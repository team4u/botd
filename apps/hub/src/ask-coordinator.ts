import { randomUUID } from 'node:crypto';
import {
  validateUiSpec,
  type AskPreviewType,
  type PendingAskRecord,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { SseHub } from './sse.js';

interface PendingAskEntry {
  record: PendingAskRecord;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

/** 人工询问（ask）机制：pending ask 的创建、应答、超时，以及会话取消/关闭时的级联失效 */
export class AskCoordinator {
  private pendingAsks = new Map<string, PendingAskEntry>();
  private closed = false;

  constructor(
    private db: HubDatabase,
    private sseHub: SseHub
  ) {}

  close(): void {
    this.closed = true;
    for (const entry of this.pendingAsks.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error('Hub closed'));
    }
    this.pendingAsks.clear();
  }

  async requestHumanInput(input: {
    sessionId: string;
    botId: string;
    prompt: string;
    options?: string[];
    timeoutSeconds?: number;
    previewType?: AskPreviewType;
    previewContent?: string;
  }): Promise<{ answer: string }> {
    if (this.closed) throw new Error('Hub is shutting down');
    const session = this.db.getSession(input.sessionId);
    if (!session) throw new Error(`Session ${input.sessionId} not found`);

    let previewContent = input.previewContent;
    if (input.previewType === 'ui') {
      if (!previewContent || !previewContent.trim()) {
        throw new Error('Invalid UI spec: Missing UI previewContent');
      }
      const validation = validateUiSpec(previewContent);
      if (!validation.ok) {
        throw new Error(`Invalid UI spec: ${validation.errors.join('; ')}`);
      }
      previewContent = validation.normalizedJson;
    }

    const askId = `ask_${randomUUID()}`;
    const now = new Date();
    const isIndefinite = input.timeoutSeconds === 0;
    const timeoutSec = isIndefinite
      ? 0
      : (input.timeoutSeconds && input.timeoutSeconds > 0 ? input.timeoutSeconds : 300);
    const expiresAt = isIndefinite ? undefined : new Date(now.getTime() + timeoutSec * 1000).toISOString();

    const record: PendingAskRecord = {
      id: askId,
      sessionId: input.sessionId,
      botId: input.botId,
      prompt: input.prompt,
      options: input.options ?? [],
      status: 'pending',
      createdAt: now.toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      ...(input.previewType ? { previewType: input.previewType } : {}),
      ...(previewContent ? { previewContent } : {}),
    };
    this.db.savePendingAsk(record);

    return new Promise<{ answer: string }>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (!isIndefinite) {
        timer = setTimeout(() => {
          const entry = this.pendingAsks.get(askId);
          if (entry) {
            entry.record.status = 'expired';
            this.db.updatePendingAskStatus(askId, 'expired');
            this.pendingAsks.delete(askId);
            entry.reject(new Error(`Interactive ask timed out after ${timeoutSec}s`));
          }
        }, timeoutSec * 1000);
      }

      this.pendingAsks.set(askId, {
        record,
        resolve: (ans: string) => resolve({ answer: ans }),
        reject,
        timer,
      });

      this.sseHub.broadcast(input.sessionId, {
        type: 'interaction_request',
        sessionId: input.sessionId,
        ask: record,
      });
    });
  }

  getPendingAsks(sessionId: string): PendingAskRecord[] {
    const result: PendingAskRecord[] = [];
    const seen = new Set<string>();
    for (const entry of this.pendingAsks.values()) {
      if (entry.record.sessionId === sessionId && entry.record.status === 'pending') {
        seen.add(entry.record.id);
        result.push(entry.record);
      }
    }
    const dbAsks = this.db.getPendingAsksForSession(sessionId);
    for (const ask of dbAsks) {
      if (!seen.has(ask.id)) {
        seen.add(ask.id);
        result.push(ask);
      }
    }
    return result;
  }

  respondToAsk(sessionId: string, askId: string, answer: string): PendingAskRecord | undefined {
    const entry = this.pendingAsks.get(askId);
    if (entry) {
      if (entry.record.sessionId !== sessionId) return undefined;
      if (entry.record.status !== 'pending') return undefined;

      if (entry.timer) clearTimeout(entry.timer);
      entry.record.status = 'answered';
      entry.record.answer = answer;
      this.db.updatePendingAskStatus(askId, 'answered', answer);
      this.pendingAsks.delete(askId);

      entry.resolve(answer);

      this.sseHub.broadcast(sessionId, {
        type: 'interaction_resolved',
        sessionId,
        askId,
        answer,
      });

      return entry.record;
    }

    const dbAsks = this.db.getPendingAsksForSession(sessionId);
    const dbAsk = dbAsks.find((a) => a.id === askId);
    if (dbAsk && dbAsk.status === 'pending') {
      dbAsk.status = 'answered';
      dbAsk.answer = answer;
      this.db.updatePendingAskStatus(askId, 'answered', answer);
      this.sseHub.broadcast(sessionId, {
        type: 'interaction_resolved',
        sessionId,
        askId,
        answer,
      });
      return dbAsk;
    }

    return undefined;
  }

  /** 会话取消：reject 内存中的 pending ask，并把 DB 中残留的 pending 一并标记 expired */
  rejectPendingForSession(sessionId: string, reason: string): void {
    for (const [askId, entry] of this.pendingAsks.entries()) {
      if (entry.record.sessionId === sessionId) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingAsks.delete(askId);
        entry.record.status = 'expired';
        this.db.updatePendingAskStatus(askId, 'expired');
        entry.reject(new Error(reason));
      }
    }
    const dbAsks = this.db.getPendingAsksForSession(sessionId);
    for (const ask of dbAsks) {
      this.db.updatePendingAskStatus(ask.id, 'expired');
    }
  }
}
