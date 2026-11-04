import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type Models } from '@earendil-works/pi-ai';
import { UserRecord } from '@botd/protocol';
import { HubDatabase } from './db.js';
import { AuthManager } from './auth.js';
import { SseHub } from './sse.js';
import { NodeConnectionManager } from './ws-hub.js';
import { GroupRouter } from './group-router.js';
import { createStaticMiddleware } from './static.js';
import { ArtifactService } from './artifact-service.js';
import { HubDurableRuntime, type BotPersonaConfig } from './harness/hub-harness.js';
import { SecretInjectingEnv } from './harness/hub-harness.js';
import { createHubCredentialStore } from './credential-store.js';
import { loadDynamicDurableExtension } from './harness/dynamic-extension-loader.js';
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
import { runWatchdogPass } from './harness/watchdog.js';
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
  /** 生产启动时后台 Watchdog 巡检间隔（默认 30s）；仅 `startHub` 生效。 */
  watchdogIntervalMs?: number;
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

  // Super-agent 持久运行时：懒创建（createHub 保持同步，不破坏既有调用方）。
  // 声明先于 ctx：注入的 runtime 直接上 ctx（sessions cancel 等路由即取即用），
  // 懒创建路径由 ensureDurableRuntime 打开后补写。
  let durableRuntime: HubDurableRuntime | undefined = options?.durableRuntime;

  const ctx: HubContext = {
    db,
    auth,
    connections,
    router,
    sseHub,
    artifacts,
    ...(durableRuntime ? { durableRuntime } : {}),
  };
  let durableRuntimeOpening: Promise<HubDurableRuntime> | undefined;
  const ensureDurableRuntime = async (): Promise<HubDurableRuntime> => {
    if (durableRuntime !== undefined) {
      // Bot 配置可能已更新（新建/改模型/改工作目录）：每次取用都重新同步分身。
      await syncBotPersonas(durableRuntime);
      return durableRuntime;
    }
    if (durableRuntimeOpening === undefined) {
      durableRuntimeOpening = (async () => {
        const runtime = await HubDurableRuntime.open(
          {
            ...(options?.dbPath ? { dbPath: `${options.dbPath}.durable.sqlite` } : {}),
            // 凭据来自 Hub SQLite（provider_credentials）：Hub 侧 LLM 请求直接解析认证
            models: options?.durableModels ?? createModels({ credentials: createHubCredentialStore(db) }),
            // Hub 托管 Skills 与 Memory：分身的 Router/Worker 会话获得 load_skill /
            // update_memory 工具，内容直接读写 Hub 文件系统权威存储（含 Bot
            // workspace 的 .agents/skills / .agent/skills 自动发现）
            skills: {
              getBotEnabledSkills: (botId) => {
                const bot = db.getBot(botId);
                if (!bot) return [];
                const extraDirs = bot.workspaceDir ? [bot.workspaceDir] : [];
                const seen = new Set<string>();
                const skills: Array<{ id: string; content: string }> = [];
                for (const skillId of bot.enabledSkills ?? []) {
                  if (seen.has(skillId)) continue;
                  const content = db.getSkillContent(skillId, 'SKILL.md', extraDirs);
                  if (content !== '') {
                    seen.add(skillId);
                    skills.push({ id: skillId, content });
                  }
                }
                // Bot workspace 内 .agents/skills / .agent/skills 的技能自动可用
                for (const skill of db.listSkills(extraDirs)) {
                  if (seen.has(skill.id) || skill.source !== 'agent-dir') continue;
                  const content = db.getSkillContent(skill.id, 'SKILL.md', extraDirs);
                  if (content !== '') {
                    seen.add(skill.id);
                    skills.push({ id: skill.id, content });
                  }
                }
                return skills;
              },
              getSkillContent: (skillId, relPath, botId) => {
                const bot = botId ? db.getBot(botId) : undefined;
                const extra = bot?.workspaceDir ? [bot.workspaceDir] : [];
                const content = db.getSkillContent(skillId, relPath ?? 'SKILL.md', extra);
                return content === '' ? undefined : content;
              },
              listSkillFiles: (skillId, botId) => {
                const bot = botId ? db.getBot(botId) : undefined;
                const extra = bot?.workspaceDir ? [bot.workspaceDir] : [];
                return db.listSkillFiles(skillId, extra);
              },
              getBotMemory: (botId) => db.getBotFile(botId, 'memory'),
              setBotMemory: (botId, content) => db.setBotFile(botId, 'memory', content),
            },
            // Brain in Hub, Hands on Node：会话的目标节点在线时，工具执行走远端
            // RemoteExecutionEnv；否则退回本地 NodeExecutionEnv（自动合并分身 env）。
            env: async ({ conversationId, cwd }) => {
              const targetInfo = await remoteTargetFor(String(conversationId), cwd);
              if (targetInfo.nodeId !== undefined && connections.getNodeEnvRpc(targetInfo.nodeId) !== undefined) {
                return connections.createRemoteEnv({ nodeId: targetInfo.nodeId, cwd: cwd ?? process.cwd() });
              }
              return new SecretInjectingEnv({
                cwd: cwd ?? process.cwd(),
                ...(targetInfo.shellEnv ? { shellEnv: targetInfo.shellEnv } : {}),
              });
            },
          },
        );
        runtime.harness.resume();
        await syncBotPersonas(runtime);
        durableRuntime = runtime;
        // 运行时就绪后补齐镜像与路由上下文：懒创建路径下 messages/sessions
        // 也要看到活跃的 durableRuntime 与 durableMirror。
        durableMirror ??= createDurableSessionMirror({ db, sseHub, durableRuntime: runtime });
        ctx.durableRuntime = runtime;
        messageCtx.durableRuntime = runtime;
        messageCtx.durableMirror = durableMirror;
        return runtime;
      })();
    }
    return durableRuntimeOpening;
  };
  /** 解析 Bot 的自定义环境变量（存储在 Hub SQLite bot_files.env）。 */
  const readBotEnvMap = (botId: string): Record<string, string> | undefined => {
    const raw = db.getBotFile(botId, 'env').trim();
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * 解析会话应使用的目标节点与分身环境变量：优先读 durable 侧 `botd.target` 文档（Router/
   * Worker 会话记录了 botId 与 nodeId），否则按 Bot 的 workspaceDir 匹配 cwd。
   */
  const remoteTargetFor = async (
    conversationId: string,
    cwd?: string,
  ): Promise<{ nodeId?: string; shellEnv?: Record<string, string> }> => {
    if (durableRuntime !== undefined) {
      try {
        const numeric = Number(conversationId);
        if (Number.isInteger(numeric)) {
          const target = await durableRuntime.harness.snapshot(
            TargetDoc,
            numeric as import('@earendil-works/pi-durable').ConversationId,
            BACKGROUND_CONTEXT,
          );
          if (target !== undefined) {
            const shellEnv = target.botId ? readBotEnvMap(target.botId) : undefined;
            if (target.nodeId !== '') return { nodeId: target.nodeId, ...(shellEnv ? { shellEnv } : {}) };
            if (shellEnv) return { shellEnv };
          }
        }
      } catch {
        // 快照失败退回 Bot 配置匹配
      }
    }
    if (cwd === undefined || cwd === '') return {};
    const matched = db.getAllBots().find((bot) => bot.workspaceDir && bot.workspaceDir === cwd);
    if (!matched) return {};
    const shellEnv = readBotEnvMap(matched.id);
    return { nodeId: matched.nodeId, ...(shellEnv ? { shellEnv } : {}) };
  };
  /** Hub 数据库 Bot → 持久分身（SYSTEM/MEMORY、模型、思考档位、Skills、Extensions、环境变量全部来自 Hub 权威存储）。 */
  const syncBotPersonas = async (runtime: HubDurableRuntime): Promise<void> => {
    for (const bot of db.getAllBots()) {
      const parent = bot.parentBotId ? db.getBot(bot.parentBotId) : undefined;
      const effectiveModel =
        bot.inheritModel && parent
          ? { provider: parent.modelProvider, modelId: parent.modelId }
          : { provider: bot.modelProvider, modelId: bot.modelId };
      const effectiveSkills =
        bot.inheritSkills && parent
          ? (parent.enabledSkills ?? bot.enabledSkills ?? [])
          : (bot.enabledSkills ?? []);
      const systemMd = db.getBotFile(bot.id, 'system').trim();
      const memoryMd = db.getBotFile(bot.id, 'memory').trim();
      const botEnv = readBotEnvMap(bot.id);
      const persona: BotPersonaConfig = {
        botId: bot.id,
        name: bot.name,
        model: effectiveModel,
        ...(bot.thinkingLevel ? { thinkingLevel: bot.thinkingLevel } : {}),
        instructions:
          systemMd ||
          `You are "${bot.name}", the lead bot of this hub.${bot.description ? ` ${bot.description}` : ''}`,
        ...(memoryMd ? { memory: memoryMd } : {}),
        enabledSkills: effectiveSkills,
        enabledExtensions: bot.enabledExtensions,
        ...(botEnv ? { env: botEnv } : {}),
        nodeId: bot.nodeId,
        cwd: bot.workspaceDir?.trim() || process.cwd(),
      };
      // 动态挂载 Hub 托管的用户扩展：从 <dataDir>/extensions/<extId>/ 目录包
      // 加载；目录内容变更（HTTP 保存）时重载热替换
      for (const extId of bot.enabledExtensions ?? []) {
        if (!db.hasExtensionDir(extId)) continue;
        try {
          runtime.installDynamicExtension(
            await loadDynamicDurableExtension(extId, db.getExtensionDir(extId)),
          );
        } catch (err) {
          console.warn(`[hub] 加载动态扩展 ${extId} 失败（已跳过）:`, err instanceof Error ? err.message : err);
        }
      }
      runtime.registerPersona(persona);
    }
  };

  // Durable Router 会话 → botd 会话消息镜像（SSE 桥）：注入的 runtime 直接建，
  // 懒创建路径在 runtime 打开后建（见 ensureDurableRuntime）。
  let durableMirror: DurableSessionMirror | undefined = durableRuntime !== undefined
    ? createDurableSessionMirror({ db, sseHub, durableRuntime })
    : undefined;

  registerCoreMiddleware(app, ctx); // health/bodyLimit/auth，注册顺序即执行顺序
  registerAuthRoutes(app, ctx);
  registerNodeRoutes(app, ctx);
  registerBotRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  // 主线切流：注入的 runtime 立即生效；懒创建路径在 ensureDurableRuntime 打开
  // 运行时后写入 messageCtx（见上），首次消息后同样走 Durable 主线。
  const messageCtx: HubContext & {
    durableRuntime?: HubDurableRuntime;
    durableMirror?: DurableSessionMirror;
    getDurableRuntime?: () => Promise<HubDurableRuntime>;
    durableInjected?: boolean;
  } = {
    ...ctx,
    ...(durableRuntime ? { durableRuntime } : {}),
    ...(durableMirror ? { durableMirror } : {}),
    // 提交路径优先走 ensureDurableRuntime：每次提交前重新同步分身（注入路径下
    // 测试后置的种子 Bot 也能被看到），懒打开后此处直接复用同一实例。
    getDurableRuntime: ensureDurableRuntime,
    ...(options?.durableRuntime !== undefined ? { durableInjected: true } : {}),
  };
  registerMessageRoutes(app, messageCtx);
  registerEventRoutes(app, ctx);
  registerProviderRoutes(app, db, {
    onCredentialSaved: () => {
      // 凭据落库后新打开的持久运行时才能用；已打开的重新同步（模型目录/凭据按需重读）。
      void ctx.refreshDurablePersonas?.();
    },
  });
  registerArtifactRoutes(app, artifacts);
  registerShareRoutes(app, db, getSessionOwnerId);
  const triggerScheduler = registerTriggerRoutes(app, db, router, getSessionOwnerId, {
    sseHub,
    artifacts,
    // 主线切流门槛与 messages.ts 一致：仅当 runtime 为显式注入，或 Hub 已配置
    // 任一 Provider 凭据时生效（懒加载路径下 startHub 打开运行时后同样命中）。
    shouldUseDurable: () =>
      options?.durableRuntime !== undefined || db.listProviderCredentials().length > 0,
    getDurableRuntime: ensureDurableRuntime,
    getDurableMirror: () => durableMirror,
  });
  const unsubscribeChannels = registerChannelRoutes(app, db, router, sseHub, {
    sseHub,
    getDurableRuntime: () => durableRuntime,
  });
  registerWorkerRoutes(app, { ...ctx, getDurableRuntime: ensureDurableRuntime, ...(durableRuntime ? { durableRuntime } : {}) });

  // 热同步分身：配置面（Bot/Skill/Extension/凭据）任一变更后，把 Hub SQLite 的
  // 最新权威配置推送到已打开的持久运行时；未打开时静默跳过（下次打开时全量同步）。
  ctx.refreshDurablePersonas = async () => {
    // 热同步与请求生命周期解耦（fire-and-forget）：失败（含 Hub 关闭后的 DB 已关）
    // 只记日志，绝不上抛成未处理拒绝。
    if (durableRuntime === undefined) return;
    try {
      await syncBotPersonas(durableRuntime);
    } catch (err) {
      console.warn('[hub] durable persona refresh failed:', err instanceof Error ? err.message : err);
    }
  };
  // 注入的 runtime 视为显式启用：创建时同步一次分身（异步，不破坏 createHub 同步性）。
  if (options?.durableRuntime !== undefined) {
    void syncBotPersonas(options.durableRuntime).catch((err) => {
      console.warn('[hub] injected durable runtime persona sync warning:', err);
    });
  }

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

  // 生产启动：打开（或复用注入的）持久运行时，并随后台 Watchdog 周期巡检。
  // 打开失败不阻断 Hub 启动（HTTP 面仍可用，Durable 路由返回 503）。
  await hub.ensureDurableRuntime().catch((err) => {
    console.warn('[hub] durable runtime init warning:', err);
  });
  let watchdogTimer: NodeJS.Timeout | undefined;
  if (hub.durableRuntime !== undefined) {
    const runtime = hub.durableRuntime;
    watchdogTimer = setInterval(() => {
      void runWatchdogPass(runtime.harness, undefined, BACKGROUND_CONTEXT).catch((err) => {
        console.warn('[hub] watchdog pass failed:', err instanceof Error ? err.message : err);
      });
    }, options?.watchdogIntervalMs ?? 30_000);
    watchdogTimer.unref();
  }

  const addr = server.address();
  const resolvedPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  const originalClose = hub.close;
  hub.close = async (): Promise<void> => {
    // 0. Stop the background watchdog first
    if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
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
