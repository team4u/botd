/**
 * 生产 Durable 存储兜底 / botd wake 的 Durable 路由 / hub.drain 的 Durable 感知。
 *
 * 1. `createHub()` 在 `BOTD_DB_PATH` 指定且 `options.dbPath` 缺省（与生产 startHub
 *    相同）时，`ensureDurableRuntime()` 与业务表共用同一个 `hub.sqlite`
 *    （pi_* 前缀表单库共存，无第二个数据库文件），且 Hub 重启后会话仍在；
 * 2. Durable 主线启用时 `requestWakeupTurn`（不带 noTurn）先落 `[Wake-up]` callback，
 *    再把唤醒回合提交给 Durable Router 会话，而不是向节点下发已废弃的 runTurn；
 * 3. `hub.drain()` 等待 Durable 运行时中的活跃任务排空。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createHub, startHub } from '../apps/hub/src/index.js';
import type { HubInstance } from '../apps/hub/src/index.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import type {
  BotConfig,
  HubRpcFunctions,
  MessageRecord,
  NodeRpcFunctions,
  SessionRecord,
} from '../packages/protocol/src/index.js';

const PASSWORD = 'integration-password';

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  let last: T;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > end) throw new Error('Timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const durableModels = (faux: ReturnType<typeof fauxProvider>) => {
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
};

/** 直接写 Hub DB 的种子：节点 + Bot + 会话（绕过需要登录的 HTTP 面）。 */
const seedSession = (hub: HubInstance, botId = 'architect'): { sessionId: string; ownerId: string } => {
  const db = hub.db;
  const admin = db.getUserWithHash('admin')!;
  db.createNode({
    id: 'node-1',
    name: 'Test node',
    platform: 'linux',
    tokenHash: 'x'.repeat(64),
    ownerId: admin.id,
  });
  db.saveBot({
    id: botId,
    nodeId: 'node-1',
    name: 'Architect',
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  } satisfies BotConfig);
  const session = db.createSession({
    id: `sess_${botId}_1`,
    title: 'Durable storage & wake',
    leadBotId: botId,
    ownerId: admin.id,
  });
  return { sessionId: session.id, ownerId: admin.id };
};

const { submitSessionMessageToDurable, ensureRouterConversationId } = await import('../apps/hub/src/routes/workers.js');

/** 读取（或懒建）会话映射的 Router 会话 id（不产生新提交）。 */
const resolveRouterId = async (runtime: HubDurableRuntime, sessionId: string): Promise<string> => {
  return ensureRouterConversationId(runtime, sessionId, 'architect');
};

/** 会话的 Router 会话全部 user 输入文本（验证 durable 侧历史保留）。 */
const durableUserTexts = async (runtime: HubDurableRuntime, routerId: string): Promise<string[]> => {
  const conversation = await runtime.conversation(routerId, BACKGROUND_CONTEXT);
  if (conversation === undefined) return [];
  const page = await conversation.entries({ order: 'ascending' }, 500, undefined, BACKGROUND_CONTEXT);
  const texts: string[] = [];
  for (const entry of page.items) {
    const messages = (entry.model ?? []) as unknown as Array<{ role?: string; content?: unknown }>;
    for (const message of messages) {
      if (message?.role !== 'user') continue;
      if (typeof message.content === 'string') texts.push(message.content);
      else if (Array.isArray(message.content)) {
        const text = (message.content as Array<{ type?: string; text?: string }>)
          .filter((part) => part?.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n');
        if (text) texts.push(text);
      }
    }
  }
  return texts;
};

/** 带环境变量的 createHub（生产路径：options.dbPath 缺省，读 BOTD_DB_PATH）。 */
const createHubFromEnv = async (
  dbPath: string,
  models?: ReturnType<typeof createModels>,
): Promise<HubInstance> => {
  const previous = process.env.BOTD_DB_PATH;
  process.env.BOTD_DB_PATH = dbPath;
  try {
    return createHub({
      adminPassword: PASSWORD,
      ...(models ? { durableModels: models } : {}),
    });
  } finally {
    if (previous === undefined) delete process.env.BOTD_DB_PATH;
    else process.env.BOTD_DB_PATH = previous;
  }
};

// ---------------------------------------------------------------------------
// 1. 生产存储兜底：BOTD_DB_PATH + options.dbPath 缺省 → pi_* 表单库共存落盘
// ---------------------------------------------------------------------------

test('ensureDurableRuntime shares hub.sqlite via pi_* tables and survives Hub restart', { timeout: 60_000 }, async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-durable-storage-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const dbPath = path.join(dir, 'hub.sqlite');
  const faux = fauxProvider({ models: [{ id: 'main' }] });

  // 与生产完全一致：不传 options.dbPath，仅靠 BOTD_DB_PATH 环境变量。
  const hub = await createHubFromEnv(dbPath, durableModels(faux));
  try {
    assert.equal(hub.db.dbPath, dbPath);
    const seeded = seedSession(hub);
    assert.equal(seeded.sessionId, 'sess_architect_1');
    await hub.ensureDurableRuntime();
    // 单库化：pi-durable 的 pi_* 表与业务表共用同一个 hub.sqlite，
    // 不再有第二个 <db>.durable.sqlite 文件。
    assert.ok(existsSync(dbPath), `hub sqlite must exist at ${dbPath}`);
    assert.ok(!existsSync(`${dbPath}.durable.sqlite`), 'durable must share hub.sqlite (no sidecar file)');
    const tables = (hub.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%'").all()) as { name: string }[];
    assert.ok(tables.some((r) => r.name === 'pi_conversations'), `pi_* tables must live in hub.sqlite, got: ${JSON.stringify(tables.map((r) => r.name))}`);

    // 提交对话：会话上下文进入 durable 存储（faux 脚本多次，防重试耗尽）
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage('persisted reply')));
    const routerId = await submitSessionMessageToDurable(
      { db: hub.db, sseHub: hub.sseHub, durableRuntime: hub.durableRuntime },
      seeded.sessionId,
      'architect',
      'remember this',
    );
    assert.ok(routerId, 'durable submit must resolve a router conversation id');
    const texts1 = await waitFor(
      () => durableUserTexts(hub.durableRuntime!, routerId),
      (texts) => texts.includes('remember this'),
      15_000,
    );
    assert.ok(texts1.includes('remember this'));
  } finally {
    await hub.close();
  }

  // Hub 重启（同样走 BOTD_DB_PATH）：durable 存储复用，重启前的会话上下文仍在
  const faux2 = fauxProvider({ models: [{ id: 'main' }] });
  const hub2 = await createHubFromEnv(dbPath, durableModels(faux2));
  try {
    await hub2.ensureDurableRuntime();
    const ownerId = hub2.db.listUsers()[0].id;
    const sessionId = hub2.db.getAllSessions(ownerId)[0].id;
    assert.equal(sessionId, 'sess_architect_1', 'Hub SQLite session must survive restart');

    const runtime2 = hub2.durableRuntime!;
    // Router 会话映射（SessionRouterDoc）跨重启保留：同一会话拿到同一 conversation
    faux2.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage('post-restart reply')));
    const routerId2 = await submitSessionMessageToDurable(
      { db: hub2.db, sseHub: hub2.sseHub, durableRuntime: runtime2 },
      sessionId,
      'architect',
      'still there?',
    );
    const texts2 = await waitFor(
      () => durableUserTexts(runtime2, routerId2 ?? ''),
      (texts) => texts.includes('still there?'),
      15_000,
    );
    // 重启前的输入未丢：durable 存储真实跨重启持久
    assert.ok(
      texts2.includes('remember this'),
      `durable history must survive restart; got: ${JSON.stringify(texts2)}`,
    );
  } finally {
    await hub2.close();
  }
});

// ---------------------------------------------------------------------------
// 2. botd wake（requestWakeupTurn）走 Durable Router 会话
// ---------------------------------------------------------------------------

test('requestWakeupTurn routes the wake turn through the durable runtime (no runTurn RPC)', { timeout: 60_000 }, async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-durable-wake-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const runtime = await HubDurableRuntime.open({
    storage: undefined, // default memory storage；此测试关注路由而非落盘
    models: durableModels(faux),
    workerAgent: () => ({}),
  });
  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableRuntime: runtime,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
    await runtime.close().catch(() => undefined);
  });

  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  // 登录管理员（HTTP 面）
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  // 节点配对先行：Bot 直接归属配对节点（registerNode 上报时无归属冲突）
  const pairing = await (await fetch(`${base}/api/nodes/pairing`, {
    method: 'POST',
    headers: { cookie },
  })).json() as { code: string };
  const identity = await (await fetch(`${base}/api/nodes/pairing/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, name: 'Wake node', platform: 'linux' }),
  })).json() as { nodeId: string; token: string };

  // 种子 Bot + 会话（Bot 归属配对节点，成员校验才能通过）
  const db = hub.db;
  const admin = db.getUserWithHash('admin')!;
  const architectBot: BotConfig = {
    id: 'architect',
    nodeId: identity.nodeId,
    name: 'Architect',
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  db.saveBot(architectBot);
  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Wake session', mode: 'direct', leadBotId: 'architect', memberBotIds: ['architect'] }),
  });
  assert(created.ok, `session create failed: ${created.status}`);
  const session = (await created.json()) as SessionRecord;

  // 节点侧 WebSocket：连接 → registerNode
  const runTurnCalls: unknown[] = [];
  const nodeSocket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`);
  t.after(() => nodeSocket.terminate());
  const nodeRpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>({
    getModelCatalog: async () => ({ providers: [], models: [] }) as never,
    saveBot: async () => {},
    deleteBot: async () => {},
    readFile: async () => '',
    writeFile: async () => {},
    getCommands: async () => [],
    runTurn: async (input) => {
      runTurnCalls.push(input);
      throw new Error('runTurn is no longer served by node');
    },
    cancelTurn: async () => {},
    resetSession: async () => {},
    restartDaemon: async () => ({ ok: true as const, pid: 4242 }),
    installResource: async () => ({ kind: 'skill', id: 'stub' }),
    readResourcePackage: async () => ({ files: [], kind: 'skill', id: 'stub' }),
    deleteResource: async () => {},
  }, {
    post: (data) => nodeSocket.send(data),
    on: (callback) => nodeSocket.on('message', (data) => callback(data.toString())),
    serialize: serializeRpcMessage,
    deserialize: JSON.parse,
    timeout: 10_000,
  });
  await once(nodeSocket, 'open');
  await nodeRpc.registerNode({
    nodeId: identity.nodeId,
    name: 'Wake node',
    platform: 'linux',
    bots: [architectBot],
    skills: [],
    extensions: [],
  });

  // botd wake：节点 CLI 请求唤醒回合（noTurn 未设置）
  faux.setResponses([fauxAssistantMessage('wake handled by durable router')]);
  const result = await nodeRpc.requestWakeupTurn({
    sessionId: session.id,
    botId: 'architect',
    wakeupMessage: 'background job finished',
  });
  assert.ok(result && (result as { ok: true }).ok === true);

  // 1. [Wake-up] callback 消息照常落库并广播
  const messages = await waitFor(
    () => db.getMessages(session.id),
    (list) => list.some((m) => m.role === 'callback' && m.content.includes('[Wake-up] background job finished')),
  );
  const callback = messages.find((m) => m.role === 'callback')!;
  assert.equal(callback.senderBotId, 'architect');
  assert.ok(callback.content.startsWith('[Wake-up]'));

  // 2. 唤醒回合由 Durable Router 会话执行（faux 回复被镜像回时间线），
  //    且绝不向节点下发 runTurn（该 RPC 已废弃，节点侧会抛错）
  const finalMessages = await waitFor(
    () => db.getMessages(session.id),
    (list) => list.some((m) => m.role === 'assistant' && m.content === 'wake handled by durable router'),
  );
  assert.ok(finalMessages.some((m) => m.role === 'assistant' && m.content === 'wake handled by durable router'));
  assert.equal(runTurnCalls.length, 0, 'wake must not invoke the removed node runTurn RPC');

  // 排空等待 durable 任务完成后再进入清理（hub.close 在 t.after 中调用）
  const drained = await hub.drain(10_000);
  assert.ok(drained.drained, `durable tasks should drain, remaining=${drained.remaining}`);
});

// ---------------------------------------------------------------------------
// 3. hub.drain() 等待 Durable 运行时的活跃任务
// ---------------------------------------------------------------------------

test('hub.drain() waits for active durable runtime tasks', { timeout: 60_000 }, async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-durable-drain-'));
  await mkdir(dir, { recursive: true });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'main' }], tokensPerSecond: 30 });
  const hub = await createHubFromEnv(path.join(dir, 'hub.sqlite'), durableModels(faux));
  try {
    seedSession(hub);
    await hub.ensureDurableRuntime();
    const runtime = hub.durableRuntime!;

    const admin = hub.db.listUsers()[0].id;
    const sessionId = hub.db.getAllSessions(admin)[0].id;
    const botId = hub.db.getSession(sessionId)!.leadBotId;

    // 长回复（低速率流式）保证 drain 启动时 pi.generation 任务仍在运行
    faux.setResponses([fauxAssistantMessage(`${'drain-me '.repeat(120)}end`)]);
    await submitSessionMessageToDurable(
      { db: hub.db, sseHub: hub.sseHub, durableRuntime: runtime },
      sessionId,
      botId,
      'long running work',
    );

    // 确认 durable 任务确实活跃（generation 任务存在且未 blocked）
    const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
    const active = inspection.tasks.filter(
      (task) => task.record.kind !== 'botd.watchdog' && task.state.kind !== 'blocked',
    );
    assert.ok(active.length > 0, 'a durable generation task must be in flight');

    const drained = await hub.drain(15_000);
    assert.deepEqual(drained, { drained: true, remaining: 0 });

    // 排空后：没有遗留的活跃 durable 任务
    const after = await runtime.harness.inspect(BACKGROUND_CONTEXT);
    assert.equal(
      after.tasks.filter((task) => task.record.kind !== 'botd.watchdog' && task.state.kind !== 'blocked').length,
      0,
    );
    // 会话侧产出真实存在（durable 提交路径已完成工作）
    const texts = await waitFor(
      async () => durableUserTexts(runtime, await resolveRouterId(runtime, sessionId)),
      (list) => list.includes('long running work'),
    );
    assert.ok(texts.includes('long running work'));
  } finally {
    await hub.close();
  }
});
