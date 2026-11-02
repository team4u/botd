import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Send,
  Square,
  Bot,
  Loader2,
  AtSign,
  Terminal,
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  X,
  Check,
  Pencil,
  Paperclip,
  FileText,
} from 'lucide-react';
import type { BotConfig, NodeRecord, ChatCommand, MessageRecord, MessageAttachment, SessionMode } from '@botd/protocol';
import { api } from '../api';
import { formatFileSize } from './MessageItem';
import {
  canSubmitMessage,
  consumeSubmittedAttachments,
  consumeSubmittedDraft,
  createUploadTaskTracker,
  startUploadTask,
  finishUploadTask,
  resetUploadTasksOnSessionChange,
  isUploadResultValid,
  validateUploadFile,
} from '../utils/input-uploads';

interface ChatInputProps {
  onSendMessage: (content: string, attachments?: MessageAttachment[]) => Promise<void>;
  memberBots: BotConfig[];
  nodeMap: Map<string, NodeRecord>;
  sessionId?: string;
  leadBotId?: string;
  botMap?: Map<string, BotConfig>;
  sessionMode?: SessionMode;
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
}

/**
 * 解析光标前文本是否命中斜杠命令触发条件。
 * 规则：
 * 1. 仅在消息开头或前置单个/多个 @BOT 之后输入 / 触发；
 * 2. 避免路径与 URL（如 /path/to、http:// 等）持续误弹；
 * 3. 提取前置 @BOT 列表，用于识别纯 /（作用于 lead）或单一前置 @BOT（作用于该成员），以及多目标检测。
 */
export interface ParsedSlashTrigger {
  slashIndex: number;
  query: string;
  targetBotIds: string[];
}

export function parseSlashTrigger(textBefore: string): ParsedSlashTrigger | null {
  // 必须以可选前导空格开头，跟着 0 个或多个 "@botid "（后带至少一个空白），然后是 "/"，后接非空且不含空白与斜杠的命令查询词
  const slashRegex = /^(\s*(?:@[a-zA-Z0-9_-]+\s+)*)\/([^\s/]*)$/;
  const match = slashRegex.exec(textBefore);
  if (!match) return null;

  const prefix = match[1];
  const query = match[2];
  const slashIndex = prefix.length;

  const mentionMatches = prefix.match(/@([a-zA-Z0-9_-]+)/g) || [];
  const targetBotIds = mentionMatches.map((m) => m.slice(1));

  return {
    slashIndex,
    query,
    targetBotIds,
  };
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  memberBots,
  nodeMap,
  sessionId,
  leadBotId,
  botMap,
  sessionMode,
  isSubagentSession = false,
  disabled = false,
  isRunning = false,
  cancelling = false,
  onCancelSession,
  editingMessage = null,
  onSubmitEditing,
  onCancelEditing,
}) => {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [validationNotice, setValidationNotice] = useState<string | null>(null);

  // 待发送附件（图片/文件）：上传完成后暂存，随消息一并发送
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  // 上传任务计数与会话 generation 跟踪（防异步多批并发与切会话 ABA 竞态）
  const uploadTrackerRef = useRef(createUploadTaskTracker(0));
  const [uploadingCount, setUploadingCount] = useState(0);
  const uploadingFile = uploadingCount > 0;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mention 下拉菜单状态
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionPosition, setMentionPosition] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });

  // 斜杠命令浮层状态
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashPosition, setSlashPosition] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });
  const [slashTargetBot, setSlashTargetBot] = useState<BotConfig | { id: string; name: string } | null>(null);
  const [isMultiTarget, setIsMultiTarget] = useState(false);

  // 命令数据与请求状态
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [loadingCommands, setLoadingCommands] = useState(false);
  const [commandsError, setCommandsError] = useState<string | null>(null);

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const slashDropdownRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const mentionItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const isComposingRef = useRef(false);
  const dismissedSlashRef = useRef<{ text: string; cursor: number } | null>(null);
  const activeTargetBotIdRef = useRef<string | null>(null);
  const fetchRequestIdRef = useRef<number>(0);
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;

  // 进入编辑前保存输入框已有草稿，取消编辑时恢复（null 表示未处于编辑会话）
  const draftBeforeEditRef = useRef<string | null>(null);

  // 过滤成员 BOT
  const filteredBots = useMemo(() => {
    if (!mentionQuery) return memberBots;
    const q = mentionQuery.toLowerCase();
    return memberBots.filter(
      (bot) => bot.id.toLowerCase().includes(q) || bot.name.toLowerCase().includes(q)
    );
  }, [memberBots, mentionQuery]);

  // 过滤斜杠命令（统一搜索 skill/prompt/extension 的 name 与 description）
  const filteredCommands = useMemo(() => {
    if (!slashQuery) return commands;
    const q = slashQuery.toLowerCase();
    return commands.filter((cmd) => {
      const nameMatch = cmd.name.toLowerCase().includes(q);
      const descMatch = cmd.description ? cmd.description.toLowerCase().includes(q) : false;
      return nameMatch || descMatch;
    });
  }, [commands, slashQuery]);

  // 快捷协作胶囊栏（群聊且非编辑态且成员数>=2时展示）
  const showWorkflowPills =
    sessionMode !== 'direct' &&
    !editingMessage &&
    memberBots.length >= 2;

  const { relayPillText, refinePillText, whisperPillText } = useMemo(() => {
    const nonLeads = memberBots.filter((b) => b.id !== leadBotId);
    const nonLead0 = nonLeads[0]?.id || memberBots[0]?.id;
    const nonLead1 =
      nonLeads[1]?.id ||
      (memberBots[1]?.id !== nonLead0 ? memberBots[1]?.id : memberBots[0]?.id);
    const lead = leadBotId || memberBots[memberBots.length - 1]?.id;

    if (nonLeads.length >= 2) {
      return {
        relayPillText: `@${nonLead0} -> @${nonLead1} -> @${lead} `,
        refinePillText: `@${nonLead0} <-> @${nonLead1} -> @${lead} `,
        whisperPillText: `@${nonLead0} >> @${nonLead1} `,
      };
    } else if (nonLeads.length === 1 && lead && lead !== nonLead0) {
      return {
        relayPillText: `@${nonLead0} -> @${lead} `,
        refinePillText: `@${nonLead0} <-> @${lead} `,
        whisperPillText: `@${nonLead0} >> @${lead} `,
      };
    } else {
      const b0 = memberBots[0]?.id;
      const b1 = memberBots[1]?.id;
      return {
        relayPillText: `@${b0} -> @${b1} `,
        refinePillText: `@${b0} <-> @${b1} `,
        whisperPillText: `@${b0} >> @${b1} `,
      };
    }
  }, [memberBots, leadBotId]);

  const handleInsertWorkflowPill = (prefix: string) => {
    setContent((prev) => {
      if (prev.startsWith(prefix)) return prev;
      return `${prefix}${prev}`;
    });
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 10);
  };

  // 按目标 BOT 加载命令目录（具备防竞态与异常重试）
  const fetchCommands = useCallback(async (botId: string) => {
    if (!botId) return;
    const reqId = ++fetchRequestIdRef.current;
    activeTargetBotIdRef.current = botId;
    setCommands([]);
    setSlashIndex(0);
    setLoadingCommands(true);
    setCommandsError(null);

    try {
      const list = await api.getBotCommands(botId);
      if (fetchRequestIdRef.current === reqId && activeTargetBotIdRef.current === botId) {
        setCommands(Array.isArray(list) ? list : []);
        setLoadingCommands(false);
      }
    } catch (err: any) {
      if (fetchRequestIdRef.current === reqId && activeTargetBotIdRef.current === botId) {
        setCommands([]);
        setCommandsError(err?.message || '获取命令失败');
        setLoadingCommands(false);
      }
    }
  }, []);

  // 切换会话时重置所有状态、请求版本及草稿内容
  useEffect(() => {
    fetchRequestIdRef.current++;
    resetUploadTasksOnSessionChange(uploadTrackerRef.current);
    setUploadingCount(0);
    activeTargetBotIdRef.current = null;
    setContent('');
    setSending(false);
    setCommands([]);
    setCommandsError(null);
    setLoadingCommands(false);
    setIsMultiTarget(false);
    setSlashTargetBot(null);
    setShowSlashMenu(false);
    setShowMentions(false);
    setValidationNotice(null);
    setPendingAttachments([]);
    dismissedSlashRef.current = null;
    draftBeforeEditRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [sessionId]);

  // 进入编辑态 / 切换编辑目标：预填消息内容、聚焦并把光标移到末尾
  useEffect(() => {
    if (!editingMessage) return;
    // 仅首次进入编辑时保存当前草稿，切换编辑目标不覆盖
    if (draftBeforeEditRef.current === null) {
      draftBeforeEditRef.current = content;
    }
    setShowMentions(false);
    setShowSlashMenu(false);
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
  }, [editingMessage?.id]);

  // 取消编辑：恢复进入编辑前的草稿（若有），退出编辑态
  const cancelEditing = () => {
    if (!editingMessage || sending) return; // 保存中不允许取消，避免与提交竞态
    setContent(draftBeforeEditRef.current ?? '');
    draftBeforeEditRef.current = null;
    setShowMentions(false);
    setShowSlashMenu(false);
    setValidationNotice(null);
    onCancelEditing?.();
  };

  // 自动根据内容伸缩高度
  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  useEffect(() => {
    adjustHeight();
  }, [content]);

  // 当搜索词变化时重置选中的命令高亮项
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  // 命令浮层高亮项滚动至可见
  useEffect(() => {
    if (showSlashMenu && filteredCommands.length > 0) {
      const el = slashItemRefs.current[slashIndex];
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [slashIndex, showSlashMenu, filteredCommands.length]);

  // 提及成员浮层高亮项滚动至可见
  useEffect(() => {
    if (showMentions && filteredBots.length > 0) {
      const el = mentionItemRefs.current[mentionIndex];
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [mentionIndex, showMentions, filteredBots.length]);

  // 点击外部关闭所有浮层（两浮层互斥，分别可选判断）
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideSlash = slashDropdownRef.current?.contains(target);
      const insideMention = mentionDropdownRef.current?.contains(target);
      const insideTextarea = textareaRef.current?.contains(target);
      if (!insideSlash && !insideMention && !insideTextarea) {
        setShowMentions(false);
        setShowSlashMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // 检测 @ 与 / 触发（严格互斥）
  const checkTriggers = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    const cursor = el.selectionStart;
    const text = el.value;
    const textBefore = text.slice(0, cursor);

    // 1. 优先检测斜杠命令
    const slashMatch = parseSlashTrigger(textBefore);
    if (slashMatch) {
      setShowMentions(false);

      // 若用户曾按 Esc 主动关闭，且内容和光标未发生位移，则不立即重开
      if (
        dismissedSlashRef.current &&
        dismissedSlashRef.current.text === text &&
        dismissedSlashRef.current.cursor === cursor
      ) {
        return;
      }
      dismissedSlashRef.current = null;

      const multi = slashMatch.targetBotIds.length > 1;
      setIsMultiTarget(multi);

      if (multi) {
        fetchRequestIdRef.current++;
        activeTargetBotIdRef.current = null;
        setCommands([]);
        setSlashIndex(0);
        setLoadingCommands(false);
        setCommandsError(null);
        setSlashTargetBot(null);
        setSlashQuery(slashMatch.query);
        setSlashPosition({ start: slashMatch.slashIndex, end: cursor });
        setShowSlashMenu(true);
      } else {
        const hasSpecificBot = slashMatch.targetBotIds.length === 1;
        const targetId = hasSpecificBot ? slashMatch.targetBotIds[0] : (leadBotId || '');

        // 仅允许限制为 memberBots 或 leadBotId
        const isMember = memberBots.some((b) => b.id === targetId) || targetId === leadBotId;

        if (hasSpecificBot && !isMember) {
          // 无效前置 @ 展示明确错误且不请求目录
          fetchRequestIdRef.current++;
          activeTargetBotIdRef.current = null;
          setCommands([]);
          setSlashIndex(0);
          setLoadingCommands(false);
          setCommandsError(`@${targetId} 不是当前会话成员`);
          setSlashTargetBot({ id: targetId, name: targetId });
          setSlashQuery(slashMatch.query);
          setSlashPosition({ start: slashMatch.slashIndex, end: cursor });
          setShowSlashMenu(true);
          return;
        }

        const target =
          memberBots.find((b) => b.id === targetId) ||
          (targetId === leadBotId && botMap && leadBotId ? botMap.get(leadBotId) : undefined) ||
          (targetId ? { id: targetId, name: targetId } : null);

        setSlashTargetBot(target);
        setSlashQuery(slashMatch.query);
        setSlashPosition({ start: slashMatch.slashIndex, end: cursor });
        setShowSlashMenu(true);

        // 仅在菜单开启或切换目标 BOT 时拉取目录，避免重复与永不过期
        if (!showSlashMenu || activeTargetBotIdRef.current !== targetId) {
          if (targetId) {
            fetchCommands(targetId);
          } else {
            setCommands([]);
            setCommandsError('未找到主导智能体');
          }
        }
      }
      return;
    }

    // 未命中斜杠命令，关闭斜杠浮层
    setShowSlashMenu(false);

    // 2. 检测 @ 提及触发（分身/子代理会话中禁止继续 @ 其他智能体）
    const mentionMatch = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(textBefore);
    if (!isSubagentSession && mentionMatch && memberBots.length > 0) {
      const matchIndex = mentionMatch.index + (mentionMatch[0].startsWith('@') ? 0 : 1);
      setMentionQuery(mentionMatch[1]);
      setMentionPosition({ start: matchIndex, end: cursor });
      setShowMentions(true);
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  }, [leadBotId, botMap, memberBots, showSlashMenu, fetchCommands, isSubagentSession]);

  const insertMention = (bot: BotConfig) => {
    const el = textareaRef.current;
    if (!el) return;

    const before = content.slice(0, mentionPosition.start);
    const after = content.slice(mentionPosition.end);
    const replacement = `@${bot.id} `;
    const newContent = `${before}${replacement}${after}`;

    setContent(newContent);
    setShowMentions(false);

    const newCursor = mentionPosition.start + replacement.length;
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    }, 10);
  };

  const insertSlashCommand = useCallback((cmd: ChatCommand) => {
    const el = textareaRef.current;
    if (!el) return;

    // 选中只补全 '/name '，保留 / 外正文和光标后文字
    const before = content.slice(0, slashPosition.start);
    const after = content.slice(slashPosition.end);
    const replacement = `/${cmd.name} `;
    const newContent = `${before}${replacement}${after}`;

    setContent(newContent);
    setShowSlashMenu(false);

    const newCursor = slashPosition.start + replacement.length;
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    }, 10);
  }, [content, slashPosition]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文 IME 拼音输入期间按 Enter/Space 选词不触发任何补全或发送，增加 keyCode 229 兜底
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
      return;
    }

    // 1. 斜杠命令浮层处于打开状态
    if (showSlashMenu) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
        const el = textareaRef.current;
        if (el) {
          dismissedSlashRef.current = {
            text: el.value,
            cursor: el.selectionStart,
          };
        }
        return;
      }

      if (isMultiTarget || loadingCommands || Boolean(commandsError)) {
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          return;
        }
      } else if (filteredCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashIndex((prev) => (prev + 1) % filteredCommands.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const selected = filteredCommands[slashIndex];
          if (selected) {
            insertSlashCommand(selected);
          }
          return;
        }
      } else {
        // 过滤无结果时，禁止 Enter 意外提交消息
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          return;
        }
      }
    }

    // 2. 提及下拉菜单处于打开状态
    if (showMentions && filteredBots.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % filteredBots.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + filteredBots.length) % filteredBots.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = filteredBots[mentionIndex];
        if (selected) {
          insertMention(selected);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }

    // 3. 编辑态按 Esc 取消编辑（补全浮层未打开时）
    if (e.key === 'Escape' && editingMessage) {
      e.preventDefault();
      cancelEditing();
      return;
    }

    // 4. Ctrl+Enter / Command+Enter 发送消息（编辑态下为提交编辑）；普通 Enter 保持默认换行
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
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

  // 上传单个文件为会话产物并加入待发送附件列表；上传失败以输入框 notice 提示
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const sessionIdForUpload = currentSessionIdRef.current;
      if (!sessionIdForUpload) {
        setValidationNotice('当前无有效会话，无法上传附件');
        return;
      }
      const list = Array.from(files);
      if (list.length === 0) return;

      const { generation: taskGen } = startUploadTask(uploadTrackerRef.current);
      setUploadingCount(uploadTrackerRef.current.activeCount);

      try {
        for (const file of list) {
          // 客户端大小预检：超限跳过该文件并提示，不读取进内存也不上传
          const sizeError = validateUploadFile(file);
          if (sizeError) {
            setValidationNotice(sizeError);
            continue;
          }

          const contentBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result;
              if (typeof result !== 'string') {
                reject(new Error('读取文件失败'));
                return;
              }
              // dataURL 去掉 "data:*;base64," 前缀，仅保留 Base64 载荷
              const idx = result.indexOf(',');
              resolve(idx >= 0 ? result.slice(idx + 1) : result);
            };
            reader.onerror = () => reject(new Error('读取文件失败'));
            reader.readAsDataURL(file);
          });

          // 上传前再检查一次会话与 generation 是否有效
          if (
            !isUploadResultValid(
              taskGen,
              uploadTrackerRef.current.generation,
              sessionIdForUpload,
              currentSessionIdRef.current
            )
          ) {
            return;
          }

          const uploaded = await api.uploadArtifact(sessionIdForUpload, {
            filename: file.name,
            mimeType: file.type || undefined,
            contentBase64,
          });

          // 防竞态：上传期间切换会话（或切走再切回 ABA）则丢弃结果
          if (
            !isUploadResultValid(
              taskGen,
              uploadTrackerRef.current.generation,
              sessionIdForUpload,
              currentSessionIdRef.current
            )
          ) {
            return;
          }

          setPendingAttachments((prev) => [
            ...prev,
            {
              id: uploaded.id,
              filename: uploaded.filename,
              mimeType: uploaded.mimeType || file.type || 'application/octet-stream',
              sizeBytes: uploaded.sizeBytes ?? file.size,
              url: uploaded.url,
            },
          ]);
        }
      } catch (err: any) {
        if (
          isUploadResultValid(
            taskGen,
            uploadTrackerRef.current.generation,
            sessionIdForUpload,
            currentSessionIdRef.current
          )
        ) {
          setValidationNotice(err?.message || '附件上传失败，请重试');
        }
      } finally {
        const { valid, activeCount } = finishUploadTask(uploadTrackerRef.current, taskGen);
        if (valid) {
          setUploadingCount(activeCount);
        }
      }
    },
    []
  );

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
      setShowMentions(false);
      setShowSlashMenu(false);
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
    setShowMentions(false);
    setShowSlashMenu(false);
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

  // 当前命令目标 BOT 名称
  const targetBotName = slashTargetBot?.name || (slashTargetBot as any)?.id || leadBotId || '主导智能体';

  const getSourceBadge = (source: ChatCommand['source']) => {
    switch (source) {
      case 'skill':
        return (
          <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 border border-purple-200/50 dark:border-purple-800/50">
            技能
          </span>
        );
      case 'prompt':
        return (
          <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200/50 dark:border-blue-800/50">
            提示词
          </span>
        );
      case 'extension':
        return (
          <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-200/50 dark:border-amber-800/50">
            扩展
          </span>
        );
      default:
        return null;
    }
  };

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
    <div className="chat-input-container relative border-t border-zinc-200/80 dark:border-zinc-800/80 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-xs p-2.5 sm:p-3 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
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
      {showSlashMenu && (
        <div
          ref={slashDropdownRef}
          id="slash-commands-listbox"
          className="absolute bottom-full left-3 right-3 sm:left-4 sm:max-w-md mb-2 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden z-30 max-h-60 sm:max-h-72 flex flex-col animate-in fade-in slide-in-from-bottom-2"
          role="listbox"
          aria-label="斜杠命令列表"
        >
          {/* 顶栏元信息 */}
          <div className="px-3 py-2 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between text-xs shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <Terminal className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
              <span className="font-semibold text-zinc-800 dark:text-zinc-200 shrink-0">命令</span>
              <span className="text-zinc-300 dark:text-zinc-600 shrink-0">·</span>
              {isMultiTarget ? (
                <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium truncate">
                  不支持多目标
                </span>
              ) : (
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate flex items-center gap-1">
                  <span>作用于</span>
                  <span className="font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                    {targetBotName}
                  </span>
                  {slashTargetBot && 'id' in slashTargetBot && (
                    <span className="font-mono text-zinc-400 dark:text-zinc-500 text-[11px]">
                      @{slashTargetBot.id}
                    </span>
                  )}
                </span>
              )}
            </div>

            {!isMultiTarget && !loadingCommands && !commandsError && (
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono shrink-0 ml-2">
                共 {filteredCommands.length} 个
              </span>
            )}
          </div>

          {/* 浮层内容区域 */}
          <div className="p-1 space-y-0.5 overflow-y-auto flex-1">
            {isMultiTarget ? (
              <div className="p-3 text-xs text-amber-700 dark:text-amber-400 bg-amber-50/70 dark:bg-amber-950/30 rounded-lg flex items-start gap-2 m-1">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <div className="leading-relaxed">
                  <div className="font-semibold">不支持多目标命令</div>
                  <div className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-0.5">
                    斜杠命令仅支持单一目标。请仅前置单个 @BOT，或直接使用 / 作用于主导智能体。
                  </div>
                </div>
              </div>
            ) : loadingCommands ? (
              <div className="p-4 flex items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <Loader2 className="w-4 h-4 animate-spin-fast text-blue-600 dark:text-blue-400" />
                <span>正在加载命令列表...</span>
              </div>
            ) : commandsError ? (
              <div className="p-3 text-xs text-center space-y-2">
                <div className="text-rose-500 dark:text-rose-400 font-medium">
                  {commandsError}
                </div>
                {activeTargetBotIdRef.current && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      if (activeTargetBotIdRef.current) {
                        fetchCommands(activeTargetBotIdRef.current);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 cursor-pointer transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>重试</span>
                  </button>
                )}
              </div>
            ) : commands.length === 0 ? (
              <div className="p-4 text-xs text-center text-zinc-400 dark:text-zinc-500">
                当前智能体暂无可调用的命令
              </div>
            ) : filteredCommands.length === 0 ? (
              <div className="p-4 text-xs text-center text-zinc-400 dark:text-zinc-500">
                未找到匹配 &ldquo;{slashQuery}&rdquo; 的命令
              </div>
            ) : (
              filteredCommands.map((cmd, index) => {
                const isSelected = index === slashIndex;
                return (
                  <button
                    key={`${cmd.source}-${cmd.name}`}
                    id={`slash-cmd-${cmd.name}`}
                    type="button"
                    onClick={() => insertSlashCommand(cmd)}
                    onMouseEnter={() => setSlashIndex(index)}
                    ref={(el) => {
                      slashItemRefs.current[index] = el;
                    }}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-200'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                    }`}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate">
                          /{cmd.name}
                        </span>
                        {cmd.argumentHint && (
                          <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                            {cmd.argumentHint}
                          </span>
                        )}
                      </div>
                      <div className="shrink-0">
                        {getSourceBadge(cmd.source)}
                      </div>
                    </div>
                    {cmd.description && (
                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-1 mt-0.5">
                        {cmd.description}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* 提及选择浮层 */}
      {showMentions && filteredBots.length > 0 && (
        <div
          ref={mentionDropdownRef}
          id="mention-listbox"
          className="absolute bottom-full left-3 right-3 sm:left-4 sm:max-w-sm mb-2 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden z-30 max-h-56 overflow-y-auto animate-in fade-in slide-in-from-bottom-2"
          role="listbox"
          aria-label="选择提及成员"
        >
          <div className="px-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-100 dark:border-zinc-800 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <AtSign className="w-3 h-3 text-blue-500 dark:text-blue-400" />
              <span>提及成员</span>
            </span>
            <span className="text-zinc-400 dark:text-zinc-500 font-normal">共 {filteredBots.length} 个</span>
          </div>

          <div className="p-1 space-y-0.5">
            {filteredBots.map((bot, index) => {
              const node = nodeMap.get(bot.nodeId);
              const isSelected = index === mentionIndex;

              return (
                <button
                  key={bot.id}
                  id={`mention-bot-${bot.id}`}
                  type="button"
                  onClick={() => insertMention(bot)}
                  onMouseEnter={() => setMentionIndex(index)}
                  ref={(el) => {
                    mentionItemRefs.current[index] = el;
                  }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-200'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                  }`}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div className="flex items-center gap-2 truncate">
                    <div
                      className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${
                        isSelected
                          ? 'bg-blue-600 text-white'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
                      }`}
                    >
                      <Bot className="w-3 h-3" />
                    </div>
                    <span className="font-semibold text-xs truncate text-zinc-900 dark:text-zinc-100">{bot.name}</span>
                    <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">@{bot.id}</span>
                  </div>

                  {node && (
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono truncate max-w-[100px] shrink-0">
                      {node.name}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 现代悬浮胶囊输入框 */}
      <div className="max-w-4xl mx-auto">
        {/* 快捷协作胶囊栏 (Workflow Quick Pills) */}
        {showWorkflowPills && (
          <div className="flex items-center gap-1.5 mb-1.5 overflow-x-auto no-scrollbar py-0.5">
            <button
              type="button"
              onClick={() => handleInsertWorkflowPill('@all ')}
              className="h-6 px-2 text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-md transition-colors whitespace-nowrap cursor-pointer flex items-center gap-1 shrink-0"
              title="插入各自盲评编排 (@all )"
            >
              <span>💡 各自盲评</span>
            </button>
            <button
              type="button"
              onClick={() => handleInsertWorkflowPill(relayPillText)}
              className="h-6 px-2 text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-md transition-colors whitespace-nowrap cursor-pointer flex items-center gap-1 shrink-0"
              title={`插入顺序接力 (${relayPillText})`}
            >
              <span>🔗 顺序接力</span>
            </button>
            <button
              type="button"
              onClick={() => handleInsertWorkflowPill(refinePillText)}
              className="h-6 px-2 text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-md transition-colors whitespace-nowrap cursor-pointer flex items-center gap-1 shrink-0"
              title={`插入交叉打磨 (${refinePillText})`}
            >
              <span>⚖️ 交叉打磨</span>
            </button>
            <button
              type="button"
              onClick={() => handleInsertWorkflowPill(whisperPillText)}
              className="h-6 px-2 text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-md transition-colors whitespace-nowrap cursor-pointer flex items-center gap-1 shrink-0"
              title={`插入耳语协商 (${whisperPillText})`}
            >
              <span>🤫 耳语协商</span>
            </button>
          </div>
        )}

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

        <div className="relative flex items-center gap-2 bg-zinc-50 dark:bg-zinc-900 border border-zinc-300/80 dark:border-zinc-700/80 rounded-2xl p-1.5 sm:p-2 focus-within:bg-white dark:focus-within:bg-zinc-900 focus-within:border-zinc-400 dark:focus-within:border-zinc-600 focus-within:ring-2 focus-within:ring-zinc-100 dark:focus-within:ring-zinc-800 transition-all shadow-xs">
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
              if (dismissedSlashRef.current && dismissedSlashRef.current.text !== e.target.value) {
                dismissedSlashRef.current = null;
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
                ? '编辑消息，Ctrl+Enter 保存，Esc 取消...'
                : '输入 / 命令，@ 提及成员...'
            }
            rows={1}
            disabled={disabled || sending}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={showSlashMenu || showMentions}
            aria-controls={
              showSlashMenu
                ? 'slash-commands-listbox'
                : showMentions
                ? 'mention-listbox'
                : undefined
            }
            aria-activedescendant={
              showSlashMenu && filteredCommands[slashIndex]
                ? `slash-cmd-${filteredCommands[slashIndex].name}`
                : showMentions && filteredBots[mentionIndex]
                ? `mention-bot-${filteredBots[mentionIndex].id}`
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
              title="保存并重新生成（Ctrl+Enter）"
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
              title="发送消息（Ctrl+Enter）"
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

        {/* 仅在桌面端显示的极简小提示 */}
        <div className="hidden sm:flex items-center justify-between text-[11px] text-zinc-400 dark:text-zinc-500 px-2 mt-1">
          <span>支持 / 调用命令与技能</span>
          <span>Ctrl+Enter 发送 · Enter 换行</span>
        </div>
      </div>
    </div>
  );
};
