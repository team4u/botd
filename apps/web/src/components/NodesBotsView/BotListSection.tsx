import React from 'react';
import { Bot, Plus, Settings, Trash2, Loader2, PowerOff, Wrench, Blocks } from 'lucide-react';
import type { BotConfig, NodeWithBots } from '@botd/protocol';
import { formatThinkingLevel, getShortModelId, groupNodeBots } from './helpers';

interface BotListSectionProps {
  node: NodeWithBots;
  isOnline: boolean;
  deletingBotId: string | null;
  onOpenCreateBot: (node: NodeWithBots) => void;
  onOpenCreateSubagent: (node: NodeWithBots, parentBot: BotConfig) => void;
  onOpenEditBot: (node: NodeWithBots, bot: BotConfig, tab?: 'basic' | 'system' | 'memory') => void;
  onDeleteBot: (bot: BotConfig) => void;
}

/** 节点卡片内的智能体列表：主 BOT 卡片 + 子代理行 + 独立/无归属子代理。 */
export const BotListSection: React.FC<BotListSectionProps> = ({
  node,
  isOnline,
  deletingBotId,
  onOpenCreateBot,
  onOpenCreateSubagent,
  onOpenEditBot,
  onDeleteBot,
}) => {
  const nodeBots = node.bots || [];

  return (
    <div className="border-t border-zinc-100 dark:border-zinc-800/60">
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-50/70 dark:bg-zinc-900/50">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
          <span>智能体 ({nodeBots.length})</span>
        </span>
        <button
          type="button"
          onClick={() => onOpenCreateBot(node)}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200/80 dark:border-zinc-800/80 cursor-pointer"
          title="在该节点上新建独立主 BOT（独立工作空间，Hub 权威存储）"
        >
          <Plus className="w-3 h-3" />
          <span>新建主 BOT</span>
        </button>
      </div>

      {nodeBots.length === 0 ? (
        <p className="px-4 py-4 text-xs text-zinc-400 dark:text-zinc-500">
          暂无智能体。点击右上角「新建主 BOT」创建（配置存于 Hub，节点离线也可管理）。
        </p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60 border-t border-zinc-100 dark:border-zinc-800/60">
          {(() => {
            const { primaryBots, subagentMap, orphanSubagents } = groupNodeBots(nodeBots);

            return (
              <>
                {primaryBots.map((bot) => {
                  const isDeleting = deletingBotId === bot.id;
                  const shortModel = getShortModelId(bot.modelId);
                  const thinkingText = formatThinkingLevel(bot.thinkingLevel);
                  const subagents = subagentMap.get(bot.id) || [];

                  // Collect enabled skills and extensions compactly
                  const enabledItems = [
                    ...(bot.enabledSkills || []).map((s) => ({ type: 'skill' as const, name: s })),
                    ...(bot.enabledExtensions || []).map((e) => ({ type: 'ext' as const, name: e })),
                  ];

                  return (
                    <div key={bot.id} className="p-4 flex flex-col justify-between gap-3 min-w-0">
                      {/* Bot identity & + 子代理 action */}
                      <div className="flex items-start justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                              isOnline
                                ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200/70 dark:border-zinc-700/70'
                                : 'bg-zinc-50 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-600 border-zinc-200/70 dark:border-zinc-800/70'
                            }`}
                          >
                            <Bot className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div
                              className={`font-semibold text-sm truncate ${
                                isOnline
                                  ? 'text-zinc-900 dark:text-zinc-100'
                                  : 'text-zinc-500 dark:text-zinc-400'
                              }`}
                            >
                              {bot.name}
                            </div>
                            <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 block truncate">
                              @{bot.id}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => onOpenEditBot(node, bot)}
                            className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                            title="智能体设置"
                            aria-label={`设置智能体 ${bot.name}`}
                          >
                            <Settings className="w-3.5 h-3.5" />
                          </button>
                          {!isOnline && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">
                              <PowerOff className="w-2.5 h-2.5" />
                              <span>离线</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Description */}
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-2 min-h-[32px] leading-relaxed">
                        {bot.description || '暂无角色描述'}
                      </p>

                      {/* Metadata chips */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="font-mono text-[11px] text-zinc-700 bg-zinc-100 dark:text-zinc-300 dark:bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-200/60 dark:border-zinc-700/60 truncate max-w-[140px]"
                          title={bot.modelId}
                        >
                          {shortModel}
                        </span>

                        {thinkingText && (
                          <span className="text-[11px] text-zinc-600 bg-zinc-100 dark:text-zinc-400 dark:bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 font-medium">
                            {thinkingText}
                          </span>
                        )}

                        {enabledItems.slice(0, 2).map((item) => (
                          <span
                            key={`${item.type}-${item.name}`}
                            className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-600 bg-zinc-50 dark:text-zinc-400 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800/80 px-1.5 py-0.5 rounded truncate max-w-[110px]"
                            title={item.type === 'skill' ? `技能: ${item.name}` : `扩展: ${item.name}`}
                          >
                            {item.type === 'skill' ? (
                              <Wrench className="w-2.5 h-2.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                            ) : (
                              <Blocks className="w-2.5 h-2.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                            )}
                            <span className="truncate">{item.name}</span>
                          </span>
                        ))}
                        {enabledItems.length > 2 && (
                          <span className="text-[11px] font-mono text-zinc-400 bg-zinc-50 dark:text-zinc-500 dark:bg-zinc-900 px-1 py-0.5 rounded border border-zinc-200/60 dark:border-zinc-800/60">
                            +{enabledItems.length - 2}
                          </span>
                        )}
                      </div>

                      {/* Actions: read-only while the owning node is offline */}
                      <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            type="button"
                            onClick={() => onOpenEditBot(node, bot)}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200/80 dark:border-zinc-800/80 cursor-pointer"
                            title="智能体设置"
                          >
                            <Settings className="w-3 h-3" />
                            <span>设置</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => onOpenCreateSubagent(node, bot)}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200/80 dark:border-zinc-800/80 cursor-pointer"
                            title="在该主 BOT 下新建共享工作区的子代理"
                          >
                            <Plus className="w-3 h-3 text-zinc-500" />
                            <span>新建子代理</span>
                          </button>
                        </div>

                        <button
                          onClick={() => onDeleteBot(bot)}
                          disabled={isDeleting}
                          className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:text-zinc-500 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          title="删除该智能体"
                          aria-label="删除"
                        >
                          {isDeleting ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-rose-500 dark:text-rose-400" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>

                      {/* Subagents list underneath parent bot */}
                      {subagents.length > 0 && (
                        <div className="mt-2 pt-2.5 border-t border-dashed border-zinc-200 dark:border-zinc-800 space-y-1.5">
                          <div className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                            子代理 ({subagents.length})
                          </div>
                          {subagents.map((sub) => (
                            <SubagentRow
                              key={sub.id}
                              node={node}
                              sub={sub}
                              isDeleting={deletingBotId === sub.id}
                              onOpenEditBot={onOpenEditBot}
                              onDeleteBot={onDeleteBot}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {orphanSubagents.length > 0 && (
                  <div className="col-span-full p-4 border-t border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/50 dark:bg-zinc-900/30">
                    <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-2">
                      独立/无归属子代理 ({orphanSubagents.length})
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {orphanSubagents.map((sub) => (
                        <div
                          key={sub.id}
                          className="p-3 bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between gap-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="min-w-0">
                              <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate block">
                                {sub.name}
                              </span>
                              <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate block">
                                @{sub.id} (隶属 @{sub.parentBotId})
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => onOpenEditBot(node, sub)}
                              className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                              title="子代理设置"
                              aria-label={`子代理 ${sub.name} 设置`}
                            >
                              <Settings className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteBot(sub)}
                              disabled={deletingBotId === sub.id}
                              className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:text-zinc-500 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              title="删除子代理"
                              aria-label={`删除子代理 ${sub.name}`}
                            >
                              {deletingBotId === sub.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-rose-500" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
};

interface SubagentRowProps {
  node: NodeWithBots;
  sub: BotConfig;
  isDeleting: boolean;
  onOpenEditBot: (node: NodeWithBots, bot: BotConfig, tab?: 'basic' | 'system' | 'memory') => void;
  onDeleteBot: (bot: BotConfig) => void;
}

/** 主 BOT 卡片下挂的子代理行 */
const SubagentRow: React.FC<SubagentRowProps> = ({ node, sub, isDeleting, onOpenEditBot, onDeleteBot }) => (
  <div className="p-2 bg-zinc-50/80 dark:bg-zinc-900/60 rounded-lg border border-zinc-200/70 dark:border-zinc-800/70 flex items-center justify-between gap-2">
    <div className="flex items-center gap-2 min-w-0 flex-wrap">
      <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate">{sub.name}</span>
      <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate">@{sub.id}</span>

      {/* Capability badges */}
      <div className="flex items-center gap-1 shrink-0 flex-wrap">
        {sub.inheritModel ? (
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 font-medium">
            跟随主模型
          </span>
        ) : (
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
            {getShortModelId(sub.modelId)}
          </span>
        )}
        {sub.toolScope === 'readonly' && (
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 font-medium">
            只读
          </span>
        )}
      </div>
    </div>

    {/* Quick actions for subagent */}
    <div className="flex items-center gap-1 shrink-0">
      <button
        type="button"
        onClick={() => onOpenEditBot(node, sub)}
        className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
        title="子代理设置"
        aria-label={`子代理 ${sub.name} 设置`}
      >
        <Settings className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={() => onDeleteBot(sub)}
        disabled={isDeleting}
        className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:text-zinc-500 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        title="删除子代理"
        aria-label={`删除子代理 ${sub.name}`}
      >
        {isDeleting ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-rose-500" />
        ) : (
          <Trash2 className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  </div>
);
