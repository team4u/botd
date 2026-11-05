// 触发器路由装配层：请求体校验 + 路由注册。求值/分发/调度机制见 trigger-service.ts。
import { randomBytes, randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { isValidCronExpr, parseDelayDuration } from '@botd/protocol';
import type { SessionRecord, TriggerEventFilter, TriggerKind, UserRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import { TriggerService, type OwnedTrigger, type TriggerSchedulerHandle, type TriggerServiceOptions } from './trigger-service.js';
import { resolveOwnedSession, type AuthContext } from './http-helpers.js';

// 机制层的纯函数与类型经此 re-export，保持外部导入路径（tests、index.ts）不变
export { extractWebhookEventMeta, matchesEventFilter } from './trigger-service.js';

const VALID_KINDS = new Set<TriggerKind>(['webhook', 'cron', 'once']);
const VALID_DISPATCH_MODES = new Set<string>(['append', 'subsession']);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type TriggerRoutesOptions = TriggerServiceOptions;

type CreateTriggerBody = {
  name?: string;
  botId?: string;
  kind?: TriggerKind;
  cronExpr?: string;
  runAt?: string;
  delaySeconds?: number;
  prompt?: string;
  enabled?: boolean;
  dispatchMode?: string;
  skillId?: string;
  secret?: string;
  eventFilter?: TriggerEventFilter;
};

/** 校验 eventFilter：source 非空串 / types 为非空串数组 / payloadMatch 值为基础类型 */
function validateEventFilter(f: unknown): string | null {
  if (!isObject(f)) return 'Invalid eventFilter';
  if (f.source !== undefined && (typeof f.source !== 'string' || !f.source)) {
    return 'eventFilter.source must be a non-empty string';
  }
  if (f.types !== undefined && (!Array.isArray(f.types) || !f.types.every((t) => typeof t === 'string' && t))) {
    return 'eventFilter.types must be an array of non-empty strings';
  }
  if (
    f.payloadMatch !== undefined &&
    (!isObject(f.payloadMatch) ||
      !Object.values(f.payloadMatch).every((v) => ['string', 'number', 'boolean'].includes(typeof v)) ||
      !Object.keys(f.payloadMatch).every((k) => k.trim().length > 0))
  ) {
    return 'eventFilter.payloadMatch values must be string/number/boolean with non-empty keys';
  }
  return null;
}

/** once 触发器：解析 delaySeconds / runAt 为统一的 ISO 时间点；无法解析返回 null */
function resolveOnceRunAt(body: CreateTriggerBody): string | null {
  if (typeof body.delaySeconds === 'number' && body.delaySeconds > 0) {
    return new Date(Date.now() + Math.floor(body.delaySeconds) * 1000).toISOString();
  }
  if (typeof body.runAt === 'string' && body.runAt.trim()) {
    const runAtRaw = body.runAt.trim();
    const delaySec = parseDelayDuration(runAtRaw);
    if (delaySec !== null) return new Date(Date.now() + delaySec * 1000).toISOString();
    const parsed = Date.parse(runAtRaw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/** 校验触发器创建入参并构造 db.createTrigger 输入；不合法时返回错误消息（统一 400） */
function parseTriggerCreate(
  session: SessionRecord,
  sessionId: string,
  ownerId: string,
  body: unknown
): { ok: true; input: Parameters<HubDatabase['createTrigger']>[0] } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: 'Invalid trigger input' };
  const b = body as CreateTriggerBody;
  if (typeof b.name !== 'string' || !b.name.trim()
    || typeof b.botId !== 'string' || !b.botId
    || !VALID_KINDS.has(b.kind as TriggerKind)
    || typeof b.prompt !== 'string' || !b.prompt.trim()) {
    return { ok: false, error: 'Invalid trigger input' };
  }
  const kind = b.kind as TriggerKind;

  // botId 必须是会话主控
  if (b.botId !== session.leadBotId) {
    return { ok: false, error: `Bot ${b.botId} is not a member of the session` };
  }

  if (kind === 'cron') {
    if (typeof b.cronExpr !== 'string' || !isValidCronExpr(b.cronExpr)) {
      return { ok: false, error: '无效的 Cron 表达式（标准 5 段式：分 时 日 月 周）' };
    }
  }
  if (kind !== 'cron' && b.cronExpr !== undefined) {
    return { ok: false, error: 'cronExpr 仅适用于 cron 触发器' };
  }

  // dispatchMode / skillId / secret / eventFilter 校验
  if (b.dispatchMode !== undefined && !VALID_DISPATCH_MODES.has(b.dispatchMode)) {
    return { ok: false, error: "dispatchMode must be 'append' or 'subsession'" };
  }
  if (b.skillId !== undefined && (typeof b.skillId !== 'string' || !b.skillId.trim())) {
    return { ok: false, error: 'Invalid skillId' };
  }
  if (b.secret !== undefined && (typeof b.secret !== 'string' || !b.secret.trim())) {
    return { ok: false, error: 'Invalid secret' };
  }
  if (b.eventFilter !== undefined) {
    const err = validateEventFilter(b.eventFilter);
    if (err) return { ok: false, error: err };
  }

  // once 触发器：解析 delaySeconds / runAt 为统一的 ISO 时间点
  let resolvedRunAt: string | undefined;
  if (kind === 'once') {
    resolvedRunAt = resolveOnceRunAt(b) ?? undefined;
    if (!resolvedRunAt) {
      return { ok: false, error: 'once 触发器需要有效的 runAt 时间或 delaySeconds 延时秒数' };
    }
  }

  return {
    ok: true,
    input: {
      id: `trg_${randomUUID()}`,
      sessionId,
      ownerId,
      name: b.name.trim(),
      botId: b.botId,
      kind,
      ...(kind === 'webhook' ? { token: randomBytes(18).toString('hex') } : {}),
      ...(kind === 'cron' ? { cronExpr: b.cronExpr } : {}),
      ...(kind === 'once' ? { runAt: resolvedRunAt } : {}),
      prompt: b.prompt.trim(),
      enabled: b.enabled !== false,
      ...(b.dispatchMode ? { dispatchMode: b.dispatchMode as 'append' | 'subsession' } : {}),
      ...(b.skillId ? { skillId: b.skillId.trim() } : {}),
      ...(b.secret ? { secret: b.secret.trim() } : {}),
      ...(b.eventFilter ? { eventFilter: b.eventFilter } : {}),
    },
  };
}

type PatchTriggerBody = {
  enabled?: boolean;
  name?: string;
  prompt?: string;
  cronExpr?: string;
  runAt?: string;
  dispatchMode?: string;
  skillId?: string | null;
  secret?: string | null;
  eventFilter?: TriggerEventFilter | null;
};

/** 校验触发器 PATCH 入参并构造 patch 对象；空 patch 返回错误（统一 400） */
function parseTriggerPatch(
  body: unknown
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: 'Invalid trigger patch' };
  const b = body as PatchTriggerBody;

  const patch: Record<string, unknown> = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean' };
    }
    patch.enabled = b.enabled;
  }
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return { ok: false, error: 'Invalid trigger name' };
    }
    patch.name = b.name.trim();
  }
  if (b.prompt !== undefined) {
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) {
      return { ok: false, error: 'Invalid trigger prompt' };
    }
    patch.prompt = b.prompt.trim();
  }
  if (b.cronExpr !== undefined) {
    if (typeof b.cronExpr !== 'string' || !isValidCronExpr(b.cronExpr)) {
      return { ok: false, error: '无效的 Cron 表达式（标准 5 段式：分 时 日 月 周）' };
    }
    patch.cronExpr = b.cronExpr;
  }
  if (b.runAt !== undefined) {
    const runAt = b.runAt;
    if (typeof runAt !== 'string' || !runAt.trim() || !Number.isFinite(Date.parse(runAt))) {
      return { ok: false, error: 'Invalid trigger runAt' };
    }
    patch.runAt = runAt;
  }
  if (b.dispatchMode !== undefined) {
    if (!VALID_DISPATCH_MODES.has(b.dispatchMode)) {
      return { ok: false, error: "dispatchMode must be 'append' or 'subsession'" };
    }
    patch.dispatchMode = b.dispatchMode;
  }
  if (b.skillId !== undefined) {
    if (b.skillId === null || b.skillId === '') {
      patch.skillId = null;
    } else if (typeof b.skillId === 'string' && b.skillId.trim()) {
      patch.skillId = b.skillId.trim();
    } else {
      return { ok: false, error: 'Invalid skillId' };
    }
  }
  if (b.secret !== undefined) {
    if (b.secret === null || b.secret === '') {
      patch.secret = null;
    } else if (typeof b.secret === 'string' && b.secret.trim()) {
      patch.secret = b.secret.trim();
    } else {
      return { ok: false, error: 'Invalid secret' };
    }
  }
  if (b.eventFilter !== undefined) {
    if (b.eventFilter === null) {
      patch.eventFilter = null;
    } else {
      const err = validateEventFilter(b.eventFilter);
      if (err) return { ok: false, error: err };
      patch.eventFilter = b.eventFilter;
    }
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'Nothing to update' };
  }
  return { ok: true, patch };
}

/** 加载触发器并校验归属；未找到 / 无权限时返回对应 HTTP 响应 */
function resolveOwnedTrigger(
  c: AuthContext,
  db: HubDatabase,
  triggerId: string
): { ok: true; trigger: OwnedTrigger } | { ok: false; response: Response } {
  const trigger = db.getTrigger(triggerId);
  if (!trigger) {
    return { ok: false as const, response: c.json({ error: 'Trigger not found' }, 404) };
  }
  if (trigger.ownerId !== c.get('user').id) {
    return { ok: false as const, response: c.json({ error: 'Forbidden' }, 403) };
  }
  return { ok: true as const, trigger };
}

export function registerTriggerRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  router: unknown,
  getSessionOwnerId?: (sessionId: string) => string | undefined,
  options?: TriggerRoutesOptions
): TriggerSchedulerHandle {
  const service = new TriggerService(db, router, getSessionOwnerId, options);

  // --- 公共 Webhook 入口（鉴权靠 :token，在 index.ts 的认证中间件白名单中放行） ---
  app.post('/api/webhooks/:token', async (c) => {
    const result = await service.processWebhook(
      c.req.param('token'),
      () => c.req.text().catch(() => ''),
      (name) => c.req.header(name)
    );
    return c.json(result.body, result.status);
  });

  // --- 会话事件查询（Event Inbox 列表）---
  // 注：GET /api/sessions/:id/events 已被 SSE 流占用，事件收件箱走 /automation-events
  app.get('/api/sessions/:id/automation-events', (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const limitRaw = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
    return c.json(db.listSessionAutomationEvents(id, limit));
  });

  // --- 会话触发器 CRUD（Cookie 鉴权） ---
  app.get('/api/sessions/:id/triggers', (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    return c.json(db.listSessionTriggers(id));
  });

  app.post('/api/sessions/:id/triggers', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const body = await c.req.json<CreateTriggerBody>().catch(() => null);
    const parsed = parseTriggerCreate(sRes.session, id, c.get('user').id, body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    return c.json(db.createTrigger(parsed.input), 201);
  });

  app.patch('/api/triggers/:triggerId', async (c) => {
    const triggerId = c.req.param('triggerId');
    const tRes = resolveOwnedTrigger(c, db, triggerId);
    if (!tRes.ok) return tRes.response;

    const body = await c.req.json().catch(() => null);
    const parsed = parseTriggerPatch(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const updated = db.updateTrigger(triggerId, parsed.patch);
    if (!updated) {
      return c.json({ error: 'Trigger not found' }, 404);
    }
    // 所有者显式更新触发器：重置该触发器的 webhook 限流窗口
    service.webhookGuard.resetRateLimit(triggerId);
    return c.json(updated);
  });

  app.post('/api/triggers/:triggerId/run', async (c) => {
    const triggerId = c.req.param('triggerId');
    const tRes = resolveOwnedTrigger(c, db, triggerId);
    if (!tRes.ok) return tRes.response;

    // fire-and-forget 语义保持：分发不等待回合完成，但会同步完成提交
    // （含 Durable 主线切流），childSessionId（subsession 模式）照常返回。
    const { childSessionId } = await service.dispatchTrigger(
      tRes.trigger,
      `[手动触发: ${tRes.trigger.name}] ${tRes.trigger.prompt}`,
    );

    return c.json({ ok: true, ...(childSessionId ? { childSessionId } : {}) });
  });

  app.delete('/api/triggers/:triggerId', (c) => {
    const triggerId = c.req.param('triggerId');
    const tRes = resolveOwnedTrigger(c, db, triggerId);
    if (!tRes.ok) return tRes.response;
    db.deleteTrigger(triggerId);
    return c.json({ ok: true });
  });

  // --- 后台调度器：cron 每分钟粒度去重，once 到点单次触发并自动停用 ---
  return service.startScheduler();
}
