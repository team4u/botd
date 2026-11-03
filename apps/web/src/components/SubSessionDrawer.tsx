import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, Send, CircleStop } from 'lucide-react';
import type {
  BotConfig,
  MessageRecord,
  NodeRecord,
  SessionRecord,
  SessionStatus,
  TurnBlock,
} from '@botd/protocol';
import { api } from '../api';
import { onGlobalEvent } from '../events';
import { updateStreamingMap, clearStreamingMap } from '../utils/message-state';
import { BotAvatarBadge } from './MessageItem';
import { MessageTimeline } from './MessageTimeline';
import type { StreamingAssistantState, ToolExecutionState, ToastItem } from '../types';

export interface SubSessionDrawerProps {
  isOpen: boolean;
  subSession: SessionRecord | null;
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  onClose: () => void;
  /** 切换到该子会话的完整视图（退出内联检视） */
  onOpenFullSession?: (sessionId: string) => void;
  onToast: (type: ToastItem['type'], message: string) => void;
}

/** 会话状态 → 徽章文案 */
export const subSessionStatusLabel = (status: SessionStatus): string => {
  switch (status) {
    case 'running':
      return '运行中';
    case 'queued':
      return '排队中';
    case 'failed':
      return '失败';
    default:
      return '已完成';
  }
};

/** 会话状态 → 徽章配色 */
export const subSessionStatusBadgeClass = (status: SessionStatus): string => {
  switch (status) {
    case 'running':
      return 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200/60 dark:border-blue-800/60';
    case 'queued':
      return 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200/60 dark:border-amber-800/60';
    case 'failed':
      return 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-800/60';
    default:
      return 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-800/60';
  }
};

/**
 * 跨 BOT 子会话内联检视抽屉：在父会话内就地查看委派子任务的完整对话，
 * UX 与 SubagentRunDrawer（本地子代理检视）对齐——上部为与主对话完全同源的
 * MessageTimeline（实时流式：思考/工具/文本），底部为插话输入框与停止控制。
 */
export const SubSessionDrawer: React.FC<SubSessionDrawerProps> = ({
  isOpen,
  subSession,
  botMap,
  nodeMap,
  onClose,
  // onOpenFullSession 保留在 Props 签名中以兼容外部调用方；UI 已移除冗余跳转按钮，不再解构使用
  onToast,
}) => {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // 向上分页：是否还有更早消息 / 加载中
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // 实时会话状态（SSE session_status 驱动；null 时回退 subSession.status 轮询快照）
  const [liveStatus, setLiveStatus] = useState<SessionStatus | null>(null);
  const [streamingMap, setStreamingMap] = useState<Record<string, StreamingAssistantState>>({});
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // idle/failed 后延迟清理流式状态（等待取消场景下晚到的部分输出消息落位，与 App 同策略）
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionId = subSession?.id ?? null;
  const leadBot = subSession ? botMap.get(subSession.leadBotId) : undefined;
  const leadNode = leadBot?.nodeId ? nodeMap.get(leadBot.nodeId) : undefined;

  const effectiveStatus = liveStatus ?? subSession?.status ?? 'idle';
  const isActive = effectiveStatus === 'running' || effectiveStatus === 'queued';
  const isRunning = effectiveStatus === 'running';

  const streamingStates = useMemo(
    () => Object.values(streamingMap),
    [streamingMap]
  );

  // 打开/切换子会话：复位本地状态并拉取最新一页消息
  useEffect(() => {
    if (!isOpen || !sessionId) {
      setMessages([]);
      setStreamingMap(clearStreamingMap());
      setLiveStatus(null);
      setLoadError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setMessages([]);
    setStreamingMap(clearStreamingMap());
    setLiveStatus(null);
    setLoading(true);
    setLoadError(null);
    setHasEarlier(false);

    api
      .getSessionMessagesPage(sessionId, { limit: 60 })
      .then((result) => {
        if (cancelled) return;
        setMessages(result.messages);
        setHasEarlier(result.hasMore);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setLoadError(err?.message || '读取子会话消息失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId, reloadToken]);

  // 实时流：订阅全局事件总线，仅处理目标子会话的事件（message_created 的 sessionId 在 message 内）
  useEffect(() => {
    if (!isOpen || !sessionId) return;

    const clearCleanupTimer = () => {
      if (cleanupTimerRef.current) {
        clearTimeout(cleanupTimerRef.current);
        cleanupTimerRef.current = null;
      }
    };

    const updateStreaming = (
      botId: string,
      updater: (prev: StreamingAssistantState | undefined) => StreamingAssistantState | null
    ) => {
      // 新流式活动到达：取消 idle 后的延迟清理，避免误删正在进行的状态
      clearCleanupTimer();
      setStreamingMap((prevMap) => updateStreamingMap(prevMap, botId, updater));
    };

    const unsubscribe = onGlobalEvent((event) => {
      if (event.type === 'message_created') {
        if (event.message.sessionId !== sessionId) return;
      } else if (!('sessionId' in event) || event.sessionId !== sessionId) {
        return;
      }

      switch (event.type) {
        case 'thinking_stream': {
          updateStreaming(event.botId, (prev) => {
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
          updateStreaming(event.botId, (prev) => {
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
          updateStreaming(event.botId, (prev) => {
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
          const message = event.message;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === message.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = message;
              return next;
            }
            return [...prev, message];
          });

          // 消息已落位：清除对应 BOT 的流式状态，由完整消息接管渲染
          if (message.role === 'assistant' && message.senderBotId) {
            updateStreaming(message.senderBotId, () => null);
          }
          break;
        }

        case 'session_status': {
          setLiveStatus(event.status);
          if (event.status === 'idle' || event.status === 'failed') {
            // 取消场景：cancelSession 立即广播 idle，但部分输出消息可能稍后到达。
            // 延迟一拍清理，若期间部分输出/新流式事件到达则自然接管（与 App 同策略）。
            setStreamingMap((prevMap) => {
              if (Object.keys(prevMap).length === 0) return prevMap;
              clearCleanupTimer();
              cleanupTimerRef.current = setTimeout(() => {
                cleanupTimerRef.current = null;
                setStreamingMap(clearStreamingMap());
              }, 600);
              return prevMap;
            });
          }
          break;
        }

        default:
          break;
      }
    });

    return () => {
      clearCleanupTimer();
      unsubscribe();
    };
  }, [isOpen, sessionId]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // 向上加载更早消息：以当前最早一条为游标向前取一页并 prepend（按 id 去重兼容实时 SSE 到达）
  const handleLoadEarlier = useCallback(async () => {
    if (!sessionId || loadingEarlier) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const result = await api.getSessionMessagesPage(sessionId, {
        before: oldest.id,
        limit: 60,
      });
      setHasEarlier(result.hasMore);
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const older = result.messages.filter((m) => !existingIds.has(m.id));
        return older.length > 0 ? [...older, ...prev] : prev;
      });
    } catch (err: any) {
      onToast('error', err?.message || '加载更早消息失败');
    } finally {
      setLoadingEarlier(false);
    }
  }, [sessionId, loadingEarlier, messages, onToast]);

  const handleStop = async () => {
    if (!subSession || stopping) return;
    setStopping(true);
    try {
      await api.cancelSession(subSession.id);
      onToast('success', `已请求停止子会话 @${subSession.leadBotId}`);
    } catch (err: any) {
      onToast('error', err?.message || '停止子会话失败');
    } finally {
      setStopping(false);
    }
  };

  const handleSend = async () => {
    const message = inputValue.trim();
    if (!subSession || !message || sending) return;
    setSending(true);
    try {
      const userMsg = await api.sendMessage(subSession.id, message);
      setMessages((prev) =>
        prev.some((m) => m.id === userMsg.id) ? prev : [...prev, userMsg]
      );
      setInputValue('');
      onToast('success', isRunning ? '插话已发送到子会话' : '已在该子会话继续追问');
    } catch (err: any) {
      onToast('error', err?.message || '发送失败');
    } finally {
      setSending(false);
    }
  };

  if (!isOpen || !subSession) return null;

  return (
    <>
      {/* 遮罩：点击关闭 */}
      <div
        className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 右侧滑入面板 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`跨 BOT 子会话详情 ${subSession.id}`}
        className="fixed inset-y-0 right-0 z-40 w-[min(38rem,96vw)] bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        {/* 顶部栏：子会话身份 + 状态徽章 + 停止 / 完整会话 / 关闭 */}
        <div className="flex items-center justify-between gap-2 px-4 h-13 sm:h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <BotAvatarBadge
              botId={subSession.leadBotId}
              name={leadBot?.name}
              color={leadBot?.color}
              className="!w-7 !h-7 !text-[11px]"
            />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                {subSession.title.replace(/^\[子任务\]\s*/, '')}
              </h2>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">
                  @{subSession.leadBotId}
                </span>
                {leadNode && (
                  <span
                    className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-md border border-zinc-200/70 dark:border-zinc-700/70 bg-zinc-50 dark:bg-zinc-800 text-[11px] text-zinc-500 dark:text-zinc-400"
                    title={`计算节点 ${leadNode.id}`}
                  >
                    {leadNode.name}
                  </span>
                )}
                <span
                  className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate"
                  title={subSession.id}
                >
                  {subSession.id}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium ${subSessionStatusBadgeClass(effectiveStatus)}`}
            >
              {effectiveStatus === 'running' && <Loader2 className="w-3 h-3 animate-spin-fast" />}
              {subSessionStatusLabel(effectiveStatus)}
            </span>
            {isActive && (
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={stopping}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-medium transition-colors cursor-pointer shrink-0"
                title="仅停止该子会话，不中断父会话与其他子任务"
              >
                {stopping ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                ) : (
                  <CircleStop className="w-3.5 h-3.5" />
                )}
                <span>停止</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              aria-label="关闭抽屉"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 内容区：与主对话完全同源的时间线（同一组件，自动获得全部视觉与交互） */}
        <MessageTimeline
          messages={messages}
          streamingStates={streamingStates}
          botMap={botMap}
          nodeMap={nodeMap}
          session={subSession}
          loadingMessages={loading}
          loadError={loadError}
          onRetryLoad={() => setReloadToken((t) => t + 1)}
          hasEarlierMessages={hasEarlier}
          loadingEarlier={loadingEarlier}
          onLoadEarlier={handleLoadEarlier}
          className="max-w-none px-4"
        />

        {/* 底部输入框：运行中发送即插话，结束后发送即继续追问（语义由当前状态自动决定） */}
        <div className="px-4 py-3 border-t border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              disabled={sending}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={
                isRunning
                  ? '向正在运行的跨 BOT 子会话插话...'
                  : `在该子会话继续追问 @${subSession.leadBotId}...`
              }
              aria-label={isRunning ? '向跨 BOT 子会话插话' : '向跨 BOT 子会话追问'}
              className="flex-1 min-w-0 h-8 px-2.5 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 transition-colors"
            />
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!inputValue.trim() || sending}
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer shrink-0"
              title={isRunning ? '发送插话' : '发送追问'}
            >
              {sending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
