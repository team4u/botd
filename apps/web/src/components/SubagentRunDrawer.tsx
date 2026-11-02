import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, Send, CircleStop } from 'lucide-react';
import type {
  BotConfig,
  MessageRecord,
  NodeRecord,
  SubagentRunRecord,
} from '@botd/protocol';
import { api } from '../api';
import { BotAvatarBadge, formatDuration } from './MessageItem';
import { MessageTimeline } from './MessageTimeline';
import type { StreamingAssistantState, ToastItem } from '../types';

interface SubagentRunDrawerProps {
  isOpen: boolean;
  sessionId: string;
  /** 当前查看的分身运行记录（由上层从实时 activeSubagentRuns 或已落库 messages 中派生最新值） */
  run: SubagentRunRecord | null;
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  onClose: () => void;
  onToast: (type: ToastItem['type'], message: string) => void;
};

/** 状态徽章配色 */
const statusBadgeClass = (status: SubagentRunRecord['status']): string => {
  switch (status) {
    case 'running':
      return 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200/60 dark:border-blue-800/60';
    case 'done':
      return 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-800/60';
    case 'stopped':
      return 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200/70 dark:border-zinc-700/70';
    case 'error':
      return 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-800/60';
    default:
      return 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-200/70 dark:border-zinc-700/70';
  }
};

const statusLabel = (status: SubagentRunRecord['status']): string => {
  switch (status) {
    case 'running':
      return '运行中';
    case 'done':
      return '已完成';
    case 'stopped':
      return '已停止';
    case 'error':
      return '失败';
    default:
      return '已跳过';
  }
};

/**
 * 把一次分身运行记录合成为 MessageTimeline 的标准输入：
 * - 初始任务 + 历次 steer/resume 指令 → 右对齐用户气泡（senderUsername 标注指令类型）
 * - 分身执行过程 → 运行中映射为流式状态（思考/工具/文本实时滚动）；
 *   已结束映射为一条 assistant 消息（blocks 交错时间线 + toolCalls + 完整输出）
 * 零特判：时间线组件与主对话共用同一渲染路径，视觉/交互完全一致。
 */
export function subagentRunToTimeline(run: SubagentRunRecord): {
  messages: MessageRecord[];
  streamingStates: StreamingAssistantState[];
} {
  const startIso = run.startedAt || new Date().toISOString();
  const messages: MessageRecord[] = [];

  // 1) 指令侧：初始任务 + steer/resume 全部作为用户消息（同一时间轴，按到达顺序）
  messages.push({
    id: `${run.id}:task`,
    sessionId: '',
    role: 'user',
    content: run.task || '（无任务描述）',
    mentions: [],
    senderUsername: '任务指令',
    createdAt: startIso,
  });
  for (const [idx, steer] of (run.steers ?? []).entries()) {
    messages.push({
      id: `${run.id}:steer:${idx}`,
      sessionId: '',
      role: 'user',
      content: steer.message,
      mentions: [],
      senderUsername: steer.mode === 'resume' ? '追问 (Resume)' : '插话纠偏 (Steer)',
      createdAt: steer.timestamp || startIso,
    });
  }

  // 2) 分身侧
  const baseAssistant: MessageRecord = {
    id: `${run.id}:reply`,
    sessionId: '',
    role: 'assistant',
    senderBotId: run.subagentId,
    content: run.replyFull || run.replyPreview || '',
    mentions: [],
    createdAt: startIso,
    ...(run.status === 'stopped' ? { aborted: true } : {}),
    ...(run.toolCalls && run.toolCalls.length > 0 ? { toolCalls: run.toolCalls } : {}),
    ...(run.blocks && run.blocks.length > 0 ? { blocks: run.blocks } : {}),
  };

  const streamingStates: StreamingAssistantState[] = [];
  if (run.status === 'running') {
    // 运行中：交给流式渲染（呼吸徽章 + 思考/工具/文本实时滚动）
    streamingStates.push({
      botId: run.subagentId,
      delta: '',
      tools: [],
      blocks: run.blocks,
    });
    // 若已有部分文本输出（run.blocks 内含 text 块），流式块本身即可渲染，无需额外消息
    return { messages, streamingStates };
  }

  // 已结束：一条完整 assistant 消息（blocks 优先；无 blocks 时由 toolCalls+content 合成）
  messages.push(baseAssistant);
  return { messages, streamingStates };
}

/**
 * 分身运行详情抽屉：上部为与主对话完全同源的 MessageTimeline（同一组件、同一渲染路径），
 * 底部为 steer / resume 输入框与运行中停止按钮。主对话界面后续任何改进此处自动同步。
 */
export const SubagentRunDrawer: React.FC<SubagentRunDrawerProps> = ({
  isOpen,
  sessionId,
  run,
  botMap,
  nodeMap,
  onClose,
  onToast,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isRunning = run?.status === 'running';

  // 合成 botMap：确保分身 id 能命中（主会话的 botMap 可能未含分身条目）
  const effectiveBotMap = useMemo(() => {
    if (!run) return botMap;
    if (botMap.has(run.subagentId)) return botMap;
    const next = new Map(botMap);
    next.set(run.subagentId, {
      id: run.subagentId,
      nodeId: '',
      name: run.subagentName || run.subagentId,
      description: '',
      ...(run.color ? { color: run.color } : {}),
      parentBotId: '',
      modelProvider: '',
      modelId: '',
      toolScope: 'all',
      inheritModel: true,
      inheritSkills: true,
      enabledSkills: [],
      enabledExtensions: [],
      updatedAt: '',
    } as BotConfig);
    return next;
  }, [botMap, run]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const handleStop = async () => {
    if (!run || stopping) return;
    setStopping(true);
    try {
      await api.stopSubagent(sessionId, run.id);
      onToast('success', `已请求停止分身 ${run.subagentName || `@${run.subagentId}`}`);
    } catch (err: any) {
      onToast('error', err?.message || '停止分身失败');
    } finally {
      setStopping(false);
    }
  };

  const handleSend = async () => {
    const message = inputValue.trim();
    if (!run || !message || sending) return;
    setSending(true);
    try {
      await api.interactSubagent(sessionId, run.id, {
        message,
        mode: isRunning ? 'steer' : 'resume',
        subagentId: run.subagentId,
      });
      setInputValue('');
      onToast(
        'success',
        isRunning ? '插话已发送给正在运行的分身 (Steer)' : '已在该分身上下文继续追问 (Resume)'
      );
    } catch (err: any) {
      onToast('error', err?.message || '发送失败');
    } finally {
      setSending(false);
    }
  };

  const { messages: timelineMessages, streamingStates } = useMemo(
    () => (run ? subagentRunToTimeline(run) : { messages: [], streamingStates: [] }),
    [run]
  );

  if (!isOpen || !run) return null;

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
        aria-label={`分身运行详情 ${run.id}`}
        className="fixed inset-y-0 right-0 z-40 w-[min(38rem,96vw)] bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        {/* 顶部栏：分身身份 + 状态徽章 + 耗时 + 停止按钮 */}
        <div className="flex items-center justify-between gap-2 px-4 h-13 sm:h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <BotAvatarBadge
              botId={run.subagentId}
              name={run.subagentName}
              color={run.color}
              className="!w-7 !h-7 !text-[11px]"
            />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                {run.subagentName || `@${run.subagentId}`}
              </h2>
              <p
                className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate font-mono"
                title={run.id}
              >
                {run.id}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium ${statusBadgeClass(run.status)}`}
            >
              {isRunning && <Loader2 className="w-3 h-3 animate-spin-fast" />}
              {statusLabel(run.status)}
            </span>
            {typeof run.durationMs === 'number' && (
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
                {formatDuration(run.durationMs)}
              </span>
            )}
            {isRunning && (
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={stopping}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-medium transition-colors cursor-pointer shrink-0"
                title="仅停止该分身，不中断主回合与其他并发分身"
              >
                {stopping ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                ) : (
                  <CircleStop className="w-3.5 h-3.5" />
                )}
                <span>停止分身</span>
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
          messages={timelineMessages}
          streamingStates={streamingStates}
          botMap={effectiveBotMap}
          nodeMap={nodeMap}
          className="max-w-none px-4"
        />

        {/* 底部控制栏：steer / resume 输入框 */}
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
                  ? '向正在运行的分身插话纠偏 (Steer)...'
                  : '在同一分身上下文继续追问 (Resume)...'
              }
              aria-label={isRunning ? '向分身插话' : '向分身追问'}
              className="flex-1 min-w-0 h-8 px-2.5 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 transition-colors"
            />
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!inputValue.trim() || sending}
              className="inline-flex items-center gap-1 h-8 px-3 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer shrink-0"
              title={isRunning ? '发送插话 (Steer)' : '发送追问 (Resume)'}
            >
              {sending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>{isRunning ? 'Steer' : 'Resume'}</span>
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
            {isRunning
              ? 'Steer 消息将在分身当前工具执行完后注入其会话；「停止分身」仅停该 runId，不影响主回合。'
              : 'Resume 在同一分身会话上下文继续追问，结果将更新到本抽屉与消息卡片。'}
          </p>
        </div>
      </div>
    </>
  );
};
