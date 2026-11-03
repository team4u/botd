import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import type { BotConfig, ChatCommand, DelegateSessionResult } from '@botd/protocol';
import { assertSafeId, ensureDir, getBotDir, readNodeIdentity, writeAtomicFile } from './storage.js';
import subagentsExtension from '@tintinweb/pi-subagents/dist/index.js';
import {
  setDefaultsDisabled,
  setFallbackSubagent,
  NO_FALLBACK,
  registerAgents,
  resolveSpawnType,
} from '@tintinweb/pi-subagents/dist/agent-types.js';
import { loadCustomAgents } from '@tintinweb/pi-subagents/dist/custom-agents.js';
import { runWorkflow, validateScript, type WorkflowHost } from '@tintinweb/pi-subagents/dist/workflow/runtime.js';
import { createWorkflowHost } from '@tintinweb/pi-subagents/dist/workflow/host.js';
import { appendJournal, readJournal, type WorkflowJournalEntry } from '@tintinweb/pi-subagents/dist/workflow/journal.js';
import {
  completeWorkflowTask,
  createWorkflowTask,
  failWorkflowTask,
  updateWorkflowProgressBatch,
  workflowResultText,
  workflowRunId,
} from '@tintinweb/pi-subagents/dist/workflow/task.js';
import { resolveWorkflowScript, resolveWorkflowSource } from '@tintinweb/pi-subagents/dist/workflow/saved.js';
import type { ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** pi-subagents 扩展工厂：为主 BOT 提供 Agent / SubagentWorkflow 编排底座。 */
const subagentsExtensionFactory: ExtensionFactory = subagentsExtension as unknown as ExtensionFactory;

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

function getActiveSubagentHandoffScope(): SubagentHandoffScope | undefined {
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
function rebindSubagentGlobalsForBot(botDir: string): void {
  process.env.PI_CODING_AGENT_DIR = botDir;
  setDefaultsDisabled(true);
  setFallbackSubagent(NO_FALLBACK);
  registerAgents(loadCustomAgents(botDir));
}

/**
 * 框架内部（delegate_bot / 工作流跨 BOT 步骤）连接 Hub：优先节点身份的 hubUrl。
 * cli.json 是用户侧 CLI 的持久化状态，可能残留过期地址（如 Hub 换端口后），
 * 框架内部调用不应被它劫持——daemon 自己的 node.json 才是当前配对事实。
 * 未配对时退回 cli.json / 默认登录路径，保持 CLI 手动配置仍可用。
 */
async function connectHubAsNode(dataDir: string): Promise<import('./cli/hub-client.js').HubClient> {
  const { HubClient } = await import('./cli/hub-client.js');
  const identity = await readNodeIdentity(dataDir);
  return HubClient.connect(identity?.hubUrl ? { dataDir, hubUrl: identity.hubUrl } : { dataDir });
}

/**
 * 包装 Agent 工具 execute：主 Bot 前台等待子代理时，若用户在主会话发新消息
 * （steerBotTurn → triggerActiveSubagentHandoff），等待立即解除，返回提示文本让主 Bot
 * 接管新消息并用 stop_subagent / steer_subagent / get_subagent_result 控制子代理。
 *
 * 同时支持跨 Bot 子会话委派（subagent_type 传 @botId / bot:botId 或其他主 BOT ID）：
 * 统一收口到与 SubagentWorkflow 一致的跨 Bot 委派模型，支持前台等待/后台运行/断点续跑（resume），
 * 并向协同面板发射携带 childSessionId 的 subagents:* 事件。
 */
interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface CrossBotSessionRecord {
  childSessionId: string;
  botId: string;
  label: string;
  phaseTitle?: string;
}

/** 跨 Bot 子会话全局映射表：支持按 agentId、runId、label 或 childSessionId 查找 */
const crossBotSessionMap = new Map<string, CrossBotSessionRecord>();

interface HandoffWatch {
  combo: AbortController;
  signal: AbortSignal;
  isHandedOff: () => boolean;
  cleanup: () => void;
}

/** 组合信号监听：父级取消（整会话停止）与用户接管轮询（80ms），集中管理 cleanup 避免样板代码重复 */
function createHandoffWatch(options: {
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

/**
 * 向跨 Bot 子会话发送跟进消息并等待该会话回到 idle / failed。
 * 时序与 delegateSessionAndWait 对齐：先订阅子会话 SSE 确认流已激活，再 POST 消息。
 */
async function sendSessionMessageAndWait(
  client: import('./cli/hub-client.js').HubClient,
  childSessionId: string,
  prompt: string,
  options: {
    waitSeconds: number;
    signal?: AbortSignal;
  },
): Promise<{ ok: boolean; status: 'done' | 'failed'; reply: string }> {
  const abortController = new AbortController();
  const externalAbort = () => abortController.abort();
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener('abort', externalAbort, { once: true });

  const streamReady = createDeferred<void>();
  let streamReadySettled = false;
  let sawInitialSnapshot = false;
  let sawRunningOrQueued = false;
  let sawActivity = false;
  const completion = createDeferred<{ status: 'done' | 'failed' }>();
  let completionSettled = false;

  const eventsPromise = client
    .events(childSessionId, {
      signal: abortController.signal,
      onEvent: (event: any) => {
        if (!streamReadySettled) {
          streamReadySettled = true;
          streamReady.resolve();
        }
        if (event.type === 'message_created') {
          sawActivity = true;
        }
        if (event.type === 'session_status') {
          if (!sawInitialSnapshot) {
            sawInitialSnapshot = true;
            return;
          }
          if (event.status === 'running' || event.status === 'queued') {
            sawRunningOrQueued = true;
          } else if ((sawRunningOrQueued || sawActivity) && (event.status === 'idle' || event.status === 'failed')) {
            if (!completionSettled) {
              completionSettled = true;
              completion.resolve({ status: event.status === 'failed' ? 'failed' : 'done' });
            }
          }
        }
      },
    })
    .catch((err: unknown) => {
      if (!streamReadySettled) {
        streamReadySettled = true;
        streamReady.reject(err);
      }
    });

  try {
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const streamTimeout = new Promise<never>((_, reject) => {
      streamTimer = setTimeout(() => {
        reject(new Error('Timed out opening child session event stream'));
      }, 10_000);
    });
    try {
      await Promise.race([streamReady.promise, streamTimeout]);
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
    }

    await client.post(`/api/sessions/${encodeURIComponent(childSessionId)}/messages`, {
      content: prompt,
    });

    if (!completionSettled) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const waitTimeout = new Promise<never>((_, reject) => {
        waitTimer = setTimeout(() => {
          reject(new Error(`Timed out after ${options.waitSeconds}s waiting for child session turn`));
        }, options.waitSeconds * 1000);
      });
      const onAbort = () => {
        if (!completionSettled) {
          completionSettled = true;
          completion.resolve({ status: 'failed' });
        }
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await Promise.race([completion.promise, waitTimeout]);
      } finally {
        if (waitTimer) clearTimeout(waitTimer);
        abortController.signal.removeEventListener('abort', onAbort);
      }
    }

    const completionResult = await completion.promise;
    const messages = await client
      .get<any[]>(`/api/sessions/${encodeURIComponent(childSessionId)}/messages`)
      .catch(() => []);
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const lastSystem = [...messages].reverse().find((m) => m.role === 'system');
    const reply = lastAssistant?.content?.trim() || lastSystem?.content?.trim() || '';

    return {
      ok: completionResult.status === 'done',
      status: completionResult.status,
      reply,
    };
  } finally {
    abortController.abort();
    await eventsPromise;
  }
}

interface CrossBotSessionOptions {
  client: import('./cli/hub-client.js').HubClient;
  pi: ExtensionAPI;
  parentSessionId: string;
  botId: string;
  prompt: string;
  title?: string;
  artifactIds?: string[];
  runInBackground?: boolean;
  timeoutSeconds?: number;
  handoffScope?: SubagentHandoffScope;
  signal?: AbortSignal;
  stepRunId: string;
  label?: string;
  phaseTitle?: string;
  skipCompletionEvent?: boolean;
  onChildCreated?: (created: DelegateSessionResult) => void;
}

interface CrossBotExecutionResult {
  ok: boolean;
  status: 'done' | 'failed' | 'aborted' | 'background';
  reply: string;
  formattedText: string;
  childSessionId?: string;
  returnedArtifacts: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; url: string }>;
  details: Record<string, unknown>;
  handedOff?: boolean;
  durationMs?: number;
}

/**
 * 跨 Bot 子会话执行共用函数：供 Agent 工具与 SubagentWorkflow 共同复用。
 * 支持前台等待（autoWakeParent: false）与后台运行（autoWakeParent: true）、
 * 父级取消联动与用户新消息接管（handoff）、以及生命周期事件桥接。
 */
async function executeCrossBotSession(options: CrossBotSessionOptions): Promise<CrossBotExecutionResult> {
  const {
    client,
    pi,
    parentSessionId,
    botId,
    prompt,
    title,
    artifactIds,
    runInBackground,
    timeoutSeconds,
    handoffScope,
    signal,
    stepRunId,
    label,
    phaseTitle,
    skipCompletionEvent,
    onChildCreated,
  } = options;

  const startMs = Date.now();
  const description = label || prompt.slice(0, 80);

  // 后台模式：立即派发，子会话完成后 Hub 自动唤醒父会话
  if (runInBackground === true || handoffScope?.wasTriggered()) {
    const res = await client.post<DelegateSessionResult>(
      `/api/sessions/${encodeURIComponent(parentSessionId)}/delegate`,
      {
        botId,
        prompt,
        title,
        artifactIds,
        autoWakeParent: true,
      },
    );
    const rec: CrossBotSessionRecord = {
      childSessionId: res.childSession.id,
      botId,
      label: label || botId,
      ...(phaseTitle !== undefined ? { phaseTitle } : {}),
    };
    crossBotSessionMap.set(stepRunId, rec);
    crossBotSessionMap.set(res.childSession.id, rec);
    if (label) crossBotSessionMap.set(label, rec);

    onChildCreated?.(res);
    pi.events.emit('subagents:started', {
      id: stepRunId,
      type: botId,
      description,
      ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
      childSessionId: res.childSession.id,
    });

    const formattedText = `Delegated background sub-session "${res.childSession.id}" (${res.childSession.title}) to @${botId}. The parent session will be woken up automatically when all active sub-sessions complete.`;
    return {
      ok: true,
      status: 'background',
      reply: '',
      formattedText,
      childSessionId: res.childSession.id,
      returnedArtifacts: [],
      details: { ...res, agentId: stepRunId, childSessionId: res.childSession.id },
    };
  }

  // 前台模式：等待子会话执行完成，支持接管转后台与父级取消
  const { delegateSessionAndWait } = await import('./cli/commands/sessions.js');
  let childSessionId = '';
  const watch = createHandoffWatch({
    parentSignal: signal,
    handoffScope,
    onParentAbort: () => {
      if (childSessionId) {
        void client
          .post(`/api/sessions/${encodeURIComponent(childSessionId)}/cancel`)
          .catch(() => {});
      }
    },
  });

  let waitRes: Awaited<ReturnType<typeof delegateSessionAndWait>> | undefined;
  try {
    waitRes = await delegateSessionAndWait(
      client,
      parentSessionId,
      {
        botId,
        prompt,
        title,
        artifactIds,
        autoWakeParent: false,
      },
      {
        waitSeconds: timeoutSeconds ?? 600,
        signal: watch.signal,
        onChildCreated: (r) => {
          childSessionId = r.childSession.id;
          const rec: CrossBotSessionRecord = {
            childSessionId,
            botId,
            label: label || botId,
            ...(phaseTitle !== undefined ? { phaseTitle } : {}),
          };
          crossBotSessionMap.set(stepRunId, rec);
          crossBotSessionMap.set(childSessionId, rec);
          if (label) crossBotSessionMap.set(label, rec);

          onChildCreated?.(r);
          pi.events.emit('subagents:started', {
            id: stepRunId,
            type: botId,
            description,
            ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
            childSessionId: r.childSession.id,
          });
        },
      },
    );
  } catch (err) {
    if (watch.isHandedOff() || signal?.aborted || watch.signal.aborted) {
      waitRes = undefined;
    } else {
      watch.cleanup();
      throw err;
    }
  } finally {
    watch.cleanup();
  }

  const durationMs = Date.now() - startMs;
  const handedOff = watch.isHandedOff();

  if (!waitRes) {
    const formattedText = handedOff
      ? `Delegated sub-session "${childSessionId}" (@${botId}) has been moved to the background because the user sent a new message in the session. It is STILL RUNNING.`
      : `Delegated sub-session "${childSessionId}" (@${botId}) wait was aborted.`;
    return {
      ok: false,
      status: 'aborted',
      reply: formattedText,
      formattedText,
      childSessionId,
      returnedArtifacts: [],
      details: { agentId: stepRunId, childSessionId },
      handedOff,
      durationMs,
    };
  }

  const isFailed = waitRes.status === 'failed';
  if (!skipCompletionEvent) {
    pi.events.emit(isFailed ? 'subagents:failed' : 'subagents:completed', {
      id: stepRunId,
      type: botId,
      description,
      ...(phaseTitle !== undefined ? { phase: phaseTitle } : {}),
      childSessionId: waitRes.childSession.id,
      status: isFailed ? 'error' : 'completed',
      ...(isFailed ? { error: waitRes.reply || 'Cross-bot sub-session failed' } : { result: waitRes.reply }),
      durationMs,
    });
  }

  const lines = [`Sub-session: ${waitRes.childSession.id} (@${botId}) — ${waitRes.status}`, waitRes.reply];
  if (waitRes.returnedArtifacts.length > 0) {
    lines.push('Returned artifacts:');
    for (const artifact of waitRes.returnedArtifacts) {
      lines.push(`- ${artifact.filename} (id: ${artifact.id}, url: ${artifact.url})`);
    }
  }

  return {
    ok: !isFailed,
    status: isFailed ? 'failed' : 'done',
    reply: waitRes.reply,
    formattedText: lines.join('\n'),
    childSessionId: waitRes.childSession.id,
    returnedArtifacts: waitRes.returnedArtifacts,
    details: { ...waitRes, agentId: stepRunId, childSessionId: waitRes.childSession.id },
    durationMs,
  };
}

interface WrapAgentToolDeps {
  dataDir: string;
  bot: BotConfig;
  botDir: string;
  workspaceDir: string;
  sessionId?: string;
  pi: ExtensionAPI;
  handoffScope: SubagentHandoffScope | undefined;
}

function wrapAgentToolForHandoff(tool: any, deps: WrapAgentToolDeps): any {
  const originalExecute = tool.execute?.bind(tool);
  if (typeof originalExecute !== 'function') return tool;
  const { dataDir, botDir, pi, handoffScope } = deps;

  const dispatchWithThisBotsAgents = (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: any,
  ) => {
    // 同步重置全局注册表再进入原 execute：pi-subagents 的 execute 前缀
    // （reloadCustomAgents + resolveSpawnType）是同步的，JS 单线程内这一步
    // 之后、首个 await 之前的解析不会被并发回合的环境覆盖。
    if (botDir) rebindSubagentGlobalsForBot(botDir);
    return originalExecute(toolCallId, params, signal, onUpdate, ctx);
  };

  const makeTextResult = (text: string, isError = false) =>
    ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) }) as any;

  const findTool = (ctx: any, name: string): any => {
    try {
      const runner = ctx?.session?.extensionRunner ?? ctx?.extensionRunner;
      const def = runner?.getToolDefinition?.(name);
      if (def?.execute) return def;
    } catch {
      // fall through
    }
    return undefined;
  };

  // 扩展参数定义与工具描述
  const parameters = tool.parameters ? { ...tool.parameters } : { type: 'object', properties: {} };
  const properties = { ...(parameters.properties || {}) };

  if (properties.subagent_type) {
    properties.subagent_type = {
      ...properties.subagent_type,
      description:
        'The subagent type to spawn (local role subagent ID sharing this workspace) or target primary BOT ID ' +
        '(e.g. "@botId", "bot:botId", or "botId") to delegate via an isolated sub-session with zero-copy artifact sharing.',
    };
  }
  if (!properties.title) {
    properties.title = {
      type: 'string',
      description: 'Optional short title for cross-bot sub-session (defaults to description).',
    };
  }
  if (!properties.artifact_ids) {
    properties.artifact_ids = {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional list of parent session artifact IDs to share with the sub-session. Omit to share all current session artifacts.',
    };
  }
  if (!properties.timeout_seconds) {
    properties.timeout_seconds = {
      type: 'number',
      description: 'Maximum seconds to wait when run_in_background is false (default: 600).',
    };
  }
  parameters.properties = properties;

  const description =
    'Spawn an autonomous subagent or delegate to another primary BOT. ' +
    'For subagent_type, you can pass either a local role subagent ID (shares your workspace) ' +
    'or another primary BOT ID (prefixed with "@", "bot:", or direct bot ID, runs in an isolated sub-session with zero-copy artifact sharing). ' +
    'Defaults to run_in_background: false (waits for completion inline; emit multiple Agent calls in one turn to run in parallel). ' +
    'Set run_in_background: true for long-running tasks that wake the parent session when done.';

  const wrappedExecute = async (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: any,
  ) => {
    // 1) 跨 Bot 子会话 resume 判定
    if (params?.resume) {
      const resumeRef = String(params.resume).trim();
      const remote =
        crossBotSessionMap.get(resumeRef) ??
        (resumeRef.startsWith('sess_')
          ? { childSessionId: resumeRef, botId: 'remote', label: resumeRef }
          : undefined);
      if (remote) {
        const runId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const startMs = Date.now();
        const desc = String(params.description || params.prompt || '').slice(0, 80);
        pi.events.emit('subagents:started', {
          id: runId,
          type: remote.botId,
          description: desc,
          childSessionId: remote.childSessionId,
        });
        const client = await connectHubAsNode(dataDir);
        const res = await sendSessionMessageAndWait(client, remote.childSessionId, String(params.prompt || ''), {
          waitSeconds: params.timeout_seconds ?? 600,
          signal,
        });
        pi.events.emit(res.ok ? 'subagents:completed' : 'subagents:failed', {
          id: runId,
          type: remote.botId,
          description: desc,
          childSessionId: remote.childSessionId,
          status: res.ok ? 'completed' : 'error',
          ...(res.ok ? { result: res.reply } : { error: res.reply || 'Resume failed' }),
          durationMs: Date.now() - startMs,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Sub-session: ${remote.childSessionId} (@${remote.botId}) — ${res.status}\n${res.reply}`,
            },
          ],
          details: { ...res, agentId: runId, childSessionId: remote.childSessionId },
          ...(res.ok ? {} : { isError: true }),
        } as any;
      }
      return dispatchWithThisBotsAgents(toolCallId, params, signal, onUpdate, ctx);
    }

    // 2) 路由判定：本地子代理 vs 跨 Bot 子会话
    const rawType = String(params?.subagent_type || '').trim();
    const cleanType = rawType.replace(/^(?:@|bot:)/, '');
    const forceRemote = rawType.startsWith('@') || rawType.startsWith('bot:');

    if (botDir) rebindSubagentGlobalsForBot(botDir);
    const localDispatch = !forceRemote ? resolveSpawnType(cleanType) : { ok: false as const };

    // Branch A：本地子代理
    if (localDispatch.ok) {
      const wantsForeground = params?.run_in_background === false || params?.run_in_background === undefined;
      // 仅拦截“新前台调用且非 resume”：resume / 后台 / 定时调用走原路径
      if (!wantsForeground || params?.schedule) {
        return dispatchWithThisBotsAgents(toolCallId, params, signal, onUpdate, ctx);
      }

      // 已被接管（用户已发新消息）：这次调用直接按后台跑，不再阻塞
      if (handoffScope?.wasTriggered()) {
        return dispatchWithThisBotsAgents(toolCallId, { ...params, run_in_background: true }, signal, onUpdate, ctx);
      }

      const getResultTool = findTool(ctx, 'get_subagent_result');
      if (!getResultTool) {
        // 找不到等待工具（扩展未激活）：退回原生行为
        return dispatchWithThisBotsAgents(toolCallId, params, signal, onUpdate, ctx);
      }

      // 以后台方式启动子代理，拿到 agentId
      const bgResult = await dispatchWithThisBotsAgents(toolCallId, { ...params, run_in_background: true }, signal, onUpdate, ctx);
      const agentId = String((bgResult as any)?.details?.agentId || '').trim();
      if (!agentId) {
        return bgResult;
      }

      // 组合信号：父级取消（整会话停止）或用户接管（主会话新消息）
      const watch = createHandoffWatch({
        parentSignal: signal,
        handoffScope,
        onParentAbort: () => {
          const manager = getGlobalSubagentManager();
          manager?.abort?.(agentId);
        },
      });

      try {
        const waitResult = await getResultTool.execute(
          `wait_${toolCallId}`,
          { agent_id: agentId, wait: true },
          watch.signal,
          undefined,
          ctx,
        );
        if (watch.isHandedOff()) {
          return makeTextResult(
            `Agent "${agentId}" (${params.subagent_type}) has been moved to the background because the user sent a new message in the session. It is STILL RUNNING. Read the user's new message and use stop_subagent, steer_subagent, or get_subagent_result with agent_id "${agentId}" as needed.`
          );
        }
        return waitResult;
      } finally {
        watch.cleanup();
      }
    }

    // Branch B：跨 Bot 子会话委派
    const parentSessionId = deps.sessionId || process.env.BOTD_SESSION_ID || '';
    if (!parentSessionId) {
      return makeTextResult('Missing session context: cannot resolve the parent session ID for subagent dispatch.', true);
    }
    if (!cleanType) {
      return makeTextResult('Missing required parameter: subagent_type.', true);
    }
    if (!params?.prompt || String(params.prompt).trim() === '') {
      return makeTextResult('Missing required parameter: prompt is required.', true);
    }

    const runId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const client = await connectHubAsNode(dataDir);
    const execRes = await executeCrossBotSession({
      client,
      pi,
      parentSessionId,
      botId: cleanType,
      prompt: String(params.prompt).trim(),
      title: params?.title || params?.description,
      artifactIds: params?.artifact_ids,
      runInBackground: params?.run_in_background === true,
      timeoutSeconds: params?.timeout_seconds ?? 600,
      handoffScope,
      signal,
      stepRunId: runId,
      label: params?.description || cleanType,
    });

    return {
      content: [{ type: 'text', text: execRes.formattedText }],
      details: execRes.details,
      ...(execRes.status === 'failed' ? { isError: true } : {}),
    } as any;
  };

  return { ...tool, description, parameters, execute: wrappedExecute };
}

/** 从文本回复中提取结构化 JSON：优先整体解析，其次 ```json 围栏，最后首尾大括号截取 */
function extractJsonFromText(text: string): unknown | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // fall through
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 子代理记录的终态（与 pi-subagents host 的 toSpawnResult 成败判定对齐） */
const SUBAGENT_TERMINAL_STATUSES = new Set(['completed', 'steered', 'error', 'stopped', 'aborted']);

/**
 * 把全局 subagent manager 注册表（Symbol.for('pi-subagents:manager')，仅暴露
 * spawn/getRecord/hasRunning/waitForAll）适配成 createWorkflowHost 需要的
 * AgentManager 形状：spawnAndWait 通过 spawn(isBackground) + 终态轮询实现，
 * abort / consume 通过事件总线 RPC（subagents:rpc:stop / :consume）实现。
 * 消费结果（consume）避免本地步骤完成后又被扩展补发一条完成通知，
 * 与 Agent 工具的 get_subagent_result(wait) 消费语义一致。
 */
function createLocalWorkflowManager(
  registry: NonNullable<ReturnType<typeof getGlobalSubagentManager>>,
  pi: ExtensionAPI,
): unknown {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    getRecord: (id: string) => registry.getRecord?.(id),
    abort: (id: string) => {
      // 异步尽力停止：stop RPC 拒绝非运行中的代理时静默吞掉
      void requestSubagentsRpc(pi, 'subagents:rpc:stop', { agentId: id });
      return true;
    },
    async resume() {
      // 注册表未暴露 resume：返回 undefined 让 host 报告“无可恢复会话”
      return undefined;
    },
    async spawnAndWait(
      piRef: unknown,
      ctxRef: unknown,
      type: string,
      prompt: string,
      options: Record<string, any>,
      onSpawned?: (id: string) => void,
    ) {
      // spawnTopLevel 强制 detached（不占前台池）：自行轮询记录终态
      const id = registry.spawn!(piRef, ctxRef, type, prompt, { ...options, isBackground: true });
      onSpawned?.(id);
      const signal = options?.signal as AbortSignal | undefined;
      for (;;) {
        if (signal?.aborted) {
          void requestSubagentsRpc(pi, 'subagents:rpc:stop', { agentId: id });
          await sleep(300);
          const record = registry.getRecord?.(id);
          return { record: record ?? { status: 'stopped', error: 'Stopped.' } };
        }
        const record = registry.getRecord?.(id);
        if (record && SUBAGENT_TERMINAL_STATUSES.has(String((record as any).status))) {
          // 已终态：标记结果已消费，抑制扩展补发的后台完成通知
          void requestSubagentsRpc(pi, 'subagents:rpc:consume', { agentId: id });
          return { record };
        }
        await sleep(100);
      }
    },
  };
}

/**
 * 包装 SubagentWorkflow 工具：为跨 BOT 协同提供 CompositeWorkflowHost。
 *
 * 行为变化（相对原生 SubagentWorkflow）：
 * - 前台同步执行（原生是后台 + 通知）；完成后直接返回结构化摘要文本。
 * - 工作流步骤的 agentType 可以写 "@<botId>" 或 "bot:<botId>" 强制路由到另一个主 BOT
 *   （通过 Hub 子会话委派）；不带前缀时先尝试本地子代理，解析失败即视为跨 BOT 目标。
 * - 每次运行把脚本副本与 `<runId>.workflow.jsonl` 断点日志落盘到 `<workspaceDir>/.workflows/`，
 *   失败后可用 `{ scriptPath, resumeFromRunId: "<runId>" }` 从失败步骤断点续跑
 *   （已完成步骤直接从日志缓存回放，不再重新调用子代理/子会话）。
 */
function wrapWorkflowToolForCrossBot(
  tool: any,
  deps: {
    dataDir: string;
    bot: BotConfig;
    botDir: string;
    workspaceDir: string;
    sessionId?: string;
    pi: ExtensionAPI;
    handoffScope: SubagentHandoffScope | undefined;
  },
): any {
  const originalExecute = tool.execute?.bind(tool);
  if (typeof originalExecute !== 'function') return tool;
  const { dataDir, botDir, workspaceDir, pi, handoffScope } = deps;

  const textResult = (text: string, isError = false, details?: Record<string, unknown>) =>
    ({
      content: [{ type: 'text', text }],
      ...(details ? { details } : {}),
      ...(isError ? { isError } : {}),
    }) as any;

  const wrappedExecute = async (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    _onUpdate: ((update: unknown) => void) | undefined,
    ctx: any,
  ) => {
    // 与 Agent 工具包装器同理：进入原 execute 前同步重置为本 BOT 的全局注册表，
    // 防止并发回合的环境覆盖导致本地步骤类型解析成别的 BOT 的（空）目录。
    rebindSubagentGlobalsForBot(botDir);

    // 1) 准备 .workflows 目录与断点日志回放
    const workflowsDir = path.join(workspaceDir, '.workflows');
    await ensureDir(workflowsDir);

    let replayEntries: WorkflowJournalEntry[] | undefined;
    const resumeFromRunId = typeof params?.resumeFromRunId === 'string' ? params.resumeFromRunId.trim() : '';
    if (resumeFromRunId) {
      if (!/^wf_[a-z0-9-]+$/i.test(resumeFromRunId)) {
        return textResult(`Invalid resumeFromRunId "${resumeFromRunId}": expected a workflow run id like "wf_ab12cd34ef56".`, true);
      }
      const prevJournalPath = path.join(workflowsDir, `${resumeFromRunId}.workflow.jsonl`);
      const prevScriptPath = path.join(workflowsDir, `${resumeFromRunId}.mjs`);
      if (!existsSync(prevJournalPath) && !existsSync(prevScriptPath)) {
        return textResult(
          `Cannot resume workflow "${resumeFromRunId}": run journal not found in ${workflowsDir}.`,
          true,
        );
      }
      replayEntries = readJournal(prevJournalPath);
    }

    // 2) 解析脚本源（script > scriptPath > name > 断点脚本副本）
    let scriptSource = '';
    if (typeof params?.script === 'string' && params.script.trim() !== '') {
      scriptSource = params.script;
    } else if (typeof params?.scriptPath === 'string' && params.scriptPath.trim() !== '') {
      const resolved = path.resolve(workspaceDir, params.scriptPath);
      try {
        scriptSource = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        return textResult(`Could not read workflow script "${resolved}": ${err instanceof Error ? err.message : String(err)}`, true);
      }
    } else if (typeof params?.name === 'string' && params.name.trim() !== '') {
      const saved = resolveWorkflowScript({ name: params.name }, workspaceDir);
      if (!saved.ok) return textResult(saved.message, true);
      scriptSource = saved.script;
    } else if (resumeFromRunId && existsSync(path.join(workflowsDir, `${resumeFromRunId}.mjs`))) {
      scriptSource = await fs.readFile(path.join(workflowsDir, `${resumeFromRunId}.mjs`), 'utf8');
    } else {
      return textResult(
        'Provide `script` (inline source), `scriptPath` (a file to read), `name` (a saved workflow), or `resumeFromRunId` (re-run a previous run\'s persisted script).',
        true,
      );
    }

    // 3) 校验脚本 meta（失败直接返回作者可修复的报错）
    let validated: ReturnType<typeof validateScript>;
    try {
      validated = validateScript(scriptSource);
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }

    // 4) 落盘脚本副本 + 新建本次运行的 journal
    const runId = workflowRunId();
    const runScriptPath = path.join(workflowsDir, `${runId}.mjs`);
    const scriptPath = typeof params?.scriptPath === 'string' && params.scriptPath.trim() !== ''
      ? path.resolve(workspaceDir, params.scriptPath)
      : runScriptPath;
    try {
      await writeAtomicFile(scriptPath, scriptSource);
      if (scriptPath !== runScriptPath) await writeAtomicFile(runScriptPath, scriptSource);
    } catch (err) {
      return textResult(`Could not persist workflow script: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const journalPath = path.join(workflowsDir, `${runId}.workflow.jsonl`);

    // 5) 组合 abort 信号：父级取消（会话停止）中止整个工作流；接管（新消息）仅解除等待
    const effectiveSessionId = deps.sessionId || process.env.BOTD_SESSION_ID || '';
    const watch = createHandoffWatch({
      parentSignal: signal,
      handoffScope,
    });
    const workflowAbortController = watch.combo;

    // 6) CompositeWorkflowHost：本地子代理走 pi-subagents manager，
    //    未注册类型（或 @/bot: 前缀）走 Hub 子会话跨 BOT 委派。
    const remoteSessions = new Map<string, { childSessionId: string; botId: string; label: string; phaseTitle?: string }>();
    const globalManager = getGlobalSubagentManager();
    const localHost = globalManager
      ? createWorkflowHost({
          pi,
          ctx,
          manager: createLocalWorkflowManager(globalManager, pi) as any,
          signal: workflowAbortController.signal,
          ...(effectiveSessionId ? { rootSessionId: effectiveSessionId } : {}),
          workflowId: runId,
        })
      : undefined;

    const host: WorkflowHost = {
      async spawnAgent(request) {
        const stepRunId = `${runId}_${request.agentId}`;
        const rawType = String(request.agentType || '').trim();
        const cleanType = rawType.replace(/^(?:@|bot:)/, '');
        const forceRemote = rawType.startsWith('@') || rawType.startsWith('bot:');
        // 本地类型解析前重置为本 BOT 的注册表：工作流脚本在异步执行中到达这里，
        // 与工具入口的重置之间可能已插入其他 BOT 的回合。
        if (!forceRemote) rebindSubagentGlobalsForBot(botDir);
        const localDispatch = !forceRemote ? resolveSpawnType(cleanType) : { ok: false as const };

        // Branch A：本地子代理
        if (localDispatch.ok && localHost) {
          const startMs = Date.now();
          const description = request.label || request.prompt.slice(0, 80);
          pi.events.emit('subagents:started', {
            id: stepRunId,
            type: localDispatch.type,
            description,
            ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
          });
          const res = await localHost.spawnAgent({ ...request, agentType: localDispatch.type });
          pi.events.emit(res.ok ? 'subagents:completed' : 'subagents:failed', {
            id: stepRunId,
            type: localDispatch.type,
            description,
            ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
            status: res.skipped ? 'stopped' : res.ok ? 'completed' : 'error',
            ...(res.ok && res.text !== undefined ? { result: res.text } : {}),
            ...(res.ok ? {} : { error: res.error || 'Agent failed.' }),
            durationMs: Date.now() - startMs,
            ...(res.toolCalls ? { toolUses: res.toolCalls } : {}),
          });
          return res;
        }

        // Branch B：跨主 BOT / 对端主 BOT
        if (!cleanType) {
          return { ok: false, error: `Cannot resolve agent type "${rawType}" for workflow step "${request.label}".` };
        }
        if (!effectiveSessionId) {
          return { ok: false, error: 'Missing sessionId for cross-bot delegation in workflow.' };
        }
        const client = await connectHubAsNode(dataDir);

        let effectivePrompt = request.prompt;
        if (request.schema !== undefined) {
          effectivePrompt +=
            `\n\n[Structured Output Requirement]\nYou MUST respond with a valid JSON object matching this JSON Schema (either as raw JSON or inside a \`\`\`json code fence):\n${JSON.stringify(request.schema.schema)}`;
        }

        const startMs = Date.now();
        const execRes = await executeCrossBotSession({
          client,
          pi,
          parentSessionId: effectiveSessionId,
          botId: cleanType,
          prompt: effectivePrompt,
          title: `[${request.phaseTitle || validated.meta.name}] ${request.label || cleanType}`,
          runInBackground: false,
          timeoutSeconds: 600,
          handoffScope,
          signal: workflowAbortController.signal,
          stepRunId,
          label: request.label || cleanType,
          phaseTitle: request.phaseTitle,
          skipCompletionEvent: true,
          onChildCreated: (created) => {
            const rec = {
              childSessionId: created.childSession.id,
              botId: cleanType,
              label: request.label || cleanType,
              ...(request.phaseTitle !== undefined ? { phaseTitle: request.phaseTitle } : {}),
            };
            remoteSessions.set(request.agentId, rec);
            if (request.label) remoteSessions.set(request.label, rec);
            request.onResolved?.({ recordId: created.childSession.id, modelId: cleanType });
          },
        });

        if (!execRes.ok) {
          const message = execRes.reply || 'Cross-bot sub-session failed';
          const error = watch.isHandedOff() || workflowAbortController.signal.aborted ? 'Workflow aborted.' : message;
          pi.events.emit('subagents:failed', {
            id: stepRunId,
            type: cleanType,
            description: request.label || cleanType,
            ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
            ...(execRes.childSessionId ? { childSessionId: execRes.childSessionId } : {}),
            status: 'error',
            error,
            durationMs: execRes.durationMs ?? (Date.now() - startMs),
          });
          return { ok: false, error };
        }

        let outText = execRes.reply;
        if (execRes.returnedArtifacts.length > 0 && request.schema === undefined) {
          outText +=
            `\n\n[Returned Artifacts]\n${execRes.returnedArtifacts.map((a) => `- ${a.filename} (id: ${a.id}, url: ${a.url})`).join('\n')}`;
        }
        if (request.schema !== undefined) {
          const parsedJson = extractJsonFromText(execRes.reply);
          if (parsedJson === undefined) {
            const error = 'Structured output schema validation failed: the sub-session reply was not valid JSON.';
            pi.events.emit('subagents:failed', {
              id: stepRunId,
              type: cleanType,
              description: request.label || cleanType,
              ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
              childSessionId: execRes.childSessionId,
              status: 'error',
              error,
              durationMs: execRes.durationMs ?? (Date.now() - startMs),
            });
            return { ok: false, error };
          }
          const check = request.schema.check(parsedJson);
          if (check !== true) {
            const error = `Structured output schema validation failed: ${check}`;
            pi.events.emit('subagents:failed', {
              id: stepRunId,
              type: cleanType,
              description: request.label || cleanType,
              ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
              childSessionId: execRes.childSessionId,
              status: 'error',
              error,
              durationMs: execRes.durationMs ?? (Date.now() - startMs),
            });
            return { ok: false, error };
          }
          outText = JSON.stringify(parsedJson);
        }

        pi.events.emit('subagents:completed', {
          id: stepRunId,
          type: cleanType,
          description: request.label || cleanType,
          ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
          childSessionId: execRes.childSessionId,
          status: 'completed',
          result: outText,
          durationMs: execRes.durationMs ?? (Date.now() - startMs),
        });
        return { ok: true, text: outText };
      },

      abortAgent(agentId: string) {
        const remote = remoteSessions.get(agentId) ?? crossBotSessionMap.get(agentId);
        if (remote) {
          connectHubAsNode(dataDir)
            .then((client) =>
              client.post(`/api/sessions/${encodeURIComponent(remote.childSessionId)}/cancel`).catch(() => {}),
            )
            .catch(() => {});
        } else {
          localHost?.abortAgent(agentId);
        }
      },

      async resumeAgent(agentId: string, prompt: string, onResolved?: (info: { recordId?: string }) => void) {
        const remote =
          remoteSessions.get(agentId) ??
          crossBotSessionMap.get(agentId) ??
          (agentId.startsWith('sess_')
            ? { childSessionId: agentId, botId: 'remote', label: agentId }
            : undefined);
        if (remote) {
          const stepRunId = `${runId}_${agentId}_resume_${Date.now().toString(36)}`;
          const startMs = Date.now();
          onResolved?.({ recordId: remote.childSessionId });
          pi.events.emit('subagents:started', {
            id: stepRunId,
            type: remote.botId,
            description: prompt.slice(0, 80),
            ...(remote.phaseTitle !== undefined ? { phase: remote.phaseTitle } : {}),
            childSessionId: remote.childSessionId,
          });
          const client = await connectHubAsNode(dataDir);
          const res = await sendSessionMessageAndWait(client, remote.childSessionId, prompt, {
            waitSeconds: 600,
            signal: workflowAbortController.signal,
          });
          pi.events.emit(res.ok ? 'subagents:completed' : 'subagents:failed', {
            id: stepRunId,
            type: remote.botId,
            description: prompt.slice(0, 80),
            ...(remote.phaseTitle !== undefined ? { phase: remote.phaseTitle } : {}),
            childSessionId: remote.childSessionId,
            status: res.ok ? 'completed' : 'error',
            ...(res.ok ? { result: res.reply } : { error: res.reply || 'Resume failed' }),
            durationMs: Date.now() - startMs,
          });
          return { ok: res.ok, text: res.reply, ...(res.ok ? {} : { error: res.reply || 'Resume failed' }) };
        }
        if (!localHost?.resumeAgent) {
          return { ok: false, error: 'Resume not supported' };
        }
        return localHost.resumeAgent(agentId, prompt, onResolved as any);
      },

      async runGate(command: string, gate: { agentId: string; cwd?: string }) {
        if (localHost?.runGate) return localHost.runGate(command, gate);
        // 无本地 host（纯跨 BOT 场景）：退化为在主工作区执行
        const result = await pi.exec(process.platform === 'win32' ? 'cmd' : 'sh',
          process.platform === 'win32' ? ['/c', command] : ['-c', command],
          { cwd: gate.cwd ?? workspaceDir, timeout: 10 * 60_000 });
        const output = [result.stdout, result.stderr].map((s) => s.trim()).filter(Boolean).join('\n');
        return { ok: !result.killed && result.code === 0, output: output || (result.killed ? `Gate command timed out: ${command}` : output) };
      },

      loadWorkflow(ref: { name?: string; scriptPath?: string }) {
        return resolveWorkflowSource(ref, workspaceDir);
      },
    };

    // 7) 断点回放步骤的 UI 桥接：cached done 条目补发 completed 事件
    const emittedCachedSteps = new Set<number>();
    const task = createWorkflowTask({
      id: runId,
      script: scriptSource,
      scriptPath,
      args: params?.args,
      meta: validated.meta,
      toolCallId,
      journalPath,
      ...(replayEntries && replayEntries.length > 0 ? { replay: replayEntries, resumedFrom: resumeFromRunId } : {}),
    });
    const onProgress = (entries: readonly any[]) => {
      updateWorkflowProgressBatch(task, entries);
      for (const entry of entries) {
        if (
          entry &&
          entry.type === 'workflow_agent' &&
          entry.cached === true &&
          entry.state === 'done' &&
          typeof entry.index === 'number' &&
          !emittedCachedSteps.has(entry.index)
        ) {
          emittedCachedSteps.add(entry.index);
          pi.events.emit('subagents:completed', {
            id: `${runId}_cached_${entry.index}`,
            type: entry.agentType || 'agent',
            description: `[\u5df2\u7f13\u5b58] ${entry.label ?? ''}`,
            ...(entry.phaseTitle !== undefined ? { phase: entry.phaseTitle } : {}),
            status: 'completed',
            result: entry.resultPreview || '\uff08\u65ad\u70b9\u7eed\u8dd1\uff1a\u5df2\u590d\u7528\u4e0a\u6b21\u6210\u529f\u7ed3\u679c\uff09',
            durationMs: 0,
          });
        }
      }
    };

    // 8) 前台跑完整个工作流并返回结构化摘要
    try {
      const result = await runWorkflow({
        script: scriptSource,
        args: params?.args,
        signal: workflowAbortController.signal,
        host,
        onProgress,
        journal: {
          ...(replayEntries ? { entries: replayEntries } : {}),
          append: (entry) => appendJournal(journalPath, entry),
        },
      });
      completeWorkflowTask(task, result);

      const lines = [
        `Workflow "${validated.meta.name}" ${result.status} (runId: ${runId})`,
        `Script: ${scriptPath}`,
      ];
      if (result.replayedCount > 0) {
        lines.push(`Replayed from ${resumeFromRunId}: ${result.replayedCount}/${result.agentCount} step(s) from journal cache.`);
      }
      if (result.status === 'failed' && result.error) {
        lines.push(`Error: ${result.error}`);
      }
      lines.push(`Result: ${workflowResultText(task)}`);
      if (result.status === 'failed') {
        lines.push(
          `To retry from the failed step without re-running completed steps, call SubagentWorkflow with { scriptPath: "${scriptPath}", resumeFromRunId: "${runId}" }.`,
        );
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          taskId: runId,
          runId,
          scriptPath,
          status: result.status,
          value: result.value,
          replayedCount: result.replayedCount,
          agentCount: result.agentCount,
        },
        ...(result.status === 'failed' ? { isError: true } : {}),
      } as any;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failWorkflowTask(task, message);
      return textResult(`Workflow "${validated.meta.name}" failed (runId: ${runId}): ${message}\nScript: ${scriptPath}`, true, {
        taskId: runId,
        runId,
        scriptPath,
        status: 'failed',
      });
    } finally {
      watch.cleanup();
    }
  };

  return { ...tool, execute: wrappedExecute };
}

async function resolveExtensionPaths(dataDir: string, ids: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const id of ids) {
    assertSafeId(id, 'Extension ID');
    const dir = path.join(dataDir, 'extensions', id);
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      if (pkg && typeof pkg === 'object' && 'pi' in pkg) {
        paths.push(dir);
        continue;
      }
    } catch {
      // A standalone extension need not have a package manifest.
    }
    if (existsSync(path.join(dir, 'index.ts'))) paths.push(path.join(dir, 'index.ts'));
    else if (existsSync(pkgPath)) paths.push(dir);
  }
  return paths;
}

/** Use the same explicit resource paths for discovery and execution. */
export async function loadBotResources(
  dataDir: string,
  bot: BotConfig,
  settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } }),
  appendSystemPrompt: () => string[] = () => [],
  options?: { enableSubagents?: boolean; sessionId?: string },
): Promise<DefaultResourceLoader> {
  const botDir = getBotDir(dataDir, bot.id);
  const workspaceDir = path.join(botDir, 'workspace');
  const promptsDir = path.join(botDir, 'prompts');
  const skillPaths = (bot.enabledSkills ?? []).map(id => {
    assertSafeId(id, 'Skill ID');
    return path.join(dataDir, 'skills', id);
  });
  // 主 BOT 挂载 pi-subagents 底座（Agent / SubagentWorkflow 编排工具 + 子代理调度）；
  // 子代理不挂载（防套娃：子代理不能再派子代理），扩展内部另有 inChildSessionContext 防重入双保险。
  let extensionFactories: ExtensionFactory[] = [];
  if (options?.enableSubagents && !bot.parentBotId) {
    await ensureDir(path.join(botDir, 'agents'));
    await writeAtomicFile(
      path.join(botDir, 'subagents.json'),
      JSON.stringify(
        {
          disableDefaultAgents: true,
          disableDefaults: true,
          fallbackSubagent: 'none',
          backgroundByDefault: false,
          packageAgents: false,
          // async：完成通知逐个即时投递，避免 group 批次延迟到回合尾才可见，
          // 供主会话运行中新消息接管时能拿到实时结果。
          defaultJoinMode: 'async',
        },
        null,
        2
      )
    );

    const wrappedSubagentsFactory: ExtensionFactory = async (pi) => {
      process.env.PI_CODING_AGENT_DIR = botDir;
      setDefaultsDisabled(true);
      setFallbackSubagent(NO_FALLBACK);

      // 拦截 pi.registerTool：包一层 Agent 工具包装器（Auto-background on User Message）。
      // 主 Bot 前台等待子代理时，若用户在主会话发送新消息，steerBotTurn 会触发该回合的
      // handoffController，此时等待立即解除、子代理转后台继续运行，主 Bot 马上接管响应。
      const realRegisterTool = pi.registerTool.bind(pi);
      const handoffScope = getActiveSubagentHandoffScope();
      const wrappedRegisterTool: typeof pi.registerTool = ((tool: any) => {
        if (tool?.name === 'SubagentWorkflow') {
          return realRegisterTool(
            wrapWorkflowToolForCrossBot(tool, {
              dataDir,
              bot,
              botDir,
              workspaceDir,
              sessionId: options?.sessionId,
              pi,
              handoffScope,
            }),
          );
        }
        if (tool?.name !== 'Agent') {
          return realRegisterTool(tool);
        }
        const wrappedTool = wrapAgentToolForHandoff(tool, {
          dataDir,
          bot,
          botDir,
          workspaceDir,
          sessionId: options?.sessionId,
          pi,
          handoffScope,
        });
        return realRegisterTool(wrappedTool);
      }) as typeof pi.registerTool;
      const scopedPi = new Proxy(pi as ExtensionAPI, {
        get(target, prop) {
          if (prop === 'registerTool') return wrappedRegisterTool;
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? (value as any).bind(target) : value;
        },
      });

      await subagentsExtensionFactory(scopedPi as ExtensionAPI);
      setDefaultsDisabled(true);
      setFallbackSubagent(NO_FALLBACK);
      registerAgents(loadCustomAgents(botDir));

      // 注册 stop_subagent：按 agent_id（或 handle/subagent_type）单独停掉一个运行中的子代理，
      // 不中断主回合与其他并发子代理。优先直接命中 manager 记录，退化为事件总线 RPC。
      realRegisterTool({
        name: 'stop_subagent',
        label: 'Stop Subagent',
        description:
          'Stop a running subagent by its agent_id (or handle/subagent_type) without aborting the main turn. ' +
          'Use this when the user asks to stop/interrupt one specific subagent while others keep running.',
        promptSnippet: 'Stop a single running subagent without aborting the main turn',
        parameters: {
          type: 'object',
          properties: {
            agent_id: {
              type: 'string',
              description:
                'The agent ID to stop (the id returned by the Agent tool). The agent\'s handle or subagent_type also works.',
            },
          },
          required: ['agent_id'],
        } as any,
        execute: async (_toolCallId: string, params: { agent_id: string }) => {
          const ref = String(params?.agent_id || '').trim();
          if (!ref) {
            return { content: [{ type: 'text', text: 'Missing agent_id.' }], isError: true } as any;
          }
          const manager = getGlobalSubagentManager();
          if (manager?.getRecord) {
            let target: { id?: string; handle?: string; type?: string } | undefined =
              manager.getRecord(ref) as any;
            if (!target) {
              for (const record of manager.listAgents?.() ?? []) {
                const r = record as any;
                if (r?.handle === ref || r?.alias === ref || r?.type === ref) {
                  target = r;
                  break;
                }
              }
            }
            if (!target?.id) {
              return {
                content: [{ type: 'text', text: `Agent not found: "${ref}". It may have already finished or been cleaned up.` }],
              } as any;
            }
            const stopped = manager.abort?.(target.id);
            return {
              content: [
                {
                  type: 'text',
                  text: stopped
                    ? `Agent "${target.id}" stop requested. It will stop after its current tool execution; use get_subagent_result to read its partial output.`
                    : `Agent "${target.id}" is not running (it may have already finished).`,
                },
              ],
            } as any;
          }
          // 退化路径：通过事件总线 RPC 停止（跨激活的 manager 仍挂着 RPC 处理器）
          const stoppedViaRpc = await requestSubagentsRpc(pi, 'subagents:rpc:stop', { agentId: ref });
          return {
            content: [
              {
                type: 'text',
                text: stoppedViaRpc
                  ? `Agent "${ref}" stop requested.`
                  : `Could not stop agent "${ref}": not found or not running.`,
              },
            ],
          } as any;
        },
      } as any);

      pi.on('session_start', () => {
        process.env.PI_CODING_AGENT_DIR = botDir;
        setDefaultsDisabled(true);
        setFallbackSubagent(NO_FALLBACK);
        registerAgents(loadCustomAgents(botDir));
      });
      pi.on('before_agent_start', () => {
        process.env.PI_CODING_AGENT_DIR = botDir;
        setDefaultsDisabled(true);
        setFallbackSubagent(NO_FALLBACK);
        registerAgents(loadCustomAgents(botDir));
      });
    };

    extensionFactories = [wrappedSubagentsFactory];
  }
  const loader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: botDir,
    settingsManager,
    noSkills: true,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: skillPaths,
    additionalExtensionPaths: await resolveExtensionPaths(dataDir, bot.enabledExtensions ?? []),
    additionalPromptTemplatePaths: existsSync(promptsDir) ? [promptsDir] : [],
    extensionFactories,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: appendSystemPrompt,
  });
  // Pi clears the module cache on reload so edited extensions are visible next time.
  (loader as unknown as { loaded: boolean }).loaded = true;
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw new Error(errors.map(error => `${error.path}: ${error.error}`).join('\n'));
  return loader;
}

/** Preserve Pi's native dispatch precedence and real invocation names across extensions, skills, and prompts. */
export function collectBotCommands(
  loader: ResourceLoader,
  runner: Pick<ExtensionRunner, 'getRegisteredCommands'>,
): ChatCommand[] {
  const commands: ChatCommand[] = [];
  const claimed = new Set<string>();
  for (const command of runner.getRegisteredCommands()) {
    claimed.add(command.invocationName);
    commands.push({ name: command.invocationName, description: command.description, source: 'extension' });
  }
  for (const skill of loader.getSkills().skills) {
    const name = `skill:${skill.name}`;
    if (claimed.has(name)) continue;
    claimed.add(name);
    commands.push({ name, description: skill.description, source: 'skill' });
  }
  for (const template of loader.getPrompts().prompts) {
    if (claimed.has(template.name)) continue;
    claimed.add(template.name);
    commands.push({ name: template.name, description: template.description, source: 'prompt', argumentHint: template.argumentHint });
  }
  return commands;
}

/** Discover commands without selecting a model or starting an extension session. */
export async function getBotCommands(dataDir: string, bot: BotConfig): Promise<ChatCommand[]> {
  const loader = await loadBotResources(dataDir, bot);
  const { extensions, runtime } = loader.getExtensions();
  const botDir = getBotDir(dataDir, bot.id);
  const cwd = path.join(botDir, 'workspace');
  // The runner's registry is unused during discovery; keep its backing store isolated
  // and skip model availability/authentication checks.
  const models = await ModelRuntime.create({
    authPath: path.join(dataDir, '.agent', 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), new ModelRegistry(models));
  try {
    return collectBotCommands(loader, runner);
  } finally {
    runner.invalidate();
  }
}
