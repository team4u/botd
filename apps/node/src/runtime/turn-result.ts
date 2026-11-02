import type { ToolCallRecord, TurnBlock, TurnUsage } from '@botd/protocol';
import { toolBlockFromRecord } from './tool-preview.js';

/**
 * 回合结果的定稿整理：从 Pi 会话的最终 assistant 消息中提取回复文本、
 * 汇总 token 用量、校准流式期间拼接的 blocks。
 * 全部为纯函数。
 */

interface AssistantMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  content?: Array<{ type: string; text?: string; thinking?: string }>;
  usage?: any;
}

/** 汇总本轮全部 assistant 消息的 usage（多段消息累加，字段名兼容 input/inputTokens 等变体） */
export function collectTurnUsage(assistants: AssistantMessage[], contextWindow?: number): TurnUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;

  for (const msg of assistants) {
    const u = msg?.usage;
    if (!u) continue;
    const inp = Number(u.input ?? u.inputTokens ?? 0) || 0;
    const out = Number(u.output ?? u.outputTokens ?? 0) || 0;
    const cr = Number(u.cacheRead ?? u.cacheReadTokens ?? 0) || 0;
    const cw = Number(u.cacheWrite ?? u.cacheWriteTokens ?? 0) || 0;
    const rawTot = u.totalTokens ?? u.total;
    const tot = Number(rawTot ?? (inp + out + cr + cw)) || 0;
    inputTokens += inp;
    outputTokens += out;
    cacheReadTokens += cr;
    cacheWriteTokens += cw;
    totalTokens += tot;
  }

  if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0)) {
    totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  }

  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
  };
}

/** 提取本轮 assistant 消息的正文文本（每条消息内多段 text 用 \n 连接，消息间用 \n\n 连接） */
export function collectAssistantText(assistants: AssistantMessage[]): string {
  const texts: string[] = [];
  for (const msg of assistants) {
    const msgText = (msg.content || [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
      .map((part) => part.text as string)
      .join('\n')
      .trim();
    if (msgText.length > 0) texts.push(msgText);
  }
  return texts.join('\n\n');
}

/** 定稿消息里的全部 text 片段（按消息顺序），供 blocks 校准比对 */
function finalizedTextParts(assistants: AssistantMessage[]): string[] {
  const parts: string[] = [];
  for (const msg of assistants) {
    for (const part of msg.content || []) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        parts.push(part.text);
      }
    }
  }
  return parts;
}

/**
 * 流式期间未收集到任何 blocks 时的兜底：从定稿 assistant 消息重建时间线。
 */
export function buildBlocksFromFinalized(
  assistants: AssistantMessage[],
  toolCalls: ToolCallRecord[],
): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  for (const msg of assistants) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > 0) {
        blocks.push({ type: 'thinking', thinking: part.thinking, status: 'done' });
      } else if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'text') {
          last.text += `\n\n${part.text}`;
        } else {
          blocks.push({ type: 'text', text: part.text });
        }
      }
    }
  }
  if (toolCalls.length > 0 && !blocks.some((b) => b.type === 'tool')) {
    const toolBlocks = toolCalls.map((tc, idx) => toolBlockFromRecord(tc, idx));
    const firstTextIdx = blocks.findIndex((b) => b.type === 'text');
    if (firstTextIdx >= 0) {
      blocks.splice(firstTextIdx, 0, ...toolBlocks);
    } else {
      blocks.push(...toolBlocks);
    }
  }
  return blocks;
}

/**
 * 落库前校准：流式阶段拼接的 text 块若与定稿消息的文本总量一致（即未被截断/中止），
 * 按定稿顺序重建，保证 blocks 文本与 content 字段一字不差，消除任何流式期间的拼接瑕疵。
 */
export function calibrateTextBlocks(blocks: TurnBlock[], assistants: AssistantMessage[]): TurnBlock[] {
  if (blocks.length === 0) return blocks;
  const finalizedTexts = finalizedTextParts(assistants);
  if (finalizedTexts.length === 0) return blocks;

  // 比较时忽略每段首尾空白（流式拼接可能在消息边界注入 \n\n 前缀）：
  // 内容一致才重建，用定稿文本消除流式期间的任何拼接瑕疵。
  const normalize = (parts: string[]) => parts.map((p) => p.replace(/^\s+|\s+$/g, '')).join('\u0000');
  const streamedTexts = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
  if (normalize(streamedTexts) !== normalize(finalizedTexts)) return blocks;

  // 文本完全一致：按定稿块结构重建（可能把流式期间被 tool 块分隔的多个 text 块
  // 重新归位为模型真实的段落切分）
  const nextBlocks: TurnBlock[] = [];
  let textIdx = 0;
  for (const block of blocks) {
    if (block.type === 'text') {
      if (textIdx < finalizedTexts.length) {
        nextBlocks.push({ type: 'text', text: finalizedTexts[textIdx] });
        textIdx++;
      }
    } else {
      nextBlocks.push(block);
    }
  }
  // 流式期间 text 块数多于定稿（如同一段文本被拆成多块）：合并多余的尾块
  while (textIdx < finalizedTexts.length) {
    const last = nextBlocks[nextBlocks.length - 1];
    if (last && last.type === 'text') {
      last.text += `\n\n${finalizedTexts[textIdx]}`;
    } else {
      nextBlocks.push({ type: 'text', text: finalizedTexts[textIdx] });
    }
    textIdx++;
  }
  return nextBlocks;
}
