import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfig } from '@botd/protocol';

interface UseMentionMenuParams {
  /** 当前输入框草稿（用于补全插入） */
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  memberBots: BotConfig[];
  isSubagentSession: boolean;
}

/**
 * @ 提及浮层：触发检测、成员过滤、键盘导航与提及插入。
 */
export function useMentionMenu({ content, setContent, textareaRef, memberBots, isSubagentSession }: UseMentionMenuParams) {
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionPosition, setMentionPosition] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });

  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const mentionItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 过滤成员 BOT
  const filteredBots = useMemo(() => {
    if (!mentionQuery) return memberBots;
    const q = mentionQuery.toLowerCase();
    return memberBots.filter(
      (bot) => bot.id.toLowerCase().includes(q) || bot.name.toLowerCase().includes(q)
    );
  }, [memberBots, mentionQuery]);

  const insertMention = useCallback((bot: BotConfig) => {
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
  }, [content, mentionPosition, setContent, textareaRef]);

  /**
   * @ 触发检测（checkTriggers 的提及分支）：命中时开启浮层，未命中时关闭。
   * 子代理会话中禁止继续 @ 其他智能体。
   */
  const checkMentionTrigger = useCallback((text: string, cursor: number) => {
    const textBefore = text.slice(0, cursor);
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
  }, [isSubagentSession, memberBots.length]);

  /**
   * 浮层打开时的键盘处理。返回 true 表示事件已消费。
   */
  const handleMentionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showMentions || filteredBots.length === 0) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % filteredBots.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + filteredBots.length) % filteredBots.length);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = filteredBots[mentionIndex];
        if (selected) {
          insertMention(selected);
        }
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentions(false);
        return true;
      }
      return false;
    },
    [showMentions, filteredBots, mentionIndex, insertMention]
  );

  // 提及浮层高亮项滚动至可见
  useEffect(() => {
    if (showMentions && filteredBots.length > 0) {
      const el = mentionItemRefs.current[mentionIndex];
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [mentionIndex, showMentions, filteredBots.length]);

  return {
    // state
    showMentions,
    setShowMentions,
    filteredBots,
    mentionIndex,
    setMentionIndex,
    // refs
    mentionDropdownRef,
    mentionItemRefs,
    // actions
    insertMention,
    checkMentionTrigger,
    handleMentionKeyDown,
  };
}
