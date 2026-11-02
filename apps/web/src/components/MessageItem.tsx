import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  User as UserIcon,
  BellRing,
  Info,
  Copy,
  Check,
  Pencil,
  GitFork,
  FileText,
  ChevronRight,
  Loader2,
  Brain,
  Terminal,
  FileSearch,
  FileDiff,
  FilePen,
  Wrench,
  Search,
  Square,
  X,
  Users,
} from 'lucide-react';
import type {
  MessageRecord,
  BotConfig,
  NodeRecord,
  ToolCallRecord,
  MessageAttachment,
  SubagentColor,
  SubagentRunRecord,
  TurnBlock,
} from '@botd/protocol';
import { Markdown } from './Markdown';
import { copyText } from '../utils/clipboard';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';

/** 单个工具块类型别名 */
type ToolBlock = Extract<TurnBlock, { type: 'tool' }>;

/**
 * 辅助函数：提取模型简称，截取斜杠后的核心模型标识
 * 如 "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4-20250514"
 */
export function formatShortModel(model?: string): string {
  if (!model) return '';
  const parts = model.split('/');
  return parts[parts.length - 1] || model;
}

/**
 * 辅助函数：格式化消息时间
 * 今天的消息只显示时:分；跨天消息前缀短日期，显示为 "MM-DD HH:mm"
 */
function formatMessageTime(createdAt: string): string {
  const date = new Date(createdAt);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hm = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return hm;
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}-${dd} ${hm}`;
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

export const subagentColorStyles: Record<
  SubagentColor,
  {
    bg: string;
    border: string;
    text: string;
    darkBg: string;
    darkBorder: string;
    darkText: string;
    badge: string;
    iconBg: string;
  }
> = {
  blue: {
    bg: 'bg-blue-50',
    border: 'border-blue-200/70',
    text: 'text-blue-700',
    darkBg: 'dark:bg-blue-950/40',
    darkBorder: 'dark:border-blue-900/60',
    darkText: 'dark:text-blue-300',
    badge: 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200/60 dark:border-blue-800/60',
    iconBg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  },
  purple: {
    bg: 'bg-purple-50',
    border: 'border-purple-200/70',
    text: 'text-purple-700',
    darkBg: 'dark:bg-purple-950/40',
    darkBorder: 'dark:border-purple-900/60',
    darkText: 'dark:text-purple-300',
    badge: 'bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border-purple-200/60 dark:border-purple-800/60',
    iconBg: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  },
  red: {
    bg: 'bg-red-50',
    border: 'border-red-200/70',
    text: 'text-red-700',
    darkBg: 'dark:bg-red-950/40',
    darkBorder: 'dark:border-red-900/60',
    darkText: 'dark:text-red-300',
    badge: 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200/60 dark:border-red-800/60',
    iconBg: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800',
  },
  emerald: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-200/70',
    text: 'text-emerald-700',
    darkBg: 'dark:bg-emerald-950/40',
    darkBorder: 'dark:border-emerald-900/60',
    darkText: 'dark:text-emerald-300',
    badge: 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-800/60',
    iconBg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  },
  amber: {
    bg: 'bg-amber-50',
    border: 'border-amber-200/70',
    text: 'text-amber-700',
    darkBg: 'dark:bg-amber-950/40',
    darkBorder: 'dark:border-amber-900/60',
    darkText: 'dark:text-amber-300',
    badge: 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200/60 dark:border-amber-800/60',
    iconBg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  },
  cyan: {
    bg: 'bg-cyan-50',
    border: 'border-cyan-200/70',
    text: 'text-cyan-700',
    darkBg: 'dark:bg-cyan-950/40',
    darkBorder: 'dark:border-cyan-900/60',
    darkText: 'dark:text-cyan-300',
    badge: 'bg-cyan-50 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-300 border-cyan-200/60 dark:border-cyan-800/60',
    iconBg: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800',
  },
  pink: {
    bg: 'bg-pink-50',
    border: 'border-pink-200/70',
    text: 'text-pink-700',
    darkBg: 'dark:bg-pink-950/40',
    darkBorder: 'dark:border-pink-900/60',
    darkText: 'dark:text-pink-300',
    badge: 'bg-pink-50 dark:bg-pink-950/50 text-pink-700 dark:text-pink-300 border-pink-200/60 dark:border-pink-800/60',
    iconBg: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-200 dark:border-pink-800',
  },
  indigo: {
    bg: 'bg-indigo-50',
    border: 'border-indigo-200/70',
    text: 'text-indigo-700',
    darkBg: 'dark:bg-indigo-950/40',
    darkBorder: 'dark:border-indigo-900/60',
    darkText: 'dark:text-indigo-300',
    badge: 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border-indigo-200/60 dark:border-indigo-800/60',
    iconBg: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800',
  },
};

/** 智能体微徽章取色序列（主 BOT 无 color 时按 ID 哈希稳定取色） */
const BOT_ACCENT_ORDER: SubagentColor[] = ['blue', 'indigo', 'purple', 'cyan', 'emerald', 'amber', 'pink', 'red'];

export function botAccentFor(key: string): SubagentColor {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return BOT_ACCENT_ORDER[h % BOT_ACCENT_ORDER.length];
}

/**
 * 行内智能体微徽章（20px 圆角色块 + 首字母）：
 * 分身优先用自身 color，主 BOT 按 ID 哈希稳定取色，群聊中扫一眼颜色即可分辨发言者
 */
export const BotAvatarBadge: React.FC<{
  botId?: string;
  name?: string;
  color?: SubagentColor;
  className?: string;
}> = ({ botId, name, color, className = '' }) => {
  const accent = color && subagentColorStyles[color] ? color : botAccentFor(botId || name || 'bot');
  const letter = (name || botId || 'B').trim().charAt(0).toUpperCase() || 'B';
  return (
    <span
      className={`w-5 h-5 rounded-md border flex items-center justify-center text-[10px] font-bold shrink-0 select-none ${subagentColorStyles[accent].iconBg} ${className}`}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
};

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
 * 分身协同执行面板（Web 时间轴步骤流风格）
 * 点击任意分身行（running / done / error / stopped）打开右侧「分身运行详情抽屉」
 */
export const SubagentRunsPanel: React.FC<{
  runs: SubagentRunRecord[];
  onInspectSubagentRun?: (run: SubagentRunRecord) => void;
}> = ({ runs, onInspectSubagentRun }) => {
  const hasRunning = runs.some((r) => r.status === 'running');
  const [expanded, setExpanded] = useState(hasRunning);

  React.useEffect(() => {
    if (hasRunning) {
      setExpanded(true);
    }
  }, [hasRunning]);

  if (!runs || runs.length === 0) return null;

  const names = runs.map((r) => r.subagentName || `@${r.subagentId}`).join('、');

  return (
    <div className="my-2 max-w-2xl">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer select-none min-w-0"
        title={names}
      >
        <Users className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium shrink-0">分身协同</span>
        <span className="text-zinc-400 dark:text-zinc-500 truncate">
          {runs.length} 个分身 · {names}
        </span>
        {hasRunning && (
          <span className="inline-flex items-center gap-1 text-blue-500 dark:text-blue-400 shrink-0">
            <span className="w-1 h-1 rounded-full bg-blue-500 animate-pulse" />
            <span>运行中</span>
          </span>
        )}
        <ChevronRight
          className={`w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform duration-200 ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </button>

      {expanded && (
        <div className="mt-2 relative">
          {runs.length > 1 && (
            <span
              className="absolute left-[11px] top-2 bottom-2 w-px bg-zinc-200 dark:bg-zinc-800"
              aria-hidden="true"
            />
          )}
          <div className="space-y-2">
            {runs.map((run) => {
              return (
                <div key={run.id} className="relative flex gap-2">
                  {/* 状态节点：运行中旋转 / 失败叉 / 停止点 / 完成勾 */}
                  <span className="z-10 w-6 h-6 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center shrink-0">
                    {run.status === 'running' ? (
                      <Loader2 className="w-3 h-3 text-blue-500 animate-spin-fast" />
                    ) : run.status === 'error' ? (
                      <X className="w-3 h-3 text-rose-500" />
                    ) : run.status === 'stopped' ? (
                      <Square className="w-3 h-3 text-zinc-400 dark:text-zinc-500" />
                    ) : (
                      <Check className="w-3 h-3 text-emerald-500" />
                    )}
                  </span>

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onInspectSubagentRun?.(run)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onInspectSubagentRun?.(run);
                      }
                    }}
                    title="点击查看运行详情"
                    className="flex-1 min-w-0 cursor-pointer"
                  >
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-zinc-800 dark:text-zinc-200 text-xs">
                        {run.subagentName || `@${run.subagentId}`}
                      </span>
                      {run.phase && (
                        <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                          {run.phase}
                        </span>
                      )}
                      {typeof run.durationMs === 'number' && (
                        <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                          {formatDuration(run.durationMs)}
                        </span>
                      )}
                      {run.status === 'running' && (
                        <span className="text-[11px] text-blue-500 dark:text-blue-400">
                          运行中{run.currentTool ? ` · ${run.currentTool}` : ''}
                        </span>
                      )}
                      {run.status === 'error' && (
                        <span className="text-[11px] text-rose-500 dark:text-rose-400">失败</span>
                      )}
                      {run.status === 'stopped' && (
                        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">已停止</span>
                      )}
                      <ChevronRight className="ml-auto w-3.5 h-3.5 text-zinc-300 dark:text-zinc-600 shrink-0" />
                    </div>

                    <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 truncate">{run.task}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 辅助函数：格式化附件体积（KB/MB），供消息附件与输入框附件芯片共用
 */
export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 辅助组件：消息附件渲染（用户与助手消息通用）
 * 图片渲染为可点击缩略图（点击打开大图预览弹窗），其余渲染为文件芯片
 * 芯片上提供预览（可预览类型）与下载两个入口
 */
const MessageAttachments: React.FC<{ attachments: MessageAttachment[] }> = ({ attachments }) => {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  if (!attachments || attachments.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {attachments.map((att, i) =>
          att.mimeType?.startsWith('image/') && att.url ? (
            <button
              key={att.id}
              type="button"
              onClick={() => setPreviewIndex(i)}
              title={`预览图片：${att.filename}`}
              className="block max-w-full rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden hover:opacity-90 transition-opacity shadow-xs cursor-zoom-in"
            >
              <img
                src={att.url}
                alt={att.filename}
                loading="lazy"
                className="max-h-56 rounded-lg block max-w-full"
              />
            </button>
          ) : (
            <button
              key={att.id}
              type="button"
              onClick={() => setPreviewIndex(i)}
              title={`预览 ${att.filename}`}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 rounded-lg text-[11px] text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
              <span className="truncate max-w-[160px]">{att.filename}</span>
              {typeof att.sizeBytes === 'number' && att.sizeBytes > 0 && (
                <span className="font-mono text-zinc-400 dark:text-zinc-500 shrink-0">
                  {formatFileSize(att.sizeBytes)}
                </span>
              )}
            </button>
          )
        )}
      </div>
      {previewIndex !== null && (
        <AttachmentPreviewModal
          attachments={attachments}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </>
  );
};

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

// ===== 工具语义化元信息（Web 原生图标 + 中文动词标签 + 主题色） =====

type ToolIcon = React.ComponentType<{ className?: string }>;

interface ToolMetaEntry {
  icon: ToolIcon;
  label: string;
  /** 小色块底 + 文字色（用于 20px 图标方块） */
  chip: string;
  /** 纯文字色（用于时间轴节点图标） */
  tint: string;
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
  const [expanded, setExpanded] = useState<boolean>(initialExpanded ?? isError);

  useEffect(() => {
    if (isError) {
      setExpanded(true);
    }
  }, [isError]);

  return (
    <div className="my-1.5 max-w-2xl select-none">
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

  return (
    <div className="my-2 max-w-2xl select-none">
      <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 overflow-hidden shadow-xs">
        <button
          type="button"
          onClick={() => setGroupExpanded((v) => !v)}
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

/**
 * 兼容旧组件签名的 ToolCallsTrace，直接使用 SingleToolView / ToolGroupView
 */
export const ToolCallsTrace: React.FC<{ toolCalls: ToolCallRecord[]; initialExpanded?: boolean }> = ({
  toolCalls,
  initialExpanded = false,
}) => {
  if (!toolCalls || toolCalls.length === 0) return null;
  const toolBlocks: ToolBlock[] = toolCalls.map((tc, idx) => ({
    type: 'tool',
    id: tc.id || `${tc.name}_${idx}`,
    name: tc.name,
    ...(tc.args ? { args: tc.args } : {}),
    ...(tc.summary ? { summary: tc.summary } : {}),
    status: tc.status,
    ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
    ...(tc.outputPreview !== undefined ? { outputPreview: tc.outputPreview } : {}),
    ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
  }));

  if (toolBlocks.length === 1) {
    return (
      <div className="my-1.5 max-w-2xl">
        <SingleToolView tool={toolBlocks[0]} initialExpanded={initialExpanded} />
      </div>
    );
  }

  return (
    <div className="my-2 max-w-2xl">
      <ToolGroupView tools={toolBlocks} initialExpanded={initialExpanded} />
    </div>
  );
};

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

  const isExpanded = userOverride !== null ? userOverride : isRunning;

  if (!block.thinking && !isRunning) return null;

  return (
    <div className="my-2 max-w-2xl select-none">
      <button
        type="button"
        onClick={() => setUserOverride(!isExpanded)}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-violet-200/70 dark:border-violet-900/50 bg-violet-50/80 dark:bg-violet-950/30 text-[11px] font-medium text-violet-600 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-colors cursor-pointer"
      >
        <Brain className={`w-3.5 h-3.5 shrink-0 ${isRunning ? 'animate-pulse' : ''}`} />
        <span>
          {isRunning
            ? '深度思考中'
            : `已深度思考${block.durationMs ? ` · ${formatDuration(block.durationMs)}` : ''}`}
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

/**
 * 统一时间线交错渲染器（供 MessageItem 与 ChatView 流式块共用）
 */
export const AssistantTurnContent: React.FC<{
  blocks?: TurnBlock[];
  toolCalls?: ToolCallRecord[];
  content?: string;
}> = ({ blocks, toolCalls, content }) => {
  const resolvedBlocks: TurnBlock[] = useMemo(() => {
    if (blocks && blocks.length > 0) {
      return blocks;
    }
    const synthetic: TurnBlock[] = [];
    if (toolCalls && toolCalls.length > 0) {
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        synthetic.push({
          type: 'tool',
          id: tc.id || `${tc.name}_${i}`,
          name: tc.name,
          ...(tc.args ? { args: tc.args } : {}),
          ...(tc.summary ? { summary: tc.summary } : {}),
          status: tc.status,
          ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
          ...(tc.outputPreview !== undefined ? { outputPreview: tc.outputPreview } : {}),
          ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
        });
      }
    }
    if (content) {
      synthetic.push({
        type: 'text',
        text: content,
      });
    }
    return synthetic;
  }, [blocks, toolCalls, content]);

  const timelineItems = useMemo(() => buildTimelineItems(resolvedBlocks), [resolvedBlocks]);

  if (timelineItems.length === 0) return null;

  return (
    <div className="space-y-1">
      {timelineItems.map((item, idx) => {
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
        if (item.kind === 'text') {
          return (
            <div
              key={`text-${idx}-${item.index}`}
              className="mt-1 text-zinc-800 dark:text-zinc-200 leading-relaxed break-words prose-botd"
            >
              <Markdown>{item.block.text}</Markdown>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
};

export const MessageCopyButton: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyText(content);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? '已复制' : '复制消息'}
      title={copied ? '已复制' : '复制'}
      className={`flex items-center gap-1 p-1 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition shrink-0 ${className}`}
    >
      {copied ? (
        <>
          <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400">已复制</span>
        </>
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
};

/**
 * 分叉按钮：从该消息（含）复制出新会话并自动切换，原会话不动
 * 运行中也可点击（只读源 + 新建，不打扰执行）
 */
const MessageForkButton: React.FC<{
  messageId: string;
  onForkMessage: (messageId: string) => void | Promise<void>;
  className?: string;
}> = ({ messageId, onForkMessage, className = '' }) => {
  return (
    <button
      type="button"
      onClick={() => void onForkMessage(messageId)}
      aria-label="从这里分叉新会话"
      title="从这里分叉新会话"
      className={`flex items-center gap-1 p-1 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition shrink-0 ${className}`}
    >
      <GitFork className="w-3.5 h-3.5" />
    </button>
  );
};

interface MessageItemProps {
  message: MessageRecord;
  botMap: Map<string, BotConfig>;
  nodeMap: Map<string, NodeRecord>;
  /** 是否允许编辑（运行中的会话禁止，与后端 409 拦截对齐） */
  canEdit?: boolean;
  /** 该消息是否为止在编辑的目标（编辑由底部 ChatInput 承载） */
  isEditing?: boolean;
  /** 点击铅笔进入编辑态（Slack 式：复用底部发送框） */
  onStartEdit?: (message: MessageRecord) => void;
  /** 从该消息（含）分叉出新会话并自动切换（MessageItem 不感知 sessionId，由上层闭包绑定） */
  onForkMessage?: (messageId: string) => void | Promise<void>;
  /** 点击分身运行记录打开右侧详情抽屉 */
  onInspectSubagentRun?: (run: SubagentRunRecord) => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  botMap,
  nodeMap,
  canEdit = true,
  isEditing = false,
  onStartEdit,
  onForkMessage,
  onInspectSubagentRun,
}) => {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isCallback = message.role === 'callback';
  const isSystem = message.role === 'system';

  const bot = message.senderBotId ? botMap.get(message.senderBotId) : undefined;
  const node = bot ? nodeMap.get(bot.nodeId) : undefined;

  const rawModel = message.modelBadge || bot?.modelId;
  const shortModel = formatShortModel(rawModel);

  const formattedTime = formatMessageTime(message.createdAt);
  // 完整本地日期时间，供时间元素 title 悬停展示
  const fullTime = new Date(message.createdAt).toLocaleString();
  // Bot 头部悬停提示：收拢完整身份信息（昵称、@id、节点、完整模型名），头部只展示精简版
  const botHeaderTitle = [
    bot?.name || message.senderBotId,
    message.senderBotId ? `@${message.senderBotId}` : '',
    node?.name,
    rawModel,
  ]
    .filter(Boolean)
    .join(' · ');

  // Token 用量徽标：置于底部操作行（复制/分叉旁），悬停展示完整用量明细
  const usageBadge =
    message.usage && message.usage.totalTokens > 0 ? (
      <span
        className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0"
        title={[
          `输入 ${message.usage.inputTokens.toLocaleString()} tokens`,
          message.usage.cacheReadTokens && message.usage.cacheReadTokens > 0
            ? `缓存读取 ${message.usage.cacheReadTokens.toLocaleString()} tokens`
            : '',
          message.usage.cacheWriteTokens && message.usage.cacheWriteTokens > 0
            ? `缓存写入 ${message.usage.cacheWriteTokens.toLocaleString()} tokens`
            : '',
          `输出 ${message.usage.outputTokens.toLocaleString()} tokens`,
          message.usage.contextWindow
            ? `上下文窗口 ${message.usage.contextWindow.toLocaleString()}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')}
      >
        {message.usage.totalTokens.toLocaleString()} tokens
        {message.usage.contextWindow && message.usage.contextWindow > 0 && (
          <> · {Math.round((message.usage.totalTokens / message.usage.contextWindow) * 100)}% ctx</>
        )}
      </span>
    ) : null;

  // 系统消息：紧凑单行胶囊居中
  if (isSystem) {
    return (
      <div data-message-id={message.id} className="flex justify-center my-3">
        <div className="flex items-center gap-1.5 max-w-xl py-1 px-3 bg-zinc-100/90 dark:bg-zinc-800/90 border border-zinc-200/60 dark:border-zinc-800/60 rounded-full text-[11px] text-zinc-500 dark:text-zinc-400">
          <Info className="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />
          <div className="prose-botd prose-botd--xs text-zinc-600 dark:text-zinc-400">
            <Markdown>{message.content}</Markdown>
          </div>
          <span className="text-zinc-300 dark:text-zinc-600">·</span>
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0" title={fullTime}>
            {formattedTime}
          </span>
        </div>
      </div>
    );
  }

  // [PASS] 智能体略过发言紧凑单行展示
  const isPassMessage =
    isAssistant &&
    (message.content.trim() === '[PASS]' ||
      (message.content.trim().startsWith('[PASS]') && message.content.trim().length < 40));

  if (isPassMessage) {
    return (
      <div
        data-message-id={message.id}
        className="flex items-center justify-between py-1 text-xs text-zinc-400 dark:text-zinc-500"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0" />
          <span className="font-medium text-zinc-500 dark:text-zinc-400 truncate text-xs">
            {bot?.name || (message.senderBotId ? '@' + message.senderBotId : '智能体')}
          </span>
          <span className="text-[11px]">已略过本轮发言</span>
        </div>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0" title={fullTime}>
          {formattedTime}
        </span>
      </div>
    );
  }

  // 唤醒回调事件：去中英混排，轻量卡片
  if (isCallback) {
    return (
      <div data-message-id={message.id} className="flex justify-center my-3">
        <div className="max-w-2xl w-full p-2.5 sm:p-3 bg-amber-50/70 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 rounded-xl text-xs text-amber-900 dark:text-amber-200 shadow-xs">
          <div className="flex items-center justify-between font-medium text-amber-800 dark:text-amber-300 mb-1">
            <div className="flex items-center gap-1.5">
              <BellRing className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>后台任务唤醒回调</span>
            </div>
            <span className="text-[11px] text-amber-600/80 dark:text-amber-400/80 font-normal" title={fullTime}>
              {formattedTime}
            </span>
          </div>
          <div className="prose-botd prose-botd--xs text-amber-950 dark:text-amber-200 mt-1">
            <Markdown>{message.content}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  // 用户消息：右对齐紧凑现代气泡，轮次之间以更大的顶部留白制造呼吸感
  if (isUser) {
    return (
      <div data-message-id={message.id} className="flex flex-col items-end pt-6 pb-1 group">
        {message.senderUsername && (
          <div className="flex items-center gap-1 mb-1 mr-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 select-none">
            <UserIcon className="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />
            <span>{message.senderUsername}</span>
          </div>
        )}
        <div
          className={`bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700/60 px-4 py-2.5 rounded-2xl rounded-br-md max-w-[85%] sm:max-w-[75%] shadow-xs user-bubble ${
            isEditing ? 'ring-2 ring-blue-500/60' : ''
          }`}
        >
          <div className="prose-botd leading-relaxed break-words">
            <Markdown>{message.content}</Markdown>
          </div>
        </div>
        {/* 附件（图片缩略图 / 文件下载芯片），与气泡同宽右对齐展示 */}
        <MessageAttachments attachments={message.attachments || []} />
        <div className="flex items-center gap-0.5 mt-0.5 mr-1 select-none opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500" title={fullTime}>
            {formattedTime}
          </span>
          {!isEditing && <MessageCopyButton content={message.content} />}
          {!isEditing && onForkMessage && (
            <MessageForkButton messageId={message.id} onForkMessage={onForkMessage} />
          )}
          {canEdit && onStartEdit && (
            <button
              type="button"
              onClick={() => onStartEdit(message)}
              aria-label="编辑消息"
              title="编辑并重新生成回复"
              className="flex items-center gap-1 p-1 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition shrink-0"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // AI 助手消息（Assistant）：色彩微徽章身份行 + Markdown 正文平铺画布，
  // 不再有整块 hover 底色，过程（思考/工具）与结论（正文）通过卡片层级自然分离
  return (
    <div data-message-id={message.id} className="group py-2 sm:py-2.5">
      {/* 身份行：微徽章 + 名称 + 模型 + 中止标记 */}
      <div className="flex items-center gap-1.5 min-w-0 mb-0.5">
        <BotAvatarBadge botId={message.senderBotId} name={bot?.name} color={bot?.color} />
        <span
          className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate max-w-[180px]"
          title={botHeaderTitle}
        >
          {bot?.name || message.senderBotId || '智能体'}
        </span>
        {shortModel && (
          <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 truncate">
            {shortModel}
          </span>
        )}
        {message.aborted && (
          <span className="text-[11px] italic text-amber-600/90 dark:text-amber-500/90 shrink-0">
            已中止
          </span>
        )}
      </div>

      {/* 分身协同面板 */}
      {message.subagentRuns && message.subagentRuns.length > 0 && (
        <SubagentRunsPanel runs={message.subagentRuns} onInspectSubagentRun={onInspectSubagentRun} />
      )}

      {/* 统一交错时间线渲染器 */}
      <AssistantTurnContent
        blocks={message.blocks}
        toolCalls={isAssistant ? message.toolCalls : undefined}
        content={message.content}
      />

      {/* 附件（图片缩略图 / 文件下载芯片），助手产出的文件产物同样可预览与下载 */}
      <MessageAttachments attachments={message.attachments || []} />

      {/* 操作行：时间 + 复制 + 分叉 + Token 用量置于正文下方，移动端常显、桌面端悬停显示 */}
      <div className="mt-1 flex items-center gap-0.5 select-none opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 px-1" title={fullTime}>
          {formattedTime}
        </span>
        <MessageCopyButton content={message.content} />
        {onForkMessage && (
          <MessageForkButton messageId={message.id} onForkMessage={onForkMessage} />
        )}
        {usageBadge}
      </div>
    </div>
  );
};

/**
 * MessageItem 的 memo 比较：botMap/nodeMap 是上层每次渲染重建的 Map 引用，直接浅比较会让 memo 失效；
 * 这里仅对当前消息用到的 bot/node（senderBotId -> bot -> nodeId -> node）比较条目内容等价性，
 * 其余 props 浅比较。流式期间（SSE 高频重渲染）历史消息不再整页重解析 Markdown/KaTeX。
 */
function areMessageItemPropsEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  if (
    prev.message !== next.message ||
    prev.canEdit !== next.canEdit ||
    prev.isEditing !== next.isEditing ||
    prev.onStartEdit !== next.onStartEdit ||
    prev.onForkMessage !== next.onForkMessage ||
    prev.onInspectSubagentRun !== next.onInspectSubagentRun
  ) {
    return false;
  }
  if (prev.botMap === next.botMap && prev.nodeMap === next.nodeMap) return true;
  // Map 引用变化时，仅比较本条消息实际读取的条目（引用相等即内容未变）
  const senderBotId = next.message.senderBotId;
  if (senderBotId) {
    if (prev.botMap.get(senderBotId) !== next.botMap.get(senderBotId)) return false;
    const nextBot = next.botMap.get(senderBotId);
    if (nextBot && prev.nodeMap.get(nextBot.nodeId) !== next.nodeMap.get(nextBot.nodeId)) {
      return false;
    }
  }
  return true;
}

/**
 * 供消息列表逐条渲染的 memo 版 MessageItem（ChatView 使用；直接调用组件本体的场景仍用 MessageItem）
 */
export const MemoizedMessageItem = React.memo(MessageItem, areMessageItemPropsEqual);
