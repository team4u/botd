import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { startHub } from '../apps/hub/src/index.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import type {
  BotConfig,
  HubRpcFunctions,
  NodeRpcFunctions,
  PendingAskRecord,
  ProviderLoginState,
  SessionRecord,
  SessionSseEvent,
} from '../packages/protocol/src/index.js';

const PASSWORD = 'test-secret-password-123';

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the expected state');
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test('Hub 重启登录态持久化：同一 dbPath 重启后先前签发的 Cookie 依然能通过 /api/auth/me 鉴权', async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-persist-auth-'));
  const dbPath = path.join(dir, 'hub.sqlite');

  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // 1. 启动 Hub 实例 1 并登录获取 Cookie
  const hub1 = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath,
    adminPassword: PASSWORD,
  });
  const addr1 = hub1.server.address();
  assert(addr1 && typeof addr1 !== 'string');
  const base1 = `http://127.0.0.1:${addr1.port}`;

  const loginRes = await fetch(`${base1}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(loginRes.status, 200, '首次登录成功');
  const rawSetCookie = loginRes.headers.get('set-cookie');
  assert(rawSetCookie, '必须返回 set-cookie');
  const cookie = rawSetCookie.split(';')[0];

  // 验证在 Hub 1 上鉴权通过
  const meRes1 = await fetch(`${base1}/api/auth/me`, {
    headers: { cookie },
  });
  assert.equal(meRes1.status, 200);
  const meData1 = (await meRes1.json()) as { user: { username: string; role: string } };
  assert.equal(meData1.user.username, 'admin');

  // 关闭 Hub 1
  hub1.server.closeAllConnections();
  await hub1.close();

  // 2. 检查底层 DB 中是否已持久化 auth_secret 设置
  const checkDb = new HubDatabase({ dbPath });
  const savedSecret = checkDb.getSetting<string>('auth_secret');
  assert(savedSecret && typeof savedSecret === 'string' && savedSecret.length > 0, 'auth_secret 必须已保存至 settings 表');

  // 3. 启动 Hub 实例 2（复用同一 dbPath，模拟服务重启）
  const hub2 = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath,
    adminPassword: PASSWORD,
  });
  const addr2 = hub2.server.address();
  assert(addr2 && typeof addr2 !== 'string');
  const base2 = `http://127.0.0.1:${addr2.port}`;

  t.after(async () => {
    hub2.server.closeAllConnections();
    await hub2.close();
  });

  // 使用 Hub 1 签发的 cookie 访问 Hub 2 的 /api/auth/me
  const meRes2 = await fetch(`${base2}/api/auth/me`, {
    headers: { cookie },
  });
  assert.equal(meRes2.status, 200, 'Hub 重启后原先签发的 Cookie 依然能通过鉴权');
  const meData2 = (await meRes2.json()) as { user: { username: string; role: string } };
  assert.equal(meData2.user.username, 'admin');
  assert.equal(meData2.user.role, 'admin');
});

test('db.savePendingAsk / getPendingAsksForSession 持久化、状态更新与过期清理', async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-persist-asks-'));
  const dbPath = path.join(dir, 'hub.sqlite');

  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const db = new HubDatabase({ dbPath });
  db.ensureBootstrapAdmin('fake_hash');

  const now = new Date();
  const futureExpiry = new Date(now.getTime() + 60_000).toISOString();
  const pastExpiry = new Date(now.getTime() - 10_000).toISOString();

  // 1. 创建并持久化待确认项 ask1
  const ask1: PendingAskRecord = {
    id: 'ask_test_1',
    sessionId: 'sess_test',
    botId: 'bot_alpha',
    prompt: 'Please confirm release',
    options: ['yes', 'no'],
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: futureExpiry,
  };
  db.savePendingAsk(ask1);

  // 立即查询：应查到 ask1
  const asksAfterSave = db.getPendingAsksForSession('sess_test');
  assert.equal(asksAfterSave.length, 1);
  assert.equal(asksAfterSave[0].id, 'ask_test_1');
  assert.equal(asksAfterSave[0].prompt, 'Please confirm release');
  assert.deepEqual(asksAfterSave[0].options, ['yes', 'no']);
  assert.equal(asksAfterSave[0].status, 'pending');

  // 2. 状态更新为 answered，之后 getPendingAsksForSession 不再返回（仅返回 pending）
  db.updatePendingAskStatus('ask_test_1', 'answered', 'yes');
  assert.equal(db.getPendingAsksForSession('sess_test').length, 0);

  // 3. 保存一个已过期的 ask2：调用 getPendingAsksForSession 时自动更新其为 expired 并过滤
  const ask2: PendingAskRecord = {
    id: 'ask_test_2',
    sessionId: 'sess_test',
    botId: 'bot_beta',
    prompt: 'Expired prompt',
    options: ['ok'],
    status: 'pending',
    createdAt: new Date(now.getTime() - 20_000).toISOString(),
    expiresAt: pastExpiry,
  };
  db.savePendingAsk(ask2);
  const asksAfterExpired = db.getPendingAsksForSession('sess_test');
  assert.equal(asksAfterExpired.length, 0, '已过期记录应自动标记并被过滤');

  // 4. 重启 DB 实例测试：新建有效 ask3，关闭重开后依然能查询
  const ask3: PendingAskRecord = {
    id: 'ask_test_3',
    sessionId: 'sess_test',
    botId: 'bot_gamma',
    prompt: 'Persistent ask survives restart',
    options: ['a', 'b'],
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  db.savePendingAsk(ask3);

  const db2 = new HubDatabase({ dbPath });
  const asksDb2 = db2.getPendingAsksForSession('sess_test');
  assert.equal(asksDb2.length, 1);
  assert.equal(asksDb2[0].id, 'ask_test_3');
  assert.equal(asksDb2[0].prompt, 'Persistent ask survives restart');

  // 5. 级联清理测试：创建对应 session 记录并调用 deleteSession，同步清理 pending_asks
  db2.createSession({
    id: 'sess_test',
    title: 'Test Session',
    mode: 'direct',
    leadBotId: 'bot_gamma',
    memberBotIds: ['bot_gamma'],
    ownerId: 'user_admin',
  });
  db2.deleteSession('sess_test');
  assert.equal(db2.getPendingAsksForSession('sess_test').length, 0, 'deleteSession 应同步清理 pending_asks 行');
});

test('会话运行时，session_status SSE 事件携带 activeBotIds 数组', async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-parallel-sse-'));
  const dbPath = path.join(dir, 'hub.sqlite');

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath,
    adminPassword: PASSWORD,
  });
  const addr = hub.server.address();
  assert(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  const sockets: WebSocket[] = [];

  t.after(async () => {
    for (const s of sockets) s.terminate();
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  // 登录获取 cookie
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0];

  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const res = await fetch(base + route, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        cookie,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const result = await res.json();
    assert(res.ok, `${method} ${route}: ${res.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  // 准备 mock node 节点
  const pairing = await json('/api/nodes/pairing', 'POST');
  const identity = await json('/api/nodes/pairing/exchange', 'POST', {
    code: pairing.code,
    name: 'Parallel Test Node',
    platform: 'linux',
  });

  const botIds = ['lead-judge', 'agent-reviewer-1', 'agent-reviewer-2'];
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

  const turnEntered = deferred<void>();
  const allowTurnFinish = deferred<void>();

  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`);
  sockets.push(socket);

  const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
    {
      getModelCatalog: async () => getBuiltinModelCatalog(),
      startProviderLogin: async () => ({ id: '1', providerId: 'openai', method: 'api_key', status: 'pending', events: [] }),
      getProviderLogin: async () => ({ id: '1', providerId: 'openai', method: 'api_key', status: 'pending', events: [] }),
      respondProviderLogin: async () => ({ id: '1', providerId: 'openai', method: 'api_key', status: 'pending', events: [] }),
      cancelProviderLogin: async () => {},
      logoutProvider: async () => {},
      saveBot: async () => {},
      deleteBot: async () => {},
      readFile: async () => '',
      writeFile: async () => {},
      installResource: async () => ({ kind: 'skill', id: 'inst' }),
      deleteResource: async () => {},
      restartDaemon: async () => ({ ok: true, pid: 1234 }),
      getCommands: async () => [],
      runTurn: async () => {
        turnEntered.resolve();
        await allowTurnFinish.promise;
        return { replyText: 'Summary from lead judge', modelBadge: 'model/lead' };
      },
      cancelTurn: async () => {},
      resetSession: async () => {},
    },
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
    name: 'Parallel Test Node',
    platform: 'linux',
    bots,
    skills: [],
    extensions: [],
  });

  // 创建单主控会话
  const session = await json<SessionRecord>('/api/sessions', 'POST', {
    title: 'Workflow Session',
    mode: 'direct',
    leadBotId: 'lead-judge',
    memberBotIds: ['lead-judge'],
  });

  // 监听会话 SSE 事件流
  const sseEvents: SessionSseEvent[] = [];
  const controller = new AbortController();
  t.after(() => controller.abort());

  const sseStream = await fetch(`${base}/api/sessions/${session.id}/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  assert.equal(sseStream.status, 200);

  const reader = sseStream.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n\n');
        sseBuffer = lines.pop() || '';
        for (const block of lines) {
          const match = block.match(/^data:\s*(.+)$/m);
          if (match) {
            try {
              sseEvents.push(JSON.parse(match[1]));
            } catch {}
          }
        }
      }
    } catch {}
  })();

  // 发送触发消息
  await json(`/api/sessions/${session.id}/messages`, 'POST', {
    content: 'Start evaluation now',
  });

  // 等待进入活跃推理
  await turnEntered.promise;

  // 1. 验证 SSE 收到 activeBotIds 包含当前活跃 BOT 的 session_status 事件
  const statusEvent = await waitFor(
    () => sseEvents.filter((e): e is Extract<SessionSseEvent, { type: 'session_status' }> => e.type === 'session_status'),
    (list) => list.some((e) => e.status === 'running' && Array.isArray(e.activeBotIds) && e.activeBotIds.length === 1)
  );
  const initialRunningEvent = statusEvent.find((e) => e.status === 'running' && e.activeBotIds?.length === 1)!;
  assert.deepEqual(
    initialRunningEvent.activeBotIds,
    ['lead-judge'],
    '启动时广播携带 activeBotIds'
  );

  // 2. 验证 GET /api/sessions 返回运行中的会话附加了 activeBotIds
  const sessionsList = await json<SessionRecord[]>('/api/sessions');
  const runningSession = sessionsList.find((s) => s.id === session.id);
  assert(runningSession, '列表必须包含当前会话');
  assert.equal(runningSession.status, 'running');
  assert.deepEqual(
    runningSession.activeBotIds,
    ['lead-judge'],
    'GET /api/sessions 对 running 状态会话附加 activeBotIds'
  );

  // 3. 放行完成，会话回到 idle 广播 activeBotIds: []
  allowTurnFinish.resolve();

  await waitFor(
    () => sseEvents.filter((e): e is Extract<SessionSseEvent, { type: 'session_status' }> => e.type === 'session_status'),
    (list) => list.some((e) => e.status === 'idle' && Array.isArray(e.activeBotIds) && e.activeBotIds.length === 0)
  );

  // 最终会话消息完整
  const messages = await json<any[]>(`/api/sessions/${session.id}/messages`);
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 1, '包含助手回复');
});
