import React, { useState } from 'react';
import { Bot, BellRing, Info, Copy, Check, Pencil, GitFork } from 'lucide-react';
import type { MessageRecord, BotConfig, NodeRecord } from '@botd/protocol';
import { Markdown } from './Markdown';

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
 * 整条消息复制按钮：复制原文（message.content），成功后短暂显示"已复制"状态
 * 可通过 className 追加可见性控制（如 hover 才显示）与布局类
 */
const MessageCopyButton: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（如非安全上下文）时静默降级
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
          <span className="text-[10px] text-emerald-600 dark:text-emerald-400">已复制</span>
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

  // 系统消息：紧凑单行胶囊居中
  if (isSystem) {
    return (
      <div className="flex justify-center my-2 px-3 sm:px-6">
        <div className="flex items-center gap-1.5 max-w-xl py-1 px-3 bg-zinc-100/90 dark:bg-zinc-800/90 border border-zinc-200/60 dark:border-zinc-800/60 rounded-full text-[11px] text-zinc-500 dark:text-zinc-400">
          <Info className="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />
          <div className="prose-botd text-[11px] text-zinc-600 dark:text-zinc-400">
            <Markdown>{message.content}</Markdown>
          </div>
          <span className="text-zinc-300 dark:text-zinc-600">·</span>
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0" title={fullTime}>
            {formattedTime}
          </span>
        </div>
      </div>
    );
  }

  // 唤醒回调事件：去中英混排，轻量卡片
  if (isCallback) {
    return (
      <div className="flex justify-center my-2.5 px-3 sm:px-6">
        <div className="max-w-2xl w-full p-2.5 sm:p-3 bg-amber-50/70 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 rounded-xl text-xs text-amber-900 dark:text-amber-200 shadow-xs">
          <div className="flex items-center justify-between font-medium text-amber-800 dark:text-amber-300 mb-1">
            <div className="flex items-center gap-1.5">
              <BellRing className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>后台任务唤醒回调</span>
            </div>
            <span className="text-[10px] text-amber-600/80 dark:text-amber-400/80 font-normal" title={fullTime}>
              {formattedTime}
            </span>
          </div>
          <div className="prose-botd text-xs text-amber-950 dark:text-amber-200 mt-1">
            <Markdown>{message.content}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  // 用户消息：去头像、去顶部“我+时间”，直接右对齐紧凑现代气泡
  if (isUser) {
    return (
      <div className="flex flex-col items-end my-2 px-3 sm:px-6 group">
        <div
          className={`bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-4 py-2.5 rounded-2xl rounded-br-sm max-w-[85%] sm:max-w-[75%] shadow-xs user-bubble ${
            isEditing ? 'ring-2 ring-blue-500/60' : ''
          }`}
        >
          <div className="prose-botd text-[14px] sm:text-[15px] leading-relaxed break-words">
            <Markdown>{message.content}</Markdown>
          </div>
        </div>
        <div className="flex items-center gap-0.5 mt-0.5 mr-1 select-none opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500" title={fullTime}>
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
    <div className="group px-3 sm:px-6 py-2.5 sm:py-3 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 transition-colors">
      {/* 极简单行浅灰元数据 */}
      <div className="flex items-center gap-1.5 min-w-0 text-xs flex-wrap sm:flex-nowrap">
        <div className="w-5 h-5 rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-900/60 flex items-center justify-center shrink-0">
          <Bot className="w-3.5 h-3.5" />
        </div>
        <span className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
          {bot?.name || message.senderBotId}
        </span>
        {message.senderBotId && (
          <span className="font-mono text-zinc-400 dark:text-zinc-500 text-[11px] shrink-0">
            @{message.senderBotId}
          </span>
        )}
        {node && (
          <>
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate max-w-[120px] font-normal">
              {node.name}
            </span>
          </>
        )}
        {shortModel && (
          <>
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate max-w-[140px] font-normal">
              {shortModel}
            </span>
          </>
        )}
        <span className="text-zinc-300 dark:text-zinc-600">·</span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0 font-normal" title={fullTime}>
          {formattedTime}
        </span>
        <MessageCopyButton
          content={message.content}
          className="ml-auto opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
        />
        {onForkMessage && (
          <MessageForkButton
            messageId={message.id}
            onForkMessage={onForkMessage}
            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
          />
        )}
      </div>

      {/* Markdown 正文直接平铺在干净画布上，不套外部白框气泡 */}
      <div className="mt-1 text-zinc-800 dark:text-zinc-200 text-[14px] sm:text-[15px] leading-relaxed break-words prose-botd">
        <Markdown>{message.content}</Markdown>
      </div>
    </div>
  );
};
