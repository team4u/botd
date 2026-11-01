import React, { useState } from 'react';
import {
  Bot,
  BellRing,
  Info,
  Copy,
  Check,
  Pencil,
  GitFork,
  Terminal,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleAlert,
  Loader2,
  FileText,
} from 'lucide-react';
import type {
  MessageRecord,
  BotConfig,
  NodeRecord,
  ToolCallRecord,
  MessageAttachment,
} from '@botd/protocol';
import { Markdown } from './Markdown';
import { copyText } from '../utils/clipboard';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';

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

/**
 * 辅助函数：格式化工具调用耗时，<1s 以毫秒展示，否则保留一位小数秒
 */
function formatDuration(ms: number): string {
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
 * 可折叠工具执行轨迹：收起时为轻量内联文字行（无框无底色，与元数据行自然留白），
 * 展开后为分栏对齐的终端风明细面板（名称/摘要/耗时各归其位）
 */
const ToolCallsTrace: React.FC<{ toolCalls: ToolCallRecord[] }> = ({ toolCalls }) => {
  const [expanded, setExpanded] = useState(false);
  if (!toolCalls || toolCalls.length === 0) return null;

  const hasDuration = toolCalls.some((t) => typeof t.durationMs === 'number');
  const totalMs = toolCalls.reduce((sum, t) => sum + (t.durationMs || 0), 0);
  const errorCount = toolCalls.filter((t) => t.status === 'error').length;

  return (
    <div className="mt-2 mb-1 max-w-xl">
      {/* 收起态：极简内联文字按钮，去边框去底色，悬停仅加深文字 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer"
      >
        <Terminal className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">
          {toolCalls.length} 次工具调用
          {errorCount > 0 && (
            <span className="text-rose-500 dark:text-rose-400">（{errorCount} 失败）</span>
          )}
        </span>
        {hasDuration && (
          <span className="font-mono tabular-nums">· {formatDuration(totalMs)}</span>
        )}
        {expanded ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
      </button>

      {/* 展开态：细分隔线的终端风面板，单行内名称固定、摘要截断悬停看全文、耗时右对齐 */}
      {expanded && (
        <div className="mt-1.5 rounded-lg border border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/60 overflow-hidden">
          {toolCalls.map((tool, idx) => (
            <div
              key={`${tool.name}-${idx}`}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] leading-relaxed border-zinc-100 dark:border-zinc-800/60 first:border-t-0 border-t"
            >
              {tool.status === 'running' ? (
                <Loader2 className="w-3 h-3 shrink-0 text-amber-500 animate-spin-fast" />
              ) : tool.status === 'error' ? (
                <CircleAlert className="w-3 h-3 shrink-0 text-rose-500 dark:text-rose-400" />
              ) : (
                <CircleCheck className="w-3 h-3 shrink-0 text-emerald-500" />
              )}
              <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300 shrink-0">
                {tool.name}
              </span>
              {tool.summary ? (
                <span
                  className="min-w-0 flex-1 truncate font-mono text-zinc-500 dark:text-zinc-400"
                  title={tool.summary}
                >
                  {tool.summary}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {typeof tool.durationMs === 'number' && (
                <span className="shrink-0 font-mono tabular-nums text-zinc-400 dark:text-zinc-500">
                  {formatDuration(tool.durationMs)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * 整条消息复制按钮：复制原文（message.content），成功后短暂显示"已复制"状态
 * 可通过 className 追加可见性控制（如 hover 才显示）与布局类
 */
const MessageCopyButton: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => {
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
  onForkMessage: (messageId: string) => Promise<void>;
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
  onForkMessage?: (messageId: string) => Promise<void>;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  botMap,
  nodeMap,
  canEdit = true,
  isEditing = false,
  onStartEdit,
  onForkMessage,
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
      <div data-message-id={message.id} className="flex justify-center my-2 px-3 sm:px-6">
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

  // 唤醒回调事件：去中英混排，轻量卡片
  if (isCallback) {
    return (
      <div data-message-id={message.id} className="flex justify-center my-2.5 px-3 sm:px-6">
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

  // 用户消息：去头像、去顶部“我+时间”，直接右对齐紧凑现代气泡
  if (isUser) {
    return (
      <div data-message-id={message.id} className="flex flex-col items-end my-2 px-3 sm:px-6 group">
        <div
          className={`bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700/60 px-4 py-2.5 rounded-2xl rounded-br-sm max-w-[85%] sm:max-w-[75%] shadow-xs user-bubble ${
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

  // AI 助手消息（Assistant）：去独立头像列、去外框气泡，Markdown 正文平铺画布，释放移动端阅读空间
  return (
    <div data-message-id={message.id} className="group px-3 sm:px-6 py-2.5 sm:py-3 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 transition-colors">
      {/* 极简单行浅灰元数据 */}
      <div className="flex items-center gap-1.5 min-w-0 text-xs flex-wrap sm:flex-nowrap">
        <div className="w-5 h-5 rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-900/60 flex items-center justify-center shrink-0">
          <Bot className="w-3.5 h-3.5" />
        </div>
        <span
          className="font-semibold text-zinc-900 dark:text-zinc-100 truncate max-w-[160px]"
          title={botHeaderTitle}
        >
          {bot?.name || message.senderBotId}
        </span>
        {shortModel && (
          <>
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate max-w-[140px] font-normal">
              {shortModel}
            </span>
          </>
        )}
      </div>

      {/* 可折叠工具执行轨迹：收起时仅单行摘要，展开后逐条展示名称/摘要/状态/耗时 */}
      <ToolCallsTrace toolCalls={isAssistant ? message.toolCalls || [] : []} />

      {/* Markdown 正文直接平铺在干净画布上，不套外部白框气泡 */}
      <div className="mt-1 text-zinc-800 dark:text-zinc-200 leading-relaxed break-words prose-botd">
        <Markdown>{message.content}</Markdown>
      </div>

      {/* 附件（图片缩略图 / 文件下载芯片），助手产出的文件产物同样可预览与下载 */}
      <MessageAttachments attachments={message.attachments || []} />

      {/* 操作按钮与用户消息保持一致：时间 + 复制 + 分叉 + Token 用量置于正文下方，移动端常显、桌面端悬停显示 */}
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
