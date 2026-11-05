/**
 * @botd/node 轻量化守卫（Phase 7A）：
 *
 * 1. 依赖断言：apps/node/package.json 仅保留五个运行时依赖，禁止任何
 *    @earendil-works/* 或 @botd/models 回流（它们带来 ~180MB 的 LLM/WASM
 *    传递依赖，违背「远端双手」轻量安装的定位）；
 * 2. 源码断言：apps/node/src 不允许 import 任何 @earendil-works/* 或
 *    @botd/models（NodeExecutionEnv/withCancel 已 vendored 到 src/env/，
 *    仅用 Node 标准库）；
 * 3. 行为断言：getActiveExecCount 精确反映在途 envExec；performNodeUpgrade
 *    以 getActiveTurnsCount: () => rpc.getActiveExecCount?.() 注入时，升级
 *    排空等待在途 bash 命令结束后才继续。
 *
 * 运行：npx tsx --test tests/node-lightweight.test.ts
 */

import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeEnvRpcServer } from '../apps/node/src/env-rpc-server.js';
import { performNodeUpgrade } from '../apps/node/src/upgrader.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodePkgPath = path.join(repoRoot, 'apps', 'node', 'package.json');
const nodeSrcDir = path.join(repoRoot, 'apps', 'node', 'src');

const ALLOWED_DEPENDENCIES = new Set(['@botd/protocol', 'birpc', 'commander', 'partysocket', 'ws']);

// ---------------------------------------------------------------------------
// 1. package.json：engines 降到 >=20，依赖里没有任何重包
// ---------------------------------------------------------------------------

test('apps/node/package.json requires only node >=20 and zero heavyweight dependencies', { timeout: 60_000 }, async () => {
  const pkg = JSON.parse(await readFile(nodePkgPath, 'utf8')) as {
    engines?: { node?: string };
    dependencies?: Record<string, string>;
  };

  assert.equal(pkg.engines?.node, '>=20.0.0', 'engines.node must be lowered to >=20.0.0');

  const dependencies = Object.keys(pkg.dependencies ?? {});
  assert.ok(dependencies.length > 0, 'apps/node must keep runtime dependencies');
  const banned = dependencies.filter(
    (name) => name === '@botd/models' || name.startsWith('@earendil-works/'),
  );
  assert.deepEqual(banned, [], `heavyweight dependencies must not return: ${banned.join(', ')}`);
  for (const name of dependencies) {
    assert.ok(ALLOWED_DEPENDENCIES.has(name), `unexpected dependency "${name}"; allowed: ${[...ALLOWED_DEPENDENCIES].join(', ')}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 源码：apps/node/src 零 @earendil-works/* / @botd/models import
// ---------------------------------------------------------------------------

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(full)));
    else if (entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test('apps/node/src contains zero imports of @earendil-works/* or @botd/models', { timeout: 60_000 }, async () => {
  const files = await collectSourceFiles(nodeSrcDir);
  assert.ok(files.length > 0, 'apps/node/src must contain sources');
  const offenders: string[] = [];
  const bannedPattern = /['"](@earendil-works\/[^'"]+|@botd\/models)['"]/;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const line of source.split('\n')) {
      if (bannedPattern.test(line)) offenders.push(`${path.relative(repoRoot, file)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `banned imports found:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 3. getActiveExecCount 与升级排空保护
// ---------------------------------------------------------------------------

test('getActiveExecCount tracks in-flight envExec commands and returns to zero when done or aborted', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-lightweight-count-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const rpc = createNodeEnvRpcServer({ defaultCwd: root });
  t.after(() => rpc.envCleanup().catch(() => undefined));

  assert.equal(rpc.getActiveExecCount?.(), 0, 'no exec running initially');

  // 在途：长时间运行的 bash 命令使计数 +1
  const slow = rpc.envExec({ execId: 'light-1', command: 'sleep 5', timeout: 30 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(rpc.getActiveExecCount?.(), 1, 'running envExec must be counted');

  // 中止后计数归零
  await rpc.envAbortExec('light-1');
  const aborted = await slow;
  assert.equal(aborted.ok, false, 'aborted exec must fail');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(rpc.getActiveExecCount?.(), 0, 'aborted exec must decrement the count');

  // 正常结束后计数也归零
  const done = rpc.envExec({ execId: 'light-2', command: 'sleep 1', timeout: 30 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(rpc.getActiveExecCount?.(), 1);
  const finished = await done;
  assert.equal(finished.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(rpc.getActiveExecCount?.(), 0, 'completed exec must decrement the count');
});

test('performNodeUpgrade drains an in-flight envExec before completing the upgrade', { timeout: 60_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-lightweight-upgrade-'));
  const workDir = await mkdtemp(path.join(tmpdir(), 'botd-lightweight-work-'));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  const rpc = createNodeEnvRpcServer({ defaultCwd: workDir });
  t.after(() => rpc.envCleanup().catch(() => undefined));

  // 在途命令：写 marker 后退出 —— 排空等待必须在命令结束后才放行升级。
  const marker = path.join(workDir, 'drained.marker');
  const inFlight = rpc.envExec({
    execId: 'drain-1',
    command: `sleep 1 && touch ${JSON.stringify(marker)}`,
    timeout: 30,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(rpc.getActiveExecCount?.(), 1, 'precondition: one exec in flight');

  let spawnSeenActiveCount = -1;
  let shutdownScheduled = false;
  const result = await performNodeUpgrade(dataDir, {
    targetVersion: '9.9.9',
    force: true,
    drainTimeoutMs: 10_000,
    getActiveTurnsCount: () => rpc.getActiveExecCount?.() ?? 0,
    stageExtractor: async (stagingDir) => {
      const entry = path.join(stagingDir, 'cli.js');
      await writeFile(entry, '// mocked cli\n', 'utf8');
      return 'cli.js';
    },
    spawnReplacementFn: async () => {
      spawnSeenActiveCount = rpc.getActiveExecCount?.() ?? -1;
      return 424242;
    },
    onScheduleShutdown: () => {
      shutdownScheduled = true;
    },
  });

  const finished = await inFlight;
  assert.equal(result.ok, true);
  assert.equal(result.upgraded, true);
  assert.equal(shutdownScheduled, true);
  assert.equal(finished.ok, true, 'in-flight exec must complete normally');
  assert.equal(spawnSeenActiveCount, 0, 'replacement daemon must only spawn after the exec drained');
  assert.equal(rpc.getActiveExecCount?.(), 0);
  // 命令完整跑完的证明：marker 已落盘
  const markerContent = await readFile(marker, 'utf8').catch(() => null);
  assert.notEqual(markerContent, null, 'drained command must have run to completion (marker written)');
});
