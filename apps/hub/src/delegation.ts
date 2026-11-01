import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type {
  DelegateSessionInput,
  DelegateSessionResult,
  MessageAttachment,
  SessionMode,
  UserRecord,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { GroupRouter } from './group-router.js';
import type { SseHub } from './sse.js';
import { resolveOwnedSession } from './http-helpers.js';

const VALID_MODES = new Set<SessionMode>(['direct', 'lead', 'roundtable']);

export function registerDelegationRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  router: GroupRouter,
  sseHub: SseHub,
  _getSessionOwnerId?: (sessionId: string) => string | undefined
): void {
  // GET /api/sessions/:id/subsessions
  app.get('/api/sessions/:id/subsessions', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const subsessions = db.listSubSessions(id);
    return c.json(subsessions);
  });

  // POST /api/sessions/:id/delegate
  app.post('/api/sessions/:id/delegate', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const user = c.get('user');
    const body = await c.req.json<DelegateSessionInput>().catch(() => null);
    if (
      !body ||
      typeof body.botId !== 'string' ||
      !body.botId.trim() ||
      typeof body.prompt !== 'string' ||
      !body.prompt.trim()
    ) {
      return c.json({ error: 'botId and non-empty prompt are required' }, 400);
    }

    if (body.mode && !VALID_MODES.has(body.mode)) {
      return c.json({ error: 'Invalid session mode' }, 400);
    }

    const botId = body.botId.trim();
    const bot = db.getBot(botId);
    if (!bot) {
      return c.json({ error: `Bot ${botId} not found` }, 404);
    }
    if (db.getNodeOwner(bot.nodeId) !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (body.memberBotIds !== undefined) {
      if (!Array.isArray(body.memberBotIds) || !body.memberBotIds.every((m) => typeof m === 'string' && m.trim())) {
        return c.json({ error: 'Invalid memberBotIds' }, 400);
      }
      for (const mId of body.memberBotIds) {
        const mTrimmed = mId.trim();
        const mBot = db.getBot(mTrimmed);
        if (!mBot) {
          return c.json({ error: `Member bot ${mTrimmed} not found` }, 404);
        }
        if (db.getNodeOwner(mBot.nodeId) !== user.id) {
          return c.json({ error: 'Forbidden' }, 403);
        }
      }
    }

    const title = body.title?.trim() || `[子任务] ${body.prompt.trim().slice(0, 28)}`;
    const mode: SessionMode = body.mode || 'direct';
    const memberBotIds = Array.from(new Set([botId, ...(body.memberBotIds?.map((m) => m.trim()) || [])]));

    const childSessionId = `sess_${randomUUID()}`;
    const childSession = db.createSession({
      id: childSessionId,
      title,
      mode,
      leadBotId: botId,
      memberBotIds,
      ownerId: user.id,
      parentSessionId: id,
    });

    // 在父会话中插入一条 role: 'callback'、senderBotId: body.botId 的公屏通知消息并广播 SSE message_created
    const parentNoticeContent = `📋 已派生子会话「[${childSession.title}](#?s=${childSession.id})」交由 @${botId} 执行任务。`;
    const parentNoticeMsg = db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId: id,
      role: 'callback',
      senderBotId: botId,
      content: parentNoticeContent,
      mentions: [],
    });
    sseHub.broadcast(id, {
      type: 'message_created',
      message: parentNoticeMsg.message,
    });

    // 若请求中指定了 artifactIds，或父会话存在产物，则将对应产物复制/关联给子会话
    const targetArtifacts = (Array.isArray(body.artifactIds) && body.artifactIds.length > 0)
      ? body.artifactIds
          .map((artId) => (typeof artId === 'string' ? db.getArtifactWithStoragePath(artId.trim()) : undefined))
          .filter((art): art is NonNullable<typeof art> => Boolean(art && art.sessionId === id))
      : db.listSessionArtifacts(id).map((a) => db.getArtifactWithStoragePath(a.id)).filter((art): art is NonNullable<typeof art> => Boolean(art));

    const copiedAttachments: MessageAttachment[] = [];
    for (const art of targetArtifacts) {
      const childArtId = `art_${randomUUID()}`;
      db.createArtifact({
        id: childArtId,
        sessionId: childSession.id,
        filename: art.filename,
        mimeType: art.mimeType,
        sizeBytes: art.sizeBytes,
        senderBotId: art.senderBotId,
        storagePath: art.storagePath,
      });
      copiedAttachments.push({
        id: childArtId,
        filename: art.filename,
        mimeType: art.mimeType,
        sizeBytes: art.sizeBytes,
        url: `/api/artifacts/${childArtId}`,
      });
    }

    let initialPrompt = body.prompt.trim();
    if (copiedAttachments.length > 0) {
      const artifactLines = copiedAttachments.map((a) => `- ${a.filename} (${a.url})`).join('\n');
      initialPrompt += `\n\n[关联产物文件]:\n${artifactLines}`;
    }

    // 在子会话中插入初始用户消息并广播 SSE message_created
    const initialMsg = db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId: childSession.id,
      role: 'user',
      content: initialPrompt,
      mentions: [],
      attachments: copiedAttachments.length > 0 ? copiedAttachments : undefined,
    });
    sseHub.broadcast(childSession.id, {
      type: 'message_created',
      message: initialMsg.message,
    });

    // 唤醒父会话 Lead Bot 执行后续汇总或处理
    const wakeParent = (triggerMsgId: string, summaryText: string) => {
      const autoWake = (body as any).autoWakeParent !== false;
      if (!autoWake) return;
      const parentSession = db.getSession(id);
      if (!parentSession?.leadBotId) return;
      if (!router.canRunBot(id, parentSession.leadBotId)) return;
      router.handleUserMessage(
        id,
        triggerMsgId,
        `@${parentSession.leadBotId} ${summaryText}`
      );
    };

    // 监听子会话的首轮任务完成
    let unsubscribed = false;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };

    unsubscribe = sseHub.subscribe(childSession.id, (event) => {
      if (event.type !== 'session_status') return;
      if (event.status === 'idle') {
        cleanup();
        const messages = db.getMessages(childSession.id);
        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
        const summary = lastAssistant?.content?.trim() || '(无回复内容)';
        const callbackContent = `✅ 子会话「[${childSession.title}](#?s=${childSession.id})」已完成：\n\n${summary}`;
        const resultMsg = db.createMessage({
          id: `msg_${randomUUID()}`,
          sessionId: id,
          role: 'callback',
          senderBotId: botId,
          content: callbackContent,
          mentions: [],
        });
        sseHub.broadcast(id, {
          type: 'message_created',
          message: resultMsg.message,
        });
        wakeParent(resultMsg.message.id, `子会话「${childSession.title}」已完成，请汇总处理。`);
      } else if (event.status === 'failed') {
        cleanup();
        const messages = db.getMessages(childSession.id);
        const lastSys = [...messages].reverse().find((m) => m.role === 'system');
        const failContent = `❌ 子会话「[${childSession.title}](#?s=${childSession.id})」执行失败：\n\n${lastSys?.content?.trim() || '(未知错误)'}`;
        const failMsg = db.createMessage({
          id: `msg_${randomUUID()}`,
          sessionId: id,
          role: 'callback',
          senderBotId: botId,
          content: failContent,
          mentions: [],
        });
        sseHub.broadcast(id, {
          type: 'message_created',
          message: failMsg.message,
        });
        wakeParent(failMsg.message.id, `子会话「${childSession.title}」执行失败，请处理异常。`);
      }
    });

    // 调用 router.handleUserMessage 启动子会话执行
    router.handleUserMessage(childSession.id, initialMsg.message.id, initialMsg.message.content);

    // 返回 201
    const result: DelegateSessionResult = {
      parentSessionId: id,
      childSession,
      initialMessage: initialMsg.message,
    };
    return c.json(result, 201);
  });
}
