import type { Hono } from 'hono';
import type { PendingAskRecord, UserRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { NodeConnectionManager } from './ws-hub.js';
import type { GroupRouter } from './group-router.js';

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function registerSkillSyncAndAskRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  connections: NodeConnectionManager,
  router: GroupRouter,
  getSessionOwnerId: (sessionId: string) => string | undefined
): void {
  // --- 跨节点技能同步 ---
  app.post('/api/nodes/:nodeId/skills/:skillId/sync', async (c) => {
    const { nodeId, skillId } = c.req.param();
    const user = c.get('user');

    const sourceNode = db.getNode(nodeId);
    if (!sourceNode) {
      return c.json({ error: 'Source node not found' }, 404);
    }
    if (db.getNodeOwner(nodeId) !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const sourceRpc = connections.getNodeRpc(nodeId);
    if (!sourceRpc) {
      return c.json({ error: 'Source node is offline' }, 503);
    }

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
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const asks = (router as unknown as { getPendingAsks?: (sessionId: string) => PendingAskRecord[] }).getPendingAsks?.(id) ?? [];
    return c.json(asks);
  });

  app.post('/api/sessions/:id/asks/:askId/respond', async (c) => {
    const id = c.req.param('id');
    const askId = c.req.param('askId');
    const session = db.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (getSessionOwnerId(id) !== c.get('user').id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{ answer?: string }>().catch(() => null);
    if (!isObject(body) || typeof body.answer !== 'string' || !body.answer.trim()) {
      return c.json({ error: 'Missing answer' }, 400);
    }

    const resolved = (router as unknown as { respondToAsk?: (sessionId: string, askId: string, answer: string) => PendingAskRecord | undefined })
      .respondToAsk?.(id, askId, body.answer.trim());
    if (!resolved) {
      return c.json({ error: 'Ask not found' }, 404);
    }
    return c.json({ ok: true, ask: resolved });
  });
}
