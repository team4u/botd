import { randomUUID } from 'node:crypto';
import { isSafeId, isThinkingLevel } from '@botd/protocol';
import type { CreateSessionInput, SessionModelConfig, SessionModelOverride } from '@botd/protocol';
import { resolveOwnedSession } from '../http-helpers.js';
import {
  cancelDurableSession,
  clearDurableSessionContext,
  ensureRouterConversationId,
  forkDurableSession,
  HUB_ROUTER_BOT_ID,
  resetDurableSession,
  resolveHubRouterBotConfig,
} from './workers.js';
import type { HubDurableRuntime } from '../harness/hub-harness.js';
import type { HubApp, HubContext } from './context.js';

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

interface MemberValidationSuccess {
  ok: true;
  leadBotId: string;
  leadBot: NonNullable<ReturnType<HubContext['db']['getBot']>>;
}

interface MemberValidationFailure {
  ok: false;
  error: string;
  status: 400 | 403;
}

type MemberValidationResult = MemberValidationSuccess | MemberValidationFailure;

function validateSessionMembers(
  db: HubContext['db'],
  userId: string,
  leadBotIdInput: unknown
): MemberValidationResult {
  if (!isSafeId(leadBotIdInput)) {
    return { ok: false, error: 'Invalid lead BOT', status: 400 };
  }
  // 内置中枢总管：不落 SQLite bots 表，以虚拟配置参与会话（免 db.getBot 校验）。
  if (leadBotIdInput === HUB_ROUTER_BOT_ID) {
    return { ok: true, leadBotId: HUB_ROUTER_BOT_ID, leadBot: resolveHubRouterBotConfig(db) };
  }
  const leadBot = db.getBot(leadBotIdInput);
  if (!leadBot) {
    return { ok: false, error: `Lead bot ${leadBotIdInput} not found`, status: 400 };
  }
  if (!db.canUserUseBot(leadBotIdInput, userId)) {
    return { ok: false, error: 'Forbidden', status: 403 };
  }

  return { ok: true, leadBotId: leadBotIdInput, leadBot };
}

export function registerSessionRoutes(app: HubApp, ctx: HubContext): void {
  const { db, router, sseHub, artifacts } = ctx;

  // Session management
  app.get('/api/sessions', (c) => {
    const sessions = db.getAllSessions(c.get('user').id);
    return c.json(
      sessions.map((s) => {
        if (s.status === 'running') {
          const activeBotIds = router.getActiveBotIds(s.id);
          return {
            ...s,
            ...(activeBotIds.length > 0 ? { activeBotIds } : {}),
          };
        }
        return s;
      })
    );
  });

  app.post('/api/sessions', async (c) => {
    const user = c.get('user');
    const body = await c.req.json<CreateSessionInput>().catch(() => null);
    if (!body || !body.title || typeof body.title !== 'string' || !body.title.trim()) {
      return c.json({ error: 'Invalid session title' }, 400);
    }

    const validation = validateSessionMembers(db, user.id, body.leadBotId);
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status);
    }
    const { leadBotId, leadBot } = validation;

    // Space 绑定：未显式指定时默认继承主 Bot 的绑定目录
    const workspaceDir =
      (typeof body.workspaceDir === 'string' && body.workspaceDir.trim())
        ? body.workspaceDir.trim()
        : leadBot.workspaceDir;

    const sessionId = `sess_${randomUUID()}`;
    const session = db.createSession({
      id: sessionId,
      title: body.title.trim(),
      leadBotId,
      ownerId: user.id,
      parentSessionId: body.parentSessionId,
      ...(workspaceDir ? { workspaceDir } : {}),
    });

    return c.json(session);
  });

  app.patch('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

    const body = await c.req.json<{
      title?: string;
      leadBotId?: string;
      archived?: boolean;
      workspaceDir?: string;
    }>().catch(() => null);
    if (!isObject(body)) return c.json({ error: 'Invalid session configuration' }, 400);
    // 归档是纯 UI 分类标记，允许在运行中修改（如「开启新话题」时旧会话仍在后台执行）；
    // 标题/负责人/Space 会改变调度行为，运行中仍需拒绝。
    const touchesConfig =
      body.title !== undefined ||
      body.leadBotId !== undefined ||
      body.workspaceDir !== undefined;
    if (session.status === 'running' && touchesConfig) {
      return c.json({ error: 'Stop the session before changing its configuration' }, 409);
    }
    if (body.archived !== undefined && typeof body.archived !== 'boolean') return c.json({ error: 'Invalid archived flag' }, 400);
    if (body.title !== undefined && !isText(body.title)) return c.json({ error: 'Invalid session title' }, 400);
    if (body.leadBotId !== undefined && !isSafeId(body.leadBotId)) return c.json({ error: 'Invalid lead BOT' }, 400);
    if (body.workspaceDir !== undefined && typeof body.workspaceDir !== 'string') {
      return c.json({ error: 'Invalid workspaceDir' }, 400);
    }

    const validation = validateSessionMembers(db, c.get('user').id, body.leadBotId ?? session.leadBotId);
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status);
    }
    const { leadBotId } = validation;

    // 配置成员变更时统一失效旧队列，复用 cancelSession，防止 queued 任务绕过新配置
    if (touchesConfig) {
      await router.cancelSession(id);
    }

    const updated = db.updateSession(id, {
      title: body.title?.trim(),
      leadBotId,
      archived: body.archived,
      ...(body.workspaceDir !== undefined ? { workspaceDir: body.workspaceDir } : {}),
    });
    return c.json(updated);
  });

  app.post('/api/sessions/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    await router.cancelSession(id);
    // Durable 侧同步停止：running Worker 与 Router 会话自身的回合一并中止。
    if (ctx.durableRuntime) await cancelDurableSession(ctx.durableRuntime, id);
    return c.json({ ok: true });
  });

  // 子代理运行控制已迁移到 Durable Worker 路由：
  // POST /api/sessions/:id/workers/:workerId/stop 与 /steer（routes/workers.ts）。

  // 会话分叉：以某条消息为锚点克隆出新会话（含锚点及其之前的消息），源会话完全不动。
  // 允许 running 中分叉：只读源会话 + 新建独立会话，不打扰执行中的回合；新会话尚无订阅者，无需 SSE 广播。
  app.post('/api/sessions/:id/fork', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const body = await c.req.json<{ anchorMessageId?: string }>().catch(() => null);
    if (!isObject(body) || !isText(body.anchorMessageId)) {
      return c.json({ error: 'Invalid anchorMessageId' }, 400);
    }

    const forked = db.forkSession(id, body.anchorMessageId);
    if (!forked) {
      return c.json({ error: 'Session or anchor message not found' }, 404);
    }

    // Durable 侧同步零拷贝分叉：若源会话已有 Durable Router 会话，通过 pi-durable 原生
    // conv.fork(atEntryId) 在锚点消息对应的 Entry 处分叉并绑定到新会话。
    if (ctx.durableRuntime) {
      const forkedMessages = db.getMessages(forked.id);
      const anchorMsg = forkedMessages.at(-1);
      if (anchorMsg) {
        await forkDurableSession(ctx.durableRuntime, {
          sourceSessionId: id,
          targetSessionId: forked.id,
          anchorMessage: anchorMsg,
          botId: forked.leadBotId,
          messagesUpToAnchor: forkedMessages,
        }).catch((err) => {
          console.warn('[sessions] durable fork skipped:', err instanceof Error ? err.message : err);
        });
      }
    }

    return c.json(forked, 201);
  });

  app.delete('/api/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;
    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before clearing messages' }, 409);
    }

    // 验证后，使用 Router 统一失效旧队列，复用 cancelSession
    await router.cancelSession(id);

    // Durable 侧同步重置：默认停掉 running Worker / 中止 Router 回合，并清掉会话映射，
    // 清空后的下一条消息重新懒建全新 Router 会话；`?keepWorkers=1`（/clear）则原地
    // 清空上下文 —— 仅 pi.reset 边界，保留会话映射与正在运行的后台 Worker。
    const keepWorkers = c.req.query('keepWorkers') === '1';
    const rt = ctx.durableRuntime ?? (ctx.getDurableRuntime ? await ctx.getDurableRuntime() : undefined);
    if (rt) {
      if (keepWorkers) {
        await clearDurableSessionContext(rt, id);
      } else {
        await resetDurableSession(rt, id);
      }
    }

    db.clearSessionMessages(id);
    // 同步清空各成员节点的本地会话记忆（best-effort，失败在方法内部吞掉）
    await router.resetMemberSessions(id);
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;
    if (db.getSessionOwner(id) !== c.get('user').id) {
      return c.json({ error: 'Only owner can delete session' }, 403);
    }
    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before deleting it' }, 409);
    }

    // 验证后，使用 Router 统一失效旧队列，复用 cancelSession
    await router.cancelSession(id);

    // Durable 侧同步重置（与清空消息同构）：停 Worker + 清会话映射。
    if (ctx.durableRuntime) await resetDurableSession(ctx.durableRuntime, id);

    // resetMemberSessions 内部要查会话成员，必须在 deleteSession 之前调用
    await router.resetMemberSessions(id);
    artifacts.deleteSession(id);
    // 广播 idle 让子会话委派的 SSE 监听闭包自行清理，避免永久挂在 SseHub.listeners
    sseHub.broadcast(id, {
      type: 'session_status',
      sessionId: id,
      status: 'idle',
      activeBotId: undefined,
      activeBotIds: [],
    });
    return c.json({ ok: true });
  });

  // --- 会话级模型覆盖 -------------------------------------------------------
  // 单会话秒切模型：覆盖只落在该会话的 Router 会话上，不改动全局 Bot 配置，
  // 同 Bot 的兄弟会话不受影响；PUT 后显式尝试恢复失败回合（恢复失败不影响保存结果）。

  /** 取运行时并同步 Hub 当前分身配置。 */
  const modelRuntime = async (): Promise<HubDurableRuntime | undefined> =>
    ctx.getDurableRuntime ? await ctx.getDurableRuntime() : ctx.durableRuntime;

  /** 解析会话 Router 会话 id；分身缺失等配置错误返回 400，其余内部错误返回 500 */
  const modelConversation = async (
    rt: HubDurableRuntime,
    session: { id: string; leadBotId: string; workspaceDir?: string },
  ): Promise<{ ok: true; conversationId: string } | { ok: false; error: string; status: 400 | 500 }> => {
    try {
      const conversationId = await ensureRouterConversationId(rt, session.id, session.leadBotId, {
        workspaceDir: session.workspaceDir,
      });
      return { ok: true, conversationId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('unknown persona') ? 400 : 500;
      return { ok: false, error: message, status };
    }
  };

  app.get('/api/sessions/:id/model', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const rt = await modelRuntime();
    if (!rt) return c.json({ error: 'Durable runtime unavailable' }, 503);
    const conv = await modelConversation(rt, sRes.session);
    if (!conv.ok) return c.json({ error: conv.error }, conv.status);

    try {
      const config = await rt.getConversationModelConfig(conv.conversationId);
      const body: SessionModelConfig = { ...config, resumed: false };
      return c.json(body);
    } catch (err) {
      console.warn('[sessions] get conversation model config failed:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Failed to load session model config' }, 500);
    }
  });

  app.put('/api/sessions/:id/model', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

    const body = await c.req.json<{ override?: SessionModelOverride | null }>().catch(() => null);
    if (!isObject(body) || !('override' in body)) {
      return c.json({ error: 'Invalid model override body' }, 400);
    }
    let override: SessionModelOverride | null = null;
    if (body.override !== null && body.override !== undefined) {
      const raw = body.override;
      if (!isObject(raw) || !isText(raw.provider) || !isText(raw.modelId)) {
        return c.json({ error: 'Invalid model override: provider and modelId are required' }, 400);
      }
      if (raw.thinkingLevel !== undefined && !isThinkingLevel(raw.thinkingLevel)) {
        return c.json({ error: 'Invalid thinkingLevel' }, 400);
      }
      override = {
        provider: raw.provider.trim(),
        modelId: raw.modelId.trim(),
        ...(raw.thinkingLevel !== undefined ? { thinkingLevel: raw.thinkingLevel } : {}),
      };
    }

    const rt = await modelRuntime();
    if (!rt) return c.json({ error: 'Durable runtime unavailable' }, 503);
    const conv = await modelConversation(rt, session);
    if (!conv.ok) return c.json({ error: conv.error }, conv.status);

    // 保存与恢复分开：覆盖落盘成功即成功，setter 返回实际保存的 {override, effective}；
    // 恢复失败回合失败只降级 resumed=false，绝不影响已保存的配置。
    let savedConfig: SessionModelConfig;
    try {
      savedConfig = await rt.setConversationModelOverride(conv.conversationId, override);
    } catch (err) {
      console.warn('[sessions] set conversation model override failed:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Failed to save session model override' }, 500);
    }
    let resumed = false;
    try {
      resumed = await rt.resumeFailedConversation(conv.conversationId);
    } catch (err) {
      console.warn('[sessions] resume failed conversation skipped:', err instanceof Error ? err.message : err);
    }
    return c.json({ ...savedConfig, resumed });
  });
}
