import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type {
  DelegateSessionInput,
  DelegateSessionResult,
  MessageAttachment,
  UserRecord,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { GroupRouter } from './group-router.js';
import type { SseHub } from './sse.js';
import { resolveOwnedSession } from './http-helpers.js';

/** 判定回复是否为静默略过（以 [PASS] 或 [IGNORE] 开头，后接空白、标点或结尾） */
export function isSilentSkipReply(content: string | undefined | null): boolean {
  if (typeof content !== 'string') return false;
  return /^\[(?:PASS|IGNORE)\](?:$|\s|[:：—-])/i.test(content.trim());
}

export interface WatchSubSessionOptions {
  db: HubDatabase;
  sseHub?: SseHub | null;
  parentSessionId: string;
  childSession: { id: string; title: string };
  botId: string;
  baselineArtifactIds?: Set<string>;
  inheritedStoragePaths?: Set<string>;
  emitParentCallback?: boolean;
  /** 子会话以 [PASS]/[IGNORE] 结束且无新产出附件时，静默跳过父会话 callback 消息投递 */
  suppressSkipCallback?: boolean;
  onSettled?: (status: 'idle' | 'failed', triggerMsgId?: string) => void;
}

export function watchSubSessionCompletion(options: WatchSubSessionOptions): () => void {
  const {
    db,
    sseHub,
    parentSessionId,
    childSession,
    botId,
    baselineArtifactIds,
    inheritedStoragePaths,
    emitParentCallback = true,
    suppressSkipCallback = false,
    onSettled,
  } = options;

  if (!sseHub) return () => {};

  let unsubscribed = false;
  let unsubscribe: (() => void) | undefined;
  const cleanup = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsubscribe?.();
  };

  unsubscribe = sseHub.subscribe(childSession.id, (event) => {
    if (event.type !== 'session_status') return;
    if (event.status === 'idle') {
      cleanup();
      // 幂等防重：仅首个完成/失败回调可插入父会话消息/回传，跨 Hub 重启依然生效
      if (!db.markSessionParentNotified(childSession.id)) return;

      // 子 -> 父回传：把子会话执行期间新产出的交付物以零拷贝 storagePath 引用复制回父会话。
      // 删除安全性依赖 artifact-service 的按引用计数回收（见 reclaimUnreferencedFiles），
      // 此处只新增引用行、不复制文件，也不得改成删行即删文件。
      const returnedAttachments: MessageAttachment[] = [];
      const childArtifacts = db.listSessionArtifacts(childSession.id);
      for (const childArt of childArtifacts) {
        if (baselineArtifactIds?.has(childArt.id)) continue;
        const withPath = db.getArtifactWithStoragePath(childArt.id);
        if (!withPath) continue;
        if (inheritedStoragePaths?.has(withPath.storagePath)) {
          continue; // 继承自父会话的产物不回传
        }
        const parentArtId = `art_${randomUUID()}`;
        const parentArt = db.createArtifact({
          id: parentArtId,
          sessionId: parentSessionId,
          filename: withPath.filename,
          mimeType: withPath.mimeType,
          sizeBytes: withPath.sizeBytes,
          senderBotId: withPath.senderBotId,
          storagePath: withPath.storagePath,
        });
        sseHub.broadcast(parentSessionId, {
          type: 'artifact_created',
          sessionId: parentSessionId,
          artifact: parentArt,
        });
        returnedAttachments.push({
          id: parentArtId,
          filename: parentArt.filename,
          mimeType: parentArt.mimeType,
          sizeBytes: parentArt.sizeBytes,
          url: `/api/artifacts/${parentArtId}`,
        });
      }

      if (emitParentCallback) {
        const messages = db.getMessages(childSession.id);
        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
        const summary = lastAssistant?.content?.trim() || '(无回复内容)';

        // 静默跳过原语：子会话以 [PASS]/[IGNORE] 收敛且无新产出附件时，
        // 不向父会话投递 callback（有产物则仍回传，避免丢失交付物引用）。
        if (suppressSkipCallback && isSilentSkipReply(lastAssistant?.content) && returnedAttachments.length === 0) {
          onSettled?.('idle');
          return;
        }

        let callbackContent = `✅ 子会话「[${childSession.title}](#?s=${childSession.id})」已完成：\n\n${summary}`;

        if (returnedAttachments.length > 0) {
          const artifactLines = returnedAttachments
            .map((a) => `- ${a.filename} (${a.url})`)
            .join('\n');
          callbackContent += `\n\n📦 产出交付物：\n${artifactLines}`;
        }

        const resultMsg = db.createMessage({
          id: `msg_${randomUUID()}`,
          sessionId: parentSessionId,
          role: 'callback',
          senderBotId: botId,
          content: callbackContent,
          mentions: [],
          ...(returnedAttachments.length > 0 ? { attachments: returnedAttachments } : {}),
        });
        sseHub.broadcast(parentSessionId, {
          type: 'message_created',
          message: resultMsg.message,
        });
        onSettled?.('idle', resultMsg.message.id);
      } else {
        onSettled?.('idle');
      }
    } else if (event.status === 'failed') {
      cleanup();
      if (!db.markSessionParentNotified(childSession.id)) return;

      if (emitParentCallback) {
        const messages = db.getMessages(childSession.id);
        const lastSys = [...messages].reverse().find((m) => m.role === 'system');
        const errorDetail = lastSys?.content?.trim() || '(未知错误)';
        const failContent = `❌ 子会话「[${childSession.title}](#?s=${childSession.id})」执行失败：\n\n${errorDetail}`;
        const failMsg = db.createMessage({
          id: `msg_${randomUUID()}`,
          sessionId: parentSessionId,
          role: 'callback',
          senderBotId: botId,
          content: failContent,
          mentions: [],
        });
        sseHub.broadcast(parentSessionId, {
          type: 'message_created',
          message: failMsg.message,
        });
        onSettled?.('failed', failMsg.message.id);
      } else {
        onSettled?.('failed');
      }
    }
  });

  return cleanup;
}

export function registerDelegationRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  router: GroupRouter,
  sseHub: SseHub
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

    const botId = body.botId.trim();
    const bot = db.getBot(botId);
    if (!bot) {
      return c.json({ error: `Bot ${botId} not found` }, 404);
    }
    if (!db.canUserUseBot(botId, user.id)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const title = body.title?.trim() || `[子任务] ${body.prompt.trim().slice(0, 28)}`;

    const childSessionId = `sess_${randomUUID()}`;
    const childSession = db.createSession({
      id: childSessionId,
      title,
      leadBotId: botId,
      ownerId: user.id,
      parentSessionId: id,
    });

    // 注意：此处"复制"产物为同 storagePath 多行引用（不复制文件）。删除安全性依赖 artifact-service 的按引用计数回收（见 reclaimUnreferencedFiles），修改删除逻辑前必须保持该不变量。
    // 若请求中指定了 artifactIds，或父会话存在产物，则将对应产物复制/关联给子会话
    const targetArtifacts = Array.isArray(body.artifactIds)
      ? body.artifactIds
          .map((artId) => (typeof artId === 'string' ? db.getArtifactWithStoragePath(artId.trim()) : undefined))
          .filter((art): art is NonNullable<typeof art> => Boolean(art && art.sessionId === id))
      : db.listSessionArtifacts(id)
          .map((a) => db.getArtifactWithStoragePath(a.id))
          .filter((art): art is NonNullable<typeof art> => Boolean(art));

    // 继承产物的底层存储路径集合：子会话完成时用它区分「新产出」与「从父会话继承」的产物，
    // 只回传新产出部分，避免把父会话自己的文件原样回传一遍。
    const inheritedStoragePaths = new Set<string>();

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
      inheritedStoragePaths.add(art.storagePath);
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

    const baselineArtifactIds = new Set(db.listSessionArtifacts(childSession.id).map((a) => a.id));

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

    const autoWake = body.autoWakeParent !== false;

    // 唤醒父会话 Lead Bot 执行后续汇总或处理
    const wakeParent = (triggerMsgId: string, summaryText: string) => {
      if (!autoWake) return;
      const parentSession = db.getSession(id);
      if (!parentSession?.leadBotId) return;
      if (!router.canRunBot(id, parentSession.leadBotId)) return;
      // Barrier 汇合：若父会话下仍有其他处于 running 或 queued 状态的兄弟子会话，
      // 本次仅落库 callback 消息与回传产物，等最后一个子会话收敛后再统一唤醒父会话主控 Bot。
      const siblingSubs = db.listSubSessions(id);
      const stillActive = siblingSubs.some(
        (s) => s.id !== childSession.id && (s.status === 'running' || s.status === 'queued')
      );
      if (stillActive) return;
      router.handleUserMessage(
        id,
        triggerMsgId,
        `@${parentSession.leadBotId} ${summaryText}`
      );
    };

    // 监听子会话状态收敛
    watchSubSessionCompletion({
      db,
      sseHub,
      parentSessionId: id,
      childSession,
      botId,
      baselineArtifactIds,
      inheritedStoragePaths,
      emitParentCallback: autoWake,
      onSettled: (status, triggerMsgId) => {
        if (triggerMsgId) {
          wakeParent(
            triggerMsgId,
            status === 'idle'
              ? `子会话「${childSession.title}」已完成，请汇总处理。`
              : `子会话「${childSession.title}」执行失败，请处理异常。`
          );
        }
      },
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
