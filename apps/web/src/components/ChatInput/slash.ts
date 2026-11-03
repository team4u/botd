import type { ChatCommand } from '@botd/protocol';

/**
 * 解析光标前文本是否命中斜杠命令触发条件。
 * 规则：
 * 1. 仅在消息开头或前置单个/多个 @BOT 之后输入 / 触发；
 * 2. 避免路径与 URL（如 /path/to、http:// 等）持续误弹；
 * 3. 提取前置 @BOT 列表，用于识别纯 /（作用于 lead）或单一前置 @BOT（作用于该成员），以及多目标检测。
 */
export interface ParsedSlashTrigger {
  slashIndex: number;
  query: string;
  targetBotIds: string[];
}

export function parseSlashTrigger(textBefore: string): ParsedSlashTrigger | null {
  // 必须以可选前导空格开头，跟着 0 个或多个 "@botid "（后带至少一个空白），然后是 "/"，后接非空且不含空白与斜杠的命令查询词
  const slashRegex = /^(\s*(?:@[a-zA-Z0-9_-]+\s+)*)\/([^\s/]*)$/;
  const match = slashRegex.exec(textBefore);
  if (!match) return null;

  const prefix = match[1];
  const query = match[2];
  const slashIndex = prefix.length;

  const mentionMatches = prefix.match(/@([a-zA-Z0-9_-]+)/g) || [];
  const targetBotIds = mentionMatches.map((m) => m.slice(1));

  return {
    slashIndex,
    query,
    targetBotIds,
  };
}

export const BUILTIN_SESSION_COMMANDS: ChatCommand[] = [
  {
    name: 'new',
    description: '开启新话题（归档当前话题并开始新对话）',
    source: 'builtin',
  },
  {
    name: 'compact',
    description: '压缩当前会话上下文以降低 Token 水位',
    source: 'builtin',
  },
];
