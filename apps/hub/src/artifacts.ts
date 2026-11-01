import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import type { UserRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { SseHub } from './sse.js';

const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;

/** 文件产物落盘目录：<dataDir>/artifacts（文件名即 artifactId，杜绝路径穿越） */
export function getArtifactsDir(): string {
  return path.join(process.env.BOTD_HUB_DATA_DIR || path.join(os.homedir(), '.botd'), 'artifacts');
}

export function registerArtifactRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  sseHub: SseHub,
  getSessionOwnerId: (sessionId: string) => string | undefined
): void {
  // 上传文件产物（Web 端 / Node 端均可调用）
  app.post('/api/sessions/:id/artifacts', async (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{ filename?: string; mimeType?: string; contentBase64?: string; senderBotId?: string }>()
      .catch(() => null);
    if (!body || typeof body.filename !== 'string' || !body.filename.trim()
      || typeof body.contentBase64 !== 'string' || body.contentBase64.length === 0) {
      return c.json({ error: 'Invalid artifact upload: filename and contentBase64 are required' }, 400);
    }

    const content = Buffer.from(body.contentBase64, 'base64');
    if (content.length === 0) {
      return c.json({ error: 'Artifact content is empty' }, 400);
    }
    if (content.length > MAX_ARTIFACT_BYTES) {
      return c.json({ error: `Artifact too large (max ${Math.floor(MAX_ARTIFACT_BYTES / 1024 / 1024)}MB)` }, 413);
    }

    const artifactId = `art_${randomUUID()}`;
    const dir = getArtifactsDir();
    fs.mkdirSync(dir, { recursive: true });
    const storagePath = path.join(dir, artifactId);
    fs.writeFileSync(storagePath, content);

    const artifact = db.createArtifact({
      id: artifactId,
      sessionId: id,
      filename: body.filename.trim(),
      mimeType: body.mimeType || 'application/octet-stream',
      sizeBytes: content.length,
      ...(body.senderBotId ? { senderBotId: body.senderBotId } : {}),
      storagePath,
    });

    sseHub.broadcast(id, {
      type: 'artifact_created',
      sessionId: id,
      artifact,
    });

    return c.json({ ...artifact, url: `/api/artifacts/${artifact.id}/content` }, 201);
  });

  // 列出会话的全部文件产物
  app.get('/api/sessions/:id/artifacts', (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return c.json(db.listSessionArtifacts(id));
  });

  // 下载/内联预览产物内容（仅会话归属用户可访问）
  app.get('/api/artifacts/:artifactId/content', (c) => {
    const artifactId = c.req.param('artifactId');
    const art = db.getArtifactWithStoragePath(artifactId);
    if (!art) {
      return c.json({ error: 'Artifact not found' }, 404);
    }
    if (getSessionOwnerId(art.sessionId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    let content: Uint8Array<ArrayBuffer>;
    try {
      content = new Uint8Array(fs.readFileSync(art.storagePath));
    } catch {
      return c.json({ error: 'Artifact content is missing on disk' }, 410);
    }

    return c.body(content, 200, {
      'Content-Type': art.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(art.filename)}"`,
    });
  });
}
