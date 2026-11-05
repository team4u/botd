import { randomUUID } from 'node:crypto';
import type { MessageAttachment } from '@botd/protocol';
import { extractMentions, parseSlashCommand } from '../group-router.js';
import { resolveOwnedSession } from '../http-helpers.js';
import { ArtifactError, type ArtifactActor, type ArtifactService } from '../artifact-service.js';
import type { HubDatabase } from '../db.js';
import {
  ensureRouterConversationId,
  rewindDurableSessionBeforeMessage,
  submitSessionMessageToDurable,
  type DurableSessionMirror,
} from './workers.js';
import type { HubDurableRuntime } from '../harness/hub-harness.js';
import type { HubApp, HubContext } from './context.js';
import { listEffectiveProviderCredentials, loadStoredProviders } from '../credential-store.js';

/** 构造「未配置模型/凭据」的系统错误消息文本 */
function unconfiguredModelMessage(botName: string, provider: string, modelId: string): string {
  const current = provider ? `${provider}/${modelId || '未设置'}` : '未设置';
  return `⚠️ 消息未能发送：智能体「${botName}」尚未配置可用的模型或服务商凭据（当前：${current}）。请在输入框左下角切换已就绪的模型，或前往「系统设置 → 模型服务商」配置 API Key。`;
}

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

    // 已落盘产物：以 Artifact 行为准重建指针（补齐缺失字段、剥离 dataUrl）。
    // 归属校验：附件指向的产物必须属于当前会话（跨会话/跨用户引用直接拒收）。
    if (typeof att.id === 'string' && att.id) {
      const existing = input.db.getArtifact(att.id);
      if (existing) {
        if (existing.sessionId !== input.sessionId) {
          throw new ArtifactError('Forbidden: attachment belongs to another session', 403);
        }
        // 元数据以数据库权威字段优先，请求方仅能补齐缺失项，防止伪装/覆盖。
        normalized.push({
          id: existing.id,
          filename: existing.filename || att.filename || 'attachment',
          mimeType: existing.mimeType || att.mimeType || 'application/octet-stream',
          sizeBytes: existing.sizeBytes ?? att.sizeBytes ?? 0,
          url: `/api/artifacts/${existing.id}/content`,
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
  // 注意：不在此处固化 durableMirror —— 懒打开运行时在首条消息时才创建镜像器，
  // 处理器内动态读 ctx.durableMirror 才能拿到实例（旧闭包捕获恒 undefined）。
  // 主线切流门槛：仅当 runtime 为显式注入，或 Hub 已配置任一 Provider 凭据时生效。
  // 否则（如无凭据的测试 Hub）直接走 GroupRouter，避免提交给无凭据的 Durable 运行时阻塞。
  const durableCtx = () => ({
    ...ctx,
    durableRuntime:
      ctx.durableInjected || listEffectiveProviderCredentials(db).length > 0 ? ctx.durableRuntime : undefined,
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

    // 多分身群聊路由：@mention / 斜杠命令目标分身优先，否则回落主 Bot。
    const targetBotId =
      (cmdResult.targetBotId && db.getBot(cmdResult.targetBotId) ? cmdResult.targetBotId : undefined) ??
      mentions.find((m) => db.getBot(m) !== undefined) ??
      session.leadBotId;

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

    const credentials = listEffectiveProviderCredentials(db);
    const durableMainlineEligible = ctx.durableInjected || credentials.length > 0;
    const dctx = durableCtx();
    const rt = durableMainlineEligible
      ? (dctx.getDurableRuntime ? await dctx.getDurableRuntime() : dctx.durableRuntime)
      : undefined;

    // 校验实际会话模型，避免全局 Bot 的空配置挡住有效的会话覆盖。
    // 节点自行执行的路径仍由节点管理凭据。
    if (rt !== undefined && !ctx.durableInjected && targetBotId) {
      const bot = db.getBot(targetBotId);
      if (bot) {
        const conversationId = await ensureRouterConversationId(rt, id, targetBotId, { workspaceDir: session.workspaceDir });
        const { effective } = await rt.getConversationModelConfig(conversationId);
        if (
          !effective.provider.trim() ||
          !effective.modelId.trim() ||
          (!credentials.some((credential) => credential.providerId === effective.provider) &&
            !loadStoredProviders(db.getDataDir()).some((provider) => provider.id === effective.provider))
        ) {
          const errorMsg = db.createMessage({
            id: `msg_${randomUUID()}`,
            sessionId: id,
            role: 'system',
            content: unconfiguredModelMessage(bot.name || targetBotId, effective.provider, effective.modelId),
          });
          sseHub.broadcast(id, { type: 'message_created', message: errorMsg.message });
          sseHub.broadcast(id, { type: 'session_status', sessionId: id, status: 'failed' });
          db.updateSessionStatus(id, 'failed');
          return c.json(msgResult.message, 202);
        }
      }
    }

    // 已配置 Durable 主线时提交到会话 Router，否则沿用节点路由。
    if (rt !== undefined) {
      try {
        const submitted = await submitSessionMessageToDurable(
          { db, sseHub, durableRuntime: rt },
          id,
          targetBotId,
          content,
          ctx.durableMirror,
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

    // 多分身群聊路由（与 POST 一致）：@mention / 斜杠命令目标分身优先，否则回落主 Bot。
    const targetBotId =
      (cmdResult.targetBotId && db.getBot(cmdResult.targetBotId) ? cmdResult.targetBotId : undefined) ??
      mentions.find((m) => db.getBot(m) !== undefined) ??
      session.leadBotId;

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
            botId: targetBotId,
            previousMessage: messagesBeforeEdited.at(-1),
            messagesBeforeEdited,
          });
        }
        const submitted = await submitSessionMessageToDurable(
          dctx,
          id,
          targetBotId,
          body.content,
          ctx.durableMirror,
          {
            // 编辑重提保留原消息附件：SQL 侧未动附件，Durable 侧同样要带上图片块/[Attached Files]。
            ...(updated.attachments?.length ? { attachments: updated.attachments } : {}),
            ...(cmdResult.isCommand && cmdResult.commandText ? { commandText: cmdResult.commandText } : {}),
          },
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
