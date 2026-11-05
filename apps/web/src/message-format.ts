/**
 * 消息展示格式化域（纯函数与展示常量，无 React 组件）：
 * 从 MessageItem 组件中拆出以保持 Fast Refresh 兼容（组件文件只导出组件）。
 */
import type { ComponentType } from 'react';
import { FileSearch, FileDiff, FilePen, Terminal, Search, Wrench } from 'lucide-react';
import type { TurnBlock } from '@botd/protocol';

/** 单个工具块类型别名 */
export type ToolBlock = Extract<TurnBlock, { type: 'tool' }>;

export type ToolIcon = ComponentType<{ className?: string }>;

export interface ToolMetaEntry {
  icon: ToolIcon;
  label: string;
  /** 小色块底 + 文字色（用于 20px 图标方块） */
  chip: string;
  /** 纯文字色（用于时间轴节点图标） */
  tint: string;
}

/**
 * 辅助函数：提取模型简称，截取斜杠后的核心模型标识
 * 如 "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4-20250514"
 */
export function formatShortModel(model?: string): string {
  if (!model) return '';
  const parts = model.split('/');
  return parts[parts.length - 1] || model;
}

/** 判断两个 ISO 时间是否落在同一自然日 */
export function isSameCalendarDay(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 聊天流日期分隔标签：今天 / 昨天 / M月D日（跨年带年份） */
export function formatChatDayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameCalendarDay(iso, now.toISOString())) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(iso, yesterday.toISOString())) return '昨天';
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 辅助函数：格式化工具调用耗时，<1s 以毫秒展示，否则保留一位小数秒
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 辅助函数：格式化附件体积（KB/MB），供消息附件与输入框附件芯片共用
 */
export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 格式化 read 工具行范围 (:offset-limit)
 */
export function formatReadLineRange(args?: Record<string, unknown>): string {
  if (!args) return '';
  const offset = typeof args.offset === 'number' ? args.offset : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  if (offset !== undefined && limit !== undefined) {
    return `:${offset}-${offset + limit - 1}`;
  }
  if (offset !== undefined) {
    return `:${offset}`;
  }
  if (limit !== undefined) {
    return `:1-${limit}`;
  }
  return '';
}

/**
 * 聚合工具出现频次：read ×2, edit ×1, bash ×1
 */
export function computeToolBreakdown(tools: ToolBlock[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    counts.set(t.name, (counts.get(t.name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ');
}

export function formatGenericToolArgs(tool: {
  name: string;
  args?: Record<string, unknown>;
  summary?: string;
}): string {
  if (tool.args && typeof tool.args === 'object' && Object.keys(tool.args).length > 0) {
    const pairs = Object.entries(tool.args)
      .filter(([k]) => k !== 'subagent_type')
      .map(([k, v]) => {
        const str = typeof v === 'string' ? (v.length > 30 ? `${v.slice(0, 30)}...` : v) : JSON.stringify(v);
        return `${k}=${str}`;
      })
      .join(' ');
    if (pairs.length > 100) return `${pairs.slice(0, 100)}...`;
    return pairs;
  }
  if (tool.summary) {
    return tool.summary.length > 100 ? `${tool.summary.slice(0, 100)}...` : tool.summary;
  }
  return '';
}

export function formatToolSignature(tool: {
  name: string;
  args?: Record<string, unknown>;
  summary?: string;
}): string {
  if (tool.name === 'bash') {
    const rawCmd =
      typeof tool.args?.command === 'string'
        ? tool.args.command.trim()
        : tool.summary?.trim() || '...';
    const firstLine = rawCmd.split('\n')[0];
    const displayCmd = firstLine.length > 70 ? `${firstLine.slice(0, 70)}...` : firstLine;
    const timeout = typeof tool.args?.timeout === 'number' ? ` (timeout ${tool.args.timeout}s)` : '';
    return `$ ${displayCmd}${timeout}`;
  }
  if (tool.name === 'read') {
    const path =
      typeof tool.args?.path === 'string'
        ? tool.args.path
        : typeof tool.args?.file_path === 'string'
          ? tool.args.file_path
          : tool.summary || '';
    const range = formatReadLineRange(tool.args);
    return `read ${path}${range}`.trim();
  }
  if (tool.name === 'edit') {
    const path = typeof tool.args?.path === 'string' ? tool.args.path : tool.summary || '';
    const edits = Array.isArray(tool.args?.edits) ? tool.args.edits : [];
    const editSummary = edits.length > 0 ? ` (${edits.length} edit${edits.length > 1 ? 's' : ''})` : '';
    return `edit ${path}${editSummary}`.trim();
  }
  if (tool.name === 'write') {
    const path = typeof tool.args?.path === 'string' ? tool.args.path : tool.summary || '';
    return `write ${path}`.trim();
  }
  const genericArgs = formatGenericToolArgs(tool);
  return `${tool.name}${genericArgs ? ` ${genericArgs}` : ''}`;
}

const TOOL_META: Record<string, ToolMetaEntry> = {
  read: { icon: FileSearch, label: '读取', chip: 'bg-blue-500/10 text-blue-600 dark:text-blue-400', tint: 'text-blue-500' },
  edit: { icon: FileDiff, label: '修改', chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', tint: 'text-amber-500' },
  write: { icon: FilePen, label: '写入', chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', tint: 'text-emerald-500' },
  bash: { icon: Terminal, label: '命令', chip: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400', tint: 'text-cyan-500' },
  search: { icon: Search, label: '搜索', chip: 'bg-violet-500/10 text-violet-600 dark:text-violet-400', tint: 'text-violet-500' },
  grep: { icon: Search, label: '搜索', chip: 'bg-violet-500/10 text-violet-600 dark:text-violet-400', tint: 'text-violet-500' },
};

const DEFAULT_TOOL_META: ToolMetaEntry = {
  icon: Wrench,
  label: '调用',
  chip: 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400',
  tint: 'text-zinc-400',
};

export function getToolMeta(name: string): ToolMetaEntry {
  return TOOL_META[name] || DEFAULT_TOOL_META;
}

/** 提取工具头部主参数（命令首行 / 文件路径 / 泛化参数），用于一行式展示 */
export function getToolPrimaryArg(tool: {
  name: string;
  args?: Record<string, unknown>;
  summary?: string;
}): string {
  if (tool.name === 'bash') {
    const raw =
      typeof tool.args?.command === 'string'
        ? tool.args.command.trim()
        : tool.summary?.trim() || '';
    return raw.split('\n')[0];
  }
  if (tool.name === 'read' || tool.name === 'edit' || tool.name === 'write') {
    const p =
      typeof tool.args?.path === 'string'
        ? tool.args.path
        : typeof tool.args?.file_path === 'string'
          ? tool.args.file_path
          : tool.summary || '';
    return p;
  }
  return formatGenericToolArgs(tool) || tool.summary || '';
}

/** 统计 edit 工具增删行数，渲染 +n -n 徽标（比 "2 edits" 更直观） */
export function countEditDiffStats(edits: unknown): { added: number; removed: number } {
  if (!Array.isArray(edits)) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const e of edits as Array<{ oldText?: unknown; newText?: unknown }>) {
    if (typeof e?.oldText === 'string') removed += e.oldText.split('\n').length;
    if (typeof e?.newText === 'string') added += e.newText.split('\n').length;
  }
  return { added, removed };
}

export type TimelineItem =
  | { kind: 'thinking'; block: Extract<TurnBlock, { type: 'thinking' }>; index: number }
  | { kind: 'text'; block: Extract<TurnBlock, { type: 'text' }>; index: number }
  | { kind: 'tool_group'; tools: ToolBlock[]; index: number };

export function buildTimelineItems(blocks: TurnBlock[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let currentToolGroup: ToolBlock[] = [];
  let toolGroupStartIndex = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'tool') {
      if (currentToolGroup.length === 0) {
        toolGroupStartIndex = i;
      }
      currentToolGroup.push(block);
    } else {
      if (currentToolGroup.length > 0) {
        items.push({ kind: 'tool_group', tools: currentToolGroup, index: toolGroupStartIndex });
        currentToolGroup = [];
      }
      if (block.type === 'thinking') {
        items.push({ kind: 'thinking', block, index: i });
      } else if (block.type === 'text') {
        items.push({ kind: 'text', block, index: i });
      }
    }
  }
  if (currentToolGroup.length > 0) {
    items.push({ kind: 'tool_group', tools: currentToolGroup, index: toolGroupStartIndex });
  }
  return items;
}

/** 按回调正文语义推导标题（后端已不再产生 📋 过程消息） */
export function deriveCallbackTitle(content: string): string {
  if (content.startsWith('[Worker Completed:')) return '后台任务完成';
  if (content.includes('[Background Job')) return '后台进程完成';
  if (
    content.includes('[Timer:') ||
    content.includes('[定时任务:') ||
    content.includes('[Webhook:') ||
    content.includes('[手动触发:') ||
    content.includes('触发器')
  ) {
    return '自动触发通知';
  }
  if (content.includes('子会话')) return '异步子任务回执';
  return '系统唤醒通知';
}

/** 拆分长回执：首行为 headline（去尾冒号），其余为可折叠详情；正文剥去 [Wake-up] 前缀 */
export function splitCallbackReceipt(content: string): { headline: string; detailBody: string | null } {
  const normalized = content.startsWith('[Wake-up] ') ? content.slice('[Wake-up] '.length) : content;
  // Worker 完成回执：headline 只留「workerId · 任务标题」，Summary/Worktree 全文归入折叠详情
  const workerMatch = /^\[Worker Completed: ([^\]|]+) \| ([^\]]+)\]\n([\s\S]*)$/.exec(normalized);
  if (workerMatch) {
    const detail = workerMatch[3].trim();
    return {
      headline: `${workerMatch[1].trim()} · ${workerMatch[2].trim()}`,
      detailBody: detail || null,
    };
  }
  const sepIdx = normalized.indexOf('\n\n');
  if (sepIdx < 0) return { headline: normalized, detailBody: null };
  return {
    headline: normalized.slice(0, sepIdx).replace(/：$/, ''),
    detailBody: normalized.slice(sepIdx + 2),
  };
}
