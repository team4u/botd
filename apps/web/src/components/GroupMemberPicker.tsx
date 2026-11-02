import { useState } from 'react';
import { Crown, PenLine, Check, X } from 'lucide-react';
import type { BotConfig } from '@botd/protocol';

/**
 * 将 BOT 列表按树序重排：主 BOT 保持原有相对顺序，其子代理紧随其后。
 * 孤儿子代理（parentBotId 不在列表中）视作顶层。防御性去重，保持稳定顺序。
 */
export function orderBotsAsTree(bots: BotConfig[]): BotConfig[] {
  const ids = new Set(bots.map((b) => b.id));
  const childrenOf = new Map<string, BotConfig[]>();
  for (const bot of bots) {
    if (bot.parentBotId && ids.has(bot.parentBotId)) {
      const list = childrenOf.get(bot.parentBotId) || [];
      list.push(bot);
      childrenOf.set(bot.parentBotId, list);
    }
  }

  const seen = new Set<string>();
  const result: BotConfig[] = [];
  const push = (bot: BotConfig) => {
    if (seen.has(bot.id)) return;
    seen.add(bot.id);
    result.push(bot);
  };

  for (const bot of bots) {
    if (bot.parentBotId && ids.has(bot.parentBotId)) continue;
    push(bot);
    for (const child of childrenOf.get(bot.id) || []) push(child);
  }
  for (const bot of bots) push(bot);
  return result;
}

export interface GroupMemberSelectionState {
  selectedIds: string[];
  leadBotId: string;
}

/**
 * 切换成员勾选状态（纯函数）：
 * - 勾选：加入 selectedIds；若当前无有效主持人，自动将该成员设为主持人。
 * - 取消勾选：从 selectedIds 移除；若取消的是当前主持人，自动顺延给树序中第一位仍选中的成员。
 */
export function toggleGroupMember(
  treeBots: { id: string }[],
  selectedIds: string[],
  leadBotId: string,
  targetBotId: string
): GroupMemberSelectionState {
  const selectedSet = new Set(selectedIds);
  if (selectedSet.has(targetBotId)) {
    const nextSelected = selectedIds.filter((id) => id !== targetBotId);
    const nextSelectedSet = new Set(nextSelected);
    let nextLead = leadBotId;
    if (leadBotId === targetBotId || !nextSelectedSet.has(leadBotId)) {
      const firstRemaining = treeBots.find((b) => nextSelectedSet.has(b.id));
      nextLead = firstRemaining ? firstRemaining.id : nextSelected[0] || '';
    }
    return { selectedIds: nextSelected, leadBotId: nextLead };
  }

  const nextSelected = [...new Set([...selectedIds, targetBotId])];
  const nextSelectedSet = new Set(nextSelected);
  const nextLead = leadBotId && nextSelectedSet.has(leadBotId) ? leadBotId : targetBotId;
  return { selectedIds: nextSelected, leadBotId: nextLead };
}

/**
 * 指定主持人（纯函数）：若目标成员尚未勾选，自动勾选入群。
 */
export function selectGroupLead(
  selectedIds: string[],
  targetBotId: string
): GroupMemberSelectionState {
  const nextSelected = selectedIds.includes(targetBotId)
    ? selectedIds
    : [...selectedIds, targetBotId];
  return { selectedIds: nextSelected, leadBotId: targetBotId };
}

/**
 * 全选 / 反选群成员（纯函数）：保留不在当前可见 options 中的隐藏 ID，并维护有效主持人。
 */
export function batchSelectGroupMembers(
  treeBots: { id: string }[],
  selectedIds: string[],
  leadBotId: string,
  action: 'selectAll' | 'invert'
): GroupMemberSelectionState {
  const optionIds = new Set(treeBots.map((b) => b.id));
  const selectedSet = new Set(selectedIds);
  const nextVisible = treeBots
    .filter(({ id }) => action === 'selectAll' || !selectedSet.has(id))
    .map(({ id }) => id);
  const hiddenIds = selectedIds.filter((id) => !optionIds.has(id));
  const nextSelected = [...new Set([...nextVisible, ...hiddenIds])];
  const nextSelectedSet = new Set(nextSelected);

  let nextLead = leadBotId;
  if (!nextLead || !nextSelectedSet.has(nextLead)) {
    const first = treeBots.find((b) => nextSelectedSet.has(b.id));
    nextLead = first ? first.id : nextSelected[0] || '';
  }

  return { selectedIds: nextSelected, leadBotId: nextLead };
}

export interface GroupMemberPickerProps {
  label?: string;
  bots: BotConfig[];
  nodeMap: Map<string, { name: string; status: 'online' | 'offline' }>;
  selectedIds: string[];
  leadBotId: string;
  memberRoles: Record<string, string>;
  onChange: (next: GroupMemberSelectionState) => void;
  onRoleChange: (botId: string, role: string) => void;
}

/**
 * 三合一树状群成员选择器：
 * 在同一棵树状花名册中闭环完成「勾选入群 + 指定主持人 + 设置群内头衔」，
 * 视觉对齐对话框 @ 提及菜单，消除多控件割裂与行内输入框撑破问题。
 */
export function GroupMemberPicker({
  label = '参会成员',
  bots,
  nodeMap,
  selectedIds,
  leadBotId,
  memberRoles,
  onChange,
  onRoleChange,
}: GroupMemberPickerProps) {
  const [editingRoleBotId, setEditingRoleBotId] = useState<string | null>(null);

  const treeBots = orderBotsAsTree(bots);
  const selectedSet = new Set(selectedIds);
  const selectedCount = treeBots.filter((b) => selectedSet.has(b.id)).length;
  const leadBot = bots.find((b) => b.id === leadBotId);

  const handleToggle = (botId: string) => {
    const next = toggleGroupMember(treeBots, selectedIds, leadBotId, botId);
    if (!next.selectedIds.includes(botId) && editingRoleBotId === botId) {
      setEditingRoleBotId(null);
    }
    onChange(next);
  };

  const handleSelectLead = (botId: string) => {
    onChange(selectGroupLead(selectedIds, botId));
  };

  const handleSelectAll = () => {
    onChange(batchSelectGroupMembers(treeBots, selectedIds, leadBotId, 'selectAll'));
  };

  const handleInvert = () => {
    const next = batchSelectGroupMembers(treeBots, selectedIds, leadBotId, 'invert');
    if (editingRoleBotId && !next.selectedIds.includes(editingRoleBotId)) {
      setEditingRoleBotId(null);
    }
    onChange(next);
  };

  return (
    <div>
      {/* 顶部标题栏：已选计数 + 当前主持人 + 全选/反选 */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
            {label}（已选 {selectedCount}/{treeBots.length}）
          </span>
          {leadBot ? (
            <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.2 rounded bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200/70 dark:border-amber-800/60">
              <Crown className="w-3 h-3 shrink-0" />
              <span className="truncate max-w-[140px]">主持: {leadBot.name}</span>
            </span>
          ) : (
            <span className="text-[11px] text-rose-500 dark:text-rose-400">未指定主持人</span>
          )}
        </div>

        {treeBots.length > 0 && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={handleSelectAll}
              className="px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md cursor-pointer transition-colors"
            >
              全选
            </button>
            <span className="text-[11px] text-zinc-300 dark:text-zinc-700">|</span>
            <button
              type="button"
              onClick={handleInvert}
              className="px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md cursor-pointer transition-colors"
            >
              反选
            </button>
          </div>
        )}
      </div>

      {/* 树状成员花名册 */}
      {treeBots.length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 bg-zinc-50 dark:bg-zinc-900 p-3 rounded-lg border border-zinc-200 dark:border-zinc-800">
          暂无可选成员
        </p>
      ) : (
        <div className="space-y-1 max-h-60 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-xl p-1.5 bg-zinc-50/50 dark:bg-zinc-900/50">
          {treeBots.map((bot) => {
            const checked = selectedSet.has(bot.id);
            const isLead = checked && bot.id === leadBotId;
            const role = memberRoles[bot.id]?.trim() || '';
            const isEditingRole = checked && editingRoleBotId === bot.id;
            const node = nodeMap.get(bot.nodeId);
            const rowTooltip = `${bot.name} (@${bot.id})${node ? ` · ${node.name}` : ''} · ${bot.modelId}`;

            return (
              <div
                key={bot.id}
                className={`group rounded-lg border px-2.5 py-1.5 transition-colors ${
                  checked
                    ? 'bg-indigo-50/60 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800/80'
                    : 'bg-white dark:bg-zinc-900 border-zinc-200/80 dark:border-zinc-800/80 hover:border-zinc-300 dark:hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  {/* 左区：勾选框 + 树状前缀 + 名字 + 子代理徽章 + @id */}
                  <label
                    title={rowTooltip}
                    className="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleToggle(bot.id)}
                      aria-label={`选择成员 ${bot.name}`}
                      className="rounded border-zinc-300 dark:border-zinc-600 dark:bg-zinc-800 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 shrink-0 cursor-pointer"
                    />
                    {bot.parentBotId && (
                      <span
                        className="text-zinc-400 dark:text-zinc-600 font-mono text-xs shrink-0"
                        aria-hidden="true"
                      >
                        └─
                      </span>
                    )}
                    <span
                      className={`font-semibold text-xs truncate ${
                        checked
                          ? 'text-zinc-900 dark:text-zinc-100'
                          : 'text-zinc-600 dark:text-zinc-400'
                      }`}
                    >
                      {bot.name}
                    </span>
                    {bot.parentBotId && (
                      <span className="text-[10px] px-1 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 shrink-0">
                        子代理
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                      @{bot.id}
                    </span>
                  </label>

                  {/* 右区：头衔胶囊 + 主持人切换 + 模型徽章 */}
                  <div className="flex items-center gap-1 shrink-0">
                    {checked && (
                      <button
                        type="button"
                        onClick={() => setEditingRoleBotId(isEditingRole ? null : bot.id)}
                        title={role ? `本群头衔：${role}（点击修改）` : '设置本群头衔（可选）'}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer max-w-[108px] ${
                          role
                            ? 'bg-indigo-100/80 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-medium'
                            : isEditingRole
                              ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200'
                              : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <PenLine className="w-2.5 h-2.5 shrink-0" />
                        <span className="truncate">{role || '头衔'}</span>
                      </button>
                    )}

                    {isLead ? (
                      <span
                        title="当前群聊主持人（默认由该成员先行响应并统筹分工）"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 text-[11px] font-semibold rounded shrink-0"
                      >
                        <Crown className="w-3 h-3 shrink-0" />
                        <span>主持人</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSelectLead(bot.id)}
                        title={`将 ${bot.name} 设为主持人`}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors cursor-pointer shrink-0"
                      >
                        <Crown className="w-3 h-3 shrink-0" />
                        <span className="hidden sm:inline">设为主持</span>
                      </button>
                    )}

                    <span
                      title={node ? `${node.name} · ${bot.modelId}` : bot.modelId}
                      className="font-mono text-[11px] bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.2 rounded text-zinc-500 dark:text-zinc-400 max-w-[92px] sm:max-w-[110px] truncate shrink-0"
                    >
                      {bot.modelId}
                    </span>
                  </div>
                </div>

                {/* 按需展开的行内头衔编辑栏 */}
                {isEditingRole && (
                  <div className="mt-1.5 pt-1.5 border-t border-indigo-200/60 dark:border-indigo-800/50 flex items-center gap-1.5">
                    <PenLine className="w-3 h-3 text-indigo-500 shrink-0" />
                    <input
                      type="text"
                      autoFocus
                      value={memberRoles[bot.id] || ''}
                      onChange={(e) => onRoleChange(bot.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingRoleBotId(null);
                        }
                      }}
                      placeholder={`设置 ${bot.name} 的本群头衔（如：初稿主笔 / 挑刺审稿）`}
                      className="flex-1 min-w-0 h-7 px-2 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-md text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    {role && (
                      <button
                        type="button"
                        onClick={() => onRoleChange(bot.id, '')}
                        title="清空头衔"
                        className="p-1 text-zinc-400 hover:text-rose-500 rounded cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setEditingRoleBotId(null)}
                      title="完成（Enter）"
                      className="h-7 px-2 text-[11px] font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-md inline-flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <Check className="w-3 h-3" />
                      <span>完成</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
