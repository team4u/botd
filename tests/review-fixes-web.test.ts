import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { SessionRecord, BotConfig } from '../packages/protocol/src/index.js';

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

test('2. pickCurrentDirectSession: 严格排除 parentSessionId 子会话与归档会话', async () => {
  const sidebarModule = (await import('../apps/web/src/session-space.js' as any)) as {
    pickCurrentDirectSession: (sessions: SessionRecord[], botId: string) => SessionRecord | undefined;
  };
  const { pickCurrentDirectSession } = sidebarModule;

  const now = Date.now();
  const mainSession: SessionRecord = {
    id: 'sess_main',
    title: 'Bot 1 主会话',
    status: 'idle',
    leadBotId: 'bot_1',
    archived: false,
    createdAt: new Date(now - 120_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  };

  const childSession: SessionRecord = {
    id: 'sess_child',
    title: '[子任务] 委派计算',
    status: 'idle',
    leadBotId: 'bot_1',
    parentSessionId: 'sess_parent_group',
    archived: false,
    createdAt: new Date(now - 10_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  const archivedSession: SessionRecord = {
    id: 'sess_archived',
    title: '已归档会话',
    status: 'idle',
    leadBotId: 'bot_1',
    archived: true,
    createdAt: new Date(now - 5_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  const otherSession: SessionRecord = {
    id: 'sess_other',
    title: '其他会话',
    status: 'idle',
    leadBotId: 'bot_2',
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
    status: 'idle',
    leadBotId: 'bot_1',
    archived: false,
    createdAt: new Date(now - 30_000).toISOString(),
    updatedAt: new Date(now - 10_000).toISOString(),
  };
  const pickedNewer = pickCurrentDirectSession([mainSession, newerMain], 'bot_1');
  assert.equal(pickedNewer?.id, 'sess_main_newer', '应选取 updatedAt 最新的非归档主单聊');
});



// ==========================================
// 三维合一重构：个人助理聚合 / 活跃雷达 / 顶栏 Tab 分组（纯函数）
// ==========================================

const mkSession = (over: Partial<SessionRecord> & { id: string; leadBotId: string }): SessionRecord => ({
  title: `会话 ${over.id}`,
  status: 'idle',
  archived: false,
  createdAt: new Date(Date.now() - 300_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  ...over,
} as SessionRecord);

const mkBot = (over: Partial<BotConfig> & { id: string; name: string }): BotConfig => ({
  nodeId: 'node_1',
  description: '',
  modelProvider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  enabledSkills: [],
  updatedAt: new Date(Date.now() - 600_000).toISOString(),
  ...over,
} as unknown as BotConfig);

test('buildAssistantEntries: 每个主分身聚合为 1 条记录，汇总未读/最高注意力/directSessions', async () => {
  const { buildAssistantEntries } = (await import('../apps/web/src/session-space.js' as any)) as {
    buildAssistantEntries: typeof import('../apps/web/src/session-space.js').buildAssistantEntries;
  };

  const botA = mkBot({ id: 'bot_a', name: '助理 A' });
  const botB = mkBot({ id: 'bot_b', name: '助理 B' });
  const subA = mkBot({ id: 'sub_a', name: '子代理', parentBotId: 'bot_a' });

  const aDirect1 = mkSession({ id: 'a1', leadBotId: 'bot_a', updatedAt: new Date(Date.now() - 100_000).toISOString() });
  const aDirect2 = mkSession({ id: 'a2', leadBotId: 'bot_a', updatedAt: new Date(Date.now() - 10_000).toISOString() });
  const aInSpace = mkSession({ id: 'a_sp', leadBotId: 'bot_a', workspaceDir: '/root/code/proj' });
  const bDirect = mkSession({ id: 'b1', leadBotId: 'bot_b', status: 'running' });
  const archived = mkSession({ id: 'a_old', leadBotId: 'bot_a', archived: true });
  const child = mkSession({ id: 'a_child', leadBotId: 'bot_a', parentSessionId: 'a1' });

  const entries = buildAssistantEntries(
    [aDirect1, aDirect2, aInSpace, bDirect, archived, child],
    [botA, botB, subA],
    { a1: 3, a_sp: 2 }
  );

  assert.equal(entries.length, 2, '仅主分身各占一条（子代理不单独成行）');
  const entryA = entries.find((e) => e.bot.id === 'bot_a');
  assert.ok(entryA, 'bot_a 应有聚合条目');
  // currentSession 取 updatedAt 最新（a2），且 directSessions 只含未绑定 Space 的主会话
  assert.equal(entryA!.currentSession?.id, 'a2');
  assert.deepEqual(
    entryA!.directSessions.map((s) => s.id).sort(),
    ['a1', 'a2'],
    'directSessions 不含 Space 内会话/归档/子会话'
  );
  assert.deepEqual(
    entryA!.allActiveSessions.map((s) => s.id).sort(),
    ['a1', 'a2', 'a_sp'],
    'allActiveSessions 含 Space 内会话'
  );
  assert.equal(entryA!.unreadCount, 5, '未读数 = a1(3) + a_sp(2) 汇总');
  assert.equal(entryA!.subagentCount, 1, '子代理计数');
  // 注意力聚合：直接会话均 idle，但未读>0 → done_unseen
  assert.equal(entryA!.topAttention, 'done_unseen');

  const entryB = entries.find((e) => e.bot.id === 'bot_b');
  assert.ok(entryB);
  assert.equal(entryB!.topAttention, 'working', 'running 会话 → working');
  assert.equal(entryB!.directSessions.length, 1);
});

test('buildActivePulseEntries: 仅含非 idle 未归档会话，支持 priority 与 grouped 排序', async () => {
  const { buildActivePulseEntries } = (await import('../apps/web/src/session-space.js' as any)) as {
    buildActivePulseEntries: typeof import('../apps/web/src/session-space.js').buildActivePulseEntries;
  };

  const botDev = mkBot({ id: 'bot_dev', name: 'Dev Bot', workspaceDir: '/root/code/botd' });
  const botLife = mkBot({ id: 'bot_life', name: 'Life Bot' });

  const failed = mkSession({ id: 's_failed', leadBotId: 'bot_life', status: 'failed' });
  const working = mkSession({ id: 's_working', leadBotId: 'bot_dev', status: 'running' });
  const unseen = mkSession({ id: 's_unseen', leadBotId: 'bot_life' });
  const idle = mkSession({ id: 's_idle', leadBotId: 'bot_dev' });
  const archivedWorking = mkSession({ id: 's_arch', leadBotId: 'bot_dev', status: 'running', archived: true });
  const childTask = mkSession({ id: 's_child', leadBotId: 'bot_dev', status: 'running', parentSessionId: 's_working' });

  const sessions = [failed, working, unseen, idle, archivedWorking, childTask];
  const bots = [botDev, botLife];
  const unread = { s_unseen: 2, s_child: 1 };

  const pulse = buildActivePulseEntries(sessions, bots, unread, 'priority');
  assert.deepEqual(
    pulse.map((p) => p.session.id),
    ['s_failed', 's_unseen', 's_working', 's_child'],
    '仅非 idle 未归档会话入雷达（含子任务），按 failed > done_unseen > working 排序'
  );

  // 容器标签：Space 会话取 Space 名，非 Space 会话取分身名
  const byId = new Map(pulse.map((p) => [p.session.id, p]));
  assert.equal(byId.get('s_working')!.containerLabel, 'botd');
  assert.equal(byId.get('s_working')!.spacePath, '/root/code/botd');
  assert.equal(byId.get('s_failed')!.containerLabel, 'Life Bot');
  assert.equal(byId.get('s_child')!.isChild, true);
  assert.equal(byId.get('s_failed')!.unread, 0);
  assert.equal(byId.get('s_unseen')!.unread, 2);

  // grouped：先按容器分组（botd < Life Bot），组内按优先级
  const grouped = buildActivePulseEntries(sessions, bots, unread, 'grouped');
  assert.deepEqual(
    grouped.map((p) => `${p.containerLabel}/${p.session.id}`),
    ['botd/s_working', 'botd/s_child', 'Life Bot/s_failed', 'Life Bot/s_unseen'],
    'grouped 模式先按容器分组，组内按优先级降序'
  );
});

test('resolveContextTabGroup: Space 会话与 Assistant 会话分别聚合平级未归档主会话 Tabs', async () => {
  const { resolveContextTabGroup } = (await import('../apps/web/src/session-space.js' as any)) as {
    resolveContextTabGroup: typeof import('../apps/web/src/session-space.js').resolveContextTabGroup;
  };

  const botDev = mkBot({ id: 'bot_dev', name: 'Dev Bot' });
  const botLife = mkBot({ id: 'bot_life', name: 'Life Bot' });
  const bots = [botDev, botLife];

  const now = Date.now();
  const sp1 = mkSession({
    id: 'sp1', leadBotId: 'bot_dev', workspaceDir: '/root/code/botd',
    createdAt: new Date(now - 90_000).toISOString(),
  });
  const sp2 = mkSession({
    id: 'sp2', leadBotId: 'bot_dev', workspaceDir: '/root/code/botd/',
    createdAt: new Date(now - 50_000).toISOString(),
  });
  const spOther = mkSession({ id: 'sp3', leadBotId: 'bot_dev', workspaceDir: '/root/code/other' });
  const spArchived = mkSession({
    id: 'sp4', leadBotId: 'bot_dev', workspaceDir: '/root/code/botd', archived: true,
  });
  const spChild = mkSession({
    id: 'sp5', leadBotId: 'bot_dev', workspaceDir: '/root/code/botd', parentSessionId: 'sp1',
  });

  const spaceGroup = resolveContextTabGroup(sp2, [sp2, sp1, spOther, spArchived, spChild], bots);
  assert.ok(spaceGroup, 'Space 会话应返回分组');
  assert.equal(spaceGroup!.kind, 'space');
  assert.equal(spaceGroup!.key, '/root/code/botd');
  assert.equal(spaceGroup!.label, 'botd');
  assert.equal(spaceGroup!.spacePath, '/root/code/botd');
  assert.deepEqual(
    spaceGroup!.tabs.map((t) => t.id),
    ['sp1', 'sp2'],
    'Tabs 为同 Space 未归档主会话，按 createdAt 升序；尾部斜杠已规范化，不含其他 Space/归档/子会话'
  );

  // Assistant 分支：无 workspaceDir 会话聚合同主控的未绑定 Space 主会话
  const life1 = mkSession({ id: 'l1', leadBotId: 'bot_life', createdAt: new Date(now - 80_000).toISOString() });
  const life2 = mkSession({ id: 'l2', leadBotId: 'bot_life', createdAt: new Date(now - 40_000).toISOString() });
  const lifeInSpace = mkSession({ id: 'l3', leadBotId: 'bot_life', workspaceDir: '/root/code/x' });
  const devDirect = mkSession({ id: 'd1', leadBotId: 'bot_dev' });

  const assistantGroup = resolveContextTabGroup(life2, [life1, life2, lifeInSpace, devDirect], bots);
  assert.ok(assistantGroup);
  assert.equal(assistantGroup!.kind, 'assistant');
  assert.equal(assistantGroup!.key, 'bot_life');
  assert.equal(assistantGroup!.label, 'Life Bot');
  assert.equal(assistantGroup!.spacePath, null);
  assert.deepEqual(
    assistantGroup!.tabs.map((t) => t.id),
    ['l1', 'l2'],
    'Assistant Tabs 只含同主控且未绑定 Space 的未归档主会话，createdAt 升序'
  );

  assert.equal(resolveContextTabGroup(null, [], bots), null, '无活跃会话返回 null');
});

// ==========================================
// 3. 回调通知卡：语义化标题 + 长回执默认折叠
// ==========================================

test('deriveCallbackTitle: 按正文语义推导回调卡标题', async () => {
  const { deriveCallbackTitle } = (await import('../apps/web/src/message-format.js' as any)) as {
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
  const { splitCallbackReceipt } = (await import('../apps/web/src/message-format.js' as any)) as {
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
