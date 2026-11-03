import type { NotificationChannelKind, NotificationEventKind, NotificationChannelRecord, NotificationOutboxRecord, NotificationTellPolicy } from '@botd/protocol';
import type { HubDatabase } from './db.js';

export const VALID_CHANNEL_KINDS = new Set<NotificationChannelKind>(['webhook', 'feishu', 'slack', 'telegram']);
export const VALID_EVENT_KINDS = new Set<NotificationEventKind>(['assistant_reply', 'ask_request', 'wakeup']);
export const VALID_TELL_POLICIES = new Set<NotificationTellPolicy>(['always', 'needed', 'never']);

export interface ChannelRow {
  id: string;
  session_id: string;
  owner_id: string;
  name: string;
  kind: string;
  target_url: string;
  secret: string | null;
  events_json: string;
  tell_policy: string;
  enabled: number;
  last_triggered_at: string | null;
  created_at: string;
}

export interface OutboxRow {
  id: string;
  channel_id: string;
  session_id: string;
  event_kind: string;
  payload_json: string;
  status: string;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function parseTellPolicy(val: unknown): NotificationTellPolicy {
  return typeof val === 'string' && VALID_TELL_POLICIES.has(val as NotificationTellPolicy)
    ? (val as NotificationTellPolicy)
    : 'always';
}

export function parseEvents(eventsJson: string): NotificationEventKind[] {
  try {
    const parsed = JSON.parse(eventsJson);
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((e): e is NotificationEventKind => VALID_EVENT_KINDS.has(e));
      if (filtered.length > 0) return filtered;
    }
  } catch {}
  return ['assistant_reply', 'ask_request', 'wakeup'];
}

export function mapChannelRow(row: ChannelRow): NotificationChannelRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    kind: row.kind as NotificationChannelKind,
    targetUrl: row.target_url,
    ...(row.secret ? { secret: row.secret } : {}),
    events: parseEvents(row.events_json),
    ...(row.tell_policy ? { tellPolicy: parseTellPolicy(row.tell_policy) } : {}),
    enabled: Boolean(row.enabled),
    ...(row.last_triggered_at ? { lastTriggeredAt: row.last_triggered_at } : {}),
    createdAt: row.created_at,
  };
}

export function mapOutboxRow(row: OutboxRow): NotificationOutboxRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    sessionId: row.session_id,
    eventKind: row.event_kind as NotificationEventKind,
    status: row.status as 'pending' | 'sent' | 'dead',
    attemptCount: row.attempt_count,
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 自包含建表 + 老库迁移：通知通道表、出站队列表（tell_policy 列后补） */
export function ensureChannelTables(db: HubDatabase): void {
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_url TEXT NOT NULL,
      secret TEXT,
      events_json TEXT NOT NULL DEFAULT '["assistant_reply","ask_request","wakeup"]',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_triggered_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_channels_session ON notification_channels(session_id);
  `);

  // 老库迁移：补齐 tell_policy 列（默认 'always'）
  try {
    const channelColumns = db.db.prepare('PRAGMA table_info(notification_channels)').all() as Array<{ name: string }>;
    if (channelColumns.length > 0 && !channelColumns.some((col) => col.name === 'tell_policy')) {
      db.db.exec("ALTER TABLE notification_channels ADD COLUMN tell_policy TEXT NOT NULL DEFAULT 'always'");
    }
  } catch (err) {
    console.error('[channels] Failed to migrate notification_channels.tell_policy:', err);
  }

  // 通知出站队列（Outbox）：持久化发送队列与退避重试
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_outbox_status_retry ON notification_outbox(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_notification_outbox_session ON notification_outbox(session_id, created_at);
  `);
}
