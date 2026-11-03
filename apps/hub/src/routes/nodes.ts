import { isSafeId } from '@botd/protocol';
import { resolveOwnedNode, resolveOwnedNodeRpc } from '../http-helpers.js';
import type { HubApp, HubContext } from './context.js';

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function registerNodeRoutes(app: HubApp, ctx: HubContext): void {
  const { db, connections } = ctx;

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
}
