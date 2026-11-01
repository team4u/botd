import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Loader2,
  SquareTerminal,
  ChevronDown,
  ChevronRight,
  Ban,
  RefreshCw,
} from 'lucide-react';
import type { BgJobRecord, BotConfig, NodeRecord } from '@botd/protocol';
import { api } from '../api';
import { ConfirmDialog } from './ConfirmDialog';

/** 会话成员 bots 去重出 nodeId 集合 */
function memberNodeIds(sessionMemberBotIds: string[], botMap: Map<string, BotConfig>): string[] {
  const ids = new Set<string>();
  for (const botId of sessionMemberBotIds) {
    const bot = botMap.get(botId);
    if (bot?.nodeId) ids.add(bot.nodeId);
  }
  return [...ids];
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 7 天退化为本地日期 */
function formatRelativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(time).toLocaleDateString();
}

/** 耗时格式化：ms / s / m s / h m s */
function formatJobDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

/** 单条后台任务的状态徽标样式与文案 */
function jobStatusBadge(status: BgJobRecord['status']): { label: string; className: string } {
  switch (status) {
    case 'running':
      return {
        label: '运行中',
        className: 'bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 border-blue-200/60 dark:border-blue-900/60 animate-pulse',
      };
    case 'done':
      return {
        label: '已完成',
        className: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-200/60 dark:border-emerald-900/60',
      };
    case 'failed':
      return {
        label: '失败',
        className: 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border-rose-200/60 dark:border-rose-900/60',
      };
    default:
      return {
        label: '已终止',
        className: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-200/60 dark:border-zinc-700/60',
      };
  }
}

/** 单条后台任务行：点击展开/收起日志，运行中行尾提供终止按钮 */
const BgJobRow: React.FC<{
  job: BgJobRecord;
  nodeId: string;
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  defaultExpanded?: boolean;
  onKilled: () => void;
  onToast?: (type: 'success' | 'error' | 'info', message: string) => void;
}> = ({ job, nodeId, botMap, nodeMap, defaultExpanded = false, onKilled, onToast }) => {
  const [expanded, setExpanded] = useState(defaultExpanded || job.status === 'failed');
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [defaultExpanded]);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [killing, setKilling] = useState(false);

  const bot = job.botId ? botMap.get(job.botId) : undefined;
  const node = nodeMap.get(nodeId);
  const badge = jobStatusBadge(job.status);
  const startedAtMs = new Date(job.startedAt).getTime();
  const endMs = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  const durationMs = Number.isNaN(startedAtMs) ? 0 : Math.max(0, endMs - startedAtMs);

  // 展开时懒加载日志（已加载不重发；轮询刷新后重置缓存下次展开重拉）
  useEffect(() => {
    if (!expanded || logs !== null || logsLoading) return;
    let cancelled = false;
    setLogsLoading(true);
    setLogsError(null);
    api
      .getBgJobLogs(nodeId, job.id, 200)
      .then((result) => {
        if (cancelled) return;
        setLogs(result.logs || '（暂无日志输出）');
        setLogsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLogsError(message || '日志加载失败');
        setLogsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, nodeId, job.id, job.status, job.finishedAt]);

  // 终止任务：确认后调用 killBgJob 并刷新列表
  const handleKill = async () => {
    if (killing) return;
    setKilling(true);
    try {
      await api.killBgJob(nodeId, job.id);
      setKillConfirmOpen(false);
      onToast?.('success', '已发送终止信号');
      onKilled();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onToast?.('error', message ? `终止失败：${message}` : '终止失败');
    } finally {
      setKilling(false);
    }
  };

  return (
    <div ref={rowRef} className="rounded-lg border border-zinc-200/80 dark:border-zinc-800/80 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
        )}
        <span
          className={`inline-flex items-center shrink-0 text-[10px] font-medium rounded-full px-1.5 py-0.5 border ${badge.className}`}
        >
          {badge.label}
        </span>
        <span
          className="flex-1 min-w-0 font-mono text-[11px] text-zinc-700 dark:text-zinc-300 truncate"
          title={job.command}
        >
          {job.command}
        </span>
        {job.status === 'running' && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              setKillConfirmOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                setKillConfirmOpen(true);
              }
            }}
            className="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-md text-xs text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
            title="终止该后台任务"
          >
            <Ban className="w-3 h-3" />
            <span>终止</span>
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 flex-wrap">
            <span className="truncate max-w-[120px]">{bot?.name || `@${job.botId}`}</span>
            {node && (
              <>
                <span className="text-zinc-300 dark:text-zinc-600">@</span>
                <span className="truncate max-w-[120px]">{node.name}</span>
              </>
            )}
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            <span title={job.startedAt}>{formatRelativeTime(job.startedAt)}开始</span>
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            <span className="font-mono">
              {job.status === 'running' ? '已运行' : '耗时'} {formatJobDuration(durationMs)}
            </span>
            {job.status !== 'running' && typeof job.exitCode === 'number' && (
              <>
                <span className="text-zinc-300 dark:text-zinc-600">·</span>
                <span className={`font-mono ${job.exitCode === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                  exit {job.exitCode}
                </span>
              </>
            )}
          </div>
          {logsLoading ? (
            <div className="flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 py-3">
              <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
              <span>正在加载日志...</span>
            </div>
          ) : logsError ? (
            <div className="text-[11px] text-rose-500 dark:text-rose-400 py-2">{logsError}</div>
          ) : logs !== null ? (
            <pre className="max-h-64 overflow-auto text-[11px] font-mono leading-relaxed bg-zinc-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 rounded-lg p-2.5 whitespace-pre-wrap break-all">
              {logs}
            </pre>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        isOpen={killConfirmOpen}
        title="终止后台任务"
        message="确定终止后台任务？正在执行的进程会被 kill。"
        confirmText="终止"
        danger
        busy={killing}
        onConfirm={() => void handleKill()}
        onClose={() => {
          if (!killing) setKillConfirmOpen(false);
        }}
      />
    </div>
  );
};

interface BgJobsDrawerProps {
  isOpen: boolean;
  sessionId: string;
  memberBotIds: string[];
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  initialJobId?: string | null;
  onClose: () => void;
  onToast?: (type: 'success' | 'error' | 'info', message: string) => void;
}

/**
 * 后台任务抽屉：右侧滑入面板，聚合展示会话成员所在全部节点的 bg 任务。
 * 打开时按节点聚合查询；存在 running 任务时每 5s 轮询；节点离线按节点降级提示。
 */
export const BgJobsDrawer: React.FC<BgJobsDrawerProps> = ({
  isOpen,
  sessionId,
  memberBotIds,
  botMap,
  nodeMap,
  initialJobId,
  onClose,
  onToast,
}) => {
  const [jobs, setJobs] = useState<BgJobRecord[]>([]);
  const [failedNodes, setFailedNodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // 聚合查询：成员 bots 去重 nodeId → 逐节点 listBgJobs(sessionId 过滤) → 合并按 startedAt 倒序
  const refresh = useCallback(async () => {
    const nodeIds = memberNodeIds(memberBotIds, botMap);
    if (nodeIds.length === 0) {
      setJobs([]);
      setFailedNodes([]);
      return;
    }
    setLoading(true);
    const results = await Promise.allSettled(
      nodeIds.map((id) => api.listBgJobs(id, { sessionId }))
    );
    const collected: BgJobRecord[] = [];
    const offline: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        collected.push(...r.value);
      } else {
        offline.push(nodeIds[i]);
      }
    });
    collected.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    setJobs(collected);
    setFailedNodes(offline);
    setLoading(false);
  }, [memberBotIds, botMap, sessionId]);

  // 切换会话时清缓存
  useEffect(() => {
    setJobs([]);
    setFailedNodes([]);
  }, [sessionId]);

  // 用 ref 持有最新 refresh，避免 fetch effect 依赖 refresh 导致的重复请求/循环
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // 打开时立即拉取；存在 running 任务时每 5s 轮询（关闭即清理）
  const hasRunning = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!isOpen) return;
    void refreshRef.current();
  }, [isOpen, sessionId]);

  useEffect(() => {
    if (!isOpen || !hasRunning) return;
    const timer = window.setInterval(() => {
      void refreshRef.current();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [isOpen, hasRunning]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

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
        aria-label="后台任务"
        className="fixed inset-y-0 right-0 z-40 w-[min(24rem,90vw)] bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        <div className="flex items-center justify-between gap-2 px-4 h-13 sm:h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <h2 className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            后台任务
          </h2>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="刷新"
            title="刷新任务列表"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin-fast' : ''}`} />
          </button>
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

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
          {/* 节点降级提示：查询失败的节点单列展示 */}
          {failedNodes.map((nodeId) => {
            const node = nodeMap.get(nodeId);
            return (
              <div
                key={`offline-${nodeId}`}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-dashed border-zinc-300/80 dark:border-zinc-700/80 text-[11px] text-zinc-400 dark:text-zinc-500"
              >
                <SquareTerminal className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  {node?.name || nodeId}：节点离线，无法查询
                </span>
              </div>
            );
          })}

          {loading && jobs.length === 0 && failedNodes.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin-fast text-blue-600 dark:text-blue-400" />
              <p className="text-xs">正在加载后台任务...</p>
            </div>
          ) : jobs.length === 0 && failedNodes.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500 text-center px-4">
              <SquareTerminal className="w-8 h-8" />
              <p className="text-xs leading-relaxed">
                本会话暂无后台任务。智能体通过 bg 命令启动的后台进程会出现在这里。
              </p>
            </div>
          ) : (
            jobs.map((job) => {
              const bot = job.botId ? botMap.get(job.botId) : undefined;
              const nodeId = bot?.nodeId || '';
              return (
                <BgJobRow
                  key={job.id}
                  job={job}
                  nodeId={nodeId}
                  botMap={botMap}
                  nodeMap={nodeMap}
                  defaultExpanded={Boolean(initialJobId && initialJobId === job.id)}
                  onKilled={() => void refresh()}
                  onToast={onToast}
                />
              );
            })
          )}
        </div>
      </div>
    </>
  );
};
