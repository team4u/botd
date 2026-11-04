/**
 * hub-superagent-routes.test.ts — Super-agent HTTP 路由集成测试。
 *
 * 覆盖 Phase 2 接入层：
 *  1. POST /api/sessions/:id/workers 派生后台 Worker（含 threadKey 订阅），
 *     GET 列表带 threadKeys，steer / recall / stop 全链路；
 *  2. POST /api/events/ingest：快速路径丢弃、直通（threadKey 已订阅直达 Worker）；
 *  3. GET /api/watchdog/health：结构化健康诊断。
 *
 * 全部跑在真实 Hono app + HubDurableRuntime（faux provider，无真实 LLM）上。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';

const PASSWORD = 'test-admin-password';

const waitFor = async <T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  message: string,
  timeout = 8_000,
): Promise<T> => {
  const end = Date.now() + timeout;
  let last: T;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

interface Fixture {
  base: string;
  cookie: string;
  hub: Awaited<ReturnType<typeof startHub>>;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
  request: (route: string, method?: string, body?: unknown) => Promise<Response>;
}

async function fixture(t: TestContext, durableRuntime?: HubDurableRuntime): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-superagent-routes-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // faux provider：懒加载路径也用同一 models 实例；慢流式保证 Worker 真正忙
  // （stop 场景需要 Worker 运行中可被中止）。
  const faux = fauxProvider({ models: [{ id: 'main' }], tokensPerSecond: 40 });
  const models = createModels();
  models.setProvider(faux.provider);

  const runtime =
    durableRuntime ??
    (await HubDurableRuntime.open({ storage: new MemoryStorage(), models, workerAgent: () => ({}) }));

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
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  // 种子数据：节点 + Bot + 会话（直接写 Hub DB，绕过需要在线 Node 的路由）。
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
    updatedAt: now,
  });
  const session = db.createSession({
    id: 'sess_test_1',
    title: 'Super-agent routes',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });
  assert.equal(session.id, 'sess_test_1');

  // 同步分身到持久运行时（生产路径由 ensureDurableRuntime 完成）。
  const persona: BotPersonaConfig = {
    botId: 'architect',
    name: 'Architect',
    model: { provider: 'faux', modelId: 'main' },
    instructions: 'You are the architect bot.',
    nodeId: 'node-1',
    cwd: process.cwd(),
  };
  runtime.registerPersona(persona);
  // Worker 首轮任务的长回答：持续流式中，直到测试 stop 它。
  faux.setResponses([fauxAssistantMessage(`Working on it: ${'detail '.repeat(60)}done.`)]);

  return { base, cookie, hub, json, request };
}

test('workers lifecycle: spawn, list with threadKeys, steer, recall, stop', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_test_1';

  // 派生一个带 threadKey 的后台 Worker（faux 响应对 Worker 的首轮运行兜底）。
  const spawned = await f.json<{ ok: boolean; worker: { workerId: string; conversationId: string; threadKeys?: string[] } }>(
    `/api/sessions/${sid}/workers`,
    'POST',
    { title: 'watch PR 42', task: 'Watch PR 42 and report review comments.', threadKey: 'github:pr:botd#42' },
  );
  assert.equal(spawned.ok, true);
  const workerId = spawned.worker.workerId;
  assert.match(workerId, /^w-\d+-\d+$/);
  assert.equal(spawned.worker.threadKeys?.[0], 'github:pr:botd#42');

  // 列表能查到该 Worker，且带 threadKeys。
  const listed = await waitFor(
    async () =>
      await f.json<{ workers: Array<{ workerId: string; status: string; threadKeys?: string[]; parentSessionId: string }> }>(
        `/api/sessions/${sid}/workers`,
      ),
    (result) => result.workers.some((w) => w.workerId === workerId && (w.threadKeys?.length ?? 0) > 0),
    'spawned worker to appear with threadKeys',
  );
  const item = listed.workers.find((w) => w.workerId === workerId)!;
  assert.ok(['running', 'completed'].includes(item.status), `unexpected status ${item.status}`);
  assert.deepEqual(item.threadKeys, ['github:pr:botd#42']);
  assert.equal(item.parentSessionId, sid);

  // steer：向运行中的 Worker 插话。
  const steered = await f.json<{ ok: boolean }>(
    `/api/sessions/${sid}/workers/${encodeURIComponent(workerId)}/steer`,
    'POST',
    { message: 'Focus on the security implications.', mode: 'steer' },
  );
  assert.equal(steered.ok, true);

  // recall：RecallIndex 节点 + Transcript 摘录。
  const recalled = await f.json<{ node: { id: string; kind: string; title: string; conversationId?: string }; transcript: Array<{ id: string; kind: string }> }>(
    `/api/sessions/${sid}/workers/${encodeURIComponent(workerId)}/recall`,
  );
  assert.equal(recalled.node.id, workerId);
  assert.equal(recalled.node.kind, 'worker');
  assert.equal(recalled.node.title, 'watch PR 42');
  assert.ok(Array.isArray(recalled.transcript));

  // stop：中止后台 Worker。
  const stopped = await f.json<{ ok: boolean }>(
    `/api/sessions/${sid}/workers/${encodeURIComponent(workerId)}/stop`,
    'POST',
  );
  assert.equal(stopped.ok, true);
  const after = await waitFor(
    async () => await f.json<{ workers: Array<{ workerId: string; status: string }> }>(`/api/sessions/${sid}/workers`),
    (result) => result.workers.find((w) => w.workerId === workerId)?.status === 'aborted',
    'worker to be aborted after stop',
  );
  assert.equal(after.workers.find((w) => w.workerId === workerId)!.status, 'aborted');

  // 未知 Worker：404。
  const missing = await f.request(`/api/sessions/${sid}/workers/w-99-999/stop`, 'POST');
  assert.equal(missing.status, 404);
});

test('events ingest: fast-path drops ignored events, pass-through delivers to subscribed worker', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_test_1';

  // 快速路径：policy mode=ignore 直接丢弃（0 LLM 调用）。
  const dropped = await f.json<{ action: string; reason: string }>(
    '/api/events/ingest',
    'POST',
    { source: 'github', type: 'pr.comment', sender: 'bot', title: 'noise', policy: { mode: 'ignore' } },
  );
  assert.equal(dropped.action, 'dropped');
  assert.match(dropped.reason, /mode=ignore/);

  // 快速路径：来源白名单不命中丢弃。
  const droppedSource = await f.json<{ action: string }>(
    '/api/events/ingest',
    'POST',
    { source: 'twitter', type: 'mention', sender: 'user1', title: 'hi', policy: { source: ['github'] } },
  );
  assert.equal(droppedSource.action, 'dropped');

  // 准备订阅：派生一个订阅 github:pr:botd#42 的 Worker。
  const spawned = await f.json<{ worker: { workerId: string; conversationId: string } }>(
    `/api/sessions/${sid}/workers`,
    'POST',
    { title: 'pr watcher', task: 'Watch the PR.', threadKey: 'github:pr:botd#42' },
  );

  // 首个同线程事件：已订阅 → 直通 Worker（pass_through，0 Router LLM 调用）。
  const passed = await f.json<{ action: string; threadKey: string; deliveredTo: string[]; routerLlmCalls: number }>(
    '/api/events/ingest',
    'POST',
    {
      source: 'github',
      type: 'pr.comment',
      sender: 'reviewer',
      title: 'new review comment',
      content: 'Please address the nits in src/index.ts.',
      repo: 'botd',
      prNumber: 42,
      sessionId: sid,
    },
  );
  assert.equal(passed.action, 'pass_through');
  assert.equal(passed.threadKey, 'github:pr:botd#42');
  assert.equal(passed.routerLlmCalls, 0);
  assert.deepEqual(passed.deliveredTo, [spawned.worker.conversationId]);

  // 未订阅线程的事件：慢路径交给 Router（routed_to_router）。
  const routed = await f.json<{ action: string; routerConversationId: string; routerLlmCalls: number }>(
    '/api/events/ingest',
    'POST',
    {
      source: 'github',
      type: 'issue.opened',
      sender: 'user1',
      title: 'new bug report',
      repo: 'botd',
      issueNumber: 7,
      sessionId: sid,
    },
  );
  assert.equal(routed.action, 'routed_to_router');
  assert.equal(routed.routerLlmCalls, 1);
  assert.ok(routed.routerConversationId);
});

test('watchdog health returns structured diagnostics', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  const report = await f.json<{ healthy: boolean; summary: string; findings: unknown[]; interventions: unknown[] }>(
    '/api/watchdog/health',
  );
  assert.equal(typeof report.healthy, 'boolean');
  assert.equal(typeof report.summary, 'string');
  assert.ok(report.summary.length > 0);
  assert.ok(Array.isArray(report.findings));
  assert.ok(Array.isArray(report.interventions));

  // runPass=1：先跑一轮巡检再诊断（不报错、结构不变）。
  const afterPass = await f.json<{ summary: string } & Record<string, unknown>>('/api/watchdog/health?runPass=1');
  assert.equal(typeof afterPass.summary, 'string');
});

test('mainline cutover: session message drives Super-agent loop, worker completes and reports back', { timeout: 60_000 }, async (t) => {
  // 与 fixture 相同的种子，但脚本化 faux：Router 收到用户消息后 spawn_worker，
  // Worker 完成后报告回 Router，Router 汇总——全程走 POST /api/sessions/:id/messages。
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-superagent-mainline-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models, workerAgent: () => ({}) });

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
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  // 种子：通过真实配对流创建节点并建立 WebSocket 连接（Brain in Hub, Hands on Node
  // 在线路径）；Bot 的 cwd 落在节点上。
  const db = hub.db;
  const pairing = await json<{ code: string }>('/api/nodes/pairing', 'POST');
  const identity = await json<{ nodeId: string; hubUrl: string; token: string }>(
    '/api/nodes/pairing/exchange',
    'POST',
    { code: pairing.code, name: 'Remote node', platform: 'linux' },
  );
  const socket = new WebSocket(
    `${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`,
  );
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const now = new Date().toISOString();
  const workspaceDir = process.cwd();
  db.saveBot({
    id: 'architect',
    nodeId: identity.nodeId,
    name: 'Architect',
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: now,
    workspaceDir,
  });
  const session = db.createSession({
    id: 'sess_mainline',
    title: 'Mainline cutover',
    leadBotId: 'architect',
    ownerId: 'user_admin',
    workspaceDir,
  });
  assert.equal(session.id, 'sess_mainline');

  // 分身同步（生产路径由 ensureDurableRuntime 完成）。
  runtime.registerPersona({
    botId: 'architect',
    name: 'Architect',
    model: { provider: 'faux', modelId: 'main' },
    instructions: 'You are the architect bot.',
    nodeId: identity.nodeId,
    cwd: workspaceDir,
  });

  // 脚本化 Router / Worker 行为（按 transcript 内容回答）。
  const lastUserText = (messages: readonly { role: string; content: unknown }[]): string => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (typeof lastUser?.content === 'string') return lastUser.content;
    if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? '');
    return '';
  };
  faux.setResponses(
    [...Array(64)].map(() => ((context: { messages: readonly { role: string; content: unknown }[] }) => {
      const text = lastUserText(context.messages);
      if (/Write the migration guide/.test(text)) {
        return fauxAssistantMessage('Migration guide written: 3 sections, all examples verified.');
      }
      if (/\[Worker Completed:/.test(text)) {
        return fauxAssistantMessage('The migration worker finished: 3 sections verified.');
      }
      const toolResultSeen = context.messages.some((m) => m.role === 'toolResult');
      if (/please write the migration guide/.test(text) && !toolResultSeen) {
        return fauxAssistantMessage(
          [fauxToolCall('spawn_worker', { title: 'write guide', task: 'Write the migration guide and verify examples.' })],
          { stopReason: 'toolUse' },
        );
      }
      return fauxAssistantMessage('Started the guide worker; ping me anytime.');
    }) as never),
  );

  // 用户消息（主线切流）：POST /api/sessions/:id/messages 直接驱动 Super-agent 循环。
  const posted = await json<{ id: string; role: string }>(
    '/api/sessions/sess_mainline/messages',
    'POST',
    { content: 'please write the migration guide' },
  );
  assert.equal(posted.role, 'user');

  // Worker 出现在会话后台工作单元列表，并最终 completed（带回 summary）。
  const workers = await waitFor(
    async () => await json<{ workers: Array<{ workerId: string; status: string; summary?: string }> }>('/api/sessions/sess_mainline/workers'),
    (result) => result.workers.some((w) => w.status === 'completed' && /3 sections/.test(w.summary ?? '')),
    'worker to complete with summary',
  );
  const completed = workers.workers.find((w) => w.status === 'completed')!;
  assert.match(completed.summary ?? '', /3 sections/);

  // 镜像：Router 的 assistant 回复与 worker 完成通知落库为会话消息（SSE message_created 同源）。
  const messages = await waitFor(
    async () => await json<Array<{ role: string; content: string }>>('/api/sessions/sess_mainline/messages'),
    (list) =>
      list.some((m) => m.role === 'assistant' && /guide worker|migration worker/i.test(m.content)) &&
      list.some((m) => m.role === 'assistant' && /\[Worker Completed:/.test(m.content)),
    'mirrored assistant replies to appear in session messages',
  );
  assert(messages.some((m) => m.role === 'user' && /please write the migration guide/.test(m.content)));
});
