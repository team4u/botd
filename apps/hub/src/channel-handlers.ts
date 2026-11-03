import { randomUUID } from 'node:crypto';
import type {
  CreateNotificationChannelInput,
  NotificationChannelKind,
  NotificationEventKind,
  NotificationTellPolicy,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { AuthContext } from './http-helpers.js';
import { resolveOwnedSession } from './http-helpers.js';
import { buildTestPayload, sendNotificationToChannel } from './channel-payloads.js';
import { touchChannelTriggeredAt } from './channel-outbox.js';
import {
  mapChannelRow,
  mapOutboxRow,
  parseTellPolicy,
  VALID_CHANNEL_KINDS,
  VALID_EVENT_KINDS,
  VALID_TELL_POLICIES,
  type ChannelRow,
  type OutboxRow,
} from './channel-schema.js';

function isValidHttpUrl(val: unknown): val is string {
  if (typeof val !== 'string' || !val.trim()) return false;
  try {
    const url = new URL(val.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** GET /api/sessions/:id/channels —— 列出会话的出站通知通道 */
export function listSessionChannels(c: AuthContext, db: HubDatabase, id: string) {
  const sRes = resolveOwnedSession(c, db, id);
  if (!sRes.ok) return sRes.response;

  const stmt = db.db.prepare(
    'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, tell_policy, enabled, last_triggered_at, created_at FROM notification_channels WHERE session_id = ? ORDER BY created_at ASC'
  );
  const rows = stmt.all(id) as unknown as ChannelRow[];
  return c.json(rows.map(mapChannelRow));
}

/** GET /api/sessions/:id/outbox —— 查询该会话关联通道的出站通知队列近期记录 */
export function listSessionOutbox(c: AuthContext, db: HubDatabase, id: string) {
  const sRes = resolveOwnedSession(c, db, id);
  if (!sRes.ok) return sRes.response;

  const rows = db.db
    .prepare(
      `SELECT o.id, o.channel_id, o.session_id, o.event_kind, o.payload_json, o.status, o.attempt_count, o.next_retry_at, o.last_error, o.created_at, o.updated_at
       FROM notification_outbox o
       JOIN notification_channels ch ON ch.id = o.channel_id
       WHERE o.session_id = ? OR ch.session_id = ?
       ORDER BY o.created_at DESC
       LIMIT 100`
    )
    .all(id, id) as unknown as OutboxRow[];
  return c.json(rows.map(mapOutboxRow));
}

/** POST /api/sessions/:id/channels —— 创建出站通知通道 */
export async function createSessionChannel(c: AuthContext, db: HubDatabase, id: string) {
  const sRes = resolveOwnedSession(c, db, id);
  if (!sRes.ok) return sRes.response;
  const user = c.get('user');

  const body = await c.req.json<CreateNotificationChannelInput>().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { name, kind, targetUrl, secret, events, tellPolicy, enabled } = body;
  if (typeof name !== 'string' || !name.trim()) {
    return c.json({ error: 'Channel name is required' }, 400);
  }
  if (!VALID_CHANNEL_KINDS.has(kind)) {
    return c.json({ error: 'Invalid channel kind. Allowed: webhook, feishu, slack, telegram' }, 400);
  }
  if (!isValidHttpUrl(targetUrl)) {
    return c.json({ error: 'Invalid targetUrl. Must be a valid http:// or https:// URL' }, 400);
  }
  if (tellPolicy !== undefined && !VALID_TELL_POLICIES.has(tellPolicy)) {
    return c.json({ error: "Invalid tellPolicy. Allowed: 'always', 'needed', 'never'" }, 400);
  }
  const tellPolicyValue: NotificationTellPolicy = tellPolicy ?? 'always';

  let parsedEvents: NotificationEventKind[] = ['assistant_reply', 'ask_request', 'wakeup'];
  if (Array.isArray(events) && events.length > 0) {
    const filtered = events.filter((e): e is NotificationEventKind => VALID_EVENT_KINDS.has(e));
    if (filtered.length > 0) {
      parsedEvents = filtered;
    }
  }

  const channelId = `chan_${randomUUID()}`;
  const now = new Date().toISOString();
  const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

  const stmt = db.db.prepare(`
    INSERT INTO notification_channels (
      id, session_id, owner_id, name, kind, target_url, secret, events_json, tell_policy, enabled, last_triggered_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);

  stmt.run(
    channelId,
    id,
    user.id,
    name.trim(),
    kind,
    targetUrl.trim(),
    typeof secret === 'string' && secret.trim() ? secret.trim() : null,
    JSON.stringify(parsedEvents),
    tellPolicyValue,
    isEnabled,
    now
  );

  const record = {
    id: channelId,
    sessionId: id,
    name: name.trim(),
    kind,
    targetUrl: targetUrl.trim(),
    ...(secret && secret.trim() ? { secret: secret.trim() } : {}),
    events: parsedEvents,
    tellPolicy: tellPolicyValue,
    enabled: Boolean(isEnabled),
    createdAt: now,
  };

  return c.json(record, 201);
}

/** PATCH /api/channels/:channelId —— 部分更新通道配置 */
export async function updateChannel(c: AuthContext, db: HubDatabase, channelId: string) {
  const user = c.get('user');

  const selectStmt = db.db.prepare(
    'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, tell_policy, enabled, last_triggered_at, created_at FROM notification_channels WHERE id = ?'
  );
  const existing = selectStmt.get(channelId) as unknown as ChannelRow | undefined;
  if (!existing) {
    return c.json({ error: 'Channel not found' }, 404);
  }
  if (existing.owner_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<Partial<CreateNotificationChannelInput>>().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  let nextName = existing.name;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return c.json({ error: 'Channel name cannot be empty' }, 400);
    }
    nextName = body.name.trim();
  }

  let nextTargetUrl = existing.target_url;
  if (body.targetUrl !== undefined) {
    if (!isValidHttpUrl(body.targetUrl)) {
      return c.json({ error: 'Invalid targetUrl' }, 400);
    }
    nextTargetUrl = body.targetUrl.trim();
  }

  let nextSecret = existing.secret;
  if (body.secret !== undefined) {
    nextSecret = typeof body.secret === 'string' && body.secret.trim() ? body.secret.trim() : null;
  }

  let nextEventsJson = existing.events_json;
  if (body.events !== undefined) {
    if (Array.isArray(body.events)) {
      const filtered = body.events.filter((e): e is NotificationEventKind => VALID_EVENT_KINDS.has(e));
      nextEventsJson = JSON.stringify(filtered);
    }
  }

  let nextTellPolicy = parseTellPolicy(existing.tell_policy);
  if (body.tellPolicy !== undefined) {
    if (!VALID_TELL_POLICIES.has(body.tellPolicy)) {
      return c.json({ error: "Invalid tellPolicy. Allowed: 'always', 'needed', 'never'" }, 400);
    }
    nextTellPolicy = body.tellPolicy;
  }

  let nextEnabled = existing.enabled;
  if (body.enabled !== undefined) {
    nextEnabled = body.enabled ? 1 : 0;
  }

  const updateStmt = db.db.prepare(`
    UPDATE notification_channels
    SET name = ?, target_url = ?, secret = ?, events_json = ?, tell_policy = ?, enabled = ?
    WHERE id = ?
  `);
  updateStmt.run(nextName, nextTargetUrl, nextSecret, nextEventsJson, nextTellPolicy, nextEnabled, channelId);

  const updatedRow = selectStmt.get(channelId) as unknown as ChannelRow;
  return c.json(mapChannelRow(updatedRow));
}

/** DELETE /api/channels/:channelId —— 删除通道 */
export function deleteChannel(c: AuthContext, db: HubDatabase, channelId: string) {
  const user = c.get('user');

  const selectStmt = db.db.prepare('SELECT owner_id FROM notification_channels WHERE id = ?');
  const existing = selectStmt.get(channelId) as { owner_id: string } | undefined;
  if (!existing) {
    return c.json({ error: 'Channel not found' }, 404);
  }
  if (existing.owner_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  db.db.prepare('DELETE FROM notification_channels WHERE id = ?').run(channelId);
  return c.json({ ok: true });
}

/** POST /api/channels/:channelId/test —— 向通道目标发送测试推送 */
export async function testChannel(c: AuthContext, db: HubDatabase, channelId: string) {
  const user = c.get('user');

  const selectStmt = db.db.prepare(
    'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, tell_policy, enabled, last_triggered_at, created_at FROM notification_channels WHERE id = ?'
  );
  const existing = selectStmt.get(channelId) as unknown as ChannelRow | undefined;
  if (!existing) {
    return c.json({ error: 'Channel not found' }, 404);
  }
  if (existing.owner_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const payload = buildTestPayload(existing.kind as NotificationChannelKind, existing.session_id);
  const result = await sendNotificationToChannel(
    {
      kind: existing.kind as NotificationChannelKind,
      targetUrl: existing.target_url,
      secret: existing.secret ?? undefined,
    },
    payload
  );

  if (!result.ok) {
    return c.json({ error: result.error || 'Remote test request failed' }, 502);
  }

  touchChannelTriggeredAt(db, channelId);
  return c.json({ ok: true, status: result.status });
}
