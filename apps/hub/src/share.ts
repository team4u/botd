import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Hono } from 'hono';
import type {
  SessionShareRecord,
  SharedBotSummary,
  SharedSessionSnapshot,
  UserRecord,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { ArtifactService } from './artifact-service.js';

interface ShareRow {
  id: string;
  session_id: string;
  owner_id: string;
  token: string;
  created_at: string;
  expires_at: string | null;
}

function mapShareRow(row: ShareRow): SessionShareRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    token: row.token,
    createdAt: row.created_at,
    expiresAt: row.expires_at || undefined,
  };
}

export function registerShareRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  _artifactService: ArtifactService,
  getSessionOwnerId: (sessionId: string) => string | undefined
): void {
  // 1. 初始化数据表
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS session_shares (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_shares_token ON session_shares(token);
  `);

  // 2. 认证接口（仅会话归属用户可访问）
  app.get('/api/sessions/:id/share', (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const ownerId = getSessionOwnerId(id);

    if (!ownerId) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (ownerId !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const stmt = db.db.prepare(
      'SELECT id, session_id, owner_id, token, created_at, expires_at FROM session_shares WHERE session_id = ?'
    );
    const row = stmt.get(id) as ShareRow | undefined;
    if (!row) {
      return c.json({ share: null });
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return c.json({ share: null });
    }

    return c.json({ share: mapShareRow(row) });
  });

  app.post('/api/sessions/:id/share', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const ownerId = getSessionOwnerId(id);

    if (!ownerId) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (ownerId !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{ regenerate?: boolean }>().catch(() => ({ regenerate: false }));

    const queryStmt = db.db.prepare(
      'SELECT id, session_id, owner_id, token, created_at, expires_at FROM session_shares WHERE session_id = ?'
    );
    const existing = queryStmt.get(id) as ShareRow | undefined;
    const isExpired = existing?.expires_at ? new Date(existing.expires_at).getTime() <= Date.now() : false;

    if (existing && !isExpired && !body?.regenerate) {
      return c.json(mapShareRow(existing), 200);
    }

    const newRecord: SessionShareRecord = {
      id: `shr_${randomUUID()}`,
      sessionId: id,
      token: randomBytes(18).toString('hex'),
      createdAt: new Date().toISOString(),
    };

    const upsertStmt = db.db.prepare(`
      INSERT INTO session_shares (id, session_id, owner_id, token, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(session_id) DO UPDATE SET
        id = excluded.id,
        owner_id = excluded.owner_id,
        token = excluded.token,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `);
    upsertStmt.run(newRecord.id, newRecord.sessionId, user.id, newRecord.token, newRecord.createdAt);

    return c.json(newRecord, 201);
  });

  app.delete('/api/sessions/:id/share', (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const ownerId = getSessionOwnerId(id);

    if (!ownerId) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (ownerId !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const deleteStmt = db.db.prepare('DELETE FROM session_shares WHERE session_id = ?');
    deleteStmt.run(id);

    return c.json({ ok: true });
  });

  // 3. 公开免登录接口
  app.get('/api/public/shares/:token', (c) => {
    const token = c.req.param('token');
    const stmt = db.db.prepare(
      'SELECT id, session_id, owner_id, token, created_at, expires_at FROM session_shares WHERE token = ?'
    );
    const shareRow = stmt.get(token) as ShareRow | undefined;

    if (!shareRow) {
      return c.json({ error: 'Share link not found or expired' }, 404);
    }
    if (shareRow.expires_at && new Date(shareRow.expires_at).getTime() <= Date.now()) {
      return c.json({ error: 'Share link not found or expired' }, 404);
    }

    const session = db.getSession(shareRow.session_id);
    if (!session) {
      return c.json({ error: 'Share link not found or expired' }, 404);
    }

    const botIds = [...new Set([session.leadBotId, ...(session.memberBotIds || [])])];
    const bots: SharedBotSummary[] = [];
    for (const botId of botIds) {
      const bot = db.getBot(botId);
      if (bot) {
        bots.push({
          id: bot.id,
          name: bot.name,
          description: bot.description,
          modelProvider: bot.modelProvider,
          modelId: bot.modelId,
        });
      }
    }

    const messages = db.getMessages(shareRow.session_id);
    const rewrittenMessages = messages.map((msg) => {
      if (!msg.attachments || msg.attachments.length === 0) return msg;
      return {
        ...msg,
        attachments: msg.attachments.map((att) => ({
          ...att,
          url: `/api/public/shares/${encodeURIComponent(token)}/artifacts/${encodeURIComponent(att.id)}/content`,
        })),
      };
    });

    const artifacts = db.listSessionArtifacts(shareRow.session_id);

    const snapshot: SharedSessionSnapshot = {
      share: mapShareRow(shareRow),
      session: {
        id: session.id,
        title: session.title,
        mode: session.mode,
        leadBotId: session.leadBotId,
        memberBotIds: session.memberBotIds,
        parallelRoundtable: session.parallelRoundtable,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      bots,
      messages: rewrittenMessages,
      artifacts,
    };

    return c.json(snapshot);
  });

  app.get('/api/public/shares/:token/artifacts/:artifactId/content', (c) => {
    const token = c.req.param('token');
    const artifactId = c.req.param('artifactId');

    const stmt = db.db.prepare('SELECT session_id, expires_at FROM session_shares WHERE token = ?');
    const shareRow = stmt.get(token) as { session_id: string; expires_at: string | null } | undefined;

    if (!shareRow) {
      return c.json({ error: 'Share link not found or expired' }, 404);
    }
    if (shareRow.expires_at && new Date(shareRow.expires_at).getTime() <= Date.now()) {
      return c.json({ error: 'Share link not found or expired' }, 404);
    }

    const artifact = db.getArtifactWithStoragePath(artifactId);
    if (!artifact || artifact.sessionId !== shareRow.session_id) {
      return c.json({ error: 'Artifact not found' }, 404);
    }

    if (!fs.existsSync(artifact.storagePath)) {
      return c.json({ error: 'Artifact content is missing on disk' }, 410);
    }

    const content = fs.readFileSync(artifact.storagePath);
    return c.body(new Uint8Array(content), 200, {
      'Content-Type': artifact.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(artifact.filename)}"`,
    });
  });
}
