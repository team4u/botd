/**
 * Node ↔ Hub env RPC 桥集成测试（真实 WebSocket + birpc 双向通道）。
 *
 * 覆盖：
 * 1. NodeConnectionManager + createNodeEnvRpcServer 经真实 WebSocket 连接：
 *    createRemoteEnv 的文件读写、exec 流式输出（onEnvExecOutput → execOutputHub）、
 *    Git Worktree 创建/释放；
 * 2. waitForNodeOnline 离线韧性：远端操作先于节点连接发起，节点上线后自动完成。
 *
 * 运行：npx tsx --test tests/node-hub-env-bridge.test.ts
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { AuthManager } from '../apps/hub/src/auth.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { SseHub } from '../apps/hub/src/sse.js';
import { NodeConnectionManager } from '../apps/hub/src/ws-hub.js';
import { createNodeEnvRpcServer } from '../apps/node/src/env-rpc-server.js';
import {
  serializeRpcMessage,
  type HubRpcFunctions,
  type NodeRpcFunctions,
  type PlatformType,
} from '../packages/protocol/src/index.js';
import type { Context } from '../apps/hub/node_modules/@earendil-works/chord/dist/context/index.d.ts';
import { withAbortSignal } from '../apps/hub/node_modules/@earendil-works/chord/dist/context/index.js';

const run = promisify(execFile);
const CTX: Context = (
  await import('../apps/hub/node_modules/@earendil-works/chord/dist/context/index.js')
).BACKGROUND_CONTEXT as Context;

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for the expected state');
};

interface HubFixture {
  manager: NodeConnectionManager;
  db: HubDatabase;
  auth: AuthManager;
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/** Hub 侧测试夹具：真实 NodeConnectionManager（HTTP upgrade + WSS + birpc）。 */
async function startHubSide(t: TestContext): Promise<HubFixture> {
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

  return {
    manager,
    db,
    auth,
    server,
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => undefined,
  };
}

/** 节点登记 + 真实 WebSocket birpc 连接（daemon.ts 同款接线：envRpcServer 展开 + onEnvExecOutput 转发）。 */
async function connectNode(
  hub: HubFixture,
  db: HubDatabase,
  auth: AuthManager,
  nodeId: string,
  defaultCwd: string,
): Promise<{
  rpc: ReturnType<typeof createNodeEnvRpcServer>;
  ws: WebSocket;
  ready: Promise<void>;
}> {
  const token = `tok-${nodeId}`;
  if (db.getNodeWithSecret(nodeId) === undefined) {
    db.createNode({
      id: nodeId,
      name: `node-${nodeId}`,
      platform: process.platform as PlatformType,
      tokenHash: auth.hashToken(token),
      ownerId: 'user_test',
    });
  }

  const ws = new WebSocket(`${hub.url}/ws/node?nodeId=${encodeURIComponent(nodeId)}&token=${encodeURIComponent(token)}`);

  // daemon.ts 同款：流式输出经 hubRpc.onEnvExecOutput 回传
  const envRpcServer = createNodeEnvRpcServer({
    defaultCwd,
    onExecOutput: (event) => {
      try {
        hubRpc?.onEnvExecOutput?.(event);
      } catch {
        // 回传失败不影响命令本身
      }
    },
  });

  let onRpcMessage: ((data: string) => void) | undefined;
  let hubRpc: ReturnType<typeof createBirpc<HubRpcFunctions, NodeRpcFunctions>> | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      const client = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
        {
          restartDaemon: async () => ({ ok: true as const, pid: process.pid }),
          // daemon.ts 同款：展开 envRpcServer 全部 env* 方法
          ...envRpcServer,
        } as NodeRpcFunctions,
        {
          post: (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data as unknown as string);
          },
          on: (callback) => {
            onRpcMessage = callback;
          },
          serialize: serializeRpcMessage,
          deserialize: JSON.parse,
          timeout: 60_000,
        },
      );
      hubRpc = client;
      void client
        .registerNode({
          nodeId,
          name: `node-${nodeId}`,
          platform: process.platform as PlatformType,
          bots: [],
          skills: [],
          pid: process.pid,
        })
        .then(() => resolve())
        .catch(reject);
    });
    ws.once('error', reject);
  });

  ws.on('message', (msg) => {
    const raw = typeof msg === 'string' ? msg : msg.toString();
    if (raw && onRpcMessage) {
      try {
        onRpcMessage(raw);
      } catch {
        // ignore malformed
      }
    }
  });

  return { rpc: envRpcServer, ws, ready };
}

// ---------------------------------------------------------------------------
// 1. 真实 WebSocket 桥：文件 / exec 流 / worktree
// ---------------------------------------------------------------------------

test('createRemoteEnv bridges files, streaming exec and worktrees over real websocket', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined));

  const hub = await startHubSide(t);
  const nodeId = 'bridge-node';
  const node = await connectNode(hub, hub.db, hub.auth, nodeId, root);
  t.after(() => {
    node.ws.terminate();
    void node.rpc.envCleanup().catch(() => undefined);
  });
  await node.ready;

  const env = hub.manager.createRemoteEnv({ nodeId, cwd: root });

  // 文件读写经真实 RPC 往返
  const write = await env.writeFile('hello.txt', 'line1\nline2\n', CTX);
  assert.ok(write.ok, JSON.stringify(write));
  const text = await env.readTextFile('hello.txt', CTX);
  assert.ok(text.ok);
  assert.equal(text.value, 'line1\nline2\n');

  // exec 流式输出：Node stdout/stderr 分块 → onEnvExecOutput → execOutputHub → onOutput
  const chunks: { text: string; stream: string }[] = [];
  const exec = await env.exec('printf one; printf err >&2; echo two', {
    onOutput: (text: string, _context: Context, info: { stream: 'stdout' | 'stderr' }) =>
      chunks.push({ text, stream: info.stream }),
  }, CTX);
  assert.ok(exec.ok, JSON.stringify(exec));
  assert.equal(exec.value.exitCode, 0);
  const joined = chunks.map((c) => c.text).join('');
  assert.ok(joined.includes('one') && joined.includes('two'), joined);
  assert.ok(chunks.some((c) => c.stream === 'stderr' && c.text.includes('err')), JSON.stringify(chunks));

  // envAbortExec 经同一通道：超长命令被中止
  const abortPromise = (async () => {
    const abortId = 'bridge-abort';
    const slow = node.rpc.envExec({ execId: abortId, command: 'sleep 30', timeout: 30 });
    await new Promise((r) => setTimeout(r, 150));
    await node.rpc.envAbortExec(abortId);
    return slow;
  })();
  const aborted = await abortPromise;
  assert.ok(!aborted.ok);

  // Git Worktree：acquire → 隔离修改 → release
  const repoDir = path.join(root, 'repo');
  await run('git', ['init', '-q'], { cwd: repoDir }).catch(async () => {
    await run('git', ['init', '-q', repoDir]);
  });
  await run('git', ['config', 'user.email', 'a@b.c'], { cwd: repoDir });
  await run('git', ['config', 'user.name', 'test'], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'shared.txt'), 'base\n');
  await run('git', ['add', '.'], { cwd: repoDir });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });

  const acquired = await node.rpc.envAcquireWorktree({ repoDir, workerId: 'bridge-worker' });
  assert.ok(acquired.isGitRepo, JSON.stringify(acquired));
  assert.equal(acquired.branchName, 'botd/bridge-worker');
  assert.ok(acquired.worktreePath.startsWith(path.join(repoDir, '.botd-worktrees')));

  // worktree 内文件可经 RemoteExecutionEnv（cwd 指向 worktree）读写
  const workerEnv = hub.manager.createRemoteEnv({ nodeId, cwd: acquired.worktreePath });
  const wWrite = await workerEnv.writeFile('shared.txt', 'from-worker\n', CTX);
  assert.ok(wWrite.ok, JSON.stringify(wWrite));
  const wRead = await workerEnv.readTextFile('shared.txt', CTX);
  assert.ok(wRead.ok && wRead.value === 'from-worker\n');
  const mainShared = await readFile(path.join(repoDir, 'shared.txt'), 'utf8');
  assert.equal(mainShared, 'base\n', 'main worktree must stay untouched');

  const released = await node.rpc.envReleaseWorktree({
    repoDir,
    worktreePath: acquired.worktreePath,
    branchName: acquired.branchName,
    deleteBranch: true,
  });
  assert.ok(released.ok);
  const worktrees = await run('git', ['worktree', 'list'], { cwd: repoDir });
  assert.ok(!worktrees.stdout.includes('bridge-worker'), worktrees.stdout);
  const branches = await run('git', ['branch', '--list', 'botd/*'], { cwd: repoDir });
  assert.ok(!branches.stdout.includes('botd/bridge-worker'), branches.stdout);
});

// ---------------------------------------------------------------------------
// 2. waitForNodeOnline：先发起操作，节点后上线
// ---------------------------------------------------------------------------

test('remote env tool call started before node connects waits and completes on connect', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-bridge-wait-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined));

  const hub = await startHubSide(t);
  const nodeId = 'late-node';

  // 节点尚未连接：getNodeEnvRpc 为空，waitForNodeOnline 应挂起
  assert.equal(hub.manager.getNodeEnvRpc(nodeId), undefined);

  const env = hub.manager.createRemoteEnv({ nodeId, cwd: root });
  const started = Date.now();

  // 先发起远端工具调用（节点离线）：应等待而非立即失败
  const pending = env.exec('echo late-online', undefined, CTX);

  // 让等待真正挂起后再连接节点
  await new Promise((r) => setTimeout(r, 150));
  const node = await connectNode(hub, hub.db, hub.auth, nodeId, root);
  t.after(() => {
    node.ws.terminate();
    void node.rpc.envCleanup().catch(() => undefined);
  });
  await node.ready;

  const result = await pending;
  const elapsed = Date.now() - started;
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(elapsed >= 140, `should have waited for the node to connect, elapsed=${elapsed}ms`);
  assert.equal(result.value.exitCode, 0);

  // 上线后写入经 waitForNodeOnline 路径解析到新连接，可继续无缝读写
  const write = await env.writeFile('after-online.txt', 'ok', CTX);
  assert.ok(write.ok, JSON.stringify(write));
  const read = await env.readTextFile('after-online.txt', CTX);
  assert.ok(read.ok && read.value === 'ok');

  // waitForNodeOnline 对在线节点立即返回
  const onlineRpc = await hub.manager.waitForNodeOnline(nodeId, CTX);
  assert.equal(typeof onlineRpc.envExec, 'function');
});

test('waitForNodeOnline rejects when context is cancelled before the node comes online', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-bridge-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined));

  const hub = await startHubSide(t);
  const controller = new AbortController();
  const cancelledContext = withAbortSignal(controller.signal, CTX);

  const waiting = hub.manager.waitForNodeOnline('ghost-node', cancelledContext);
  controller.abort();
  await assert.rejects(waiting);

  // 取消后的 context 直接发起等待也应立刻拒绝
  await assert.rejects(() => hub.manager.waitForNodeOnline('ghost-node', cancelledContext));
});
