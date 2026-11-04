import { randomUUID } from 'node:crypto';
import type { MessageAttachment } from '@botd/protocol';
import { extractMentions, parseSlashCommand } from '../group-router.js';
import { resolveOwnedSession } from '../http-helpers.js';
import type { ArtifactActor, ArtifactService } from '../artifact-service.js';
import type { HubDatabase } from '../db.js';
import {
  rewindDurableSessionBeforeMessage,
  submitSessionMessageToDurable,
  type DurableSessionMirror,
} from './workers.js';
import type { HubDurableRuntime } from '../harness/hub-harness.js';
import type { HubApp, HubContext } from './context.js';

const DATA_URL_PATTERN = /^data:([^;]+);base64,([\s\S]+)$/;

/** 解析内联 dataUrl（`data:<mime>;base64,xxx` 或裸 base64）为字节缓冲。 */
function decodeInlineDataUrl(dataUrl: string): { buffer: Buffer; mimeType?: string } | undefined {
  const match = DATA_URL_PATTERN.exec(dataUrl.trim());
  const encoded = match ? match[2] : dataUrl.trim();
  if (!encoded) return undefined;
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0) return undefined;
  return { buffer, ...(match ? { mimeType: match[1] } : {}) };
}

/**
 * 消息附件规范化：内联 dataUrl 自动落盘为 Artifact（物理字节只住磁盘），
 * 并剥离一切 dataUrl 字段——SQLite `messages.attachments_json` 永远只存
 * 轻量指针 `{ id, filename, mimeType, sizeBytes, url }`，杜绝 base64 膨胀。
 */
function normalizeMessageAttachments(
  rawAttachments: readonly unknown[],
  input: {
    db: Pick<HubDatabase, 'getArtifact'>;
    artifacts: Pick<ArtifactService, 'uploadArtifactBuffer'>;
    sessionId: string;
    actor: ArtifactActor;
  },
): MessageAttachment[] {
  const normalized: MessageAttachment[] = [];
  for (const raw of rawAttachments) {
    if (!raw || typeof raw !== 'object') continue;
    const att = raw as Partial<MessageAttachment> & { dataUrl?: unknown };

    // 已落盘产物：以 Artifact 行为准重建指针（补齐缺失字段、剥离 dataUrl）
    if (typeof att.id === 'string' && att.id) {
      const existing = input.db.getArtifact(att.id);
      if (existing) {
        normalized.push({
          id: existing.id,
          filename: att.filename || existing.filename,
          mimeType: att.mimeType || existing.mimeType,
          sizeBytes: att.sizeBytes ?? existing.sizeBytes,
          url: att.url || `/api/artifacts/${existing.id}/content`,
        });
        continue;
      }
    }

    // 内联 dataUrl：解码落盘为 Artifact，替换为磁盘产物指针
    if (typeof att.dataUrl === 'string' && att.dataUrl) {
      const decoded = decodeInlineDataUrl(att.dataUrl);
      if (decoded) {
        const uploaded = input.artifacts.uploadArtifactBuffer(input.actor, {
          sessionId: input.sessionId,
          filename: att.filename || 'attachment',
          mimeType: att.mimeType || decoded.mimeType || 'application/octet-stream',
          content: decoded.buffer,
        });
        normalized.push({
          id: uploaded.id,
          filename: uploaded.filename,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          url: `/api/artifacts/${uploaded.id}/content`,
        });
        continue;
      }
    }

    // 既非磁盘产物也无内联字节：仅保留指针元数据（无 id 的纯载荷直接丢弃）
    if (typeof att.id === 'string' && att.id) {
      normalized.push({
        id: att.id,
        filename: att.filename ?? '',
        mimeType: att.mimeType ?? '',
        sizeBytes: att.sizeBytes ?? 0,
        url: att.url ?? '',
      });
    }
  }
  return normalized;
}

export function registerMessageRoutes(
  app: HubApp,
  ctx: HubContext & {
    durableRuntime?: HubDurableRuntime;
    durableMirror?: DurableSessionMirror;
    getDurableRuntime?: () => Promise<HubDurableRuntime>;
    /** runtime 由 HubOptions 显式注入（测试/生产显式启用）时为 true。 */
    durableInjected?: boolean;
  },
): void {
  const { db, router, sseHub, artifacts } = ctx;
  const durableMirror = ctx.durableMirror;
  // 主线切流门槛：仅当 runtime 为显式注入，或 Hub 已配置任一 Provider 凭据时生效。
  // 否则（如无凭据的测试 Hub）直接走 GroupRouter，避免提交给无凭据的 Durable 运行时阻塞。
  const durableCtx = () => ({
    ...ctx,
    durableRuntime:
      ctx.durableInjected || db.listProviderCredentials().length > 0 ? ctx.durableRuntime : undefined,
    ...(ctx.getDurableRuntime ? { getDurableRuntime: ctx.getDurableRuntime } : {}),
  });

  app.get('/api/messages/search', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) {
      return c.json({ error: 'Missing search query parameter "q"' }, 400);
    }
    const sessionId = c.req.query('sessionId')?.trim() || undefined;
    if (sessionId) {
      const sRes = resolveOwnedSession(c, db, sessionId);
      if (!sRes.ok) return sRes.response;
    }
    const rawLimit = Number(c.req.query('limit') || '30');
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 30;
    const hits = db.searchMessages(c.get('user').id, q, { sessionId, limit });
    return c.json(hits);
  });

  app.get('/api/sessions/:id/messages', (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    // 分页参数：before=<messageId>（向上翻页）、around=<messageId>（定位上下文）、limit；无参数时保持全量返回
    const beforeId = c.req.query('before')?.trim() || undefined;
    const aroundId = c.req.query('around')?.trim() || undefined;
    const limitRaw = c.req.query('limit');
    if (beforeId === undefined && aroundId === undefined && limitRaw === undefined) {
      return c.json(db.getMessages(id));
    }

    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return c.json({ error: 'Invalid limit' }, 400);
      }
      limit = parsed;
    }

    // around 优先于 before；锚点必须存在且属于该会话
    const anchorId = aroundId ?? beforeId;
    let anchor: { rowid: number } | undefined;
    if (anchorId !== undefined) {
      const found = db.getMessageById(anchorId);
      if (!found || found.message.sessionId !== id) {
        return c.json({ error: 'Message not found' }, 404);
      }
      anchor = found;
    }

    const page = db.getMessagesPage(id, {
      ...(anchor && beforeId !== undefined && aroundId === undefined ? { beforeRowid: anchor.rowid } : {}),
      ...(anchor && aroundId !== undefined ? { aroundRowid: anchor.rowid } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json(page);
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

    if (router.isDraining()) {
      return c.json({ error: 'Hub is draining for upgrade, please retry shortly' }, 503);
    }

    const body = (await c.req.json<{ content?: string; attachments?: MessageAttachment[] }>().catch(() => ({ content: '' }))) as {
      content?: string;
      attachments?: MessageAttachment[];
    };
    const rawAttachments: unknown[] = Array.isArray(body.attachments) ? body.attachments : [];
    if ((typeof body.content !== 'string' || !body.content.trim()) && rawAttachments.length === 0) {
      return c.json({ error: 'Missing content' }, 400);
    }
    const content = typeof body.content === 'string' ? body.content : '';

    const validBots = router.getValidBotIds(session);
    const cmdResult = parseSlashCommand(content, validBots);
    if (cmdResult.error) {
      return c.json({ error: cmdResult.error }, 400);
    }

    const user = c.get('user');

    // 附件规范化：内联 dataUrl 落盘为 Artifact，attachments_json 只存轻量指针
    // （ArtifactError 等业务错误带 status，原语义透传，如 413 超限）
    let attachments: MessageAttachment[];
    try {
      attachments = normalizeMessageAttachments(rawAttachments, {
        db,
        artifacts,
        sessionId: id,
        actor: { type: 'user', userId: user.id },
      });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      return c.json({ error: err?.message || 'Invalid attachments' }, status);
    }
    if (!content.trim() && attachments.length === 0) {
      return c.json({ error: 'Missing content' }, 400);
    }

    const mentions = cmdResult.targetBotId
      ? [cmdResult.targetBotId]
      : (cmdResult.isCommand ? [] : extractMentions(content, validBots));

    const msgResult = db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId: id,
      role: 'user',
      senderUserId: user.id,
      senderUsername: user.username,
      content,
      mentions,
      attachments,
    });

    sseHub.broadcast(id, {
      type: 'message_created',
      message: msgResult.message,
    });

    // 主线切流：显式注入 runtime 或已配置 Provider 凭据时，用户消息直接提交给会话的
    // Router 会话（全双工 whenBusy: "steer"），assistant 回复经镜像回写时间线；
    // 未注入且无凭据（或提交失败）时退回原 GroupRouter 路径。
    const dctx = durableCtx();
    if (dctx.durableRuntime !== undefined) {
      try {
        const submitted = await submitSessionMessageToDurable(
          dctx,
          id,
          session.leadBotId,
          content,
          durableMirror,
          {
            attachments,
            ...(cmdResult.isCommand && cmdResult.commandText ? { commandText: cmdResult.commandText } : {}),
          },
        );
        if (submitted !== undefined) return c.json(msgResult.message, 202);
      } catch (err: any) {
        console.warn('[messages] durable submit failed, falling back to GroupRouter:', err?.message || err);
      }
    }

    // TODO(后续在 formatIncrementalMessages 中消费 senderUsername)
    router.handleUserMessage(id, msgResult.message.id, content, cmdResult.isCommand ? {
      commandText: cmdResult.commandText!,
      targetBotId: cmdResult.targetBotId,
    } : undefined);

    return c.json(msgResult.message, 202);
  });

  // 编辑用户消息：更新锚点内容，截断其后所有消息，重置游标与节点本地会话，再从锚点重新派发
  app.put('/api/sessions/:id/messages/:messageId', async (c) => {
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

    const found = db.getMessageById(messageId);
    if (!found || found.message.sessionId !== id) {
      return c.json({ error: 'Message not found' }, 404);
    }
    const message = found.message;

    const body = (await c.req.json<{ content?: string }>().catch(() => ({ content: '' }))) as {
      content?: string;
    };
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      return c.json({ error: 'Missing content' }, 400);
    }

    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before editing messages' }, 409);
    }
    if (message.role !== 'user') {
      return c.json({ error: 'Only user messages can be edited' }, 400);
    }

    // 先校验斜杠命令，避免截断发生后才发现无法派发
    const validBots = router.getValidBotIds(session);
    const cmdResult = parseSlashCommand(body.content, validBots);
    if (cmdResult.error) {
      return c.json({ error: cmdResult.error }, 400);
    }

    const mentions = cmdResult.targetBotId
      ? [cmdResult.targetBotId]
      : (cmdResult.isCommand ? [] : extractMentions(body.content, validBots));

    // 验证输入后，使用 Router 统一失效旧队列，复用 cancelSession
    await router.cancelSession(id);

    const anchorRowid = found.rowid;
    // 记录锚点之前的历史消息（用于 pi-durable 原生 conv.fork(prevEntryId) 精确回滚上下文）
    const allBeforeTruncate = db.getMessages(id);
    const anchorIndex = allBeforeTruncate.findIndex((m) => m.id === messageId);
    const messagesBeforeEdited = anchorIndex > 0 ? allBeforeTruncate.slice(0, anchorIndex) : [];

    const updated = db.updateMessageContent(messageId, body.content, mentions);
    if (!updated) {
      return c.json({ error: 'Message not found' }, 404);
    }

    db.deleteMessagesAfter(id, anchorRowid);
    db.resetSessionCursors(id);
    await router.resetMemberSessions(id);
    sseHub.broadcast(id, {
      type: 'messages_truncated',
      sessionId: id,
      anchorMessageId: messageId,
    });

    const dctx = durableCtx();
    if (dctx.durableRuntime !== undefined) {
      try {
        const rt = dctx.getDurableRuntime ? await dctx.getDurableRuntime() : dctx.durableRuntime;
        if (rt !== undefined) {
          await rewindDurableSessionBeforeMessage(rt, {
            sessionId: id,
            botId: session.leadBotId,
            previousMessage: messagesBeforeEdited.at(-1),
            messagesBeforeEdited,
          });
        }
        const submitted = await submitSessionMessageToDurable(
          dctx,
          id,
          session.leadBotId,
          body.content,
          durableMirror,
          cmdResult.isCommand && cmdResult.commandText ? { commandText: cmdResult.commandText } : undefined,
        );
        if (submitted !== undefined) return c.json(updated, 200);
      } catch (err: any) {
        console.warn('[messages] durable rewind/submit failed, falling back to GroupRouter:', err?.message || err);
      }
    }

    router.handleUserMessage(id, messageId, body.content, cmdResult.isCommand ? {
      commandText: cmdResult.commandText!,
      targetBotId: cmdResult.targetBotId,
    } : undefined);

    return c.json(updated, 200);
  });
}
