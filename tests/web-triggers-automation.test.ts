import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.resolve('../apps/web/package.json'));
const React = req('react');
const ReactDOMServer = req('react-dom/server');

import { api, ApiError } from '../apps/web/src/api.js';
import type {
  AutomationEventRecord,
  NotificationOutboxRecord,
  TriggerRecord,
  CreateTriggerInput,
  NotificationChannelRecord,
} from '../packages/protocol/src/index.js';

// Dynamically import TriggersModal so tsc in tsconfig.tests.json does not traverse into sibling web components
const { TriggersModal } = await import('../apps/web/src/components/TriggersModal.js' as any);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 1. api.ts: 新增自动化事件收件箱与通知投递队列 API 回归测试
// ============================================================

test('api.listAutomationEvents: issues GET to /api/sessions/:id/automation-events with default limit 50', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;

  const mockEvents: AutomationEventRecord[] = [
    {
      id: 'evt_1',
      triggerId: 'trg_1',
      sessionId: 'sess_1',
      childSessionId: 'sess_child_1',
      source: 'github',
      eventType: 'pull_request.opened',
      summary: 'PR #42 opened by alice',
      createdAt: new Date().toISOString(),
    },
  ];

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return new Response(JSON.stringify(mockEvents), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const res = await api.listAutomationEvents('sess_1');
    assert.equal(requestedUrl, '/api/sessions/sess_1/automation-events?limit=50');
    assert.equal(requestedOptions?.credentials, 'include');
    assert.deepEqual(res, mockEvents);

    // Verify custom limit and URI encoding
    await api.listAutomationEvents('sess/with:special@id', 10);
    assert.equal(requestedUrl, '/api/sessions/sess%2Fwith%3Aspecial%40id/automation-events?limit=10');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.listAutomationEvents: throws ApiError on non-200 responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      async () => {
        await api.listAutomationEvents('sess_other');
      },
      (err: any) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.message, 'Forbidden');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.listNotificationOutbox: issues GET to /api/sessions/:id/outbox', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;

  const mockOutbox: NotificationOutboxRecord[] = [
    {
      id: 'out_1',
      channelId: 'ch_1',
      sessionId: 'sess_1',
      eventKind: 'assistant_reply',
      status: 'sent',
      attemptCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return new Response(JSON.stringify(mockOutbox), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const res = await api.listNotificationOutbox('sess_1');
    assert.equal(requestedUrl, '/api/sessions/sess_1/outbox');
    assert.equal(requestedOptions?.credentials, 'include');
    assert.deepEqual(res, mockOutbox);

    // Verify URI encoding
    await api.listNotificationOutbox('sess/with:special@id');
    assert.equal(requestedUrl, '/api/sessions/sess%2Fwith%3Aspecial%40id/outbox');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================
// 2. api.ts: createSessionTrigger / updateTrigger / createSessionChannel
//    新参数（dispatchMode / skillId / eventFilter / tellPolicy）透传测试
// ============================================================

test('api.createSessionTrigger: passes dispatchMode, skillId and eventFilter in POST body', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedMethod = '';
  let requestedBody: any;

  const mockTrigger: TriggerRecord = {
    id: 'trg_new',
    sessionId: 'sess_1',
    name: 'PR Review',
    botId: 'bot-1',
    kind: 'webhook',
    token: 'tok_abc',
    prompt: '审查这个 PR',
    enabled: true,
    dispatchMode: 'subsession',
    skillId: 'github-pr-review',
    eventFilter: { types: ['pull_request.opened'] },
    createdAt: new Date().toISOString(),
  };

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedUrl = String(url);
    requestedMethod = options?.method || 'GET';
    requestedBody = options?.body ? JSON.parse(String(options.body)) : null;
    return new Response(JSON.stringify(mockTrigger), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const input: CreateTriggerInput = {
      name: 'PR Review',
      botId: 'bot-1',
      kind: 'webhook',
      prompt: '审查这个 PR',
      enabled: true,
      dispatchMode: 'subsession',
      skillId: 'github-pr-review',
      eventFilter: { types: ['pull_request.opened', 'pull_request.synchronize'] },
    };
    const res = await api.createSessionTrigger('sess_1', input);
    assert.equal(requestedUrl, '/api/sessions/sess_1/triggers');
    assert.equal(requestedMethod, 'POST');
    assert.equal(requestedBody.dispatchMode, 'subsession');
    assert.equal(requestedBody.skillId, 'github-pr-review');
    assert.deepEqual(requestedBody.eventFilter, {
      types: ['pull_request.opened', 'pull_request.synchronize'],
    });
    assert.deepEqual(res, mockTrigger);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.updateTrigger: passes dispatchMode, skillId and eventFilter in PATCH body', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedMethod = '';
  let requestedBody: any;

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedUrl = String(url);
    requestedMethod = options?.method || 'GET';
    requestedBody = options?.body ? JSON.parse(String(options.body)) : null;
    return new Response(
      JSON.stringify({ id: 'trg_1', dispatchMode: 'subsession', skillId: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    await api.updateTrigger('trg_1', {
      dispatchMode: 'append',
      skillId: null,
      eventFilter: null,
    });
    assert.equal(requestedUrl, '/api/triggers/trg_1');
    assert.equal(requestedMethod, 'PATCH');
    assert.equal(requestedBody.dispatchMode, 'append');
    assert.equal(requestedBody.skillId, null);
    assert.equal(requestedBody.eventFilter, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.createSessionChannel: passes tellPolicy in POST body', async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody: any;

  const mockChannel: NotificationChannelRecord = {
    id: 'ch_new',
    sessionId: 'sess_1',
    name: '团队飞书群',
    kind: 'feishu',
    targetUrl: 'https://example.com/hook',
    events: ['assistant_reply'],
    tellPolicy: 'needed',
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedBody = options?.body ? JSON.parse(String(options.body)) : null;
    return new Response(JSON.stringify(mockChannel), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const res = await api.createSessionChannel('sess_1', {
      name: '团队飞书群',
      kind: 'feishu',
      targetUrl: 'https://example.com/hook',
      events: ['assistant_reply'],
      tellPolicy: 'needed',
      enabled: true,
    });
    assert.equal(requestedBody.tellPolicy, 'needed');
    assert.deepEqual(res, mockChannel);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.updateChannel: passes tellPolicy in PATCH body', async () => {
  const originalFetch = globalThis.fetch;
  let requestedMethod = '';
  let requestedBody: any;

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedMethod = options?.method || 'GET';
    requestedBody = options?.body ? JSON.parse(String(options.body)) : null;
    return new Response(JSON.stringify({ id: 'ch_1', tellPolicy: 'never' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.updateChannel('ch_1', { tellPolicy: 'never' });
    assert.equal(requestedMethod, 'PATCH');
    assert.equal(requestedBody.tellPolicy, 'never');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================
// 3. TriggersModal.tsx: 源码级回归 —— 新增表单字段、徽章与区块
// ============================================================

const componentPath = path.resolve(__dirname, '../apps/web/src/components/TriggersModal.tsx');

test('TriggersModal source: imports new protocol types and renders dispatchMode selector', () => {
  const source = readFileSync(componentPath, 'utf8');

  // 类型引入
  for (const t of [
    'TriggerDispatchMode',
    'TriggerEventFilter',
    'NotificationTellPolicy',
    'AutomationEventRecord',
    'NotificationOutboxRecord',
  ]) {
    assert(source.includes(t), `TriggersModal.tsx must reference ${t}`);
  }

  // API 方法
  assert(source.includes('api.listAutomationEvents'), 'must call api.listAutomationEvents');
  assert(source.includes('api.listNotificationOutbox'), 'must call api.listNotificationOutbox');

  // 执行方式下拉选项文案
  assert(
    source.includes('派生独立子会话（推荐，隔离每次运行）'),
    'dispatchMode subsession option label'
  );
  assert(source.includes('追加到当前会话'), 'dispatchMode append option label');

  // 绑定技能输入框
  assert(
    source.includes('可选，如 github-pr-review'),
    'skillId input placeholder'
  );

  // 事件类型过滤
  assert(
    source.includes('pull_request.opened, pull_request.synchronize'),
    'event types filter placeholder'
  );
  assert(
    /\{ types: parsedTypes \}/.test(source),
    'save must assemble eventFilter: { types: [...] }'
  );

  // 触发器徽章
  assert(source.includes('派生子会话'), 'subsession badge text');
  assert(
    source.includes('/skill:{trigger.skillId}'),
    'skill badge renders /skill:<id>'
  );

  // 事件收件箱区块
  assert(source.includes('事件收件箱 (Event Inbox)'), 'Event Inbox section header');
  assert(
    source.includes('`#?s=${ev.childSessionId}`'),
    'child session link uses #?s=<id>'
  );
});

test('TriggersModal source: tell policy options, badge and outbox section', () => {
  const source = readFileSync(componentPath, 'utf8');

  // 通知打扰策略文案
  assert(source.includes('按需打扰'), 'tellPolicy needed label');
  assert(source.includes('全部推送'), 'tellPolicy always label');
  assert(source.includes('静默'), 'tellPolicy never label');

  // Outbox 状态徽章文案
  assert(source.includes('已送达'), 'outbox sent badge');
  assert(source.includes('重试中'), 'outbox pending badge');
  assert(source.includes('投递失败'), 'outbox dead badge');
  assert(
    /重试 \{rec\.attemptCount\} 次/.test(source),
    'outbox attempt count display'
  );
  assert(source.includes('rec.lastError'), 'outbox lastError display');
  assert(source.includes('最近通知投递记录 (Outbox)'), 'Outbox section header');
});

// ============================================================
// 4. TriggersModal: 初始渲染冒烟测试（inbound / outbound 两个 Tab）
// ============================================================

const mockSession: any = {
  id: 'sess_test',
  title: 'Test Session',
  leadBotId: 'bot-1',
  memberBotIds: ['bot-1'],
  mode: 'single',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockBots: any[] = [
  {
    id: 'bot-1',
    nodeId: 'node-1',
    name: 'Bot One',
    description: '',
    modelProvider: 'provider-1',
    modelId: 'model-1',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  },
];

const noop = () => {};

test('TriggersModal: renders inbound tab skeleton without crash', () => {
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TriggersModal, {
      isOpen: true,
      session: mockSession,
      memberBots: mockBots,
      onClose: noop,
      onAddToast: noop,
    })
  );
  assert(html.includes('新建触发器'), 'inbound tab has create trigger button');
  // 可折叠收件箱标题默认收起（仍渲染按钮标题）
  assert(html.includes('事件收件箱 (Event Inbox)'), 'event inbox section is present');
});

test('TriggersModal: renders outbound tab skeleton without crash', () => {
  // 组件默认渲染 inbound；outbound 通过源码断言覆盖（tab 切换依赖交互）。
  // 这里验证 outbound 相关的渲染源码与状态机已挂载即可。
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TriggersModal, {
      isOpen: true,
      session: mockSession,
      memberBots: mockBots,
      onClose: noop,
      onAddToast: noop,
    })
  );
  assert(html.includes('通知通道'), 'outbound tab button exists');
  assert(!html.includes('最近通知投递记录 (Outbox)'), 'outbox section hidden on inbound tab');
});
