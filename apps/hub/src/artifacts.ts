import type { Hono } from 'hono';
import type { UserRecord } from '@botd/protocol';
import {
  ArtifactError,
  type ArtifactHttpStatus,
  type ArtifactService,
} from './artifact-service.js';

export function registerArtifactRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  artifactService: ArtifactService
): void {

  // 上传文件产物（Web 端 / Node 端均可调用）
  app.post('/api/sessions/:id/artifacts', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');

    const contentType = c.req.header('content-type') || '';
    const rawHeaderFilename = c.req.header('x-artifact-filename');
    const isBinaryStream = contentType.startsWith('application/octet-stream') || Boolean(rawHeaderFilename);

    if (isBinaryStream) {
      let headerFilename = '';
      if (rawHeaderFilename) {
        try {
          headerFilename = decodeURIComponent(rawHeaderFilename);
        } catch {
          headerFilename = rawHeaderFilename;
        }
      }
      const filename = headerFilename || c.req.query('filename') || '';

      const headerMimeType = c.req.header('x-artifact-mime-type');
      const queryMimeType = c.req.query('mimeType');
      const nonOctetContentType = contentType && !contentType.startsWith('application/octet-stream')
        ? contentType.split(';')[0].trim()
        : undefined;
      const mimeType = headerMimeType || queryMimeType || nonOctetContentType || undefined;

      const senderBotId = c.req.header('x-artifact-bot-id') || c.req.query('botId') || undefined;

      const rawMsg = c.req.header('x-artifact-message');
      let message: string | undefined;
      if (rawMsg !== undefined) {
        try {
          message = decodeURIComponent(rawMsg);
        } catch {
          message = rawMsg;
        }
      } else {
        message = c.req.query('message') || undefined;
      }

      try {
        const raw = Buffer.from(await c.req.arrayBuffer());
        const artifact = artifactService.uploadArtifactBuffer(
          { type: 'user', userId: user.id },
          {
            sessionId: id,
            filename,
            mimeType,
            content: raw,
            senderBotId,
            message,
          }
        );
        return c.json({ ...artifact, url: `/api/artifacts/${artifact.id}/content` }, 201);
      } catch (err: any) {
        const status: ArtifactHttpStatus = err instanceof ArtifactError ? err.status : 500;
        return c.json({ error: err.message }, status);
      }
    }

    const body = await c.req.json<{
      filename?: string;
      mimeType?: string;
      contentBase64?: string;
      senderBotId?: string;
      botId?: string;
      message?: string;
    }>().catch(() => null);

    if (!body || typeof body.filename !== 'string' || !body.filename.trim()
      || typeof body.contentBase64 !== 'string' || body.contentBase64.length === 0) {
      return c.json({ error: 'Invalid artifact upload: filename and contentBase64 are required' }, 400);
    }

    try {
      const artifact = artifactService.uploadArtifact(
        { type: 'user', userId: user.id },
        {
          sessionId: id,
          filename: body.filename,
          mimeType: body.mimeType,
          contentBase64: body.contentBase64,
          senderBotId: body.senderBotId || body.botId,
          message: body.message,
        }
      );
      return c.json({ ...artifact, url: `/api/artifacts/${artifact.id}/content` }, 201);
    } catch (err: any) {
      const status: ArtifactHttpStatus = err instanceof ArtifactError ? err.status : 500;
      return c.json({ error: err.message }, status);
    }
  });

  // 列出会话的全部文件产物
  app.get('/api/sessions/:id/artifacts', (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    try {
      const artifacts = artifactService.listSessionArtifacts(
        { type: 'user', userId: user.id },
        id
      );
      return c.json(artifacts);
    } catch (err: any) {
      const status: ArtifactHttpStatus = err instanceof ArtifactError ? err.status : 500;
      return c.json({ error: err.message }, status);
    }
  });

  // 下载/内联预览产物内容（仅会话归属用户可访问）
  app.get('/api/artifacts/:artifactId/content', (c) => {
    const artifactId = c.req.param('artifactId');
    const user = c.get('user');
    try {
      const { artifact, content } = artifactService.getArtifactContent(
        { type: 'user', userId: user.id },
        artifactId
      );
      return c.body(new Uint8Array(content), 200, {
        'Content-Type': artifact.mimeType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(artifact.filename)}"`,
        'X-Artifact-Id': artifact.id,
        'X-Artifact-Session-Id': artifact.sessionId,
        'X-Artifact-Size-Bytes': String(artifact.sizeBytes),
        'X-Artifact-Created-At': artifact.createdAt,
        ...(artifact.senderBotId ? { 'X-Artifact-Sender-Bot-Id': artifact.senderBotId } : {}),
      });
    } catch (err: any) {
      const status: ArtifactHttpStatus = err instanceof ArtifactError ? err.status : 500;
      return c.json({ error: err.message }, status);
    }
  });
}
