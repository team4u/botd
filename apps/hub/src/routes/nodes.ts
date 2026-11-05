import { decodePackageFile, isSafeId } from '@botd/protocol';
import { ensureNodeOwned, requireAdmin, resolveOwnedNode, resolveOwnedNodeRpc } from '../http-helpers.js';
import { installResourceLocally } from '../local-installer.js';
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
    const adminErr = requireAdmin(c);
    if (adminErr) return adminErr;
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
    const adminErr = requireAdmin(c);
    if (adminErr) return adminErr;
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
    const adminErr = requireAdmin(c);
    if (adminErr) return adminErr;
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
    const adminErr = requireAdmin(c);
    if (adminErr) return adminErr;
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

  // --- 节点能力：安装（在线节点优先，Hub 本地兜底）/ 重启 / 升级 ---
  app.post('/api/nodes/:nodeId/install', async (c) => {
    const { nodeId } = c.req.param();
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
    const input = {
      source: body.source.trim(),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.customId?.trim() ? { customId: body.customId.trim() } : {}),
    };

    /** 入库 + 刷新分身：Hub 文件系统包目录是权威存储，节点清单同步登记；落盘优先走保真 packageFiles。 */
    const persist = (installed: {
      kind: 'skill' | 'extension';
      id: string;
      files: Record<string, import('../db.js').HubPackageFileInput>;
      packageFiles?: Record<string, { data: Buffer; executable: boolean }>;
    }) => {
      if (installed.kind === 'skill') {
        db.addNodeSkill(nodeId, installed.id);
        db.saveSkillFiles(installed.id, installed.packageFiles ?? installed.files);
      } else {
        db.addNodeExtension(nodeId, installed.id);
        db.saveExtensionFiles(installed.id, installed.packageFiles ?? installed.files);
      }
      void ctx.refreshDurablePersonas?.();
    };

    // 虚拟 local 节点：不要求真实节点，自动建虚拟节点行后直接走 Hub 本地安装。
    if (nodeId === 'local') {
      if (!ensureNodeOwned(db, 'local', c.get('user').id)) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      try {
        const installed = await installResourceLocally(input);
        persist(installed);
        return c.json({ kind: installed.kind, id: installed.id });
      } catch (err: any) {
        return c.json({ error: err?.message || 'Failed to install resource locally' }, 500);
      }
    }

    const nodeRpc = resolveOwnedNodeRpc(c, db, connections, nodeId);
    if (nodeRpc.ok) {
      try {
        const installed = await nodeRpc.rpc.installResource(input);
        // 安装内容回读：优先读回完整资源包（多文件 + 二进制保真）落盘为 Hub 权威
        // 存储；旧节点不支持 readResourcePackage 时退回 Hub 本地解析。
        const bundle = await nodeRpc.rpc.readResourcePackage(installed).catch(() => undefined);
        if (bundle && bundle.files.length > 0) {
          const packageFiles: Record<string, { data: Buffer; executable: boolean }> = {};
          for (const file of bundle.files) {
            const decoded = decodePackageFile(file);
            packageFiles[decoded.path] = { data: decoded.data, executable: decoded.executable };
          }
          persist({ kind: bundle.kind, id: bundle.id, files: {}, packageFiles });
          return c.json({ kind: installed.kind, id: installed.id });
        }
        const local = await installResourceLocally(input).catch(() => undefined);
        if (local) {
          persist(local);
          return c.json({ kind: local.kind, id: local.id });
        }
        return c.json({ error: 'Node installed the resource but the package could not be read back' }, 502);
      } catch (err: any) {
        // 节点安装失败（来源不可达 / 不支持）：Hub 能本地解析的来源降级本地安装。
        const local = await installResourceLocally(input).catch((localErr: any) => {
          throw new Error(`${err?.message || 'Failed to install resource'}; local fallback: ${localErr?.message || 'failed'}`);
        });
        persist(local);
        return c.json({ kind: local.kind, id: local.id });
      }
    }

    // 节点离线：本地路径 / git / npm 来源允许 Hub 本地安装兜底（零节点可用）。
    const nodeRes = resolveOwnedNode(c, db, nodeId);
    if (!nodeRes.ok) return nodeRes.response;
    try {
      const installed = await installResourceLocally(input);
      persist(installed);
      return c.json({ kind: installed.kind, id: installed.id });
    } catch (err: any) {
      return c.json(
        { error: err?.message || 'Node is offline and the source cannot be installed locally' },
        502,
      );
    }
  });

  // 全局安装别名：等价 POST /api/nodes/local/install（零外部节点的 Hub 直装入口）。
  app.post('/api/install', async (c) => {
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
    if (!ensureNodeOwned(db, 'local', c.get('user').id)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    try {
      const installed = await installResourceLocally({
        source: body.source.trim(),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.customId?.trim() ? { customId: body.customId.trim() } : {}),
      });
      if (installed.kind === 'skill') {
        db.addNodeSkill('local', installed.id);
        db.saveSkillFiles(installed.id, installed.packageFiles ?? installed.files);
      } else {
        db.addNodeExtension('local', installed.id);
        db.saveExtensionFiles(installed.id, installed.packageFiles ?? installed.files);
      }
      void ctx.refreshDurablePersonas?.();
      return c.json({ kind: installed.kind, id: installed.id });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to install resource locally' }, 500);
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
