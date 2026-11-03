import { randomUUID } from 'node:crypto';
import { isSafeId } from '@botd/protocol';
import type { CreateSessionInput, SessionMode } from '@botd/protocol';
import { resolveOwnedSession } from '../http-helpers.js';
import type { HubApp, HubContext } from './context.js';

const VALID_MODES = new Set<SessionMode>(['direct']);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

interface MemberValidationSuccess {
  ok: true;
  leadBotId: string;
  memberBotIds: string[];
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
  mode: SessionMode,
  leadBotIdInput: unknown,
  _memberBotIdsInput?: unknown
): MemberValidationResult {
  if (mode !== 'direct') {
    return { ok: false, error: 'Invalid session mode', status: 400 };
  }
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

  return { ok: true, leadBotId: leadBotIdInput, memberBotIds: [leadBotIdInput] };
}

export function registerSessionRoutes(app: HubApp, ctx: HubContext): void {
  const { db, router, sseHub, artifacts } = ctx;

  // Session management
  app.get('/api/sessions', (c) => {
    const sessions = db.getAccessibleSessions(c.get('user').id);
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
    if (!VALID_MODES.has(body.mode)) {
      return c.json({ error: 'Invalid session mode' }, 400);
    }

    const validation = validateSessionMembers(db, user.id, body.mode, body.leadBotId, body.memberBotIds);
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status);
    }
    const { leadBotId, memberBotIds } = validation;

    const sessionId = `sess_${randomUUID()}`;
    const session = db.createSession({
      id: sessionId,
      title: body.title.trim(),
      mode: body.mode,
      leadBotId,
      memberBotIds,
      ownerId: user.id,
      parentSessionId: body.parentSessionId,
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
      mode?: SessionMode;
      leadBotId?: string;
      memberBotIds?: string[];
      archived?: boolean;
      pinned?: boolean;
    }>().catch(() => null);
    if (!isObject(body)) return c.json({ error: 'Invalid session configuration' }, 400);
    // 归档是纯 UI 分类标记，允许在运行中修改（如「开启新话题」时旧会话仍在后台执行）；
    // 标题/模式/负责人/成员会改变调度行为，运行中仍需拒绝。
    const touchesConfig =
      body.title !== undefined ||
      body.mode !== undefined ||
      body.leadBotId !== undefined ||
      body.memberBotIds !== undefined;
    if (session.status === 'running' && touchesConfig) {
      return c.json({ error: 'Stop the session before changing its configuration' }, 409);
    }
    if (body.archived !== undefined && typeof body.archived !== 'boolean') return c.json({ error: 'Invalid archived flag' }, 400);
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') return c.json({ error: 'Invalid pinned flag' }, 400);
    if (body.title !== undefined && !isText(body.title)) return c.json({ error: 'Invalid session title' }, 400);
    if (body.leadBotId !== undefined && !isSafeId(body.leadBotId)) return c.json({ error: 'Invalid lead BOT' }, 400);
    if (body.memberBotIds !== undefined && (!Array.isArray(body.memberBotIds) || !body.memberBotIds.every(isSafeId))) {
      return c.json({ error: 'Invalid memberBotIds' }, 400);
    }

    if (body.mode !== undefined && !VALID_MODES.has(body.mode)) {
      return c.json({ error: 'Invalid session mode' }, 400);
    }

    const mode = body.mode ?? session.mode;
    const targetLead = body.leadBotId ?? session.leadBotId;
    const targetMembers = body.memberBotIds ?? session.memberBotIds;

    const validation = validateSessionMembers(db, c.get('user').id, mode, targetLead, targetMembers);
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status);
    }
    const { leadBotId, memberBotIds } = validation;

    // 配置成员变更时统一失效旧队列，复用 cancelSession，防止 queued 任务绕过新配置
    if (touchesConfig) {
      await router.cancelSession(id);
    }

    const updated = db.updateSession(id, {
      title: body.title?.trim(),
      mode,
      leadBotId,
      memberBotIds,
      archived: body.archived,
      pinned: body.pinned,
    });
    return c.json(updated);
  });

  app.post('/api/sessions/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    await router.cancelSession(id);
    return c.json({ ok: true });
  });

  // 单独停掉某个运行中的子代理（按 runId），不中断主回合与其他并发子代理
  app.post('/api/sessions/:id/subagents/:runId/stop', async (c) => {
    const id = c.req.param('id');
    const runId = c.req.param('runId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    try {
      const result = await router.stopSubagent(id, runId);
      if (!result.ok) {
        return c.json({ error: result.error || 'Failed to stop subagent' }, 400);
      }
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to stop subagent' }, 500);
    }
  });

  // 向某个子代理发送 steer（运行中插话）或 resume（结束后追问，同一 runId 上下文继续）
  app.post('/api/sessions/:id/subagents/:runId/interact', async (c) => {
    const id = c.req.param('id');
    const runId = c.req.param('runId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const body = await c.req
      .json<{ message?: string; mode?: 'steer' | 'resume'; subagentId?: string }>()
      .catch(() => null);
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }
    const mode = body.mode === 'resume' ? 'resume' : 'steer';

    try {
      const result = await router.interactSubagent(id, runId, body.message, mode, body.subagentId);
      if (!result.ok) {
        return c.json({ error: result.error || 'Failed to interact with subagent', ...(result.run ? { run: result.run } : {}) }, 400);
      }
      return c.json({ ok: true, run: result.run });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to interact with subagent' }, 500);
    }
  });

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

  // Session Participants API
  app.get('/api/sessions/:id/participants', (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    return c.json(db.listSessionParticipants(id));
  });

  app.post('/api/sessions/:id/participants', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    if (db.getSessionOwner(id) !== c.get('user').id) {
      return c.json({ error: 'Only session owner can add participants' }, 403);
    }
    const body = await c.req.json<{ userId?: string; username?: string; role?: 'owner' | 'member' }>().catch(() => null);
    if (!body || (!body.userId && !body.username)) {
      return c.json({ error: 'userId or username required' }, 400);
    }
    const targetUser = body.username ? db.getUserByUsername(body.username) : db.getUser(body.userId!);
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }
    const role = body.role === 'owner' ? 'owner' : 'member';
    db.addSessionParticipant(id, targetUser.id, role);
    return c.json({
      ok: true,
      participant: {
        sessionId: id,
        userId: targetUser.id,
        username: targetUser.username,
        role,
        joinedAt: new Date().toISOString(),
      },
    });
  });

  app.delete('/api/sessions/:id/participants/:userId', (c) => {
    const id = c.req.param('id');
    const userId = c.req.param('userId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const callerId = c.get('user').id;
    const isOwner = db.getSessionOwner(id) === callerId;
    const isSelf = callerId === userId;
    if (!isOwner && !isSelf) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    db.removeSessionParticipant(id, userId);
    return c.json({ ok: true });
  });
}
