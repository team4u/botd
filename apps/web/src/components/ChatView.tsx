import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  BgJobRecord,
  CreateSessionInput,
  SubagentRunRecord,
} from '@botd/protocol';
import type { StreamingAssistantState } from '../types';
import {
  MemoizedMessageItem,
  formatShortModel,
  subagentColorStyles,
  SubagentRunsPanel,
} from './MessageItem';
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
  /** 各 BOT 当前活跃的分身协同执行轨迹 */
  activeSubagentRuns?: Record<string, SubagentRunRecord[]>;
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
  /** 更新会话配置（如黑板/头衔） */
  onUpdateSession?: (
    sessionId: string,
    input: Partial<CreateSessionInput> & { memberRoles?: Record<string, string>; blackboard?: string }
  ) => Promise<void>;
  /** 跳转/打开指定智能体的单聊 */
  onOpenBotChat?: (bot: BotConfig) => void;
  /** 是否还有更早的历史消息可加载（App 负责分页） */
  hasEarlierMessages?: boolean;
  /** 正在加载更早消息 */
  loadingEarlier?: boolean;
  /** 加载更早消息（App 负责 prepend） */
  onLoadEarlier?: () => void;
  /** 搜索跳转定位高亮的消息 id */
  highlightMessageId?: string | null;
}

export function pickPollIntervalMs(hasActiveWork: boolean): number {
  return hasActiveWork ? 5000 : 30000;
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
  activeSubagentRuns = {},
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
  onUpdateSession,
  onOpenBotChat,
  hasEarlierMessages = false,
  loadingEarlier = false,
  onLoadEarlier,
  highlightMessageId = null,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const keyboardInset = useKeyboardInset();

  // 📌 群备忘录面板展开与编辑状态
  const [blackboardOpen, setBlackboardOpen] = useState(false);
  const [blackboardEditing, setBlackboardEditing] = useState(false);
  const [blackboardDraft, setBlackboardDraft] = useState('');
  const [savingBlackboard, setSavingBlackboard] = useState(false);

  // 临时点名下拉菜单状态
  const [appendDropdownOpen, setAppendDropdownOpen] = useState(false);
  const appendDropdownRef = useRef<HTMLDivElement>(null);

  // 本会话参会成员（提前声明：蓝点探测/SSE/群设置等多处使用）
  // useMemo 稳定引用：下游 memberNodeIds/fetchBgJobs 等依赖链才不会每次 render 失稳
  const memberBots = useMemo<BotConfig[]>(
    () =>
      (session.memberBotIds || [])
        .map((id) => botMap.get(id))
        .filter((b): b is BotConfig => Boolean(b)),
    [session.memberBotIds, botMap]
  );

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
  const [bgJobs, setBgJobs] = useState<BgJobRecord[]>([]);
  const [selectedBgJobId, setSelectedBgJobId] = useState<string | null>(null);

  // ===== 会话切换守卫 =====
  // 异步响应提交前校验会话未变，防止 A 会话的在途响应覆盖 B 会话的界面
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;

  // ===== 子会话委派任务列表 =====
  const [subSessions, setSubSessions] = useState<SessionRecord[]>([]);

  const loadSubSessions = useCallback(async () => {
    const capturedSessionId = session.id;
    try {
      const subs = await api.listSubSessions(capturedSessionId);
      if (sessionIdRef.current !== capturedSessionId) return;
      setSubSessions(subs);
    } catch {
      if (sessionIdRef.current !== capturedSessionId) return;
      setSubSessions([]);
    }
  }, [session.id]);

  useEffect(() => {
    void loadSubSessions();
  }, [loadSubSessions]);

  // 当 messages 中有包含 #?s=sess_ 的 callback 消息到达时重新拉取子会话列表
  const lastSubCallbackMsgRef = useRef<string>('');
  useEffect(() => {
    const callbackWithSub = messages.find(
      (m) => m.role === 'callback' && m.content.includes('#?s=sess_')
    );
    const key = callbackWithSub ? `${callbackWithSub.id}:${callbackWithSub.content}` : '';
    if (key && key !== lastSubCallbackMsgRef.current) {
      lastSubCallbackMsgRef.current = key;
      void loadSubSessions();
    }
  }, [messages, loadSubSessions]);

  // 探测本会话后台任务：成员节点集合派生 join 字符串作稳定依赖，成员不变时 fetchBgJobs 引用不换新
  const memberNodeIds = useMemo(
    () =>
      [...new Set(memberBots.map((b) => b.nodeId).filter(Boolean))],
    [memberBots]
  );
  const memberNodeIdsKey = memberNodeIds.join(',');

  const fetchBgJobs = useCallback(async () => {
    const capturedSessionId = sessionIdRef.current;
    const nodeIds = memberNodeIdsKey ? memberNodeIdsKey.split(',') : [];
    if (nodeIds.length === 0) {
      setBgJobs([]);
      setHasRunningBgJobs(false);
      return;
    }
    const results = await Promise.allSettled(
      nodeIds.map((id) => api.listBgJobs(id, { sessionId: capturedSessionId }))
    );
    if (sessionIdRef.current !== capturedSessionId) return;
    const collected: BgJobRecord[] = [];
    results.forEach((r) => {
      if (r.status === 'fulfilled') {
        collected.push(...r.value);
      }
    });
    setBgJobs(collected);
    setHasRunningBgJobs(collected.some((j) => j.status === 'running'));
  }, [memberNodeIdsKey]);

  // 最新回调引用：轮询 interval 与 SSE 订阅经 ref 调用，避免依赖函数引用导致订阅被反复拆建
  const loadSubSessionsRef = useRef(loadSubSessions);
  loadSubSessionsRef.current = loadSubSessions;
  const fetchBgJobsRef = useRef(fetchBgJobs);
  fetchBgJobsRef.current = fetchBgJobs;

  // 切换会话时重置抽屉与状态标记
  const prevMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    setArtifactsUnseen(false);
    setHasRunningBgJobs(false);
    setBgJobs([]);
    setSelectedBgJobId(null);
    setSubSessions([]);
    lastSubCallbackMsgRef.current = '';
    prevMessagesLengthRef.current = messages.length;
  }, [session.id]);

  // 会话或成员节点集合变化时立即探测一次后台任务
  useEffect(() => {
    void fetchBgJobsRef.current();
  }, [session.id, memberNodeIdsKey]);

  // 消息条数实际发生变化（包括 callback 消息到达）时拉取后台任务，避免仅引用变化引起的无效请求
  useEffect(() => {
    if (messages.length === prevMessagesLengthRef.current) return;
    prevMessagesLengthRef.current = messages.length;
    void fetchBgJobsRef.current();
  }, [messages.length]);

  const hasActiveWork =
    subSessions.some((s) => s.status === 'running') ||
    bgJobs.some((j) => j.status === 'running');

  // 统一轮询：存在运行中子任务或后台任务时 5s 轮询，闲置时降频至 30s；
  // interval 仅依赖 hasActiveWork 布尔值并经 ref 调用最新加载函数，避免被高频重渲染拆建导致降频计时不断重置
  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadSubSessionsRef.current();
      void fetchBgJobsRef.current();
    }, pickPollIntervalMs(hasActiveWork));
    return () => window.clearInterval(interval);
  }, [hasActiveWork]);

  const runningBgJobs = useMemo(
    () => bgJobs.filter((j) => j.status === 'running'),
    [bgJobs]
  );

  // 计算最新上下文水位线百分比
  const latestCtxPct = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        msg.role === 'assistant' &&
        msg.usage?.totalTokens &&
        msg.usage?.contextWindow &&
        msg.usage.contextWindow > 0
      ) {
        return Math.min(100, Math.round((msg.usage.totalTokens / msg.usage.contextWindow) * 100));
      }
    }
    return 0;
  }, [messages]);

  // 用 ref 避免订阅 effect 依赖抽屉开关导致反复重订阅
  const artifactsOpenRef = useRef(false);
  const bgJobsOpenRef = useRef(false);
  artifactsOpenRef.current = artifactsOpen;
  bgJobsOpenRef.current = bgJobsOpen;

  // 全局 SSE：本会话 artifact_created 且抽屉未开时置红点；新回调消息（后台任务完成）到达时重新探测
  // 订阅仅依赖 session.id，经 ref 调用最新 fetchBgJobs，不再每 render 退订重订
  useEffect(() => {
    const unsubscribe = onGlobalEvent((e) => {
      if (e.type === 'artifact_created' && e.sessionId === session.id) {
        if (!artifactsOpenRef.current) setArtifactsUnseen(true);
      } else if (
        e.type === 'message_created' &&
        e.message.sessionId === session.id &&
        e.message.role === 'callback'
      ) {
        if (!bgJobsOpenRef.current) void fetchBgJobsRef.current();
      }
    });
    return unsubscribe;
  }, [session.id]);

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
    setBlackboardOpen(false);
    setBlackboardEditing(false);
    setAppendDropdownOpen(false);
  }, [session.id]);

  // 临时点名菜单展开时：点击外部关闭
  useEffect(() => {
    if (!appendDropdownOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (appendDropdownRef.current && !appendDropdownRef.current.contains(e.target as Node)) {
        setAppendDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [appendDropdownOpen]);

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
  // useCallback 稳定引用：配合 MemoizedMessageItem 的自定义比较，流式期间历史消息不因回调换新而重渲染
  const startEdit = useCallback(
    (msg: MessageRecord) => {
      if (session.status === 'running') return;
      setEditingMessage(msg);
    },
    [session.status]
  );

  // 分叉回调：useCallback 稳定化，避免逐条消息内联闭包使 MemoizedMessageItem 的 memo 比较失效
  const handleForkMessage = useCallback(
    (messageId: string) => onForkMessage(session.id, messageId),
    [onForkMessage, session.id]
  );

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

  // 分身智能体（Subagent）单聊主控归属检测
  const leadBot = botMap.get(session.leadBotId);
  const isSubagentDirect = session.mode === 'direct' && Boolean(leadBot?.parentBotId);
  const parentBotId = leadBot?.parentBotId;
  const subagentColorStyle =
    leadBot?.color && subagentColorStyles[leadBot.color]
      ? subagentColorStyles[leadBot.color]
      : subagentColorStyles.indigo;

  const handleReturnToParentBot = () => {
    if (session.parentSessionId) {
      window.location.hash = `#?s=${session.parentSessionId}`;
      return;
    }
    if (!parentBotId) return;
    const parentBot = botMap.get(parentBotId);
    if (parentBot && onOpenBotChat) {
      onOpenBotChat(parentBot);
    }
  };

  // 队列阶段控制
  const handleSkipStage = async (stageId: string, botId?: string) => {
    try {
      await api.skipQueueStage(session.id, { stageId, botId });
    } catch (err: any) {
      onAddToast?.('error', err?.message || '跳过阶段失败');
    }
  };

  const handleAppendStage = async (botId: string) => {
    try {
      setAppendDropdownOpen(false);
      await api.appendQueueStage(session.id, `@${botId}`);
    } catch (err: any) {
      onAddToast?.('error', err?.message || '临时点名失败');
    }
  };

  const hasQueuePlan = Boolean(session.queuePlan && session.queuePlan.length > 0);
  const showQueueBar = (isRunning || hasQueuePlan) && (session.mode !== 'direct' || hasQueuePlan);
  const activeBots =
    session.activeBotIds && session.activeBotIds.length > 0
      ? session.activeBotIds
      : session.activeBotId
        ? [session.activeBotId]
        : [];

  // 单个流式 BOT 输出块（并发网格内复用，风格与 MessageItem Assistant 一致）
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

        {/* 分身协同运行中轨迹 */}
        {activeSubagentRuns?.[state.botId] && activeSubagentRuns[state.botId].length > 0 && (
          <SubagentRunsPanel runs={activeSubagentRuns[state.botId]} />
        )}

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
            ) : (
              <span className="text-[11px] font-normal px-1.5 py-0.5 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/60 dark:border-amber-900/60 rounded-md shrink-0">
                主持模式
              </span>
            )}

            {/* 分身单聊标识与返回主控入口 */}
            {isSubagentDirect && parentBotId && (
              <>
                <span
                  className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md border ${subagentColorStyle.badge} shrink-0`}
                  title={`分身智能体，隶属于主控 @${parentBotId}`}
                >
                  分身 · 隶属 @{parentBotId}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleReturnToParentBot();
                  }}
                  className="inline-flex items-center gap-1 h-6 px-2 text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-md transition-colors cursor-pointer shrink-0"
                  title={`返回主控 @${parentBotId} 的会话`}
                >
                  ← 返回主控
                </button>
              </>
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

        {/* 右侧操作：高水位一键压缩 + 开启新话题 + 产物/后台任务抽屉入口 + 更多操作下拉菜单 */}
        <div className="flex items-center gap-1 shrink-0">
          {latestCtxPct >= 75 && (
            <button
              type="button"
              onClick={() => void onSendMessage('/compact')}
              className="hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60 text-xs font-medium transition-colors cursor-pointer shrink-0 shadow-2xs mr-0.5"
              title="当前上下文水位较高，点击自动发送 /compact 进行上下文压缩"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
              <span>上下文水位 {latestCtxPct}% · 一键压缩 (/compact)</span>
            </button>
          )}

          {/* 开启新话题 */}
          <button
            onClick={() => void onNewTopic(session.id)}
            className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="开启新话题"
            aria-label="开启新话题"
          >
            <MessageSquarePlus className="w-4 h-4" />
          </button>

          {/* 📌 群备忘录入口（群聊可见） */}
          {session.mode !== 'direct' && (
            <button
              type="button"
              onClick={() => {
                setBlackboardOpen((v) => !v);
                if (!blackboardOpen) {
                  setBlackboardDraft(session.blackboard || '');
                  setBlackboardEditing(false);
                }
              }}
              className={`h-8 px-2.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 ${
                blackboardOpen
                  ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
              title="群备忘录 / 共享黑板"
              aria-label="群备忘录"
            >
              <span>📌 群备忘录</span>
              {Boolean(session.blackboard?.trim()) && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0"
                  aria-hidden="true"
                />
              )}
            </button>
          )}

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
                setSelectedBgJobId(null);
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

      {/* 📌 群聊备忘录 (Shared Blackboard) 折叠面板 */}
      {blackboardOpen && session.mode !== 'direct' && (
        <div className="mx-3 sm:mx-4 mt-2 px-3 py-2 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-900/60 rounded-lg text-xs shrink-0 animate-in fade-in">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5 text-indigo-900 dark:text-indigo-200 font-medium">
              <span>📌</span>
              <span>群聊备忘录 (Shared Blackboard)</span>
              <span className="text-[11px] text-indigo-600/70 dark:text-indigo-400/70 font-normal">
                置顶注入上下文的共识与约束
              </span>
            </div>
            <div className="flex items-center gap-1">
              {!blackboardEditing ? (
                <button
                  type="button"
                  onClick={() => {
                    setBlackboardDraft(session.blackboard || '');
                    setBlackboardEditing(true);
                  }}
                  className="h-6 px-2 text-[11px] font-medium rounded-md text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-colors cursor-pointer"
                >
                  编辑
                </button>
              ) : (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={savingBlackboard}
                    onClick={async () => {
                      setSavingBlackboard(true);
                      try {
                        await onUpdateSession?.(session.id, { blackboard: blackboardDraft });
                        setBlackboardEditing(false);
                      } catch {
                        // error handled by onUpdateSession toast
                      } finally {
                        setSavingBlackboard(false);
                      }
                    }}
                    className="h-6 px-2 text-[11px] font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    {savingBlackboard ? <Loader2 className="w-3 h-3 animate-spin-fast" /> : null}
                    <span>保存</span>
                  </button>
                  <button
                    type="button"
                    disabled={savingBlackboard}
                    onClick={() => setBlackboardEditing(false)}
                    className="h-6 px-2 text-[11px] font-medium rounded-md text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    取消
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => setBlackboardOpen(false)}
                className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-md transition-colors cursor-pointer"
                aria-label="关闭备忘录"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {blackboardEditing ? (
            <textarea
              value={blackboardDraft}
              onChange={(e) => setBlackboardDraft(e.target.value)}
              placeholder="记录本群长期共识、全局约定、当前阶段目标（将作为系统提示注入后续各 BOT 上下文）..."
              rows={3}
              className="w-full p-2.5 text-xs rounded-lg border border-indigo-200 dark:border-indigo-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y leading-relaxed"
            />
          ) : (
            <div className="text-zinc-700 dark:text-zinc-300 leading-relaxed break-words whitespace-pre-wrap max-h-48 overflow-y-auto">
              {session.blackboard?.trim() ? (
                session.blackboard
              ) : (
                <span className="text-zinc-400 dark:text-zinc-500 italic">
                  暂未记录备忘录。点击右上角「编辑」添加群共识与约束。
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 子任务委派状态条 */}
      {subSessions.length > 0 && (
        <div className="mx-3 sm:mx-4 mt-2.5 px-3 py-1.5 bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 rounded-lg flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 shrink-0 overflow-x-auto">
          <span className="font-medium shrink-0 text-zinc-600 dark:text-zinc-400">
            子任务 ({subSessions.length})
          </span>
          <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto py-0.5">
            {subSessions.map((sub) => {
              let statusIndicator = (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="已完成" />
              );
              if (sub.status === 'running') {
                statusIndicator = (
                  <span title="运行中" className="shrink-0 flex items-center">
                    <Loader2 className="w-3 h-3 text-blue-500 animate-spin-fast" />
                  </span>
                );
              } else if (sub.status === 'failed') {
                statusIndicator = (
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" title="失败" />
                );
              }
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => {
                    window.location.hash = `#?s=${sub.id}`;
                  }}
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 bg-white dark:bg-zinc-800 border border-zinc-200/90 dark:border-zinc-700/80 rounded-lg text-xs hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-950/30 transition-colors shrink-0 cursor-pointer text-left max-w-[220px]"
                  title={`${sub.title} (@${sub.leadBotId})`}
                >
                  {statusIndicator}
                  <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">
                    @{sub.leadBotId}
                  </span>
                  <span className="truncate text-zinc-800 dark:text-zinc-200 text-xs">
                    {sub.title.replace(/^\[子任务\]\s*/, '')}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 子会话模式返回父会话横幅 */}
      {session.parentSessionId && (
        <div className="mx-3 sm:mx-4 mt-2.5 px-3 py-1.5 bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200/80 dark:border-blue-900/60 rounded-lg flex items-center justify-between gap-2 text-xs text-blue-800 dark:text-blue-300 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium shrink-0">子会话模式</span>
            <span className="text-blue-600/70 dark:text-blue-400/60 text-[11px] truncate">由父会话派生</span>
          </div>
          <button
            type="button"
            onClick={() => {
              window.location.hash = `#?s=${session.parentSessionId}`;
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-white dark:bg-zinc-900 border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/60 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer shadow-2xs"
          >
            ← 返回父会话
          </button>
        </div>
      )}

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

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={
                  highlightedId === msg.id
                    ? 'rounded-2xl ring-2 ring-blue-400/60 bg-blue-50/50 dark:bg-blue-500/5 transition-colors duration-500'
                    : 'transition-colors duration-500'
                }
              >
                <MemoizedMessageItem
                  message={msg}
                  botMap={botMap}
                  nodeMap={nodeMap}
                  memberRoles={session.memberRoles}
                  canEdit={canEdit}
                  isEditing={editingMessage?.id === msg.id}
                  onStartEdit={startEdit}
                  onForkMessage={handleForkMessage}
                />
              </div>
            ))}

            {/* 多 BOT 并发流式：网格并排展示，互不覆盖；单 BOT 保持平铺风格 */}
            {isParallelStreaming ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 px-3 sm:px-6 my-2">
                <div className="col-span-full flex items-center justify-center gap-1.5 py-1.5 px-3 bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-900/60 rounded-full w-fit mx-auto">
                  <Hourglass className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
                  <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    多智能体并发执行中 ({effectiveStreamingStates.length} 位智能体同步处理中...)
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

      {/* 上下文高水位线报警与一键压缩（小屏或输入框上方常驻） */}
      {latestCtxPct >= 75 && (
        <div className="px-3 sm:px-4 pt-1.5 max-w-4xl w-full mx-auto sm:hidden">
          <div
            onClick={() => void onSendMessage('/compact')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void onSendMessage('/compact');
              }
            }}
            className="flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-50/90 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-lg text-xs text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors cursor-pointer shadow-2xs"
            title="上下文水位较高，点击自动发送 /compact"
          >
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
              <span className="font-medium">上下文水位 {latestCtxPct}%</span>
            </div>
            <span className="font-mono text-[11px] underline">一键压缩 (/compact)</span>
          </div>
        </div>
      )}

      {/* 后台任务运行中状态条 */}
      {runningBgJobs.length > 0 && (
        <div className="px-3 sm:px-4 pt-1.5 max-w-4xl w-full mx-auto">
          <div
            onClick={() => {
              setSelectedBgJobId(runningBgJobs[0].id);
              setBgJobsOpen(true);
              setHasRunningBgJobs(false);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSelectedBgJobId(runningBgJobs[0].id);
                setBgJobsOpen(true);
                setHasRunningBgJobs(false);
              }
            }}
            className="flex items-center justify-between gap-2 px-3 py-1.5 bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200/80 dark:border-blue-900/60 rounded-lg text-xs text-blue-800 dark:text-blue-300 hover:bg-blue-100/70 dark:hover:bg-blue-900/50 transition-colors cursor-pointer shadow-2xs"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0">⚙️</span>
              <span className="font-medium shrink-0">
                {runningBgJobs.length} 个后台任务运行中
              </span>
              <span className="text-zinc-400 dark:text-zinc-500">·</span>
              <span className="font-mono text-[11px] truncate text-blue-700/90 dark:text-blue-300/90">
                {runningBgJobs[0].command}
              </span>
            </div>
            <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0 ml-1">
              查看日志 / 管理 →
            </span>
          </div>
        </div>
      )}

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

      {/* 实时接力进度条 (Live Workflow Queue Bar) */}
      {showQueueBar && (
        <div className="px-3 sm:px-4 pt-1.5 max-w-4xl w-full mx-auto">
          <div className="px-3 py-1.5 bg-zinc-50/90 dark:bg-zinc-900/80 border border-zinc-200/80 dark:border-zinc-800/80 rounded-lg text-xs flex items-center justify-between gap-2 shadow-2xs">
            {/* 左侧：当前活跃 + 队列阶段 */}
            <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto no-scrollbar py-0.5">
              {activeBots.length > 0 && (
                <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400 shrink-0 font-mono text-[11px]">
                  <span>🟢 正在执行:</span>
                  <span>{activeBots.map((id) => `@${id}`).join(', ')}</span>
                </span>
              )}

              {session.queuePlan && session.queuePlan.length > 0 && (
                <>
                  {activeBots.length > 0 && (
                    <span className="text-zinc-300 dark:text-zinc-600 shrink-0">──▸</span>
                  )}
                  {session.queuePlan.map((stage, idx) => {
                    const stageLabel = stage.parallel
                      ? `(@${stage.botIds.join(', @')})`
                      : `@${stage.botIds[0] || '?'}`;
                    const loopPrefix = stage.loopGroupId ? '🔄 ' : '';
                    const whisperPrefix = stage.whisper ? '🤫 ' : '';

                    return (
                      <React.Fragment key={stage.id || idx}>
                        {idx > 0 && (
                          <span className="text-zinc-300 dark:text-zinc-600 shrink-0">──▸</span>
                        )}
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded text-[11px] text-zinc-700 dark:text-zinc-300 shrink-0 font-mono">
                          <span>⏳ {loopPrefix}{whisperPrefix}{stageLabel}</span>
                          <button
                            type="button"
                            onClick={() => handleSkipStage(stage.id, stage.botIds[0])}
                            className="ml-0.5 text-zinc-400 hover:text-rose-500 dark:hover:text-rose-400 font-sans cursor-pointer transition-colors"
                            title="跳过此阶段"
                          >
                            × 跳过
                          </button>
                        </span>
                      </React.Fragment>
                    );
                  })}
                </>
              )}
            </div>

            {/* 右侧：临时点名 */}
            <div className="relative shrink-0" ref={appendDropdownRef}>
              <button
                type="button"
                onClick={() => setAppendDropdownOpen((v) => !v)}
                className="h-6 px-2 text-[11px] font-medium rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors flex items-center gap-1 cursor-pointer shrink-0"
                title="向队列末尾追加指定智能体"
              >
                <span>+ 临时点名</span>
              </button>

              {appendDropdownOpen && (
                <div className="absolute right-0 bottom-full mb-1.5 w-44 max-h-48 overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg py-1 z-50 animate-in fade-in">
                  <div className="px-2 py-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                    点名成员追加接力
                  </div>
                  {memberBots.map((bot) => (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => handleAppendStage(bot.id)}
                      className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between text-zinc-700 dark:text-zinc-200 cursor-pointer"
                    >
                      <span className="truncate">{bot.name}</span>
                      <span className="font-mono text-[11px] text-zinc-400">@{bot.id}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 底部输入框：将 isRunning, cancelling, onCancelSession 传给 ChatInput 实现发送/停止二合一；
          编辑态复用输入框（享受斜杠/提及补全、自动增高与 IME 处理） */}
      <ChatInput
        sessionId={session.id}
        leadBotId={session.leadBotId}
        sessionMode={session.mode}
        isSubagentSession={Boolean(session.mode === 'direct' && botMap.get(session.leadBotId)?.parentBotId)}
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
        initialJobId={selectedBgJobId}
        onClose={() => {
          setBgJobsOpen(false);
          setSelectedBgJobId(null);
        }}
        onToast={(type, message) => onAddToast?.(type, message)}
      />
    </div>
  );
};
