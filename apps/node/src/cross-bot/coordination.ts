import {
  setDefaultsDisabled,
  setFallbackSubagent,
  NO_FALLBACK,
  registerAgents,
} from '@tintinweb/pi-subagents/dist/agent-types.js';
import { loadCustomAgents } from '@tintinweb/pi-subagents/dist/custom-agents.js';

/**
 * 进程级协调原语：全局 subagent manager 注册表、事件总线 RPC、
 * 主回合接管作用域（handoff scope）、组合信号监听。被 commands.ts 的
 * Agent 工具包装器、cross-bot/workflow.ts 的工作流 host 与 runtime 共用。
 */

/**
 * 全局 subagent manager 注册表（由 pi-subagents 扩展用 Symbol.for 挂载）。
 * 只读出运行/停止能力，不持有具体类型引用，避免与扩展内部结构耦合。
 */
export function getGlobalSubagentManager():
  | {
      hasRunning?: () => boolean;
      waitForAll?: () => Promise<void>;
      abort?: (id: string) => boolean;
      abortAll?: () => number;
      steer?: (id: string, message: string) => boolean;
      resume?: (id: string, prompt: string, signal?: AbortSignal, options?: any) => Promise<any>;
      spawn?: (pi: unknown, ctx: unknown, type: string, prompt: string, options: any) => string;
      getRecord?: (id: string) => any;
      listAgents?: () => any[];
    }
  | undefined {
  return (globalThis as any)[Symbol.for('pi-subagents:manager')];
}

/** 通过 pi.events 事件总线调用 subagents 扩展的 RPC（stop / steer 等），返回是否成功 */
export function requestSubagentsRpc(
  pi: { events: { on: (ch: string, fn: (d: unknown) => void) => () => void; emit: (ch: string, d: unknown) => void } },
  channel: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const requestId = `botd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `${channel}:reply:${requestId}`;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        unsub();
        resolve(false);
      }
    }, timeoutMs);
    const unsub = pi.events.on(replyChannel, (reply: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(Boolean((reply as any)?.success));
    });
    pi.events.emit(channel, { ...params, requestId });
  });
}

/**
 * 主会话“用户新消息接管”（steerBotTurn）时需要释放的前台子代理等待句柄。
 * 每个主回合开始时创建，回合结束时消费并清理。
 */
export interface SubagentHandoffScope {
  /** 触发前台等待解除（子代理转后台继续运行，主 Bot 立即接管响应） */
  triggerHandoff(): void;
  /** 本回合是否已触发过接管 */
  wasTriggered(): boolean;
  /** 当回栈解绑，返回是否曾被触发 */
  settle(): boolean;
}

let activeHandoffScope: SubagentHandoffScope | undefined;

export function getActiveSubagentHandoffScope(): SubagentHandoffScope | undefined {
  return activeHandoffScope;
}

/** 开始一个主回合的接管作用域（runtime.runBotTurn 在 session 建立前后调用均可） */
export function beginSubagentHandoffScope(): SubagentHandoffScope {
  const previous = activeHandoffScope;
  if (previous) previous.settle();
  let triggered = false;
  activeHandoffScope = {
    triggerHandoff() {
      triggered = true;
    },
    wasTriggered: () => triggered,
    settle() {
      const was = triggered;
      triggered = false;
      if (activeHandoffScope === this) activeHandoffScope = undefined;
      return was;
    },
  };
  return activeHandoffScope;
}

/** 结束接管作用域（finally 路径统一调用，防止残留到下一回合） */
export function endSubagentHandoffScope(scope: SubagentHandoffScope | undefined): void {
  if (scope) scope.settle();
  else activeHandoffScope = undefined;
}

/** 供 runtime 导出给 daemon 的 steerBotTurn 使用：触发当前主回合的前台子代理转后台 */
export function triggerActiveSubagentHandoff(): boolean {
  const scope = activeHandoffScope;
  if (!scope) return false;
  scope.triggerHandoff();
  return true;
}

/**
 * 以当前 BOT 的目录为唯一事实来源，重置 pi-subagents 的全局状态：
 * `PI_CODING_AGENT_DIR` 是进程级可变环境变量，多个主 BOT 共享同一 daemon 时，
 * 并发回合会互相覆盖它（A 的 Agent 工具执行时可能读到 B 刚写入的值），导致
 * 子代理注册表解析成别的 BOT 的（空）目录——工具描述里列出的类型在执行时
 * 变成 "Available: (none)"。本函数在派发/解析前同步调用，保证解析窗口内
 * 全局目录与注册表属于当前 BOT。
 */
export function rebindSubagentGlobalsForBot(botDir: string): void {
  process.env.PI_CODING_AGENT_DIR = botDir;
  setDefaultsDisabled(false);
  setFallbackSubagent(NO_FALLBACK);
  registerAgents(loadCustomAgents(botDir));
}

export interface HandoffWatch {
  combo: AbortController;
  signal: AbortSignal;
  isHandedOff: () => boolean;
  cleanup: () => void;
}

/** 组合信号监听：父级取消（整会话停止）与用户接管轮询（80ms），集中管理 cleanup 避免样板代码重复 */
export function createHandoffWatch(options: {
  parentSignal?: AbortSignal;
  handoffScope?: { wasTriggered: () => boolean };
  onParentAbort?: () => void;
}): HandoffWatch {
  const combo = new AbortController();
  let handedOff = false;

  const onParentAbort = () => {
    options.onParentAbort?.();
    combo.abort();
  };
  const onHandoff = () => {
    handedOff = true;
    combo.abort();
  };

  if (options.parentSignal?.aborted) {
    onParentAbort();
  } else {
    options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }

  const handoffPoll = setInterval(() => {
    if (options.handoffScope?.wasTriggered()) onHandoff();
  }, 80);

  const cleanup = () => {
    clearInterval(handoffPoll);
    options.parentSignal?.removeEventListener?.('abort', onParentAbort);
  };

  return {
    combo,
    signal: combo.signal,
    isHandedOff: () => handedOff,
    cleanup,
  };
}
