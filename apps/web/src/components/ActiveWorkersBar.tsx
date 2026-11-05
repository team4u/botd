import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  GitBranch,
  HeartPulse,
  Link2,
  Loader2,
  Plus,
  Zap,
  X,
} from 'lucide-react';
import {
  formatWorkerElapsed,
  isWorkerActive,
  type SuperAgentWorkerItem,
} from '../hooks/useSuperAgentWorkers';

/**
 * 全双工常驻胶囊条：置于 ChatView 顶部，当前会话的 Bot 人格有后台 Worker / Workflow
 * 运行（或近期完成）时展示。移动端为单行横向滚动条（不换行、不折叠成多行高楼），
 * 点击胶囊打开 WorkerInspectDrawer 检视；胶囊右侧 × 快速停止该后台任务，
 * 完全不打断前台对话。右端固定「派发任务」与「Watchdog 巡检」入口。
 */
export interface ActiveWorkersBarProps {
  workers: SuperAgentWorkerItem[];
  /** 正在停止中的 workerId 集合（按钮转圈禁用） */
  stoppingWorkerIds?: ReadonlySet<string>;
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
  /** 零 Worker 手动展开态的关闭回调（有 Worker 运行时不展示关闭钮） */
  onClose?: () => void;
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
      className="group inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-700/80 hover:border-blue-300 dark:hover:border-blue-700 shadow-xs transition-colors cursor-pointer shrink-0"
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

      <span className="text-[11px] font-medium text-zinc-800 dark:text-zinc-200 truncate max-w-[130px] sm:max-w-[180px]">
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

      {/* 订阅线程键（Pass-through 直通）徽标：全部线程键均展示，超出胶囊宽度折叠为 +N */}
      {(worker.threadKeys ?? []).slice(0, 1).map((key) => (
        <span
          key={key}
          title={`Pass-through 直通订阅：${(worker.threadKeys ?? []).join('、')}`}
          className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 dark:border-blue-800/60 text-[10px] font-medium text-blue-600 dark:text-blue-300 max-w-[140px] shrink-0"
        >
          <Link2 className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate font-mono">{key}</span>
        </span>
      ))}
      {(worker.threadKeys ?? []).length > 1 && (
        <span
          title={`其余 Pass-through 直通订阅：${(worker.threadKeys ?? []).slice(1).join('、')}`}
          className="inline-flex items-center px-1 py-px rounded bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 dark:border-blue-800/60 text-[10px] font-medium text-blue-600 dark:text-blue-300 shrink-0"
        >
          <Link2 className="w-2.5 h-2.5 shrink-0" />
          +{(worker.threadKeys ?? []).length - 1}
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
  onSpawnWorker,
  onRunWatchdog,
  onClose,
}) => {
  // 活跃任务走表计时（每秒推进，无活跃任务不启动定时器）
  const [now, setNow] = useState(() => Date.now());
  // 手动派发表单与 Watchdog 巡检状态
  const [showSpawnForm, setShowSpawnForm] = useState(false);
  const [spawnTitle, setSpawnTitle] = useState('');
  const [spawnTask, setSpawnTask] = useState('');
  const [spawnWorktree, setSpawnWorktree] = useState(false);
  const [spawnThreadKey, setSpawnThreadKey] = useState('');
  const [spawning, setSpawning] = useState(false);
  const [watchdogRunning, setWatchdogRunning] = useState(false);
  const [watchdogSummary, setWatchdogSummary] = useState<string | null>(null);
  const hasActive = workers.some((worker) => isWorkerActive(worker.status));

  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  // 零 Worker 挂载（用户从「更多操作」按需展开）：默认展开派发表单，落地即可填写
  useEffect(() => {
    if (workers.length === 0 && onSpawnWorker) setShowSpawnForm(true);
  }, [workers.length, onSpawnWorker]);

  const handleRunWatchdog = async () => {
    if (!onRunWatchdog || watchdogRunning) return;
    setWatchdogRunning(true);
    try {
      const result = await onRunWatchdog();
      setWatchdogSummary(result ? result.summary : '巡检请求失败');
    } finally {
      setWatchdogRunning(false);
    }
  };

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

  if (workers.length === 0 && !onSpawnWorker && !onRunWatchdog && !showSpawnForm) return null;

  const activeWorkers = workers.filter((worker) => isWorkerActive(worker.status));
  const completedCount = workers.length - activeWorkers.length;
  const stopping = stoppingWorkerIds ?? new Set<string>();

  return (
    <div className="px-3 sm:px-4 pt-2.5 max-w-4xl w-full mx-auto shrink-0">
      <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/50 shadow-xs">
        {/* 单行主栏：胶囊列表横向滚动（移动端不换行）。派发/巡检等低频管理操作已收进顶栏「···」菜单，不再常驻占宽 */}
        <div className="flex items-center gap-1 py-1 px-1.5">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1.5 px-1 min-w-0 flex-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {/* 状态摘要：运行中 / 已完成（移动端极简为图标+数字，不挤占胶囊宽度） */}
            <span
              title={
                hasActive
                  ? `${activeWorkers.length} 个后台任务运行中`
                  : workers.length === 0
                    ? '后台任务'
                    : `${completedCount} 个后台任务已完成`
              }
              className={`inline-flex items-center gap-1 text-[11px] font-medium shrink-0 select-none ${
                hasActive
                  ? 'text-blue-700 dark:text-blue-300'
                  : workers.length === 0
                    ? 'text-zinc-500 dark:text-zinc-400'
                    : 'text-emerald-700 dark:text-emerald-300'
              }`}
            >
              {hasActive ? (
                <>
                  <Zap className="w-3.5 h-3.5 shrink-0" />
                  <span className="whitespace-nowrap hidden sm:inline">{activeWorkers.length} 个后台任务运行中</span>
                  <span className="sm:hidden font-mono">{activeWorkers.length}</span>
                </>
              ) : workers.length === 0 ? (
                <>
                  <Zap className="w-3.5 h-3.5 shrink-0" />
                  <span className="whitespace-nowrap hidden sm:inline">后台任务</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span className="whitespace-nowrap hidden sm:inline">{completedCount} 个后台任务已完成</span>
                  <span className="sm:hidden font-mono">{completedCount}</span>
                </>
              )}
            </span>

            {/* 胶囊列表：横向滚动，点击检视 / × 快速停止 */}
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

          {/* 右端：零 Worker 手动展开态才有按钮（派发 + 收起）；有任务时整行全给胶囊，手机端不再被常驻按钮挤压 */}
          {workers.length === 0 && (
            <div className="flex items-center gap-1 shrink-0">
              {onRunWatchdog && (
                <button
                  type="button"
                  onClick={() => void handleRunWatchdog()}
                  disabled={watchdogRunning}
                  title="运行 Watchdog 巡检"
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-zinc-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-900 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:border-blue-300 dark:hover:border-blue-700 disabled:opacity-50 transition-colors cursor-pointer shrink-0"
                >
                  {watchdogRunning ? (
                    <Loader2 className="w-3 h-3 animate-spin-fast" />
                  ) : (
                    <HeartPulse className="w-3 h-3" />
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
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-zinc-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-900 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:border-blue-300 dark:hover:border-blue-700 transition-colors cursor-pointer shrink-0"
                >
                  <Plus className="w-3 h-3" />
                  <span className="whitespace-nowrap">派发任务</span>
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  aria-label="收起后台任务控制台"
                  title="收起后台任务控制台"
                  onClick={onClose}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Watchdog 巡检结果摘要胶囊 */}
        {watchdogSummary && (
          <div className="px-2.5 pb-1.5">
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
          <div className="px-3 pb-2.5 pt-1 space-y-1.5 border-t border-zinc-200/70 dark:border-zinc-800/70">
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
      </div>
    </div>
  );
};
