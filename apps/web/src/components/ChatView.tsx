import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Menu,
  Settings as SettingsIcon,
  Loader2,
  MoreHorizontal,
  MessageSquarePlus,
  Pencil,
  Eraser,
  Trash2,
  Check,
  X,
  Clock,
  Hourglass,
  Package,
  PlayCircle,
  SquareTerminal,
  FileDiff,
  Share2,
  Sparkles,
  History as HistoryIcon,
  FolderGit2,
} from 'lucide-react';
import type {
  SessionRecord,
  MessageRecord,
  BotConfig,
  NodeRecord,
  NodeWithBots,
  MessageAttachment,
  PendingAskRecord,
  BgJobRecord,
  SubagentRunRecord,
  ChatCommand,
} from '@botd/protocol';
import type { StreamingAssistantState, SessionExtensionUiState, ExtensionWidgetState } from '../types';
import { MessageTimeline } from './MessageTimeline';
import { ChatInput } from './ChatInput';
import { ConfirmDialog } from './ConfirmDialog';
import { AskCard } from './AskCard';
import { TriggersModal } from './TriggersModal';
import { ArtifactsDrawer } from './ArtifactsDrawer';
import { BgJobsDrawer } from './BgJobsDrawer';
import { WorkspaceDiffDrawer } from './WorkspaceDiffDrawer';
import { ShareSessionModal } from './ShareSessionModal';
import { BotHistoryDrawer } from './BotHistoryDrawer';
import { SubagentRunDrawer } from './SubagentRunDrawer';
import { SubSessionDrawer } from './SubSessionDrawer';
import { BotEditorModal } from './BotEditorModal';
import { BotdUiRenderer } from './generative-ui/BotdUiRenderer';
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
  /** 所有计算节点（用于单聊智能体设置） */
  nodes?: NodeWithBots[];
  /** 刷新节点与智能体列表 */
  onRefreshNodes?: () => Promise<void>;
  /** 各 BOT 的流式状态；多个成员同时运行时并排展示。 */
  streamingStates: StreamingAssistantState[];
  /** 各 BOT 当前活跃的子代理协同执行轨迹 */
  activeSubagentRuns?: Record<string, SubagentRunRecord[]>;
  /** 会话级扩展 UI 状态（ctx.ui 桥接：status 徽标 / workingMessage / composer 挂件） */
  extensionUiState?: SessionExtensionUiState;
  onSendMessage: (content: string, attachments?: MessageAttachment[]) => Promise<void>;
  onEditMessage: (sessionId: string, messageId: string, content: string) => Promise<void>;
  onCancelSession: () => Promise<void>;
  onToggleSidebar: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<void> | void;
  onClearMessages: (sessionId: string) => Promise<void> | void;
  onDeleteSession: (sessionId: string) => Promise<void> | void;
  /** 批量删除会话（历史话题抽屉全选删除），由 App 统一同步全局列表 */
  onDeleteSessions?: (ids: string[]) => Promise<void> | void;
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
  /** 点击子代理运行记录打开详情抽屉（Steer / Resume / 停止控制）；传 null 关闭 */
  onInspectSubagentRun?: (run: SubagentRunRecord | null) => void;
  /** 当前抽屉正在查看的子代理运行 ID（由上层从实时状态与已落库消息中派生最新记录传入） */
  inspectingRunId?: string | null;
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

/** 点击工作流/子代理步骤后的检视目标 */
export type RunInspectionTarget =
  | { kind: 'none' }
  | { kind: 'subsession'; childSessionId: string }
  | { kind: 'subagent'; run: SubagentRunRecord };

/**
 * 纯函数：判定点击某条 SubagentRunRecord 应打开哪种检视抽屉。
 * - 带childSessionId 的工作流/编排步骤 → 跨BOT子会话抽屉（SubSessionDrawer）
 * - 普通本地子代理运行 → 子代理运行抽屉（SubagentRunDrawer）
 */
export function resolveRunInspectionTarget(run: SubagentRunRecord | null): RunInspectionTarget {
  if (!run) return { kind: 'none' };
  const childSessionId = (run as { childSessionId?: string }).childSessionId;
  if (childSessionId) return { kind: 'subsession', childSessionId };
  return { kind: 'subagent', run };
}

/** 从实时子代理轨迹与已落库消息中按 childSessionId 反查工作流步骤运行记录 */
function findSubagentRunByChildSessionId(
  activeSubagentRuns: Record<string, SubagentRunRecord[]>,
  messages: MessageRecord[],
  childSessionId: string
): SubagentRunRecord | undefined {
  for (const runs of Object.values(activeSubagentRuns)) {
    const hit = runs.find(
      (r) => (r as { childSessionId?: string }).childSessionId === childSessionId
    );
    if (hit) return hit;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const hit = messages[i].subagentRuns?.find(
      (r) => (r as { childSessionId?: string }).childSessionId === childSessionId
    );
    if (hit) return hit;
  }
  return undefined;
}

export const ChatView: React.FC<ChatViewProps> = ({
  session,
  messages,
  loadingMessages,
  loadError,
  onRetryLoad,
  botMap,
  nodeMap,
  nodes,
  onRefreshNodes,
  streamingStates,
  activeSubagentRuns = {},
  extensionUiState,
  onSendMessage,
  onEditMessage,
  onCancelSession,
  onToggleSidebar,
  onRenameSession,
  onClearMessages,
  onDeleteSession,
  onDeleteSessions,
  onNewTopic,
  onForkMessage,
  cancelling,
  pendingAsks = [],
  onRespondToAsk,
  onAddToast,
  onInspectSubagentRun,
  inspectingRunId = null,
  hasEarlierMessages = false,
  loadingEarlier = false,
  onLoadEarlier,
  highlightMessageId = null,
}) => {
  const keyboardInset = useKeyboardInset();

  // 本会话主控智能体（提前声明：蓝点探测/SSE/设置等多处使用）
  // useMemo 稳定引用：下游 memberNodeIds/fetchBgJobs 等依赖链才不会每次 render 失稳
  const memberBots = useMemo<BotConfig[]>(
    () => {
      const lead = botMap.get(session.leadBotId);
      return lead ? [lead] : [];
    },
    [session.leadBotId, botMap]
  );

  // 输入框 @ 可提及的智能体列表：排除当前单聊对象自己（不能 @ 自己）；
  // 优先展示同门子代理与主 BOT，其次展示其他可用 BOT
  const mentionableBots = useMemo<BotConfig[]>(() => {
    const allBots = Array.from(botMap.values());
    const result: BotConfig[] = [];
    const seen = new Set<string>();
    const pushBot = (b: BotConfig | undefined) => {
      if (!b || seen.has(b.id)) return;
      seen.add(b.id);
      result.push(b);
    };

    // 单聊中绝不允许 @ 当前对话对象自己
    seen.add(session.leadBotId);
    const leadBot = botMap.get(session.leadBotId);
    if (leadBot) {
      if (!leadBot.parentBotId) {
        // 当前是主 BOT：优先展示它麾下的子代理
        for (const b of allBots) {
          if (b.parentBotId === leadBot.id) pushBot(b);
        }
      } else {
        // 当前是子代理：优先展示它的主 BOT 及同门兄弟子代理
        pushBot(botMap.get(leadBot.parentBotId));
        for (const b of allBots) {
          if (b.parentBotId === leadBot.parentBotId) pushBot(b);
        }
      }
    }
    // 其余 BOT 按主从顺序追加，方便随时 @ 其他 BOT/子代理接力
    for (const b of allBots) {
      if (!b.parentBotId) {
        pushBot(b);
        for (const sub of allBots) {
          if (sub.parentBotId === b.id) pushBot(sub);
        }
      }
    }
    for (const b of allBots) pushBot(b);
    return result;
  }, [session.leadBotId, botMap]);

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
  // 智能体/子代理专属历史话题抽屉开关
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  // 智能体/子代理专属设置弹窗开关
  const [botEditorOpen, setBotEditorOpen] = useState(false);

  // 单聊对应的目标智能体（主 BOT 或子代理）
  const directBot = useMemo<BotConfig | undefined>(() => {
    return memberBots[0] || (session.leadBotId ? botMap.get(session.leadBotId) : undefined);
  }, [session.leadBotId, memberBots, botMap]);

  const directNode = useMemo<NodeWithBots | null>(() => {
    if (!directBot) return null;
    const found = nodes?.find((n) => n.id === directBot.nodeId);
    if (found) return found;
    const basicNode = nodeMap.get(directBot.nodeId);
    if (!basicNode) return null;
    return {
      ...basicNode,
      skills: [],
      extensions: [],
      bots: [directBot],
    };
  }, [directBot, nodes, nodeMap]);

  const parentBot = useMemo<BotConfig | null>(() => {
    if (!directBot?.parentBotId) return null;
    return botMap.get(directBot.parentBotId) || null;
  }, [directBot, botMap]);

  const isDirectNodeOnline = directNode?.status === 'online';

  // 会话是否正在运行（提前声明：挂件交互禁用态与胶囊点击分流都依赖）
  const isRunning = session.status === 'running';

  // ===== 扩展命令快捷胶囊（composer.pill 插槽）=====
  // 主控智能体注册的扩展斜杠命令：无参命令点击即发，带参命令预填输入框
  const [extensionCommands, setExtensionCommands] = useState<ChatCommand[]>([]);
  useEffect(() => {
    setExtensionCommands([]);
    if (!session.leadBotId || !isDirectNodeOnline) return;
    let cancelled = false;
    api
      .getBotCommands(session.leadBotId)
      .then((list) => {
        if (cancelled) return;
        setExtensionCommands((Array.isArray(list) ? list : []).filter((cmd) => cmd.source === 'extension'));
      })
      .catch(() => {
        // 静默降级：命令目录拉取失败时 capsule 条不展示即可
      });
    return () => {
      cancelled = true;
    };
  }, [session.leadBotId, isDirectNodeOnline]);

  const handleExtensionPillClick = (cmd: ChatCommand) => {
    // 带参数或会话运行中：仅预填到输入框供用户补充/确认，不直接发送
    if (cmd.argumentHint || isRunning) {
      setInsertTextRequest({ text: `/${cmd.name} `, seq: Date.now(), replace: true });
      return;
    }
    void onSendMessage(`/${cmd.name}`);
  };

  // ===== 会话产物 / 后台进程抽屉 =====
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [bgJobsOpen, setBgJobsOpen] = useState(false);
  const [artifactsUnseen, setArtifactsUnseen] = useState(false);
  const [hasRunningBgJobs, setHasRunningBgJobs] = useState(false);
  const [bgJobs, setBgJobs] = useState<BgJobRecord[]>([]);
  const [selectedBgJobId, setSelectedBgJobId] = useState<string | null>(null);

  // ===== 代码变更抽屉 =====
  const [diffDrawerOpen, setDiffDrawerOpen] = useState(false);
  const [insertTextRequest, setInsertTextRequest] = useState<{ text: string; seq: number; replace?: boolean } | null>(null);

  // ===== 右侧抽屉「双栏常驻（Pin 模式）」=====
  // 偏好持久化到 localStorage；开启后抽屉与主对话并排展示，不再遮挡输入
  const [drawerPinned, setDrawerPinned] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('botd-drawer-pinned') === '1';
    } catch {
      return false;
    }
  });
  const toggleDrawerPin = useCallback(() => {
    setDrawerPinned((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('botd-drawer-pinned', next ? '1' : '0');
      } catch {
        // 隐私模式等场景下静默降级为会话内记忆
      }
      return next;
    });
  }, []);

  // 宽屏探测：Pin 布局只在 lg(1024px)+ 生效，窄屏自动回退为浮层抽屉
  const [isWideScreen, setIsWideScreen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  );
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent) => setIsWideScreen(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  const drawerPinnedActive = drawerPinned && isWideScreen;

  // ===== 扩展 UI（ctx.ui 桥接）=====
  // editor_text 事件预填输入框（mode=set 替换 / paste 追加）；挂件与状态徽标由 extensionUiState 渲染
  useEffect(() => {
    const unsubscribe = onGlobalEvent((e) => {
      if (e.type !== 'extension_ui' || e.sessionId !== session.id || e.event.kind !== 'editor_text') return;
      const { text, mode } = e.event;
      setInsertTextRequest({ text, seq: Date.now(), replace: mode === 'set' });
    });
    return unsubscribe;
  }, [session.id]);

  // 用户手动收起的挂件 key（会话内记忆，直到扩展重设该挂件）
  const [dismissedWidgetKeys, setDismissedWidgetKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    setDismissedWidgetKeys(new Set());
  }, [session.id]);

  const visibleWidgets = useMemo(() => {
    const widgets = Object.values(extensionUiState?.widgets ?? {}).filter(
      (w) => !dismissedWidgetKeys.has(w.key),
    );
    widgets.sort((a, b) => a.updatedAt - b.updatedAt);
    return widgets;
  }, [extensionUiState, dismissedWidgetKeys]);

  const aboveEditorWidgets = visibleWidgets.filter((w) => w.placement !== 'belowEditor');
  const belowEditorWidgets = visibleWidgets.filter((w) => w.placement === 'belowEditor');

  // 挂件按钮交互回流：spec 含 Button 时切到 ask 模式，点击后把命令/表单回灌到输入框发送
  const handleWidgetSubmit = (payloadJson: string) => {
    try {
      const parsed = JSON.parse(payloadJson);
      const cmd = parsed?.params?.command;
      if (typeof cmd === 'string' && cmd.trim()) {
        const stateStr =
          parsed?.state && Object.keys(parsed.state).length > 0
            ? ` ${JSON.stringify(parsed.state)}`
            : '';
        void onSendMessage(`${cmd.trim()}${stateStr}`);
        return;
      }
    } catch {
      // 非 JSON payload，回退为原文发送
    }
    void onSendMessage(payloadJson);
  };

  const renderWidget = (widget: ExtensionWidgetState) => {
    // 含 Button 的挂件切 ask 模式（可点击、运行中禁用），纯展示挂件保持 display
    const hasInteractiveButtons = Boolean(
      widget.uiSpec && Object.values(widget.uiSpec.elements).some((el) => el.type === 'Button')
    );
    return (
      <div
        key={widget.key}
        className="relative rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-2.5 shadow-xs"
      >
        <button
          type="button"
          onClick={() =>
            setDismissedWidgetKeys((prev) => {
              const next = new Set(prev);
              next.add(widget.key);
              return next;
            })
          }
          className="absolute top-1.5 right-1.5 p-1 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          aria-label={`收起挂件 ${widget.key}`}
          title="收起挂件"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        {widget.uiSpec ? (
          <div className="pr-6">
            <BotdUiRenderer
              spec={widget.uiSpec}
              mode={hasInteractiveButtons ? 'ask' : 'display'}
              disabled={isRunning}
              onSubmit={hasInteractiveButtons ? handleWidgetSubmit : undefined}
            />
          </div>
        ) : (
          <pre className="pr-6 font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
            {(widget.lines ?? []).join('\n')}
          </pre>
        )}
      </div>
    );
  };

  // ===== 会话切换守卫 =====
  // 异步响应提交前校验会话未变，防止 A 会话的在途响应覆盖 B 会话的界面
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;

  // ===== 子会话内联检视：点击消息内 #?s= 链接或协同面板步骤时打开右侧 SubSessionDrawer，不离开父会话 =====
  const [inspectingSubSessionId, setInspectingSubSessionId] = useState<string | null>(null);

  // 未拉到真实记录前，用匹配的 SubagentRunRecord 合成兜底 SessionRecord，让抽屉立即打开
  const inspectingSubSession = useMemo(() => {
    if (!inspectingSubSessionId) return null;
    const matchingRun = findSubagentRunByChildSessionId(
      activeSubagentRuns,
      messages,
      inspectingSubSessionId
    );
    const leadId = matchingRun?.subagentId || session.leadBotId;
    return {
      id: inspectingSubSessionId,
      title: matchingRun?.task || inspectingSubSessionId,
      leadBotId: leadId,
      status:
        matchingRun?.status === 'running'
          ? ('running' as const)
          : matchingRun?.status === 'error'
            ? ('failed' as const)
            : ('idle' as const),
      parentSessionId: session.id,
      createdAt: matchingRun?.startedAt || session.createdAt,
      updatedAt: matchingRun?.startedAt || session.updatedAt,
    };
  }, [inspectingSubSessionId, activeSubagentRuns, messages, session]);

  // 探测本会话后台进程：成员节点集合派生 join 字符串作稳定依赖，成员不变时 fetchBgJobs 引用不换新
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
  const fetchBgJobsRef = useRef(fetchBgJobs);
  fetchBgJobsRef.current = fetchBgJobs;

  // 切换会话时重置抽屉与状态标记
  const prevMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    setArtifactsUnseen(false);
    setHasRunningBgJobs(false);
    setBgJobs([]);
    setSelectedBgJobId(null);
    setInspectingSubSessionId(null);
    prevMessagesLengthRef.current = messages.length;
  }, [session.id]);

  // 会话或成员节点集合变化时立即探测一次后台进程
  useEffect(() => {
    void fetchBgJobsRef.current();
  }, [session.id, memberNodeIdsKey]);

  // 消息条数实际发生变化（包括 callback 消息到达）时拉取后台进程，避免仅引用变化引起的无效请求
  useEffect(() => {
    if (messages.length === prevMessagesLengthRef.current) return;
    prevMessagesLengthRef.current = messages.length;
    void fetchBgJobsRef.current();
  }, [messages.length]);

  const hasActiveWork = bgJobs.some((j) => j.status === 'running');

  // 统一轮询：存在运行中后台进程时 5s 轮询，闲置时降频至 30s；
  // interval 仅依赖 hasActiveWork 布尔值并经 ref 调用最新加载函数，避免被高频重渲染拆建导致降频计时不断重置
  useEffect(() => {
    const interval = window.setInterval(() => {
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

  // ===== 顶栏 Space（项目工作目录）徽标与快速绑定 =====
  // 目录可能挂在 session 或 BOT 上；绑定通过 PATCH /api/sessions/:id 即时生效
  const sessionWorkspaceDir =
    (session as { workspaceDir?: string }).workspaceDir ||
    (directBot as { workspaceDir?: string } | undefined)?.workspaceDir ||
    '';
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [spaceInput, setSpaceInput] = useState('');
  const [spaceBusy, setSpaceBusy] = useState(false);
  const spaceMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSpaceMenuOpen(false);
    setSpaceInput(sessionWorkspaceDir);
  }, [session.id, sessionWorkspaceDir]);

  // 点击外部关闭 Space 绑定浮层
  useEffect(() => {
    if (!spaceMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (spaceMenuRef.current && !spaceMenuRef.current.contains(e.target as Node)) {
        setSpaceMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSpaceMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [spaceMenuOpen]);

  const commitSpaceDir = async () => {
    const dir = spaceInput.trim();
    if (spaceBusy) return;
    setSpaceBusy(true);
    try {
      await api.updateSession(session.id, { workspaceDir: dir } as never);
      onAddToast?.('success', dir ? `已绑定项目目录 ${dir}` : '已解绑项目目录');
      setSpaceMenuOpen(false);
    } catch (err: unknown) {
      onAddToast?.('error', err instanceof Error ? err.message : '绑定项目目录失败');
    } finally {
      setSpaceBusy(false);
    }
  };

  // ===== 全局开发快捷键 =====
  // Cmd/Ctrl+. 切换代码变更抽屉；Cmd/Ctrl+Shift+J 切换后台进程抽屉；Cmd/Ctrl+Shift+O 开启新话题
  // 经 ref 调用最新回调，避免依赖变化导致监听反复拆建；输入框聚焦时同样生效（可随时切换右栏视野）
  const toggleDiffDrawerRef = useRef(() => setDiffDrawerOpen((v) => !v));
  toggleDiffDrawerRef.current = () => setDiffDrawerOpen((v) => !v);
  const toggleBgJobsRef = useRef(() => {
    setSelectedBgJobId(null);
    setBgJobsOpen((v) => !v);
    setHasRunningBgJobs(false);
  });
  toggleBgJobsRef.current = () => {
    setSelectedBgJobId(null);
    setBgJobsOpen((v) => !v);
    setHasRunningBgJobs(false);
  };
  const newTopicRef = useRef(() => void onNewTopic(session.id));
  newTopicRef.current = () => void onNewTopic(session.id);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === '.') {
        e.preventDefault();
        toggleDiffDrawerRef.current();
      } else if (e.shiftKey && (e.key === 'J' || e.key === 'j')) {
        e.preventDefault();
        toggleBgJobsRef.current();
      } else if (e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        newTopicRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ===== 代码变更抽屉静默刷新信号 =====
  // 会话消息数或流式工具状态变化时，打开中的右栏 diff 跟随左栏对话实时刷新
  const streamingToolSignal = useMemo(
    () =>
      streamingStates
        .map(
          (s) =>
            `${s.botId}:${s.tools.map((t) => `${t.toolName}@${t.status}`).join(',')}`
        )
        .join('|'),
    [streamingStates]
  );
  const diffRefreshSignal = `${messages.length}:${streamingToolSignal}`;

  // 用 ref 避免订阅 effect 依赖抽屉开关导致反复重订阅
  const artifactsOpenRef = useRef(false);
  const bgJobsOpenRef = useRef(false);
  artifactsOpenRef.current = artifactsOpen;
  bgJobsOpenRef.current = bgJobsOpen;

  // 全局 SSE：本会话 artifact_created 且抽屉未开时置红点；后台进程完成的回调到达时重新探测
  // 订阅仅依赖 session.id，经 ref 调用最新 fetchBgJobs，不再每 render 退订重订
  useEffect(() => {
    const unsubscribe = onGlobalEvent((e) => {
      if (e.type === 'artifact_created' && e.sessionId === session.id) {
        if (!artifactsOpenRef.current) setArtifactsUnseen(true);
      } else if (
        e.type === 'message_created' &&
        e.message.sessionId === session.id &&
        e.message.role === 'callback' &&
        e.message.content.includes('[Background Job')
      ) {
        if (!bgJobsOpenRef.current) void fetchBgJobsRef.current();
      }
    });
    return unsubscribe;
  }, [session.id]);

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

  // 扩展状态徽标：workingMessage（会话运行中）与各 statusKey
  const statusEntries = useMemo(() => {
    if (!extensionUiState) return [];
    const entries: { botId: string; label: string }[] = [];
    if (isRunning) {
      for (const [botId, message] of Object.entries(extensionUiState.workingMessages)) {
        entries.push({ botId, label: `@${botMap.get(botId)?.name || botId}: ${message}` });
      }
    }
    for (const { botId, text } of Object.values(extensionUiState.statuses)) {
      entries.push({ botId, label: text });
    }
    return entries;
  }, [extensionUiState, isRunning, botMap]);
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

  // 空输入框按 ↑：直接进入「编辑上一条用户消息」流程（复用 Slack 式编辑态）。
  // 优先级高于 ChatInput 内部的本地发送历史栈；运行中的会话不可编辑，回落到历史栈行为。
  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i];
    }
    return null;
  }, [messages]);

  const handleRecallLastMessage = useCallback(() => {
    if (session.status === 'running') return false;
    if (!lastUserMessage) return false;
    setEditingMessage(lastUserMessage);
    return true;
  }, [session.status, lastUserMessage]);

  // 从实时 activeSubagentRuns 或已落库 messages 中派生抽屉当前查看的最新子代理运行记录：
  // 后台完成 / resume / stop 更新时，打开的抽屉能实时热更新
  const inspectingRun = useMemo<SubagentRunRecord | null>(() => {
    if (!inspectingRunId) return null;
    // 优先实时流状态（主回合仍在跑）
    for (const runs of Object.values(activeSubagentRuns)) {
      const hit = runs.find((r) => r.id === inspectingRunId);
      if (hit) return hit;
    }
    // 已落库消息（后台完成 / resume 更新已持久化）；
    // 历史「自己挂自己」的镜像 run 可能缺 replyFull/blocks/toolCalls，
    // 用宿主消息自身内容兑底补全，保证抽屉可完整展示
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const hit = msg.subagentRuns?.find((r) => r.id === inspectingRunId);
      if (hit) {
        if (!hit.replyFull && hit.subagentId === msg.senderBotId) {
          return {
            ...hit,
            replyFull: msg.content,
            blocks: hit.blocks ?? msg.blocks,
            toolCalls: hit.toolCalls ?? msg.toolCalls,
          };
        }
        return hit;
      }
    }
    return null;
  }, [inspectingRunId, activeSubagentRuns, messages]);

  // 拦截消息正文内指向子会话的 #?s=sess_... 链接：目标是其他会话时就地打开检视抽屉，
  // 不跳转离开父会话；按住修饰键（新标签/窗口）时放行浏览器默认行为
  const handleRootClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const match = anchor.getAttribute('href')?.match(/^#\?s=(sess_[a-zA-Z0-9_-]+)$/);
      if (!match) return;
      if (match[1] === session.id) return;
      e.preventDefault();
      setInspectingSubSessionId(match[1]);
    },
    [session.id]
  );

  // 工作流步骤 / 本地子代理运行的统一检视入口（分流逻辑见 resolveRunInspectionTarget）：
  // 带 childSessionId 的编排步骤打开跨BOT子会话抽屉，否则走本地子代理运行抽屉
  const handleInspectRun = useCallback(
    (run: SubagentRunRecord | null) => {
      const target = resolveRunInspectionTarget(run);
      if (target.kind === 'none') {
        onInspectSubagentRun?.(null);
        return;
      }
      if (target.kind === 'subsession') {
        onInspectSubagentRun?.(null);
        setInspectingSubSessionId(target.childSessionId);
        return;
      }
      setInspectingSubSessionId(null);
      onInspectSubagentRun?.(target.run);
    },
    [onInspectSubagentRun]
  );

  return (
    <div className="flex-1 flex h-full bg-white dark:bg-zinc-950 overflow-hidden">
      {/* 左侧主聊天列：抽屉固定分栏时右移让位，其余时刻独占全宽 */}
      <div
        className="flex-1 min-w-0 flex flex-col h-full overflow-hidden"
        onClick={handleRootClick}
      >
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
                directBot && isDirectNodeOnline
                  ? 'cursor-pointer hover:opacity-85 transition-opacity'
                  : ''
              }`}
              onClick={
                directBot && isDirectNodeOnline
                  ? () => setBotEditorOpen(true)
                  : undefined
              }
              title={
                directBot
                  ? isDirectNodeOnline
                    ? directBot.parentBotId
                      ? `点击打开子代理「${directBot.name}」设置`
                      : `点击打开智能体「${directBot.name}」设置`
                    : '节点离线'
                  : undefined
              }
            >
              <h2 className="font-semibold text-sm sm:text-base text-zinc-900 dark:text-zinc-100 truncate">
                {session.title}
              </h2>

              {/* Space（项目工作目录）徽标：点击弹出轻量绑定浮层 */}
              <div className="relative shrink-0" ref={spaceMenuRef}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSpaceMenuOpen((v) => !v);
                  }}
                  title={sessionWorkspaceDir || '绑定当前会话对应的本地项目目录'}
                  className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium transition-colors cursor-pointer max-w-40 sm:max-w-56 ${
                    sessionWorkspaceDir
                      ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      : 'border border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-600'
                  }`}
                >
                  <FolderGit2 className="w-3 h-3 shrink-0" />
                  <span className="truncate font-mono">
                    {sessionWorkspaceDir
                      ? sessionWorkspaceDir.split('/').filter(Boolean).pop() || sessionWorkspaceDir
                      : '绑定项目目录'}
                  </span>
                </button>
                {spaceMenuOpen && (
                  <div className="absolute left-0 top-full mt-1.5 w-72 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-800 rounded-xl shadow-lg p-2.5 z-50 animate-in fade-in">
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-1.5 leading-relaxed">
                      绑定当前会话对应的本地项目目录（如 /root/code/botd），留空即解绑。
                    </p>
                    <input
                      autoFocus
                      type="text"
                      value={spaceInput}
                      disabled={spaceBusy}
                      onChange={(e) => setSpaceInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void commitSpaceDir();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setSpaceMenuOpen(false);
                        }
                      }}
                      placeholder="/root/code/my-project"
                      aria-label="项目工作目录"
                      className="w-full px-2 py-1.5 text-xs font-mono bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400"
                    />
                    <div className="flex items-center justify-end gap-1.5 mt-2">
                      <button
                        type="button"
                        onClick={() => setSpaceMenuOpen(false)}
                        disabled={spaceBusy}
                        className="px-2.5 py-1 rounded-lg text-xs text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() => void commitSpaceDir()}
                        disabled={spaceBusy}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium transition-colors cursor-pointer"
                      >
                        {spaceBusy && <Loader2 className="w-3 h-3 animate-spin-fast" />}
                        保存
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右侧操作：常驻上下文水位胶囊 + 开启新话题 + 产物/后台进程抽屉入口 + 更多操作下拉菜单 */}
        <div className="flex items-center gap-1 shrink-0">
          {/* 上下文水位常驻胶囊：>0 即展示；>=75% 琥珀色预警，点击发送 /compact */}
          {latestCtxPct > 0 && (
            <button
              type="button"
              onClick={() => void onSendMessage('/compact')}
              className={`inline-flex items-center gap-1.5 h-8 rounded-lg text-xs font-medium transition-colors cursor-pointer shrink-0 border mr-0.5 ${
                latestCtxPct >= 75
                  ? 'px-2.5 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60'
                  : 'px-2 bg-zinc-50 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200/80 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
              title={
                latestCtxPct >= 75
                  ? '当前上下文水位较高，点击自动发送 /compact 进行上下文压缩'
                  : `当前上下文水位 ${latestCtxPct}%，点击发送 /compact 主动压缩`
              }
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  latestCtxPct >= 75 ? 'bg-amber-500 animate-pulse' : 'bg-zinc-400 dark:bg-zinc-500'
                }`}
              />
              <span className="font-mono tabular-nums">Ctx {latestCtxPct}%</span>
              {latestCtxPct >= 75 && <span className="hidden md:inline">· 压缩</span>}
            </button>
          )}

          {/* 开启新话题 */}
          <button
            onClick={() => void onNewTopic(session.id)}
            className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="开启新话题 (Ctrl/Cmd+Shift+O)"
            aria-label="开启新话题"
          >
            <MessageSquarePlus className="w-4 h-4" />
          </button>

          {/* 历史话题（单聊专属）：打开当前主 BOT 或子代理的历史话题抽屉 */}
          {directBot && (
            <button
              type="button"
              onClick={() => setHistoryDrawerOpen(true)}
              className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              title={`历史话题（${directBot.name}）`}
              aria-label={`查看 ${directBot.name} 的历史话题`}
            >
              <HistoryIcon className="w-4 h-4" />
            </button>
          )}

          {/* 智能体/子代理设置（单聊专属）：打开自身设置界面 */}
          {directBot && (
            <button
              type="button"
              onClick={() => setBotEditorOpen(true)}
              disabled={!isDirectNodeOnline}
              className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                !isDirectNodeOnline
                  ? '节点离线，无法编辑配置'
                  : directBot.parentBotId
                  ? `子代理设置（${directBot.name}）`
                  : `智能体设置（${directBot.name}）`
              }
              aria-label={directBot.parentBotId ? '子代理设置' : '智能体设置'}
            >
              <SettingsIcon className="w-4 h-4" />
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

          {/* 后台进程抽屉入口：本会话存在 running 进程时蓝点 */}
          <div className="relative">
            <button
              onClick={() => {
                setSelectedBgJobId(null);
                setBgJobsOpen(true);
                setHasRunningBgJobs(false);
              }}
              className="h-8 w-8 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors cursor-pointer"
              title="后台进程 (Ctrl/Cmd+Shift+J)"
              aria-label="后台进程"
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

          {/* 代码变更抽屉入口：查看 BOT 工作区 Git 净变更 */}
          <button
            type="button"
            onClick={() => setDiffDrawerOpen(true)}
            className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
              diffDrawerOpen
                ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400'
                : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
            title="代码变更 (Ctrl/Cmd+.)"
            aria-label="代码变更"
          >
            <FileDiff className="w-4 h-4" />
          </button>

          {/* 更多操作下拉菜单：收纳分享、重命名、定时与触发器、清空、删除等低频操作（绝不与外显图标重复） */}
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
                    setShareModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>分享对话</span>
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

      {/* 中断恢复横幅：失败 / 中断会话一键继续（已完成的工作区变更与步骤已保留） */}
      {session.status === 'failed' && !isRunning && (
        <div className="mx-3 sm:mx-4 mt-2.5 px-3 py-2 bg-blue-50/90 dark:bg-blue-950/40 border border-blue-200/80 dark:border-blue-900/60 rounded-lg flex items-center justify-between gap-2 text-xs text-blue-800 dark:text-blue-300 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <PlayCircle className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
            <span>上次执行已中断或失败，已完成的工作区变更与步骤已保留。</span>
          </div>
          <button
            type="button"
            disabled={Boolean(directBot && !isDirectNodeOnline)}
            onClick={() => void onSendMessage('继续')}
            title={directBot && !isDirectNodeOnline ? '目标计算节点离线，恢复上线后可继续' : '发送「继续」接着执行'}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-white dark:bg-zinc-900 border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/60 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer shadow-2xs"
          >
            继续执行
          </button>
        </div>
      )}

      {/* 消息时间线：与子代理运行抽屉共用的唯一渲染器（滚动/分页/流式网格/回到底部均在内部） */}
      <MessageTimeline
        messages={messages}
        streamingStates={streamingStates}
        botMap={botMap}
        nodeMap={nodeMap}
        session={session}
        loadingMessages={loadingMessages}
        loadError={loadError}
        onRetryLoad={onRetryLoad}
        highlightMessageId={highlightMessageId}
        onStartEdit={startEdit}
        onForkMessage={handleForkMessage}
        onInspectSubagentRun={handleInspectRun}
        editingMessage={editingMessage}
        canEdit={canEdit}
        hasEarlierMessages={hasEarlierMessages}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={onLoadEarlier}
        keyboardInset={keyboardInset}
        activeSubagentRunsFor={activeSubagentRuns}
      />

      {/* 后台进程运行中状态条 */}
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
              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              <span className="font-medium shrink-0">
                {runningBgJobs.length} 个后台进程运行中
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

      {/* 扩展 UI：输入框上方挂件（composer.widget 插槽）+ 扩展状态徽标栏 */}
      {aboveEditorWidgets.length > 0 && (
        <div className="px-3 sm:px-4 pb-2 max-w-4xl w-full mx-auto space-y-2 shrink-0">
          {aboveEditorWidgets.map(renderWidget)}
        </div>
      )}
      {statusEntries.length > 0 && (
        <div className="px-3 sm:px-4 pb-1.5 max-w-4xl w-full mx-auto shrink-0">
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200/70 dark:border-zinc-800/70 text-[11px] text-zinc-600 dark:text-zinc-300">
            {statusEntries.map((entry, idx) => (
              <span
                key={`${entry.botId}-${idx}`}
                className="inline-flex items-center gap-1.5 max-w-full truncate"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                <span className="truncate">{entry.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 扩展命令快捷胶囊（composer.pill 插槽）：编辑态隐藏，避免与编辑表单抢焦点 */}
      {extensionCommands.length > 0 && !editingMessage && (
        <div className="px-3 sm:px-4 pb-1.5 max-w-4xl w-full mx-auto shrink-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {extensionCommands.map((cmd) => (
              <button
                key={cmd.name}
                type="button"
                onClick={() => handleExtensionPillClick(cmd)}
                title={cmd.description || `/${cmd.name}`}
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 text-[11px] font-mono text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 hover:text-zinc-900 dark:hover:border-zinc-700 dark:hover:text-zinc-100 transition-colors cursor-pointer shadow-2xs"
              >
                <Sparkles className="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />
                <span className="max-w-[12rem] truncate">/{cmd.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 底部输入框：将 isRunning, cancelling, onCancelSession 传给 ChatInput 实现发送/停止二合一；
          编辑态复用输入框（享受斜杠/提及补全、自动增高与 IME 处理） */}
      <ChatInput
        sessionId={session.id}
        leadBotId={session.leadBotId}
        isSubagentSession={false}
        botMap={botMap}
        onSendMessage={onSendMessage}
        memberBots={mentionableBots}
        nodeMap={nodeMap}
        isRunning={isRunning}
        cancelling={cancelling}
        onCancelSession={onCancelSession}
        editingMessage={editingMessage}
        onSubmitEditing={handleSubmitEdit}
        onCancelEditing={() => setEditingMessage(null)}
        insertTextRequest={insertTextRequest}
        onRecallLastMessage={handleRecallLastMessage}
      />

      {/* 扩展 UI：输入框下方挂件（placement='belowEditor'） */}
      {belowEditorWidgets.length > 0 && (
        <div className="px-3 sm:px-4 pb-2 max-w-4xl w-full mx-auto space-y-2 shrink-0">
          {belowEditorWidgets.map(renderWidget)}
        </div>
      )}

      {/* 移动端软键盘动态避让垫片：iOS Safari 键盘弹起时垫起输入框，消除悬空与空白 */}
      {keyboardInset > 0 && (
        <div
          style={{ height: `${keyboardInset}px` }}
          className="w-full shrink-0"
          aria-hidden="true"
        />
      )}
      </div>{/* /左侧主聊天列 */}

      {/* 右侧固定抽屉列（Pin 模式）：代码变更优先，其次子代理运行详情；窄屏自动隐藏 */}
      {drawerPinnedActive && (diffDrawerOpen || Boolean(inspectingRun)) && (
        <div className="hidden lg:flex w-[440px] xl:w-[540px] shrink-0 border-l border-zinc-200/90 dark:border-zinc-800/90 h-full">
          {diffDrawerOpen ? (
            <WorkspaceDiffDrawer
              isOpen
              pinned
              onTogglePin={toggleDrawerPin}
              sessionId={session.id}
              bot={directBot || botMap.get(session.leadBotId)}
              messages={messages}
              onClose={() => setDiffDrawerOpen(false)}
              onQuoteFile={(filePath) => {
                setInsertTextRequest({ text: `\`${filePath}\` `, seq: Date.now() });
              }}
              onQuoteDiffLine={(quoteText) => {
                setInsertTextRequest({ text: `${quoteText} `, seq: Date.now() });
              }}
              refreshSignal={diffRefreshSignal}
            />
          ) : (
            <SubagentRunDrawer
              isOpen
              pinned
              onTogglePin={toggleDrawerPin}
              sessionId={session.id}
              run={inspectingRun}
              botMap={botMap}
              nodeMap={nodeMap}
              onClose={() => onInspectSubagentRun?.(null)}
              onToast={(type, message) => onAddToast?.(type, message)}
            />
          )}
        </div>
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

      {/* 代码变更抽屉（浮层模式）：查看工作区 Git 净变更，引用文件路径/行插入输入框；Pin 分栏时由右列渲染 */}
      {!drawerPinnedActive && (
        <WorkspaceDiffDrawer
          isOpen={diffDrawerOpen}
          sessionId={session.id}
          bot={directBot || botMap.get(session.leadBotId)}
          messages={messages}
          onClose={() => setDiffDrawerOpen(false)}
          onTogglePin={toggleDrawerPin}
          onQuoteFile={(filePath) => {
            setInsertTextRequest({ text: `\`${filePath}\` `, seq: Date.now() });
          }}
          onQuoteDiffLine={(quoteText) => {
            setInsertTextRequest({ text: `${quoteText} `, seq: Date.now() });
          }}
          refreshSignal={diffRefreshSignal}
        />
      )}

      {/* 分享对话弹窗 */}
      {shareModalOpen && (
        <ShareSessionModal
          sessionId={session.id}
          onClose={() => setShareModalOpen(false)}
        />
      )}

      {/* 单聊专属：当前主 BOT 或子代理的历史话题抽屉 */}
      {directBot && (
        <BotHistoryDrawer
          isOpen={historyDrawerOpen}
          bot={directBot}
          onClose={() => setHistoryDrawerOpen(false)}
          onOpenSession={(sid) => {
            setHistoryDrawerOpen(false);
            window.location.hash = `#?s=${sid}&v=chat`;
          }}
          onAddToast={(type, message) => onAddToast?.(type, message)}
          onDeleteSessions={onDeleteSessions}
        />
      )}

      {/* 单聊专属：当前主 BOT 或子代理的设置弹窗 */}
      {directBot && (
        <BotEditorModal
          isOpen={botEditorOpen}
          node={directNode}
          bot={directBot}
          parentBot={parentBot}
          initialTab="basic"
          onClose={() => setBotEditorOpen(false)}
          onSaved={async () => {
            onAddToast?.(
              'success',
              directBot.parentBotId ? '子代理配置已成功更新' : '智能体配置已成功更新'
            );
            await onRefreshNodes?.();
          }}
        />
      )}

      {/* 后台进程抽屉 */}
      <BgJobsDrawer
        isOpen={bgJobsOpen}
        sessionId={session.id}
        memberBotIds={[session.leadBotId]}
        botMap={botMap}
        nodeMap={nodeMap}
        initialJobId={selectedBgJobId}
        onClose={() => {
          setBgJobsOpen(false);
          setSelectedBgJobId(null);
        }}
        onToast={(type, message) => onAddToast?.(type, message)}
      />

      {/* 子代理运行详情抽屉（浮层模式）：与主对话同源的时间线 + Steer/Resume/停止控制；Pin 分栏时由右列渲染 */}
      {!drawerPinnedActive && (
        <SubagentRunDrawer
          isOpen={Boolean(inspectingRunId)}
          sessionId={session.id}
          run={inspectingRun}
          botMap={botMap}
          nodeMap={nodeMap}
          onClose={() => onInspectSubagentRun?.(null)}
          onTogglePin={toggleDrawerPin}
          onToast={(type, message) => onAddToast?.(type, message)}
        />
      )}

      {/* 跨 BOT 子会话内联检视抽屉：不离开父会话就地查看/插话子任务 */}
      <SubSessionDrawer
        isOpen={Boolean(inspectingSubSession)}
        subSession={inspectingSubSession}
        botMap={botMap}
        nodeMap={nodeMap}
        onClose={() => setInspectingSubSessionId(null)}
        onOpenFullSession={(sid) => {
          setInspectingSubSessionId(null);
          window.location.hash = `#?s=${sid}`;
        }}
        onToast={(type, message) => onAddToast?.(type, message)}
      />
    </div>
  );
};
