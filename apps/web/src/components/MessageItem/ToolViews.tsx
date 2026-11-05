import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, X } from 'lucide-react';
import { BotdUiRenderer } from '../generative-ui/BotdUiRenderer.js';
import {
  formatDuration,
  formatReadLineRange,
  computeToolBreakdown,
  getToolMeta,
  getToolPrimaryArg,
  countEditDiffStats,
  type ToolBlock,
  type ToolMetaEntry,
} from '../../message-format.js';

/** edit 工具的原始 edits 数组归一化（兼容单编辑 oldText/newText 形态） */
function normalizeEditEntries(args?: Record<string, unknown>): Array<{ oldText?: unknown; newText?: unknown }> | undefined {
  if (Array.isArray(args?.edits)) return args.edits as Array<{ oldText?: unknown; newText?: unknown }>;
  if (typeof args?.oldText === 'string' && typeof args?.newText === 'string') {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  return undefined;
}

const DiffStatsBadge: React.FC<{ added: number; removed: number }> = ({ added, removed }) => (
  <span className="inline-flex items-center gap-1 shrink-0 font-mono text-[10px] leading-none tabular-nums">
    <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
    <span className="text-rose-500 dark:text-rose-400">-{removed}</span>
  </span>
);

const LineRangeChip: React.FC<{ range: string }> = ({ range }) => (
  <span className="shrink-0 px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono text-[10px] leading-none text-zinc-400 dark:text-zinc-500">
    {range}
  </span>
);

export const ToolStatusBadge: React.FC<{ tool: ToolBlock }> = ({ tool }) => {
  const isError = tool.status === 'error' || Boolean(tool.isError);
  if (tool.status === 'cancelled') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
        <span>已取消</span>
        {typeof tool.durationMs === 'number' && (
          <span className="font-mono">{formatDuration(tool.durationMs)}</span>
        )}
      </span>
    );
  }
  if (tool.status === 'running') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
        <Loader2 className="w-3 h-3 animate-spin-fast" />
        <span>执行中</span>
      </span>
    );
  }
  if (isError) {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-rose-500 dark:text-rose-400">
        <X className="w-3 h-3" />
        <span>失败</span>
        {typeof tool.durationMs === 'number' && (
          <span className="font-mono font-normal">{formatDuration(tool.durationMs)}</span>
        )}
      </span>
    );
  }
  if (typeof tool.durationMs === 'number') {
    return (
      <span className="shrink-0 font-mono text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums">
        {formatDuration(tool.durationMs)}
      </span>
    );
  }
  return null;
};

export const ToolDetailPanel: React.FC<{ tool: ToolBlock }> = ({ tool }) => {
  const [showFullWrite, setShowFullWrite] = useState(false);

  // tool.view 插槽：工具返回合法 BotdUiSpec 时以富视图为主视图；
  // 仅当同时出错且带输出预览时，在下方补充错误输出
  if (tool.uiSpec) {
    const hasError = Boolean(tool.isError || tool.status === 'error');
    return (
      <div className="space-y-1.5">
        <div className="py-1 font-sans">
          <BotdUiRenderer spec={tool.uiSpec} mode="display" />
        </div>
        {hasError && tool.outputPreview && (
          <pre className="px-2.5 py-2 text-[11px] font-mono whitespace-pre-wrap break-all border rounded-lg max-h-48 overflow-y-auto bg-rose-50/80 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-900/60">
            {tool.outputPreview}
          </pre>
        )}
      </div>
    );
  }

  // 1. Edit tool: unified diff
  if (tool.name === 'edit') {
    const rawEdits = normalizeEditEntries(tool.args) || [];

    return (
      <div className="space-y-1.5 font-mono text-[11px]">
        {rawEdits.length > 0 ? (
          <div className="rounded-lg bg-zinc-100/80 dark:bg-zinc-950/80 p-2 overflow-x-auto space-y-2 border border-zinc-200/60 dark:border-zinc-800/60">
            {rawEdits.map((edit: any, idx: number) => {
              const oldLines = typeof edit.oldText === 'string' ? edit.oldText.split('\n') : [];
              const newLines = typeof edit.newText === 'string' ? edit.newText.split('\n') : [];
              return (
                <div key={idx} className="space-y-0.5">
                  {oldLines.map((line: string, lIdx: number) => (
                    <div
                      key={`old-${lIdx}`}
                      className="bg-rose-500/10 text-rose-700 dark:text-rose-300 px-1.5 py-0.5 rounded whitespace-pre break-all"
                    >
                      - {line}
                    </div>
                  ))}
                  {newLines.map((line: string, lIdx: number) => (
                    <div
                      key={`new-${lIdx}`}
                      className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded whitespace-pre break-all"
                    >
                      + {line}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : null}
        {(rawEdits.length === 0 || tool.isError || tool.status === 'error') && tool.outputPreview && (
          <pre
            className={`px-2.5 py-2 text-[11px] font-mono whitespace-pre-wrap break-all border rounded-lg max-h-64 overflow-y-auto ${
              tool.isError || tool.status === 'error'
                ? 'bg-rose-50/80 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-900/60'
                : 'bg-zinc-100/80 dark:bg-zinc-950/60 text-zinc-600 dark:text-zinc-300 border-zinc-200/60 dark:border-zinc-800/60'
            }`}
          >
            {tool.outputPreview}
          </pre>
        )}
      </div>
    );
  }

  // 2. Bash tool
  if (tool.name === 'bash') {
    const rawCmd = typeof tool.args?.command === 'string' ? tool.args.command.trim() : '';
    const isMultilineOrLong = rawCmd.includes('\n') || rawCmd.length > 80;

    return (
      <div className="space-y-1.5 font-mono text-[11px]">
        {isMultilineOrLong && (
          <pre className="p-2 rounded-lg bg-zinc-100/80 dark:bg-zinc-950/80 text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-all border border-zinc-200/60 dark:border-zinc-800/60 max-h-48 overflow-y-auto">
            $ {rawCmd}
          </pre>
        )}
        {tool.outputPreview ? (
          <pre
            className={`px-2.5 py-2 text-[11px] font-mono whitespace-pre-wrap break-all border rounded-lg max-h-64 overflow-y-auto ${
              tool.isError || tool.status === 'error'
                ? 'bg-rose-50/80 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-900/60'
                : 'bg-zinc-100/80 dark:bg-zinc-950/60 text-zinc-600 dark:text-zinc-300 border-zinc-200/60 dark:border-zinc-800/60'
            }`}
          >
            {tool.outputPreview}
          </pre>
        ) : (
          tool.status !== 'running' && (
            <div className="text-zinc-400 dark:text-zinc-500 italic">(no output)</div>
          )
        )}
      </div>
    );
  }

  // 3. Write tool
  if (tool.name === 'write') {
    const content = typeof tool.args?.content === 'string' ? tool.args.content : undefined;
    const lines = content ? content.split('\n') : [];
    const isTruncated = lines.length > 30 && !showFullWrite;
    const displayedContent = isTruncated ? lines.slice(0, 30).join('\n') : content;

    return (
      <div className="space-y-1.5 font-mono text-[11px]">
        {content !== undefined && (
          <div className="space-y-1">
            <pre className="p-2 rounded-lg bg-zinc-100/80 dark:bg-zinc-950/80 text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-all border border-zinc-200/60 dark:border-zinc-800/60 max-h-64 overflow-y-auto">
              {displayedContent}
            </pre>
            {lines.length > 30 && (
              <button
                type="button"
                onClick={() => setShowFullWrite((v) => !v)}
                className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 underline cursor-pointer"
              >
                {showFullWrite ? '收起' : `展开全部（${lines.length} 行）`}
              </button>
            )}
          </div>
        )}
        {tool.outputPreview && (
          <pre
            className={`px-2.5 py-2 text-[11px] font-mono whitespace-pre-wrap break-all border rounded-lg max-h-48 overflow-y-auto ${
              tool.isError || tool.status === 'error'
                ? 'bg-rose-50/80 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-900/60'
                : 'bg-zinc-100/80 dark:bg-zinc-950/60 text-zinc-600 dark:text-zinc-300 border-zinc-200/60 dark:border-zinc-800/60'
            }`}
          >
            {tool.outputPreview}
          </pre>
        )}
      </div>
    );
  }

  // 4. Generic / Read tools
  const hasArgs = tool.args && Object.keys(tool.args).length > 0;
  return (
    <div className="space-y-1.5 font-mono text-[11px]">
      {hasArgs && (
        <div className="p-2 rounded-lg bg-zinc-100/60 dark:bg-zinc-950/60 text-zinc-500 dark:text-zinc-400 space-y-0.5 border border-zinc-200/50 dark:border-zinc-800/50">
          {Object.entries(tool.args!).map(([k, v]) => (
            <div key={k} className="flex gap-1.5 truncate">
              <span className="font-semibold text-zinc-600 dark:text-zinc-300 shrink-0">{k}:</span>
              <span className="truncate">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      )}
      {tool.outputPreview ? (
        <pre
          className={`px-2.5 py-2 text-[11px] font-mono whitespace-pre-wrap break-all border rounded-lg max-h-64 overflow-y-auto ${
            tool.isError || tool.status === 'error'
              ? 'bg-rose-50/80 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border-rose-200/60 dark:border-rose-900/60'
              : 'bg-zinc-100/80 dark:bg-zinc-950/60 text-zinc-600 dark:text-zinc-300 border-zinc-200/60 dark:border-zinc-800/60'
          }`}
        >
          {tool.outputPreview}
        </pre>
      ) : (
        tool.status !== 'running' && !hasArgs && (
          <div className="text-zinc-400 dark:text-zinc-500 italic">(no output)</div>
        )
      )}
    </div>
  );
};

/**
 * 工具卡片头部内容（单工具卡片与时间轴步骤行共用）：
 * 展开箭头 + 语义图标 + 动词标签 + 主参数 + 增删/行号徽标
 */
const ToolHeaderContent: React.FC<{
  tool: ToolBlock;
  showChevron: boolean;
  showIcon: boolean;
  expanded: boolean;
}> = ({ tool, showChevron, showIcon, expanded }) => {
  const meta = getToolMeta(tool.name);
  const Icon = meta.icon;
  const primary = getToolPrimaryArg(tool);
  const readRange = tool.name === 'read' ? formatReadLineRange(tool.args) : '';
  const editEntries = tool.name === 'edit' ? normalizeEditEntries(tool.args) : undefined;
  const diffStats = editEntries ? countEditDiffStats(editEntries) : null;

  return (
    <>
      {showChevron && (
        <ChevronRight
          className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform duration-200 ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      )}
      {showIcon && (
        <span className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${meta.chip}`}>
          <Icon className="w-3 h-3" />
        </span>
      )}
      <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 shrink-0">{meta.label}</span>
      {primary && (
        <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300 truncate min-w-0">
          {primary}
        </span>
      )}
      {diffStats && (diffStats.added > 0 || diffStats.removed > 0) && (
        <DiffStatsBadge added={diffStats.added} removed={diffStats.removed} />
      )}
      {readRange && <LineRangeChip range={`L${readRange.slice(1)}`} />}
    </>
  );
};

/**
 * Case 1B: 单个工具调用渲染为独立语义卡片
 */
export const SingleToolView: React.FC<{
  tool: ToolBlock;
  initialExpanded?: boolean;
}> = ({ tool, initialExpanded }) => {
  const isError = tool.status === 'error' || Boolean(tool.isError);
  // 低噪声默认收起：仅错误与声明式 UI 规格工具默认展开；
  // edit 卡也改为默认收起（摘要行已含 ±行数），点击再看完整红绿 Diff
  const [expanded, setExpanded] = useState<boolean>(
    () => Boolean(initialExpanded || tool.uiSpec || isError)
  );

  useEffect(() => {
    if (isError) {
      setExpanded(true);
    }
  }, [isError]);

  return (
    <div className="my-1.5 max-w-2xl">
      <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 overflow-hidden shadow-xs">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-1.5 pl-2 pr-2.5 h-9 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer"
        >
          <ToolHeaderContent tool={tool} showChevron showIcon expanded={expanded} />
          <span className="ml-auto flex items-center gap-2 shrink-0 pl-2">
            <ToolStatusBadge tool={tool} />
          </span>
        </button>
        {expanded && (
          <div className="border-t border-zinc-100 dark:border-zinc-800/70 px-2.5 py-2 bg-zinc-50/60 dark:bg-zinc-950/40">
            <ToolDetailPanel tool={tool} />
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Case 2B: 连续工具聚合为时间轴步骤卡（收起态显示摘要，展开态为带竖向导轨的步骤流）
 */
export const ToolGroupView: React.FC<{
  tools: ToolBlock[];
  initialExpanded?: boolean;
}> = ({ tools, initialExpanded }) => {
  const hasError = tools.some((t) => t.status === 'error' || t.isError);
  const isRunning = tools.some((t) => t.status === 'running');
  const hasCancelled = tools.some((t) => t.status === 'cancelled');
  const totalMs = tools.reduce((sum, t) => sum + (t.durationMs || 0), 0);
  const errorCount = tools.filter((t) => t.status === 'error' || t.isError).length;

  const [groupExpanded, setGroupExpanded] = useState<boolean>(initialExpanded ?? hasError);
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    tools.forEach((t, i) => {
      if (t.status === 'error' || t.isError) initial.add(i);
    });
    // 含 edit 工具时也不再默认展开（摘要行的 ±行数徽标已足够低噪声），需要时点击展开
    for (let i = tools.length - 1; i >= 0; i--) {
      const t = tools[i];
      if (
        t.name === 'edit' &&
        (t.status === 'running' || t.status === 'done') &&
        !tools.slice(i + 1).some((later) => later.name === 'edit')
      ) {
        initial.delete(i);
        break;
      }
    }
    return initial;
  });

  useEffect(() => {
    if (hasError) {
      setGroupExpanded(true);
      setExpandedIndices((prev) => {
        const next = new Set(prev);
        tools.forEach((t, i) => {
          if (t.status === 'error' || t.isError) next.add(i);
        });
        return next;
      });
    }
  }, [hasError]);

  // 低噪声流式：运行中的组自动收起为单行摘要（错误仍强制展开），
  // 用户手动展开后不再被自动收回，长 bash 输出不再刷屏移动端视口
  const [userPinnedExpanded, setUserPinnedExpanded] = useState(false);
  useEffect(() => {
    if (userPinnedExpanded) return;
    setGroupExpanded(isRunning ? false : hasError);
  }, [isRunning, hasError, userPinnedExpanded]);

  const toggleGroup = () => {
    setUserPinnedExpanded(true);
    setGroupExpanded((v) => !v);
  };

  const toggleTool = (idx: number) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // 摘要行的去重工具类型图标（最多 3 个，一眼看出这组操作的性质）
  const metaIcons: ToolMetaEntry[] = [];
  const seenLabels = new Set<string>();
  for (const t of tools) {
    const m = getToolMeta(t.name);
    if (!seenLabels.has(m.label)) {
      seenLabels.add(m.label);
      metaIcons.push(m);
    }
  }

  const summaryText = isRunning ? `正在执行 ${tools.length} 项操作` : `已执行 ${tools.length} 项操作`;
  const breakdown = computeToolBreakdown(tools);

  // 汇总本组 edit 工具的增删行数：折叠态也能一眼看到这组操作改了多少行代码
  const groupEditStats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const t of tools) {
      if (t.name !== 'edit') continue;
      const entries = normalizeEditEntries(t.args);
      if (!entries) continue;
      const stats = countEditDiffStats(entries);
      added += stats.added;
      removed += stats.removed;
    }
    return added > 0 || removed > 0 ? { added, removed } : null;
  }, [tools]);

  return (
    <div className="my-2 max-w-2xl">
      <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 overflow-hidden shadow-xs">
        <button
          type="button"
          onClick={toggleGroup}
          className="w-full flex items-center gap-2 px-2.5 h-9 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer"
        >
          <ChevronRight
            className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform duration-200 ${
              groupExpanded ? 'rotate-90' : ''
            }`}
          />
          <span className="flex items-center gap-0.5 shrink-0">
            {metaIcons.slice(0, 3).map((m) => {
              const I = m.icon;
              return <I key={m.label} className={`w-3 h-3 ${m.tint}`} />;
            })}
          </span>
          <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300 shrink-0">
            {summaryText}
          </span>
          {totalMs > 0 && (
            <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums shrink-0">
              {formatDuration(totalMs)}
            </span>
          )}
          <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate hidden sm:inline">
            {breakdown}
          </span>
          {groupEditStats && <DiffStatsBadge added={groupEditStats.added} removed={groupEditStats.removed} />}
          {errorCount > 0 && (
            <span className="text-[11px] font-medium text-rose-500 dark:text-rose-400 shrink-0">
              · {errorCount} 项失败
            </span>
          )}
          {hasCancelled && !isRunning && (
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">· 已取消</span>
          )}
          <span className="ml-auto flex items-center gap-2 shrink-0">
            {isRunning && <Loader2 className="w-3 h-3 text-zinc-400 animate-spin-fast" />}
          </span>
        </button>

        {groupExpanded && (
          <div className="border-t border-zinc-100 dark:border-zinc-800/70 px-2.5 py-2.5 bg-zinc-50/60 dark:bg-zinc-950/40">
            <div className="relative">
              {tools.length > 1 && (
                <span
                  className="absolute left-[13px] top-2 bottom-2 w-px bg-zinc-200 dark:bg-zinc-800"
                  aria-hidden="true"
                />
              )}
              <div className="space-y-1">
                {tools.map((tool, idx) => {
                  const isOpen = expandedIndices.has(idx);
                  const meta = getToolMeta(tool.name);
                  const StepIcon = meta.icon;
                  return (
                    <div key={tool.id || `${tool.name}-${idx}`} className="relative flex gap-2">
                      <span className="z-10 w-6 h-6 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center shrink-0">
                        <StepIcon className={`w-3 h-3 ${meta.tint}`} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <button
                          type="button"
                          onClick={() => toggleTool(idx)}
                          className="w-full flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity cursor-pointer"
                        >
                          <ToolHeaderContent tool={tool} showChevron showIcon={false} expanded={isOpen} />
                          <span className="ml-auto flex items-center gap-2 shrink-0 pl-2">
                            <ToolStatusBadge tool={tool} />
                          </span>
                        </button>
                        {isOpen && (
                          <div className="mt-1 mb-1 pl-5">
                            <ToolDetailPanel tool={tool} />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
