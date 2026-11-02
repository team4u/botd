import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactRecord, MessageAttachment } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { SseHub } from './sse.js';

export const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;

export function artifactTooLargeMessage(): string {
  return `Artifact too large (max ${Math.floor(MAX_ARTIFACT_BYTES / 1024 / 1024)}MB)`;
}

// 净化上传文件名：禁止任何路径成分（Unix / Windows 分隔符、".."、NUL），
// 防止恶意 artifact 在 CLI pull 下载时于 cwd 外任意写文件
function sanitizeUploadFilename(raw: string): string | null {
  const filename = raw.trim();
  if (!filename || filename === '.') return null;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..') || filename.includes('\0')) {
    return null;
  }
  return path.posix.basename(filename) === filename ? filename : null;
}

function getArtifactsDir(): string {
  return path.join(process.env.BOTD_HUB_DATA_DIR || path.join(os.homedir(), '.botd'), 'artifacts');
}

export type ArtifactHttpStatus = 400 | 403 | 404 | 410 | 413 | 500;

export class ArtifactError extends Error {
  constructor(message: string, public readonly status: ArtifactHttpStatus) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export type ArtifactActor =
  | { type: 'user'; userId: string }
  | { type: 'node'; nodeId: string };

export interface UploadArtifactInput {
  sessionId: string;
  botId?: string;
  senderBotId?: string;
  filename: string;
  mimeType?: string;
  contentBase64: string;
  message?: string;
}

export interface UploadArtifactBufferInput {
  sessionId: string;
  botId?: string;
  senderBotId?: string;
  filename: string;
  mimeType?: string;
  content: Buffer | Uint8Array;
  message?: string;
}

export class ArtifactService {
  private db: HubDatabase;
  private sseHub: SseHub;
  private artifactsDir: string;

  constructor(db: HubDatabase, sseHub: SseHub, options?: { artifactsDir?: string }) {
    this.db = db;
    this.sseHub = sseHub;
    this.artifactsDir = options?.artifactsDir ?? getArtifactsDir();
    this.retryPendingCleanups();
  }

  private assertSessionAccess(actor: ArtifactActor, sessionId: string): void {
    const sessionOwner = this.db.getSessionOwner(sessionId);
    if (!sessionOwner) {
      throw new ArtifactError('Forbidden', 403);
    }
    if (actor.type === 'user') {
      if (actor.userId !== sessionOwner) {
        throw new ArtifactError('Forbidden', 403);
      }
    } else if (actor.type === 'node') {
      const nodeOwner = this.db.getNodeOwner(actor.nodeId);
      if (!nodeOwner || nodeOwner !== sessionOwner) {
        throw new ArtifactError(`Forbidden: node ${actor.nodeId} does not own session ${sessionId}`, 403);
      }
    }
  }

  uploadArtifactBuffer(actor: ArtifactActor, input: UploadArtifactBufferInput): ArtifactRecord {
    const session = this.db.getSession(input.sessionId);
    if (!session) {
      throw new ArtifactError(`Session ${input.sessionId} not found`, 404);
    }
    this.assertSessionAccess(actor, input.sessionId);

    const botId = input.senderBotId || input.botId;
    if (botId) {
      const bot = this.db.getBot(botId);
      if (!bot) {
        throw new ArtifactError(`Bot ${botId} not found`, 404);
      }
      if (actor.type === 'node') {
        if (bot.nodeId !== actor.nodeId) {
          throw new ArtifactError(`Forbidden: bot ${botId} does not belong to node ${actor.nodeId}`, 403);
        }
      } else if (actor.type === 'user') {
        const botOwner = this.db.getNodeOwner(bot.nodeId);
        if (!botOwner || botOwner !== actor.userId) {
          throw new ArtifactError(`Forbidden: bot ${botId} does not belong to user`, 403);
        }
      }
      // 会话成员本身，或其所属主 Bot（Subagent）为会话成员/主持人均可上传
      const isMember =
        session.memberBotIds.includes(botId) ||
        session.leadBotId === botId ||
        Boolean(
          bot.parentBotId &&
            (session.memberBotIds.includes(bot.parentBotId) || session.leadBotId === bot.parentBotId)
        );
      if (!isMember) {
        throw new ArtifactError(`Forbidden: bot ${botId} is not a member of session ${input.sessionId}`, 403);
      }
    }

    if (typeof input.filename !== 'string' || !input.filename.trim()) {
      throw new ArtifactError('Invalid artifact upload: filename is required', 400);
    }
    const filename = sanitizeUploadFilename(input.filename);
    if (!filename) {
      throw new ArtifactError('Invalid artifact upload: filename must not contain path separators or ".."', 400);
    }
    if (!input.content || !(Buffer.isBuffer(input.content) || input.content instanceof Uint8Array)) {
      throw new ArtifactError('Invalid artifact upload: content is required', 400);
    }

    const buffer = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content.buffer, input.content.byteOffset, input.content.byteLength);

    if (buffer.length === 0) {
      throw new ArtifactError('Artifact content is empty', 400);
    }
    if (buffer.length > MAX_ARTIFACT_BYTES) {
      throw new ArtifactError(artifactTooLargeMessage(), 413);
    }

    const artifactId = `art_${randomUUID()}`;
    const storageDir = this.artifactsDir;
    fs.mkdirSync(storageDir, { recursive: true });
    const storagePath = path.join(storageDir, artifactId);
    fs.writeFileSync(storagePath, buffer);

    const mimeType = input.mimeType || 'application/octet-stream';
    let artifact: ArtifactRecord;
    try {
      artifact = this.db.createArtifact({
        id: artifactId,
        sessionId: input.sessionId,
        filename,
        mimeType,
        sizeBytes: buffer.length,
        ...(botId ? { senderBotId: botId } : {}),
        storagePath,
      });
    } catch (err: any) {
      try {
        if (fs.existsSync(storagePath)) {
          fs.unlinkSync(storagePath);
        }
      } catch (unlinkErr: any) {
        this.db.recordArtifactCleanupPending(storagePath, String(unlinkErr?.message || unlinkErr));
      }
      throw err;
    }

    this.sseHub.broadcast(input.sessionId, {
      type: 'artifact_created',
      sessionId: input.sessionId,
      artifact,
    });

    if (input.message) {
      const attachment: MessageAttachment = {
        id: artifact.id,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        url: `/api/artifacts/${artifact.id}/content`,
      };
      const msg = this.db.createMessage({
        id: `msg_${randomUUID()}`,
        sessionId: input.sessionId,
        role: 'assistant',
        senderBotId: botId,
        content: input.message,
        attachments: [attachment],
      });
      this.sseHub.broadcast(input.sessionId, {
        type: 'message_created',
        message: msg.message,
      });
    }

    return artifact;
  }

  uploadArtifact(actor: ArtifactActor, input: UploadArtifactInput): ArtifactRecord {
    if (typeof input.contentBase64 !== 'string' || input.contentBase64.length === 0) {
      throw new ArtifactError('Invalid artifact upload: contentBase64 is required', 400);
    }
    const buffer = Buffer.from(input.contentBase64, 'base64');
    return this.uploadArtifactBuffer(actor, {
      sessionId: input.sessionId,
      botId: input.botId,
      senderBotId: input.senderBotId,
      filename: input.filename,
      mimeType: input.mimeType,
      content: buffer,
      message: input.message,
    });
  }

  // 同一物理文件可能被多个 artifact id 引用（委派/分叉复制）；读取路径无共享副作用。
  getArtifactContent(
    actor: ArtifactActor,
    artifactId: string
  ): { artifact: ArtifactRecord; content: Buffer } {
    const art = this.db.getArtifactWithStoragePath(artifactId);
    if (!art) {
      throw new ArtifactError(`Artifact ${artifactId} not found`, 404);
    }
    this.assertSessionAccess(actor, art.sessionId);

    if (!fs.existsSync(art.storagePath)) {
      throw new ArtifactError('Artifact content is missing on disk', 410);
    }

    try {
      const content = fs.readFileSync(art.storagePath);
      return { artifact: art, content };
    } catch {
      throw new ArtifactError('Artifact content is missing on disk', 410);
    }
  }

  downloadArtifact(
    actor: ArtifactActor,
    artifactId: string
  ): { artifact: ArtifactRecord; contentBase64: string } {
    const { artifact, content } = this.getArtifactContent(actor, artifactId);
    return {
      artifact,
      contentBase64: content.toString('base64'),
    };
  }

  listSessionArtifacts(actor: ArtifactActor, sessionId: string): ArtifactRecord[] {
    const session = this.db.getSession(sessionId);
    if (!session) {
      throw new ArtifactError(`Session ${sessionId} not found`, 404);
    }
    this.assertSessionAccess(actor, sessionId);
    return this.db.listSessionArtifacts(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    const candidatePaths = this.db.listArtifactStoragePaths({ sessionId });

    const deleted = this.db.deleteSession(sessionId);
    if (!deleted) return false;

    this.reclaimUnreferencedFiles(candidatePaths);
    this.retryPendingCleanups();
    return true;
  }

  deleteUser(userId: string): void {
    const candidatePaths = this.db.listArtifactStoragePaths({ ownerId: userId });

    this.db.deleteUser(userId);
    this.reclaimUnreferencedFiles(candidatePaths);
    this.retryPendingCleanups();
  }

  retryPendingCleanups(): void {
    this.reclaimUnreferencedFiles(this.db.listArtifactCleanupPending().map((item) => item.storagePath));
  }

  // 不变量：多个 artifacts 行共享同一 storage_path 是合法形态（子会话委派/分叉时的引用复制）。
  // 回收判定必须始终以"是否仍有任意行引用该路径"为准，禁止改为"删行即删文件"。
  private reclaimUnreferencedFiles(candidatePaths: string[]): void {
    for (const filePath of new Set(candidatePaths)) {
      if (this.db.isArtifactStoragePathReferenced(filePath)) {
        this.db.removeArtifactCleanupPending(filePath);
        continue;
      }
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        this.db.removeArtifactCleanupPending(filePath);
      } catch (err: unknown) {
        this.db.recordArtifactCleanupPending(filePath, err instanceof Error ? err.message : String(err));
      }
    }
  }
}
