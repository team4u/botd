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
