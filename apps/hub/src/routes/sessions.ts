import { randomUUID } from 'node:crypto';
import { isSafeId } from '@botd/protocol';
import type { CreateSessionInput } from '@botd/protocol';
import { resolveOwnedSession } from '../http-helpers.js';
import { cancelDurableSession, forkDurableSession, resetDurableSession } from './workers.js';
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

    // Durable 侧同步重置：停掉 running Worker / 中止 Router 回合，并清掉会话映射，
    // 清空后的下一条消息重新懒建全新 Router 会话。
    if (ctx.durableRuntime) await resetDurableSession(ctx.durableRuntime, id);

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
}
