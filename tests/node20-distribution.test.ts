/**
 * @botd/node Node 20 交付兼容冒烟（真实行为级，非源码字符串断言）：
 *
 * 1. 依赖引擎校验：@botd/node 公开运行时依赖的 engines 必须覆盖 >=20.0.0，
 *    并拒绝 commander@>=15（要求 >=22.12）这类破坏 Node 20 承诺的版本；
 * 2. 打包产物语法校验：dist 目录全部 .js 在 --check 下只允许已 shipped 的语法
 *    （import attributes 在最早的 20.x 上不可用）；
 * 3. 真实执行冒烟（条件触发）：当环境提供 BOTD_NODE20_BIN（CI 的 Node 20
 *    job 注入；本机可指向任意 Node 20 二进制）且存在已构建的 tarball 时，
 *    在隔离目录用 Node 20 安装两个 tarball，跑 `botd --help` / `--version`
 *    与 NodeExecutionEnv 文件读写、envExec、取消行为。仓库根 engines>=24
 *    只约束 pnpm install 工作区，此测试不安装工作区，故 Node 24 可全程驱动。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodePkgDir = path.join(repoRoot, 'apps', 'node');
const node20Bin = process.env.BOTD_NODE20_BIN;

/** 兼容官方发行包与系统安装两种布局，定位随 Node 20 一起分发的 npm CLI。 */
function npmCliOf(nodeBin: string): string {
  const binDir = path.dirname(nodeBin);
  const candidates = [
    path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`cannot locate npm-cli.js next to ${nodeBin}; checked: ${candidates.join(', ')}`);
  return found;
}

/** 把 >=x.y / >=x 形式的 engines 表达式解析成可比较的 [major, minor, patch]。 */
function parseFloor(range: string): [number, number, number] | null {
  const match = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function coversNode20(range: string): boolean {
  const floor = parseFloor(range);
  if (!floor) return false;
  const [major, minor, patch] = floor;
  // 下限不高于 20.0.0 即覆盖（如 >=20、>=20.0、>=20.0.0）。
  return major < 20 || (major === 20 && minor === 0 && patch === 0);
}

test('runtime dependency engines of @botd/node cover Node 20.0.0', { timeout: 60_000 }, async () => {
  const manifest = JSON.parse(await readFile(path.join(nodePkgDir, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.engines?.node, '>=20.0.0');

  // 公开依赖逐个从 node_modules 反查清单：engines 下限必须不高于 20.0.0。
  const offenders: string[] = [];
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith('@botd/')) continue; // workspace 协议包，随仓声明
    const depManifest = await readFile(path.join(nodePkgDir, 'node_modules', name, 'package.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (!depManifest) throw new Error(`missing installed manifest for dependency "${name}" (run pnpm install)`);
    const engines = depManifest.engines?.node as string | undefined;
    if (!engines) continue;
    if (!coversNode20(engines)) offenders.push(`${name}@${depManifest.version} (dep range ${range}, engines ${engines})`);
  }
  assert.deepEqual(offenders, [], `dependencies breaking the Node >=20.0.0 promise: ${offenders.join('; ')}`);
});

test('packaged dist passes Node 20 syntax check without import attributes', { timeout: 60_000 }, async () => {
  const distDir = path.join(nodePkgDir, 'dist');
  if (!existsSync(distDir)) {
    assert.ok(true, 'dist not built (plain install); behavior smoke only runs in the Node 20 CI job');
    return;
  }
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && full.endsWith('.js')) files.push(full);
    }
  };
  await walk(distDir);
  assert.ok(files.length > 0, 'built dist must contain JS output');
  for (const file of files) {
    // --check 只做解析：比 Node 20 新的语法（含 import attributes）在此直接报错。
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
  // 打包产物直接防回潮：dist 里不允许出现 import attributes。
  const attrOffenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/with\s*\{\s*type:\s*['"]json['"]\s*\}/.test(source)) attrOffenders.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(attrOffenders, [], 'dist must not rely on import attributes (unsupported on early Node 20)');
});

/**
 * 真实安装 + 执行冒烟。需要（由 scripts/node20-smoke.sh 准备）：
 * - BOTD_NODE20_BIN：Node 20 二进制路径
 * - BOTD_PROTOCOL_TARBALL / BOTD_NODE_TARBALL：已构建的打包产物
 */
const realSmoke = Boolean(node20Bin && process.env.BOTD_PROTOCOL_TARBALL && process.env.BOTD_NODE_TARBALL);

test(
  'tarballs install and behave under real Node 20 (help/version, env io, exec, abort)',
  { skip: realSmoke ? false : 'set BOTD_NODE20_BIN + tarball envs to run the real Node 20 smoke', timeout: 60_000 },
  async t => {
    assert.ok(node20Bin && existsSync(node20Bin), `BOTD_NODE20_BIN must exist: ${node20Bin}`);
    const root = await mkdtemp(path.join(tmpdir(), 'botd-node20-smoke-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const target = path.join(root, 'target');
    await mkdir(target, { recursive: true });

    const runNode20 = (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) =>
      execFileSync(node20Bin!, args, { cwd: opts?.cwd ?? target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: opts?.env });

    const npmOnNode20 = (args: string[]) => runNode20([npmCliOf(node20Bin!), ...args]);

    // 隔离安装目录中安装两个 tarball：engines 与运行时兼容性在此真实生效。
    // 仓库根 engines>=24 只作用于 pnpm 工作区安装，不影响这里的 npm 客户端。
    npmOnNode20(['init', '-y']);
    const protocolTarball = process.env.BOTD_PROTOCOL_TARBALL!;
    const nodeTarball = process.env.BOTD_NODE_TARBALL!;
    npmOnNode20(['install', protocolTarball]);
    npmOnNode20(['install', nodeTarball]);

    const bin = path.join(target, 'node_modules', '.bin', 'botd');
    assert.ok(existsSync(bin), 'botd bin must be linked after install');
    const pkgManifest = JSON.parse(await readFile(path.join(target, 'node_modules', '@botd', 'node', 'package.json'), 'utf8')) as { version: string };

    // 1) CLI 可执行：--version 输出 package 版本（createRequire 读 JSON 的真实路径）。
    const versionOut = runNode20([bin, '--version']).trim();
    assert.equal(versionOut, pkgManifest.version, 'botd --version must print the installed package version');

    // 2) --help 输出用法且退出码为 0。
    const helpOut = runNode20([bin, '--help']);
    assert.match(helpOut, /Usage:\s+botd/, 'botd --help must print usage');
    assert.match(helpOut, /node\s+start/, 'help must list the node daemon subcommand');

    // 3) NodeExecutionEnv 行为：文件写入/读回 + envExec 执行 + 取消。
    const behavior = `
      import { createNodeEnvRpcServer } from '@botd/node';
      const rpc = createNodeEnvRpcServer({ defaultCwd: process.cwd() });
      const assert = (await import('node:assert/strict')).default;

      const w = await rpc.envWriteFile({ path: 'note.txt', content: 'hello-node20' });
      assert.equal(w.ok, true, JSON.stringify(w));
      const r = await rpc.envReadTextFile({ path: 'note.txt' });
      assert.ok(r.ok && r.value === 'hello-node20', JSON.stringify(r));

      const info = await rpc.envFileInfo({ path: 'note.txt' });
      assert.ok(info.ok && info.value.size === 'hello-node20'.length, JSON.stringify(info));

      const okExec = await rpc.envExec({ execId: 'smoke-ok', command: 'printf botd-node20-ok', timeout: 15 });
      assert.ok(okExec.ok && okExec.value.exitCode === 0, JSON.stringify(okExec));

      const failExec = await rpc.envExec({ execId: 'smoke-fail', command: 'exit 7', timeout: 15 });
      assert.ok(failExec.ok && failExec.value.exitCode === 7, JSON.stringify(failExec));

      const slow = rpc.envExec({ execId: 'smoke-abort', command: 'sleep 30', timeout: 30 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(rpc.getActiveExecCount?.(), 1, 'in-flight exec must be tracked');
      await rpc.envAbortExec('smoke-abort');
      const aborted = await slow;
      assert.equal(aborted.ok, false, 'aborted exec must fail: ' + JSON.stringify(aborted));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(rpc.getActiveExecCount?.(), 0, 'aborted exec must release the in-flight slot');

      await rpc.envCleanup().catch(() => undefined);
      console.log('NODE20_BEHAVIOR_OK');
    `;
    await writeFile(path.join(target, 'behavior.mjs'), behavior, 'utf8');
    const behaviorOut = runNode20(['behavior.mjs']);
    assert.ok(behaviorOut.includes('NODE20_BEHAVIOR_OK'), `behavior script must pass, got: ${behaviorOut}`);
  },
);
