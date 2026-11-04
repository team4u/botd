import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, GitBranch, Link2, Loader2, Zap, X } from 'lucide-react';
import {
  formatWorkerElapsed,
  isWorkerActive,
  type SuperAgentWorkerItem,
} from '../hooks/useSuperAgentWorkers';

/**
 * 全双工常驻胶囊条：置于 ChatView 顶部，当前会话的 Bot 人格有后台 Worker / Workflow
 * 运行（或近期完成）时展示。点击胶囊打开 WorkerInspectDrawer 检视；胶囊右侧 × 快速
 * 停止该后台任务，完全不打断前台对话。
 */
export interface ActiveWorkersBarProps {
  workers: SuperAgentWorkerItem[];
  /** 正在停止中的 workerId 集合（按钮转圈禁用） */
  stoppingWorkerIds?: ReadonlySet<string>;
  onSelectWorker: (workerId: string) => void;
  onStopWorker: (workerId: string) => void;
}

const STATUS_ICON_CLASS: Record<SuperAgentWorkerItem['status'], string> = {
  pending: 'text-zinc-400 dark:text-zinc-500',
  running: 'text-blue-500 dark:text-blue-400',
  waiting: 'text-amber-500 dark:text-amber-400',
  completed: 'text-emerald-500 dark:text-emerald-400',
  failed: 'text-rose-500 dark:text-rose-400',
  aborted: 'text-zinc-400 dark:text-zinc-500',
};

/** 单个后台工作单元胶囊：状态图标 + 标题 + 阶段/工具徽标 + 计时 + 隔离/订阅徽标 + 快速停止 */
const WorkerCapsule: React.FC<{
  worker: SuperAgentWorkerItem;
  now: number;
  stopping: boolean;
  onSelect: () => void;
  onStop: () => void;
}> = ({ worker, now, stopping, onSelect, onStop }) => {
  const active = isWorkerActive(worker.status);
  const elapsed = formatWorkerElapsed(worker, now);
  const toolBadge = worker.currentTool || worker.phase;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      title={`${worker.title}（点击检视${active ? '，× 停止该后台任务' : ''}）`}
      className="group inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-700/80 hover:border-blue-300 dark:hover:border-blue-700 shadow-xs transition-colors cursor-pointer max-w-full min-w-0"
    >
      {/* 状态图标：运行/等待旋转，完成勾，失败警示，中止叉 */}
      {active ? (
        <Loader2 className={`w-3 h-3 animate-spin-fast shrink-0 ${STATUS_ICON_CLASS[worker.status]}`} />
      ) : worker.status === 'completed' ? (
        <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-500 dark:text-emerald-400" />
      ) : worker.status === 'failed' ? (
        <AlertTriangle className="w-3 h-3 shrink-0 text-rose-500 dark:text-rose-400" />
      ) : (
        <X className="w-3 h-3 shrink-0 text-zinc-400 dark:text-zinc-500" />
      )}

      <span className="text-[11px] font-medium text-zinc-800 dark:text-zinc-200 truncate max-w-[180px]">
        {worker.title}
      </span>

      {/* 当前阶段或工具徽标（如 bash / Phase: Verify） */}
      {toolBadge && (
        <span className="hidden sm:inline-flex items-center px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 max-w-[120px] truncate">
          {worker.phase && !worker.currentTool ? `Phase: ${toolBadge}` : toolBadge}
        </span>
      )}

      {/* 计时（活跃走表 / 终态冻结） */}
      <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums shrink-0">
        {elapsed}
      </span>

      {/* Git worktree 隔离徽标 */}
      {worker.worktreePath && (
        <span
          title={`Git worktree 隔离：${worker.worktreePath}`}
          className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200/60 dark:border-emerald-800/60 text-[10px] font-medium text-emerald-600 dark:text-emerald-300 shrink-0"
        >
          <GitBranch className="w-2.5 h-2.5" />
          <span className="hidden md:inline">worktree</span>
        </span>
      )}

      {/* 订阅线程键（Pass-through 直通）徽标 */}
      {worker.threadKeys && worker.threadKeys.length > 0 && (
        <span
          title={`Pass-through 直通订阅：${worker.threadKeys.join('、')}`}
          className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 dark:border-blue-800/60 text-[10px] font-medium text-blue-600 dark:text-blue-300 max-w-[140px] shrink-0"
        >
          <Link2 className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">{worker.threadKeys[0]}</span>
        </span>
      )}

      {/* 快速停止（仅活跃任务，不打断前台对话） */}
      {active && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!stopping) onStop();
          }}
          disabled={stopping}
          aria-label={`停止后台任务 ${worker.title}`}
          title="停止该后台任务（不影响前台对话）"
          className="inline-flex items-center justify-center w-4 h-4 rounded-full text-zinc-400 hover:text-white hover:bg-rose-500 dark:text-zinc-500 dark:hover:text-white disabled:opacity-50 transition-colors cursor-pointer shrink-0"
        >
          {stopping ? <Loader2 className="w-2.5 h-2.5 animate-spin-fast" /> : <X className="w-2.5 h-2.5" />}
        </button>
      )}
    </div>
  );
};

export const ActiveWorkersBar: React.FC<ActiveWorkersBarProps> = ({
  workers,
  stoppingWorkerIds,
  onSelectWorker,
  onStopWorker,
}) => {
  // 活跃任务走表计时（每秒推进，无活跃任务不启动定时器）
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(true);
  const hasActive = workers.some((worker) => isWorkerActive(worker.status));

  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  // 新任务出现时自动展开胶囊列表
  useEffect(() => {
    if (hasActive) setExpanded(true);
  }, [hasActive]);

  if (workers.length === 0) return null;

  const activeWorkers = workers.filter((worker) => isWorkerActive(worker.status));
  const completedCount = workers.length - activeWorkers.length;
  const stopping = stoppingWorkerIds ?? new Set<string>();

  return (
    <div className="px-3 sm:px-4 pt-2.5 max-w-4xl w-full mx-auto shrink-0">
      <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/50 shadow-xs">
        {/* 状态徽标行：全双工模式提示 / 完成摘要 + 展开-收起 */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center justify-between gap-2 w-full px-3 py-1.5 text-xs cursor-pointer select-none"
          aria-expanded={expanded}
        >
          <span
            className={`inline-flex items-center gap-1.5 font-medium ${
              hasActive ? 'text-blue-700 dark:text-blue-300' : 'text-emerald-700 dark:text-emerald-300'
            }`}
          >
            {hasActive ? (
              <>
                <Zap className="w-3.5 h-3.5 shrink-0" />
                <span>⚡ 全双工常驻 · {activeWorkers.length} 个后台任务运行中</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>✓ {completedCount} 个后台任务已完成</span>
              </>
            )}
          </span>
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
          )}
        </button>

        {/* 胶囊列表：横向滚动，点击检视 / × 快速停止 */}
        {expanded && (
          <div className="flex items-center gap-1.5 px-2.5 pb-2 overflow-x-auto">
            {workers.map((worker) => (
              <WorkerCapsule
                key={worker.workerId}
                worker={worker}
                now={now}
                stopping={stopping.has(worker.workerId)}
                onSelect={() => onSelectWorker(worker.workerId)}
                onStop={() => onStopWorker(worker.workerId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
