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
import { assertSafeId, ensureDir, getBotDir, writeAtomicFile } from './storage.js';
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
 * 包装 Agent 工具 execute：主 Bot 前台等待子代理时，若用户在主会话发新消息
 * （steerBotTurn → triggerActiveSubagentHandoff），等待立即解除，返回提示文本让主 Bot
 * 接管新消息并用 stop_subagent / steer_subagent / get_subagent_result 控制子代理。
 *
 * 实现方式：先以 run_in_background: true 调原 Agent.execute 拿到 agentId，
 * 再立即用扩展注册的 get_subagent_result（wait: true）等待。waitSignal 被接管触发时，
 * get_subagent_result 只退出等待、子代理继续后台运行且保留完成通知；父级会话取消信号
 * （用户点了整个会话的停止）则额外停掉该子代理。
 */
function wrapAgentToolForHandoff(tool: any, handoffScope: SubagentHandoffScope): any {
  const originalExecute = tool.execute?.bind(tool);
  if (typeof originalExecute !== 'function') return tool;

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

  const wrappedExecute = async (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: any,
  ) => {
    const wantsForeground = params?.run_in_background === false || params?.run_in_background === undefined;
    // 仅拦截“新前台调用且非 resume”：resume / 后台 / 定时调用走原路径
    if (!wantsForeground || params?.resume || params?.schedule) {
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
    }

    // 已被接管（用户已发新消息）：这次调用直接按后台跑，不再阻塞
    if (handoffScope.wasTriggered()) {
      return originalExecute(toolCallId, { ...params, run_in_background: true }, signal, onUpdate, ctx);
    }

    const getResultTool = findTool(ctx, 'get_subagent_result');
    if (!getResultTool) {
      // 找不到等待工具（扩展未激活）：退回原生行为
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
    }

    // 以后台方式启动子代理，拿到 agentId
    const bgResult = await originalExecute(toolCallId, { ...params, run_in_background: true }, signal, onUpdate, ctx);
    const agentId = String((bgResult as any)?.details?.agentId || '').trim();
    if (!agentId) {
      // 启动失败（未知类型等）：原样返回错误/结果
      return bgResult;
    }

    // 组合信号：父级取消（整会话停止）或用户接管（主会话新消息）
    const combo = new AbortController();
    const onParentAbort = () => {
      // 用户点了整个会话的停止：同时停掉该子代理
      const manager = getGlobalSubagentManager();
      manager?.abort?.(agentId);
      combo.abort();
    };
    const onHandoff = () => {
      handedOff = true;
      combo.abort();
    };
    if (signal?.aborted) {
      onParentAbort();
    } else {
      signal?.addEventListener('abort', onParentAbort, { once: true });
    }

    let handedOff = false;
    const handoffPoll = setInterval(onHandoff, 80);
    const cleanupListeners = () => {
      clearInterval(handoffPoll);
      signal?.removeEventListener?.('abort', onParentAbort);
    };

    try {
      // get_subagent_result(wait: true)：正常跑完会自动标记 resultConsumed 并取消完成通知，
      // 向主 Bot 返回完整结果；信号被取消时仅退出等待，子代理在后台继续运行。
      const waitResult = await getResultTool.execute(
        `wait_${toolCallId}`,
        { agent_id: agentId, wait: true },
        combo.signal,
        undefined,
        ctx,
      );
      if (handedOff) {
        return makeTextResult(
          `Agent "${agentId}" (${params.subagent_type}) has been moved to the background because the user sent a new message in the session. It is STILL RUNNING. Read the user's new message and use stop_subagent, steer_subagent, or get_subagent_result with agent_id "${agentId}" as needed.`
        );
      }
      return waitResult;
    } finally {
      cleanupListeners();
    }
  };

  return { ...tool, execute: wrappedExecute };
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
    const { dataDir, workspaceDir, pi, handoffScope } = deps;

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
    const workflowAbortController = new AbortController();
    let handedOff = false;
    const onParentAbort = () => workflowAbortController.abort();
    const onHandoff = () => {
      handedOff = true;
      workflowAbortController.abort();
    };
    if (signal?.aborted) onParentAbort();
    else signal?.addEventListener('abort', onParentAbort, { once: true });
    const handoffPoll = setInterval(() => {
      if (handoffScope?.wasTriggered()) onHandoff();
    }, 80);
    const cleanupListeners = () => {
      clearInterval(handoffPoll);
      signal?.removeEventListener?.('abort', onParentAbort);
    };

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
        const { HubClient } = await import('./cli/hub-client.js');
        const { delegateSessionAndWait } = await import('./cli/commands/sessions.js');
        const client = await HubClient.connect({ dataDir });

        let effectivePrompt = request.prompt;
        if (request.schema !== undefined) {
          effectivePrompt +=
            `\n\n[Structured Output Requirement]\nYou MUST respond with a valid JSON object matching this JSON Schema (either as raw JSON or inside a \`\`\`json code fence):\n${JSON.stringify(request.schema.schema)}`;
        }

        const startMs = Date.now();
        let waitRes: Awaited<ReturnType<typeof delegateSessionAndWait>> | undefined;
        try {
          waitRes = await delegateSessionAndWait(
            client,
            effectiveSessionId,
            {
              botId: cleanType,
              prompt: effectivePrompt,
              title: `[${request.phaseTitle || validated.meta.name}] ${request.label || cleanType}`,
              autoWakeParent: false,
            },
            {
              waitSeconds: 600,
              signal: workflowAbortController.signal,
              onChildCreated: (created) => {
                remoteSessions.set(request.agentId, {
                  childSessionId: created.childSession.id,
                  botId: cleanType,
                  label: request.label || cleanType,
                  ...(request.phaseTitle !== undefined ? { phaseTitle: request.phaseTitle } : {}),
                });
                request.onResolved?.({ recordId: created.childSession.id, modelId: cleanType });
                pi.events.emit('subagents:started', {
                  id: stepRunId,
                  type: cleanType,
                  description: request.label || request.prompt.slice(0, 80),
                  ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
                  childSessionId: created.childSession.id,
                });
              },
            },
          );
        } catch (err) {
          // 接管 / 父级取消不算步骤失败：工作流 abort 已在 flight 中，直接返回失败占位
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, error: handedOff || workflowAbortController.signal.aborted ? 'Workflow aborted.' : message };
        }

        if (waitRes.status === 'failed') {
          pi.events.emit('subagents:failed', {
            id: stepRunId,
            type: cleanType,
            description: request.label || cleanType,
            ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
            childSessionId: waitRes.childSession.id,
            status: 'error',
            error: waitRes.reply || 'Cross-bot sub-session failed',
            durationMs: Date.now() - startMs,
          });
          return { ok: false, error: waitRes.reply || 'Cross-bot sub-session failed' };
        }

        let outText = waitRes.reply;
        if (waitRes.returnedArtifacts.length > 0 && request.schema === undefined) {
          outText +=
            `\n\n[Returned Artifacts]\n${waitRes.returnedArtifacts.map((a) => `- ${a.filename} (id: ${a.id}, url: ${a.url})`).join('\n')}`;
        }
        if (request.schema !== undefined) {
          const parsedJson = extractJsonFromText(waitRes.reply);
          if (parsedJson === undefined) {
            const error = 'Structured output schema validation failed: the sub-session reply was not valid JSON.';
            pi.events.emit('subagents:failed', {
              id: stepRunId,
              type: cleanType,
              description: request.label || cleanType,
              ...(request.phaseTitle !== undefined ? { phase: request.phaseTitle } : {}),
              childSessionId: waitRes.childSession.id,
              status: 'error',
              error,
              durationMs: Date.now() - startMs,
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
              childSessionId: waitRes.childSession.id,
              status: 'error',
              error,
              durationMs: Date.now() - startMs,
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
          childSessionId: waitRes.childSession.id,
          status: 'completed',
          result: outText,
          durationMs: Date.now() - startMs,
        });
        return { ok: true, text: outText };
      },

      abortAgent(agentId: string) {
        const remote = remoteSessions.get(agentId);
        if (remote) {
          import('./cli/hub-client.js')
            .then(({ HubClient }) => HubClient.connect({ dataDir }))
            .then((client) =>
              client.post(`/api/sessions/${encodeURIComponent(remote.childSessionId)}/cancel`).catch(() => {}),
            )
            .catch(() => {});
        } else {
          localHost?.abortAgent(agentId);
        }
      },

      async resumeAgent(agentId: string, prompt: string, onResolved?: (info: { recordId?: string }) => void) {
        const remote = remoteSessions.get(agentId);
        if (remote && !localHost) {
          return { ok: false, error: `Cannot resume "${agentId}": cross-bot sub-session "${remote.childSessionId}" has no resumable in-process context. Use a new agent() step to follow up with @${remote.botId}.` };
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
      cleanupListeners();
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
        const wrappedTool = handoffScope ? wrapAgentToolForHandoff(tool, handoffScope) : tool;
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

      // 注册 delegate_bot：跨主 BOT 协同编排——把任务委派给另一个主 BOT（跨节点或隔离工作区）
      // 的子会话执行，支持零拷贝产物共享。前台等待模式与 Agent 工具对齐：用户在主会话发新消息
      // 时接管解除等待、子会话继续后台运行；用户取消整个会话时同步取消子会话。
      realRegisterTool({
        name: 'delegate_bot',
        label: 'Delegate to Bot',
        description:
          'Delegate a task to another primary BOT (across nodes or in an isolated workspace) via a sub-session with zero-copy artifact sharing. ' +
          'Defaults to run_in_background: false (waits for completion and returns the bot reply and returned artifacts inline; emit multiple delegate_bot calls in one turn to run them in parallel). ' +
          'Set run_in_background: true for long-running tasks that will automatically wake this session when all active sub-sessions finish.',
        promptSnippet: 'Delegate a task to another primary BOT in an isolated sub-session',
        parameters: {
          type: 'object',
          properties: {
            bot_id: {
              type: 'string',
              description: 'Target primary bot ID (e.g. "ops-bot", without leading @).',
            },
            prompt: {
              type: 'string',
              description: 'Self-contained task instructions for the target bot.',
            },
            title: {
              type: 'string',
              description: 'Optional short title for the sub-session.',
            },
            artifact_ids: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional list of parent session artifact IDs to share with the sub-session. Omit to share all current session artifacts.',
            },
            run_in_background: {
              type: 'boolean',
              description:
                'Defaults to false (wait inline and return reply + artifacts). Set true to run asynchronously and wake parent session when done.',
            },
            timeout_seconds: {
              type: 'number',
              description: 'Maximum seconds to wait when run_in_background is false (default: 600).',
            },
          },
          required: ['bot_id', 'prompt'],
        } as any,
        execute: async (
          _toolCallId: string,
          params: {
            bot_id?: string;
            prompt?: string;
            title?: string;
            artifact_ids?: string[];
            run_in_background?: boolean;
            timeout_seconds?: number;
          },
          signal?: AbortSignal,
        ) => {
          const parentSessionId = options?.sessionId || process.env.BOTD_SESSION_ID || '';
          if (!parentSessionId) {
            return {
              content: [{ type: 'text', text: 'Missing session context: cannot resolve the parent session ID for delegate_bot.' }],
              isError: true,
            } as any;
          }
          const botId = String(params?.bot_id || '').trim().replace(/^@+/, '');
          const prompt = String(params?.prompt || '').trim();
          if (!botId || !prompt) {
            return {
              content: [{ type: 'text', text: 'Missing required parameters: bot_id and prompt are required.' }],
              isError: true,
            } as any;
          }

          const { HubClient } = await import('./cli/hub-client.js');
          const { delegateSessionAndWait } = await import('./cli/commands/sessions.js');
          const client = await HubClient.connect({ dataDir });

          // 后台模式：立即返回，子会话完成后由 Hub 自动唤醒父会话（all-settled 汇总）
          if (params?.run_in_background === true) {
            const res = await client.post<DelegateSessionResult>(
              `/api/sessions/${encodeURIComponent(parentSessionId)}/delegate`,
              {
                botId,
                prompt,
                title: params?.title,
                artifactIds: params?.artifact_ids,
                autoWakeParent: true,
              },
            );
            return {
              content: [
                {
                  type: 'text',
                  text: `Delegated background sub-session "${res.childSession.id}" (${res.childSession.title}) to @${botId}. The parent session will be woken up automatically when all active sub-sessions complete.`,
                },
              ],
              details: res,
            } as any;
          }

          // 前台模式：组合信号——父级取消（用户取消会话）取消子会话；接管（用户新消息）仅解除等待
          let childSessionId = '';
          let handedOff = false;
          const combo = new AbortController();
          const handoffScope = getActiveSubagentHandoffScope();
          const onParentAbort = () => {
            if (childSessionId) {
              void client
                .post(`/api/sessions/${encodeURIComponent(childSessionId)}/cancel`)
                .catch(() => {});
            }
            combo.abort();
          };
          const onHandoff = () => {
            handedOff = true;
            combo.abort();
          };
          if (signal?.aborted) {
            onParentAbort();
          } else {
            signal?.addEventListener('abort', onParentAbort, { once: true });
          }
          const handoffPoll = setInterval(() => {
            if (handoffScope?.wasTriggered()) onHandoff();
          }, 80);
          const cleanupListeners = () => {
            clearInterval(handoffPoll);
            signal?.removeEventListener?.('abort', onParentAbort);
          };

          let waitRes: Awaited<ReturnType<typeof delegateSessionAndWait>> | undefined;
          try {
            waitRes = await delegateSessionAndWait(
              client,
              parentSessionId,
              {
                botId,
                prompt,
                title: params?.title,
                artifactIds: params?.artifact_ids,
                autoWakeParent: false,
              },
              {
                waitSeconds: params?.timeout_seconds ?? 600,
                signal: combo.signal,
                onChildCreated: (r) => {
                  childSessionId = r.childSession.id;
                },
              },
            );
          } catch (err) {
            // 等待被解除的两种非错误情形：接管（用户新消息，子会话继续后台跑）与父级取消
            // （子会话已被 fire-and-forget cancel，终端态尚未来得及落库）。均不向前台抛错。
            if (handedOff || signal?.aborted || combo.signal.aborted) {
              waitRes = undefined;
            } else {
              cleanupListeners();
              throw err;
            }
          } finally {
            cleanupListeners();
          }

          if (!waitRes) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    handedOff
                  ? `Delegated sub-session "${childSessionId}" (@${botId}) has been moved to the background because the user sent a new message in the session. It is STILL RUNNING.`
                  : `Delegated sub-session "${childSessionId}" (@${botId}) wait was aborted.`,
                },
              ],
            } as any;
          }

          const lines = [`Sub-session: ${waitRes.childSession.id} (@${botId}) — ${waitRes.status}`, waitRes.reply];
          if (waitRes.returnedArtifacts.length > 0) {
            lines.push('Returned artifacts:');
            for (const artifact of waitRes.returnedArtifacts) {
              lines.push(`- ${artifact.filename} (id: ${artifact.id}, url: ${artifact.url})`);
            }
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            details: waitRes,
            ...(waitRes.status === 'failed' ? { isError: true } : {}),
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
