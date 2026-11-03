import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  ChevronUp,
  ArrowDown,
  Bot,
  Users,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { BotConfig, MessageRecord, NodeRecord, SessionRecord } from '@botd/protocol';
import {
  BotAvatarBadge,
  MemoizedMessageItem,
  formatChatDayLabel,
  formatShortModel,
  isSameCalendarDay,
  SubagentRunsPanel,
  TypingDots,
} from './MessageItem';
import { AssistantTurnContent } from './MessageItem';
import type { StreamingAssistantState } from '../types';

/**
 * 会话消息时间线（ChatView 主对话与 SubagentRunDrawer 子代理检视共用的唯一渲染器）。
 *
 * 承载：消息列表（日期分隔线 + MemoizedMessageItem + 定位高亮）、多 BOT 并发流式网格、
 * 自动贴底与「回到底部」悬浮按钮、向上分页（prepend 锚定 + IntersectionObserver 哨兵）、
 * 加载/错误/空态。两处使用方的差异只体现在数据源与外围（顶栏/输入框），渲染路径完全同源。
 */
export interface MessageTimelineProps {
  /** 时间线消息（按时间升序） */
  messages: MessageRecord[];
  /** 运行中的流式状态（渲染为时间线尾部的并发网格） */
  streamingStates: StreamingAssistantState[];
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  /** 当前会话（用于空态文案与成员展示；抽屉等检视场景可不传，此时不渲染空态引导） */
  session?: SessionRecord;
  /** 正在加载历史消息且列表为空时显示全屏 loading */
  loadingMessages?: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
  /** 搜索跳转定位：滚动到该消息并短暂高亮 */
  highlightMessageId?: string | null;
  /** 消息操作回调（不传则隐藏对应按钮） */
  onStartEdit?: (message: MessageRecord) => void;
  onForkMessage?: (messageId: string) => void | Promise<void>;
  onInspectSubagentRun?: (run: import('@botd/protocol').SubagentRunRecord) => void;
  /** 编辑态目标消息（Slack 式编辑由使用方的输入框承载，此处只做标记与失效防御） */
  editingMessage?: MessageRecord | null;
  /** 运行中的会话禁止编辑（与后端 409 拦截对齐）；抽屉检视场景不传（合成消息不可编辑） */
  canEdit?: boolean;
  /** 向上分页：还有更早消息可加载 */
  hasEarlierMessages?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  /** 移动端软键盘垫片高度变化时保持贴底 */
  keyboardInset?: number;
  /** 流式块上方叠加的子代理协同面板数据（主对话传入；抽屉场景不传） */
  activeSubagentRunsFor?: Record<string, import('@botd/protocol').SubagentRunRecord[]>;
  /** 时间线容器自定义类（抽屉内收敛最大宽度） */
  className?: string;
}

export const MessageTimeline: React.FC<MessageTimelineProps> = ({
  messages,
  streamingStates,
  botMap,
  nodeMap,
  session,
  loadingMessages = false,
  loadError = null,
  onRetryLoad,
  highlightMessageId,
  onStartEdit,
  onForkMessage,
  onInspectSubagentRun,
  editingMessage,
  canEdit = false,
  hasEarlierMessages = false,
  loadingEarlier = false,
  onLoadEarlier,
  keyboardInset = 0,
  activeSubagentRunsFor,
  className = 'max-w-4xl px-3 sm:px-5',
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  // 回到底部按钮触发的程序化平滑滚动标记，避免滚动动画的中间位置误触发 userScrolledUp
  const programmaticScrollRef = useRef(false);

  // ===== 历史消息向上分页：prepend 滚动锚定 =====
  const prevScrollHeightRef = useRef<number | null>(null);
  const prevFirstMessageIdRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(messages.length);
  const pendingPrependRef = useRef(false);
  // 自动滚动专用：记录上次自动滚动时的消息数，用于识别首屏填充（0→N）强制瞬时
  const prevAutoScrollCountRef = useRef(messages.length);

  const handleLoadEarlier = useCallback(() => {
    if (loadingEarlier || !onLoadEarlier) return;
    const el = scrollContainerRef.current;
    if (el) prevScrollHeightRef.current = el.scrollHeight;
    prevFirstMessageIdRef.current = messages.length > 0 ? messages[0].id : null;
    pendingPrependRef.current = true;
    onLoadEarlier();
  }, [loadingEarlier, onLoadEarlier, messages]);

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
  }, [hasEarlierMessages, loadingEarlier, onLoadEarlier, messages.length, handleLoadEarlier]);

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

  // ===== 自动滚动 / 回到底部 =====
  const scrollToBottom = (smooth = true) => {
    if (userScrolledUp) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  const effectiveStreamingStates = streamingStates;
  const isParallelStreaming = effectiveStreamingStates.length > 1;

  useLayoutEffect(() => {
    scrollToBottom(false);
  }, [session?.id]);

  useLayoutEffect(() => {
    // prepend 加载更早消息时不触发自动滚底（视口锚定由上方 layout effect 补偿）。
    if (pendingPrependRef.current) {
      pendingPrependRef.current = false;
      return;
    }
    // 首屏填充（0→N）与长距离回落（切回浏览器重连补齐等）一律瞬时贴底，
    // 避免移动端呈现「从顶滑到底」的动画；
    // 仅已在底部附近的增量追加（流式输出、新消息）保留平滑滚动。
    // 注意不能用「落差 < 2 屏」判断：短会话总高度本身小于 2 屏，首次填充会误走 smooth。
    const el = scrollContainerRef.current;
    let smooth = false;
    if (el && el.clientHeight > 0) {
      const isInitialFill = prevAutoScrollCountRef.current === 0;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      smooth = !isInitialFill && distance < el.clientHeight * 2;
    }
    prevAutoScrollCountRef.current = messages.length;
    scrollToBottom(smooth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 单个流式 BOT 输出块（并发网格内复用，风格与 MessageItem Assistant 一致）
  const renderStreamingBlock = (state: StreamingAssistantState) => {
    const bot = botMap.get(state.botId);
    const shortModel = formatShortModel(bot?.modelId);
    const hasContent = Boolean(
      (state.blocks && state.blocks.length > 0) || state.delta || state.tools.length > 0
    );
    const subRuns = activeSubagentRunsFor?.[state.botId];

    return (
      <div
        key={state.botId}
        className={
          isParallelStreaming
            ? 'p-3 bg-white dark:bg-zinc-900/40 border border-zinc-200/80 dark:border-zinc-800 rounded-xl min-w-0'
            : 'py-2 sm:py-2.5 animate-in fade-in'
        }
      >
        {/* 身份行：微徽章 + 名称 + 模型 + 运行中呼吸指示 */}
        <div className="flex items-center gap-1.5 min-w-0 mb-0.5">
          <BotAvatarBadge botId={state.botId} name={bot?.name} color={bot?.color} />
          <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {bot?.name || state.botId}
          </span>
          {shortModel && (
            <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 truncate">
              {shortModel}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-[11px] text-blue-500 dark:text-blue-400">生成中</span>
          </span>
        </div>

        {/* 子代理协同运行中轨迹 */}
        {subRuns && subRuns.length > 0 && (
          <SubagentRunsPanel runs={subRuns} onInspectSubagentRun={onInspectSubagentRun} />
        )}

        {/* 统一交错时间线渲染器 */}
        {hasContent ? (
          <AssistantTurnContent
            blocks={state.blocks}
            toolCalls={state.tools.map((t, idx) => ({
              id: t.id || `${t.toolName}_${idx}`,
              name: t.toolName,
              status: t.status,
              summary: t.summary,
              args: t.args,
              outputPreview: t.outputPreview,
              durationMs: t.durationMs,
              isError: t.isError,
            }))}
            content={state.delta}
          />
        ) : (
          <div className="flex items-center gap-2 py-2">
            <TypingDots />
            <span className="text-xs text-zinc-400 dark:text-zinc-500">正在思考如何回应…</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto"
        role="log"
        aria-label="聊天消息记录"
      >
        <div className={`w-full mx-auto py-3 ${className}`}>
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
          ) : messages.length === 0 && effectiveStreamingStates.length === 0 && session ? (
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
                {session.memberBotIds.map((bid) => {
                  const b = botMap.get(bid);
                  return (
                    <span
                      key={bid}
                      className="inline-flex items-center gap-1.5 px-2 py-1 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800/80 rounded-full text-[11px] text-zinc-600 dark:text-zinc-400"
                      title={`${b?.name || bid} · @${bid}`}
                    >
                      <BotAvatarBadge botId={bid} name={b?.name} color={b?.color} className="!w-4 !h-4 !text-[9px]" />
                      <span className="truncate max-w-[120px]">{b?.name || bid}</span>
                    </span>
                  );
                })}
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
                  {/* 日期分隔线：相邻消息跨自然日时插入时间锚点 */}
                  {(idx === 0 || !isSameCalendarDay(messages[idx - 1].createdAt, msg.createdAt)) && (
                    <div className="flex justify-center my-3">
                      <span className="px-2.5 py-0.5 rounded-full bg-zinc-100/90 dark:bg-zinc-800/90 text-[11px] text-zinc-500 dark:text-zinc-400 select-none">
                        {formatChatDayLabel(msg.createdAt)}
                      </span>
                    </div>
                  )}
                  <div
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
                      canEdit={canEdit}
                      isEditing={editingMessage?.id === msg.id}
                      onStartEdit={onStartEdit}
                      onForkMessage={onForkMessage}
                      onInspectSubagentRun={onInspectSubagentRun}
                    />
                  </div>
                </React.Fragment>
              ))}

              {/* 多 BOT 并发流式：网格并排展示，互不覆盖；单 BOT 保持平铺风格 */}
              {isParallelStreaming ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 my-2">
                  <div className="col-span-full flex items-center justify-center gap-1.5 py-1.5 px-3 bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200/70 dark:border-blue-900/60 rounded-full w-fit mx-auto">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
                    <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">
                      {effectiveStreamingStates.length} 位智能体并发执行中
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
      </div>

      {/* 回到底部悬浮按钮：画布底部水平居中，毛玻璃质感 */}
      {userScrolledUp && (
        <button
          onClick={handleJumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 h-9 px-3.5 rounded-full bg-white/90 dark:bg-zinc-800/90 backdrop-blur-md border border-zinc-200 dark:border-zinc-700 shadow-lg text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-white dark:hover:bg-zinc-700 transition-colors cursor-pointer animate-in fade-in"
          aria-label="回到底部"
        >
          <ArrowDown className="w-3.5 h-3.5" />
          <span>回到底部</span>
        </button>
      )}
    </div>
  );
};
