import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import {
  isBotConfig,
  isSafeId,
  isValidBotEnvKey,
} from '@botd/protocol';
import type {
  BotConfig,
  CreateSessionInput,
  MessageAttachment,
  PlatformType,
  SaveBotInput,
  SessionMode,
  UserRecord,
  UserRole,
} from '@botd/protocol';
import { HubDatabase } from './db.js';
import { AuthManager } from './auth.js';
import { SseHub } from './sse.js';
import { NodeConnectionManager } from './ws-hub.js';
import { GroupRouter, extractMentions, parseSlashCommand } from './group-router.js';
import { createStaticMiddleware } from './static.js';
import { registerProviderRoutes } from './providers.js';
import { registerArtifactRoutes } from './artifacts.js';
import { ArtifactService } from './artifact-service.js';
import { registerTriggerRoutes } from './triggers.js';
import { registerBgJobRoutes } from './bg-jobs.js';
import { registerSkillSyncAndAskRoutes } from './skill-sync.js';
import { registerChannelRoutes } from './channels.js';
import {
  requireAdmin,
  resolveOwnedBotRpc,
  resolveOwnedNode,
  resolveOwnedNodeRpc,
  resolveOwnedSession,
  type NodeRpc,
} from './http-helpers.js';

export interface HubOptions {
  dbPath?: string;
  adminPassword?: string;
  webDir?: string;
  artifactsDir?: string;
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
  sseHub: SseHub;
  close: () => Promise<void>;
}

export interface StartHubResult extends HubInstance {
  server: Server;
  port: number;
}

const VALID_MODES = new Set<SessionMode>(['direct', 'lead', 'roundtable']);
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{2,32}$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

interface MemberValidationSuccess {
  ok: true;
  leadBotId: string;
  memberBotIds: string[];
}

interface MemberValidationFailure {
  ok: false;
  error: string;
  status: 400 | 403;
}

type MemberValidationResult = MemberValidationSuccess | MemberValidationFailure;

function validateSessionMembers(
  db: HubDatabase,
  userId: string,
  mode: SessionMode,
  leadBotIdInput: unknown,
  memberBotIdsInput: unknown
): MemberValidationResult {
  if (!isSafeId(leadBotIdInput)) {
    return { ok: false, error: 'Invalid lead BOT', status: 400 };
  }
  const leadBot = db.getBot(leadBotIdInput);
  if (!leadBot) {
    return { ok: false, error: `Lead bot ${leadBotIdInput} not found`, status: 400 };
  }
  if (db.getNodeOwner(leadBot.nodeId) !== userId) {
    return { ok: false, error: 'Forbidden', status: 403 };
  }

  if (!Array.isArray(memberBotIdsInput) || !memberBotIdsInput.every(isSafeId)) {
    return { ok: false, error: 'Invalid memberBotIds', status: 400 };
  }

  const dedupedMembers = [...new Set<string>(memberBotIdsInput)];

  for (const mid of dedupedMembers) {
    const memberBot = db.getBot(mid);
    if (!memberBot) {
      return { ok: false, error: `Member bot ${mid} not found`, status: 400 };
    }
    if (db.getNodeOwner(memberBot.nodeId) !== userId) {
      return { ok: false, error: 'Forbidden', status: 403 };
    }
  }

  if (!dedupedMembers.includes(leadBotIdInput) || (mode === 'direct' && dedupedMembers.length !== 1)) {
    return { ok: false, error: 'Lead BOT must be a member; direct sessions have exactly one member', status: 400 };
  }

  return { ok: true, leadBotId: leadBotIdInput, memberBotIds: dedupedMembers };
}

export function createHub(options?: HubOptions): HubInstance {
  const db = new HubDatabase({ dbPath: options?.dbPath });
  const auth = new AuthManager();
  const adminPassword = options?.adminPassword || process.env.BOTD_ADMIN_PASSWORD || 'admin';
  db.ensureBootstrapAdmin(auth.hashPassword(adminPassword));
  // SessionRecord 未暴露 ownerId，读取归属；SseHub 借此把会话事件同步派发给 owner 的全局订阅者
  const getSessionOwnerId = (sessionId: string): string | undefined => {
    return db.getSessionOwner(sessionId);
  };
  const sseHub = new SseHub({ getSessionOwnerId });
  const artifacts = new ArtifactService(db, sseHub, { artifactsDir: options?.artifactsDir });
  const connections = new NodeConnectionManager(db, auth, sseHub, artifacts);
  const router = new GroupRouter(db, connections, sseHub);
  connections.setRouter(router);

  const app = new Hono<{ Variables: { user: UserRecord } }>();
  app.onError((error, c) => c.json({ error: error.message || 'Internal server error' }, 500));
  app.notFound(c => c.json({ error: 'Not found' }, 404));

  // 1. Health check (public)
  app.get('/api/health', (c) => c.json({ ok: true }));

  // 2. Cookie authentication middleware for /api/*
  app.use('/api/*', async (c, next) => {
    const reqPath = c.req.path;
    const method = c.req.method;

    if (
      reqPath === '/api/health' ||
      (reqPath === '/api/auth/login' && method === 'POST') ||
      (reqPath === '/api/nodes/pairing/exchange' && method === 'POST') ||
      (reqPath.startsWith('/api/webhooks/') && method === 'POST') ||
      reqPath.startsWith('/api/public/asks/')
    ) {
      return next();
    }

    const cookie = c.req.header('cookie');
    const verified = auth.verifyCookie(cookie);
    let user = verified ? db.getUser(verified.userId) : undefined;
    if (!user) {
      const headerNodeId = c.req.header('x-botd-node-id');
      const headerNodeToken = c.req.header('x-botd-node-token');
      if (headerNodeId && headerNodeToken) {
        const nodeWithSecret = db.getNodeWithSecret(headerNodeId);
        if (nodeWithSecret && auth.verifyNodeToken(headerNodeToken, nodeWithSecret.tokenHash)) {
          const ownerId = db.getNodeOwner(headerNodeId);
          if (ownerId) {
            user = db.getUser(ownerId);
          }
        }
      }
    }
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
    if (db.getAllNodesWithBots(id).length > 0) {
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

  app.delete('/api/nodes/:nodeId', async (c) => {
    const { nodeId } = c.req.param();
    const nodeRes = resolveOwnedNode(c, db, nodeId);
    if (!nodeRes.ok) return nodeRes.response;

    const hostedBots = db.getBotsForNode(nodeId);
    if (hostedBots.length > 0) {
      // Regular removal requires an empty node: the node is authoritative for its
      // BOT directories, so deleting them needs the agent to be online.
      if (c.req.query('force') !== '1') {
        return c.json({ error: `Node still hosts ${hostedBots.length} bot(s); delete them first or force=1` }, 409);
      }
      // Force removal (node may be gone for good): drop the Hub cache and
      // best-effort clean the node itself when it happens to be online.
      const rpc = connections.getNodeRpc(nodeId);
      if (rpc) {
        await Promise.allSettled(hostedBots.map((bot) => rpc.deleteBot(bot.id)));
      }
      db.deleteBotsForNode(nodeId);
    }

    connections.disconnectNode(nodeId);
    db.deleteNode(nodeId);
    return c.json({ ok: true });
  });

  app.get('/api/nodes/:nodeId/skills/:skillId', async (c) => {
    const { nodeId, skillId } = c.req.param();
    if (!isSafeId(skillId)) {
      return c.json({ error: 'Invalid skill id format' }, 400);
    }
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      const content = await nodeRpc.rpc.readFile({ kind: 'skill', id: skillId });
      return c.json({ content });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read skill' }, 500);
    }
  });

  app.put('/api/nodes/:nodeId/skills/:skillId', async (c) => {
    const { nodeId, skillId } = c.req.param();
    if (!isSafeId(skillId)) {
      return c.json({ error: 'Invalid skill id format' }, 400);
    }
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    try {
      await nodeRpc.rpc.writeFile({ kind: 'skill', id: skillId }, body.content);
      db.addNodeSkill(nodeId, skillId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write skill' }, 500);
    }
  });

  app.delete('/api/nodes/:nodeId/skills/:skillId', async (c) => {
    const { nodeId, skillId } = c.req.param();
    if (!isSafeId(skillId)) {
      return c.json({ error: 'Invalid skill id format' }, 400);
    }
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      await nodeRpc.rpc.deleteResource({ kind: 'skill', id: skillId });
      db.removeNodeSkill(nodeId, skillId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to delete skill' }, 500);
    }
  });

  app.get('/api/nodes/:nodeId/extensions/:extId', async (c) => {
    const { nodeId, extId } = c.req.param();
    if (!isSafeId(extId)) {
      return c.json({ error: 'Invalid extension id format' }, 400);
    }
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      const content = await nodeRpc.rpc.readFile({ kind: 'extension', id: extId });
      return c.json({ content });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read extension' }, 500);
    }
  });

  app.put('/api/nodes/:nodeId/extensions/:extId', async (c) => {
    const { nodeId, extId } = c.req.param();
    if (!isSafeId(extId)) {
      return c.json({ error: 'Invalid extension id format' }, 400);
    }
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    try {
      await nodeRpc.rpc.writeFile({ kind: 'extension', id: extId }, body.content);
      db.addNodeExtension(nodeId, extId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write extension' }, 500);
    }
  });

  app.delete('/api/nodes/:nodeId/extensions/:extId', async (c) => {
    const { nodeId, extId } = c.req.param();
    if (!isSafeId(extId)) {
      return c.json({ error: 'Invalid extension id format' }, 400);
    }
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      await nodeRpc.rpc.deleteResource({ kind: 'extension', id: extId });
      db.removeNodeExtension(nodeId, extId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to delete extension' }, 500);
    }
  });

  app.post('/api/nodes/:nodeId/install', async (c) => {
    const { nodeId } = c.req.param();
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
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
    if (body.customId !== undefined && body.customId !== '' && !isSafeId(body.customId)) {
      return c.json({ error: 'Invalid customId' }, 400);
    }
    try {
      const installed = await nodeRpc.rpc.installResource({
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
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      const result = await nodeRpc.rpc.restartDaemon();
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

    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, body.nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;

    const existing = db.getBot(body.id);
    if (existing && existing.nodeId !== body.nodeId) {
      return c.json({ error: `Bot id "${body.id}" already owned by node "${existing.nodeId}"` }, 409);
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
      await nodeRpc.rpc.saveBot(botConfig, body.systemMd || '');
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to save bot on node' }, 500);
    }

    db.saveBot(botConfig);
    return c.json(botConfig);
  });

  app.put('/api/bots/:botId', async (c) => {
    const botId = c.req.param('botId');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;
    const { bot: existing, rpc } = botRpc;

    const body = await c.req.json<Partial<BotConfig> & { systemMd?: string }>().catch(() => null);
    if (!isObject(body) || !isBotConfig({ ...existing, ...body, id: botId })
      || (body.systemMd !== undefined && typeof body.systemMd !== 'string')) {
      return c.json({ error: 'Invalid BOT configuration' }, 400);
    }

    if (body.nodeId && body.nodeId !== existing.nodeId) {
      return c.json({ error: 'Cannot transfer bot to a different node' }, 409);
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
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    try {
      await botRpc.rpc.deleteBot(botId);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to delete bot on node' }, 500);
    }

    db.deleteBot(botId);
    return c.json({ ok: true });
  });

  app.get('/api/bots/:botId/commands', async (c) => {
    const botId = c.req.param('botId');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    try {
      const commands = await botRpc.rpc.getCommands(botId);
      return c.json(commands);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to fetch bot commands' }, 500);
    }
  });

  app.get('/api/bots/:botId/system', async (c) => {
    const botId = c.req.param('botId');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    try {
      const content = await botRpc.rpc.readFile({ kind: 'system', botId, id: 'SYSTEM.md' });
      return c.json({ content });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read system prompt' }, 500);
    }
  });

  app.put('/api/bots/:botId/system', async (c) => {
    const botId = c.req.param('botId');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    try {
      await botRpc.rpc.writeFile({ kind: 'system', botId, id: 'SYSTEM.md' }, body.content);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write system prompt' }, 500);
    }
  });

  app.get('/api/bots/:botId/memory', async (c) => {
    const botId = c.req.param('botId');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    try {
      const content = await botRpc.rpc.readFile({ kind: 'memory', botId, id: 'MEMORY.md' });
      return c.json({ content });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read memory' }, 500);
    }
  });

  app.put('/api/bots/:botId/memory', async (c) => {
    const botId = c.req.param('botId');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    try {
      await botRpc.rpc.writeFile({ kind: 'memory', botId, id: 'MEMORY.md' }, body.content);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write memory' }, 500);
    }
  });

  const readNodeBotEnv = async (
    rpc: NodeRpc,
    botId: string,
  ): Promise<Record<string, string>> => {
    try {
      const raw = await rpc.readFile({ kind: 'env', botId, id: 'env.json' });
      if (!raw || !raw.trim()) return {};
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  };

  const writeNodeBotEnv = async (
    rpc: NodeRpc,
    botId: string,
    env: Record<string, string>,
  ): Promise<Record<string, string>> => {
    await rpc.writeFile({ kind: 'env', botId, id: 'env.json' }, JSON.stringify(env, null, 2));
    return env;
  };

  app.get('/api/bots/:botId/env', async (c) => {
    const botId = c.req.param('botId');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    try {
      const env = await readNodeBotEnv(botRpc.rpc, botId);
      return c.json({ keys: Object.keys(env), env });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read bot env' }, 500);
    }
  });

  app.put('/api/bots/:botId/env', async (c) => {
    const botId = c.req.param('botId');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    const body = await c.req.json<{ env?: Record<string, unknown>; merge?: boolean }>().catch(() => null);
    if (!body || !isObject(body.env)) {
      return c.json({ error: 'env must be a key-value object' }, 400);
    }
    const sanitized: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.env)) {
      if (!isValidBotEnvKey(k)) {
        return c.json({ error: `Invalid or reserved environment variable name: "${k}"` }, 400);
      }
      if (typeof v !== 'string') {
        return c.json({ error: `Environment variable "${k}" must be a string` }, 400);
      }
      sanitized[k] = v;
    }
    try {
      const base = body.merge ? await readNodeBotEnv(botRpc.rpc, botId) : {};
      const nextEnv = { ...base, ...sanitized };
      const saved = await writeNodeBotEnv(botRpc.rpc, botId, nextEnv);
      return c.json({ ok: true, keys: Object.keys(saved), env: saved });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to write bot env' }, 500);
    }
  });

  app.delete('/api/bots/:botId/env/:key', async (c) => {
    const botId = c.req.param('botId');
    const key = c.req.param('key');
    const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
    if (!botRpc.ok) return botRpc.response;

    try {
      const current = await readNodeBotEnv(botRpc.rpc, botId);
      delete current[key];
      const saved = await writeNodeBotEnv(botRpc.rpc, botId, current);
      return c.json({ ok: true, keys: Object.keys(saved), env: saved });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to delete bot env key' }, 500);
    }
  });

  // 8. Session management
  app.get('/api/messages/search', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) {
      return c.json({ error: 'Missing search query parameter "q"' }, 400);
    }
    const sessionId = c.req.query('sessionId')?.trim() || undefined;
    if (sessionId) {
      const sRes = resolveOwnedSession(c, db, sessionId);
      if (!sRes.ok) return sRes.response;
    }
    const rawLimit = Number(c.req.query('limit') || '30');
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 30;
    const hits = db.searchMessages(c.get('user').id, q, { sessionId, limit });
    return c.json(hits);
  });

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

    const validation = validateSessionMembers(db, user.id, body.mode, body.leadBotId, body.memberBotIds);
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status);
    }
    const { leadBotId, memberBotIds } = validation;

    const sessionId = `sess_${randomUUID()}`;
    const session = db.createSession({
      id: sessionId,
      title: body.title.trim(),
      mode: body.mode,
      leadBotId,
      memberBotIds,
      ownerId: user.id,
      parallelRoundtable: Boolean(body.parallelRoundtable),
    });

    return c.json(session);
  });

  app.patch('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

    const body = await c.req.json<{
      title?: string;
      mode?: SessionMode;
      leadBotId?: string;
      memberBotIds?: string[];
      archived?: boolean;
      pinned?: boolean;
      parallelRoundtable?: boolean;
    }>().catch(() => null);
    if (!isObject(body)) return c.json({ error: 'Invalid session configuration' }, 400);
    // 归档是纯 UI 分类标记，允许在运行中修改（如「开启新话题」时旧会话仍在后台执行）；
    // 标题/模式/负责人/成员/圆桌并发会改变调度行为，运行中仍需拒绝。
    const touchesConfig =
      body.title !== undefined ||
      body.mode !== undefined ||
      body.leadBotId !== undefined ||
      body.memberBotIds !== undefined ||
      body.parallelRoundtable !== undefined;
    if (session.status === 'running' && touchesConfig) {
      return c.json({ error: 'Stop the session before changing its configuration' }, 409);
    }
    if (body.archived !== undefined && typeof body.archived !== 'boolean') return c.json({ error: 'Invalid archived flag' }, 400);
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') return c.json({ error: 'Invalid pinned flag' }, 400);
    if (body.parallelRoundtable !== undefined && typeof body.parallelRoundtable !== 'boolean') return c.json({ error: 'Invalid parallelRoundtable flag' }, 400);
    if (body.title !== undefined && !isText(body.title)) return c.json({ error: 'Invalid session title' }, 400);
    if (body.leadBotId !== undefined && !isSafeId(body.leadBotId)) return c.json({ error: 'Invalid lead BOT' }, 400);
    if (body.memberBotIds !== undefined && (!Array.isArray(body.memberBotIds) || !body.memberBotIds.every(isSafeId))) {
      return c.json({ error: 'Invalid memberBotIds' }, 400);
    }

    if (body.mode !== undefined && !VALID_MODES.has(body.mode)) {
      return c.json({ error: 'Invalid session mode' }, 400);
    }

    const mode = body.mode ?? session.mode;
    const targetLead = body.leadBotId ?? session.leadBotId;
    const targetMembers = body.memberBotIds ?? session.memberBotIds;

    const validation = validateSessionMembers(db, c.get('user').id, mode, targetLead, targetMembers);
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status);
    }
    const { leadBotId, memberBotIds } = validation;

    // 配置成员变更时统一失效旧队列，复用 cancelSession，防止 queued 任务绕过新配置
    if (touchesConfig) {
      await router.cancelSession(id);
    }

    // 成员移除时禁用相应 trigger，避免旧任务造成跨用户调用
    const oldMemberIds = new Set([session.leadBotId, ...session.memberBotIds]);
    const newMemberIds = new Set(memberBotIds);
    const removedBotIds = [...oldMemberIds].filter((botId) => !newMemberIds.has(botId));
    if (removedBotIds.length > 0) {
      const triggers = db.listSessionTriggers(id);
      for (const trg of triggers) {
        if (removedBotIds.includes(trg.botId) && trg.enabled) {
          db.updateTrigger(trg.id, { enabled: false });
        }
      }
    }

    const updated = db.updateSession(id, {
      title: body.title?.trim(),
      mode,
      leadBotId,
      memberBotIds,
      archived: body.archived,
      pinned: body.pinned,
      parallelRoundtable: body.parallelRoundtable,
    });
    return c.json(updated);
  });

  app.get('/api/sessions/:id/messages', (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    // 分页参数：before=<messageId>（向上翻页）、around=<messageId>（定位上下文）、limit；无参数时保持全量返回
    const beforeId = c.req.query('before')?.trim() || undefined;
    const aroundId = c.req.query('around')?.trim() || undefined;
    const limitRaw = c.req.query('limit');
    if (beforeId === undefined && aroundId === undefined && limitRaw === undefined) {
      return c.json(db.getMessages(id));
    }

    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return c.json({ error: 'Invalid limit' }, 400);
      }
      limit = parsed;
    }

    // around 优先于 before；锚点必须存在且属于该会话
    const anchorId = aroundId ?? beforeId;
    let anchor: { rowid: number } | undefined;
    if (anchorId !== undefined) {
      const found = db.getMessageById(anchorId);
      if (!found || found.message.sessionId !== id) {
        return c.json({ error: 'Message not found' }, 404);
      }
      anchor = found;
    }

    const page = db.getMessagesPage(id, {
      ...(anchor && beforeId !== undefined && aroundId === undefined ? { beforeRowid: anchor.rowid } : {}),
      ...(anchor && aroundId !== undefined ? { aroundRowid: anchor.rowid } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json(page);
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

    const body = (await c.req.json<{ content?: string; attachments?: MessageAttachment[] }>().catch(() => ({ content: '' }))) as {
      content?: string;
      attachments?: MessageAttachment[];
    };
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if ((typeof body.content !== 'string' || !body.content.trim()) && attachments.length === 0) {
      return c.json({ error: 'Missing content' }, 400);
    }
    const content = typeof body.content === 'string' ? body.content : '';

    const validBots = new Set([session.leadBotId, ...session.memberBotIds]);
    const cmdResult = parseSlashCommand(content, validBots);
    if (cmdResult.error) {
      return c.json({ error: cmdResult.error }, 400);
    }

    const mentions = cmdResult.targetBotId
      ? [cmdResult.targetBotId]
      : (cmdResult.isCommand ? [] : extractMentions(content, validBots));

    const msgResult = db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId: id,
      role: 'user',
      content,
      mentions,
      attachments,
    });

    sseHub.broadcast(id, {
      type: 'message_created',
      message: msgResult.message,
    });

    router.handleUserMessage(id, msgResult.message.id, content, cmdResult.isCommand ? {
      commandText: cmdResult.commandText!,
      targetBotId: cmdResult.targetBotId,
    } : undefined);

    return c.json(msgResult.message, 202);
  });

  // 编辑用户消息：更新锚点内容，截断其后所有消息，重置游标与节点本地会话，再从锚点重新派发
  app.put('/api/sessions/:id/messages/:messageId', async (c) => {
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

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

    // 验证输入后，使用 Router 统一失效旧队列，复用 cancelSession
    await router.cancelSession(id);

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
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    await router.cancelSession(id);
    return c.json({ ok: true });
  });

  // 会话分叉：以某条消息为锚点克隆出新会话（含锚点及其之前的消息），源会话完全不动。
  // 允许 running 中分叉：只读源会话 + 新建独立会话，不打扰执行中的回合；新会话尚无订阅者，无需 SSE 广播。
  app.post('/api/sessions/:id/fork', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

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
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;
    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before clearing messages' }, 409);
    }

    // 验证后，使用 Router 统一失效旧队列，复用 cancelSession
    await router.cancelSession(id);

    db.clearSessionMessages(id);
    // 同步清空各成员节点的本地会话记忆（best-effort，失败在方法内部吞掉）
    await router.resetMemberSessions(id);
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;
    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before deleting it' }, 409);
    }

    // 验证后，使用 Router 统一失效旧队列，复用 cancelSession
    await router.cancelSession(id);

    // resetMemberSessions 内部要查会话成员，必须在 deleteSession 之前调用
    await router.resetMemberSessions(id);
    artifacts.deleteSession(id);
    return c.json({ ok: true });
  });

  // 9. SSE Streaming
  app.get('/api/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

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

  // 全局 SSE（登录用户）：该用户所有会话事件 + 其节点上下线通知
  app.get('/api/events', (c) => {
    const user = c.get('user');

    return streamSSE(c, async (stream) => {
      // 首个事件：握手确认，便于客户端确认订阅已建立
      await stream.writeSSE({
        data: JSON.stringify({ type: 'hello' }),
      });

      const unsubscribe = sseHub.subscribeUser(user.id, async (event) => {
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
  registerArtifactRoutes(app, artifacts);
  const triggerScheduler = registerTriggerRoutes(app, db, router, getSessionOwnerId);
  registerBgJobRoutes(app, db, connections);
  registerSkillSyncAndAskRoutes(app, db, connections, router, getSessionOwnerId);
  const unsubscribeChannels = registerChannelRoutes(app, db, router, sseHub, getSessionOwnerId);

  // 10. Serve static web files & SPA fallback
  app.use('*', createStaticMiddleware(options?.webDir));

  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    unsubscribeChannels();
    triggerScheduler.stop();
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
    sseHub,
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
