import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SubagentRunRecord } from '@botd/protocol';
import type { HubStream } from './hub-stream.js';
import { createHubStreamSink, toSubagentPayload } from './hub-stream.js';
import { TurnEventRecorder } from './turn-events.js';
import { runRegistry } from './run-registry.js';
import { getDataDirSafe } from './shell-env.js';
import { getBotDir, getBotWorkspaceDir, readBot } from '../storage.js';
import { createRuntimeForProvider, configureProviderAuth } from '../models.js';
import { loadTurnDeps } from './turn-deps.js';
import { getGlobalSubagentManager } from '../commands.js';

/**
 * 回合外的分身直接控制：steer（运行中插话）、stop（单独停止）、resume（结束后追问）。
 * 由 daemon 暴露为 NodeRpcFunctions，供 Hub 在回合外部定位并操控分身。
 */

/** 最近一次活跃回合的 hubRpc 引用：后台/resume 推流用（turn 结束后仍可能收到完成事件） */
let lastHubRpc: HubStream | null = null;

/** 供 daemon 传入 hubRpc，使回合外的 resume / 后台完成也能推流给 Hub */
export function setRuntimeHubRpc(rpc: HubStream | null): void {
  lastHubRpc = rpc;
}

/** 回合结束后的兜底推流：直接走 lastHubRpc */
function emitOrphanSubagentEvent(sessionId: string, botId: string, run: SubagentRunRecord): void {
  if (!lastHubRpc) return;
  try {
    createHubStreamSink(lastHubRpc).subagent(sessionId, botId, toSubagentPayload(run));
  } catch {
    // 推流失败不影响结果返回
  }
}

/**
 * 主会话运行中收到用户新消息：将正在阻塞等待的前台分身切为后台继续运行，
 * 并把新消息 steer 进当前主 Bot 回合，让主 Bot 马上接管响应
 * （调用 stop_subagent / steer_subagent 控制分身）。
 */
export async function steerBotTurn(
  sessionId: string,
  botId: string,
  message: string,
): Promise<{ accepted: boolean }> {
  const { triggerActiveSubagentHandoff } = await import('../commands.js');
  const ctx = runRegistry.findActiveTurn(sessionId);
  if (!ctx || ctx.botId !== botId) return { accepted: false };
  const session = runRegistry.getSession(ctx.runKey);
  if (!session) return { accepted: false };
  if (!message.trim()) return { accepted: false };

  // 1) 触发前台分身转后台（解除 Agent 工具的阻塞等待）
  triggerActiveSubagentHandoff();

  // 2) 将用户新消息注入当前主 Bot 回合
  try {
    await session.steer(message);
    return { accepted: true };
  } catch {
    return { accepted: false };
  }
}

/** 单独停止某一个正在运行的子代理（按 runId），不中断主回合与其他分身 */
export async function stopSubagent(
  sessionId: string,
  botId: string,
  runId: string,
): Promise<{ ok: boolean; error?: string }> {
  const manager = getGlobalSubagentManager();
  const record = manager?.getRecord?.(runId);
  if (!record) {
    return { ok: false, error: `Subagent run "${runId}" not found on this node (it may have finished or been evicted).` };
  }
  const aborted = manager?.abort?.(runId) ?? false;
  if (!aborted) {
    return { ok: false, error: `Subagent run "${runId}" is not running (status: ${record.status}).` };
  }

  // 更新本地 runRecord 状态并推送流事件（事件桥也会收到 subagents:failed，此处立即反馈）
  const ctx = runRegistry.findActiveTurn(sessionId);
  if (ctx && ctx.sessionId === sessionId && ctx.botId === botId) {
    const run = ctx.peekSubagentRun(runId);
    if (run) {
      run.status = 'stopped';
      run.currentTool = undefined;
      if (typeof record.result === 'string' && record.result) {
        run.replyFull = record.result;
        run.replyPreview = record.result.slice(0, 200);
      }
      ctx.emitSubagentEvent(run);
    }
  }
  return { ok: true };
}

/**
 * 直接向某个子代理发送 steer（运行中插话）或 resume（结束后继续追问）。
 * - steer：通过全局 manager.steer 将消息投递进运行中的分身会话；
 * - resume：若 manager 记录仍在则 manager.resume 同一 runId；否则用保存的 sessionFile
 *   重开同一分身上下文执行一轮追问（跨回合场景）。期间推送同一 runId 的
 *   running -> done 状态、steers、toolCalls 与更新后的 replyFull。
 */
export async function interactSubagent(input: {
  sessionId: string;
  botId: string;
  runId: string;
  subagentId?: string;
  message: string;
  mode: 'steer' | 'resume';
}): Promise<{ ok: boolean; run?: SubagentRunRecord; error?: string }> {
  const { sessionId, botId, runId, message, mode } = input;
  if (!message.trim()) return { ok: false, error: 'Message must be non-empty.' };

  const ctx = runRegistry.findActiveTurn(sessionId);
  const manager = getGlobalSubagentManager();
  const managerRecord = manager?.getRecord?.(runId);

  // 取（或重建）runRecord
  let run: SubagentRunRecord | undefined = ctx?.peekSubagentRun(runId);
  if (!run) {
    const meta = ctx?.sessionFiles.get(runId);
    run = {
      id: runId,
      subagentId: input.subagentId || meta?.subagentId || managerRecord?.type || 'agent',
      task: meta?.task || managerRecord?.description || runId,
      status: 'running',
      ...(managerRecord?.startedAt ? { startedAt: new Date(managerRecord.startedAt).toISOString() } : {}),
    };
  }
  const pushEvent = (patch: Partial<SubagentRunRecord>) => {
    Object.assign(run!, patch);
    if (ctx) {
      ctx.emitSubagentEvent(run!);
    } else {
      // 回合已结束（后台 resume）：直接通过 lastHubRpc 推流
      emitOrphanSubagentEvent(sessionId, botId, run!);
    }
  };

  if (mode === 'steer') {
    if (!managerRecord || managerRecord.status !== 'running') {
      return { ok: false, error: `Subagent run "${runId}" is not running (status: ${managerRecord?.status ?? 'unknown'}). Use resume mode instead.` };
    }
    const accepted = manager?.steer?.(runId, message) ?? false;
    if (!accepted) {
      return { ok: false, error: `Failed to steer subagent run "${runId}".` };
    }
    run.steers ??= [];
    run.steers.push({ message, timestamp: new Date().toISOString(), mode: 'steer' });
    pushEvent({});
    return { ok: true, run };
  }

  // ---- resume：在同一 runId / 同一分身上下文继续追问 ----
  const startedAt = Date.now();
  run.steers ??= [];
  run.steers.push({ message, timestamp: new Date().toISOString(), mode: 'resume' });
  pushEvent({ status: 'running', currentTool: undefined });

  try {
    // 优先：manager 记录仍在（同回合或记录未被清理）→ manager.resume 保持同一 runId
    if (managerRecord?.session) {
      const record = await manager?.resume?.(runId, message, undefined, { isBackground: true });
      if (!record) {
        pushEvent({ status: 'error', replyFull: 'Resume was rejected (the run may still be in progress).', durationMs: Date.now() - startedAt });
        return { ok: false, run, error: 'Resume rejected: the run may still be in progress.' };
      }
      const isStopped = record.status === 'stopped' || record.status === 'aborted';
      const full = String(record.result || record.error || '');
      pushEvent({
        status: record.status === 'error' ? 'error' : isStopped ? 'stopped' : 'done',
        ...(full ? { replyFull: full, replyPreview: full.slice(0, 200) } : {}),
        durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
        currentTool: undefined,
      });
      return { ok: true, run };
    }

    // 跨回合：用保存的 sessionFile 重开同一分身上下文执行一轮追问
    const meta = ctx?.sessionFiles.get(runId);
    if (!meta?.sessionFile || !existsSync(meta.sessionFile)) {
      pushEvent({ status: 'error', replyFull: `Subagent session file for "${runId}" is gone; cannot resume.`, durationMs: Date.now() - startedAt });
      return { ok: false, run, error: `Subagent run "${runId}" has no resumable session file on this node.` };
    }

    const turnDeps = await loadTurnDeps();
    const { createAgentSession, SessionManager, SettingsManager } = turnDeps.piAgent;
    const getModel = turnDeps.piAiCompat.getModel;
    const dataDir = getDataDirSafe();
    const botData = await readBot(dataDir, botId);
    const botConfig = (botData as any)?.config ?? botData?.bot;
    if (!botConfig) {
      pushEvent({ status: 'error', replyFull: `Bot "${botId}" not found on node; cannot resume.`, durationMs: Date.now() - startedAt });
      return { ok: false, run, error: `Bot "${botId}" not found on node.` };
    }

    const subBotDir = getBotDir(dataDir, botConfig.parentBotId || botConfig.id);
    const workspaceDir = getBotWorkspaceDir(dataDir, botConfig.parentBotId || botConfig.id);

    const modelRuntime = await createRuntimeForProvider(dataDir, botConfig.modelProvider);
    await configureProviderAuth(modelRuntime, botConfig.modelProvider);
    const model =
      modelRuntime.getModel(botConfig.modelProvider, botConfig.modelId) ??
      getModel(botConfig.modelProvider as any, botConfig.modelId as any);
    if (!model) {
      pushEvent({ status: 'error', replyFull: `Model not found: ${botConfig.modelProvider}/${botConfig.modelId}`, durationMs: Date.now() - startedAt });
      return { ok: false, run, error: `Model not found: ${botConfig.modelProvider}/${botConfig.modelId}` };
    }

    // 分身会话文件在 subBotDir 下：重开同一文件继续追问
    const sessionManager = SessionManager.open(meta.sessionFile, path.join(subBotDir, 'sessions'), workspaceDir);
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: botConfig.modelProvider,
      defaultModel: botConfig.modelId,
      compaction: { enabled: false },
    });
    const resourceLoader = await turnDeps.commandsMod.loadBotResources(
      dataDir,
      botConfig,
      settingsManager,
      () => [],
      { enableSubagents: false }, // 分身不能再派分身
    );
    const created = await createAgentSession({
      cwd: workspaceDir,
      agentDir: subBotDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    const subSession = created.session;

    // 订阅分身工具事件，实时更新 run.toolCalls
    run.toolCalls ??= [];
    run.blocks ??= [];
    const recorder = new TurnEventRecorder(
      { blocks: run.blocks, toolCalls: run.toolCalls },
      {
        onTool: ({ status }) => {
          if (status === 'running') {
            run!.currentTool = run!.toolCalls!.at(-1)?.name;
          } else if (!run!.toolCalls!.some((tc) => tc.status === 'running')) {
            run!.currentTool = undefined;
          }
          run!.toolCount = run!.toolCalls!.length;
          pushEvent({});
        },
      },
    );
    const unsubTools = subSession.subscribe((event: any) => recorder.handle(event));

    try {
      await subSession.prompt(message);
      await subSession.waitForIdle();
    } finally {
      unsubTools();
      recorder.markThinkingDone();
    }

    const assistants = subSession.messages.filter((m: any) => m.role === 'assistant');
    const texts = assistants.flatMap((m: any) =>
      (m.content || [])
        .filter((p: any) => p.type === 'text' && typeof p.text === 'string' && p.text.length > 0)
        .map((p: any) => p.text),
    );
    const reply = texts.join('\n\n').trim();
    const lastError = assistants.some((m: any) => m.stopReason === 'error');

    pushEvent({
      status: lastError ? 'error' : 'done',
      ...(reply ? { replyFull: reply, replyPreview: reply.slice(0, 200) } : {}),
      durationMs: Date.now() - startedAt,
      currentTool: undefined,
    });
    try {
      subSession.dispose();
    } catch {
      // ignore
    }
    return { ok: true, run };
  } catch (err: any) {
    const errorText = err?.message || String(err);
    pushEvent({ status: 'error', replyFull: errorText, durationMs: Date.now() - startedAt });
    return { ok: false, run, error: errorText };
  }
}
