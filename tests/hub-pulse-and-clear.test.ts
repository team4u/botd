/**
 * hub-pulse-and-clear.test.ts — 中枢脉冲与原地清空集成测试。
 *
 * 覆盖：
 *  1. `GET /api/workers` 全局后台 Worker 聚合：跨当前用户多个会话汇总，带
 *     `sessionTitle` / `workspaceDir`，running 优先排序；
 *  2. `DELETE /api/sessions/:id/messages?keepWorkers=1`（/clear HTTP 入口）：
 *     清空 SQLite 消息 + Router 会话追加重置边界（pi.reset），但运行中的后台
 *     Worker 保持 running，SessionRouterDoc 映射保持同一 routerId；
 *  3. `/clear` 斜杠命令（submitSessionMessageToDurable 路径）同语义：清空消息、
 *     重置 Router 上下文，同时后台 Worker 存活；
 *  4. 标题含「中枢」的会话：TargetDoc.title 同步，且 Router 系统提示词注入
 *     Central Hub Dispatcher Rules（中枢总管守则）。
 *
 * 模型走确定性 faux provider，不触真实 LLM。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { TargetDoc } from '../apps/hub/src/harness/docs.js';
import { ensureRouterConversationId } from '../apps/hub/src/routes/workers.js';

const PASSWORD = 'pulse-clear-password';

const waitFor = async <T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  message: string,
  timeout = 10_000,
): Promise<T> => {
  const end = Date.now() + timeout;
  let last: T;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

interface Fixture {
  base: string;
  hub: Awaited<ReturnType<typeof startHub>>;
  faux: ReturnType<typeof fauxProvider>;
  runtime: HubDurableRuntime;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
  request: (route: string, method?: string, body?: unknown) => Promise<Response>;
}

/** Durable 主线 fixture：注入 HubDurableRuntime + faux provider。 */
async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-pulse-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableRuntime: runtime,
    durableModels: models,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
  });

  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  const request = async (route: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(route, method, body);
    const result = await response.json().catch(() => undefined);
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  const db = hub.db;
  db.createNode({
    id: 'node-1',
    name: 'Test node',
    platform: 'linux',
    tokenHash: 'x'.repeat(64),
    ownerId: 'user_admin',
  });
  const now = new Date().toISOString();
  db.saveBot({
    id: 'architect',
    nodeId: 'node-1',
    name: 'Architect',
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    // 显式工作目录：Peer Bots 提示词的 cwd 断言不依赖 process.cwd()，避免环境相关性。
    workspaceDir: '/tmp/arch-space',
    updatedAt: now,
  });
  db.setBotFile('architect', 'system', 'You are the architect bot.');
  await hub.ensureDurableRuntime();
  assert.ok(runtime.getPersona('architect'), 'persona must be synced from Hub SQLite');

  return { base, hub, faux, runtime, json, request };
}

/** Router 会话 Entry 历史里是否已出现 pi.reset 边界。 */
const hasResetEntry = async (runtime: HubDurableRuntime, routerId: string): Promise<boolean> => {
  const conv = await runtime.conversation(routerId, BACKGROUND_CONTEXT);
  if (!conv) return false;
  const page = await conv.entries({ order: 'descending' }, 50, undefined, BACKGROUND_CONTEXT);
  return page.items.some((entry) => entry.kind === 'pi.reset');
};

// ---------------------------------------------------------------------------

test('1. GET /api/workers aggregates workers across sessions with sessionTitle/workspaceDir, running first', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 两个会话，各带 workspaceDir；各派生一个 Worker。
  f.hub.db.createSession({
    id: 'sess_alpha',
    title: 'Alpha Hub',
    leadBotId: 'architect',
    ownerId: 'user_admin',
    workspaceDir: '/tmp/alpha-space',
  });
  f.hub.db.createSession({
    id: 'sess_beta',
    title: 'Beta Work',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });

  // alpha：completed 样本 —— Worker 首轮真实回复，回报链把 registry 落成 completed
  //（回报后的 Router 汇总回合再消耗一条响应）。
  f.faux.setResponses([
    fauxAssistantMessage('alpha worker done: shipped the report.'),
    fauxAssistantMessage('alpha router noted the report.'),
  ]);
  await f.json('/api/sessions/sess_alpha/workers', 'POST', {
    title: 'alpha task',
    task: 'Do the alpha work.',
  });
  await waitFor(
    async () => {
      const routerId = await ensureRouterConversationId(f.runtime, 'sess_alpha', 'architect');
      const workers = await f.runtime.getActiveWorkers(routerId);
      return workers.find((w) => w.title === 'alpha task')?.status;
    },
    (status) => status === 'completed',
    'alpha worker completion',
  );

  // beta：running 样本 —— faux 队列已空，Worker 的 generation 失败且无回报，
  // registry 停留在 running（与 hub-loops-and-upgrade 的长任务样本同构）。
  f.faux.setResponses([]);
  await f.json('/api/sessions/sess_beta/workers', 'POST', {
    title: 'beta task',
    task: 'Do the beta work.',
  });
  await waitFor(
    async () => {
      const routerId = await ensureRouterConversationId(f.runtime, 'sess_beta', 'architect');
      const workers = await f.runtime.getActiveWorkers(routerId);
      return workers.find((w) => w.title === 'beta task')?.status;
    },
    (status) => status === 'running',
    'beta worker running',
  );

  const { workers } = await f.json<{ workers: Array<Record<string, any>> }>('/api/workers');
  assert.ok(Array.isArray(workers), 'global workers endpoint returns a list');
  const alpha = workers.find((w) => w.title === 'alpha task');
  const beta = workers.find((w) => w.title === 'beta task');
  assert.ok(alpha, 'alpha worker aggregated globally');
  assert.ok(beta, 'beta worker aggregated globally');
  assert.equal(alpha.parentSessionId, 'sess_alpha');
  assert.equal(alpha.sessionTitle, 'Alpha Hub');
  assert.equal(alpha.workspaceDir, '/tmp/alpha-space');
  assert.equal(beta.parentSessionId, 'sess_beta');
  assert.equal(beta.sessionTitle, 'Beta Work');
  assert.equal(beta.workspaceDir, undefined, 'session without workspaceDir omits the field');

  // running 优先：beta(running) 排在 alpha(completed) 之前。
  const betaIdx = workers.findIndex((w) => w.title === 'beta task');
  const alphaIdx = workers.findIndex((w) => w.title === 'alpha task');
  assert.ok(betaIdx !== -1 && alphaIdx !== -1);
  assert.ok(betaIdx < alphaIdx, 'running workers must sort before finished ones');
});

test('2. DELETE /messages?keepWorkers=1 clears SQLite messages and resets the router conversation without stopping running workers', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_keep';

  f.hub.db.createSession({
    id: sid,
    title: 'Keep Workers',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });

  // 派生一个长任务 Worker：faux 队列已空，Worker 的 generation 失败且无回报，
  // registry 停留在 running（与 hub-loops-and-upgrade 的长任务样本同构）。
  f.faux.setResponses([]);
  await f.json(`/api/sessions/${sid}/workers`, 'POST', {
    title: 'long task',
    task: 'Do something long-running.',
  });
  const workers = await waitFor(
    async () => await f.json<{ workers: Array<{ workerId: string; status: string }> }>(`/api/sessions/${sid}/workers`),
    (result) => result.workers.some((w) => w.status === 'running'),
    'spawned worker to be running',
  );
  const workerId = workers.workers.find((w) => w.status === 'running')!.workerId;
  const routerIdBefore = await ensureRouterConversationId(f.runtime, sid, 'architect');

  // 落几条 SQLite 消息，验证清空确实生效。
  await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: 'hello before clear' });
  const before = await f.json<Array<{ id: string }>>(`/api/sessions/${sid}/messages`);
  assert.ok(before.length > 0, 'user message persisted before clear');

  // 先等会话回到非 running（清空接口对 running 会话返回 409）。
  await waitFor(
    () => f.hub.db.getSession(sid)!.status,
    (status) => status !== 'running',
    'session to go idle before keepWorkers clear',
  );

  // /clear HTTP 入口：keepWorkers=1 原地清空。
  await f.json(`/api/sessions/${sid}/messages?keepWorkers=1`, 'DELETE');

  // SQLite 消息已清空。
  const after = await f.json<Array<{ id: string }>>(`/api/sessions/${sid}/messages`);
  assert.equal(after.length, 0, 'SQLite messages must be cleared');

  // Router 会话追加了 pi.reset 边界。
  assert.ok(
    await hasResetEntry(f.runtime, routerIdBefore),
    'a pi.reset boundary is appended to the router conversation',
  );

  // SessionRouterDoc 映射保持不变（同一 routerId），Worker 依然 running。
  const routerIdAfter = await ensureRouterConversationId(f.runtime, sid, 'architect');
  assert.equal(routerIdAfter, routerIdBefore, 'keepWorkers clear must keep the same router conversation');

  const workerStatus = await waitFor(
    async () => {
      const list = await f.runtime.getActiveWorkers(routerIdAfter);
      return list.find((w) => w.workerId === workerId)?.status;
    },
    (status) => status !== undefined,
    'worker entry to stay visible after keepWorkers clear',
  );
  assert.equal(workerStatus, 'running', 'running background worker must survive keepWorkers clear');
});

test('3. /clear command clears SQLite messages and resets the router conversation while keeping workers alive', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_slash_clear';

  f.hub.db.createSession({
    id: sid,
    title: 'Slash Clear',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });

  // 先发一条普通消息（faux 给一条回复，保证有历史可清）。
  f.faux.setResponses([fauxAssistantMessage('noted your request.')]);
  await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: 'remember this please' });
  await waitFor(
    () => f.hub.db.getMessages(sid).length,
    (count) => count >= 2,
    'user + assistant messages mirrored before /clear',
  );

  // 派生长任务 Worker（faux 队列已空 → 恒 running）。
  f.faux.setResponses([]);
  await f.json(`/api/sessions/${sid}/workers`, 'POST', {
    title: 'survivor task',
    task: 'Keep running through the clear.',
  });
  const workers = await waitFor(
    async () => await f.json<{ workers: Array<{ workerId: string; status: string }> }>(`/api/sessions/${sid}/workers`),
    (result) => result.workers.some((w) => w.status === 'running'),
    'spawned worker to be running',
  );
  const workerId = workers.workers.find((w) => w.status === 'running')!.workerId;
  const routerIdBefore = await ensureRouterConversationId(f.runtime, sid, 'architect');

  await waitFor(
    () => f.hub.db.getSession(sid)!.status,
    (status) => status !== 'running',
    'session to go idle before /clear',
  );

  // /clear 斜杠命令（POST 消息路径 → submitSessionMessageToDurable）。
  await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: '/clear start fresh' });

  const after = await f.json<Array<{ id: string }>>(`/api/sessions/${sid}/messages`);
  assert.equal(after.length, 0, 'SQLite messages must be cleared by /clear');

  assert.ok(
    await hasResetEntry(f.runtime, routerIdBefore),
    'a pi.reset boundary is appended by /clear',
  );

  const routerIdAfter = await ensureRouterConversationId(f.runtime, sid, 'architect');
  assert.equal(routerIdAfter, routerIdBefore, '/clear must keep the same router conversation');

  const workerStatus = await waitFor(
    async () => {
      const list = await f.runtime.getActiveWorkers(routerIdAfter);
      return list.find((w) => w.workerId === workerId)?.status;
    },
    (status) => status !== undefined,
    'worker entry to stay visible after /clear',
  );
  assert.equal(workerStatus, 'running', 'running background worker must survive /clear');
});

test('4. 中枢-titled session syncs TargetDoc.title and injects Central Hub Dispatcher Rules into the router prompt', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_hub_dispatcher';

  f.hub.db.createSession({
    id: sid,
    title: '⚡ 中枢总管',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });

  // 按请求捕获 system 提示词（pi-durable 的提示词由多条 system 消息增量补丁，
  // 按 replay 语义合并全部 sections）。
  const systemPrompts: string[] = [];
  const capture = () =>
    ((context: { messages: Array<{ role: string; content?: unknown }> }) => {
      const shown = new Map<string, string>();
      for (const m of context.messages) {
        if (m.role !== 'system') continue;
        const sections = (m as { sections?: Record<string, string | null> }).sections;
        if (sections === undefined) continue;
        for (const [k, v] of Object.entries(sections)) {
          if (v === null) shown.delete(k);
          else shown.set(k, v);
        }
      }
      systemPrompts.push([...shown.values()].join('\n'));
      return fauxAssistantMessage('dispatching.');
    }) as never;
  f.faux.setResponses([capture(), capture()]);

  await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: 'coordinate everything' });
  await waitFor(() => systemPrompts.length, (n) => n >= 1, 'router system prompt captured');

  // TargetDoc.title 已同步会话标题。
  const routerId = await ensureRouterConversationId(f.runtime, sid, 'architect');
  const target = await f.runtime.harness.snapshot(
    TargetDoc,
    Number(routerId) as never,
    BACKGROUND_CONTEXT,
  );
  assert.equal(target?.title, '⚡ 中枢总管', 'TargetDoc.title must sync from the session title');

  // Router 系统提示词注入中枢总管守则。
  const prompt = systemPrompts.at(-1)!;
  assert.match(prompt, /Central Hub Dispatcher Rules \(中枢总管守则\)/);
  assert.match(prompt, /Global Central Dispatcher \(中枢总管\)/);
  assert.match(prompt, /spawn_worker/);

  // 对照组：普通标题的会话不含中枢守则。
  const plainSid = 'sess_plain';
  f.hub.db.createSession({
    id: plainSid,
    title: '普通工作会话',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });
  const plainPrompts: string[] = [];
  const plainCapture = () =>
    ((context: { messages: Array<{ role: string; content?: unknown }> }) => {
      const shown = new Map<string, string>();
      for (const m of context.messages) {
        if (m.role !== 'system') continue;
        const sections = (m as { sections?: Record<string, string | null> }).sections;
        if (sections === undefined) continue;
        for (const [k, v] of Object.entries(sections)) {
          if (v === null) shown.delete(k);
          else shown.set(k, v);
        }
      }
      plainPrompts.push([...shown.values()].join('\n'));
      return fauxAssistantMessage('working directly.');
    }) as never;
  f.faux.setResponses([plainCapture(), plainCapture()]);
  await f.json(`/api/sessions/${plainSid}/messages`, 'POST', { content: 'just do the work' });
  await waitFor(() => plainPrompts.length, (n) => n >= 1, 'plain router system prompt captured');
  assert.doesNotMatch(plainPrompts.at(-1)!, /中枢总管守则/, 'non-hub sessions must not get dispatcher rules');
});

test('5. hub-router built-in persona: session creation, commands, end-to-end messaging and peer visibility', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 前置断言：hub-router 不在 SQLite bots 表，也不出现在 GET /api/bots。
  assert.ok(!f.hub.db.getAllBots().some((b: { id: string }) => b.id === 'hub-router'));
  const botsListed = await f.json<Array<{ id: string }>>('/api/bots');
  assert.ok(!botsListed.some((b) => b.id === 'hub-router'), 'GET /api/bots must not list hub-router');

  // 1. 以 leadBotId: 'hub-router' 创建会话（不在 bots 表也能成功）。
  const session = await f.json<{ id: string; leadBotId: string }>('/api/sessions', 'POST', {
    title: '⚡ 中枢总管',
    leadBotId: 'hub-router',
  });
  assert.equal(session.leadBotId, 'hub-router');
  const sid = session.id;

  // 2. GET /api/bots/hub-router/commands 返回 200（技能命令直出）。
  const commands = await f.json<Array<{ name: string; source: string }>>('/api/bots/hub-router/commands');
  assert.ok(Array.isArray(commands));

  // 3. 端到端发消息：注入中枢守则 + Peer Bots 列出用户主分身（含 cwd/nodeId/description）。
  const systemPrompts: string[] = [];
  const capture = () =>
    ((context: { messages: Array<{ role: string; content?: unknown }> }) => {
      const shown = new Map<string, string>();
      for (const m of context.messages) {
        if (m.role !== 'system') continue;
        const sections = (m as { sections?: Record<string, string | null> }).sections;
        if (sections === undefined) continue;
        for (const [k, v] of Object.entries(sections)) {
          if (v === null) shown.delete(k);
          else shown.set(k, v);
        }
      }
      systemPrompts.push([...shown.values()].join('\n'));
      return fauxAssistantMessage('dispatching via hub-router.');
    }) as never;
  f.faux.setResponses([capture(), capture()]);
  await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: '调度一个跨项目任务' });
  await waitFor(() => systemPrompts.length, (n) => n >= 1, 'hub-router system prompt captured');

  const prompt = systemPrompts.at(-1)!;
  // 中枢守则按 botId 触发（标题只是兑底信号）。
  assert.match(prompt, /Central Hub Dispatcher Rules \(中枢总管守则\)/);
  // Peer Bots 列出用户主分身 architect 及其 cwd / node / description。
  assert.match(prompt, /## Peer Bots \(cross-workspace \/ cross-node\)/);
  const peerLine = prompt.split('\n').find((l) => l.includes('- architect')) ?? '';
  assert.ok(peerLine, 'peer bots section must list the user-created architect bot');
  assert.match(peerLine, /cwd \/tmp\/arch-space/);
  assert.match(peerLine, /node node-1/);
  assert.match(peerLine, /You design systems\./);

  // 4. 对照组：普通分身的提示词不把 hub-router 列为 peer。
  const plainSid = 'sess_router_plain';
  f.hub.db.createSession({
    id: plainSid,
    title: '普通工作会话',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });
  const plainPrompts: string[] = [];
  const plainCapture = () =>
    ((context: { messages: Array<{ role: string; content?: unknown }> }) => {
      const shown = new Map<string, string>();
      for (const m of context.messages) {
        if (m.role !== 'system') continue;
        const sections = (m as { sections?: Record<string, string | null> }).sections;
        if (sections === undefined) continue;
        for (const [k, v] of Object.entries(sections)) {
          if (v === null) shown.delete(k);
          else shown.set(k, v);
        }
      }
      plainPrompts.push([...shown.values()].join('\n'));
      return fauxAssistantMessage('working directly.');
    }) as never;
  f.faux.setResponses([plainCapture(), plainCapture()]);
  await f.json(`/api/sessions/${plainSid}/messages`, 'POST', { content: 'just do the work' });
  await waitFor(() => plainPrompts.length, (n) => n >= 1, 'plain router system prompt captured');
  const plainPrompt = plainPrompts.at(-1)!;
  assert.ok(
    !plainPrompt.split('\n').some((l) => l.includes('- hub-router')),
    'regular bots must not see hub-router as a peer',
  );
});
