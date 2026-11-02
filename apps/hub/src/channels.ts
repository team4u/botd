import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import type {
  CreateNotificationChannelInput,
  NotificationChannelKind,
  NotificationChannelRecord,
  NotificationEventKind,
  NotificationOutboxRecord,
  NotificationTellPolicy,
  SessionSseEvent,
  UserRecord,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { GroupRouter } from './group-router.js';
import type { SseHub } from './sse.js';
import { resolveOwnedSession } from './http-helpers.js';

const ASK_SECRET_SETTING_KEY = 'ask_secret';

/**
 * 解析 ask 回调签名密钥：环境变量优先，其次 settings 表持久化值，
 * 都没有则生成 64 位 hex 随机密钥并落库（重启后不变，避免历史推送链接失效）。
 */
function resolveAskSecret(db: HubDatabase): string {
  const fromEnv = process.env.BOTD_ASK_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const stored = db.getSetting<string>(ASK_SECRET_SETTING_KEY);
  if (stored && stored.length > 0) return stored;
  const generated = randomBytes(32).toString('hex');
  db.setSetting(ASK_SECRET_SETTING_KEY, generated);
  return generated;
}

export function signAskToken(sessionId: string, askId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${sessionId}:${askId}`).digest('hex');
}

export function verifyAskToken(sessionId: string, askId: string, token: string, secret: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const expected = signAskToken(sessionId, askId, secret);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(token, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const VALID_CHANNEL_KINDS = new Set<NotificationChannelKind>(['webhook', 'feishu', 'slack', 'telegram']);
const VALID_EVENT_KINDS = new Set<NotificationEventKind>(['assistant_reply', 'ask_request', 'wakeup']);
const VALID_TELL_POLICIES = new Set<NotificationTellPolicy>(['always', 'needed', 'never']);

function parseTellPolicy(val: unknown): NotificationTellPolicy {
  return typeof val === 'string' && VALID_TELL_POLICIES.has(val as NotificationTellPolicy)
    ? (val as NotificationTellPolicy)
    : 'always';
}

/** needed 策略下判定 wakeup（callback 消息）是否属于失败/错误回调 */
function isFailureCallbackMessage(content: string): boolean {
  const lower = content.toLowerCase();
  return lower.includes('❌') || lower.includes('失败') || lower.includes('failed') || lower.includes('error');
}

/** 按通道 tellPolicy 过滤事件：never 全静默；needed 仅放行 ask_request、失败回调与 failed 会话回复 */
function shouldTellChannel(
  channel: { tellPolicy?: NotificationTellPolicy },
  eventKind: NotificationEventKind,
  ctx: { isFailureCallback: boolean; sessionFailed: boolean }
): boolean {
  const policy = channel.tellPolicy && VALID_TELL_POLICIES.has(channel.tellPolicy) ? channel.tellPolicy : 'always';
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  // needed：异常与审批才打扰
  if (eventKind === 'ask_request') return true;
  if (eventKind === 'wakeup') return ctx.isFailureCallback;
  if (eventKind === 'assistant_reply') return ctx.sessionFailed;
  return false;
}

function isValidHttpUrl(val: unknown): val is string {
  if (typeof val !== 'string' || !val.trim()) return false;
  try {
    const url = new URL(val.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

interface ChannelRow {
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

function parseEvents(eventsJson: string): NotificationEventKind[] {
  try {
    const parsed = JSON.parse(eventsJson);
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((e): e is NotificationEventKind => VALID_EVENT_KINDS.has(e));
      if (filtered.length > 0) return filtered;
    }
  } catch {}
  return ['assistant_reply', 'ask_request', 'wakeup'];
}

function mapChannelRow(row: ChannelRow): NotificationChannelRecord {
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

interface OutboxRow {
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

function mapOutboxRow(row: OutboxRow): NotificationOutboxRecord {
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

function touchChannelTriggeredAt(db: HubDatabase, channelId: string, timestamp?: string): void {
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

async function sendNotificationToChannel(
  channel: { kind: NotificationChannelKind; targetUrl: string; secret?: string },
  payload: unknown
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const bodyStr = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'botd-notifier/0.1.0',
    };
    if (channel.kind === 'webhook' && channel.secret) {
      const hmac = createHmac('sha256', channel.secret).update(bodyStr).digest('hex');
      headers['X-Botd-Signature'] = `sha256=${hmac}`;
    }

    const res = await fetch(channel.targetUrl, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: `Remote returned HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err: any) {
    return { ok: false, status: 502, error: err?.message || 'Remote request failed' };
  }
}

function buildTestPayload(kind: NotificationChannelKind, sessionId: string): unknown {
  const testMsg = '[botd] 这是一条来自 botd 的通知推送测试消息 🚀';
  switch (kind) {
    case 'feishu':
      return {
        msg_type: 'text',
        content: { text: testMsg },
      };
    case 'slack':
      return {
        text: testMsg,
      };
    case 'telegram':
      return {
        text: testMsg,
        parse_mode: 'Markdown',
      };
    case 'webhook':
      return {
        event: 'assistant_reply',
        sessionId,
        sessionTitle: '测试通道推送',
        timestamp: new Date().toISOString(),
        message: {
          id: `msg_test_${Date.now()}`,
          sessionId,
          role: 'assistant',
          content: testMsg,
          mentions: [],
          createdAt: new Date().toISOString(),
        },
      };
  }
}

function buildEventPayload(
  kind: NotificationChannelKind,
  eventKind: NotificationEventKind,
  event: SessionSseEvent,
  sessionId: string,
  sessionTitle: string,
  baseUrl: string,
  askSecret: string,
  channelSessionId?: string
): unknown {
  const timestamp = new Date().toISOString();
  // 继承通知时（子会话事件命中父会话通道）附带 channelSessionId，便于消费方区分事件源与通道归属
  const inherited = channelSessionId && channelSessionId !== sessionId;

  if (eventKind === 'ask_request' && event.type === 'interaction_request') {
    const ask = event.ask;
    // 签名必须使用 ask 实际所在的会话（事件源会话），否则免登录回调无法命中
    const token = signAskToken(sessionId, ask.id, askSecret);
    const respondUrls: Record<string, string> = {};
    for (const opt of ask.options) {
      respondUrls[opt] = `${baseUrl}/api/public/asks/${encodeURIComponent(ask.id)}/respond?sessionId=${encodeURIComponent(sessionId)}&answer=${encodeURIComponent(opt)}&token=${token}`;
    }

    if (kind === 'webhook') {
      return {
        event: 'ask_request',
        sessionId,
        ...(inherited ? { channelSessionId: channelSessionId! } : {}),
        sessionTitle,
        timestamp,
        ask: {
          id: ask.id,
          botId: ask.botId,
          prompt: ask.prompt,
          options: ask.options,
          expiresAt: ask.expiresAt,
        },
        respondUrls,
      };
    }

    if (kind === 'feishu') {
      const optionsText = ask.options.length > 0
        ? `\n\n请直接点击链接确认选项：\n` + ask.options.map((opt) => `👉 ${opt}：${respondUrls[opt]}`).join('\n')
        : '';
      const text = `[botd 交互确认] @${ask.botId} 请求用户输入：\n${ask.prompt}${optionsText}`;
      return {
        msg_type: 'text',
        content: { text },
      };
    }

    if (kind === 'slack') {
      const optionsText = ask.options.length > 0
        ? `\n\n请直接点击选项链接确认：\n` + ask.options.map((opt) => `• <${respondUrls[opt]}|${opt}>`).join('\n')
        : '';
      const text = `[botd 交互确认] *@${ask.botId}* 请求用户确认：\n${ask.prompt}${optionsText}`;
      return {
        text,
      };
    }

    if (kind === 'telegram') {
      const optionsText = ask.options.length > 0
        ? `\n\n*请点击选项链接确认：*\n` + ask.options.map((opt) => `• [${opt}](${respondUrls[opt]})`).join('\n')
        : '';
      const text = `*【botd 交互确认】* @${ask.botId} 请求用户确认：\n${ask.prompt}${optionsText}`;
      return {
        text,
        parse_mode: 'Markdown',
      };
    }
  }

  // assistant_reply or wakeup
  const message = event.type === 'message_created' ? event.message : undefined;
  const content = message?.content ?? '';
  const senderBotId = message?.senderBotId;
  const originSuffix = inherited ? `（子会话 ${sessionId}）` : '';
  const prefix = eventKind === 'wakeup' ? '[botd 唤醒]' : '[botd]';
  const formattedText = `${prefix} ${senderBotId ? `@${senderBotId}: ` : ''}${content}${originSuffix}`.trim();

  if (kind === 'webhook') {
    return {
      event: eventKind,
      sessionId,
      ...(inherited ? { channelSessionId: channelSessionId! } : {}),
      sessionTitle,
      timestamp,
      message,
    };
  }

  if (kind === 'feishu') {
    return {
      msg_type: 'text',
      content: { text: formattedText },
    };
  }

  if (kind === 'slack') {
    return {
      text: formattedText,
    };
  }

  if (kind === 'telegram') {
    return {
      text: formattedText,
      parse_mode: 'Markdown',
    };
  }

  return { text: formattedText };
}

function renderResponseHtml(answer: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>botd 交互确认</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 24px;
      background: #f4f4f5;
      color: #18181b;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
    }
    @media (prefers-color-scheme: dark) {
      body {
        background: #09090b;
        color: #f4f4f5;
      }
    }
    .card {
      background: #ffffff;
      padding: 36px 32px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
      max-width: 440px;
      width: 100%;
      text-align: center;
    }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #18181b;
        border: 1px solid #27272a;
      }
    }
    .icon {
      font-size: 48px;
      margin-bottom: 16px;
      line-height: 1;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 12px;
      font-weight: 600;
    }
    .answer-box {
      background: #f4f4f5;
      border-radius: 10px;
      padding: 12px 16px;
      margin: 18px 0;
      font-weight: 600;
      font-size: 15px;
      color: #2563eb;
      word-break: break-all;
    }
    @media (prefers-color-scheme: dark) {
      .answer-box {
        background: #27272a;
        color: #60a5fa;
      }
    }
    .hint {
      font-size: 13px;
      color: #71717a;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>已确认提交</h1>
    <div class="answer-box">${escapeHtml(answer)}</div>
    <div class="hint">回调已成功投递到 botd 会话，您可以关闭此页面。</div>
  </div>
</body>
</html>`;
}

function renderErrorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>botd 交互确认失败</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 24px;
      background: #f4f4f5;
      color: #18181b;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
    }
    @media (prefers-color-scheme: dark) {
      body {
        background: #09090b;
        color: #f4f4f5;
      }
    }
    .card {
      background: #ffffff;
      padding: 36px 32px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
      max-width: 440px;
      width: 100%;
      text-align: center;
    }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #18181b;
        border: 1px solid #27272a;
      }
    }
    .icon {
      font-size: 48px;
      margin-bottom: 16px;
      line-height: 1;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 12px;
      font-weight: 600;
      color: #e11d48;
    }
    .desc {
      font-size: 14px;
      color: #52525b;
      margin: 12px 0;
    }
    @media (prefers-color-scheme: dark) {
      .desc { color: #a1a1aa; }
    }
    .hint {
      font-size: 13px;
      color: #71717a;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="desc">${escapeHtml(message)}</div>
    <div class="hint">您可以关闭此页面。</div>
  </div>
</body>
</html>`;
}

export function registerChannelRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  router: GroupRouter,
  sseHub: SseHub,
  _getSessionOwnerId: (sessionId: string) => string | undefined
): () => void {
  // 1. 自包含建表
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

  // 1.1 老库迁移：补齐 tell_policy 列（默认 'always'）
  try {
    const channelColumns = db.db.prepare('PRAGMA table_info(notification_channels)').all() as Array<{ name: string }>;
    if (channelColumns.length > 0 && !channelColumns.some((col) => col.name === 'tell_policy')) {
      db.db.exec("ALTER TABLE notification_channels ADD COLUMN tell_policy TEXT NOT NULL DEFAULT 'always'");
    }
  } catch (err) {
    console.error('[channels] Failed to migrate notification_channels.tell_policy:', err);
  }

  // 1.2 通知出站队列（Outbox）：持久化发送队列与退避重试
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

  // Outbox 重试配置：最大尝试次数 / 基础退避间隔 / 后台轮询间隔
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
  const enqueueOutboxDelivery = (
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
  const outboxTimer = setInterval(() => {
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
  outboxTimer.unref?.();

  // ask 回调签名密钥：初始化时解析并持久化（见 resolveAskSecret）
  const askSecret = resolveAskSecret(db);

  // 2. 路由：公开免登录的 botd ask 外部一键确认回调
  const handleAskRespond = async (c: any) => {
    const askId = c.req.param('askId');
    let sessionId: string | undefined;
    let answer: string | undefined;
    let token: string | undefined;

    if (c.req.method === 'POST') {
      const body = await c.req.json().catch(() => null);
      if (body && typeof body === 'object') {
        sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
        answer = typeof body.answer === 'string' ? body.answer : undefined;
        token = typeof body.token === 'string' ? body.token : undefined;
      }
    }

    const query = c.req.query();
    if (!sessionId && query.sessionId) sessionId = query.sessionId;
    if (!answer && query.answer) answer = query.answer;
    if (!token && query.token) token = query.token;

    const accept = c.req.header('accept') || '';
    const wantsHtml = accept.includes('text/html');

    if (!sessionId || !answer || !token) {
      if (wantsHtml) {
        return c.html(renderErrorHtml('参数不完整', '缺少必要的确认参数 (sessionId, answer, token)'), 400);
      }
      return c.json({ error: 'Missing required parameters: sessionId, answer, token' }, 400);
    }

    const trimmedAnswer = answer.trim();

    if (!verifyAskToken(sessionId, askId, token, askSecret)) {
      if (wantsHtml) {
        return c.html(renderErrorHtml('鉴权失败', '回调 Token 无效或已过期'), 403);
      }
      return c.json({ error: 'Invalid or expired token' }, 403);
    }

    // 选项非空时强制答案在选项内，防止伪造 token 后提交任意文本
    const pendingAsk = router.getPendingAsks(sessionId).find((a) => a.id === askId);
    if (pendingAsk && pendingAsk.status === 'pending' && pendingAsk.options.length > 0
      && !pendingAsk.options.includes(trimmedAnswer)) {
      if (wantsHtml) {
        return c.html(renderErrorHtml('无效选项', '答案不在可选项列表中'), 400);
      }
      return c.json({ error: 'Answer must be one of the ask options' }, 400);
    }

    const resolved = router.respondToAsk(sessionId, askId, trimmedAnswer);
    if (!resolved) {
      if (wantsHtml) {
        return c.html(renderErrorHtml('请求失效', '该确认请求不存在、已超时或已被其他用户处理'), 404);
      }
      return c.json({ error: 'Ask not found or already answered' }, 404);
    }

    if (wantsHtml) {
      return c.html(renderResponseHtml(trimmedAnswer));
    }
    return c.json({ ok: true, ask: resolved });
  };

  app.get('/api/public/asks/:askId/respond', handleAskRespond);
  app.post('/api/public/asks/:askId/respond', handleAskRespond);

  // 3. 路由：会话出站通道 CRUD
  // GET /api/sessions/:id/channels
  app.get('/api/sessions/:id/channels', (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const stmt = db.db.prepare(
      'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, tell_policy, enabled, last_triggered_at, created_at FROM notification_channels WHERE session_id = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(id) as unknown as ChannelRow[];
    return c.json(rows.map(mapChannelRow));
  });

  // GET /api/sessions/:id/outbox —— 查询该会话关联通道的出站通知队列近期记录
  app.get('/api/sessions/:id/outbox', (c) => {
    const id = c.req.param('id');
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
  });

  // POST /api/sessions/:id/channels
  app.post('/api/sessions/:id/channels', async (c) => {
    const id = c.req.param('id');
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

    const record: NotificationChannelRecord = {
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
  });

  // PATCH /api/channels/:channelId
  app.patch('/api/channels/:channelId', async (c) => {
    const channelId = c.req.param('channelId');
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
  });

  // DELETE /api/channels/:channelId
  app.delete('/api/channels/:channelId', (c) => {
    const channelId = c.req.param('channelId');
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
  });

  // POST /api/channels/:channelId/test
  app.post('/api/channels/:channelId/test', async (c) => {
    const channelId = c.req.param('channelId');
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
  });

  // 4. 全局内部监听器注册：监听会话事件并异步非阻塞推送到外部通道
  //    支持子会话向上继承：子会话事件同时命中其父会话配置的启用通道（按通道 id 去重）
  const unsubscribe = sseHub.onBroadcast((sessionId, event) => {
    void (async () => {
      try {
        let eventKind: NotificationEventKind | undefined;
        if (event.type === 'message_created') {
          if (event.message.role === 'assistant') {
            eventKind = 'assistant_reply';
          } else if (event.message.role === 'callback') {
            eventKind = 'wakeup';
          }
        } else if (event.type === 'interaction_request') {
          eventKind = 'ask_request';
        }

        if (!eventKind) return;

        // 收集事件会话及其父会话（若存在）上的启用通道，按 id 去重
        const session = db.getSession(sessionId);
        const sessionIds = [sessionId];
        if (session?.parentSessionId) {
          sessionIds.push(session.parentSessionId);
        }

        const selectStmt = db.db.prepare(
          'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, tell_policy, enabled, last_triggered_at, created_at FROM notification_channels WHERE session_id = ? AND enabled = 1'
        );
        const seenChannelIds = new Set<string>();
        const rows: ChannelRow[] = [];
        for (const sid of sessionIds) {
          for (const row of selectStmt.all(sid) as unknown as ChannelRow[]) {
            if (seenChannelIds.has(row.id)) continue;
            seenChannelIds.add(row.id);
            rows.push(row);
          }
        }
        if (rows.length === 0) return;

        // tellPolicy 过滤上下文：wakeup 仅失败回调放行；assistant_reply 仅 failed 会话放行
        const messageContent = event.type === 'message_created' ? event.message.content : '';
        const isFailureCallback = eventKind === 'wakeup' && isFailureCallbackMessage(messageContent);
        const sessionFailed = session?.status === 'failed';

        const channels = rows
          .map(mapChannelRow)
          .filter(
            (ch) => ch.events.includes(eventKind!) && shouldTellChannel(ch, eventKind!, { isFailureCallback, sessionFailed })
          );
        if (channels.length === 0) return;

        const baseUrl =
          process.env.BOTD_PUBLIC_URL ||
          process.env.BOTD_BASE_URL ||
          `http://localhost:${process.env.BOTD_PORT || 3000}`;

        for (const channel of channels) {
          // payload 主体使用事件源会话（ask 签名 / respondUrls 必须指向事件会话）；
          // 通道归属会话（可能是父会话）作为 channelSessionId 附带，供消费方区分。
          const notifySession = channel.sessionId === sessionId ? session : db.getSession(channel.sessionId);
          const sessionTitle = notifySession?.title || channel.sessionId;
          const payload = buildEventPayload(
            channel.kind,
            eventKind,
            event,
            sessionId,
            sessionTitle,
            baseUrl,
            askSecret,
            channel.sessionId
          );
          enqueueOutboxDelivery(channel, sessionId, eventKind, payload);
        }
      } catch (err) {
        console.error('[channels] Broadcast listener error:', err);
      }
    })();
  });

  return () => {
    clearInterval(outboxTimer);
    unsubscribe();
  };
}
