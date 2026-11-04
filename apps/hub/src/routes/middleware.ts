import { bodyLimit } from 'hono/body-limit';
import { MAX_ARTIFACT_BYTES } from '../artifact-service.js';
import type { HubApp, HubContext } from './context.js';

// 常规 JSON 路由 1MB；webhook 回调 64KB；artifact 上传按 MAX_ARTIFACT_BYTES 放宽：
// 二进制流路径直传原始字节（16MB），base64 JSON 路径有 ~1.34 倍膨胀，留足余量。
const ARTIFACT_BODY_LIMIT = Math.ceil(MAX_ARTIFACT_BYTES * 1.4) + 64 * 1024;

/**
 * 核心中间件：health 路由、全局请求体限制、Cookie/节点令牌认证。
 * 注册顺序即执行顺序（health → bodyLimit → auth），勿调整。
 */
export function registerCoreMiddleware(app: HubApp, ctx: HubContext): void {
  const { db, auth, router } = ctx;

  // Health check (public)
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      draining: router.isDraining(),
      activeTurns: router.getActiveTurnCount(),
    })
  );

  // Global request body limits (anti-OOM on unauthenticated endpoints)。
  // 单条 /api/* 动态选择上限：Hono 多条匹配中间件串行执行，若同时注册
  // `/api/sessions/:id/artifacts` 放宽版与 `/api/*` 默认版，后者仍会拦截大产物
  // 上传（413）。故合并为一条，按路径分发：artifacts/messages（含 base64 附件）
  // 走 ARTIFACT_BODY_LIMIT，webhooks 64KB，其余默认 1MB。
  const bodyLimited = (maxSize: number) =>
    bodyLimit({
      maxSize,
      onError: (c) => c.json({ error: 'Payload Too Large' }, 413),
    });
  const artifactBodyLimit = bodyLimited(ARTIFACT_BODY_LIMIT);
  const webhookBodyLimit = bodyLimited(64 * 1024);
  const defaultBodyLimit = bodyLimited(1024 * 1024);
  app.use('/api/*', async (c, next) => {
    const p = c.req.path;
    if (/^\/api\/sessions\/[^/]+\/(artifacts|messages)$/.test(p)) {
      return artifactBodyLimit(c, next);
    }
    if (p.startsWith('/api/webhooks/')) {
      return webhookBodyLimit(c, next);
    }
    return defaultBodyLimit(c, next);
  });

  // Cookie authentication middleware for /api/*
  app.use('/api/*', async (c, next) => {
    const reqPath = c.req.path;
    const method = c.req.method;

    if (
      reqPath === '/api/health' ||
      (reqPath === '/api/auth/login' && method === 'POST') ||
      (reqPath === '/api/nodes/pairing/exchange' && method === 'POST') ||
      (reqPath.startsWith('/api/webhooks/') && method === 'POST') ||
      (reqPath.startsWith('/api/public/') && (method === 'GET' || method === 'POST'))
    ) {
      return next();
    }

    const cookie = c.req.header('cookie');
    const verified = auth.verifyCookie(cookie, (userId) => db.getUserTokenEpoch(userId) ?? 0);
    let user = verified ? db.getUser(verified.userId) : undefined;
    let viaNode = false;
    let headerNodeId: string | undefined;
    if (!user) {
      const headerNodeToken = c.req.header('x-botd-node-token');
      headerNodeId = c.req.header('x-botd-node-id');
      if (headerNodeId && headerNodeToken) {
        const nodeWithSecret = db.getNodeWithSecret(headerNodeId);
        if (nodeWithSecret && auth.verifyNodeToken(headerNodeToken, nodeWithSecret.tokenHash)) {
          const ownerId = db.getNodeOwner(headerNodeId);
          if (ownerId) {
            user = db.getUser(ownerId);
            viaNode = true;
          }
        }
      }
    }
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // 节点令牌仅限节点运行所需 API：用户管理/改密/配对码创建等管理面一律拒绝
    if (viaNode) {
      const isAdminScoped =
        reqPath.startsWith('/api/users') ||
        (reqPath.startsWith('/api/nodes/pairing') && method === 'POST');
      if (isAdminScoped) {
        return c.json({ error: 'Forbidden: node tokens cannot access user management endpoints' }, 403);
      }

      // 执行身份传递：团队共享 Bot 在他人会话中运行时（delegate_bot / 跨 Bot Workflow /
      // 产物读写），节点凭据请求的会话级路由应以「会话所有者」身份生效——前提是该会话
      // （或其父会话链）确实调度过此节点上的 Bot（canNodeActOnSession 校验调度事实）。
      // 否则保持节点归属者身份，resolveOwnedSession 会照常拒绝无关会话的访问。
      if (headerNodeId) {
        const sessionMatch = reqPath.match(/^\/api\/sessions\/([^/]+)/);
        const artifactMatch = reqPath.match(/^\/api\/artifacts\/([^/?]+)/);
        const targetSessionId = sessionMatch
          ? decodeURIComponent(sessionMatch[1])
          : artifactMatch
            ? db.getArtifactWithStoragePath(decodeURIComponent(artifactMatch[1]))?.sessionId
            : undefined;
        if (targetSessionId && db.canNodeActOnSession(headerNodeId, targetSessionId)) {
          const sessionOwnerId = db.getSessionOwner(targetSessionId);
          if (sessionOwnerId) {
            user = db.getUser(sessionOwnerId) ?? user;
          }
        }
      }
    }

    c.set('user', user);
    c.set('viaNode', viaNode);

    return next();
  });
}
