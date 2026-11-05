import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  SessionRecord,
  MessageRecord,
  PendingAskRecord,
  SessionSseEvent,
  MessageAttachment,
  TurnBlock,
} from '@botd/protocol';
import { api, AuthRequiredError } from '../api';
import {
  EMPTY_EXTENSION_UI_STATE,
  type ExtensionWidgetState,
  type SessionExtensionUiState,
  type StreamingAssistantState,
} from '../types';
import {
  mergeMessagesPage,
  isSnapshotCurrent,
  truncateMessagesAtAnchor,
  updateStreamingMap,
  clearStreamingMap,
  mergePendingAsks,
} from '../utils/message-state';
import type { AddToastFn } from './useToasts';
import type { NavigateFn } from './useHashRoute';

/** session_status 事件 → 会话列表项 patch（当前/其他会话共用） */
export const patchSessionStatus = (
  sessions: SessionRecord[],
  event: Extract<SessionSseEvent, { type: 'session_status' }>
): SessionRecord[] =>
  sessions.map((s) =>
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
  );

export interface SessionMessagesParams {
  authenticated: boolean;
  activeSessionId: string | null;
  /** 当前活跃会话 ref（App 装配层持有，与 SSE 分流/会话动作共享同步读取） */
  activeSessionIdRef: MutableRefObject<string | null>;
  /** 统一的登录失效处理 ref（setAuthenticated(false) + ref 同步） */
  onAuthLostRef: MutableRefObject<() => void>;
  addToast: AddToastFn;
  navigate: NavigateFn;
  setSessions: Dispatch<SetStateAction<SessionRecord[]>>;
  /** 进入会话回调：清零未读计数 */
  onSessionActivated: (sessionId: string) => void;
  /** 当前会话页面不可见时到达的完成消息：发浏览器通知 */
  notifyHiddenCompletion: (message: MessageRecord) => void;
  /** /new 命令：归档当前会话并开新话题 */
  onNewTopic: (sessionId: string) => Promise<void>;
}

/**
 * 当前会话消息状态机：历史加载/分页、SSE 实时流式状态（thinking/text/tool）、
 * 人机协同 asks、取消与截断失效，epoch/seq 双计数器防护会话切换与乱序快照竞态。
 * SSE 事件应用入口为 applyLiveSessionEvent（由 useEventStream 按会话分流后调用）。
 */
export const useSessionMessages = (params: SessionMessagesParams) => {
  const {
    authenticated,
    activeSessionId,
    activeSessionIdRef,
    onAuthLostRef,
    addToast,
    navigate,
    setSessions,
    onSessionActivated,
    notifyHiddenCompletion,
    onNewTopic,
  } = params;

  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const messagesRef = useRef<MessageRecord[]>([]);
  messagesRef.current = messages;

  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 多 BOT 并发流式状态（按 botId 隔离索引，互不覆盖）
  const [streamingStatesMap, setStreamingStatesMap] = useState<Record<string, StreamingAssistantState>>({});
  const [cancelling, setCancelling] = useState(false);

  // 当前会话待处理的人机协同交互请求（botd ask）
  const [pendingAsks, setPendingAsks] = useState<PendingAskRecord[]>([]);

  // 当前会话扩展 UI 状态（ctx.ui 桥接：statuses / workingMessages / widgets）；切会话时重置
  const [extensionUiState, setExtensionUiState] = useState<SessionExtensionUiState>(EMPTY_EXTENSION_UI_STATE);

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

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
        onAuthLostRef.current();
      } else {
        setLoadError(err?.message || '读取历史消息记录失败');
      }
    } finally {
      if (isCurrentSnapshot()) setLoadingMessages(false);
    }
  }, [onAuthLostRef]);

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
        onAuthLostRef.current();
      } else {
        addToast('error', err?.message || '加载更早消息失败');
      }
    } finally {
      loadingEarlierRef.current = false;
      if (isMountedRef.current) {
        setLoadingEarlier(false);
      }
    }
  }, [addToast, onAuthLostRef]);

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
  const applyLiveSessionEvent = (event: SessionSseEvent) => {
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
            tools: [],
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
            tools: [],
            blocks: currentBlocks,
          };
        });
        break;
      }

      case 'tool_status': {
        updateStreamingStates(event.botId, (prev) => {
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
            ...(event.uiSpec ? { uiSpec: event.uiSpec } : {}),
          };

          if (existingBlockIdx >= 0) {
            const existing = currentBlocks[existingBlockIdx] as Extract<TurnBlock, { type: 'tool' }>;
            currentBlocks[existingBlockIdx] = {
              ...existing,
              ...toolBlock,
              args: event.args ?? existing.args,
              summary: event.summary ?? existing.summary,
              ...(event.uiSpec || existing.uiSpec ? { uiSpec: event.uiSpec ?? existing.uiSpec } : {}),
            };
          } else {
            currentBlocks.push(toolBlock);
          }

          return {
            botId: event.botId,
            delta: prev?.delta || '',
            tools: [],
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
          notifyHiddenCompletion(event.message);
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
        setSessions((prev) => patchSessionStatus(prev, event));

        if (event.status === 'running' && event.activeBotId) {
          // 占位流式状态：提交即亮起「正在思考」，不必等首条 thinking/text 事件
          updateStreamingStates(event.activeBotId, (prev) =>
            prev ?? { botId: event.activeBotId!, delta: '', tools: [], blocks: [] },
          );
        }

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
          // 回合结束：清理 workingMessages（statuses/widgets 保留，由扩展显式清除或用户手动收起）
          setExtensionUiState((prev) =>
            Object.keys(prev.workingMessages).length > 0
              ? { ...prev, workingMessages: {} }
              : prev,
          );
          // 不区分当前/其他会话：全局同一时刻只有一个取消动作在飞行中，任一会话结束即复位
          setCancelling(false);
        }
        break;
      }

      case 'extension_ui': {
        // ctx.ui 桥接事件：notify 弹 Toast，status/working_message/widget 更新会话级扩展 UI 状态
        const ui = event.event;
        if (ui.kind === 'notify') {
          addToast(ui.notifyType === 'error' ? 'error' : 'info', ui.message);
          break;
        }
        setExtensionUiState((prev) => {
          if (ui.kind === 'status') {
            const next = { ...prev, statuses: { ...prev.statuses } };
            if (ui.statusText === undefined || ui.statusText === '') {
              delete next.statuses[ui.statusKey];
            } else {
              next.statuses[ui.statusKey] = { botId: event.botId, text: ui.statusText };
            }
            return next;
          }
          if (ui.kind === 'working_message') {
            const next = { ...prev, workingMessages: { ...prev.workingMessages } };
            if (ui.message === undefined || ui.message === '') {
              delete next.workingMessages[event.botId];
            } else {
              next.workingMessages[event.botId] = ui.message;
            }
            return next;
          }
          // widget：undefined 内容或既无 lines 也无 uiSpec 表示清除
          if (ui.kind !== 'widget') return prev;
          const widgets = { ...prev.widgets };
          if (ui.lines === undefined && ui.uiSpec === undefined) {
            delete widgets[ui.widgetKey];
          } else {
            const widget: ExtensionWidgetState = {
              key: ui.widgetKey,
              botId: event.botId,
              ...(ui.lines !== undefined ? { lines: ui.lines } : {}),
              ...(ui.uiSpec ? { uiSpec: ui.uiSpec } : {}),
              placement: ui.placement ?? 'aboveEditor',
              updatedAt: Date.now(),
            };
            widgets[ui.widgetKey] = widget;
          }
          return { ...prev, widgets };
        });
        break;
      }
    }
  };

  // 会话切换：立即清空消息/流式/待响应状态防鬼影，bump epoch 使旧快照失效，并加载新会话首屏。
  // 注意：全局 SSE 订阅不随会话切换重建（见 useEventStream），切换本身只做状态清理与历史加载。
  useEffect(() => {
    // 切换会话即复位取消状态：取消动作只针对原会话，切走后停止按钮不得永久卡在「正在停止...」
    setCancelling(false);
    setExtensionUiState(EMPTY_EXTENSION_UI_STATE);
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
    onSessionActivated(activeSessionId);

    // Load initial message history
    loadMessagesForSession(activeSessionId, currentEpoch);
  }, [authenticated, activeSessionId, loadMessagesForSession, onSessionActivated]);

  const handleSendMessage = async (content: string, attachments?: MessageAttachment[]) => {
    // /new 命令：一键开启新话题（归档当前会话并创建新会话）
    if (content.trim() === '/new') {
      const sid = activeSessionIdRef.current;
      if (sid) await onNewTopic(sid);
      return;
    }

    // /clear 命令：原地清空当前会话消息与上下文（不归档、不换会话，保留后台运行中的 Worker）
    if (content.trim() === '/clear') {
      const sid = activeSessionIdRef.current;
      if (sid) await handleClearMessages(sid, { keepWorkers: true });
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
        onAuthLostRef.current();
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
        onAuthLostRef.current();
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
        onAuthLostRef.current();
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

  const handleClearMessages = async (sessionId: string, options?: { keepWorkers?: boolean }) => {
    try {
      await api.clearSessionMessages(sessionId, options);
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
        onAuthLostRef.current();
        return;
      }
      if (err?.status === 409) {
        addToast('error', '会话正在运行，请先停止后再清空消息');
      } else {
        addToast('error', err?.message || '清空消息失败');
      }
    }
  };

  /** 登出前置：使在飞快照/截断标记/ask 记录全部失效（在 logout 请求发出前调用） */
  const invalidateForLogout = () => {
    sessionEpochRef.current++;
    snapshotSeqRef.current++;
    clientTruncatedAnchorRef.current = null;
    resolvedAskIdsRef.current.clear();
    activeSessionIdRef.current = null;
  };

  /** 登出复位：清空全部会话内状态（在 logout 请求完成后调用） */
  const resetForLogout = () => {
    setMessages([]);
    setStreamingStatesMap(clearStreamingMap());
    setPendingAsks([]);
    setExtensionUiState(EMPTY_EXTENSION_UI_STATE);
    // 登出同样复位取消状态，防止残留的 cancelling 卡住下一次会话的停止按钮
    setCancelling(false);
  };

  /** 其他会话 idle/failed：复位取消标志（取消请求跨会话唯一，切走后仍能解除卡死） */
  const resetCancelling = () => setCancelling(false);

  /** SSE 重连建立后的恢复：清空半截流式状态并重拉当前会话快照补齐丢失事件 */
  const recoverAfterReconnect = () => {
    // 断线期间回合完成时 message_created/idle 已永久丢失，
    // 半截 streaming 气泡不清理会残留；若回合仍在进行，后续 text_delta 会自然重建
    setStreamingStatesMap(clearStreamingMap());
    const sid = activeSessionIdRef.current;
    if (sid) loadMessagesForSession(sid, sessionEpochRef.current);
  };

  return {
    // state
    messages,
    loadingMessages,
    loadError,
    streamingStatesMap,
    cancelling,
    pendingAsks,
    extensionUiState,
    hasEarlierMessages,
    loadingEarlier,
    // refs（供 SSE 分流层与装配层同步读取）
    sessionEpochRef,
    // actions
    loadMessagesForSession,
    handleLoadEarlier,
    handleSendMessage,
    handleEditMessage,
    handleRespondToAsk,
    handleCancelSession,
    handleClearMessages,
    applyLiveSessionEvent,
    invalidateForLogout,
    resetForLogout,
    resetCancelling,
    recoverAfterReconnect,
  };
};

export type SessionMessagesApi = ReturnType<typeof useSessionMessages>;
