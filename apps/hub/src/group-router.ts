import { randomUUID } from 'node:crypto';
import type { MessageRecord, SessionRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { NodeConnectionManager } from './ws-hub.js';
import type { SseHub } from './sse.js';

const MENTION_REGEX = /(?:^|\s)@([a-zA-Z0-9_-]+)/g;
const MAX_RELAY_TURNS = 5;

export class ChainBudget {
  constructor(public remainingRelays: number = MAX_RELAY_TURNS) {}

  consumeRelay(): boolean {
    if (this.remainingRelays > 0) {
      this.remainingRelays--;
      return true;
    }
    return false;
  }
}

export interface QueueItem {
  botId: string;
  chainBudget: ChainBudget;
  wakeupMessage?: string;
  generation: number;
  commandText?: string;
  commandMessageId?: string;
}

export interface SessionRuntimeState {
  sessionId: string;
  queue: QueueItem[];
  isRunning: boolean;
  generation: number;
  activeBotId?: string;
}

export interface SlashCommandParseResult {
  isCommand: boolean;
  targetBotId?: string;
  commandText?: string;
  error?: string;
}

export function parseSlashCommand(content: string, validBotIds: Set<string>): SlashCommandParseResult {
  const trimmed = content.trim();

  const extractValidCommand = (rawCommandPart: string): { commandName: string; commandText: string } | null => {
    if (!rawCommandPart.startsWith('/')) return null;
    const withoutLeadingSlash = rawCommandPart.slice(1);
    const match = withoutLeadingSlash.match(/^([^\s]+)([\s\S]*)$/);
    if (!match) return null;
    const commandName = match[1];
    if (commandName.length === 0 || commandName.includes('/')) {
      return null;
    }
    return { commandName, commandText: rawCommandPart };
  };

  if (trimmed.startsWith('/')) {
    const parsed = extractValidCommand(trimmed);
    if (parsed) {
      return {
        isCommand: true,
        commandText: parsed.commandText,
      };
    }
    return { isCommand: false };
  }

  const leadingMentionsMatch = trimmed.match(/^((?:@[a-zA-Z0-9_-]+\s+)+)(\S[\s\S]*)$/);
  if (leadingMentionsMatch) {
    const mentionsBlock = leadingMentionsMatch[1].trim();
    const rest = leadingMentionsMatch[2].trim();

    const parsed = extractValidCommand(rest);
    if (parsed) {
      const leadingMentions = Array.from(mentionsBlock.matchAll(/@([a-zA-Z0-9_-]+)/g)).map((m) => m[1]);

      if (leadingMentions.length > 1) {
        return {
          isCommand: true,
          error: 'Multiple bot mentions before a command are not allowed',
        };
      }

      const targetBotId = leadingMentions[0];
      if (!validBotIds.has(targetBotId)) {
        return {
          isCommand: true,
          error: `Unknown bot @${targetBotId}`,
        };
      }

      return {
        isCommand: true,
        targetBotId,
        commandText: parsed.commandText,
      };
    }
  }

  return { isCommand: false };
}

export function extractMentions(text: string, validBotIds: Set<string>): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(MENTION_REGEX)) {
    const id = match[1];
    if (validBotIds.has(id) && !result.includes(id)) {
      result.push(id);
    }
  }
  return result;
}

export function formatIncrementalMessages(messages: MessageRecord[]): string {
  return messages
    .map((msg) => {
      const sender = msg.senderBotId ? `@${msg.senderBotId}` : msg.role === 'user' ? 'User' : msg.role;
      return `${sender}: ${msg.content}`;
    })
    .join('\n\n');
}

export function buildGroupContextPrompt(session: SessionRecord): string {
  const members = session.memberBotIds.map((id) => `@${id}`).join(', ');
  let prompt = `## 群聊上下文\n- 会话标题: ${session.title}\n- 会话模式: ${session.mode}\n- 群负责人: @${session.leadBotId}\n- 参与成员: ${members}\n`;
  if (session.mode === 'lead') {
    prompt += `\n你当前处于 Lead 群聊模式。群负责人（@${session.leadBotId}）负责协调对话。如需交由其他成员发言，请在回复中使用 @<botId> 呼叫对方。`;
  } else if (session.mode === 'roundtable') {
    prompt += `\n你当前处于 Roundtable 圆桌讨论模式。如需交由特定成员接力，请在回复中使用 @<botId> 呼叫对方。`;
  } else {
    prompt += `\n你当前处于单聊模式。`;
  }
  return prompt;
}

export class GroupRouter {
  private db: HubDatabase;
  private connections: NodeConnectionManager;
  private sseHub: SseHub;
  private states = new Map<string, SessionRuntimeState>();
  private closed = false;

  constructor(db: HubDatabase, connections: NodeConnectionManager, sseHub: SseHub) {
    this.db = db;
    this.connections = connections;
    this.sseHub = sseHub;
  }

  private getOrCreateState(sessionId: string): SessionRuntimeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        queue: [],
        isRunning: false,
        generation: 0,
        activeBotId: undefined,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  getActiveBotId(sessionId: string): string | undefined {
    const state = this.states.get(sessionId);
    return state?.isRunning ? state.activeBotId : undefined;
  }

  handleUserMessage(
    sessionId: string,
    messageId: string,
    content: string,
    commandInfo?: { commandText: string; targetBotId?: string }
  ): void {
    if (this.closed) return;
    const session = this.db.getSession(sessionId);
    if (!session) return;

    const state = this.getOrCreateState(sessionId);
    const validBotIds = new Set([session.leadBotId, ...session.memberBotIds]);

    const parsedCommand = commandInfo ?? (() => {
      const parsed = parseSlashCommand(content, validBotIds);
      return parsed.isCommand && !parsed.error ? parsed : undefined;
    })();

    let botIdsToQueue: string[];
    let commandText: string | undefined;
    let commandMessageId: string | undefined;

    if (parsedCommand && parsedCommand.commandText) {
      commandText = parsedCommand.commandText;
      commandMessageId = messageId;
      const target = parsedCommand.targetBotId ?? session.leadBotId;
      botIdsToQueue = [target];
    } else {
      const mentions = extractMentions(content, validBotIds);
      if (mentions.length > 0) {
        botIdsToQueue = mentions;
      } else {
        if (session.mode === 'direct' || session.mode === 'lead') {
          botIdsToQueue = [session.leadBotId];
        } else {
          // roundtable: members except leadBotId first, then leadBotId at the end
          const others = session.memberBotIds.filter((id) => id !== session.leadBotId);
          botIdsToQueue = [...others, session.leadBotId];
        }
      }
    }

    const chainBudget = new ChainBudget(MAX_RELAY_TURNS);
    for (const botId of botIdsToQueue) {
      state.queue.push({
        botId,
        chainBudget,
        generation: state.generation,
        commandText,
        commandMessageId,
      });
      commandText = undefined;
      commandMessageId = undefined;
    }

    this.processQueue(sessionId).catch(() => {});
  }

  async handleWakeup(sessionId: string, botId: string, wakeupMessage: string): Promise<void> {
    if (this.closed) throw new Error('Hub is shutting down');
    const session = this.db.getSession(sessionId);
    if (!session) return;

    const state = this.getOrCreateState(sessionId);

    // Insert callback message into DB
    const callbackMsg = this.db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId,
      role: 'callback',
      senderBotId: botId,
      content: `[Wake-up] ${wakeupMessage}`,
    });

    this.sseHub.broadcast(sessionId, {
      type: 'message_created',
      message: callbackMsg.message,
    });

    const chainBudget = new ChainBudget(MAX_RELAY_TURNS);
    state.queue.push({
      botId,
      chainBudget,
      wakeupMessage,
      generation: state.generation,
    });

    this.processQueue(sessionId).catch(() => {});
  }

  async cancelSession(sessionId: string): Promise<void> {
    const state = this.getOrCreateState(sessionId);
    const previousActiveBotId = state.activeBotId;

    // Advance generation so current turn & queued items of this generation are discarded
    state.generation++;
    state.queue = [];
    state.activeBotId = undefined;
    // Keep isRunning unchanged so the owning loop remains the sole execution engine.

    this.db.updateSessionStatus(sessionId, 'idle', undefined);
    this.sseHub.broadcast(sessionId, {
      type: 'session_status',
      sessionId,
      status: 'idle',
      activeBotId: undefined,
    });

    if (previousActiveBotId) {
      const bot = this.db.getBot(previousActiveBotId);
      if (bot) {
        const rpc = this.connections.getNodeRpc(bot.nodeId);
        if (rpc) {
          await rpc.cancelTurn(sessionId, previousActiveBotId).catch(() => {});
        }
      }
    }
  }

  /** 通知会话全部成员所在的节点归档其本地会话文件（best-effort：离线节点/已删除 bot 不阻塞流程） */
  async resetMemberSessions(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) return;

    const memberIds = [...new Set([session.leadBotId, ...session.memberBotIds])];
    const results = await Promise.allSettled(memberIds.map(async (botId) => {
      const bot = this.db.getBot(botId);
      if (!bot) return; // 节点已删除该 bot，跳过
      const rpc = this.connections.getNodeRpc(bot.nodeId);
      if (!rpc) {
        console.warn(`[group-router] resetSession skipped: node ${bot.nodeId} for bot @${botId} is offline`);
        return;
      }
      await rpc.resetSession(sessionId, botId);
    }));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn(`[group-router] resetSession failed for session ${sessionId}:`, result.reason);
      }
    }
  }

  private async processQueue(sessionId: string): Promise<void> {
    const state = this.getOrCreateState(sessionId);
    if (state.isRunning) return;

    state.isRunning = true;

    try {
      while (!this.closed && state.queue.length > 0) {
        const item = state.queue.shift()!;
        if (item.generation !== state.generation) continue;

        const session = this.db.getSession(sessionId);
        if (!session) break;

        const bot = this.db.getBot(item.botId);
        if (!bot) {
          const sysMsg = this.db.createMessage({
            id: `msg_${randomUUID()}`,
            sessionId,
            role: 'system',
            content: `Bot @${item.botId} not found.`,
          });
          this.sseHub.broadcast(sessionId, { type: 'message_created', message: sysMsg.message });
          this.db.updateSessionStatus(sessionId, 'failed', undefined);
          this.sseHub.broadcast(sessionId, { type: 'session_status', sessionId, status: 'failed', activeBotId: undefined });
          state.queue = [];
          break;
        }

        const rpc = this.connections.getNodeRpc(bot.nodeId);
        if (!rpc) {
          const sysMsg = this.db.createMessage({
            id: `msg_${randomUUID()}`,
            sessionId,
            role: 'system',
            content: `Node for bot @${item.botId} is offline or unavailable.`,
          });
          this.sseHub.broadcast(sessionId, { type: 'message_created', message: sysMsg.message });
          this.db.updateSessionStatus(sessionId, 'failed', undefined);
          this.sseHub.broadcast(sessionId, { type: 'session_status', sessionId, status: 'failed', activeBotId: undefined });
          state.queue = [];
          break;
        }

        state.activeBotId = item.botId;
        this.db.updateSessionStatus(sessionId, 'running', item.botId);
        this.sseHub.broadcast(sessionId, {
          type: 'session_status',
          sessionId,
          status: 'running',
          activeBotId: item.botId,
        });

        const lastRowid = session.cursorMap[item.botId] ?? 0;
        const rawIncResult = this.db.getIncrementalMessages(sessionId, lastRowid);
        // Filter out bot's own already-persisted assistant output,
        // and filter out the current user command message from formatted history if commandText is being passed separately
        const incResult = rawIncResult.filter(
          (r) => !(r.message.role === 'assistant' && r.message.senderBotId === item.botId) &&
                 !(item.commandMessageId && r.message.id === item.commandMessageId)
        );
        const incrementalText = formatIncrementalMessages(incResult.map((r) => r.message));
        // Snapshot max delivered rowid at the time of building the input
        const deliveredSnapshotRowid =
          rawIncResult.length > 0 ? Math.max(...rawIncResult.map((r) => r.rowid)) : lastRowid;

        const groupContextPrompt = buildGroupContextPrompt(session);
        const turnGen = state.generation;

        let turnResult: { replyText: string; modelBadge: string };
        try {
          turnResult = await rpc.runTurn({
            sessionId,
            botId: item.botId,
            groupContextPrompt,
            incrementalMessages: incrementalText,
            ...(item.commandText ? { commandText: item.commandText } : {}),
          });
        } catch (err: any) {
          if (turnGen !== state.generation) {
            // Cancelled during execution - continue loop to drain new items if any
            continue;
          }
          const errorText = err?.message || String(err);
          const sysMsg = this.db.createMessage({
            id: `msg_${randomUUID()}`,
            sessionId,
            role: 'system',
            content: `Error executing turn for @${item.botId}: ${errorText}`,
          });
          this.sseHub.broadcast(sessionId, { type: 'message_created', message: sysMsg.message });
          this.db.updateSessionStatus(sessionId, 'failed', undefined);
          this.sseHub.broadcast(sessionId, { type: 'session_status', sessionId, status: 'failed', activeBotId: undefined });
          state.queue = [];
          break;
        }

        // Suppress late reply if turn was cancelled while executing
        if (turnGen !== state.generation) {
          continue;
        }

        const validBotIds = new Set([session.leadBotId, ...session.memberBotIds]);
        const replyMentions = extractMentions(turnResult.replyText, validBotIds);

        // Check if new public rows arrived during turn execution
        const maxRowidBeforeInsert = this.db.getMaxMessageRowid(sessionId);

        const newMsg = this.db.createMessage({
          id: `msg_${randomUUID()}`,
          sessionId,
          role: 'assistant',
          senderBotId: item.botId,
          modelBadge: turnResult.modelBadge,
          content: turnResult.replyText,
          mentions: replyMentions,
        });

        // Advance cursor through delivered rows if unseen public rows arrived; else advance to reply rowid
        if (maxRowidBeforeInsert > deliveredSnapshotRowid) {
          this.db.updateSessionCursor(sessionId, item.botId, deliveredSnapshotRowid);
        } else {
          this.db.updateSessionCursor(sessionId, item.botId, Math.max(deliveredSnapshotRowid, newMsg.rowid));
        }

        this.sseHub.broadcast(sessionId, {
          type: 'message_created',
          message: newMsg.message,
        });

        // Relay budget shared across the chain
        if (replyMentions.length > 0) {
          for (const nextBotId of replyMentions) {
            if (item.chainBudget.consumeRelay()) {
              state.queue.push({
                botId: nextBotId,
                chainBudget: item.chainBudget,
                generation: state.generation,
              });
            }
          }
        }
      }
    } finally {
      state.isRunning = false;
      state.activeBotId = undefined;

      // If new items were queued during finalization, resume processing
      if (this.closed) {
        state.queue = [];
      } else if (state.queue.length > 0) {
        this.processQueue(sessionId).catch(() => {});
      } else {
        const cur = this.db.getSession(sessionId);
        if (cur && cur.status === 'running') {
          this.db.updateSessionStatus(sessionId, 'idle', undefined);
          this.sseHub.broadcast(sessionId, {
            type: 'session_status',
            sessionId,
            status: 'idle',
            activeBotId: undefined,
          });
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const state of this.states.values()) {
      state.generation++;
      state.queue = [];
      state.activeBotId = undefined;
    }
    this.states.clear();
  }
}
