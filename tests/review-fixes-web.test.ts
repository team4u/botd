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
  assert.equal(chatViewModule.pickPollIntervalMs(true), 5000, '存在 running 子任务或后台任务时应为 5000ms');
  assert.equal(chatViewModule.pickPollIntervalMs(false), 30000, '闲置无 running 任务时应降频至 30000ms');
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

  const groupSession: SessionRecord = {
    id: 'sess_group',
    title: '群聊',
    mode: 'lead',
    status: 'idle',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1', 'bot_2'],
    archived: false,
    createdAt: new Date(now - 5_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  // 即使 childSession、archivedSession、groupSession 的 updatedAt 更晚，也必须选取 mainSession
  const picked = pickCurrentDirectSession(
    [mainSession, childSession, archivedSession, groupSession],
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

test('3. GroupSettingsModal 模块加载冒烟与纯逻辑草稿测试', async () => {
  const modalModule = await import('../apps/web/src/components/GroupSettingsModal.js');
  assert.equal(typeof modalModule.initGroupSettingsDraft, 'function');
  assert.equal(typeof modalModule.resolveGroupSettingsStep, 'function');

  const session: SessionRecord = {
    id: 'sess_test',
    title: '测试群',
    mode: 'lead',
    status: 'idle',
    leadBotId: 'bot_a',
    memberBotIds: ['bot_a', 'bot_b'],
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const draft = modalModule.initGroupSettingsDraft(session, []);
  assert.equal(draft.title, '测试群');
  assert.equal(draft.leadBotId, 'bot_a');
  assert.deepEqual(draft.memberBotIds, ['bot_a', 'bot_b']);
});
