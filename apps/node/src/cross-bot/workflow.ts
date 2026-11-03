import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BotConfig, DelegateSessionResult } from '@botd/protocol';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { resolveSpawnType } from '@tintinweb/pi-subagents/dist/agent-types.js';
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
import { ensureDir, writeAtomicFile } from '../storage.js';
import type { SubagentHandoffScope } from './coordination.js';
import {
  createHandoffWatch,
  getGlobalSubagentManager,
  rebindSubagentGlobalsForBot,
  requestSubagentsRpc,
} from './coordination.js';
import {
  connectHubAsNode,
  effectiveTimeoutSeconds,
  emitSubagentEvent,
  executeCrossBotSession,
  findCrossBotSession,
  lookupCrossBotSession,
  probeChildSessionReusable,
  sendSessionMessageAndWait,
} from './session.js';

/**
 * 未完成工作流断点标记：<workspaceDir>/.workflows/latest-unfinished.json。
 * 工作流启动时写入，正常跑完删除；失败 / 中断 / 进程被杀则保留，
 * 下一回合由 readUnfinishedWorkflowHint 注入提示，模型可从断点续跑。
 */
export function latestUnfinishedPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.workflows', 'latest-unfinished.json');
}

/** 工作流启动后写入断点标记（prepareWorkflowRun 成功后调用） */
export async function markWorkflowRunStarted(
  workspaceDir: string,
  meta: { runId: string; workflowName: string; scriptPath: string },
): Promise<void> {
  await writeAtomicFile(
    latestUnfinishedPath(workspaceDir),
    JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2),
  ).catch(() => {}); // 标记写失败不影响工作流本身
}

/** 工作流正常跑完后删除断点标记（失败 / 中断路径不删） */
export async function markWorkflowRunFinished(workspaceDir: string): Promise<void> {
  await fs.rm(latestUnfinishedPath(workspaceDir), { force: true }).catch(() => {});
}

/**
 * 读取未完成工作流断点提示（注入主 Bot 回合的追加系统提示）。
 * 文件不存在、损坏或对应脚本 / 日志已不存在时返回 ''。
 */
export async function readUnfinishedWorkflowHint(workspaceDir: string): Promise<string> {
  const marker = latestUnfinishedPath(workspaceDir);
  if (!existsSync(marker)) return '';
  try {
    const parsed = JSON.parse(await fs.readFile(marker, 'utf8')) as {
      runId?: unknown;
      workflowName?: unknown;
      scriptPath?: unknown;
    };
    const runId = typeof parsed.runId === 'string' ? parsed.runId : '';
    const workflowName = typeof parsed.workflowName === 'string' ? parsed.workflowName : '';
    const scriptPath = typeof parsed.scriptPath === 'string' ? parsed.scriptPath : '';
    if (!runId || !scriptPath) return '';
    // 断点对应的脚本副本或日志必须仍存在，否则提示无意义
    const workflowsDir = path.join(workspaceDir, '.workflows');
    const journalExists = existsSync(path.join(workflowsDir, `${runId}.workflow.jsonl`));
    const scriptExists = existsSync(scriptPath) || existsSync(path.join(workflowsDir, `${runId}.mjs`));
    if (!journalExists && !scriptExists) return '';
    return (
      `[未完成工作流断点提醒]\n工作区存在上次中断或未跑完的工作流 "${workflowName}"（runId: ${runId}，脚本: ${scriptPath}）。` +
      `若用户要求继续或重试，请调用 SubagentWorkflow({ scriptPath: "${scriptPath}", resumeFromRunId: "${runId}" }) 从断点续跑，已完成的步骤会自动从日志缓存复用。`
    );
  } catch {
    return '';
  }
}

/**
 * 跨 Bot 工作流编排：把 wrapWorkflowToolForCrossBot 的机制拆为独立单元——
 * 纯函数（JSON 提取 / agentType 路由 / 脚本源与断点日志解析 / 结果聚合文本）、
 * 子会话映射持久化（断点续跑幂等重连）、CompositeWorkflowHost 组装，
 * 以及组装这一切的薄工具包装器。
 */

/** 从文本回复中提取结构化 JSON：优先整体解析，其次 ```json 围栏，最后首尾大括号截取 */
export function extractJsonFromText(text: string): unknown | undefined {
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

/** 解析步骤 agentType 的路由前缀：@ / bot: 前缀强制跨 Bot，否则清洗后交由本地注册表解析 */
export function parseAgentTypePrefix(agentType: string): { rawType: string; cleanType: string; forceRemote: boolean } {
  const rawType = String(agentType || '').trim();
  const cleanType = rawType.replace(/^(?:@|bot:)/, '');
  const forceRemote = rawType.startsWith('@') || rawType.startsWith('bot:');
  return { rawType, cleanType, forceRemote };
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
export function createLocalWorkflowManager(
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

export interface WorkflowReplay {
  resumeFromRunId: string;
  replayEntries: WorkflowJournalEntry[] | undefined;
}

/** 解析断点续跑参数并回放上次运行的 journal（参数非法 / 日志缺失时返回错误文本） */
export async function loadWorkflowReplay(workflowsDir: string, resumeFromRunId: string): Promise<WorkflowReplay | string> {
  if (!resumeFromRunId) return { resumeFromRunId: '', replayEntries: undefined };
  if (!/^wf_[a-z0-9-]+$/i.test(resumeFromRunId)) {
    return `Invalid resumeFromRunId "${resumeFromRunId}": expected a workflow run id like "wf_ab12cd34ef56".`;
  }
  const prevJournalPath = path.join(workflowsDir, `${resumeFromRunId}.workflow.jsonl`);
  const prevScriptPath = path.join(workflowsDir, `${resumeFromRunId}.mjs`);
  if (!existsSync(prevJournalPath) && !existsSync(prevScriptPath)) {
    return `Cannot resume workflow "${resumeFromRunId}": run journal not found in ${workflowsDir}.`;
  }
  return { resumeFromRunId, replayEntries: readJournal(prevJournalPath) };
}

/** 解析脚本源：script > scriptPath > name（已保存工作流）> 断点脚本副本 */
export async function loadWorkflowScript(options: {
  workspaceDir: string;
  workflowsDir: string;
  script?: unknown;
  scriptPath?: unknown;
  name?: unknown;
  resumeFromRunId: string;
}): Promise<{ source: string } | { error: string }> {
  if (typeof options.script === 'string' && options.script.trim() !== '') {
    return { source: options.script };
  }
  if (typeof options.scriptPath === 'string' && options.scriptPath.trim() !== '') {
    const resolved = path.resolve(options.workspaceDir, options.scriptPath);
    try {
      return { source: await fs.readFile(resolved, 'utf8') };
    } catch (err) {
      return { error: `Could not read workflow script "${resolved}": ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (typeof options.name === 'string' && options.name.trim() !== '') {
    const saved = resolveWorkflowScript({ name: options.name }, options.workspaceDir);
    if (!saved.ok) return { error: saved.message };
    return { source: saved.script };
  }
  const resumeScript = path.join(options.workflowsDir, `${options.resumeFromRunId}.mjs`);
  if (options.resumeFromRunId && existsSync(resumeScript)) {
    return { source: await fs.readFile(resumeScript, 'utf8') };
  }
  return {
    error:
      'Provide `script` (inline source), `scriptPath` (a file to read), `name` (a saved workflow), or `resumeFromRunId` (re-run a previous run\'s persisted script).',
  };
}

/** 落盘脚本副本（断点续跑的脚本来源）与本次运行的 journal 路径 */
export async function persistWorkflowScript(
  workflowsDir: string,
  runId: string,
  workspaceDir: string,
  scriptPathParam: unknown,
  source: string,
): Promise<{ scriptPath: string; journalPath: string } | { error: string }> {
  const runScriptPath = path.join(workflowsDir, `${runId}.mjs`);
  const scriptPath =
    typeof scriptPathParam === 'string' && scriptPathParam.trim() !== ''
      ? path.resolve(workspaceDir, scriptPathParam)
      : runScriptPath;
  try {
    await writeAtomicFile(scriptPath, source);
    if (scriptPath !== runScriptPath) await writeAtomicFile(runScriptPath, source);
  } catch (err) {
    return { error: `Could not persist workflow script: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { scriptPath, journalPath: path.join(workflowsDir, `${runId}.workflow.jsonl`) };
}

export interface PersistedSessionEntry {
  childSession: DelegateSessionResult['childSession'];
  initialMessage: DelegateSessionResult['initialMessage'];
  parentSessionId: string;
  baselineArtifactIds: string[];
  botId: string;
}

/**
 * 跨 Bot 子会话映射持久化（<runId>.sessions.json）。
 * 等待超时（timed_out）的步骤不会写入 journal，但它的子会话仍在后台运行；
 * 该映射让 resumeFromRunId 续跑时能幂等重连同一个子会话，而不是再创建一个。
 */
export class WorkflowSessionsMap {
  private readonly entries = new Map<string, PersistedSessionEntry>();
  private dirty = false;

  constructor(
    private readonly workflowsDir: string,
    private readonly runId: string,
  ) {}

  get(signature: string): PersistedSessionEntry | undefined {
    return this.entries.get(signature);
  }

  delete(signature: string): void {
    this.entries.delete(signature);
    this.dirty = true;
    this.flush();
  }

  /** 子会话创建即落盘：即使随后等待超时（timed_out），断点续跑也能幂等重连 */
  remember(signature: string, entry: PersistedSessionEntry): void {
    this.entries.set(signature, entry);
    this.dirty = true;
    this.flush();
  }

  /** 继承上次运行的映射并同步写入本次运行文件，保证 resume-of-resume 也能传递 */
  async inheritFrom(workflowsDir: string, resumeFromRunId: string): Promise<void> {
    if (!resumeFromRunId) return;
    const prevSessionsPath = path.join(workflowsDir, `${resumeFromRunId}.sessions.json`);
    if (existsSync(prevSessionsPath)) {
      try {
        const parsed = JSON.parse(await fs.readFile(prevSessionsPath, 'utf8')) as Record<string, PersistedSessionEntry>;
        for (const [sig, entry] of Object.entries(parsed)) {
          if (entry && typeof entry.childSession?.id === 'string') {
            this.entries.set(sig, entry);
          }
        }
      } catch {
        // 损坏的映射文件视为空：代价只是失去幂等重连
      }
    }
    if (this.entries.size > 0) {
      this.dirty = true;
      this.flush();
    }
  }

  /** 落盘失败不阻断工作流：仅失去下次续跑的幂等重连能力 */
  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeAtomicFile(
        path.join(this.workflowsDir, `${this.runId}.sessions.json`),
        JSON.stringify(Object.fromEntries(this.entries), null, 2),
      ).catch(() => {});
    } catch {
      // 同上：落盘失败静默
    }
  }
}

export interface CrossBotWorkflowHostDeps {
  dataDir: string;
  botDir: string;
  workspaceDir: string;
  effectiveSessionId: string;
  pi: ExtensionAPI;
  handoffScope: SubagentHandoffScope | undefined;
  /** 断点续跑的子会话映射（幂等重连） */
  sessions: WorkflowSessionsMap;
  runId: string;
  workflowName: string;
  stepTimeoutSeconds: number;
  /** 整个工作流的 abort 信号（父级取消 + 用户接管组合） */
  abortSignal: AbortSignal;
  /** 用户接管监视（区分“工作流中止”与步骤失败文案） */
  isHandedOff: () => boolean;
}

/**
 * CompositeWorkflowHost：本地子代理走 pi-subagents manager，
 * 未注册类型（或 @/bot: 前缀）走 Hub 子会话跨 BOT 委派。
 */
export function createCrossBotWorkflowHost(deps: CrossBotWorkflowHostDeps, ctx: any): WorkflowHost {
  const {
    dataDir,
    botDir,
    workspaceDir,
    effectiveSessionId,
    pi,
    handoffScope,
    sessions,
    runId,
    workflowName,
    stepTimeoutSeconds,
    abortSignal,
    isHandedOff,
  } = deps;

  /** 本次运行的跨 Bot 子会话记录（abort / resume 按 agentId / label 定位） */
  const remoteSessions = new Map<string, { childSessionId: string; botId: string; label: string; phaseTitle?: string }>();
  const globalManager = getGlobalSubagentManager();
  const localHost = globalManager
    ? createWorkflowHost({
        pi,
        ctx,
        manager: createLocalWorkflowManager(globalManager, pi) as any,
        signal: abortSignal,
        ...(effectiveSessionId ? { rootSessionId: effectiveSessionId } : {}),
        workflowId: runId,
      })
    : undefined;

  return {
    async spawnAgent(request) {
      const stepRunId = `${runId}_${request.agentId}`;
      const { rawType, cleanType, forceRemote } = parseAgentTypePrefix(request.agentType);
      // 本地类型解析前重置为本 BOT 的注册表：工作流脚本在异步执行中到达这里，
      // 与工具入口的重置之间可能已插入其他 BOT 的回合。
      if (!forceRemote) rebindSubagentGlobalsForBot(botDir);
      const localDispatch = forceRemote ? { ok: false as const } : resolveSpawnType(cleanType);

      // Branch A：本地子代理
      if (localDispatch.ok && localHost) {
        const startMs = Date.now();
        const description = request.label || request.prompt.slice(0, 80);
        emitSubagentEvent(pi, 'subagents:started', {
          id: stepRunId,
          type: localDispatch.type,
          description,
          phase: request.phaseTitle,
        });
        const res = await localHost.spawnAgent({ ...request, agentType: localDispatch.type });
        emitSubagentEvent(
          pi,
          res.ok ? 'subagents:completed' : 'subagents:failed',
          { id: stepRunId, type: localDispatch.type, description, phase: request.phaseTitle },
          {
            status: res.skipped ? 'stopped' : res.ok ? 'completed' : 'error',
            ...(res.ok && res.text !== undefined ? { result: res.text } : {}),
            ...(res.ok ? {} : { error: res.error || 'Agent failed.' }),
            durationMs: Date.now() - startMs,
            ...(res.toolCalls ? { toolUses: res.toolCalls } : {}),
          },
        );
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
      const emitFailed = (error: string, childSessionId?: string, durationMs?: number) =>
        emitSubagentEvent(
          pi,
          'subagents:failed',
          {
            id: stepRunId,
            type: cleanType,
            description: request.label || cleanType,
            phase: request.phaseTitle,
            ...(childSessionId !== undefined ? { childSessionId } : {}),
          },
          { status: 'error', error, durationMs: durationMs ?? (Date.now() - startMs) },
        );

      // 断点续跑幂等复用：同一跨 Bot 步骤若已有持久化的子会话记录（例如上次
      // 等待超时后仍在后台运行的子会话），先探测 Hub 上该子会话是否可用——
      // 可用则直接重连复用，绝不重新 POST /delegate 创建重复子会话。
      const stepSignature = `${cleanType}::${request.label || ''}::${request.prompt}`;
      let existingChild: DelegateSessionResult | undefined;
      let reuseBaselineArtifactIds: string[] | undefined;
      const prev = sessions.get(stepSignature);
      if (prev) {
        const probe = await probeChildSessionReusable(client, prev.childSession.id);
        if (probe) {
          existingChild = {
            parentSessionId: prev.parentSessionId,
            childSession: prev.childSession,
            initialMessage: prev.initialMessage,
          };
          reuseBaselineArtifactIds = prev.baselineArtifactIds;
          const rec = {
            childSessionId: prev.childSession.id,
            botId: cleanType,
            label: request.label || cleanType,
            ...(request.phaseTitle !== undefined ? { phaseTitle: request.phaseTitle } : {}),
          };
          remoteSessions.set(request.agentId, rec);
          if (request.label) remoteSessions.set(request.label, rec);
          request.onResolved?.({ recordId: prev.childSession.id, modelId: cleanType });
          emitSubagentEvent(pi, 'subagents:started', {
            id: stepRunId,
            type: cleanType,
            description: request.label || cleanType,
            phase: request.phaseTitle,
            childSessionId: prev.childSession.id,
          });
        } else {
          // 子会话已 failed / 不存在（404）：丢弃旧记录，派生新子会话重试
          sessions.delete(stepSignature);
        }
      }

      // 父会话产物基线：新建路径下在派发前拉取并随子会话记录持久化，
      // 供等待超时后的断点续跑重连时对比识别新回传产物
      let newChildBaselineArtifactIds: string[] | undefined;
      if (!existingChild) {
        newChildBaselineArtifactIds = await client
          .get<Array<{ id: string }>>(`/api/sessions/${encodeURIComponent(effectiveSessionId)}/artifacts`)
          .then((arts) => arts.map((a) => a.id))
          .catch(() => []);
      }

      const execRes = await executeCrossBotSession({
        client,
        pi,
        parentSessionId: effectiveSessionId,
        botId: cleanType,
        prompt: effectivePrompt,
        title: `[${request.phaseTitle || workflowName}] ${request.label || cleanType}`,
        runInBackground: false,
        timeoutSeconds: stepTimeoutSeconds,
        handoffScope,
        signal: abortSignal,
        stepRunId,
        label: request.label || cleanType,
        phaseTitle: request.phaseTitle,
        skipCompletionEvent: true,
        ...(existingChild
          ? { existingChild, ...(reuseBaselineArtifactIds ? { baselineParentArtifactIds: reuseBaselineArtifactIds } : {}) }
          : {}),
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
          // 子会话创建即落盘：即使随后等待超时（timed_out），断点续跑也能幂等重连
          if (!existingChild) {
            sessions.remember(stepSignature, {
              childSession: created.childSession,
              initialMessage: created.initialMessage,
              parentSessionId: effectiveSessionId,
              baselineArtifactIds: newChildBaselineArtifactIds ?? [],
              botId: cleanType,
            });
          }
        },
      });

      if (!execRes.ok) {
        const message = execRes.reply || 'Cross-bot sub-session failed';
        const error = isHandedOff() || abortSignal.aborted ? 'Workflow aborted.' : message;
        emitFailed(error, execRes.childSessionId, execRes.durationMs);
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
          emitFailed(error, execRes.childSessionId, execRes.durationMs);
          return { ok: false, error };
        }
        const check = request.schema.check(parsedJson);
        if (check !== true) {
          const error = `Structured output schema validation failed: ${check}`;
          emitFailed(error, execRes.childSessionId, execRes.durationMs);
          return { ok: false, error };
        }
        outText = JSON.stringify(parsedJson);
      }

      emitSubagentEvent(
        pi,
        'subagents:completed',
        {
          id: stepRunId,
          type: cleanType,
          description: request.label || cleanType,
          phase: request.phaseTitle,
          childSessionId: execRes.childSessionId,
        },
        { status: 'completed', result: outText, durationMs: execRes.durationMs ?? (Date.now() - startMs) },
      );
      return { ok: true, text: outText };
    },

    abortAgent(agentId: string) {
      const remote = remoteSessions.get(agentId) ?? lookupCrossBotSession(agentId);
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
      const remote = remoteSessions.get(agentId) ?? findCrossBotSession(agentId);
      if (remote) {
        const stepRunId = `${runId}_${agentId}_resume_${Date.now().toString(36)}`;
        const startMs = Date.now();
        const description = prompt.slice(0, 80);
        onResolved?.({ recordId: remote.childSessionId });
        emitSubagentEvent(pi, 'subagents:started', {
          id: stepRunId,
          type: remote.botId,
          description,
          phase: remote.phaseTitle,
          childSessionId: remote.childSessionId,
        });
        const client = await connectHubAsNode(dataDir);
        const res = await sendSessionMessageAndWait(client, remote.childSessionId, prompt, {
          waitSeconds: stepTimeoutSeconds,
          signal: abortSignal,
        });
        emitSubagentEvent(
          pi,
          res.ok ? 'subagents:completed' : 'subagents:failed',
          { id: stepRunId, type: remote.botId, description, phase: remote.phaseTitle, childSessionId: remote.childSessionId },
          {
            status: res.ok ? 'completed' : 'error',
            ...(res.ok ? { result: res.reply } : { error: res.reply || 'Resume failed' }),
            durationMs: Date.now() - startMs,
          },
        );
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
}

/** 断点回放步骤的 UI 桥接：批量更新任务进度 + cached done 条目补发 completed 事件 */
function createWorkflowProgressBridge(pi: ExtensionAPI, runId: string, task: ReturnType<typeof createWorkflowTask>) {
  const emittedCachedSteps = new Set<number>();
  return (entries: readonly any[]) => {
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
        emitSubagentEvent(
          pi,
          'subagents:completed',
          {
            id: `${runId}_cached_${entry.index}`,
            type: entry.agentType || 'agent',
            description: `[已缓存] ${entry.label ?? ''}`,
            phase: entry.phaseTitle,
          },
          { status: 'completed', result: entry.resultPreview || '（断点续跑：已复用上次成功结果）', durationMs: 0 },
        );
      }
    }
  };
}

/** 聚合工作流运行结果为工具返回（结构化摘要 / 失败时的断点续跑提示） */
function formatWorkflowResult(
  task: ReturnType<typeof createWorkflowTask>,
  result: Awaited<ReturnType<typeof runWorkflow>>,
  meta: { name: string; runId: string; scriptPath: string; resumeFromRunId: string },
): any {
  const lines = [
    `Workflow "${meta.name}" ${result.status} (runId: ${meta.runId})`,
    `Script: ${meta.scriptPath}`,
  ];
  if (result.replayedCount > 0) {
    lines.push(`Replayed from ${meta.resumeFromRunId}: ${result.replayedCount}/${result.agentCount} step(s) from journal cache.`);
  }
  if (result.status === 'failed' && result.error) {
    lines.push(`Error: ${result.error}`);
  }
  lines.push(`Result: ${workflowResultText(task)}`);
  if (result.status === 'failed') {
    lines.push(
      `To retry from the failed step without re-running completed steps, call SubagentWorkflow with { scriptPath: "${meta.scriptPath}", resumeFromRunId: "${meta.runId}" }.`,
    );
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: {
      taskId: meta.runId,
      runId: meta.runId,
      scriptPath: meta.scriptPath,
      status: result.status,
      value: result.value,
      replayedCount: result.replayedCount,
      agentCount: result.agentCount,
    },
    ...(result.status === 'failed' ? { isError: true } : {}),
  } as any;
}

export interface PreparedWorkflowRun {
  runId: string;
  stepTimeoutSeconds: number;
  resumeFromRunId: string;
  replayEntries: WorkflowJournalEntry[] | undefined;
  scriptSource: string;
  scriptPath: string;
  journalPath: string;
  meta: ReturnType<typeof validateScript>['meta'];
  sessions: WorkflowSessionsMap;
}

/** 逆序准备一次运行：目录/断点日志回放、脚本源解析、meta 校验、脚本副本与 journal 落盘、子会话映射继承 */
export async function prepareWorkflowRun(
  workspaceDir: string,
  params: any,
): Promise<PreparedWorkflowRun | { error: string }> {
  // 1) 准备 .workflows 目录与断点日志回放
  const workflowsDir = path.join(workspaceDir, '.workflows');
  await ensureDir(workflowsDir);
  const replay = await loadWorkflowReplay(
    workflowsDir,
    typeof params?.resumeFromRunId === 'string' ? params.resumeFromRunId.trim() : '',
  );
  if (typeof replay === 'string') return { error: replay };
  const { resumeFromRunId, replayEntries } = replay;

  // 2) 解析脚本源（script > scriptPath > name > 断点脚本副本）
  const script = await loadWorkflowScript({
    workspaceDir,
    workflowsDir,
    script: params?.script,
    scriptPath: params?.scriptPath,
    name: params?.name,
    resumeFromRunId,
  });
  if ('error' in script) return script;

  // 3) 校验脚本 meta（失败直接返回作者可修复的报错）
  let validated: ReturnType<typeof validateScript>;
  try {
    validated = validateScript(script.source);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  // 4) 落盘脚本副本 + 新建本次运行的 journal 与子会话映射
  const runId = workflowRunId();
  const persisted = await persistWorkflowScript(workflowsDir, runId, workspaceDir, params?.scriptPath, script.source);
  if ('error' in persisted) return persisted;
  const sessions = new WorkflowSessionsMap(workflowsDir, runId);
  await sessions.inheritFrom(workflowsDir, resumeFromRunId);

  return {
    runId,
    stepTimeoutSeconds: effectiveTimeoutSeconds(params?.timeout_seconds),
    resumeFromRunId,
    replayEntries,
    scriptSource: script.source,
    scriptPath: persisted.scriptPath,
    journalPath: persisted.journalPath,
    meta: validated.meta,
    sessions,
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
export function wrapWorkflowToolForCrossBot(
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

  // 工具参数定义：追加可选 timeout_seconds（每次跨 Bot 步骤的等待超时）
  const parameters = tool.parameters ? { ...tool.parameters } : { type: 'object', properties: {} };
  const properties = { ...(parameters.properties || {}) };
  if (!properties.timeout_seconds) {
    properties.timeout_seconds = {
      type: 'number',
      description: 'Maximum seconds to wait for each cross-bot step (default: 600 or BOTD_CROSS_BOT_TIMEOUT_SECONDS).',
    };
  }
  parameters.properties = properties;

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

    const run = await prepareWorkflowRun(workspaceDir, params);
    if ('error' in run) return textResult(run.error, true);
    const { runId, scriptSource, scriptPath, journalPath, meta, replayEntries, resumeFromRunId } = run;

    // 未完成断点标记：启动即写入，正常跑完删除；失败 / 中断保留供下回合提示续跑
    await markWorkflowRunStarted(workspaceDir, {
      runId,
      workflowName: meta.name,
      scriptPath,
    });

    // 5) 组合 abort 信号：父级取消（会话停止）中止整个工作流；接管（新消息）仅解除等待
    const effectiveSessionId = deps.sessionId || process.env.BOTD_SESSION_ID || '';
    const watch = createHandoffWatch({ parentSignal: signal, handoffScope });
    const workflowAbortController = watch.combo;

    // 6) CompositeWorkflowHost + 前台跑完整个工作流并返回结构化摘要
    const host = createCrossBotWorkflowHost(
      {
        dataDir,
        botDir,
        workspaceDir,
        effectiveSessionId,
        pi,
        handoffScope,
        sessions: run.sessions,
        runId,
        workflowName: meta.name,
        stepTimeoutSeconds: run.stepTimeoutSeconds,
        abortSignal: workflowAbortController.signal,
        isHandedOff: () => watch.isHandedOff(),
      },
      ctx,
    );
    const task = createWorkflowTask({
      id: runId,
      script: scriptSource,
      scriptPath,
      args: params?.args,
      meta,
      toolCallId,
      journalPath,
      ...(replayEntries && replayEntries.length > 0 ? { replay: replayEntries, resumedFrom: resumeFromRunId } : {}),
    });

    try {
      const result = await runWorkflow({
        script: scriptSource,
        args: params?.args,
        signal: workflowAbortController.signal,
        host,
        onProgress: createWorkflowProgressBridge(pi, runId, task),
        journal: {
          ...(replayEntries ? { entries: replayEntries } : {}),
          append: (entry) => appendJournal(journalPath, entry),
        },
      });
      completeWorkflowTask(task, result);
      // 正常跑完（completed）才清除断点标记；failed / killed 保留供下回合提示续跑
      if (result.status === 'completed') {
        await markWorkflowRunFinished(workspaceDir);
      }
      return formatWorkflowResult(task, result, { name: meta.name, runId, scriptPath, resumeFromRunId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failWorkflowTask(task, message);
      return textResult(`Workflow "${meta.name}" failed (runId: ${runId}): ${message}\nScript: ${scriptPath}`, true, {
        taskId: runId,
        runId,
        scriptPath,
        status: 'failed',
      });
    } finally {
      watch.cleanup();
    }
  };

  return { ...tool, parameters, execute: wrappedExecute };
}
