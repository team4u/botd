import type { BotConfig } from '@botd/protocol';

/** Max chips visible in a collapsed pool before expanding. */
export const POOL_PREVIEW_COUNT = 6;

/**
 * Format uptime duration from startedAt ISO timestamp.
 * <60s -> "Ns"
 * <60m -> "Nm"
 * <24h -> "Nh Mm"
 * >=24h -> "Nd Nh"
 */
export function formatUptime(startedAt?: string): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (diffSec < 60) {
    return `${diffSec}s`;
  }
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return `${mins}m`;
  }
  if (diffSec < 86400) {
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  return `${days}d ${hours}h`;
}

/** Map thinking level to Chinese */
export function formatThinkingLevel(level?: string) {
  if (!level) return null;
  const map: Record<string, string> = {
    low: '轻度思考',
    medium: '标准思考',
    high: '深度思考',
  };
  return map[level.toLowerCase()] || level;
}

/** Get short model name (strip prefix before /) */
export function getShortModelId(modelId: string) {
  if (!modelId) return '';
  const parts = modelId.split('/');
  return parts[parts.length - 1];
}

/** Relative time for heartbeats, e.g. "3 分钟前" */
export function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 30_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '1 分钟前';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString([], { month: '2-digit', day: '2-digit' });
}

/** Split node bots into primary bots (with their subagents) and orphan subagents. */
export function groupNodeBots(nodeBots: BotConfig[]): {
  primaryBots: BotConfig[];
  subagentMap: Map<string, BotConfig[]>;
  orphanSubagents: BotConfig[];
} {
  const primaryBots = nodeBots.filter((b) => !b.parentBotId);
  const subagentMap = new Map<string, BotConfig[]>();
  for (const b of nodeBots) {
    if (b.parentBotId) {
      const list = subagentMap.get(b.parentBotId) || [];
      list.push(b);
      subagentMap.set(b.parentBotId, list);
    }
  }
  const orphanSubagents = nodeBots.filter(
    (b) => b.parentBotId && !primaryBots.some((p) => p.id === b.parentBotId)
  );
  return { primaryBots, subagentMap, orphanSubagents };
}
