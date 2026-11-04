import { randomUUID } from 'node:crypto';
import type { MessageAttachment } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { SseHub } from './sse.js';

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
