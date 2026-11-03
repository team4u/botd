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
  type SubagentSteerRecord,
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
  dispatchedByBotId?: string;
  mentionedBotIds?: string[];
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
  prompt += `## 会话上下文\n- 会话标题: ${session.title}\n- 主控 Bot: @${session.leadBotId}\n`;

  if (db) {
    prompt += '\n### 成员信息\n';
    const bot = db.getBot(session.leadBotId);
    const desc = bot?.description ? ` - ${bot.description}` : '';
    const skills = bot?.enabledSkills?.length ? ` (技能: ${bot.enabledSkills.join(', ')})` : '';
    prompt += `- @${session.leadBotId} (${bot?.name || session.leadBotId})${desc}${skills}\n`;
  }

  // 子代理感知：主 BOT 始终注入子代理引导与规范，让主 BOT 知道如何调度与创建子代理
  const currentBot = db && currentBotId ? db.getBot(currentBotId) : undefined;
  const isPrimaryBot = !currentBot?.parentBotId;
  const mySubagents = db && currentBotId
    ? db.getAllBots().filter((b) => b.parentBotId === currentBotId)
    : [];

  if (isPrimaryBot) {
    prompt += '\n### ⚡ 你的子代理 (Subagents)\n';
    if (mySubagents.length > 0) {
      for (const sub of mySubagents) {
        const tags: string[] = [];
        if (sub.inheritModel) tags.push('跟随主模型');
        else if (sub.modelId) tags.push(sub.modelId);
        if (sub.toolScope === 'readonly') tags.push('只读');
        prompt += `- ${sub.id} (${sub.name}${sub.description ? ` - ${sub.description}` : ''}${tags.length ? ` [${tags.join(' · ')}]` : ''})\n`;
      }
      prompt +=
        '【调度子代理规范】：\n' +
        '1. 调度你麾下的子代理时，请直接调用 `Agent` 工具（`subagent_type` 填子代理 id，传入 `run_in_background: false`；在同一轮回复中同时发出多个 `Agent` 工具调用即可原生并发执行并在本回合汇总结果），或使用 `SubagentWorkflow` 工具编排多阶段流水线。不要在文本末尾用 `@子代理` 呼叫你自己的子代理。\n' +
        '2. 默认情况下子代理与你共享同一个主工作空间目录（不传 `isolation`）；仅当需要多个子代理并发修改同一个 Git 仓库代码、或用户明确要求在独立分支/worktree 试验时，才在调用 `Agent` / `SubagentWorkflow` 时传入 `isolation: "worktree"`。\n' +
        '3. 如需新建更多子代理或修改子代理配置，可在 bash 中运行：`botd bots create <subId> --node "$BOTD_NODE_ID" --parent "$BOTD_BOT_ID" --name "<名称>" --desc "<职责>" --tool-scope <all|readonly> --system-file -`（创建后同一回合即可立即通过 `Agent` 工具调用）。\n';
    } else {
      prompt +=
        '当前你麾下暂无子代理。当用户要求创建子代理、或需要多角色并发协同（如编码、审查、测试、调研分工）时，你可直接在 bash 中运行以下命令创建子代理（默认继承你的模型与技能，创建后在当前回合即可立即通过 `Agent` 工具并发调用）：\n' +
        '`botd bots create <subId> --node "$BOTD_NODE_ID" --parent "$BOTD_BOT_ID" --name "<展示名称>" --desc "<职责说明>" --tool-scope <all|readonly> --system-file -`\n';
    }

    const ownerId = session.ownerId || (db ? db.getSessionOwner(session.id) : undefined);
    const peerPrimaryBots = db && currentBotId
      ? db.getAllBots().filter(
          (b) =>
            !b.parentBotId &&
            b.id !== currentBotId &&
            (!ownerId || db.canUserUseBot(b.id, ownerId))
        )
      : [];
    if (peerPrimaryBots.length > 0 && db) {
      prompt += '\n### 🌐 可协同的其他主 BOT (跨节点 / 独立工作区)\n';
      for (const peer of peerPrimaryBots) {
        const node = db.getNode(peer.nodeId);
        const tags: string[] = [];
        if (node) tags.push(`节点:${node.name || peer.nodeId}·${node.status === 'online' ? '在线' : '离线'}`);
        if (peer.visibility === 'team') tags.push('团队共享');
        if (peer.enabledSkills?.length) tags.push(`技能:${peer.enabledSkills.join(',')}`);
        prompt += `- @${peer.id} (${peer.name}${peer.description ? ` - ${peer.description}` : ''}${tags.length ? ` [${tags.join(' · ')}]` : ''})\n`;
      }
      prompt +=
        '【跨 BOT 协同规范】：\n' +
        '1. 同工作区内的多角色分工请优先使用 `Agent` / `SubagentWorkflow` 调度你麾下的子代理。\n' +
        '2. 当任务需要跨机器节点执行、需要其他主 BOT 的独立工作区/专属环境变量、或需调用团队共享主 BOT 时：单步或多并发委派请直接使用 `Agent` 工具（传入 `subagent_type: "@<botId>"`，支持 `run_in_background`、`title`、`artifact_ids`、`timeout_seconds`；在同一轮回复中发出多个 `Agent` 调用即可原生并发委派）；多阶段流水线、条件分支或需断点续跑（`resumeFromRunId`）的跨 BOT 任务，可直接使用 `SubagentWorkflow` 工具并在脚本的 `agent(prompt, { agentType: "@<botId>", phase: "<阶段名>" })` 中指定目标主 BOT ID，支持将本机子代理与跨节点主 BOT 无缝混编。\n';
    }
  }

  prompt += `\n你当前处于单聊模式。`;

  return prompt;
}

export class GroupRouter {
  private db: HubDatabase;
  private connections: NodeConnectionManager;
  private sseHub: SseHub;
  private states = new Map<string, SessionRuntimeState>();
  private mirroredSubagentRuns = new Map<string, { sessionId: string; directSessionId: string; parentBotId?: string; run: SubagentRunRecord }>();
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
    if (!session) return false;
    const bot = this.db.getBot(botId);
    if (!bot) return false;
    if (session.leadBotId === botId) return true;
    if (bot.parentBotId && bot.parentBotId === session.leadBotId) return true;
    return false;
  }

  getValidBotIds(session: SessionRecord): Set<string> {
    const valid = new Set<string>([session.leadBotId]);
    const ownerId = this.getSessionOwner(session.id, session);
    const allBots = this.db.getAllBots();
    for (const b of allBots) {
      if (b.parentBotId && valid.has(b.parentBotId)) {
        valid.add(b.id);
      }
      // owner 可用的其他 BOT/子代理也可被 @ 接力
      if (
        ownerId &&
        !b.parentBotId &&
        this.db.canUserUseBot(b.id, ownerId)
      ) {
        valid.add(b.id);
        for (const sub of allBots) {
          if (sub.parentBotId === b.id) valid.add(sub.id);
        }
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
        while (i < state.queue.length && state.queue[i].parallelGroupId === pId) {
          botIds.push(state.queue[i].botId);
          i++;
        }
        stages.push({
          id: stageId,
          botIds,
          parallel: true,
        });
      } else {
        stages.push({
          id: item.stageId || `stage_${i}_${item.botId}`,
          botIds: [item.botId],
        });
        i++;
      }
    }
    return stages;
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

  handleNativeSubagentStreamEvent(
    sessionId: string,
    _parentBotId: string,
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
  ): SubagentRunRecord | undefined {
    const session = this.db.getSession(sessionId);
    if (!session) return undefined;
    const subBot = this.db.getBot(subEvent.subagentId);

    let entry = this.mirroredSubagentRuns.get(subEvent.id);
    if (!entry) {
      const run: SubagentRunRecord = {
        id: subEvent.id,
        subagentId: subEvent.subagentId,
        subagentName: subBot?.name || subEvent.subagentId,
        ...(subBot?.color ? { color: subBot.color } : {}),
        task: subEvent.task,
        status: subEvent.status,
        ...(subEvent.phase ? { phase: subEvent.phase } : {}),
        ...(subEvent.childSessionId ? { childSessionId: subEvent.childSessionId } : {}),
      };
      entry = {
        sessionId,
        directSessionId: '',
        parentBotId: _parentBotId || undefined,
        run,
      };
      this.mirroredSubagentRuns.set(subEvent.id, entry);
    }
    if (_parentBotId) entry.parentBotId = _parentBotId;
    entry.run.status = subEvent.status;
    if (typeof subEvent.durationMs === 'number') entry.run.durationMs = subEvent.durationMs;
    if (typeof subEvent.toolUses === 'number') entry.run.toolCount = subEvent.toolUses;
    if (subEvent.currentTool !== undefined) entry.run.currentTool = subEvent.currentTool;
    if (subEvent.phase) entry.run.phase = subEvent.phase;
    if (subEvent.childSessionId) entry.run.childSessionId = subEvent.childSessionId;
    if (subEvent.startedAt) entry.run.startedAt = subEvent.startedAt;
    if (subEvent.blocks) entry.run.blocks = subEvent.blocks;
    if (subEvent.toolCalls) entry.run.toolCalls = subEvent.toolCalls;
    if (subEvent.steers) {
      // 合并追加 steer / resume 记录（按 timestamp+message 去重）
      const existing = entry.run.steers ?? [];
      const seen = new Set(existing.map((s) => `${s.timestamp}|${s.message}`));
      for (const steer of subEvent.steers) {
        if (!seen.has(`${steer.timestamp}|${steer.message}`)) existing.push(steer);
      }
      entry.run.steers = existing;
    }
    if (subEvent.status !== 'running') {
      const replyContent = subEvent.result || subEvent.error || '（已完成执行）';
      entry.run.replyFull = replyContent;
      entry.run.replyPreview = replyContent.slice(0, 500);
      entry.run.currentTool = undefined;
    }
    this.sseHub.broadcast(sessionId, {
      type: 'subagent_status',
      sessionId,
      botId: subEvent.subagentId,
      run: { ...entry.run },
    });

    // 父消息已落库（子代理后台完成 / 抽屉内 resume / stop 等）：同步持久化更新该消息的 subagentRuns
    this.persistSubagentRunUpdate(sessionId, { ...entry.run });

    return entry.run;
  }

  /** 查找会话最近包含该 runId 的消息并持久化更新其 subagentRuns */
  private persistSubagentRunUpdate(sessionId: string, run: SubagentRunRecord): void {
    try {
      const page = this.db.getMessagesPage(sessionId, { limit: 30 });
      for (let i = page.messages.length - 1; i >= 0; i--) {
        const msg = page.messages[i];
        if (!msg.subagentRuns || msg.subagentRuns.length === 0) continue;
        const idx = msg.subagentRuns.findIndex((r) => r.id === run.id);
        if (idx < 0) continue;
        const updated = [...msg.subagentRuns];
        updated[idx] = { ...updated[idx], ...run };
        this.db.updateMessageSubagentRuns(msg.id, updated);
        // 广播更新后的消息，让已落库卡片与打开的抽屉热更新
        const refreshed = this.db.getMessageById(msg.id);
        if (refreshed) {
          this.sseHub.broadcast(sessionId, { type: 'message_created', message: refreshed.message });
        }
        return;
      }
    } catch {
      // 持久化失败不影响流事件
    }
  }

  /** 单独停掉某个运行中的子代理（转发到对应节点，含已落库消息的状态同步） */
  async stopSubagent(sessionId: string, runId: string): Promise<{ ok: boolean; error?: string }> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // 定位 runId 归属的主 BOT：活跃回合的 activeBotId → 流事件镜像记录的 parentBotId → 最近包含该 runId 的消息 sender
    let parentBotId = this.getActiveBotId(sessionId);
    if (!parentBotId) parentBotId = this.mirroredSubagentRuns.get(runId)?.parentBotId;
    if (!parentBotId) {
      const page = this.db.getMessagesPage(sessionId, { limit: 30 });
      for (let i = page.messages.length - 1; i >= 0; i--) {
        const msg = page.messages[i];
        if (msg.subagentRuns?.some((r) => r.id === runId) && msg.senderBotId) {
          parentBotId = msg.senderBotId;
          break;
        }
      }
    }
    if (!parentBotId) return { ok: false, error: `Cannot determine the parent bot of subagent run ${runId}.` };

    const bot = this.db.getBot(parentBotId);
    if (!bot) return { ok: false, error: `Bot @${parentBotId} not found.` };
    const rpc = this.connections.getNodeRpc(bot.nodeId);
    if (!rpc?.stopSubagent) {
      return { ok: false, error: 'Node is offline or does not support stopping subagents.' };
    }
    const result = await rpc.stopSubagent(sessionId, parentBotId, runId);
    if (result.ok) {
      // 立即同步本地镜像与已落库消息状态（节点流事件随后到达作准）
      const entry = this.mirroredSubagentRuns.get(runId);
      if (entry) {
        entry.run.status = 'stopped';
        entry.run.currentTool = undefined;
        this.sseHub.broadcast(sessionId, {
          type: 'subagent_status',
          sessionId,
          botId: entry.run.subagentId,
          run: { ...entry.run },
        });
        this.persistSubagentRunUpdate(sessionId, { ...entry.run });
      }
    }
    return result;
  }

  /** 向某个子代理发送 steer（运行中插话）或 resume（结束后追问） */
  async interactSubagent(
    sessionId: string,
    runId: string,
    message: string,
    mode: 'steer' | 'resume',
    subagentId?: string,
  ): Promise<{ ok: boolean; run?: SubagentRunRecord; error?: string }> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    let parentBotId = this.getActiveBotId(sessionId);
    if (!parentBotId) parentBotId = this.mirroredSubagentRuns.get(runId)?.parentBotId;
    if (!parentBotId) {
      const page = this.db.getMessagesPage(sessionId, { limit: 30 });
      for (let i = page.messages.length - 1; i >= 0; i--) {
        const msg = page.messages[i];
        if (msg.subagentRuns?.some((r) => r.id === runId) && msg.senderBotId) {
          parentBotId = msg.senderBotId;
          break;
        }
      }
    }
    if (!parentBotId) return { ok: false, error: `Cannot determine the parent bot of subagent run ${runId}.` };

    const bot = this.db.getBot(parentBotId);
    if (!bot) return { ok: false, error: `Bot @${parentBotId} not found.` };
    const rpc = this.connections.getNodeRpc(bot.nodeId);
    if (!rpc?.interactSubagent) {
      return { ok: false, error: 'Node is offline or does not support subagent interaction.' };
    }
    const result = await rpc.interactSubagent({
      sessionId,
      botId: parentBotId,
      runId,
      ...(subagentId ? { subagentId } : {}),
      message,
      mode,
    });
    if (result.ok && result.run) {
      // 同步本地镜像与已落库消息（节点流事件随后到达作准）
      const entry = this.mirroredSubagentRuns.get(runId);
      if (entry) {
        Object.assign(entry.run, result.run);
        this.sseHub.broadcast(sessionId, {
          type: 'subagent_status',
          sessionId,
          botId: entry.run.subagentId,
          run: { ...entry.run },
        });
        this.persistSubagentRunUpdate(sessionId, { ...entry.run });
      } else {
        this.persistSubagentRunUpdate(sessionId, result.run);
      }
    }
    return result;
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

    // 主会话运行中收到用户新消息（非斜杠命令）：优先尝试 steerBotTurn ——
    // 让正在运行的 Bot 实时接管该消息（阻塞中的前台子代理自动切后台），
    // 避免消息死锁排队到当前回合之后。接管成功则推进游标（标记已投递）并直接返回；
    // 节点不支持 / 接管失败则回落到原有入队逻辑。
    if (!parsedCommand && state.isRunning) {
      const activeBotId = state.activeBotId ?? (state.activeBotIds.size > 0 ? Array.from(state.activeBotIds)[0] : undefined);
      if (activeBotId) {
        const bot = this.db.getBot(activeBotId);
        const rpc = bot ? this.connections.getNodeRpc(bot.nodeId) : undefined;
        if (rpc?.steerBotTurn) {
          const text = content;
          rpc
            .steerBotTurn(sessionId, activeBotId, text)
            .then((result) => {
              if (result?.accepted) {
                // 已实时注入当前回合：推进该 Bot 游标到本条消息，避免回合结束后重复执行同一消息
                const rowid = this.db.getMessageRowid(messageId);
                if (rowid) this.db.updateSessionCursor(sessionId, activeBotId, rowid);
              } else {
                this.enqueueUserMessage(sessionId, messageId, content, commandInfo);
              }
            })
            .catch(() => {
              this.enqueueUserMessage(sessionId, messageId, content, commandInfo);
            });
          return;
        }
      }
    }

    this.enqueueUserMessage(sessionId, messageId, content, commandInfo);
  }

  private enqueueUserMessage(
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
    let mentionedBotIds: string[] | undefined;

    if (parsedCommand && parsedCommand.commandText) {
      commandText = parsedCommand.commandText;
      commandMessageId = messageId;
      const target = parsedCommand.targetBotId ?? session.leadBotId;
      botIdsToQueue = [target];
    } else {
      const nonLeadMentions = extractMentions(content, validBotIds).filter((id) => id !== session.leadBotId);
      if (nonLeadMentions.length > 0) {
        mentionedBotIds = nonLeadMentions;
      }
      botIdsToQueue = [session.leadBotId];
    }

    const chainBudget = new ChainBudget(MAX_RELAY_TURNS);
    for (const botId of botIdsToQueue) {
      state.queue.push({
        botId,
        chainBudget,
        generation: state.generation,
        commandText,
        commandMessageId,
        mentionedBotIds,
      });
      commandText = undefined;
      commandMessageId = undefined;
      mentionedBotIds = undefined;
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

    const memberIds = [session.leadBotId];
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

    let effectiveGroupContextPrompt = groupContextPrompt;
    const mentionedTargets = prep.item.mentionedBotIds && prep.item.mentionedBotIds.length > 0
      ? prep.item.mentionedBotIds
      : (() => {
          const mentions = extractMentions(prep.incrementalText, validBotIds).filter((id) => id !== prep.item.botId);
          return mentions.length > 0 ? mentions : undefined;
        })();

    if (mentionedTargets && mentionedTargets.length > 0 && prep.item.botId === session.leadBotId) {
      effectiveGroupContextPrompt +=
        `\n\n### 🎯 本轮用户 @ 提及分派指令\n` +
        `用户在最新消息中显式提及了：${mentionedTargets.map((id) => `@${id}`).join(', ')}。\n` +
        `请直接调用 \`Agent\` 工具将对应子任务分派给被提及的目标（麾下子代理传 \`subagent_type: "<id>"\`；其他主 BOT 传 \`subagent_type: "@<id>"\`；若提及多个目标请在同一轮并发发出多个 \`Agent\` 调用），并在拿到执行结果后向用户汇总回复。`;
    }

    let turnResult: {
      replyText: string;
      modelBadge: string;
      toolCalls?: ToolCallRecord[];
      blocks?: TurnBlock[];
      usage?: TurnUsage;
      subagentRuns?: SubagentRunRecord[];
      aborted?: boolean;
    };
    try {
      turnResult = await rpc.runTurn({
        sessionId,
        botId: item.botId,
        groupContextPrompt: effectiveGroupContextPrompt,
        incrementalMessages: prep.incrementalText,
        ...(item.commandText ? { commandText: item.commandText } : {}),
        ...(prep.attachments.length > 0 ? { attachments: prep.attachments } : {}),
        ...(prep.incomingArtifacts.length > 0 ? { incomingArtifacts: prep.incomingArtifacts } : {}),
      });
    } catch (err: any) {
      // 用户中止（取消到达前回合已在飞行）：尽力保留已产生的部分输出，不当作失败丢弃。
      // 此时 generation 已递增，但部分输出消息仍应持久化并广播，屏幕上已展示的内容才能落盘。
      // 用户中止：取消到达时回合可能在任意阶段，节点抛出 cancelled/aborted。
      // 无论 generation 是否已递增，都补一条「已中止」占位消息，避免用户点击通知后内容突兀消失。
      const isCancel = String(err?.message || '').includes('cancelled') || String(err?.message || '').includes('aborted');
      if (isCancel) {
        const partialMsg = this.db.createMessage({
          id: `msg_${randomUUID()}`,
          sessionId,
          role: 'assistant',
          senderBotId: item.botId,
          modelBadge: `${prep.bot.modelProvider}/${prep.bot.modelId}`,
          content: '',
          aborted: true,
        });
        this.sseHub.broadcast(sessionId, { type: 'message_created', message: partialMsg.message });
        if (isParallel) state.activeBotIds.delete(item.botId);
        return 'cancelled';
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

    // 用户中止：node 正常返回 aborted=true + 部分输出。generation 已变（队列已清），
    // 但已产生的 thinking/工具/文本必须落盘——跳过后续路由，只走持久化路径。
    if (turnGen !== state.generation && !turnResult.aborted) return 'cancelled';
    const wasAborted = Boolean(turnResult.aborted);

    // 1. Blackboard extraction（中止的部分输出不参与黑板/路由）
    if (wasAborted) {
      // 落盘部分输出并广播，然后直接结束，不再提取黑板与派发后续 BOT
      const abortedMsg = this.db.createMessage({
        id: `msg_${randomUUID()}`,
        sessionId,
        role: 'assistant',
        senderBotId: item.botId,
        modelBadge: turnResult.modelBadge,
        content: turnResult.replyText,
        toolCalls: turnResult.toolCalls,
        blocks: turnResult.blocks,
        usage: turnResult.usage,
        aborted: true,
      });
      this.sseHub.broadcast(sessionId, {
        type: 'message_created',
        message: {
          ...abortedMsg.message,
          ...(turnResult.toolCalls ? { toolCalls: turnResult.toolCalls } : {}),
          ...(turnResult.blocks ? { blocks: turnResult.blocks } : {}),
          ...(turnResult.usage ? { usage: turnResult.usage } : {}),
          aborted: true,
        },
      });
      if (isParallel) {
        state.activeBotIds.delete(item.botId);
      }
      return 'cancelled';
    }

    const replyMentions = extractMentions(turnResult.replyText, validBotIds).filter((id) => id !== item.botId);
    const maxRowidBeforeInsert = this.db.getMaxMessageRowid(sessionId);

    const nativeRuns: SubagentRunRecord[] = (turnResult.subagentRuns || []).map((r) => {
      const mirrored = this.mirroredSubagentRuns.get(r.id)?.run;
      this.mirroredSubagentRuns.delete(r.id);
      return mirrored ? { ...r, ...mirrored, status: r.status } : r;
    });
    const allSubagentRuns: SubagentRunRecord[] = nativeRuns;

    const newMsg = this.db.createMessage({
      id: `msg_${randomUUID()}`,
      sessionId,
      role: 'assistant',
      senderBotId: item.botId,
      modelBadge: turnResult.modelBadge,
      content: turnResult.replyText,
      mentions: replyMentions,
      ...(allSubagentRuns.length > 0 ? { subagentRuns: allSubagentRuns } : {}),
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
        ...(allSubagentRuns.length > 0 ? { subagentRuns: allSubagentRuns } : {}),
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
