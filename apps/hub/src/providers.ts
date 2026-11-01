import type { Hono } from 'hono';
import { isSafeId, type ProviderAuthType, type UserRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { NodeConnectionManager } from './ws-hub.js';
import { resolveOwnedNodeRpc } from './http-helpers.js';

const messageOf = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Node request failed';

let builtinCatalogPromise: Promise<ReturnType<typeof import('@botd/models').getBuiltinModelCatalog>> | undefined;
function getCachedBuiltinCatalog() {
  return (builtinCatalogPromise ??= import('@botd/models').then(m => m.getBuiltinModelCatalog()));
}

export function registerProviderRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  connections: NodeConnectionManager
): void {
  app.get('/api/models/catalog', async c => {
    const nodeId = c.req.query('nodeId');
    if (nodeId) {
      const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
      if (!nodeRpc.ok) return nodeRpc.response;
      try {
        return c.json(await nodeRpc.rpc.getModelCatalog());
      } catch (error) {
        return c.json({ error: messageOf(error) }, /Login not found/i.test(messageOf(error)) ? 404 : 502);
      }
    }
    const builtinCatalog = await getCachedBuiltinCatalog();
    return c.json({
      ...builtinCatalog,
      providers: builtinCatalog.providers.map(provider => ({
        ...provider,
        configured: false,
      })),
    });
  });

  app.post('/api/nodes/:nodeId/providers/:providerId/login', async c => {
    const { nodeId, providerId } = c.req.param();
    if (!isSafeId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    const input = await c.req.json<{ method?: ProviderAuthType }>().catch(() => null);
    if (!input || !['api_key', 'oauth'].includes(input.method ?? '')) return c.json({ error: 'Invalid login method' }, 400);
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      return c.json(await nodeRpc.rpc.startProviderLogin({ providerId, method: input.method! }));
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });

  app.get('/api/nodes/:nodeId/provider-logins/:loginId', async c => {
    const { nodeId, loginId } = c.req.param();
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      return c.json(await nodeRpc.rpc.getProviderLogin(loginId));
    } catch (error) {
      return c.json({ error: messageOf(error) }, /Login not found/i.test(messageOf(error)) ? 404 : 502);
    }
  });

  app.post('/api/nodes/:nodeId/provider-logins/:loginId/respond', async c => {
    const { nodeId, loginId } = c.req.param();
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    const input = await c.req.json<{ promptId?: string; value?: string }>().catch(() => null);
    if (!input || typeof input.promptId !== 'string' || typeof input.value !== 'string' || input.value.length > 65_536) {
      return c.json({ error: 'Invalid login response' }, 400);
    }
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      return c.json(await nodeRpc.rpc.respondProviderLogin({ loginId, promptId: input.promptId, value: input.value }));
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });

  app.delete('/api/nodes/:nodeId/provider-logins/:loginId', async c => {
    const { nodeId, loginId } = c.req.param();
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      await nodeRpc.rpc.cancelProviderLogin(loginId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });

  app.delete('/api/nodes/:nodeId/providers/:providerId/auth', async c => {
    const { nodeId, providerId } = c.req.param();
    if (!isSafeId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    try {
      await nodeRpc.rpc.logoutProvider(providerId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });
}
