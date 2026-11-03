import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BotConfig } from '@botd/protocol';
import type { HubStream } from './hub-stream.js';
import type { BotTurnResult } from './execute-turn.js';
import { executeBotTurn } from './execute-turn.js';
import { assertSafeId, getBotDir, writeAtomicFile } from '../storage.js';

/**
 * 长任务断连容错：在途回合附着（attach）+ 单槽结果回执（receipt）。
 *
 * Hub 侧网络闪断时会把回合转回离线队列并在节点重连后重发（runKey + signature 相同），
 * 节点侧保证该回合的模型推理**恰好执行一次**：
 * - 在途：直接附着到正在执行的 Promise 等待同一结果；
 * - 已离线完成：消费磁盘回执（只消费一次），不重复调用模型。
 */

type RunTurnInput = Parameters<typeof executeBotTurn>[2];

/** 回合输入签名：Hub 断连重发时增量与命令不变即为同一回合 */
export function turnSignature(input: RunTurnInput): string {
  return JSON.stringify({
    incrementalMessages: input.incrementalMessages,
    commandText: input.commandText ?? '',
  });
}

interface InFlightTurn {
  signature: string;
  promise: Promise<BotTurnResult>;
  /** 是否有重连后的调用附着消费结果（附着即视为结果已交付） */
  attached: boolean;
}

/** 进程级在途回合表：runKey = `${sessionId}:${botId}` */
const inFlightTurns = new Map<string, InFlightTurn>();

/** 回执文件路径：<botDir>/sessions/<sessionId>.receipt.json（单槽：新结果覆盖旧结果） */
function receiptPath(dataDir: string, sessionId: string, botId: string): string {
  return path.join(getBotDir(dataDir, botId), 'sessions', `${sessionId}.receipt.json`);
}

interface StoredReceipt {
  sessionId: string;
  botId: string;
  signature: string;
  completedAt: string;
  result: BotTurnResult;
}

async function readReceipt(dataDir: string, sessionId: string, botId: string): Promise<StoredReceipt | undefined> {
  const file = receiptPath(dataDir, sessionId, botId);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as StoredReceipt;
    if (parsed?.sessionId === sessionId && parsed?.botId === botId && typeof parsed.signature === 'string') {
      return parsed;
    }
  } catch {
    // 损坏的回执视为不存在
  }
  return undefined;
}

async function removeReceipt(dataDir: string, sessionId: string, botId: string): Promise<void> {
  await fs.rm(receiptPath(dataDir, sessionId, botId), { force: true }).catch(() => {});
}

/** 清理指定回合的回执（resetBotSession / cancelTurn 调用） */
export async function clearTurnReceipt(dataDir: string, sessionId: string, botId: string): Promise<void> {
  await removeReceipt(dataDir, sessionId, botId);
}

/**
 * 执行一个回合，带断连容错语义（详见模块注释）。
 *
 * @param getHubStream 取当前可用的 Hub 推流代理（断连重连后推流自动切到新连接）
 * @param connectionEpoch 当前连接代数（0 = 断开）；发起与完成时代数不同说明发起连接已死
 * @param execute 实际执行函数（默认 executeBotTurn；测试可注入）
 */
export async function runTurnWithResilience(
  dataDir: string,
  bot: BotConfig,
  input: RunTurnInput,
  getHubStream: () => HubStream | null,
  connectionEpoch: () => number,
  execute: typeof executeBotTurn = executeBotTurn,
): Promise<BotTurnResult> {
  assertSafeId(bot.id, 'Bot ID');
  assertSafeId(input.sessionId, 'Session ID');
  const runKey = `${input.sessionId}:${bot.id}`;
  const signature = turnSignature(input);

  // 1) 在途附着：同一回合正在执行，直接等它的结果（Hub 断连重发场景）
  const inFlight = inFlightTurns.get(runKey);
  if (inFlight && inFlight.signature === signature) {
    inFlight.attached = true;
    return await inFlight.promise;
  }

  const entry: InFlightTurn = { signature, promise: null as any, attached: false };
  // 同步占位后再进入异步体：并发重发不可能双双穿透到真正执行
  entry.promise = (async (): Promise<BotTurnResult> => {
    // 2) 单槽回执：节点在离线期间已跑完同一回合，直接消费缓存结果（只消费一次）
    const receipt = await readReceipt(dataDir, input.sessionId, bot.id);
    if (receipt && receipt.signature === signature) {
      await removeReceipt(dataDir, input.sessionId, bot.id);
      return receipt.result;
    }

    // 3) 真正执行
    const startedEpoch = connectionEpoch();
    const hubStream = getHubStream();
    if (!hubStream || startedEpoch === 0) {
      throw new Error('Hub RPC not available');
    }
    const result = await execute(dataDir, bot, input, hubStream);
    // 结果已通过当前活跃 RPC 正常返回 → 清掉旧回执；
    // 发起连接已死（代数变化）或完成时断开，且无人附着消费 → 写入单槽回执供重连后回放
    const currentEpoch = connectionEpoch();
    const delivered = entry.attached
      ? currentEpoch !== 0
      : currentEpoch === startedEpoch;
    if (result.aborted || delivered) {
      await removeReceipt(dataDir, input.sessionId, bot.id);
    } else {
      const stored: StoredReceipt = {
        sessionId: input.sessionId,
        botId: bot.id,
        signature,
        completedAt: new Date().toISOString(),
        result,
      };
      await writeAtomicFile(
        receiptPath(dataDir, input.sessionId, bot.id),
        JSON.stringify(stored),
      ).catch(() => {}); // 回执写失败不阻断结果返回
    }
    return result;
  })();
  inFlightTurns.set(runKey, entry);
  try {
    return await entry.promise;
  } finally {
    if (inFlightTurns.get(runKey) === entry) inFlightTurns.delete(runKey);
  }
}
