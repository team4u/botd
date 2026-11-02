import { randomUUID } from 'node:crypto';
import {
  validateUiSpec,
  type AskPreviewType,
  type IncomingArtifactRef,
  type MessageRecord,
  type PendingAskRecord,
  type QueueStageSummary,
  type SessionRecord,
  type SubagentRunRecord,
  type ToolCallRecord,
  type TurnBlock,
  type TurnUsage,
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
  stageId?: string;
  loopGroupId?: string;
  whisperTargetBotIds?: string[];
  dispatchedByBotId?: string;
}

export interface PreparedTurnItem {
  item: QueueItem;
  bot: NonNullable<ReturnType<HubDatabase['getBot']>>;
  rpc: NonNullable<ReturnType<NodeConnectionManager['getNodeRpc']>>;
  incrementalText: string;
  deliveredSnapshotRowid: number;
  attachments: NonNullable<MessageRecord['attachments']>;
  incomingArtifacts: IncomingArtifactRef[];
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

export function extractBotRoutingDirective(text: string): { directive: string; plan: string } | null {
  const lines = text.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/^(?:->|ROUTE:)\s*(.*)$/);
    if (match) {
      return {
        directive: line,
        plan: match[1].trim(),
      };
    }
    break;
  }
  return null;
}

export function parseOrchestrationPlan(
  plan: string,
  validBotIds: Set<string>,
  session: SessionRecord,
  options?: {
    chainBudget?: ChainBudget;
    generation?: number;
    dispatchedByBotId?: string;
  }
): QueueItem[] {
  const trimmed = plan.trim();
  if (!trimmed || trimmed === '@none' || trimmed.startsWith('@none')) return [];

  // Split by -> but not <->
  const rawStages = trimmed.split(/(?<!<)->/).map((s) => s.trim()).filter(Boolean);
  if (rawStages.length === 0) return [];

  const items: QueueItem[] = [];
  const generation = options?.generation ?? 0;
  const chainBudget = options?.chainBudget ?? new ChainBudget(MAX_RELAY_TURNS);

  for (const rawStage of rawStages) {
    const stageId = `stage_${randomUUID()}`;

    // 1. Check for @all
    if (rawStage === '@all') {
      const nonLeadMembers = session.memberBotIds.filter((id) => id !== session.leadBotId && validBotIds.has(id));
      if (nonLeadMembers.length > 0) {
        const parallelGroupId = `pg_${randomUUID()}`;
        for (const botId of nonLeadMembers) {
          items.push({
            botId,
            chainBudget,
            generation,
            parallelGroupId,
            stageId,
            ...(options?.dispatchedByBotId ? { dispatchedByBotId: options.dispatchedByBotId } : {}),
          });
        }
      }
      if (validBotIds.has(session.leadBotId)) {
        items.push({
          botId: session.leadBotId,
          chainBudget,
          generation,
          stageId: `stage_${randomUUID()}`,
          ...(options?.dispatchedByBotId ? { dispatchedByBotId: options.dispatchedByBotId } : {}),
        });
      }
      continue;
    }

    // 2. Parallel group: (@botA @botB ...)
    const parenMatch = rawStage.match(/^\(([^)]+)\)$/);
    if (parenMatch) {
      const inner = parenMatch[1];
      const botMentions = extractMentions(inner, validBotIds);
      if (botMentions.length > 0) {
        const parallelGroupId = `pg_${randomUUID()}`;
        for (const botId of botMentions) {
          items.push({
            botId,
            chainBudget,
            generation,
            parallelGroupId,
            stageId,
            ...(options?.dispatchedByBotId ? { dispatchedByBotId: options.dispatchedByBotId } : {}),
          });
        }
      }
      continue;
    }

    // 3. Maker-Checker loop: @botA <-> @botB [* N]
    if (rawStage.includes('<->')) {
      const parts = rawStage.split('<->').map((p) => p.trim());
      if (parts.length >= 2) {
        const botAMentions = extractMentions(parts[0], validBotIds);
        let roundCount = 2;
        const starMatch = parts[1].match(/\*\s*(\d+)/);
        if (starMatch) {
          roundCount = Math.min(Math.max(1, parseInt(starMatch[1], 10) || 2), 4);
        }
        const botBMentions = extractMentions(parts[1].replace(/\*\s*\d+/, ''), validBotIds);

        const botA = botAMentions[0];
        const botB = botBMentions[0];
        if (botA && botB) {
          const loopGroupId = `loop_${randomUUID()}`;
          for (let r = 0; r < roundCount; r++) {
            items.push({
              botId: botA,
              chainBudget,
              generation,
              loopGroupId,
              stageId,
              ...(options?.dispatchedByBotId ? { dispatchedByBotId: options.dispatchedByBotId } : {}),
            });
            items.push({
              botId: botB,
              chainBudget,
              generation,
              loopGroupId,
              stageId,
              ...(options?.dispatchedByBotId ? { dispatchedByBotId: options.dispatchedByBotId } : {}),
            });
          }
        }
      }
      continue;
    }

    // 4. Whisper sub-thread: @botA >> @botB
    if (rawStage.includes('>>')) {
      const parts = rawStage.split('>>').map((p) => p.trim());
      if (parts.length >= 2) {
        const botAMentions = extractMentions(parts[0], validBotIds);
        const botBMentions = extractMentions(parts[1], validBotIds);
        const botA = botAMentions[0];
        const botB = botBMentions[0];
        if (botA && botB) {
          const whisperTargetBotIds = [botA, botB];
          items.push({
            botId: botA,
            chainBudget,
            generation,
            whisperTargetBotIds,
            stageId,
            ...(options?.dispatchedByBotId ? { dispatchedByBotId: options.dispatchedByBotId } : {}),
          });
          items.push({
            botId: botB,
            chainBudget,
            generation,
            whisperTargetBotIds,
            stageId,
            ...(options?.dispatchedByBotId ? { dispatchedByBotId: options.dispatchedByBotId } : {}),
          });
        }
      }
      continue;
    }

    // 5. Single or multiple serial mentions
    const botMentions = extractMentions(rawStage, validBotIds);
    for (const botId of botMentions) {
      items.push({
        botId,
        chainBudget,
        generation,
        stageId,
        ...(options?.dispatchedByBotId ? { dispatchedByBotId: options.dispatchedByBotId } : {}),
      });
    }
  }

  return items;
}

export function formatIncrementalMessages(messages: MessageRecord[]): string {
  return messages
    .map((msg) => {
      const sender = msg.senderBotId ? `@${msg.senderBotId}` : msg.role === 'user' ? 'User' : msg.role;
      return `${sender}: ${msg.content}`;
    })
    .join('\n\n');
}

export function buildGroupContextPrompt(
  session: SessionRecord,
  db?: HubDatabase,
  currentBotId?: string
): string {
  let prompt = '';
  if (session.blackboard && session.blackboard.trim().length > 0) {
    prompt += `## 📌 群备忘录 (Shared Blackboard)\n${session.blackboard.trim()}\n\n`;
  }
  const members = session.memberBotIds.map((id) => `@${id}`).join(', ');
  prompt += `## 群聊上下文\n- 会话标题: ${session.title}\n- 会话模式: ${session.mode}\n- 群负责人: @${session.leadBotId}\n- 参与成员: ${members}\n`;

  if (db) {
    prompt += '\n### 成员列表与角色\n';
    const allMemberIds = [session.leadBotId, ...session.memberBotIds.filter((id) => id !== session.leadBotId)];
    for (const memberId of allMemberIds) {
      const bot = db.getBot(memberId);
      const role = session.memberRoles?.[memberId];
      const roleStr = role ? ` | 本群头衔: 【${role}】` : '';
      const desc = bot?.description ? ` - ${bot.description}` : '';
      const skills = bot?.enabledSkills?.length ? ` (技能: ${bot.enabledSkills.join(', ')})` : '';
      prompt += `- @${memberId} (${bot?.name || memberId}${roleStr})${desc}${skills}\n`;
    }
  }

  if (currentBotId && session.memberRoles?.[currentBotId]) {
    prompt += `\n🎭 你在本群的专属头衔/角色是：【${session.memberRoles[currentBotId]}】，请严格代入该视角发言。\n`;
  }

  // 分身感知：列出当前 BOT 麾下的角色分身（单聊与群聊均注入），让主 BOT 知道自己能调度谁。
  const mySubagents = db && currentBotId
    ? db.getAllBots().filter((b) => b.parentBotId === currentBotId)
    : [];
  if (mySubagents.length > 0) {
    prompt += '\n### ⚡ 你的角色分身 (Subagents)\n';
    for (const sub of mySubagents) {
      const tags: string[] = [];
      if (sub.inheritModel) tags.push('跟随主模型');
      else if (sub.modelId) tags.push(sub.modelId);
      if (sub.toolScope === 'readonly') tags.push('只读');
      if (sub.isolation === 'worktree') tags.push('worktree隔离');
      prompt += `- @${sub.id} (${sub.name}${sub.description ? ` - ${sub.description}` : ''}${tags.length ? ` [${tags.join(' · ')}]` : ''})\n`;
    }
    prompt +=
      '你可以用 Agent 工具（subagent_type 填分身 id）或 SubagentWorkflow 工具调度上述分身并发/串行干活；\n' +
      '也可以在群聊回复尾部输出单行编排指令 \'-> ...\' 让 Hub 跨会话接力调度。\n';
  }

  if (session.mode === 'lead') {
    prompt += `\n你当前处于 Lead 群聊模式。群负责人（@${session.leadBotId}）负责协调对话。如需交由其他成员发言，请在回复中使用 @<botId> 呼叫对方。`;
  } else {
    prompt += `\n你当前处于单聊模式。`;
  }

  const isLead = currentBotId === session.leadBotId;
  const hasSubagents = mySubagents.length > 0;
  if (session.mode !== 'direct' && (isLead || hasSubagents)) {
    prompt +=
      `\n\n### 编排指令与共享黑板说明\n` +
      `你可以通过在回复尾部输出单行编排指令来调度工作流（将覆盖默认的 @mention 转发）：\n` +
      `- 并行聚合: \`-> (@botA @botB) -> @${session.leadBotId}\`\n` +
      `- 串行流水线: \`-> @botA -> @botB -> @${session.leadBotId}\`\n` +
      `- 双人对抗/审查循环: \`-> @botA <-> @botB -> @${session.leadBotId}\` (或 \`*N\` 次循环)\n` +
      `- 私密子线程耳语: \`-> @botA >> @botB -> @${session.leadBotId}\`\n` +
      `- 终止唤醒: \`-> @none\`\n` +
      `如需更新共享备忘录，请在回复中包含如下代码块：\n` +
      `\`\`\`blackboard\n[最新共识/进展/待办]\n\`\`\``;
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
      timer?: NodeJS.Timeout;
    }
  >();
  private closed = false;
  private draining = false;

  constructor(db: HubDatabase, connections: NodeConnectionManager, sseHub: SseHub) {
    this.db = db;
    this.connections = connections;
    this.sseHub = sseHub;
  }

  isDraining(): boolean {
    return this.draining;
  }

  getActiveTurnCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.isRunning) {
        count++;
      }
    }
    return count;
  }

  async drain(timeoutMs = 30_000): Promise<{ drained: boolean; remaining: number }> {
    this.draining = true;
    for (const [sessionId, state] of this.states.entries()) {
      state.queue = [];
      if (!state.isRunning) {
        const cur = this.db.getSession(sessionId);
        if (cur && cur.status === 'queued') {
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

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const remaining = this.getActiveTurnCount();
      if (remaining === 0) {
        return { drained: true, remaining: 0 };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const remaining = this.getActiveTurnCount();
    return { drained: remaining === 0, remaining };
  }

  private getSessionOwner(sessionId: string, _session?: SessionRecord): string | undefined {
    return this.db.getSessionOwner(sessionId);
  }

  canRunBot(sessionId: string, botId: string): boolean {
    const session = this.db.getSession(sessionId);
    const bot = this.db.getBot(botId);
    if (!session || !bot) return false;
    const sessionMembers = [session.leadBotId, ...session.memberBotIds];
    let isMember = sessionMembers.includes(botId);
    if (!isMember && bot.parentBotId && sessionMembers.includes(bot.parentBotId)) {
      isMember = true;
    }
    if (!isMember) return false;
    const ownerId = this.getSessionOwner(sessionId, session);
    return ownerId !== undefined && this.db.canUserUseBot(botId, ownerId);
  }

  getValidBotIds(session: SessionRecord): Set<string> {
    const valid = new Set<string>([session.leadBotId, ...session.memberBotIds]);
    const allBots = this.db.getAllBots();
    for (const b of allBots) {
      if (b.parentBotId && valid.has(b.parentBotId)) {
        valid.add(b.id);
      }
    }
    return valid;
  }

  getQueuePlan(sessionId: string): QueueStageSummary[] {
    const state = this.states.get(sessionId);
    if (!state || state.queue.length === 0) return [];
    const stages: QueueStageSummary[] = [];
    let i = 0;
    while (i < state.queue.length) {
      const item = state.queue[i];
      if (item.parallelGroupId) {
        const pId = item.parallelGroupId;
        const botIds: string[] = [];
        const stageId = item.stageId || pId;
        const loopGroupId = item.loopGroupId;
        const whisper = Boolean(item.whisperTargetBotIds && item.whisperTargetBotIds.length > 0);
        while (i < state.queue.length && state.queue[i].parallelGroupId === pId) {
          botIds.push(state.queue[i].botId);
          i++;
        }
        stages.push({
          id: stageId,
          botIds,
          parallel: true,
          ...(loopGroupId ? { loopGroupId } : {}),
          ...(whisper ? { whisper } : {}),
        });
      } else {
        stages.push({
          id: item.stageId || `stage_${i}_${item.botId}`,
          botIds: [item.botId],
          ...(item.loopGroupId ? { loopGroupId: item.loopGroupId } : {}),
          ...(item.whisperTargetBotIds && item.whisperTargetBotIds.length > 0 ? { whisper: true } : {}),
        });
        i++;
      }
    }
    return stages;
  }

  skipQueueStage(sessionId: string, target: { stageId?: string; botId?: string }): QueueStageSummary[] {
    const state = this.getOrCreateState(sessionId);
    if (target.stageId) {
      state.queue = state.queue.filter(
        (item) => item.stageId !== target.stageId && item.parallelGroupId !== target.stageId
      );
    } else if (target.botId) {
      const idx = state.queue.findIndex((item) => item.botId === target.botId);
      if (idx !== -1) {
        state.queue.splice(idx, 1);
      }
    }
    const queuePlan = this.getQueuePlan(sessionId);
    this.sseHub.broadcast(sessionId, {
      type: 'session_status',
      sessionId,
      status: state.isRunning ? 'running' : 'idle',
      activeBotId: state.activeBotId,
      activeBotIds: Array.from(state.activeBotIds),
      queuePlan,
    });
    return queuePlan;
  }

  appendQueueStage(sessionId: string, orchestration: string): QueueStageSummary[] {
    const session = this.db.getSession(sessionId);
    if (!session) return [];
    const state = this.getOrCreateState(sessionId);
    const validBotIds = this.getValidBotIds(session);
    const compiled = parseOrchestrationPlan(orchestration, validBotIds, session, {
      chainBudget: new ChainBudget(MAX_RELAY_TURNS),
      generation: state.generation,
    });
    if (compiled.length > 0) {
      state.queue.push(...compiled);
    }
    const queuePlan = this.getQueuePlan(sessionId);
    this.sseHub.broadcast(sessionId, {
      type: 'session_status',
      sessionId,
      status: state.isRunning ? 'running' : 'idle',
      activeBotId: state.activeBotId,
      activeBotIds: Array.from(state.activeBotIds),
      queuePlan,
    });
    if (!state.isRunning) {
      this.processQueue(sessionId).catch(() => {});
    }
    return queuePlan;
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

  getActiveBotIds(sessionId: string): string[] {
    const state = this.states.get(sessionId);
    if (!state?.isRunning) return [];
    return state.activeBotIds.size > 0
      ? Array.from(state.activeBotIds)
      : (state.activeBotId ? [state.activeBotId] : []);
  }

  isBotActiveInSession(sessionId: string, botId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state || !state.isRunning) return false;
    return state.activeBotId === botId || state.activeBotIds.has(botId);
  }

  onNodeOnline(nodeId: string): void {
    if (this.closed || this.draining) return;

    // Check store-and-forward queue
    const pendingTasks = this.db.listPendingOutboundTasks(nodeId);
    for (const task of pendingTasks) {
      const state = this.getOrCreateState(task.sessionId);
      // 同一 bot 在内存队列已有待执行项时跳过（离线路径 processQueue 会把队首项重新
      // unshift 回内存队列并落库，两项语义都是"执行最新未读增量"，重复入队会双跑）；
      // 不同 bot 的多条离线任务全部入队，由 processQueue 串行消费，其 finally 分支续跑剩余任务。
      const alreadyQueued = state.queue.some((item) => item.botId === task.botId);
      if (alreadyQueued) {
        this.db.markOutboundTaskDispatched(task.id);
        if (!state.isRunning) {
          this.processQueue(task.sessionId).catch(() => {});
        }
        continue;
      }
      let payload: { generation?: number; wakeupMessage?: string; commandText?: string } = {};
      try {
        payload = JSON.parse(task.payloadJson);
      } catch {}
      // 补发任务只携带旧的 wakeupMessage/commandText 引用，但 prepareTurnInput 按增量游标（cursorMap）重新收集全部未读消息，因此补发回合的语义等于"执行最新未读增量"，与内存队列路径一致，不会重复消费历史。
      state.queue.push({
        botId: task.botId,
        chainBudget: new ChainBudget(),
        generation: state.generation,
        wakeupMessage: payload.wakeupMessage,
        commandText: payload.commandText,
      });
      // 确认入队后才标记 dispatched，避免"已标记永不执行"的任务丢失
      this.db.markOutboundTaskDispatched(task.id);
      if (!state.isRunning) {
        this.processQueue(task.sessionId).catch(() => {});
      }
    }

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
    previewType?: AskPreviewType;
    previewContent?: string;
  }): Promise<{ answer: string }> {
    if (this.closed) throw new Error('Hub is shutting down');
    const session = this.db.getSession(input.sessionId);
    if (!session) throw new Error(`Session ${input.sessionId} not found`);

    let previewContent = input.previewContent;
    if (input.previewType === 'ui') {
      if (!previewContent || !previewContent.trim()) {
        throw new Error('Invalid UI spec: Missing UI previewContent');
      }
      const validation = validateUiSpec(previewContent);
      if (!validation.ok) {
        throw new Error(`Invalid UI spec: ${validation.errors.join('; ')}`);
      }
      previewContent = validation.normalizedJson;
    }

    const askId = `ask_${randomUUID()}`;
    const now = new Date();
    const isIndefinite = input.timeoutSeconds === 0;
    const timeoutSec = isIndefinite
      ? 0
      : (input.timeoutSeconds && input.timeoutSeconds > 0 ? input.timeoutSeconds : 300);
    const expiresAt = isIndefinite ? undefined : new Date(now.getTime() + timeoutSec * 1000).toISOString();

    const record: PendingAskRecord = {
      id: askId,
      sessionId: input.sessionId,
      botId: input.botId,
      prompt: input.prompt,
      options: input.options ?? [],
      status: 'pending',
      createdAt: now.toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      ...(input.previewType ? { previewType: input.previewType } : {}),
      ...(previewContent ? { previewContent } : {}),
    };
    this.db.savePendingAsk(record);

    return new Promise<{ answer: string }>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (!isIndefinite) {
        timer = setTimeout(() => {
          const entry = this.pendingAsks.get(askId);
          if (entry) {
            entry.record.status = 'expired';
            this.db.updatePendingAskStatus(askId, 'expired');
            this.pendingAsks.delete(askId);
            entry.reject(new Error(`Interactive ask timed out after ${timeoutSec}s`));
          }
        }, timeoutSec * 1000);
      }

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
    const seen = new Set<string>();
    for (const entry of this.pendingAsks.values()) {
      if (entry.record.sessionId === sessionId && entry.record.status === 'pending') {
        seen.add(entry.record.id);
        result.push(entry.record);
      }
    }
    const dbAsks = this.db.getPendingAsksForSession(sessionId);
    for (const ask of dbAsks) {
      if (!seen.has(ask.id)) {
        seen.add(ask.id);
        result.push(ask);
      }
    }
    return result;
  }

  respondToAsk(sessionId: string, askId: string, answer: string): PendingAskRecord | undefined {
    const entry = this.pendingAsks.get(askId);
    if (entry) {
      if (entry.record.sessionId !== sessionId) return undefined;
      if (entry.record.status !== 'pending') return undefined;

      if (entry.timer) clearTimeout(entry.timer);
      entry.record.status = 'answered';
      entry.record.answer = answer;
      this.db.updatePendingAskStatus(askId, 'answered', answer);
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

    const dbAsks = this.db.getPendingAsksForSession(sessionId);
    const dbAsk = dbAsks.find((a) => a.id === askId);
    if (dbAsk && dbAsk.status === 'pending') {
      dbAsk.status = 'answered';
      dbAsk.answer = answer;
      this.db.updatePendingAskStatus(askId, 'answered', answer);
      this.sseHub.broadcast(sessionId, {
        type: 'interaction_resolved',
        sessionId,
        askId,
        answer,
      });
      return dbAsk;
    }

    return undefined;
  }

  handleUserMessage(
    sessionId: string,
    messageId: string,
    content: string,
    commandInfo?: { commandText: string; targetBotId?: string }
  ): void {
    if (this.closed || this.draining) return;
    const session = this.db.getSession(sessionId);
    if (!session) return;

    const state = this.getOrCreateState(sessionId);
    const validBotIds = this.getValidBotIds(session);

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
      // Check if content has workflow DSL operators: ->, <->, >>, @all, or parenthesized parallel (@a @b)
      const hasWorkflow = /(?<!<)->|<->|>>|@all|\([@\w\s-]+\)/.test(content);
      if (hasWorkflow) {
        const compiled = parseOrchestrationPlan(content, validBotIds, session, {
          chainBudget: new ChainBudget(MAX_RELAY_TURNS),
          generation: state.generation,
        });
        if (compiled.length > 0) {
          this.db.updateMessageOrchestrationPlan(messageId, content.trim());
          state.queue.push(...compiled);
          this.processQueue(sessionId).catch(() => {});
          return;
        }
      }

      const mentions = extractMentions(content, validBotIds);
      if (mentions.length > 0) {
        botIdsToQueue = mentions;
      } else {
        botIdsToQueue = [session.leadBotId];
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
    if (this.closed || this.draining) throw new Error('Hub is shutting down');
    const session = this.db.getSession(sessionId);
    if (!session) return;

    const validBotIds = this.getValidBotIds(session);
    if (!this.canRunBot(sessionId, botId)) {
      throw new Error(`Forbidden: bot @${botId} cannot run in session ${sessionId}`);
    }

    const state = this.getOrCreateState(sessionId);

    const isValidReplyTo = replyToBotId && validBotIds.has(replyToBotId);
    let callbackContent = `[Wake-up] ${wakeupMessage}`;
    if (isValidReplyTo && !wakeupMessage.includes(`@${replyToBotId}`)) {
      callbackContent += ` (cc @${replyToBotId})`;
    }

    const mentions = extractMentions(callbackContent, validBotIds);

    // Insert callback message into DB
    const callbackMsg = this.db.createMessage({
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
    // Invalidate any store-and-forward tasks for this session first: they
    // belong to the discarded generation and must not replay on node online.
    this.db.invalidateOutboundTasksForSession(sessionId);
    const state = this.getOrCreateState(sessionId);
    const activeBotsToCancel = new Set<string>();
    if (state.activeBotId) activeBotsToCancel.add(state.activeBotId);
    for (const b of state.activeBotIds) activeBotsToCancel.add(b);

    // Reject any pending asks
    for (const [askId, entry] of this.pendingAsks.entries()) {
      if (entry.record.sessionId === sessionId) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingAsks.delete(askId);
        entry.record.status = 'expired';
        this.db.updatePendingAskStatus(askId, 'expired');
        entry.reject(new Error('Session cancelled'));
      }
    }
    const dbAsks = this.db.getPendingAsksForSession(sessionId);
    for (const ask of dbAsks) {
      this.db.updatePendingAskStatus(ask.id, 'expired');
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
      activeBotIds: [],
      queuePlan: [],
    });

    for (const botId of activeBotsToCancel) {
      const bot = this.db.getBot(botId);
      if (bot) {
        const rpc = this.connections.getNodeRpc(bot.nodeId);
        if (rpc) {
          // fire-and-forget：取消不应被节点状态拖死（节点可能已静默失联，rpc 会挂到超时）；
          // 通知已通过 generation 递增与会话状态广播生效，节点侧取消仅作尽力而为的联动。
          const cancelFn: any = (rpc as any).cancelTurn;
          if (typeof cancelFn?.asEvent === 'function') {
            void cancelFn.asEvent(sessionId, botId).catch(() => {});
          } else {
            void Promise.race([
              Promise.resolve(cancelFn.call(rpc, sessionId, botId)).catch(() => {}),
              new Promise((resolve) => setTimeout(resolve, 5_000)),
            ]);
          }
        }
      }
    }
  }

  /** 通知会话全部成员所在的节点归档其本地会话文件（持久化待重置标记并在成功后清除） */
  async resetMemberSessions(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) return;

    const memberIds = [...new Set([session.leadBotId, ...session.memberBotIds])];
    const state = this.getOrCreateState(sessionId);
    const generation = state.generation;
    for (const botId of memberIds) {
      this.db.markSessionResetPending(sessionId, botId);
    }
    const results = await Promise.allSettled(memberIds.map(async (botId) => {
      const bot = this.db.getBot(botId);
      if (!bot) return; // 节点已删除该 bot，跳过
      const rpc = this.connections.getNodeRpc(bot.nodeId);
      if (!rpc) {
        console.warn(`[group-router] resetSession skipped: node ${bot.nodeId} for bot @${botId} is offline`);
        return;
      }
      await rpc.resetSession(sessionId, botId);
      if (state.generation === generation) this.db.clearSessionResetPending(sessionId, botId);
    }));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn(`[group-router] resetSession failed for session ${sessionId}:`, result.reason);
      }
    }
  }

  private prepareTurnInput(
    session: NonNullable<ReturnType<HubDatabase['getSession']>>,
    item: QueueItem
  ): {
    incrementalText: string;
    deliveredSnapshotRowid: number;
    attachments: NonNullable<MessageRecord['attachments']>;
    incomingArtifacts: IncomingArtifactRef[];
  } {
    const lastRowid = session.cursorMap[item.botId] ?? 0;
    const rawIncResult = this.db.getIncrementalMessages(session.id, lastRowid);
    const incResult = rawIncResult.filter((r) => {
      const msg = r.message;
      if (msg.role === 'assistant' && msg.senderBotId === item.botId) return false;
      if (item.commandMessageId && msg.id === item.commandMessageId) return false;
      if (msg.whisperTargetBotIds && msg.whisperTargetBotIds.length > 0) {
        if (
          item.botId !== session.leadBotId &&
          msg.senderBotId !== item.botId &&
          !msg.whisperTargetBotIds.includes(item.botId)
        ) {
          return false;
        }
      }
      return true;
    });
    const incrementalText = formatIncrementalMessages(incResult.map((r) => r.message));
    const deliveredSnapshotRowid =
      rawIncResult.length > 0 ? Math.max(...rawIncResult.map((r) => r.rowid)) : lastRowid;
    const attachments = incResult.flatMap((r) => r.message.attachments ?? []);

    const sessionArtifacts = this.db.listSessionArtifacts(session.id);
    const incomingArtifacts: IncomingArtifactRef[] = sessionArtifacts
      .filter((art) => art.senderBotId !== item.botId)
      .map((art) => ({
        id: art.id,
        filename: art.filename,
        mimeType: art.mimeType,
        sizeBytes: art.sizeBytes,
        url: `/api/artifacts/${art.id}/download`,
        ...(art.senderBotId ? { fromBotName: art.senderBotId } : {}),
      }));

    return {
      incrementalText,
      deliveredSnapshotRowid,
      attachments,
      incomingArtifacts,
    };
  }

  private async executeTurn(
    session: NonNullable<ReturnType<HubDatabase['getSession']>>,
    state: SessionRuntimeState,
    prep: PreparedTurnItem,
    groupContextPrompt: string,
    validBotIds: Set<string>,
    turnGen: number,
    isParallel: boolean
  ): Promise<'success' | 'failed' | 'cancelled'> {
    const { item, rpc } = prep;
    const sessionId = session.id;

    if (this.db.hasPendingSessionReset(sessionId, item.botId)) {
      try {
        await rpc.resetSession(sessionId, item.botId);
        if (turnGen !== state.generation) return 'cancelled';
        this.db.clearSessionResetPending(sessionId, item.botId);
      } catch (err: any) {
        if (turnGen !== state.generation) return 'cancelled';
        const errorText = err?.message || String(err);
        const sysMsg = this.db.createMessage({
          id: `msg_${randomUUID()}`,
          sessionId,
          role: 'system',
          content: `Error resetting session for @${item.botId}: ${errorText}`,
        });
        this.sseHub.broadcast(sessionId, { type: 'message_created', message: sysMsg.message });
        if (!isParallel) {
          this.db.updateSessionStatus(sessionId, 'failed', undefined);
          this.sseHub.broadcast(sessionId, {
            type: 'session_status',
            sessionId,
            status: 'failed',
            activeBotId: undefined,
            activeBotIds: [],
            queuePlan: this.getQueuePlan(sessionId),
          });
          state.queue = [];
        } else {
          state.activeBotIds.delete(item.botId);
          if (state.activeBotIds.size > 0) {
            state.activeBotId = state.activeBotIds.values().next().value;
            this.sseHub.broadcast(sessionId, {
              type: 'session_status',
              sessionId,
              status: 'running',
              activeBotId: state.activeBotId,
              activeBotIds: Array.from(state.activeBotIds),
              queuePlan: this.getQueuePlan(sessionId),
            });
          }
        }
        return 'failed';
      }
    }

    if (turnGen !== state.generation) return 'cancelled';

    const isSubagent = Boolean(prep.bot.parentBotId);
    const isDispatchedSubagent =
      isSubagent && (session.leadBotId === prep.bot.parentBotId || Boolean(item.dispatchedByBotId));
    let subagentRun: SubagentRunRecord | undefined;
    let directSessionId: string | undefined;
    const turnStartTime = Date.now();

    if (isDispatchedSubagent) {
      const parentBotId = item.dispatchedByBotId || prep.bot.parentBotId!;
      const sessionOwner = this.getSessionOwner(sessionId, session) ?? 'user_admin';
      let directSession = this.db
        .getAllSessions(sessionOwner)
        .find(
          (s) =>
            s.mode === 'direct' &&
            s.leadBotId === prep.bot.id &&
            !s.archived &&
            s.memberBotIds.length === 1 &&
            s.memberBotIds[0] === prep.bot.id
        );
      if (!directSession) {
        directSession = this.db.createSession({
          id: `sess_${randomUUID()}`,
          title: `${prep.bot.name}（分身会话）`,
          mode: 'direct',
          leadBotId: prep.bot.id,
          memberBotIds: [prep.bot.id],
          ownerId: sessionOwner,
        });
      }
      directSessionId = directSession.id;

      subagentRun = {
        id: `run_${randomUUID()}`,
        subagentId: prep.bot.id,
        subagentName: prep.bot.name,
        color: prep.bot.color,
        task: prep.incrementalText.trim().slice(0, 120) || 'Task execution',
        status: 'running',
        childSessionId: directSession.id,
      };

      this.sseHub.broadcast(sessionId, {
        type: 'subagent_status',
        sessionId,
        botId: prep.bot.id,
        run: subagentRun,
      });

      const mirrorPrompt = `📋 [来自 @${parentBotId} 的派单]\n${prep.incrementalText}`;
      const mirrorUserMsg = this.db.createMessage({
        id: `msg_${randomUUID()}`,
        sessionId: directSession.id,
        role: 'user',
        content: mirrorPrompt,
      });
      this.sseHub.broadcast(directSession.id, {
        type: 'message_created',
        message: mirrorUserMsg.message,
      });
    }

    let turnResult: { replyText: string; modelBadge: string; toolCalls?: ToolCallRecord[]; blocks?: TurnBlock[]; usage?: TurnUsage };
    try {
      turnResult = await rpc.runTurn({
        sessionId,
        botId: item.botId,
        groupContextPrompt,
        incrementalMessages: prep.incrementalText,
        ...(item.commandText ? { commandText: item.commandText } : {}),
        ...(prep.attachments.length > 0 ? { attachments: prep.attachments } : {}),
        ...(prep.incomingArtifacts.length > 0 ? { incomingArtifacts: prep.incomingArtifacts } : {}),
      });
    } catch (err: any) {
      if (isDispatchedSubagent && subagentRun) {
        subagentRun.status = 'error';
        subagentRun.durationMs = Date.now() - turnStartTime;
        this.sseHub.broadcast(sessionId, {
          type: 'subagent_status',
          sessionId,
          botId: prep.bot.id,
          run: subagentRun,
        });
      }
      if (turnGen !== state.generation) return 'cancelled';
      const errorText = err?.message || String(err);
      const sysMsg = this.db.createMessage({
        id: `msg_${randomUUID()}`,
        sessionId,
        role: 'system',
        content: `Error executing turn for @${item.botId}: ${errorText}`,
      });
      this.sseHub.broadcast(sessionId, { type: 'message_created', message: sysMsg.message });
      if (!isParallel) {
        this.db.updateSessionStatus(sessionId, 'failed', undefined);
        this.sseHub.broadcast(sessionId, {
          type: 'session_status',
          sessionId,
          status: 'failed',
          activeBotId: undefined,
          activeBotIds: [],
          queuePlan: this.getQueuePlan(sessionId),
        });
        state.queue = [];
      } else {
        state.activeBotIds.delete(item.botId);
        if (state.activeBotIds.size > 0) {
          state.activeBotId = state.activeBotIds.values().next().value;
          this.sseHub.broadcast(sessionId, {
            type: 'session_status',
            sessionId,
            status: 'running',
            activeBotId: state.activeBotId,
            activeBotIds: Array.from(state.activeBotIds),
            queuePlan: this.getQueuePlan(sessionId),
          });
        }
      }
      return 'failed';
    }

    if (turnGen !== state.generation) return 'cancelled';

    if (isDispatchedSubagent && subagentRun) {
      subagentRun.status = 'done';
      subagentRun.durationMs = Date.now() - turnStartTime;
      subagentRun.toolCount = turnResult.toolCalls?.length ?? 0;
      subagentRun.replyPreview = turnResult.replyText.slice(0, 200);

      this.sseHub.broadcast(sessionId, {
        type: 'subagent_status',
        sessionId,
        botId: prep.bot.id,
        run: subagentRun,
      });

      if (directSessionId) {
        const mirrorAssistantMsg = this.db.createMessage({
          id: `msg_${randomUUID()}`,
          sessionId: directSessionId,
          role: 'assistant',
          senderBotId: prep.bot.id,
          modelBadge: turnResult.modelBadge,
          content: turnResult.replyText,
          toolCalls: turnResult.toolCalls,
          blocks: turnResult.blocks,
          usage: turnResult.usage,
        });
        this.sseHub.broadcast(directSessionId, {
          type: 'message_created',
          message: mirrorAssistantMsg.message,
        });
      }
    }

    // 1. Blackboard extraction
    const bbMatch = turnResult.replyText.match(/```blackboard[^\n]*\r?\n([\s\S]*?)```/);
    if (bbMatch) {
      const blackboard = bbMatch[1].trim();
      this.db.updateSession(sessionId, { blackboard });
      this.sseHub.broadcast(sessionId, {
        type: 'session_updated',
        sessionId,
        blackboard,
      });
    }

    // 2. Loop pruning on [LGTM] or [PASS]
    if (item.loopGroupId && (turnResult.replyText.includes('[LGTM]') || turnResult.replyText.includes('[PASS]'))) {
      state.queue = state.queue.filter((q) => q.loopGroupId !== item.loopGroupId);
    }

    // 3. Pass check
    const trimmedReply = turnResult.replyText.trim();
    const isPass = trimmedReply === '[PASS]' || trimmedReply.startsWith('[PASS]');

    // 4. Trailing routing directive
    const routingDirective = extractBotRoutingDirective(turnResult.replyText);
    const orchestrationPlan = routingDirective?.directive;

    const replyMentions = extractMentions(turnResult.replyText, validBotIds);
    const maxRowidBeforeInsert = this.db.getMaxMessageRowid(sessionId);

    const newMsg = this.db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId,
      role: 'assistant',
      senderBotId: item.botId,
      modelBadge: turnResult.modelBadge,
      content: turnResult.replyText,
      mentions: replyMentions,
      ...(item.whisperTargetBotIds && item.whisperTargetBotIds.length > 0
        ? { whisperTargetBotIds: item.whisperTargetBotIds }
        : {}),
      ...(orchestrationPlan ? { orchestrationPlan } : {}),
      ...(subagentRun ? { subagentRuns: [subagentRun] } : {}),
      toolCalls: turnResult.toolCalls,
      blocks: turnResult.blocks,
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
        ...(turnResult.blocks ? { blocks: turnResult.blocks } : {}),
        ...(turnResult.usage ? { usage: turnResult.usage } : {}),
      },
    });

    if (isParallel) {
      state.activeBotIds.delete(item.botId);
      if (state.activeBotIds.size > 0) {
        state.activeBotId = state.activeBotIds.values().next().value;
        this.sseHub.broadcast(sessionId, {
          type: 'session_status',
          sessionId,
          status: 'running',
          activeBotId: state.activeBotId,
          activeBotIds: Array.from(state.activeBotIds),
          queuePlan: this.getQueuePlan(sessionId),
        });
      }
    }

    if (routingDirective) {
      if (routingDirective.plan !== '@none' && !routingDirective.plan.startsWith('@none')) {
        if (item.botId === session.leadBotId) {
          item.chainBudget = new ChainBudget(8);
        }
        const compiled = parseOrchestrationPlan(routingDirective.plan, validBotIds, session, {
          chainBudget: item.chainBudget,
          generation: state.generation,
          dispatchedByBotId: item.botId,
        });
        for (const nextItem of compiled) {
          if (item.chainBudget.consumeRelay()) {
            state.queue.push(nextItem);
          }
        }
      }
      // Explicit directive suppresses prose @mentions
    } else if (!isPass) {
      // 5. Fallback prose @mentions
      const isSubagentBot = Boolean(prep.bot.parentBotId);
      if (item.replyToBotId && !replyMentions.includes(item.replyToBotId)) {
        if (item.chainBudget.consumeRelay()) {
          state.queue.push({
            botId: item.replyToBotId,
            chainBudget: item.chainBudget,
            generation: state.generation,
          });
        }
      }

      if (!isSubagentBot && replyMentions.length > 0) {
        for (const nextBotId of replyMentions) {
          const alreadyUpcoming = state.queue.some((q) => q.botId === nextBotId);
          if (alreadyUpcoming) continue;
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

    return 'success';
  }

  private async processQueue(sessionId: string): Promise<void> {
    const state = this.getOrCreateState(sessionId);
    if (state.isRunning) return;

    state.isRunning = true;

    try {
      while (!this.closed && !this.draining && state.queue.length > 0) {
        const frontItem = state.queue[0];
        const isParallel = Boolean(frontItem.parallelGroupId);
        const rawBatch: QueueItem[] = [];
        if (isParallel) {
          const groupId = frontItem.parallelGroupId!;
          while (state.queue.length > 0 && state.queue[0].parallelGroupId === groupId) {
            rawBatch.push(state.queue.shift()!);
          }
        } else {
          rawBatch.push(state.queue.shift()!);
        }

        const validBatch = rawBatch.filter((item) => item.generation === state.generation);
        if (validBatch.length === 0) continue;

        const session = this.db.getSession(sessionId);
        if (!session) break;

        const validBotIds = this.getValidBotIds(session);
        const sessionOwner = this.getSessionOwner(sessionId, session);

        const activeBatch: QueueItem[] = [];
        if (!isParallel) {
          const item = validBatch[0];
          if (!validBotIds.has(item.botId)) {
            console.warn(`[group-router] Skipping turn for bot @${item.botId}: no longer a member of session ${sessionId}`);
            continue;
          }
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
            this.sseHub.broadcast(sessionId, {
              type: 'session_status',
              sessionId,
              status: 'failed',
              activeBotId: undefined,
              activeBotIds: [],
              queuePlan: this.getQueuePlan(sessionId),
            });
            state.queue = [];
            break;
          }
          const botOwner = this.db.getNodeOwner(bot.nodeId);
          if (sessionOwner && botOwner && botOwner !== sessionOwner && !this.db.canUserUseBot(item.botId, sessionOwner)) {
            console.warn(`[group-router] Skipping turn for bot @${item.botId}: owner mismatch (session: ${sessionOwner}, bot: ${botOwner})`);
            continue;
          }
          activeBatch.push(item);
        } else {
          for (const item of validBatch) {
            if (!validBotIds.has(item.botId)) {
              console.warn(`[group-router] Skipping turn for bot @${item.botId}: no longer a member of session ${sessionId}`);
              continue;
            }
            const bot = this.db.getBot(item.botId);
            if (!bot) continue;
            const botOwner = this.db.getNodeOwner(bot.nodeId);
            if (sessionOwner && botOwner && botOwner !== sessionOwner && !this.db.canUserUseBot(item.botId, sessionOwner)) continue;
            activeBatch.push(item);
          }
        }

        if (activeBatch.length === 0) continue;

        let anyOffline = false;
        for (const item of activeBatch) {
          const bot = this.db.getBot(item.botId)!;
          const rpc = this.connections.getNodeRpc(bot.nodeId);
          if (!rpc) {
            anyOffline = true;
            break;
          }
        }
        if (anyOffline) {
          for (const item of activeBatch) {
            const bot = this.db.getBot(item.botId);
            if (bot && !this.connections.getNodeRpc(bot.nodeId)) {
              this.db.enqueueOutboundTask({
                nodeId: bot.nodeId,
                botId: item.botId,
                sessionId,
                taskType: 'turn',
                payload: {
                  generation: item.generation,
                  wakeupMessage: item.wakeupMessage,
                  commandText: item.commandText,
                },
              });
            }
          }
          state.queue.unshift(...activeBatch);
          this.db.updateSessionStatus(sessionId, 'queued', undefined);
          this.sseHub.broadcast(sessionId, {
            type: 'session_status',
            sessionId,
            status: 'queued',
            activeBotId: undefined,
            activeBotIds: [],
            queuePlan: this.getQueuePlan(sessionId),
          });
          break;
        }

        if (isParallel) {
          state.activeBotId = activeBatch[0].botId;
          state.activeBotIds = new Set(activeBatch.map((item) => item.botId));
          this.db.updateSessionStatus(sessionId, 'running', state.activeBotId);
          this.sseHub.broadcast(sessionId, {
            type: 'session_status',
            sessionId,
            status: 'running',
            activeBotId: state.activeBotId,
            activeBotIds: Array.from(state.activeBotIds),
            queuePlan: this.getQueuePlan(sessionId),
          });
        } else {
          const item = activeBatch[0];
          state.activeBotId = item.botId;
          state.activeBotIds = new Set([item.botId]);
          this.db.updateSessionStatus(sessionId, 'running', item.botId);
          this.sseHub.broadcast(sessionId, {
            type: 'session_status',
            sessionId,
            status: 'running',
            activeBotId: item.botId,
            activeBotIds: [item.botId],
            queuePlan: this.getQueuePlan(sessionId),
          });
        }

        const turnGen = state.generation;

        const preparedItems: PreparedTurnItem[] = activeBatch.map((item) => {
          const turnInput = this.prepareTurnInput(session, item);
          const bot = this.db.getBot(item.botId)!;
          const rpc = this.connections.getNodeRpc(bot.nodeId)!;
          return {
            item,
            bot,
            rpc,
            ...turnInput,
          };
        });

        if (isParallel) {
          await Promise.all(
            preparedItems.map((prep) =>
              this.executeTurn(
                session,
                state,
                prep,
                buildGroupContextPrompt(session, this.db, prep.item.botId),
                validBotIds,
                turnGen,
                true
              )
            )
          );
        } else {
          const result = await this.executeTurn(
            session,
            state,
            preparedItems[0],
            buildGroupContextPrompt(session, this.db, preparedItems[0].item.botId),
            validBotIds,
            turnGen,
            false
          );
          if (result === 'failed') {
            break;
          }
        }

        state.activeBotIds.clear();
        state.activeBotId = undefined;
      }
    } finally {
      state.isRunning = false;
      state.activeBotId = undefined;
      state.activeBotIds.clear();

      // If new items were queued during finalization, resume processing
      if (this.closed || this.draining) {
        state.queue = [];
      }
      if (!this.closed && !this.draining && state.queue.length > 0) {
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
            activeBotIds: [],
            queuePlan: [],
          });
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    this.draining = true;
    for (const entry of this.pendingAsks.values()) {
      if (entry.timer) clearTimeout(entry.timer);
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
