import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import type {
  BotConfig,
  CreateSessionInput,
  PlatformType,
  SaveBotInput,
  SessionMode,
  UserRecord,
  UserRole,
} from '@botd/protocol';
import { HubDatabase, isValidCommandName } from './db.js';
import { AuthManager } from './auth.js';
import { SseHub } from './sse.js';
import { NodeConnectionManager } from './ws-hub.js';
import { GroupRouter, extractMentions, parseSlashCommand } from './group-router.js';
import { createStaticMiddleware } from './static.js';
import { registerProviderRoutes } from './providers.js';

export interface HubOptions {
  dbPath?: string;
  adminPassword?: string;
  webDir?: string;
}

export interface StartHubOptions extends HubOptions {
  port?: number;
  host?: string;
}

export interface HubInstance {
  app: Hono<{ Variables: { user: UserRecord } }>;
  db: HubDatabase;
  connections: NodeConnectionManager;
  router: GroupRouter;
  close: () => Promise<void>;
}

export interface StartHubResult extends HubInstance {
  server: Server;
  port: number;
}

const VALID_MODES = new Set<SessionMode>(['direct', 'lead', 'roundtable']);
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{2,32}$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isId = (value: unknown): value is string => typeof value === 'string' && ID_REGEX.test(value);
const isBotConfig = (value: unknown): value is BotConfig => {
  if (!isObject(value)) return false;
  return isId(value.id) && isId(value.nodeId) && isText(value.name) && typeof value.description === 'string'
    && isText(value.modelProvider) && isText(value.modelId)
    && (value.thinkingLevel === undefined || ['low', 'medium', 'high'].includes(String(value.thinkingLevel)))
    && Array.isArray(value.enabledSkills) && value.enabledSkills.every(isId)
    && (value.enabledExtensions === undefined || (Array.isArray(value.enabledExtensions) && value.enabledExtensions.every(isId)))
    && (value.webCommandNames === undefined || (Array.isArray(value.webCommandNames) && value.webCommandNames.every(isValidCommandName)));
};

export function createHub(options?: HubOptions): HubInstance {
  const db = new HubDatabase({ dbPath: options?.dbPath });
  const auth = new AuthManager();
  const adminPassword = options?.adminPassword || process.env.BOTD_ADMIN_PASSWORD || 'admin';
  db.ensureBootstrapAdmin(auth.hashPassword(adminPassword));
  const sseHub = new SseHub();
  const connections = new NodeConnectionManager(db, auth, sseHub);
  const router = new GroupRouter(db, connections, sseHub);
  connections.setRouter(router);

  const app = new Hono<{ Variables: { user: UserRecord } }>();
  app.onError((error, c) => c.json({ error: error.message || 'Internal server error' }, 500));
  app.notFound(c => c.json({ error: 'Not found' }, 404));

  // SessionRecord 未暴露 ownerId，直接查 sessions 表读取归属
  const getSessionOwnerId = (sessionId: string): string | undefined => {
    const row = db.db.prepare('SELECT owner_id FROM sessions WHERE id = ?').get(sessionId) as
      | { owner_id: string | null }
      | undefined;
    return row?.owner_id ?? undefined;
  };

  // 1. Health check (public)
  app.get('/api/health', (c) => c.json({ ok: true }));

  // 2. Cookie authentication middleware for /api/*
  app.use('/api/*', async (c, next) => {
    const reqPath = c.req.path;
    const method = c.req.method;

    if (
      reqPath === '/api/health' ||
      (reqPath === '/api/auth/login' && method === 'POST') ||
      (reqPath === '/api/nodes/pairing/exchange' && method === 'POST')
    ) {
      return next();
    }

    const cookie = c.req.header('cookie');
    const verified = auth.verifyCookie(cookie);
    const user = verified ? db.getUser(verified.userId) : undefined;
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('user', user);

    return next();
  });

  // 3. Auth routes
  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({} as { username?: string; password?: string }));
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
      return c.json({ error: 'Invalid username or password' }, 401);
    }

    const user = db.getUserWithHash(body.username);
    if (!user || !auth.verifyPassword(body.password, user.passwordHash)) {
      return c.json({ error: 'Invalid username or password' }, 401);
    }

    const { token, maxAgeSeconds } = auth.issueToken(user.id);
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

  // 4. User management (admin only)
  app.get('/api/users', (c) => {
    if (c.get('user').role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    return c.json(db.listUsers());
  });

  app.post('/api/users', async (c) => {
    if (c.get('user').role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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
    if (c.get('user').role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    const id = c.req.param('id');
    if (id === c.get('user').id) {
      return c.json({ error: 'Cannot delete yourself' }, 400);
    }
    if (!db.getUser(id)) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (db.getAllNodesWithBots(id).length > 0) {
      return c.json({ error: 'User still owns nodes; delete their nodes first' }, 409);
    }
    db.deleteUser(id);
    return c.json({ ok: true });
  });

  app.put('/api/users/:id/password', async (c) => {
    if (c.get('user').role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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

  // 5. Node pairing
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
    const ownerUserId = auth.consumePairingCode(body.code);
    if (!ownerUserId) {
      return c.json({ error: 'Invalid or expired pairing code' }, 400);
    }

    const nodeId = `node_${randomUUID()}`;
    const token = randomBytes(24).toString('hex');
    const tokenHash = auth.hashToken(token);
    const name = body.name || 'Test node';
    const platform = (body.platform as PlatformType) || 'linux';

    db.createNode({ id: nodeId, name, platform, tokenHash, ownerId: ownerUserId });

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

  // 6. Node, Skill, and Extension management
  app.get('/api/nodes', (c) => c.json(db.getAllNodesWithBots(c.get('user').id)));

  app.delete('/api/nodes/:nodeId', (c) => {
    const { nodeId } = c.req.param();
    const node = db.getNode(nodeId);
    if (!node) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const bots = db.getBotsForNode(nodeId);
    if (bots.length > 0) {
      return c.json({ error: `Node still hosts ${bots.length} bot(s); delete them first` }, 409);
    }

    connections.disconnectNode(nodeId);
    db.deleteNode(nodeId);
    return c.json({ ok: true });
  });

  app.get('/api/nodes/:nodeId/skills/:skillId', async (c) => {
    const { nodeId, skillId } = c.req.param();
    if (!ID_REGEX.test(skillId)) {
      return c.json({ error: 'Invalid skill id format' }, 400);
    }
    if (!db.getNode(nodeId)) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rpc = connections.getNodeRpc(nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }
    try {
      const content = await rpc.readFile({ kind: 'skill', id: skillId });
      return c.json({ content });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read skill' }, 500);
    }
  });

  app.put('/api/nodes/:nodeId/skills/:skillId', async (c) => {
    const { nodeId, skillId } = c.req.param();
    if (!ID_REGEX.test(skillId)) {
      return c.json({ error: 'Invalid skill id format' }, 400);
    }
    if (!db.getNode(nodeId)) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rpc = connections.getNodeRpc(nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }
    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    try {
      await rpc.writeFile({ kind: 'skill', id: skillId }, body.content);
      db.addNodeSkill(nodeId, skillId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write skill' }, 500);
    }
  });

  app.delete('/api/nodes/:nodeId/skills/:skillId', async (c) => {
    const { nodeId, skillId } = c.req.param();
    if (!ID_REGEX.test(skillId)) {
      return c.json({ error: 'Invalid skill id format' }, 400);
    }
    if (!db.getNode(nodeId)) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rpc = connections.getNodeRpc(nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }
    try {
      await rpc.deleteResource({ kind: 'skill', id: skillId });
      db.removeNodeSkill(nodeId, skillId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to delete skill' }, 500);
    }
  });

  app.get('/api/nodes/:nodeId/extensions/:extId', async (c) => {
    const { nodeId, extId } = c.req.param();
    if (!ID_REGEX.test(extId)) {
      return c.json({ error: 'Invalid extension id format' }, 400);
    }
    if (!db.getNode(nodeId)) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rpc = connections.getNodeRpc(nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }
    try {
      const content = await rpc.readFile({ kind: 'extension', id: extId });
      return c.json({ content });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read extension' }, 500);
    }
  });

  app.put('/api/nodes/:nodeId/extensions/:extId', async (c) => {
    const { nodeId, extId } = c.req.param();
    if (!ID_REGEX.test(extId)) {
      return c.json({ error: 'Invalid extension id format' }, 400);
    }
    if (!db.getNode(nodeId)) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rpc = connections.getNodeRpc(nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }
    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    try {
      await rpc.writeFile({ kind: 'extension', id: extId }, body.content);
      db.addNodeExtension(nodeId, extId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write extension' }, 500);
    }
  });

  app.delete('/api/nodes/:nodeId/extensions/:extId', async (c) => {
    const { nodeId, extId } = c.req.param();
    if (!ID_REGEX.test(extId)) {
      return c.json({ error: 'Invalid extension id format' }, 400);
    }
    if (!db.getNode(nodeId)) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rpc = connections.getNodeRpc(nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }
    try {
      await rpc.deleteResource({ kind: 'extension', id: extId });
      db.removeNodeExtension(nodeId, extId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to delete extension' }, 500);
    }
  });

  app.post('/api/nodes/:nodeId/install', async (c) => {
    const { nodeId } = c.req.param();
    if (!db.getNode(nodeId)) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rpc = connections.getNodeRpc(nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }
    const body = await c.req.json<{
      source?: string;
      kind?: 'auto' | 'skill' | 'extension';
      customId?: string;
    }>().catch(() => null);
    if (!body || !isText(body.source)) {
      return c.json({ error: 'Invalid install source' }, 400);
    }
    if (body.kind !== undefined && !['auto', 'skill', 'extension'].includes(body.kind)) {
      return c.json({ error: 'Invalid kind' }, 400);
    }
    if (body.customId !== undefined && body.customId !== '' && !isId(body.customId)) {
      return c.json({ error: 'Invalid customId' }, 400);
    }
    try {
      const installed = await rpc.installResource({
        source: body.source.trim(),
        kind: body.kind,
        customId: body.customId?.trim() || undefined,
      });
      if (installed.kind === 'skill') {
        db.addNodeSkill(nodeId, installed.id);
      } else {
        db.addNodeExtension(nodeId, installed.id);
      }
      return c.json(installed);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to install resource' }, 500);
    }
  });

  app.post('/api/nodes/:nodeId/restart', async (c) => {
    const { nodeId } = c.req.param();
    const node = db.getNode(nodeId);
    if (!node) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rpc = connections.getNodeRpc(nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }
    try {
      const result = await rpc.restartDaemon();
      return c.json(result);
    } catch (err: any) {
      const message = err && typeof err === 'object' && 'message' in err && err.message
        ? String(err.message)
        : 'Failed to restart daemon';
      return c.json({ error: message }, 502);
    }
  });

  // 7. Bot management (Node is authoritative)
  app.post('/api/bots', async (c) => {
    const body = await c.req.json<SaveBotInput>().catch(() => null);
    if (!isBotConfig(body) || typeof body.systemMd !== 'string') {
      return c.json({ error: 'Invalid BOT configuration' }, 400);
    }

    const node = db.getNode(body.nodeId);
    if (!node) {
      return c.json({ error: 'Node not found' }, 404);
    }
    if (db.getNodeOwner(body.nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const existing = db.getBot(body.id);
    if (existing && existing.nodeId !== body.nodeId) {
      return c.json({ error: `Bot id "${body.id}" already owned by node "${existing.nodeId}"` }, 409);
    }

    const rpc = connections.getNodeRpc(body.nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }

    const botConfig: BotConfig = {
      id: body.id,
      nodeId: body.nodeId,
      name: body.name,
      description: body.description || '',
      modelProvider: body.modelProvider,
      modelId: body.modelId,
      thinkingLevel: body.thinkingLevel ?? 'medium',
      enabledSkills: Array.isArray(body.enabledSkills) ? body.enabledSkills : [],
      enabledExtensions: Array.isArray(body.enabledExtensions) ? body.enabledExtensions : [],
      webCommandNames: Array.isArray(body.webCommandNames) ? Array.from(new Set(body.webCommandNames)) : [],
      updatedAt: new Date().toISOString(),
    };

    try {
      await rpc.saveBot(botConfig, body.systemMd || '');
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to save bot on node' }, 500);
    }

    db.saveBot(botConfig);
    return c.json(botConfig);
  });

  app.put('/api/bots/:botId', async (c) => {
    const botId = c.req.param('botId');
    const existing = db.getBot(botId);
    if (!existing) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    if (db.getNodeOwner(existing.nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<Partial<BotConfig> & { systemMd?: string }>().catch(() => null);
    if (!isObject(body) || !isBotConfig({ ...existing, ...body, id: botId })
      || (body.systemMd !== undefined && typeof body.systemMd !== 'string')) {
      return c.json({ error: 'Invalid BOT configuration' }, 400);
    }

    if (body.nodeId && body.nodeId !== existing.nodeId) {
      return c.json({ error: 'Cannot transfer bot to a different node' }, 409);
    }

    const rpc = connections.getNodeRpc(existing.nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }

    const { systemMd: requestedSystem, ...botPatch } = body;
    const botConfig: BotConfig = {
      ...existing,
      ...botPatch,
      enabledExtensions: Array.isArray(body.enabledExtensions) ? body.enabledExtensions : (existing.enabledExtensions ?? []),
      webCommandNames: Array.isArray(body.webCommandNames)
        ? Array.from(new Set(body.webCommandNames))
        : (existing.webCommandNames ?? []),
      id: botId,
      nodeId: existing.nodeId,
      updatedAt: new Date().toISOString(),
    };

    try {
      const systemMd = requestedSystem ?? await rpc.readFile({ kind: 'system', botId, id: 'SYSTEM.md' });
      await rpc.saveBot(botConfig, systemMd);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to save bot on node' }, 500);
    }

    db.saveBot(botConfig);
    return c.json(botConfig);
  });

  app.delete('/api/bots/:botId', async (c) => {
    const botId = c.req.param('botId');
    const existing = db.getBot(botId);
    if (!existing) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    if (db.getNodeOwner(existing.nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rpc = connections.getNodeRpc(existing.nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }

    try {
      await rpc.deleteBot(botId);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to delete bot on node' }, 500);
    }

    db.deleteBot(botId);
    return c.json({ ok: true });
  });

  app.get('/api/bots/:botId/commands', async (c) => {
    const botId = c.req.param('botId');
    const bot = db.getBot(botId);
    if (!bot) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    if (db.getNodeOwner(bot.nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rpc = connections.getNodeRpc(bot.nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }

    try {
      const commands = await rpc.getCommands(botId);
      return c.json(commands);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to fetch bot commands' }, 500);
    }
  });

  app.get('/api/bots/:botId/system', async (c) => {
    const botId = c.req.param('botId');
    const bot = db.getBot(botId);
    if (!bot) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    if (db.getNodeOwner(bot.nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rpc = connections.getNodeRpc(bot.nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }

    try {
      const content = await rpc.readFile({ kind: 'system', botId, id: 'SYSTEM.md' });
      return c.json({ content });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read system prompt' }, 500);
    }
  });

  app.put('/api/bots/:botId/system', async (c) => {
    const botId = c.req.param('botId');
    const bot = db.getBot(botId);
    if (!bot) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    if (db.getNodeOwner(bot.nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rpc = connections.getNodeRpc(bot.nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }

    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    try {
      await rpc.writeFile({ kind: 'system', botId, id: 'SYSTEM.md' }, body.content);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write system prompt' }, 500);
    }
  });

  app.get('/api/bots/:botId/memory', async (c) => {
    const botId = c.req.param('botId');
    const bot = db.getBot(botId);
    if (!bot) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    if (db.getNodeOwner(bot.nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rpc = connections.getNodeRpc(bot.nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }

    try {
      const content = await rpc.readFile({ kind: 'memory', botId, id: 'MEMORY.md' });
      return c.json({ content });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read memory' }, 500);
    }
  });

  app.put('/api/bots/:botId/memory', async (c) => {
    const botId = c.req.param('botId');
    const bot = db.getBot(botId);
    if (!bot) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    if (db.getNodeOwner(bot.nodeId) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rpc = connections.getNodeRpc(bot.nodeId);
    if (!rpc) {
      return c.json({ error: 'Node is offline' }, 503);
    }

    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    try {
      await rpc.writeFile({ kind: 'memory', botId, id: 'MEMORY.md' }, body.content);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write memory' }, 500);
    }
  });

  // 8. Session management
  app.get('/api/sessions', (c) => c.json(db.getAllSessions(c.get('user').id)));

  app.post('/api/sessions', async (c) => {
    const user = c.get('user');
    const body = await c.req.json<CreateSessionInput>().catch(() => null);
    if (!body || !body.title || typeof body.title !== 'string' || !body.title.trim()) {
      return c.json({ error: 'Invalid session title' }, 400);
    }
    if (!VALID_MODES.has(body.mode)) {
      return c.json({ error: 'Invalid session mode' }, 400);
    }
    const leadBot = isId(body.leadBotId) ? db.getBot(body.leadBotId) : undefined;
    if (!leadBot) {
      return c.json({ error: `Lead bot ${body?.leadBotId} not found` }, 400);
    }
    if (db.getNodeOwner(leadBot.nodeId) !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!Array.isArray(body.memberBotIds)) {
      return c.json({ error: 'Invalid memberBotIds' }, 400);
    }

    for (const memberId of body.memberBotIds) {
      const memberBot = isId(memberId) ? db.getBot(memberId) : undefined;
      if (!memberBot) {
        return c.json({ error: `Member bot ${memberId} not found` }, 400);
      }
      if (db.getNodeOwner(memberBot.nodeId) !== user.id) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }

    const memberBotIds = [...new Set(body.memberBotIds)];
    if (!memberBotIds.includes(body.leadBotId) || (body.mode === 'direct' && memberBotIds.length !== 1)) {
      return c.json({ error: 'Lead BOT must be a member; direct sessions have exactly one member' }, 400);
    }
    const sessionId = `sess_${randomUUID()}`;
    const session = db.createSession({
      id: sessionId,
      title: body.title.trim(),
      mode: body.mode,
      leadBotId: body.leadBotId,
      memberBotIds,
      ownerId: user.id,
    });

    return c.json(session);
  });

  app.patch('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{ title?: string; mode?: SessionMode; leadBotId?: string; memberBotIds?: string[]; archived?: boolean }>().catch(() => null);
    if (!isObject(body)) return c.json({ error: 'Invalid session configuration' }, 400);
    // 归档是纯 UI 分类标记，允许在运行中修改（如「开启新话题」时旧会话仍在后台执行）；
    // 标题/模式/负责人/成员会改变调度行为，运行中仍需拒绝。
    const touchesConfig =
      body.title !== undefined ||
      body.mode !== undefined ||
      body.leadBotId !== undefined ||
      body.memberBotIds !== undefined;
    if (session.status === 'running' && touchesConfig) {
      return c.json({ error: 'Stop the session before changing its configuration' }, 409);
    }
    if (body.archived !== undefined && typeof body.archived !== 'boolean') return c.json({ error: 'Invalid archived flag' }, 400);
    if (body.title !== undefined && !isText(body.title)) return c.json({ error: 'Invalid session title' }, 400);
    if (body.leadBotId !== undefined && !isId(body.leadBotId)) return c.json({ error: 'Invalid lead BOT' }, 400);
    if (body.memberBotIds !== undefined && (!Array.isArray(body.memberBotIds) || !body.memberBotIds.every(isId))) {
      return c.json({ error: 'Invalid memberBotIds' }, 400);
    }

    if (body.mode !== undefined && !VALID_MODES.has(body.mode)) {
      return c.json({ error: 'Invalid session mode' }, 400);
    }

    if (body.leadBotId && !db.getBot(body.leadBotId)) {
      return c.json({ error: `Lead bot ${body.leadBotId} not found` }, 400);
    }

    if (body.memberBotIds) {
      if (!Array.isArray(body.memberBotIds)) {
        return c.json({ error: 'Invalid memberBotIds' }, 400);
      }
      for (const mid of body.memberBotIds) {
        if (!db.getBot(mid)) {
          return c.json({ error: `Member bot ${mid} not found` }, 400);
        }
      }
    }

    const leadBotId = body.leadBotId ?? session.leadBotId;
    const mode = body.mode ?? session.mode;
    const memberBotIds = [...new Set(body.memberBotIds ?? session.memberBotIds)];
    if (!memberBotIds.includes(leadBotId) || (mode === 'direct' && memberBotIds.length !== 1)) {
      return c.json({ error: 'Lead BOT must be a member; direct sessions have exactly one member' }, 400);
    }
    const updated = db.updateSession(id, { title: body.title?.trim(), mode, leadBotId, memberBotIds, archived: body.archived });
    return c.json(updated);
  });

  app.get('/api/sessions/:id/messages', (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return c.json(db.getMessages(id));
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = (await c.req.json<{ content?: string }>().catch(() => ({ content: '' }))) as {
      content?: string;
    };
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      return c.json({ error: 'Missing content' }, 400);
    }

    const validBots = new Set([session.leadBotId, ...session.memberBotIds]);
    const cmdResult = parseSlashCommand(body.content, validBots);
    if (cmdResult.error) {
      return c.json({ error: cmdResult.error }, 400);
    }

    const mentions = cmdResult.targetBotId
      ? [cmdResult.targetBotId]
      : (cmdResult.isCommand ? [] : extractMentions(body.content, validBots));

    const msgResult = db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId: id,
      role: 'user',
      content: body.content,
      mentions,
    });

    sseHub.broadcast(id, {
      type: 'message_created',
      message: msgResult.message,
    });

    router.handleUserMessage(id, msgResult.message.id, body.content, cmdResult.isCommand ? {
      commandText: cmdResult.commandText!,
      targetBotId: cmdResult.targetBotId,
    } : undefined);

    return c.json(msgResult.message, 202);
  });

  // 编辑用户消息：更新锚点内容，截断其后所有消息，重置游标与节点本地会话，再从锚点重新派发
  app.put('/api/sessions/:id/messages/:messageId', async (c) => {
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const found = db.getMessageById(messageId);
    if (!found || found.message.sessionId !== id) {
      return c.json({ error: 'Message not found' }, 404);
    }
    const message = found.message;

    const body = (await c.req.json<{ content?: string }>().catch(() => ({ content: '' }))) as {
      content?: string;
    };
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      return c.json({ error: 'Missing content' }, 400);
    }

    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before editing messages' }, 409);
    }
    if (message.role !== 'user') {
      return c.json({ error: 'Only user messages can be edited' }, 400);
    }

    // 先校验斜杠命令，避免截断发生后才发现无法派发
    const validBots = new Set([session.leadBotId, ...session.memberBotIds]);
    const cmdResult = parseSlashCommand(body.content, validBots);
    if (cmdResult.error) {
      return c.json({ error: cmdResult.error }, 400);
    }

    const mentions = cmdResult.targetBotId
      ? [cmdResult.targetBotId]
      : (cmdResult.isCommand ? [] : extractMentions(body.content, validBots));

    const anchorRowid = found.rowid;
    const updated = db.updateMessageContent(messageId, body.content, mentions);
    if (!updated) {
      return c.json({ error: 'Message not found' }, 404);
    }

    db.deleteMessagesAfter(id, anchorRowid);
    db.resetSessionCursors(id);
    await router.resetMemberSessions(id);
    sseHub.broadcast(id, {
      type: 'messages_truncated',
      sessionId: id,
      anchorMessageId: messageId,
    });

    router.handleUserMessage(id, messageId, body.content, cmdResult.isCommand ? {
      commandText: cmdResult.commandText!,
      targetBotId: cmdResult.targetBotId,
    } : undefined);

    return c.json(updated, 200);
  });

  app.post('/api/sessions/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await router.cancelSession(id);
    return c.json({ ok: true });
  });

  // 会话分叉：以某条消息为锚点克隆出新会话（含锚点及其之前的消息），源会话完全不动。
  // 允许 running 中分叉：只读源会话 + 新建独立会话，不打扰执行中的回合；新会话尚无订阅者，无需 SSE 广播。
  app.post('/api/sessions/:id/fork', async (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{ anchorMessageId?: string }>().catch(() => null);
    if (!isObject(body) || !isText(body.anchorMessageId)) {
      return c.json({ error: 'Invalid anchorMessageId' }, 400);
    }

    const forked = db.forkSession(id, body.anchorMessageId);
    if (!forked) {
      return c.json({ error: 'Session or anchor message not found' }, 404);
    }

    return c.json(forked, 201);
  });

  app.delete('/api/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before clearing messages' }, 409);
    }

    db.clearSessionMessages(id);
    // 同步清空各成员节点的本地会话记忆（best-effort，失败在方法内部吞掉）
    await router.resetMemberSessions(id);
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before deleting it' }, 409);
    }

    // resetMemberSessions 内部要查会话成员，必须在 deleteSession 之前调用
    await router.resetMemberSessions(id);
    db.deleteSession(id);
    return c.json({ ok: true });
  });

  // 9. SSE Streaming
  app.get('/api/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    return streamSSE(c, async (stream) => {
      // Send initial session status event
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'session_status',
          sessionId: session.id,
          status: session.status,
          activeBotId: session.activeBotId,
        }),
      });

      const unsubscribe = sseHub.subscribe(id, async (event) => {
        try {
          await stream.writeSSE({
            data: JSON.stringify(event),
          });
        } catch {
          // stream aborted or error
        }
      });

      const keepalive = setInterval(async () => {
        try {
          await stream.writeSSE({
            event: 'ping',
            data: '',
          });
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        unsubscribe();
      });

      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
    });
  });

  registerProviderRoutes(app, db, connections);

  // 10. Serve static web files & SPA fallback
  app.use('*', createStaticMiddleware(options?.webDir));

  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    router.close();
    connections.close();
    sseHub.close();
    db.close();
  };

  return {
    app,
    db,
    connections,
    router,
    close,
  };
}

export async function startHub(options?: StartHubOptions): Promise<StartHubResult> {
  const hub = createHub(options);
  const host = options?.host ?? process.env.BOTD_HOST ?? '0.0.0.0';
  const requestedPort =
    options?.port !== undefined
      ? options.port
      : Number(process.env.BOTD_PORT || process.env.PORT || 3000);

  let resolveServer!: (server: Server) => void;
  let rejectServer!: (err: Error) => void;
  const serverReady = new Promise<Server>((resolve, reject) => {
    resolveServer = resolve;
    rejectServer = reject;
  });

  const server = serve(
    {
      fetch: hub.app.fetch,
      hostname: host,
      port: requestedPort,
    },
    () => {
      resolveServer(server as unknown as Server);
    }
  ) as unknown as Server;

  server.on('error', (err) => {
    rejectServer(err);
  });

  server.on('upgrade', (req, socket, head) => {
    hub.connections.handleUpgrade(req, socket, head);
  });

  await serverReady;

  const addr = server.address();
  const resolvedPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  const originalClose = hub.close;
  hub.close = async (): Promise<void> => {
    // 1. Close application resources, WebSockets and DB first
    await originalClose();

    // 2. Abort or close all open connections to prevent server.close hanging
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }

    // 3. Close the server with fallback timeout
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return {
    ...hub,
    server,
    port: resolvedPort,
  };
}

// Direct execution entry
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startHub()
    .then(({ port, close }) => {
      console.log(`Cloud Hub listening on http://127.0.0.1:${port}`);
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await close();
        process.exit(0);
      };
      process.once('SIGTERM', () => { void shutdown(); });
      process.once('SIGINT', () => { void shutdown(); });
    })
    .catch((err) => {
      console.error('Failed to start Cloud Hub:', err);
      process.exit(1);
    });
}
