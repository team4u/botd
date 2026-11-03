import type { Hono } from 'hono';
import type { UserRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { NodeConnectionManager } from './ws-hub.js';
import type { GroupRouter } from './group-router.js';
import { isObject, resolveOwnedNodeRpc, resolveOwnedSession } from './http-helpers.js';

export function registerSkillSyncAndAskRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  connections: NodeConnectionManager,
  router: GroupRouter
): void {
  // --- 跨节点技能同步 ---
  app.post('/api/nodes/:nodeId/skills/:skillId/sync', async (c) => {
    const { nodeId, skillId } = c.req.param();
    const user = c.get('user');

    const sourceRes = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!sourceRes.ok) return sourceRes.response;
    const sourceRpc = sourceRes.rpc;

    const body = await c.req.json<{ targetNodeIds?: string[] }>().catch(() => null);
    if (!isObject(body) || !Array.isArray(body.targetNodeIds) || body.targetNodeIds.length === 0
      || !body.targetNodeIds.every((id) => typeof id === 'string' && id.length > 0)) {
      return c.json({ error: 'targetNodeIds must be a non-empty string array' }, 400);
    }

    let content: string;
    try {
      content = await sourceRpc.readFile({ kind: 'skill', id: skillId });
    } catch (err: any) {
      return c.json({ error: err?.message || `Failed to read skill "${skillId}" from source node` }, 502);
    }

    const syncedNodeIds: string[] = [];
    const failedNodeIds: string[] = [];
    for (const targetNodeId of body.targetNodeIds as string[]) {
      try {
        const targetNode = db.getNode(targetNodeId);
        if (!targetNode) throw new Error('Target node not found');
        if (db.getNodeOwner(targetNodeId) !== user.id) throw new Error('Forbidden');
        const targetRpc = connections.getNodeRpc(targetNodeId);
        if (!targetRpc) throw new Error('Target node is offline');
        await targetRpc.writeFile({ kind: 'skill', id: skillId }, content);
        db.addNodeSkill(targetNodeId, skillId);
        syncedNodeIds.push(targetNodeId);
      } catch (err: any) {
        console.warn(`[skill-sync] ${nodeId} -> ${targetNodeId} (${skillId}) failed:`, err?.message || err);
        failedNodeIds.push(targetNodeId);
      }
    }

    return c.json({ ok: true, syncedNodeIds, failedNodeIds });
  });

  // --- botd ask 人机协同交互 ---
  app.get('/api/sessions/:id/asks', (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const asks = router.getPendingAsks(id);
    return c.json(asks);
  });

  app.post('/api/sessions/:id/asks/:askId/respond', async (c) => {
    const id = c.req.param('id');
    const askId = c.req.param('askId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const body = await c.req.json<{ answer?: string }>().catch(() => null);
    if (!isObject(body) || typeof body.answer !== 'string' || !body.answer.trim()) {
      return c.json({ error: 'Missing answer' }, 400);
    }

    const resolved = router.respondToAsk(id, askId, body.answer.trim());
    if (!resolved) {
      return c.json({ error: 'Ask not found' }, 404);
    }
    return c.json({ ok: true, ask: resolved });
  });
}
