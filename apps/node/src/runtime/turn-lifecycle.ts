import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeId, getBotDir } from '../storage.js';
import { getGlobalSubagentManager } from '../commands.js';
import { runRegistry } from './run-registry.js';
import { clearTurnReceipt } from './turn-receipt.js';

/**
 * 回合生命周期 API：会话重置与取消（单回合 / 按 dataDir 全量）。
 */

/** 删除 (sessionId, botId) 的本地 Pi 会话文件（.jsonl），下一回合将从 Hub 历史全量重建上下文。文件不存在时静默成功（幂等）。 */
export async function resetBotSession(dataDir: string, sessionId: string, botId: string): Promise<void> {
  assertSafeId(sessionId, 'Session ID');
  assertSafeId(botId, 'Bot ID');

  const runKey = `${sessionId}:${botId}`;
  if (runRegistry.isPending(runKey)) {
    throw new Error('Turn is running and cannot be reset');
  }

  // Defensive: a live session for this key should not exist when idle, but if it
  // does, tear it down before deleting so it cannot write back to the old file.
  const activeSession = runRegistry.getSession(runKey);
  if (activeSession) {
    runRegistry.dropSession(runKey);
    activeSession.dispose();
  }

  // 重置会话意味着放弃上下文：未消费的断连回执一并清理
  await clearTurnReceipt(dataDir, sessionId, botId);

  const sessionFile = path.join(getBotDir(dataDir, botId), 'sessions', `${sessionId}.jsonl`);
  if (!existsSync(sessionFile)) {
    return;
  }
  await fs.rm(sessionFile);
}

export async function cancelBotTurn(sessionId: string, botId: string, dataDir?: string): Promise<void> {
  const runKey = `${sessionId}:${botId}`;
  runRegistry.cancel(runKey);
  // 取消的回合不会产生有效结果：清理其未消费回执（优先用显式 dataDir，退化到运行注册表反查）
  const resolvedDataDir = dataDir ?? runRegistry.dataDirOf(runKey);
  if (resolvedDataDir) await clearTurnReceipt(resolvedDataDir, sessionId, botId);
  const session = runRegistry.getSession(runKey);
  if (session) {
    // 取消前先停掉全部分身（含后台），避免 dispose 只断开主会话而分身孤儿化
    try {
      getGlobalSubagentManager()?.abortAll?.();
    } catch {
      // ignore
    }
    await session.abort();
  }
}

export async function cancelAllBotTurns(dataDir?: string): Promise<void> {
  const abortPromises: Promise<void>[] = [];
  for (const [runKey, session] of runRegistry.entriesWithSession()) {
    if (!dataDir || runRegistry.dataDirOf(runKey) === dataDir) {
      runRegistry.cancel(runKey);
      abortPromises.push(session.abort().catch(() => {}));
    }
  }
  for (const runKey of runRegistry.pendingRunKeys(dataDir)) {
    runRegistry.cancel(runKey);
  }
  await Promise.all(abortPromises);
}
