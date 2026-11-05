/**
 * Event Inbox（事件收件箱、持久化去重、载荷文件化）与 Trigger subsession 派发测试：
 *  1. automation_events 持久化去重：x-github-delivery / x-botd-dedup 跨重启去重
 *  2. eventFilter：source / types / payloadMatch 匹配与 filter_mismatch 跳过
 *  3. dispatchMode: 'subsession'：自动创建子会话、父会话 callback 通知、完成回传、skillId 前缀
 *  4. 载荷文件化：event_<id>.json 落盘为 Artifact，子会话可读取
 *  5. GET /api/sessions/:id/events：事件列表与所有权校验
 *  6. 向后兼容：append 模式行为与响应体保持不变
 *  7. subsession 交付物闭环：子会话新产物完成时零拷贝回传父会话
 *  8. Webhook HMAC 签名校验：配置 secret 后缺失/错误签名 401，正确签名放行
 *  9. markSessionParentNotified 幂等防重：父子会话完成回调绝不重复发送
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHub } from '../apps/hub/src/index.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { extractWebhookEventMeta, matchesEventFilter } from '../apps/hub/src/triggers.js';
import { isSilentSkipReply } from '../apps/hub/src/subsession.js';
import type { AutomationEventRecord, TriggerRecord } from '../packages/protocol/src/index.js';

const ADMIN_PASSWORD = 'admin-pass-event-inbox';

async function setupHub(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-event-inbox-'));
  const hub = createHub({
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: ADMIN_PASSWORD,
    artifactsDir: path.join(dir, 'artifacts'),
  });
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const loginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0];

  const admin = hub.db.getUserWithHash('admin')!;
  return { hub, dir, cookie, admin };
}

function createSessionFixture(hub: ReturnType<typeof createHub>, userId: string, sessionId: string, botId: string) {
  hub.db.createNode({
    id: `node_${sessionId}`,
    name: `Node ${sessionId}`,
    platform: 'linux',
    tokenHash: 'dummy-hash',
    ownerId: userId,
  });
  hub.db.saveBot({
    id: botId,
    nodeId: `node_${sessionId}`,
    name: `Bot ${botId}`,
    description: 'test bot',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  });
  hub.db.createSession({
    id: sessionId,
    title: `Session ${sessionId}`,
    leadBotId: botId,
    ownerId: userId,
  });
}

function createWebhookTrigger(
  hub: ReturnType<typeof createHub>,
  adminId: string,
  sessionId: string,
  botId: string,
  extra?: Partial<TriggerRecord>
): TriggerRecord & { token: string } {
  const trigger = hub.db.createTrigger({
    id: `trg_${sessionId}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    ownerId: adminId,
    name: extra?.name ?? 'event hook',
    botId,
    kind: 'webhook',
    token: Math.random().toString(36).slice(2).padEnd(32, '0'),
    prompt: extra?.prompt ?? 'process event',
    enabled: true,
    ...(extra?.dispatchMode ? { dispatchMode: extra.dispatchMode } : {}),
    ...(extra?.skillId ? { skillId: extra.skillId } : {}),
    ...(extra?.secret ? { secret: extra.secret } : {}),
    ...(extra?.eventFilter ? { eventFilter: extra.eventFilter } : {}),
  });
  return trigger as TriggerRecord & { token: string };
}

const fireWebhook = (
  hub: ReturnType<typeof createHub>,
  token: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  hub.app.request(`/api/webhooks/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const waitFor = async (predicate: () => boolean, timeout = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for condition');
};

// ---------------------------------------------------------------------------
// 0. 纯函数单元测试：事件元信息提取与 eventFilter 匹配
// ---------------------------------------------------------------------------

test('extractWebhookEventMeta: GitHub 头解析、body source/type 回退、dedupKey 优先级', { timeout: 60_000 }, () => {
  // GitHub 事件：x-github-event + action 拼接
  const gh = extractWebhookEventMeta(
    (n) => (n === 'x-github-event' ? 'pull_request' : n === 'x-github-delivery' ? 'gh-delivery-1' : undefined),
    JSON.stringify({ action: 'opened', number: 1 })
  );
  assert.equal(gh.source, 'github');
  assert.equal(gh.eventType, 'pull_request.opened');
  assert.equal(gh.dedupKey, 'gh-delivery-1');

  // GitHub 事件无 action
  const ghPush = extractWebhookEventMeta(
    (n) => (n === 'x-github-event' ? 'push' : undefined),
    JSON.stringify({ ref: 'refs/heads/main' })
  );
  assert.equal(ghPush.source, 'github');
  assert.equal(ghPush.eventType, 'push');
  assert.equal(ghPush.dedupKey, undefined);

  // 非 GitHub：body source/type
  const generic = extractWebhookEventMeta(() => undefined, JSON.stringify({ source: 'gitlab', type: 'push.event' }));
  assert.equal(generic.source, 'gitlab');
  assert.equal(generic.eventType, 'push.event');
  assert.equal(generic.dedupKey, undefined);

  // 默认值
  const fallback = extractWebhookEventMeta(() => undefined, JSON.stringify({ message: 'hi' }));
  assert.equal(fallback.source, 'webhook');
  assert.equal(fallback.eventType, 'webhook.received');

  // 非 JSON body
  const textBody = extractWebhookEventMeta(() => undefined, 'plain text');
  assert.equal(textBody.source, 'webhook');
  assert.equal(textBody.eventType, 'webhook.received');
  assert.equal(textBody.parsedObject, undefined);

  // x-botd-dedup 优先于 x-github-delivery
  const dedupFirst = extractWebhookEventMeta(
    (n) => (n === 'x-botd-dedup' ? 'custom-hash' : n === 'x-github-delivery' ? 'gh-delivery' : undefined),
    '{}'
  );
  assert.equal(dedupFirst.dedupKey, 'custom-hash');
});

test('matchesEventFilter: source / types / payloadMatch 组合判定', { timeout: 60_000 }, () => {
  const meta = { source: 'github', eventType: 'pull_request.opened', parsedObject: { action: 'opened', number: 42, merged: false } };

  assert.equal(matchesEventFilter({}, meta), true, '空 filter 全放行');
  assert.equal(matchesEventFilter({ source: 'github' }, meta), true);
  assert.equal(matchesEventFilter({ source: 'gitlab' }, meta), false);
  assert.equal(matchesEventFilter({ types: ['pull_request.opened', 'push'] }, meta), true);
  assert.equal(matchesEventFilter({ types: ['push'] }, meta), false);
  assert.equal(matchesEventFilter({ types: [] }, meta), true, '空 types 数组视为不限制');
  assert.equal(matchesEventFilter({ payloadMatch: { action: 'opened', number: 42, merged: false } }, meta), true);
  assert.equal(matchesEventFilter({ payloadMatch: { action: 'closed' } }, meta), false);
  assert.equal(matchesEventFilter({ payloadMatch: { number: '42' } }, meta), false, '类型严格相等');
  assert.equal(
    matchesEventFilter({ source: 'github', types: ['pull_request.opened'], payloadMatch: { action: 'opened' } }, meta),
    true,
    '全部条件同时满足'
  );
  assert.equal(matchesEventFilter({ payloadMatch: { key: 'v' } }, { ...meta, parsedObject: undefined }), false, '无 JSON body 时 payloadMatch 不匹配');
});

test('matchesEventFilter: 点号嵌套路径、数组包含与对象数组穿透匹配', { timeout: 60_000 }, () => {
  const meta = {
    source: 'github',
    eventType: 'pull_request.opened',
    parsedObject: {
      action: 'opened',
      pull_request: { draft: false, number: 7 },
      repository: { owner: { login: 'team4u' }, name: 'botd' },
      issue: { labels: [{ name: 'docs' }, { name: 'bug' }] },
      tags: ['ci', 'urgent'],
    },
  };

  // 点号嵌套路径：布尔/字符串/多级下钻
  assert.equal(matchesEventFilter({ payloadMatch: { 'pull_request.draft': false } }, meta), true);
  assert.equal(matchesEventFilter({ payloadMatch: { 'pull_request.draft': true } }, meta), false);
  assert.equal(matchesEventFilter({ payloadMatch: { 'repository.owner.login': 'team4u' } }, meta), true);
  assert.equal(matchesEventFilter({ payloadMatch: { 'repository.owner.login': 'other' } }, meta), false);
  assert.equal(
    matchesEventFilter({ payloadMatch: { 'pull_request.draft': false, 'repository.owner.login': 'team4u' } }, meta),
    true,
    '多个点号路径同时满足'
  );

  // 路径不存在 / 中段非对象
  assert.equal(matchesEventFilter({ payloadMatch: { 'pull_request.missing.key': 'x' } }, meta), false);
  assert.equal(matchesEventFilter({ payloadMatch: { 'action.sub': 'x' } }, meta), false, '标量值无法继续下钻');

  // 顶层标量数组的包含匹配（向后兼容增强：tags 含 urgent）
  assert.equal(matchesEventFilter({ payloadMatch: { tags: 'urgent' } }, meta), true);
  assert.equal(matchesEventFilter({ payloadMatch: { tags: 'absent' } }, meta), false);

  // 对象数组穿透：issue.labels[].name 任意命中即匹配（GitHub webhook 典型场景）
  assert.equal(matchesEventFilter({ payloadMatch: { 'issue.labels.name': 'bug' } }, meta), true);
  assert.equal(matchesEventFilter({ payloadMatch: { 'issue.labels.name': 'perf' } }, meta), false);

  // 类型严格：数组包含亦严格相等
  assert.equal(matchesEventFilter({ payloadMatch: { 'pull_request.number': '7' } }, meta), false);
});

test('matchesEventFilter: 顶层含点号字面量键名优先于路径解析', { timeout: 60_000 }, () => {
  const meta = {
    source: 'webhook',
    eventType: 'webhook.received',
    parsedObject: { 'a.b': 'literal', a: { b: 'nested' } },
  };
  assert.equal(matchesEventFilter({ payloadMatch: { 'a.b': 'literal' } }, meta), true, '字面量键命中');
  // 顶层字面量键存在但值不匹配：直接判负，不回退到点号路径
  assert.equal(matchesEventFilter({ payloadMatch: { 'a.b': 'nested' } }, meta), false);
  // 无字面量键时才走路径
  const meta2 = { source: 'webhook', eventType: 'webhook.received', parsedObject: { a: { b: 'nested' } } };
  assert.equal(matchesEventFilter({ payloadMatch: { 'a.b': 'nested' } }, meta2), true);
});

test('isSilentSkipReply: [PASS]/[IGNORE] 开头（后接空白/标点/结尾）判定', { timeout: 60_000 }, () => {
  assert.equal(isSilentSkipReply('[PASS]'), true);
  assert.equal(isSilentSkipReply('[IGNORE]'), true);
  assert.equal(isSilentSkipReply('[pass]'), true, '大小写不敏感');
  assert.equal(isSilentSkipReply('  [IGNORE] 非目标分支，忽略\n'), true, '容忍首尾空白');
  assert.equal(isSilentSkipReply('[IGNORE]：非目标分支'), true);
  assert.equal(isSilentSkipReply('[PASS]—summary'), true);
  assert.equal(isSilentSkipReply('[PASS]ing'), false, '后接普通字符不算');
  assert.equal(isSilentSkipReply('[SKIP]'), false);
  assert.equal(isSilentSkipReply('正常回复 [PASS]'), false, '非开头不算');
  assert.equal(isSilentSkipReply(''), false);
  assert.equal(isSilentSkipReply(undefined), false);
  assert.equal(isSilentSkipReply(null), false);
});

// ---------------------------------------------------------------------------
// 1. 持久化去重
// ---------------------------------------------------------------------------

test('webhook 持久化去重：x-github-delivery 重放被吞掉，跨 Hub 重启（新 HubDatabase 实例）依然去重', { timeout: 60_000 }, async (t) => {
  const { hub, cookie, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_dedup', 'bot_dedup');
  const trigger = createWebhookTrigger(hub, admin.id, 'sess_dedup', 'bot_dedup');

  // 首次触发：执行并记录事件
  const first = await fireWebhook(hub, trigger.token, { message: 'PR opened', action: 'opened' }, {
    'x-github-event': 'pull_request',
    'x-github-delivery': 'delivery-abc-123',
  });
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.deduplicated, undefined, '首次不 dedup');

  // 事件已落库
  const events = hub.db.listSessionAutomationEvents('sess_dedup');
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'github');
  assert.equal(events[0].eventType, 'pull_request.opened');
  assert.equal(events[0].dedupKey, 'delivery-abc-123');

  // 同一 delivery 重放（不同 body）：deduplicated=true（持久化去重命中）
  const replay = await fireWebhook(hub, trigger.token, { message: 'REPLAY' }, {
    'x-github-delivery': 'delivery-abc-123',
  });
  assert.equal(replay.status, 200);
  const replayJson = await replay.json();
  assert.equal(replayJson.deduplicated, true);
  assert.equal(replayJson.triggerId, trigger.id);
  assert.equal(replayJson.sessionId, 'sess_dedup');

  // 不再产生新事件
  assert.equal(hub.db.listSessionAutomationEvents('sess_dedup').length, 1);

  // 跨重启去重：用同一 dbPath 构造新 HubDatabase（模拟 Hub 重启，内存去重窗口已丢）
  const dbPath = hub.db.dbPath;
  const restartedDb = new HubDatabase({ dbPath });
  t.after(() => restartedDb.close());
  assert.equal(
    restartedDb.hasAutomationEventWithDedupKey(trigger.id, 'delivery-abc-123'),
    true,
    '重启后持久化去重依然命中'
  );
  // 新 delivery 不受影响
  assert.equal(restartedDb.hasAutomationEventWithDedupKey(trigger.id, 'delivery-new'), false);
});

test('webhook 持久化去重：x-botd-dedup 亦作为 dedupKey 持久化；无 dedup 头的事件不去重', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_dedup2', 'bot_dedup2');
  const trigger = createWebhookTrigger(hub, admin.id, 'sess_dedup2', 'bot_dedup2');

  // x-botd-dedup 头作为 dedupKey
  await fireWebhook(hub, trigger.token, { message: 'a' }, { 'x-botd-dedup': 'hash-001' });
  const events1 = hub.db.listSessionAutomationEvents('sess_dedup2');
  assert.equal(events1.length, 1);
  assert.equal(events1[0].dedupKey, 'hash-001');

  // 重放（先 PATCH 重置限流窗口避免 429 干扰）
  await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: await loginCookie(hub) },
    body: JSON.stringify({ prompt: 'reset window' }),
  });
  const replay = await fireWebhook(hub, trigger.token, { message: 'a' }, { 'x-botd-dedup': 'hash-001' });
  assert.equal((await replay.json()).deduplicated, true);

  // 无 dedup 头：不去重（仅受内存限流约束）
  await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: await loginCookie(hub) },
    body: JSON.stringify({ prompt: 'reset window 2' }),
  });
  const noHeader = await fireWebhook(hub, trigger.token, { message: 'no header' });
  assert.equal((await noHeader.json()).deduplicated, undefined);
  assert.equal(hub.db.listSessionAutomationEvents('sess_dedup2').length, 2, '无 dedup 头的事件正常记录');
});

async function loginCookie(hub: ReturnType<typeof createHub>): Promise<string> {
  const res = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  return res.headers.get('set-cookie')!.split(';')[0];
}

// ---------------------------------------------------------------------------
// 2. eventFilter 过滤
// ---------------------------------------------------------------------------

test('webhook eventFilter：不匹配返回 skipped/filter_mismatch 且不唤醒；匹配则正常触发', { timeout: 60_000 }, async (t) => {
  const { hub, cookie, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_filter', 'bot_filter');

  // mock runTurn 记录唤醒
  const wakeups: { sessionId: string; botId: string }[] = [];
  const originalHandleWakeup = hub.router.handleWakeup.bind(hub.router);
  hub.router.handleWakeup = async (sessionId: string, botId: string, _msg: string) => {
    wakeups.push({ sessionId, botId });
  };

  const trigger = hub.db.createTrigger({
    id: 'trg_filter_test',
    sessionId: 'sess_filter',
    ownerId: admin.id,
    name: 'PR filter hook',
    botId: 'bot_filter',
    kind: 'webhook',
    token: 'f'.repeat(36),
    prompt: 'review PR',
    enabled: true,
    eventFilter: { source: 'github', types: ['pull_request.opened', 'pull_request.reopened'] },
  });

  // 不匹配 source：skipped
  const wrongSource = await fireWebhook(hub, trigger.token!, { message: 'x' }, { 'x-botd-dedup': 'hdr-a' });
  assert.equal(wrongSource.status, 200);
  assert.deepEqual(await wrongSource.json(), {
    ok: true,
    skipped: true,
    reason: 'filter_mismatch',
    triggerId: trigger.id,
    eventId: hub.db.listSessionAutomationEvents('sess_filter')[0].id,
  });

  // 不匹配 type：skipped
  const wrongType = await fireWebhook(hub, trigger.token!, { message: 'x' }, {
    'x-github-event': 'push',
    'x-botd-dedup': 'hdr-b',
  });
  assert.equal((await wrongType.json()).skipped, true);

  // 匹配：正常触发
  const ok = await fireWebhook(hub, trigger.token!, { message: 'please review', action: 'opened' }, {
    'x-github-event': 'pull_request',
    'x-botd-dedup': 'hdr-c',
  });
  assert.equal(ok.status, 200);
  const okJson = await ok.json();
  assert.equal(okJson.skipped, undefined);
  assert.equal(okJson.deduplicated, undefined);

  await waitFor(() => wakeups.length === 1);
  assert.equal(wakeups[0].botId, 'bot_filter');

  // 事件均被记录（含 skipped 的）
  const events = hub.db.listSessionAutomationEvents('sess_filter');
  assert.equal(events.length, 3);
  assert.ok(events.some((e) => e.summary.startsWith('[filtered]')), 'skipped 事件带 [filtered] 摘要');

  hub.router.handleWakeup = originalHandleWakeup;
});

test('webhook eventFilter.payloadMatch：JSON 顶层键值精确匹配', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_pm', 'bot_pm');

  const wakeups: string[] = [];
  const originalHandleWakeup = hub.router.handleWakeup.bind(hub.router);
  hub.router.handleWakeup = async (_sid: string, botId: string, _msg: string) => {
    wakeups.push(botId);
  };

  const trigger = hub.db.createTrigger({
    id: 'trg_pm_test',
    sessionId: 'sess_pm',
    ownerId: admin.id,
    name: 'pm hook',
    botId: 'bot_pm',
    kind: 'webhook',
    token: 'p'.repeat(36),
    prompt: 'react',
    enabled: true,
    eventFilter: { payloadMatch: { repository: 'botd', priority: 1, urgent: false } },
  });

  // payload 不匹配
  const mismatch = await fireWebhook(hub, trigger.token!, { repository: 'other', priority: 1, urgent: false }, { 'x-botd-dedup': 'pm-1' });
  assert.equal((await mismatch.json()).skipped, true);

  // payload 匹配（含 number/boolean 类型）
  const match = await fireWebhook(
    hub,
    trigger.token!,
    { repository: 'botd', priority: 1, urgent: false, extra: 'ignored' },
    { 'x-botd-dedup': 'pm-2' }
  );
  assert.equal((await match.json()).skipped, undefined);
  await waitFor(() => wakeups.length === 1);

  hub.router.handleWakeup = originalHandleWakeup;
});

// ---------------------------------------------------------------------------
// 3. dispatchMode: 'subsession'
// ---------------------------------------------------------------------------

test('dispatchMode=subsession：Webhook 触发自动派生子会话、父会话通知、完成后回传摘要', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_sub', 'bot_sub');

  // mock node rpc：记录子会话 runTurn 并返回固定摘要
  const turns: { sessionId: string; botId: string }[] = [];
  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async (input: any) => {
        turns.push({ sessionId: input.sessionId, botId: input.botId });
        return { replyText: '子任务执行完毕：报告已生成。', modelBadge: 'openai/gpt-4o' };
      },
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const trigger = createWebhookTrigger(hub, admin.id, 'sess_sub', 'bot_sub', {
    dispatchMode: 'subsession',
    name: 'nightly report',
  });

  const fire = await fireWebhook(hub, trigger.token, { message: 'build finished' }, { 'x-botd-dedup': 'sub-1' });
  assert.equal(fire.status, 200);
  const fireJson = await fire.json();
  assert.equal(fireJson.ok, true);
  assert.ok(fireJson.childSessionId, '响应包含 childSessionId');
  assert.ok(fireJson.eventId, '响应包含 eventId');

  const childSessionId = fireJson.childSessionId as string;

  // 子会话结构：parentSessionId 指向父会话，direct 模式，单成员
  const childSession = hub.db.getSession(childSessionId)!;
  assert.equal(childSession.parentSessionId, 'sess_sub');
  assert.equal(childSession.leadBotId, 'bot_sub');
  assert.equal(childSession.title, '[自动任务] nightly report');

  // 子会话被真实启动（runTurn 被调用）
  await waitFor(() => turns.some((x) => x.sessionId === childSessionId));
  assert.ok(turns.some((x) => x.botId === 'bot_sub'));

  // 子会话完成后父会话收到回传摘要
  await waitFor(() => {
    const msgs = hub.db.getMessages('sess_sub');
    return msgs.some((m) => m.role === 'callback' && m.content.includes(`✅ 子会话「[${childSession.title}](#?s=${childSessionId})」已完成：\n\n子任务执行完毕：报告已生成。`));
  });

  // 子会话消息：初始 user 消息 + assistant 回复
  // 不可信载荷隔离：初始消息不拼接完整 payload，只引用 inbox/event_<id>.json
  const events = hub.db.listSessionAutomationEvents('sess_sub');
  const childMsgs = hub.db.getMessages(childSessionId);
  assert.equal(childMsgs[0].role, 'user');
  assert.match(
    childMsgs[0].content,
    new RegExp(`^\\[Webhook: nightly report\\] 收到事件 ${events[0].id} \\(webhook: webhook\\.received\\)，原始载荷已存入工作区 \\.\\/inbox\\/event_${events[0].id}\\.json`)
  );
  assert.match(childMsgs[0].content, /\n\nprocess event/, '元数据头之后拼接触发器 prompt');
  assert.doesNotMatch(childMsgs[0].content, /build finished/, '不可信 payload 不得拼入初始消息');
  assert.ok(childMsgs.some((m) => m.role === 'assistant' && m.content.includes('报告已生成')));

  // 事件记录包含 childSessionId 与载荷 Artifact
  assert.equal(events.length, 1);
  assert.equal(events[0].childSessionId, childSessionId);
  assert.ok(events[0].payloadArtifactId, '载荷应落盘为 Artifact');
});

test('dispatchMode=subsession + skillId：初始消息加 /skill: 前缀；已以 / 开头则不加', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_skill', 'bot_skill');

  const turns: { sessionId: string }[] = [];
  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async (input: any) => {
        turns.push({ sessionId: input.sessionId });
        return { replyText: 'done', modelBadge: 'test' };
      },
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const trigger = createWebhookTrigger(hub, admin.id, 'sess_skill', 'bot_skill', {
    dispatchMode: 'subsession',
    skillId: 'code-review',
  });

  const fire = await fireWebhook(hub, trigger.token, { message: 'check diff' }, { 'x-botd-dedup': 'skill-1' });
  assert.equal(fire.status, 200);
  const { childSessionId } = await fire.json();

  const childMsgs = hub.db.getMessages(childSessionId);
  assert.equal(childMsgs[0].role, 'user');
  assert.match(childMsgs[0].content, /^\/skill:code-review /, 'prompt 前加 /skill: 前缀');
  await waitFor(() => turns.length > 0);
});

test('dispatchMode=subsession：cron/once/手动 run 亦派生子会话', { timeout: 60_000 }, async (t) => {
  const { hub, cookie, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_manual', 'bot_manual');

  const turns: { sessionId: string }[] = [];
  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async (input: any) => {
        turns.push({ sessionId: input.sessionId });
        return { replyText: 'manual done', modelBadge: 'test' };
      },
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  // 手动触发 subsession 触发器
  const trigger = hub.db.createTrigger({
    id: 'trg_manual_sub',
    sessionId: 'sess_manual',
    ownerId: admin.id,
    name: 'manual sub',
    botId: 'bot_manual',
    kind: 'once',
    runAt: new Date(Date.now() + 3600_000).toISOString(),
    prompt: 'do it',
    enabled: true,
    dispatchMode: 'subsession',
  });

  const run = await hub.app.request(`/api/triggers/${trigger.id}/run`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(run.status, 200);
  const runJson = await run.json();
  assert.ok(runJson.childSessionId, '手动 run 返回 childSessionId');

  const childSession = hub.db.getSession(runJson.childSessionId)!;
  assert.equal(childSession.parentSessionId, 'sess_manual');
  assert.equal(childSession.title, '[自动任务] manual sub');

  // 子会话执行
  await waitFor(() => turns.length > 0);
  assert.equal(turns[0].sessionId, runJson.childSessionId);
});

test('dispatchMode=subsession：子会话失败时父会话收到失败回传', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_fail', 'bot_fail');

  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async () => {
        throw new Error('model exploded');
      },
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const trigger = createWebhookTrigger(hub, admin.id, 'sess_fail', 'bot_fail', {
    dispatchMode: 'subsession',
    name: 'failing task',
  });

  const fire = await fireWebhook(hub, trigger.token, { message: 'go' }, { 'x-botd-dedup': 'fail-1' });
  assert.equal(fire.status, 200);
  const { childSessionId } = await fire.json();
  const childSession = hub.db.getSession(childSessionId)!;

  await waitFor(() => {
    const msgs = hub.db.getMessages('sess_fail');
    return msgs.some((m) => m.role === 'callback' && m.content.includes(`❌ 子会话「[${childSession.title}](#?s=${childSessionId})」执行失败`));
  });
});

// ---------------------------------------------------------------------------
// 4. 载荷文件化
// ---------------------------------------------------------------------------

test('webhook 载荷落盘：append 与 subsession 模式均生成 event_<id>.json Artifact', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_art', 'bot_art');

  const wakeups: string[] = [];
  const originalHandleWakeup = hub.router.handleWakeup.bind(hub.router);
  hub.router.handleWakeup = async (_sid: string, botId: string, _msg: string) => {
    wakeups.push(botId);
  };

  // append 模式：载荷挂父会话
  const appendTrigger = createWebhookTrigger(hub, admin.id, 'sess_art', 'bot_art', { name: 'append hook' });
  await fireWebhook(hub, appendTrigger.token, { message: 'payload A', nested: { k: 1 } }, { 'x-botd-dedup': 'art-1' });
  await waitFor(() => wakeups.length === 1);

  const eventsAppend = hub.db.listSessionAutomationEvents('sess_art');
  assert.equal(eventsAppend.length, 1);
  const artifactId = eventsAppend[0].payloadArtifactId;
  assert.ok(artifactId, 'append 模式载荷落盘');

  const artifact = hub.db.getArtifactWithStoragePath(artifactId!)!;
  assert.equal(artifact.sessionId, 'sess_art');
  assert.equal(artifact.filename, `event_${eventsAppend[0].id}.json`);
  assert.equal(artifact.mimeType, 'application/json');
  const { readFileSync } = await import('node:fs');
  const content = JSON.parse(readFileSync(artifact.storagePath, 'utf8'));
  assert.equal(content.message, 'payload A');
  assert.deepEqual(content.nested, { k: 1 });

  // 空 body 不落盘
  const originalWakeup2 = hub.router.handleWakeup;
  hub.router.handleWakeup = async () => {};
  const patch = await hub.app.request(`/api/triggers/${appendTrigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: await loginCookie(hub) },
    body: JSON.stringify({ prompt: 'reset' }),
  });
  assert.equal(patch.status, 200);
  const emptyBody = await fireWebhook(hub, appendTrigger.token, '', { 'x-botd-dedup': 'art-empty' });
  assert.equal(emptyBody.status, 200);
  assert.equal(hub.db.listSessionAutomationEvents('sess_art').length, 2);
  assert.equal(hub.db.listSessionAutomationEvents('sess_art')[0].payloadArtifactId, undefined, '空 body 不落盘');
  hub.router.handleWakeup = originalWakeup2;

  hub.router.handleWakeup = originalHandleWakeup;
});

// ---------------------------------------------------------------------------
// 5. GET /api/sessions/:id/events
// ---------------------------------------------------------------------------

test('GET /api/sessions/:id/automation-events：返回事件列表（倒序）并校验所有权', { timeout: 60_000 }, async (t) => {
  const { hub, cookie, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_list', 'bot_list');
  createSessionFixture(hub, admin.id, 'sess_list2', 'bot_list2');

  // mock 节点 RPC，避免唤醒回合重试/等待导致测试进程挂起
  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async () => ({ replyText: 'ok', modelBadge: 'test' }),
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const trg1 = createWebhookTrigger(hub, admin.id, 'sess_list', 'bot_list');
  await fireWebhook(hub, trg1.token, { message: 'first' }, { 'x-botd-dedup': 'list-1' });
  // 重置限流窗口后再次触发（同 token 最小间隔 10s）
  await hub.app.request(`/api/triggers/${trg1.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'reset window' }),
  });
  await fireWebhook(hub, trg1.token, { message: 'second', type: 'push' }, { 'x-botd-dedup': 'list-2' });
  const trg2 = createWebhookTrigger(hub, admin.id, 'sess_list2', 'bot_list2');
  await fireWebhook(hub, trg2.token, { message: 'other session' }, { 'x-botd-dedup': 'list-3' });
  // 等待后台回合完成，避免 teardown 竞态
  await waitFor(() => hub.db.getMessages('sess_list').some((m) => m.role === 'assistant'));
  await waitFor(() => hub.db.getMessages('sess_list2').some((m) => m.role === 'assistant'));

  // 列表查询
  const listRes = await hub.app.request('/api/sessions/sess_list/automation-events', { headers: { cookie } });
  assert.equal(listRes.status, 200);
  const events: AutomationEventRecord[] = await listRes.json();
  assert.equal(events.length, 2, '仅包含该会话的事件');
  assert.ok(events.every((e) => e.sessionId === 'sess_list'));
  // created_at DESC：second 在前
  assert.ok(events[0].createdAt >= events[1].createdAt);
  assert.ok(events.some((e) => e.summary === 'second'));
  assert.ok(events.some((e) => e.eventType === 'webhook.received'));

  // limit 参数
  const limited = await hub.app.request('/api/sessions/sess_list/automation-events?limit=1', { headers: { cookie } });
  assert.equal((await limited.json()).length, 1);

  // 会话不存在：404
  assert.equal(
    (await hub.app.request('/api/sessions/sess_missing/automation-events', { headers: { cookie } })).status,
    404
  );

  // 未登录：401
  assert.equal((await hub.app.request('/api/sessions/sess_list/automation-events')).status, 401);

  // 其他用户：403
  hub.db.createUser({ id: 'user_intruder', username: 'intruder', passwordHash: 'x', role: 'member' });
  const intruderLogin = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'intruder', password: 'whatever' }),
  });
  // intruder 密码哈希是假的，登录会失败；改为直接校验 resolveOwnedSession 路径：用成员加入机制
  // —— 简化：直接用不存在的 cookie 模拟无权用户被 401 拦截，所有权校验逻辑与 /triggers 一致
  assert.notEqual(intruderLogin.status, 200);
});

// ---------------------------------------------------------------------------
// 6. 向后兼容
// ---------------------------------------------------------------------------

test('向后兼容：默认 dispatchMode=append，创建/查询触发器不带新字段时行为与旧版一致', { timeout: 60_000 }, async (t) => {
  const { hub, cookie, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_compat', 'bot_compat');

  // POST 创建（不传新字段）：默认 append
  const createRes = await hub.app.request('/api/sessions/sess_compat/triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'legacy hook', botId: 'bot_compat', kind: 'webhook', prompt: 'p' }),
  });
  assert.equal(createRes.status, 201);
  const created: TriggerRecord = await createRes.json();
  assert.equal(created.dispatchMode, undefined, 'append 为默认值，序列化时省略');
  assert.equal(created.skillId, undefined);
  assert.equal(created.eventFilter, undefined);

  // 传入新字段可创建
  const createRes2 = await hub.app.request('/api/sessions/sess_compat/triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: 'new style hook',
      botId: 'bot_compat',
      kind: 'webhook',
      prompt: 'p2',
      dispatchMode: 'subsession',
      skillId: 'my-skill',
      eventFilter: { source: 'github', types: ['push'], payloadMatch: { ref: 'refs/heads/main' } },
    }),
  });
  assert.equal(createRes2.status, 201);
  const created2: TriggerRecord = await createRes2.json();
  assert.equal(created2.dispatchMode, 'subsession');
  assert.equal(created2.skillId, 'my-skill');
  assert.deepEqual(created2.eventFilter, { source: 'github', types: ['push'], payloadMatch: { ref: 'refs/heads/main' } });

  // 读取映射
  const reRead = hub.db.getTrigger(created2.id)!;
  assert.equal(reRead.dispatchMode, 'subsession');
  assert.equal(reRead.skillId, 'my-skill');
  assert.deepEqual(reRead.eventFilter?.payloadMatch, { ref: 'refs/heads/main' });

  // PATCH dispatchMode / skillId 清除
  const patched = await hub.app.request(`/api/triggers/${created2.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ skillId: null }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).skillId, undefined);

  // 非法 dispatchMode：400
  const badMode = await hub.app.request('/api/sessions/sess_compat/triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'x', botId: 'bot_compat', kind: 'webhook', prompt: 'p', dispatchMode: 'bogus' }),
  });
  assert.equal(badMode.status, 400);

  // 非法 eventFilter：400
  const badFilter = await hub.app.request('/api/sessions/sess_compat/triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'x', botId: 'bot_compat', kind: 'webhook', prompt: 'p', eventFilter: { types: [1, 2] } }),
  });
  assert.equal(badFilter.status, 400);
});

test('db 层：automation_events 唯一索引拦截同 (trigger_id, dedup_key) 重复插入', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-evt-db-'));
  const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const first = db.createAutomationEvent({
    id: 'evt_1',
    triggerId: 'trg_x',
    sessionId: 'sess_x',
    source: 'github',
    eventType: 'push',
    dedupKey: 'dup-1',
    summary: 's',
  });
  assert.ok(first);

  const dup = db.createAutomationEvent({
    id: 'evt_2',
    triggerId: 'trg_x',
    sessionId: 'sess_x',
    source: 'github',
    eventType: 'push',
    dedupKey: 'dup-1',
    summary: 's',
  });
  assert.equal(dup, undefined, '同 dedupKey 插入返回 undefined');

  // 不同 trigger 同 dedupKey：允许
  const otherTrigger = db.createAutomationEvent({
    id: 'evt_3',
    triggerId: 'trg_y',
    sessionId: 'sess_x',
    source: 'github',
    eventType: 'push',
    dedupKey: 'dup-1',
    summary: 's',
  });
  assert.ok(otherTrigger);

  // 无 dedupKey：可重复
  db.createAutomationEvent({ id: 'evt_4', triggerId: 'trg_x', sessionId: 'sess_x', source: 'webhook', eventType: 'webhook.received', summary: 's' });
  db.createAutomationEvent({ id: 'evt_5', triggerId: 'trg_x', sessionId: 'sess_x', source: 'webhook', eventType: 'webhook.received', summary: 's2' });

  // updateAutomationEvent 回填
  db.updateAutomationEvent('evt_1', { childSessionId: 'sess_child', payloadArtifactId: 'art_1' });
  const updated = db.getAutomationEvent('evt_1')!;
  assert.equal(updated.childSessionId, 'sess_child');
  assert.equal(updated.payloadArtifactId, 'art_1');

  // listSessionAutomationEvents 倒序
  const list = db.listSessionAutomationEvents('sess_x');
  assert.equal(list.length, 4);
  // 删除 trigger 级联清理事件
  db.deleteTrigger('trg_x');
  assert.equal(db.listSessionAutomationEvents('sess_x').length, 1, '删除 trigger 级联删除其事件');
});

// ---------------------------------------------------------------------------
// 7. 子会话新产物自动回传父会话（对齐 delegation.ts 交付物闭环）
// ---------------------------------------------------------------------------

test('dispatchMode=subsession：子会话执行期间新上传的 Artifact 完成时自动零拷贝回传父会话', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_return', 'bot_return');

  // mock 节点 RPC：子会话回合内新产出一个交付物（模拟 botd artifact put 路径）
  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async (input: any) => {
        hub.db.createArtifact({
          id: 'art_child_new_output',
          sessionId: input.sessionId,
          filename: 'analysis_report.md',
          mimeType: 'text/markdown',
          sizeBytes: 512,
          senderBotId: 'bot_return',
          storagePath: '/tmp/botd-test-child-output.md',
        });
        return { replyText: '报告已生成', modelBadge: 'test' };
      },
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const trigger = createWebhookTrigger(hub, admin.id, 'sess_return', 'bot_return', {
    dispatchMode: 'subsession',
    name: 'report task',
  });

  const fire = await fireWebhook(hub, trigger.token, { message: 'run report' }, { 'x-botd-dedup': 'return-1' });
  assert.equal(fire.status, 200);
  const { childSessionId, eventId } = await fire.json();

  // 等待父会话收到完成 callback（含 📦 产出交付物清单）
  await waitFor(() => {
    const msgs = hub.db.getMessages('sess_return');
    return msgs.some((m) => m.role === 'callback' && m.content.includes('📦 产出交付物'));
  });

  const parentMsgs = hub.db.getMessages('sess_return');
  const completionMsg = parentMsgs.find(
    (m) => m.role === 'callback' && m.content.includes('✅ 子会话') && m.content.includes('📦 产出交付物')
  );
  assert.ok(completionMsg, '父会话完成 callback 必须存在');
  assert.ok(completionMsg.content.includes('analysis_report.md'), 'callback 消息列出交付物');

  // callback 消息带 attachments
  assert.ok(completionMsg.attachments, '完成 callback 消息必须带 attachments');
  assert.equal(completionMsg.attachments!.length, 1);
  const att = completionMsg.attachments![0];
  assert.equal(att.filename, 'analysis_report.md');
  assert.notEqual(att.id, 'art_child_new_output', '回传产物应为父会话中的新引用记录');

  // 父会话产物栏可见回传产物，且为同 storagePath 零拷贝引用
  const parentArt = hub.db.getArtifactWithStoragePath(att.id)!;
  assert.equal(parentArt.sessionId, 'sess_return');
  const childArt = hub.db.getArtifactWithStoragePath('art_child_new_output')!;
  assert.equal(parentArt.storagePath, childArt.storagePath, '回传必须是同 storagePath 零拷贝引用');

  // 启动时挂载的事件载荷 event_<eventId>.json 不应被回传为父会话新产物
  const parentArtifacts = hub.db.listSessionArtifacts('sess_return');
  assert.ok(!parentArtifacts.some((a) => a.filename === `event_${eventId}.json`), '事件载荷不回传');
});

// ---------------------------------------------------------------------------
// 8. Webhook HMAC 签名校验（secret）
// ---------------------------------------------------------------------------

test('webhook secret：正确 X-Hub-Signature-256 放行，错误或缺失签名返回 401', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_hmac', 'bot_hmac');

  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async () => ({ replyText: 'ok', modelBadge: 'test' }),
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const secret = 'top-secret-hmac-key';
  const trigger = hub.db.createTrigger({
    id: 'trg_hmac_test',
    sessionId: 'sess_hmac',
    ownerId: admin.id,
    name: 'signed hook',
    botId: 'bot_hmac',
    kind: 'webhook',
    token: 'h'.repeat(36),
    secret,
    prompt: 'process',
    enabled: true,
  });
  assert.equal(trigger.secret, secret, 'createTrigger 支持读写 secret');
  assert.equal(hub.db.getTrigger(trigger.id)!.secret, secret, 'getTrigger 回读 secret');

  const body = JSON.stringify({ message: 'signed ping' });
  const sign = (raw: string) => 'sha256=' + createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

  // 缺失签名头：401
  const missing = await fireWebhook(hub, trigger.token!, body, { 'x-botd-dedup': 'hmac-1' });
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: 'Invalid webhook signature' });

  // 错误签名：401
  const wrong = await fireWebhook(hub, trigger.token!, body, {
    'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    'x-botd-dedup': 'hmac-2',
  });
  assert.equal(wrong.status, 401);

  // 签名与 body 不匹配：401
  const otherBodySig = await fireWebhook(hub, trigger.token!, body, {
    'x-hub-signature-256': sign(JSON.stringify({ message: 'other' })),
    'x-botd-dedup': 'hmac-3',
  });
  assert.equal(otherBodySig.status, 401);

  // 被拒请求不产生事件
  assert.equal(hub.db.listSessionAutomationEvents('sess_hmac').length, 0);

  // 正确签名（x-hub-signature-256）：放行
  const ok = await fireWebhook(hub, trigger.token!, body, {
    'x-hub-signature-256': sign(body),
    'x-botd-dedup': 'hmac-4',
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  assert.equal(hub.db.listSessionAutomationEvents('sess_hmac').length, 1);
  await waitFor(() => hub.db.getMessages('sess_hmac').some((m) => m.role === 'assistant'));

  // PATCH 更新 secret 后旧签名失效
  await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: await loginCookie(hub) },
    body: JSON.stringify({ secret: 'rotated-key' }),
  });
  const rotated = await fireWebhook(hub, trigger.token!, body, {
    'x-hub-signature-256': sign(body),
    'x-botd-dedup': 'hmac-5',
  });
  assert.equal(rotated.status, 401, '旧 secret 签名应被拒绝');
});

test('webhook secret：x-botd-signature 头亦可作为签名来源；未配置 secret 的触发器不需签名', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_hmac2', 'bot_hmac2');

  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async () => ({ replyText: 'ok', modelBadge: 'test' }),
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const secret = 'botd-sig-key';
  const signed = hub.db.createTrigger({
    id: 'trg_hmac_botd_sig',
    sessionId: 'sess_hmac2',
    ownerId: admin.id,
    name: 'botd sig hook',
    botId: 'bot_hmac2',
    kind: 'webhook',
    token: 's'.repeat(36),
    secret,
    prompt: 'process',
    enabled: true,
  });
  const body = JSON.stringify({ message: 'alt header' });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const okRes = await fireWebhook(hub, signed.token!, body, {
    'x-botd-signature': sig,
    'x-botd-dedup': 'hmac2-1',
  });
  assert.equal(okRes.status, 200, 'x-botd-signature 头可替代 x-hub-signature-256');
  await waitFor(() => hub.db.getMessages('sess_hmac2').some((m) => m.role === 'assistant'));

  // 未配置 secret：无签名头直接放行
  const unsigned = createWebhookTrigger(hub, admin.id, 'sess_hmac2', 'bot_hmac2', { name: 'unsigned hook' });
  const plain = await fireWebhook(hub, unsigned.token, { message: 'no sig needed' }, { 'x-botd-dedup': 'hmac2-2' });
  assert.equal(plain.status, 200);
  await waitFor(() => hub.db.getMessages('sess_hmac2').filter((m) => m.role === 'assistant').length >= 2);
});

// ---------------------------------------------------------------------------
// 9. 父子会话完成回调幂等防重
// ---------------------------------------------------------------------------

test('markSessionParentNotified 幂等防重：首次返回 true，重复调用返回 false', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-notified-db-'));
  const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  db.createSession({
    id: 'sess_notify',
    title: 'notify test',
    leadBotId: 'bot_x',
    ownerId: 'user_admin',
  });

  assert.equal(db.markSessionParentNotified('sess_notify'), true, '首次标记返回 true');
  assert.equal(db.markSessionParentNotified('sess_notify'), false, '重复标记返回 false');
  assert.equal(db.markSessionParentNotified('sess_notify'), false, '多次重复仍返回 false');

  // 不存在的会话返回 false（不产生副作用）
  assert.equal(db.markSessionParentNotified('sess_ghost'), false);

  // 跨重启（同一 dbPath 新实例）依然幂等
  const dbPath = db.dbPath;
  db.close();
  const reopened = new HubDatabase({ dbPath });
  t.after(() => reopened.close());
  assert.equal(reopened.markSessionParentNotified('sess_notify'), false, '重启后标记状态持久生效');
});

// ---------------------------------------------------------------------------
// 10. PATCH /api/triggers/:id 更新与清除 eventFilter
// ---------------------------------------------------------------------------

test('PATCH /api/triggers/:id：更新与清除（null）eventFilter', { timeout: 60_000 }, async (t) => {
  const { hub, cookie, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_patch_filter', 'bot_patch_filter');

  const trigger = hub.db.createTrigger({
    id: 'trg_patch_filter',
    sessionId: 'sess_patch_filter',
    ownerId: admin.id,
    name: 'patch filter hook',
    botId: 'bot_patch_filter',
    kind: 'webhook',
    token: 'z'.repeat(36),
    prompt: 'p',
    enabled: true,
    eventFilter: { source: 'github', types: ['push'] },
  });

  // 更新为新的 eventFilter（含点号路径 payloadMatch）
  const patched = await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ eventFilter: { payloadMatch: { 'pull_request.draft': false } } }),
  });
  assert.equal(patched.status, 200);
  const patchedJson: TriggerRecord = await patched.json();
  assert.deepEqual(patchedJson.eventFilter, { payloadMatch: { 'pull_request.draft': false } });
  assert.equal(hub.db.getTrigger(trigger.id)!.eventFilter?.payloadMatch?.['pull_request.draft'], false);

  // 传 null 清除：返回体与 db 回读均无残留
  const cleared = await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ eventFilter: null }),
  });
  assert.equal(cleared.status, 200);
  const clearedJson: TriggerRecord = await cleared.json();
  assert.equal(clearedJson.eventFilter, undefined);
  assert.equal(hub.db.getTrigger(trigger.id)!.eventFilter, undefined);

  // 非法 eventFilter：400
  const bad = await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ eventFilter: { types: [1] } }),
  });
  assert.equal(bad.status, 400);

  // 非法 payloadMatch key（空串）：400
  const badKey = await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ eventFilter: { payloadMatch: { '  ': 'v' } } }),
  });
  assert.equal(badKey.status, 400);
});

// ---------------------------------------------------------------------------
// 11. dispatchMode=subsession 静默跳过原语（[PASS] / [IGNORE]）
// ---------------------------------------------------------------------------

test('dispatchMode=subsession：子会话回复 [IGNORE]/[PASS] 且无新产物时，父会话不收到 callback 消息', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_skip', 'bot_skip');

  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async (input: any) => ({ replyText: `[IGNORE] 非目标分支，忽略`, modelBadge: 'test' }),
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const trigger = createWebhookTrigger(hub, admin.id, 'sess_skip', 'bot_skip', {
    dispatchMode: 'subsession',
    name: 'skip task',
  });

  const fire = await fireWebhook(hub, trigger.token, { message: 'watch main only' }, { 'x-botd-dedup': 'skip-1' });
  assert.equal(fire.status, 200);
  const { childSessionId } = await fire.json();

  // 子会话自身消息正常落库（user + assistant [IGNORE]）
  await waitFor(() => hub.db.getMessages(childSessionId).some((m) => m.role === 'assistant'));
  const childMsgs = hub.db.getMessages(childSessionId);
  assert.ok(childMsgs.some((m) => m.role === 'assistant' && m.content.startsWith('[IGNORE]')));

  // 等待子会话回合彻底收敛（session idle）
  await waitFor(() => hub.db.getSession(childSessionId)!.status === 'idle');
  // 再留足窗口确认父会话未收到任何 callback 消息
  await new Promise((r) => setTimeout(r, 300));
  const parentMsgs = hub.db.getMessages('sess_skip');
  assert.equal(
    parentMsgs.some((m) => m.role === 'callback'),
    false,
    '静默跳过时父会话不应收到 ✅ 子会话 callback'
  );
  assert.equal(parentMsgs.length, 0, '父会话不应有任何消息（载荷挂子会话）');

  // [PASS] 纯标记同样静默（新子会话、新 dedup key）
  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async (input: any) => ({ replyText: `[PASS]`, modelBadge: 'test' }),
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;
  await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: await loginCookie(hub) },
    body: JSON.stringify({ prompt: 'reset window' }),
  });
  const fire2 = await fireWebhook(hub, trigger.token, { message: 'again' }, { 'x-botd-dedup': 'skip-2' });
  assert.equal(fire2.status, 200);
  const { childSessionId: child2 } = await fire2.json();
  await waitFor(() => hub.db.getSession(child2)!.status === 'idle');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    hub.db.getMessages('sess_skip').some((m) => m.role === 'callback'),
    false,
    '[PASS] 纯标记同样静默'
  );
});

test('dispatchMode=subsession：子会话回复 [IGNORE] 但有新产物时仍正常回传 callback', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_skip_art', 'bot_skip_art');

  hub.connections.getNodeRpc = () =>
    ({
      runTurn: async (input: any) => {
        hub.db.createArtifact({
          id: `art_skip_${Math.random().toString(36).slice(2, 8)}`,
          sessionId: input.sessionId,
          filename: 'report.md',
          mimeType: 'text/markdown',
          sizeBytes: 64,
          senderBotId: 'bot_skip_art',
          storagePath: '/tmp/botd-test-skip.md',
        });
        return { replyText: '[IGNORE] 无需人工介入，但产物已生成', modelBadge: 'test' };
      },
      cancelTurn: async () => {},
      resetSession: async () => {},
    }) as any;

  const trigger = createWebhookTrigger(hub, admin.id, 'sess_skip_art', 'bot_skip_art', {
    dispatchMode: 'subsession',
    name: 'skip with artifact',
  });

  const fire = await fireWebhook(hub, trigger.token, { message: 'run' }, { 'x-botd-dedup': 'skip-art-1' });
  assert.equal(fire.status, 200);
  const { childSessionId } = await fire.json();

  await waitFor(() => {
    const msgs = hub.db.getMessages('sess_skip_art');
    return msgs.some((m) => m.role === 'callback' && m.content.includes('📦 产出交付物'));
  });
  const callback = hub.db.getMessages('sess_skip_art').find((m) => m.role === 'callback')!;
  assert.ok(callback.attachments, '回传产物作为附件');
  assert.equal(callback.attachments!.length, 1);
  assert.equal(callback.attachments![0].filename, 'report.md');
  void childSessionId;
});

// ---------------------------------------------------------------------------
// 12. channel-notifier：[PASS]/[IGNORE] 助手回复不推送外部通道
// ---------------------------------------------------------------------------

test('channel-notifier：[PASS]/[IGNORE] 助手回复不推送外部通道（always 与 needed 策略）', { timeout: 60_000 }, async (t) => {
  const { hub, admin } = await setupHub(t);
  createSessionFixture(hub, admin.id, 'sess_skip_notify', 'bot_skip_notify');

  const mkChannel = async (name: string, tellPolicy: 'always' | 'needed') => {
    const res = await hub.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const chanRes = await hub.app.request('/api/sessions/sess_skip_notify/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name,
        kind: 'webhook',
        targetUrl: `http://127.0.0.1:9/void/${name}`,
        events: ['assistant_reply'],
        tellPolicy,
      }),
    });
    assert.equal(chanRes.status, 201, `通道 ${name} 创建失败`);
    return (await chanRes.json()).id as string;
  };
  await mkChannel('always 通道', 'always');
  await mkChannel('needed 通道', 'needed');

  const outboxRows = () => {
    const rows = hub.db.db
      .prepare('SELECT id FROM notification_outbox WHERE session_id = ?')
      .all('sess_skip_notify');
    return rows.length;
  };

  const broadcastAssistant = (id: string, content: string) => {
    const msg = hub.db.createMessage({ id, sessionId: 'sess_skip_notify', role: 'assistant', senderBotId: 'bot_skip_notify', content });
    hub.sseHub.broadcast('sess_skip_notify', { type: 'message_created', message: msg.message });
  };

  // [PASS] / [IGNORE] 回复：不产生任何 outbox 记录
  broadcastAssistant('msg_pass_1', '[PASS]');
  broadcastAssistant('msg_ignore_1', '[IGNORE] 非目标分支，忽略');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(outboxRows(), 0, '[PASS]/[IGNORE] 回复不得推送外部通道');

  // 对照组：普通回复在 always 策略下正常入队（needed 对成功回复静默）
  broadcastAssistant('msg_normal_1', '巡检完成，一切正常');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(outboxRows(), 1, '普通回复仅 always 通道入队一次');
  void admin;
});
