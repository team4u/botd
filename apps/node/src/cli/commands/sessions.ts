import type {
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
 * 时序：先订阅父会话 SSE（等初始 session_status 快照帧确认流已激活），再 POST delegate。
 * 这样即使子会话极快完成，完成/失败 callback 消息也不会漏采。
 * 终止信号：父会话出现匹配 childSessionId 的 ✅/❌ callback 消息、waitSeconds 超时、
 * 或外部 signal 中止（用户接管/取消）。结束后拉取子会话消息提取 reply / 错误详情。
 */
export async function delegateSessionAndWait(
  client: HubClient,
  parentSessionId: string,
  input: DelegateSessionInput & { autoWakeParent?: boolean },
  options: {
    waitSeconds: number;
    signal?: AbortSignal;
    onChildCreated?: (res: DelegateSessionResult) => void;
  },
): Promise<DelegateWaitOutput> {
  const abortController = new AbortController();
  const externalAbort = () => abortController.abort();
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener('abort', externalAbort, { once: true });

  const streamReady = createDeferred<void>();
  let streamReadySettled = false;
  let sawInitialSnapshot = false;
  const callbackBuffer: MessageRecord[] = [];
  const completion = createDeferred<MessageRecord>();
  let completionSettled = false;
  let childSessionId = '';

  /** 判定一条 callback 消息是否为 childSessionId 的完成/失败通知 */
  const isCompletionFor = (msg: MessageRecord, childSessionId: string): boolean =>
    msg.role === 'callback' &&
    msg.content.includes(`(#?s=${childSessionId})`) &&
    (msg.content.startsWith('✅') || msg.content.startsWith('❌'));

  const eventsPromise = client
    .events(parentSessionId, {
      signal: abortController.signal,
      onEvent: (event: SessionSseEvent) => {
        if (!streamReadySettled) {
          streamReadySettled = true;
          streamReady.resolve();
        }
        // 服务器建流时总是先推一帧当前状态快照，不能作为任何业务事件的依据
        if (event.type === 'session_status' && !sawInitialSnapshot) {
          sawInitialSnapshot = true;
          return;
        }
        if (event.type === 'message_created' && event.message.role === 'callback') {
          callbackBuffer.push(event.message);
          if (
            childSessionId &&
            isCompletionFor(event.message, childSessionId) &&
            !completionSettled
          ) {
            completionSettled = true;
            completion.resolve(event.message);
          }
        }
      },
    })
    .catch((err: unknown) => {
      if (!streamReadySettled) {
        streamReadySettled = true;
        streamReady.reject(err);
      }
      // 主动断流（abortController.abort()）导致的抛错是正常路径，吞掉
    });

  try {
    // 1. 等事件流激活（收到首个事件），10 秒无事件则超时
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const streamTimeout = new Promise<never>((_, reject) => {
      streamTimer = setTimeout(() => {
        reject(new CliError('Timed out opening the session event stream'));
      }, 10_000);
    });
    try {
      await Promise.race([streamReady.promise, streamTimeout]);
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
    }

    // 2. 流激活后再创建子会话，避免竞态漏掉快速完成的 callback
    const delegateResult = await client.post<DelegateSessionResult>(
      `/api/sessions/${encodeURIComponent(parentSessionId)}/delegate`,
      { ...input, autoWakeParent: input.autoWakeParent ?? false },
    );
    childSessionId = delegateResult.childSession.id;
    options.onChildCreated?.(delegateResult);

    // 3. 缓冲区可能已含完成回调（子会话在 POST 返回前就结束）
    const alreadyDone = callbackBuffer.find((m) => isCompletionFor(m, childSessionId));
    if (alreadyDone && !completionSettled) {
      completionSettled = true;
      completion.resolve(alreadyDone);
    }

    // 4. 等待完成 callback、超时或外部中止
    if (!completionSettled) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const waitTimeout = new Promise<never>((_, reject) => {
        waitTimer = setTimeout(() => {
          reject(new CliError(`Timed out after ${options.waitSeconds}s waiting for the sub-session to finish`));
        }, options.waitSeconds * 1000);
      });
      const onAbortReject = () => {
        if (!completionSettled) {
          completionSettled = true;
          completion.resolve(undefined as unknown as MessageRecord);
        }
      };
      abortController.signal.addEventListener('abort', onAbortReject, { once: true });
      try {
        await Promise.race([completion.promise, waitTimeout]);
      } finally {
        if (waitTimer) clearTimeout(waitTimer);
        abortController.signal.removeEventListener('abort', onAbortReject);
      }
    }

    const completionCallbackMsg =
      callbackBuffer.find((m) => isCompletionFor(m, childSessionId)) ?? undefined;

    // 5. 拉取子会话消息，提取 reply 或错误详情
    const childMessages = completionCallbackMsg
      ? await client.get<MessageRecord[]>(
          `/api/sessions/${encodeURIComponent(childSessionId)}/messages`,
        )
      : [];

    const failed = completionCallbackMsg?.content.startsWith('❌') === true;
    let status: 'done' | 'failed' = 'done';
    let reply = '';
    if (!completionCallbackMsg) {
      status = 'failed';
      reply = `Timed out or aborted while waiting for sub-session "${childSessionId}" to finish. It may still be running; inspect it with \`botd sessions messages ${childSessionId} --json\`.`;
    } else if (failed) {
      status = 'failed';
      const lastSystem = [...childMessages].reverse().find((m) => m.role === 'system');
      reply = lastSystem?.content?.trim() || completionCallbackMsg.content.trim();
    } else {
      const lastAssistant = [...childMessages].reverse().find((m) => m.role === 'assistant');
      reply = lastAssistant?.content?.trim() ?? '';
    }

    return {
      ...delegateResult,
      status,
      reply,
      returnedArtifacts: completionCallbackMsg?.attachments ?? [],
    };
  } finally {
    abortController.abort();
    void eventsPromise.catch(() => {});
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
