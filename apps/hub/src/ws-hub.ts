import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import {
  type ArtifactRecord,
  HubRpcFunctions,
  type MessageAttachment,
  NodeRpcFunctions,
  serializeRpcMessage,
} from '@botd/protocol';
import { type HubDatabase, isValidCommandName } from './db.js';
import type { AuthManager } from './auth.js';
import type { SseHub } from './sse.js';

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
  onNodeOnline?(nodeId: string): void;
  requestHumanInput?(input: {
    sessionId: string;
    botId: string;
    prompt: string;
    options?: string[];
    timeoutSeconds?: number;
  }): Promise<{ answer: string }>;
}

export interface ArtifactHandlerDelegate {
  uploadArtifact(input: {
    sessionId: string;
    botId?: string;
    filename: string;
    mimeType?: string;
    contentBase64: string;
    message?: string;
  }): Promise<ArtifactRecord>;
  downloadArtifact(artifactId: string): Promise<{
    artifact: ArtifactRecord;
    contentBase64: string;
  }>;
  listSessionArtifacts(sessionId: string): Promise<ArtifactRecord[]>;
}

export interface NodeConnection {
  nodeId: string;
  ws: WebSocket;
  rpc: BirpcReturn<NodeRpcFunctions, HubRpcFunctions>;
}

export class NodeConnectionManager {
  public wss: WebSocketServer;
  private connections = new Map<string, NodeConnection>();
  private db: HubDatabase;
  private auth: AuthManager;
  private sseHub: SseHub;
  private router?: GroupRouterDelegate;
  private artifactHandler?: ArtifactHandlerDelegate;

  constructor(db: HubDatabase, auth: AuthManager, sseHub: SseHub) {
    this.db = db;
    this.auth = auth;
    this.sseHub = sseHub;
    this.wss = new WebSocketServer({ noServer: true });
  }

  setRouter(router: GroupRouterDelegate): void {
    this.router = router;
  }

  setArtifactHandler(handler: ArtifactHandlerDelegate): void {
    this.artifactHandler = handler;
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
          || (info.startedAt !== undefined && info.startedAt !== null && typeof info.startedAt !== 'string')) {
          throw new Error('Invalid node registration');
        }
        if (info.nodeId !== nodeId) {
          throw new Error(`Forbidden: authenticated as node ${nodeId}, cannot register as ${info.nodeId}`);
        }

        const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

        const extensions = info.extensions ?? [];
        if (!Array.isArray(extensions) || !extensions.every(ext => typeof ext === 'string' && ID_REGEX.test(ext))) {
          throw new Error('Invalid extensions configuration in node registration');
        }

        const pid = typeof info.pid === 'number' && Number.isFinite(info.pid) ? info.pid : undefined;
        const startedAt = typeof info.startedAt === 'string' && info.startedAt.trim().length > 0 ? info.startedAt.trim() : undefined;

        // 1. Validate all skills first before any writes
        for (const skill of info.skills || []) {
          if (typeof skill !== 'string' || !ID_REGEX.test(skill)) {
            throw new Error(`Invalid skill id format: "${skill}"`);
          }
        }

        // 2. Validate all bots and ensure no stealing of bot IDs from another node
        const botIds = new Set<string>();
        for (const bot of info.bots || []) {
          if (!bot || typeof bot.id !== 'string' || !ID_REGEX.test(bot.id)
            || typeof bot.name !== 'string' || !bot.name.trim()
            || typeof bot.modelProvider !== 'string' || !bot.modelProvider.trim()
            || typeof bot.modelId !== 'string' || !bot.modelId.trim()
            || typeof bot.description !== 'string' || !Array.isArray(bot.enabledSkills)
            || !bot.enabledSkills.every(skill => typeof skill === 'string' && ID_REGEX.test(skill))
            || !(bot.enabledExtensions === undefined || (Array.isArray(bot.enabledExtensions) && bot.enabledExtensions.every(ext => typeof ext === 'string' && ID_REGEX.test(ext))))
            || !(bot.webCommandNames === undefined || (Array.isArray(bot.webCommandNames) && bot.webCommandNames.every(isValidCommandName)))
            || (bot.thinkingLevel !== undefined && !['low', 'medium', 'high'].includes(bot.thinkingLevel))) {
            throw new Error('Invalid BOT configuration in node registration');
          }
          if (botIds.has(bot.id)) throw new Error(`Duplicate BOT id: ${bot.id}`);
          botIds.add(bot.id);
          if (!ID_REGEX.test(bot.id)) {
            throw new Error(`Invalid bot id format: "${bot.id}"`);
          }
          if (bot.nodeId !== nodeId) {
            throw new Error(`Forbidden: bot ${bot.id} nodeId does not match ${nodeId}`);
          }
          const existing = this.db.getBot(bot.id);
          if (existing && existing.nodeId !== nodeId) {
            throw new Error(`Forbidden: bot id "${bot.id}" is already owned by node "${existing.nodeId}"`);
          }
        }

        // Reconcile the cache with the node's authoritative local inventory.
        this.db.db.exec('BEGIN');
        try {
          this.db.updateNodeMetadata(nodeId, info.name, info.platform, info.skills, extensions, pid, startedAt);
          for (const cached of this.db.getBotsForNode(nodeId)) {
            if (!botIds.has(cached.id)) this.db.deleteBot(cached.id);
          }
          for (const bot of info.bots) this.db.saveBot({
            ...bot,
            enabledExtensions: bot.enabledExtensions ?? [],
            webCommandNames: Array.from(new Set(bot.webCommandNames ?? [])),
          });
          this.db.db.exec('COMMIT');
        } catch (error) {
          this.db.db.exec('ROLLBACK');
          throw error;
        }

        this.router?.onNodeOnline?.(nodeId);

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

        const isMember = session.memberBotIds.includes(event.botId) || session.leadBotId === event.botId;
        if (!isMember) {
          return;
        }

        // Enforce that this session is currently running and this bot is an active bot
        const isActive = this.router?.isBotActiveInSession
          ? this.router.isBotActiveInSession(event.sessionId, event.botId)
          : this.router?.getActiveBotId(event.sessionId) === event.botId;
        if (!isActive) {
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

        if (event.toolName && event.toolStatus) {
          this.sseHub.broadcast(event.sessionId, {
            type: 'tool_status',
            sessionId: event.sessionId,
            botId: event.botId,
            toolName: event.toolName,
            status: event.toolStatus,
            summary: event.toolSummary,
          });
        }
      },

      requestWakeupTurn: async (input) => {
        const bot = this.db.getBot(input.botId);
        if (!bot || bot.nodeId !== nodeId) {
          throw new Error(`Forbidden: bot ${input.botId} does not belong to node ${nodeId}`);
        }

        const session = this.db.getSession(input.sessionId);
        if (!session) {
          throw new Error(`Session ${input.sessionId} not found`);
        }

        const isMember = session.memberBotIds.includes(input.botId) || session.leadBotId === input.botId;
        if (!isMember) {
          throw new Error(`Forbidden: bot ${input.botId} is not a member of session ${input.sessionId}`);
        }

        if (this.router) {
          // 延时唤醒：在 Hub 上创建 once 触发器，到点再触发推理回合
          if (typeof input.delaySeconds === 'number' && Number.isFinite(input.delaySeconds) && input.delaySeconds > 0) {
            const ownerRow = this.db.db.prepare('SELECT owner_id FROM sessions WHERE id = ?').get(input.sessionId) as
              | { owner_id: string | null }
              | undefined;
            const ownerId = ownerRow?.owner_id ?? 'user_admin';
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
        const bot = this.db.getBot(input.botId);
        if (!bot || bot.nodeId !== nodeId) {
          throw new Error(`Forbidden: bot ${input.botId} does not belong to node ${nodeId}`);
        }

        const session = this.db.getSession(input.sessionId);
        if (!session) {
          throw new Error(`Session ${input.sessionId} not found`);
        }

        const isMember = session.memberBotIds.includes(input.botId) || session.leadBotId === input.botId;
        if (!isMember) {
          throw new Error(`Forbidden: bot ${input.botId} is not a member of session ${input.sessionId}`);
        }

        if (!this.router?.requestHumanInput) {
          throw new Error('Interactive human input is not supported by router');
        }

        return await this.router.requestHumanInput(input);
      },

      uploadArtifact: async (input) => {
        if (this.artifactHandler) {
          return await this.artifactHandler.uploadArtifact(input);
        }

        const session = this.db.getSession(input.sessionId);
        if (!session) {
          throw new Error(`Session ${input.sessionId} not found`);
        }

        if (input.botId) {
          const bot = this.db.getBot(input.botId);
          if (!bot || bot.nodeId !== nodeId) {
            throw new Error(`Forbidden: bot ${input.botId} does not belong to node ${nodeId}`);
          }
          const isMember = session.memberBotIds.includes(input.botId) || session.leadBotId === input.botId;
          if (!isMember) {
            throw new Error(`Forbidden: bot ${input.botId} is not a member of session ${input.sessionId}`);
          }
        }

        const artifactId = `art_${randomUUID()}`;
        const buffer = Buffer.from(input.contentBase64, 'base64');
        const sizeBytes = buffer.length;
        const mimeType = input.mimeType || 'application/octet-stream';
        const storageDir = path.join(process.env.BOTD_HUB_DATA_DIR || path.join(os.homedir(), '.botd'), 'artifacts');
        fs.mkdirSync(storageDir, { recursive: true });
        const storagePath = path.join(storageDir, artifactId);
        fs.writeFileSync(storagePath, buffer);

        let artifact: ArtifactRecord;
        if (typeof (this.db as any).createArtifact === 'function') {
          artifact = (this.db as any).createArtifact({
            id: artifactId,
            sessionId: input.sessionId,
            filename: input.filename,
            mimeType,
            sizeBytes,
            senderBotId: input.botId,
            storagePath,
          });
        } else {
          artifact = {
            id: artifactId,
            sessionId: input.sessionId,
            filename: input.filename,
            mimeType,
            sizeBytes,
            senderBotId: input.botId,
            createdAt: new Date().toISOString(),
          };
        }

        this.sseHub.broadcast(input.sessionId, {
          type: 'artifact_created',
          sessionId: input.sessionId,
          artifact,
        });

        if (input.message) {
          const attachment: MessageAttachment = {
            id: artifact.id,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            url: `/api/artifacts/${artifact.id}`,
          };
          const msg = (this.db as any).createMessage({
            id: `msg_${randomUUID()}`,
            sessionId: input.sessionId,
            role: 'assistant',
            senderBotId: input.botId,
            content: input.message,
            attachments: [attachment],
          });
          this.sseHub.broadcast(input.sessionId, {
            type: 'message_created',
            message: msg.message,
          });
        }

        return artifact;
      },

      downloadArtifact: async (artifactId: string) => {
        if (this.artifactHandler) {
          return await this.artifactHandler.downloadArtifact(artifactId);
        }

        let artifact: ArtifactRecord | undefined;
        let storagePath: string | undefined;

        if (typeof (this.db as any).getArtifactWithStoragePath === 'function') {
          const res = (this.db as any).getArtifactWithStoragePath(artifactId);
          if (res) {
            artifact = res;
            storagePath = res.storagePath;
          }
        }

        if (!storagePath) {
          storagePath = path.join(process.env.BOTD_HUB_DATA_DIR || path.join(os.homedir(), '.botd'), 'artifacts', artifactId);
        }

        if (!fs.existsSync(storagePath)) {
          throw new Error(`Artifact ${artifactId} not found`);
        }

        if (!artifact) {
          const stat = fs.statSync(storagePath);
          artifact = {
            id: artifactId,
            sessionId: '',
            filename: artifactId,
            mimeType: 'application/octet-stream',
            sizeBytes: stat.size,
            createdAt: stat.birthtime.toISOString(),
          };
        }

        const contentBase64 = fs.readFileSync(storagePath).toString('base64');
        return {
          artifact,
          contentBase64,
        };
      },

      listSessionArtifacts: async (sessionId: string) => {
        if (this.artifactHandler) {
          return await this.artifactHandler.listSessionArtifacts(sessionId);
        }

        if (typeof (this.db as any).listSessionArtifacts === 'function') {
          return (this.db as any).listSessionArtifacts(sessionId);
        }

        return [];
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

    const conn: NodeConnection = { nodeId, ws, rpc };
    this.connections.set(nodeId, conn);

    const cleanup = () => {
      if (this.connections.get(nodeId)?.ws === ws) {
        this.connections.delete(nodeId);
        this.db.updateNodeStatus(nodeId, 'offline');
        rpc.$close();
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  getNodeRpc(nodeId: string): BirpcReturn<NodeRpcFunctions, HubRpcFunctions> | undefined {
    return this.connections.get(nodeId)?.rpc;
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

  isNodeOnline(nodeId: string): boolean {
    return this.connections.has(nodeId);
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
    try {
      this.wss.close();
    } catch {
      // ignore
    }
  }
}
