import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  CornerDownRight,
  GitBranch,
  Link2,
  Loader2,
  Send,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type { BotConfig, NodeRecord, ToolCallRecord, TurnBlock } from '@botd/protocol';
import { BotAvatarBadge, formatDuration } from './MessageItem';
import {
  formatWorkerElapsed,
  isWorkerActive,
  type SuperAgentWorkerItem,
  type SuperAgentWorkerSteerMode,
} from '../hooks/useSuperAgentWorkers';

/**
 * 后台 Worker / Workflow 检视抽屉（Super-agent 全双工干预台）：
 * 实时观看执行时间线（思考 / 工具调用 / 工作流阶段 / 历次人工指令），
 * 并可在底部随时插话（Steer）、继续（Follow-up）或中止（Abort）正在后台执行的任务。
 */
export interface WorkerInspectDrawerProps {
  isOpen: boolean;
  worker: SuperAgentWorkerItem | null;
  botMap?: Map<string, BotConfig>;
  nodeMap?: Map<string, NodeRecord>;
  onClose: () => void;
  onSteer: (workerId: string, message: string, mode: SuperAgentWorkerSteerMode) => Promise<boolean>;
  onStop: (workerId: string) => void;
  /** 停止请求进行中（按钮转圈禁用） */
  stopping?: boolean;
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

/** 时间线思考块行（可展开完整思考文本） */
const ThinkingRow: React.FC<{ block: Extract<TurnBlock, { type: 'thinking' }> }> = ({ block }) => (
  <div className="flex gap-2">
    <span className="z-10 w-6 h-6 mt-0.5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center shrink-0">
      <Brain className={`w-3 h-3 text-zinc-400 dark:text-zinc-500 ${block.status === 'running' ? 'animate-pulse' : ''}`} />
    </span>
    <div className="flex-1 min-w-0 pb-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">思考</span>
        {typeof block.durationMs === 'number' && (
          <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
            {formatDuration(block.durationMs)}
          </span>
        )}
      </div>
      <ExpandablePreview text={block.thinking} label="思考过程" />
    </div>
  </div>
);

/** 时间线文本块行（Worker 产出的最终回答片段） */
const TextRow: React.FC<{ block: Extract<TurnBlock, { type: 'text' }> }> = ({ block }) => (
  <div className="flex gap-2">
    <span className="z-10 w-6 h-6 mt-0.5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center shrink-0">
      <Zap className="w-3 h-3 text-blue-500 dark:text-blue-400" />
    </span>
    <div className="flex-1 min-w-0 pb-2 text-[13px] text-zinc-800 dark:text-zinc-200 leading-relaxed break-words whitespace-pre-wrap">
      {block.text}
    </div>
  </div>
);

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

export const WorkerInspectDrawer: React.FC<WorkerInspectDrawerProps> = ({
  isOpen,
  worker,
  botMap,
  nodeMap,
  onClose,
  onSteer,
  onStop,
  stopping = false,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const active = worker ? isWorkerActive(worker.status) : false;
  // 后台执行不打断前台：切到抽屉时聚焦输入框，随时插话
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // 新事件到达时自动贴底（用户上翻浏览时不打扰）
  const timelineSignature = useMemo(() => {
    if (!worker) return '';
    return `${worker.blocks?.length ?? 0}:${worker.toolCalls?.length ?? 0}:${worker.steers?.length ?? 0}:${worker.status}`;
  }, [worker]);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [timelineSignature]);

  // 走表计时（活跃时每秒推进）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const handleSend = async (mode: SuperAgentWorkerSteerMode) => {
    const message = inputValue.trim();
    if (!worker || !message || sending) return;
    setSending(true);
    try {
      const ok = await onSteer(worker.workerId, message, mode);
      if (ok) setInputValue('');
    } finally {
      setSending(false);
    }
  };

  if (!isOpen || !worker) return null;

  // 合成时间线：blocks（交错思考/工具/文本）> toolCalls > summary 兜底
  const timelineBlocks = worker.blocks && worker.blocks.length > 0 ? worker.blocks : null;
  const bot = botMap?.get(worker.botId);
  const node = worker.nodeId ? nodeMap?.get(worker.nodeId) : undefined;

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 右侧滑入面板 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`后台任务检视 ${worker.title}`}
        className="fixed inset-y-0 right-0 z-40 w-[min(40rem,96vw)] bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        {/* 顶部：标题 + Bot 人格徽标 + 状态徽标 */}
        <div className="flex items-center justify-between gap-2 px-4 h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <BotAvatarBadge
              botId={worker.botId}
              name={worker.botName || bot?.name}
              color={bot?.color}
              className="!w-7 !h-7 !text-[11px]"
            />
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
          {worker.conversationId && (
            <span
              title={`独立子会话：${worker.conversationId}`}
              className="inline-flex items-center px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono text-zinc-400 dark:text-zinc-500 max-w-[200px] truncate"
            >
              {worker.conversationId}
            </span>
          )}
        </div>

        {/* 实时执行时间线 */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
          {/* 初始任务指令 */}
          <div className="flex gap-2 justify-end mb-3">
            <div className="max-w-[85%] px-2.5 py-1.5 rounded-xl rounded-tr-sm bg-zinc-100 dark:bg-zinc-800">
              <div className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 mb-0.5">初始任务</div>
              <div className="text-xs text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap break-words">
                {worker.summary || worker.title}
              </div>
            </div>
          </div>

          {/* 执行过程：blocks 交错时间线 / toolCalls 列表 / 无数据兜底 */}
          {timelineBlocks ? (
            <div className="relative">
              {timelineBlocks.length > 1 && (
                <span
                  className="absolute left-[11px] top-2 bottom-2 w-px bg-zinc-200 dark:bg-zinc-800"
                  aria-hidden="true"
                />
              )}
              <div className="space-y-1">
                {timelineBlocks.map((block, idx) =>
                  block.type === 'thinking' ? (
                    <ThinkingRow key={`thinking-${idx}`} block={block} />
                  ) : block.type === 'tool' ? (
                    <ToolCallRow
                      key={`tool-${idx}`}
                      tool={{
                        id: block.id,
                        name: block.name,
                        ...(block.args ? { args: block.args } : {}),
                        ...(block.summary ? { summary: block.summary } : {}),
                        status: block.status,
                        ...(block.durationMs !== undefined ? { durationMs: block.durationMs } : {}),
                        ...(block.outputPreview !== undefined ? { outputPreview: block.outputPreview } : {}),
                        ...(block.isError !== undefined ? { isError: block.isError } : {}),
                      }}
                    />
                  ) : (
                    <TextRow key={`text-${idx}`} block={block} />
                  )
                )}
              </div>
            </div>
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

          {/* 历次人工指令（Steer / Follow-up） */}
          {(worker.steers ?? []).length > 0 && (
            <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-900 space-y-2">
              <div className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500">人工干预记录</div>
              {(worker.steers ?? []).map((steer, idx) => (
                <SteerRow key={`steer-${idx}`} message={steer.message} createdAt={steer.createdAt} />
              ))}
            </div>
          )}
        </div>

        {/* 底部全双工指令 composer：运行中 Steer 插话 / 已结束 Follow-up 继续 / Abort 中止 */}
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
      </div>
    </>
  );
};
