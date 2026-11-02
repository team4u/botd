/**
 * 自动化事件环境变量：从 Hub 唤醒消息中识别本轮触发来源（cron / webhook / 一次性定时 /
 * 手动触发 / 后台任务），注入 BOTD_TURN_* 变量，让脚本与扩展能区分自动化与用户手动发起。
 */

export interface AutomationEventEnv {
  BOTD_TURN_TRIGGER: 'automation' | 'manual';
  BOTD_TURN_EVENT_KIND: string;
  BOTD_TURN_EVENT_NAME: string;
  BOTD_TURN_EVENT_AT: string;
}

/**
 * 自动化唤醒标记格式（Hub 唤醒消息实际落地形态）：
 *   `[Wake-up] [定时任务: 每日巡检] ...`（tag 带冒号）
 *   `[Wake-up] [Background Job bg_1] 命令 ... 执行完成`（tag 无冒号，名称内嵌）
 */
const AUTOMATION_EVENT_TAGS: Array<{ tag: string; kind: string }> = [
  { tag: '定时任务', kind: 'cron' },
  { tag: 'Timer', kind: 'once' },
  { tag: 'Webhook', kind: 'webhook' },
  { tag: '手动触发', kind: 'manual-trigger' },
  { tag: '延时唤醒', kind: 'delayed-wake' },
  { tag: 'Background Job', kind: 'bg-job' },
];

/**
 * 从唤醒消息中解析自动化事件标记。用户手动发起（无自动化标记）时返回 undefined。
 */
export function detectAutomationEvent(incrementalMessages: string): { kind: string; name: string } | undefined {
  for (const { tag, kind } of AUTOMATION_EVENT_TAGS) {
    // `[<tag>: <名称>]`（冒号分隔）或 `[<tag> <名称>]`（空格分隔，如 Background Job / 延时唤醒）
    const match = incrementalMessages.match(
      new RegExp(`\\[Wake-up\\]\\s*\\[${tag}(?::\\s*|\\s+)([^\\]]*)\\]`),
    );
    if (match) {
      return { kind, name: (match[1] ?? '').trim() };
    }
  }
  return undefined;
}

/** 构建本轮自动化事件环境变量；用户发起（非自动化唤醒）时返回 manual 基准集。 */
export function buildAutomationEventEnv(incrementalMessages: string, now = new Date()): AutomationEventEnv {
  const event = detectAutomationEvent(incrementalMessages);
  return {
    BOTD_TURN_TRIGGER: event ? 'automation' : 'manual',
    BOTD_TURN_EVENT_KIND: event?.kind ?? 'chat',
    BOTD_TURN_EVENT_NAME: event?.name ?? '',
    BOTD_TURN_EVENT_AT: now.toISOString(),
  };
}
