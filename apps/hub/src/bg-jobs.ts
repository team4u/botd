import type { Hono } from 'hono';
import { isSafeId, type BgJobRecord, type UserRecord, type WorkspaceDiffResult } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { NodeConnectionManager } from './ws-hub.js';
import { resolveOwnedNodeRpc } from './http-helpers.js';

/**
 * 后台任务 HTTP 面：把节点上 BgJobManager 的查询/日志/终止能力透传给前端。
 * 全部要求请求者是节点 owner；节点不在线或节点版本过旧（RPC 未实现对应方法）返回 503。
 */
export function registerBgJobRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  connections: NodeConnectionManager
): void {
  app.get('/api/nodes/:nodeId/bg-jobs', async (c) => {
    const { nodeId } = c.req.param();
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    const { rpc } = nodeRpc;
    if (typeof rpc.listBgJobs !== 'function') {
      return c.json({ error: '节点版本过旧，不支持后台任务查询' }, 503);
    }
    const sessionId = c.req.query('sessionId') || undefined;
    try {
      const jobs = await rpc.listBgJobs(sessionId ? { sessionId } : undefined);
      return c.json(jobs satisfies BgJobRecord[]);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to list background jobs' }, 500);
    }
  });

  app.get('/api/nodes/:nodeId/bg-jobs/:jobId/logs', async (c) => {
    const { nodeId, jobId } = c.req.param();
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    const { rpc } = nodeRpc;
    if (typeof rpc.getBgJobLogs !== 'function') {
      return c.json({ error: '节点版本过旧，不支持后台任务查询' }, 503);
    }
    const linesRaw = c.req.query('lines');
    let lines = 200;
    if (linesRaw !== undefined) {
      const parsed = Number(linesRaw);
      if (Number.isFinite(parsed) && parsed > 0) {
        lines = Math.min(Math.floor(parsed), 5000);
      }
    }
    try {
      const result = await rpc.getBgJobLogs(jobId, lines);
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read background job logs' }, 500);
    }
  });

  app.post('/api/nodes/:nodeId/bg-jobs/:jobId/kill', async (c) => {
    const { nodeId, jobId } = c.req.param();
    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (!nodeRpc.ok) return nodeRpc.response;
    const { rpc } = nodeRpc;
    if (typeof rpc.killBgJob !== 'function') {
      return c.json({ error: '节点版本过旧，不支持后台任务查询' }, 503);
    }
    try {
      const job = await rpc.killBgJob(jobId);
      return c.json({ job });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to kill background job' }, 500);
    }
  });

  // BOT 工作区代码变更（只读）：节点 owner 或可使用该 BOT 的用户（共享团队 BOT）可查
  app.get('/api/nodes/:nodeId/bots/:botId/diff', async (c) => {
    const { nodeId, botId } = c.req.param();
    if (!isSafeId(botId)) {
      return c.json({ error: 'Invalid bot ID' }, 400);
    }

    // 先按 BOT 归属鉴权（共享团队 BOT 也放行），否则回退节点 owner 校验
    const bot = db.getBot(botId);
    let rpc: ReturnType<NodeConnectionManager['getNodeRpc']>;
    if (bot && bot.nodeId === nodeId && db.canUserUseBot(botId, c.get('user').id)) {
      rpc = connections.getNodeRpc(nodeId);
      if (!rpc) return c.json({ error: 'Node is offline' }, 503);
    } else {
      const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
      if (!nodeRpc.ok) return nodeRpc.response;
      rpc = nodeRpc.rpc;
    }

    const sessionId = c.req.query('sessionId') || undefined;
    const result = (await rpc.getWorkspaceDiff?.({ botId, sessionId }).catch(() => undefined)) ?? undefined;
    if (!result) {
      return c.json({ error: '节点版本过旧，不支持代码变更查询' }, 503);
    }
    return c.json(result satisfies WorkspaceDiffResult);
  });
}
