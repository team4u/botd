import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare,
  Server,
  Settings,
  LogOut,
  X,
  Search,
  Trash2,
  ChevronDown,
  Archive,
  ArchiveRestore,
  UserCog,
  User,
  Loader2,
  MoreHorizontal,
  Bell,
  BellRing,
  CheckSquare,
  Square,
  ListChecks,
  FolderGit2,
  Bot,
} from 'lucide-react';
import type { SessionRecord, BotConfig, NodeRecord, UserRecord } from '@botd/protocol';
import type { MessageSearchHit } from '@botd/protocol';
import { ConfirmDialog } from './ConfirmDialog.js';
import ThemeToggle from './ThemeToggle.js';
import { botAccentFor, subagentColorStyles } from './MessageItem.js';
import { api } from '../api.js';

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
  /** 批量删除会话（最近协同批量管理） */
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
 * 分身快捷入口、active 高亮与 App 的 handleOpenBotChat 共用此规则，避免逻辑漂移。
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

// ---------------------------------------------------------------------------
// 内部工具与展示组件
// ---------------------------------------------------------------------------

/** 相对时间：刚刚 / 今天 HH:MM / 昨天 / N 天前 / MM-DD */
function formatRelativeTime(iso?: string): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;

  const now = Date.now();
  if (now - time < 60_000) return '刚刚';

  const d = new Date(time);
  const nowD = new Date(now);
  if (d.toDateString() === nowD.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(nowD.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  if (now - time < 7 * 86_400_000) return `${Math.floor((now - time) / 86_400_000)} 天前`;

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

/** 会话展示标题：标题等于默认值（bot id）时替换为分身名，其余保持原标题 */
function sessionDisplayTitle(session: SessionRecord, botsById: Map<string, BotConfig>): string {
  const leadBot = botsById.get(session.leadBotId);
  if (leadBot && session.title === leadBot.id) return leadBot.name || session.title;
  return session.title;
}

/** 未读数徽标：99+ 封顶 */
const UnreadBadge: React.FC<{ count: number }> = ({ count }) => {
  if (count <= 0) return null;
  return (
    <span className="shrink-0 bg-red-500 text-white text-[10px] font-semibold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
      {count > 99 ? '99+' : count}
    </span>
  );
};

/** 状态灯：按注意力级别渲染（idle 不渲染） */
const AttentionDot: React.FC<{ level: SessionAttentionLevel; title?: string }> = ({
  level,
  title,
}) => {
  if (level === 'idle') return null;
  const visual = ATTENTION_VISUALS[level];
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${visual.dot}`}
      title={title || visual.label}
    />
  );
};

/** 分身/会话首字母色块：取色规则与聊天区 BotAvatarBadge 完全一致（子代理色优先，否则按 ID 哈希） */
const BotTile: React.FC<{ bot?: BotConfig; className?: string }> = ({ bot, className = '' }) => {
  const accent =
    bot?.color && subagentColorStyles[bot.color] ? bot.color : botAccentFor(bot?.id || bot?.name || 'bot');
  const letter = (bot?.name || bot?.id || 'B').trim().charAt(0).toUpperCase() || 'B';
  return (
    <span
      aria-hidden="true"
      className={`rounded-lg border flex items-center justify-center font-bold select-none shrink-0 ${subagentColorStyles[accent].iconBg} ${className}`}
    >
      {letter}
    </span>
  );
};

/** 角色分身快捷卡：首字母色块 + 在线/运行状态点 + 名称 + 子代理计数 */
const PersonaPill: React.FC<{
  bot: BotConfig;
  active: boolean;
  running: boolean;
  online: boolean;
  subagentCount: number;
  wide: boolean;
  onClick: () => void;
}> = ({ bot, active, running, online, subagentCount, wide, onClick }) => {
  const dotClass = running
    ? 'bg-blue-500 animate-pulse'
    : online
      ? 'bg-emerald-500'
      : 'bg-zinc-300 dark:bg-zinc-600';
  const dotTitle = running ? '会话运行中' : online ? '节点在线' : '节点离线';
  return (
    <button
      type="button"
      onClick={onClick}
      title={`@${bot.id} · ${dotTitle}`}
      className={`flex items-center gap-2 rounded-xl border text-left transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
        wide ? 'w-full min-w-0' : 'shrink-0'
      } ${
        active
          ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs'
          : 'bg-white/70 dark:bg-zinc-900/70 border-zinc-200/80 dark:border-zinc-800/80 hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80'
      } pl-1.5 pr-2.5 py-1.5`}
    >
      <span className="relative shrink-0">
        <BotTile bot={bot} className="w-7 h-7 text-xs" />
        <span
          title={dotTitle}
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-50 dark:border-zinc-900 ${dotClass}`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
          {bot.name}
        </span>
      </span>
      {subagentCount > 0 && (
        <span
          title={`${subagentCount} 个子代理`}
          className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200/80 dark:border-zinc-800"
        >
          +{subagentCount}
        </span>
      )}
    </button>
  );
};

/** 会话行「⋯」操作菜单：归档/恢复 + 删除。点击外部 / Esc 关闭 */
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
          open ? 'opacity-100' : 'opacity-60 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100'
        } flex items-center justify-center w-5 h-5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-opacity cursor-pointer`}
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-6 z-50 min-w-[124px] py-1 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-md"
        >
          {onSetArchived && (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                onSetArchived(session.id, !session.archived);
                setOpen(false);
              }}
              className={menuItemClass}
            >
              {session.archived ? (
                <ArchiveRestore className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <Archive className="w-3.5 h-3.5 shrink-0" />
              )}
              <span>{session.archived ? '恢复' : '归档'}</span>
            </button>
          )}
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

/** 统一收件箱会话行：min-h-[56px] 舒适触达 + 状态胶囊 / Space 徽标 / 未读数 / 快捷菜单 */
const SessionRow: React.FC<{
  session: SessionRecord;
  leadBot?: BotConfig;
  botsById: Map<string, BotConfig>;
  isActive: boolean;
  attention: SessionAttentionLevel;
  unread: number;
  batchMode: boolean;
  selected: boolean;
  dimmed?: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onSetArchived?: (sessionId: string, archived: boolean) => void;
  onDelete: (session: SessionRecord) => void;
}> = ({
  session,
  leadBot,
  botsById,
  isActive,
  attention,
  unread,
  batchMode,
  selected,
  dimmed = false,
  onSelect,
  onToggleSelect,
  onSetArchived,
  onDelete,
}) => {
  const relativeTime = formatRelativeTime(session.lastMessageAt ?? session.updatedAt);
  const spaceDir = resolveSessionWorkspaceDir(session, botsById);
  const spaceName = spaceDir ? getSpaceDisplayName(spaceDir) : null;
  const title = sessionDisplayTitle(session, botsById);

  const handleClick = () => {
    if (batchMode) onToggleSelect();
    else onSelect();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      title={session.title}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`group min-h-[56px] w-full text-left px-2 py-2 rounded-xl border transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 flex items-center gap-2.5 ${
        dimmed ? 'opacity-70 hover:opacity-100' : ''
      } ${
        batchMode && selected
          ? 'bg-blue-50/70 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/70'
          : isActive
            ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs'
            : 'border-transparent hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80'
      }`}
    >
      {batchMode ? (
        selected ? (
          <CheckSquare className="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
        ) : (
          <Square className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
        )
      ) : (
        <span className="relative shrink-0">
          <BotTile bot={leadBot} className="w-8 h-8 text-sm" />
          {attention !== 'idle' && (
            <span
              title={ATTENTION_VISUALS[attention].label}
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-50 dark:border-zinc-900 ${
                ATTENTION_VISUALS[attention].dot
              }`}
            />
          )}
        </span>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span
            className={`truncate text-[13px] font-semibold ${
              isActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-800 dark:text-zinc-200'
            }`}
          >
            {title}
          </span>
          {relativeTime && (
            <span className="ml-auto shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
              {relativeTime}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1 min-w-0">
          {attention !== 'idle' && (
            <span
              className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                ATTENTION_VISUALS[attention].pill
              }`}
            >
              {ATTENTION_VISUALS[attention].label}
            </span>
          )}
          {spaceName && (
            <span
              title={spaceDir ?? undefined}
              className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-mono text-zinc-400 dark:text-zinc-500 truncate max-w-[96px]"
            >
              <FolderGit2 className="w-3 h-3 shrink-0" />
              {spaceName}
            </span>
          )}
          <UnreadBadge count={unread} />
        </div>
      </div>

      {!batchMode && (
        <SessionItemMenu session={session} onSetArchived={onSetArchived} onDelete={onDelete} />
      )}
    </div>
  );
};

/** 子任务会话紧凑行（44px 触达）：色块 + 标题 + 时间 + 状态点/未读 */
const ChildSessionRow: React.FC<{
  session: SessionRecord;
  leadBot?: BotConfig;
  isActive: boolean;
  attention: SessionAttentionLevel;
  unread: number;
  onSelect: () => void;
}> = ({ session, leadBot, isActive, attention, unread, onSelect }) => {
  const relativeTime = formatRelativeTime(session.lastMessageAt ?? session.updatedAt);
  return (
    <div
      role="button"
      tabIndex={0}
      title={session.title}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group min-h-[44px] w-full text-left px-2 py-1.5 rounded-lg border transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 flex items-center gap-2 ${
        isActive
          ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70'
          : 'border-transparent hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80'
      }`}
    >
      <span className="relative shrink-0">
        <BotTile bot={leadBot} className="w-6 h-6 text-[10px]" />
        {attention !== 'idle' && (
          <span
            title={ATTENTION_VISUALS[attention].label}
            className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-zinc-50 dark:border-zinc-900 ${
              ATTENTION_VISUALS[attention].dot
            }`}
          />
        )}
      </span>
      <span className="truncate text-xs text-zinc-700 dark:text-zinc-300 flex-1 min-w-0">
        {session.title}
      </span>
      {!isActive && <UnreadBadge count={unread} />}
      {relativeTime && (
        <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">{relativeTime}</span>
      )}
    </div>
  );
};

/** 安静折叠区（子任务/归档）：默认收起，绝不干扰主收件箱 */
const QuietSection: React.FC<{
  icon: React.ReactNode;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ icon, label, count, open, onToggle, children }) => (
  <section className="pt-1">
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors cursor-pointer"
    >
      {icon}
      <span>{label}</span>
      <span className="font-normal">· {count}</span>
      <ChevronDown
        className={`w-3.5 h-3.5 ml-auto shrink-0 transition-transform duration-200 ${
          open ? '' : '-rotate-90'
        }`}
      />
    </button>
    {open && <div className="space-y-0.5">{children}</div>}
  </section>
);

/** 全局消息搜索结果块 */
const SearchHitsBlock: React.FC<{
  hits: MessageSearchHit[];
  searching: boolean;
  done: boolean;
  query: string;
  onSelect: (sessionId: string, messageId: string) => void;
}> = ({ hits, searching, done, query, onSelect }) => (
  <section className="mb-2 shrink-0">
    <div className="text-[11px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-500 px-2 py-1.5 flex items-center gap-1">
      <span>消息搜索</span>
      {searching ? (
        <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
      ) : (
        <span className="font-normal">· {hits.length}</span>
      )}
    </div>
    {done && !searching && hits.length === 0 ? (
      <p className="px-2 py-2 text-[11px] text-zinc-400 dark:text-zinc-500">未找到匹配的历史消息</p>
    ) : (
      <div className="space-y-0.5 max-h-56 overflow-y-auto">
        {hits.map((hit) => (
          <button
            key={hit.message.id}
            type="button"
            onClick={() => onSelect(hit.message.sessionId, hit.message.id)}
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
              const snippet = buildSearchSnippet(hit.message.content, query);
              return (
                <p className="truncate text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  <span className="font-mono shrink-0">
                    {hit.message.senderBotId ? `@${hit.message.senderBotId}` : 'User'}:
                  </span>{' '}
                  {snippet.leading}
                  {snippet.before}
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {snippet.match}
                  </span>
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
  </section>
);

/** 收件箱过滤模式：全部 / 仅活跃关注 / 按项目 Space 分组 */
type InboxFilter = 'all' | 'attention' | 'space';

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
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>('all');
  // 批量管理（最近协同）：multiSelectOn 后整行切换勾选，配合批量删除栏
  const [multiSelectOn, setMultiSelectOn] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 安静折叠区：默认收起
  const [childrenOpen, setChildrenOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(new Set());

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

  // 全局消息搜索状态（250ms 防抖，关键词 >= 2 字才触发）
  const [searchHits, setSearchHits] = useState<MessageSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);

  const query = filter.trim().toLowerCase();
  const searchActive = filter.trim().length >= 2;

  useEffect(() => {
    const trimmed = filter.trim();
    if (trimmed.length < 2) {
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

  const botsById = useMemo(() => new Map(bots.map((b) => [b.id, b] as const)), [bots]);

  // parentBotId -> 子代理列表
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

  // 主分身列表：无 parentBotId，或父 BOT 不在已知列表中的孤儿子代理
  const primaryBots = useMemo(
    () => bots.filter((bot) => !bot.parentBotId || !bots.some((b) => b.id === bot.parentBotId)),
    [bots]
  );

  const filteredPrimaryBots = useMemo(() => {
    if (!query) return primaryBots;
    return primaryBots.filter((bot) => {
      const nodeName = nodeMap.get(bot.nodeId)?.name || '';
      if (
        bot.name.toLowerCase().includes(query) ||
        bot.id.toLowerCase().includes(query) ||
        nodeName.toLowerCase().includes(query)
      )
        return true;
      const subs = subagentsByParentId.get(bot.id) || [];
      return subs.some((s) => s.name.toLowerCase().includes(query) || s.id.toLowerCase().includes(query));
    });
  }, [primaryBots, nodeMap, query, subagentsByParentId]);

  // 每个 bot 当前指向的单聊会话（active 高亮依据）
  const currentDirectByBot = useMemo(() => {
    const map = new Map<string, SessionRecord>();
    bots.forEach((bot) => {
      const current = pickCurrentDirectSession(sessions, bot.id);
      if (current) map.set(bot.id, current);
    });
    return map;
  }, [bots, sessions]);

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

  const openBot = onOpenBotDirect || onOpenBotChat;

  const spaceGroups = useMemo(
    () => buildSpaceGroups(sessions, bots, unreadCounts),
    [sessions, bots, unreadCounts]
  );

  const attentionOf = useCallback(
    (s: SessionRecord) => getSessionAttention(s, unreadCounts[s.id] ?? 0),
    [unreadCounts]
  );

  const sessionMatchesQuery = useCallback(
    (s: SessionRecord) => {
      if (!query) return true;
      const lead = botsById.get(s.leadBotId);
      return (
        s.title.toLowerCase().includes(query) ||
        (s.lastMessagePreview || '').toLowerCase().includes(query) ||
        (!!lead &&
          (lead.name.toLowerCase().includes(query) || lead.id.toLowerCase().includes(query)))
      );
    },
    [query, botsById]
  );

  // 统一收件箱：全部未归档主控会话，按注意力浮顶 + 活跃时间倒序
  const unifiedSessions = useMemo(() => {
    const matched = sessions
      .filter((s) => !s.archived && !s.parentSessionId)
      .filter(sessionMatchesQuery);
    const ranked = matched.filter((s) => attentionOf(s) !== 'idle');
    const idle = matched.filter((s) => attentionOf(s) === 'idle');
    const byAttentionDesc = (a: SessionRecord, b: SessionRecord) =>
      ATTENTION_PRIORITY[attentionOf(b)] - ATTENTION_PRIORITY[attentionOf(a)] ||
      activityTimeOf(b) - activityTimeOf(a);
    const byTimeDesc = (a: SessionRecord, b: SessionRecord) => activityTimeOf(b) - activityTimeOf(a);
    if (inboxFilter === 'attention') return ranked.sort(byAttentionDesc);
    return [...ranked.sort(byAttentionDesc), ...idle.sort(byTimeDesc)];
  }, [sessions, sessionMatchesQuery, attentionOf, inboxFilter]);

  const attentionCount = useMemo(
    () =>
      sessions.filter((s) => !s.archived && !s.parentSessionId && attentionOf(s) !== 'idle').length,
    [sessions, attentionOf]
  );

  // 按项目 Space 视图：分组 + 未归档兜底组
  const spaceView = useMemo(() => {
    if (inboxFilter !== 'space') return { sections: [] as { group: SpaceGroup; visible: SessionRecord[] }[], ungrouped: [] as SessionRecord[] };
    const byDir = new Map(
      spaceGroups.map((g) => [g.path, { group: g, visible: [] as SessionRecord[] }] as const)
    );
    const ungrouped: SessionRecord[] = [];
    for (const s of unifiedSessions) {
      const dir = resolveSessionWorkspaceDir(s, botsById);
      const sec = dir ? byDir.get(dir) : undefined;
      if (sec) sec.visible.push(s);
      else ungrouped.push(s);
    }
    return {
      sections: [...byDir.values()].filter((sec) => sec.visible.length > 0),
      ungrouped,
    };
  }, [inboxFilter, spaceGroups, unifiedSessions, botsById]);

  const visibleSessions = useMemo(
    () =>
      inboxFilter === 'space'
        ? [...spaceView.sections.flatMap((sec) => sec.visible), ...spaceView.ungrouped]
        : unifiedSessions,
    [inboxFilter, spaceView, unifiedSessions]
  );

  // 子任务会话与归档会话（安静折叠区）
  const childSessions = useMemo(
    () =>
      sessions
        .filter((s) => !s.archived && s.parentSessionId && sessionMatchesQuery(s))
        .sort((a, b) => activityTimeOf(b) - activityTimeOf(a)),
    [sessions, sessionMatchesQuery]
  );

  const archivedSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.archived && sessionMatchesQuery(s))
        .sort((a, b) => activityTimeOf(b) - activityTimeOf(a)),
    [sessions, sessionMatchesQuery]
  );

  // 搜索时强制展开安静区，保证命中可见
  const effectiveChildrenOpen = childrenOpen || !!query;
  const effectiveArchivedOpen = archivedOpen || !!query;

  const handleSelect = useCallback(
    (id: string, messageId?: string) => {
      onSelectSession(id, messageId);
      onClose();
    },
    [onSelectSession, onClose]
  );

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

  // 进入/退出批量模式：退出时清空选择
  const toggleMultiSelect = (on?: boolean) => {
    const next = on ?? !multiSelectOn;
    setMultiSelectOn(next);
    if (!next) setSelectedIds(new Set());
  };

  // 搜索/过滤变更时丢弃不可见项的选择
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(visibleSessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleSessions]);

  const allVisibleSelected =
    visibleSessions.length > 0 && visibleSessions.every((s) => selectedIds.has(s.id));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(visibleSessions.map((s) => s.id)));
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

  const toggleSpaceCollapse = (path: string) => {
    setCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderSessionRow = (session: SessionRecord, dimmed = false) => (
    <SessionRow
      key={session.id}
      session={session}
      leadBot={botsById.get(session.leadBotId)}
      botsById={botsById}
      isActive={session.id === activeSessionId}
      attention={attentionOf(session)}
      unread={unreadCounts[session.id] ?? 0}
      batchMode={multiSelectOn}
      selected={selectedIds.has(session.id)}
      dimmed={dimmed}
      onSelect={() => handleSelect(session.id)}
      onToggleSelect={() => toggleSelectOne(session.id)}
      onSetArchived={onSetArchived}
      onDelete={setDeleteTarget}
    />
  );

  const onlineNodes = useMemo(
    () => [...nodeMap.values()].filter((n) => n.status === 'online').length,
    [nodeMap]
  );

  const showAttentionPill = attentionCount > 0;
  const showSpacePill = spaceGroups.length > 1;
  const showPillBar = showAttentionPill || showSpacePill;

  const pillClass = (on: boolean) =>
    `shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
      on
        ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 border-transparent'
        : 'bg-white/70 dark:bg-zinc-900/70 text-zinc-500 dark:text-zinc-400 border-zinc-200/80 dark:border-zinc-800/80 hover:text-zinc-700 dark:hover:text-zinc-300'
    }`;

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

      {/* Sidebar container：移动端近全屏面板，桌面端 288px 常驻侧栏 */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-full sm:w-80 lg:w-72 bg-zinc-50/95 dark:bg-zinc-900/95 backdrop-blur-md border-r border-zinc-200/80 dark:border-zinc-800/80 flex flex-col transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static ${
          isOpen ? 'translate-x-0 shadow-2xl lg:shadow-none' : '-translate-x-full'
        }`}
        aria-label="侧边会话导航"
      >
        {/* Section 1: 顶栏（品牌 + 节点状态 + 快捷入口） */}
        <div className="h-14 px-3 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center gap-2 shrink-0">
          <div className="w-8 h-8 rounded-xl bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center text-white dark:text-zinc-900 shadow-xs shrink-0">
            <Bot className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <span className="block text-sm font-bold leading-tight tracking-tight text-zinc-900 dark:text-zinc-100">
              botd
            </span>
            <span
              className="flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-500"
              title={`${onlineNodes}/${nodeMap.size} 节点在线`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  onlineNodes > 0 ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'
                }`}
              />
              {nodeMap.size > 0 ? `${onlineNodes}/${nodeMap.size} 在线` : '无节点'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                onOpenNodesView();
                onClose();
              }}
              title="节点与分身管理"
              aria-label="节点与分身管理"
              className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
            >
              <Server className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenSettings();
                onClose();
              }}
              title="系统设置"
              aria-label="系统设置"
              className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
            >
              <Settings className="w-4 h-4" />
            </button>
            {activeSessionId && (
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭侧边栏"
                className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer lg:hidden"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        {/* 搜索：本地过滤 + 全局消息搜索（>= 2 字触发） */}
        <div className="px-3 pt-2.5 pb-2 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索对话或消息内容..."
              className="w-full h-9 pl-8 pr-7 text-xs bg-white dark:bg-zinc-950 border border-zinc-200/80 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:border-zinc-400 dark:focus:border-zinc-600 transition-all"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded transition-colors cursor-pointer"
                aria-label="清除搜索"
              >
                {searching ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <X className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Section 2: 角色分身快捷区 */}
        <div className="px-3 pb-2 shrink-0">
          <div className="text-[11px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-500 px-1 pb-1.5">
            角色分身
          </div>
          {filteredPrimaryBots.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-zinc-400 dark:text-zinc-500">
              {query ? '未找到匹配的分身' : '暂无可用分身，先到「节点与分身管理」创建'}
            </p>
          ) : filteredPrimaryBots.length <= 4 ? (
            <div className="grid grid-cols-2 gap-1.5">
              {filteredPrimaryBots.map((bot) => {
                const currentDirect = currentDirectByBot.get(bot.id);
                return (
                  <PersonaPill
                    key={bot.id}
                    bot={bot}
                    wide
                    active={!!currentDirect && currentDirect.id === activeSessionId}
                    running={isBotRunning(bot.id)}
                    online={nodeMap.get(bot.nodeId)?.status === 'online'}
                    subagentCount={(subagentsByParentId.get(bot.id) || []).length}
                    onClick={() => {
                      openBot(bot);
                      onClose();
                    }}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
              {filteredPrimaryBots.map((bot) => {
                const currentDirect = currentDirectByBot.get(bot.id);
                return (
                  <PersonaPill
                    key={bot.id}
                    bot={bot}
                    wide={false}
                    active={!!currentDirect && currentDirect.id === activeSessionId}
                    running={isBotRunning(bot.id)}
                    online={nodeMap.get(bot.nodeId)?.status === 'online'}
                    subagentCount={(subagentsByParentId.get(bot.id) || []).length}
                    onClick={() => {
                      openBot(bot);
                      onClose();
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Section 3 + 4: 统一最近协同列表（含安静折叠区） */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {/* 全局消息搜索结果 */}
          {searchActive && (
            <SearchHitsBlock
              hits={searchHits}
              searching={searching}
              done={searchDone}
              query={filter}
              onSelect={(sessionId, messageId) => handleSelect(sessionId, messageId)}
            />
          )}

          {/* 列表头：标题 + 批量管理开关 */}
          <div className="flex items-center px-2 py-1">
            <span className="text-[11px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-500">
              最近协同
            </span>
            <span className="ml-1 text-[11px] text-zinc-400 dark:text-zinc-500 font-normal">
              · {visibleSessions.length}
            </span>
            {onDeleteSessions && visibleSessions.length > 0 && (
              <button
                type="button"
                onClick={() => toggleMultiSelect()}
                aria-pressed={multiSelectOn}
                title={multiSelectOn ? '退出批量管理' : '批量管理会话'}
                className={`ml-auto p-1 rounded-md transition-colors cursor-pointer shrink-0 ${
                  multiSelectOn
                    ? 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40'
                    : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                <ListChecks className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* 过滤胶囊栏 */}
          {showPillBar && !multiSelectOn && (
            <div className="flex gap-1 px-1 pb-1.5 overflow-x-auto">
              <button
                type="button"
                onClick={() => setInboxFilter('all')}
                className={pillClass(inboxFilter === 'all')}
              >
                全部
              </button>
              {showAttentionPill && (
                <button
                  type="button"
                  onClick={() => setInboxFilter('attention')}
                  className={pillClass(inboxFilter === 'attention')}
                >
                  运行中/待看 ({attentionCount})
                </button>
              )}
              {showSpacePill && (
                <button
                  type="button"
                  onClick={() => setInboxFilter('space')}
                  className={pillClass(inboxFilter === 'space')}
                >
                  按项目 Space
                </button>
              )}
            </div>
          )}

          {/* 批量操作栏 */}
          {multiSelectOn && (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 mb-1 rounded-lg bg-zinc-100/70 dark:bg-zinc-800/60">
              <button
                type="button"
                onClick={toggleSelectAllVisible}
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
              >
                {allVisibleSelected ? (
                  <CheckSquare className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                ) : (
                  <Square className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                )}
                <span>{allVisibleSelected ? '取消全选' : '全选'}</span>
              </button>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                  已选 {selectedIds.size} 项
                </span>
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

          {/* 会话列表主体 */}
          {visibleSessions.length === 0 ? (
            <div className="py-8 px-4 text-center">
              <MessageSquare className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                {query ? '未找到匹配的会话' : '暂无会话，点击上方分身即可开始'}
              </p>
            </div>
          ) : inboxFilter === 'space' ? (
            <div className="space-y-1">
              {spaceView.sections.map(({ group, visible }) => {
                const open = !collapsedSpaces.has(group.path) || !!query;
                return (
                  <div key={group.path}>
                    <button
                      type="button"
                      onClick={() => toggleSpaceCollapse(group.path)}
                      aria-expanded={open}
                      title={group.path}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 transition-colors cursor-pointer"
                    >
                      <FolderGit2 className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{group.name}</span>
                      <span className="font-normal text-zinc-400 dark:text-zinc-500">
                        · {visible.length}
                      </span>
                      <AttentionDot level={group.topAttention} />
                      <ChevronDown
                        className={`w-3.5 h-3.5 ml-auto shrink-0 text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${
                          open ? '' : '-rotate-90'
                        }`}
                      />
                    </button>
                    {open && <div className="space-y-0.5">{visible.map((s) => renderSessionRow(s))}</div>}
                  </div>
                );
              })}
              {spaceView.ungrouped.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500">
                    <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                    <span>未分组</span>
                    <span className="font-normal">· {spaceView.ungrouped.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {spaceView.ungrouped.map((s) => renderSessionRow(s))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-0.5">{unifiedSessions.map((s) => renderSessionRow(s))}</div>
          )}

          {/* Section 4: 安静折叠区 */}
          {childSessions.length > 0 && (
            <QuietSection
              icon={<Bot className="w-3.5 h-3.5" />}
              label="子代理任务"
              count={childSessions.length}
              open={effectiveChildrenOpen}
              onToggle={() => setChildrenOpen((v) => !v)}
            >
              {childSessions.map((session) => (
                <ChildSessionRow
                  key={session.id}
                  session={session}
                  leadBot={botsById.get(session.leadBotId)}
                  isActive={session.id === activeSessionId}
                  attention={attentionOf(session)}
                  unread={unreadCounts[session.id] ?? 0}
                  onSelect={() => handleSelect(session.id)}
                />
              ))}
            </QuietSection>
          )}

          {archivedSessions.length > 0 && (
            <QuietSection
              icon={<Archive className="w-3.5 h-3.5" />}
              label="已归档"
              count={archivedSessions.length}
              open={effectiveArchivedOpen}
              onToggle={() => setArchivedOpen((v) => !v)}
            >
              {archivedSessions.map((session) => renderSessionRow(session, true))}
            </QuietSection>
          )}
        </div>

        {/* Section 5: 底部用户条 */}
        <div className="shrink-0 border-t border-zinc-200/80 dark:border-zinc-800/80 px-2 py-2 pb-safe">
          <div className="flex items-center gap-1 min-w-0">
            {currentUser && (
              <div className="flex items-center gap-2 min-w-0 flex-1 px-1.5 py-1">
                <div className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-center text-zinc-600 dark:text-zinc-300 shrink-0">
                  <User className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    {currentUser.username}
                  </span>
                  <span className="block text-[10px] text-zinc-400 dark:text-zinc-500">
                    {currentUser.role === 'admin' ? '管理员' : '成员'}
                  </span>
                </div>
              </div>
            )}
            <div className={`flex items-center gap-0.5 shrink-0 ${currentUser ? '' : 'ml-auto'}`}>
              {currentUser?.role === 'admin' && onOpenUsers && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenUsers();
                    onClose();
                  }}
                  title="用户管理"
                  aria-label="用户管理"
                  className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                >
                  <UserCog className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={toggleSound}
                title="新消息提示音"
                aria-pressed={soundOn}
                className={`p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors cursor-pointer ${
                  soundOn ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400 dark:text-zinc-500'
                }`}
              >
                {soundOn ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
              </button>
              <ThemeToggle />
              <button
                type="button"
                onClick={onLogout}
                title="退出登录"
                aria-label="退出登录"
                className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50/60 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
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

      {/* 批量删除会话二次确认 */}
      <ConfirmDialog
        isOpen={batchConfirmOpen}
        title="批量删除会话"
        message={
          <>
            确定要删除已选的 {selectedIds.size} 个会话吗？
            <br />
            这些会话的全部历史消息将被永久移除，此操作不可恢复。运行中的会话会被自动跳过。
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
