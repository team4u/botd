import { randomUUID } from 'node:crypto';
import type {
  MessageAttachment,
  MessageRecord,
  PendingAskRecord,
  SessionRecord,
  ToolCallRecord,
  TurnUsage,
} from '@botd/protocol';
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
  parallelGroupId?: string;
  replyToBotId?: string;
}

export interface SessionRuntimeState {
  sessionId: string;
  queue: QueueItem[];
  isRunning: boolean;
  generation: number;
  activeBotId?: string;
  activeBotIds: Set<string>;
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
  private pendingAsks = new Map<
    string,
    {
      record: PendingAskRecord;
      resolve: (answer: string) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
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
        activeBotIds: new Set<string>(),
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  getActiveBotId(sessionId: string): string | undefined {
    const state = this.states.get(sessionId);
    if (!state?.isRunning) return undefined;
    return state.activeBotId ?? (state.activeBotIds.size > 0 ? Array.from(state.activeBotIds)[0] : undefined);
  }

  isBotActiveInSession(sessionId: string, botId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state || !state.isRunning) return false;
    return state.activeBotId === botId || state.activeBotIds.has(botId);
  }

  onNodeOnline(nodeId: string): void {
    if (this.closed) return;
    for (const [sessionId, state] of this.states.entries()) {
      if (state.queue.length > 0 && !state.isRunning) {
        const frontItem = state.queue[0];
        const batch = frontItem.parallelGroupId
          ? state.queue.filter((item) => item.parallelGroupId === frontItem.parallelGroupId)
          : [frontItem];
        const anyBelongsToNode = batch.some((item) => {
          const bot = this.db.getBot(item.botId);
          return bot && bot.nodeId === nodeId;
        });
        if (anyBelongsToNode) {
          this.processQueue(sessionId).catch(() => {});
        }
      }
    }
  }

  async requestHumanInput(input: {
    sessionId: string;
    botId: string;
    prompt: string;
    options?: string[];
    timeoutSeconds?: number;
  }): Promise<{ answer: string }> {
    if (this.closed) throw new Error('Hub is shutting down');
    const session = this.db.getSession(input.sessionId);
    if (!session) throw new Error(`Session ${input.sessionId} not found`);

    const askId = `ask_${randomUUID()}`;
    const now = new Date();
    const timeoutSec = input.timeoutSeconds && input.timeoutSeconds > 0 ? input.timeoutSeconds : 300;
    const expiresAt = new Date(now.getTime() + timeoutSec * 1000).toISOString();

    const record: PendingAskRecord = {
      id: askId,
      sessionId: input.sessionId,
      botId: input.botId,
      prompt: input.prompt,
      options: input.options ?? [],
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt,
    };

    return new Promise<{ answer: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pendingAsks.get(askId);
        if (entry) {
          entry.record.status = 'expired';
          this.pendingAsks.delete(askId);
          entry.reject(new Error(`Interactive ask timed out after ${timeoutSec}s`));
        }
      }, timeoutSec * 1000);

      this.pendingAsks.set(askId, {
        record,
        resolve: (ans: string) => resolve({ answer: ans }),
        reject,
        timer,
      });

      this.sseHub.broadcast(input.sessionId, {
        type: 'interaction_request',
        sessionId: input.sessionId,
        ask: record,
      });
    });
  }

  getPendingAsks(sessionId: string): PendingAskRecord[] {
    const result: PendingAskRecord[] = [];
    for (const entry of this.pendingAsks.values()) {
      if (entry.record.sessionId === sessionId && entry.record.status === 'pending') {
        result.push(entry.record);
      }
    }
    return result;
  }

  respondToAsk(sessionId: string, askId: string, answer: string): PendingAskRecord | undefined {
    const entry = this.pendingAsks.get(askId);
    if (!entry || entry.record.sessionId !== sessionId) return undefined;
    if (entry.record.status !== 'pending') return undefined;

    clearTimeout(entry.timer);
    entry.record.status = 'answered';
    entry.record.answer = answer;
    this.pendingAsks.delete(askId);

    entry.resolve(answer);

    this.sseHub.broadcast(sessionId, {
      type: 'interaction_resolved',
      sessionId,
      askId,
      answer,
    });

    return entry.record;
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
          if (Boolean((session as any).parallelRoundtable) && others.length > 0) {
            const parallelGroupId = `pg_${randomUUID()}`;
            const chainBudget = new ChainBudget(MAX_RELAY_TURNS);
            for (const botId of others) {
              state.queue.push({
                botId,
                chainBudget,
                generation: state.generation,
                parallelGroupId,
              });
            }
            state.queue.push({
              botId: session.leadBotId,
              chainBudget: new ChainBudget(MAX_RELAY_TURNS),
              generation: state.generation,
            });
            this.processQueue(sessionId).catch(() => {});
            return;
          }
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

  async handleWakeup(
    sessionId: string,
    botId: string,
    wakeupMessage: string,
    replyToBotId?: string,
    options?: { noTurn?: boolean }
  ): Promise<void> {
    if (this.closed) throw new Error('Hub is shutting down');
    const session = this.db.getSession(sessionId);
    if (!session) return;

    const state = this.getOrCreateState(sessionId);
    const validBotIds = new Set([session.leadBotId, ...session.memberBotIds]);

    const isValidReplyTo = replyToBotId && validBotIds.has(replyToBotId);
    let callbackContent = `[Wake-up] ${wakeupMessage}`;
    if (isValidReplyTo && !wakeupMessage.includes(`@${replyToBotId}`)) {
      callbackContent += ` (cc @${replyToBotId})`;
    }

    const mentions = extractMentions(callbackContent, validBotIds);

    // Insert callback message into DB
    const callbackMsg = (this.db as any).createMessage({
      id: `msg_${randomUUID()}`,
      sessionId,
      role: 'callback',
      senderBotId: botId,
      content: callbackContent,
      mentions,
    });

    this.sseHub.broadcast(sessionId, {
      type: 'message_created',
      message: callbackMsg.message,
    });

    // 静默唤醒：仅落库并广播公屏，不触发大模型推理回合
    if (options?.noTurn === true) {
      return;
    }

    const chainBudget = new ChainBudget(MAX_RELAY_TURNS);
    state.queue.push({
      botId,
      chainBudget,
      wakeupMessage,
      generation: state.generation,
      replyToBotId: isValidReplyTo ? replyToBotId : undefined,
    });

    this.processQueue(sessionId).catch(() => {});
  }

  async cancelSession(sessionId: string): Promise<void> {
    const state = this.getOrCreateState(sessionId);
    const activeBotsToCancel = new Set<string>();
    if (state.activeBotId) activeBotsToCancel.add(state.activeBotId);
    for (const b of state.activeBotIds) activeBotsToCancel.add(b);

    // Reject any pending asks
    for (const [askId, entry] of this.pendingAsks.entries()) {
      if (entry.record.sessionId === sessionId) {
        clearTimeout(entry.timer);
        this.pendingAsks.delete(askId);
        entry.reject(new Error('Session cancelled'));
      }
    }

    // Advance generation so current turn & queued items of this generation are discarded
    state.generation++;
    state.queue = [];
    state.activeBotId = undefined;
    state.activeBotIds.clear();
    // Keep isRunning unchanged so the owning loop remains the sole execution engine.

    this.db.updateSessionStatus(sessionId, 'idle', undefined);
    this.sseHub.broadcast(sessionId, {
      type: 'session_status',
      sessionId,
      status: 'idle',
      activeBotId: undefined,
    });

    for (const botId of activeBotsToCancel) {
      const bot = this.db.getBot(botId);
      if (bot) {
        const rpc = this.connections.getNodeRpc(bot.nodeId);
        if (rpc) {
          await rpc.cancelTurn(sessionId, botId).catch(() => {});
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
        const frontItem = state.queue[0];
        if (frontItem.parallelGroupId) {
          const groupId = frontItem.parallelGroupId;
          const batch: QueueItem[] = [];
          while (state.queue.length > 0 && state.queue[0].parallelGroupId === groupId) {
            batch.push(state.queue.shift()!);
          }
          const validBatch = batch.filter((item) => item.generation === state.generation);
          if (validBatch.length === 0) continue;

          const session = this.db.getSession(sessionId);
          if (!session) break;

          let missingBotId: string | undefined;
          for (const it of validBatch) {
            if (!this.db.getBot(it.botId)) {
              missingBotId = it.botId;
              break;
            }
          }
          if (missingBotId) {
            const sysMsg = (this.db as any).createMessage({
              id: `msg_${randomUUID()}`,
              sessionId,
              role: 'system',
              content: `Bot @${missingBotId} not found.`,
            });
            this.sseHub.broadcast(sessionId, { type: 'message_created', message: sysMsg.message });
            this.db.updateSessionStatus(sessionId, 'failed', undefined);
            this.sseHub.broadcast(sessionId, { type: 'session_status', sessionId, status: 'failed', activeBotId: undefined });
            state.queue = [];
            break;
          }

          let anyOffline = false;
          for (const it of validBatch) {
            const bot = this.db.getBot(it.botId)!;
            const rpc = this.connections.getNodeRpc(bot.nodeId);
            if (!rpc) {
              anyOffline = true;
              break;
            }
          }
          if (anyOffline) {
            state.queue.unshift(...validBatch);
            this.db.updateSessionStatus(sessionId, 'queued', undefined);
            this.sseHub.broadcast(sessionId, {
              type: 'session_status',
              sessionId,
              status: 'queued',
              activeBotId: undefined,
            });
            break;
          }

          state.activeBotIds = new Set(validBatch.map((item) => item.botId));
          state.activeBotId = validBatch[0].botId;
          this.db.updateSessionStatus(sessionId, 'running', state.activeBotId);
          this.sseHub.broadcast(sessionId, {
            type: 'session_status',
            sessionId,
            status: 'running',
            activeBotId: state.activeBotId,
          });

          const groupContextPrompt = buildGroupContextPrompt(session);
          const turnGen = state.generation;

          // Snapshot incremental messages for each bot BEFORE any turn starts (Blind Review)
          const preparedItems = validBatch.map((item) => {
            const lastRowid = session.cursorMap[item.botId] ?? 0;
            const rawIncResult = this.db.getIncrementalMessages(sessionId, lastRowid);
            const incResult = rawIncResult.filter(
              (r) => !(r.message.role === 'assistant' && r.message.senderBotId === item.botId) &&
                     !(item.commandMessageId && r.message.id === item.commandMessageId)
            );
            const incrementalText = formatIncrementalMessages(incResult.map((r) => r.message));
            const deliveredSnapshotRowid =
              rawIncResult.length > 0 ? Math.max(...rawIncResult.map((r) => r.rowid)) : lastRowid;
            const attachments = incResult.flatMap((r) => r.message.attachments ?? []);
            const bot = this.db.getBot(item.botId)!;
            const rpc = this.connections.getNodeRpc(bot.nodeId)!;
            return {
              item,
              bot,
              rpc,
              incrementalText,
              deliveredSnapshotRowid,
              attachments,
            };
          });

          await Promise.all(
            preparedItems.map(async (prep) => {
              const { item, rpc } = prep;
              let turnResult: { replyText: string; modelBadge: string; toolCalls?: ToolCallRecord[]; usage?: TurnUsage };
              try {
                turnResult = await rpc.runTurn({
                  sessionId,
                  botId: item.botId,
                  groupContextPrompt,
                  incrementalMessages: prep.incrementalText,
                  ...(item.commandText ? { commandText: item.commandText } : {}),
                  ...(prep.attachments.length > 0 ? { attachments: prep.attachments } : {}),
                });
              } catch (err: any) {
                if (turnGen !== state.generation) return;
                const errorText = err?.message || String(err);
                const sysMsg = (this.db as any).createMessage({
                  id: `msg_${randomUUID()}`,
                  sessionId,
                  role: 'system',
                  content: `Error executing turn for @${item.botId}: ${errorText}`,
                });
                this.sseHub.broadcast(sessionId, { type: 'message_created', message: sysMsg.message });
                return;
              }

              if (turnGen !== state.generation) return;

              const validBotIds = new Set([session.leadBotId, ...session.memberBotIds]);
              const replyMentions = extractMentions(turnResult.replyText, validBotIds);
              const maxRowidBeforeInsert = this.db.getMaxMessageRowid(sessionId);

              const newMsg = (this.db as any).createMessage({
                id: `msg_${randomUUID()}`,
                sessionId,
                role: 'assistant',
                senderBotId: item.botId,
                modelBadge: turnResult.modelBadge,
                content: turnResult.replyText,
                mentions: replyMentions,
                toolCalls: turnResult.toolCalls,
                usage: turnResult.usage,
              });

              if (maxRowidBeforeInsert > prep.deliveredSnapshotRowid) {
                this.db.updateSessionCursor(sessionId, item.botId, prep.deliveredSnapshotRowid);
              } else {
                this.db.updateSessionCursor(sessionId, item.botId, Math.max(prep.deliveredSnapshotRowid, newMsg.rowid));
              }

              this.sseHub.broadcast(sessionId, {
                type: 'message_created',
                message: {
                  ...newMsg.message,
                  ...(turnResult.toolCalls ? { toolCalls: turnResult.toolCalls } : {}),
                  ...(turnResult.usage ? { usage: turnResult.usage } : {}),
                },
              });

              if (item.replyToBotId && !replyMentions.includes(item.replyToBotId)) {
                if (item.chainBudget.consumeRelay()) {
                  state.queue.push({
                    botId: item.replyToBotId,
                    chainBudget: item.chainBudget,
                    generation: state.generation,
                  });
                }
              }

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
            })
          );

          state.activeBotIds.clear();
          state.activeBotId = undefined;
          continue;
        }

        const item = state.queue.shift()!;
        if (item.generation !== state.generation) continue;

        const session = this.db.getSession(sessionId);
        if (!session) break;

        const bot = this.db.getBot(item.botId);
        if (!bot) {
          const sysMsg = (this.db as any).createMessage({
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
          state.queue.unshift(item);
          this.db.updateSessionStatus(sessionId, 'queued', undefined);
          this.sseHub.broadcast(sessionId, { type: 'session_status', sessionId, status: 'queued', activeBotId: undefined });
          break;
        }

        state.activeBotId = item.botId;
        state.activeBotIds = new Set([item.botId]);
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
        const attachments = incResult.flatMap((r) => r.message.attachments ?? []);

        const groupContextPrompt = buildGroupContextPrompt(session);
        const turnGen = state.generation;

        let turnResult: { replyText: string; modelBadge: string; toolCalls?: ToolCallRecord[]; usage?: TurnUsage };
        try {
          turnResult = await rpc.runTurn({
            sessionId,
            botId: item.botId,
            groupContextPrompt,
            incrementalMessages: incrementalText,
            ...(item.commandText ? { commandText: item.commandText } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          });
        } catch (err: any) {
          if (turnGen !== state.generation) {
            // Cancelled during execution - continue loop to drain new items if any
            continue;
          }
          const errorText = err?.message || String(err);
          const sysMsg = (this.db as any).createMessage({
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

        const newMsg = (this.db as any).createMessage({
          id: `msg_${randomUUID()}`,
          sessionId,
          role: 'assistant',
          senderBotId: item.botId,
          modelBadge: turnResult.modelBadge,
          content: turnResult.replyText,
          mentions: replyMentions,
          toolCalls: turnResult.toolCalls,
          usage: turnResult.usage,
        });

        // Advance cursor through delivered rows if unseen public rows arrived; else advance to reply rowid
        if (maxRowidBeforeInsert > deliveredSnapshotRowid) {
          this.db.updateSessionCursor(sessionId, item.botId, deliveredSnapshotRowid);
        } else {
          this.db.updateSessionCursor(sessionId, item.botId, Math.max(deliveredSnapshotRowid, newMsg.rowid));
        }

        this.sseHub.broadcast(sessionId, {
          type: 'message_created',
          message: {
            ...newMsg.message,
            ...(turnResult.toolCalls ? { toolCalls: turnResult.toolCalls } : {}),
            ...(turnResult.usage ? { usage: turnResult.usage } : {}),
          },
        });

        if (item.replyToBotId && !replyMentions.includes(item.replyToBotId)) {
          if (item.chainBudget.consumeRelay()) {
            state.queue.push({
              botId: item.replyToBotId,
              chainBudget: item.chainBudget,
              generation: state.generation,
            });
          }
        }

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
      state.activeBotIds.clear();

      // If new items were queued during finalization, resume processing
      if (this.closed) {
        state.queue = [];
      } else if (state.queue.length > 0) {
        const cur = this.db.getSession(sessionId);
        if (cur && cur.status !== 'queued') {
          this.processQueue(sessionId).catch(() => {});
        }
      } else {
        const cur = this.db.getSession(sessionId);
        if (cur && (cur.status === 'running' || cur.status === 'queued')) {
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
    for (const [askId, entry] of this.pendingAsks.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Hub closed'));
    }
    this.pendingAsks.clear();

    for (const state of this.states.values()) {
      state.generation++;
      state.queue = [];
      state.activeBotId = undefined;
      state.activeBotIds.clear();
    }
    this.states.clear();
  }
}
