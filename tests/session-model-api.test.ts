/**
 * session-model-api.test.ts — 会话级模型选择 HTTP API 集成测试。
 *
 * 真实 HTTP Hub（faux provider + HubDurableRuntime）全链路验证：
 *  1. GET/PUT /api/sessions/:id/model 基本读写与响应结构；
 *  2. 同 Bot 两个会话隔离：A 会话覆盖不影响 B 会话；
 *  3. 全局 Bot 更新（PUT /api/bots/:id）不抹掉会话覆盖；
 *  4. 清除覆盖（override: null）恢复 Bot 默认；
 *  5. 权限（未登录 401 / 不存在 404）与无效输入 400；
 *  6. model_error 失败回合：保存覆盖成功且恢复结果如实返回（resumed=true）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { LiveDoc, MemoryStorage } from '@earendil-works/pi-durable';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime, stringToConversationId, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';
import { ensureRouterConversationId } from '../apps/hub/src/routes/workers.js';

const PASSWORD = 'test-admin-password';

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T> | T,
  check: (value: T) => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await read();
    if (check(last)) return last;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${message}`);
    await wait(20);
  }
}

interface Fixture {
  base: string;
  cookie: string;
  runtime: HubDurableRuntime;
  faux: ReturnType<typeof fauxProvider>;
  request: (route: string, method?: string, body?: unknown, cookie?: string) => Promise<Response>;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-session-model-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'model-a' }, { id: 'model-b' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({
    storage: new MemoryStorage(),
    models,
    workerAgent: () => ({}),
  });
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

  const request = async (
    route: string,
    method = 'GET',
    body?: unknown,
    cookieHeader?: string,
  ): Promise<Response> =>
    fetch(base + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(route, method, body, cookie);
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  // 种子数据：节点 + Bot（faux/model-a，与 persona 同步 medium）+ 同 Bot 两个会话。
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
    id: 'architect',
    nodeId: 'node-1',
    name: 'Architect',
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'model-a',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });
  db.createSession({ id: 'sess_a', title: 'Session A', leadBotId: 'architect', ownerId: admin.id });
  db.createSession({ id: 'sess_b', title: 'Session B', leadBotId: 'architect', ownerId: admin.id });

  const persona: BotPersonaConfig = {
    botId: 'architect',
    name: 'Architect',
    model: { provider: 'faux', modelId: 'model-a' },
    thinkingLevel: 'medium',
    instructions: 'You are the architect bot.',
    nodeId: 'node-1',
    cwd: process.cwd(),
  };
  runtime.registerPersona(persona);
  await runtime.syncPersonas([persona]);

  return { base, cookie, runtime, faux, request, json };
}

test('GET/PUT session model: defaults, override lifecycle and response shape', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 未登录：401
  const anon = await f.request('/api/sessions/sess_a/model');
  assert.equal(anon.status, 401);

  // 初始：无覆盖，生效配置即 Bot 默认
  const initial = await f.json('/api/sessions/sess_a/model');
  assert.equal(initial.override, null);
  assert.equal(initial.effective.provider, 'faux');
  assert.equal(initial.effective.modelId, 'model-a');
  assert.equal(initial.effective.thinkingLevel, 'medium');

  // PUT 设置覆盖：返回保存后的覆盖与生效配置
  const put = await f.json('/api/sessions/sess_a/model', 'PUT', {
    override: { provider: 'faux', modelId: 'model-b', thinkingLevel: 'high' },
  });
  assert.equal(put.override.modelId, 'model-b');
  assert.equal(put.effective.modelId, 'model-b');
  assert.equal(put.effective.thinkingLevel, 'high');
  assert.equal(typeof put.resumed, 'boolean');

  // GET 反映真实有效配置
  const after = await f.json('/api/sessions/sess_a/model');
  assert.equal(after.effective.modelId, 'model-b');
  assert.equal(after.override?.modelId, 'model-b');

  // thinkingLevel 可省略
  const noThinking = await f.json('/api/sessions/sess_a/model', 'PUT', {
    override: { provider: 'faux', modelId: 'model-a' },
  });
  assert.equal(noThinking.effective.modelId, 'model-a');
  assert.equal(noThinking.override?.thinkingLevel, undefined);
});

test('same-bot sessions are isolated: overriding session A never touches session B', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  await f.json('/api/sessions/sess_a/model', 'PUT', { override: { provider: 'faux', modelId: 'model-b' } });

  const a = await f.json('/api/sessions/sess_a/model');
  const b = await f.json('/api/sessions/sess_b/model');
  assert.equal(a.effective.modelId, 'model-b', 'session A runs the override');
  assert.equal(b.effective.modelId, 'model-a', 'session B keeps the bot default');
  assert.equal(b.override, null);
});

test('global bot update keeps the session override; clearing restores the bot default', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  await f.json('/api/sessions/sess_a/model', 'PUT', { override: { provider: 'faux', modelId: 'model-b' } });

  // 全局更新 Bot（Bot 编辑器语义）：不能抹掉会话覆盖
  const botPut = await f.request('/api/bots/architect', 'PUT', { description: 'Updated.' }, f.cookie);
  assert.equal(botPut.status, 200);

  const kept = await f.json('/api/sessions/sess_a/model');
  assert.equal(kept.effective.modelId, 'model-b', 'override survives a global bot update');

  // 清除覆盖：恢复 Bot 默认
  const cleared = await f.json('/api/sessions/sess_a/model', 'PUT', { override: null });
  assert.equal(cleared.override, null);
  assert.equal(cleared.effective.modelId, 'model-a');

  const after = await f.json('/api/sessions/sess_a/model');
  assert.equal(after.effective.modelId, 'model-a');
});

test('permission and validation errors', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 不存在的会话：404
  const missing = await f.request('/api/sessions/sess_none/model', 'GET', undefined, f.cookie);
  assert.equal(missing.status, 404);

  // 覆盖缺 provider/modelId：400
  const bad1 = await f.request('/api/sessions/sess_a/model', 'PUT', { override: { provider: 'faux' } }, f.cookie);
  assert.equal(bad1.status, 400);

  // 空 provider：400
  const bad2 = await f.request('/api/sessions/sess_a/model', 'PUT', { override: { provider: '  ', modelId: 'model-b' } }, f.cookie);
  assert.equal(bad2.status, 400);

  // 非法 thinkingLevel：400
  const bad3 = await f.request('/api/sessions/sess_a/model', 'PUT', { override: { provider: 'faux', modelId: 'model-b', thinkingLevel: 'ultra' } }, f.cookie);
  assert.equal(bad3.status, 400);

  // 缺 override 字段 / 非 JSON body / 非对象 override：400
  const bad4 = await f.request('/api/sessions/sess_a/model', 'PUT', {}, f.cookie);
  assert.equal(bad4.status, 400);
  const bad5 = await f.request('/api/sessions/sess_a/model', 'PUT', undefined, f.cookie);
  assert.equal(bad5.status, 400);
  const bad6 = await f.request('/api/sessions/sess_a/model', 'PUT', { override: 42 }, f.cookie);
  assert.equal(bad6.status, 400);
});

test('saving an override after a model_error failure resumes the failed turn', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 提交一条无响应排队的消息：回合以 model_error 失败落 LiveDoc.runFailure。
  const send = await f.request('/api/sessions/sess_a/messages', 'POST', { content: 'this turn will fail' }, f.cookie);
  assert.equal(send.status, 202, await send.text());

  // 精确等待 Router 会话空闲且带 model_error 失败：用生产同款映射函数定位会话。
  const convId = stringToConversationId(
    await ensureRouterConversationId(f.runtime, 'sess_a', 'architect'),
  );

  const liveFailed = await waitFor(
    async () => await f.runtime.harness.snapshot(LiveDoc, convId, BACKGROUND_CONTEXT),
    (live) => live?.run === undefined && live?.runFailure?.reason === 'model_error',
    'runFailure(model_error) while idle',
  );
  assert.equal(liveFailed?.runFailure?.reason, 'model_error');

  // faux 排上正常响应后保存覆盖：失败回合必须在新模型上自动续跑完成。
  f.faux.setResponses([fauxAssistantMessage('recovered on model-b')]);
  const saved = await f.json('/api/sessions/sess_a/model', 'PUT', {
    override: { provider: 'faux', modelId: 'model-b' },
  });
  assert.equal(saved.effective.modelId, 'model-b', 'override is saved even when resume is attempted');
  assert.equal(saved.resumed, true, 'a failed idle session must auto-continue on the new model');

  // 失败回合最终被清除：无 live run、无 runFailure。
  await waitFor(
    async () => await f.runtime.harness.snapshot(LiveDoc, convId, BACKGROUND_CONTEXT),
    (live) => live?.run === undefined && live?.runFailure === undefined,
    'the continued run to finish cleanly',
  );
});
