import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { UserRecord } from '@botd/protocol';
import { HubDatabase } from './db.js';
import { AuthManager } from './auth.js';
import { SseHub } from './sse.js';
import { NodeConnectionManager } from './ws-hub.js';
import { GroupRouter } from './group-router.js';
import { createStaticMiddleware } from './static.js';
import { ArtifactService } from './artifact-service.js';
import { registerProviderRoutes } from './providers.js';
import { registerArtifactRoutes } from './artifacts.js';
import { registerShareRoutes } from './share.js';
import { registerTriggerRoutes } from './triggers.js';
import { registerBgJobRoutes } from './bg-jobs.js';
import { registerSkillSyncAndAskRoutes } from './skill-sync.js';
import { registerDelegationRoutes } from './delegation.js';
import { registerChannelRoutes } from './channels.js';
import { registerCoreMiddleware } from './routes/middleware.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerBotRoutes } from './routes/bots.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerEventRoutes } from './routes/events.js';
import type { HubApp } from './routes/context.js';

export interface HubOptions {
  dbPath?: string;
  adminPassword?: string;
  webDir?: string;
  artifactsDir?: string;
}

export interface StartHubOptions extends HubOptions {
  port?: number;
  host?: string;
}

export interface HubInstance {
  app: HubApp;
  db: HubDatabase;
  connections: NodeConnectionManager;
  router: GroupRouter;
  sseHub: SseHub;
  drain: (timeoutMs?: number) => Promise<{ drained: boolean; remaining: number }>;
  close: () => Promise<void>;
}

export interface StartHubResult extends HubInstance {
  server: Server;
  port: number;
}

export function createHub(options?: HubOptions): HubInstance {
  // DB 与密钥自举
  const db = new HubDatabase({ dbPath: options?.dbPath });
  const savedSecret = db.getSetting<string>('auth_secret');
  const auth = new AuthManager(savedSecret);
  if (!savedSecret) {
    db.setSetting('auth_secret', auth.getSecret());
  }
  const adminPassword = options?.adminPassword || process.env.BOTD_ADMIN_PASSWORD;
  if (adminPassword) {
    db.ensureBootstrapAdmin(auth.hashPassword(adminPassword));
  } else {
    // 未配置管理员密码时生成一次性随机密码：绝不允许可预测的默认凭据自举
    const generated = randomBytes(12).toString('base64url');
    db.ensureBootstrapAdmin(auth.hashPassword(generated));
    console.warn('==============================================================');
    console.warn('[botd] BOTD_ADMIN_PASSWORD is not set.');
    console.warn(`[botd] Bootstrap admin password (one-time): ${generated}`);
    console.warn('[botd] Set BOTD_ADMIN_PASSWORD to override, then restart.');
    console.warn('==============================================================');
  }

  // SSE / WS / GroupRouter 装配
  // SessionRecord 未暴露 ownerId，读取归属；SseHub 借此把会话事件同步派发给 owner 的全局订阅者
  const getSessionOwnerId = (sessionId: string): string | undefined => {
    return db.getSessionOwner(sessionId);
  };
  const sseHub = new SseHub({ getSessionOwnerId });
  const artifacts = new ArtifactService(db, sseHub, { artifactsDir: options?.artifactsDir });
  const connections = new NodeConnectionManager(db, auth, sseHub, artifacts);
  const router = new GroupRouter(db, connections, sseHub);
  connections.setRouter(router);

  // HTTP 装配
  const app: HubApp = new Hono<{ Variables: { user: UserRecord; viaNode?: boolean } }>();
  app.onError((error, c) => {
    // 内部错误不外泄原文：日志留底，对外仅返回通用 500；业务错误（带 status 属性）保留原语义
    if (error && typeof error === 'object' && 'status' in error && typeof (error as any).status === 'number') {
      return c.json({ error: error.message || 'Internal server error' }, (error as any).status);
    }
    console.error('[hub] Unhandled request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  });
  app.notFound(c => c.json({ error: 'Not found' }, 404));

  const ctx = { db, auth, connections, router, sseHub, artifacts };
  registerCoreMiddleware(app, ctx); // health/bodyLimit/auth，注册顺序即执行顺序
  registerAuthRoutes(app, ctx);
  registerNodeRoutes(app, ctx);
  registerBotRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerMessageRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerProviderRoutes(app, db, connections);
  registerArtifactRoutes(app, artifacts);
  registerShareRoutes(app, db, artifacts, getSessionOwnerId);
  const triggerScheduler = registerTriggerRoutes(app, db, router, getSessionOwnerId, { sseHub, artifacts });
  registerBgJobRoutes(app, db, connections);
  registerSkillSyncAndAskRoutes(app, db, connections, router, getSessionOwnerId);
  registerDelegationRoutes(app, db, router, sseHub, getSessionOwnerId);
  const unsubscribeChannels = registerChannelRoutes(app, db, router, sseHub, getSessionOwnerId);

  // 静态 Web 文件 & SPA fallback
  app.use('*', createStaticMiddleware(options?.webDir));

  let isClosed = false;
  const drain = async (timeoutMs?: number): Promise<{ drained: boolean; remaining: number }> => {
    return router.drain(timeoutMs);
  };
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    unsubscribeChannels();
    triggerScheduler.stop();
    router.close();
    connections.close();
    sseHub.close();
    db.close();
  };

  return {
    app,
    db,
    connections,
    router,
    sseHub,
    drain,
    close,
  };
}

export async function startHub(options?: StartHubOptions): Promise<StartHubResult> {
  const hub = createHub(options);
  const host = options?.host ?? process.env.BOTD_HOST ?? '0.0.0.0';
  const requestedPort =
    options?.port !== undefined
      ? options.port
      : Number(process.env.BOTD_PORT || process.env.PORT || 3000);

  let resolveServer!: (server: Server) => void;
  let rejectServer!: (err: Error) => void;
  const serverReady = new Promise<Server>((resolve, reject) => {
    resolveServer = resolve;
    rejectServer = reject;
  });

  const server = serve(
    {
      fetch: hub.app.fetch,
      hostname: host,
      port: requestedPort,
    },
    () => {
      resolveServer(server as unknown as Server);
    }
  ) as unknown as Server;

  server.on('error', (err) => {
    rejectServer(err);
  });

  server.on('upgrade', (req, socket, head) => {
    hub.connections.handleUpgrade(req, socket, head);
  });

  await serverReady;

  const addr = server.address();
  const resolvedPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  const originalClose = hub.close;
  hub.close = async (): Promise<void> => {
    // 1. Close application resources, WebSockets and DB first
    await originalClose();

    // 2. Abort or close all open connections to prevent server.close hanging
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }

    // 3. Close the server with fallback timeout
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return {
    ...hub,
    server,
    port: resolvedPort,
  };
}

// Direct execution entry
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startHub()
    .then((hub) => {
      console.log(`Cloud Hub listening on http://127.0.0.1:${hub.port}`);
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await hub.drain(25_000);
        await hub.close();
        process.exit(0);
      };
      process.once('SIGTERM', () => { void shutdown(); });
      process.once('SIGINT', () => { void shutdown(); });
    })
    .catch((err) => {
      console.error('Failed to start Cloud Hub:', err);
      process.exit(1);
    });
}
