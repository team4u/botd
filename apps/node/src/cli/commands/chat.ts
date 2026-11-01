import type { MessageRecord, SessionSseEvent } from '@botd/protocol';
import type { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

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

export function registerChatCommands(program: Command): void {
  const chat = program.command('chat').description('Chat and session interaction');

  chat
    .command('send <sessionId> <message...>')
    .description('Send a message to a session and optionally wait for BOT replies')
    .option(
      '--wait [seconds]',
      'Wait for BOT replies until the session returns to idle',
      (v: string | undefined) => (v === undefined ? 300 : Number(v)),
      undefined,
    )
    .action(
      (
        sessionId: string,
        messageWords: string[],
        options: Record<string, unknown>,
        command: Command,
      ) =>
        cliAction(async (_opts, cmd) => {
          const g = readGlobals(cmd);
          const client = await HubClient.connect(g);

          const content = messageWords.join(' ').trim();
          if (!content) {
            throw new CliError('Message content cannot be empty');
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

          const encodedSessionId = encodeURIComponent(sessionId);

          if (waitSeconds === 0) {
            const sent = await client.post<MessageRecord>(
              `/api/sessions/${encodedSessionId}/messages`,
              { content },
            );
            printResult(sent, g.json);
            return;
          }

          // 带 --wait 的完整时序：必须先订阅再发送，避免错过状态迁移
          const abortController = new AbortController();
          const streamReady = createDeferred<void>();
          let streamReadySettled = false;

          const roundFinished = createDeferred<void>();
          let roundFinishedSettled = false;

          let posted = false;
          const collected: MessageRecord[] = [];

          const eventsPromise = client
            .events(sessionId, {
              signal: abortController.signal,
              onEvent: (event: SessionSseEvent) => {
                if (!streamReadySettled) {
                  streamReadySettled = true;
                  streamReady.resolve();
                }

                if (!posted) return;

                if (event.type === 'message_created' && event.message.role !== 'user') {
                  collected.push(event.message);
                } else if (
                  event.type === 'session_status' &&
                  (event.status === 'idle' || event.status === 'failed')
                ) {
                  if (!roundFinishedSettled) {
                    roundFinishedSettled = true;
                    roundFinished.resolve();
                  }
                }
              },
            })
            .catch((err: unknown) => {
              if (!streamReadySettled) {
                streamReadySettled = true;
                streamReady.reject(err);
              }
              // events() 本身若因 abort 而抛错，必须吞掉（主动断流是正常路径）
            });

          // 1. 等待事件流激活（收到首个事件），10 秒无事件则超时
          let streamTimer: ReturnType<typeof setTimeout> | undefined;
          const streamTimeout = new Promise<never>((_, reject) => {
            streamTimer = setTimeout(() => {
              reject(new CliError('Timed out opening the session event stream'));
            }, 10_000);
          });

          try {
            await Promise.race([streamReady.promise, streamTimeout]);
          } catch (err) {
            abortController.abort();
            throw err;
          } finally {
            if (streamTimer) clearTimeout(streamTimer);
          }

          // 2. 订阅激活后发送消息
          try {
            await client.post<MessageRecord>(`/api/sessions/${encodedSessionId}/messages`, {
              content,
            });
            posted = true;

            // 4. 等待轮次结束或超时
            let waitTimer: ReturnType<typeof setTimeout> | undefined;
            const waitTimeout = new Promise<never>((_, reject) => {
              waitTimer = setTimeout(() => {
                reject(
                  new CliError(`Timed out after ${waitSeconds}s waiting for the session to finish`),
                );
              }, waitSeconds * 1000);
            });

            try {
              await Promise.race([roundFinished.promise, waitTimeout]);
            } finally {
              if (waitTimer) clearTimeout(waitTimer);
            }
          } finally {
            // 5. 结束后主动断开 SSE
            abortController.abort();
            void eventsPromise.catch(() => {});
          }

          // 5. 输出收集到的 BOT 消息
          if (g.json) {
            console.log(JSON.stringify(collected, null, 2));
          } else {
            if (collected.length === 0) {
              console.log('(no reply)');
            } else {
              const formatted = collected
                .map((m) => `${m.senderBotId ?? m.role}:\n${m.content}`)
                .join('\n\n');
              console.log(formatted);
            }
          }
        })(options, command),
    );

  chat
    .command('watch <sessionId>')
    .description('Watch live session events as JSON lines (for AI agents and scripts)')
    .option(
      '--duration <seconds>',
      'Stop after N seconds (0 = wait indefinitely until disconnected)',
      (v: string) => Number(v),
      0,
    )
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);

        const durationOption = Number(options.duration);
        const timeoutSeconds =
          Number.isFinite(durationOption) && durationOption > 0 ? durationOption : 0;
        const signal = timeoutSeconds > 0 ? AbortSignal.timeout(timeoutSeconds * 1000) : undefined;

        try {
          await client.events(sessionId, {
            signal,
            onEvent: (event) => console.log(JSON.stringify(event)),
          });
        } catch (err: unknown) {
          if (signal?.aborted) {
            return;
          }
          if (
            err instanceof Error &&
            (err.name === 'AbortError' || err.name === 'TimeoutError')
          ) {
            return;
          }
          if (
            err instanceof CliError &&
            (err.message.includes('aborted') ||
              err.message.includes('timeout') ||
              err.message.includes('Timeout'))
          ) {
            return;
          }
          throw err;
        }
      })(options, command),
    );
}
