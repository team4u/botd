import React, { useState, useMemo } from 'react';
import {
  User as UserIcon,
  BellRing,
  Info,
  Copy,
  Check,
  Pencil,
  GitFork,
  FileText,
} from 'lucide-react';
import type {
  MessageRecord,
  BotConfig,
  NodeRecord,
  ToolCallRecord,
  MessageAttachment,
  SubagentRunRecord,
  TurnBlock,
} from '@botd/protocol';
import { Markdown } from './Markdown.js';
import { copyText } from '../utils/clipboard.js';
import { AttachmentPreviewModal } from './AttachmentPreviewModal.js';
import {
  formatShortModel,
  formatFileSize,
  buildTimelineItems,
  deriveCallbackTitle,
  splitCallbackReceipt,
  type TimelineItem,
} from '../message-format.js';
import {
  SingleToolView,
  ToolGroupView,
} from './MessageItem/ToolViews.js';
import {
  ThinkingTrace,
  CollapsedProcessGroup,
  SubagentRunsPanel,
} from './MessageItem/ProcessViews.js';

// 子视图组件重导出：既有调用方（MessageTimeline / WorkersDrawer 等）统一从 MessageItem 导入
export { SingleToolView, ToolGroupView } from './MessageItem/ToolViews.js';
export { TypingDots, ThinkingTrace, CollapsedProcessGroup, SubagentRunsPanel } from './MessageItem/ProcessViews.js';


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
 * 统一时间线交错渲染器（供 MessageItem 与 ChatView 流式块共用）
 *
 * collapseCompletedProcess=true（已落库完成的消息）：过程项（思考/工具）总步骤数 >= 2 时，
 * 把连续的过程项聚合成一个默认收起的折叠条（位于对应 text 块上方），
 * 点击展开后带左边框缩进渲染原本的 ThinkingTrace / SingleToolView / ToolGroupView。
 * 默认 false：流式渲染与既有单测保持原行为（逐项平铺）。
 */
export const AssistantTurnContent: React.FC<{
  blocks?: TurnBlock[];
  toolCalls?: ToolCallRecord[];
  content?: string;
  collapseCompletedProcess?: boolean;
}> = ({ blocks, toolCalls, content, collapseCompletedProcess = false }) => {
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
          ...(tc.uiSpec ? { uiSpec: tc.uiSpec } : {}),
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

  // 已完成消息的过程块折叠：非 text 过程项总步骤数（思考块数 + 工具总数）>= 2 时，
  // 把每段连续的过程项（thinking / tool_group，直到遇到 text 分隔）聚合成一个默认收起的折叠条
  const processStepTotal = timelineItems.reduce(
    (sum, item) =>
      item.kind === 'thinking' ? sum + 1 : item.kind === 'tool_group' ? sum + item.tools.length : sum,
    0
  );
  const shouldCollapseProcess = collapseCompletedProcess && processStepTotal >= 2;

  if (shouldCollapseProcess) {
    const rendered: React.ReactNode[] = [];
    let pendingProcessItems: TimelineItem[] = [];
    const flushProcessItems = (keyPrefix: string) => {
      if (pendingProcessItems.length === 0) return;
      rendered.push(<CollapsedProcessGroup key={keyPrefix} items={pendingProcessItems} />);
      pendingProcessItems = [];
    };
    timelineItems.forEach((item, idx) => {
      if (item.kind === 'text') {
        flushProcessItems(`process-${idx}`);
        rendered.push(
          <div
            key={`text-${idx}-${item.index}`}
            className="mt-1 text-zinc-800 dark:text-zinc-200 leading-relaxed break-words prose-botd"
          >
            <Markdown>{item.block.text}</Markdown>
          </div>
        );
      } else {
        pendingProcessItems.push(item);
      }
    });
    flushProcessItems(`process-end-${timelineItems.length}`);

    return <div className="space-y-1">{rendered}</div>;
  }

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

export const MessageCopyButton: React.FC<{
  content: string;
  className?: string;
  label?: boolean;
}> = ({ content, className = '', label = false }) => {
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
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer transition-colors shrink-0 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 ${className}`}
    >
      {copied ? (
        <>
          <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
          {label && <span className="text-emerald-600 dark:text-emerald-400">已复制</span>}
        </>
      ) : (
        <>
          <Copy className="w-3.5 h-3.5" />
          {label && <span>复制</span>}
        </>
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
  label?: boolean;
  className?: string;
}> = ({ messageId, onForkMessage, label = false, className = '' }) => {
  return (
    <button
      type="button"
      onClick={() => void onForkMessage(messageId)}
      aria-label="从这里分叉新会话"
      title="从这里分叉新会话"
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer transition-colors shrink-0 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 ${className}`}
    >
      <GitFork className="w-3.5 h-3.5" />
      {label && <span>分叉</span>}
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
  /** 点击子代理运行记录打开右侧详情抽屉 */
  onInspectSubagentRun?: (run: SubagentRunRecord) => void;
}


interface CallbackMessageCardProps {
  messageId: string;
  content: string;
  childSessionId?: string;
  formattedTime: string;
  fullTime: string;
}

/** 回调通知卡：语义化标题 + 长回执默认折叠（父 Bot 随后会汇总，全文不默认平铺） */
const CallbackMessageCard: React.FC<CallbackMessageCardProps> = ({
  messageId,
  content,
  childSessionId,
  formattedTime,
  fullTime,
}) => {
  const [expanded, setExpanded] = useState(false);
  const title = deriveCallbackTitle(content);
  const { headline, detailBody } = splitCallbackReceipt(content);
  // Worker 完成回执：headline 为「workerId · 标题」，是纯粹的完成凭条（完整时间线走顶栏 ⚡
  // 抽屉，且 Worker 轨迹存在内存，历史会话中不可回看，不提供死链）；detailBody 是 200 字
  // 截断的残缺摘要，该场景折叠区整体省略
  const isWorkerReceipt = title === '后台任务完成';
  const collapsible = detailBody !== null && !isWorkerReceipt;

  return (
    <div data-message-id={messageId} className="flex justify-center my-3">
      <div className="max-w-2xl w-full p-2.5 sm:p-3 bg-amber-50/70 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 rounded-xl text-xs text-amber-900 dark:text-amber-200 shadow-xs">
        <div className="flex items-center justify-between font-medium text-amber-800 dark:text-amber-300 mb-1">
          <div className="flex items-center gap-1.5">
            <BellRing className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>{title}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isWorkerReceipt && childSessionId && (
              <a
                href={`#?s=${childSessionId}`}
                className="text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:underline"
              >
                查看对话 / 追问 →
              </a>
            )}
            <span className="text-[11px] text-amber-600/80 dark:text-amber-400/80 font-normal" title={fullTime}>
              {formattedTime}
            </span>
          </div>
        </div>
        <div className="text-amber-950 dark:text-amber-200 mt-1">
          {collapsible ? (
            <>
              <p className="leading-relaxed break-words">{headline}</p>
              {expanded && (
                <div className="prose-botd prose-botd--xs text-amber-950 dark:text-amber-200 mt-1.5 pt-1.5 border-t border-amber-200/60 dark:border-amber-900/50">
                  <Markdown>{detailBody}</Markdown>
                </div>
              )}
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:underline cursor-pointer"
              >
                {expanded ? '收起详情 ▴' : '展开回执详情 ▾'}
              </button>
            </>
          ) : (
            <div className="prose-botd prose-botd--xs text-amber-950 dark:text-amber-200">
              <Markdown>{headline}</Markdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

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

  // 历史消息过滤「自己挂自己」的 subagentRuns：
  // 旧版本会把子代理自己发言的镜像 run（id 以 run_ 开头且 subagentId === 发送者自身）挂到它自己的消息上，
  // 造成公屏消息头顶出现冗余的自指卡片；真实子代理卡片（其他 bot 的 runs）不受影响。
  // 注：这里不用 useMemo——既有单测以普通函数方式直接调用 MessageItem，顶层 hooks 会破坏该用法；
  // 过滤本身是廉价数组操作，外层 MemoizedMessageItem 已隔绝大多数重渲染。
  const visibleSubagentRuns = (message.subagentRuns || []).filter(
    (r) => !(r.subagentId === message.senderBotId && r.id.startsWith('run_'))
  );

  // 跨 BOT 回调黄卡：正文包含指向子会话的 #?s=sess_... 链接时，右上角提供「查看对话 / 追问」内联入口
  const callbackChildSessionId = isCallback
    ? message.content.match(/#\?s=(sess_[a-zA-Z0-9_-]+)/)?.[1]
    : undefined;

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

  // [PASS]/[IGNORE] 智能体略过发言紧凑单行展示
  const trimmedContent = message.content.trim();
  const isPassMessage =
    isAssistant &&
    (/^\[(?:PASS|IGNORE)\]$/i.test(trimmedContent) ||
      (/^\[(?:PASS|IGNORE)\](?:\s|[:：—-])/i.test(trimmedContent) && trimmedContent.length < 80));

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

  // 唤醒回调事件：语义化标题的轻量通知卡（长回执默认折叠）
  if (isCallback) {
    return (
      <CallbackMessageCard
        messageId={message.id}
        content={message.content}
        childSessionId={callbackChildSessionId}
        formattedTime={formattedTime}
        fullTime={fullTime}
      />
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
        {/* 常显操作行：时间 + 复制 + 分叉 + 编辑（移动端与桌面端均可见） */}
        <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 select-none">
          <span className="px-1" title={fullTime}>
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
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer shrink-0"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // AI 助手消息（Assistant）：纯文字身份行 + Markdown 正文平铺画布，
  // 不再有整块 hover 底色，过程（思考/工具）与结论（正文）通过卡片层级自然分离
  return (
    <div data-message-id={message.id} className="group py-2 sm:py-2.5">
      {/* 身份行：名称 + 模型 + 中止标记 */}
      <div className="flex items-center gap-1.5 min-w-0 mb-0.5">
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

      {/* 子代理协同面板（过滤历史数据中「自己挂自己」的自指 run 记录） */}
      {visibleSubagentRuns.length > 0 && (
        <SubagentRunsPanel runs={visibleSubagentRuns} onInspectSubagentRun={onInspectSubagentRun} />
      )}

      {/* 统一交错时间线渲染器（已落库完成消息：过程块折叠为 1 行摘要） */}
      <AssistantTurnContent
        blocks={message.blocks}
        toolCalls={isAssistant ? message.toolCalls : undefined}
        content={message.content}
        collapseCompletedProcess={true}
      />

      {/* 附件（图片缩略图 / 文件下载芯片），助手产出的文件产物同样可预览与下载 */}
      <MessageAttachments attachments={message.attachments || []} />

      {/* 操作行：时间 + 复制 + 分叉 + Token 用量置于正文下方，移动端与桌面端均常显 */}
      <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 select-none">
        <span className="px-1" title={fullTime}>
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
