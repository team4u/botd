import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronRight,
  Brain,
} from 'lucide-react';
import type { TurnBlock } from '@botd/protocol';
import { Markdown } from '../Markdown.js';
import { formatDuration, type TimelineItem } from '../../message-format.js';
import { SingleToolView, ToolGroupView } from './ToolViews.js';

/** 流式生成中的三点呼吸指示（Web 原生动效，替代终端式 "running..." 文案） */
export const TypingDots: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span className={`inline-flex items-center gap-0.5 ${className}`} aria-hidden="true">
    <span
      className="w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce"
      style={{ animationDelay: '0ms' }}
    />
    <span
      className="w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce"
      style={{ animationDelay: '150ms' }}
    />
    <span
      className="w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce"
      style={{ animationDelay: '300ms' }}
    />
  </span>
);

/**
 * 深度思考轨迹（Thinking）：收起态为紫色呼吸胶囊，展开态为柔和卡片
 */
export const ThinkingTrace: React.FC<{ block: Extract<TurnBlock, { type: 'thinking' }> }> = ({ block }) => {
  const isRunning = block.status === 'running';
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const prevStatusRef = useRef(block.status);

  useEffect(() => {
    if (prevStatusRef.current === 'running' && block.status === 'done') {
      setUserOverride(null);
    }
    prevStatusRef.current = block.status;
  }, [block.status]);

  // 低噪声：思考默认收起为单行呼吸胶囊（流式与完成后一致），用户点开后自主控制
  const isExpanded = userOverride === true;

  if (!block.thinking && !isRunning) return null;

  return (
    <div className="my-2 max-w-2xl">
      <button
        type="button"
        onClick={() => setUserOverride(!isExpanded)}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-violet-200/70 dark:border-violet-900/50 bg-violet-50/80 dark:bg-violet-950/30 text-[11px] font-medium text-violet-600 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-colors cursor-pointer"
      >
        <Brain className={`w-3.5 h-3.5 shrink-0 ${isRunning ? 'animate-pulse' : ''}`} />
        <span>
          {isRunning
            ? `深度思考中${block.thinking ? ` · ${block.thinking.length} 字` : ''}`
            : `已深度思考${
                block.durationMs && block.durationMs >= 100
                  ? ` · ${formatDuration(block.durationMs)}`
                  : ''
              }`}
        </span>
        <ChevronRight
          className={`w-3.5 h-3.5 opacity-60 transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {isExpanded && (
        <div className="mt-1.5 rounded-xl border border-zinc-200/60 dark:border-zinc-800/70 bg-zinc-50/80 dark:bg-zinc-900/40 px-3.5 py-2.5 text-zinc-500 dark:text-zinc-400 leading-relaxed prose-botd prose-botd--xs break-words">
          <Markdown>{block.thinking || (isRunning ? '…' : '')}</Markdown>
        </div>
      )}
    </div>
  );
};

/**
 * 已完成消息的连续过程项（thinking / tool_group）折叠条：
 * 默认收起为 1 行摘要，点击展开后带左边框缩进渲染原本的时间线项。
 */
export const CollapsedProcessGroup: React.FC<{ items: TimelineItem[] }> = ({ items }) => {
  const [expanded, setExpanded] = useState(false);

  let thinkingCount = 0;
  let toolCount = 0;
  let errorCount = 0;
  for (const item of items) {
    if (item.kind === 'thinking') {
      thinkingCount++;
    } else if (item.kind === 'tool_group') {
      toolCount += item.tools.length;
      errorCount += item.tools.filter(
        (t) => t.status === 'error' || t.isError === true || t.status === 'cancelled'
      ).length;
    }
  }

  const summaryParts: string[] = [];
  if (thinkingCount > 0) summaryParts.push(`已完成 ${thinkingCount} 步思考`);
  if (toolCount > 0) summaryParts.push(`${toolCount} 次工具调用`);
  const summaryText = summaryParts.join(' · ');

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/50 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer select-none"
      >
        <span>{summaryText}</span>
        {errorCount > 0 && <span className="text-rose-500 dark:text-rose-400">· {errorCount} 项失败</span>}
        <ChevronRight
          className={`w-3.5 h-3.5 opacity-60 transition-transform duration-200 ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {expanded && (
        <div className="mt-1.5 pl-3 border-l-2 border-zinc-200/70 dark:border-zinc-800 space-y-1">
          {items.map((item, idx) => {
            if (item.kind === 'thinking') {
              return <ThinkingTrace key={`thinking-${idx}-${item.index}`} block={item.block} />;
            }
            if (item.kind === 'tool_group') {
              if (item.tools.length === 1) {
                return (
                  <SingleToolView
                    key={`tool-single-${idx}-${item.index}`}
                    tool={item.tools[0]}
                  />
                );
              }
              return (
                <ToolGroupView
                  key={`tool-group-${idx}-${item.index}`}
                  tools={item.tools}
                />
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
};
