import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { startHub } from '../apps/hub/src/index.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import {
  markWorkflowRunFinished,
  markWorkflowRunStarted,
  readUnfinishedWorkflowHint,
} from '../apps/node/src/cross-bot/workflow.js';
import {
  runTurnWithResilience,
  turnSignature,
  clearTurnReceipt,
} from '../apps/node/src/runtime/turn-receipt.js';
import type { BotTurnResult } from '../apps/node/src/runtime/execute-turn.js';
import type { BotConfig, HubRpcFunctions, NodeRpcFunctions, SessionRecord } from '../packages/protocol/src/index.js';

/**
 * 长任务断连容错与重启恢复（long-task reliability）：
 * 1. 在途附着：节点闪断时会话转 queued（不 failed），重连后重发附着同一在途回合，只执行 1 次；
 * 2. 离线完成回执：节点离线跑完写 .receipt.json，重连后 Hub 消费回执，不重复调用模型；
 * 3. Hub 重启恢复：queued_offline 会话保持 queued，孤儿 running 会话变 failed 并写入诚实中断提示；
 * 4. 工作流断点提示：中断后提示含 resumeFromRunId，成功完成后自动清除。
 */

const PASSWORD = 'reliability-test-password';

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('Timed out waiting for the expected state');
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

// ---------------------------------------------------------------- hub fixture

interface HubFixture {
  hub: Awaited<ReturnType<typeof startHub>>;
  base: string;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
  request: (route: string, method?: string, body?: unknown) => Promise<Response>;
}

async function startHubFixture(t: TestContext): Promise<HubFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reliability-hub-'));
  const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'hub.sqlite'), adminPassword: PASSWORD });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = async (route: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(route, method, body);
    const value = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
    return value as T;
  };
  return { hub, base, json, request };
}

// ---------------------------------------------------------------- node fixture

/**
 * 模拟节点：真实 WS 连到 Hub，runTurn 走 runTurnWithResilience（与 daemon 行为一致：
 * 在途附着 + 单槽回执），execute 注入测试桩统计真实执行次数。
 */
interface NodeFixture {
  identity: { nodeId: string; token: string };
  socket: WebSocket;
  rpc: ReturnType<typeof createBirpc<HubRpcFunctions, NodeRpcFunctions>>;
  /** 真正执行（调用 execute 桩）的次数 */
  executions: () => number;
  /** Hub 重发（附着 / 消费回执前）的 runTurn RPC 调用次数 */
  rpcCalls: () => number;
  /** 模拟连接断开（底层 WS terminate，RPC epoch 归零） */
  simulateDisconnect: () => Promise<void>;
  /** 模拟重连：新建 WS + registerNode */
  simulateReconnect: () => Promise<void>;
  /** 手动推进 epoch（离线完成场景：断开 → 跑完 → 重连） */
  setEpoch: (epoch: number) => void;
  releaseTurn: () => void;
}

async function addResilientNode(
  f: HubFixture,
  t: TestContext,
  options: {
    botId: string;
    /** execute 桩：真实执行的回合体 */
    execute: () => Promise<BotTurnResult>;
  },
): Promise<NodeFixture> {
  const { botId, execute } = options;
  const pairing = await f.json('/api/nodes/pairing', 'POST');
  const identity = await f.json<{ nodeId: string; token: string }>('/api/nodes/pairing/exchange', 'POST', {
    code: pairing.code,
    name: 'Reliability node',
    platform: 'linux',
  });
  const bots: BotConfig[] = [
    {
      id: botId,
      nodeId: identity.nodeId,
      name: botId,
      description: '',
      modelProvider: 'openai',
      modelId: 'test-model',
      thinkingLevel: 'medium',
      enabledSkills: [],
      updatedAt: new Date().toISOString(),
    },
  ];

  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-reliability-node-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  let epoch = 1;
  let executionCount = 0;
  let rpcCallCount = 0;
  let currentSocket: WebSocket | null = null;
  let currentRpc: NodeFixture['rpc'] | null = null;
  let currentOnMessage: ((data: string) => void) | undefined;
  let releaseTurn: (() => void) | null = null;
  const sockets: WebSocket[] = [];

  const connect = async () => {
    const wsUrl = f.base.replace(/^http/, 'ws') +
      `/ws/node?nodeId=${encodeURIComponent(identity.nodeId)}&token=${encodeURIComponent(identity.token)}`;
    const socket = new WebSocket(wsUrl);
    sockets.push(socket);
    currentSocket = socket;
    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
      {
        registerNode: async () => {},
        heartbeat: async () => {},
        getModelCatalog: async () => getBuiltinModelCatalog(),
        runTurn: async (input: Parameters<NodeRpcFunctions['runTurn']>[0]) => {
          rpcCallCount++;
          const connected = () => epoch !== 0;
          const promise = runTurnWithResilience(
            dataDir,
            bots[0],
            input,
            () => (connected() ? ({} as any) : null),
            () => (connected() ? epoch : 0),
            async () => {
              executionCount++;
              await new Promise<void>((resolve) => { releaseTurn = resolve; });
              return await execute();
            },
          );
          return await promise;
        },
        cancelTurn: async () => {},
        resetSession: async () => {},
      } as unknown as NodeRpcFunctions,
      {
        post: (data) => { if (socket.readyState === WebSocket.OPEN) socket.send(data); },
        on: (callback) => { currentOnMessage = callback; },
        serialize: serializeRpcMessage,
        deserialize: JSON.parse,
        timeout: 30_000,
      },
    );
    currentRpc = rpc;
    socket.on('message', (data) => {
      const raw = data.toString();
      if (currentOnMessage) {
        try { currentOnMessage(raw); } catch { /* malformed */ }
      }
    });
    await once(socket, 'open');
    await rpc.registerNode({
      nodeId: identity.nodeId,
      name: 'Reliability node',
      platform: 'linux',
      bots,
      skills: [],
      extensions: [],
    });
  };

  const simulateDisconnect = async () => {
    epoch = 0;
    currentOnMessage = undefined;
    currentSocket?.terminate();
    currentSocket = null;
    currentRpc?.$close();
    currentRpc = null;
    // 等 Hub 侧感知下线
    await waitFor(
      () => f.json<any>('/api/nodes'),
      (nodes) => nodes.find((n: any) => n.id === identity.nodeId)?.status === 'offline',
    );
  };

  const simulateReconnect = async () => {
    epoch += 1;
    await connect();
    await waitFor(
      () => f.json<any>('/api/nodes'),
      (nodes) => nodes.find((n: any) => n.id === identity.nodeId)?.status === 'online',
    );
  };

  t.after(() => {
    for (const socket of sockets) socket.terminate();
  });

  await connect();
  await waitFor(
    () => f.json<any>('/api/nodes'),
    (nodes) => nodes.find((n: any) => n.id === identity.nodeId)?.status === 'online',
  );

  return {
    identity,
    get socket() { return currentSocket!; },
    get rpc() { return currentRpc!; },
    executions: () => executionCount,
    rpcCalls: () => rpcCallCount,
    simulateDisconnect,
    simulateReconnect,
    setEpoch: (value: number) => { epoch = value; },
    releaseTurn: () => { releaseTurn?.(); releaseTurn = null; },
  };
}

// ---------------------------------------------------------------- scenario 1

test('场景 1（在途附着）：回合执行中节点闪断，会话转 queued 不报失败；重连后附着同一在途回合，底层只执行 1 次', { timeout: 60_000 }, async (t) => {
  const f = await startHubFixture(t);
  const node = await addResilientNode(f, t, {
    botId: 'worker',
    execute: async () => ({ replyText: 'long-task-result', modelBadge: 'openai/test-model' }),
  });

  const session = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: '长任务断连容错',
    mode: 'direct',
    leadBotId: 'worker',
    memberBotIds: ['worker'],
  });

  // 发消息触发回合；回合挂起不返回（模拟 20 分钟长任务）
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: '开始长任务' });
  await waitFor(() => node.executions(), (count) => count === 1);

  // 回合执行中节点闪断：Hub 不得把会话置为 failed，应转 queued（离线队列）
  await node.simulateDisconnect();
  const queued = await waitFor(
    () => f.json<SessionRecord[]>(`/api/sessions`),
    (list) => list.find((s) => s.id === session.id)?.status === 'queued',
  );
  assert.equal(queued.find((s) => s.id === session.id)!.status, 'queued', '断连后会话必须转 queued 而非 failed');

  // 断连期间不得出现 Error executing turn 系统消息
  const messagesDuringOutage = await f.json<any[]>(`/api/sessions/${session.id}/messages`);
  assert.equal(
    messagesDuringOutage.some((m) => m.role === 'system' && /Error executing turn/.test(m.content)),
    false,
    '断连不得写入 Error executing turn',
  );

  // 回合仍在节点上跑（未完成）；此时节点重连 → Hub onNodeOnline 补发同一回合
  // （Hub 侧补发会因 cursor 未推进而重发同一增量；节点附着到在途回合）
  await node.simulateReconnect();
  // 等待补发的 runTurn RPC 到达节点（附着，不新开执行）
  await waitFor(() => node.rpcCalls(), (count) => count >= 2, 15_000);

  // 释放长任务：底层 execute 只跑过 1 次
  node.releaseTurn();
  await waitFor(() => node.executions(), (count) => count === 1); // 仍为 1
  assert.equal(node.executions(), 1, '底层回合必须只执行 1 次（在途附着）');

  // 最终回复正常落库、会话回到 idle
  const finalMessages = await waitFor(
    () => f.json<any[]>(`/api/sessions/${session.id}/messages`),
    (list) => list.some((m) => m.role === 'assistant' && m.content === 'long-task-result'),
    15_000,
  );
  assert.equal(finalMessages.filter((m) => m.role === 'assistant' && m.content === 'long-task-result').length, 1, '回复恰好落库一次');
  const finalSession = await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((s) => s.id === session.id)?.status === 'idle',
    15_000,
  );
  assert.equal(finalSession.find((s) => s.id === session.id)!.status, 'idle');
});

// ---------------------------------------------------------------- scenario 2

test('场景 2（离线完成回执）：断连后节点离线跑完写入 .receipt.json；重连后 Hub 消费回执，底层只执行 1 次', { timeout: 60_000 }, async (t) => {
  const f = await startHubFixture(t);
  const node = await addResilientNode(f, t, {
    botId: 'worker',
    execute: async () => ({ replyText: 'offline-completed-result', modelBadge: 'openai/test-model' }),
  });

  const session = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: '离线完成回执',
    mode: 'direct',
    leadBotId: 'worker',
    memberBotIds: ['worker'],
  });

  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: '开始离线长任务' });
  await waitFor(() => node.executions(), (count) => count === 1);

  // 断连 → 会话转 queued
  await node.simulateDisconnect();
  await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((s) => s.id === session.id)?.status === 'queued',
  );

  // 节点在离线状态下跑完回合（WS 已断）→ 单槽回执写盘
  node.releaseTurn();
  await waitFor(() => node.executions(), () => true);
  // 给回执写盘一个微任务周期
  await new Promise((r) => setTimeout(r, 100));

  // 节点重连：Hub 补发同一回合 → 节点消费回执直接返回（不重复调用模型）
  await node.simulateReconnect();
  const finalMessages = await waitFor(
    () => f.json<any[]>(`/api/sessions/${session.id}/messages`),
    (list) => list.some((m) => m.role === 'assistant' && m.content === 'offline-completed-result'),
    15_000,
  );
  assert.equal(
    finalMessages.filter((m) => m.role === 'assistant' && m.content === 'offline-completed-result').length,
    1,
    '离线完成的结果恰好落库一次',
  );
  assert.equal(node.executions(), 1, '底层回合必须只执行 1 次（回执消费，不重复调用模型）');

  const finalSession = await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((s) => s.id === session.id)?.status === 'idle',
    15_000,
  );
  assert.equal(finalSession.find((s) => s.id === session.id)!.status, 'idle');
});

// ---------------------------------------------------------------- scenario 3

test('场景 3（Hub 重启恢复）：queued_offline 会话保持 queued；孤儿 running 会话变 failed 并写入含「继续」提示的系统消息', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reliability-restart-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  try {
    // 第一次初始化：构造 running 孤儿会话 + 含 queued_offline 待发任务的 queued 会话
    {
      const db = new HubDatabase({ dbPath });
      db.ensureBootstrapAdmin('dummy-hash');
      const admin = db.getUserWithHash('admin');
      assert(admin, 'admin must exist');
      db.createNode({
        id: 'node_r',
        name: 'Restart Node',
        platform: 'linux',
        tokenHash: 'x'.repeat(64),
        ownerId: admin.id,
      });
      db.saveBot({
        id: 'bot_r',
        nodeId: 'node_r',
        name: 'bot_r',
        description: '',
        modelProvider: 'openai',
        modelId: 'm',
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        updatedAt: new Date().toISOString(),
      });
      // 孤儿 running：Hub 在回合运行期间被杀，无任何待发任务
      db.createSession({
        id: 'sess_orphan',
        title: '孤儿运行中',
        leadBotId: 'bot_r',
        ownerId: admin.id,
      });
      db.updateSessionStatus('sess_orphan', 'running', 'bot_r');
      // queued + queued_offline 待发任务：断连转队列后 Hub 重启
      db.createSession({
        id: 'sess_pending',
        title: '待发排队',
        leadBotId: 'bot_r',
        ownerId: admin.id,
      });
      db.updateSessionStatus('sess_pending', 'queued', undefined);
      db.enqueueOutboundTask({
        nodeId: 'node_r',
        botId: 'bot_r',
        sessionId: 'sess_pending',
        taskType: 'turn',
        payload: { generation: 0 },
      });
      // 占位的 user 消息（避免空会话）
      db.createMessage({ id: 'msg_u1', sessionId: 'sess_orphan', role: 'user', content: '跑长任务' });
      db.db.close();
    }

    // 重新初始化（触发 resetStaleMetadata，模拟 Hub 重启）
    const db = new HubDatabase({ dbPath });
    t.after(() => db.db.close());

    // 含待发任务的会话保持 queued（不抹成 idle / failed）
    const pending = db.getSession('sess_pending');
    assert.ok(pending, 'sess_pending must exist');
    assert.equal(pending.status, 'queued', '有 queued_offline 待发任务的会话必须保持 queued');
    assert.equal(pending.activeBotId, undefined);

    // 孤儿 running 会话变 failed，且写入诚实中断的 system 消息
    const orphan = db.getSession('sess_orphan');
    assert.ok(orphan, 'sess_orphan must exist');
    assert.equal(orphan.status, 'failed', '无待发任务的孤儿 running 会话必须标记 failed');
    assert.equal(orphan.activeBotId, undefined);
    const orphanMessages = db.getMessages('sess_orphan');
    const restartNotice = orphanMessages.find(
      (m) => m.role === 'system' && m.content.includes('服务重启中断'),
    );
    assert.ok(restartNotice, `必须写入服务重启中断的 system 消息，实际：${JSON.stringify(orphanMessages.map((m) => m.content))}`);
    assert.match(restartNotice!.content, /继续/);
    assert.match(restartNotice!.content, /工作流断点已保留/);

    // 节点全部置 offline
    const node = db.getNode('node_r');
    assert.equal(node!.status, 'offline');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- scenario 4

test('场景 4（工作流断点提示生命周期）：失败 / 中断后提示含 resumeFromRunId；成功完成后自动清除', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reliability-workflow-'));
  const workspaceDir = path.join(dir, 'workspace');
  const workflowsDir = path.join(workspaceDir, '.workflows');
  await mkdir(workflowsDir, { recursive: true });
  try {
    // 无标记时提示为空
    assert.equal(await readUnfinishedWorkflowHint(workspaceDir), '');

    // 启动工作流：写脚本副本 + 断点标记
    const runId = 'wf_hinttest01';
    const scriptPath = path.join(workflowsDir, `${runId}.mjs`);
    await writeFile(scriptPath, 'export const meta = { name: "hint-flow" }\nreturn 1;\n');
    await markWorkflowRunStarted(workspaceDir, { runId, workflowName: 'hint-flow', scriptPath });
    assert.ok(existsSync(path.join(workflowsDir, 'latest-unfinished.json')), '断点标记必须落盘');

    // 工作流失败 / 中断：标记保留 → 提示注入
    const hint = await readUnfinishedWorkflowHint(workspaceDir);
    assert.match(hint, /未完成工作流断点提醒/);
    assert.match(hint, /hint-flow/);
    assert.match(hint, new RegExp(`resumeFromRunId: "${runId}"`));
    assert.match(hint, new RegExp(`scriptPath: "${scriptPath}"`));

    // 正常跑完：标记清除 → 提示为空
    await markWorkflowRunFinished(workspaceDir);
    assert.equal(existsSync(path.join(workflowsDir, 'latest-unfinished.json')), false, '完成后标记必须删除');
    assert.equal(await readUnfinishedWorkflowHint(workspaceDir), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- receipt unit behaviors

test('回执签名与消费：相同签名命中且只消费一次；不同签名不命中', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reliability-receipt-'));
  const dataDir = path.join(dir, 'data');
  const bot: BotConfig = {
    id: 'bot_receipt',
    nodeId: 'node_x',
    name: 'bot_receipt',
    description: '',
    modelProvider: 'openai',
    modelId: 'm',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  const input = {
    sessionId: 'sess_receipt',
    botId: 'bot_receipt',
    groupContextPrompt: '',
    incrementalMessages: 'User: hi',
  };
  try {
    assert.equal(
      turnSignature({ ...input, commandText: undefined } as any),
      turnSignature({ ...input, commandText: '' } as any),
      'commandText undefined 与空串视为同一回合',
    );
    assert.notEqual(
      turnSignature({ ...input } as any),
      turnSignature({ ...input, incrementalMessages: 'User: other' } as any),
    );

    // 离线完成 → 写回执；重连后同签名调用消费回执（execute 0 次）
    let executions = 0;
    const execute = async (): Promise<BotTurnResult> => {
      executions++;
      return { replyText: 'r1', modelBadge: 'b' };
    };
    // epoch 探测器：启动时在线（epoch 1），execute 桩执行后切到断开（0）→ 完成时写回执
    let epoch = 1;
    const result1 = await runTurnWithResilience(
      dataDir,
      bot,
      input as any,
      () => (epoch === 0 ? null : ({} as any)),
      () => epoch,
      async () => {
        epoch = 0; // 模拟执行期间断连
        return await execute();
      },
    );
    assert.equal(result1.replyText, 'r1');
    assert.equal(executions, 1);

    // 重连：同签名 → 消费回执，不再执行
    epoch = 2;
    const result2 = await runTurnWithResilience(dataDir, bot, input as any, () => ({}) as any, () => epoch, execute);
    assert.equal(result2.replyText, 'r1');
    assert.equal(executions, 1, '回执必须只消费一次，不重复执行');

    // 再次调用（回执已被消费）→ 重新执行
    const result3 = await runTurnWithResilience(
      dataDir,
      bot,
      input as any,
      () => ({}) as any,
      () => epoch,
      async () => {
        epoch = 0;
        return await execute();
      },
    );
    assert.equal(result3.replyText, 'r1');
    assert.equal(executions, 2);

    // 不同签名不吃旧回执
    epoch = 1;
    await runTurnWithResilience(
      dataDir,
      bot,
      { ...input, incrementalMessages: 'User: changed' } as any,
      () => ({} as any),
      () => epoch,
      async () => {
        epoch = 0; // 执行期间断连 → 离线完成写回执
        return await execute();
      },
    );
    const receiptFile = path.join(dataDir, 'bots', bot.id, 'sessions', `${input.sessionId}.receipt.json`);
    assert.ok(existsSync(receiptFile), '离线完成必须写入回执');
    const stored = JSON.parse(await readFile(receiptFile, 'utf8'));
    assert.equal(stored.signature, turnSignature({ ...input, incrementalMessages: 'User: changed' } as any));

    // clearTurnReceipt 清理
    await clearTurnReceipt(dataDir, input.sessionId, bot.id);
    assert.equal(existsSync(receiptFile), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
