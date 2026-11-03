import { isBotConfig, isValidBotEnvKey } from '@botd/protocol';
import type { BotConfig, SaveBotInput } from '@botd/protocol';
import { resolveOwnedBotRpc, resolveOwnedNodeRpc, type NodeRpc } from '../http-helpers.js';
import type { HubApp, HubContext } from './context.js';

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function registerBotRoutes(app: HubApp, ctx: HubContext): void {
  const { db, connections } = ctx;

  // Bot management (Node is authoritative)
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
}
