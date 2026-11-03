import type { Context } from 'hono';
import type {
  BotConfig,
  HubRpcFunctions,
  NodeRecord,
  NodeRpcFunctions,
  SessionRecord,
  UserRecord,
} from '@botd/protocol';
import type { BirpcReturn } from 'birpc';
import type { HubDatabase } from './db.js';
import type { NodeConnectionManager } from './ws-hub.js';

export type AuthContext = Context<{ Variables: { user: UserRecord } }>;
export type NodeRpc = BirpcReturn<NodeRpcFunctions, HubRpcFunctions>;

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function requireAdmin(c: AuthContext): Response | null {
  if (c.get('user').role !== 'admin') {
    return c.json({ error: 'Admin only' }, 403);
  }
  return null;
}

export function resolveOwnedNode(
  c: AuthContext,
  db: HubDatabase,
  nodeId: string,
): { ok: true; node: NodeRecord } | { ok: false; response: Response } {
  const node = db.getNode(nodeId);
  if (!node) {
    return { ok: false as const, response: c.json({ error: 'Node not found' }, 404) };
  }
  if (db.getNodeOwner(nodeId) !== c.get('user').id) {
    return { ok: false as const, response: c.json({ error: 'Forbidden' }, 403) };
  }
  return { ok: true as const, node };
}

export function resolveOwnedNodeRpc(
  c: AuthContext,
  db: HubDatabase,
  connections: Pick<NodeConnectionManager, 'getNodeRpc'>,
  nodeId: string,
): { ok: true; node: NodeRecord; rpc: NodeRpc } | { ok: false; response: Response } {
  const nodeRes = resolveOwnedNode(c, db, nodeId);
  if (!nodeRes.ok) return nodeRes;
  const rpc = connections.getNodeRpc(nodeId);
  if (!rpc) {
    return { ok: false as const, response: c.json({ error: 'Node is offline' }, 503) };
  }
  return { ok: true as const, node: nodeRes.node, rpc };
}

/** 鉴权 + 定位归属 BOT：404（不存在）/ 403（非归属）语义与 resolveOwnedNode 一致。 */
export function resolveOwnedBot(
  c: AuthContext,
  db: HubDatabase,
  botId: string,
): { ok: true; bot: BotConfig } | { ok: false; response: Response } {
  const bot = db.getBot(botId);
  if (!bot) {
    return { ok: false as const, response: c.json({ error: 'Bot not found' }, 404) };
  }
  if (db.getNodeOwner(bot.nodeId) !== c.get('user').id) {
    return { ok: false as const, response: c.json({ error: 'Forbidden' }, 403) };
  }
  return { ok: true as const, bot };
}

export function resolveOwnedBotRpc(
  c: AuthContext,
  db: HubDatabase,
  connections: Pick<NodeConnectionManager, 'getNodeRpc'>,
  botId: string,
): { ok: true; bot: BotConfig; rpc: NodeRpc } | { ok: false; response: Response } {
  const botRes = resolveOwnedBot(c, db, botId);
  if (!botRes.ok) return botRes;
  const rpc = connections.getNodeRpc(botRes.bot.nodeId);
  if (!rpc) {
    return { ok: false as const, response: c.json({ error: 'Node is offline' }, 503) };
  }
  return { ok: true as const, bot: botRes.bot, rpc };
}

export function resolveOwnedSession(
  c: AuthContext,
  db: HubDatabase,
  sessionId: string,
): { ok: true; session: SessionRecord } | { ok: false; response: Response } {
  const session = db.getSession(sessionId);
  if (!session) {
    return { ok: false as const, response: c.json({ error: 'Session not found' }, 404) };
  }
  if (!db.canUserAccessSession(sessionId, c.get('user').id)) {
    return { ok: false as const, response: c.json({ error: 'Forbidden' }, 403) };
  }
  return { ok: true as const, session };
}
