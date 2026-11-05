/**
 * worktree 获取失败边界（fail-closed）行为测试。
 *
 * 验证真实行为（不做源码断言）：
 *  1. Node envAcquireWorktree（远端节点侧执行体）：申请后主目录零写入；
 *     有效 worktree 幂等复用且保留未提交改动（不 force 删）；陌生目录
 *     占用路径报错；非 git 目录明确降级；repoDir 缺失抛错。
 *  2. Hub 本地 helper（acquireLocalWorktree）：与 Node 侧相同语义。
 *  3. 真实 startHub（本地节点）：获取失败以真实错误暴露给 worker 的工具结果，
 *     绝不回退主仓执行（主目录零写入）。
 *  4. 真实 WebSocket 桥：远端 envAcquireWorktree 失败原样传回 Hub，
 *     Hub 本机绝不代为挂载。
 *
 * 运行：npx tsx --test tests/worktree-acquisition-integrity.test.ts
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { createNodeEnvRpcServer } from '../apps/node/src/env-rpc-server.js';
import { acquireLocalWorktree } from '../apps/hub/src/harness/worktree.js';
import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { WorkerRegistryDoc } from '../apps/hub/src/harness/docs.js';
import { AuthManager } from '../apps/hub/src/auth.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { SseHub } from '../apps/hub/src/sse.js';
import { NodeConnectionManager } from '../apps/hub/src/ws-hub.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';

const run = promisify(execFile);
const PASSWORD = 'pw-worktree-integrity';

/** 建一个带初始提交的真实 git 仓库。 */
async function makeRepo(prefix: string): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), prefix));
  await run('git', ['init', '-q'], { cwd: repoDir });
  await run('git', ['config', 'user.email', 'botd@test'], { cwd: repoDir });
  await run('git', ['config', 'user.name', 'botd-test'], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'README.md'), '# repo\n');
  await run('git', ['add', '.'], { cwd: repoDir });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
  return repoDir;
}

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > deadline) throw new Error('timeout waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const seedBot = (hub: Awaited<ReturnType<typeof startHub>>, id: string, node: string, workspaceDir: string): void => {
  hub.db.saveBot({
    id,
    nodeId: node,
    name: id,
    description: '',
    modelProvider: 'faux',
    modelId: 'main',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
    workspaceDir,
  });
  hub.db.setBotFile(id, 'system', 'You code.');
};

/** worker 收到任务后用 bash 写探测文件；若隔离失效回退主仓，主目录会出现该文件。 */
const probeWorkerScript = (faux: ReturnType<typeof fauxProvider>): void => {
  faux.setResponses(
    [...Array(16)].map(
      () =>
        ((ctx: { messages: readonly { role: string; content: unknown }[] }) => {
          const sawToolResult = ctx.messages.some((m) => m.role === 'toolResult');
          const lastUser = [...ctx.messages].reverse().find((m) => m.role === 'user');
          const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
          if (/write the probe/.test(text) && !sawToolResult) {
            return fauxAssistantMessage(
              [fauxToolCall('bash', { command: 'echo isolated > isolation-probe.txt' })],
              { stopReason: 'toolUse' },
            );
          }
          return fauxAssistantMessage('done');
        }) as never,
    ),
  );
};

const assertNoProbeInMain = async (repoDir: string): Promise<void> => {
  const status = await run('git', ['status', '--porcelain'], { cwd: repoDir });
  assert.ok(
    !status.stdout.includes('isolation-probe.txt'),
    `bash must never run in the main checkout (status: ${status.stdout.trim()})`,
  );
  const probe = await readFile(path.join(repoDir, 'isolation-probe.txt'), 'utf8').then(
    () => true,
    () => false,
  );
  assert.ok(!probe, 'no probe file may appear in the main repo');
};

// ---------------------------------------------------------------------------
// 1. Node 侧 envAcquireWorktree（远端节点侧的真实行为）
// ---------------------------------------------------------------------------

test('node: acquire keeps the main checkout clean, reuses valid worktrees with changes, rejects foreign paths', { timeout: 60_000 }, async (t) => {
  const repoDir = await makeRepo('botd-wt-node-');
  t.after(() => rm(repoDir, { recursive: true, force: true }).catch(() => undefined));
  const rpc = createNodeEnvRpcServer({ defaultCwd: repoDir });

  // 获取成功：主目录保持干净（.botd-worktrees 外零改动），路径与分支符合约定。
  const acquired = await rpc.envAcquireWorktree({ repoDir, workerId: 'w-1-1' });
  assert.ok(acquired.isGitRepo);
  assert.equal(acquired.worktreePath, path.join(repoDir, '.botd-worktrees', 'w-1-1'));
  assert.equal(acquired.branchName, 'botd/w-1-1');
  const mainStatus = await run('git', ['status', '--porcelain'], { cwd: repoDir });
  assert.ok(
    !mainStatus.stdout.split('\n').some((line) => /^ [MD?]{1,2} (?!\.botd-worktrees).+/.test(line)),
    `main checkout must stay clean after acquire (status: ${mainStatus.stdout.trim()})`,
  );

  // 幂等复用：二次获取同 workerId 返回同路径，且保留未提交改动（不 force 删）。
  await writeFile(path.join(acquired.worktreePath, 'dirty.txt'), 'uncommitted\n');
  const reacquired = await rpc.envAcquireWorktree({ repoDir, workerId: 'w-1-1' });
  assert.equal(reacquired.worktreePath, acquired.worktreePath);
  assert.equal(
    await readFile(path.join(acquired.worktreePath, 'dirty.txt'), 'utf8'),
    'uncommitted\n',
    'a valid worktree must be reused with its uncommitted changes intact',
  );

  // 陌生目录占用预期路径：报错，绝不复用（假隔离）。
  const foreignPath = path.join(repoDir, '.botd-worktrees', 'w-2-9');
  await mkdir(foreignPath, { recursive: true });
  await writeFile(path.join(foreignPath, 'not-a-worktree.txt'), 'x\n');
  await assert.rejects(
    () => rpc.envAcquireWorktree({ repoDir, workerId: 'w-2-9' }),
    /拒绝复用|worktree/i,
    'a non-worktree directory occupying the path must be rejected, not reused',
  );

  await assert.rejects(() => rpc.envAcquireWorktree({ repoDir, workerId: '..' }), /不能复用主工作区/);

  // 非 git 目录：明确降级语义（isGitRepo=false，原样返回，branchName 为空）。
  const plain = await mkdtemp(path.join(tmpdir(), 'botd-wt-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }).catch(() => undefined));
  const degraded = await rpc.envAcquireWorktree({ repoDir: plain, workerId: 'w-3-1' });
  assert.equal(degraded.isGitRepo, false);
  assert.equal(degraded.worktreePath, plain);
  assert.equal(degraded.branchName, '');

  // repoDir 不存在：真实失败必须抛错（不能当非仓库降级）。
  await assert.rejects(
    () => rpc.envAcquireWorktree({ repoDir: path.join(plain, 'no-such-dir'), workerId: 'w-4-1' }),
    'a missing repoDir must throw, never degrade to repoDir execution',
  );
});

// ---------------------------------------------------------------------------
// 2. Hub 侧 acquireLocalWorktree（与 Node 相同语义）
// ---------------------------------------------------------------------------

test('hub helper: reuse only valid same-repo worktrees; degrade only on explicit non-repo', { timeout: 60_000 }, async (t) => {
  const repoDir = await makeRepo('botd-wt-hub-');
  t.after(() => rm(repoDir, { recursive: true, force: true }).catch(() => undefined));

  const worktreePath = path.join(repoDir, '.botd-worktrees', 'w-1-2');
  assert.equal(await acquireLocalWorktree(repoDir, worktreePath, 'botd/w-1-2'), worktreePath);
  const mainStatus = await run('git', ['status', '--porcelain'], { cwd: repoDir });
  assert.ok(
    !mainStatus.stdout.split('\n').some((line) => /^ [MD?]{1,2} (?!\.botd-worktrees).+/.test(line)),
    `main checkout must stay clean after acquire (status: ${mainStatus.stdout.trim()})`,
  );

  // 幂等复用保留未提交改动。
  await writeFile(path.join(worktreePath, 'dirty.txt'), 'keep-me\n');
  assert.equal(await acquireLocalWorktree(repoDir, worktreePath, 'botd/w-1-2'), worktreePath);
  assert.equal(await readFile(path.join(worktreePath, 'dirty.txt'), 'utf8'), 'keep-me\n');

  // 陌生目录占用：报错，不假隔离。
  const foreignPath = path.join(repoDir, '.botd-worktrees', 'w-2-8');
  await mkdir(foreignPath, { recursive: true });
  await assert.rejects(
    () => acquireLocalWorktree(repoDir, foreignPath, 'botd/w-2-8'),
    /拒绝复用|假隔离|worktree/i,
  );

  await assert.rejects(() => acquireLocalWorktree(repoDir, repoDir, 'botd/main'), /不能复用主工作区/);

  // 非 git 目录：原样返回（明确语义）。
  const plain = await mkdtemp(path.join(tmpdir(), 'botd-wt-plain2-'));
  t.after(() => rm(plain, { recursive: true, force: true }).catch(() => undefined));
  assert.equal(await acquireLocalWorktree(plain, path.join(plain, '.botd-worktrees', 'x'), 'botd/x'), plain);

  // repoDir 缺失：抛错。
  await assert.rejects(() =>
    acquireLocalWorktree(path.join(plain, 'gone'), path.join(plain, 'gone', '.botd-worktrees', 'y'), 'botd/y'));
});

test('bare repositories and relative paths preserve valid worktrees on reacquisition', { timeout: 60_000 }, async (t) => {
  const root = await makeRepo('botd-wt-bare-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = path.join(root, 'bare.git');
  await run('git', ['clone', '--bare', root, bare]);
  const relativeRepo = path.relative(process.cwd(), bare);
  const rpc = createNodeEnvRpcServer({ defaultCwd: root });
  t.after(() => rpc.envCleanup());
  const acquired = await rpc.envAcquireWorktree({ repoDir: relativeRepo, workerId: 'bare-node' });
  assert.equal(acquired.isGitRepo, true, 'a bare repository must not be treated as a plain directory');
  await writeFile(path.join(acquired.worktreePath, 'dirty.txt'), 'keep node changes');
  assert.deepEqual(await rpc.envAcquireWorktree({ repoDir: relativeRepo, workerId: 'bare-node' }), acquired);
  assert.equal(await readFile(path.join(acquired.worktreePath, 'dirty.txt'), 'utf8'), 'keep node changes');
  const relativeTree = path.relative(process.cwd(), path.join(bare, '.botd-worktrees', 'bare-hub'));
  const local = await acquireLocalWorktree(relativeRepo, relativeTree, 'botd/bare-hub');
  await writeFile(path.join(local, 'dirty.txt'), 'keep hub changes');
  assert.equal(await acquireLocalWorktree(relativeRepo, relativeTree, 'botd/bare-hub'), local);
  assert.equal(await readFile(path.join(local, 'dirty.txt'), 'utf8'), 'keep hub changes');
});

test('standalone durable runtime exposes worktree failure without executing in the main checkout', { timeout: 60_000 }, async (t) => {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'botd-wt-standalone-'));
  t.after(() => rm(repoDir, { recursive: true, force: true }));
  await run('git', ['init', '-q', repoDir]);
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models, codemode: false });
  t.after(() => runtime.close());
  runtime.registerPersona({ botId: 'standalone', name: 'Standalone', model: { provider: 'faux', modelId: 'main' }, instructions: 'Run the probe.', nodeId: 'local', cwd: repoDir });
  const parent = await runtime.ensureBotMainSession('standalone');
  probeWorkerScript(faux);
  const { conversation } = await runtime.forkSessionToWorker(String(parent.id), {
    botId: 'standalone', title: 'Probe', task: 'write the probe', worktree: true,
  });
  const results = await waitFor(() => latestToolResults(runtime, conversation.id), (items) => items.length > 0);
  assert.ok(results.some((result) => result.includes('[error]') && /HEAD|worktree/i.test(result)));
  await assertNoProbeInMain(repoDir);
});

// ---------------------------------------------------------------------------
// 3. 真实 startHub（本地节点）：获取失败以真实错误暴露，绝不回退主仓
// ---------------------------------------------------------------------------

test('startHub local: worktree acquisition failure surfaces to the worker, never falls back to the main repo', { timeout: 60_000 }, async (t) => {
  const repoDir = await makeRepo('botd-wt-start-');
  t.after(() => rm(repoDir, { recursive: true, force: true }).catch(() => undefined));

  // `.botd-worktrees` 被普通文件占用：任何 worktree 创建都无法进行。
  await writeFile(path.join(repoDir, '.botd-worktrees'), 'not a directory\n');

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(repoDir, 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableModels: models,
  });
  t.after(async () => {
    (hub.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await hub.close();
  });
  seedBot(hub, 'coder', 'local', repoDir);
  const runtime = await hub.ensureDurableRuntime();
  const router = await runtime.ensureBotMainSession('coder');
  probeWorkerScript(faux);

  const { workerId, conversation } = await runtime.forkSessionToWorker(String(router.id), {
    botId: 'coder',
    title: 'integrity probe',
    task: 'write the probe',
    worktree: true,
  });
  assert.ok(workerId);

  // 获取失败必须以真实错误暴露给 worker：bash 工具结果携带 acquire 的报错
  //（绝不静默回退主仓执行后伪装成功）。
  const results = await waitFor(
    async () => latestToolResults(runtime, conversation.id),
    (list) => list.length > 0,
    10_000,
  );
  const errorResult = results.find((text) => text.includes('[error]')) ?? '';
  assert.match(
    errorResult,
    /EEXIST|拒绝复用|worktree/i,
    `the tool error must surface the real acquisition failure (got: ${errorResult.slice(0, 200)})`,
  );

  // registry 不再把该 worker 报成无异的 completed 之前：至少主仓零写入必须成立。
  await assertNoProbeInMain(repoDir);
  const status = await run('git', ['status', '--porcelain'], { cwd: repoDir });
  // 主仓内允许的只有 hub 运行痕迹（db/skills/.botd-worktrees 占位）：
  // 任何 worker 业务文件（探测文件、源码改动）都不得出现。
  const allowed = /^\?\? (\.botd-worktrees|hub\.sqlite|hub\.sqlite\.durable\.sqlite(-\w+)?|skills\/)/;
  const unexpected = status.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !allowed.test(line));
  assert.deepEqual(
    unexpected,
    [],
    `worker files leaked into the main repo: ${JSON.stringify(unexpected)}`,
  );
  void WorkerRegistryDoc;
});

/** worker 会话最近一轮的工具结果文本。 */
async function latestToolResults(
  runtime: NonNullable<Awaited<ReturnType<typeof startHub>>['durableRuntime']>,
  conversationId: unknown,
): Promise<string[]> {
  const conv = await runtime.conversation(String(conversationId));
  if (conv === undefined) return [];
  const page = await conv.entries({ order: 'ascending' }, 32, undefined, BACKGROUND_CONTEXT);
  const results: string[] = [];
  for (const item of [...page.items].reverse()) {
    for (const m of ((item as { model?: unknown[] }).model ?? []) as { role?: string; content?: unknown }[]) {
      if (m.role === 'toolResult') results.push(JSON.stringify(m.content));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 4. 真实 WebSocket 桥：远端 envAcquireWorktree 失败不回退本地执行
// ---------------------------------------------------------------------------

test('remote node: envAcquireWorktree failure propagates to the hub, hub never mounts locally', { timeout: 60_000 }, async (t) => {
  const repoDir = await makeRepo('botd-wt-remote-');
  t.after(() => rm(repoDir, { recursive: true, force: true }).catch(() => undefined));

  // Hub 侧：真实 HTTP upgrade + WSS + NodeConnectionManager（node-hub-env-bridge 同款接线）。
  const db = new HubDatabase({ dbPath: ':memory:' });
  const auth = new AuthManager();
  const sseHub = new SseHub();
  const manager = new NodeConnectionManager(db, auth, sseHub);
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => manager.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  t.after(async () => {
    manager.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  // 节点登记 + 真实 birpc 连接；envAcquireWorktree 一律抛错（模拟远端创建失败）。
  const nodeId = 'failing-node';
  const token = `tok-${nodeId}`;
  db.createNode({
    id: nodeId,
    name: nodeId,
    platform: 'linux',
    tokenHash: auth.hashToken(token),
    ownerId: 'user_test',
  });
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/node?nodeId=${encodeURIComponent(nodeId)}&token=${encodeURIComponent(token)}`);
  t.after(() => ws.terminate());
  const envRpcServer = createNodeEnvRpcServer({ defaultCwd: repoDir });
  const failure = new Error('remote acquire failed (simulated)');
  const rpc = new Proxy(envRpcServer, {
    get(target, prop, receiver) {
      if (prop === 'envAcquireWorktree') return async () => {
        throw failure;
      };
      return Reflect.get(target, prop, receiver);
    },
  });
  let onRpcMessage: ((data: string) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      const client = createBirpc({ ...rpc } as never, {
        post: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data as unknown as string);
        },
        on: (cb) => {
          onRpcMessage = cb;
        },
        serialize: serializeRpcMessage,
        deserialize: JSON.parse,
        timeout: 30_000,
      });
      void (client as unknown as { registerNode: (input: never) => Promise<void> })
        .registerNode({ nodeId, name: nodeId, platform: process.platform, bots: [], skills: [], pid: process.pid } as never)
        .then(() => resolve(), reject);
    });
    ws.once('error', reject);
  });
  ws.on('message', (msg) => {
    const raw = typeof msg === 'string' ? msg : msg.toString();
    if (raw && onRpcMessage) onRpcMessage(raw);
  });
  await ready;

  // 经 Hub 侧 RPC 视图调用：真实抛错必须原样传回（不被代理/通道层吞掉）。
  const rpcView = manager.getNodeEnvRpc(nodeId);
  assert.ok(rpcView?.envAcquireWorktree, 'node rpc view must expose envAcquireWorktree');
  await assert.rejects(
    () => rpcView.envAcquireWorktree({ repoDir, workerId: 'w-9-1' }),
    (err: unknown) => {
      const text = err instanceof Error ? err.message : JSON.stringify(String((err as { message?: string })?.message ?? err));
      return /remote acquire failed|simulated/i.test(text);
    },
    'the remote failure must propagate to the hub, never degrade to local execution',
  );

  // Hub 本机零挂载：.botd-worktrees 不得被创建（远端失败绝不本地建）。
  const mounted = await readdir(path.join(repoDir, '.botd-worktrees')).then(
    () => true,
    () => false,
  );
  assert.ok(!mounted, 'the hub must never mount the remote worker worktree locally');
});

test('startHub remote workers reject failed, missing and invalid worktree RPC results before execution', { timeout: 60_000 }, async () => {
  const repoDir = await makeRepo('botd-wt-remote-guard-');
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let rpc: ReturnType<typeof createNodeEnvRpcServer> | undefined;
  try {
    const faux = fauxProvider({ models: [{ id: 'main' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: path.join(repoDir, 'hub.sqlite'), adminPassword: PASSWORD, durableModels: models });
    const currentHub = hub;
    const nodeId = 'remote_guard';
    currentHub.db.createNode({ id: nodeId, name: nodeId, platform: 'linux', tokenHash: 'x'.repeat(64), ownerId: 'user_admin' });
    seedBot(currentHub, 'guard_bot', nodeId, repoDir);
    const runtime = await currentHub.ensureDurableRuntime();
    const parent = await runtime.ensureBotMainSession('guard_bot');
    rpc = createNodeEnvRpcServer({ defaultCwd: repoDir });
    const realRpc = rpc;
    let executions = 0;
    const remoteRpc = {
      ...realRpc,
      envExec: async (input: Parameters<typeof realRpc.envExec>[0]) => {
        executions += 1;
        return realRpc.envExec(input);
      },
    };
    currentHub.connections.getNodeEnvRpc = () => remoteRpc;
    const modes = [
      async () => { throw new Error('remote acquisition rejected'); },
      undefined,
      async () => ({ worktreePath: repoDir, branchName: 'botd/invalid', isGitRepo: true }),
    ];
    for (const acquire of modes) {
      Object.defineProperty(remoteRpc, 'envAcquireWorktree', { value: acquire, configurable: true });
      probeWorkerScript(faux);
      const { conversation } = await runtime.forkSessionToWorker(String(parent.id), {
        botId: 'guard_bot', title: 'Guard probe', task: 'write the probe', worktree: true,
      });
      const results = await waitFor(() => latestToolResults(runtime, conversation.id), (items) => items.length > 0);
      assert.ok(results.some((result) => result.includes('[error]')), 'the worker must see the isolation error');
      await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
      assert.equal(executions, 0, 'remote execution must not start without an isolated worktree');
      await assertNoProbeInMain(repoDir);
    }
  } finally {
    await rpc?.envCleanup();
    await hub?.close();
    await rm(repoDir, { recursive: true, force: true });
  }
});
