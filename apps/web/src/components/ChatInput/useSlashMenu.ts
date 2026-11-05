import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfig, ChatCommand } from '@botd/protocol';
import { api } from '../../api';
import { HUB_ROUTER_BOT_ID } from '../../session-space';
import { BUILTIN_SESSION_COMMANDS, parseSlashTrigger, type ParsedSlashTrigger } from './slash';

interface UseSlashMenuParams {
  /** 当前输入框草稿（用于补全插入） */
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  leadBotId?: string;
  memberBots: BotConfig[];
  botMap?: Map<string, BotConfig>;
}

/**
 * 斜杠命令浮层：触发检测、命令目录拉取（防竞态）、键盘导航与补全插入。
 */
export function useSlashMenu({ content, setContent, textareaRef, leadBotId, memberBots, botMap }: UseSlashMenuParams) {
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

  const slashDropdownRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const dismissedSlashRef = useRef<{ text: string; cursor: number } | null>(null);
  const activeTargetBotIdRef = useRef<string | null>(null);
  const fetchRequestIdRef = useRef<number>(0);

  const allCommands = useMemo(() => {
    const existingNames = new Set(commands.map((c) => c.name));
    const builtins = BUILTIN_SESSION_COMMANDS.filter((b) => !existingNames.has(b.name));
    return [...builtins, ...commands];
  }, [commands]);

  // 过滤斜杠命令（统一搜索 skill/prompt/extension 的 name 与 description）
  const filteredCommands = useMemo(() => {
    if (!slashQuery) return allCommands;
    const q = slashQuery.toLowerCase();
    return allCommands.filter((cmd) => {
      const nameMatch = cmd.name.toLowerCase().includes(q);
      const descMatch = cmd.description ? cmd.description.toLowerCase().includes(q) : false;
      return nameMatch || descMatch;
    });
  }, [allCommands, slashQuery]);

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

  // 切换会话时重置浮层状态与请求版本（由 ChatInput 的会话重置 effect 调用）
  const resetOnSessionChange = useCallback(() => {
    fetchRequestIdRef.current++;
    activeTargetBotIdRef.current = null;
    setCommands([]);
    setCommandsError(null);
    setLoadingCommands(false);
    setIsMultiTarget(false);
    setSlashTargetBot(null);
    setShowSlashMenu(false);
    dismissedSlashRef.current = null;
  }, []);

  // 当搜索词变化时重置选中的命令高亮项
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const closeSlashMenu = useCallback(() => {
    setShowSlashMenu(false);
  }, []);

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
  }, [content, slashPosition, setContent, textareaRef]);

  /**
   * 斜杠触发检测（checkTriggers 的斜杠分支）：命中时开启/更新浮层并返回 true，
   * 未命中时关闭浮层并返回 false（由调用方继续做 @ 检测）。
   */
  const checkSlashTrigger = useCallback(
    (text: string, cursor: number): boolean => {
      const textBefore = text.slice(0, cursor);
      const slashMatch: ParsedSlashTrigger | null = parseSlashTrigger(textBefore);
      if (!slashMatch) {
        setShowSlashMenu(false);
        return false;
      }

      // 若用户曾按 Esc 主动关闭，且内容和光标未发生位移，则不立即重开
      if (
        dismissedSlashRef.current &&
        dismissedSlashRef.current.text === text &&
        dismissedSlashRef.current.cursor === cursor
      ) {
        return true;
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
        return true;
      }

      const hasSpecificBot = slashMatch.targetBotIds.length === 1;
      const targetId = hasSpecificBot ? slashMatch.targetBotIds[0] : (leadBotId || '');

      // 系统内置中枢总管（hub-router）为合法斜杠目标：总管会话中输入 / 直接打开命令浮层
      const isHubRouterTarget = targetId === HUB_ROUTER_BOT_ID;

      // 仅允许限制为 memberBots 或 leadBotId 或有效 bot
      const isMember =
        memberBots.some((b) => b.id === targetId) ||
        targetId === leadBotId ||
        isHubRouterTarget ||
        Boolean(botMap?.has(targetId));

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
        return true;
      }

      const target =
        memberBots.find((b) => b.id === targetId) ||
        botMap?.get(targetId) ||
        (isHubRouterTarget ? { id: HUB_ROUTER_BOT_ID, name: '中枢总管' } : undefined) ||
        (targetId === leadBotId && botMap && leadBotId ? botMap.get(leadBotId) : undefined) ||
        (targetId ? { id: targetId, name: targetId } : null);

      setSlashTargetBot(target);
      setSlashQuery(slashMatch.query);
      setSlashPosition({ start: slashMatch.slashIndex, end: cursor });
      setShowSlashMenu(true);

      // 仅在菜单开启或切换目标 BOT 时拉取目录，避免重复与永不过期；
      // hub-router 为前端虚拟身份，无命令目录，仅展示内建会话命令（/new /clear /compact）
      if (!showSlashMenu || activeTargetBotIdRef.current !== targetId) {
        if (targetId && targetId !== HUB_ROUTER_BOT_ID) {
          fetchCommands(targetId);
        } else if (targetId === HUB_ROUTER_BOT_ID) {
          fetchRequestIdRef.current++;
          activeTargetBotIdRef.current = HUB_ROUTER_BOT_ID;
          setCommands([]);
          setSlashIndex(0);
          setLoadingCommands(false);
          setCommandsError(null);
        } else {
          setCommands([]);
          setCommandsError('未找到主导智能体');
        }
      }
      return true;
    },
    [leadBotId, botMap, memberBots, showSlashMenu, fetchCommands]
  );

  /**
   * 浮层打开时的键盘处理（checkTriggers/handleKeyDown 的斜杠分支）。
   * 返回 true 表示事件已消费，调用方不再继续后续按键逻辑。
   */
  const handleSlashKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showSlashMenu) return false;

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
        return true;
      }

      if (isMultiTarget || loadingCommands || Boolean(commandsError)) {
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          return true;
        }
        return false;
      }

      if (filteredCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashIndex((prev) => (prev + 1) % filteredCommands.length);
          return true;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
          return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const selected = filteredCommands[slashIndex];
          if (selected) {
            insertSlashCommand(selected);
          }
          return true;
        }
        return false;
      }

      // 过滤无结果时，禁止 Enter 意外提交消息
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return true;
      }
      return false;
    },
    [showSlashMenu, isMultiTarget, loadingCommands, commandsError, filteredCommands, slashIndex, insertSlashCommand, textareaRef]
  );

  // 当前命令目标 BOT 名称
  const targetBotName = slashTargetBot?.name || (slashTargetBot as any)?.id || leadBotId || '主导智能体';

  return {
    // state
    showSlashMenu,
    slashQuery,
    slashIndex,
    setSlashIndex,
    filteredCommands,
    allCommands,
    loadingCommands,
    commandsError,
    slashTargetBot,
    isMultiTarget,
    targetBotName,
    // refs
    slashDropdownRef,
    slashItemRefs,
    dismissedSlashRef,
    activeTargetBotIdRef,
    // actions
    fetchCommands,
    resetOnSessionChange,
    closeSlashMenu,
    insertSlashCommand,
    checkSlashTrigger,
    handleSlashKeyDown,
  };
}
