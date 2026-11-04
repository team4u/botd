import React from 'react';
import { AtSign, Bot } from 'lucide-react';
import type { BotConfig, NodeRecord } from '@botd/protocol';

interface MentionMenuDropdownProps {
  nodeMap: Map<string, NodeRecord>;
  filteredBots: BotConfig[];
  mentionIndex: number;
  setMentionIndex: (index: number) => void;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  insertMention: (bot: BotConfig) => void;
}

/** 提及成员选择浮层（受控展示，触发与键盘逻辑在 useMentionMenu） */
export const MentionMenuDropdown: React.FC<MentionMenuDropdownProps> = ({
  nodeMap,
  filteredBots,
  mentionIndex,
  setMentionIndex,
  dropdownRef,
  itemRefs,
  insertMention,
}) => (
  <div
    ref={dropdownRef}
    id="mention-listbox"
    className="absolute bottom-full left-3 right-3 sm:left-4 sm:max-w-sm mb-2 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden z-30 max-h-56 max-w-[calc(100vw-1.5rem)] overflow-y-auto animate-in fade-in slide-in-from-bottom-2"
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
              itemRefs.current[index] = el;
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
              {bot.parentBotId && (
                <span className="text-zinc-400 dark:text-zinc-600 font-mono text-xs shrink-0 select-none">
                  └─
                </span>
              )}
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
              {bot.parentBotId && (
                <span className="text-[10px] px-1 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 shrink-0">
                  子代理
                </span>
              )}
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
);
