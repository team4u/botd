import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHub } from '../apps/hub/src/index.js';

interface ReceivedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  json?: any;
}

function startMockHttpServer(): Promise<{
  server: Server;
  port: number;
  requests: ReceivedRequest[];
  waitForRequest: (predicate: (req: ReceivedRequest) => boolean, timeoutMs?: number) => Promise<ReceivedRequest>;
  close: () => Promise<void>;
}> {
  const requests: ReceivedRequest[] = [];
  const waiters: Array<{
    predicate: (req: ReceivedRequest) => boolean;
    resolve: (req: ReceivedRequest) => void;
  }> = [];

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // not json
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
    }

    const item: ReceivedRequest = {
      method: req.method || 'GET',
      url: req.url || '/',
      headers,
      body: rawBody,
      json: parsed,
    };
    requests.push(item);

    // Notify any matching waiters
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(item)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(item);
      }
    }

    if (req.url === '/error-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        return reject(new Error('Failed to obtain server address'));
      }
      const port = addr.port;

      const waitForRequest = (
        predicate: (req: ReceivedRequest) => boolean,
        timeoutMs = 5000
      ): Promise<ReceivedRequest> => {
        const existing = requests.find(predicate);
        if (existing) return Promise.resolve(existing);

        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.resolve === res);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(new Error(`Timed out waiting for HTTP request matching predicate after ${timeoutMs}ms`));
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

      const close = () =>
        new Promise<void>((cb) => {
          server.close(() => cb());
        });

      resolve({ server, port, requests, waitForRequest, close });
    });
  });
}

test('外部消息通道桥接：通道 CRUD、测试推送、事件自动推送与 botd ask 免登录一键回调确认', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-channels-test-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const adminPassword = 'admin-password-test';
  const hub = createHub({ dbPath, adminPassword });

  const mockServer = await startMockHttpServer();

  t.after(async () => {
    await hub.close();
    await mockServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  const jsonRequest = async (
    url: string,
    method = 'GET',
    body?: unknown,
    cookieOverride?: string,
    headersOverride?: Record<string, string>
  ) => {
    const headers: Record<string, string> = { ...headersOverride };
    if (body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    if (cookieOverride) headers['cookie'] = cookieOverride;
    const res = await hub.app.request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, ok: res.ok, json, text, headers: res.headers };
  };

  // 1. 管理员登录
  const loginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  assert.equal(loginRes.status, 200, 'admin login failed');
  const adminCookie = loginRes.headers.get('set-cookie')?.split(';')[0];
  assert.ok(adminCookie, 'admin login must provide cookie');

  // 2. 注册节点和 BOT 并创建会话
  const adminUser = hub.db.getUserWithHash('admin')!;
  hub.db.createNode({
    id: 'node-test',
    name: 'Test Node',
    platform: 'linux',
    tokenHash: 'dummy',
    ownerId: adminUser.id,
  });
  hub.db.saveBot({
    id: 'bot-lead',
    nodeId: 'node-test',
    name: 'Lead Bot',
    description: 'Test Bot',
    modelProvider: 'test',
    modelId: 'test-model',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });

  const sessionRes = await jsonRequest(
    '/api/sessions',
    'POST',
    {
      title: '外部通知测试会话',
      leadBotId: 'bot-lead',
    },
    adminCookie
  );
  assert.equal(sessionRes.status, 200, 'create session failed');
  const session = sessionRes.json;
  const sessionId = session.id;

  // 3. 通道创建输入校验
  const invalidKindRes = await jsonRequest(
    `/api/sessions/${sessionId}/channels`,
    'POST',
    {
      name: 'Bad Kind',
      kind: 'wechat_invalid',
      targetUrl: `http://127.0.0.1:${mockServer.port}/hook`,
    },
    adminCookie
  );
  assert.equal(invalidKindRes.status, 400);

  const invalidUrlRes = await jsonRequest(
    `/api/sessions/${sessionId}/channels`,
    'POST',
    {
      name: 'Bad URL',
      kind: 'webhook',
      targetUrl: 'ftp://bad-url',
    },
    adminCookie
  );
  assert.equal(invalidUrlRes.status, 400);

  // 4. 创建 Webhook 通道（带 secret）与 飞书通道
  const webhookSecret = 'test-webhook-hmac-secret-123';
  const createWebhookRes = await jsonRequest(
    `/api/sessions/${sessionId}/channels`,
    'POST',
    {
      name: '研发告警 Webhook',
      kind: 'webhook',
      targetUrl: `http://127.0.0.1:${mockServer.port}/webhook`,
      secret: webhookSecret,
      events: ['assistant_reply', 'ask_request', 'wakeup'],
    },
    adminCookie
  );
  assert.equal(createWebhookRes.status, 201);
  const webhookChannel = createWebhookRes.json;
  assert.equal(webhookChannel.name, '研发告警 Webhook');
  assert.equal(webhookChannel.kind, 'webhook');
  assert.equal(webhookChannel.enabled, true);

  const createFeishuRes = await jsonRequest(
    `/api/sessions/${sessionId}/channels`,
    'POST',
    {
      name: '飞书群机器人',
      kind: 'feishu',
      targetUrl: `http://127.0.0.1:${mockServer.port}/feishu`,
      events: ['assistant_reply', 'ask_request'],
    },
    adminCookie
  );
  assert.equal(createFeishuRes.status, 201);
  const feishuChannel = createFeishuRes.json;
  assert.equal(feishuChannel.kind, 'feishu');

  // 查询列表
  const listRes = await jsonRequest(`/api/sessions/${sessionId}/channels`, 'GET', undefined, adminCookie);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.json.length, 2);

  // 5. 测试按钮推送 (POST /api/channels/:channelId/test)
  // 测试飞书推送
  const testFeishuRes = await jsonRequest(
    `/api/channels/${feishuChannel.id}/test`,
    'POST',
    undefined,
    adminCookie
  );
  assert.equal(testFeishuRes.status, 200);
  assert.equal(testFeishuRes.json.ok, true);

  const feishuTestReq = await mockServer.waitForRequest((r) => r.url === '/feishu');
  assert.equal(feishuTestReq.method, 'POST');
  assert.equal(feishuTestReq.json.msg_type, 'text');
  assert.ok(feishuTestReq.json.content.text.includes('[botd]'));

  // 测试 Webhook 推送及 HMAC 验签
  const testWebhookRes = await jsonRequest(
    `/api/channels/${webhookChannel.id}/test`,
    'POST',
    undefined,
    adminCookie
  );
  assert.equal(testWebhookRes.status, 200);

  const webhookTestReq = await mockServer.waitForRequest((r) => r.url === '/webhook');
  assert.equal(webhookTestReq.method, 'POST');
  const signatureHeader = webhookTestReq.headers['x-botd-signature'];
  assert.ok(signatureHeader, 'webhook must include X-Botd-Signature');
  const expectedHmac = 'sha256=' + createHmac('sha256', webhookSecret).update(webhookTestReq.body).digest('hex');
  assert.equal(signatureHeader, expectedHmac, 'X-Botd-Signature must match calculated HMAC');

  // 远端返回 500 时测试推送应返回 502
  const errorChanRes = await jsonRequest(
    `/api/sessions/${sessionId}/channels`,
    'POST',
    {
      name: '故障通道',
      kind: 'webhook',
      targetUrl: `http://127.0.0.1:${mockServer.port}/error-500`,
    },
    adminCookie
  );
  assert.equal(errorChanRes.status, 201);
  const errorChan = errorChanRes.json;
  const testErrorRes = await jsonRequest(`/api/channels/${errorChan.id}/test`, 'POST', undefined, adminCookie);
  assert.equal(testErrorRes.status, 502, 'remote 500 should produce 502');

  // 6. 自动事件广播推送测试：assistant_reply 与 wakeup
  mockServer.requests.length = 0; // 清空历史请求以便断言新推送

  const assistantMsg = hub.db.createMessage({
    id: 'msg_assistant_1',
    sessionId,
    role: 'assistant',
    senderBotId: 'bot-lead',
    content: '你好，我是助手，这是我的工作汇报。',
  });
  hub.sseHub.broadcast(sessionId, {
    type: 'message_created',
    message: assistantMsg.message,
  });

  // 验证两通道均收到推送
  const feishuReplyReq = await mockServer.waitForRequest((r) => r.url === '/feishu' && r.body.includes('你好，我是助手'));
  assert.equal(feishuReplyReq.json.msg_type, 'text');
  assert.ok(feishuReplyReq.json.content.text.includes('@bot-lead: 你好，我是助手'));

  const webhookReplyReq = await mockServer.waitForRequest((r) => r.url === '/webhook' && r.body.includes('你好，我是助手'));
  assert.equal(webhookReplyReq.json.event, 'assistant_reply');
  assert.equal(webhookReplyReq.json.sessionId, sessionId);
  assert.equal(webhookReplyReq.json.message.content, '你好，我是助手，这是我的工作汇报。');

  // 7. botd ask 交互请求推送与手机端免登录一键点击回调确认
  mockServer.requests.length = 0;

  const askPromise = hub.router.requestHumanInput({
    sessionId,
    botId: 'bot-lead',
    prompt: '是否立即发布部署版本 v1.2.0 至生产集群？',
    options: ['确认发布', '暂缓操作'],
    timeoutSeconds: 30,
  });

  // 验证出站通道收到了 ask_request 推送
  const feishuAskReq = await mockServer.waitForRequest((r) => r.url === '/feishu' && r.body.includes('是否立即发布部署版本'));
  assert.ok(feishuAskReq.json.content.text.includes('确认发布'));
  assert.ok(feishuAskReq.json.content.text.includes('暂缓操作'));

  const webhookAskReq = await mockServer.waitForRequest((r) => r.url === '/webhook' && r.body.includes('是否立即发布部署版本'));
  assert.equal(webhookAskReq.json.event, 'ask_request');
  assert.equal(webhookAskReq.json.ask.prompt, '是否立即发布部署版本 v1.2.0 至生产集群？');
  assert.deepEqual(webhookAskReq.json.ask.options, ['确认发布', '暂缓操作']);
  assert.ok(webhookAskReq.json.respondUrls, 'Webhook must provide respondUrls map');

  const confirmUrlStr = webhookAskReq.json.respondUrls['确认发布'];
  assert.ok(confirmUrlStr, 'respondUrls must contain entry for 确认发布');
  const confirmUrl = new URL(confirmUrlStr);
  const askId = confirmUrl.pathname.split('/')[4];
  const querySessionId = confirmUrl.searchParams.get('sessionId');
  const queryAnswer = confirmUrl.searchParams.get('answer');
  const queryToken = confirmUrl.searchParams.get('token');

  assert.equal(querySessionId, sessionId);
  assert.equal(queryAnswer, '确认发布');
  assert.ok(queryToken, 'token must be present');

  // 8. 测试免登录一键回调接口 /api/public/asks/:askId/respond
  // 测试非法 token (403)
  const badTokenRes = await jsonRequest(
    `/api/public/asks/${askId}/respond?sessionId=${sessionId}&answer=确认发布&token=bad_invalid_token`,
    'GET'
  );
  assert.equal(badTokenRes.status, 403, 'bad token must be rejected with 403');

  // 测试缺失参数 (400)
  const missingParamRes = await jsonRequest(
    `/api/public/asks/${askId}/respond?sessionId=${sessionId}&token=${queryToken}`,
    'GET'
  );
  assert.equal(missingParamRes.status, 400);

  // 模拟手机端浏览器直接打开确认链接（带 Accept: text/html）
  const callbackRes = await jsonRequest(
    `${confirmUrl.pathname}${confirmUrl.search}`,
    'GET',
    undefined,
    undefined,
    { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  );
  assert.equal(callbackRes.status, 200, 'public ask respond should return 200');
  assert.ok(callbackRes.text.includes('已确认提交'), 'HTML should show confirmation text');
  assert.ok(callbackRes.text.includes('确认发布'), 'HTML should display the selected answer');

  // 验证 askPromise 顺利 resolve
  const askResult = await askPromise;
  assert.equal(askResult.answer, '确认发布');

  // 再次调用已被确认的 ask 回调，应当返回 404
  const secondCallbackRes = await jsonRequest(
    `${confirmUrl.pathname}${confirmUrl.search}`,
    'GET'
  );
  assert.equal(secondCallbackRes.status, 404, 'already resolved ask should return 404');

  // 9. 测试 Slack 和 Telegram 格式推送
  mockServer.requests.length = 0;
  const createSlackRes = await jsonRequest(
    `/api/sessions/${sessionId}/channels`,
    'POST',
    {
      name: 'Slack 告警',
      kind: 'slack',
      targetUrl: `http://127.0.0.1:${mockServer.port}/slack`,
      events: ['assistant_reply'],
    },
    adminCookie
  );
  assert.equal(createSlackRes.status, 201);

  const createTgRes = await jsonRequest(
    `/api/sessions/${sessionId}/channels`,
    'POST',
    {
      name: 'Telegram 告警',
      kind: 'telegram',
      targetUrl: `http://127.0.0.1:${mockServer.port}/telegram`,
      events: ['assistant_reply'],
    },
    adminCookie
  );
  assert.equal(createTgRes.status, 201);

  const msg2 = hub.db.createMessage({
    id: 'msg_assistant_2',
    sessionId,
    role: 'assistant',
    senderBotId: 'bot-lead',
    content: '多通道通知格式测试',
  });
  hub.sseHub.broadcast(sessionId, {
    type: 'message_created',
    message: msg2.message,
  });

  const slackReq = await mockServer.waitForRequest((r) => r.url === '/slack');
  assert.equal(typeof slackReq.json.text, 'string');
  assert.ok(slackReq.json.text.includes('多通道通知格式测试'));

  const tgReq = await mockServer.waitForRequest((r) => r.url === '/telegram');
  assert.equal(tgReq.json.parse_mode, 'Markdown');
  assert.ok(tgReq.json.text.includes('多通道通知格式测试'));

  // 10. 测试 POST 请求免登录一键回答 botd ask
  const askPromise2 = hub.router.requestHumanInput({
    sessionId,
    botId: 'bot-lead',
    prompt: '是否重启服务？',
    options: ['立即重启', '稍后提醒'],
  });
  const webhookAskReq2 = await mockServer.waitForRequest(
    (r) => r.url === '/webhook' && r.body.includes('是否重启服务')
  );
  const restartUrl = new URL(webhookAskReq2.json.respondUrls['立即重启']);
  const askId2 = restartUrl.pathname.split('/')[4];
  const token2 = restartUrl.searchParams.get('token');

  // 用 POST 发送 JSON 回答
  const postRespondRes = await jsonRequest(
    `/api/public/asks/${askId2}/respond`,
    'POST',
    {
      sessionId,
      answer: '立即重启',
      token: token2,
    }
  );
  assert.equal(postRespondRes.status, 200);
  assert.equal(postRespondRes.json.ok, true);
  assert.equal(postRespondRes.json.ask.answer, '立即重启');
  const askResult2 = await askPromise2;
  assert.equal(askResult2.answer, '立即重启');

  // 11. 测试通道停用时不会触发推送
  await jsonRequest(
    `/api/channels/${createSlackRes.json.id}`,
    'PATCH',
    { enabled: false },
    adminCookie
  );
  mockServer.requests.length = 0;
  const msg3 = hub.db.createMessage({
    id: 'msg_assistant_3',
    sessionId,
    role: 'assistant',
    senderBotId: 'bot-lead',
    content: '停用通道不接收通知',
  });
  hub.sseHub.broadcast(sessionId, {
    type: 'message_created',
    message: msg3.message,
  });
  await mockServer.waitForRequest((r) => r.url === '/telegram' && r.body.includes('停用通道不接收通知'));
  assert.equal(
    mockServer.requests.some((r) => r.url === '/slack'),
    false,
    'Disabled slack channel must not receive webhook notification'
  );

  // 12. 权限隔离校验：跨用户操作
  const user2Res = await jsonRequest(
    '/api/users',
    'POST',
    {
      username: 'user2',
      password: 'password123',
      role: 'member',
    },
    adminCookie
  );
  assert.equal(user2Res.status, 200);

  const user2Login = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'user2', password: 'password123' }),
  });
  const user2Cookie = user2Login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(user2Cookie);

  // user2 试图查看 userAdmin 的 session 通道列表 -> 403
  const user2ListRes = await jsonRequest(
    `/api/sessions/${sessionId}/channels`,
    'GET',
    undefined,
    user2Cookie
  );
  assert.equal(user2ListRes.status, 403);

  // user2 试图修改 userAdmin 的通道 -> 403
  const user2PatchRes = await jsonRequest(
    `/api/channels/${webhookChannel.id}`,
    'PATCH',
    { name: 'Hacked' },
    user2Cookie
  );
  assert.equal(user2PatchRes.status, 403);

  // user2 试图删除 userAdmin 的通道 -> 403
  const user2DelRes = await jsonRequest(
    `/api/channels/${webhookChannel.id}`,
    'DELETE',
    undefined,
    user2Cookie
  );
  assert.equal(user2DelRes.status, 403);

  // 13. 通道更新与删除测试
  const patchRes = await jsonRequest(
    `/api/channels/${webhookChannel.id}`,
    'PATCH',
    {
      name: '已更新名称通道',
      enabled: false,
    },
    adminCookie
  );
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.json.name, '已更新名称通道');
  assert.equal(patchRes.json.enabled, false);

  const deleteRes = await jsonRequest(`/api/channels/${webhookChannel.id}`, 'DELETE', undefined, adminCookie);
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.json.ok, true);

  const listAfterDelete = await jsonRequest(`/api/sessions/${sessionId}/channels`, 'GET', undefined, adminCookie);
  assert.equal(listAfterDelete.json.some((c: any) => c.id === webhookChannel.id), false);

  // 等待微任务与非阻塞后台推送完成
  await new Promise((r) => setTimeout(r, 100));
});
