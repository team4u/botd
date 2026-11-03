import { randomBytes, randomUUID } from 'node:crypto';
import type { PlatformType, UserRole } from '@botd/protocol';
import { requireAdmin } from '../http-helpers.js';
import type { HubApp, HubContext } from './context.js';

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{2,32}$/;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function registerAuthRoutes(app: HubApp, ctx: HubContext): void {
  const { db, auth, artifacts } = ctx;

  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({} as { username?: string; password?: string }));
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
      return c.json({ error: 'Invalid username or password' }, 401);
    }

    const user = db.getUserWithHash(body.username);
    if (!user || !auth.verifyPassword(body.password, user.passwordHash)) {
      return c.json({ error: 'Invalid username or password' }, 401);
    }

    const { token, maxAgeSeconds } = auth.issueToken(user.id, db.getUserTokenEpoch(user.id) ?? 0);
    c.header('Set-Cookie', `botd_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`);
    return c.json({
      ok: true,
      user: { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt },
    });
  });

  app.post('/api/auth/logout', (c) => {
    c.header('Set-Cookie', 'botd_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', (c) => c.json({ authenticated: true, user: c.get('user') }));

  // User management (admin only)
  app.get('/api/users', (c) => {
    const adminErr = requireAdmin(c);
    if (adminErr) return adminErr;
    return c.json(db.listUsers());
  });

  app.post('/api/users', async (c) => {
    const adminErr = requireAdmin(c);
    if (adminErr) return adminErr;
    const body = await c.req.json<{ username?: string; password?: string; role?: string }>().catch(() => ({} as { username?: string; password?: string; role?: string }));
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const roleInput = body?.role ?? 'member';
    if (!USERNAME_REGEX.test(username) || password.length < 4 || (roleInput !== 'admin' && roleInput !== 'member')) {
      return c.json({ error: 'Invalid username, password, or role' }, 400);
    }
    const role: UserRole = roleInput;
    const id = `user_${randomUUID()}`;
    try {
      db.createUser({ id, username, passwordHash: auth.hashPassword(password), role });
    } catch {
      return c.json({ error: 'Username already exists' }, 409);
    }
    return c.json(db.getUser(id));
  });

  app.delete('/api/users/:id', (c) => {
    const adminErr = requireAdmin(c);
    if (adminErr) return adminErr;
    const id = c.req.param('id');
    if (id === c.get('user').id) {
      return c.json({ error: 'Cannot delete yourself' }, 400);
    }
    if (!db.getUser(id)) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (db.countNodesOwnedBy(id) > 0) {
      return c.json({ error: 'User still owns nodes; delete their nodes first' }, 409);
    }
    artifacts.deleteUser(id);
    return c.json({ ok: true });
  });

  app.put('/api/users/:id/password', async (c) => {
    const adminErr = requireAdmin(c);
    if (adminErr) return adminErr;
    const id = c.req.param('id');
    const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }));
    if (!body || typeof body.password !== 'string' || body.password.length < 4) {
      return c.json({ error: 'Password must be at least 4 characters' }, 400);
    }
    if (!db.getUser(id)) {
      return c.json({ error: 'User not found' }, 404);
    }
    db.updateUserPassword(id, auth.hashPassword(body.password));
    return c.json({ ok: true });
  });

  // Node pairing
  app.post('/api/nodes/pairing', (c) => {
    const pairing = auth.createPairingCode(c.get('user').id);
    return c.json(pairing);
  });

  app.post('/api/nodes/pairing/exchange', async (c) => {
    const body = (await c.req
      .json<{ code?: string; name?: string; platform?: PlatformType }>()
      .catch(() => ({} as { code?: string; name?: string; platform?: PlatformType })));
    if (!body || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)
      || !isText(body.name) || (body.platform !== undefined && !['linux', 'darwin', 'win32'].includes(body.platform))) {
      return c.json({ error: 'Invalid pairing input' }, 400);
    }

    // 配对码暴破防护：按来源 IP 失败指数退避（1s 起，上限 5 分钟）。
    // 持有效配对码的请求不拦截（失败退避只针对暴破猜测），避免误伤正常配对重试。
    const clientIp =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || 'unknown';
    const ownerUserId = auth.peekPairingCodeOwner(body.code);
    if (!ownerUserId) {
      const backoffMs = auth.pairingBackoffRemainingMs(clientIp);
      if (backoffMs > 0) {
        return c.json({ error: `Too many failed pairing attempts; retry in ${Math.ceil(backoffMs / 1000)}s` }, 429);
      }
      // 该 IP 记一次失败；若猜测的码确实存在，也对其连续失败计数（5 次即作废）
      auth.recordPairingFailure(clientIp, body.code);
      return c.json({ error: 'Invalid or expired pairing code' }, 400);
    }
    // 消费配对码（一次性语义）并清除该 IP 的失败退避
    const pairedUserId = auth.consumePairingCode(body.code);
    if (!pairedUserId) {
      return c.json({ error: 'Invalid or expired pairing code' }, 400);
    }
    auth.clearPairingFailures(clientIp);

    const nodeId = `node_${randomUUID()}`;
    const token = randomBytes(24).toString('hex');
    const tokenHash = auth.hashToken(token);
    const name = body.name || 'Test node';
    const platform = (body.platform as PlatformType) || 'linux';

    db.createNode({ id: nodeId, name, platform, tokenHash, ownerId: pairedUserId });

    const proto = c.req.header('x-forwarded-proto') || (c.req.url.startsWith('https:') ? 'https' : 'http');
    const host = c.req.header('host') || '127.0.0.1';
    const hubUrl = `${proto}://${host}`;

    return c.json({
      nodeId,
      name,
      hubUrl,
      token,
    });
  });
}
