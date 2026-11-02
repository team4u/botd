import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type {
  SessionRecord,
  MessageRecord,
  NodeWithBots,
  BotConfig,
  NodeRecord,
  CreateSessionInput,
  SessionSseEvent,
  GlobalSseEvent,
  MessageAttachment,
  PendingAskRecord,
  SubagentRunRecord,
  TurnBlock,
} from '@botd/protocol';
import { api, AuthRequiredError, subscribeGlobalEvents } from './api';
import { emitGlobalEvent } from './events';
import type { StreamingAssistantState, ToolExecutionState, ToastItem, MainViewTab, UserInfo } from './types';
import { LoginView } from './components/LoginView';
import { Sidebar, pickCurrentDirectSession } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { CreateSessionModal } from './components/CreateSessionModal';
import { GroupSettingsModal } from './components/GroupSettingsModal';
import { NodesBotsView } from './components/NodesBotsView';
import { SettingsModal } from './components/SettingsModal';
import { UsersModal } from './components/UsersModal';
import { ToastContainer } from './components/Toast';
import { Loader2, Menu, Bot } from 'lucide-react';
import {
  mergeMessagesPage,
  isSnapshotCurrent,
  truncateMessagesAtAnchor,
  updateStreamingMap,
  clearStreamingMap,
  mergePendingAsks,
} from './utils/message-state';

// 全局 hash 路由：视图/当前会话/弹窗统一编码进 URL hash（如 #?v=nodes&s=xxx&m=settings），
// 页面重载/手机后台回收后原样恢复。不引路由库，hash 即状态单一来源。
type ModalName = 'create' | 'group' | 'settings' | 'users';

/** 会话内消息高亮定位：搜索跳转等场景通过 msg 参数携带目标消息 ID */
interface HashRoute {
  view: MainViewTab;
  sessionId: string | null;
  modal: ModalName | null;
  messageId: string | null;
}

const parseHash = (): HashRoute => {
  const raw = window.location.hash.replace(/^#[?]?/, '');
  const params = new URLSearchParams(raw);
  const m = params.get('m');
  return {
    view: params.get('v') === 'nodes' ? 'nodes' : 'chat',
    sessionId: params.get('s'),
    modal: m === 'create' || m === 'group' || m === 'settings' || m === 'users' ? m : null,
    messageId: params.get('msg'),
  };
};

const buildHash = (route: HashRoute): string => {
  const params = new URLSearchParams();
  if (route.view !== 'chat') params.set('v', route.view);
  if (route.sessionId) params.set('s', route.sessionId);
  if (route.modal) params.set('m', route.modal);
  if (route.messageId) params.set('msg', route.messageId);
  const qs = params.toString();
  return qs ? `#?${qs}` : '';
};

/** 非当前会话新消息提示音：150ms 880Hz→660Hz 短促 beep（Web Audio，失败静默） */
const playNotificationBeep = () => {
  try {
    const AudioCtor: typeof AudioContext | undefined =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.linearRampToValueAtTime(660, now + 0.15);
    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {
    // Web Audio 不可用时静默降级
  }
};

export const App: React.FC = () => {
  // Auth state
  const [authChecking, setAuthChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const authenticatedRef = useRef(false);
  const [currentUser, setCurrentUser] = useState<UserInfo | null>(null);

  // View state（视图/当前会话/弹窗统一进 hash 路由）
  const [route, setRoute] = useState<HashRoute>(parseHash);
  const { view: currentView, sessionId: activeSessionId, modal: openModal } = route;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Data state
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  // 全局 SSE 分流时同步读取最新列表（避免闭包拿到陈旧数据）
  const sessionsRef = useRef<SessionRecord[]>([]);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef<string | null>(null);

  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const messagesRef = useRef<MessageRecord[]>([]);
  messagesRef.current = messages;

  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [nodes, setNodes] = useState<NodeWithBots[]>([]);
  // node_status 事件分流时同步读取最新节点列表
  const nodesRef = useRef<NodeWithBots[]>([]);
  nodesRef.current = nodes;
  const [loadingNodes, setLoadingNodes] = useState(false);

  // 多 BOT 并发流式状态（按 botId 隔离索引，互不覆盖）
  const [streamingStatesMap, setStreamingStatesMap] = useState<Record<string, StreamingAssistantState>>({});
  // 活跃分身执行轨迹（按主 BOT ID 隔离索引，供 ChatView 展示实时分身协同）
  const [subagentRunsMap, setSubagentRunsMap] = useState<Record<string, SubagentRunRecord[]>>({});
  const [cancelling, setCancelling] = useState(false);

  // 当前会话待处理的人机协同交互请求（botd ask）
  const [pendingAsks, setPendingAsks] = useState<PendingAskRecord[]>([]);

  // Toast notifications
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // 非当前会话未读计数（sessionId → 条数）：进入会话清零、登出清空
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  // 聚合未读数写入 document.title（登出/无未读时恢复默认标题）
  useEffect(() => {
    const total = authenticated
      ? Object.values(unreadCounts).reduce((sum, n) => sum + n, 0)
      : 0;
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) botd` : 'botd · 多节点个人智能体平台';
  }, [unreadCounts, authenticated]);

  // 历史消息分页：是否还有更早消息 / 加载中（ref 防重入，state 供 UI 展示）
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);

  // Epoch counter for session changes to protect against race conditions
  const sessionEpochRef = useRef<number>(0);
  // idle 后延迟清理流式状态的定时器：等待取消场景下晚到的部分输出消息落位
  const pendingCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Snapshot sequence number for out-of-order & truncation invalidation protection
  const snapshotSeqRef = useRef<number>(0);
  // 本地发起的历史截断锚点记录（防止 HTTP 与 SSE 竞态误切新回复）
  const clientTruncatedAnchorRef = useRef<string | null>(null);
  // 已响应的人机协同请求记录，防止拉取慢快照时重新复活已解决 ask
  const resolvedAskIdsRef = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  // 单聊静默创建并发防抖：创建进行中忽略重复点击
  const creatingBotChatRef = useRef(false);

  // 会话分叉并发防抖：分叉请求进行中忽略重复点击
  const forkingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Synchronize refs
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // hash 路由：navigate 更新 route state，副作用同步到 URL（replaceState 不污染历史栈）；
  // 同时监听 hashchange（手动改 URL / 分享链接），从 hash 反向解析
  const navigate = useCallback(
    (patch: Partial<HashRoute> | ((prev: HashRoute) => Partial<HashRoute>)) => {
      setRoute((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
    },
    []
  );

  useEffect(() => {
    const hash = buildHash(route);
    window.history.replaceState(null, '', hash || window.location.pathname + window.location.search);
  }, [route]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  const addToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Bot & Node maps for fast lookups
  const { botMap, allBots, nodeMap } = useMemo(() => {
    const bMap = new Map<string, BotConfig>();
    const nMap = new Map<string, NodeRecord>();
    const botsList: BotConfig[] = [];

    nodes.forEach((node) => {
      nMap.set(node.id, node);
      (node.bots || []).forEach((bot) => {
        bMap.set(bot.id, bot);
        botsList.push(bot);
      });
    });

    return { botMap: bMap, allBots: botsList, nodeMap: nMap };
  }, [nodes]);

  // 全局 SSE 回调里读取最新 botMap（订阅不随会话/节点重建，避免闭包拿到陈旧映射）
  const botMapRef = useRef(botMap);
  botMapRef.current = botMap;

  // Active session object
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );

  // Check auth on mount，成功后再取当前用户信息（未拿到则回登录页）
  useEffect(() => {
    let mounted = true;
    api.checkAuth()
      .then(async (isAuth) => {
        if (!isAuth) {
          if (!mounted) return;
          setAuthenticated(false);
          authenticatedRef.current = false;
          setAuthChecking(false);
          return;
        }
        try {
          const me = await api.me();
          if (!mounted) return;
          setCurrentUser(me.user || null);
          setAuthenticated(true);
          authenticatedRef.current = true;
        } catch {
          if (!mounted) return;
          setCurrentUser(null);
          setAuthenticated(false);
          authenticatedRef.current = false;
        } finally {
          if (mounted) setAuthChecking(false);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setAuthenticated(false);
        authenticatedRef.current = false;
        setAuthChecking(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Surface real network/auth errors, do NOT individually catch with empty arrays
  const loadInitialData = useCallback(async () => {
    try {
      setLoadingNodes(true);
      const [fetchedNodes, fetchedSessions] = await Promise.all([
        api.getNodes(),
        api.getSessions(),
      ]);

      if (!isMountedRef.current) return;

      setNodes(fetchedNodes);
      setSessions(fetchedSessions);

      // Preserve valid active session or select first
      navigate((prev) => {
        if (prev.sessionId && fetchedSessions.some((s) => s.id === prev.sessionId)) {
          return {};
        }
        return { sessionId: fetchedSessions[0]?.id || null };
      });
    } catch (err: any) {
      if (!isMountedRef.current) return;
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
      } else {
        addToast('error', err?.message || '初始化数据加载失败');
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingNodes(false);
      }
    }
  }, [addToast]);

  useEffect(() => {
    if (authenticated) {
      loadInitialData();
    }
  }, [authenticated, loadInitialData]);

  // Modest polling every 10s for nodes when authenticated & window focused
  useEffect(() => {
    if (!authenticated) return;

    const pollInterval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!authenticatedRef.current || !isMountedRef.current) return;

      api.getNodes()
        .then((fetchedNodes) => {
          if (!authenticatedRef.current || !isMountedRef.current) return;
          setNodes(fetchedNodes);
        })
        .catch((err: any) => {
          if (!authenticatedRef.current || !isMountedRef.current) return;
          if (err instanceof AuthRequiredError || err?.status === 401) {
            setAuthenticated(false);
            authenticatedRef.current = false;
          }
        });
    }, 10000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [authenticated]);

  // Load messages with epoch/seq guards and merge fetched snapshot with live incoming SSE messages
  const loadMessagesForSession = useCallback(async (sessionId: string, epoch: number) => {
    if (!isMountedRef.current || activeSessionIdRef.current !== sessionId || sessionEpochRef.current !== epoch) return;
    const seq = ++snapshotSeqRef.current;
    const meta = { sessionId, epoch, seq };
    const isCurrentSnapshot = () => isMountedRef.current && isSnapshotCurrent(
      activeSessionIdRef.current, sessionEpochRef.current, snapshotSeqRef.current, meta
    );
    const knownLiveIdsAtStart = new Set(messagesRef.current.map((m) => m.id));

    setLoadingMessages(true);
    setLoadError(null);

    // 同步拉取当前待处理的人机协同请求（静默失败，不影响消息加载）
    api
      .getPendingAsks(sessionId)
      .then((asks) => {
        if (!isCurrentSnapshot()) return;
        setPendingAsks((prev) => mergePendingAsks(prev, asks, resolvedAskIdsRef.current));
      })
      .catch(() => {
        // 静默失败，保留当前已有待响应 ask，不覆盖为空
      });

    try {
      // 首载取最新一页（60 条），更早历史由 ChatView「加载更早」按游标分页拉取
      const fetched = await api.getSessionMessagesPage(sessionId, { limit: 60 });

      if (!isCurrentSnapshot()) return;

      setMessages((currentLive) => {
        if (!isCurrentSnapshot()) return currentLive;
        const next = mergeMessagesPage(currentLive, fetched.messages, knownLiveIdsAtStart, fetched.hasMore);
        messagesRef.current = next;
        return next;
      });
      setHasEarlierMessages(fetched.hasMore);
    } catch (err: any) {
      if (!isCurrentSnapshot()) return;
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
      } else {
        setLoadError(err?.message || '读取历史消息记录失败');
      }
    } finally {
      if (isCurrentSnapshot()) setLoadingMessages(false);
    }
  }, []);

  // 加载更早历史：以当前最早一条消息为游标向前取一页并 prepend，
  // 与 SSE 实时到达的新消息按 id 去重兼容；loadingEarlierRef 防重入
  const handleLoadEarlier = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    const oldest = messagesRef.current[0];
    if (!sessionId || !oldest || loadingEarlierRef.current) return;

    const epoch = sessionEpochRef.current;
    const seq = snapshotSeqRef.current;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);

    try {
      const result = await api.getSessionMessagesPage(sessionId, { before: oldest.id, limit: 60 });
      // Guard：会话已切换或期间发生快照刷新（截断/重连补拉）则丢弃本次结果
      if (
        !isMountedRef.current ||
        sessionEpochRef.current !== epoch ||
        activeSessionIdRef.current !== sessionId ||
        snapshotSeqRef.current !== seq
      ) {
        return;
      }
      setHasEarlierMessages(result.hasMore);
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const older = result.messages.filter((m) => !existingIds.has(m.id));
        if (older.length === 0) return prev;
        const next = [...older, ...prev];
        messagesRef.current = next;
        return next;
      });
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
      } else {
        addToast('error', err?.message || '加载更早消息失败');
      }
    } finally {
      loadingEarlierRef.current = false;
      if (isMountedRef.current) {
        setLoadingEarlier(false);
      }
    }
  }, [addToast]);

  // 统一历史截断/失效动作：立即按 anchorMessageId 截断，使旧快照请求失效，并发起新快照
  const handleHistoryInvalidation = useCallback((anchorMessageId: string, updatedContent?: string, clientInitiated = false) => {
    const sessionId = activeSessionIdRef.current;
    const epoch = sessionEpochRef.current;
    if (!sessionId) return;

    if (clientInitiated) {
      // 客户端主动发起的编辑：记录 anchor，防止后续广播/响应竞态误把新回复截断
      clientTruncatedAnchorRef.current = anchorMessageId;
      setMessages((prev) => {
        const next = truncateMessagesAtAnchor(prev, anchorMessageId, updatedContent);
        messagesRef.current = next;
        return next;
      });
      snapshotSeqRef.current++;
      return;
    }

    // 服务端广播 (messages_truncated)：
    if (clientTruncatedAnchorRef.current === anchorMessageId) {
      // 若当前客户端已先行动作，消费标记并放行（不重复 slice，避免把正在生成/已到达的新回复切掉）
      clientTruncatedAnchorRef.current = null;
      loadMessagesForSession(sessionId, epoch);
      return;
    }

    // 其他标签页/服务端发起的截断：立即按 anchorMessageId 截断，使旧请求失效，并拉取最新快照
    setMessages((prev) => {
      const next = truncateMessagesAtAnchor(prev, anchorMessageId, updatedContent);
      messagesRef.current = next;
      return next;
    });
    snapshotSeqRef.current++;
    loadMessagesForSession(sessionId, epoch);
  }, [loadMessagesForSession]);

  // 会话切换：立即清空消息/流式/待响应状态防鬼影，bump epoch 使旧快照失效，并加载新会话首屏。
  // 注意：全局 SSE 订阅不随会话切换重建（见下方 effect），切换本身只做状态清理与历史加载。
  useEffect(() => {
    // 切换会话即复位取消状态：取消动作只针对原会话，切走后停止按钮不得永久卡在「正在停止...」
    setCancelling(false);
    if (!authenticated || !activeSessionId) {
      setStreamingStatesMap(clearStreamingMap());
      setPendingAsks([]);
      setMessages([]);
      setHasEarlierMessages(false);
      return;
    }

    const currentEpoch = ++sessionEpochRef.current;
    snapshotSeqRef.current++;
    clientTruncatedAnchorRef.current = null;
    resolvedAskIdsRef.current.clear();
    activeSessionIdRef.current = activeSessionId;

    // Immediately clear messages and stream on session switch to prevent ghosting
    setMessages([]);
    setStreamingStatesMap(clearStreamingMap());
    setPendingAsks([]);
    setHasEarlierMessages(false);
    // 进入会话即清零该会话未读
    setUnreadCounts((prev) =>
      prev[activeSessionId] ? { ...prev, [activeSessionId]: 0 } : prev
    );

    // Load initial message history
    loadMessagesForSession(activeSessionId, currentEpoch);
  }, [authenticated, activeSessionId, loadMessagesForSession]);

  // 全局 SSE 订阅：登录后建立一条连接（不随会话切换重建），登出时关闭。
  // 事件先 emitGlobalEvent 喂给全局总线（供产物抽屉等组件消费），再分流：
  // - node_status：patch 本地节点状态，未知节点触发一次节点列表刷新；
  // - 当前会话事件：走完整处理（流式/工具状态/消息/截断/人机协同/会话状态）；
  // - 其他会话事件：仅处理 assistant/callback 消息（未读+提醒）与 session_status。
  useEffect(() => {
    if (!authenticated) return;

    // 后台完成通知：页面不可见时以浏览器 Web Notification 提醒用户回合结束；点击聚焦并跳回来源会话
    const notifyBackgroundCompletion = (message: MessageRecord) => {
      if (typeof Notification === 'undefined') return;
      if (document.visibilityState !== 'hidden') return;
      if (Notification.permission !== 'granted') return;
      try {
        const botName = botMapRef.current.get(message.senderBotId || '')?.name || message.senderBotId || '智能体';
        const preview = (message.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const title =
          message.role === 'callback' ? `${botName} 的后台任务有回调` : `${botName} 已完成回复`;
        const body = preview || '回合已结束，点击返回查看';
        const notification = new Notification(title, { body, tag: `botd-${message.sessionId}` });
        notification.onclick = () => {
          window.focus();
          // navigate 为稳定 useCallback，闭包内可安全引用；跳回来源会话并清除高亮
          navigate({ sessionId: message.sessionId, view: 'chat', messageId: null });
          notification.close();
        };
      } catch {
        // 通知构造失败（如部分环境限制）时静默降级
      }
    };

    // 更新单个 BOT 的并发流式状态（按 botId 隔离互不覆盖）
    const updateStreamingStates = (
      botId: string,
      updater: (prev: StreamingAssistantState | undefined) => StreamingAssistantState | null
    ) => {
      // 新流式活动到达：取消 idle 后的延迟清理，避免误删正在进行的状态
      if (pendingCleanupTimerRef.current) {
        clearTimeout(pendingCleanupTimerRef.current);
        pendingCleanupTimerRef.current = null;
      }
      setStreamingStatesMap((prevMap) => updateStreamingMap(prevMap, botId, updater));
    };

    // 当前会话事件全量处理（分流层已保证事件属于当前活跃会话）
    const handleCurrentSessionEvent = (event: SessionSseEvent) => {
      switch (event.type) {
        case 'thinking_stream': {
          updateStreamingStates(event.botId, (prev) => {
            const currentBlocks: TurnBlock[] = prev?.blocks ? [...prev.blocks] : [];
            const lastBlock = currentBlocks[currentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'thinking' && lastBlock.status === 'running') {
              const updated = { ...lastBlock };
              if (event.delta) {
                updated.thinking += event.delta;
              }
              if (event.status) {
                updated.status = event.status;
              }
              if (event.durationMs !== undefined) {
                updated.durationMs = event.durationMs;
              }
              currentBlocks[currentBlocks.length - 1] = updated;
            } else if (event.status === 'running' || event.delta) {
              currentBlocks.push({
                type: 'thinking',
                thinking: event.delta || '',
                status: event.status ?? 'running',
                ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
              });
            }
            return {
              botId: event.botId,
              delta: prev?.delta || '',
              tools: prev?.tools || [],
              blocks: currentBlocks,
            };
          });
          break;
        }

        case 'text_delta': {
          updateStreamingStates(event.botId, (prev) => {
            const currentBlocks: TurnBlock[] = prev?.blocks ? [...prev.blocks] : [];
            const lastBlock = currentBlocks[currentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'text') {
              currentBlocks[currentBlocks.length - 1] = {
                ...lastBlock,
                text: lastBlock.text + event.delta,
              };
            } else {
              currentBlocks.push({
                type: 'text',
                text: event.delta,
              });
            }
            return {
              botId: event.botId,
              delta: (prev?.delta || '') + event.delta,
              tools: prev?.tools || [],
              blocks: currentBlocks,
            };
          });
          break;
        }

        case 'tool_status': {
          updateStreamingStates(event.botId, (prev) => {
            const toolItem: ToolExecutionState = {
              id: event.toolCallId,
              toolName: event.toolName,
              status: event.status,
              summary: event.summary,
              args: event.args,
              outputPreview: event.outputPreview,
              durationMs: event.durationMs,
              isError: event.isError,
              updatedAt: Date.now(),
            };

            const currentTools = prev?.tools || [];
            const existingIdx = currentTools.findIndex(
              (t) =>
                (event.toolCallId && t.id === event.toolCallId) ||
                (!event.toolCallId && t.toolName === event.toolName && t.status === 'running')
            );
            let nextTools = [...currentTools];
            if (existingIdx >= 0) {
              nextTools[existingIdx] = toolItem;
            } else {
              nextTools.push(toolItem);
            }

            const currentBlocks: TurnBlock[] = prev?.blocks ? [...prev.blocks] : [];
            const toolBlockId = event.toolCallId || event.toolName;
            const existingBlockIdx = currentBlocks.findIndex(
              (b) =>
                b.type === 'tool' &&
                (b.id === toolBlockId || (b.name === event.toolName && b.status === 'running'))
            );

            const toolBlock: TurnBlock = {
              type: 'tool',
              id: event.toolCallId || `${event.toolName}_${Date.now()}`,
              name: event.toolName,
              ...(event.args ? { args: event.args } : {}),
              ...(event.summary ? { summary: event.summary } : {}),
              status: event.status,
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
              ...(event.outputPreview !== undefined ? { outputPreview: event.outputPreview } : {}),
              ...(event.isError !== undefined ? { isError: event.isError } : {}),
            };

            if (existingBlockIdx >= 0) {
              const existing = currentBlocks[existingBlockIdx] as Extract<TurnBlock, { type: 'tool' }>;
              currentBlocks[existingBlockIdx] = {
                ...existing,
                ...toolBlock,
                args: event.args ?? existing.args,
                summary: event.summary ?? existing.summary,
              };
            } else {
              currentBlocks.push(toolBlock);
            }

            return {
              botId: event.botId,
              delta: prev?.delta || '',
              tools: nextTools,
              blocks: currentBlocks,
            };
          });
          break;
        }

        case 'message_created': {
          // 消息已落位，取消待执行的延迟清理（取消场景的部分输出已持久化，可立即接管）
          if (pendingCleanupTimerRef.current) {
            clearTimeout(pendingCleanupTimerRef.current);
            pendingCleanupTimerRef.current = null;
          }
          setMessages((prev) => {
            if (prev.some((m) => m.id === event.message.id)) {
              return prev;
            }
            const next = [...prev, event.message];
            messagesRef.current = next;
            return next;
          });

          // If message was created by the streaming assistant, clear streaming state
          if (event.message.senderBotId) {
            updateStreamingStates(event.message.senderBotId, () => null);
          }

          // 后台完成通知：助手回复或回调到达且页面不可见时发浏览器通知
          if (event.message.role === 'assistant' || event.message.role === 'callback') {
            notifyBackgroundCompletion(event.message);
          }
          break;
        }

        case 'messages_truncated': {
          // 编辑用户消息后：按锚点统一截断历史，使旧请求失效并刷新
          handleHistoryInvalidation(event.anchorMessageId);
          break;
        }

        case 'interaction_request': {
          // BOT 发起的人机协同请求：追加到待响应列表
          setPendingAsks((prev) => {
            if (prev.some((a) => a.id === event.ask.id)) return prev;
            return [...prev.filter((a) => a.id !== event.ask.id && a.status === 'pending'), event.ask];
          });
          break;
        }

        case 'interaction_resolved': {
          // 人机协同请求已响应：从待响应列表移除并记录，防止后续被慢快照重新复活
          resolvedAskIdsRef.current.add(event.askId);
          setPendingAsks((prev) => prev.filter((a) => a.id !== event.askId));
          break;
        }

        case 'session_status': {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === event.sessionId
                ? {
                    ...s,
                    status: event.status,
                    activeBotId: event.activeBotId,
                    activeBotIds: event.activeBotIds,
                    queuePlan:
                      event.status === 'idle' || event.status === 'failed'
                        ? []
                        : event.queuePlan ?? s.queuePlan ?? [],
                  }
                : s
            )
          );

          if (event.status === 'idle' || event.status === 'failed') {
            // 取消场景：cancelSession 立即广播 idle，但节点随后才返回部分输出（message_created）。
            // 立即清空会闪空屏；延迟一拍清理，若期间部分输出/新流式事件到达则自然接管。
            setStreamingStatesMap((prevMap) => {
              if (Object.keys(prevMap).length === 0) return prevMap;
              if (pendingCleanupTimerRef.current) clearTimeout(pendingCleanupTimerRef.current);
              pendingCleanupTimerRef.current = setTimeout(() => {
                pendingCleanupTimerRef.current = null;
                setStreamingStatesMap((prev) => {
                  // 仅当仍是同一会话且无新流式活动时才清空
                  if (activeSessionIdRef.current === event.sessionId) return clearStreamingMap();
                  return prev;
                });
              }, 600);
              return prevMap;
            });
            setSubagentRunsMap({});
            // 不区分当前/其他会话：全局同一时刻只有一个取消动作在飞行中，任一会话结束即复位
            setCancelling(false);
          } else if (event.status === 'running' && event.activeBotIds && event.activeBotIds.length > 1) {
            setStreamingStatesMap((prevMap) => {
              let updated = false;
              const nextMap = { ...prevMap };
              for (const botId of event.activeBotIds!) {
                if (!nextMap[botId]) {
                  nextMap[botId] = { botId, delta: '', tools: [] };
                  updated = true;
                }
              }
              return updated ? nextMap : prevMap;
            });
          }
          break;
        }

        case 'session_updated': {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === event.sessionId
                ? {
                    ...s,
                    blackboard: event.blackboard !== undefined ? event.blackboard : s.blackboard,
                    memberRoles: event.memberRoles !== undefined ? event.memberRoles : s.memberRoles,
                  }
                : s
            )
          );
          break;
        }

        case 'subagent_status': {
          setSubagentRunsMap((prev) => {
            const list = prev[event.botId] || [];
            const idx = list.findIndex((r) => r.id === event.run.id);
            let nextList: SubagentRunRecord[];
            if (idx >= 0) {
              nextList = [...list];
              nextList[idx] = event.run;
            } else {
              nextList = [...list, event.run];
            }
            return { ...prev, [event.botId]: nextList };
          });
          break;
        }
      }
    };

    const unsubscribe = subscribeGlobalEvents({
      onEvent: (event: GlobalSseEvent) => {
        if (!isMountedRef.current || !authenticatedRef.current) return;

        // 1. 每条事件先喂全局总线（供产物抽屉等组件消费）
        emitGlobalEvent(event);

        // 2. 节点上下线：patch 本地节点状态；未知节点触发一次节点列表刷新
        if (event.type === 'node_status') {
          const known = nodesRef.current.some((n) => n.id === event.nodeId);
          if (known) {
            const seenAt = new Date().toISOString();
            setNodes((prev) =>
              prev.map((n) =>
                n.id === event.nodeId ? { ...n, status: event.status, lastSeenAt: seenAt } : n
              )
            );
          } else {
            api
              .getNodes()
              .then((fetched) => {
                if (isMountedRef.current && authenticatedRef.current) setNodes(fetched);
              })
              .catch(() => {
                // 静默失败，交给 10s 轮询兑底
              });
          }
          return;
        }

        // 3. 会话事件按 sessionId 分流（message_created 的 sessionId 在 message 内）
        const eventSessionId =
          'sessionId' in event
            ? event.sessionId
            : event.type === 'message_created'
              ? event.message.sessionId
              : null;
        if (!eventSessionId) return;

        if (eventSessionId === activeSessionIdRef.current) {
          handleCurrentSessionEvent(event);
          return;
        }

        // 其他会话：仅 assistant/callback 新消息计未读+提醒；session_status 同步列表状态
        if (event.type === 'message_created') {
          const message = event.message;
          if (message.role !== 'assistant' && message.role !== 'callback') return;
          // 未读会话不在列表中（理论少见）直接忽略
          if (!sessionsRef.current.some((s) => s.id === eventSessionId)) return;

          setUnreadCounts((prev) => ({ ...prev, [eventSessionId]: (prev[eventSessionId] || 0) + 1 }));

          if (document.visibilityState === 'visible') {
            // 页面可见：按用户设置播提示音；不可见时交给 Notification，避免双重打扰
            if (localStorage.getItem('botd-sound') === '1') playNotificationBeep();
          } else {
            notifyBackgroundCompletion(message);
          }
          return;
        }

        if (event.type === 'session_status') {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === eventSessionId
                ? {
                    ...s,
                    status: event.status,
                    activeBotId: event.activeBotId,
                    activeBotIds: event.activeBotIds,
                    queuePlan:
                      event.status === 'idle' || event.status === 'failed'
                        ? []
                        : event.queuePlan ?? s.queuePlan ?? [],
                  }
                : s
            )
          );
          // 其他会话的 idle/failed 同样复位取消标志（取消请求跨会话唯一，切走后仍能解除卡死）
          if (event.status === 'idle' || event.status === 'failed') {
            setCancelling(false);
          }
          return;
        }

        if (event.type === 'session_updated') {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === eventSessionId
                ? {
                    ...s,
                    blackboard: event.blackboard !== undefined ? event.blackboard : s.blackboard,
                    memberRoles: event.memberRoles !== undefined ? event.memberRoles : s.memberRoles,
                  }
                : s
            )
          );
          return;
        }
      },
      onOpen: () => {
        // 重连建立后先清空流式状态：断线期间回合完成时 message_created/idle 已永久丢失，
        // 半截 streaming 气泡不清理会残留；若回合仍在进行，后续 text_delta 会自然重建
        setStreamingStatesMap(clearStreamingMap());
        setSubagentRunsMap({});
        // 连接（含断线重连）建立后重拉当前会话最新快照，补齐断线期间丢失的事件
        const sid = activeSessionIdRef.current;
        if (sid) loadMessagesForSession(sid, sessionEpochRef.current);
      },
      onError: (err) => {
        console.warn('[SSE] Global EventSource connection error:', err);
      },
    });

    return () => {
      unsubscribe();
    };
  }, [authenticated, loadMessagesForSession, handleHistoryInvalidation, navigate]);

  // Handlers
  const handleLoginSuccess = () => {
    // 登录成功后立即拉取当前用户信息供侧边栏展示
    api
      .me()
      .then((me) => {
        setCurrentUser(me.user || null);
      })
      .catch(() => {
        setCurrentUser(null);
      });
    setAuthenticated(true);
    authenticatedRef.current = true;
  };

  const handleLogout = async () => {
    sessionEpochRef.current++;
    snapshotSeqRef.current++;
    clientTruncatedAnchorRef.current = null;
    resolvedAskIdsRef.current.clear();
    authenticatedRef.current = false;
    activeSessionIdRef.current = null;

    try {
      await api.logout();
    } catch {
      // ignore
    }
    setAuthenticated(false);
    setCurrentUser(null);
    setSessions([]);
    setUnreadCounts({});
    navigate({ sessionId: null, modal: null, view: 'chat', messageId: null });
    setMessages([]);
    setNodes([]);
    setStreamingStatesMap(clearStreamingMap());
    setPendingAsks([]);
    // 登出同样复位取消状态，防止残留的 cancelling 卡住下一次会话的停止按钮
    setCancelling(false);
  };

  const handleSendMessage = async (content: string, attachments?: MessageAttachment[]) => {
    // /new 命令：一键开启新话题（归档当前会话并创建新会话）
    if (content.trim() === '/new') {
      const sid = activeSessionIdRef.current;
      if (sid) await handleNewTopic(sid);
      return;
    }

    const targetSessionId = activeSessionIdRef.current;
    if (!targetSessionId) return;

    const currentEpoch = sessionEpochRef.current;

    // 发送消息时顺手请求浏览器通知权限（仅在支持且未授权时静默询问，切后台接收完成提醒）
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        void Notification.requestPermission();
      } catch {
        // 忽略权限请求失败
      }
    }

    try {
      const userMsg = await api.sendMessage(targetSessionId, content, attachments);

      // Guard: only append if user is still on this same session & epoch
      if (!isMountedRef.current || activeSessionIdRef.current !== targetSessionId || sessionEpochRef.current !== currentEpoch) {
        return;
      }

      setMessages((prev) => {
        if (prev.some((m) => m.id === userMsg.id)) {
          return prev;
        }
        const next = [...prev, userMsg];
        messagesRef.current = next;
        return next;
      });

      // 用户主动发消息即脱离搜索高亮场景，清除陈旧高亮定位
      navigate((prev) => (prev.messageId ? { messageId: null } : {}));
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
      }
      addToast('error', err?.message || '发送消息失败');
      throw err;
    }
  };

  // 编辑已发送的用户消息：服务端更新该消息、截断其后回复并自动重新派发 bot 生成新回复
  const handleEditMessage = async (sessionId: string, messageId: string, content: string) => {
    const epoch = sessionEpochRef.current;
    const isCurrentSession = () => isMountedRef.current &&
      activeSessionIdRef.current === sessionId && sessionEpochRef.current === epoch;
    try {
      if (isCurrentSession()) handleHistoryInvalidation(messageId, content, true);
      await api.editUserMessage(sessionId, messageId, content);
      // 响应后只拉取服务端快照，不再切片；SSE 断开时也能取得最终历史。
      if (isCurrentSession()) await loadMessagesForSession(sessionId, epoch);
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      if (isCurrentSession()) {
        clientTruncatedAnchorRef.current = null;
        void loadMessagesForSession(sessionId, epoch);
      }
      if (err?.status === 409) {
        addToast('error', '会话运行中，请先停止再编辑');
      } else {
        addToast('error', err?.message || '编辑消息失败');
      }
      throw err;
    }
  };

  // 响应 BOT 的人机协同交互请求：成功后服务端广播 interaction_resolved，本地即时移除
  const handleRespondToAsk = async (sessionId: string, askId: string, answer: string) => {
    const epoch = sessionEpochRef.current;
    try {
      await api.respondToAsk(sessionId, askId, answer);
      if (activeSessionIdRef.current === sessionId && sessionEpochRef.current === epoch) {
        resolvedAskIdsRef.current.add(askId);
        setPendingAsks((prev) => prev.filter((a) => a.id !== askId));
      }
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || '响应交互请求失败');
      throw err;
    }
  };

  const handleCancelSession = async () => {
    if (!activeSessionId) return;
    setCancelling(true);
    try {
      await api.cancelSession(activeSessionId);
    } catch (err: any) {
      addToast('error', err?.message || '中止执行失败');
      setCancelling(false);
    }
  };

  // 点击通讯录中的智能体：进入其当前单聊，不存在则静默创建
  const handleOpenBotChat = async (bot: BotConfig) => {
    const existing = pickCurrentDirectSession(sessions, bot.id);
    if (existing) {
      navigate({ sessionId: existing.id, view: 'chat' });
      return;
    }

    if (creatingBotChatRef.current) return; // 创建进行中，忽略重复点击
    creatingBotChatRef.current = true;
    try {
      const created = await api.createSession({
        title: bot.name || bot.id,
        mode: 'direct',
        leadBotId: bot.id,
        memberBotIds: [bot.id],
      });
      setSessions((prev) => [created, ...prev]);
      navigate({ sessionId: created.id, view: 'chat' });
      // 静默创建：不弹成功 toast
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || '创建单聊会话失败');
    } finally {
      creatingBotChatRef.current = false;
    }
  };

  // 开启新话题：基于当前会话创建同成员新会话，并归档旧会话（running 中也允许）
  const handleNewTopic = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

    try {
      const input: CreateSessionInput =
        session.mode === 'direct'
          ? {
              title: botMap.get(session.leadBotId)?.name || session.title,
              mode: 'direct',
              leadBotId: session.leadBotId,
              memberBotIds: session.memberBotIds,
            }
          : {
              title: session.title,
              mode: session.mode,
              leadBotId: session.leadBotId,
              memberBotIds: session.memberBotIds,
            };

      const created = await api.createSession(input);
      setSessions((prev) => [created, ...prev]);
      navigate({ sessionId: created.id, view: 'chat', modal: null });

      // 归档旧会话：后端允许 running 中归档（纯 UI 分类标记），失败则如实提示
      try {
        const updated = await api.setSessionArchived(sessionId, true);
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
        );
      } catch (archiveErr: any) {
        addToast('error', archiveErr?.message || '旧话题归档失败，仍可在历史话题中查看');
      }
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || '开启新话题失败');
    }
  };

  // 从指定消息（含）分叉出新会话并自动切换：原会话不动，运行中也允许（只读源 + 新建）
  const handleForkMessage = async (sessionId: string, messageId: string) => {
    if (forkingRef.current) return; // 分叉进行中，忽略重复点击
    forkingRef.current = true;
    try {
      const forked = await api.forkSession(sessionId, messageId);
      setSessions((prev) => [forked, ...prev]);
      navigate({ sessionId: forked.id, view: 'chat' });
      addToast('success', '已分叉到新会话');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || '分叉会话失败');
    } finally {
      forkingRef.current = false;
    }
  };

  const handleCreateSession = async (input: CreateSessionInput) => {
    try {
      const newSession = await api.createSession(input);
      setSessions((prev) => [newSession, ...prev]);
      navigate({ sessionId: newSession.id, view: 'chat', modal: null });
      // 创建成功后直接导航进新会话，界面反馈已足够，不再弹 toast
    } catch (err: any) {
      addToast('error', err?.message || '创建会话失败');
      throw err;
    }
  };

  const handleUpdateSession = async (
    sessionId: string,
    input: Partial<CreateSessionInput> & { memberRoles?: Record<string, string>; blackboard?: string }
  ) => {
    try {
      const updated = await api.updateSession(sessionId, input);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
      );
    } catch (err: any) {
      addToast('error', err?.message || '更新群配置失败');
      throw err;
    }
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const updated = await api.updateSession(sessionId, { title: trimmed });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
      );
    } catch (err: any) {
      addToast('error', err?.message || '重命名会话失败');
      throw err;
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await api.deleteSession(sessionId);
      const idx = sessions.findIndex((s) => s.id === sessionId);
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      // 同步移除被删会话的未读计数，避免 document.title 角标永久虚高
      setUnreadCounts((prev) => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      if (sessionId === activeSessionIdRef.current) {
        // 删除的是当前会话：优先选同位置的后一个，删的是末尾则选前一个，无则 null
        const fallback = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
        navigate({ sessionId: fallback?.id ?? null });
      }
      addToast('success', '会话已删除');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      if (err?.status === 409) {
        addToast('error', '会话正在运行，请先停止后再删除');
      } else {
        addToast('error', err?.message || '删除会话失败');
      }
    }
  };

  const handleClearMessages = async (sessionId: string) => {
    try {
      await api.clearSessionMessages(sessionId);
      if (sessionId === activeSessionIdRef.current) {
        snapshotSeqRef.current++;
        setMessages([]);
        // 消息已清空，不再有更早历史
        setHasEarlierMessages(false);
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, messageCount: 0, lastMessagePreview: undefined, lastMessageAt: undefined }
            : s
        )
      );
      addToast('success', '会话消息已清空');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      if (err?.status === 409) {
        addToast('error', '会话正在运行，请先停止后再清空消息');
      } else {
        addToast('error', err?.message || '清空消息失败');
      }
    }
  };

  // 置顶/取消置顶：服务端更新后 patch 本地列表，失败如实提示
  const handleTogglePinned = async (sessionId: string, pinned: boolean) => {
    try {
      const updated = await api.updateSessionPinned(sessionId, pinned);
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s)));
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || '更新置顶状态失败');
    }
  };

  // 归档/恢复：归档当前会话时不跳转（保留查看），仅切换列表分类
  const handleSetArchived = async (sessionId: string, archived: boolean) => {
    try {
      const updated = await api.setSessionArchived(sessionId, archived);
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s)));
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || (archived ? '归档会话失败' : '恢复会话失败'));
    }
  };

  const handleRefreshNodes = async () => {
    try {
      setLoadingNodes(true);
      const fetchedNodes = await api.getNodes();
      if (isMountedRef.current) {
        setNodes(fetchedNodes);
      }
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
      } else {
        addToast('error', err?.message || '刷新节点列表失败');
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingNodes(false);
      }
    }
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-900 flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400 gap-3">
        <Loader2 className="w-6 h-6 animate-spin-fast text-zinc-900 dark:text-zinc-100" />
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">正在连接服务并校验登录状态...</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <>
        <LoginView onLoginSuccess={handleLoginSuccess} />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      {/* Responsive Sidebar */}
      <Sidebar
        sessions={sessions}
        bots={allBots}
        nodeMap={nodeMap}
        activeSessionId={activeSessionId}
        onSelectSession={(id, messageId) => {
          // 进入会话即清零未读并清除陈旧高亮（搜索跳转可携带 messageId）
          navigate({ sessionId: id, view: 'chat', messageId: messageId ?? null });
        }}
        onOpenBotChat={handleOpenBotChat}
        unreadCounts={unreadCounts}
        onTogglePinned={handleTogglePinned}
        onSetArchived={handleSetArchived}
        onCreateGroup={() => navigate({ modal: 'create' })}
        onOpenNodesView={() => navigate({ view: 'nodes' })}
        onOpenSettings={() => navigate({ modal: 'settings' })}
        onLogout={handleLogout}
        onDeleteSession={handleDeleteSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        currentUser={currentUser || undefined}
        onOpenUsers={() => navigate({ modal: 'users' })}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative bg-white dark:bg-zinc-950">
        {currentView === 'nodes' ? (
          <NodesBotsView
            nodes={nodes}
            loading={loadingNodes}
            onRefresh={handleRefreshNodes}
            onBackToChat={() => navigate({ view: 'chat' })}
            onToggleSidebar={() => setSidebarOpen(true)}
            onAddToast={addToast}
          />
        ) : activeSession ? (
          <ChatView
            session={activeSession}
            messages={messages}
            loadingMessages={loadingMessages}
            loadError={loadError}
            onRetryLoad={() => activeSessionId && loadMessagesForSession(activeSessionId, sessionEpochRef.current)}
            botMap={botMap}
            nodeMap={nodeMap}
            nodes={nodes}
            onRefreshNodes={handleRefreshNodes}
            onSelectSession={(id) => navigate({ sessionId: id, view: 'chat' })}
            streamingStates={Object.values(streamingStatesMap)}
            activeSubagentRuns={subagentRunsMap}
            onSendMessage={handleSendMessage}
            onEditMessage={handleEditMessage}
            onCancelSession={handleCancelSession}
            onOpenGroupSettings={() => navigate({ modal: 'group' })}
            onToggleSidebar={() => setSidebarOpen(true)}
            onRenameSession={handleRenameSession}
            onClearMessages={handleClearMessages}
            onDeleteSession={handleDeleteSession}
            onNewTopic={handleNewTopic}
            onForkMessage={handleForkMessage}
            cancelling={cancelling}
            pendingAsks={pendingAsks}
            hasEarlierMessages={hasEarlierMessages}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={handleLoadEarlier}
            highlightMessageId={route.messageId}
            onRespondToAsk={handleRespondToAsk}
            onAddToast={addToast}
            onUpdateSession={handleUpdateSession}
            onOpenBotChat={handleOpenBotChat}
          />
        ) : (
          /* Mobile startup header with accessible menu when no active session */
          <div className="flex-1 flex flex-col h-full bg-white dark:bg-zinc-950 overflow-hidden">
            <header className="h-14 px-4 bg-white/90 dark:bg-zinc-950/90 backdrop-blur-md border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between lg:hidden shrink-0">
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-2 -ml-2 text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl flex items-center gap-2"
                aria-label="打开侧边会话导航"
              >
                <Menu className="w-5 h-5 text-zinc-700 dark:text-zinc-300" />
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">会话列表</span>
              </button>
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">botd</span>
              </div>
            </header>

            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-14 h-14 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-center text-zinc-800 dark:text-zinc-200 mb-4 shadow-xs">
                <Bot className="w-7 h-7" />
              </div>
              <h2 className="text-sm sm:text-base font-bold text-zinc-900 dark:text-zinc-100 mb-1.5">欢迎使用 botd</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-6 max-w-sm leading-relaxed">
                从左侧智能体列表选择一个智能体即可开始单聊，或点击下方按钮发起多智能体协同群聊。
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => navigate({ modal: 'create' })}
                  className="px-4 py-2 bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200/90 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs font-medium shadow-xs transition-colors cursor-pointer"
                >
                  新建群聊
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      <CreateSessionModal
        isOpen={openModal === 'create'}
        bots={allBots}
        nodeMap={nodeMap}
        onClose={() => navigate({ modal: null })}
        onCreateSession={handleCreateSession}
      />

      {activeSession && (
        <GroupSettingsModal
          isOpen={openModal === 'group'}
          session={activeSession}
          bots={allBots}
          nodeMap={nodeMap}
          onClose={() => navigate({ modal: null })}
          onUpdateSession={handleUpdateSession}
        />
      )}

      <SettingsModal
        isOpen={openModal === 'settings'}
        nodes={nodes}
        onClose={() => navigate({ modal: null })}
      />

      {currentUser?.role === 'admin' && (
        <UsersModal
          isOpen={openModal === 'users'}
          currentUser={currentUser}
          onClose={() => navigate({ modal: null })}
        />
      )}

      {/* Global Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
