import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Loader2,
  Square,
  Send,
  Terminal,
  MessageSquareQuote,
  Wrench,
  FileText,
  ChevronDown,
  ChevronRight,
  CircleStop,
} from 'lucide-react';
import type { SubagentRunRecord, ToolCallRecord } from '@botd/protocol';
import { api } from '../api';
import { formatDuration, subagentColorStyles } from './MessageItem';
import type { ToastItem } from '../types';

interface SubagentRunDrawerProps {
  isOpen: boolean;
  sessionId: string;
  /** 当前查看的分身运行记录（由上层从实时 activeSubagentRuns 或已落库 messages 中派生最新值） */
  run: SubagentRunRecord | null;
  onClose: () => void;
  onToast: (type: ToastItem['type'], message: string) => void;
}

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

/** 单条工具调用行（可展开看输出预览） */
const ToolCallRow: React.FC<{ tool: ToolCallRecord }> = ({ tool }) => {
  const [expanded, setExpanded] = useState(false);
  const isError = tool.status === 'error' || Boolean(tool.isError);
  const hasDetail = Boolean(tool.outputPreview || tool.summary || tool.args);

  return (
    <div className="rounded-lg border border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/50 overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left ${
          hasDetail ? 'cursor-pointer hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40 transition-colors' : 'cursor-default'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 font-mono text-[11px]">
          {hasDetail ? (
            <span className="text-zinc-400 shrink-0">{expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</span>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className={`font-semibold truncate ${isError ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
            {tool.name}
          </span>
          {tool.summary && (
            <span className="text-zinc-400 dark:text-zinc-500 truncate">{tool.summary}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-[11px] font-mono">
          {tool.status === 'running' && <span className="text-blue-500">running…</span>}
          {tool.status === 'error' && <span className="text-rose-500">error</span>}
          {typeof tool.durationMs === 'number' && (
            <span className="text-zinc-400 dark:text-zinc-500">{formatDuration(tool.durationMs)}</span>
          )}
        </div>
      </button>
      {expanded && (tool.outputPreview || tool.args) && (
        <div className="px-2.5 pb-2 space-y-1.5">
          {tool.args && Object.keys(tool.args).length > 0 && (
            <pre className="px-2 py-1.5 rounded bg-white dark:bg-zinc-950/70 border border-zinc-200/50 dark:border-zinc-800/50 text-[11px] font-mono text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
              {JSON.stringify(tool.args, null, 2)}
            </pre>
          )}
          {tool.outputPreview && (
            <pre
              className={`px-2 py-1.5 rounded border text-[11px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto ${
                isError
                  ? 'bg-rose-50/80 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-900/60'
                  : 'bg-white dark:bg-zinc-950/70 text-zinc-600 dark:text-zinc-300 border-zinc-200/50 dark:border-zinc-800/50'
              }`}
            >
              {tool.outputPreview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * 分身运行详情抽屉：展示单个 runId 的初始任务、交互指令记录、工具调用轨迹与完整输出，
 * 并提供运行中停止 / steer 插话 / resume 追问控制（不跳转离开主会话窗口）。
 */
export const SubagentRunDrawer: React.FC<SubagentRunDrawerProps> = ({
  isOpen,
  sessionId,
  run,
  onClose,
  onToast,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const isRunning = run?.status === 'running';
  const colorStyle = run?.color && subagentColorStyles[run.color] ? subagentColorStyles[run.color] : undefined;
  const fullReply = useMemo(() => run?.replyFull || run?.replyPreview || '', [run]);
  const toolCalls = run?.toolCalls ?? [];

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
        className="fixed inset-y-0 right-0 z-40 w-[min(28rem,92vw)] bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        {/* 顶部栏：分身身份 + 状态徽章 + 耗时 + 停止按钮 */}
        <div className="flex items-center justify-between gap-2 px-4 h-13 sm:h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                colorStyle?.iconBg ?? 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800'
              }`}
            >
              <Wrench className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                {run.subagentName || `@${run.subagentId}`}
              </h2>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate font-mono" title={run.id}>
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

        {/* 内容区：初始任务 / 交互指令 / 工具调用轨迹 / 完整回复 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
          {/* 1. 初始任务（Task Prompt） */}
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">
              <FileText className="w-3.5 h-3.5" />
              <span>初始任务 (Task)</span>
            </h3>
            <div className="rounded-lg border border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 px-3 py-2.5 text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">
              {run.task || '（无任务描述）'}
            </div>
          </section>

          {/* 2. 交互指令记录（Steers / Resumes） */}
          {run.steers && run.steers.length > 0 && (
            <section>
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">
                <MessageSquareQuote className="w-3.5 h-3.5" />
                <span>交互指令记录 ({run.steers.length})</span>
              </h3>
              <div className="space-y-1.5">
                {run.steers.map((steer, idx) => (
                  <div
                    key={`${steer.timestamp}-${idx}`}
                    className="rounded-lg border border-amber-200/60 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2"
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        {steer.mode === 'resume' ? '追问 (Resume)' : '插话 (Steer)'}
                      </span>
                      <span className="text-[11px] text-amber-600/60 dark:text-amber-400/50 font-mono">
                        {new Date(steer.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-xs text-amber-900 dark:text-amber-200 whitespace-pre-wrap break-words">
                      {steer.message}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 3. 工具调用轨迹（Tool Calls） */}
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">
              <Terminal className="w-3.5 h-3.5" />
              <span>
                工具调用轨迹 ({toolCalls.length}
                {run.currentTool ? ` · 当前: ${run.currentTool}` : ''})
              </span>
            </h3>
            {toolCalls.length > 0 ? (
              <div className="space-y-1.5">
                {toolCalls.map((tool, idx) => (
                  <ToolCallRow key={tool.id || `${tool.name}-${idx}`} tool={tool} />
                ))}
              </div>
            ) : (
              <div className="text-xs text-zinc-400 dark:text-zinc-500 italic px-1">
                {isRunning ? '尚未调用工具…' : '（无工具调用记录）'}
              </div>
            )}
          </section>

          {/* 4. 完整回复内容（Full Reply，不截断） */}
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">
              <FileText className="w-3.5 h-3.5" />
              <span>完整输出 (Full Reply)</span>
            </h3>
            {fullReply ? (
              <div className="rounded-lg border border-zinc-200/70 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 px-3 py-2.5 text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words leading-relaxed max-h-[50vh] overflow-y-auto">
                {fullReply}
              </div>
            ) : (
              <div className="text-xs text-zinc-400 dark:text-zinc-500 italic px-1">
                {isRunning ? '分身仍在运行，输出尚未产生…' : '（无输出内容）'}
              </div>
            )}
          </section>
        </div>

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
          <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 flex items-center gap-1">
            <Square className="w-3 h-3 shrink-0" />
            <span>
              {isRunning
                ? 'Steer 消息将在分身当前工具执行完后注入其会话；「停止分身」仅停该 runId，不影响主回合。'
                : 'Resume 在同一分身会话上下文继续追问，结果将更新到本抽屉与消息卡片。'}
            </span>
          </p>
        </div>
      </div>
    </>
  );
};
