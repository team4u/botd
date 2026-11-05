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
  Share2,
  Sparkles,
  History as HistoryIcon,
  FolderGit2,
  Zap,
  Plus,
} from 'lucide-react';
import type {
  SessionRecord,
  MessageRecord,
  BotConfig,
  NodeRecord,
  NodeWithBots,
  MessageAttachment,
  PendingAskRecord,
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
import { ShareSessionModal } from './ShareSessionModal';
import { BotHistoryDrawer } from './BotHistoryDrawer';
import { WorkersDrawer } from './WorkersDrawer';
import { useSuperAgentWorkers, isWorkerActive } from '../hooks/useSuperAgentWorkers';
import { BotEditorModal } from './BotEditorModal';
import {
  resolveContextTabGroup,
  getSessionAttention,
  ATTENTION_VISUALS,
  type ContextTabGroup,
} from '../session-space';
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
  /** 是否还有更早的历史消息可加载（App 负责分页） */
  hasEarlierMessages?: boolean;
  /** 正在加载更早消息 */
  loadingEarlier?: boolean;
  /** 加载更早消息（App 负责 prepend） */
  onLoadEarlier?: () => void;
  /** 搜索跳转定位高亮的消息 id */
  highlightMessageId?: string | null;
  /** 全部会话列表（顶栏 Context Tab Bar 数据源） */
  sessions?: SessionRecord[];
  /** sessionId -> 未读消息数 */
  unreadCounts?: Record<string, number>;
  /** 切换到同容器下的另一个会话 Tab */
  onSelectSession?: (sessionId: string) => void;
  /** 归档（关闭）一个会话 Tab */
  onSetArchived?: (sessionId: string, archived: boolean) => Promise<void> | void;
  /** 在当前空间/助理下并列新建话题 Tab（不归档旧会话） */
  onCreateParallelTopic?: (input: {
    leadBotId: string;
    workspaceDir?: string;
    title?: string;
  }) => Promise<void> | void;
  /** 会话被服务端更新（如绑定/解绑项目目录）后回调，供父层同步全局列表 */
  onSessionUpdated?: (updated: SessionRecord) => void;
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
  hasEarlierMessages = false,
  loadingEarlier = false,
  onLoadEarlier,
  highlightMessageId = null,
  sessions: sessionListProp,
  unreadCounts = {},
  onSelectSession,
  onSetArchived,
  onCreateParallelTopic,
  onSessionUpdated,
}) => {
  const keyboardInset = useKeyboardInset();

  // Super-agent 全双工后台工作单元（Worker / Workflow / Speculative）：
  // 顶栏 ⚡ 角标入口 + 子任务抽屉（列表⇄详情）干预（steer / followUp / stop），不打断前台对话
  const superAgent = useSuperAgentWorkers(session.id);
  const { spawnBackgroundWorker } = superAgent;

  // 后台子任务抽屉：initialWorkerId 非空时直接定位到该 worker 详情
  const [workersDrawerOpen, setWorkersDrawerOpen] = useState(false);
  const [workersDrawerInitial, setWorkersDrawerInitial] = useState<string | null>(null);
  const openWorkersDrawer = useCallback((initialWorkerId: string | null) => {
    setWorkersDrawerInitial(initialWorkerId);
    setWorkersDrawerOpen(true);
  }, []);
  const closeWorkersDrawer = useCallback(() => {
    setWorkersDrawerOpen(false);
    superAgent.setSelectedWorkerId(null);
  }, [superAgent]);

  // Watchdog 健康巡检：列表与详情视图共用（runPass=1 先跑一轮巡检再出报告）
  const runWatchdog = async (): Promise<{ healthy: boolean; summary: string } | null> => {
    try {
      const res = await api.getWatchdogHealth(true);
      return { healthy: res.healthy, summary: res.summary || '巡检完成' };
    } catch {
      return null;
    }
  };

  // 本会话主控智能体（提前声明：蓝点探测/SSE/设置等多处使用）
  // useMemo 稳定引用：下游 mentionableBots 等派生链不会每次 render 失稳
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

  // ===== 会话产物抽屉 =====
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactsUnseen, setArtifactsUnseen] = useState(false);

  const [insertTextRequest, setInsertTextRequest] = useState<{ text: string; seq: number; replace?: boolean } | null>(null);

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

  // 切换会话时重置抽屉与状态标记
  const prevMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    setArtifactsUnseen(false);
    prevMessagesLengthRef.current = messages.length;
  }, [session.id]);

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

  // ===== 会话产物计数（顶栏产物入口徽标数）=====
  // 会话加载时拉取一次列表，之后靠 SSE artifact_created 增量去重追加，
  // 让「会话产物」按钮上的数字随会话生命周期实时可见
  const [artifactItems, setArtifactItems] = useState<Array<{ id?: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    setArtifactItems([]);
    api
      .listSessionArtifacts(session.id)
      .then((list) => {
        if (!cancelled) setArtifactItems(list.map((a) => ({ id: a.id })));
      })
      .catch(() => {
        // 拉取失败时徽标退化为无数字展示，抽屉内部仍会重试
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const openArtifacts = useCallback(() => {
    setArtifactsOpen(true);
    setArtifactsUnseen(false);
  }, []);

  useEffect(() => {
    const unsubscribe = onGlobalEvent((e) => {
      if (e.type !== 'artifact_created' || e.sessionId !== session.id) return;
      setArtifactItems((prev) =>
        prev.some((a) => a.id === e.artifact.id) ? prev : [...prev, { id: e.artifact.id }]
      );
    });
    return unsubscribe;
  }, [session.id]);

  const artifactCount = artifactItems.length;

  // ===== 后台子任务角标（顶栏 ⚡ 按钮）=====
  // 徽章分层：活跃（蓝，呼吸图标）> 失败（玫瑰红）> 全部完成（安静灰）
  const workersActiveCount = superAgent.workers.filter((w) => isWorkerActive(w.status)).length;
  const workersFailedCount = superAgent.workers.filter((w) => w.status === 'failed').length;
  const workersBadge =
    workersActiveCount > 0
      ? { count: workersActiveCount, className: 'bg-blue-600' }
      : workersFailedCount > 0
        ? { count: workersFailedCount, className: 'bg-rose-600' }
        : { count: superAgent.workers.length, className: 'bg-zinc-400 dark:bg-zinc-600' };
  const workersTitle =
    workersActiveCount > 0
      ? `后台子任务：${workersActiveCount} 运行 · ${superAgent.workers.length - workersActiveCount} 完成`
      : workersFailedCount > 0
        ? `后台子任务：${workersFailedCount} 失败`
        : '后台子任务';
  const openWorkersFromBadge = () => {
    if (superAgent.workers.length === 1) {
      const workerId = superAgent.workers[0].workerId;
      superAgent.setSelectedWorkerId(workerId);
      setWorkersDrawerInitial(workerId);
    } else {
      setWorkersDrawerInitial(null);
    }
    setWorkersDrawerOpen(true);
  };

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
      const updated = await api.updateSession(session.id, { workspaceDir: dir } as never);
      onSessionUpdated?.(updated);
      onAddToast?.('success', dir ? `已绑定项目目录 ${dir}` : '已解绑项目目录');
      setSpaceMenuOpen(false);
    } catch (err: unknown) {
      onAddToast?.('error', err instanceof Error ? err.message : '绑定项目目录失败');
    } finally {
      setSpaceBusy(false);
    }
  };

  // 顶栏副标题：工作目录取尾段（如 /root/code/botd -> botd），
  // 以 10px 等宽交字静静躺在标题下方，不再占用头部行宽
  const currentSpaceName = sessionWorkspaceDir
    ? sessionWorkspaceDir.split('/').filter(Boolean).pop() || sessionWorkspaceDir
    : '';

  // 已用项目空间去重列表：从全部会话与分身中提取非空 workspaceDir，供绑定浮层快选
  const usedWorkspaceDirs = useMemo(() => {
    const dirs = new Set<string>();
    const add = (raw: unknown) => {
      if (typeof raw !== 'string') return;
      const dir = raw.trim().replace(/\/+$/, '');
      if (dir) dirs.add(dir);
    };
    for (const s of sessionListProp || []) add((s as { workspaceDir?: string }).workspaceDir);
    for (const b of botMap.values()) add((b as { workspaceDir?: string }).workspaceDir);
    return [...dirs].sort((a, b) => a.localeCompare(b));
  }, [sessionListProp, botMap]);

  // 纯个人助理单聊：未绑定任何项目目录。此场景收敛工程噪音（后台任务角标、
  // 并行话题标签页等工程入口），让普通用户拥有零心智负担的纯净对话界面。
  const isPureAssistantChat = !sessionWorkspaceDir.trim();

  // ===== 顶栏 Context Tab Bar（Herdr 风格水平多标签工作台）=====
  // 当前会话所属容器（Space 或个人助理）与平级未归档主会话 Tabs；
  // Space 会话或 >= 2 个并行话题时才渲染标签栏，单聊保持纯净 IM 顶栏
  const contextGroup: ContextTabGroup | null = useMemo(
    () =>
      resolveContextTabGroup(
        session,
        sessionListProp && sessionListProp.length > 0 ? sessionListProp : [session],
        Array.from(botMap.values())
      ),
    [session, sessionListProp, botMap]
  );
  const showContextTabs = Boolean(
    contextGroup && (contextGroup.kind === 'space' || contextGroup.tabs.length > 1)
  );

  // 关闭 Tab：归档目标会话；若关的是当前激活 Tab 则切到相邻 Tab
  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (!contextGroup) return;
      const idx = contextGroup.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      void onSetArchived?.(tabId, true);
      if (tabId === session.id && onSelectSession && contextGroup.tabs.length > 1) {
        const neighbor = contextGroup.tabs[idx + 1] || contextGroup.tabs[idx - 1];
        if (neighbor && neighbor.id !== tabId) onSelectSession(neighbor.id);
      }
    },
    [contextGroup, onSetArchived, session.id, onSelectSession]
  );

  // ===== 全局开发快捷键 =====
  // Cmd/Ctrl+Shift+O 开启新话题；经 ref 调用最新回调，避免依赖变化导致监听反复拆建
  const newTopicRef = useRef(() => void onNewTopic(session.id));
  newTopicRef.current = () => void onNewTopic(session.id);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        newTopicRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 用 ref 避免订阅 effect 依赖抽屉开关导致反复重订阅
  const artifactsOpenRef = useRef(false);
  artifactsOpenRef.current = artifactsOpen;

  // 全局 SSE：本会话 artifact_created 且抽屉未开时置红点
  useEffect(() => {
    const unsubscribe = onGlobalEvent((e) => {
      if (e.type === 'artifact_created' && e.sessionId === session.id) {
        if (!artifactsOpenRef.current) setArtifactsUnseen(true);
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

  return (
    <div className="flex-1 flex h-full bg-white dark:bg-zinc-950 overflow-hidden">
      {/* 左侧主聊天列：抽屉固定分栏时右移让位，其余时刻独占全宽 */}
      <div
        className="flex-1 min-w-0 flex flex-col h-full overflow-hidden"
      >
      {/* 极简顶栏（h-13 sm:h-14）：左侧身份区（侧栏开关 + 徽章 + 标题/工作目录副标题），
          右侧仅 3 个紧凑触发器（新话题 / 产物 / 更多菜单），移动端不再挤压标题 */}
      <header className="h-13 sm:h-14 px-2.5 sm:px-4 bg-white dark:bg-zinc-950 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between gap-1 shrink-0 z-10">
        {/* 左侧身份区 */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0 flex-1">
          <button
            onClick={onToggleSidebar}
            className="w-9 h-9 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg lg:hidden cursor-pointer shrink-0"
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
            /* 标题/副标题：点击标题行内重命名 */
            <div
              className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer group/title"
              onClick={startRename}
              title="点击重命名会话"
            >
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="font-semibold text-sm sm:text-base text-zinc-900 dark:text-zinc-100 truncate">
                  {session.title}
                </span>
                <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                  {directBot ? `${directBot.name}${currentSpaceName ? ` · ${currentSpaceName}` : ''}` : currentSpaceName}
                </span>
              </div>
              <Pencil className="w-3 h-3 text-zinc-300 dark:text-zinc-600 shrink-0 sm:opacity-0 sm:group-hover/title:opacity-100 transition-opacity" />
            </div>
          )}
        </div>

        {/* 右侧 3 个紧凑触发器：开启新话题 / 会话产物（有产物或桌面端展示）/ 更多操作菜单 */}
        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          <button
            onClick={() => void onNewTopic(session.id)}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="开启新话题 (Ctrl/Cmd+Shift+O)"
            aria-label="开启新话题"
          >
            <MessageSquarePlus className="w-4 h-4" />
          </button>

          {/* 后台子任务：有任务才占位（桌面端零任务也完全隐藏）；纯助理单聊收敛工程入口 */}
          {!isPureAssistantChat && superAgent.workers.length > 0 && (
            <button
              onClick={openWorkersFromBadge}
              className="relative w-9 h-9 inline-flex items-center justify-center rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              title={workersTitle}
              aria-label={workersTitle}
            >
              <Zap
                className={`w-4 h-4 ${
                  workersActiveCount > 0 ? 'text-blue-500 dark:text-blue-400 animate-pulse' : ''
                }`}
              />
              <span
                className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full ${workersBadge.className} text-white text-[9px] font-semibold flex items-center justify-center pointer-events-none`}
              >
                {workersBadge.count > 99 ? '99+' : workersBadge.count}
              </span>
            </button>
          )}

          {/* 会话产物：桌面端常驻，移动端有产物或未读红点时才占位，徽标展示数量 */}
          <button
            onClick={openArtifacts}
            className={`relative w-9 h-9 items-center justify-center rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer ${
              artifactCount > 0 || artifactsUnseen ? 'inline-flex' : 'hidden sm:inline-flex'
            }`}
            title="会话产物"
            aria-label="会话产物"
          >
            <Package className="w-4 h-4" />
            {artifactCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-blue-600 text-white text-[9px] font-semibold flex items-center justify-center pointer-events-none">
                {artifactCount > 99 ? '99+' : artifactCount}
              </span>
            )}
          </button>

          {/* 更多操作下拉菜单：收纳全部二级与控制台操作（绝不与外显图标重复） */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors cursor-pointer ${
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
                className="absolute right-0 top-full mt-1.5 w-60 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-800 rounded-xl shadow-lg py-1 z-50 animate-in fade-in"
              >
                {/* 上下文水位 + 一键压缩：内联进度条，点击发送 /compact */}
                {latestCtxPct > 0 && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void onSendMessage('/compact');
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                    title="发送 /compact 主动压缩上下文"
                  >
                    <Hourglass className={`w-3.5 h-3.5 shrink-0 ${latestCtxPct >= 75 ? 'text-amber-500' : 'text-zinc-400'}`} />
                    <span className="flex-1 text-left whitespace-nowrap">
                      上下文水位 Ctx {latestCtxPct}% · 压缩
                    </span>
                    <span className="w-14 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden shrink-0">
                      <span
                        className={`block h-full rounded-full ${
                          latestCtxPct >= 75 ? 'bg-amber-500' : 'bg-zinc-400 dark:bg-zinc-500'
                        }`}
                        style={{ width: `${latestCtxPct}%` }}
                      />
                    </span>
                  </button>
                )}

                {directBot && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setHistoryDrawerOpen(true);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <HistoryIcon className="w-3.5 h-3.5" />
                    <span className="whitespace-nowrap">历史话题</span>
                  </button>
                )}

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    openWorkersDrawer(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap">派发后台任务 / 巡检</span>
                </button>

                {onCreateParallelTopic && !isPureAssistantChat && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void onCreateParallelTopic({
                        leadBotId: session.leadBotId,
                        workspaceDir: contextGroup?.spacePath || undefined,
                      });
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span className="whitespace-nowrap">新建并行话题标签页</span>
                  </button>
                )}

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setSpaceMenuOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <FolderGit2 className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap truncate">{sessionWorkspaceDir ? `工作区 ${currentSpaceName}` : '设置工作区目录'}</span>
                </button>

                {directBot && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setBotEditorOpen(true);
                    }}
                    disabled={!isDirectNodeOnline}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    title={!isDirectNodeOnline ? '节点离线，无法编辑配置' : undefined}
                  >
                    <SettingsIcon className="w-3.5 h-3.5" />
                    <span className="whitespace-nowrap">{directBot.parentBotId ? '子代理设置' : '智能体设置'}</span>
                  </button>
                )}

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setTriggersOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap">定时与触发器</span>
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
                  <span className="whitespace-nowrap">分享只读快照</span>
                </button>

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    openArtifacts();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Package className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap">查看会话产物{artifactCount > 0 ? `（${artifactCount}）` : ''}</span>
                </button>

                <div className="my-1 border-t border-zinc-100 dark:border-zinc-800/80" />

                <button
                  role="menuitem"
                  onClick={startRename}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  <span>重命名会话…</span>
                </button>

                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmAction('clear');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                >
                  <Eraser className="w-3.5 h-3.5" />
                  <span>清空对话记录</span>
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

      {/* 顶栏 Context Tab Bar（Herdr 风格水平多标签工作台）：
          Space 会话或当前助理有 >= 2 个并行话题时展示 */}
      {showContextTabs && contextGroup && (
        <div className="h-9 px-2.5 sm:px-4 bg-zinc-50/90 dark:bg-zinc-900/80 border-b border-zinc-200/70 dark:border-zinc-800/70 flex items-center gap-1 overflow-x-auto shrink-0">
          {/* 左侧容器徽标：Space 可点击弹出目录绑定浮层；Assistant 显示头像 */}
          {contextGroup.kind === 'space' ? (
            <button
              type="button"
              onClick={() => setSpaceMenuOpen(true)}
              title={`${contextGroup.label}（${contextGroup.spacePath}）· 点击绑定目录`}
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[11px] font-mono font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <FolderGit2 className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
              <span className="max-w-[120px] truncate">{contextGroup.label}</span>
            </button>
          ) : (
            contextGroup.leadBot && (
              <span className="shrink-0 inline-flex items-center gap-1 px-1 py-0.5">
                <span className="text-[11px] font-mono font-semibold text-zinc-600 dark:text-zinc-300 max-w-[100px] truncate">
                  {contextGroup.label}
                </span>
              </span>
            )
          )}
          <span className="shrink-0 text-zinc-300 dark:text-zinc-600 select-none" aria-hidden="true">
            |
          </span>

          {/* 平级会话 Tabs：状态灯 + 标题 + 未读 + 关闭归档 */}
          {contextGroup.tabs.map((tab) => {
            const isCurrent = tab.id === session.id;
            const tabAttention = getSessionAttention(tab, unreadCounts[tab.id] ?? 0);
            const tabUnread = isCurrent ? 0 : unreadCounts[tab.id] ?? 0;
            return (
              <div
                key={tab.id}
                className={`group/tab shrink-0 inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-md border text-xs transition-all cursor-pointer max-w-[180px] ${
                  isCurrent
                    ? 'bg-white dark:bg-zinc-800 border-zinc-300/80 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'bg-transparent border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'
                }`}
                onClick={() => {
                  if (!isCurrent) onSelectSession?.(tab.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !isCurrent) {
                    e.preventDefault();
                    onSelectSession?.(tab.id);
                  }
                }}
                title={tab.title}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    tabAttention === 'idle'
                      ? 'bg-zinc-300 dark:bg-zinc-600'
                      : ATTENTION_VISUALS[tabAttention].dot
                  }`}
                />
                <span className="truncate">{tab.title}</span>
                {tabUnread > 0 && (
                  <span className="shrink-0 bg-red-500 text-white text-[9px] font-semibold rounded-full min-w-[14px] h-3.5 px-1 flex items-center justify-center">
                    {tabUnread > 99 ? '99+' : tabUnread}
                  </span>
                )}
                {contextGroup.tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTab(tab.id);
                    }}
                    title="归档关闭该标签页"
                    aria-label={`关闭标签页 ${tab.title}`}
                    className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/80 dark:hover:bg-zinc-700/80 transition-colors cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}

          {/* 末尾 [+]：在当前空间/助理下并列新建标签页 */}
          <button
            type="button"
            onClick={() =>
              onCreateParallelTopic?.({
                leadBotId: session.leadBotId,
                workspaceDir: contextGroup.spacePath || undefined,
              })
            }
            title="在当前空间/助理下新建并行标签页"
            aria-label="新建并行标签页"
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 工作区目录绑定浮层：锚定顶栏左侧（更多菜单入口），编辑当前会话的项目目录 */}
      {spaceMenuOpen && (
        <div className="px-2.5 sm:px-4 pt-2 max-w-4xl w-full mx-auto shrink-0 z-10">
          <div ref={spaceMenuRef} className="relative">
            <div className="relative w-72 max-w-full bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-800 rounded-xl shadow-lg p-2.5 animate-in fade-in">
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
              {/* 已有项目空间快选芯片：点击直接填入，免去手打长路径 */}
              {usedWorkspaceDirs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {usedWorkspaceDirs.map((dir) => {
                    const name = dir.split('/').filter(Boolean).pop() || dir;
                    const selected = spaceInput.trim().replace(/\/+$/, '') === dir;
                    return (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => setSpaceInput(dir)}
                        title={dir}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border transition-colors cursor-pointer ${
                          selected
                            ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                            : 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <FolderGit2 className="w-3 h-3" />
                        <span>{name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
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
        onInspectSubagentRun={(run) => {
          if (run) openWorkersDrawer(run.id);
        }}
        editingMessage={editingMessage}
        canEdit={canEdit}
        hasEarlierMessages={hasEarlierMessages}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={onLoadEarlier}
        keyboardInset={keyboardInset}
        activeSubagentRunsFor={activeSubagentRuns}
      />

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

      {/* Super-agent 后台子任务抽屉：列表⇄详情一体（派发/巡检/中止/Steer/Follow-up 全双工干预） */}
      <WorkersDrawer
        isOpen={workersDrawerOpen}
        workers={superAgent.workers}
        botMap={botMap}
        nodeMap={nodeMap}
        initialWorkerId={workersDrawerInitial ?? undefined}
        onSelectWorker={(workerId) => superAgent.setSelectedWorkerId(workerId)}
        onStopWorker={(workerId) => {
          void superAgent.stopWorker(workerId);
        }}
        onSpawnWorker={spawnBackgroundWorker}
        onRunWatchdog={runWatchdog}
        onSteer={superAgent.steerWorker}
        onClose={closeWorkersDrawer}
      />
    </div>
  );
};
