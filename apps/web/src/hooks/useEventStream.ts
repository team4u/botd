import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { SessionRecord, MessageRecord, NodeWithBots, GlobalSseEvent, SessionSseEvent } from '@botd/protocol';
import { api, subscribeGlobalEvents } from '../api';
import { emitGlobalEvent } from '../events';
import { patchSessionStatus } from './useSessionMessages';

export interface EventStreamParams {
  authenticated: boolean;
  authenticatedRef: MutableRefObject<boolean>;
  sessionsRef: MutableRefObject<SessionRecord[]>;
  nodesRef: MutableRefObject<NodeWithBots[]>;
  setSessions: Dispatch<SetStateAction<SessionRecord[]>>;
  setNodes: Dispatch<SetStateAction<NodeWithBots[]>>;
  activeSessionIdRef: React.MutableRefObject<string | null>;
  /** 当前会话事件全量处理（流式/消息/截断/人机协同/会话状态） */
  applyLiveSessionEvent: (event: SessionSseEvent) => void;
  /** 其他会话 assistant/callback 新消息：未读+提醒（含会话列表存在性检查） */
  onForeignSessionMessage: (sessionId: string, message: MessageRecord) => void;
  /** 其他会话 idle/failed：复位取消标志 */
  onForeignSessionIdle: () => void;
  /** SSE 重连建立后的恢复：清空流式残影并重拉当前会话快照 */
  recoverAfterReconnect: () => void;
}

/**
 * 全局 SSE 订阅：登录后建立一条连接（不随会话切换重建），登出时关闭。
 * 事件先 emitGlobalEvent 喂给全局总线（供产物抽屉等组件消费），再分流：
 * - node_status：patch 本地节点状态，未知节点触发一次节点列表刷新；
 * - 当前会话事件：走完整处理（applyLiveSessionEvent）；
 * - 其他会话事件：仅处理 assistant/callback 消息（未读+提醒）与 session_status。
 * 可变回调通过 ref 显式传递，订阅 effect 只依赖 authenticated，避免闭包拿到陈旧数据。
 */
export const useEventStream = (params: EventStreamParams) => {
  const {
    authenticated,
    authenticatedRef,
    sessionsRef,
    nodesRef,
    setSessions,
    setNodes,
    activeSessionIdRef,
  } = params;

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 订阅不随会话/列表重建；把每次渲染的最新回调装进 ref，事件到达时取最新
  const handlersRef = useRef(params);
  handlersRef.current = params;

  useEffect(() => {
    if (!authenticated) return;

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
          handlersRef.current.applyLiveSessionEvent(event);
          return;
        }

        // 其他会话：仅 assistant/callback 新消息计未读+提醒；session_status 同步列表状态
        if (event.type === 'message_created') {
          const message = event.message;
          if (message.role !== 'assistant' && message.role !== 'callback') return;
          // 未读会话不在列表中（理论少见）直接忽略
          if (!sessionsRef.current.some((s) => s.id === eventSessionId)) return;
          handlersRef.current.onForeignSessionMessage(eventSessionId, message);
          return;
        }

        if (event.type === 'session_status') {
          setSessions((prev) => patchSessionStatus(prev, event));
          // 其他会话的 idle/failed 同样复位取消标志（取消请求跨会话唯一，切走后仍能解除卡死）
          if (event.status === 'idle' || event.status === 'failed') {
            handlersRef.current.onForeignSessionIdle();
          }
          return;
        }

        if (event.type === 'session_updated') {
          return;
        }
      },
      onOpen: () => {
        // 重连建立后恢复：清空断线期间残留的半截流式状态，并重拉当前会话最新快照
        handlersRef.current.recoverAfterReconnect();
      },
      onError: (err) => {
        console.warn('[SSE] Global EventSource connection error:', err);
      },
    });

    return () => {
      unsubscribe();
    };
  }, [authenticated]);
};
