import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHub } from '../apps/hub/src/index.js';

// 本文件验证 outbox 退避重试闭环，统一注入快速重试节奏（须在 createHub 读取前设置）
process.env.BOTD_OUTBOX_RETRY_MS = process.env.BOTD_OUTBOX_RETRY_MS || '50';
process.env.BOTD_OUTBOX_POLL_MS = process.env.BOTD_OUTBOX_POLL_MS || '50';

interface ReceivedRequest {
  method: string;
  url: string;
  body: string;
  json?: any;
}

/**
 * 可编程 mock 远端：按 URL 前缀配置响应序列（如先 500 后 200），
 * 用于验证 outbox 指数退避重试闭环。
 * 注意：callCount 在请求到达时即计数（先于 handler 与 waiter 谓词求值）。
 */
function startFlakyMockServer(): Promise<{
  server: Server;
  port: number;
  requests: ReceivedRequest[];
  getCallCount: () => number;
  respondWith: (urlPrefix: string, handler: (ctx: { callCount: number }) => { status: number; body?: string } | Promise<{ status: number; body?: string }>) => void;
  waitForRequest: (predicate: (req: ReceivedRequest) => boolean, timeoutMs?: number) => Promise<ReceivedRequest>;
  close: () => Promise<void>;
}> {
  const requests: ReceivedRequest[] = [];
  const waiters: Array<{ predicate: (req: ReceivedRequest) => boolean; resolve: (req: ReceivedRequest) => void }> = [];
  const handlers = new Map<string, (ctx: { callCount: number }) => { status: number; body?: string } | Promise<{ status: number; body?: string }>>();
  let callCount = 0;

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {}
    callCount++;
    const item: ReceivedRequest = { method: req.method || 'GET', url: req.url || '/', body: rawBody, json: parsed };
    requests.push(item);

    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(item)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(item);
      }
    }

    let handler = handlers.get(req.url || '/');
    if (!handler) {
      // 前缀匹配兜底
      for (const [prefix, h] of handlers) {
        if ((req.url || '').startsWith(prefix)) {
          handler = h;
          break;
        }
      }
    }
    const result = handler ? await handler({ callCount }) : { status: 200, body: JSON.stringify({ ok: true }) };
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body ?? JSON.stringify({ ok: true }));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Failed to obtain server address'));
      const port = addr.port;

      const respondWith = (
        urlPrefix: string,
        handler: (ctx: { callCount: number }) => { status: number; body?: string } | Promise<{ status: number; body?: string }>
      ) => {
        handlers.set(urlPrefix, handler);
      };

      const waitForRequest = (predicate: (req: ReceivedRequest) => boolean, timeoutMs = 5000): Promise<ReceivedRequest> => {
        const existing = requests.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.resolve === res);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(new Error(`Timed out waiting for request matching predicate after ${timeoutMs}ms`));
          }, timeoutMs);
          waiters.push({
            predicate,
            resolve: (item) => {
              clearTimeout(timer);
              res(item);
            },
          });
        });
      };

      const close = () => new Promise<void>((cb) => server.close(() => cb()));
      resolve({ server, port, requests, getCallCount: () => callCount, respondWith, waitForRequest, close });
    });
  });
}

async function createTestHub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-outbox-test-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const adminPassword = 'admin-password-outbox-test';
  const hub = createHub({ dbPath, adminPassword });

  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const adminUser = hub.db.getUserWithHash('admin')!;
  hub.db.createNode({
    id: 'node-outbox-test',
    name: 'Outbox Test Node',
    platform: 'linux',
    tokenHash: 'dummy',
    ownerId: adminUser.id,
  });
  hub.db.saveBot({
    id: 'bot-outbox',
    nodeId: 'node-outbox-test',
    name: 'Outbox Bot',
    description: 'Test Bot',
    modelProvider: 'test',
    modelId: 'test-model',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });

  const loginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const jsonRequest = async (url: string, method = 'GET', body?: unknown) => {
    const res = await hub.app.request(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        cookie: cookie!,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  };

  return { hub, jsonRequest };
}

/** 轮询 outbox 接口直到谓词命中某条记录或超时（消除投递异步状态更新的竞态） */
async function waitForOutboxRow(
  jsonRequest: (url: string, method?: string, body?: unknown) => Promise<{ status: number; json: any }>,
  sessionId: string,
  predicate: (row: any) => boolean,
  timeoutMs = 5000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await jsonRequest(`/api/sessions/${sessionId}/outbox`, 'GET');
    const row = res.json?.find?.(predicate);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for outbox row matching predicate after ${timeoutMs}ms`);
}

test('tellPolicy=needed：仅放行 ask_request 与失败回调，静默普通成功消息', async (t) => {
  const { hub, jsonRequest } = await createTestHub(t);
  const mock = await startFlakyMockServer();
  t.after(async () => {
    await mock.close();
  });

  const sessionRes = await jsonRequest('/api/sessions', 'POST', {
    title: 'needed 策略会话',
    leadBotId: 'bot-outbox',
  });
  assert.equal(sessionRes.status, 200);
  const sessionId = sessionRes.json.id;

  // 创建 needed 策略通道
  const chanRes = await jsonRequest(`/api/sessions/${sessionId}/channels`, 'POST', {
    name: '按需通知通道',
    kind: 'webhook',
    targetUrl: `http://127.0.0.1:${mock.port}/needed-hook`,
    events: ['assistant_reply', 'ask_request', 'wakeup'],
    tellPolicy: 'needed',
  });
  assert.equal(chanRes.status, 201);
  assert.equal(chanRes.json.tellPolicy, 'needed');

  // 告警事件 1：普通 assistant 回复（成功）→ 应被静默
  const okMsg = hub.db.createMessage({
    id: 'msg_ok_1',
    sessionId,
    role: 'assistant',
    senderBotId: 'bot-outbox',
    content: '一切正常，任务已完成 ✅',
  });
  hub.sseHub.broadcast(sessionId, { type: 'message_created', message: okMsg.message });

  // 告警事件 2：普通 wakeup 回调（成功过程消息）→ 应被静默
  const spawnMsg = hub.db.createMessage({
    id: 'msg_spawn_1',
    sessionId,
    role: 'callback',
    content: '📋 已派生子会话，任务执行中',
  });
  hub.sseHub.broadcast(sessionId, { type: 'message_created', message: spawnMsg.message });

  // 等待足够时间确认无任何推送
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    mock.requests.some((r) => r.url === '/needed-hook'),
    false,
    'needed 策略下普通成功消息不应触发推送'
  );

  // 告警事件 3：失败回调 → 应发送
  const failMsg = hub.db.createMessage({
    id: 'msg_fail_1',
    sessionId,
    role: 'callback',
    content: '❌ 子会话执行失败：构建错误',
  });
  hub.sseHub.broadcast(sessionId, { type: 'message_created', message: failMsg.message });
  const failReq = await mock.waitForRequest((r) => r.url === '/needed-hook' && r.body.includes('执行失败'));
  assert.equal(failReq.json.event, 'wakeup');

  // 告警事件 4：ask_request → 应发送
  const askPromise = hub.router.requestHumanInput({
    sessionId,
    botId: 'bot-outbox',
    prompt: '是否继续执行部署？',
    options: ['继续', '终止'],
    timeoutSeconds: 30,
  });
  const askReq = await mock.waitForRequest((r) => r.url === '/needed-hook' && r.body.includes('是否继续执行部署'));
  assert.equal(askReq.json.event, 'ask_request');
  assert.ok(askReq.json.respondUrls['继续']);
  // 清理 pending ask，避免悬挂 timer
  hub.router.respondToAsk(sessionId, askReq.json.ask.id, '终止');
  await askPromise;

  // 验证 outbox 中只落库了 2 条（失败回调 + ask），且均投递成功
  const askRow = await waitForOutboxRow(jsonRequest, sessionId, (o: any) => o.eventKind === 'ask_request' && o.status === 'sent');
  const wakeupRow = await waitForOutboxRow(jsonRequest, sessionId, (o: any) => o.eventKind === 'wakeup' && o.status === 'sent');
  assert.equal(askRow.attemptCount, 1);
  assert.equal(wakeupRow.attemptCount, 1);

  const outboxRes = await jsonRequest(`/api/sessions/${sessionId}/outbox`, 'GET');
  assert.equal(outboxRes.status, 200);
  assert.equal(outboxRes.json.length, 2, 'needed 策略仅应有 2 条 outbox 记录');
  assert.equal(outboxRes.json[0].eventKind, 'ask_request');
  assert.equal(outboxRes.json[1].eventKind, 'wakeup');
  assert.equal(outboxRes.json[0].status, 'sent');
});

test('tellPolicy=never：完全静默不推送', async (t) => {
  const { hub, jsonRequest } = await createTestHub(t);
  const mock = await startFlakyMockServer();
  t.after(async () => {
    await mock.close();
  });

  const sessionRes = await jsonRequest('/api/sessions', 'POST', {
    title: 'never 策略会话',
    leadBotId: 'bot-outbox',
  });
  const sessionId = sessionRes.json.id;

  const chanRes = await jsonRequest(`/api/sessions/${sessionId}/channels`, 'POST', {
    name: '静默通道',
    kind: 'webhook',
    targetUrl: `http://127.0.0.1:${mock.port}/never-hook`,
    events: ['assistant_reply', 'ask_request', 'wakeup'],
    tellPolicy: 'never',
  });
  assert.equal(chanRes.status, 201);

  // ask_request 也应被 never 拦截
  const askPromise = hub.router.requestHumanInput({
    sessionId,
    botId: 'bot-outbox',
    prompt: 'never 策略下的确认请求',
    options: ['是'],
    timeoutSeconds: 30,
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    mock.requests.some((r) => r.url === '/never-hook'),
    false,
    'never 策略不应推送任何事件'
  );
  const asks = hub.router.getPendingAsks(sessionId);
  if (asks.length > 0) hub.router.respondToAsk(sessionId, asks[0].id, '是');
  await askPromise;
});

test('子会话事件向上继承：命中父会话配置的通知通道', async (t) => {
  const { hub, jsonRequest } = await createTestHub(t);
  const mock = await startFlakyMockServer();
  t.after(async () => {
    await mock.close();
  });

  const adminUser = hub.db.getUserWithHash('admin')!;

  // 父会话（配置飞书通道）+ 自动化子会话
  const parent = hub.db.createSession({
    id: 'sess_parent_inherit',
    title: '父会话',
    leadBotId: 'bot-outbox',
    ownerId: adminUser.id,
  });
  const child = hub.db.createSession({
    id: 'sess_child_inherit',
    title: '自动化子会话',
    leadBotId: 'bot-outbox',
    ownerId: adminUser.id,
    parentSessionId: parent.id,
  });

  const chanRes = await jsonRequest(`/api/sessions/${parent.id}/channels`, 'POST', {
    name: '父会话飞书通知',
    kind: 'feishu',
    targetUrl: `http://127.0.0.1:${mock.port}/parent-feishu`,
    events: ['ask_request', 'wakeup'],
  });
  assert.equal(chanRes.status, 201);
  assert.equal(chanRes.json.tellPolicy, 'always', '默认策略应为 always');

  // 子会话失败回调 → 命中父会话通道
  const failMsg = hub.db.createMessage({
    id: 'msg_child_fail',
    sessionId: child.id,
    role: 'callback',
    content: '❌ 子会话任务执行失败：超时',
  });
  hub.sseHub.broadcast(child.id, { type: 'message_created', message: failMsg.message });

  const failReq = await mock.waitForRequest((r) => r.url === '/parent-feishu' && r.body.includes('子会话任务执行失败'));
  assert.ok(failReq.json.content.text.includes('（子会话 sess_child_inherit）'), '继承通知应标注来源子会话');

  // 子会话 ask_request → 命中父会话通道，respondUrls 指向子会话（ask 实际所在会话）
  const askPromise = hub.router.requestHumanInput({
    sessionId: child.id,
    botId: 'bot-outbox',
    prompt: '子会话请求确认',
    options: ['批准'],
    timeoutSeconds: 30,
  });
  const askReq = await mock.waitForRequest((r) => r.url === '/parent-feishu' && r.body.includes('子会话请求确认'));
  assert.ok(askReq.json.content.text.includes('批准'));

  // 从 webhook 通道再验证 respondUrls 签名指向子会话
  const whChanRes = await jsonRequest(`/api/sessions/${parent.id}/channels`, 'POST', {
    name: '父会话 Webhook',
    kind: 'webhook',
    targetUrl: `http://127.0.0.1:${mock.port}/parent-webhook`,
    events: ['ask_request'],
  });
  assert.equal(whChanRes.status, 201);
  const askPromise2 = hub.router.requestHumanInput({
    sessionId: child.id,
    botId: 'bot-outbox',
    prompt: '子会话二次确认',
    options: ['同意', '拒绝'],
    timeoutSeconds: 30,
  });
  const whAskReq = await mock.waitForRequest((r) => r.url === '/parent-webhook' && r.body.includes('子会话二次确认'));
  assert.equal(whAskReq.json.sessionId, child.id, 'payload 主体会话应为事件源子会话');
  assert.equal(whAskReq.json.channelSessionId, parent.id, '应附带通道归属父会话标识');
  const approveUrl = new URL(whAskReq.json.respondUrls['同意']);
  assert.equal(approveUrl.searchParams.get('sessionId'), child.id, 'respondUrl 必须指向子会话');

  // 免登录回调在子会话上下文中应可用（验证签名正确性）
  const askId2 = approveUrl.pathname.split('/')[4];
  const token2 = approveUrl.searchParams.get('token')!;
  const respondRes = await hub.app.request(
    `/api/public/asks/${askId2}/respond?sessionId=${encodeURIComponent(child.id)}&answer=${encodeURIComponent('同意')}&token=${encodeURIComponent(token2)}`,
    { method: 'GET' }
  );
  assert.equal(respondRes.status, 200, '继承通知的回调链接必须可用');
  await askPromise2;

  // 清理第一个 ask（飞书 payload 不含 ask id，从 pending 列表获取）
  const pendingAsks = hub.router.getPendingAsks(child.id);
  const firstAsk = pendingAsks.find((a) => a.prompt === '子会话请求确认');
  if (firstAsk) hub.router.respondToAsk(child.id, firstAsk.id, '批准');
  await askPromise;

  // 无亲缘关系的会话不应命中父会话通道
  const stranger = hub.db.createSession({
    id: 'sess_stranger',
    title: '无关会话',
    leadBotId: 'bot-outbox',
    ownerId: adminUser.id,
  });
  mock.requests.length = 0;
  const strangerMsg = hub.db.createMessage({
    id: 'msg_stranger_fail',
    sessionId: stranger.id,
    role: 'callback',
    content: '❌ 无关会话失败',
  });
  hub.sseHub.broadcast(stranger.id, { type: 'message_created', message: strangerMsg.message });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    mock.requests.some((r) => r.url === '/parent-feishu'),
    false,
    '非子会话事件不应命中父会话通道'
  );

  // 父会话 outbox 查询接口应能查到子会话触发的记录（通过通道归属关联）
  const outboxRes = await jsonRequest(`/api/sessions/${parent.id}/outbox`, 'GET');
  assert.equal(outboxRes.status, 200);
  assert.ok(outboxRes.json.length >= 3, '父会话 outbox 应包含子会话触发的通知记录');
  assert.ok(outboxRes.json.every((o: any) => o.status === 'sent' || o.status === 'pending'));
});

test('Outbox 重试闭环：首投 500 落 pending，退避重试后转 sent', async (t) => {
  const { hub, jsonRequest } = await createTestHub(t);
  const mock = await startFlakyMockServer();
  t.after(async () => {
    await mock.close();
  });

  const sessionRes = await jsonRequest('/api/sessions', 'POST', {
    title: 'Outbox 重试会话',
    leadBotId: 'bot-outbox',
  });
  const sessionId = sessionRes.json.id;

  // 远端前 2 次 500，之后 200（callCount 由 mock 在请求到达时维护）
  mock.respondWith('/flaky-hook', (ctx) => {
    if (ctx.callCount <= 2) return { status: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    return { status: 200 };
  });

  const chanRes = await jsonRequest(`/api/sessions/${sessionId}/channels`, 'POST', {
    name: '不稳定远端',
    kind: 'webhook',
    targetUrl: `http://127.0.0.1:${mock.port}/flaky-hook`,
    events: ['assistant_reply'],
  });
  assert.equal(chanRes.status, 201);

  const msg = hub.db.createMessage({
    id: 'msg_flaky_1',
    sessionId,
    role: 'assistant',
    senderBotId: 'bot-outbox',
    content: '触发不稳定远端的通知',
  });
  hub.sseHub.broadcast(sessionId, { type: 'message_created', message: msg.message });

  // 首投失败：等待第一次请求到达
  await mock.waitForRequest((r) => r.url === '/flaky-hook');

  const pendingRow = await waitForOutboxRow(
    jsonRequest,
    sessionId,
    (o: any) => o.eventKind === 'assistant_reply' && o.status === 'pending' && o.attemptCount >= 1
  );
  assert.ok(pendingRow.nextRetryAt, 'pending 记录应安排 nextRetryAt');
  assert.ok(pendingRow.lastError?.includes('500'), '应记录 last_error');

  // 等待后台轮询重试成功（测试环境 BOTD_OUTBOX_RETRY_MS=50 POLL_MS=50 已在文件顶部注入）
  await mock.waitForRequest((r) => r.url === '/flaky-hook' && mock.getCallCount() >= 3, 10000);

  const sentRow = await waitForOutboxRow(
    jsonRequest,
    sessionId,
    (o: any) => o.id === pendingRow.id && o.status === 'sent'
  );
  assert.equal(sentRow.attemptCount, 3, '两次失败 + 一次成功，共 3 次尝试');
  assert.ok(!sentRow.lastError);
  assert.ok(!sentRow.nextRetryAt);

  // 通道 last_triggered_at 应被更新
  const chanList = await jsonRequest(`/api/sessions/${sessionId}/channels`, 'GET');
  assert.ok(chanList.json[0].lastTriggeredAt, 'sent 后应更新 lastTriggeredAt');
  assert.equal(mock.getCallCount(), 3, '远端恰好收到 3 次请求');
});

test('PATCH 通道支持更新 tellPolicy 且校验非法值', async (t) => {
  const { hub, jsonRequest } = await createTestHub(t);

  const sessionRes = await jsonRequest('/api/sessions', 'POST', {
    title: '策略更新会话',
    leadBotId: 'bot-outbox',
  });
  const sessionId = sessionRes.json.id;

  const chanRes = await jsonRequest(`/api/sessions/${sessionId}/channels`, 'POST', {
    name: '策略测试通道',
    kind: 'webhook',
    targetUrl: 'http://127.0.0.1:9/hook',
  });
  assert.equal(chanRes.status, 201);
  assert.equal(chanRes.json.tellPolicy, 'always', '不传 tellPolicy 时默认 always');

  const badPatch = await jsonRequest(`/api/channels/${chanRes.json.id}`, 'PATCH', { tellPolicy: 'sometimes' });
  assert.equal(badPatch.status, 400);

  const patchRes = await jsonRequest(`/api/channels/${chanRes.json.id}`, 'PATCH', { tellPolicy: 'needed' });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.json.tellPolicy, 'needed');

  // 列表接口应返回更新后的策略
  const listRes = await jsonRequest(`/api/sessions/${sessionId}/channels`, 'GET');
  assert.equal(listRes.json[0].tellPolicy, 'needed');
});
