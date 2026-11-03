import type { DelegateSessionResult } from '@botd/protocol';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readNodeIdentity } from '../storage.js';
import { createHandoffWatch, type SubagentHandoffScope } from './coordination.js';

/**
 * 跨 Bot 子会话执行机制：Hub 连接、子会话等待/续聊、前台/后台执行。
 * 供 commands.ts 的 Agent 工具包装器与 cross-bot/workflow.ts 的工作流 host 共用。
 */

/**
 * 框架内部（delegate_bot / 工作流跨 BOT 步骤）连接 Hub：优先节点身份的 hubUrl。
 * cli.json 是用户侧 CLI 的持久化状态，可能残留过期地址（如 Hub 换端口后），
 * 框架内部调用不应被它劫持——daemon 自己的 node.json 才是当前配对事实。
 * 未配对时退回 cli.json / 默认登录路径，保持 CLI 手动配置仍可用。
 */
export async function connectHubAsNode(dataDir: string): Promise<import('../cli/hub-client.js').HubClient> {
  const { HubClient } = await import('../cli/hub-client.js');
  const identity = await readNodeIdentity(dataDir);
  return HubClient.connect(identity?.hubUrl ? { dataDir, hubUrl: identity.hubUrl } : { dataDir });
}

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

export interface CrossBotSessionRecord {
  childSessionId: string;
  botId: string;
  label: string;
  phaseTitle?: string;
}

/** 跨 Bot 子会话全局映射表：支持按 agentId、runId、label 或 childSessionId 查找 */
const crossBotSessionMap = new Map<string, CrossBotSessionRecord>();

/** 登记一条跨 Bot 子会话记录（按 runId、childSessionId 与可选 label 建索引） */
export function rememberCrossBotSession(
  stepRunId: string,
  record: { childSessionId: string; botId: string; label?: string; phaseTitle?: string },
): CrossBotSessionRecord {
  const rec: CrossBotSessionRecord = {
    childSessionId: record.childSessionId,
    botId: record.botId,
    label: record.label || record.botId,
    ...(record.phaseTitle !== undefined ? { phaseTitle: record.phaseTitle } : {}),
  };
  crossBotSessionMap.set(stepRunId, rec);
  crossBotSessionMap.set(rec.childSessionId, rec);
  if (record.label) crossBotSessionMap.set(record.label, rec);
  return rec;
}

/** 查找跨 Bot 子会话记录（仅精确匹配映射表，不做 sess_ 推断） */
export function lookupCrossBotSession(ref: string): CrossBotSessionRecord | undefined {
  return crossBotSessionMap.get(ref);
}

/** 查找跨 Bot 子会话记录：映射表命中，或形如 sess_* 的裸子会话 ID */
export function findCrossBotSession(ref: string): CrossBotSessionRecord | undefined {
  return (
    lookupCrossBotSession(ref) ??
    (ref.startsWith('sess_') ? { childSessionId: ref, botId: 'remote', label: ref } : undefined)
  );
}

/**
 * 向协同面板发射 subagents:* 生命周期事件（可选携带 phase / childSessionId，
 * undefined 时按原语义省略字段，extra 透传 status/result/error/durationMs 等）。
 */
export function emitSubagentEvent(
  pi: ExtensionAPI,
  event: 'subagents:started' | 'subagents:completed' | 'subagents:failed',
  data: { id: string; type: string; description: string; phase?: string; childSessionId?: string },
  extra?: Record<string, unknown>,
): void {
  pi.events.emit(event, {
    id: data.id,
    type: data.type,
    description: data.description,
    ...(data.phase !== undefined ? { phase: data.phase } : {}),
    ...(data.childSessionId !== undefined ? { childSessionId: data.childSessionId } : {}),
    ...extra,
  });
}

/**
 * 向跨 Bot 子会话发送跟进消息并等待该会话回到 idle / failed。
 * 时序与 delegateSessionAndWait 对齐：先订阅子会话 SSE 确认流已激活，再 POST 消息。
 */
export async function sendSessionMessageAndWait(
  client: import('../cli/hub-client.js').HubClient,
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

/** 默认跨 Bot 子会话等待超时（秒）：BOTD_CROSS_BOT_TIMEOUT_SECONDS 可覆盖，缺省 600 */
export function getDefaultCrossBotTimeoutSeconds(): number {
  const raw = Number(process.env.BOTD_CROSS_BOT_TIMEOUT_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600;
}

/** 参数显式 timeout_seconds > BOTD_CROSS_BOT_TIMEOUT_SECONDS > 600 */
export function effectiveTimeoutSeconds(timeoutSeconds: unknown): number {
  return typeof timeoutSeconds === 'number' && timeoutSeconds > 0
    ? timeoutSeconds
    : getDefaultCrossBotTimeoutSeconds();
}

/**
 * 探测一个历史子会话能否被断点续跑重连复用。
 *
 * Hub 未提供 GET /api/sessions/:id 单端点；这里用消息列表做探针：
 * - 404（会话不存在）→ 不可复用（丢弃记录，派生新子会话重试）
 * - 末条消息为 system（回合失败落下的错误消息）→ 已失败，不可复用
 * - 其余（idle 且有 assistant 回复 / running / queued）→ 可复用，具体收敛
 *   状态由重连等待逻辑（waitForExistingChildSession 的 SSE 首帧快照 + 后续帧）判定
 */
export async function probeChildSessionReusable(
  client: import('../cli/hub-client.js').HubClient,
  childSessionId: string,
): Promise<boolean> {
  try {
    const messages = await client.get<Array<{ role?: string }>>(
      `/api/sessions/${encodeURIComponent(childSessionId)}/messages`,
    );
    const last = messages[messages.length - 1];
    if (last?.role === 'system') return false;
    return true;
  } catch {
    return false;
  }
}

export interface CrossBotSessionOptions {
  client: import('../cli/hub-client.js').HubClient;
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
  /** 传入时复用/重连该已有子会话（断点续跑幂等复用），绝不重新 POST /delegate */
  existingChild?: DelegateSessionResult;
  /** 配合 existingChild：父会话产物基线（用于识别重连后新回传的产物） */
  baselineParentArtifactIds?: string[];
}

export interface CrossBotExecutionResult {
  ok: boolean;
  status: 'done' | 'failed' | 'timed_out' | 'aborted' | 'background';
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
export async function executeCrossBotSession(options: CrossBotSessionOptions): Promise<CrossBotExecutionResult> {
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
    existingChild,
    baselineParentArtifactIds,
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
    rememberCrossBotSession(stepRunId, { childSessionId: res.childSession.id, botId, label, phaseTitle });

    onChildCreated?.(res);
    emitSubagentEvent(pi, 'subagents:started', {
      id: stepRunId,
      type: botId,
      description,
      phase: phaseTitle,
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
  const { delegateSessionAndWait } = await import('../cli/commands/sessions.js');
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
        waitSeconds: timeoutSeconds ?? getDefaultCrossBotTimeoutSeconds(),
        signal: watch.signal,
        existingChild,
        ...(baselineParentArtifactIds ? { baselineParentArtifacts: baselineParentArtifactIds } : {}),
        onChildCreated: (r) => {
          childSessionId = r.childSession.id;
          rememberCrossBotSession(stepRunId, { childSessionId, botId, label, phaseTitle });

          onChildCreated?.(r);
          emitSubagentEvent(pi, 'subagents:started', {
            id: stepRunId,
            type: botId,
            description,
            phase: phaseTitle,
            childSessionId: r.childSession.id,
          });
        },
      },
    );
  } catch (err) {
    if (watch.isHandedOff() || signal?.aborted || watch.signal.aborted) {
      waitRes = undefined;
    } else if (
      err instanceof Error &&
      err.message.includes('Timed out after') &&
      childSessionId
    ) {
      // 等待超时：子会话仍在后台运行且未被取消。返回结构化 timed_out 结果，
      // 保留 childSessionId 供断点续跑幂等重连，绝不向外 throw 丢失子会话句柄。
      const formattedText = `Sub-session "${childSessionId}" (@${botId}) timed out after ${timeoutSeconds ?? getDefaultCrossBotTimeoutSeconds()}s while still running. It was NOT cancelled and continues running in the background.`;
      return {
        ok: false,
        status: 'timed_out',
        reply: formattedText,
        formattedText,
        childSessionId,
        returnedArtifacts: [],
        details: { agentId: stepRunId, childSessionId, status: 'timed_out' },
        durationMs: Date.now() - startMs,
      };
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
    emitSubagentEvent(
      pi,
      isFailed ? 'subagents:failed' : 'subagents:completed',
      {
        id: stepRunId,
        type: botId,
        description,
        phase: phaseTitle,
        childSessionId: waitRes.childSession.id,
      },
      {
        status: isFailed ? 'error' : 'completed',
        ...(isFailed ? { error: waitRes.reply || 'Cross-bot sub-session failed' } : { result: waitRes.reply }),
        durationMs,
      },
    );
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
