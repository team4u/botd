import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import { createModels, type Models, type MutableModels } from '@earendil-works/pi-ai';
import { UserRecord } from '@botd/protocol';
import { HubDatabase } from './db.js';
import { AuthManager } from './auth.js';
import { SseHub } from './sse.js';
import { NodeConnectionManager } from './ws-hub.js';
import { GroupRouter } from './group-router.js';
import { createStaticMiddleware } from './static.js';
import { ArtifactService } from './artifact-service.js';
import { HubDurableRuntime, SecretInjectingEnv, type BotPersonaConfig } from './harness/hub-harness.js';
import { createHubCredentialStore, registerStoredProviders, listEffectiveProviderCredentials } from './credential-store.js';
import { loadDynamicDurableExtension } from './harness/dynamic-extension-loader.js';
import { TargetDoc, WorkerRegistryDoc } from './harness/docs.js';
import { releaseLocalWorktree } from './harness/router-extension.js';
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
import { registerWorkerRoutes, createDurableSessionMirror, submitSessionMessageToDurable, type DurableSessionMirror } from './routes/workers.js';
import { runWatchdogPass } from './harness/watchdog.js';
import { acquireLocalWorktree } from './harness/worktree.js';
import { seedBuiltinSkillInHub } from './builtin-skill-seed.js';
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
  /** watchdog abort 时的宿主 Worker 停止钩子（清宿主 worktree 缓存并释放）。 */
  stopWorkerHook: (runtime: HubDurableRuntime, conversationId: number, context: Context) => Promise<boolean>;
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
  // 内置技能 botd-cli 种子化：零节点连接时每个分身仍可 load_skill（幂等，版本标记控制重写）
  seedBuiltinSkillInHub(db);
  const savedSecret = db.getSetting<string>('auth_secret');
  const auth = new AuthManager(savedSecret);
  if (!savedSecret) {
    db.setSetting('auth_secret', auth.getSecret());
  }
  const adminPassword = options?.adminPassword || process.env.BOTD_ADMIN_PASSWORD;
  if (adminPassword) {
    db.ensureBootstrapAdmin(auth.hashPassword(adminPassword), true);
  } else if (db.countUsers() === 0) {
    // 仅在初始 users 表为空且未配置管理员密码时生成一次性随机密码
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
  /**
   * 配置面轻量指纹：Bot 行 + bot_files（SYSTEM/MEMORY/env）+ 技能/扩展目录
   * mtime + 生效凭据的摘要。正常发消息时指纹不变，ensureDurableRuntime
   * 直接短路返回；直接写 db 的旁路写入（测试）改变指纹后才真正重新同步。
   */
  let lastPersonaFingerprint = '';
  const computePersonaFingerprint = (): string => {
    const bots = db.getAllBots();
    const botFiles = bots.map((bot) => [bot.id, bot.updatedAt, db.getBotFile(bot.id, 'system'), db.getBotFile(bot.id, 'memory'), db.getBotFile(bot.id, 'env')] as const);
    return JSON.stringify([botFiles, db.listExtensions(), db.listSkills(), listEffectiveProviderCredentials(db)]);
  };
  /** Bot 的生效技能清单：inheritSkills 时继承父 Bot，内置 botd-cli 始终前置（两处消费必须一致，否则系统提示词与分身配置脱节）。 */
  const resolveEffectiveBotSkillIds = (bot: import('@botd/protocol').BotConfig): string[] => {
    const parent = bot.parentBotId ? db.getBot(bot.parentBotId) : undefined;
    const base =
      bot.inheritSkills && parent
        ? (parent.enabledSkills ?? bot.enabledSkills ?? [])
        : (bot.enabledSkills ?? []);
    return Array.from(new Set(['botd-cli', ...base]));
  };
  /** 懒创建持久运行时的默认模型集合：Hub 凭据 + `.agent/` 下存储的动态 provider（如 magpie）。 */
  const createDefaultModels = () => {
    const defaultModels = createModels({ credentials: createHubCredentialStore(db) });
    registerStoredProviders(defaultModels, db.getDataDir());
    return defaultModels;
  };
  const ensureDurableRuntime = async (): Promise<HubDurableRuntime> => {
    if (durableRuntime !== undefined) {
      // 读路径零开销短路：配置面变更经 refreshDurablePersonas（HTTP 写路由必调）
      // 推送；直接写 db 的测试等旁路写入由下面的轻量指纹兑底感知。
      const currentFingerprint = computePersonaFingerprint();
      if (currentFingerprint === lastPersonaFingerprint) return durableRuntime;
      lastPersonaFingerprint = currentFingerprint;
      await syncBotPersonas(durableRuntime);
      return durableRuntime;
    }
    if (durableRuntimeOpening === undefined) {
      durableRuntimeOpening = (async () => {
        const runtime = await HubDurableRuntime.open(
          {
            // 与 HubDatabase 同源：只要主库落在磁盘（options.dbPath / BOTD_DB_PATH /
            // 默认 ~/.botd/hub.sqlite），持久运行时同样落盘到 <主库>.durable.sqlite，
            // 绝不静默退回 MemoryStorage 丢掉全部会话状态。
            ...(db.dbPath && db.dbPath !== ':memory:' ? { dbPath: `${db.dbPath}.durable.sqlite` } : {}),
            // 凭据来自 Hub SQLite（provider_credentials）+ `.agent/auth.json`；
            // magpie 等动态 provider 的缓存模型来自 `.agent/models-store.json`
            models: options?.durableModels ?? createDefaultModels(),
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
                for (const skillId of resolveEffectiveBotSkillIds(bot)) {
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
            // Brain in Hub, Hands on Node：目标节点是远端时一律走 RemoteExecutionEnv
            //（离线等待重连由其 waitForNodeOnline 承担，绝不退回 Hub 本机执行）；
            // 仅本地（无 nodeId 或 'local'）才用 SecretInjectingEnv。
            env: async ({ conversationId, cwd }) => {
              const targetInfo = await remoteTargetFor(String(conversationId), cwd);
              const finalCwd = targetInfo.effectiveCwd ?? cwd ?? process.cwd();
              const isRemoteNodeId = Boolean(targetInfo.nodeId && targetInfo.nodeId !== 'local');
              if (isRemoteNodeId) {
                return connections.createRemoteEnv({
                  nodeId: targetInfo.nodeId!,
                  cwd: finalCwd,
                  ...(targetInfo.shellEnv ? { shellEnv: targetInfo.shellEnv } : {}),
                });
              }
              return new SecretInjectingEnv({
                cwd: finalCwd,
                ...(targetInfo.shellEnv ? { shellEnv: targetInfo.shellEnv } : {}),
              });
            },
            // 统一 worktree 释放：stopWorker / stop_worker 停止隔离 worker 时清理
            // 远端节点与本机的 .botd-worktrees，并同步清会话级挂载缓存。
            releaseWorktree,
          },
        );
        runtime.harness.resume();
        await syncBotPersonas(runtime);
        durableRuntime = runtime;
        // 运行时就绪后补齐镜像与路由上下文：懒创建路径下 messages/sessions
        // 也要看到活跃的 durableRuntime 与 durableMirror。
        durableMirror ??= createDurableSessionMirror({ db, sseHub, durableRuntime: runtime });
        void attachMirrorToExistingSessions(durableMirror);
        ctx.durableRuntime = runtime;
        messageCtx.durableRuntime = runtime;
        messageCtx.durableMirror = durableMirror;
        return runtime;
      })();
    }
    return durableRuntimeOpening;
  };
  /** 会话 → 已挂载 worktree 路径缓存：每个 conversation 只幂等获取一次。 */
  const acquiredWorktrees = new Map<string, string>();
  /**
   * 统一的 worktree 释放：远端节点走 envReleaseWorktree RPC（在线才发，离线
   * 留给节点侧幂等清理），本机走 git worktree remove；两侧都同步清缓存，
   * 同一会话下次获取时重新挂载。stopWorker 与 stop_worker 工具共用此入口。
   */
  const releaseWorktree = async (info: { nodeId: string; cwd: string; worktreePath: string; workerId: string }): Promise<void> => {
    for (const [key, value] of acquiredWorktrees) {
      if (value === info.worktreePath) acquiredWorktrees.delete(key);
    }
    if (info.nodeId && info.nodeId !== 'local') {
      const envRpc = connections.getNodeEnvRpc(info.nodeId);
      if (envRpc?.envReleaseWorktree) {
        await envRpc.envReleaseWorktree({ repoDir: info.cwd, worktreePath: info.worktreePath, deleteBranch: false });
        return;
      }
      // 节点离线：本机无法代劳远端清理，留待节点重连后的幂等清理。
      return;
    }
    await releaseLocalWorktree(info.cwd, info.worktreePath);
  };

  /**
   * 宿主 Worker 停止钩子（watchdog abort 时调用）：经 TargetDoc.parentConversationId
   * 找到父 Router，再从其 WorkerRegistryDoc 反查 workerId 后走 runtime.stopWorker
   * （标记 aborted + abort 会话 + 释放 worktree）；非 worker 会话返回 false，由
   * watchdog 回退普通 conversation.abort。停止成功后同步清宿主缓存，避免已释放
   * 路径被后续唤醒的 worker 复用。
   */
  const stopWorkerHook = async (
    runtime: HubDurableRuntime,
    conversationId: number,
    context: Context,
  ): Promise<boolean> => {
    const target = await runtime.harness.snapshot(
      TargetDoc,
      conversationId as import('@earendil-works/pi-durable').ConversationId,
      context,
    );
    const parentId = target?.parentConversationId;
    if (parentId === undefined || parentId === '') return false;
    const registry = await runtime.harness.snapshot(
      WorkerRegistryDoc,
      Number(parentId) as import('@earendil-works/pi-durable').ConversationId,
      context,
    );
    if (registry === undefined) return false;
    const entry = Object.values(registry.workers).find((w) => Number(w.conversationId) === conversationId);
    if (entry === undefined) return false;
    const stopped = await runtime.stopWorker(parentId, entry.workerId, context);
    if (stopped) acquiredWorktrees.delete(String(conversationId));
    return stopped;
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
   * 解析会话应使用的目标节点、分身环境变量与实际执行 cwd：优先读 durable 侧
   * `botd.target` 文档（Router/Worker 会话记录了 botId 与 nodeId），否则按
   * Bot 的 workspaceDir 匹配 cwd。`BOTD_SESSION_ID` / `BOTD_BOT_ID` 上下文
   * 环境变量随 shellEnv 注入；目标带 worktreePath 时首问幂等挂载隔离工作树
   * （远端节点走 envAcquireWorktree RPC，本地走 acquireLocalWorktree）。
   */
  const remoteTargetFor = async (
    conversationId: string,
    cwd?: string,
  ): Promise<{ nodeId?: string; shellEnv?: Record<string, string>; effectiveCwd?: string }> => {
    const numeric = Number(conversationId);
    // TargetDoc 读取异常直接传播：此时无法知道会话是否要求隔离/远端执行，
    // 任何回退都会绕过边界。仅「读成功但文档不存在」才走 Bot cwd 匹配。
    const target =
      durableRuntime !== undefined && Number.isInteger(numeric)
        ? await durableRuntime.harness.snapshot(
            TargetDoc,
            numeric as import('@earendil-works/pi-durable').ConversationId,
            BACKGROUND_CONTEXT,
          )
        : undefined;
    if (target !== undefined) {
      const shellEnv: Record<string, string> = {
        ...(readBotEnvMap(target.botId) ?? {}),
        ...(target.botId ? { BOTD_BOT_ID: target.botId } : {}),
        ...(target.sessionId ? { BOTD_SESSION_ID: target.sessionId } : {}),
        // 分身所在节点：botd-cli 技能的 `botd bots create --node "$BOTD_NODE_ID"`
        // 依赖此变量；缺失时会落到 'local' 虚拟节点（显示离线且无法对话）。
        ...(target.nodeId ? { BOTD_NODE_ID: target.nodeId } : {}),
      };
      let effectiveCwd = target.cwd || cwd || process.cwd();
      if (target.worktreePath) {
        const cached = acquiredWorktrees.get(conversationId);
        if (cached !== undefined) {
          effectiveCwd = cached;
        } else {
          const workerId = path.basename(target.worktreePath) || `w-${conversationId}`;
          const isRemoteTarget = Boolean(target.nodeId && target.nodeId !== 'local');
          if (isRemoteTarget) {
            // 远端节点：离线时等待重连后由节点侧创建 worktree，绝不在 Hub 本机建。
            // envAcquireWorktree 失败时错误必须传播（fail-closed），不回退本地。
            const envRpc =
              connections.getNodeEnvRpc(target.nodeId!) ??
              (await connections.waitForNodeOnline(target.nodeId!, BACKGROUND_CONTEXT));
            if (envRpc?.envAcquireWorktree === undefined) {
              throw new Error(`节点 ${target.nodeId} 不支持 worktree 隔离`);
            }
            const res = await envRpc.envAcquireWorktree({ repoDir: effectiveCwd, workerId });
            if (res.isGitRepo && (!res.worktreePath || res.worktreePath === effectiveCwd)) {
              throw new Error(`节点 ${target.nodeId} 未返回隔离 worktree 路径`);
            }
            effectiveCwd = res.isGitRepo === false ? effectiveCwd : res.worktreePath;
          } else {
            effectiveCwd = await acquireLocalWorktree(
              effectiveCwd,
              target.worktreePath,
              target.branchName ?? `botd/${workerId}`,
            );
          }
          acquiredWorktrees.set(conversationId, effectiveCwd);
        }
      }
      if (target.nodeId !== '') return { nodeId: target.nodeId, shellEnv, effectiveCwd };
      return { shellEnv, effectiveCwd };
    }
    if (cwd === undefined || cwd === '') return {};
    const matched = db.getAllBots().find((bot) => bot.workspaceDir && bot.workspaceDir === cwd);
    if (!matched) return {};
    const shellEnv = readBotEnvMap(matched.id);
    return { nodeId: matched.nodeId, ...(shellEnv ? { shellEnv } : {}) };
  };
  /** Hub 数据库 Bot → 持久分身（SYSTEM/MEMORY、模型、思考档位、Skills、Extensions、环境变量全部来自 Hub 权威存储）。 */
  const syncBotPersonas = async (runtime: HubDurableRuntime): Promise<void> => {
    // `.agent/` 下新增的动态 provider 模型（如 magpie 缓存目录）热注册进运行时，
    // 保证运行时打开后新写入的存储模型无需重启即可选型。
    const runtimeModels = runtime.models as Models | undefined;
    if (runtimeModels !== undefined && typeof (runtimeModels as MutableModels).setProvider === 'function') {
      registerStoredProviders(runtimeModels as MutableModels, db.getDataDir());
    }
    const personas: BotPersonaConfig[] = [];
    for (const bot of db.getAllBots()) {
      const parent = bot.parentBotId ? db.getBot(bot.parentBotId) : undefined;
      const effectiveModel =
        bot.inheritModel && parent
          ? { provider: parent.modelProvider, modelId: parent.modelId }
          : { provider: bot.modelProvider, modelId: bot.modelId };
      const systemMd = db.getBotFile(bot.id, 'system').trim();
      const memoryMd = db.getBotFile(bot.id, 'memory').trim();
      const botEnv = readBotEnvMap(bot.id);
      const persona: BotPersonaConfig = {
        botId: bot.id,
        name: bot.name,
        ...(bot.parentBotId ? { parentBotId: bot.parentBotId } : {}),
        ...(bot.description ? { description: bot.description } : {}),
        model: effectiveModel,
        ...(bot.thinkingLevel ? { thinkingLevel: bot.thinkingLevel } : {}),
        instructions:
          systemMd ||
          `You are "${bot.name}", the lead bot of this hub.${bot.description ? ` ${bot.description}` : ''}`,
        ...(memoryMd ? { memory: memoryMd } : {}),
        enabledSkills: resolveEffectiveBotSkillIds(bot),
        enabledExtensions: bot.enabledExtensions,
        ...(botEnv ? { env: botEnv } : {}),
        nodeId: bot.nodeId,
        // 子代理未显式配置工作目录时继承父 Bot 的 workspaceDir。
        cwd: bot.workspaceDir?.trim() || parent?.workspaceDir?.trim() || process.cwd(),
        ...(bot.toolScope ? { toolScope: bot.toolScope } : {}),
        ...(bot.customTools ? { customTools: bot.customTools } : {}),
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
      personas.push(persona);
    }
    // 存量会话热同步：已创建的 Router/Worker 会话立即应用最新分身配置
    //（模型/思考档位/SYSTEM/MEMORY/toolScope/扩展选择），无需重启或新建会话。
    if (typeof runtime.syncPersonas === 'function') {
      await runtime.syncPersonas(personas);
    }
    // 同步完成后记录配置面指纹：正常发消息时指纹不变，读路径直接短路。
    lastPersonaFingerprint = computePersonaFingerprint();
  };

  // Durable Router 会话 → botd 会话消息镜像（SSE 桥）：注入的 runtime 直接建，
  // 懒创建路径在 runtime 打开后建（见 ensureDurableRuntime）。
  let durableMirror: DurableSessionMirror | undefined = durableRuntime !== undefined
    ? createDurableSessionMirror({ db, sseHub, durableRuntime })
    : undefined;
  /** 重启/懒打开后补挂存量会话的镜像：未发新消息的会话也能继续接收回复回写。 */
  const attachMirrorToExistingSessions = async (mirror: DurableSessionMirror): Promise<void> => {
    for (const user of db.listUsers()) {
      for (const session of db.getAllSessions(user.id)) {
        await mirror.ensure(session.id).catch(() => undefined);
      }
    }
  };
  if (durableMirror !== undefined) {
    void attachMirrorToExistingSessions(durableMirror);
  }

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
      options?.durableRuntime !== undefined || listEffectiveProviderCredentials(db).length > 0,
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

  // 延时唤醒与静默唤醒（noTurn）仍走 GroupRouter（once 触发器 / 纯 callback 落库）；
  // 真正需要推理回合的唤醒在 Durable 主线启用时改提交 Router 会话（见 handleDurableWakeup），
  // 避免向已不再提供 runTurn 的节点下发 RPC。
  ;(router as GroupRouter & { handleDurableWakeup?: (input: {
    sessionId: string;
    botId: string;
    wakeupMessage: string;
    replyToBotId?: string;
    noTurn?: boolean;
  }) => Promise<boolean> }).handleDurableWakeup = async (input): Promise<boolean> => {
    if (input.noTurn === true) return false; // 静默唤醒：仅落 callback，由 handleWakeup 直接处理
    // 主线切流门槛与 messages.ts 一致：runtime 显式注入，或已配置任一 Provider 凭据。
    if (options?.durableRuntime === undefined && listEffectiveProviderCredentials(db).length === 0) {
      return false;
    }
    // 1. 先以 noTurn 语义落库并广播 [Wake-up] callback 消息（保留原公屏行为）
    await router.handleWakeup(input.sessionId, input.botId, input.wakeupMessage, input.replyToBotId, {
      noTurn: true,
    });
    // 2. 唤醒正文提交给会话的 Durable Router 会话（whenBusy: steer），由 Hub 侧模型驱动回合
    const rt = await ensureDurableRuntime();
    await submitSessionMessageToDurable(
      { db, sseHub, durableRuntime: rt, getDurableRuntime: ensureDurableRuntime },
      input.sessionId,
      input.botId,
      `[Wake-up] ${input.wakeupMessage}`,
      durableMirror,
    );
    return true;
  };

  // 静态 Web 文件 & SPA fallback
  app.use('*', createStaticMiddleware(options?.webDir));

  let isClosed = false;
  /** Durable 运行时中仍在执行的任务数（排除 Hub 托管的后台 watchdog 巡检与 blocked 任务）。 */
  const getActiveDurableTaskCount = async (): Promise<number> => {
    if (durableRuntime === undefined) return 0;
    try {
      const inspection = await durableRuntime.harness.inspect(BACKGROUND_CONTEXT);
      // record.kind 即任务定义名（pi.generation / pi.tool / botd.watchdog…）；
      // blocked 任务无注册定义可接管，不构成活跃工作。
      return inspection.tasks.filter(
        (task) => task.record.kind !== 'botd.watchdog' && task.state.kind !== 'blocked',
      ).length;
    } catch {
      return 0;
    }
  };
  const drain = async (timeoutMs = 30_000): Promise<{ drained: boolean; remaining: number }> => {
    // 先让 GroupRouter 完成自身的排空准备（清空队列、置 draining 标记）
    await router.drain(timeoutMs);
    const start = Date.now();
    for (;;) {
      const remaining = router.getActiveTurnCount() + (await getActiveDurableTaskCount());
      if (remaining === 0) return { drained: true, remaining: 0 };
      if (Date.now() - start >= timeoutMs) return { drained: false, remaining };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
    // 动态 getter：懒打开后 hub.durableRuntime 也能拿到实例（旧快照展开恒 undefined）。
    get durableRuntime() {
      return durableRuntime;
    },
    ensureDurableRuntime,
    stopWorkerHook,
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
  // 定时器始终创建（懒打开在启动后任意时刻完成）：回调内动态读取当前实例。
  // 宿主 Worker 停止钩子由 createHub 提供（闭包可见宿主 acquiredWorktrees 缓存）。
  const watchdogTimer: NodeJS.Timeout = setInterval(() => {
    const runtime = hub.durableRuntime;
    if (runtime === undefined) return;
    void runWatchdogPass(runtime.harness, { stopWorker: (conversationId, ctx) => hub.stopWorkerHook(runtime, conversationId, ctx) }, BACKGROUND_CONTEXT).catch((err) => {
      console.warn('[hub] watchdog pass failed:', err instanceof Error ? err.message : err);
    });
  }, options?.watchdogIntervalMs ?? 30_000);
  watchdogTimer.unref();

  const addr = server.address();
  const resolvedPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  const originalClose = hub.close;
  hub.close = async (): Promise<void> => {
    // 0. Stop the background watchdog first
    clearInterval(watchdogTimer);
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
