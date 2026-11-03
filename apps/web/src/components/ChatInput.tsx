import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Square,
  Loader2,
  AlertCircle,
  X,
  Check,
  Pencil,
  Paperclip,
  FileText,
} from 'lucide-react';
import type { BotConfig, NodeRecord, MessageRecord, MessageAttachment } from '@botd/protocol';
import { formatFileSize } from './MessageItem';
import {
  canSubmitMessage,
  consumeSubmittedAttachments,
  consumeSubmittedDraft,
} from '../utils/input-uploads';
import { useSlashMenu } from './ChatInput/useSlashMenu';
import { useMentionMenu } from './ChatInput/useMentionMenu';
import { useUploads } from './ChatInput/useUploads';
import { SlashMenuDropdown } from './ChatInput/SlashMenuDropdown';
import { MentionMenuDropdown } from './ChatInput/MentionMenuDropdown';

export { parseSlashTrigger, type ParsedSlashTrigger } from './ChatInput/slash';

interface ChatInputProps {
  onSendMessage: (content: string, attachments?: MessageAttachment[]) => Promise<void>;
  memberBots: BotConfig[];
  nodeMap: Map<string, NodeRecord>;
  sessionId?: string;
  leadBotId?: string;
  botMap?: Map<string, BotConfig>;
  isSubagentSession?: boolean;
  disabled?: boolean;
  isRunning?: boolean;
  cancelling?: boolean;
  onCancelSession?: () => Promise<void>;
  /** 正在编辑的目标消息（Slack 式：编辑复用底部输入框） */
  editingMessage?: MessageRecord | null;
  /** 提交编辑：成功 resolve（由上层清除编辑态），失败 rethrow（本地保持编辑态） */
  onSubmitEditing?: (content: string) => Promise<void>;
  /** 取消编辑（恢复进入编辑前的草稿） */
  onCancelEditing?: () => void;
  /** 外部插入文本请求（如代码变更抽屉引用文件路径 / 扩展 editor_text 事件）；seq 变化时追加到输入框末尾并聚焦；replace=true 时直接替换输入框内容 */
  insertTextRequest?: { text: string; seq: number; replace?: boolean } | null;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  memberBots,
  nodeMap,
  sessionId,
  leadBotId,
  botMap,
  isSubagentSession = false,
  disabled = false,
  isRunning = false,
  cancelling = false,
  onCancelSession,
  editingMessage = null,
  onSubmitEditing,
  onCancelEditing,
  insertTextRequest = null,
}) => {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [validationNotice, setValidationNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  // 始终读取最新会话 ID：提交/上传的异步回调中用于丢弃过期结果
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;

  // 进入编辑前保存输入框已有草稿，取消编辑时恢复（null 表示未处于编辑会话）
  const draftBeforeEditRef = useRef<string | null>(null);

  const uploads = useUploads({ sessionId, setValidationNotice });
  const { pendingAttachments, setPendingAttachments, uploadingCount, uploadingFile, uploadTrackerRef, fileInputRef, resetOnSessionChange: resetUploadsOnSessionChange, uploadFiles } = uploads;

  const slash = useSlashMenu({ content, setContent, textareaRef, leadBotId, memberBots, botMap });
  const mention = useMentionMenu({ content, setContent, textareaRef, memberBots, isSubagentSession });

  // 切换会话时重置所有状态、请求版本及草稿内容
  useEffect(() => {
    slash.resetOnSessionChange();
    resetUploadsOnSessionChange();
    setContent('');
    setSending(false);
    setValidationNotice(null);
    draftBeforeEditRef.current = null;
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 进入编辑态 / 切换编辑目标：预填消息内容、聚焦并把光标移到末尾
  useEffect(() => {
    if (!editingMessage) return;
    // 仅首次进入编辑时保存当前草稿，切换编辑目标不覆盖
    if (draftBeforeEditRef.current === null) {
      draftBeforeEditRef.current = content;
    }
    mention.setShowMentions(false);
    slash.closeSlashMenu();
    setContent(editingMessage.content);
    // 等受控值更新后再聚焦，光标落在文本末尾
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }, 10);
    // 依赖编辑目标 id：仅在新进入或切换目标时重置输入框
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingMessage?.id]);

  // 取消编辑：恢复进入编辑前的草稿（若有），退出编辑态
  const cancelEditing = () => {
    if (!editingMessage || sending) return; // 保存中不允许取消，避免与提交竞态
    setContent(draftBeforeEditRef.current ?? '');
    draftBeforeEditRef.current = null;
    mention.setShowMentions(false);
    slash.closeSlashMenu();
    setValidationNotice(null);
    onCancelEditing?.();
  };

  // 外部插入文本（代码变更抽屉引用文件路径 / 扩展 editor_text）：追加到草稿末尾并聚焦输入框；
  // replace=true（扩展 setEditorText）时直接替换输入框内容
  useEffect(() => {
    if (!insertTextRequest?.seq) return;
    setContent((prev) =>
      insertTextRequest.replace
        ? insertTextRequest.text
        : prev
          ? `${prev}${prev.endsWith(' ') ? '' : ' '}${insertTextRequest.text}`
          : insertTextRequest.text,
    );
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }, 0);
    // 仅依赖 seq：同一文本重复请求（seq 递增）也能再次触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertTextRequest?.seq]);

  // 自动根据内容伸缩高度
  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  useEffect(() => {
    adjustHeight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // 点击外部关闭所有浮层（两浮层互斥，分别可选判断）
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideSlash = slash.slashDropdownRef.current?.contains(target);
      const insideMention = mention.mentionDropdownRef.current?.contains(target);
      const insideTextarea = textareaRef.current?.contains(target);
      if (!insideSlash && !insideMention && !insideTextarea) {
        mention.setShowMentions(false);
        slash.closeSlashMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 检测 @ 与 / 触发（严格互斥：斜杠优先）
  const checkTriggers = () => {
    const el = textareaRef.current;
    if (!el) return;

    const cursor = el.selectionStart;
    const text = el.value;

    if (slash.checkSlashTrigger(text, cursor)) {
      mention.setShowMentions(false);
      return;
    }
    mention.checkMentionTrigger(text, cursor);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文 IME 拼音输入期间按 Enter/Space 选词不触发任何补全或发送，增加 keyCode 229 兜底
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
      return;
    }

    // 1. 斜杠命令浮层处于打开状态
    if (slash.handleSlashKeyDown(e)) return;

    // 2. 提及下拉菜单处于打开状态
    if (mention.handleMentionKeyDown(e)) return;

    // 3. 编辑态按 Esc 取消编辑（补全浮层未打开时）
    if (e.key === 'Escape' && editingMessage) {
      e.preventDefault();
      cancelEditing();
      return;
    }

    // 4. Enter 直接发送消息（编辑态下为提交编辑）；Shift+Enter / Ctrl+Enter / Command+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      handleSubmit();
      return;
    }

    // Ctrl+Enter / Command+Enter / Shift+Enter 插入换行（保持默认行为，显式声明意图）
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      const el = textareaRef.current;
      if (el) {
        const cursor = el.selectionStart;
        const next = `${content.slice(0, cursor)}\n${content.slice(el.selectionEnd)}`;
        setContent(next);
        setTimeout(() => {
          el.focus();
          el.setSelectionRange(cursor + 1, cursor + 1);
          adjustHeight();
        }, 0);
      }
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 忽略由 keydown 处理的选择/导航/关闭按键，避免重置高亮索引或在 Enter 补全后重开浮层
    if (
      ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key) ||
      e.keyCode === 229
    ) {
      return;
    }
    checkTriggers();
  };

  // 文件选择器选中文件后立即上传
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    void uploadFiles(e.target.files);
    // 允许连续选择同一文件：每次清空 value
    e.target.value = '';
  };

  // 粘贴板含文件（如截图）时自动上传为附件，不干扰正常文本粘贴
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void uploadFiles(files);
    }
  };

  const handleSubmit = async () => {
    // 统一提交守卫：检查文本/附件、发送中、禁用状态，以及真实的上传任务状态（同时检查 state 与 ref）
    if (
      !canSubmitMessage({
        content,
        hasAttachments: pendingAttachments.length > 0,
        disabled,
        sending,
        uploadingCount: uploadTrackerRef.current.activeCount,
        isUploading: uploadingFile || uploadTrackerRef.current.activeCount > 0,
        isEditing: Boolean(editingMessage),
      })
    ) {
      return;
    }

    const trimmed = content.trim();

    // 编辑态优先：提交编辑，成功后由服务端截断后续回复并重新生成
    if (editingMessage) {
      if (!onSubmitEditing) return;
      const targetSessionId = sessionId;
      const submitGen = uploadTrackerRef.current.generation;
      const submittedDraft = content;
      setSending(true);
      mention.setShowMentions(false);
      slash.closeSlashMenu();
      setValidationNotice(null);
      try {
        await onSubmitEditing(trimmed);
        // 成功：仅在当前会话未变更且未发生 ABA 切换时消费草稿；编辑目标（editingMessage）由 ChatView 负责清除
        if (
          currentSessionIdRef.current === targetSessionId &&
          uploadTrackerRef.current.generation === submitGen
        ) {
          setContent((prev) => consumeSubmittedDraft(prev, submittedDraft));
          draftBeforeEditRef.current = null;
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
        }
      } catch {
        // 失败：保留编辑内容与编辑态，错误提示由上层 App toast 展示
      } finally {
        if (
          currentSessionIdRef.current === targetSessionId &&
          uploadTrackerRef.current.generation === submitGen
        ) {
          setSending(false);
          setTimeout(() => textareaRef.current?.focus(), 10);
        }
      }
      return;
    }

    // 仅当第一个 slash token 不含后续 /（即不是 /tmp/file 等文件路径）时，才判断为多目标命令
    const multiTargetMatch = /^(\s*(?:@[a-zA-Z0-9_-]+\s+){2,})\/(\S*)/.exec(trimmed);
    if (multiTargetMatch) {
      const slashToken = multiTargetMatch[2];
      if (!slashToken.includes('/')) {
        setValidationNotice('斜杠命令不支持同时发送给多个 BOT，请指定单个 @BOT 或直接使用 /');
        return;
      }
    }

    const targetSessionId = sessionId;
    const submitGen = uploadTrackerRef.current.generation;
    setSending(true);
    mention.setShowMentions(false);
    slash.closeSlashMenu();
    setValidationNotice(null);

    // 纯附件发送时自动补充占位正文，保证消息流可读
    const outgoingContent = trimmed || `[已发送附件: ${pendingAttachments.map((a) => a.filename).join(', ')}]`;
    const outgoingAttachments = [...pendingAttachments];
    const submittedDraft = content;
    const submittedAttachments = [...pendingAttachments];

    try {
      await onSendMessage(outgoingContent, outgoingAttachments);
      // 发送完成仅消费当次发送的附件与草稿，不能抹掉发送期间新追加的附件或草稿
      if (
        currentSessionIdRef.current === targetSessionId &&
        uploadTrackerRef.current.generation === submitGen
      ) {
        setContent((prev) => consumeSubmittedDraft(prev, submittedDraft));
        setPendingAttachments((prev) =>
          consumeSubmittedAttachments(prev, submittedAttachments)
        );
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      }
    } catch (err: any) {
      // onSendMessage reject 时保留用户输入，捕获异常并在输入框 notice 展示错误
      if (
        currentSessionIdRef.current === targetSessionId &&
        uploadTrackerRef.current.generation === submitGen
      ) {
        setValidationNotice(err?.message || '发送消息失败，请重试');
      }
    } finally {
      if (
        currentSessionIdRef.current === targetSessionId &&
        uploadTrackerRef.current.generation === submitGen
      ) {
        setSending(false);
        setTimeout(() => textareaRef.current?.focus(), 10);
      }
    }
  };

  const handleStop = async () => {
    if (cancelling || !onCancelSession) return;
    await onCancelSession();
  };

  // 发送与停止按钮二合一逻辑：正在运行中且输入框没有排队的新内容时显示停止按钮
  const showStopButton = Boolean(isRunning && !content.trim() && pendingAttachments.length === 0 && !uploadingFile);

  // 按钮禁用与提交守卫条件复用
  const canSubmit = canSubmitMessage({
    content,
    hasAttachments: pendingAttachments.length > 0,
    disabled,
    sending,
    uploadingCount,
    isUploading: uploadingFile || uploadTrackerRef.current.activeCount > 0,
    isEditing: Boolean(editingMessage),
  });

  return (
    <div className="chat-input-container relative bg-gradient-to-t from-white via-white/95 to-transparent dark:from-zinc-950 dark:via-zinc-950/95 px-3 sm:px-4 pt-3 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
      {/* 校验错误提示条 */}
      {validationNotice && (
        <div className="max-w-4xl mx-auto mb-2 px-3 py-1.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between animate-in fade-in">
          <span className="flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{validationNotice}</span>
          </span>
          <button
            type="button"
            onClick={() => setValidationNotice(null)}
            className="text-amber-600 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-200 p-0.5 cursor-pointer"
            aria-label="关闭提示"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 编辑态提示条：标记当前正在编辑消息，保存后将清除其后回复并重新生成 */}
      {editingMessage && (
        <div className="max-w-4xl mx-auto mb-1.5 flex items-center gap-2 px-3 py-1.5 text-xs bg-blue-50 dark:bg-blue-950/40 border border-blue-200/70 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 rounded-lg animate-in fade-in">
          <Pencil className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium shrink-0">正在编辑消息</span>
          <span className="text-blue-500/80 dark:text-blue-400/80 truncate min-w-0">
            保存后将清除其后回复并重新生成
          </span>
          <button
            type="button"
            onClick={cancelEditing}
            disabled={sending}
            className="ml-auto shrink-0 p-0.5 rounded text-blue-500 dark:text-blue-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="取消编辑"
            title="取消编辑（Esc）"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 斜杠命令选择浮层 */}
      {slash.showSlashMenu && (
        <SlashMenuDropdown
          slashQuery={slash.slashQuery}
          slashIndex={slash.slashIndex}
          setSlashIndex={slash.setSlashIndex}
          filteredCommands={slash.filteredCommands}
          allCommands={slash.allCommands}
          loadingCommands={slash.loadingCommands}
          commandsError={slash.commandsError}
          slashTargetBot={slash.slashTargetBot}
          isMultiTarget={slash.isMultiTarget}
          targetBotName={slash.targetBotName}
          dropdownRef={slash.slashDropdownRef}
          itemRefs={slash.slashItemRefs}
          activeTargetBotIdRef={slash.activeTargetBotIdRef}
          fetchCommands={slash.fetchCommands}
          insertSlashCommand={slash.insertSlashCommand}
        />
      )}

      {/* 提及选择浮层 */}
      {mention.showMentions && mention.filteredBots.length > 0 && (
        <MentionMenuDropdown
          nodeMap={nodeMap}
          filteredBots={mention.filteredBots}
          mentionIndex={mention.mentionIndex}
          setMentionIndex={mention.setMentionIndex}
          dropdownRef={mention.mentionDropdownRef}
          itemRefs={mention.mentionItemRefs}
          insertMention={mention.insertMention}
        />
      )}

      {/* 现代悬浮胶囊输入框 */}
      <div className="max-w-4xl mx-auto">
        {/* 待发送附件芯片：图片显示缩略图，文件显示文件名与体积，可逐个移除 */}
        {(pendingAttachments.length > 0 || uploadingFile) && (
          <div className="flex flex-wrap gap-1.5 mb-1.5 px-1">
            {pendingAttachments.map((att) => (
              <div
                key={att.id}
                className="group/att relative flex items-center gap-1.5 px-2 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-700/80 rounded-lg shadow-xs"
              >
                {att.mimeType.startsWith('image/') && att.url ? (
                  <img
                    src={att.url}
                    alt={att.filename}
                    className="w-8 h-8 rounded-md object-cover shrink-0 border border-zinc-100 dark:border-zinc-800"
                  />
                ) : (
                  <FileText className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                )}
                <div className="flex flex-col min-w-0 max-w-[140px]">
                  <span className="text-[11px] text-zinc-700 dark:text-zinc-200 truncate leading-tight">
                    {att.filename}
                  </span>
                  {att.sizeBytes > 0 && (
                    <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 leading-tight">
                      {formatFileSize(att.sizeBytes)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))
                  }
                  className="w-4 h-4 rounded-full flex items-center justify-center bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-rose-500 hover:text-white transition-colors cursor-pointer shrink-0"
                  aria-label={`移除附件 ${att.filename}`}
                  title="移除附件"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
            {uploadingFile && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg text-[11px] text-zinc-500 dark:text-zinc-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-blue-600 dark:text-blue-400" />
                <span>正在上传附件...</span>
              </div>
            )}
          </div>
        )}

        {/* 输入胶囊：悬浮式命令台，focus 时边框与阴影同步加深 */}
        <div className="relative flex items-center gap-2 bg-white dark:bg-zinc-900 border border-zinc-300/80 dark:border-zinc-700/80 rounded-2xl p-1.5 sm:p-2 focus-within:bg-white dark:focus-within:bg-zinc-900 focus-within:border-zinc-400 dark:focus-within:border-zinc-600 focus-within:ring-2 focus-within:ring-zinc-100 dark:focus-within:ring-zinc-800 focus-within:shadow-md transition-all shadow-xs">
          {/* 附件上传：编辑态不提供（编辑仅重写文本），选择后立即上传为会话产物 */}
          {!editingMessage && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileInputChange}
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || uploadingFile || sending}
                aria-label="上传附件"
                title="上传附件（支持图片与文件，也可直接粘贴截图）"
                className="h-8 w-8 rounded-lg flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0 cursor-pointer"
              >
                {uploadingFile ? (
                  <Loader2 className="w-4 h-4 animate-spin-fast text-blue-600 dark:text-blue-400" />
                ) : (
                  <Paperclip className="w-4 h-4" />
                )}
              </button>
            </>
          )}

          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              if (slash.dismissedSlashRef.current && slash.dismissedSlashRef.current.text !== e.target.value) {
                slash.dismissedSlashRef.current = null;
              }
              checkTriggers();
            }}
            onKeyUp={handleKeyUp}
            onClick={checkTriggers}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              checkTriggers();
            }}
            placeholder={
              editingMessage
                ? '编辑消息，Enter 保存，Esc 取消...'
                : '输入 / 命令，@ 提及成员...'
            }
            rows={1}
            disabled={disabled || sending}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={slash.showSlashMenu || mention.showMentions}
            aria-controls={
              slash.showSlashMenu
                ? 'slash-commands-listbox'
                : mention.showMentions
                ? 'mention-listbox'
                : undefined
            }
            aria-activedescendant={
              slash.showSlashMenu && slash.filteredCommands[slash.slashIndex]
                ? `slash-cmd-${slash.filteredCommands[slash.slashIndex].name}`
                : mention.showMentions && mention.filteredBots[mention.mentionIndex]
                ? `mention-bot-${mention.filteredBots[mention.mentionIndex].id}`
                : undefined
            }
            className="w-full resize-none bg-transparent px-2.5 py-1.5 sm:py-2 text-base sm:text-xs text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none max-h-[180px] leading-relaxed"
            aria-label="消息输入框"
          />

          {/* 保存编辑 / 发送 / 停止按钮：编辑态始终显示提交按钮（不显示停止按钮） */}
          {editingMessage ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-label="保存并重新生成"
              title="保存并重新生成（Enter）"
              className="p-2 sm:p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 text-white shadow-xs transition-colors shrink-0 flex items-center justify-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin-fast" />
              ) : (
                <Check className="w-4 h-4" />
              )}
            </button>
          ) : showStopButton ? (
            <button
              type="button"
              onClick={handleStop}
              disabled={cancelling}
              aria-label={cancelling ? '正在停止...' : '停止生成'}
              title={cancelling ? '正在停止...' : '停止生成'}
              className="p-2 sm:p-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 text-white shadow-xs transition-colors shrink-0 flex items-center justify-center cursor-pointer"
            >
              {cancelling ? (
                <Loader2 className="w-4 h-4 animate-spin-fast text-zinc-200 dark:text-zinc-700" />
              ) : (
                <Square className="w-4 h-4 fill-current text-white dark:text-zinc-900" />
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-label="发送消息"
              title="发送消息（Enter）"
              className="p-2 sm:p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 text-white shadow-xs transition-colors shrink-0 flex items-center justify-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin-fast" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
