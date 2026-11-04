import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { startHub } from '../apps/hub/src/index.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import type {
  BotConfig,
  HubRpcFunctions,
  MessageRecord,
  NodeRpcFunctions,
  SessionRecord,
  SubagentRunRecord,
} from '../packages/protocol/src/index.js';

const PASSWORD = '{{SECRET_hb7g2sqw}}';

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for the expected state');
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-subagent-ctrl-'));
  const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'hub.sqlite'), adminPassword: PASSWORD });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  let cookie = '';
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = async (route: string, method = 'GET', body?: unknown) =>
    fetch(base + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(route, method, body);
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  interface NodeHarness {
    identity: { nodeId: string; hubUrl: string; token: string };
    rpc: BirpcHarness;
    stopSubagentCalls: { sessionId: string; botId: string; runId: string }[];
    interactCalls: Array<{
      sessionId: string;
      botId: string;
      runId: string;
      message: string;
      mode: 'steer' | 'resume';
    }>;
    steerBotTurnCalls: { sessionId: string; botId: string; message: string }[];
  }
  interface BirpcHarness {
    registerNode(input: unknown): Promise<void>;
    onSessionStream(event: unknown): void;
  }

  const addNode = async (
    botIds: string[],
    handlers: {
      runTurn?: NodeRpcFunctions['runTurn'];
      stopSubagent?: NodeRpcFunctions['stopSubagent'];
      interactSubagent?: NodeRpcFunctions['interactSubagent'];
      steerBotTurn?: NodeRpcFunctions['steerBotTurn'];
    } = {}
  ): Promise<NodeHarness> => {
    const pairing = await json<{ code: string }>('/api/nodes/pairing', 'POST');
    const identity = await json<{ nodeId: string; hubUrl: string; token: string }>(
      '/api/nodes/pairing/exchange',
      'POST',
      { code: pairing.code, name: 'Ctrl node', platform: 'linux' }
    );
    const bots: BotConfig[] = botIds.map((id) => ({
      id,
      nodeId: identity.nodeId,
      name: id,
      description: '',
      modelProvider: 'openai',
      modelId: 'test-model',
      thinkingLevel: 'medium',
      enabledSkills: [],
      updatedAt: new Date().toISOString(),
    }));

    const stopSubagentCalls: NodeHarness['stopSubagentCalls'] = [];
    const interactCalls: NodeHarness['interactCalls'] = [];
    const steerBotTurnCalls: NodeHarness['steerBotTurnCalls'] = [];

    const socket = new WebSocket(
      `${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`
    );
    sockets.push(socket);

    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
      {
        getModelCatalog: async () => getBuiltinModelCatalog(),
        getCommands: async () => [],
        runTurn:
          handlers.runTurn ??
          (async (input) => ({ replyText: `Reply from ${input.botId}`, modelBadge: 'openai/test-model' })),
        cancelTurn: async () => {},
        steerBotTurn: async (sessionId: string, botId: string, message: string) => {
          steerBotTurnCalls.push({ sessionId, botId, message });
          return handlers.steerBotTurn ? handlers.steerBotTurn(sessionId, botId, message) : { accepted: true };
        },
        stopSubagent: async (sessionId: string, botId: string, runId: string) => {
          stopSubagentCalls.push({ sessionId, botId, runId });
          return handlers.stopSubagent ? handlers.stopSubagent(sessionId, botId, runId) : { ok: true };
        },
        interactSubagent: async (input: Parameters<NonNullable<NodeRpcFunctions['interactSubagent']>>[0]) => {
            interactCalls.push({
              sessionId: input.sessionId,
              botId: input.botId,
              runId: input.runId,
              message: input.message,
              mode: input.mode,
            });
            if (handlers.interactSubagent) return handlers.interactSubagent(input);
            return {
              ok: true,
              run: {
                id: input.runId,
                subagentId: 'reviewer',
                subagentName: '审查员',
                task: '初始任务',
                status: input.mode === 'resume' ? 'done' : 'running',
                replyFull: `回复：${input.message}`,
                replyPreview: `回复：${input.message}`.slice(0, 200),
                steers: [{ message: input.message, timestamp: new Date().toISOString(), mode: input.mode }],
              } satisfies SubagentRunRecord,
            };
        },
      } as unknown as NodeRpcFunctions,
      {
        post: (data) => socket.send(data),
        on: (callback) => socket.on('message', (data) => callback(data.toString())),
        serialize: serializeRpcMessage,
        deserialize: JSON.parse,
        timeout: 10_000,
      }
    );
    await once(socket, 'open');
    await rpc.registerNode({
      nodeId: identity.nodeId,
      name: 'Ctrl node',
      platform: 'linux',
      bots,
      skills: [],
      extensions: [],
    });
    return { identity, rpc: rpc as unknown as BirpcHarness, stopSubagentCalls, interactCalls, steerBotTurnCalls };
  };

  const session = (ids: string[], mode: 'direct' | 'lead' = 'lead') =>
    json<SessionRecord>('/api/sessions', 'POST', { title: 'Ctrl session', mode, leadBotId: ids[0], memberBotIds: ids });
  const messages = (id: string) => json<MessageRecord[]>(`/api/sessions/${id}/messages`);
  const idle = async (id: string) =>
    waitFor(
      () => json<SessionRecord[]>('/api/sessions'),
      (list) => list.find((s) => s.id === id)?.status !== 'running'
    );

  return { hub, base, request, json, addNode, session, messages, idle };
}

test('subagent run record protocol carries full reply / toolCalls / steers / stopped status', () => {
  const run: SubagentRunRecord = {
    id: 'agent_abc',
    subagentId: 'reviewer',
    subagentName: '审查员',
    color: 'indigo',
    task: '审查 runtime.ts 的取消路径',
    status: 'stopped',
    toolCount: 2,
    durationMs: 12_345,
    replyPreview: '部分输出…',
    replyFull: '完整的子代理输出，绝不截断'.repeat(20),
    toolCalls: [
      { id: 'tc_1', name: 'read', args: { path: 'a.ts' }, status: 'done', durationMs: 12 },
      { id: 'tc_2', name: 'bash', summary: 'pnpm test', status: 'running' },
    ],
    steers: [
      { message: '改用方案 B', timestamp: '2025-01-01T00:00:00Z', mode: 'steer' },
      { message: '再查一下 X', timestamp: '2025-01-01T00:01:00Z', mode: 'resume' },
    ],
  };
  // childSessionId 已删除：主会话内子代理不建独立 Hub Session
  assert.equal('childSessionId' in (run as unknown as Record<string, unknown>), false);
  assert.equal(run.status, 'stopped');
  assert.equal(run.replyFull!.length, 13 * 20);
  assert.equal(run.toolCalls!.length, 2);
  assert.equal(run.steers![1].mode, 'resume');
  // 序列化往返保持全部字段
  const revived = JSON.parse(JSON.stringify(run));
  assert.deepEqual(revived.toolCalls[1], { id: 'tc_2', name: 'bash', summary: 'pnpm test', status: 'running' });
  assert.deepEqual(revived.steers[0], { message: '改用方案 B', timestamp: '2025-01-01T00:00:00Z', mode: 'steer' });
});

test('POST /api/sessions/:id/subagents/:runId/stop forwards to the owning node and mirrors status', async (t) => {
  const f = await fixture(t);

  // 制造一条已落库的包含子代理 run 的助手消息（父消息 sender = 主 BOT）：挂起第一回合让流事件生效
  const runId = 'agent_stop_1';
  const turnGate = deferred<void>();
  let released = false;
  const node = await f.addNode(['lead'], {
    runTurn: async () => {
      if (!released) {
        released = true;
        await turnGate.promise;
      }
      return {
        replyText: '已完成',
        modelBadge: 'openai/test-model',
        subagentRuns: [{ id: runId, subagentId: 'reviewer', task: '审查代码', status: 'running' }],
      };
    },
  });
  const s = await f.session(['lead'], 'direct');
  await f.json(`/api/sessions/${s.id}/messages`, 'POST', { content: '请审查这段代码' });
  await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((x) => x.id === s.id)?.status === 'running'
  );
  // 通过节点流事件镜像一条 running 记录
  node.rpc.onSessionStream({
    sessionId: s.id,
    botId: 'lead',
    subagentEvent: {
      id: runId,
      subagentId: 'reviewer',
      task: '审查代码',
      status: 'running',
    },
  });
  await f.json(`/api/sessions/${s.id}/subagents/${runId}/stop`, 'POST', {});

  assert.equal(node.stopSubagentCalls.length, 1);
  assert.equal(node.stopSubagentCalls[0].sessionId, s.id);
  assert.equal(node.stopSubagentCalls[0].botId, 'lead');
  assert.equal(node.stopSubagentCalls[0].runId, runId);
  turnGate.resolve();
  await f.idle(s.id);
});

test('POST /api/sessions/:id/subagents/:runId/interact routes steer vs resume and persists updated run', async (t) => {
  const f = await fixture(t);
  const runId = 'agent_interact_1';
  const turnGate = deferred<void>();
  let released = false;
  const node = await f.addNode(['lead'], {
    runTurn: async () => {
      if (!released) {
        released = true;
        await turnGate.promise;
      }
      return {
        replyText: '已完成',
        modelBadge: 'openai/test-model',
        subagentRuns: [{ id: runId, subagentId: 'reviewer', task: '调研', status: 'running' }],
      };
    },
  });
  const s = await f.session(['lead'], 'direct');
  await f.json(`/api/sessions/${s.id}/messages`, 'POST', { content: '开始调研' });
  await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((x) => x.id === s.id)?.status === 'running'
  );

  // 镜像运行记录
  node.rpc.onSessionStream({
    sessionId: s.id,
    botId: 'lead',
    subagentEvent: { id: runId, subagentId: 'reviewer', task: '调研', status: 'running' },
  });

  // steer（运行中插话）
  const steerRes = await f.json<{ ok: boolean; run?: SubagentRunRecord }>(
    `/api/sessions/${s.id}/subagents/${runId}/interact`,
    'POST',
    { message: '优先看并发路径', mode: 'steer' }
  );
  assert.equal(steerRes.ok, true);
  assert.equal(node.interactCalls.length, 1);
  assert.equal(node.interactCalls[0].mode, 'steer');
  assert.equal(node.interactCalls[0].message, '优先看并发路径');

  // resume（结束后追问）—— 默认缺省 mode 也是 steer；显式传 resume
  const resumeRes = await f.json<{ ok: boolean; run?: SubagentRunRecord }>(
    `/api/sessions/${s.id}/subagents/${runId}/interact`,
    'POST',
    { message: '再查一下 X', mode: 'resume' }
  );
  assert.equal(resumeRes.ok, true);
  assert.equal(node.interactCalls.length, 2);
  assert.equal(node.interactCalls[1].mode, 'resume');
  assert.equal(resumeRes.run!.replyFull, '回复：再查一下 X');
  assert.equal(resumeRes.run!.steers![0].mode, 'resume');

  // 空 message 校验
  const bad = await f.request(`/api/sessions/${s.id}/subagents/${runId}/interact`, 'POST', { message: '  ' });
  assert.equal(bad.status, 400);

  turnGate.resolve();
  await f.idle(s.id);
});

test('user message during a running turn prefers steerBotTurn and advances the cursor (no duplicate queue run)', async (t) => {
  const f = await fixture(t);
  const turnRelease = deferred<void>();
  let turnCount = 0;
  const node = await f.addNode(['lead'], {
    runTurn: async () => {
      turnCount++;
      if (turnCount === 1) await turnRelease.promise; // 第一回合挂起，模拟等待子代理
      return { replyText: `Reply ${turnCount}`, modelBadge: 'openai/test-model' };
    },
  });
  const s = await f.session(['lead'], 'direct');

  // 第一条消息触发第一回合（运行中）
  await f.json(`/api/sessions/${s.id}/messages`, 'POST', { content: '开始审查' });
  await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((x) => x.id === s.id)?.status === 'running'
  );

  // 运行中再发一条：应走 steerBotTurn（节点 accepted），而不是排队跑第二轮
  await f.json(`/api/sessions/${s.id}/messages`, 'POST', { content: '把 reviewer 停下' });
  await waitFor(() => node.steerBotTurnCalls.length, (n) => n > 0);
  assert.equal(node.steerBotTurnCalls[0].sessionId, s.id);
  assert.equal(node.steerBotTurnCalls[0].botId, 'lead');
  assert.equal(node.steerBotTurnCalls[0].message, '把 reviewer 停下');

  // 释放第一回合并等待 idle
  turnRelease.resolve();
  await f.idle(s.id);

  // steerBotTurn 已 accepted：消息已被当前回合消费，不该再排队跑一次
  assert.equal(turnCount, 1);
});

test('user message falls back to queueing when steerBotTurn is not accepted', async (t) => {
  const f = await fixture(t);
  const turnRelease = deferred<void>();
  let turnCount = 0;
  const node = await f.addNode(['lead'], {
    runTurn: async () => {
      turnCount++;
      if (turnCount === 1) await turnRelease.promise;
      return { replyText: `Reply ${turnCount}`, modelBadge: 'openai/test-model' };
    },
    steerBotTurn: async () => ({ accepted: false }),
  });
  const s = await f.session(['lead'], 'direct');

  await f.json(`/api/sessions/${s.id}/messages`, 'POST', { content: '开始调研' });
  await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((x) => x.id === s.id)?.status === 'running'
  );

  // 运行中再发一条：steerBotTurn 拒绝 → 回落入队，第一回合结束后应执行第二轮
  await f.json(`/api/sessions/${s.id}/messages`, 'POST', { content: '补充：也要看测试' });
  await waitFor(() => node.steerBotTurnCalls.length, (n) => n > 0);

  turnRelease.resolve();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const list = await f.json<any[]>('/api/sessions');
    const st = list.find((x) => x.id === s.id)?.status;
    if (st !== 'running' && turnCount >= 2) break;
  }
  assert.equal(turnCount, 2);
});

test('native subagent stream events persist replyFull / toolCalls / steers / stopped onto the parent message', async (t) => {
  const f = await fixture(t);
  // 第一回合挂起直到 firstTurnGate 被释放（模拟主 Bot 等待子代理）
  const firstTurnGate = deferred<void>();
  let firstTurnReleased = false;
  const runId = 'agent_persist_1';
  const node = await f.addNode(['lead'], {
    runTurn: async () => {
      if (!firstTurnReleased) {
        firstTurnReleased = true;
        await firstTurnGate.promise;
        return {
          replyText: '主回合完成',
          modelBadge: 'openai/test-model',
          subagentRuns: [{ id: runId, subagentId: 'reviewer', task: '并发审查', status: 'running' }],
        };
      }
      return { replyText: '主回合完成', modelBadge: 'openai/test-model' };
    },
  });
  const s = await f.session(['lead'], 'direct');

  // 用户消息 → 第一回合挂起（等子代理）
  await f.json(`/api/sessions/${s.id}/messages`, 'POST', { content: '并发审查' });
  await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((x) => x.id === s.id)?.status === 'running'
  );

  // 子代理开始运行：携带 currentTool / toolCalls / steers 全量字段
  node.rpc.onSessionStream({
    sessionId: s.id,
    botId: 'lead',
    subagentEvent: {
      id: runId,
      subagentId: 'reviewer',
      task: '并发审查',
      status: 'running',
      currentTool: 'read',
      toolCalls: [
        { id: 'tc1', name: 'read', status: 'done', durationMs: 5 },
        { id: 'tc2', name: 'grep', status: 'running' },
      ],
      steers: [{ message: '注意锁的粒度', timestamp: '2025-01-01T00:00:00Z', mode: 'steer' }],
    },
  });

  // 主回合完成：runTurn 返回该子代理 run（router 会与镜像记录合并落库到父消息）
  firstTurnReleased = true;
  firstTurnGate.resolve();
  await f.idle(s.id);

  // 子代理在后台完成（父消息已落库）：stopped 状态 + 完整 replyFull
  node.rpc.onSessionStream({
    sessionId: s.id,
    botId: 'lead',
    subagentEvent: {
      id: runId,
      subagentId: 'reviewer',
      task: '并发审查',
      status: 'stopped',
      result: '已按用户要求停止，部分发现：…'.repeat(30),
      durationMs: 9_000,
      toolUses: 2,
      toolCalls: [
        { id: 'tc1', name: 'read', status: 'done', durationMs: 5 },
        { id: 'tc2', name: 'grep', status: 'cancelled' },
      ],
      steers: [{ message: '注意锁的粒度', timestamp: '2025-01-01T00:00:00Z', mode: 'steer' }],
    },
  });

  // 已落库父消息中的 subagentRuns 应被持久化更新
  const persisted = (await waitFor(async () => {
    const msgs = await f.messages(s.id);
    return msgs.find((m) => m.subagentRuns?.some((r) => r.id === runId))?.subagentRuns?.find((r) => r.id === runId);
  }, (run) => Boolean(run && run.status === 'stopped')))!;
  assert.equal(persisted.status, 'stopped');
  assert.equal(persisted.replyFull, '已按用户要求停止，部分发现：…'.repeat(30));
  assert.equal(persisted.replyPreview!.length <= 500, true);
  assert.equal(persisted.toolCalls!.length, 2);
  assert.equal(persisted.toolCalls![1].status, 'cancelled');
  assert.equal(persisted.steers![0].message, '注意锁的粒度');
});
