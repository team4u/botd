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
  Plus,
  Zap,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { SessionRecord, BotConfig, NodeRecord, UserRecord } from '@botd/protocol';
import type { MessageSearchHit } from '@botd/protocol';
import { ConfirmDialog } from './ConfirmDialog.js';
import ThemeToggle from './ThemeToggle.js';
import { api } from '../api.js';
import {
  getSessionAttention,
  ATTENTION_VISUALS,
  resolveSessionWorkspaceDir,
  buildSpaceGroups,
  buildAssistantEntries,
  buildActivePulseEntries,
  activityTimeOf,
  type SessionAttentionLevel,
} from '../session-space.js';

/** 并行话题一键创建的上下文输入 */
interface ParallelTopicContext {
  leadBotId: string;
  workspaceDir?: string;
  title?: string;
}

interface SidebarProps {
  sessions: SessionRecord[];
  bots: BotConfig[];
  nodeMap: Map<string, NodeRecord>;
  activeSessionId: string | null;
  onSelectSession: (id: string, messageId?: string) => void;
  onOpenBotChat: (bot: BotConfig) => void;
  onOpenNodesView: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
  onDeleteSession: (id: string) => Promise<void> | void;
  /** 批量删除会话（批量管理） */
  onDeleteSessions?: (ids: string[]) => Promise<void> | void;
  /** sessionId -> 未读消息数（可选，缺省视为全部为 0） */
  unreadCounts?: Record<string, number>;
  /** 归档/恢复会话 */
  onSetArchived?: (sessionId: string, archived: boolean) => void;
  isOpen: boolean;
  onClose: () => void;
  currentUser?: UserRecord;
  onOpenUsers?: () => void;
  /** 打开新建会话弹窗（SPACES 头部「+」） */
  onOpenCreateModal?: () => void;
  /** 在指定 Space 或分身名下一键创建并行话题（不归档旧会话） */
  onCreateParallelTopic?: (context: ParallelTopicContext) => Promise<void> | void;
}

/**
 * 选取某个 bot「当前」的单聊会话：
 * 在未归档、主控为该 bot 的会话中，取 updatedAt 最新的一个。
 * 分身快捷入口、active 高亮与 App 的 handleOpenBotChat 共用此规则，避免逻辑漂移。
 */
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

/** 分身/会话导航图标：Zinc 单色线性 Bot 符号，选中态反转呼应品牌标；离线由行级降透明度表达 */
export const BotTile: React.FC<{
  className?: string;
  iconClassName?: string;
  active?: boolean;
}> = ({ className = '', iconClassName = 'w-3.5 h-3.5', active = false }) => (
  <span
    aria-hidden="true"
    className={`rounded-md border flex items-center justify-center shrink-0 transition-colors ${
      active
        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-zinc-900 dark:border-zinc-100'
        : 'bg-zinc-100 dark:bg-zinc-800/90 border-zinc-200/80 dark:border-zinc-700/80 text-zinc-500 dark:text-zinc-400'
    } ${className}`}
  >
    <Bot className={iconClassName} />
  </span>
);

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

/** 会话行（Space 树内 / 活跃雷达 / 归档区）：紧凑单行，状态灯 / 胶囊 / 时间 / 未读 / 快捷菜单 */
const SessionRow: React.FC<{
  session: SessionRecord;
  botsById: Map<string, BotConfig>;
  isActive: boolean;
  attention: SessionAttentionLevel;
  unread: number;
  batchMode: boolean;
  selected: boolean;
  dimmed?: boolean;
  treeConnector?: string | null;
  /** 容器归属前缀（雷达行用）：空间名或助理名，如 botd / 随手记 */
  contextLabel?: string | null;
  onSelect: () => void;
  onToggleSelect: () => void;
  onSetArchived?: (sessionId: string, archived: boolean) => void;
  onDelete: (session: SessionRecord) => void;
}> = ({
  session,
  botsById,
  isActive,
  attention,
  unread,
  batchMode,
  selected,
  dimmed = false,
  treeConnector = null,
  contextLabel = null,
  onSelect,
  onToggleSelect,
  onSetArchived,
  onDelete,
}) => {
  const relativeTime = formatRelativeTime(session.lastMessageAt ?? session.updatedAt);
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
      className={`group min-h-[40px] w-full text-left px-2 py-1.5 rounded-lg border transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 flex items-center gap-2 ${
        dimmed ? 'opacity-70 hover:opacity-100' : ''
      } ${
        batchMode && selected
          ? 'bg-blue-50/70 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/70'
          : isActive
            ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs'
            : 'border-transparent hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80'
      }`}
    >
      {treeConnector && (
        <span
          aria-hidden="true"
          className="shrink-0 w-3.5 font-mono text-[11px] leading-none text-zinc-300 dark:text-zinc-600 select-none"
        >
          {treeConnector}
        </span>
      )}
      {batchMode ? (
        selected ? (
          <CheckSquare className="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
        ) : (
          <Square className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
        )
      ) : (
        <AttentionDot level={attention} />
      )}

      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        {contextLabel && (
          <span
            className="shrink-0 font-mono text-[10px] text-zinc-400 dark:text-zinc-500 truncate max-w-[80px]"
            title={contextLabel}
          >
            {contextLabel}
          </span>
        )}
        <span
          className={`truncate text-[13px] font-semibold ${
            isActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-800 dark:text-zinc-200'
          }`}
        >
          {title}
        </span>
        {attention !== 'idle' && (
          <span
            className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
              ATTENTION_VISUALS[attention].pill
            }`}
          >
            {ATTENTION_VISUALS[attention].label}
          </span>
        )}
        <UnreadBadge count={unread} />
        {relativeTime && (
          <span className="ml-auto shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
            {relativeTime}
          </span>
        )}
      </div>

      {!batchMode && (
        <SessionItemMenu session={session} onSetArchived={onSetArchived} onDelete={onDelete} />
      )}
    </div>
  );
};

/** 子任务会话紧凑行：状态灯 + 标题 + 时间 + 未读 */
const ChildSessionRow: React.FC<{
  session: SessionRecord;
  isActive: boolean;
  attention: SessionAttentionLevel;
  unread: number;
  onSelect: () => void;
}> = ({ session, isActive, attention, unread, onSelect }) => {
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
      {attention !== 'idle' ? (
        <AttentionDot level={attention} />
      ) : (
        <span className="w-2 h-2 shrink-0" aria-hidden="true" />
      )}
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

const SIDEBAR_COLLAPSED_KEY = 'botd-sidebar-collapsed';
const SIDEBAR_MODE_KEY = 'botd-sidebar-mode';

/** 侧边栏场景模式：助理（纯通讯录）/ 编程（Spaces+雷达）/ 中枢（全局任务流） */
type SidebarMode = 'assistant' | 'coding' | 'pulse';

const readSidebarMode = (): SidebarMode => {
  try {
    const stored = localStorage.getItem(SIDEBAR_MODE_KEY);
    if (stored === 'assistant' || stored === 'coding' || stored === 'pulse') return stored;
  } catch {
    // localStorage 不可用时用默认值
  }
  return 'assistant';
};

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  bots,
  nodeMap,
  activeSessionId,
  onSelectSession,
  onOpenBotChat,
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
  onOpenCreateModal,
  onCreateParallelTopic,
}) => {
  const [filter, setFilter] = useState('');
  // 桌面端极客窄轨折叠（localStorage 持久化，移动端不受影响）
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // localStorage 不可用时静默忽略
      }
      return next;
    });
  };
  // 活跃雷达排序模式：priority（优先级）/ grouped（按容器分组）
  const [pulseSortMode, setPulseSortMode] = useState<'priority' | 'grouped'>('priority');
  // 场景模式（持久化）：assistant 纯通讯录 / coding 编程工作台 / pulse 全局脉冲
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(readSidebarMode);
  const changeSidebarMode = (mode: SidebarMode) => {
    setSidebarMode(mode);
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    } catch {
      // localStorage 不可用时静默忽略
    }
  };
  // 批量管理（归档区）：multiSelectOn 后整行切换勾选，配合批量删除栏
  const [multiSelectOn, setMultiSelectOn] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 安静折叠区：默认收起
  const [childrenOpen, setChildrenOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // 用户手动收起的 Space（Set<path>）；当前会话所在 Space 自动展开
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

  // ===== 数据派生：四大层次的数据源（全部纯函数 + memo） =====

  // 1. 活跃雷达：全局非 idle 会话（主会话 + 子代理任务）
  const activePulseEntries = useMemo(
    () => buildActivePulseEntries(sessions, bots, unreadCounts, pulseSortMode),
    [sessions, bots, unreadCounts, pulseSortMode]
  );

  // 2. 项目空间分组
  const spaceGroups = useMemo(() => {
    if (!query) return buildSpaceGroups(sessions, bots, unreadCounts);
    return buildSpaceGroups(sessions, bots, unreadCounts)
      .map((g) => ({
        ...g,
        sessions: g.sessions.filter(sessionMatchesQuery),
      }))
      .filter(
        (g) => g.sessions.length > 0 || g.name.toLowerCase().includes(query) || g.path.toLowerCase().includes(query)
      );
  }, [sessions, bots, unreadCounts, query, sessionMatchesQuery]);

  // 3. 个人助理通讯录
  const assistantEntries = useMemo(() => {
    const entries = buildAssistantEntries(sessions, bots, unreadCounts);
    if (!query) return entries;
    return entries.filter((entry) => {
      if (entry.bot.name.toLowerCase().includes(query) || entry.bot.id.toLowerCase().includes(query)) return true;
      if ((entry.lastMessagePreview || '').toLowerCase().includes(query)) return true;
      return entry.allActiveSessions.some(sessionMatchesQuery);
    });
  }, [sessions, bots, unreadCounts, query, sessionMatchesQuery]);

  // 4. 安静折叠区：子任务 + 已归档
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

  // 批量管理作用域：已归档区可见会话
  const visibleSessions = archivedSessions;

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

  // 切入某个 Space 的会话时清除其收起标记，保证当前所在 Space 自动展开
  useEffect(() => {
    if (!activeSessionId) return;
    const current = sessions.find((s) => s.id === activeSessionId);
    if (!current) return;
    const dir = resolveSessionWorkspaceDir(current, botsById);
    if (!dir) return;
    setCollapsedSpaces((prev) => {
      if (!prev.has(dir)) return prev;
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });
  }, [activeSessionId, sessions, botsById]);

  const onlineNodes = useMemo(
    () => [...nodeMap.values()].filter((n) => n.status === 'online').length,
    [nodeMap]
  );

  const renderSessionRow = (
    session: SessionRecord,
    dimmed = false,
    treeConnector: string | null = null
  ) => (
    <SessionRow
      key={session.id}
      session={session}
      botsById={botsById}
      isActive={session.id === activeSessionId}
      attention={attentionOf(session)}
      unread={unreadCounts[session.id] ?? 0}
      batchMode={multiSelectOn}
      selected={selectedIds.has(session.id)}
      dimmed={dimmed}
      treeConnector={treeConnector}
      onSelect={() => handleSelect(session.id)}
      onToggleSelect={() => toggleSelectOne(session.id)}
      onSetArchived={onSetArchived}
      onDelete={setDeleteTarget}
    />
  );

  // ===== 桌面端极客窄轨视图（collapsed === true） =====
  if (collapsed) {
    return (
      <aside
        className="hidden lg:flex lg:w-14 flex-col inset-y-0 left-0 z-40 bg-zinc-50/95 dark:bg-zinc-900/95 backdrop-blur-md border-r border-zinc-200/80 dark:border-zinc-800/80 static shrink-0"
        aria-label="侧边会话导航（窄轨）"
      >
        {/* 顶部：展开按钮（有活跃脉冲时带提示点） */}
        <div className="h-14 flex items-center justify-center border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <button
            type="button"
            onClick={toggleCollapsed}
            title="展开侧边栏"
            aria-label="展开侧边栏"
            className="relative w-9 h-9 flex items-center justify-center rounded-xl text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <PanelLeftOpen className="w-4.5 h-4.5" />
            {activePulseEntries.length > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            )}
          </button>
        </div>

        {/* 上半部：Spaces 紧凑图标列 */}
        <div className="flex-1 overflow-y-auto px-2 pt-2 space-y-1.5">
          {spaceGroups.map((group) => {
            const isActiveSpace = group.sessions.some((s) => s.id === activeSessionId);
            const latest = group.sessions[0];
            return (
              <button
                key={group.path}
                type="button"
                title={`${group.name} · ${group.path}${group.sessions.length > 0 ? ` · ${group.sessions.length} 任务` : ''}`}
                onClick={() => {
                  if (latest) handleSelect(latest.id);
                  else if (group.botIds[0] && onCreateParallelTopic)
                    void onCreateParallelTopic({ leadBotId: group.botIds[0], workspaceDir: group.path });
                }}
                className={`relative w-10 h-10 mx-auto rounded-xl border flex items-center justify-center font-bold text-sm transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                  isActiveSpace
                    ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs text-zinc-900 dark:text-zinc-100'
                    : 'bg-white/70 dark:bg-zinc-900/70 border-zinc-200/80 dark:border-zinc-800/80 hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 text-zinc-600 dark:text-zinc-300'
                }`}
              >
                {group.name.charAt(0).toUpperCase() || '/'}
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-50 dark:border-zinc-900 ${
                    group.topAttention !== 'idle' ? ATTENTION_VISUALS[group.topAttention].dot : 'bg-zinc-300 dark:bg-zinc-600'
                  }`}
                />
              </button>
            );
          })}
        </div>

        {/* 分割线 */}
        <div className="mx-3 my-1 border-t border-zinc-200/80 dark:border-zinc-800/80 shrink-0" />

        {/* 下半部：Assistants 紧凑头像列 */}
        <div className="flex-1 max-h-[45%] overflow-y-auto px-2 pb-2 space-y-1.5">
          {assistantEntries.map((entry) => {
            const isActiveAssistant =
              !!entry.currentSession && entry.currentSession.id === activeSessionId;
            const nodeOnline = nodeMap.get(entry.bot.nodeId)?.status === 'online';
            const running = entry.allActiveSessions.some((s) => s.status === 'running');
            const dotClass = running
              ? 'bg-blue-500 animate-pulse'
              : entry.topAttention !== 'idle'
                ? ATTENTION_VISUALS[entry.topAttention].dot
                : nodeOnline
                  ? 'bg-emerald-500'
                  : 'bg-zinc-300 dark:bg-zinc-600';
            return (
              <button
                key={entry.bot.id}
                type="button"
                title={`@${entry.bot.id}`}
                onClick={() => {
                  if (entry.currentSession) handleSelect(entry.currentSession.id);
                  else {
                    onOpenBotChat(entry.bot);
                    onClose();
                  }
                }}
                className={`relative w-10 h-10 mx-auto rounded-xl border transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                  isActiveAssistant
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-zinc-900 dark:border-zinc-100 shadow-xs'
                    : 'bg-zinc-100 dark:bg-zinc-800/90 text-zinc-500 dark:text-zinc-400 border-zinc-200/80 dark:border-zinc-700/80 hover:bg-zinc-200/80 dark:hover:bg-zinc-800'
                }`}
              >
                <Bot className="w-4.5 h-4.5" />
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-50 dark:border-zinc-900 ${dotClass}`}
                />
                {entry.unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-semibold rounded-full min-w-[14px] h-3.5 px-0.5 flex items-center justify-center pointer-events-none">
                    {entry.unreadCount > 9 ? '9+' : entry.unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 底部：节点管理 / 设置 / 主题 */}
        <div className="shrink-0 border-t border-zinc-200/80 dark:border-zinc-800/80 py-2 flex flex-col items-center gap-0.5">
          <button
            type="button"
            onClick={onOpenNodesView}
            title="节点与分身管理"
            aria-label="节点与分身管理"
            className="w-9 h-9 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
          >
            <Server className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="系统设置"
            aria-label="系统设置"
            className="w-9 h-9 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
          >
            <Settings className="w-4 h-4" />
          </button>
          <ThemeToggle />
        </div>
      </aside>
    );
  }

  const pulseSortButton = (mode: 'priority' | 'grouped', label: string) => (
    <button
      type="button"
      onClick={() => setPulseSortMode(mode)}
      title={mode === 'priority' ? '按注意力优先级排序' : '按容器分组排序'}
      className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer shrink-0 ${
        pulseSortMode === mode
          ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
          : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
      }`}
    >
      {label}
    </button>
  );

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
              onClick={() => onOpenCreateModal?.()}
              title="新建会话"
              aria-label="新建会话"
              className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
            </button>
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
            <button
              type="button"
              onClick={toggleCollapsed}
              title="折叠为窄轨"
              aria-label="折叠为窄轨"
              className="hidden lg:inline-flex p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
            >
              <PanelLeftClose className="w-4 h-4" />
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

        {/* 场景正交切换器：三段式（助理 / 编程 / 中枢），持久化到 localStorage */}
        <div className="px-3 pt-2.5 shrink-0">
          <div className="flex items-center gap-0.5 p-0.5 bg-zinc-200/60 dark:bg-zinc-800/60 rounded-lg" role="tablist" aria-label="侧边栏场景模式">
            {([
              { mode: 'assistant', label: '助理', title: '个人助理通讯录：纯净日常对话，零工程噪音', icon: <MessageSquare className="w-3 h-3" /> },
              { mode: 'coding', label: '编程', title: '编程工作台：项目空间 + 智能体实时状态', icon: <FolderGit2 className="w-3 h-3" /> },
              { mode: 'pulse', label: '中枢', title: '全局脉冲：跨项目活跃任务流与归档管理', icon: <Zap className="w-3 h-3" /> },
            ] as const).map(({ mode, label, title, icon }) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={sidebarMode === mode}
                title={title}
                onClick={() => changeSidebarMode(mode)}
                className={`flex-1 h-7 inline-flex items-center justify-center gap-1 text-[11px] font-medium rounded-md transition-all cursor-pointer ${
                  sidebarMode === mode
                    ? 'bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                }`}
              >
                {icon}
                <span>{label}</span>
              </button>
            ))}
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
              placeholder="搜索项目、助理或消息..."
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

        {/* 可滚动主体区：活跃雷达 / 项目空间 / 个人助理 / 安静折叠区 */}
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

          {/* ===== 1. 活跃雷达（ACTIVE）：编程模式下常驻下半区；中枢模式主体展示 ===== */}
          {(sidebarMode === 'coding' || sidebarMode === 'pulse') && activePulseEntries.length > 0 && (
            <section className="mb-2 shrink-0">
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-500 animate-pulse shrink-0" />
                <span className="text-[11px] font-semibold tracking-wide text-zinc-500 dark:text-zinc-400">
                  活跃任务
                </span>
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-normal">
                  · {activePulseEntries.length}
                </span>
                <span className="ml-auto flex items-center gap-0.5 shrink-0">
                  {pulseSortButton('priority', '优先级')}
                  {pulseSortButton('grouped', '按空间')}
                </span>
              </div>
              <div className="space-y-0.5">
                {activePulseEntries.map((entry) => (
                  <SessionRow
                    key={entry.session.id}
                    session={entry.session}
                    botsById={botsById}
                    isActive={entry.session.id === activeSessionId}
                    attention={entry.attention}
                    unread={entry.unread}
                    batchMode={false}
                    selected={false}
                    contextLabel={entry.containerLabel}
                    onSelect={() => handleSelect(entry.session.id)}
                    onToggleSelect={() => handleSelect(entry.session.id)}
                    onSetArchived={onSetArchived}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ===== 2. 项目空间（SPACES）：编程/中枢模式展示，助理模式隐藏 ===== */}
          {(sidebarMode === 'coding' || sidebarMode === 'pulse') && (
          <section className="mb-2 shrink-0">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <FolderGit2 className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
              <span className="text-[11px] font-semibold tracking-wide text-zinc-500 dark:text-zinc-400">
                项目空间
              </span>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-normal">
                · {spaceGroups.length}
              </span>
              <button
                type="button"
                onClick={() => onOpenCreateModal?.()}
                title="新建项目会话"
                aria-label="新建项目会话"
                className="ml-auto p-1 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {spaceGroups.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
                {query ? '未找到匹配的项目空间' : '会话或分身绑定项目目录后自动归入此处'}
              </p>
            ) : (
              <div className="space-y-0.5">
                {spaceGroups.map((group) => {
                  // 当前会话属于该 Space 时自动展开（下方 effect 同步清除其收起标记）
                  const activeInSpace = group.sessions.some((s) => s.id === activeSessionId);
                  const isOpen = !!query || !collapsedSpaces.has(group.path);
                  return (
                    <div key={group.path}>
                      <div
                        className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-lg border transition-all cursor-pointer ${
                          activeInSpace
                            ? 'bg-zinc-100/70 dark:bg-zinc-800/70 border-zinc-200/70 dark:border-zinc-700/70'
                            : 'border-transparent hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSpaceCollapse(group.path)}
                          aria-expanded={isOpen}
                          title={group.path}
                          className="shrink-0 w-4 h-4 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer"
                        >
                          <ChevronDown
                            className={`w-3.5 h-3.5 transition-transform duration-200 ${
                              isOpen ? '' : '-rotate-90'
                            }`}
                          />
                        </button>
                        <FolderGit2 className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400 shrink-0" />
                        <button
                          type="button"
                          onClick={() => {
                            // 有会话直接切最新一条；只有绑定 Bot 无会话则在该 Space 下秒开新任务
                            const latest = group.sessions[0];
                            if (latest) handleSelect(latest.id);
                            else if (group.botIds[0]) {
                              if (onCreateParallelTopic)
                                void onCreateParallelTopic({
                                  leadBotId: group.botIds[0],
                                  workspaceDir: group.path,
                                });
                              else onOpenCreateModal?.();
                            }
                          }}
                          title={group.path}
                          className="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 rounded"
                        >
                          <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                            {group.name}
                          </span>
                          <span className="shrink-0 text-[10px] font-normal text-zinc-400 dark:text-zinc-500">
                            ({group.sessions.length})
                          </span>
                          <AttentionDot level={group.topAttention} />
                        </button>
                      </div>
                      {isOpen && (
                        <div className="space-y-0.5 pl-4">
                          {group.sessions.map((s, idx) =>
                            renderSessionRow(
                              s,
                              false,
                              idx === group.sessions.length - 1 ? '└─' : '├─'
                            )
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              const leadBotId =
                                group.sessions[0]?.leadBotId ||
                                group.botIds.find((id) => !botsById.get(id)?.parentBotId) ||
                                group.botIds[0];
                              if (!leadBotId) {
                                onOpenCreateModal?.();
                                return;
                              }
                              if (onCreateParallelTopic)
                                void onCreateParallelTopic({
                                  leadBotId,
                                  workspaceDir: group.path,
                                });
                              else onOpenCreateModal?.();
                            }}
                            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 transition-colors cursor-pointer"
                          >
                            <span aria-hidden="true" className="w-3.5 font-mono text-[11px] text-zinc-300 dark:text-zinc-600 select-none">
                              └─
                            </span>
                            <Plus className="w-3 h-3 shrink-0" />
                            <span className="truncate">在 {group.name} 中新建任务</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          )}{/* /项目空间（仅编程/中枢模式） */}

          {/* ===== 3. 个人助理（ASSISTANTS）：助理模式主体；编程模式隐藏纯闲聊 ===== */}
          {sidebarMode !== 'coding' && (
          <section className="mb-2 shrink-0">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <MessageSquare className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
              <span className="text-[11px] font-semibold tracking-wide text-zinc-500 dark:text-zinc-400">
                个人助理
              </span>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-normal">
                · {assistantEntries.length}
              </span>
              {onDeleteSessions && archivedSessions.length > 0 && (
                <button
                  type="button"
                  onClick={() => toggleMultiSelect()}
                  aria-pressed={multiSelectOn}
                  title={multiSelectOn ? '退出批量管理' : '批量管理归档会话'}
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
            {assistantEntries.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
                {query ? '未找到匹配的助理' : '暂无可用分身，先到「节点与分身管理」创建'}
              </p>
            ) : (
              <div className="space-y-0.5">
                {assistantEntries.map((entry) => {
                  const bot = entry.bot;
                  const nodeOnline = nodeMap.get(bot.nodeId)?.status === 'online';
                  const running = entry.allActiveSessions.some((s) => s.status === 'running');
                  // 状态点优先级：运行中蓝点呼吸 > 待验收/异常状态色 > 节点在线绿点 > 离线灰点
                  const dotClass = running
                    ? 'bg-blue-500 animate-pulse'
                    : entry.topAttention === 'failed' || entry.topAttention === 'done_unseen' || entry.topAttention === 'working'
                      ? ATTENTION_VISUALS[entry.topAttention].dot
                      : nodeOnline
                        ? 'bg-emerald-500'
                        : 'bg-zinc-300 dark:bg-zinc-600';
                  const dotTitle = running
                    ? '会话运行中'
                    : entry.topAttention !== 'idle'
                      ? ATTENTION_VISUALS[entry.topAttention].label
                      : nodeOnline
                        ? '节点在线'
                        : '节点离线';
                  const relativeTime = formatRelativeTime(
                    entry.currentSession?.lastMessageAt ??
                      entry.currentSession?.updatedAt ??
                      (entry.lastActivityAt > 0 ? new Date(entry.lastActivityAt).toISOString() : undefined)
                  );
                  const isActive =
                    !!entry.currentSession && entry.currentSession.id === activeSessionId;
                  const preview = entry.lastMessagePreview;
                  const idleOffline = !running && entry.topAttention === 'idle' && !nodeOnline;

                  return (
                    <div
                      key={bot.id}
                      role="button"
                      tabIndex={0}
                      title={`@${bot.id} · ${dotTitle}`}
                      onClick={() => {
                        // 点击直接切入该分身当前单聊，不存在则静默创建
                        if (entry.currentSession) handleSelect(entry.currentSession.id);
                        else {
                          onOpenBotChat(bot);
                          onClose();
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (entry.currentSession) handleSelect(entry.currentSession.id);
                          else {
                            onOpenBotChat(bot);
                            onClose();
                          }
                        }
                      }}
                      className={`group min-h-[44px] w-full text-left px-2 py-2 rounded-lg border transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 flex items-center gap-2.5 ${
                        idleOffline ? 'opacity-50 hover:opacity-100' : ''
                      } ${
                        isActive
                          ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300/70 dark:border-zinc-700/70 shadow-xs'
                          : 'border-transparent hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80'
                      }`}
                    >
                      <span className="relative shrink-0">
                        <BotTile active={isActive} className="w-6 h-6" />
                        <span
                          title={dotTitle}
                          className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-zinc-50 dark:border-zinc-900 ${dotClass}`}
                        />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5">
                          <span className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                            {bot.name}
                          </span>
                          {entry.subagentCount > 0 && (
                            <span
                              title={`${entry.subagentCount} 个子代理`}
                              className="shrink-0 text-[10px] font-medium text-zinc-400 dark:text-zinc-500"
                            >
                              +{entry.subagentCount}
                            </span>
                          )}
                          {relativeTime && (
                            <span className="ml-auto shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
                              {relativeTime}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                          {preview && (
                            <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400 flex-1">
                              {preview}
                            </span>
                          )}
                          {!preview && entry.directSessions.length > 1 && (
                            <span className="flex-1" aria-hidden="true" />
                          )}
                          <UnreadBadge count={entry.unreadCount} />
                          {entry.directSessions.length > 1 && (
                            <span
                              title={`${entry.directSessions.length} 个活跃话题`}
                              className="shrink-0 text-[10px] font-medium text-zinc-400 dark:text-zinc-500"
                            >
                              ×{entry.directSessions.length}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          )}{/* /个人助理（助理/中枢模式） */}

          {/* ===== 4. 安静折叠区：子代理任务（全模式）+ 已归档（中枢模式管理） ===== */}
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
              {archivedSessions.map((session) => renderSessionRow(session, true))}
            </QuietSection>
          )}

          {/* 全空态：按当前模式给出对应引导 */}
          {!query &&
            (sidebarMode !== 'coding' || spaceGroups.length === 0) &&
            (sidebarMode === 'coding' || assistantEntries.length === 0) &&
            childSessions.length === 0 &&
            archivedSessions.length === 0 && (
              <div className="py-8 px-4 text-center">
                <MessageSquare className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  {sidebarMode === 'coding'
                    ? '暂无项目空间，新建会话时绑定项目目录即可归入此处'
                    : '暂无会话，点击上方分身即可开始'}
                </p>
              </div>
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
