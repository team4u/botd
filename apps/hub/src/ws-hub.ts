import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import {
  HubRpcFunctions,
  NodeRpcFunctions,
  isBotConfig,
  isSafeId,
  serializeRpcMessage,
  validateUiSpec,
  type ExtensionUiStreamPayload,
  type SubagentRunRecord,
  type SubagentSteerRecord,
  type ToolCallRecord,
  type TurnBlock,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { AuthManager } from './auth.js';
import type { SseHub } from './sse.js';
import { ArtifactService } from './artifact-service.js';
import { ExecOutputHub, RemoteExecutionEnv } from './harness/remote-env.js';
import type { NodeEnvRpcFunctions } from '@botd/protocol';
import type { Context } from '@earendil-works/chord/context';

export interface GroupRouterDelegate {
  handleWakeup(
    sessionId: string,
    botId: string,
    wakeupMessage: string,
    replyToBotId?: string,
    options?: { noTurn?: boolean }
  ): Promise<void>;
  getActiveBotId(sessionId: string): string | undefined;
  isBotActiveInSession?(sessionId: string, botId: string): boolean;
  canRunBot(sessionId: string, botId: string): boolean;
  handleNativeSubagentStreamEvent(
    sessionId: string,
    parentBotId: string,
    subEvent: {
      id: string;
      subagentId: string;
      task: string;
      status: 'running' | 'done' | 'error' | 'stopped';
      result?: string;
      error?: string;
      durationMs?: number;
      toolUses?: number;
      currentTool?: string;
      phase?: string;
      childSessionId?: string;
      startedAt?: string;
      blocks?: TurnBlock[];
      toolCalls?: ToolCallRecord[];
      steers?: SubagentSteerRecord[];
    }
  ): SubagentRunRecord | undefined;
  onNodeOnline?(nodeId: string): void;
  requestHumanInput?(input: {
    sessionId: string;
    botId: string;
    prompt: string;
    options?: string[];
    timeoutSeconds?: number;
  }): Promise<{ answer: string }>;
}

export interface NodeConnection {
  nodeId: string;
  ws: WebSocket;
  rpc: BirpcReturn<NodeRpcFunctions, HubRpcFunctions>;
  /** 心跳标记：收到 pong 置 true，每轮 ping 前检查并重置 */
  alive: boolean;
  /** 连续未收到 pong 的轮数，达到阈值即判定死链 */
  missedPongs: number;
}

/** 每个在线节点的等待者：节点上线（连接建立或 registerNode）时唤醒。 */
interface NodeOnlineWaiter {
  resolve: (rpc: NodeEnvRpcFunctions) => void;
  detachAbortListener: () => void;
}

export class NodeConnectionManager {
  public wss: WebSocketServer;
  private connections = new Map<string, NodeConnection>();
  private db: HubDatabase;
  private auth: AuthManager;
  private sseHub: SseHub;
  private router?: GroupRouterDelegate;
  private artifactService: ArtifactService;
  private heartbeatTimer?: NodeJS.Timeout;
  /** 远端执行环境流式输出分发器（Node 回调 onEnvExecOutput 的统一入口）。 */
  readonly execOutputHub = new ExecOutputHub();
  /** 节点离线时挂起的 waitForNodeOnline 等待者（按 nodeId 分组）。 */
  private onlineWaiters = new Map<string, Set<NodeOnlineWaiter>>();

  constructor(
    db: HubDatabase,
    auth: AuthManager,
    sseHub: SseHub,
    artifactService?: ArtifactService
  ) {
    this.db = db;
    this.auth = auth;
    this.sseHub = sseHub;
    this.artifactService = artifactService ?? new ArtifactService(db, sseHub);
    this.wss = new WebSocketServer({ noServer: true });
  }

  setRouter(router: GroupRouterDelegate): void {
    this.router = router;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const urlString = req.url || '';
    const parsed = new URL(urlString, 'http://127.0.0.1');

    if (parsed.pathname !== '/ws/node') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const nodeId = parsed.searchParams.get('nodeId');
    const token = parsed.searchParams.get('token');

    if (!nodeId || !token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const node = this.db.getNodeWithSecret(nodeId);
    if (!node || !this.auth.verifyNodeToken(token, node.tokenHash)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, nodeId);
    });
  }

  private onConnection(ws: WebSocket, nodeId: string): void {
    // Terminate any existing connection for this nodeId
    const existing = this.connections.get(nodeId);
    if (existing) {
      existing.rpc.$close();
      existing.ws.terminate();
    }

    // Mark online in DB
    this.db.updateNodeStatus(nodeId, 'online');

    const hubFunctions: HubRpcFunctions = {
      registerNode: async (info) => {
        if (!info || typeof info.name !== 'string' || !info.name.trim()
          || !['linux', 'darwin', 'win32'].includes(info.platform)
          || !Array.isArray(info.bots) || !Array.isArray(info.skills)
          || (info.pid !== undefined && info.pid !== null && (typeof info.pid !== 'number' || !Number.isFinite(info.pid)))
          || (info.startedAt !== undefined && info.startedAt !== null && typeof info.startedAt !== 'string')
          || (info.version !== undefined && info.version !== null && (typeof info.version !== 'string' || !info.version.trim()))) {
          throw new Error('Invalid node registration');
        }
        if (info.nodeId !== nodeId) {
          throw new Error(`Forbidden: authenticated as node ${nodeId}, cannot register as ${info.nodeId}`);
        }

        const extensions = info.extensions ?? [];
        if (!Array.isArray(extensions) || !extensions.every(ext => isSafeId(ext))) {
          throw new Error('Invalid extensions configuration in node registration');
        }

        const pid = typeof info.pid === 'number' && Number.isFinite(info.pid) ? info.pid : undefined;
        const startedAt = typeof info.startedAt === 'string' && info.startedAt.trim().length > 0 ? info.startedAt.trim() : undefined;

        // 1. Validate all skills first before any writes
        for (const skill of info.skills || []) {
          if (!isSafeId(skill)) {
            throw new Error(`Invalid skill id format: "${skill}"`);
          }
        }

        // 2. Validate all bots and ensure no stealing of bot IDs from another node
        const botIds = new Set<string>();
        for (const bot of info.bots || []) {
          if (!isBotConfig(bot)) {
            throw new Error('Invalid BOT configuration in node registration');
          }
          if (botIds.has(bot.id)) throw new Error(`Duplicate BOT id: ${bot.id}`);
          botIds.add(bot.id);
          if (bot.nodeId !== nodeId) {
            throw new Error(`Forbidden: bot ${bot.id} nodeId does not match ${nodeId}`);
          }
          const existing = this.db.getBot(bot.id);
          if (existing && existing.nodeId !== nodeId) {
            throw new Error(`Forbidden: bot id "${bot.id}" is already owned by node "${existing.nodeId}"`);
          }
        }

        // 与节点上报对账：Hub SQLite 是 Bot 配置的权威存储，节点上报只做 upsert，
        // 不再删除 Hub 侧存量 Bot（离线期间创建/编辑的 Bot 不能因节点未同步而被清除）。
        this.db.inTransaction(() => {
          this.db.updateNodeMetadata(nodeId, info.name, info.platform, info.skills, extensions, pid, startedAt, info.version);
          for (const bot of info.bots) {
            const existingBot = this.db.getBot(bot.id);
            this.db.saveBot({
              ...bot,
              visibility: bot.visibility ?? existingBot?.visibility ?? 'private',
              enabledExtensions: bot.enabledExtensions ?? [],
            });
          }
        });

        this.router?.onNodeOnline?.(nodeId);

        // 广播节点上线通知（仅节点 owner 的全局 SSE 订阅者）
        const onlineOwner = this.db.getNodeOwner(nodeId);
        if (onlineOwner) {
          this.sseHub.broadcastToUser(onlineOwner, { type: 'node_status', nodeId, status: 'online' });
        }

        this.resolveOnlineWaiters(nodeId);

        return;
      },

      heartbeat: async (calledNodeId: string) => {
        if (calledNodeId !== nodeId) {
          throw new Error(`Forbidden: authenticated as node ${nodeId}, cannot heartbeat for ${calledNodeId}`);
        }
        this.db.updateNodeStatus(nodeId, 'online');
      },

      onSessionStream: (event) => {
        // Enforce that the bot belongs to this authenticated node
        const bot = this.db.getBot(event.botId);
        if (!bot || bot.nodeId !== nodeId) {
          return;
        }

        // Enforce session exists and bot is a member
        const session = this.db.getSession(event.sessionId);
        if (!session) {
          return;
        }

        const isMember =
          session.leadBotId === event.botId ||
          Boolean(this.router?.canRunBot(event.sessionId, event.botId));
        if (!isMember) {
          return;
        }

        // Enforce that this session is currently running and this bot is an active bot.
        // 例外：子代理事件（subagentEvent）允许回合结束后继续透传——后台子代理完成、抽屉内
        // resume / stop 的状态更新都发生在主回合结束之后，不能当作杂散流丢弃。
        const isActive = this.router?.isBotActiveInSession
          ? this.router.isBotActiveInSession(event.sessionId, event.botId)
          : this.router?.getActiveBotId(event.sessionId) === event.botId;
        if (!isActive && !event.subagentEvent) {
          // Suppress stray or cancelled streams
          return;
        }

        if (event.deltaText !== undefined) {
          this.sseHub.broadcast(event.sessionId, {
            type: 'text_delta',
            sessionId: event.sessionId,
            botId: event.botId,
            delta: event.deltaText,
          });
        }

        if (event.thinkingDelta !== undefined || event.thinkingStatus !== undefined) {
          this.sseHub.broadcast(event.sessionId, {
            type: 'thinking_stream',
            sessionId: event.sessionId,
            botId: event.botId,
            ...(event.thinkingDelta !== undefined ? { delta: event.thinkingDelta } : {}),
            status: event.thinkingStatus ?? 'running',
            ...(event.thinkingDurationMs !== undefined ? { durationMs: event.thinkingDurationMs } : {}),
          });
        }

        if (event.toolName && event.toolStatus) {
          // tool.view 插槽：扩展工具返回的 BotdUiSpec 先校验再透传（非法直接丢弃，不影响事件本身）
          const toolUiValidation = event.toolUiSpec ? validateUiSpec(event.toolUiSpec) : undefined;
          this.sseHub.broadcast(event.sessionId, {
            type: 'tool_status',
            sessionId: event.sessionId,
            botId: event.botId,
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            toolName: event.toolName,
            status: event.toolStatus,
            ...(event.toolSummary ? { summary: event.toolSummary } : {}),
            ...(event.toolArgs ? { args: event.toolArgs } : {}),
            ...(event.toolOutput ? { outputPreview: event.toolOutput } : {}),
            ...(event.toolDurationMs !== undefined ? { durationMs: event.toolDurationMs } : {}),
            ...(event.toolIsError !== undefined ? { isError: event.toolIsError } : {}),
            ...(toolUiValidation?.ok ? { uiSpec: toolUiValidation.spec } : {}),
          });
        }

        // 扩展 UI 实时事件（notify / status / working_message / widget / editor_text）：
        // kind 合法性 + widget.uiSpec 校验后广播给会话订阅者
        if (event.extensionUiEvent) {
          const uiEvent = event.extensionUiEvent as ExtensionUiStreamPayload;
          const VALID_KINDS = new Set(['notify', 'status', 'working_message', 'widget', 'editor_text']);
          if (VALID_KINDS.has(uiEvent.kind)) {
            if (uiEvent.kind === 'widget' && uiEvent.uiSpec) {
              const widgetValidation = validateUiSpec(uiEvent.uiSpec);
              if (widgetValidation.ok) {
                uiEvent.uiSpec = widgetValidation.spec;
              } else {
                delete uiEvent.uiSpec;
              }
            }
            this.sseHub.broadcast(event.sessionId, {
              type: 'extension_ui',
              sessionId: event.sessionId,
              botId: event.botId,
              event: uiEvent,
            });
          }
        }

        if (event.subagentEvent && this.router) {
          this.router.handleNativeSubagentStreamEvent(event.sessionId, event.botId, event.subagentEvent);
        }
      },

      requestWakeupTurn: async (input) => {
        this.assertNodeBotInSession(nodeId, input.botId, input.sessionId);

        if (this.router) {
          // 延时唤醒：在 Hub 上创建 once 触发器，到点再触发推理回合
          if (typeof input.delaySeconds === 'number' && Number.isFinite(input.delaySeconds) && input.delaySeconds > 0) {
            const ownerId = this.db.getSessionOwner(input.sessionId) ?? 'user_admin';
            const runAt = new Date(Date.now() + Math.floor(input.delaySeconds) * 1000).toISOString();
            const prompt =
              input.replyToBotId && !input.wakeupMessage.includes(`@${input.replyToBotId}`)
                ? `${input.wakeupMessage} (cc @${input.replyToBotId})`
                : input.wakeupMessage;
            const trigger = this.db.createTrigger({
              id: `trg_${randomUUID()}`,
              sessionId: input.sessionId,
              botId: input.botId,
              ownerId,
              name: `延时唤醒 (${input.botId})`,
              kind: 'once',
              runAt,
              prompt,
              enabled: true,
            });
            return { ok: true as const, scheduledTriggerId: trigger.id };
          }
          await this.router.handleWakeup(input.sessionId, input.botId, input.wakeupMessage, input.replyToBotId, {
            noTurn: input.noTurn,
          });
          return { ok: true as const };
        }
      },

      requestHumanInput: async (input) => {
        this.assertNodeBotInSession(nodeId, input.botId, input.sessionId);

        if (!this.router?.requestHumanInput) {
          throw new Error('Interactive human input is not supported by router');
        }

        return await this.router.requestHumanInput(input);
      },

      uploadArtifact: async (input) => {
        return this.artifactService.uploadArtifact({ type: 'node', nodeId }, input);
      },

      downloadArtifact: async (artifactId: string) => {
        return this.artifactService.downloadArtifact({ type: 'node', nodeId }, artifactId);
      },

      listSessionArtifacts: async (sessionId: string) => {
        return this.artifactService.listSessionArtifacts({ type: 'node', nodeId }, sessionId);
      },

      onEnvExecOutput: (event) => {
        this.execOutputHub.onEnvExecOutput(event);
      },
    };

    const rpc = createBirpc<NodeRpcFunctions, HubRpcFunctions>(hubFunctions, {
      post: (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      },
      on: (fn) => {
        ws.on('message', (msg) => {
          try {
            fn(typeof msg === 'string' ? msg : msg.toString());
          } catch {
            // ignore
          }
        });
      },
      serialize: serializeRpcMessage,
      deserialize: JSON.parse,
      timeout: 30 * 60 * 1000,
    });

    const conn: NodeConnection = { nodeId, ws, rpc, alive: true, missedPongs: 0 };
    this.connections.set(nodeId, conn);
    this.startHeartbeat();
    this.resolveOnlineWaiters(nodeId);
    ws.on('pong', () => {
      conn.alive = true;
    });

    const cleanup = () => {
      if (this.connections.get(nodeId)?.ws === ws) {
        this.connections.delete(nodeId);
        this.db.updateNodeStatus(nodeId, 'offline');
        const offlineOwner = this.db.getNodeOwner(nodeId);
        if (offlineOwner) {
          this.sseHub.broadcastToUser(offlineOwner, { type: 'node_status', nodeId, status: 'offline' });
        }
        rpc.$close();
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  /**
   * 服务端协议层心跳：每 30s ping 一次，连续 2 轮无 pong 即 terminate，
   * 触发 close 清理路径（节点置 offline），避免 NAT 静默失联后 runTurn RPC 挂死。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.connections.values()) {
        if (conn.ws.readyState !== WebSocket.OPEN) continue;
        if (!conn.alive) {
          conn.missedPongs++;
          if (conn.missedPongs >= 2) {
            console.warn(`[ws-hub] Node ${conn.nodeId} missed 2 heartbeats, terminating connection`);
            conn.ws.terminate();
            continue;
          }
        } else {
          conn.missedPongs = 0;
        }
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          // ignore
        }
      }
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private assertNodeBotInSession(nodeId: string, botId: string, sessionId: string): void {
    const bot = this.db.getBot(botId);
    if (!bot || bot.nodeId !== nodeId) {
      throw new Error(`Forbidden: bot ${botId} does not belong to node ${nodeId}`);
    }

    const session = this.db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const isMember = session.leadBotId === botId;
    if (!isMember) {
      throw new Error(`Forbidden: bot ${botId} is not a member of session ${sessionId}`);
    }
  }

  getNodeRpc(nodeId: string): BirpcReturn<NodeRpcFunctions, HubRpcFunctions> | undefined {
    return this.connections.get(nodeId)?.rpc;
  }

  /** 取节点 env RPC 视图（离线返回 undefined）。birpc 客户端是 Proxy，按需合成调用函数，旧节点只会在调用时报错。 */
  getNodeEnvRpc(nodeId: string): NodeEnvRpcFunctions | undefined {
    const rpc = this.connections.get(nodeId)?.rpc;
    return rpc === undefined ? undefined : (rpc as unknown as NodeEnvRpcFunctions);
  }

  /** 唤醒指定节点全部在线等待者（连接建立或 registerNode 时调用）。 */
  private resolveOnlineWaiters(nodeId: string): void {
    const waiters = this.onlineWaiters.get(nodeId);
    if (waiters === undefined || waiters.size === 0) return;
    const rpc = this.getNodeEnvRpc(nodeId);
    if (rpc === undefined) return;
    this.onlineWaiters.delete(nodeId);
    for (const waiter of waiters) {
      waiter.detachAbortListener();
      waiter.resolve(rpc);
    }
  }

  /**
   * 等待节点上线并返回其 env RPC（BYOM 离线韧性）：
   * 已在线立即返回；否则挂起直到该节点重新连接（或 context 取消时拒绝）。
   */
  waitForNodeOnline(nodeId: string, context: Context): Promise<NodeEnvRpcFunctions> {
    const online = this.getNodeEnvRpc(nodeId);
    if (online !== undefined) return Promise.resolve(online);

    return new Promise<NodeEnvRpcFunctions>((resolve, reject) => {
      const onAbort = () => {
        const set = this.onlineWaiters.get(nodeId);
        set?.delete(waiter);
        if (set !== undefined && set.size === 0) this.onlineWaiters.delete(nodeId);
        const reason: unknown = context.abortSignal?.reason;
        reject(reason instanceof Error ? reason : new Error(`wait for node ${nodeId} online aborted`));
      };
      const waiter: NodeOnlineWaiter = {
        resolve,
        detachAbortListener: () => context.abortSignal?.removeEventListener('abort', onAbort),
      };
      context.abortSignal?.throwIfAborted();
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });

      // 挂起后竞态复查：注册等待者与连接建立之间无序，补一次在线检查
      let set = this.onlineWaiters.get(nodeId);
      if (set === undefined) {
        set = new Set();
        this.onlineWaiters.set(nodeId, set);
      }
      set.add(waiter);
      const recheck = this.getNodeEnvRpc(nodeId);
      if (recheck !== undefined) {
        set.delete(waiter);
        if (set.size === 0) this.onlineWaiters.delete(nodeId);
        waiter.detachAbortListener();
        resolve(recheck);
      }
    });
  }

  /** 为 nodeId 构造远端执行环境（Brain in Hub, Hands on Node）。 */
  createRemoteEnv(options: { nodeId: string; cwd: string }): RemoteExecutionEnv {
    return new RemoteExecutionEnv(
      {
        getNodeEnvRpc: (nodeId: string) => this.getNodeEnvRpc(nodeId),
        waitForNodeOnline: (nodeId: string, context: Context) => this.waitForNodeOnline(nodeId, context),
      },
      options,
      this.execOutputHub,
    );
  }

  disconnectNode(nodeId: string): boolean {
    const conn = this.connections.get(nodeId);
    if (!conn) return false;
    this.connections.delete(nodeId);
    try {
      conn.rpc.$close();
      conn.ws.terminate();
    } catch {
      // ignore
    }
    return true;
  }

  close(): void {
    for (const conn of this.connections.values()) {
      try {
        conn.rpc.$close();
        conn.ws.terminate();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    try {
      this.wss.close();
    } catch {
      // ignore
    }
  }
}
