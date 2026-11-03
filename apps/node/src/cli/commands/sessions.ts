import type {
  ArtifactRecord,
  DelegateSessionInput,
  DelegateSessionResult,
  MessageAttachment,
  MessageRecord,
  MessageSearchHit,
  SessionRecord,
  SessionShareRecord,
  SessionSseEvent,
} from '@botd/protocol';
import { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

export interface DelegateWaitOutput extends DelegateSessionResult {
  status: 'done' | 'failed';
  reply: string;
  returnedArtifacts: MessageAttachment[];
}

/**
 * 等待一个已存在的子会话收敛（idle / failed / 超时 / 中止），并拉取 reply 与回传产物。
 *
 * 这是 delegateSessionAndWait 的「重连」半部：子会话已经创建（可能因上次等待超时
 * 仍在后台运行或已经跑完），这里只负责订阅其 SSE 流继续等待、构造结果，
 * 绝不再次调用 POST /delegate 创建新子会话。
 */
async function waitForExistingChildSession(
  client: HubClient,
  parentSessionId: string,
  delegateResult: DelegateSessionResult,
  baselineParentArtifacts: Set<string>,
  options: {
    waitSeconds: number;
    signal?: AbortSignal;
  },
): Promise<DelegateWaitOutput> {
  const childSessionId = delegateResult.childSession.id;

  const abortController = new AbortController();
  const externalAbort = () => abortController.abort();
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener('abort', externalAbort, { once: true });

  const streamReady = createDeferred<void>();
  let streamReadySettled = false;
  let sawInitialSnapshot = false;
  const completion = createDeferred<{ status: 'done' | 'failed' }>();
  let completionSettled = false;
  let wasAborted = false;

  const resolveCompletion = (result: { status: 'done' | 'failed' }) => {
    if (!completionSettled) {
      completionSettled = true;
      completion.resolve(result);
    }
  };

  let eventsPromise: Promise<void> | undefined;

  try {
    const handleEvent = async (event: SessionSseEvent) => {
      if (!streamReadySettled) {
        streamReadySettled = true;
        streamReady.resolve();
      }
      if (event.type === 'session_status') {
        if (event.status === 'failed') {
          resolveCompletion({ status: 'failed' });
          return;
        }
        if (event.status === 'idle') {
          if (!sawInitialSnapshot) {
            sawInitialSnapshot = true;
            // 首帧快照：重连场景下子会话可能早已跑完（上次等待超时后收敛）。
            // 仅当已有 assistant/system 终态消息时才立即收敛；否则（例如回合尚未启动，
            // 会话仍为 idle）继续等待后续 running→idle 帧，避免误判为空回复完成。
            try {
              const msgs = await client.get<MessageRecord[]>(
                `/api/sessions/${encodeURIComponent(childSessionId)}/messages`,
              );
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg && lastMsg.role === 'system') {
                resolveCompletion({ status: 'failed' });
              } else if (lastMsg && lastMsg.role === 'assistant') {
                resolveCompletion({ status: 'done' });
              }
            } catch {
              // 忽略快照拉取异常，后续帧继续等待
            }
            return;
          }
          // 后续帧收到 idle，代表已完成
          resolveCompletion({ status: 'done' });
          return;
        }
        if (!sawInitialSnapshot) {
          sawInitialSnapshot = true;
        }
      }
    };

    eventsPromise = client
      .events(childSessionId, {
        signal: abortController.signal,
        onEvent: (event: SessionSseEvent) => {
          void handleEvent(event);
        },
      })
      .catch((err: unknown) => {
        if (!streamReadySettled) {
          streamReadySettled = true;
          streamReady.reject(err);
        }
      });

    // 等待子会话流激活（10 秒超时）
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const streamTimeout = new Promise<never>((_, reject) => {
      streamTimer = setTimeout(() => {
        reject(new CliError('Timed out opening the child session event stream'));
      }, 10_000);
    });
    try {
      await Promise.race([streamReady.promise, streamTimeout]);
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
    }

    // 等待状态收敛、超时或外部中止（超时直接抛出，让上层保留 childSessionId 信息）
    if (!completionSettled) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const waitTimeout = new Promise<never>((_, reject) => {
        waitTimer = setTimeout(() => {
          reject(new CliError(`Timed out after ${options.waitSeconds}s waiting for the sub-session to finish`));
        }, options.waitSeconds * 1000);
      });
      const onAbort = () => {
        wasAborted = true;
        resolveCompletion({ status: 'failed' });
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await Promise.race([completion.promise, waitTimeout]);
      } finally {
        if (waitTimer) clearTimeout(waitTimer);
        abortController.signal.removeEventListener('abort', onAbort);
      }
    }

    const outcome = await completion.promise.catch(() => ({ status: 'failed' as const }));

    // 拉取子会话消息与回传产物（与新建路径一致）
    const childMessages = await client
      .get<MessageRecord[]>(`/api/sessions/${encodeURIComponent(childSessionId)}/messages`)
      .catch(() => []);

    let status: 'done' | 'failed' = outcome.status;
    let reply = '';
    if (wasAborted) {
      status = 'failed';
      reply = `Timed out or aborted while waiting for sub-session "${childSessionId}" to finish. It may still be running; inspect it with \`botd sessions messages ${childSessionId} --json\`.`;
    } else if (status === 'failed') {
      const lastSystem = [...childMessages].reverse().find((m) => m.role === 'system');
      reply = lastSystem?.content?.trim() || 'Sub-session execution failed';
    } else {
      const lastAssistant = [...childMessages].reverse().find((m) => m.role === 'assistant');
      reply = lastAssistant?.content?.trim() ?? '';
    }

    const afterArtifacts = await client
      .get<ArtifactRecord[]>(`/api/sessions/${encodeURIComponent(parentSessionId)}/artifacts`)
      .catch(() => []);
    const returnedArtifacts: MessageAttachment[] = afterArtifacts
      .filter((a) => !baselineParentArtifacts.has(a.id))
      .map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        url: `/api/artifacts/${a.id}`,
      }));

    return {
      ...delegateResult,
      status,
      reply,
      returnedArtifacts,
    };
  } finally {
    abortController.abort();
    if (eventsPromise) void eventsPromise.catch(() => {});
    options.signal?.removeEventListener('abort', externalAbort);
  }
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

/**
 * 委派子会话并同步等待其完成（用于 `botd sessions delegate --wait` 与 delegate_bot 工具）。
 *
 * 时序：先获取父会话已有产物基线并 POST delegate 创建子会话，
 * 随后直接订阅子会话自身的 SSE 流（/api/sessions/:childSessionId/events）监听状态收敛（idle / failed）。
 * 结束后拉取子会话消息提取 reply / 错误详情，并对比父会话产物拉取新产出交付物。
 */
export async function delegateSessionAndWait(
  client: HubClient,
  parentSessionId: string,
  input: DelegateSessionInput & { autoWakeParent?: boolean },
  options: {
    waitSeconds: number;
    signal?: AbortSignal;
    onChildCreated?: (res: DelegateSessionResult) => void;
    /** 传入时不再创建新子会话，直接复用/重连该已有子会话（断点续跑幂等复用） */
    existingChild?: DelegateSessionResult;
    /** 配合 existingChild：父会话产物基线（缺省时在函数内重新拉取） */
    baselineParentArtifacts?: string[];
  },
): Promise<DelegateWaitOutput> {
  const abortController = new AbortController();
  const externalAbort = () => abortController.abort();
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener('abort', externalAbort, { once: true });

  const streamReady = createDeferred<void>();
  let streamReadySettled = false;
  let sawInitialSnapshot = false;
  const completion = createDeferred<{ status: 'done' | 'failed' }>();
  let completionSettled = false;
  let wasAborted = false;

  const resolveCompletion = (result: { status: 'done' | 'failed' }) => {
    if (!completionSettled) {
      completionSettled = true;
      completion.resolve(result);
    }
  };

  let eventsPromise: Promise<void> | undefined;

  try {
    // 1. 获取父会话已有的产物列表基线，后续用于识别子会话回传的新产物
    const baselineParentArtifacts = options.baselineParentArtifacts
      ? new Set(options.baselineParentArtifacts)
      : new Set(
          (
            await client
              .get<Array<{ id: string }>>(`/api/sessions/${encodeURIComponent(parentSessionId)}/artifacts`)
              .catch(() => [])
          ).map((a) => a.id),
        );

    // 1b. 复用已有子会话（断点续跑）：直接进入等待收敛，绝不再次 POST /delegate
    if (options.existingChild) {
      return waitForExistingChildSession(
        client,
        parentSessionId,
        options.existingChild,
        baselineParentArtifacts,
        { waitSeconds: options.waitSeconds, signal: options.signal },
      );
    }

    // 2. 创建子会话
    const delegateResult = await client.post<DelegateSessionResult>(
      `/api/sessions/${encodeURIComponent(parentSessionId)}/delegate`,
      { ...input, autoWakeParent: input.autoWakeParent ?? false },
    );
    const childSessionId = delegateResult.childSession.id;
    options.onChildCreated?.(delegateResult);

    // 3. 打开子会话自身事件流并监听状态收敛
    const handleEvent = async (event: SessionSseEvent) => {
      if (!streamReadySettled) {
        streamReadySettled = true;
        streamReady.resolve();
      }
      if (event.type === 'session_status') {
        if (event.status === 'failed') {
          resolveCompletion({ status: 'failed' });
          return;
        }
        if (event.status === 'idle') {
          if (!sawInitialSnapshot) {
            sawInitialSnapshot = true;
            // 首帧快照：检查子会话是否在建立 SSE 前已极速跑完
            try {
              const msgs = await client.get<MessageRecord[]>(
                `/api/sessions/${encodeURIComponent(childSessionId)}/messages`,
              );
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg && (lastMsg.role === 'assistant' || lastMsg.role === 'system')) {
                resolveCompletion({ status: lastMsg.role === 'system' ? 'failed' : 'done' });
              }
            } catch {
              // 忽略快照拉取异常，后续帧继续等待
            }
            return;
          }
          // 后续帧收到 idle，代表已完成
          resolveCompletion({ status: 'done' });
          return;
        }
        if (!sawInitialSnapshot) {
          sawInitialSnapshot = true;
        }
      }
    };

    eventsPromise = client
      .events(childSessionId, {
        signal: abortController.signal,
        onEvent: (event: SessionSseEvent) => {
          void handleEvent(event);
        },
      })
      .catch((err: unknown) => {
        if (!streamReadySettled) {
          streamReadySettled = true;
          streamReady.reject(err);
        }
      });

    // 4. 等待子会话流激活（10 秒超时）
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const streamTimeout = new Promise<never>((_, reject) => {
      streamTimer = setTimeout(() => {
        reject(new CliError('Timed out opening the child session event stream'));
      }, 10_000);
    });
    try {
      await Promise.race([streamReady.promise, streamTimeout]);
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
    }

    // 5. 等待状态收敛、超时或外部中止
    if (!completionSettled) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const waitTimeout = new Promise<never>((_, reject) => {
        waitTimer = setTimeout(() => {
          reject(new CliError(`Timed out after ${options.waitSeconds}s waiting for the sub-session to finish`));
        }, options.waitSeconds * 1000);
      });
      const onAbort = () => {
        wasAborted = true;
        resolveCompletion({ status: 'failed' });
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await Promise.race([completion.promise, waitTimeout]);
      } finally {
        if (waitTimer) clearTimeout(waitTimer);
        abortController.signal.removeEventListener('abort', onAbort);
      }
    }

    const outcome = await completion.promise.catch(() => ({ status: 'failed' as const }));

    // 6. 拉取子会话消息与回传产物
    const childMessages = await client
      .get<MessageRecord[]>(`/api/sessions/${encodeURIComponent(childSessionId)}/messages`)
      .catch(() => []);

    let status: 'done' | 'failed' = outcome.status;
    let reply = '';
    if (wasAborted) {
      status = 'failed';
      reply = `Timed out or aborted while waiting for sub-session "${childSessionId}" to finish. It may still be running; inspect it with \`botd sessions messages ${childSessionId} --json\`.`;
    } else if (status === 'failed') {
      const lastSystem = [...childMessages].reverse().find((m) => m.role === 'system');
      reply = lastSystem?.content?.trim() || 'Sub-session execution failed';
    } else {
      const lastAssistant = [...childMessages].reverse().find((m) => m.role === 'assistant');
      reply = lastAssistant?.content?.trim() ?? '';
    }

    const afterArtifacts = await client
      .get<ArtifactRecord[]>(`/api/sessions/${encodeURIComponent(parentSessionId)}/artifacts`)
      .catch(() => []);
    const returnedArtifacts: MessageAttachment[] = afterArtifacts
      .filter((a) => !baselineParentArtifacts.has(a.id))
      .map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        url: `/api/artifacts/${a.id}`,
      }));

    return {
      ...delegateResult,
      status,
      reply,
      returnedArtifacts,
    };
  } finally {
    abortController.abort();
    if (eventsPromise) void eventsPromise.catch(() => {});
    options.signal?.removeEventListener('abort', externalAbort);
  }
}

export function registerSessionsCommands(program: Command): void {
  const sessions = program.command('sessions').description('Session management');

  sessions
    .command('list')
    .description('List all chat sessions')
    .action(
      cliAction(async (_options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const list = await client.get<SessionRecord[]>('/api/sessions');
        printResult(list, g.json);
      }),
    );

  sessions
    .command('create')
    .description('Create a new chat session')
    .requiredOption('--title <title>', 'Session title')
    .requiredOption('--lead <botId>', 'Lead bot ID')
    .action(
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);

        const title = String(options.title).trim();
        const leadBotId = String(options.lead).trim();

        const session = await client.post<SessionRecord>('/api/sessions', {
          title,
          mode: 'direct',
          leadBotId,
          memberBotIds: [leadBotId],
        });
        printResult(session, g.json);
      }),
    );

  sessions
    .command('update <sessionId>')
    .description('Update a chat session')
    .option('--title <title>', 'Session title')
    .option('--lead <botId>', 'Lead bot ID')
    .option('--archive <boolean>', 'Archive (true) or restore (false) the session', (v: string) => v !== 'false')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);

        const body: Record<string, unknown> = {};
        if (typeof options.title === 'string') {
          body.title = options.title.trim();
        }
        if (typeof options.lead === 'string') {
          body.leadBotId = options.lead.trim();
          body.memberBotIds = [options.lead.trim()];
        }
        if (typeof options.archive === 'boolean') {
          body.archived = options.archive;
        }

        const updated = await client.patch<SessionRecord>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          body,
        );
        printResult(updated, g.json);
      })(options, command),
    );

  sessions
    .command('messages <sessionId>')
    .description('List message history of a session')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const messages = await client.get<MessageRecord[]>(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        );
        printResult(messages, g.json);
      })(options, command),
    );

  sessions
    .command('search <query...>')
    .description('Search messages across all sessions (or within --session)')
    .option('--session <sessionId>', 'Filter by session ID')
    .option('--limit <n>', 'Max results (default 30)', '30')
    .action((query: string[], options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const q = query.join(' ').trim();
        if (!q) {
          throw new Error('Provide the search query as trailing arguments');
        }
        const client = await HubClient.connect(g);
        const params = new URLSearchParams({ q });
        if (typeof options.session === 'string' && options.session.trim()) {
          params.set('sessionId', options.session.trim());
        }
        const rawLimit = Number(options.limit);
        if (Number.isFinite(rawLimit) && rawLimit > 0) {
          params.set('limit', String(Math.floor(rawLimit)));
        }
        const hits = await client.get<MessageSearchHit[]>(`/api/messages/search?${params.toString()}`);
        printResult(hits, g.json);
      })(options, command),
    );

  sessions
    .command('cancel <sessionId>')
    .description('Cancel an active session turn')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const res = await client.post<{ ok: boolean }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
        );
        printResult(res, g.json);
      })(options, command),
    );

  sessions
    .command('delete <sessionId>')
    .description('Delete a session and all its messages (bot memory is reset)')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const res = await client.delete<{ ok: boolean }>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
        );
        printResult(res, g.json);
      })(options, command),
    );

  sessions
    .command('clear <sessionId>')
    .description('Clear message history of a session and reset bot memory')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const res = await client.delete<{ ok: boolean }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        );
        printResult(res, g.json);
      })(options, command),
    );

  sessions
    .command('edit <sessionId> <messageId> [words...]')
    .description('Edit a sent user message; later replies are removed and regenerated')
    .action((sessionId: string, messageId: string, words: string[], options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const content = words.join(' ').trim();
        if (!content) {
          throw new Error('Provide the new message content as trailing arguments');
        }
        const client = await HubClient.connect(g);
        const updated = await client.put<MessageRecord>(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
          { content },
        );
        printResult(updated, g.json);
      })(options, command),
    );

  sessions
    .command('fork <sessionId>')
    .description('Fork a new session from an anchor message (history up to it is copied)')
    .requiredOption('--anchor <messageId>', 'Anchor message ID to fork from')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const forked = await client.post<SessionRecord>(
          `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
          { anchorMessageId: String(options.anchor).trim() },
        );
        printResult(forked, g.json);
      })(options, command),
    );

  sessions
    .command('share <sessionId>')
    .description('Create, view or revoke a public share link for a session')
    .option('--revoke', 'Revoke the existing share link')
    .option('--regenerate', 'Regenerate a new share token')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);

        if (options.revoke) {
          const res = await client.delete<{ ok: boolean }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/share`,
          );
          printResult(res, g.json);
          return;
        }

        const share = await client.post<SessionShareRecord>(
          `/api/sessions/${encodeURIComponent(sessionId)}/share`,
          { regenerate: Boolean(options.regenerate) },
        );
        const shareUrl = `${client.url}/?share=${encodeURIComponent(share.token)}`;
        printResult({ ...share, url: shareUrl }, g.json);
      })(options, command),
    );

  sessions
    .command('delegate <parentSessionId>')
    .description('Delegate a task to a sub-session executed by a bot')
    .requiredOption('--bot <botId>', 'Bot ID to execute the task')
    .requiredOption('--prompt <prompt>', 'Task prompt for the sub-session')
    .option('--title <title>', 'Sub-session title')
    .option('--artifacts <ids>', 'Comma-separated artifact IDs to pass to the sub-session')
    .option('--no-wake', 'Do not automatically wake the parent session when the sub-session finishes')
    .option(
      '--wait [seconds]',
      'Wait for the sub-session to finish and output its reply and returned artifacts',
      (v: string | undefined) => (v === undefined ? 300 : Number(v)),
      undefined,
    )
    .action((parentSessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const input: DelegateSessionInput & { autoWakeParent?: boolean } = {
          botId: String(options.bot).trim(),
          prompt: String(options.prompt).trim(),
          mode: 'direct',
        };
        if (typeof options.title === 'string' && options.title.trim()) {
          input.title = options.title.trim();
        }
        if (typeof options.artifacts === 'string' && options.artifacts.trim()) {
          const artifactIds = options.artifacts
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);
          if (artifactIds.length > 0) input.artifactIds = artifactIds;
        }
        if (options.wake === false) {
          input.autoWakeParent = false;
        }

        const rawWait = options.wait;
        let waitSeconds = 0;
        if (rawWait !== undefined && rawWait !== false) {
          const parsed = rawWait === true ? 300 : Number(rawWait);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new CliError(`Invalid --wait value: ${String(rawWait)}`);
          }
          waitSeconds = parsed;
        }

        if (waitSeconds === 0) {
          const result = await client.post<DelegateSessionResult>(
            `/api/sessions/${encodeURIComponent(parentSessionId)}/delegate`,
            input,
          );
          printResult(result, g.json);
          return;
        }

        // --wait：CLI 在前台内联消费子会话结果（等价 delegate_bot 前台模式）。
        // 前台等待语义下统一不唤醒父会话 lead bot（autoWakeParent=false），避免同一结果
        // 重复触发第二个消费者；后台唤醒语义由不加 --wait 的默认路径或 delegate_bot
        // 的 run_in_background: true 承担。
        const waitResult = await delegateSessionAndWait(
          client,
          parentSessionId,
          { ...input, autoWakeParent: false },
          { waitSeconds },
        );
        if (g.json) {
          printResult(waitResult, true);
        } else {
          console.log(waitResult.reply);
          if (waitResult.returnedArtifacts.length > 0) {
            console.log('Returned artifacts:');
            for (const artifact of waitResult.returnedArtifacts) {
              console.log(`- ${artifact.filename} (id: ${artifact.id}, url: ${artifact.url})`);
            }
          }
          if (waitResult.status === 'failed') {
            process.exitCode = 1;
            console.error('error: sub-session failed');
          }
        }
      })(options, command),
    );

  sessions
    .command('subsessions <parentSessionId>')
    .description('List sub-sessions of a parent session')
    .action((parentSessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const list = await client.get<SessionRecord[]>(
          `/api/sessions/${encodeURIComponent(parentSessionId)}/subsessions`,
        );
        printResult(list, g.json);
      })(options, command),
    );
}
