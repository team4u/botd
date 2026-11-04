import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type Models } from '@earendil-works/pi-ai';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { UserRecord } from '@botd/protocol';
import { HubDatabase } from './db.js';
import { AuthManager } from './auth.js';
import { SseHub } from './sse.js';
import { NodeConnectionManager } from './ws-hub.js';
import { GroupRouter } from './group-router.js';
import { createStaticMiddleware } from './static.js';
import { ArtifactService } from './artifact-service.js';
import { HubDurableRuntime, type BotPersonaConfig } from './harness/hub-harness.js';
import { createHubCredentialStore } from './credential-store.js';
import { TargetDoc } from './harness/docs.js';
import { registerProviderRoutes } from './providers.js';
import { registerArtifactRoutes } from './artifacts.js';
import { registerShareRoutes } from './share.js';
import { registerTriggerRoutes } from './triggers.js';
import { registerChannelRoutes } from './channels.js';
import { registerCoreMiddleware } from './routes/middleware.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerBotRoutes } from './routes/bots.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerEventRoutes } from './routes/events.js';
import { registerWorkerRoutes, createDurableSessionMirror, type DurableSessionMirror } from './routes/workers.js';
import type { HubApp, HubContext } from './routes/context.js';

export interface HubOptions {
  dbPath?: string;
  adminPassword?: string;
  webDir?: string;
  artifactsDir?: string;
  /** 直接注入 Super-agent 持久运行时（测试用）；缺省时懒创建。 */
  durableRuntime?: HubDurableRuntime;
  /** 懒创建 Super-agent 持久运行时使用的模型配置（测试注入 faux provider）。 */
  durableModels?: Models;
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
  /** Super-agent 持久运行时；仅当通过 HubOptions 注入时存在。 */
  durableRuntime?: HubDurableRuntime;
  /** 取（或懒创建）Super-agent 持久运行时；同一 Hub 生命周期内复用同一实例。 */
  ensureDurableRuntime: () => Promise<HubDurableRuntime>;
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

  // Super-agent 持久运行时：懒创建（createHub 保持同步，不破坏既有调用方）。
  // 首次使用时打开 HubDurableRuntime（dbPath 存在时用 SQLite，否则 MemoryStorage），
  // 并把 Hub 数据库里的全部 Bot 同步为持久分身。
  let durableRuntime: HubDurableRuntime | undefined = options?.durableRuntime;
  let durableRuntimeOpening: Promise<HubDurableRuntime> | undefined;
  const ensureDurableRuntime = async (): Promise<HubDurableRuntime> => {
    if (durableRuntime !== undefined) {
      // Bot 配置可能已更新（新建/改模型/改工作目录）：每次取用都重新同步分身。
      syncBotPersonas(durableRuntime);
      return durableRuntime;
    }
    if (durableRuntimeOpening === undefined) {
      durableRuntimeOpening = (async () => {
        const runtime = await HubDurableRuntime.open(
          {
            ...(options?.dbPath ? { dbPath: `${options.dbPath}.durable.sqlite` } : {}),
            // 凭据来自 Hub SQLite（provider_credentials）：Hub 侧 LLM 请求直接解析认证
            models: options?.durableModels ?? createModels({ credentials: createHubCredentialStore(db) }),
            // Brain in Hub, Hands on Node：会话的目标节点在线时，工具执行走远端
            // RemoteExecutionEnv；否则退回本地 NodeExecutionEnv。
            env: async ({ conversationId, cwd }) => {
              const nodeId = await remoteNodeIdFor(String(conversationId), cwd);
              if (nodeId !== undefined && connections.getNodeEnvRpc(nodeId) !== undefined) {
                return connections.createRemoteEnv({ nodeId, cwd: cwd ?? process.cwd() });
              }
              return new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });
            },
          },
        );
        runtime.harness.resume();
        syncBotPersonas(runtime);
        durableRuntime = runtime;
        return runtime;
      })();
    }
    return durableRuntimeOpening;
  };
  /**
   * 解析会话应使用的目标节点：优先读 durable 侧 `botd.target` 文档（Router/
   * Worker 会话记录了 nodeId），否则按 Bot 的 workspaceDir 匹配 cwd。
   */
  const remoteNodeIdFor = async (conversationId: string, cwd?: string): Promise<string | undefined> => {
    if (durableRuntime === undefined) return undefined;
    try {
      const numeric = Number(conversationId);
      if (Number.isInteger(numeric)) {
        const target = await durableRuntime.harness.snapshot(
          TargetDoc,
          numeric as import('@earendil-works/pi-durable').ConversationId,
          BACKGROUND_CONTEXT,
        );
        if (target !== undefined && target.nodeId !== '') return target.nodeId;
      }
    } catch {
      // 快照失败退回 Bot 配置匹配
    }
    if (cwd === undefined || cwd === '') return undefined;
    return db.getAllBots().find((bot) => bot.workspaceDir && bot.workspaceDir === cwd)?.nodeId;
  };
  /** Hub 数据库 Bot → 持久分身（模型/工作目录来自 Bot 配置）。 */
  const syncBotPersonas = (runtime: HubDurableRuntime): void => {
    for (const bot of db.getAllBots()) {
      const persona: BotPersonaConfig = {
        botId: bot.id,
        name: bot.name,
        model: { provider: bot.modelProvider, modelId: bot.modelId },
        instructions: `You are "${bot.name}", the lead bot of this hub.${bot.description ? ` ${bot.description}` : ''}`,
        nodeId: bot.nodeId,
        cwd: bot.workspaceDir?.trim() || process.cwd(),
      };
      runtime.registerPersona(persona);
    }
  };

  // Durable Router 会话 → botd 会话消息镜像（SSE 桥）：注入的 runtime 直接建，
  // 懒创建路径在 runtime 打开后建（mirror 持有当时的 runtime 引用）。
  let durableMirror: DurableSessionMirror | undefined = durableRuntime !== undefined
    ? createDurableSessionMirror({ db, sseHub, durableRuntime })
    : undefined;

  registerCoreMiddleware(app, ctx); // health/bodyLimit/auth，注册顺序即执行顺序
  registerAuthRoutes(app, ctx);
  registerNodeRoutes(app, ctx);
  registerBotRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  // 主线切流仅在外部注入 durableRuntime 时生效（显式启用）；懒创建路径仍走 GroupRouter，
  // 避免无模型配置的 Hub 因首次消息误开持久运行时而阻塞。
  const messageCtx: HubContext & { durableMirror?: DurableSessionMirror } = {
    ...ctx,
    ...(durableRuntime ? { durableRuntime, ...(durableMirror ? { durableMirror } : {}) } : {}),
  };
  registerMessageRoutes(app, messageCtx);
  registerEventRoutes(app, ctx);
  registerProviderRoutes(app, db);
  registerArtifactRoutes(app, artifacts);
  registerShareRoutes(app, db, getSessionOwnerId);
  const triggerScheduler = registerTriggerRoutes(app, db, router, getSessionOwnerId, { sseHub, artifacts });
  const unsubscribeChannels = registerChannelRoutes(app, db, router, sseHub);
  registerWorkerRoutes(app, { ...ctx, getDurableRuntime: ensureDurableRuntime, ...(durableRuntime ? { durableRuntime } : {}) });

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
    durableMirror?.close();
    router.close();
    connections.close();
    sseHub.close();
    // 懒创建的运行时随 Hub 一起关闭（含正在打开中的）；外部注入的运行时由注入方负责
    if (options?.durableRuntime === undefined) {
      await durableRuntimeOpening?.then((rt) => rt.close()).catch(() => undefined);
      if (durableRuntime !== undefined) await durableRuntime.close().catch(() => undefined);
      durableRuntime = undefined;
    }
    db.close();
  };

  return {
    app,
    db,
    connections,
    router,
    sseHub,
    ...(durableRuntime ? { durableRuntime } : {}),
    ensureDurableRuntime,
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
