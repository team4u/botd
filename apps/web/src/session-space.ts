/**
 * 会话注意力与空间分组领域模块（纯函数，无 React 依赖）：
 * 从 Sidebar 组件中拆出以保持 Fast Refresh 兼容（组件文件只导出组件）。
 */
import type { SessionRecord, BotConfig } from '@botd/protocol';

// ---------------------------------------------------------------------------
// 中枢总管（Hub Assistant）：Pulse 中枢模式的常驻自然语言调度入口
// ---------------------------------------------------------------------------

/** 中枢总管会话的固定标题（⚡ 中枢总管）：全局唯一、跨会话复用的持久会话 */
export const HUB_ASSISTANT_TITLE = '⚡ 中枢总管';

/** 判定是否为中枢总管会话：未归档、无父会话、标题精确匹配 */
export function isHubAssistantSession(
  session: Pick<SessionRecord, 'title' | 'archived' | 'parentSessionId'>
): boolean {
  return !session.archived && !session.parentSessionId && session.title === HUB_ASSISTANT_TITLE;
}

/** 选取当前中枢总管会话（同标题存在多条时取最近活跃的一条） */
export function pickHubAssistantSession(sessions: SessionRecord[]): SessionRecord | undefined {
  let latest: SessionRecord | undefined;
  let latestTime = -Infinity;
  for (const s of sessions) {
    if (!isHubAssistantSession(s)) continue;
    const time = activityTimeOf(s);
    if (time > latestTime) {
      latest = s;
      latestTime = time;
    }
  }
  return latest;
}

export function pickCurrentDirectSession(
  sessions: SessionRecord[],
  botId: string
): SessionRecord | undefined {
  let latest: SessionRecord | undefined;
  let latestTime = -Infinity;
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.parentSessionId) continue;
    // 中枢总管会话专属 Pulse 中枢模式，不得篡位普通单聊入口
    if (isHubAssistantSession(s)) continue;
    if (s.leadBotId !== botId) continue;
    const time = new Date(s.updatedAt).getTime();
    if (Number.isFinite(time) && time > latestTime) {
      latest = s;
      latestTime = time;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// 注意力优先级（Attention Priority）：纯函数，可独立测试
// ---------------------------------------------------------------------------

/** 会话注意力级别：idle（静默）之上的三级才值得开发者分神去看 */
export type SessionAttentionLevel = 'failed' | 'done_unseen' | 'working' | 'idle';

/** 需要打断/吸引注意力的活跃级别 */
export type ActiveAttention = Exclude<SessionAttentionLevel, 'idle'>;

/** 注意力优先级数值：越大越值得优先关注（failed > done_unseen > working > idle） */
export const ATTENTION_PRIORITY: Record<SessionAttentionLevel, number> = {
  failed: 4,
  done_unseen: 3,
  working: 2,
  idle: 1,
};

/** 各注意力级别的视觉表现：状态灯圆点 + 文案 + 状态胶囊配色 */
export const ATTENTION_VISUALS: Record<
  ActiveAttention,
  { dot: string; label: string; pill: string }
> = {
  failed: {
    dot: 'bg-rose-500',
    label: '异常',
    pill: 'bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400',
  },
  done_unseen: {
    dot: 'bg-emerald-500',
    label: '待验收',
    pill: 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400',
  },
  working: {
    dot: 'bg-blue-500 animate-pulse',
    label: '运行中',
    pill: 'bg-blue-100 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400',
  },
};

// ---------------------------------------------------------------------------
// 全局后台 Worker 脉冲（Global Worker Pulse）
// ---------------------------------------------------------------------------

/**
 * 全局后台 Worker 脉冲条目：从 hub `/api/workers` 聚合的跨会话后台子任务摘要。
 * 前台 Router 会话 idle 时，其后台 worker 依然让会话在雷达中保持活跃。
 */
export interface GlobalWorkerPulseItem {
  workerId: string;
  conversationId: string;
  parentSessionId: string;
  botId: string;
  title: string;
  kind?: 'worker' | 'workflow' | 'speculative';
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'aborted';
  nodeId?: string;
  cwd?: string;
  worktreePath?: string;
  branchName?: string;
  threadKeys?: string[];
  startedAt: string;
  updatedAt?: string;
  summary?: string;
  sessionTitle?: string;
  workspaceDir?: string;
}

/** 活跃（进行中）worker 判定：pending/running/waiting 均视为后台仍在干活 */
const isActiveWorkerStatus = (status: GlobalWorkerPulseItem['status']): boolean =>
  status === 'pending' || status === 'running' || status === 'waiting';

/**
 * 按父会话聚合 worker 统计：activeCount（进行中）/ failedCount（失败待处理）。
 * 用于让「前台 idle 但后台有 worker」的会话在雷达中获得 working/failed 注意力。
 */
export function aggregateWorkerStatsBySession(
  globalWorkers: GlobalWorkerPulseItem[]
): Map<string, { activeCount: number; failedCount: number }> {
  const stats = new Map<string, { activeCount: number; failedCount: number }>();
  for (const worker of globalWorkers) {
    const entry = stats.get(worker.parentSessionId) ?? { activeCount: 0, failedCount: 0 };
    if (isActiveWorkerStatus(worker.status)) entry.activeCount += 1;
    else if (worker.status === 'failed') entry.failedCount += 1;
    stats.set(worker.parentSessionId, entry);
  }
  return stats;
}

/**
 * 会话注意力优先级判定（纯函数）：
 * failed(4) > done_unseen(3，刚干完活还没验收；后台仍有 worker 活跃时不算完成)
 * > working(2，自身运行或后台 worker 运行) > idle(1)。
 */
export function getSessionAttention(
  session: Pick<SessionRecord, 'status'>,
  unreadCount: number,
  workerStats?: { activeCount?: number; failedCount?: number }
): SessionAttentionLevel {
  if (session.status === 'failed' || (workerStats?.failedCount ?? 0) > 0) return 'failed';
  if (session.status === 'idle' && unreadCount > 0 && (workerStats?.activeCount ?? 0) === 0) {
    return 'done_unseen';
  }
  if (
    session.status === 'running' ||
    session.status === 'queued' ||
    (workerStats?.activeCount ?? 0) > 0
  ) {
    return 'working';
  }
  return 'idle';
}

// workspaceDir 字段由并行分支写入 protocol，此处以结构化类型扩展安全读取，避免耦合
interface WorkspaceAware {
  workspaceDir?: string;
}

/** 规范化工作区目录：去首尾空白与多余尾部斜杠；空值返回 null */
export function normalizeWorkspaceDir(dir?: string | null): string | null {
  if (typeof dir !== 'string') return null;
  const trimmed = dir.trim();
  if (!trimmed) return null;
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

/** Space 展示名取路径最后一段（/root/code/botd -> botd），根目录显示为 / */
export function getSpaceDisplayName(dir: string): string {
  const segment = dir.split('/').filter(Boolean).pop();
  return segment || '/';
}

/** 会话归属的项目目录：会话自身 workspaceDir 优先，其次其主控 BOT 的默认工作区 */
export function resolveSessionWorkspaceDir(
  session: SessionRecord,
  botsById: Map<string, BotConfig>
): string | null {
  const own = normalizeWorkspaceDir((session as SessionRecord & WorkspaceAware).workspaceDir);
  if (own) return own;
  const leadBot = botsById.get(session.leadBotId);
  if (!leadBot) return null;
  return normalizeWorkspaceDir((leadBot as BotConfig & WorkspaceAware).workspaceDir);
}

/** 项目空间分组：Space 头部状态灯取组内会话的最高注意力级别 */
export interface SpaceGroup {
  /** 规范化后的目录路径（分组 key） */
  path: string;
  /** 展示名（路径最后一段） */
  name: string;
  /** 组内未归档主控会话（含当前单聊），按活跃时间倒序 */
  sessions: SessionRecord[];
  /** 绑定到该 Space 的主 BOT（可能尚无会话） */
  botIds: string[];
  /** 组内最高注意力级别 */
  topAttention: SessionAttentionLevel;
  /** 组内最近活跃时间戳（ms），无会话时取 BOT 更新时间 */
  lastActivityAt: number;
}

export const activityTimeOf = (s: SessionRecord) =>
  new Date(s.lastMessageAt ?? s.updatedAt).getTime() || 0;

/** 从未归档主控会话与主 BOT 的 workspaceDir 提取项目 Space 分组（纯函数） */
export function buildSpaceGroups(
  sessions: SessionRecord[],
  bots: BotConfig[],
  unreadCounts: Record<string, number> = {},
  globalWorkers: GlobalWorkerPulseItem[] = []
): SpaceGroup[] {
  const botsById = new Map(bots.map((b) => [b.id, b] as const));
  const workerStatsBySession = aggregateWorkerStatsBySession(globalWorkers);
  const groups = new Map<string, SpaceGroup>();
  const ensureGroup = (dir: string): SpaceGroup => {
    let group = groups.get(dir);
    if (!group) {
      group = {
        path: dir,
        name: getSpaceDisplayName(dir),
        sessions: [],
        botIds: [],
        topAttention: 'idle',
        lastActivityAt: 0,
      };
      groups.set(dir, group);
    }
    return group;
  };

  // 先登记绑定了 workspaceDir 的主 BOT，保证「有 Bot 无会话」的 Space 也可被发现
  for (const bot of bots) {
    const isSubagent = bot.parentBotId && bots.some((b) => b.id === bot.parentBotId);
    if (isSubagent) continue;
    const dir = normalizeWorkspaceDir((bot as BotConfig & WorkspaceAware).workspaceDir);
    if (!dir) continue;
    const group = ensureGroup(dir);
    group.botIds.push(bot.id);
    group.lastActivityAt = Math.max(
      group.lastActivityAt,
      new Date(bot.updatedAt).getTime() || 0
    );
  }

  for (const session of sessions) {
    if (session.archived || session.parentSessionId) continue;
    const dir = resolveSessionWorkspaceDir(session, botsById);
    if (!dir) continue;
    const group = ensureGroup(dir);
    group.sessions.push(session);
    group.lastActivityAt = Math.max(group.lastActivityAt, activityTimeOf(session));
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.sessions.sort((a, b) => activityTimeOf(b) - activityTimeOf(a));
    group.topAttention = group.sessions.reduce<SessionAttentionLevel>((acc, s) => {
      const level = getSessionAttention(
        s,
        unreadCounts[s.id] ?? 0,
        workerStatsBySession.get(s.id)
      );
      return ATTENTION_PRIORITY[level] > ATTENTION_PRIORITY[acc] ? level : acc;
    }, 'idle');
  }
  // 排序：先按汇总注意力优先级降序，再按最近活跃时间降序
  list.sort(
    (a, b) =>
      ATTENTION_PRIORITY[b.topAttention] - ATTENTION_PRIORITY[a.topAttention] ||
      b.lastActivityAt - a.lastActivityAt
  );
  return list;
}

// ---------------------------------------------------------------------------
// 个人助理通讯录聚合（AssistantEntry）：每个主分身固定一行，零会话平铺
// ---------------------------------------------------------------------------

/** 主分身通讯录条目：微信/Telegram 式置顶联系人卡片的数据源 */
export interface AssistantEntry {
  bot: BotConfig;
  /** 该分身当前的默认单聊会话（未绑定 Space 的最新主会话） */
  currentSession?: SessionRecord;
  /** 归属该分身且未绑定 Space 的未归档主会话列表（按活跃时间倒序） */
  directSessions: SessionRecord[];
  /** 该分身关联的所有未归档主会话（含 Space 内会话，用于计算未读/注意力） */
  allActiveSessions: SessionRecord[];
  /** 汇总最高注意力级别 */
  topAttention: SessionAttentionLevel;
  /** 汇总未读消息数 */
  unreadCount: number;
  /** 最新消息预览（仅统计未绑定 Space 的纯个人助理单聊，绝不与项目空间重复） */
  lastMessagePreview?: string;
  /** 最新活跃时间戳（ms，仅统计纯个人助理单聊） */
  lastActivityAt: number;
  /** 麾下子代理数量 */
  subagentCount: number;
}

/**
 * 把每个主分身聚合为一条 AssistantEntry（纯函数）：
 * - directSessions 只收未归档、无 parentSessionId、未绑定 Space 的主会话；
 * - currentSession / lastMessagePreview / lastActivityAt 严格来自 directSessions，
 *   保证绑定了项目目录的会话 100% 只归属项目空间，绝不在助理列表重复预览；
 * - 未读数与注意力级别为全部活跃会话汇总（含 Space 内未读，保证通知不遗漏）。
 */
export function buildAssistantEntries(
  sessions: SessionRecord[],
  bots: BotConfig[],
  unreadCounts: Record<string, number> = {}
): AssistantEntry[] {
  const botsById = new Map(bots.map((b) => [b.id, b] as const));
  const primaryBots = bots.filter(
    (bot) => !bot.parentBotId || !bots.some((b) => b.id === bot.parentBotId)
  );
  const subagentCountByParent = new Map<string, number>();
  for (const bot of bots) {
    if (!bot.parentBotId) continue;
    subagentCountByParent.set(bot.parentBotId, (subagentCountByParent.get(bot.parentBotId) ?? 0) + 1);
  }

  const entries: AssistantEntry[] = primaryBots.map((bot) => {
    const directSessions: SessionRecord[] = [];
    const allActiveSessions: SessionRecord[] = [];
    for (const s of sessions) {
      if (s.archived || s.parentSessionId) continue;
      if (s.leadBotId !== bot.id) continue;
      // 中枢总管会话专属中枢模式，不得作为普通分身的单聊预览来源
      if (isHubAssistantSession(s)) continue;
      allActiveSessions.push(s);
      const dir = resolveSessionWorkspaceDir(s, botsById);
      if (!dir) directSessions.push(s);
    }
    directSessions.sort((a, b) => activityTimeOf(b) - activityTimeOf(a));
    // 当前单聊与预览/活跃时间严格来自纯个人助理会话（directSessions 已按活跃时间倒序）
    const currentSession = directSessions[0];

    let topAttention: SessionAttentionLevel = 'idle';
    let unreadCount = 0;
    for (const s of allActiveSessions) {
      const unread = unreadCounts[s.id] ?? 0;
      unreadCount += unread;
      const level = getSessionAttention(s, unread);
      if (ATTENTION_PRIORITY[level] > ATTENTION_PRIORITY[topAttention]) topAttention = level;
    }
    const latestDirect = directSessions.reduce<SessionRecord | undefined>(
      (acc, s) => (acc === undefined || activityTimeOf(s) > activityTimeOf(acc) ? s : acc),
      undefined,
    );
    const lastActivityAt = Math.max(
      new Date(bot.updatedAt).getTime() || 0,
      latestDirect ? activityTimeOf(latestDirect) : 0,
    );

    return {
      bot,
      currentSession,
      directSessions,
      allActiveSessions,
      topAttention,
      unreadCount,
      lastMessagePreview: latestDirect?.lastMessagePreview,
      lastActivityAt,
      subagentCount: subagentCountByParent.get(bot.id) ?? 0,
    };
  });

  // 排序：有活跃态的浮顶（注意力优先级降序），再按最近活跃时间降序
  entries.sort(
    (a, b) =>
      ATTENTION_PRIORITY[b.topAttention] - ATTENTION_PRIORITY[a.topAttention] ||
      b.lastActivityAt - a.lastActivityAt
  );
  return entries;
}

// ---------------------------------------------------------------------------
// 动态注意力脉冲（Active Pulse）：全局跨容器的实时雷达
// ---------------------------------------------------------------------------

/** 活跃雷达条目：一条值得关注的会话（主会话或子代理任务） */
export interface ActivePulseEntry {
  session: SessionRecord;
  attention: ActiveAttention;
  unread: number;
  leadBot?: BotConfig;
  spaceName: string | null;
  spacePath: string | null;
  /** 容器标签：spaceName || leadBot?.name || session.leadBotId */
  containerLabel: string;
  isChild: boolean;
}

/**
 * 全局活跃雷达（纯函数）：收集所有非 idle 的未归档会话（含子代理任务）。
 * globalWorkers 让「前台 idle 但后台 worker 活跃/失败」的会话同样进入雷达。
 * sortMode='priority' 按 ATTENTION_PRIORITY 降序再按活跃时间降序；
 * sortMode='grouped' 先按容器标签分组（字典序），组内按优先级降序。
 */
export function buildActivePulseEntries(
  sessions: SessionRecord[],
  bots: BotConfig[],
  unreadCounts: Record<string, number> = {},
  sortMode: 'priority' | 'grouped' = 'priority',
  globalWorkers: GlobalWorkerPulseItem[] = []
): ActivePulseEntry[] {
  const botsById = new Map(bots.map((b) => [b.id, b] as const));
  const workerStatsBySession = aggregateWorkerStatsBySession(globalWorkers);
  const entries: ActivePulseEntry[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    const unread = unreadCounts[session.id] ?? 0;
    const attention = getSessionAttention(session, unread, workerStatsBySession.get(session.id));
    if (attention === 'idle') continue;
    const leadBot = botsById.get(session.leadBotId);
    const spacePath = resolveSessionWorkspaceDir(session, botsById);
    const spaceName = spacePath ? getSpaceDisplayName(spacePath) : null;
    entries.push({
      session,
      attention,
      unread,
      leadBot,
      spaceName,
      spacePath,
      containerLabel: spaceName || leadBot?.name || session.leadBotId,
      isChild: Boolean(session.parentSessionId),
    });
  }

  const byPriorityDesc = (a: ActivePulseEntry, b: ActivePulseEntry) =>
    ATTENTION_PRIORITY[b.attention] - ATTENTION_PRIORITY[a.attention] ||
    activityTimeOf(b.session) - activityTimeOf(a.session);
  if (sortMode === 'grouped') {
    entries.sort(
      (a, b) =>
        a.containerLabel.localeCompare(b.containerLabel, 'zh-Hans-CN') || byPriorityDesc(a, b)
    );
  } else {
    entries.sort(byPriorityDesc);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 顶栏上下文 Tab 分组（Context Tab Group）：ChatView 水平标签栏的数据源
// ---------------------------------------------------------------------------

/** 当前会话所属容器（Space 或个人助理）与其平级未归档主会话 Tabs */
export interface ContextTabGroup {
  kind: 'space' | 'assistant';
  /** spacePath 或 botId */
  key: string;
  /** space 展示名 或 bot 名称 */
  label: string;
  spacePath: string | null;
  leadBot?: BotConfig;
  /** 当前容器下的未归档主会话列表（按 createdAt 升序，保证 Tab 位置稳定） */
  tabs: SessionRecord[];
}

/**
 * 解析当前会话所属容器与平级 Tabs（纯函数）：
 * - 绑定了 workspaceDir（会话自身或主控 BOT）-> kind='space'；
 * - 否则 -> kind='assistant'，聚合该主控下所有未绑定 Space 的主会话。
 * Tabs 一律按 createdAt 升序，切换 Tab 时标签位置稳定不乱跳。
 */
export function resolveContextTabGroup(
  activeSession: SessionRecord | null,
  sessions: SessionRecord[],
  bots: BotConfig[]
): ContextTabGroup | null {
  if (!activeSession) return null;
  const botsById = new Map(bots.map((b) => [b.id, b] as const));

  const dir = resolveSessionWorkspaceDir(activeSession, botsById);
  const leadBot = botsById.get(activeSession.leadBotId);

  if (dir) {
    const tabs = sessions
      .filter(
        (s) => !s.archived && !s.parentSessionId && resolveSessionWorkspaceDir(s, botsById) === dir
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return {
      kind: 'space',
      key: dir,
      label: getSpaceDisplayName(dir),
      spacePath: dir,
      leadBot,
      tabs,
    };
  }

  const tabs = sessions
    .filter(
      (s) =>
        !s.archived &&
        !s.parentSessionId &&
        s.leadBotId === activeSession.leadBotId &&
        !resolveSessionWorkspaceDir(s, botsById)
    )
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return {
    kind: 'assistant',
    key: activeSession.leadBotId,
    label: leadBot?.name || activeSession.leadBotId,
    spacePath: null,
    leadBot,
    tabs,
  };
}

