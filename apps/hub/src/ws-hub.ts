import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import {
  HubRpcFunctions,
  NodeRpcFunctions,
  isBotConfig,
  isSafeId,
  serializeRpcMessage,
  type NodeEnvRpcFunctions,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { AuthManager } from './auth.js';
import type { SseHub } from './sse.js';
import { ExecOutputHub, RemoteExecutionEnv } from './harness/remote-env.js';
import type { Context } from '@earendil-works/chord/context';

/** 语义化版本比较（忽略预发布后缀）：a > b 返回 1，相等 0，a < b 返回 -1。 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, '').split(/[+-]/)[0].split('.').map((seg) => Number.parseInt(seg, 10) || 0);
  const [aParts, bParts] = [parse(a), parse(b)];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Hub 自身版本：环境变量覆盖优先，否则读 apps/hub/package.json。 */
function resolveHubVersion(): string {
  const fromEnv = process.env.BOTD_VERSION_OVERRIDE;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    // 直读 package.json；读取失败退回 0.0.0（永不触发自动升级）。
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version;
    return version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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

export interface NodeConnectionManagerOptions {
  /** 节点注册后版本落后于 Hub 时自动下发 upgradeDaemon（默认 BOTD_AUTO_UPGRADE_NODES=1 才启用）。 */
  autoUpgradeNodes?: boolean;
  /** Hub 自身版本（节点对齐目标）；缺省读 BOTD_VERSION_OVERRIDE 或 package.json。 */
  hubVersion?: string;
}

export class NodeConnectionManager {
  public wss: WebSocketServer;
  private connections = new Map<string, NodeConnection>();
  private db: HubDatabase;
  private auth: AuthManager;
  private sseHub: SseHub;
  private heartbeatTimer?: NodeJS.Timeout;
  /** 节点版本落后于 Hub 时自动下发升级（默认关闭，npm 包未发布前不启用）。 */
  private autoUpgradeNodes: boolean;
  /** Hub 自身版本：节点自动升级的对齐目标。 */
  private hubVersion: string;
  /** 远端执行环境流式输出分发器（Node 回调 onEnvExecOutput 的统一入口）。 */
  readonly execOutputHub = new ExecOutputHub();
  /** 节点离线时挂起的 waitForNodeOnline 等待者（按 nodeId 分组）。 */
  private onlineWaiters = new Map<string, Set<NodeOnlineWaiter>>();

  constructor(
    db: HubDatabase,
    auth: AuthManager,
    sseHub: SseHub,
    options?: NodeConnectionManagerOptions
  ) {
    this.db = db;
    this.auth = auth;
    this.sseHub = sseHub;
    this.wss = new WebSocketServer({ noServer: true });
    this.autoUpgradeNodes = options?.autoUpgradeNodes ?? process.env.BOTD_AUTO_UPGRADE_NODES === '1';
    this.hubVersion = options?.hubVersion ?? resolveHubVersion();
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

        // Hub SQLite 是 Bot 业务配置（模型、提示词、工作区、扩展等）的唯一权威事实源。
        // 节点作为无状态执行器（Stateless Worker），上报时严禁反向覆盖 Hub 中已存在的 Bot 配置。
        this.db.inTransaction(() => {
          this.db.updateNodeMetadata(nodeId, info.name, info.platform, info.skills, extensions, pid, startedAt, info.version);
          for (const bot of info.bots || []) {
            const existingBot = this.db.getBot(bot.id);
            if (!existingBot) {
              this.db.saveBot({
                ...bot,
                visibility: bot.visibility ?? 'private',
                enabledExtensions: bot.enabledExtensions ?? [],
              });
            }
          }
        });

        // 广播节点上线通知（仅节点 owner 的全局 SSE 订阅者）
        const onlineOwner = this.db.getNodeOwner(nodeId);
        if (onlineOwner) {
          this.sseHub.broadcastToUser(onlineOwner, { type: 'node_status', nodeId, status: 'online' });
        }

        this.resolveOnlineWaiters(nodeId);

        // Hub 管控节点版本对齐：注册完成后发现节点版本落后时异步下发升级
        //（不阻塞注册返回；升级失败仅告警，下次注册重新评估）。
        const nodeVersion = info.version?.trim();
        if (this.autoUpgradeNodes && nodeVersion && compareSemver(this.hubVersion, nodeVersion) > 0) {
          const conn = this.connections.get(nodeId);
          if (conn !== undefined) {
            void conn.rpc
              .upgradeDaemon?.({ targetVersion: this.hubVersion })
              .catch((err) =>
                console.warn(`[hub] auto-upgrade node ${nodeId} failed:`, err instanceof Error ? err.message : err),
              );
          }
        }

        return;
      },

      heartbeat: async (calledNodeId: string) => {
        if (calledNodeId !== nodeId) {
          throw new Error(`Forbidden: authenticated as node ${nodeId}, cannot heartbeat for ${calledNodeId}`);
        }
        this.db.updateNodeStatus(nodeId, 'online');
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
   * 触发 close 清理路径（节点置 offline），避免 NAT 静默失联后 RPC 挂死。
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

  /** 为 nodeId 构造远端执行环境（Brain in Hub, Hands on Node）；shellEnv 随会话上下文注入远端子进程。 */
  createRemoteEnv(options: { nodeId: string; cwd: string; shellEnv?: Record<string, string> }): RemoteExecutionEnv {
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

