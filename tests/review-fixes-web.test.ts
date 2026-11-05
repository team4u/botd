import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

test('2. pickCurrentDirectSession: 严格排除 parentSessionId 子会话与归档会话', { timeout: 60_000 }, async () => {
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

test('buildAssistantEntries: 每个主分身聚合为 1 条记录，汇总未读/最高注意力/directSessions', { timeout: 60_000 }, async () => {
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

test('buildActivePulseEntries: 仅含非 idle 未归档会话，支持 priority 与 grouped 排序', { timeout: 60_000 }, async () => {
  const { buildActivePulseEntries } = (await import('../apps/web/src/session-space.js' as any)) as {
    buildActivePulseEntries: typeof import('../apps/web/src/session-space.js').buildActivePulseEntries;
  };

  const botDev = mkBot({ id: 'bot_dev', name: 'Dev Bot', workspaceDir: '/root/code/botd' });
  const botLife = mkBot({ id: 'bot_life', name: 'Life Bot' });

  const failed = mkSession({ id: 's_failed', leadBotId: 'bot_life', status: 'failed' });
  const working = mkSession({
    id: 's_working',
    leadBotId: 'bot_dev',
    status: 'running',
    // 固定更晚的 updatedAt，保证同优先级（working）内 s_working 稳定排在 s_child 前，不受毫秒抖动影响
    updatedAt: new Date(Date.now() + 5_000).toISOString(),
  });
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

test('resolveContextTabGroup: Space 会话与 Assistant 会话分别聚合平级未归档主会话 Tabs', { timeout: 60_000 }, async () => {
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
// 中枢总管（⚡ 中枢总管）与全局后台 Worker 脉冲
// ==========================================

test('中枢总管会话：isHubAssistantSession/pickHubAssistantSession 识别且不篡位普通单聊', { timeout: 60_000 }, async () => {
  const mod = (await import('../apps/web/src/session-space.js' as any)) as {
    isHubAssistantSession: typeof import('../apps/web/src/session-space.js').isHubAssistantSession;
    pickHubAssistantSession: typeof import('../apps/web/src/session-space.js').pickHubAssistantSession;
    buildAssistantEntries: typeof import('../apps/web/src/session-space.js').buildAssistantEntries;
    pickCurrentDirectSession: typeof import('../apps/web/src/session-space.js').pickCurrentDirectSession;
    HUB_ASSISTANT_TITLE: string;
  };
  const { isHubAssistantSession, pickHubAssistantSession, buildAssistantEntries, pickCurrentDirectSession } = mod;
  assert.equal(mod.HUB_ASSISTANT_TITLE, '⚡ 中枢总管');

  const botA = mkBot({ id: 'bot_a', name: '助理 A' });
  const now = Date.now();

  // 严格匹配：标题 + 未归档 + 无父会话
  const hubSession = mkSession({
    id: 'hub_1',
    leadBotId: 'bot_a',
    title: '⚡ 中枢总管',
    updatedAt: new Date(now - 50_000).toISOString(),
  });
  const hubNewer = mkSession({
    id: 'hub_2',
    leadBotId: 'bot_a',
    title: '⚡ 中枢总管',
    updatedAt: new Date(now - 10_000).toISOString(),
  });
  const hubArchived = mkSession({
    id: 'hub_arch',
    leadBotId: 'bot_a',
    title: '⚡ 中枢总管',
    archived: true,
  });
  const hubChild = mkSession({
    id: 'hub_child',
    leadBotId: 'bot_a',
    title: '⚡ 中枢总管',
    parentSessionId: 'hub_1',
  });

  assert.ok(isHubAssistantSession(hubSession), '标题匹配且未归档无父会话 → 是中枢总管');
  assert.ok(!isHubAssistantSession(hubArchived), '已归档 → 不是');
  assert.ok(!isHubAssistantSession(hubChild), '有父会话 → 不是');
  assert.ok(
    !isHubAssistantSession(mkSession({ id: 'x1', leadBotId: 'bot_a', title: '中枢总管' })),
    '标题不精确匹配（缺 ⚡ 前缀）→ 不是'
  );

  // 多条同标题时取最近活跃
  assert.equal(pickHubAssistantSession([hubSession, hubNewer, hubArchived, hubChild])?.id, 'hub_2');
  assert.equal(pickHubAssistantSession([]), undefined, '无中枢总管时返回 undefined');

  // 不篡位普通单聊：pickCurrentDirectSession 与 buildAssistantEntries 均排除中枢总管
  const normalDirect = mkSession({
    id: 'direct_1',
    leadBotId: 'bot_a',
    title: '日常单聊',
    updatedAt: new Date(now - 200_000).toISOString(),
  });
  assert.equal(
    pickCurrentDirectSession([hubNewer, normalDirect], 'bot_a')?.id,
    'direct_1',
    '中枢总管即使更新也不得成为分身默认单聊'
  );

  const entries = buildAssistantEntries([hubNewer, normalDirect], [botA], {});
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.currentSession?.id, 'direct_1', '助理单聊预览不得被中枢总管覆盖');
  assert.deepEqual(
    entries[0]!.directSessions.map((s) => s.id),
    ['direct_1'],
    'directSessions 不含中枢总管会话'
  );
});

test('getSessionAttention/buildActivePulseEntries：后台 worker 让 idle 会话进入雷达', { timeout: 60_000 }, async () => {
  const now = Date.now();
  const mod = (await import('../apps/web/src/session-space.js' as any)) as {
    getSessionAttention: typeof import('../apps/web/src/session-space.js').getSessionAttention;
    buildActivePulseEntries: typeof import('../apps/web/src/session-space.js').buildActivePulseEntries;
    aggregateWorkerStatsBySession: typeof import('../apps/web/src/session-space.js').aggregateWorkerStatsBySession;
  };
  const { getSessionAttention, buildActivePulseEntries, aggregateWorkerStatsBySession } = mod;

  // 基础注意力不受影响（未传 workerStats 时行为不变）
  assert.equal(getSessionAttention({ status: 'failed' }, 0), 'failed');
  assert.equal(getSessionAttention({ status: 'idle' }, 3), 'done_unseen');
  assert.equal(getSessionAttention({ status: 'running' }, 0), 'working');
  assert.equal(getSessionAttention({ status: 'idle' }, 0), 'idle');

  // workerStats：失败后台 worker → failed；活跃 worker 压过 done_unseen → working
  assert.equal(getSessionAttention({ status: 'idle' }, 0, { failedCount: 1 }), 'failed');
  assert.equal(getSessionAttention({ status: 'idle' }, 5, { activeCount: 2 }), 'working');
  assert.equal(getSessionAttention({ status: 'idle' }, 5, { activeCount: 0 }), 'done_unseen');
  assert.equal(getSessionAttention({ status: 'running' }, 0, { activeCount: 0 }), 'working');

  // 聚合：pending/running/waiting 计 active，failed 计 failed，其余不计
  const stats = aggregateWorkerStatsBySession([
    { workerId: 'w1', parentSessionId: 's1', status: 'running' },
    { workerId: 'w2', parentSessionId: 's1', status: 'pending' },
    { workerId: 'w3', parentSessionId: 's1', status: 'waiting' },
    { workerId: 'w4', parentSessionId: 's1', status: 'completed' },
    { workerId: 'w5', parentSessionId: 's2', status: 'failed' },
  ] as any);
  assert.deepEqual(stats.get('s1'), { activeCount: 3, failedCount: 0 });
  assert.deepEqual(stats.get('s2'), { activeCount: 0, failedCount: 1 });

  // 雷达：前台 idle 但后台 worker 活跃/失败的会话必须出现
  const botDev = mkBot({ id: 'bot_dev', name: 'Dev Bot', workspaceDir: '/root/code/botd' });
  const botLife = mkBot({ id: 'bot_life', name: 'Life Bot' });
  const idleWithWorker = mkSession({ id: 's_bg', leadBotId: 'bot_dev', status: 'idle' });
  const idleWithFailed = mkSession({ id: 's_bgf', leadBotId: 'bot_life', status: 'idle' });
  const plainIdle = mkSession({ id: 's_quiet', leadBotId: 'bot_life', status: 'idle' });

  const globalWorkers = [
    { workerId: 'w-run', conversationId: 'c1', parentSessionId: 's_bg', botId: 'bot_dev', title: '重构 worker', status: 'running', startedAt: new Date(now - 30_000).toISOString() },
    { workerId: 'w-fail', conversationId: 'c2', parentSessionId: 's_bgf', botId: 'bot_life', title: '失败 worker', status: 'failed', startedAt: new Date(now - 30_000).toISOString() },
    { workerId: 'w-other', conversationId: 'c3', parentSessionId: 'sess_unknown', botId: 'bot_dev', title: '孤儿 worker', status: 'running', startedAt: new Date(now - 30_000).toISOString() },
  ] as any[];

  const pulse = buildActivePulseEntries(
    [idleWithWorker, idleWithFailed, plainIdle],
    [botDev, botLife],
    {},
    'priority',
    globalWorkers
  );
  const byId = new Map(pulse.map((p) => [p.session.id, p]));
  assert.equal(byId.get('s_bg')?.attention, 'working', '后台 worker 运行 → 会话 working 入雷达');
  assert.equal(byId.get('s_bgf')?.attention, 'failed', '后台 worker 失败 → 会话 failed 入雷达');
  assert.ok(!byId.has('s_quiet'), '无 worker 且 idle 的会话不入雷达');
  assert.ok(!byId.has('sess_unknown'), 'worker 不能先于会话凭空制造雷达条目');

  // 不传 globalWorkers 时保持旧行为：idle 会话不入雷达
  const legacyPulse = buildActivePulseEntries([idleWithWorker, plainIdle], [botDev, botLife], {}, 'priority');
  assert.equal(legacyPulse.length, 0, '未传 globalWorkers 时纯 idle 会话不入雷达');
});

test('Sidebar 中枢模式：⚡ 中枢总管置顶卡片与全局 Worker 舰队渲染', { timeout: 60_000 }, async () => {
  const sidebarPath = fileURLToPath(
    new URL('../apps/web/src/components/Sidebar.tsx', import.meta.url)
  );
  const source = readFileSync(sidebarPath, 'utf-8');

  // 1. 中枢总管置顶卡片：位于活跃雷达块内、标题头之前，含ⓡ图标/徽标/副标题文案
  const pulseStart = source.indexOf('===== 编程模式（下半区）/ 中枢模式（第 1 块）：活跃任务雷达');
  const pulseChildren = source.indexOf('===== 中枢模式（第 2 块）：子代理任务');
  assert.ok(pulseStart >= 0 && pulseChildren > pulseStart, '区块标记必须存在且有序');
  const pulseSection = source.slice(pulseStart, pulseChildren);
  assert.match(pulseSection, /中枢总管/, '雷达块内应渲染中枢总管卡片');
  assert.match(pulseSection, /sidebarMode === 'pulse' && \(/, '卡片仅中枢模式渲染');
  assert.match(pulseSection, /自然语言调度/, '卡片带自然语言调度徽标');
  assert.match(pulseSection, /直接对话派发跨项目后台任务/, '卡片副标题说明调度能力');
  assert.match(pulseSection, /pickHubAssistantSession|hubAssistantSession/, '卡片高亮依赖中枢总管会话定位');
  assert.match(pulseSection, /onOpenHubAssistant/, '无会话时回退创建中枢总管');
  // 空态文案保留
  assert.match(pulseSection, /所有智能体空闲待命/, '零活跃空态文案保留');

  // 2. 第 2 块：全局 Worker 舰队与子会话同区渲染，计数为二者之和
  const childrenSection = source.slice(pulseChildren, source.indexOf('===== 中枢模式（第 3 块）：已归档'));
  assert.match(childrenSection, /filteredGlobalWorkers/, '子代理任务区应渲染全局后台 Worker');
  assert.match(
    childrenSection,
    /filteredGlobalWorkers\.length \+ childSessions\.length/,
    '计数为 Worker + 子会话之和'
  );
  assert.match(source, /GlobalWorkerRow/, '应存在后台 Worker 行组件');
  assert.match(source, /worker\.worktreePath && \(/, 'Worker 行应展示 worktree 徽标');
  assert.match(source, /worktree\s+<\/span>/, 'worktree 徽标文案');
  assert.match(childrenSection, /onInspectWorker/, '点击 Worker 应支持打开巡检抽屉');
  assert.match(childrenSection, /onInspectWorker\(worker\.parentSessionId, worker\.workerId\)/, '巡检携带父会话与 workerId');

  // 3. 数据接线：globalWorkers 贯穿雷达/空间分组/注意力判定，切模式自动开总管
  assert.match(source, /buildActivePulseEntries\(sessions, bots, unreadCounts, pulseSortMode, globalWorkers\)/, '雷达接入 globalWorkers');
  assert.match(source, /buildSpaceGroups\(sessions, bots, unreadCounts, globalWorkers\)/, '空间分组接入 globalWorkers');
  assert.match(source, /aggregateWorkerStatsBySession\(globalWorkers\)/, '注意力判定接入 worker 统计');
  assert.match(source, /if \(mode === 'pulse'\) onOpenHubAssistant\?\.\(\);/, '切入中枢模式即打开中枢总管');
});

// ==========================================
// 三场景正交编排：助理（通讯录）/ 编程（Spaces+雷达）/ 中枢（脉冲+归档治理）
// ==========================================

test('Sidebar 三场景正交编排：编程模式 Spaces 在雷达上方，中枢模式零 Space/助理且有零活跃空态', { timeout: 60_000 }, async () => {
  const sidebarPath = fileURLToPath(
    new URL('../apps/web/src/components/Sidebar.tsx', import.meta.url)
  );
  const source = readFileSync(sidebarPath, 'utf-8');

  // 定位可滚动主体区内各区块的满引注释行号，断言编排顺序与归属
  const idxOf = (marker: string) => {
    const idx = source.indexOf(marker);
    assert.ok(idx >= 0, `源码应包含标记：${marker}`);
    return idx;
  };

  const assistantBlock = idxOf("===== 助理模式：纯 IM 通讯录");
  const codingSpaces = idxOf("===== 编程模式（上半区）：项目空间");
  const codingPulse = idxOf("===== 编程模式（下半区）/ 中枢模式（第 1 块）：活跃任务雷达");
  const pulseChildren = idxOf("===== 中枢模式（第 2 块）：子代理任务");
  const pulseArchived = idxOf("===== 中枢模式（第 3 块）：已归档");

  // 编程模式：项目空间（第 1 块）必须在活跃任务雷达（第 2 块）上方（Herdr 上 Spaces 下 Agents）
  assert.ok(
    codingSpaces < codingPulse,
    '编程模式「项目空间」必须置于「活跃任务雷达」上方'
  );

  // 中枢模式：活跃脉冲 -> 子代理任务 -> 已归档 依次往下
  assert.ok(codingPulse < pulseChildren, '中枢模式「子代理任务」应在「活跃雷达」下方');
  assert.ok(pulseChildren < pulseArchived, '中枢模式「已归档」应在「子代理任务」下方');

  // 正交性一：项目空间区块仅属于编程模式（sidebarMode === 'coding' 才渲染）
  const spacesSection = source.slice(codingSpaces, codingPulse);
  assert.match(spacesSection, /\{sidebarMode === 'coding' && \(/, '项目空间仅编程模式渲染');
  assert.doesNotMatch(
    spacesSection,
    /sidebarMode === 'pulse'/,
    '项目空间不得在中枢模式渲染（正交分离）'
  );

  // 正交性二：个人助理通讯录仅属于助理模式
  const assistantSection = source.slice(assistantBlock, codingSpaces);
  assert.match(assistantSection, /\{sidebarMode === 'assistant' && \(/, '个人助理仅助理模式渲染');
  assert.doesNotMatch(
    assistantSection,
    /ListChecks/,
    '助理模式不再携带批量管理按钮（已移交中枢「已归档」区块）'
  );

  // 正交性三：中枢模式零活跃时常驻空态卡片，而非隐藏整块
  const pulseSection = source.slice(codingPulse, pulseChildren);
  assert.match(pulseSection, /sidebarMode === 'pulse'/, '活跃雷达中枢模式常驻渲染');
  assert.match(pulseSection, /所有智能体空闲待命/, '中枢模式应含零活跃空态卡片');
  assert.match(
    pulseSection,
    /跨项目的运行中、待决策、待验收与异常任务会实时汇聚于此/,
    '空态卡片应说明中枢定位'
  );

  // 中枢已归档区块携带批量清理入口（ListChecks 从助理标题栏迁移至此）
  const archivedSection = source.slice(pulseArchived);
  assert.match(archivedSection, /ListChecks/, '已归档区块应提供批量勾选删除入口');
  assert.match(archivedSection, /sidebarMode === 'pulse'/, '已归档区块仅中枢模式渲染');
});

// ==========================================
// 方案 A（Linear/Raycast 浮起白卡）：项目空间树重构 + 选中态升级
// ==========================================

test('Sidebar 项目空间树：移除 ASCII 字符画，改用 CSS 垂直导轨线且新建按钮上移空间头', { timeout: 60_000 }, async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const source = await fs.readFile(
    path.join(process.cwd(), 'apps/web/src/components/Sidebar.tsx'),
    'utf-8'
  );

  // 1. treeConnector 参数与字符画彻底移除
  assert.doesNotMatch(source, /treeConnector/, '不得再存在 treeConnector 参数');
  assert.doesNotMatch(source, /└─/, '不得再渲染 └─ 字符画');
  assert.doesNotMatch(source, /├─/, '不得再渲染 ├─ 字符画');

  // 2. 子会话容器采用 border-l 垂直导轨线
  assert.match(
    source,
    /border-l border-zinc-200\/80 dark:border-zinc-800/,
    '子会话列表应使用左置 CSS 垂直导轨线（border-l）'
  );
  assert.doesNotMatch(
    source,
    /\(\{group\.sessions\.length\}\)/,
    '空间头数量展示应为 · N 而非 (N)'
  );
  assert.match(source, /· \{group\.sessions\.length\}/, '空间头数量展示应为 · N');

  // 3. 新建任务按钮位于空间头部（title/aria-label），树底不再有占行按钮
  assert.match(
    source,
    /title=\{`在 \$\{group\.name\} 中新建任务`\}/,
    '空间头应携带「在空间中新建任务」的紧凑 + 按钮'
  );
  assert.match(
    source,
    /aria-label=\{`在 \$\{group\.name\} 中新建任务`\}/,
    '新建按钮应带 aria-label'
  );
  // 树底占行按钮已删：新建按钮不再是占满整行的文案按钮，而是紧凑图标按钮（w-5 h-5）
  const spaceCreateMatches = source.match(
    /aria-label=\{`在 \$\{group\.name\} 中新建任务`\}[\s\S]{0,600}?className="([^"]+)"/
  );
  assert.ok(spaceCreateMatches, '应能定位新建按钮的 className');
  assert.match(spaceCreateMatches[1], /w-5 h-5/, '新建按钮应为紧凑图标按钮');
  assert.match(
    spaceCreateMatches[1],
    /lg:opacity-0 lg:group-hover\/space:opacity-100/,
    '新建按钮应 Hover 显现（桌面端默认隐藏）'
  );
  assert.doesNotMatch(
    source,
    /在 \{group\.name\} 中新建任务<\/span>/,
    '树底不再有占行的「在空间中新建任务」文案按钮'
  );

  // 4. 展开态空间头不加背景框（消除父子双框叠罗汉）；仅折叠且活跃时轻柔胶囊
  assert.match(
    source,
    /activeInSpace && !isOpen/,
    '空间头背景提示应仅在「折叠且当前会话藏在内」时出现'
  );
  assert.doesNotMatch(
    source,
    /activeInSpace\s*\?\s*'bg-zinc-100\/70/,
    '展开态空间头不得再套灰框背景'
  );
});

test('Sidebar 选中态方案 A：浮起白卡 + 左侧指示条，归档选中不降透明度，雷达徽标胶囊化去重', { timeout: 60_000 }, async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const source = await fs.readFile(
    path.join(process.cwd(), 'apps/web/src/components/Sidebar.tsx'),
    'utf-8'
  );

  // 1. SessionRow 选中态：浮起白卡（bg-white）+ 左侧 2px 高对比指示条
  const floatingCard =
    'relative bg-white dark:bg-zinc-800/95 border-zinc-200/90 dark:border-zinc-700/80 shadow-xs';
  assert.ok(
    source.includes(floatingCard),
    'SessionRow/ChildSessionRow 选中态应为浮起白卡样式'
  );
  const indicatorBar = source.match(
    /before:content-\[""\] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0\.5 before:rounded-full before:bg-zinc-900 dark:before:bg-zinc-100/g
  );
  assert.ok(
    indicatorBar && indicatorBar.length >= 2,
    'SessionRow 与 ChildSessionRow 选中态均应携带左侧指示条'
  );

  // 2. 归档行选中时 100% 不透明：dimmed 仅在非选中态生效
  assert.match(
    source,
    /dimmed && !isActive \? 'opacity-65 hover:opacity-100' : ''/,
    '归档降透明应被 isActive 守卫，选中时清晰锐利'
  );
  assert.doesNotMatch(
    source,
    /dimmed \? 'opacity-70 hover:opacity-100' : ''/,
    '不得再无条件对归档行降透明（旧实现）'
  );

  // 3. 雷达行 contextLabel 胶囊化 + 标题智能去重前缀
  assert.match(
    source,
    /inline-flex items-center px-1\.5 py-0\.5 rounded text-\[10px\] font-medium bg-zinc-200\/70/,
    'contextLabel 应渲染为圆角目录徽标胶囊而非裸 monospace'
  );
  assert.match(
    source,
    /title\.startsWith\(`\$\{contextLabel\} `\)/,
    '标题与容器同名时应去掉重复前缀（如 [botd] botd #2 → [botd] #2）'
  );

  // 4. 个人助理卡片选中态同步浮起白卡，且图标反转高亮
  assert.match(
    source,
    /<BotTile className="w-9 h-9 text-sm" active=\{isActive\} \/>/,
    '选中助理时 BotTile 应传入 active 反转高亮'
  );
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
