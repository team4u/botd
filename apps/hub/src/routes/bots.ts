import { isBotConfig, isValidBotEnvKey } from '@botd/protocol';
import type { BotConfig, SaveBotInput } from '@botd/protocol';
import { resolveOwnedBot } from '../http-helpers.js';
import type { BotFileKind, HubDatabase } from '../db.js';
import type { HubApp, HubContext } from './context.js';

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 确保 nodeId 存在节点行（虚拟节点按首位声明者归属）；存在但不属于该用户时返回 false */
function ensureNodeOwned(db: HubDatabase, nodeId: string, userId: string): boolean {
  if (db.getNode(nodeId)) {
    return db.getNodeOwner(nodeId) === userId;
  }
  db.createNode({
    id: nodeId,
    name: nodeId === 'local' ? 'Local' : nodeId,
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    tokenHash: 'virtual:' + '0'.repeat(64),
    ownerId: userId,
  });
  return true;
}

export function registerBotRoutes(app: HubApp, ctx: HubContext): void {
  const { db, connections } = ctx;

  const readBotEnv = (botId: string): Record<string, string> => {
    const raw = db.getBotFile(botId, 'env');
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  };

  const writeBotEnv = (botId: string, env: Record<string, string>): Record<string, string> => {
    db.setBotFile(botId, 'env', JSON.stringify(env, null, 2));
    return env;
  };

  // --- Bot CRUD：Hub SQLite 权威存储，节点离线也能创建/编辑/删除 ---

  app.get('/api/bots', (c) => {
    return c.json(db.getAccessibleBots(c.get('user').id));
  });

  app.post('/api/bots', async (c) => {
    const body = await c.req.json<SaveBotInput>().catch(() => null);
    if (!isBotConfig(body) || typeof body.systemMd !== 'string') {
      return c.json({ error: 'Invalid BOT configuration' }, 400);
    }
    if (!ensureNodeOwned(db, body.nodeId, c.get('user').id)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

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
      ...(typeof body.workspaceDir === 'string' && body.workspaceDir.trim() ? { workspaceDir: body.workspaceDir.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };

    db.saveBot(botConfig);
    db.setBotFile(botConfig.id, 'system', body.systemMd || '');
    return c.json(botConfig);
  });

  app.put('/api/bots/:botId', async (c) => {
    const botId = c.req.param('botId');
    const botRes = resolveOwnedBot(c, db, botId);
    if (!botRes.ok) return botRes.response;
    const existing = botRes.bot;

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
    // Space 绑定：传空字符串/null 清除；否则以本次请求为准（未传时保留 existing）
    if (body.workspaceDir !== undefined) {
      const trimmed = typeof body.workspaceDir === 'string' ? body.workspaceDir.trim() : '';
      if (trimmed) botConfig.workspaceDir = trimmed;
      else delete botConfig.workspaceDir;
    }

    db.saveBot(botConfig);
    if (requestedSystem !== undefined) {
      db.setBotFile(botId, 'system', requestedSystem);
    }
    return c.json(botConfig);
  });

  app.delete('/api/bots/:botId', (c) => {
    const botId = c.req.param('botId');
    const botRes = resolveOwnedBot(c, db, botId);
    if (!botRes.ok) return botRes.response;

    db.deleteBot(botId);
    return c.json({ ok: true });
  });

  // --- Bot Markdown 文件（SYSTEM.md / MEMORY.md）：Hub 权威存储 ---

  const botMarkdownRoutes: Array<{
    subpath: 'system' | 'memory';
    kind: 'system' | 'memory';
  }> = [
    { subpath: 'system', kind: 'system' },
    { subpath: 'memory', kind: 'memory' },
  ];

  for (const { subpath, kind } of botMarkdownRoutes) {
    app.get(`/api/bots/:botId/${subpath}`, (c) => {
      const botId = c.req.param('botId');
      const botRes = resolveOwnedBot(c, db, botId);
      if (!botRes.ok) return botRes.response;
      return c.json({ content: db.getBotFile(botId, kind) });
    });

    app.put(`/api/bots/:botId/${subpath}`, async (c) => {
      const botId = c.req.param('botId');
      const botRes = resolveOwnedBot(c, db, botId);
      if (!botRes.ok) return botRes.response;

      const body = await c.req.json<{ content?: string }>().catch(() => null);
      if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
      db.setBotFile(botId, kind, body.content);
      return c.json({ ok: true });
    });
  }

  // 节点维度别名（既有调用方兼容）：与 /api/bots/:botId/files/:kind 同一 Hub 存储
  app.get('/api/nodes/:nodeId/bots/:botId/files/:kind', (c) => {
    const { botId, kind } = c.req.param();
    if (kind !== 'system' && kind !== 'memory') {
      return c.json({ error: 'Invalid file kind' }, 400);
    }
    const botRes = resolveOwnedBot(c, db, botId);
    if (!botRes.ok) return botRes.response;
    return c.json({ content: db.getBotFile(botId, kind as 'system' | 'memory') });
  });

  app.put('/api/nodes/:nodeId/bots/:botId/files/:kind', async (c) => {
    const { botId, kind } = c.req.param();
    if (kind !== 'system' && kind !== 'memory') {
      return c.json({ error: 'Invalid file kind' }, 400);
    }
    const botRes = resolveOwnedBot(c, db, botId);
    if (!botRes.ok) return botRes.response;

    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (!body || typeof body.content !== 'string') return c.json({ error: 'Content must be a string' }, 400);
    db.setBotFile(botId, kind as BotFileKind, body.content);
    return c.json({ ok: true });
  });

  // --- Bot 环境变量：Hub 权威存储 ---

  app.get('/api/bots/:botId/env', (c) => {
    const botId = c.req.param('botId');
    const botRes = resolveOwnedBot(c, db, botId);
    if (!botRes.ok) return botRes.response;

    const env = readBotEnv(botId);
    return c.json({ keys: Object.keys(env), env });
  });

  app.put('/api/bots/:botId/env', async (c) => {
    const botId = c.req.param('botId');
    const botRes = resolveOwnedBot(c, db, botId);
    if (!botRes.ok) return botRes.response;

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
    const base = body.merge ? readBotEnv(botId) : {};
    const saved = writeBotEnv(botId, { ...base, ...sanitized });
    return c.json({ ok: true, keys: Object.keys(saved), env: saved });
  });

  app.delete('/api/bots/:botId/env/:key', (c) => {
    const botId = c.req.param('botId');
    const key = c.req.param('key');
    const botRes = resolveOwnedBot(c, db, botId);
    if (!botRes.ok) return botRes.response;

    const current = readBotEnv(botId);
    delete current[key];
    const saved = writeBotEnv(botId, current);
    return c.json({ ok: true, keys: Object.keys(saved), env: saved });
  });

  // --- Bot 命令列表：节点在线时透传，离线时返回空列表（不再失败） ---
  app.get('/api/bots/:botId/commands', async (c) => {
    const botId = c.req.param('botId');
    const botRes = resolveOwnedBot(c, db, botId);
    if (!botRes.ok) return botRes.response;

    const rpc = connections.getNodeRpc(botRes.bot.nodeId);
    if (!rpc) return c.json([]);
    try {
      return c.json(await rpc.getCommands(botId));
    } catch {
      return c.json([]);
    }
  });
}
