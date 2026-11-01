import { randomBytes, randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { cronMatches, isValidCronExpr, parseDelayDuration } from '@botd/protocol';
import type { TriggerKind, TriggerRecord, UserRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { GroupRouter } from './group-router.js';

const VALID_KINDS = new Set<TriggerKind>(['webhook', 'cron', 'once']);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface TriggerSchedulerHandle {
  stop: () => void;
}

export function registerTriggerRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  router: GroupRouter,
  getSessionOwnerId: (sessionId: string) => string | undefined
): TriggerSchedulerHandle {
  // --- 公共 Webhook 入口（鉴权靠 :token，在 index.ts 的认证中间件白名单中放行） ---
  app.post('/api/webhooks/:token', async (c) => {
    const token = c.req.param('token');
    const trigger = db.getTriggerByToken(token);
    if (!trigger || trigger.kind !== 'webhook') {
      return c.json({ error: 'Webhook not found' }, 404);
    }
    if (!trigger.enabled) {
      return c.json({ error: 'Trigger is disabled' }, 403);
    }

    const raw = await c.req.text().catch(() => '');
    let incomingText = raw.trim();
    // JSON body 优先取 message/text/payload 字段，其余整体作为 payload 附加
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) {
        const message = typeof parsed.message === 'string' ? parsed.message
          : typeof parsed.text === 'string' ? parsed.text
          : parsed.payload !== undefined ? JSON.stringify(parsed.payload)
          : undefined;
        incomingText = message ?? JSON.stringify(parsed);
      } else if (typeof parsed === 'string') {
        incomingText = parsed.trim();
      }
    } catch {
      // 纯文本 body，原样使用
    }

    const wakeupMsg = incomingText
      ? `[Webhook: ${trigger.name}] ${trigger.prompt}\nPayload: ${incomingText}`
      : `[Webhook: ${trigger.name}] ${trigger.prompt}`;

    db.markTriggerFired(trigger.id);
    await router.handleWakeup(trigger.sessionId, trigger.botId, wakeupMsg);

    return c.json({ ok: true, triggerId: trigger.id, sessionId: trigger.sessionId });
  });

  // --- 会话触发器 CRUD（Cookie 鉴权） ---
  app.get('/api/sessions/:id/triggers', (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return c.json(db.listSessionTriggers(id));
  });

  app.post('/api/sessions/:id/triggers', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{
      name?: string;
      botId?: string;
      kind?: TriggerKind;
      cronExpr?: string;
      runAt?: string;
      delaySeconds?: number;
      prompt?: string;
      enabled?: boolean;
    }>().catch(() => null);
    if (!isObject(body) || typeof body.name !== 'string' || !body.name.trim()
      || typeof body.botId !== 'string' || !body.botId
      || !VALID_KINDS.has(body.kind as TriggerKind)
      || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return c.json({ error: 'Invalid trigger input' }, 400);
    }
    const kind = body.kind as TriggerKind;

    // botId 必须是会话成员
    const memberIds = new Set([session.leadBotId, ...session.memberBotIds]);
    if (!memberIds.has(body.botId)) {
      return c.json({ error: `Bot ${body.botId} is not a member of the session` }, 400);
    }

    if (kind === 'cron') {
      if (typeof body.cronExpr !== 'string' || !isValidCronExpr(body.cronExpr)) {
        return c.json({ error: '无效的 Cron 表达式（标准 5 段式：分 时 日 月 周）' }, 400);
      }
    }
    if (kind !== 'cron' && body.cronExpr !== undefined) {
      return c.json({ error: 'cronExpr 仅适用于 cron 触发器' }, 400);
    }

    // once 触发器：解析 delaySeconds / runAt 为统一的 ISO 时间点
    let resolvedRunAt: string | undefined;
    if (kind === 'once') {
      if (typeof body.delaySeconds === 'number' && body.delaySeconds > 0) {
        resolvedRunAt = new Date(Date.now() + Math.floor(body.delaySeconds) * 1000).toISOString();
      } else if (typeof body.runAt === 'string' && body.runAt.trim()) {
        const runAtRaw = body.runAt.trim();
        const delaySec = parseDelayDuration(runAtRaw);
        if (delaySec !== null) {
          resolvedRunAt = new Date(Date.now() + delaySec * 1000).toISOString();
        } else {
          const parsed = Date.parse(runAtRaw);
          if (Number.isFinite(parsed)) {
            resolvedRunAt = new Date(parsed).toISOString();
          }
        }
      }
      if (!resolvedRunAt) {
        return c.json({ error: 'once 触发器需要有效的 runAt 时间或 delaySeconds 延时秒数' }, 400);
      }
    }

    const trigger = db.createTrigger({
      id: `trg_${randomUUID()}`,
      sessionId: id,
      ownerId: user.id,
      name: body.name.trim(),
      botId: body.botId,
      kind,
      ...(kind === 'webhook' ? { token: randomBytes(18).toString('hex') } : {}),
      ...(kind === 'cron' ? { cronExpr: body.cronExpr } : {}),
      ...(kind === 'once' ? { runAt: resolvedRunAt } : {}),
      prompt: body.prompt.trim(),
      enabled: body.enabled !== false,
    });

    return c.json(trigger, 201);
  });

  app.patch('/api/triggers/:triggerId', async (c) => {
    const triggerId = c.req.param('triggerId');
    const trigger = db.getTrigger(triggerId);
    if (!trigger) {
      return c.json({ error: 'Trigger not found' }, 404);
    }
    if (trigger.ownerId !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{
      enabled?: boolean;
      name?: string;
      prompt?: string;
      cronExpr?: string;
      runAt?: string;
    }>().catch(() => null);
    if (!isObject(body)) {
      return c.json({ error: 'Invalid trigger patch' }, 400);
    }

    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json({ error: 'enabled must be a boolean' }, 400);
      }
      patch.enabled = body.enabled;
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return c.json({ error: 'Invalid trigger name' }, 400);
      }
      patch.name = body.name.trim();
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return c.json({ error: 'Invalid trigger prompt' }, 400);
      }
      patch.prompt = body.prompt.trim();
    }
    if (body.cronExpr !== undefined) {
      if (typeof body.cronExpr !== 'string' || !isValidCronExpr(body.cronExpr)) {
        return c.json({ error: '无效的 Cron 表达式（标准 5 段式：分 时 日 月 周）' }, 400);
      }
      patch.cronExpr = body.cronExpr;
    }
    if (body.runAt !== undefined) {
      if (typeof body.runAt !== 'string' || !body.runAt.trim() || !Number.isFinite(Date.parse(body.runAt))) {
        return c.json({ error: 'Invalid trigger runAt' }, 400);
      }
      patch.runAt = body.runAt;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'Nothing to update' }, 400);
    }

    const updated = db.updateTrigger(triggerId, patch);
    if (!updated) {
      return c.json({ error: 'Trigger not found' }, 404);
    }
    return c.json(updated);
  });

  app.delete('/api/triggers/:triggerId', (c) => {
    const triggerId = c.req.param('triggerId');
    const trigger = db.getTrigger(triggerId);
    if (!trigger) {
      return c.json({ error: 'Trigger not found' }, 404);
    }
    if (trigger.ownerId !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    db.deleteTrigger(triggerId);
    return c.json({ ok: true });
  });

  // --- 后台调度器：cron 每分钟粒度去重，once 到点单次触发并自动停用 ---
  const pollMs = Math.max(200, Number(process.env.BOTD_TRIGGER_POLL_MS || '2000') || 2000);
  const timer = setInterval(() => {
    try {
      const triggers = db.listAllEnabledScheduledTriggers();
      const now = new Date();
      const nowMinute = Math.floor(now.getTime() / 60_000);
      for (const t of triggers) {
        try {
          if (t.kind === 'once') {
            if (!t.runAt || Date.now() < Date.parse(t.runAt)) continue;
            // 先落库再触发：标记 fired 并停用，确保一次性触发器只触发一次
            db.markTriggerFired(t.id, now.toISOString());
            db.updateTrigger(t.id, { enabled: false });
            void router.handleWakeup(t.sessionId, t.botId, `[Timer: ${t.name}] ${t.prompt}`).catch(() => {});
            continue;
          }
          if (!t.cronExpr || !cronMatches(t.cronExpr, now)) continue;
          // 同一自然分钟内已触发过则跳过，避免巡检导致的重复唤醒
          if (t.lastTriggeredAt && Math.floor(Date.parse(t.lastTriggeredAt) / 60_000) === nowMinute) continue;
          db.markTriggerFired(t.id);
          router.handleWakeup(t.sessionId, t.botId, `[定时任务: ${t.name}] ${t.prompt}`).catch(() => {});
        } catch {
          // 单个触发器异常不应拖垮整轮巡检
        }
      }
    } catch {
      // 调度巡检失败不应拖垮进程
    }
  }, pollMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
