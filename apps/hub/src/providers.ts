import type { Hono } from 'hono';
import type { ProviderAuthType, UserRecord } from '@botd/protocol';
import { getBuiltinModelCatalog } from '@botd/models';
import type { HubDatabase } from './db.js';
import type { NodeConnectionManager } from './ws-hub.js';

const validId = (value: string) => /^[a-zA-Z0-9_-]+$/.test(value);
const messageOf = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Node request failed';

export function registerProviderRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  connections: NodeConnectionManager
): void {
  const builtinCatalog = getBuiltinModelCatalog();
  const peer = (nodeId: string) => connections.getNodeRpc(nodeId);

  app.get('/api/models/catalog', async c => {
    const nodeId = c.req.query('nodeId');
    if (nodeId) {
      if (!db.getNode(nodeId)) return c.json({ error: 'Node not found' }, 404);
      if (db.getNodeOwner(nodeId) !== c.get('user').id) return c.json({ error: 'Forbidden' }, 403);
      const rpc = peer(nodeId);
      if (!rpc) return c.json({ error: 'Node is offline' }, 503);
      try {
        return c.json(await rpc.getModelCatalog());
      } catch (error) {
        return c.json({ error: messageOf(error) }, /Login not found/i.test(messageOf(error)) ? 404 : 502);
      }
    }
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
    if (!validId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    const input = await c.req.json<{ method?: ProviderAuthType }>().catch(() => null);
    if (!input || !['api_key', 'oauth'].includes(input.method ?? '')) return c.json({ error: 'Invalid login method' }, 400);
    if (!db.getNode(nodeId)) return c.json({ error: 'Node not found' }, 404);
    if (db.getNodeOwner(nodeId) !== c.get('user').id) return c.json({ error: 'Forbidden' }, 403);
    const rpc = peer(nodeId);
    if (!rpc) return c.json({ error: 'Node is offline' }, 503);
    try {
      return c.json(await rpc.startProviderLogin({ providerId, method: input.method! }));
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });

  app.get('/api/nodes/:nodeId/provider-logins/:loginId', async c => {
    const { nodeId, loginId } = c.req.param();
    if (!validId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    if (!db.getNode(nodeId)) return c.json({ error: 'Node not found' }, 404);
    if (db.getNodeOwner(nodeId) !== c.get('user').id) return c.json({ error: 'Forbidden' }, 403);
    const rpc = peer(nodeId);
    if (!rpc) return c.json({ error: 'Node is offline' }, 503);
    try {
      return c.json(await rpc.getProviderLogin(loginId));
    } catch (error) {
      return c.json({ error: messageOf(error) }, /Login not found/i.test(messageOf(error)) ? 404 : 502);
    }
  });

  app.post('/api/nodes/:nodeId/provider-logins/:loginId/respond', async c => {
    const { nodeId, loginId } = c.req.param();
    if (!validId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    const input = await c.req.json<{ promptId?: string; value?: string }>().catch(() => null);
    if (!input || typeof input.promptId !== 'string' || typeof input.value !== 'string' || input.value.length > 65_536) {
      return c.json({ error: 'Invalid login response' }, 400);
    }
    if (!db.getNode(nodeId)) return c.json({ error: 'Node not found' }, 404);
    if (db.getNodeOwner(nodeId) !== c.get('user').id) return c.json({ error: 'Forbidden' }, 403);
    const rpc = peer(nodeId);
    if (!rpc) return c.json({ error: 'Node is offline' }, 503);
    try {
      return c.json(await rpc.respondProviderLogin({ loginId, promptId: input.promptId, value: input.value }));
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });

  app.delete('/api/nodes/:nodeId/provider-logins/:loginId', async c => {
    const { nodeId, loginId } = c.req.param();
    if (!validId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    if (!db.getNode(nodeId)) return c.json({ error: 'Node not found' }, 404);
    if (db.getNodeOwner(nodeId) !== c.get('user').id) return c.json({ error: 'Forbidden' }, 403);
    const rpc = peer(nodeId);
    if (!rpc) return c.json({ error: 'Node is offline' }, 503);
    try {
      await rpc.cancelProviderLogin(loginId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });

  app.delete('/api/nodes/:nodeId/providers/:providerId/auth', async c => {
    const { nodeId, providerId } = c.req.param();
    if (!validId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    if (!db.getNode(nodeId)) return c.json({ error: 'Node not found' }, 404);
    if (db.getNodeOwner(nodeId) !== c.get('user').id) return c.json({ error: 'Forbidden' }, 403);
    const rpc = peer(nodeId);
    if (!rpc) return c.json({ error: 'Node is offline' }, 503);
    try {
      await rpc.logoutProvider(providerId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: messageOf(error) }, 502);
    }
  });
}
