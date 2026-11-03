import React, { useEffect } from 'react';
import { Terminal, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import type { BotConfig, ChatCommand } from '@botd/protocol';

export function getSourceBadge(source: ChatCommand['source']) {
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
    case 'builtin':
      return (
        <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800/60 text-zinc-600 dark:text-zinc-400 border border-zinc-200/50 dark:border-zinc-700/50">
          命令
        </span>
      );
    default:
      return null;
  }
}

interface SlashMenuDropdownProps {
  slashQuery: string;
  slashIndex: number;
  setSlashIndex: (index: number) => void;
  filteredCommands: ChatCommand[];
  allCommands: ChatCommand[];
  loadingCommands: boolean;
  commandsError: string | null;
  slashTargetBot: BotConfig | { id: string; name: string } | null;
  isMultiTarget: boolean;
  targetBotName: string;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  activeTargetBotIdRef: React.RefObject<string | null>;
  fetchCommands: (botId: string) => Promise<void>;
  insertSlashCommand: (cmd: ChatCommand) => void;
}

/** 斜杠命令选择浮层（受控展示，触发与键盘逻辑在 useSlashMenu） */
export const SlashMenuDropdown: React.FC<SlashMenuDropdownProps> = ({
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
  dropdownRef,
  itemRefs,
  activeTargetBotIdRef,
  fetchCommands,
  insertSlashCommand,
}) => {
  // 命令浮层高亮项滚动至可见
  useEffect(() => {
    if (filteredCommands.length > 0) {
      const el = itemRefs.current[slashIndex];
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [slashIndex, filteredCommands.length, itemRefs]);

  return (
    <div
      ref={dropdownRef}
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
        ) : allCommands.length === 0 ? (
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
                  itemRefs.current[index] = el;
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
  );
};
