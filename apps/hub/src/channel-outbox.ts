import { randomUUID } from 'node:crypto';
import type { NotificationChannelKind, NotificationChannelRecord, NotificationEventKind } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import { sendNotificationToChannel } from './channel-payloads.js';
import type { ChannelRow, OutboxRow } from './channel-schema.js';

export function touchChannelTriggeredAt(db: HubDatabase, channelId: string, timestamp?: string): void {
  const now = timestamp || new Date().toISOString();
  try {
    db.db.prepare('UPDATE notification_channels SET last_triggered_at = ? WHERE id = ?').run(now, channelId);
  } catch (err: any) {
    if (err?.code === 'ERR_INVALID_STATE' || err?.message?.includes('database is not open')) {
      return;
    }
    console.error(`[channels] Failed to update last_triggered_at for ${channelId}:`, err);
  }
}

/**
 * Outbox 投递引擎：立即首投 + 后台轮询到期 pending 记录按指数退避重试，
 * 超过最大尝试次数置 dead。返回 enqueue（入队并首投）与 stop（清理轮询定时器）。
 */
export function createOutboxDeliverer(db: HubDatabase): {
  enqueue: (channel: NotificationChannelRecord, sessionId: string, eventKind: NotificationEventKind, payload: unknown) => void;
  stop: () => void;
} {
  // 重试配置：最大尝试次数 / 基础退避间隔 / 重试延迟上限
  const maxAttempts = Math.max(1, Number(process.env.BOTD_OUTBOX_MAX_ATTEMPTS || '5') || 5);
  const baseRetryMs = Math.max(100, Number(process.env.BOTD_OUTBOX_RETRY_MS || '5000') || 5000);
  const retryCapMs = 300_000;

  const outboxDelivering = new Set<string>();

  const getOutboxStmt = () =>
    db.db.prepare(
      'SELECT id, channel_id, session_id, event_kind, payload_json, status, attempt_count, next_retry_at, last_error, created_at, updated_at FROM notification_outbox WHERE id = ?'
    );

  /** 投递单条 outbox 记录：成功置 sent；失败计数+1，超过上限置 dead，否则按指数退避安排下次重试 */
  const deliverOutboxItem = async (outboxId: string): Promise<void> => {
    if (outboxDelivering.has(outboxId)) return;
    outboxDelivering.add(outboxId);
    try {
      const row = getOutboxStmt().get(outboxId) as unknown as OutboxRow | undefined;
      if (!row || row.status !== 'pending') return;

      const channelRow = db.db
        .prepare(
          'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, tell_policy, enabled, last_triggered_at, created_at FROM notification_channels WHERE id = ?'
        )
        .get(row.channel_id) as unknown as ChannelRow | undefined;
      if (!channelRow) {
        db.db
          .prepare(
            "UPDATE notification_outbox SET status = 'dead', last_error = 'Channel deleted', updated_at = ? WHERE id = ?"
          )
          .run(new Date().toISOString(), outboxId);
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        db.db
          .prepare(
            "UPDATE notification_outbox SET status = 'dead', last_error = 'Corrupted payload JSON', updated_at = ? WHERE id = ?"
          )
          .run(new Date().toISOString(), outboxId);
        return;
      }

      const result = await sendNotificationToChannel(
        {
          kind: channelRow.kind as NotificationChannelKind,
          targetUrl: channelRow.target_url,
          secret: channelRow.secret ?? undefined,
        },
        payload
      );

      const nowIso = new Date().toISOString();
      const attemptCount = row.attempt_count + 1;
      if (result.ok) {
        db.db
          .prepare(
            "UPDATE notification_outbox SET status = 'sent', attempt_count = ?, next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?"
          )
          .run(attemptCount, nowIso, outboxId);
        touchChannelTriggeredAt(db, row.channel_id, nowIso);
        return;
      }

      if (attemptCount >= maxAttempts) {
        db.db
          .prepare(
            "UPDATE notification_outbox SET status = 'dead', attempt_count = ?, next_retry_at = NULL, last_error = ?, updated_at = ? WHERE id = ?"
          )
          .run(attemptCount, result.error || 'Delivery failed', nowIso, outboxId);
        console.warn(
          `[channels] Outbox ${outboxId} marked dead after ${attemptCount} attempts:`,
          result.error
        );
        return;
      }

      const delayMs = Math.min(retryCapMs, baseRetryMs * Math.pow(2, attemptCount - 1));
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      db.db
        .prepare(
          "UPDATE notification_outbox SET attempt_count = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?"
        )
        .run(attemptCount, nextRetryAt, result.error || 'Delivery failed', nowIso, outboxId);
    } catch (err) {
      console.error(`[channels] Outbox delivery error for ${outboxId}:`, err);
    } finally {
      outboxDelivering.delete(outboxId);
    }
  };

  /** 将一次待发推送落入 outbox 并立即异步首投 */
  const enqueue = (
    channel: NotificationChannelRecord,
    sessionId: string,
    eventKind: NotificationEventKind,
    payload: unknown
  ): void => {
    try {
      const outboxId = `outbox_${randomUUID()}`;
      const nowIso = new Date().toISOString();
      db.db
        .prepare(
          `INSERT INTO notification_outbox (id, channel_id, session_id, event_kind, payload_json, status, attempt_count, next_retry_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`
        )
        .run(outboxId, channel.id, sessionId, eventKind, JSON.stringify(payload), nowIso, nowIso);
      void deliverOutboxItem(outboxId);
    } catch (err) {
      console.error('[channels] Failed to enqueue outbox delivery:', err);
    }
  };

  // 后台轮询：扫描到期的 pending 记录并重试投递
  const pollMs = Math.max(100, Number(process.env.BOTD_OUTBOX_POLL_MS || '2000') || 2000);
  const timer = setInterval(() => {
    try {
      const nowIso = new Date().toISOString();
      const dueRows = db.db
        .prepare(
          "SELECT id FROM notification_outbox WHERE status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT 20"
        )
        .all(nowIso) as Array<{ id: string }>;
      for (const row of dueRows) {
        void deliverOutboxItem(row.id);
      }
    } catch (err) {
      // db 可能已关闭（进程退出），静默忽略
    }
  }, pollMs);
  timer.unref?.();

  return { enqueue, stop: () => clearInterval(timer) };
}
