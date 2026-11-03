import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  FileDiff,
  GitBranch,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  MessageSquarePlus,
  FileCode2,
} from 'lucide-react';
import type { BotConfig, MessageRecord, WorkspaceDiffFile, WorkspaceDiffResult } from '@botd/protocol';
import { api } from '../api';

interface WorkspaceDiffDrawerProps {
  isOpen: boolean;
  sessionId: string;
  bot?: BotConfig;
  messages?: MessageRecord[];
  onClose: () => void;
  onQuoteFile?: (filePath: string) => void;
}

/** 状态徽标样式：M 修改 / A 新增 / D 删除 / R 重命名 / U 冲突 */
const statusBadgeClass: Record<WorkspaceDiffFile['status'], string> = {
  M: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200/70 dark:border-amber-900/60',
  A: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200/70 dark:border-emerald-900/60',
  D: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-200/70 dark:border-rose-900/60',
  R: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 border-blue-200/70 dark:border-blue-900/60',
  U: 'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400 border-purple-200/70 dark:border-purple-900/60',
};

/** 单行 diff 的着色 */
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-zinc-400 dark:text-zinc-500';
  if (line.startsWith('@@')) return 'text-blue-600 dark:text-indigo-400';
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (line.startsWith('-')) return 'bg-rose-500/10 text-rose-700 dark:text-rose-300';
  return 'text-zinc-600 dark:text-zinc-400';
}

/** 非 Git 工作区回退：从消息 toolCalls（edit/write）派生本会话触碰的文件清单 */
export function deriveSessionTouchedFiles(messages: MessageRecord[]): WorkspaceDiffFile[] {
  const byPath = new Map<string, WorkspaceDiffFile>();
  for (const message of messages) {
    for (const call of message.toolCalls || []) {
      if (call.name !== 'edit' && call.name !== 'write') continue;
      const filePath = typeof call.args?.path === 'string' ? call.args.path : call.summary;
      if (!filePath) continue;
      const existing = byPath.get(filePath);
      byPath.set(filePath, {
        path: filePath,
        status: 'M',
        additions: (existing?.additions ?? 0) + 1,
        deletions: existing?.deletions ?? 0,
        diff:
          (existing?.diff ? `${existing.diff}\n` : '') +
          `${call.name} ${filePath}${call.outputPreview ? `\n${call.outputPreview}` : ''}`,
      });
    }
  }
  return [...byPath.values()];
}

/** 单个文件折叠卡片：头部状态徽标 + 增删统计 + 引用按钮，主体为着色 diff */
const DiffFileCard: React.FC<{
  file: WorkspaceDiffFile;
  defaultExpanded: boolean;
  onQuoteFile?: (filePath: string) => void;
  onCloseDrawer: () => void;
}> = ({ file, defaultExpanded, onQuoteFile, onCloseDrawer }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const badge = statusBadgeClass[file.status] ?? statusBadgeClass.M;

  const quote = (e: React.MouseEvent) => {
    e.stopPropagation();
    onQuoteFile?.(file.path);
    if (window.innerWidth < 768) onCloseDrawer();
  };

  return (
    <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/60 transition-colors cursor-pointer"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        )}
        <span
          className={`shrink-0 w-5 h-5 rounded-md border text-[10px] font-bold flex items-center justify-center ${badge}`}
        >
          {file.status}
        </span>
        <span className="flex-1 min-w-0 font-mono text-xs text-zinc-800 dark:text-zinc-200 truncate" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
          +{file.additions}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-rose-500 dark:text-rose-400">
          -{file.deletions}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={quote}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onQuoteFile?.(file.path);
              if (window.innerWidth < 768) onCloseDrawer();
            }
          }}
          title="引用文件路径到输入框"
          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer"
        >
          <MessageSquarePlus className="w-3.5 h-3.5" />
          引用
        </span>
      </button>

      {expanded && (
        <div className="border-t border-zinc-100 dark:border-zinc-800/80 max-h-80 overflow-auto bg-zinc-50/50 dark:bg-zinc-900/40">
          {file.diff ? (
            <pre className="font-mono text-[11px] leading-relaxed p-2 whitespace-pre-wrap break-all select-text">
              {file.diff.split('\n').map((line, idx) => (
                <div key={idx} className={`px-1.5 py-0.5 ${diffLineClass(line)}`}>
                  {line || '\u00A0'}
                </div>
              ))}
            </pre>
          ) : (
            <div className="px-3 py-4 text-xs text-zinc-400 dark:text-zinc-500">（无变更内容）</div>
          )}
          {file.truncated && (
            <div className="px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 border-t border-zinc-100 dark:border-zinc-800/80">
              diff 过长已截断，完整内容请在工作区查看
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * 代码变更抽屉：右侧滑入面板，展示 BOT 工作区的 Git 净变更。
 * 点击文件卡片上的「引用」把路径插入聊天输入框，便于下达后续指令。
 */
export const WorkspaceDiffDrawer: React.FC<WorkspaceDiffDrawerProps> = ({
  isOpen,
  sessionId,
  bot,
  messages = [],
  onClose,
  onQuoteFile,
}) => {
  const [result, setResult] = useState<WorkspaceDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  // 打开或点击刷新时拉取；切换会话/BOT 时清空缓存避免串会话闪现
  useEffect(() => {
    if (!isOpen || !bot) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getWorkspaceDiff(bot.nodeId, bot.id, sessionId)
      .then((res) => {
        if (cancelled) return;
        setResult(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message || '加载代码变更失败');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId, bot?.id, reloadSeq]);

  useEffect(() => {
    setResult(null);
    setLoadError(null);
  }, [sessionId, bot?.id]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // 非 Git 工作区回退：用会话内 edit/write 工具调用合成变更清单
  const files = useMemo(() => {
    if (result && result.isGitRepo) return result.files;
    if (result && !result.isGitRepo && result.files.length === 0) {
      return deriveSessionTouchedFiles(messages);
    }
    return result?.files ?? [];
  }, [result, messages]);

  if (!isOpen) return null;

  const isGit = Boolean(result?.isGitRepo);
  const totalAdditions = isGit ? result?.totalAdditions ?? 0 : files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = isGit ? result?.totalDeletions ?? 0 : files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="代码变更"
        className="fixed inset-y-0 right-0 z-40 w-full max-w-2xl bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        <div className="flex items-center justify-between gap-2 px-4 h-13 sm:h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileDiff className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <h2 className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">代码变更</h2>
            {isGit && result?.branch && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[11px] text-zinc-600 dark:text-zinc-300 shrink-0">
                <GitBranch className="w-3 h-3" />
                <span className="font-mono truncate max-w-32">{result.branch}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setReloadSeq((v) => v + 1)}
              aria-label="刷新"
              title="刷新代码变更"
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
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
        </div>

        {/* 摘要：文件数 + 增删行数；非 Git 工作区给出提示徽标 */}
        <div className="px-4 py-2 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400 shrink-0">
          <span>{files.length} 个文件</span>
          <span className="font-mono text-emerald-600 dark:text-emerald-400">+{totalAdditions}</span>
          <span className="font-mono text-rose-500 dark:text-rose-400">-{totalDeletions}</span>
          {result && !result.isGitRepo && (
            <span className="px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 text-[11px]">
              非 Git 工作区 · 会话触碰文件
            </span>
          )}
          {result?.truncated && (
            <span className="px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 text-[11px]">
              变更文件过多已截断
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin-fast text-blue-600 dark:text-blue-400" />
              <p className="text-xs">正在读取工作区变更...</p>
            </div>
          ) : loadError ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500 text-center px-4">
              <FileDiff className="w-6 h-6" />
              <p className="text-xs text-rose-500 dark:text-rose-400">{loadError}</p>
            </div>
          ) : files.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500 text-center px-4">
              <FileCode2 className="w-8 h-8" />
              <p className="text-xs leading-relaxed">工作区暂无变更。智能体修改文件后，这里会展示 diff。</p>
            </div>
          ) : (
            files.map((file, index) => (
              <DiffFileCard
                key={`${file.path}-${index}`}
                file={file}
                defaultExpanded={index < 5}
                onQuoteFile={onQuoteFile}
                onCloseDrawer={onClose}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
};
