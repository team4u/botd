import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare,
  Server,
  Settings,
  LogOut,
  X,
  Search,
  Bot,
  Trash2,
  ChevronDown,
  Archive,
  UserCog,
  User,
  ShieldCheck,
  Loader2,
  MoreHorizontal,
  ArchiveRestore,
  Bell,
  BellRing,
  CheckSquare,
  Square,
  ListChecks,
  FolderGit2,
  Radar,
} from 'lucide-react';
import type { SessionRecord, BotConfig, NodeRecord, UserRecord } from '@botd/protocol';
import type { MessageSearchHit } from '@botd/protocol';
import { ConfirmDialog } from './ConfirmDialog.js';
import ThemeToggle from './ThemeToggle.js';
import { BotAvatarBadge } from './MessageItem.js';
import { api } from '../api.js';

/**
 * 子代理徽章：小号彩色首字母块（用子代理自身 color，与聊天区取色一致），
 * 替代树状缩进表达归属关系。
 */
const SubAvatarBadge: React.FC<{ botId: string; name: string; color?: string; active?: boolean }> = ({
  botId,
  name,
  color,
  active,
}) => (
  <span
    className={`w-[18px] h-[18px] shrink-0 select-none transition-transform ${
      active ? 'scale-105' : 'group-hover:scale-105'
    }`}
    aria-hidden="true"
  >
    <BotAvatarBadge botId={botId} name={name} color={color as any} />
  </span>
);

interface SidebarProps {
  sessions: SessionRecord[];
  bots: BotConfig[];
  nodeMap: Map<string, NodeRecord>;
  activeSessionId: string | null;
  onSelectSession: (id: string, messageId?: string) => void;
  onOpenBotChat: (bot: BotConfig) => void;
  onOpenBotDirect?: (bot: BotConfig) => void;
  onOpenNodesView: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
  onDeleteSession: (id: string) => Promise<void> | void;
  /** 批量删除会话（历史话题全选删除） */
  onDeleteSessions?: (ids: string[]) => Promise<void> | void;
  /** sessionId -> 未读消息数（可选，缺省视为全部为 0） */
  unreadCounts?: Record<string, number>;
  /** 归档/恢复会话 */
  onSetArchived?: (sessionId: string, archived: boolean) => void;
  isOpen: boolean;
  onClose: () => void;
  currentUser?: UserRecord;
  onOpenUsers?: () => void;
}

/**
 * 选取某个 bot「当前」的单聊会话：
 * 在未归档、主控为该 bot 的会话中，取 updatedAt 最新的一个。
 * 通讯录指向、active 高亮、「历史话题」分类与 App 的 handleOpenBotChat 共用此规则，避免逻辑漂移。
 */
export function pickCurrentDirectSession(
  sessions: SessionRecord[],
  botId: string
): SessionRecord | undefined {
  let latest: SessionRecord | undefined;
  let latestTime = -Infinity;
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.parentSessionId) continue;
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
// Herdr 注意力优先级（Attention Priority）：纯函数，可独立测试
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

/**
 * 会话注意力优先级判定（纯函数）：
 * failed(4) > done_unseen(3，刚干完活还没验收) > working(2) > idle(1)。
 */
export function getSessionAttention(
  session: Pick<SessionRecord, 'status'>,
  unreadCount: number
): SessionAttentionLevel {
  if (session.status === 'failed') return 'failed';
  if (session.status === 'idle' && unreadCount > 0) return 'done_unseen';
  if (session.status === 'running' || session.status === 'queued') return 'working';
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

/** 项目空间分组：Space 头部状态灯取组内会话的最高注意力级别（Herdr 汇总哲学） */
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

const activityTimeOf = (s: SessionRecord) =>
  new Date(s.lastMessageAt ?? s.updatedAt).getTime() || 0;

/** 从未归档主控会话与主 BOT 的 workspaceDir 提取项目 Space 分组（纯函数） */
export function buildSpaceGroups(
  sessions: SessionRecord[],
  bots: BotConfig[],
  unreadCounts: Record<string, number> = {}
): SpaceGroup[] {
  const botsById = new Map(bots.map((b) => [b.id, b] as const));
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
      const level = getSessionAttention(s, unreadCounts[s.id] ?? 0);
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

/** 活跃雷达条目 */
export interface AttentionRadarItem {
  session: SessionRecord;
  attention: ActiveAttention;
  unread: number;
  /** 会话所属项目 Space 展示名（未绑定目录时为 null） */
  spaceName: string | null;
}

/**
 * 活跃雷达（纯函数）：收集所有未归档会话中需要关注的条目，
 * 按 failed > done_unseen > working 降序、同级按活跃时间降序，截取前 limit 条。
 */
export function buildAttentionRadar(
  sessions: SessionRecord[],
  bots: BotConfig[],
  unreadCounts: Record<string, number> = {},
  limit = 4
): AttentionRadarItem[] {
  const botsById = new Map(bots.map((b) => [b.id, b] as const));
  return sessions
    .filter((s) => !s.archived)
    .map((session): AttentionRadarItem | null => {
      const unread = unreadCounts[session.id] ?? 0;
      const attention = getSessionAttention(session, unread);
      if (attention === 'idle') return null;
      const dir = resolveSessionWorkspaceDir(session, botsById);
      return {
        session,
        attention,
        unread,
        spaceName: dir ? getSpaceDisplayName(dir) : null,
      };
    })
    .filter((item): item is AttentionRadarItem => item !== null)
    .sort(
      (a, b) =>
        ATTENTION_PRIORITY[b.attention] - ATTENTION_PRIORITY[a.attention] ||
        activityTimeOf(b.session) - activityTimeOf(a.session)
    )
    .slice(0, limit);
}

/** 基于时间字符串生成相对时间描述，字段缺失或非法时返回 null */
function formatRelativeTime(iso?: string): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;

  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;

  const d = new Date(time);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

/** 搜索命中片段：…前文 20 字 + 命中词 + 后文 40 字…（大小写不敏感定位，未命中取开头） */
function buildSearchSnippet(
  content: string,
  query: string,
  beforeLen = 20,
  afterLen = 40
): { leading: string; before: string; match: string; after: string; trailing: string } {
  // 折叠空白为单空格，保证单行片段展示稳定
  const text = content.replace(/\s+/g, ' ').trim();
  const q = query.trim().toLowerCase();
  const idx = q ? text.toLowerCase().indexOf(q) : -1;
  const start = idx >= 0 ? idx : 0;
  const matchLen = idx >= 0 ? q.length : 0;
  const beforeStart = Math.max(0, start - beforeLen);
  const afterEnd = start + matchLen + afterLen;
  return {
    leading: beforeStart > 0 ? '…' : '',
    before: text.slice(beforeStart, start),
    match: text.slice(start, start + matchLen),
    after: text.slice(start + matchLen, afterEnd),
    trailing: afterEnd < text.length ? '…' : '',
  };
}

/** 可折叠分区头：文字 + 数量 + chevron */
const SectionHeader: React.FC<{
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}> = ({ label, count, open, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    aria-expanded={open}
    className="w-full flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors cursor-pointer"
  >
    <span>{label}</span>
    <span className="font-normal">· {count}</span>
    <ChevronDown
      className={`w-3.5 h-3.5 ml-auto mr-0.5 shrink-0 transition-transform duration-200 ${
        open ? '' : '-rotate-90'
      }`}
    />
  </button>
);

/** 未读数徽标：99+ 封顶；是否渲染（非活跃会话）由调用方决定 */
const UnreadBadge: React.FC<{ count: number }> = ({ count }) => {
  if (count <= 0) return null;
  return (
    <span className="shrink-0 bg-red-500 text-white text-[10px] font-semibold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
      {count > 99 ? '99+' : count}
    </span>
  );
};

/** 状态灯：按注意力级别渲染（idle 不渲染） */
const AttentionDot: React.FC<{ level: SessionAttentionLevel; title?: string }> = ({ level, title }) => {
  if (level === 'idle') return null;
  const visual = ATTENTION_VISUALS[level];
  return <span className={`w-2 h-2 rounded-full shrink-0 ${visual.dot}`} title={title || visual.label} />;
};

/** 状态胶囊文案：待验收拼上未读数 */
const attentionPillText = (item: AttentionRadarItem): string => {
  if (item.attention === 'done_unseen') {
    return item.unread > 0 ? `待验收 · ${item.unread}未读` : '待验收';
  }
  return ATTENTION_VISUALS[item.attention].label;
};

/**
 * 活跃雷达：搜索框下方的紧凑区域，按优先序列出最需要关注的会话。
 * 有 failed / done_unseen / working 才渲染；点击直接切换到该会话。
 */
const ActiveRadarBlock: React.FC<{
  items: AttentionRadarItem[];
  onSelect: (sessionId: string) => void;
}> = ({ items, onSelect }) => {
  if (items.length === 0) return null;
  return (
    <section className="px-2 shrink-0">
      <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/70 dark:bg-zinc-900/70 overflow-hidden">
        <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-500">
          <Radar className="w-3 h-3" />
          <span>活跃雷达</span>
          <span className="font-normal">· {items.length}</span>
        </div>
        <div className="space-y-0.5 px-1 pb-1">
          {items.map((item) => {
            const visual = ATTENTION_VISUALS[item.attention];
            return (
              <button
                key={item.session.id}
                type="button"
                onClick={() => onSelect(item.session.id)}
                title={item.session.title}
                className="w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-lg text-xs transition-colors hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 cursor-pointer"
              >
                <AttentionDot level={item.attention} title={visual.label} />
                {item.spaceName && (
                  <span className="shrink-0 font-mono text-[10px] text-zinc-400 dark:text-zinc-500 truncate max-w-[72px]">
                    [{item.spaceName}]
                  </span>
                )}
                <span className="truncate text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 text-left">
                  {item.session.title}
                </span>
                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${visual.pill}`}
                >
                  {attentionPillText(item)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};

/**
 * 单个项目 Space 分组卡片：头部图标 + 项目名 + 汇总状态灯 + 会话数，
 * 展开后列出该项目下的活跃话题（点击秒切会话）。
 */
const SpaceGroupBlock: React.FC<{
  group: SpaceGroup;
  open: boolean;
  activeSessionId: string | null;
  unreadCounts: Record<string, number>;
  query: string;
  onToggle: () => void;
  onSelect: (sessionId: string) => void;
}> = ({ group, open, activeSessionId, unreadCounts, query, onToggle, onSelect }) => {
  const matchedSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return group.sessions;
    return group.sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.lastMessagePreview || '').toLowerCase().includes(q)
    );
  }, [group.sessions, query]);

  // 搜索时强制展开，保证命中可见
  const effectiveOpen = open || !!query.trim();
  if (query.trim() && matchedSessions.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={effectiveOpen}
        title={group.path}
        className="group w-full flex items-center gap-2 p-2 rounded-xl text-xs transition-all border cursor-pointer hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent"
      >
        <div className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-center shrink-0 text-zinc-600 dark:text-zinc-300">
          <FolderGit2 className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-zinc-900 dark:text-zinc-100">{group.name}</span>
            <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">· {group.sessions.length} 话题</span>
          </div>
          <div className="truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{group.path}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <AttentionDot
            level={group.topAttention}
            title={group.topAttention === 'idle' ? undefined : ATTENTION_VISUALS[group.topAttention].label}
          />
          <ChevronDown
            className={`w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${
              effectiveOpen ? '' : '-rotate-90'
            }`}
          />
        </div>
      </button>
      {effectiveOpen && (
        <div className="space-y-0.5">
          {matchedSessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const unread = unreadCounts[session.id] || 0;
            const attention = getSessionAttention(session, unread);
            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                title={session.title}
                onClick={() => onSelect(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(session.id);
                  }
                }}
                className={`group w-full text-left flex items-center gap-2 py-1.5 pl-[18px] pr-2 rounded-lg text-xs transition-all border cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                  isActive
                    ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs'
                    : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent'
                }`}
              >
                <AttentionDot level={attention} />
                <span
                  className={`truncate ${
                    isActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  {session.title}
                </span>
                {!isActive && <UnreadBadge count={unread} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * 会话项 hover「⋯」操作菜单：恢复 + 删除。
 * 点击外部 / Esc 关闭；菜单项点击需 stopPropagation，避免冒泡触发会话切换。
 */
const SessionItemMenu: React.FC<{
  session: SessionRecord;
  onSetArchived?: (sessionId: string, archived: boolean) => void;
  onDelete: (session: SessionRecord) => void;
}> = ({ session, onSetArchived, onDelete }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const itemBase =
    'w-full flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer';
  const menuItemClass = `${itemBase} text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/60`;
  const menuItemDangerClass = `${itemBase} text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40`;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={`会话操作 ${session.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`${
          open ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'
        } items-center justify-center w-4 h-4 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors cursor-pointer`}
      >
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-5 z-50 min-w-[124px] py-1 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onSetArchived?.(session.id, false);
              setOpen(false);
            }}
            className={menuItemClass}
          >
            <ArchiveRestore className="w-3.5 h-3.5 shrink-0" />
            <span>恢复</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session);
              setOpen(false);
            }}
            className={menuItemDangerClass}
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            <span>删除</span>
          </button>
        </div>
      )}
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  bots,
  nodeMap,
  activeSessionId,
  onSelectSession,
  onOpenBotChat,
  onOpenBotDirect,
  onOpenNodesView,
  onOpenSettings,
  onLogout,
  onDeleteSession,
  onDeleteSessions,
  unreadCounts = {},
  onSetArchived,
  isOpen,
  onClose,
  currentUser,
  onOpenUsers,
}) => {
  const [filter, setFilter] = useState('');
  const [botsOpen, setBotsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 项目空间分区：默认展开，可折叠；每个 Space 独立记忆折叠状态
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 历史话题批量选择模式：multiSelectOn 后每项前置勾选框，配合底部批量删除栏
  const [multiSelectOn, setMultiSelectOn] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);

  // 新消息提示音开关（localStorage 持久化，默认关闭）
  const [soundOn, setSoundOn] = useState(() => {
    try {
      return localStorage.getItem('botd-sound') === '1';
    } catch {
      return false;
    }
  });
  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    try {
      localStorage.setItem('botd-sound', next ? '1' : '0');
    } catch {
      // localStorage 不可用时静默忽略
    }
  };

  // Global message search state (debounced)
  const [searchHits, setSearchHits] = useState<MessageSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);

  const query = filter.trim().toLowerCase();

  // Debounced global message search: fire when query is non-empty
  useEffect(() => {
    const trimmed = filter.trim();
    if (!trimmed) {
      setSearchHits([]);
      setSearching(false);
      setSearchDone(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .searchMessages(trimmed, { limit: 20 })
        .then((hits: MessageSearchHit[]) => {
          if (!active) return;
          setSearchHits(hits);
          setSearchDone(true);
        })
        .catch(() => {
          if (!active) return;
          setSearchHits([]);
          setSearchDone(true);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [filter]);

  // 搜索时强制展开各分区，保证结果可见
  const effectiveBotsOpen = botsOpen || !!query;
  const effectiveHistoryOpen = historyOpen || !!query;

  // 每个 bot 当前指向的单聊会话（通讯录 active 高亮 / 历史话题分类依据）
  const currentDirectByBot = useMemo(() => {
    const map = new Map<string, SessionRecord>();
    bots.forEach((bot) => {
      const current = pickCurrentDirectSession(sessions, bot.id);
      if (current) map.set(bot.id, current);
    });
    return map;
  }, [bots, sessions]);

  const currentDirectIds = useMemo(() => {
    const ids = new Set<string>();
    currentDirectByBot.forEach((s) => ids.add(s.id));
    return ids;
  }, [currentDirectByBot]);

  const sessionMatchesQuery = (s: SessionRecord) =>
    !query ||
    s.title.toLowerCase().includes(query) ||
    (s.lastMessagePreview || '').toLowerCase().includes(query);

  // 分区 1：智能体（按 name / @id / 节点名匹配）
  const filteredBots = bots.filter((bot) => {
    if (!query) return true;
    const nodeName = nodeMap.get(bot.nodeId)?.name || '';
    return (
      bot.name.toLowerCase().includes(query) ||
      bot.id.toLowerCase().includes(query) ||
      nodeName.toLowerCase().includes(query)
    );
  });

  // 建立 parentBotId -> subagents 映射
  const subagentsByParentId = useMemo(() => {
    const map = new Map<string, BotConfig[]>();
    for (const b of bots) {
      if (b.parentBotId) {
        const list = map.get(b.parentBotId) || [];
        list.push(b);
        map.set(b.parentBotId, list);
      }
    }
    return map;
  }, [bots]);

  // 顶层主 BOT 列表：没有 parentBotId，或者 parentBotId 不在已知 bots 中的孤儿子代理
  const primaryFilteredBots = useMemo(() => {
    const q = query.trim().toLowerCase();
    const primaryBots = bots.filter((bot) => !bot.parentBotId || !bots.some((b) => b.id === bot.parentBotId));
    if (!q) return primaryBots;

    return primaryBots.filter((bot) => {
      const nodeName = nodeMap.get(bot.nodeId)?.name || '';
      const botMatch =
        bot.name.toLowerCase().includes(q) ||
        bot.id.toLowerCase().includes(q) ||
        nodeName.toLowerCase().includes(q);
      if (botMatch) return true;

      const subs = subagentsByParentId.get(bot.id) || [];
      return subs.some((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
    });
  }, [bots, nodeMap, query, subagentsByParentId]);

  const openBot = onOpenBotDirect || onOpenBotChat;

  // Herdr 注意力体系：活跃雷达 + 项目 Space 分组
  const radarItems = useMemo(
    () => buildAttentionRadar(sessions, bots, unreadCounts, 4),
    [sessions, bots, unreadCounts]
  );

  const spaceGroups = useMemo(
    () => buildSpaceGroups(sessions, bots, unreadCounts),
    [sessions, bots, unreadCounts]
  );

  const effectiveSpacesOpen = spacesOpen || !!query;

  const toggleSpace = useCallback((path: string) => {
    setCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSelectFromRadar = useCallback(
    (sessionId: string) => {
      onSelectSession(sessionId);
      onClose();
    },
    [onSelectSession, onClose]
  );

  const handleSelectFromSpace = useCallback(
    (sessionId: string) => {
      onSelectSession(sessionId);
      onClose();
    },
    [onSelectSession, onClose]
  );

  const isBotRunning = useCallback(
    (botId: string) => {
      const currentDirect = currentDirectByBot.get(botId);
      if (currentDirect?.status === 'running') return true;
      return sessions.some(
        (s) =>
          s.status === 'running' &&
          (s.activeBotId === botId || (Array.isArray(s.activeBotIds) && s.activeBotIds.includes(botId)))
      );
    },
    [currentDirectByBot, sessions]
  );

  // 分区 2：历史话题 = 已归档会话 + 非当前的单聊会话，按活跃时间倒序
  const historySessions = useMemo(() => {
    const timeOf = (s: SessionRecord) => new Date(s.lastMessageAt ?? s.updatedAt).getTime() || 0;
    return sessions
      .filter(
        (s) =>
          (s.archived || !currentDirectIds.has(s.id)) &&
          sessionMatchesQuery(s)
      )
      .sort((a, b) => timeOf(b) - timeOf(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, currentDirectIds, query]);

  const isAllEmpty =
    filteredBots.length === 0 &&
    historySessions.length === 0 &&
    spaceGroups.length === 0;

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await onDeleteSession(deleteTarget.id);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  // 进入/退出多选模式：退出时清空选择；搜索过滤变更时丢弃不可见项的选择
  const toggleMultiSelect = (on?: boolean) => {
    const next = on ?? !multiSelectOn;
    setMultiSelectOn(next);
    if (!next) setSelectedIds(new Set());
  };

  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(historySessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySessions]);

  const allHistorySelected =
    historySessions.length > 0 && historySessions.every((s) => selectedIds.has(s.id));

  const toggleSelectAllHistory = () => {
    if (allHistorySelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(historySessions.map((s) => s.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    setBatchDeleting(true);
    try {
      await onDeleteSessions?.([...selectedIds]);
      setBatchConfirmOpen(false);
      toggleMultiSelect(false);
    } finally {
      setBatchDeleting(false);
    }
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-zinc-950/20 dark:bg-black/60 backdrop-blur-xs z-30 lg:hidden transition-opacity"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar container */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 bg-zinc-50/90 dark:bg-zinc-900/90 backdrop-blur-md border-r border-zinc-200/80 dark:border-zinc-800/80 flex flex-col transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static ${
          isOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
        aria-label="侧边会话导航"
      >
        {/* Header */}
        <div className="h-16 px-4 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center text-white dark:text-zinc-900 shadow-xs">
              <Bot className="w-4 h-4" />
            </div>
            <span className="font-bold text-base text-zinc-900 dark:text-zinc-100 tracking-tight">botd</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-lg lg:hidden"
            aria-label="关闭侧边栏"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pt-2 pb-1 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索历史消息..."
              className="w-full h-8 pl-8 pr-7 text-xs bg-white dark:bg-zinc-950 border border-zinc-200/80 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:border-zinc-400 dark:focus:border-zinc-600 transition-all"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded transition-colors cursor-pointer"
                aria-label="清除搜索"
              >
                {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        </div>

        {/* Global message search results */}
        {filter.trim() && (
          <div className="px-2 shrink-0">
            <div className="text-[11px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-500 px-2 py-1.5 flex items-center gap-1">
              <span>消息搜索</span>
              {searching ? (
                <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
              ) : (
                <span className="font-normal">· {searchHits.length}</span>
              )}
            </div>
            {searchDone && !searching && searchHits.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-zinc-400 dark:text-zinc-500">未找到匹配的历史消息</p>
            ) : (
              <div className="space-y-0.5 max-h-56 overflow-y-auto">
                {searchHits.map((hit) => (
                  <button
                    key={hit.message.id}
                    type="button"
                    onClick={() => {
                      onSelectSession(hit.message.sessionId, hit.message.id);
                      onClose();
                    }}
                    className="w-full text-left p-2 rounded-lg text-xs transition-colors hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border border-transparent hover:border-zinc-200/70 dark:hover:border-zinc-700/70 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500"
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                        {hit.sessionTitle}
                      </span>
                      {hit.sessionArchived && (
                        <span className="shrink-0 px-1 py-0.5 rounded text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                          已归档
                        </span>
                      )}
                    </div>
                    {(() => {
                      const snippet = buildSearchSnippet(hit.message.content, filter);
                      return (
                        <p className="truncate text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          <span className="font-mono shrink-0">{hit.message.senderBotId ? `@${hit.message.senderBotId}` : 'User'}:</span>{' '}
                          {snippet.leading}
                          {snippet.before}
                          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{snippet.match}</span>
                          {snippet.after}
                          {snippet.trailing}
                        </p>
                      );
                    })()}
                    <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                      {new Date(hit.message.createdAt).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 活跃雷达：需要关注的会话按优先级置顶（点击秒切） */}
        <ActiveRadarBlock items={radarItems} onSelect={handleSelectFromRadar} />

        {/* 两分区列表：项目空间 / 智能体 / 历史话题 */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
          {/* 分区 0：项目空间（Spaces）——存在绑定 workspaceDir 的会话或 Bot 时展示 */}
          {spaceGroups.length > 0 && (
            <section>
              <SectionHeader
                label="项目空间"
                count={spaceGroups.length}
                open={effectiveSpacesOpen}
                onToggle={() => setSpacesOpen((v) => !v)}
              />
              {effectiveSpacesOpen && (
                <div className="space-y-0.5">
                  {spaceGroups.map((group) => (
                    <SpaceGroupBlock
                      key={group.path}
                      group={group}
                      open={!collapsedSpaces.has(group.path)}
                      activeSessionId={activeSessionId}
                      unreadCounts={unreadCounts}
                      query={query}
                      onToggle={() => toggleSpace(group.path)}
                      onSelect={handleSelectFromSpace}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 分区 1：智能体（通讯录） */}
          <section>
            <SectionHeader
              label="智能体"
              count={filteredBots.length}
              open={effectiveBotsOpen}
              onToggle={() => setBotsOpen((v) => !v)}
            />
            {effectiveBotsOpen && (
              <div className="space-y-0.5">
                {primaryFilteredBots.map((bot) => {
                  const currentDirect = currentDirectByBot.get(bot.id);
                  const isActive = !!currentDirect && currentDirect.id === activeSessionId;
                  const isRunning = isBotRunning(bot.id);
                  const node = nodeMap.get(bot.nodeId);
                  const isOnline = node?.status === 'online';
                  const childSubagents = (subagentsByParentId.get(bot.id) || []).filter((s) => {
                    if (!query) return true;
                    const q = query.trim().toLowerCase();
                    return s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
                  });

                  return (
                    <div key={bot.id} className="space-y-0.5">
                      <div
                        role="button"
                        tabIndex={0}
                        title={`@${bot.id}`}
                        onClick={() => {
                          openBot(bot);
                          onClose();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openBot(bot);
                            onClose();
                          }
                        }}
                        className={`group w-full text-left p-2 rounded-xl text-xs transition-all flex items-center gap-2 border cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                          isActive
                            ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs'
                            : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent'
                        }`}
                      >
                        {/* 圆角方块图标 */}
                        <div
                          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border transition-colors ${
                            isActive
                              ? 'bg-zinc-200/80 dark:bg-zinc-700 border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200'
                              : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200/80 dark:border-zinc-800/80 text-zinc-600 dark:text-zinc-300'
                          }`}
                        >
                          <Bot className="w-4 h-4" />
                        </div>

                        {/* 名称 + @id / 节点名 */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`truncate font-semibold text-zinc-900 dark:text-zinc-100`}
                            >
                              {bot.name}
                            </span>
                            {(bot.visibility === 'team' || bot.isTeamShared) && (
                              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-normal">
                                [共享]
                              </span>
                            )}
                            <span
                              className={`truncate font-mono text-[11px] ${
                                isActive ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'
                              }`}
                            >
                              @{bot.id}
                            </span>
                          </div>
                          <div
                            className={`truncate text-[11px] ${
                              isActive ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'
                            }`}
                          >
                            {node?.name || bot.nodeId}
                          </div>
                        </div>

                        {/* 在线 / 运行状态点 */}
                        <div className="w-4 h-4 flex items-center justify-center shrink-0">
                          {isRunning ? (
                            <span
                              className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-dot"
                              title="会话运行中"
                            />
                          ) : isOnline ? (
                            <span className="w-2 h-2 rounded-full bg-emerald-500" title="节点在线" />
                          ) : (
                            <span
                              className="w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-600"
                              title="节点离线"
                            />
                          )}
                        </div>
                      </div>

                      {/* 子代理平铺列表（不缩进不树状） */}
                      {childSubagents.length > 0 && (
                        <div className="space-y-0.5">
                          {childSubagents.map((sub) => {
                            const subDirect = currentDirectByBot.get(sub.id);
                            const isSubActive = !!subDirect && subDirect.id === activeSessionId;
                            const isSubRunning = isBotRunning(sub.id);

                            return (
                              <div
                                key={sub.id}
                                role="button"
                                tabIndex={0}
                                title={`@${sub.id}`}
                                onClick={() => {
                                  openBot(sub);
                                  onClose();
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    openBot(sub);
                                    onClose();
                                  }
                                }}
                                className={`group w-full text-left py-1.5 pl-[18px] pr-2 rounded-lg text-xs transition-all flex items-center gap-2 border cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                                  isSubActive
                                    ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs'
                                    : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent'
                                }`}
                              >
                                <SubAvatarBadge botId={sub.id} name={sub.name} color={sub.color} active={isSubActive} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                                      {sub.name}
                                    </span>
                                    <span
                                      className={`truncate font-mono text-[11px] ${
                                        isSubActive ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'
                                      }`}
                                    >
                                      @{sub.id}
                                    </span>
                                    <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">· 子代理</span>
                                  </div>
                                </div>

                                {isSubRunning && (
                                  <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                    <span>运行中</span>
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 分区 2：历史话题（归档会话 + 非当前单聊），默认折叠 */}
          {historySessions.length > 0 && (
            <section>
              <div className="flex items-center">
                <SectionHeader
                  label="历史话题"
                  count={historySessions.length}
                  open={effectiveHistoryOpen}
                  onToggle={() => setHistoryOpen((v) => !v)}
                />
                {/* 多选批量删除入口：仅在支持批量删除时展示 */}
                {onDeleteSessions && (
                  <button
                    type="button"
                    onClick={() => toggleMultiSelect()}
                    aria-pressed={multiSelectOn}
                    title={multiSelectOn ? '退出多选' : '多选删除历史话题'}
                    className={`ml-auto mr-0.5 p-1 rounded-md transition-colors cursor-pointer shrink-0 ${
                      multiSelectOn
                        ? 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40'
                        : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <ListChecks className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {effectiveHistoryOpen && (
                <div className="space-y-0.5">
                  {/* 多选模式：全选/取消全选 + 批量删除栏 */}
                  {multiSelectOn && (
                    <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-zinc-100/70 dark:bg-zinc-800/60">
                      <button
                        type="button"
                        onClick={toggleSelectAllHistory}
                        className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                      >
                        {allHistorySelected ? (
                          <CheckSquare className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                        ) : (
                          <Square className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                        )}
                        <span>{allHistorySelected ? '取消全选' : '全选'}</span>
                      </button>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">已选 {selectedIds.size} 项</span>
                        <button
                          type="button"
                          onClick={() => setBatchConfirmOpen(true)}
                          disabled={selectedIds.size === 0}
                          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>删除</span>
                        </button>
                      </div>
                    </div>
                  )}
                  {historySessions.map((session) => {
                    const isActive = session.id === activeSessionId;
                    const relativeTime = formatRelativeTime(session.lastMessageAt ?? session.updatedAt);
                    const checked = selectedIds.has(session.id);

                    if (multiSelectOn) {
                      // 多选模式：整行切换勾选，不触发会话切换
                      return (
                        <div
                          key={session.id}
                          role="button"
                          tabIndex={0}
                          title={session.title}
                          onClick={() => toggleSelectOne(session.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleSelectOne(session.id);
                            }
                          }}
                          className={`w-full text-left p-2 rounded-xl text-xs transition-all flex items-center gap-2 border cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                            checked
                              ? 'bg-blue-50/70 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/70'
                              : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent'
                          }`}
                        >
                          {checked ? (
                            <CheckSquare className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                          ) : (
                            <Square className="w-3.5 h-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                          )}
                          <Archive
                            className={`w-3.5 h-3.5 shrink-0 ${
                              checked ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-500 dark:text-zinc-400'
                            }`}
                          />
                          <span className="truncate text-zinc-900 dark:text-zinc-100">{session.title}</span>
                          {relativeTime && (
                            <span className="ml-auto shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
                              {relativeTime}
                            </span>
                          )}
                        </div>
                      );
                    }

                    return (
                      <div
                        key={session.id}
                        role="button"
                        tabIndex={0}
                        title={session.title}
                        onClick={() => {
                          onSelectSession(session.id);
                          onClose();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectSession(session.id);
                            onClose();
                          }
                        }}
                        className={`group opacity-75 hover:opacity-100 w-full text-left p-2 rounded-xl text-xs transition-all flex items-center gap-2 border cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                          isActive
                            ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs'
                            : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent'
                        }`}
                      >
                        <Archive
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isActive ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-500 dark:text-zinc-400'
                          }`}
                        />
                        <span
                          className={`truncate ${
                            isActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-700 dark:text-zinc-300'
                          }`}
                        >
                          {session.title}
                        </span>
                        {!isActive && <UnreadBadge count={unreadCounts[session.id] || 0} />}
                        {relativeTime && (
                          <span
                            className={`ml-auto shrink-0 text-[11px] ${
                              isActive ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'
                            }`}
                          >
                            {relativeTime}
                          </span>
                        )}
                        <SessionItemMenu
                          session={session}
                          onSetArchived={onSetArchived}
                          onDelete={setDeleteTarget}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* 统一空态 */}
          {isAllEmpty && (
            <div className="py-8 px-4 text-center">
              <MessageSquare className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                {filter ? '未找到匹配的智能体或会话' : '暂无智能体与会话'}
              </p>
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div className="p-3 pb-safe border-t border-zinc-200/80 dark:border-zinc-800/80 shrink-0 space-y-1">
          {/* 当前用户信息 */}
          {currentUser && (
            <div className="flex items-center gap-2.5 px-3 py-2 mb-1">
              <div className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-center text-zinc-600 dark:text-zinc-300 shrink-0">
                <User className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    {currentUser.username}
                  </span>
                  <span
                    className={`inline-flex items-center gap-0.5 shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${
                      currentUser.role === 'admin'
                        ? 'bg-zinc-200/80 dark:bg-zinc-800/80 text-zinc-800 dark:text-zinc-200'
                        : 'bg-zinc-100 dark:bg-zinc-800/60 text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    {currentUser.role === 'admin' && <ShieldCheck className="w-2.5 h-2.5" />}
                    <span>{currentUser.role}</span>
                  </span>
                </div>
              </div>
              {/* 主题切换 + 新消息提示音开关：与底部按钮同阶的小图标按钮 */}
              <ThemeToggle />
              <button
                type="button"
                onClick={toggleSound}
                title="新消息提示音"
                aria-pressed={soundOn}
                className={`h-8 w-8 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors cursor-pointer ${
                  soundOn ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500'
                }`}
              >
                {soundOn ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
              </button>
            </div>
          )}

          <button
            onClick={() => {
              onOpenNodesView();
              onClose();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 rounded-xl transition-colors"
          >
            <Server className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
            <span>节点与智能体</span>
          </button>

          <button
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 rounded-xl transition-colors"
          >
            <Settings className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
            <span>模型与凭据设置</span>
          </button>

          {currentUser?.role === 'admin' && onOpenUsers && (
            <button
              onClick={() => {
                onOpenUsers();
                onClose();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 rounded-xl transition-colors"
            >
              <UserCog className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
              <span>用户管理</span>
            </button>
          )}

          <button
            onClick={onLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50/60 dark:hover:bg-rose-950/40 rounded-xl transition-colors"
          >
            <LogOut className="w-4 h-4 text-zinc-400 dark:text-zinc-500" />
            <span>退出登录</span>
          </button>
        </div>
      </aside>

      {/* 删除会话二次确认 */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="删除会话"
        message={
          <>
            确定要删除会话「{deleteTarget?.title}」吗？
            <br />
            该会话的全部历史消息将被永久移除，此操作不可恢复。
          </>
        }
        confirmText="删除"
        danger
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
      />

      {/* 批量删除历史话题二次确认 */}
      <ConfirmDialog
        isOpen={batchConfirmOpen}
        title="批量删除历史话题"
        message={
          <>
            确定要删除已选的 {selectedIds.size} 个历史话题吗？
            <br />
            这些话题的全部历史消息将被永久移除，此操作不可恢复。运行中的话题会被自动跳过。
          </>
        }
        confirmText="全部删除"
        danger
        busy={batchDeleting}
        onConfirm={handleBatchDelete}
        onClose={() => {
          if (!batchDeleting) setBatchConfirmOpen(false);
        }}
      />
    </>
  );
};
