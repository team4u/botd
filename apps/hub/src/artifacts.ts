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

    const body = await c.req.json<{ filename?: string; mimeType?: string; contentBase64?: string; senderBotId?: string }>()
      .catch(() => null);
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
          senderBotId: body.senderBotId,
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
      });
    } catch (err: any) {
      const status: ArtifactHttpStatus = err instanceof ArtifactError ? err.status : 500;
      return c.json({ error: err.message }, status);
    }
  });
}
