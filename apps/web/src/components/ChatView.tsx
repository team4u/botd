import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Menu,
  Users,
  Bot,
  Settings as SettingsIcon,
  Loader2,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Activity,
  MoreHorizontal,
  MessageSquarePlus,
  Pencil,
  Eraser,
  Trash2,
  ArrowDown,
  Check,
  X,
  Clock,
  Hourglass,
  Package,
  SquareTerminal,
  ChevronUp,
  Share2,
} from 'lucide-react';
import type {
  SessionRecord,
  MessageRecord,
  BotConfig,
  NodeRecord,
  MessageAttachment,
  PendingAskRecord,
} from '@botd/protocol';
import type { StreamingAssistantState } from '../types';
import { MessageItem, formatShortModel } from './MessageItem';
import { Markdown } from './Markdown';
import { ChatInput } from './ChatInput';
import { ConfirmDialog } from './ConfirmDialog';
import { AskCard } from './AskCard';
import { TriggersModal } from './TriggersModal';
import { ArtifactsDrawer } from './ArtifactsDrawer';
import { BgJobsDrawer } from './BgJobsDrawer';
import { ShareSessionModal } from './ShareSessionModal';
import { api } from '../api';
import { onGlobalEvent } from '../events';
import { useKeyboardInset } from '../utils/viewport';
import type { ToastItem } from '../types';

interface ChatViewProps {
  session: SessionRecord;
  messages: MessageRecord[];
  loadingMessages: boolean;
  loadError: string | null;
  onRetryLoad: () => void;
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  /** 各 BOT 的流式状态；多个成员同时运行时并排展示。 */
  streamingStates: StreamingAssistantState[];
  onSendMessage: (content: string, attachments?: MessageAttachment[]) => Promise<void>;
  onEditMessage: (sessionId: string, messageId: string, content: string) => Promise<void>;
  onCancelSession: () => Promise<void>;
  onOpenGroupSettings: () => void;
  onToggleSidebar: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<void> | void;
  onClearMessages: (sessionId: string) => Promise<void> | void;
  onDeleteSession: (sessionId: string) => Promise<void> | void;
  onNewTopic: (sessionId: string) => Promise<void> | void;
  /** 从指定消息（含）分叉出新会话并自动切换 */
  onForkMessage: (sessionId: string, messageId: string) => Promise<void>;
  cancelling: boolean;
  /** 当前会话待处理的人机协同交互请求（botd ask） */
  pendingAsks?: PendingAskRecord[];
  /** 响应人机协同交互请求 */
  onRespondToAsk?: (sessionId: string, askId: string, answer: string) => Promise<void>;
  /** 全局 toast 通知（供弹窗内部使用） */
  onAddToast?: (type: ToastItem['type'], message: string) => void;
  /** 是否还有更早的历史消息可加载（App 负责分页） */
  hasEarlierMessages?: boolean;
  /** 正在加载更早消息 */
  loadingEarlier?: boolean;
  /** 加载更早消息（App 负责 prepend） */
  onLoadEarlier?: () => void;
  /** 搜索跳转定位高亮的消息 id */
  highlightMessageId?: string | null;
}

export const ChatView: React.FC<ChatViewProps> = ({
  session,
  messages,
  loadingMessages,
  loadError,
  onRetryLoad,
  botMap,
  nodeMap,
  streamingStates,
  onSendMessage,
  onEditMessage,
  onCancelSession,
  onOpenGroupSettings,
  onToggleSidebar,
  onRenameSession,
  onClearMessages,
  onDeleteSession,
  onNewTopic,
  onForkMessage,
  cancelling,
  pendingAsks = [],
  onRespondToAsk,
  onAddToast,
  hasEarlierMessages = false,
  loadingEarlier = false,
  onLoadEarlier,
  highlightMessageId = null,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const keyboardInset = useKeyboardInset();

  // 本会话参会成员（提前声明：蓝点探测/SSE/群设置等多处使用）
  const memberBots: BotConfig[] = (session.memberBotIds || [])
    .map((id) => botMap.get(id))
    .filter((b): b is BotConfig => Boolean(b));

  // 头部更多操作菜单 / 行内重命名 / 清空与删除确认
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'clear' | 'delete' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // 定时与触发器弹窗开关
  const [triggersOpen, setTriggersOpen] = useState(false);
  // 分享对话弹窗开关
  const [shareModalOpen, setShareModalOpen] = useState(false);

  // 回到底部按钮触发的程序化平滑滚动标记，避免滚动动画的中间位置误触发 userScrolledUp
  const programmaticScrollRef = useRef(false);

  // ===== 历史消息向上分页：prepend 滚动锚定 =====
  // 点击「加载更早消息」前记录 scrollHeight 与首条消息 id；messages 变长后在
  // useLayoutEffect 里判定是否为顶部 prepend（首条消息 id 变化），是刚补偿 scrollHeight
  // 差值保证视口不跳，并置抑制标记让同一次 commit 的自动滚底 effect 跳过。
  const prevScrollHeightRef = useRef<number | null>(null);
  const prevFirstMessageIdRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(messages.length);
  const pendingPrependRef = useRef(false);

  const handleLoadEarlier = () => {
    if (loadingEarlier || !onLoadEarlier) return;
    const el = scrollContainerRef.current;
    if (el) prevScrollHeightRef.current = el.scrollHeight;
    prevFirstMessageIdRef.current = messages.length > 0 ? messages[0].id : null;
    pendingPrependRef.current = true;
    onLoadEarlier();
  };

  // IntersectionObserver 哨兵：列表顶部进入视口时自动触发加载（按钮仍是主入口）
  const earlierSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = earlierSentinelRef.current;
    if (!hasEarlierMessages || loadingEarlier || !onLoadEarlier || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) handleLoadEarlier();
      },
      { root: scrollContainerRef.current, rootMargin: '80px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasEarlierMessages, loadingEarlier, onLoadEarlier, messages.length]);

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    const grew = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (!pendingPrependRef.current || !el || !grew) return;
    // 仅当首条消息 id 变化才判定为 prepend（追加消息不改首条 id）
    const firstId = messages.length > 0 ? messages[0].id : null;
    const isPrepend = firstId !== prevFirstMessageIdRef.current;
    prevFirstMessageIdRef.current = firstId;
    if (!isPrepend) return;
    const prevHeight = prevScrollHeightRef.current;
    prevScrollHeightRef.current = null;
    if (prevHeight == null) return;
    // 补偿高度差：视口停在原消息位置；prepend 后必不在底部，确保回到底部按钮可见
    const delta = el.scrollHeight - prevHeight;
    if (delta > 0) {
      el.scrollTop += delta;
      setUserScrolledUp(true);
    }
  }, [messages.length]);

  // ===== 搜索跳转定位高亮 =====
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightMessageId) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-message-id="${highlightMessageId}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // 平滑滚动中间位置不触发 userScrolledUp 误判，结束后若不在底部再交回监听
    programmaticScrollRef.current = true;
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 800);
    setHighlightedId(highlightMessageId);
    const timer = window.setTimeout(() => setHighlightedId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [highlightMessageId]);

  // ===== 会话产物 / 后台任务抽屉 =====
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [bgJobsOpen, setBgJobsOpen] = useState(false);
  const [artifactsUnseen, setArtifactsUnseen] = useState(false);
  const [hasRunningBgJobs, setHasRunningBgJobs] = useState(false);

  // 切换会话时重置抽屉红点/蓝点标记
  useEffect(() => {
    setArtifactsUnseen(false);
    setHasRunningBgJobs(false);
  }, [session.id]);

  // 全局 SSE：本会话 artifact_created 且抽屉未开时置红点；新回调消息（后台任务完成）到达时
  // 重新探测 running 蓝点（callback 角色消息意味着任务状态可能已翻转）
  useEffect(() => {
    const unsubscribe = onGlobalEvent((e) => {
      if (e.type === 'artifact_created' && e.sessionId === session.id) {
        if (!artifactsOpenRef.current) setArtifactsUnseen(true);
      } else if (
        e.type === 'message_created' &&
        e.message.sessionId === session.id &&
        e.message.role === 'callback'
      ) {
        if (!bgJobsOpenRef.current) void probeRunningBgJobs();
      }
    });
    return unsubscribe;
  }, [session.id]);

  // 用 ref 避免订阅 effect 依赖抽屉开关导致反复重订阅
  const artifactsOpenRef = useRef(false);
  const bgJobsOpenRef = useRef(false);
  artifactsOpenRef.current = artifactsOpen;
  bgJobsOpenRef.current = bgJobsOpen;

  // 探测本会话是否存在 running 后台任务（用于顶栏蓝点）
  const memberNodeIds = useMemo(
    () =>
      [...new Set(memberBots.map((b) => b.nodeId).filter(Boolean))],
    [memberBots]
  );
  const probeRunningBgJobs = async () => {
    if (memberNodeIds.length === 0) return;
    const results = await Promise.allSettled(
      memberNodeIds.map((id) => api.listBgJobs(id, { sessionId: session.id }))
    );
    const running = results.some(
      (r) => r.status === 'fulfilled' && r.value.some((j) => j.status === 'running')
    );
    setHasRunningBgJobs(running);
  };

  // 会话打开/成员变化时探一次 running（轻量，仅顶栏蓝点用途）
  useEffect(() => {
    void probeRunningBgJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, memberNodeIds.join(',')]);

  // ===== 消息日期分隔线 =====
  // 相邻消息 createdAt 跨自然日时插入分隔条：今天/昨天/M月D日（同年省略年份，跨年带年份）
  const dayLabel = (iso: string): string => {
    const d = new Date(iso);
    const now = new Date();
    const sameCalendarDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameCalendarDay(d, now)) return '今天';
    if (sameCalendarDay(d, yesterday)) return '昨天';
    const sameYear = d.getFullYear() === now.getFullYear();
    return sameYear
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const sameDay = (a: string, b: string): boolean => {
    const da = new Date(a);
    const db = new Date(b);
    return (
      da.getFullYear() === db.getFullYear() &&
      da.getMonth() === db.getMonth() &&
      da.getDate() === db.getDate()
    );
  };

  // 自动滚动到底部
  const scrollToBottom = (smooth = true) => {
    if (userScrolledUp) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  useEffect(() => {
    scrollToBottom(false);
  }, [session.id]);

  const effectiveStreamingStates = streamingStates;
  const isParallelStreaming = effectiveStreamingStates.length > 1;

  useEffect(() => {
    // prepend 加载更早消息时不触发自动滚底（视口锚定由 useLayoutEffect 补偿）。
    // 注意：layout effect 先于本 effect 运行，此处消费标记（而非依赖它被清除前判断）
    if (pendingPrependRef.current) {
      pendingPrependRef.current = false;
      return;
    }
    scrollToBottom(true);
  }, [
    messages.length,
    effectiveStreamingStates.length,
    effectiveStreamingStates.map((s) => `${s.botId}:${s.delta.length}:${s.tools.length}`).join(','),
  ]);

  // 移动端软键盘联动：键盘弹起垫片高度变化时，若用户在底部则保持贴底可见
  useEffect(() => {
    if (!userScrolledUp) {
      scrollToBottom(false);
    }
  }, [keyboardInset, userScrolledUp]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (programmaticScrollRef.current) {
      // 平滑滚动动画进行中：到达底部后恢复监听，忽略中间位置
      if (isAtBottom) programmaticScrollRef.current = false;
      return;
    }
    setUserScrolledUp(!isAtBottom);
  };

  // 回到底部：先解除 userScrolledUp 守卫再平滑滚动，否则会被 scrollToBottom 的守卫拦截
  const handleJumpToBottom = () => {
    const el = scrollContainerRef.current;
    setUserScrolledUp(false);
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    // 兑底：万一滚动事件未触发，稍后自动恢复监听
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 800);
  };

  // 切换会话时重置头部交互状态
  useEffect(() => {
    setMenuOpen(false);
    setRenaming(false);
    setConfirmAction(null);
    setEditingMessage(null);
    setTriggersOpen(false);
  }, [session.id]);

  // 菜单展开时：点击外部或 ESC 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const startRename = () => {
    setMenuOpen(false);
    setRenameValue(session.title);
    setRenaming(true);
  };

  const cancelRename = () => {
    if (renameBusy) return;
    setRenaming(false);
  };

  const commitRename = async () => {
    const trimmed = renameValue.trim();
    if (renameBusy) return;
    if (!trimmed) return; // 空标题不允许提交
    if (trimmed === session.title) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    try {
      await onRenameSession(session.id, trimmed);
      setRenaming(false);
    } catch {
      // 失败时保持编辑态，错误提示由 App 层 toast 展示
    } finally {
      setRenameBusy(false);
    }
  };

  const handleConfirmAction = async () => {
    if (!confirmAction || actionBusy) return;
    setActionBusy(true);
    try {
      if (confirmAction === 'clear') {
        await onClearMessages(session.id);
      } else {
        await onDeleteSession(session.id);
      }
      setConfirmAction(null);
    } finally {
      setActionBusy(false);
    }
  };

  const isRunning = session.status === 'running';
  // 运行中禁止编辑用户消息（与后端 409 拦截对齐）
  const canEdit = session.status !== 'running';

  // Slack 式编辑：编辑态由底部 ChatInput 承载，此处仅持有编辑目标
  const [editingMessage, setEditingMessage] = useState<MessageRecord | null>(null);

  // 点击铅笔进入/切换编辑目标；运行中的会话忽略
  const startEdit = (msg: MessageRecord) => {
    if (session.status === 'running') return;
    setEditingMessage(msg);
  };

  // 防御：被编辑的消息已不在当前消息列表（如提交后被截断、清空消息）时自动退出编辑态
  useEffect(() => {
    if (!editingMessage) return;
    if (!messages.some((m) => m.id === editingMessage.id)) {
      setEditingMessage(null);
    }
  }, [messages, editingMessage]);

  // 提交编辑：成功后清除编辑态；失败由 onEditMessage rethrow，ChatInput 捕获后保持编辑态
  const handleSubmitEdit = async (content: string) => {
    if (!editingMessage) return;
    await onEditMessage(session.id, editingMessage.id, content);
    setEditingMessage(null);
  };

  // 单个流式 BOT 输出块（并发盲评网格内复用，风格与 MessageItem Assistant 一致）
  const renderStreamingBlock = (state: StreamingAssistantState) => {
    const bot = botMap.get(state.botId);
    const node = bot ? nodeMap.get(bot.nodeId) : undefined;
    const shortModel = formatShortModel(bot?.modelId);
    return (
      <div
        key={state.botId}
        className={
          isParallelStreaming
            ? 'p-3 bg-zinc-50/70 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 rounded-xl min-w-0'
            : 'px-3 sm:px-6 py-2.5 sm:py-3 animate-in fade-in'
        }
      >
        {/* 极简单行浅灰元数据 */}
        <div className="flex items-center gap-1.5 min-w-0 text-xs flex-wrap">
          <div className="w-5 h-5 rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-900/60 flex items-center justify-center shrink-0">
            <Bot className="w-3.5 h-3.5 animate-pulse" />
          </div>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {bot?.name || state.botId}
          </span>
          <span className="font-mono text-zinc-400 dark:text-zinc-500 text-[11px] shrink-0">
            @{state.botId}
          </span>
          {node && (
            <>
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate max-w-[120px] font-normal">
                {node.name}
              </span>
            </>
          )}
          {shortModel && (
            <>
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate max-w-[140px] font-normal">
                {shortModel}
              </span>
            </>
          )}
          <span className="text-zinc-300 dark:text-zinc-600">·</span>
          <span className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 font-medium shrink-0">
            <Activity className="w-3 h-3 animate-spin-fast" />
            <span>正在输出...</span>
          </span>
        </div>

        {/* 类似 Claude / Cursor 的紧凑工具状态列表 */}
        {state.tools.length > 0 && (
          <div className="my-2.5 p-2.5 bg-white dark:bg-zinc-950 border border-zinc-200/80 dark:border-zinc-800 rounded-xl text-xs space-y-1.5">
            <div className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 px-1">工具执行状态</div>
            {state.tools.map((tool, idx) => (
              <div
                key={`${tool.toolName}-${idx}`}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/70 dark:border-zinc-800/70 text-zinc-700 dark:text-zinc-300"
              >
                {tool.status === 'running' ? (
                  <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin-fast shrink-0" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                )}
                <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{tool.toolName}</span>
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                  {tool.status === 'running' ? '执行中...' : '已完成'}
                </span>
                {tool.summary && (
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate min-w-0 font-mono">
                    ({tool.summary})
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 流式正文平铺输出，不套外层大白框 */}
        <div className="mt-1 text-zinc-800 dark:text-zinc-200 leading-relaxed break-words prose-botd">
          {state.delta ? (
            <Markdown>{state.delta}</Markdown>
          ) : (
            <div className="flex items-center gap-2 text-zinc-400 dark:text-zinc-500 text-xs py-1">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
              <span>等待首字回复与工具调用...</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-zinc-950 overflow-hidden">
      {/* 极简顶栏（h-13 sm:h-14，删掉参会胶囊火车与停止按钮） */}
      <header className="h-13 sm:h-14 px-3 sm:px-4 bg-white dark:bg-zinc-950 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button
            onClick={onToggleSidebar}
            className="p-1.5 -ml-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg lg:hidden cursor-pointer"
            aria-label="打开侧边导航"
          >
            <Menu className="w-5 h-5" />
          </button>

          {renaming ? (
            /* 行内重命名：标题位置换成输入框，Enter/√ 保存，Esc/× 取消 */
            <div className="flex items-center gap-1.5 min-w-0 flex-1 max-w-sm">
              <input
                autoFocus
                type="text"
                value={renameValue}
                disabled={renameBusy}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                placeholder="输入新的会话名称"
                aria-label="会话名称"
                className="flex-1 min-w-0 w-24 sm:w-44 px-2 py-1 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-600 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500 focus:border-zinc-400 dark:focus:border-zinc-500"
              />
              <button
                onClick={() => void commitRename()}
                disabled={!renameValue.trim() || renameBusy}
                className="p-1.5 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-40 cursor-pointer"
                aria-label="保存名称"
                title="保存（Enter）"
              >
                {renameBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                onClick={cancelRename}
                disabled={renameBusy}
                className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-40 cursor-pointer"
                aria-label="取消重命名"
                title="取消（Esc）"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div
              className={`flex items-center gap-2 min-w-0 ${
                session.mode !== 'direct' ? 'cursor-pointer hover:opacity-85 transition-opacity' : ''
              }`}
              onClick={session.mode !== 'direct' ? onOpenGroupSettings : undefined}
              title={session.mode !== 'direct' ? '点击查看或修改群设置' : undefined}
            >
              <h2 className="font-semibold text-sm sm:text-base text-zinc-900 dark:text-zinc-100 truncate">
                {session.title}
              </h2>

            {/* 极简模式微标 */}
            {session.mode === 'direct' ? (
              <span className="text-[11px] font-normal px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-md shrink-0">
                单聊
              </span>
            ) : session.mode === 'lead' ? (
              <span className="text-[11px] font-normal px-1.5 py-0.5 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/60 dark:border-amber-900/60 rounded-md shrink-0">
                主持模式
              </span>
            ) : (
              <span className="text-[11px] font-normal px-1.5 py-0.5 bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200/60 dark:border-purple-900/60 rounded-md shrink-0">
                圆桌模式
              </span>
            )}

            {/* 群聊成员数微标 */}
            {session.mode !== 'direct' && (
              <span className="text-[11px] font-normal px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 rounded-md shrink-0 flex items-center gap-0.5">
                <Users className="w-3 h-3 text-zinc-400 dark:text-zinc-500" />
                <span>{memberBots.length} 人</span>
              </span>
            )}
            </div>
          )}
        </div>

        {/* 右侧操作：开启新话题 + 产物/后台任务抽屉入口 + 更多操作下拉菜单 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => void onNewTopic(session.id)}
            className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="开启新话题"
            aria-label="开启新话题"
          >
            <MessageSquarePlus className="w-4 h-4" />
          </button>

          {/* 会话产物抽屉入口：新产物未查看时右上角红点 */}
          <div className="relative">
            <button
              onClick={() => {
                setArtifactsOpen(true);
                setArtifactsUnseen(false);
              }}
              className="h-8 w-8 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors cursor-pointer"
              title="会话产物"
              aria-label="会话产物"
            >
              <Package className="w-4 h-4" />
            </button>
            {artifactsUnseen && (
              <span
                className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-red-500 pointer-events-none"
                aria-hidden="true"
              />
            )}
          </div>

          {/* 后台任务抽屉入口：本会话存在 running 任务时蓝点 */}
          <div className="relative">
            <button
              onClick={() => {
                setBgJobsOpen(true);
                setHasRunningBgJobs(false);
              }}
              className="h-8 w-8 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors cursor-pointer"
              title="后台任务"
              aria-label="后台任务"
            >
              <SquareTerminal className="w-4 h-4" />
            </button>
            {hasRunningBgJobs && !bgJobsOpen && (
              <span
                className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-blue-500 pointer-events-none"
                aria-hidden="true"
              />
            )}
          </div>

          {/* 分享对话入口 */}
          <button
            onClick={() => setShareModalOpen(true)}
            className="h-8 w-8 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors cursor-pointer"
            title="分享对话"
            aria-label="分享对话"
          >
            <Share2 className="w-4 h-4" />
          </button>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className={`p-2 rounded-lg transition-colors cursor-pointer ${
                menuOpen
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
              title="更多操作"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1.5 w-44 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-800 rounded-xl shadow-lg py-1 z-50 animate-in fade-in"
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void onNewTopic(session.id);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex flex-col items-start gap-0.5 min-w-0">
                    <span>开启新话题</span>
                    <span className="text-[11px] font-normal text-zinc-400 dark:text-zinc-500 text-left leading-tight">
                      归档当前话题并开始新会话
                    </span>
                  </span>
                </button>

                <button
                  role="menuitem"
                  onClick={startRename}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  <span>重命名…</span>
                </button>

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setShareModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>分享对话</span>
                </button>

                {session.mode !== 'direct' && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenGroupSettings();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <SettingsIcon className="w-3.5 h-3.5" />
                    <span>群设置</span>
                  </button>
                )}

                <div className="my-1 border-t border-zinc-100 dark:border-zinc-800/80" />

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setTriggersOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span>定时与触发器</span>
                </button>

                <div className="my-1 border-t border-zinc-100 dark:border-zinc-800/80" />

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmAction('clear');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                >
                  <Eraser className="w-3.5 h-3.5" />
                  <span>清空消息</span>
                </button>

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmAction('delete');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>删除会话</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 排队挂起横幅：目标计算节点离线，任务已入队等待节点恢复 */}
      {session.status === 'queued' && (
        <div className="mx-3 sm:mx-4 mt-2.5 px-3 py-2 bg-amber-50/90 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 rounded-lg flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300 shrink-0">
          <Hourglass className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>目标计算节点当前离线，任务已挂起排队，节点恢复上线后将自动继续执行。</span>
        </div>
      )}

      {/* 消息滚动主区域（外层包裹用于定位回到底部悬浮按钮） */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto py-2 sm:py-3 space-y-1"
          role="log"
          aria-label="聊天消息记录"
        >
        {loadingMessages && messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 gap-2">
            <Loader2 className="w-5 h-5 animate-spin-fast text-blue-600 dark:text-blue-400" />
            <p className="text-xs">正在同步会话消息记录...</p>
          </div>
        ) : loadError ? (
          <div className="p-4 mx-auto max-w-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded-2xl text-center my-8">
            <AlertTriangle className="w-5 h-5 text-rose-500 dark:text-rose-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-rose-800 dark:text-rose-300 mb-1">加载历史消息失败</p>
            <p className="text-xs text-rose-600 dark:text-rose-400 mb-3">{loadError}</p>
            <button
              onClick={onRetryLoad}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-zinc-900 border border-rose-300 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 rounded-lg text-xs font-medium hover:bg-rose-100/50 dark:hover:bg-rose-900/30 shadow-xs cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>重新加载</span>
            </button>
          </div>
        ) : messages.length === 0 && effectiveStreamingStates.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 max-w-md mx-auto">
            <div className="w-12 h-12 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-center text-zinc-700 dark:text-zinc-300 mb-3 shadow-xs">
              {session.mode === 'direct' ? (
                <Bot className="w-6 h-6" />
              ) : (
                <Users className="w-6 h-6" />
              )}
            </div>
            <h3 className="text-sm sm:text-base font-semibold text-zinc-800 dark:text-zinc-200 mb-1">
              {session.mode === 'direct' ? `开启与 ${session.title} 的对话` : session.title}
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4 leading-relaxed">
              {session.mode === 'direct'
                ? '发送消息开始对话。智能体将根据配置的角色与技能为你提供协助。输入 /new 可随时开启新话题。'
                : '发送消息开始对话。在群聊中输入 @ 提及成员接力发言与协作。'}
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {memberBots.map((b) => (
                <span
                  key={b.id}
                  className="px-2 py-0.5 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800/80 rounded-md text-[11px] text-zinc-600 dark:text-zinc-400 font-mono"
                >
                  @{b.id} ({b.name})
                </span>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* 加载更早消息：IntersectionObserver 哨兵（自动触发）+ 居中按钮（可靠主入口） */}
            {hasEarlierMessages && (
              <div ref={earlierSentinelRef} className="flex justify-center py-1.5">
                <button
                  type="button"
                  onClick={handleLoadEarlier}
                  disabled={loadingEarlier || !onLoadEarlier}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {loadingEarlier ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                      <span>正在加载...</span>
                    </>
                  ) : (
                    <>
                      <ChevronUp className="w-3.5 h-3.5" />
                      <span>加载更早消息</span>
                    </>
                  )}
                </button>
              </div>
            )}

            {messages.map((msg, idx) => (
              <React.Fragment key={msg.id}>
                {/* 日期分隔线：相邻消息跨自然日时插入（只做视觉分组，不动数据） */}
                {(idx === 0 || !sameDay(messages[idx - 1].createdAt, msg.createdAt)) && (
                  <div className="sticky top-0 z-[5] mx-auto my-2 w-fit px-2.5 py-0.5 rounded-full bg-zinc-100/90 dark:bg-zinc-800/90 text-[11px] text-zinc-500 backdrop-blur-sm">
                    {dayLabel(msg.createdAt)}
                  </div>
                )}
                <div
                  className={
                    highlightedId === msg.id
                      ? 'rounded-2xl ring-2 ring-blue-400/60 bg-blue-50/50 dark:bg-blue-500/5 transition-colors duration-500'
                      : 'transition-colors duration-500'
                  }
                >
                  <MessageItem
                    message={msg}
                    botMap={botMap}
                    nodeMap={nodeMap}
                    canEdit={canEdit}
                    isEditing={editingMessage?.id === msg.id}
                    onStartEdit={startEdit}
                    onForkMessage={(mid) => onForkMessage(session.id, mid)}
                  />
                </div>
              </React.Fragment>
            ))}

            {/* 多 BOT 并发流式（并行盲评）：网格并排展示，互不覆盖；单 BOT 保持平铺风格 */}
            {isParallelStreaming ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 px-3 sm:px-6 my-2">
                <div className="col-span-full flex items-center justify-center gap-1.5 py-1.5 px-3 bg-purple-50/80 dark:bg-purple-950/40 border border-purple-200/70 dark:border-purple-900/60 rounded-full w-fit mx-auto">
                  <Hourglass className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400 shrink-0" />
                  <span className="text-[11px] font-medium text-purple-700 dark:text-purple-300">
                    圆桌并发盲评进行中 ({effectiveStreamingStates.length} 位智能体同步思考中...)
                  </span>
                </div>
                {effectiveStreamingStates.map((state) => renderStreamingBlock(state))}
              </div>
            ) : (
              effectiveStreamingStates.map((state) => renderStreamingBlock(state))
            )}
          </>
        )}
        </div>

        {/* 回到底部悬浮按钮：仅在用户向上滚动离开底部时出现 */}
        {userScrolledUp && (
          <button
            onClick={handleJumpToBottom}
            className="absolute bottom-3 right-3 sm:right-6 z-20 flex items-center gap-1.5 h-9 px-3.5 rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-lg text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors cursor-pointer animate-in fade-in"
            aria-label="回到底部"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>回到底部</span>
          </button>
        )}
      </div>

      {/* 人机协同交互卡片：BOT 通过 botd ask 发起的待响应请求，置于输入框上方 */}
      {pendingAsks.length > 0 && (
        <div className="px-3 sm:px-4 pt-2.5 space-y-2 shrink-0 max-w-4xl w-full mx-auto">
          {pendingAsks.map((ask) => (
            <AskCard
              key={ask.id}
              ask={ask}
              bot={ask.botId ? botMap.get(ask.botId) : undefined}
              onRespond={async (askId, answer) => {
                await onRespondToAsk?.(session.id, askId, answer);
              }}
            />
          ))}
        </div>
      )}

      {/* 底部输入框：将 isRunning, cancelling, onCancelSession 传给 ChatInput 实现发送/停止二合一；
          编辑态复用输入框（享受斜杠/提及补全、自动增高与 IME 处理） */}
      <ChatInput
        sessionId={session.id}
        leadBotId={session.leadBotId}
        botMap={botMap}
        onSendMessage={onSendMessage}
        memberBots={memberBots}
        nodeMap={nodeMap}
        isRunning={isRunning}
        cancelling={cancelling}
        onCancelSession={onCancelSession}
        editingMessage={editingMessage}
        onSubmitEditing={handleSubmitEdit}
        onCancelEditing={() => setEditingMessage(null)}
      />

      {/* 移动端软键盘动态避让垫片：iOS Safari 键盘弹起时垫起输入框，消除悬空与空白 */}
      {keyboardInset > 0 && (
        <div
          style={{ height: `${keyboardInset}px` }}
          className="w-full shrink-0"
          aria-hidden="true"
        />
      )}

      {/* 清空消息 / 删除会话二次确认 */}
      <ConfirmDialog
        isOpen={!!confirmAction}
        title={confirmAction === 'clear' ? '清空消息' : '删除会话'}
        message={
          confirmAction === 'clear' ? (
            <>
              将永久删除会话「{session.title}」的全部 {messages.length} 条历史消息，删除后不可恢复，且会话将无法继续查看之前的对话内容。
            </>
          ) : (
            <>
              将永久删除会话「{session.title}」及其全部历史消息，删除后不可恢复。
            </>
          )}
        confirmText={confirmAction === 'clear' ? '清空消息' : '删除会话'}
        danger
        busy={actionBusy}
        onConfirm={() => void handleConfirmAction()}
        onClose={() => {
          if (!actionBusy) setConfirmAction(null);
        }}
      />

      {/* 定时与触发器管理弹窗 */}
      <TriggersModal
        isOpen={triggersOpen}
        session={session}
        memberBots={memberBots}
        onClose={() => setTriggersOpen(false)}
        onAddToast={(type, message) => onAddToast?.(type, message)}
      />

      {/* 会话产物抽屉 */}
      <ArtifactsDrawer
        isOpen={artifactsOpen}
        sessionId={session.id}
        botMap={botMap}
        onClose={() => setArtifactsOpen(false)}
      />

      {/* 分享对话弹窗 */}
      {shareModalOpen && (
        <ShareSessionModal
          sessionId={session.id}
          onClose={() => setShareModalOpen(false)}
        />
      )}

      {/* 后台任务抽屉 */}
      <BgJobsDrawer
        isOpen={bgJobsOpen}
        sessionId={session.id}
        memberBotIds={session.memberBotIds || []}
        botMap={botMap}
        nodeMap={nodeMap}
        onClose={() => setBgJobsOpen(false)}
        onToast={(type, message) => onAddToast?.(type, message)}
      />
    </div>
  );
};
