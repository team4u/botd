import { isSafeId } from '@botd/protocol';
import { resolveOwnedNode, resolveOwnedNodeRpc } from '../http-helpers.js';
import type { HubApp, HubContext } from './context.js';

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const isFilesMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.entries(value).every(([key, content]) => isText(key) && typeof content === 'string');

/** PUT body 校验与分流：files 映射优先，其次 content+path；都无效返回 400 语义错误。 */
function parseResourceBody(body: unknown): { files?: Record<string, string>; content?: string; path?: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { files, content, path: relPath } = body as { files?: unknown; content?: unknown; path?: unknown };
  if (isFilesMap(files)) return { files };
  if (typeof content === 'string') {
    if (relPath !== undefined && typeof relPath !== 'string') return undefined;
    return { content, ...(typeof relPath === 'string' ? { path: relPath } : {}) };
  }
  return undefined;
}

export function registerNodeRoutes(app: HubApp, ctx: HubContext): void {
  const { db, connections } = ctx;

  app.get('/api/nodes', (c) => c.json(db.getAllNodesWithBots(c.get('user').id)));

  app.delete('/api/nodes/:nodeId', async (c) => {
    const { nodeId } = c.req.param();
    const nodeRes = resolveOwnedNode(c, db, nodeId);
    if (!nodeRes.ok) return nodeRes.response;

    const hostedBots = db.getBotsForNode(nodeId);
    if (hostedBots.length > 0) {
      if (c.req.query('force') !== '1') {
        return c.json({ error: `Node still hosts ${hostedBots.length} bot(s); delete them first or force=1` }, 409);
      }
      // 强制移除（节点可能永久丢失）：清除 Hub 记录；节点恰好在线时尽力清理其本地目录
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

  // --- Hub 全局 Skill / Extension 路由（文件系统包目录存储，与节点无关） ---

  app.get('/api/skills', (c) => c.json(db.listSkills()));

  app.get('/api/skills/:skillId', (c) => {
    const skillId = c.req.param('skillId');
    if (!isSafeId(skillId)) return c.json({ error: 'Invalid skill id format' }, 400);
    const relPath = c.req.query('path');
    if (relPath !== undefined && relPath.includes('..')) {
      return c.json({ error: 'Invalid path' }, 400);
    }
    return c.json({
      content: db.getSkillContent(skillId, relPath || 'SKILL.md'),
      files: db.listSkillFiles(skillId),
    });
  });

  app.put('/api/skills/:skillId', async (c) => {
    const skillId = c.req.param('skillId');
    if (!isSafeId(skillId)) return c.json({ error: 'Invalid skill id format' }, 400);
    const body = parseResourceBody(await c.req.json().catch(() => null));
    if (!body) return c.json({ error: 'Content must be a string or files an object' }, 400);
    if (body.files) db.saveSkillFiles(skillId, body.files);
    else db.saveSkillContent(skillId, body.content!, body.path || 'SKILL.md');
    void ctx.refreshDurablePersonas?.();
    return c.json({ ok: true });
  });

  app.delete('/api/skills/:skillId', (c) => {
    const skillId = c.req.param('skillId');
    if (!isSafeId(skillId)) return c.json({ error: 'Invalid skill id format' }, 400);
    db.deleteSkillContent(skillId);
    void ctx.refreshDurablePersonas?.();
    return c.json({ ok: true });
  });

  app.get('/api/extensions', (c) => c.json(db.listExtensions()));

  app.get('/api/extensions/:extId', (c) => {
    const extId = c.req.param('extId');
    if (!isSafeId(extId)) return c.json({ error: 'Invalid extension id format' }, 400);
    const relPath = c.req.query('path');
    if (relPath !== undefined && relPath.includes('..')) {
      return c.json({ error: 'Invalid path' }, 400);
    }
    return c.json({
      content: db.getExtensionContent(extId, relPath || 'index.ts'),
      files: db.listExtensionFiles(extId),
    });
  });

  app.put('/api/extensions/:extId', async (c) => {
    const extId = c.req.param('extId');
    if (!isSafeId(extId)) return c.json({ error: 'Invalid extension id format' }, 400);
    const body = parseResourceBody(await c.req.json().catch(() => null));
    if (!body) return c.json({ error: 'Content must be a string or files an object' }, 400);
    if (body.files) db.saveExtensionFiles(extId, body.files);
    else db.saveExtensionContent(extId, body.content!, body.path || 'index.ts');
    void ctx.refreshDurablePersonas?.();
    return c.json({ ok: true });
  });

  app.delete('/api/extensions/:extId', (c) => {
    const extId = c.req.param('extId');
    if (!isSafeId(extId)) return c.json({ error: 'Invalid extension id format' }, 400);
    db.deleteExtensionContent(extId);
    void ctx.refreshDurablePersonas?.();
    return c.json({ ok: true });
  });

  // --- 节点维度 Skill / Extension 路由：读写 Hub 存储 + 维护节点清单 ---

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
    app.get(`/api/nodes/:nodeId/${subpath}/:${paramName}`, (c) => {
      const nodeId = c.req.param('nodeId');
      const id = c.req.param(paramName);
      if (!isSafeId(id)) {
        return c.json({ error: `Invalid ${kind} id format` }, 400);
      }
      const nodeRes = resolveOwnedNode(c, db, nodeId);
      if (!nodeRes.ok) return nodeRes.response;
      const relPath = c.req.query('path');
      if (relPath !== undefined && relPath.includes('..')) {
        return c.json({ error: 'Invalid path' }, 400);
      }
      if (kind === 'skill') {
        return c.json({
          content: db.getSkillContent(id, relPath || 'SKILL.md'),
          files: db.listSkillFiles(id),
        });
      }
      return c.json({
        content: db.getExtensionContent(id, relPath || 'index.ts'),
        files: db.listExtensionFiles(id),
      });
    });

    app.put(`/api/nodes/:nodeId/${subpath}/:${paramName}`, async (c) => {
      const nodeId = c.req.param('nodeId');
      const id = c.req.param(paramName);
      if (!isSafeId(id)) {
        return c.json({ error: `Invalid ${kind} id format` }, 400);
      }
      const nodeRes = resolveOwnedNode(c, db, nodeId);
      if (!nodeRes.ok) return nodeRes.response;
      const body = parseResourceBody(await c.req.json().catch(() => null));
      if (!body) return c.json({ error: 'Content must be a string or files an object' }, 400);
      if (kind === 'skill') {
        if (body.files) db.saveSkillFiles(id, body.files);
        else db.saveSkillContent(id, body.content!, body.path || 'SKILL.md');
      } else {
        if (body.files) db.saveExtensionFiles(id, body.files);
        else db.saveExtensionContent(id, body.content!, body.path || 'index.ts');
      }
      onAdd(nodeId, id);
      void ctx.refreshDurablePersonas?.();
      return c.json({ ok: true });
    });

    app.delete(`/api/nodes/:nodeId/${subpath}/:${paramName}`, (c) => {
      const nodeId = c.req.param('nodeId');
      const id = c.req.param(paramName);
      if (!isSafeId(id)) {
        return c.json({ error: `Invalid ${kind} id format` }, 400);
      }
      const nodeRes = resolveOwnedNode(c, db, nodeId);
      if (!nodeRes.ok) return nodeRes.response;
      if (kind === 'skill') db.deleteSkillContent(id);
      else db.deleteExtensionContent(id);
      onRemove(nodeId, id);
      void ctx.refreshDurablePersonas?.();
      return c.json({ ok: true });
    });
  }

  // --- 节点独有能力（安装/重启/升级）：仍需节点在线 ---
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
      // 安装内容回读：从节点读回真实文件内容（而非空串占位），Hub 侧才是权威存储。
      const content = await nodeRpc.rpc
        .readFile({ kind: installed.kind, id: installed.id })
        .catch(() => '');
      if (installed.kind === 'skill') {
        db.addNodeSkill(nodeId, installed.id);
        db.saveSkillContent(installed.id, content);
      } else {
        db.addNodeExtension(nodeId, installed.id);
        db.saveExtensionContent(installed.id, content);
      }
      void ctx.refreshDurablePersonas?.();
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
