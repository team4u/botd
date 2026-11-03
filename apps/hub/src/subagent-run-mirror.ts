import type {
  SubagentRunRecord,
  SubagentSteerRecord,
  ToolCallRecord,
  TurnBlock,
} from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { NodeConnectionManager } from './ws-hub.js';
import type { SseHub } from './sse.js';

export interface SubagentStreamEvent {
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

interface MirroredRunEntry {
  sessionId: string;
  directSessionId: string;
  parentBotId?: string;
  run: SubagentRunRecord;
}

/**
 * 子代理运行镜像机制：维护 hub 侧子代理 run 的内存镜像（流事件驱动），
 * 同步持久化到已落库消息，并支持 stop / steer / resume 控制指令转发到节点。
 */
export class SubagentRunMirror {
  private mirrored = new Map<string, MirroredRunEntry>();

  constructor(
    private db: HubDatabase,
    private connections: NodeConnectionManager,
    private sseHub: SseHub,
    /** 从会话运行时状态取当前活跃主 BOT（回合执行状态归 GroupRouter 管） */
    private getActiveBotId: (sessionId: string) => string | undefined
  ) {}

  /** 回合结束时取回并移除镜像（用于与节点返回的 native run 合并） */
  takeMirroredRun(runId: string): SubagentRunRecord | undefined {
    const run = this.mirrored.get(runId)?.run;
    this.mirrored.delete(runId);
    return run;
  }

  handleNativeSubagentStreamEvent(
    sessionId: string,
    parentBotId: string,
    subEvent: SubagentStreamEvent
  ): SubagentRunRecord | undefined {
    const session = this.db.getSession(sessionId);
    if (!session) return undefined;
    const subBot = this.db.getBot(subEvent.subagentId);

    let entry = this.mirrored.get(subEvent.id);
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
        parentBotId: parentBotId || undefined,
        run,
      };
      this.mirrored.set(subEvent.id, entry);
    }
    if (parentBotId) entry.parentBotId = parentBotId;
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

  /** 定位 runId 归属的主 BOT：活跃回合的 activeBotId → 流事件镜像记录的 parentBotId → 最近包含该 runId 的消息 sender */
  private resolveParentBotId(sessionId: string, runId: string): string | undefined {
    let parentBotId = this.getActiveBotId(sessionId);
    if (!parentBotId) parentBotId = this.mirrored.get(runId)?.parentBotId;
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
    return parentBotId;
  }

  /** 单独停掉某个运行中的子代理（转发到对应节点，含已落库消息的状态同步） */
  async stopSubagent(sessionId: string, runId: string): Promise<{ ok: boolean; error?: string }> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const parentBotId = this.resolveParentBotId(sessionId, runId);
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
      const entry = this.mirrored.get(runId);
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

    const parentBotId = this.resolveParentBotId(sessionId, runId);
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
      const entry = this.mirrored.get(runId);
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
}
