import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import type {
  CreateNotificationChannelInput,
  NotificationChannelKind,
  NotificationChannelRecord,
  NotificationEventKind,
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
    enabled: Boolean(row.enabled),
    ...(row.last_triggered_at ? { lastTriggeredAt: row.last_triggered_at } : {}),
    createdAt: row.created_at,
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
  askSecret: string
): unknown {
  const timestamp = new Date().toISOString();

  if (eventKind === 'ask_request' && event.type === 'interaction_request') {
    const ask = event.ask;
    const token = signAskToken(sessionId, ask.id, askSecret);
    const respondUrls: Record<string, string> = {};
    for (const opt of ask.options) {
      respondUrls[opt] = `${baseUrl}/api/public/asks/${encodeURIComponent(ask.id)}/respond?sessionId=${encodeURIComponent(sessionId)}&answer=${encodeURIComponent(opt)}&token=${token}`;
    }

    if (kind === 'webhook') {
      return {
        event: 'ask_request',
        sessionId,
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
  const prefix = eventKind === 'wakeup' ? '[botd 唤醒]' : '[botd]';
  const formattedText = `${prefix} ${senderBotId ? `@${senderBotId}: ` : ''}${content}`.trim();

  if (kind === 'webhook') {
    return {
      event: eventKind,
      sessionId,
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
      'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, enabled, last_triggered_at, created_at FROM notification_channels WHERE session_id = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(id) as unknown as ChannelRow[];
    return c.json(rows.map(mapChannelRow));
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

    const { name, kind, targetUrl, secret, events, enabled } = body;
    if (typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'Channel name is required' }, 400);
    }
    if (!VALID_CHANNEL_KINDS.has(kind)) {
      return c.json({ error: 'Invalid channel kind. Allowed: webhook, feishu, slack, telegram' }, 400);
    }
    if (!isValidHttpUrl(targetUrl)) {
      return c.json({ error: 'Invalid targetUrl. Must be a valid http:// or https:// URL' }, 400);
    }

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
        id, session_id, owner_id, name, kind, target_url, secret, events_json, enabled, last_triggered_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
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
      'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, enabled, last_triggered_at, created_at FROM notification_channels WHERE id = ?'
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

    let nextEnabled = existing.enabled;
    if (body.enabled !== undefined) {
      nextEnabled = body.enabled ? 1 : 0;
    }

    const updateStmt = db.db.prepare(`
      UPDATE notification_channels
      SET name = ?, target_url = ?, secret = ?, events_json = ?, enabled = ?
      WHERE id = ?
    `);
    updateStmt.run(nextName, nextTargetUrl, nextSecret, nextEventsJson, nextEnabled, channelId);

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
      'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, enabled, last_triggered_at, created_at FROM notification_channels WHERE id = ?'
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

        const stmt = db.db.prepare(
          'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, enabled, last_triggered_at, created_at FROM notification_channels WHERE session_id = ? AND enabled = 1'
        );
        const rows = stmt.all(sessionId) as unknown as ChannelRow[];
        if (rows.length === 0) return;

        const channels = rows.map(mapChannelRow).filter((ch) => ch.events.includes(eventKind!));
        if (channels.length === 0) return;

        const session = db.getSession(sessionId);
        const sessionTitle = session?.title || sessionId;
        const baseUrl =
          process.env.BOTD_PUBLIC_URL ||
          process.env.BOTD_BASE_URL ||
          `http://localhost:${process.env.BOTD_PORT || 3000}`;

        const nowIso = new Date().toISOString();

        for (const channel of channels) {
          const payload = buildEventPayload(
            channel.kind,
            eventKind,
            event,
            sessionId,
            sessionTitle,
            baseUrl,
            askSecret
          );
          sendNotificationToChannel(
            {
              kind: channel.kind,
              targetUrl: channel.targetUrl,
              secret: channel.secret,
            },
            payload
          )
            .then((res) => {
              if (res.ok) {
                touchChannelTriggeredAt(db, channel.id, nowIso);
              } else {
                console.warn(`[channels] Push to ${channel.kind} (${channel.id}) failed:`, res.error);
              }
            })
            .catch((err) => {
              console.warn(`[channels] Push to channel ${channel.id} error:`, err);
            });
        }
      } catch (err) {
        console.error('[channels] Broadcast listener error:', err);
      }
    })();
  });

  return unsubscribe;
}
