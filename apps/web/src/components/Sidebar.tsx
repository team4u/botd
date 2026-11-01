import React, { useMemo, useState } from 'react';
import {
  MessageSquare,
  Users,
  Server,
  Settings,
  LogOut,
  X,
  Search,
  Bot,
  Radio,
  Trash2,
  ChevronDown,
  Archive,
  UserCog,
  User,
  ShieldCheck,
} from 'lucide-react';
import type { SessionRecord, BotConfig, NodeRecord } from '@botd/protocol';
import type { UserInfo } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

interface SidebarProps {
  sessions: SessionRecord[];
  bots: BotConfig[];
  nodeMap: Map<string, NodeRecord>;
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onOpenBotChat: (bot: BotConfig) => void;
  onCreateGroup: () => void;
  onOpenNodesView: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
  onDeleteSession: (id: string) => Promise<void> | void;
  isOpen: boolean;
  onClose: () => void;
  currentUser?: UserInfo;
  onOpenUsers?: () => void;
}

/**
 * 选取某个 bot「当前」的单聊会话：
 * 在 mode === 'direct'、未归档、成员仅含该 bot 的会话中，取 updatedAt 最新的一个。
 * 通讯录指向、active 高亮、「历史话题」分类与 App 的 handleOpenBotChat 共用此规则，避免逻辑漂移。
 */
export function pickCurrentDirectSession(
  sessions: SessionRecord[],
  botId: string
): SessionRecord | undefined {
  let latest: SessionRecord | undefined;
  let latestTime = -Infinity;
  for (const s of sessions) {
    if (s.mode !== 'direct' || s.archived) continue;
    const members = s.memberBotIds || [];
    if (members.length !== 1 || members[0] !== botId) continue;
    const time = new Date(s.updatedAt).getTime();
    if (Number.isFinite(time) && time > latestTime) {
      latest = s;
      latestTime = time;
    }
  }
  return latest;
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

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  bots,
  nodeMap,
  activeSessionId,
  onSelectSession,
  onOpenBotChat,
  onCreateGroup,
  onOpenNodesView,
  onOpenSettings,
  onLogout,
  onDeleteSession,
  isOpen,
  onClose,
  currentUser,
  onOpenUsers,
}) => {
  const [filter, setFilter] = useState('');
  const [botsOpen, setBotsOpen] = useState(true);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const query = filter.trim().toLowerCase();

  // 搜索时强制展开各分区，保证结果可见
  const effectiveBotsOpen = botsOpen || !!query;
  const effectiveGroupsOpen = groupsOpen || !!query;
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

  // 分区 2：群聊（非单聊且未归档）
  const groupSessions = useMemo(
    () => sessions.filter((s) => s.mode !== 'direct' && !s.archived && sessionMatchesQuery(s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, query]
  );

  // 分区 3：历史话题 = 已归档会话 + 非当前的单聊会话，按活跃时间倒序
  const historySessions = useMemo(() => {
    const timeOf = (s: SessionRecord) => new Date(s.lastMessageAt ?? s.updatedAt).getTime() || 0;
    return sessions
      .filter(
        (s) =>
          (s.archived || (s.mode === 'direct' && !currentDirectIds.has(s.id))) &&
          sessionMatchesQuery(s)
      )
      .sort((a, b) => timeOf(b) - timeOf(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, currentDirectIds, query]);

  const isAllEmpty = filteredBots.length === 0 && groupSessions.length === 0 && historySessions.length === 0;

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

        {/* Action Buttons：单聊走左侧通讯录直接点击，这里只保留新建群聊 */}
        <div className="p-3 border-b border-zinc-200/60 dark:border-zinc-800/60 shrink-0">
          <button
            onClick={() => {
              onCreateGroup();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-1.5 py-2 px-2.5 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 rounded-xl text-xs font-medium transition-colors shadow-xs cursor-pointer"
          >
            <Users className="w-3.5 h-3.5" />
            <span>新建群聊</span>
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
              placeholder="搜索智能体与会话..."
              className="w-full pl-8 pr-3 py-1.5 text-base sm:text-xs bg-white dark:bg-zinc-950 border border-zinc-200/80 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:border-zinc-400 dark:focus:border-zinc-600 transition-all"
            />
          </div>
        </div>

        {/* 三分区列表：智能体 / 群聊 / 历史话题 */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
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
                {filteredBots.map((bot) => {
                  const currentDirect = currentDirectByBot.get(bot.id);
                  const isActive = !!currentDirect && currentDirect.id === activeSessionId;
                  const isRunning = currentDirect?.status === 'running';
                  const node = nodeMap.get(bot.nodeId);
                  const isOnline = node?.status === 'online';

                  return (
                    <div
                      key={bot.id}
                      role="button"
                      tabIndex={0}
                      title={`@${bot.id}`}
                      onClick={() => {
                        onOpenBotChat(bot);
                        onClose();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onOpenBotChat(bot);
                          onClose();
                        }
                      }}
                      className={`group w-full text-left p-2 rounded-xl text-xs transition-all flex items-center gap-2 border cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                        isActive
                          ? 'bg-zinc-900 border-zinc-900 shadow-xs dark:bg-zinc-100 dark:border-zinc-100'
                          : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent'
                      }`}
                    >
                      {/* 圆角方块图标 */}
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border transition-colors ${
                          isActive
                            ? 'bg-zinc-800 border-zinc-700 text-zinc-100 dark:bg-zinc-200 dark:border-zinc-300 dark:text-zinc-800'
                            : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200/80 dark:border-zinc-800/80 text-zinc-600 dark:text-zinc-300'
                        }`}
                      >
                        <Bot className="w-4 h-4" />
                      </div>

                      {/* 名称 + @id / 节点名 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`truncate font-semibold ${
                              isActive ? 'text-white dark:text-zinc-900' : 'text-zinc-900 dark:text-zinc-100'
                            }`}
                          >
                            {bot.name}
                          </span>
                          <span
                            className={`truncate font-mono text-[10px] ${
                              isActive ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-400 dark:text-zinc-500'
                            }`}
                          >
                            @{bot.id}
                          </span>
                        </div>
                        <div
                          className={`truncate text-[11px] ${
                            isActive ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-400 dark:text-zinc-500'
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
                  );
                })}
              </div>
            )}
          </section>

          {/* 分区 2：群聊 */}
          {groupSessions.length > 0 && (
            <section>
              <SectionHeader
                label="群聊"
                count={groupSessions.length}
                open={effectiveGroupsOpen}
                onToggle={() => setGroupsOpen((v) => !v)}
              />
              {effectiveGroupsOpen && (
                <div className="space-y-1">
                  {groupSessions.map((session) => {
                    const isActive = session.id === activeSessionId;
                    const isRunning = session.status === 'running';
                    const isFailed = session.status === 'failed';

                    const modeText =
                      session.mode === 'direct'
                        ? '单聊'
                        : session.mode === 'lead'
                        ? '主持'
                        : '圆桌';

                    const relativeTime = formatRelativeTime(session.lastMessageAt ?? session.updatedAt);

                    return (
                      <div
                        key={session.id}
                        role="button"
                        tabIndex={0}
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
                        className={`group w-full text-left p-2.5 rounded-xl text-xs transition-all flex flex-col gap-1 border cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                          isActive
                            ? 'bg-zinc-900 text-white border-zinc-900 shadow-xs dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                            : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent text-zinc-700 dark:text-zinc-300'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1 w-full">
                          <div className="flex items-center gap-1.5 truncate">
                            {session.mode === 'direct' ? (
                              <Bot
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isActive ? 'text-zinc-300 dark:text-zinc-600' : 'text-zinc-500 dark:text-zinc-400'
                                }`}
                              />
                            ) : session.mode === 'lead' ? (
                              <Users
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isActive ? 'text-zinc-300 dark:text-zinc-600' : 'text-zinc-500 dark:text-zinc-400'
                                }`}
                              />
                            ) : (
                              <Radio
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isActive ? 'text-zinc-300 dark:text-zinc-600' : 'text-zinc-500 dark:text-zinc-400'
                                }`}
                              />
                            )}
                            <span
                              className={`truncate font-medium ${
                                isActive ? 'text-white dark:text-zinc-900' : 'text-zinc-900 dark:text-zinc-100'
                              }`}
                            >
                              {session.title}
                            </span>
                          </div>

                          {/* 状态圆点：hover 时让位给删除按钮 */}
                          <div className="w-4 h-4 flex items-center justify-center shrink-0">
                            {isRunning ? (
                              <span
                                className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-dot group-hover:hidden"
                                title="运行中"
                              />
                            ) : isFailed ? (
                              <span
                                className="w-2 h-2 rounded-full bg-rose-500 group-hover:hidden"
                                title="执行异常"
                              />
                            ) : null}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(session);
                              }}
                              className="hidden group-hover:flex group-focus-within:flex items-center justify-center w-4 h-4 text-zinc-400 dark:text-zinc-400 hover:text-rose-500 dark:hover:text-rose-400 transition-colors cursor-pointer"
                              aria-label={`删除会话 ${session.title}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        <div
                          className={`flex items-center justify-between gap-2 text-[11px] ${
                            isActive ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-400 dark:text-zinc-500'
                          }`}
                        >
                          <span className="truncate">
                            {session.lastMessagePreview || `${modeText} · @${session.leadBotId}`}
                          </span>
                          {relativeTime && (
                            <span className="shrink-0 text-[10px] opacity-75">{relativeTime}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* 分区 3：历史话题（归档会话 + 非当前单聊），默认折叠 */}
          {historySessions.length > 0 && (
            <section>
              <SectionHeader
                label="历史话题"
                count={historySessions.length}
                open={effectiveHistoryOpen}
                onToggle={() => setHistoryOpen((v) => !v)}
              />
              {effectiveHistoryOpen && (
                <div className="space-y-0.5">
                  {historySessions.map((session) => {
                    const isActive = session.id === activeSessionId;
                    const relativeTime = formatRelativeTime(session.lastMessageAt ?? session.updatedAt);

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
                            ? 'bg-zinc-900 border-zinc-900 shadow-xs dark:bg-zinc-100 dark:border-zinc-100'
                            : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 border-transparent'
                        }`}
                      >
                        <Archive
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isActive ? 'text-zinc-300 dark:text-zinc-600' : 'text-zinc-500 dark:text-zinc-400'
                          }`}
                        />
                        <span
                          className={`truncate ${
                            isActive ? 'text-white dark:text-zinc-900' : 'text-zinc-700 dark:text-zinc-300'
                          }`}
                        >
                          {session.title}
                        </span>
                        {relativeTime && (
                          <span
                            className={`ml-auto shrink-0 text-[10px] ${
                              isActive ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-400 dark:text-zinc-500'
                            }`}
                          >
                            {relativeTime}
                          </span>
                        )}
                        <div className="w-4 h-4 flex items-center justify-center shrink-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(session);
                            }}
                            className="hidden group-hover:flex group-focus-within:flex items-center justify-center w-4 h-4 text-zinc-400 dark:text-zinc-400 hover:text-rose-500 dark:hover:text-rose-400 transition-colors cursor-pointer"
                            aria-label={`删除历史话题 ${session.title}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
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
                    className={`inline-flex items-center gap-0.5 shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${
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
    </>
  );
};
