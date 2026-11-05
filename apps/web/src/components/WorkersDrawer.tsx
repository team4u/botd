import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  CornerDownRight,
  GitBranch,
  HeartPulse,
  Link2,
  Loader2,
  Plus,
  Send,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type { BotConfig, NodeRecord, ToolCallRecord } from '@botd/protocol';
import { AssistantTurnContent } from './MessageItem';
import { formatDuration } from '../message-format';
import {
  formatWorkerElapsed,
  isWorkerActive,
  type SuperAgentWorkerItem,
  type SuperAgentWorkerSteerMode,
} from '../hooks/useSuperAgentWorkers';

/**
 * 后台子任务抽屉（列表 ⇄ 详情一体）：取代原顶栏横栏与独立检视抽屉的统一入口。
 *
 * 列表视图：失败置顶 → 活跃走表（计时/当前工具/行内中止）→ 终态折叠分组；
 * 顶栏提供「+ 派发」内联表单与 Watchdog 巡检。详情视图：Bot 徽标/状态/计时 +
 * 元信息徽标行 + AssistantTurnContent 实时时间线 + Steer / Follow-up / Abort 全双工干预。
 */
export interface WorkersDrawerProps {
  isOpen: boolean;
  workers: SuperAgentWorkerItem[];
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  /** 正在停止中的 workerId 集合（按钮转圈禁用） */
  stoppingWorkerIds?: ReadonlySet<string>;
  /** 初始定位到该 worker 的详情页（如 "w-1-82"）；空串/null 显示列表 */
  initialWorkerId?: string;
  onSelectWorker: (workerId: string) => void;
  onStopWorker: (workerId: string) => void;
  /** 手动派发后台 Worker（支持 Git Worktree 隔离与直通线程键） */
  onSpawnWorker?: (input: {
    title: string;
    task: string;
    worktree?: boolean;
    threadKey?: string;
  }) => Promise<boolean>;
  /** 触发 Watchdog 健康巡检 */
  onRunWatchdog?: () => Promise<{ healthy: boolean; summary: string } | null>;
  /** 向 worker 发送指令（运行中 Steer 插话 / 结束后 Follow-up 继续） */
  onSteer?: (
    workerId: string,
    message: string,
    mode: SuperAgentWorkerSteerMode
  ) => Promise<boolean>;
  onClose: () => void;
}

const STATUS_LABEL: Record<SuperAgentWorkerItem['status'], string> = {
  pending: '排队中',
  running: '运行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
};

const STATUS_BADGE_CLASS: Record<SuperAgentWorkerItem['status'], string> = {
  pending: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200/70 dark:border-zinc-700/70',
  running: 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200/60 dark:border-blue-800/60',
  waiting: 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200/60 dark:border-amber-800/60',
  completed:
    'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-800/60',
  failed: 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-800/60',
  aborted: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-200/70 dark:border-zinc-700/70',
};

/** 状态节点图标：活跃旋转 / 完成勾 / 失败警示 / 其余弱化 */
const StatusNode: React.FC<{ status: SuperAgentWorkerItem['status'] }> = ({ status }) => {
  if (status === 'pending') return <HourglassNode />;
  if (isWorkerActive(status)) {
    return (
      <Loader2
        className={`w-3 h-3 animate-spin-fast ${
          status === 'waiting' ? 'text-amber-500 dark:text-amber-400' : 'text-blue-500 dark:text-blue-400'
        }`}
      />
    );
  }
  if (status === 'completed') return <CheckCircle2 className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />;
  if (status === 'failed') return <AlertTriangle className="w-3 h-3 text-rose-500 dark:text-rose-400" />;
  return <X className="w-3 h-3 text-zinc-400 dark:text-zinc-500" />;
};

const HourglassNode: React.FC = () => (
  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse" />
);

/** 列表行左侧状态图标（与检视状态徽标同一套语义） */
const RowStatusIcon: React.FC<{ status: SuperAgentWorkerItem['status'] }> = ({ status }) => {
  if (status === 'pending') return <HourglassNode />;
  if (isWorkerActive(status)) {
    return (
      <Loader2
        className={`w-4 h-4 shrink-0 animate-spin-fast ${
          status === 'waiting' ? 'text-amber-500 dark:text-amber-400' : 'text-blue-500 dark:text-blue-400'
        }`}
      />
    );
  }
  if (status === 'completed') return <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500 dark:text-emerald-400" />;
  if (status === 'failed') return <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500 dark:text-rose-400" />;
  return <X className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />;
};

/** 可展开的输出预览（工具调用结果 / 思考摘要） */
const ExpandablePreview: React.FC<{ text?: string; label: string }> = ({ text, label }) => {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors cursor-pointer"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-56 overflow-auto font-mono text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200/70 dark:border-zinc-800 p-2">
          {text}
        </pre>
      )}
    </div>
  );
};

/** 时间线单条工具调用行 */
const ToolCallRow: React.FC<{ tool: ToolCallRecord }> = ({ tool }) => {
  return (
    <div className="flex gap-2">
      <span className="z-10 w-6 h-6 mt-0.5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center shrink-0">
        {tool.status === 'running' ? (
          <Loader2 className="w-3 h-3 text-blue-500 animate-spin-fast" />
        ) : tool.status === 'error' ? (
          <AlertTriangle className="w-3 h-3 text-rose-500 dark:text-rose-400" />
        ) : tool.status === 'cancelled' ? (
          <X className="w-3 h-3 text-zinc-400 dark:text-zinc-500" />
        ) : (
          <Wrench className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />
        )}
      </span>
      <div className="flex-1 min-w-0 pb-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
            {tool.name}
          </span>
          {tool.summary && (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate max-w-[280px]">
              {tool.summary}
            </span>
          )}
          {typeof tool.durationMs === 'number' && (
            <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
              {formatDuration(tool.durationMs)}
            </span>
          )}
        </div>
        <ExpandablePreview text={tool.outputPreview} label="输出预览" />
      </div>
    </div>
  );
};

/** 历次人工指令（Steer / Follow-up）行 */
const SteerRow: React.FC<{ message: string; createdAt: string }> = ({ message, createdAt }) => (
  <div className="flex gap-2 justify-end">
    <div className="max-w-[85%] px-2.5 py-1.5 rounded-xl rounded-tr-sm bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 dark:border-blue-800/60">
      <div className="flex items-center gap-1 text-[10px] font-medium text-blue-600 dark:text-blue-300 mb-0.5">
        <CornerDownRight className="w-3 h-3" />
        <span>人工指令</span>
        {createdAt && (
          <span className="font-mono font-normal text-blue-400/70 dark:text-blue-400/60">{createdAt.slice(11, 19)}</span>
        )}
      </div>
      <div className="text-xs text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap break-words">{message}</div>
    </div>
  </div>
);

/** 列表行：状态图标 + 标题 + 工具/阶段徽标 + 计时 + 行内中止，整行点击进详情 */
const WorkerListRow: React.FC<{
  worker: SuperAgentWorkerItem;
  now: number;
  stopping: boolean;
  onSelect: () => void;
  onStop: () => void;
}> = ({ worker, now, stopping, onSelect, onStop }) => {
  const active = isWorkerActive(worker.status);
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
      title={`${worker.title}（点击查看执行时间线）`}
      className="flex items-center gap-2 min-h-10 px-2.5 py-2 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors cursor-pointer group/row"
    >
      <RowStatusIcon status={worker.status} />
      <span className="flex-1 min-w-0 text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
        {worker.title}
      </span>
      {/* 当前阶段或工具徽标（如 bash / Phase: Verify） */}
      {toolBadge && (
        <span className="hidden xs:inline-flex items-center px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 max-w-[110px] truncate shrink-0">
          {worker.phase && !worker.currentTool ? `Phase: ${toolBadge}` : toolBadge}
        </span>
      )}
      {/* 计时（活跃走表 / 终态冻结） */}
      <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums shrink-0">
        {formatWorkerElapsed(worker, now)}
      </span>
      {/* 行内中止（仅活跃任务，不打断前台对话） */}
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
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-400 hover:text-white hover:bg-rose-500 dark:text-zinc-500 dark:hover:text-white disabled:opacity-50 transition-colors cursor-pointer shrink-0"
        >
          {stopping ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
          ) : (
            <CircleStop className="w-3.5 h-3.5" />
          )}
        </button>
      )}
    </div>
  );
};

/** 详情视图：检视台主体（顶栏 + 元信息徽标行 + 时间线 + 全双工 composer）
 *  Watchdog 巡检状态由父组件 WorkersDrawer 持有（与列表视图共享），经 props 传入。 */
const WorkerDetailView: React.FC<{
  worker: SuperAgentWorkerItem;
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  now: number;
  stopping: boolean;
  onBack: () => void;
  onClose: () => void;
  onStop: (workerId: string) => void;
  onSteer?: (workerId: string, message: string, mode: SuperAgentWorkerSteerMode) => Promise<boolean>;
  /** 触发父组件的 Watchdog 巡检（状态由父持有，与列表视图共享） */
  onTriggerWatchdog?: () => void;
  watchdogRunning?: boolean;
  watchdogSummary?: string | null;
}> = ({
  worker,
  botMap,
  nodeMap,
  now,
  stopping,
  onBack,
  onClose,
  onStop,
  onSteer,
  onTriggerWatchdog,
  watchdogRunning = false,
  watchdogSummary = null,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const active = isWorkerActive(worker.status);
  // 切到详情时聚焦输入框，随时插话
  useEffect(() => {
    inputRef.current?.focus();
  }, [worker.workerId]);

  // 新事件到达时自动贴底（用户上翻浏览时不打扰）
  const timelineSignature = useMemo(() => {
    return `${worker.blocks?.length ?? 0}:${worker.toolCalls?.length ?? 0}:${worker.steers?.length ?? 0}:${worker.status}`;
  }, [worker]);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [timelineSignature]);

  const handleSend = async (mode: SuperAgentWorkerSteerMode) => {
    const message = inputValue.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      const ok = (await onSteer?.(worker.workerId, message, mode)) ?? false;
      if (ok) setInputValue('');
    } finally {
      setSending(false);
    }
  };

  // 合成时间线：blocks（交错思考/工具/文本）> toolCalls > 占位兜底
  const timelineBlocks = worker.blocks && worker.blocks.length > 0 ? worker.blocks : null;
  const bot = botMap.get(worker.botId);
  const node = worker.nodeId ? nodeMap.get(worker.nodeId) : undefined;

  return (
    <>
      {/* 顶部：返回 + Bot 人格徽标 + 标题 + 状态徽标 + 计时 + 中止 + 关闭 */}
      <div className="flex items-center justify-between gap-2 px-2.5 sm:px-4 h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <button
            type="button"
            onClick={onBack}
            aria-label="返回任务列表"
            title="返回任务列表"
            className="inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-lg text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-4.5 h-4.5" />
          </button>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              {worker.title}
            </h2>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
              {worker.botName || bot?.name || `@${worker.botId}`}
              {worker.kind !== 'worker' && (
                <span className="ml-1 px-1 rounded bg-zinc-100 dark:bg-zinc-800 font-mono">
                  {worker.kind === 'workflow' ? 'workflow' : 'speculative'}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onTriggerWatchdog && (
            <button
              type="button"
              onClick={onTriggerWatchdog}
              disabled={watchdogRunning}
              title="运行 Watchdog 巡检"
              className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-zinc-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-900 hover:border-blue-300 dark:hover:border-blue-700 disabled:opacity-50 text-zinc-600 dark:text-zinc-300 text-xs font-medium transition-colors cursor-pointer"
            >
              {watchdogRunning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
              ) : (
                <HeartPulse className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">Watchdog 巡检</span>
            </button>
          )}
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium ${STATUS_BADGE_CLASS[worker.status]}`}
          >
            <StatusNode status={worker.status} />
            {STATUS_LABEL[worker.status]}
          </span>
          <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums">
            {formatWorkerElapsed(worker, now)}
          </span>
          {active && (
            <button
              type="button"
              onClick={() => onStop(worker.workerId)}
              disabled={stopping}
              title="中止该后台任务（不影响前台对话）"
              className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-medium transition-colors cursor-pointer shrink-0"
            >
              {stopping ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
              ) : (
                <CircleStop className="w-3.5 h-3.5" />
              )}
              <span>中止</span>
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

      {/* 元信息徽标行：nodeId / worktree / cwd / threadKeys（Pass-through 路由状态） */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-zinc-100 dark:border-zinc-900 flex-wrap shrink-0">
        {worker.nodeId && (
          <span
            title={`计算节点：${node?.name || worker.nodeId}`}
            className={`inline-flex items-center px-1.5 py-px rounded text-[10px] font-medium border ${
              node?.status === 'online'
                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-800/60'
                : 'bg-zinc-50 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200/70 dark:border-zinc-700/70'
            }`}
          >
            {node?.name || worker.nodeId}
          </span>
        )}
        {worker.phase && (
          <span className="inline-flex items-center px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
            Phase: {worker.phase}
          </span>
        )}
        {typeof worker.toolUses === 'number' && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] text-zinc-500 dark:text-zinc-400">
            <Wrench className="w-2.5 h-2.5" />
            {worker.toolUses} 次工具调用
          </span>
        )}
        {typeof worker.turns === 'number' && worker.turns > 0 && (
          <span
            title={`累计回合数：${worker.turns}`}
            className="inline-flex items-center px-1.5 py-px rounded bg-violet-50 dark:bg-violet-950/50 border border-violet-200/60 dark:border-violet-800/60 text-[10px] font-medium text-violet-600 dark:text-violet-300"
          >
            回合 {worker.turns}
          </span>
        )}
        {typeof worker.tokens === 'number' && worker.tokens > 0 && (
          <span
            title={`累计 Token 消耗：${worker.tokens.toLocaleString()}`}
            className="inline-flex items-center px-1.5 py-px rounded bg-violet-50 dark:bg-violet-950/50 border border-violet-200/60 dark:border-violet-800/60 text-[10px] font-medium text-violet-600 dark:text-violet-300 font-mono tabular-nums"
          >
            Tokens {worker.tokens.toLocaleString()}
          </span>
        )}
        {worker.worktreePath && (
          <span
            title={`Git worktree 隔离：${worker.worktreePath}`}
            className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200/60 dark:border-emerald-800/60 text-[10px] font-medium text-emerald-600 dark:text-emerald-300"
          >
            <GitBranch className="w-2.5 h-2.5" />
            <span className="font-mono max-w-[220px] truncate">
              {worker.branchName ? `worktree · ${worker.branchName}` : 'worktree'}
            </span>
          </span>
        )}
        {worker.cwd && !worker.worktreePath && (
          <span
            title={`工作目录：${worker.cwd}`}
            className="inline-flex items-center px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 max-w-[220px] truncate"
          >
            {worker.cwd}
          </span>
        )}
        {(worker.threadKeys ?? []).map((key) => (
          <span
            key={key}
            title={`Pass-through 直通订阅活跃：${key}`}
            className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 dark:border-blue-800/60 text-[10px] font-medium text-blue-600 dark:text-blue-300 max-w-[200px]"
          >
            <Link2 className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate font-mono">{key}</span>
          </span>
        ))}
        {watchdogSummary && (
          <span
            title={watchdogSummary}
            className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 dark:border-blue-800/60 text-[10px] font-medium text-blue-600 dark:text-blue-300 max-w-[320px]"
          >
            <HeartPulse className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate">Watchdog：{watchdogSummary}</span>
          </span>
        )}
        {worker.conversationId && (
          <span
            title={`独立子会话：${worker.conversationId}`}
            className="inline-flex items-center px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono text-zinc-400 dark:text-zinc-500 max-w-[200px] truncate"
          >
            {worker.conversationId}
          </span>
        )}
      </div>

      {/* 实时执行时间线（与主会话共享 AssistantTurnContent 渲染体系） */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        {timelineBlocks ? (
          <AssistantTurnContent blocks={timelineBlocks} collapseCompletedProcess />
        ) : worker.toolCalls && worker.toolCalls.length > 0 ? (
          <div className="relative">
            <span
              className="absolute left-[11px] top-2 bottom-2 w-px bg-zinc-200 dark:bg-zinc-800"
              aria-hidden="true"
            />
            <div className="space-y-1">
              {worker.toolCalls.map((tool, idx) => (
                <ToolCallRow key={`tc-${tool.id ?? idx}`} tool={tool} />
              ))}
            </div>
          </div>
        ) : active ? (
          <div className="flex items-center gap-2 py-6 justify-center text-xs text-zinc-400 dark:text-zinc-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
            <span>后台执行中，暂无过程输出…</span>
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">
            暂无过程记录
          </div>
        )}
        {(worker.steers ?? []).length > 0 && (
          <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-900 space-y-2">
            <div className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500">人工干预记录</div>
            {(worker.steers ?? []).map((steer, idx) => (
              <SteerRow key={`steer-${idx}`} message={steer.message} createdAt={steer.createdAt} />
            ))}
          </div>
        )}
      </div>

      {/* 底部全双工指令 composer：运行中 Steer 插话 / 已结束 Follow-up 继续 */}
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
                void handleSend(active ? 'steer' : 'followUp');
              }
            }}
            placeholder={
              active
                ? '向正在后台执行的 Worker 插话（Steer，不打断执行）…'
                : '继续追问该 Worker（Follow-up，同一上下文继续）…'
            }
            aria-label={active ? '向后台 Worker 插话' : '向后台 Worker 继续追问'}
            className="flex-1 min-w-0 h-9 px-2.5 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 transition-colors"
          />
          <button
            type="button"
            onClick={() => void handleSend(active ? 'steer' : 'followUp')}
            disabled={!inputValue.trim() || sending}
            title={
              active
                ? 'Steer：立即插话（whenBusy: "steer"）'
                : 'Follow-up：在该 Worker 上下文继续'
            }
            className="inline-flex items-center justify-center gap-1 h-9 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors cursor-pointer shrink-0"
          >
            {sending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">{active ? '插话' : '继续'}</span>
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
          {active
            ? '全双工模式：Steer 指令实时送达正在执行的 Worker，前台对话不受影响。'
            : '该任务已结束：发送即在原上下文继续（Follow-up）。'}
        </p>
      </div>
    </>
  );
};

/** 排序时间锚点：优先 updatedAt，缺失时回落 startedAt（倒序） */
function timeDesc(a: SuperAgentWorkerItem, b: SuperAgentWorkerItem, preferStartedAt = false): number {
  const pick = (w: SuperAgentWorkerItem) => {
    const t = Date.parse((preferStartedAt ? '' : w.updatedAt || '') || w.startedAt || '');
    return Number.isFinite(t) ? t : 0;
  };
  return pick(b) - pick(a);
}

export const WorkersDrawer: React.FC<WorkersDrawerProps> = ({
  isOpen,
  workers,
  botMap,
  nodeMap,
  stoppingWorkerIds,
  initialWorkerId,
  onSelectWorker,
  onStopWorker,
  onSpawnWorker,
  onRunWatchdog,
  onSteer,
  onClose,
}) => {
  // 列表 ⇄ 详情视图；初始态直接吃 props（SSR / 首帧即定位到 initialWorkerId 详情）
  const [view, setView] = useState<'list' | 'detail'>(() => (initialWorkerId ? 'detail' : 'list'));
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(() => initialWorkerId ?? null);

  // 手动派发表单与 Watchdog 巡检状态（列表与详情视图共用同一套巡检状态）
  const [showSpawnForm, setShowSpawnForm] = useState(false);
  const [spawnTitle, setSpawnTitle] = useState('');
  const [spawnTask, setSpawnTask] = useState('');
  const [spawnWorktree, setSpawnWorktree] = useState(false);
  const [spawnThreadKey, setSpawnThreadKey] = useState('');
  const [spawning, setSpawning] = useState(false);
  const [watchdogRunning, setWatchdogRunning] = useState(false);
  const [watchdogSummary, setWatchdogSummary] = useState<string | null>(null);

  // 终态折叠分组默认收起
  const [terminalExpanded, setTerminalExpanded] = useState(false);

  // 活跃任务走表计时（每秒推进，无活跃任务不启动定时器）
  const [now, setNow] = useState(() => Date.now());
  const hasActive = workers.some((worker) => isWorkerActive(worker.status));
  useEffect(() => {
    if (!isOpen || !hasActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isOpen, hasActive]);

  // 打开 / 外部指定初始定位：initialWorkerId 非空进详情，否则回列表
  useEffect(() => {
    if (!isOpen) return;
    if (initialWorkerId) {
      setView('detail');
      setSelectedWorkerId(initialWorkerId);
    } else {
      setView('list');
      setSelectedWorkerId(null);
    }
  }, [isOpen, initialWorkerId]);

  // 零 Worker 打开时默认展开派发表单，落地即可填写
  useEffect(() => {
    if (isOpen && workers.length === 0 && onSpawnWorker) setShowSpawnForm(true);
  }, [isOpen, workers.length, onSpawnWorker]);

  // 选中目标已不存在（会话切换 / 列表刷新）：回落列表。
  // 但首次加载中（workers 为空）或刚传入 initialWorkerId 定位时不得回落，
  // 否则点开特定 Worker 详情会被闪回空白列表。
  useEffect(() => {
    if (
      view === 'detail' &&
      selectedWorkerId &&
      workers.length > 0 &&
      !workers.some((w) => w.workerId === selectedWorkerId) &&
      selectedWorkerId !== initialWorkerId
    ) {
      setView('list');
      setSelectedWorkerId(null);
    }
  }, [workers, view, selectedWorkerId, initialWorkerId]);

  // Esc：详情返回列表，列表关闭抽屉
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (view === 'detail') {
        setView('list');
        setSelectedWorkerId(null);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, view, onClose]);

  const handleRunWatchdog = useCallback(async () => {
    if (!onRunWatchdog || watchdogRunning) return;
    setWatchdogRunning(true);
    try {
      const result = await onRunWatchdog();
      setWatchdogSummary(result ? result.summary : '巡检请求失败');
    } finally {
      setWatchdogRunning(false);
    }
  }, [onRunWatchdog, watchdogRunning]);

  const handleSpawn = async () => {
    if (!onSpawnWorker || spawning) return;
    const title = spawnTitle.trim();
    const task = spawnTask.trim();
    const threadKey = spawnThreadKey.trim();
    if (!title || !task) return;
    setSpawning(true);
    try {
      const ok = await onSpawnWorker({ title, task, worktree: spawnWorktree, ...(threadKey ? { threadKey } : {}) });
      if (ok) {
        setSpawnTitle('');
        setSpawnTask('');
        setSpawnWorktree(false);
        setSpawnThreadKey('');
        setShowSpawnForm(false);
      }
    } finally {
      setSpawning(false);
    }
  };

  const enterDetail = (workerId: string) => {
    onSelectWorker(workerId);
    setSelectedWorkerId(workerId);
    setView('detail');
  };

  const backToList = () => {
    setView('list');
    setSelectedWorkerId(null);
  };

  if (!isOpen) return null;

  // 列表分区：失败置顶 → 活跃（按启动时间倒序）→ 终态（completed/aborted 折叠组）
  const failedWorkers = workers
    .filter((worker) => worker.status === 'failed')
    .sort((a, b) => timeDesc(a, b));
  const activeWorkers = workers
    .filter((worker) => isWorkerActive(worker.status))
    .sort((a, b) => timeDesc(a, b, true));
  const terminalWorkers = workers
    .filter((worker) => worker.status === 'completed' || worker.status === 'aborted')
    .sort((a, b) => timeDesc(a, b));

  const doneCount = terminalWorkers.length;
  const failedCount = failedWorkers.length;
  const summaryText =
    activeWorkers.length > 0
      ? `${activeWorkers.length} 运行${failedCount > 0 ? ` · ${failedCount} 失败` : ''}${
          doneCount > 0 ? ` · ${doneCount} 完成` : ''
        }`
      : workers.length === 0
        ? '暂无任务'
        : failedCount > 0
          ? `${failedCount} 失败${doneCount > 0 ? ` · ${doneCount} 完成` : ''}`
          : `${workers.length} 个任务`;

  const stopping = stoppingWorkerIds ?? new Set<string>();
  const detailWorker = selectedWorkerId
    ? (workers.find((worker) => worker.workerId === selectedWorkerId) ?? null)
    : null;

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
        aria-label="后台子任务"
        className="fixed inset-y-0 right-0 z-40 w-[min(40rem,96vw)] bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        {view === 'detail' && detailWorker ? (
          <WorkerDetailView
            worker={detailWorker}
            botMap={botMap}
            nodeMap={nodeMap}
            now={now}
            stopping={stopping.has(detailWorker.workerId)}
            onBack={backToList}
            onClose={onClose}
            onStop={onStopWorker}
            onSteer={onSteer}
            onTriggerWatchdog={onRunWatchdog ? () => void handleRunWatchdog() : undefined}
            watchdogRunning={watchdogRunning}
            watchdogSummary={watchdogSummary}
          />
        ) : (
          <>
            {/* 列表顶栏：标题 + 计数摘要 + 巡检 + 派发 + 关闭 */}
            <div className="flex items-center justify-between gap-2 px-4 h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                  后台子任务
                </h2>
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{summaryText}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {onRunWatchdog && (
                  <button
                    type="button"
                    onClick={() => void handleRunWatchdog()}
                    disabled={watchdogRunning}
                    title="运行 Watchdog 巡检"
                    className="inline-flex items-center gap-1 h-8 px-2 rounded-lg border border-zinc-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-900 hover:border-blue-300 dark:hover:border-blue-700 disabled:opacity-50 text-zinc-600 dark:text-zinc-300 text-xs font-medium transition-colors cursor-pointer"
                  >
                    {watchdogRunning ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                    ) : (
                      <HeartPulse className="w-3.5 h-3.5" />
                    )}
                    <span className="whitespace-nowrap">巡检</span>
                  </button>
                )}
                {onSpawnWorker && (
                  <button
                    type="button"
                    aria-label="派发后台 Worker"
                    onClick={() => setShowSpawnForm((v) => !v)}
                    title="手动派发后台 Worker"
                    className="inline-flex items-center gap-1 h-8 px-2 rounded-lg border border-zinc-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-900 hover:border-blue-300 dark:hover:border-blue-700 text-zinc-600 dark:text-zinc-300 text-xs font-medium transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span className="whitespace-nowrap">派发</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="关闭"
                  title="关闭 (Esc)"
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Watchdog 巡检结果摘要胶囊 */}
            {watchdogSummary && (
              <div className="px-4 py-1.5 border-b border-zinc-100 dark:border-zinc-900 shrink-0">
                <span
                  title={watchdogSummary}
                  className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-full border border-blue-200/60 dark:border-blue-800/60 bg-blue-50 dark:bg-blue-950/50 text-[10px] font-medium text-blue-600 dark:text-blue-300"
                >
                  <HeartPulse className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{watchdogSummary}</span>
                </span>
              </div>
            )}

            {/* 手动派发表单：标题 / 任务指令 / worktree 隔离 / 直通线程键 */}
            {showSpawnForm && (
              <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-900 space-y-1.5 shrink-0">
                <input
                  type="text"
                  value={spawnTitle}
                  onChange={(e) => setSpawnTitle(e.target.value)}
                  placeholder="任务标题（如：修复鉴权模块）"
                  aria-label="任务标题"
                  className="w-full h-8 px-2.5 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 transition-colors"
                />
                <textarea
                  value={spawnTask}
                  onChange={(e) => setSpawnTask(e.target.value)}
                  placeholder="后台任务指令..."
                  aria-label="后台任务指令"
                  rows={2}
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 transition-colors resize-y"
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={spawnWorktree}
                      onChange={(e) => setSpawnWorktree(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 accent-blue-600 cursor-pointer"
                    />
                    Git Worktree 隔离
                  </label>
                  <input
                    type="text"
                    value={spawnThreadKey}
                    onChange={(e) => setSpawnThreadKey(e.target.value)}
                    placeholder="直通线程键（可选，如 github:pr#42）"
                    aria-label="直通线程键"
                    className="flex-1 min-w-[160px] h-8 px-2.5 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 transition-colors"
                  />
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowSpawnForm(false)}
                    className="h-8 px-2.5 rounded-lg text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSpawn()}
                    disabled={spawning || !spawnTitle.trim() || !spawnTask.trim()}
                    className="inline-flex items-center gap-1 h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors cursor-pointer"
                  >
                    {spawning ? <Loader2 className="w-3.5 h-3.5 animate-spin-fast" /> : <Zap className="w-3.5 h-3.5" />}
                    <span>立即派发</span>
                  </button>
                </div>
              </div>
            )}

            {/* 列表主体：失败置顶 → 活跃 → 终态折叠分组 */}
            <div className="flex-1 min-h-0 overflow-y-auto p-2">
              {workers.length === 0 ? (
                <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500 text-center px-4">
                  <Zap className="w-8 h-8" />
                  <p className="text-xs leading-relaxed">
                    暂无后台任务。点击右上角「派发」即可在不打断当前对话的情况下派生后台子任务。
                  </p>
                </div>
              ) : (
                <>
                  {failedWorkers.map((worker) => (
                    <WorkerListRow
                      key={worker.workerId}
                      worker={worker}
                      now={now}
                      stopping={stopping.has(worker.workerId)}
                      onSelect={() => enterDetail(worker.workerId)}
                      onStop={() => onStopWorker(worker.workerId)}
                    />
                  ))}
                  {activeWorkers.map((worker) => (
                    <WorkerListRow
                      key={worker.workerId}
                      worker={worker}
                      now={now}
                      stopping={stopping.has(worker.workerId)}
                      onSelect={() => enterDetail(worker.workerId)}
                      onStop={() => onStopWorker(worker.workerId)}
                    />
                  ))}
                  {terminalWorkers.length > 0 && (
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={() => setTerminalExpanded((v) => !v)}
                        title={`已完成与已中止任务（含中止 ${terminalWorkers.filter((w) => w.status === 'aborted').length} 个）`}
                        className="flex items-center gap-1.5 w-full min-h-10 px-2.5 py-2 rounded-lg text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
                      >
                        <ChevronDown
                          className={`w-3.5 h-3.5 shrink-0 transition-transform ${terminalExpanded ? 'rotate-180' : ''}`}
                        />
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" />
                        <span className="whitespace-nowrap">已完成 · {terminalWorkers.length}</span>
                      </button>
                      {terminalExpanded &&
                        terminalWorkers.map((worker) => (
                          <WorkerListRow
                            key={worker.workerId}
                            worker={worker}
                            now={now}
                            stopping={stopping.has(worker.workerId)}
                            onSelect={() => enterDetail(worker.workerId)}
                            onStop={() => onStopWorker(worker.workerId)}
                          />
                        ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
};
