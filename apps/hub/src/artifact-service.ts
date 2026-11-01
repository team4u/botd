import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactRecord, MessageAttachment } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { SseHub } from './sse.js';

export const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;

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

  uploadArtifact(actor: ArtifactActor, input: UploadArtifactInput): ArtifactRecord {
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
      const isMember = session.memberBotIds.includes(botId) || session.leadBotId === botId;
      if (!isMember) {
        throw new ArtifactError(`Forbidden: bot ${botId} is not a member of session ${input.sessionId}`, 403);
      }
    }

    if (typeof input.filename !== 'string' || !input.filename.trim()) {
      throw new ArtifactError('Invalid artifact upload: filename is required', 400);
    }
    if (typeof input.contentBase64 !== 'string' || input.contentBase64.length === 0) {
      throw new ArtifactError('Invalid artifact upload: contentBase64 is required', 400);
    }

    const buffer = Buffer.from(input.contentBase64, 'base64');
    if (buffer.length === 0) {
      throw new ArtifactError('Artifact content is empty', 400);
    }
    if (buffer.length > MAX_ARTIFACT_BYTES) {
      throw new ArtifactError(`Artifact too large (max ${Math.floor(MAX_ARTIFACT_BYTES / 1024 / 1024)}MB)`, 413);
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
        filename: input.filename.trim(),
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
