import { useState } from 'react';
import { PenLine } from 'lucide-react';
import type { BotConfig } from '@botd/protocol';

/**
 * 将 BOT 列表按树序重排：主 BOT 保持原有相对顺序，其角色分身紧随其后。
 * 孤儿分身（parentBotId 不在列表中）视作顶层。防御性去重，保持稳定顺序。
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
    if (bot.parentBotId && ids.has(bot.parentBotId)) continue; // 分身随主 BOT 输出
    push(bot);
    for (const child of childrenOf.get(bot.id) || []) push(child);
  }
  for (const bot of bots) push(bot); // 兜底：异常数据也不丢项
  return result;
}

interface MemberOptionRowProps {
  bot: BotConfig;
  nodeMap: Map<string, { name: string; status: 'online' | 'offline' }>;
  isLead?: boolean;
}

/**
 * 群成员勾选行：与输入框 @ 提及下拉同一套视觉语言。
 * 单行只保留 名字 +（└─ 分身徽章）+ @id +（主持人徽章），右缘模型徽章；
 * 节点名折叠为 title 提示，杜绝撑破容器。
 */
export function MemberOptionRow({ bot, nodeMap, isLead }: MemberOptionRowProps) {
  const node = nodeMap.get(bot.nodeId);
  const title = `${bot.name} (@${bot.id})${node ? ` · ${node.name}` : ''} · ${bot.modelId}`;
  return (
    <div title={title} className="flex items-center justify-between gap-2 min-w-0 flex-1">
      <div className="flex items-center gap-1.5 min-w-0">
        {bot.parentBotId && (
          <span className="text-zinc-400 dark:text-zinc-600 font-mono text-xs shrink-0 select-none" aria-hidden="true">
            └─
          </span>
        )}
        <span className="font-semibold text-xs truncate text-zinc-900 dark:text-zinc-100">{bot.name}</span>
        {bot.parentBotId && (
          <span className="text-[10px] px-1 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 shrink-0">
            分身
          </span>
        )}
        <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate">@{bot.id}</span>
        {isLead && (
          <span className="px-1.5 py-0.2 bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 text-[11px] font-semibold rounded shrink-0">
            主持人
          </span>
        )}
      </div>
      <span className="font-mono text-[11px] bg-zinc-100 dark:bg-zinc-800 px-1 py-0.2 rounded text-zinc-500 dark:text-zinc-400 max-w-[110px] truncate shrink-0">
        {bot.modelId}
      </span>
    </div>
  );
}

interface SelectedMembersChipsProps {
  /** 已选成员（含主持人），展示顺序即传入顺序 */
  bots: BotConfig[];
  roles: Record<string, string>;
  onRoleChange: (botId: string, role: string) => void;
  leadBotId?: string;
}

/**
 * 已选成员 chips 区：头衔低频，不进列表行。
 * 点击 chip 展开唯一的行内头衔编辑器；再次点击或切换 chip 收起/切换。
 */
export function SelectedMembersChips({ bots, roles, onRoleChange, leadBotId }: SelectedMembersChipsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  if (bots.length === 0) return null;

  const editingBot = bots.find((b) => b.id === editingId) || null;

  return (
    <div className="mt-2">
      <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-1.5">已选成员 · 点击设置本群头衔（可选）</div>
      <div className="flex flex-wrap gap-1.5">
        {bots.map((bot) => {
          const role = roles[bot.id]?.trim();
          const isEditing = editingId === bot.id;
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => setEditingId(isEditing ? null : bot.id)}
              title={role ? `${bot.name} · ${role}` : `${bot.name}：点击设置头衔`}
              className={`h-7 px-2 inline-flex items-center gap-1 rounded-lg border text-xs transition-colors cursor-pointer max-w-full ${
                isEditing
                  ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                  : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-700'
              }`}
            >
              <span className="truncate font-medium">{bot.name}</span>
              {leadBotId === bot.id && (
                <span className="text-[10px] px-1 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 shrink-0">
                  主持
                </span>
              )}
              {role && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400 truncate max-w-[120px]">{role}</span>
              )}
            </button>
          );
        })}
      </div>

      {editingBot && (
        <div className="mt-2 flex items-center gap-2 animate-in fade-in">
          <PenLine className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 truncate max-w-[120px]">
            {editingBot.name}
          </span>
          <input
            key={editingBot.id}
            type="text"
            autoFocus
            value={roles[editingBot.id] || ''}
            onChange={(e) => onRoleChange(editingBot.id, e.target.value)}
            placeholder="本群头衔（如：初稿主笔 / 挑刺审稿）"
            className="flex-1 min-w-0 h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>
      )}
    </div>
  );
}
