import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
import { registerShareRoutes } from './share.js';
import { ArtifactService } from './artifact-service.js';
import { registerTriggerRoutes } from './triggers.js';
import { registerBgJobRoutes } from './bg-jobs.js';
import { registerSkillSyncAndAskRoutes } from './skill-sync.js';
import { registerDelegationRoutes } from './delegation.js';
import { registerChannelRoutes } from './channels.js';
import { MAX_ARTIFACT_BYTES } from './artifact-service.js';
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
  app: Hono<{ Variables: { user: UserRecord; viaNode?: boolean } }>;
  db: HubDatabase;
  connections: NodeConnectionManager;
  router: GroupRouter;
  sseHub: SseHub;
  drain: (timeoutMs?: number) => Promise<{ drained: boolean; remaining: number }>;
  close: () => Promise<void>;
}

export interface StartHubResult extends HubInstance {
  server: Server;
  port: number;
}

const VALID_MODES = new Set<SessionMode>(['direct']);
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
  _memberBotIdsInput?: unknown
): MemberValidationResult {
  if (mode !== 'direct') {
    return { ok: false, error: 'Invalid session mode', status: 400 };
  }
  if (!isSafeId(leadBotIdInput)) {
    return { ok: false, error: 'Invalid lead BOT', status: 400 };
  }
  const leadBot = db.getBot(leadBotIdInput);
  if (!leadBot) {
    return { ok: false, error: `Lead bot ${leadBotIdInput} not found`, status: 400 };
  }
  if (!db.canUserUseBot(leadBotIdInput, userId)) {
    return { ok: false, error: 'Forbidden', status: 403 };
  }

  return { ok: true, leadBotId: leadBotIdInput, memberBotIds: [leadBotIdInput] };
}

export function createHub(options?: HubOptions): HubInstance {
  const db = new HubDatabase({ dbPath: options?.dbPath });
  const savedSecret = db.getSetting<string>('auth_secret');
  const auth = new AuthManager(savedSecret);
  if (!savedSecret) {
    db.setSetting('auth_secret', auth.getSecret());
  }
  const adminPassword = options?.adminPassword || process.env.BOTD_ADMIN_PASSWORD;
  if (adminPassword) {
    db.ensureBootstrapAdmin(auth.hashPassword(adminPassword));
  } else {
    // 未配置管理员密码时生成一次性随机密码：绝不允许可预测的默认凭据自举
    const generated = randomBytes(12).toString('base64url');
    db.ensureBootstrapAdmin(auth.hashPassword(generated));
    console.warn('==============================================================');
    console.warn('[botd] BOTD_ADMIN_PASSWORD is not set.');
    console.warn(`[botd] Bootstrap admin password (one-time): ${generated}`);
    console.warn('[botd] Set BOTD_ADMIN_PASSWORD to override, then restart.');
    console.warn('==============================================================');
  }
  // SessionRecord 未暴露 ownerId，读取归属；SseHub 借此把会话事件同步派发给 owner 的全局订阅者
  const getSessionOwnerId = (sessionId: string): string | undefined => {
    return db.getSessionOwner(sessionId);
  };
  const sseHub = new SseHub({ getSessionOwnerId });
  const artifacts = new ArtifactService(db, sseHub, { artifactsDir: options?.artifactsDir });
  const connections = new NodeConnectionManager(db, auth, sseHub, artifacts);
  const router = new GroupRouter(db, connections, sseHub);
  connections.setRouter(router);

  const app = new Hono<{ Variables: { user: UserRecord; viaNode?: boolean } }>();
  app.onError((error, c) => {
    // 内部错误不外泄原文：日志留底，对外仅返回通用 500；业务错误（带 status 属性）保留原语义
    if (error && typeof error === 'object' && 'status' in error && typeof (error as any).status === 'number') {
      return c.json({ error: error.message || 'Internal server error' }, (error as any).status);
    }
    console.error('[hub] Unhandled request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  });
  app.notFound(c => c.json({ error: 'Not found' }, 404));

  // 1. Health check (public)
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      draining: router.isDraining(),
      activeTurns: router.getActiveTurnCount(),
    })
  );

  // 1b. Global request body limits (anti-OOM on unauthenticated endpoints)
  // 常规 JSON 路由 1MB；webhook 回调 64KB；artifact 上传按 MAX_ARTIFACT_BYTES 放宽：
  // 二进制流路径直传原始字节（16MB），base64 JSON 路径有 ~1.34 倍膨胀，留足余量。
  const ARTIFACT_BODY_LIMIT = Math.ceil(MAX_ARTIFACT_BYTES * 1.4) + 64 * 1024;
  const bodyLimited = (maxSize: number) =>
    bodyLimit({
      maxSize,
      onError: (c) => c.json({ error: 'Payload Too Large' }, 413),
    });
  app.use('/api/sessions/:id/artifacts', bodyLimited(ARTIFACT_BODY_LIMIT));
  app.use('/api/webhooks/*', bodyLimited(64 * 1024));
  app.use('/api/*', bodyLimited(1024 * 1024));

  // 2. Cookie authentication middleware for /api/*
  app.use('/api/*', async (c, next) => {
    const reqPath = c.req.path;
    const method = c.req.method;

    if (
      reqPath === '/api/health' ||
      (reqPath === '/api/auth/login' && method === 'POST') ||
      (reqPath === '/api/nodes/pairing/exchange' && method === 'POST') ||
      (reqPath.startsWith('/api/webhooks/') && method === 'POST') ||
      (reqPath.startsWith('/api/public/') && (method === 'GET' || method === 'POST'))
    ) {
      return next();
    }

    const cookie = c.req.header('cookie');
    const verified = auth.verifyCookie(cookie, (userId) => db.getUserTokenEpoch(userId) ?? 0);
    let user = verified ? db.getUser(verified.userId) : undefined;
    let viaNode = false;
    if (!user) {
      const headerNodeId = c.req.header('x-botd-node-id');
      const headerNodeToken = c.req.header('x-botd-node-token');
      if (headerNodeId && headerNodeToken) {
        const nodeWithSecret = db.getNodeWithSecret(headerNodeId);
        if (nodeWithSecret && auth.verifyNodeToken(headerNodeToken, nodeWithSecret.tokenHash)) {
          const ownerId = db.getNodeOwner(headerNodeId);
          if (ownerId) {
            user = db.getUser(ownerId);
            viaNode = true;
          }
        }
      }
    }
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // 节点令牌仅限节点运行所需 API：用户管理/改密/配对码创建等管理面一律拒绝
    if (viaNode) {
      const isAdminScoped =
        reqPath.startsWith('/api/users') ||
        (reqPath.startsWith('/api/nodes/pairing') && method === 'POST');
      if (isAdminScoped) {
        return c.json({ error: 'Forbidden: node tokens cannot access user management endpoints' }, 403);
      }
    }

    c.set('user', user);
    c.set('viaNode', viaNode);

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

  const nodeResourceConfigs = [
    {
      kind: 'skill' as const,
      subpath: 'skills',
      paramName: 'skillId',
      onAdd: (nodeId: string, id: string) => db.addNodeSkill(nodeId, id),
      onRemove: (nodeId: string, id: string) => db.removeNodeSkill(nodeId, id),
    },
    {
      kind: 'extension' as const,
      subpath: 'extensions',
      paramName: 'extId',
      onAdd: (nodeId: string, id: string) => db.addNodeExtension(nodeId, id),
      onRemove: (nodeId: string, id: string) => db.removeNodeExtension(nodeId, id),
    },
  ];

  for (const { kind, subpath, paramName, onAdd, onRemove } of nodeResourceConfigs) {
    app.get(`/api/nodes/:nodeId/${subpath}/:${paramName}`, async (c) => {
      const nodeId = c.req.param('nodeId');
      const id = c.req.param(paramName);
      if (!isSafeId(id)) {
        return c.json({ error: `Invalid ${kind} id format` }, 400);
      }
      const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
      if (!nodeRpc.ok) return nodeRpc.response;
      try {
        const content = await nodeRpc.rpc.readFile({ kind, id });
        return c.json({ content });
      } catch (err: any) {
        return c.json({ error: err?.message || `Failed to read ${kind}` }, 500);
      }
    });

    app.put(`/api/nodes/:nodeId/${subpath}/:${paramName}`, async (c) => {
      const nodeId = c.req.param('nodeId');
      const id = c.req.param(paramName);
      if (!isSafeId(id)) {
        return c.json({ error: `Invalid ${kind} id format` }, 400);
      }
      const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
      if (!nodeRpc.ok) return nodeRpc.response;
      const body = await c.req.json<{ content?: string }>().catch(() => null);
      if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
      try {
        await nodeRpc.rpc.writeFile({ kind, id }, body.content);
        onAdd(nodeId, id);
        return c.json({ ok: true });
      } catch (err: any) {
        return c.json({ error: err?.message || `Failed to write ${kind}` }, 500);
      }
    });

    app.delete(`/api/nodes/:nodeId/${subpath}/:${paramName}`, async (c) => {
      const nodeId = c.req.param('nodeId');
      const id = c.req.param(paramName);
      if (!isSafeId(id)) {
        return c.json({ error: `Invalid ${kind} id format` }, 400);
      }
      const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
      if (!nodeRpc.ok) return nodeRpc.response;
      try {
        await nodeRpc.rpc.deleteResource({ kind, id });
        onRemove(nodeId, id);
        return c.json({ ok: true });
      } catch (err: any) {
        return c.json({ error: err?.message || `Failed to delete ${kind}` }, 500);
      }
    });
  }

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

  app.get('/api/nodes/:nodeId/upgrade/check', async (c) => {
    const { nodeId } = c.req.param();
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;

    if (typeof nodeRpc.rpc.checkUpgrade !== 'function') {
      return c.json({ error: 'Node does not support upgrade checks' }, 501);
    }

    try {
      const registryUrl = c.req.query('registryUrl') || undefined;
      const result = await nodeRpc.rpc.checkUpgrade({ registryUrl });
      return c.json(result);
    } catch (err: any) {
      const message = err && typeof err === 'object' && 'message' in err && err.message
        ? String(err.message)
        : 'Failed to check upgrade';
      if (message.includes('not found')) {
        return c.json({ error: 'Node does not support upgrade checks' }, 501);
      }
      return c.json({ error: message }, 502);
    }
  });

  app.post('/api/nodes/:nodeId/upgrade', async (c) => {
    const { nodeId } = c.req.param();
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;

    if (typeof nodeRpc.rpc.upgradeDaemon !== 'function') {
      return c.json({ error: 'Node does not support upgrades' }, 501);
    }

    const body = await c.req.json<{ targetVersion?: string; registryUrl?: string }>().catch(() => null);

    try {
      const result = await nodeRpc.rpc.upgradeDaemon({
        targetVersion: body?.targetVersion,
        registryUrl: body?.registryUrl,
      });
      return c.json(result);
    } catch (err: any) {
      const message = err && typeof err === 'object' && 'message' in err && err.message
        ? String(err.message)
        : 'Failed to upgrade daemon';
      if (message.includes('not found')) {
        return c.json({ error: 'Node does not support upgrades' }, 501);
      }
      return c.json({ error: message }, 502);
    }
  });

  // 7. Bot management (Node is authoritative)
  app.get('/api/bots', (c) => {
    return c.json(db.getAccessibleBots(c.get('user').id));
  });

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

    if (body.parentBotId && body.parentBotId === body.id) {
      return c.json({ error: 'Bot cannot be its own parent' }, 400);
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
      visibility: body.visibility === 'team' ? 'team' : 'private',
      ...(body.parentBotId ? { parentBotId: body.parentBotId } : {}),
      ...(body.inheritModel !== undefined ? { inheritModel: Boolean(body.inheritModel) } : {}),
      ...(body.inheritSkills !== undefined ? { inheritSkills: Boolean(body.inheritSkills) } : {}),
      ...(body.color ? { color: body.color } : {}),
      ...(body.toolScope ? { toolScope: body.toolScope } : {}),
      ...(Array.isArray(body.customTools) ? { customTools: body.customTools } : {}),
      ...(body.isolation ? { isolation: body.isolation } : {}),
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

    const rawNextParent = body.parentBotId !== undefined ? body.parentBotId : existing.parentBotId;
    const nextParentBotId = rawNextParent ? rawNextParent : undefined;
    if (nextParentBotId === botId) {
      return c.json({ error: 'Bot cannot be its own parent' }, 400);
    }

    const { systemMd: requestedSystem, ...botPatch } = body;
    const botConfig: BotConfig = {
      ...existing,
      ...botPatch,
      enabledExtensions: Array.isArray(body.enabledExtensions) ? body.enabledExtensions : (existing.enabledExtensions ?? []),
      visibility: body.visibility === 'team' ? 'team' : (body.visibility === 'private' ? 'private' : (existing.visibility ?? 'private')),
      id: botId,
      nodeId: existing.nodeId,
      updatedAt: new Date().toISOString(),
    };
    if (nextParentBotId) {
      botConfig.parentBotId = nextParentBotId;
    } else {
      delete botConfig.parentBotId;
    }

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

  const botMarkdownRoutes: Array<{
    subpath: 'system' | 'memory';
    kind: 'system' | 'memory';
    filename: 'SYSTEM.md' | 'MEMORY.md';
    label: string;
  }> = [
    { subpath: 'system', kind: 'system', filename: 'SYSTEM.md', label: 'system prompt' },
    { subpath: 'memory', kind: 'memory', filename: 'MEMORY.md', label: 'memory' },
  ];

  for (const { subpath, kind, filename, label } of botMarkdownRoutes) {
    app.get(`/api/bots/:botId/${subpath}`, async (c) => {
      const botId = c.req.param('botId');
      const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
      if (!botRpc.ok) return botRpc.response;

      try {
        const content = await botRpc.rpc.readFile({ kind, botId, id: filename });
        return c.json({ content });
      } catch (err: any) {
        return c.json({ error: err?.message || `Failed to read ${label}` }, 500);
      }
    });

    app.put(`/api/bots/:botId/${subpath}`, async (c) => {
      const botId = c.req.param('botId');
      const botRpc = resolveOwnedBotRpc(c, db, connections, botId);
      if (!botRpc.ok) return botRpc.response;

      const body = await c.req.json<{ content?: string }>().catch(() => null);
      if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
      try {
        await botRpc.rpc.writeFile({ kind, botId, id: filename }, body.content);
        return c.json({ ok: true });
      } catch (err: any) {
        return c.json({ error: err?.message || `Failed to write ${label}` }, 500);
      }
    });
  }

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

  app.get('/api/approvals/pending', (c) => {
    return c.json(db.listPendingAsksForUser(c.get('user').id));
  });

  app.get('/api/sessions', (c) => {
    const sessions = db.getAccessibleSessions(c.get('user').id);
    return c.json(
      sessions.map((s) => {
        if (s.status === 'running') {
          const activeBotIds = router.getActiveBotIds(s.id);
          return {
            ...s,
            ...(activeBotIds.length > 0 ? { activeBotIds } : {}),
          };
        }
        return s;
      })
    );
  });

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
      parentSessionId: body.parentSessionId,
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
    }>().catch(() => null);
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
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') return c.json({ error: 'Invalid pinned flag' }, 400);
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

    if (router.isDraining()) {
      return c.json({ error: 'Hub is draining for upgrade, please retry shortly' }, 503);
    }

    const body = (await c.req.json<{ content?: string; attachments?: MessageAttachment[] }>().catch(() => ({ content: '' }))) as {
      content?: string;
      attachments?: MessageAttachment[];
    };
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if ((typeof body.content !== 'string' || !body.content.trim()) && attachments.length === 0) {
      return c.json({ error: 'Missing content' }, 400);
    }
    const content = typeof body.content === 'string' ? body.content : '';

    const validBots = router.getValidBotIds(session);
    const cmdResult = parseSlashCommand(content, validBots);
    if (cmdResult.error) {
      return c.json({ error: cmdResult.error }, 400);
    }

    const user = c.get('user');
    const participants = db.listSessionParticipants(id);
    const isMultiUser = participants.length > 0 || (session.ownerId !== undefined && user.id !== session.ownerId);

    const routerContent = isMultiUser && !content.startsWith(`[User: ${user.username}]`)
      ? `[User: ${user.username}]: ${content}`
      : content;

    const mentions = cmdResult.targetBotId
      ? [cmdResult.targetBotId]
      : (cmdResult.isCommand ? [] : extractMentions(content, validBots));

    const msgResult = db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId: id,
      role: 'user',
      senderUserId: user.id,
      senderUsername: user.username,
      content,
      mentions,
      attachments,
    });

    sseHub.broadcast(id, {
      type: 'message_created',
      message: msgResult.message,
    });

    // TODO(后续在 formatIncrementalMessages 中消费 senderUsername)
    router.handleUserMessage(id, msgResult.message.id, routerContent, cmdResult.isCommand ? {
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
    const validBots = router.getValidBotIds(session);
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

  // 单独停掉某个运行中的分身（按 runId），不中断主回合与其他并发分身
  app.post('/api/sessions/:id/subagents/:runId/stop', async (c) => {
    const id = c.req.param('id');
    const runId = c.req.param('runId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    try {
      const result = await router.stopSubagent(id, runId);
      if (!result.ok) {
        return c.json({ error: result.error || 'Failed to stop subagent' }, 400);
      }
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to stop subagent' }, 500);
    }
  });

  // 向某个分身发送 steer（运行中插话）或 resume（结束后追问，同一 runId 上下文继续）
  app.post('/api/sessions/:id/subagents/:runId/interact', async (c) => {
    const id = c.req.param('id');
    const runId = c.req.param('runId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const body = await c.req
      .json<{ message?: string; mode?: 'steer' | 'resume'; subagentId?: string }>()
      .catch(() => null);
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }
    const mode = body.mode === 'resume' ? 'resume' : 'steer';

    try {
      const result = await router.interactSubagent(id, runId, body.message, mode, body.subagentId);
      if (!result.ok) {
        return c.json({ error: result.error || 'Failed to interact with subagent', ...(result.run ? { run: result.run } : {}) }, 400);
      }
      return c.json({ ok: true, run: result.run });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to interact with subagent' }, 500);
    }
  });

  app.post('/api/sessions/:id/queue/skip', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const body = await c.req.json<{ stageId?: string; botId?: string }>().catch(() => ({}));
    const queuePlan = router.skipQueueStage(id, body);
    return c.json({ ok: true, queuePlan });
  });

  app.post('/api/sessions/:id/queue/append', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const body = await c.req.json<{ orchestration: string }>().catch(() => null);
    if (!body || typeof body.orchestration !== 'string' || !body.orchestration.trim()) {
      return c.json({ error: 'orchestration expression is required' }, 400);
    }
    const queuePlan = router.appendQueueStage(id, body.orchestration);
    return c.json({ ok: true, queuePlan });
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
    if (db.getSessionOwner(id) !== c.get('user').id) {
      return c.json({ error: 'Only owner can delete session' }, 403);
    }
    if (session.status === 'running') {
      return c.json({ error: 'Stop the session before deleting it' }, 409);
    }

    // 验证后，使用 Router 统一失效旧队列，复用 cancelSession
    await router.cancelSession(id);

    // resetMemberSessions 内部要查会话成员，必须在 deleteSession 之前调用
    await router.resetMemberSessions(id);
    artifacts.deleteSession(id);
    // 广播 idle 让子会话委派的 SSE 监听闭包自行清理，避免永久挂在 SseHub.listeners
    sseHub.broadcast(id, {
      type: 'session_status',
      sessionId: id,
      status: 'idle',
      activeBotId: undefined,
      activeBotIds: [],
    });
    return c.json({ ok: true });
  });

  // Session Participants API
  app.get('/api/sessions/:id/participants', (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    return c.json(db.listSessionParticipants(id));
  });

  app.post('/api/sessions/:id/participants', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    if (db.getSessionOwner(id) !== c.get('user').id) {
      return c.json({ error: 'Only session owner can add participants' }, 403);
    }
    const body = await c.req.json<{ userId?: string; username?: string; role?: 'owner' | 'member' }>().catch(() => null);
    if (!body || (!body.userId && !body.username)) {
      return c.json({ error: 'userId or username required' }, 400);
    }
    const targetUser = body.username ? db.getUserByUsername(body.username) : db.getUser(body.userId!);
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }
    const role = body.role === 'owner' ? 'owner' : 'member';
    db.addSessionParticipant(id, targetUser.id, role);
    return c.json({
      ok: true,
      participant: {
        sessionId: id,
        userId: targetUser.id,
        username: targetUser.username,
        role,
        joinedAt: new Date().toISOString(),
      },
    });
  });

  app.delete('/api/sessions/:id/participants/:userId', (c) => {
    const id = c.req.param('id');
    const userId = c.req.param('userId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const callerId = c.get('user').id;
    const isOwner = db.getSessionOwner(id) === callerId;
    const isSelf = callerId === userId;
    if (!isOwner && !isSelf) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    db.removeSessionParticipant(id, userId);
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
  registerShareRoutes(app, db, artifacts, getSessionOwnerId);
  const triggerScheduler = registerTriggerRoutes(app, db, router, getSessionOwnerId, { sseHub, artifacts });
  registerBgJobRoutes(app, db, connections);
  registerSkillSyncAndAskRoutes(app, db, connections, router, getSessionOwnerId);
  registerDelegationRoutes(app, db, router, sseHub, getSessionOwnerId);
  const unsubscribeChannels = registerChannelRoutes(app, db, router, sseHub, getSessionOwnerId);

  // 10. Serve static web files & SPA fallback
  app.use('*', createStaticMiddleware(options?.webDir));

  let isClosed = false;
  const drain = async (timeoutMs?: number): Promise<{ drained: boolean; remaining: number }> => {
    return router.drain(timeoutMs);
  };
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
    drain,
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
    .then((hub) => {
      console.log(`Cloud Hub listening on http://127.0.0.1:${hub.port}`);
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await hub.drain(25_000);
        await hub.close();
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
