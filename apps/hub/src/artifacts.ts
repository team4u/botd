import type { Hono } from 'hono';
import type { UserRecord } from '@botd/protocol';
import {
  ArtifactError,
  type ArtifactHttpStatus,
  type ArtifactService,
  MAX_ARTIFACT_BYTES,
  artifactTooLargeMessage,
} from './artifact-service.js';

// base64 膨胀余量（×4/3）+ 少量 JSON 包装开销
const MAX_ARTIFACT_REQUEST_BYTES = Math.ceil(MAX_ARTIFACT_BYTES * 4 / 3) + 4096;

// 流式读取请求体：累计字节数，越限立即中断（适用于无 Content-Length 的 chunked 请求）
async function readBodyWithLimit(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => {});
        throw new ArtifactError(artifactTooLargeMessage(), 413);
      }
      chunks.push(Buffer.from(value));
    }
  }
  reader.releaseLock();
  return Buffer.concat(chunks);
}

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
        // 先看 Content-Length：超限直接拒绝，不做无界内存缓冲
        const contentLengthHeader = c.req.header('content-length');
        if (contentLengthHeader !== undefined && contentLengthHeader !== '') {
          const contentLength = Number(contentLengthHeader);
          if (!Number.isFinite(contentLength)) {
            return c.json({ error: 'Invalid Content-Length header' }, 400);
          }
          if (contentLength > MAX_ARTIFACT_REQUEST_BYTES) {
            return c.json({ error: artifactTooLargeMessage() }, 413);
          }
        }
        const raw = c.req.raw.body instanceof ReadableStream
          ? await readBodyWithLimit(c.req.raw.body, MAX_ARTIFACT_REQUEST_BYTES)
          : Buffer.from(await c.req.arrayBuffer());
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
