import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { SessionRecord } from '../packages/protocol/src/index.js';

// 拦截 CSS 导入（ChatView -> Markdown -> katex.min.css），避免 Node.js 原生 ESM 报 ERR_UNKNOWN_FILE_EXTENSION
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', shortCircuit: true, source: 'export default {};' };
  }
  return nextLoad(url, context);
}
`)
);

test('1. pickPollIntervalMs: 活跃任务时 5s 轮询，闲置时降频至 30s', async () => {
  const chatViewModule = (await import('../apps/web/src/components/ChatView.js' as any)) as {
    pickPollIntervalMs: (hasActiveWork: boolean) => number;
  };
  assert.equal(typeof chatViewModule.pickPollIntervalMs, 'function');
  assert.equal(chatViewModule.pickPollIntervalMs(true), 5000, '存在 running 后台进程时应为 5000ms');
  assert.equal(chatViewModule.pickPollIntervalMs(false), 30000, '闲置无运行进程时应降频至 30000ms');
});

test('2. pickCurrentDirectSession: 严格排除 parentSessionId 子会话与归档会话', async () => {
  const sidebarModule = (await import('../apps/web/src/components/Sidebar.js' as any)) as {
    pickCurrentDirectSession: (sessions: SessionRecord[], botId: string) => SessionRecord | undefined;
  };
  const { pickCurrentDirectSession } = sidebarModule;

  const now = Date.now();
  const mainSession: SessionRecord = {
    id: 'sess_main',
    title: 'Bot 1 主会话',
    mode: 'direct',
    status: 'idle',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
    archived: false,
    createdAt: new Date(now - 120_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  };

  const childSession: SessionRecord = {
    id: 'sess_child',
    title: '[子任务] 委派计算',
    mode: 'direct',
    status: 'idle',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
    parentSessionId: 'sess_parent_group',
    archived: false,
    createdAt: new Date(now - 10_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  const archivedSession: SessionRecord = {
    id: 'sess_archived',
    title: '已归档会话',
    mode: 'direct',
    status: 'idle',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
    archived: true,
    createdAt: new Date(now - 5_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  const otherSession: SessionRecord = {
    id: 'sess_other',
    title: '其他会话',
    mode: 'direct',
    status: 'idle',
    leadBotId: 'bot_2',
    memberBotIds: ['bot_2'],
    archived: false,
    createdAt: new Date(now - 5_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  // 即使 childSession、archivedSession、otherSession 的 updatedAt 更晚，也必须选取 mainSession
  const picked = pickCurrentDirectSession(
    [mainSession, childSession, archivedSession, otherSession],
    'bot_1'
  );
  assert.equal(picked?.id, 'sess_main', '子会话与归档会话不可篡位主单聊入口');

  // 若仅有 childSession，应当返回 undefined，而不是匹配成主单聊
  const pickedOnlyChild = pickCurrentDirectSession([childSession], 'bot_1');
  assert.equal(pickedOnlyChild, undefined, '仅存在子会话时不得选为主单聊');

  // 多个主单聊时取最新 updatedAt 的那一个
  const newerMain: SessionRecord = {
    id: 'sess_main_newer',
    title: 'Bot 1 新话题',
    mode: 'direct',
    status: 'idle',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
    archived: false,
    createdAt: new Date(now - 30_000).toISOString(),
    updatedAt: new Date(now - 10_000).toISOString(),
  };
  const pickedNewer = pickCurrentDirectSession([mainSession, newerMain], 'bot_1');
  assert.equal(pickedNewer?.id, 'sess_main_newer', '应选取 updatedAt 最新的非归档主单聊');
});



// ==========================================
// 3. 回调通知卡：语义化标题 + 长回执默认折叠
// ==========================================

test('deriveCallbackTitle: 按正文语义推导回调卡标题', async () => {
  const { deriveCallbackTitle } = (await import('../apps/web/src/components/MessageItem.js' as any)) as {
    deriveCallbackTitle: (content: string) => string;
  };
  assert.equal(deriveCallbackTitle('[Background Job `build`] 已退出'), '后台进程完成');
  assert.equal(deriveCallbackTitle('[Timer: 每日站会] 触发'), '自动触发通知');
  assert.equal(deriveCallbackTitle('[Webhook: ci] 触发'), '自动触发通知');
  assert.equal(deriveCallbackTitle('[手动触发: xxx]'), '自动触发通知');
  assert.equal(deriveCallbackTitle('✅ 子会话「xx」已完成：\n\n全文'), '异步子任务回执');
  assert.equal(deriveCallbackTitle('[Wake-up] 群聊被唤醒'), '系统唤醒通知');
});

test('splitCallbackReceipt: 剥离 [Wake-up] 前缀并拆分 headline / detailBody', async () => {
  const { splitCallbackReceipt } = (await import('../apps/web/src/components/MessageItem.js' as any)) as {
    splitCallbackReceipt: (content: string) => { headline: string; detailBody: string | null };
  };

  // 长回执：首行去尾冒号作 headline，其余为详情
  const long = '✅ 子会话「[调研](#?s=sess_child_1)」已完成：\n\n这是很长的\n全文回复';
  const parts = splitCallbackReceipt(long);
  assert.equal(parts.headline, '✅ 子会话「[调研](#?s=sess_child_1)」已完成');
  assert.equal(parts.detailBody, '这是很长的\n全文回复');

  // [Wake-up] 前缀剥离
  const wake = splitCallbackReceipt('[Wake-up] 定时唤醒：\n\n详情');
  assert.equal(wake.headline, '定时唤醒');

  // 单行正文无详情
  const single = splitCallbackReceipt('[Background Job `x`] 已退出（code 0）');
  assert.equal(single.headline, '[Background Job `x`] 已退出（code 0）');
  assert.equal(single.detailBody, null);
});

test('MessageItem 回调卡 SSR：语义标题 + 默认折叠长回执 + 保留查看对话链接', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.resolve('../apps/web/package.json'));
  const React = req('react');
  const ReactDOMServer = req('react-dom/server');

  const messageItemModule = (await import('../apps/web/src/components/MessageItem.js' as any)) as {
    MessageItem: React.FC<{ message: any; botMap?: Map<string, unknown>; nodeMap?: Map<string, unknown> }>;
  };

  const callbackMsg = {
    id: 'msg_cb_1',
    sessionId: 'sess_main',
    role: 'callback',
    content: '✅ 子会话「[调研](#?s=sess_child_9)」已完成：\n\n# 报告\n这里是子会话的全文回复，不应默认平铺。',
    createdAt: new Date().toISOString(),
  };

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(messageItemModule.MessageItem, { message: callbackMsg })
  );

  // 语义化标题，不再是「后台任务唤醒回调」假标题
  assert.match(html, /异步子任务回执/, '子会话回执应显示语义标题');
  assert.doesNotMatch(html, /后台任务唤醒回调/, '不得再显示统一假标题');
  // 默认折叠：headline 在、全文不在、展开按钮在
  assert.match(html, /已完成/, 'headline 行应展示');
  assert.doesNotMatch(html, /这里是子会话的全文回复/, '长回执全文不应默认平铺');
  assert.match(html, /展开回执详情/, '应提供展开详情入口');
  // 「查看对话 / 追问」链接保留
  assert.match(html, /#\?s=sess_child_9/, '应保留指向子会话的链接');
});
