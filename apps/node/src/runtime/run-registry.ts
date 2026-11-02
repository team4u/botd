import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { SubagentRunRecord } from '@botd/protocol';
import type { SubagentHandoffScope } from '../commands.js';
import type { SubagentBridge } from './subagent-bridge.js';

/**
 * 回合运行注册表：收敛 runtime 的全部模块级可变状态为单个对象。
 * runKey = `${sessionId}:${botId}`；pending 与 active 的区分保证「占位在任何 await 之前」。
 */

export interface ActiveTurnContext {
  runKey: string;
  sessionId: string;
  botId: string;
  dataDir: string;
  handoffScope: SubagentHandoffScope;
  session: AgentSession;
  /** 本回合的分身事件桥（未挂载分身扩展时为 undefined） */
  subagentBridge?: SubagentBridge;
  /** runId → 分身会话文件与身份（跨回合 resume 追问时重开同一上下文） */
  sessionFiles: Map<string, { sessionFile: string; subagentId: string; task: string }>;
  /** 推送 / 更新一条分身记录并转发到 Hub */
  emitSubagentEvent: (run: SubagentRunRecord, patch?: Partial<SubagentRunRecord>) => void;
  /** 取本回合已知的分身运行记录 */
  peekSubagentRun: (runId: string) => SubagentRunRecord | undefined;
}

export class RunRegistry {
  private readonly pendingRuns = new Set<string>();
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly cancelledRuns = new Set<string>();
  private readonly runKeyToDataDir = new Map<string, string>();
  private readonly activeTurns = new Map<string, ActiveTurnContext>();

  /** 占位（必须在任何 await 之前调用）；已运行则返回 false */
  reserve(runKey: string, dataDir: string): boolean {
    if (this.pendingRuns.has(runKey) || this.activeSessions.has(runKey)) return false;
    this.pendingRuns.add(runKey);
    this.runKeyToDataDir.set(runKey, dataDir);
    this.cancelledRuns.delete(runKey);
    return true;
  }

  /** 回合会话建立：pending → active */
  activate(runKey: string, session: AgentSession): void {
    this.pendingRuns.delete(runKey);
    this.activeSessions.set(runKey, session);
  }

  /** 取消标记（cancelBotTurn / cancelAllBotTurns 调用） */
  cancel(runKey: string): boolean {
    this.cancelledRuns.add(runKey);
    return this.activeSessions.has(runKey) || this.pendingRuns.has(runKey);
  }

  isCancelled(runKey: string): boolean {
    return this.cancelledRuns.has(runKey);
  }

  getSession(runKey: string): AgentSession | undefined {
    return this.activeSessions.get(runKey);
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size + this.pendingRuns.size;
  }

  registerTurn(ctx: ActiveTurnContext): void {
    this.activeTurns.set(ctx.runKey, ctx);
  }

  /** 回合收尾：清空该 runKey 的全部痕迹（finally 路径统一调用） */
  release(runKey: string): void {
    this.pendingRuns.delete(runKey);
    this.activeSessions.delete(runKey);
    this.activeTurns.delete(runKey);
    this.cancelledRuns.delete(runKey);
    this.runKeyToDataDir.delete(runKey);
  }

  /** 按 sessionId 找当前活跃回合上下文（同一会话同刻只有一个主回合在跑） */
  findActiveTurn(sessionId: string): ActiveTurnContext | undefined {
    for (const ctx of this.activeTurns.values()) {
      if (ctx.sessionId === sessionId) return ctx;
    }
    return undefined;
  }

  /** 全部活跃会话（cancelAllBotTurns 用） */
  entriesWithSession(): Array<[runKey: string, session: AgentSession]> {
    return [...this.activeSessions.entries()];
  }

  pendingRunKeys(dataDir?: string): string[] {
    if (!dataDir) return [...this.pendingRuns.keys()];
    return [...this.pendingRuns.keys()].filter((key) => this.runKeyToDataDir.get(key) === dataDir);
  }

  dataDirOf(runKey: string): string | undefined {
    return this.runKeyToDataDir.get(runKey);
  }
}

/** 进程级唯一注册表 */
export const runRegistry = new RunRegistry();

/**
 * 清理上一轮异常退出残留的 pi-subagents 全局 manager 注册表
 * （pi-subagents 仅在自身 session_shutdown 里释放；新回合开始前清掉陈旧注册，
 * 避免旧 manager 的后台分身孤儿化）。
 */
export function purgeStaleSubagentManager(whenIdle: boolean): void {
  try {
    const managerKey = Symbol.for('pi-subagents:manager');
    const stale = (globalThis as any)[managerKey];
    if (stale && whenIdle) {
      stale.abortAll?.();
      delete (globalThis as any)[managerKey];
    }
  } catch {
    // ignore
  }
}
