import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Command, Option } from 'commander';
import { parseDelayDuration, type BgJobRecord } from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { writeNodeIdentity, getDaemonSocketPath } from '../../storage.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { installResourceToNode } from '../../installer.js';
import { getTsxLoaderUrl, resolveCliEntry } from '../../runtime.js';

// ---------------------------------------------------------------------------
// Daemon control-plane helpers (Unix socket / Windows named pipe)
// ---------------------------------------------------------------------------

interface SocketResponse {
  status: number;
  body: string;
}

/** GET/POST a bodyless request over the local daemon socket (raw response). */
export function requestOverSocket(
  socketPath: string,
  method: 'GET' | 'POST',
  url: string,
  timeoutMs: number,
): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: url, method, headers: { 'content-length': '0' } },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Daemon request timed out')));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/** POST a JSON payload to the local daemon socket and parse the JSON response.
 *  Shared by the wake/ask commands here and the artifact commands. */
export async function postJsonOverSocket<T>(
  socketPath: string,
  url: string,
  payload: unknown,
  timeoutMs: number,
): Promise<T> {
  const data = JSON.stringify(payload);
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: url,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        res.setEncoding('utf8');
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (!responseBody) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(responseBody) as T);
            } catch {
              reject(new Error(`Daemon returned invalid JSON: ${responseBody.slice(0, 200)}`));
            }
            return;
          }
          let detail = responseBody;
          try {
            const parsed = JSON.parse(responseBody) as { error?: string };
            if (parsed && typeof parsed.error === 'string') detail = parsed.error;
          } catch {
            // keep raw text
          }
          reject(new Error(`Daemon returned status ${res.statusCode}: ${detail}`));
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Daemon request timed out')));
    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

interface WakeResponse {
  ok?: boolean;
  scheduledTriggerId?: string;
}

async function sendWakeRequest(
  socketPath: string,
  payload: {
    sessionId: string;
    botId: string;
    message: string;
    replyToBotId?: string;
    noTurn?: boolean;
    delaySeconds?: number;
  },
): Promise<WakeResponse | undefined> {
  return await postJsonOverSocket<WakeResponse>(socketPath, '/wake', payload, 15_000);
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

interface DaemonStatus {
  ok: boolean;
  nodeId: string;
  name: string;
  hubUrl: string;
  dataDir: string;
  socketPath: string;
  pid: number;
  uptimeSeconds: number;
  hubConnected: boolean;
}

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getDaemonStatus(socketPath: string): Promise<DaemonStatus | null> {
  try {
    const { status, body } = await requestOverSocket(socketPath, 'GET', '/status', 2_000);
    if (status !== 200) return null;
    return JSON.parse(body) as DaemonStatus;
  } catch {
    return null;
  }
}

function readPidFile(pidFile: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Graceful stop: socket /shutdown first, SIGTERM via pid file as fallback. */
async function stopDaemon(dataDir: string): Promise<'stopped' | 'not-running'> {
  const socketPath = getDaemonSocketPath(dataDir);
  const pidFile = path.join(dataDir, 'daemon.pid');
  const status = await getDaemonStatus(socketPath);

  if (status) {
    try {
      await requestOverSocket(socketPath, 'POST', '/shutdown', 5_000);
    } catch (err) {
      throw new CliError(`Failed to stop daemon: ${(err as Error).message}`);
    }
    for (let i = 0; i < 50; i += 1) {
      await waitMs(200);
      if (!isPidAlive(status.pid) || !fs.existsSync(socketPath)) break;
    }
    fs.rmSync(pidFile, { force: true });
    return 'stopped';
  }

  // Daemon socket is dead: fall back to the pid file (e.g. killed mid-shutdown).
  const pid = readPidFile(pidFile);
  if (pid && isPidAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50; i += 1) {
      await waitMs(200);
      if (!isPidAlive(pid)) break;
    }
    fs.rmSync(pidFile, { force: true });
    return 'stopped';
  }

  fs.rmSync(pidFile, { force: true });
  return 'not-running';
}

/** Spawn `botd start` again as a detached background process logging to a file. */
function spawnDetachedDaemon(logFile: string): number {
  const out = fs.openSync(logFile, 'a');
  try {
    // Under a tsx checkout process.argv loses the loader flag, so rebuild the
    // invocation from the resolved CLI entry instead of replaying argv verbatim.
    const { cliPath, isTypeScript } = resolveCliEntry();
    const args = process.argv.slice(2).filter((arg) => arg !== '--detach' && arg !== '-d');
    const loaderArgs = isTypeScript && getTsxLoaderUrl() ? ['--import', getTsxLoaderUrl()!] : [];
    const child = spawn(process.execPath, [...loaderArgs, cliPath, ...args], {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: { ...process.env, BOTD_DAEMON_DETACHED: '1', BOTD_DAEMON_LOG: logFile },
    });
    child.unref();
    if (typeof child.pid !== 'number') {
      throw new CliError('Failed to spawn the background daemon');
    }
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerNodeCommands(program: Command): void {
  const detachOption = new Option('-d, --detach', 'run in the background, logging to --log-file');
  const logFileOption = new Option('--log-file <path>', 'log file for --detach (default: <dataDir>/daemon.log)');

  const runStart = async (options: Record<string, unknown>, command: Command): Promise<void> => {
    const { dataDir, json } = readGlobals(command);
    const detach = options.detach === true && process.env.BOTD_DAEMON_DETACHED !== '1';

    if (detach) {
      const logFile =
        typeof options.logFile === 'string' && options.logFile
          ? path.resolve(options.logFile)
          : path.join(dataDir, 'daemon.log');
      const pid = spawnDetachedDaemon(logFile);
      if (json) {
        console.log(JSON.stringify({ ok: true, pid, logFile }, null, 2));
      } else {
        console.log(`botd daemon started in background. PID: ${pid}, Log: ${logFile}`);
        console.log('Check with: botd status');
      }
      return;
    }

    let daemon: DaemonHandle;
    try {
      daemon = await startDaemon(dataDir);
    } catch (err: unknown) {
      throw new CliError(`Daemon start error: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`botd daemon started. Node ID: ${daemon.nodeId}, Socket: ${daemon.socketPath}`);

    const shutdown = async () => {
      console.log('Shutting down botd daemon...');
      try {
        await daemon.close();
      } catch {
        // ignore shutdown errors
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await new Promise<void>(() => {});
  };

  program
    .command('start')
    .description('Start the Node Agent daemon')
    .addOption(detachOption)
    .addOption(logFileOption)
    .action(cliAction(runStart));

  program
    .command('restart')
    .description('Restart the Node Agent daemon (stop if running, then start)')
    .addOption(detachOption)
    .addOption(logFileOption)
    .action(
      cliAction(async (options, command) => {
        const { dataDir, json } = readGlobals(command);
        const result = await stopDaemon(dataDir);
        if (json) console.error(JSON.stringify({ stopped: result === 'stopped' }));
        else if (result === 'stopped') console.log('Stopped running daemon.');
        await runStart(options, command);
      }),
    );

  program
    .command('reload')
    .description('Re-register this node\'s skills/extensions/bots with the Hub (picks up files written outside the Web UI)')
    .action(
      cliAction(async (_options, command) => {
        const { dataDir, json } = readGlobals(command);
        const socketPath = getDaemonSocketPath(dataDir);
        try {
          await requestOverSocket(socketPath, 'POST', '/reload', 15_000);
        } catch (err: unknown) {
          throw new CliError('botd daemon is not running');
        }
        if (json) console.log(JSON.stringify({ ok: true }));
        else console.log('Resources re-registered with Hub.');
      }),
    );

  program
    .command('stop')
    .description('Stop the Node Agent daemon gracefully')
    .action(
      cliAction(async (_options, command) => {
        const { dataDir, json } = readGlobals(command);
        const result = await stopDaemon(dataDir);
        if (json) console.log(JSON.stringify({ ok: true, wasRunning: result === 'stopped' }, null, 2));
        else console.log(result === 'stopped' ? 'botd daemon stopped.' : 'botd daemon is not running.');
      }),
    );

  program
    .command('status')
    .description('Show whether the Node Agent daemon is running')
    .action(
      cliAction(async (_options, command) => {
        const { dataDir, json } = readGlobals(command);
        const status = await getDaemonStatus(getDaemonSocketPath(dataDir));
        if (status) {
          if (json) {
            console.log(JSON.stringify({ running: true, ...status }, null, 2));
          } else {
            console.log(`daemon: running (pid ${status.pid}, up ${status.uptimeSeconds}s)`);
            console.log(`node:   ${status.name} (${status.nodeId})`);
            console.log(`hub:    ${status.hubUrl} (${status.hubConnected ? 'connected' : 'disconnected'})`);
            console.log(`socket: ${status.socketPath}`);
          }
          return;
        }
        if (json) console.log(JSON.stringify({ running: false }, null, 2));
        else console.log('daemon: not running');
        process.exitCode = 1;
      }),
    );

  program
    .command('join <hubUrl>')
    .description('Pair this node with a Cloud Hub')
    .requiredOption('--code <code>', 'Pairing code from Hub')
    .requiredOption('--name <name>', 'Node name')
    .action(
      (hubUrl: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const code = options.code as string | undefined;
          const name = options.name as string | undefined;

          if (!code || !name) {
            throw new CliError('Missing required arguments: --code or --name');
          }

          const cleanHubUrl = hubUrl.replace(/\/+$/, '');

          let response: Response;
          try {
            response = await fetch(`${cleanHubUrl}/api/nodes/pairing/exchange`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code, name, platform: process.platform }),
              signal: AbortSignal.timeout(15_000),
            });
          } catch (err: unknown) {
            throw new CliError(`Join error: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new CliError(`Pairing failed (${response.status}): ${text}`);
          }

          let result: { nodeId: string; token: string };
          try {
            result = (await response.json()) as { nodeId: string; token: string };
          } catch (err: unknown) {
            throw new CliError(`Join error: ${err instanceof Error ? err.message : String(err)}`);
          }

          await writeNodeIdentity(dataDir, {
            nodeId: result.nodeId,
            name,
            hubUrl: cleanHubUrl,
            token: result.token,
          });

          if (json) {
            console.log(JSON.stringify({ ok: true, nodeId: result.nodeId, hubUrl: cleanHubUrl }, null, 2));
          } else {
            console.log(`Node successfully paired! Node ID: ${result.nodeId}`);
          }
        })(options, command),
    );

  program
    .command('wake')
    .description('Send wake trigger to active session')
    .option('--session <id>', 'Session ID (or env BOTD_SESSION_ID)')
    .option('--bot <id>', 'Bot ID (or env BOTD_BOT_ID)')
    .option('--message <msg>', 'Wake message to deliver')
    .option('--reply-to <botId>', 'Bot ID to hand off / mention after wakeup')
    .option('--no-turn', 'Deliver message to session without triggering an LLM turn')
    .option('--delay <duration>', 'Schedule delayed wake-up (e.g. 30s, 15m, 2h, 1d)')
    .action(
      cliAction(async (options, command) => {
        const { dataDir, json } = readGlobals(command);

        const sessionId = (options.session as string | undefined) || process.env.BOTD_SESSION_ID;
        const botId = (options.bot as string | undefined) || process.env.BOTD_BOT_ID;
        const message = options.message as string | undefined;
        const replyToBotId = options.replyTo as string | undefined;
        const noTurn = options.noTurn === true;

        let delaySeconds: number | undefined;
        if (typeof options.delay === 'string' && options.delay) {
          const parsedDelay = parseDelayDuration(options.delay);
          if (parsedDelay === null) {
            throw new CliError('Invalid --delay format. Examples: 30s, 15m, 2h, 1d');
          }
          delaySeconds = parsedDelay;
        }

        if (!sessionId || !botId || !message) {
          throw new CliError('Missing --session, --bot or --message (or env BOTD_SESSION_ID / BOTD_BOT_ID)');
        }

        const socketPath = getDaemonSocketPath(dataDir);
        let result: WakeResponse | undefined;
        try {
          result = await sendWakeRequest(socketPath, {
            sessionId,
            botId,
            message,
            ...(replyToBotId ? { replyToBotId } : {}),
            ...(noTurn ? { noTurn: true } : {}),
            ...(delaySeconds !== undefined ? { delaySeconds } : {}),
          });
        } catch (err: unknown) {
          throw new CliError(`Wake failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (json) {
          console.log(JSON.stringify({
            ok: true,
            sessionId,
            botId,
            ...(noTurn ? { noTurn: true } : {}),
            ...(delaySeconds !== undefined ? { delaySeconds } : {}),
            ...(result?.scheduledTriggerId ? { scheduledTriggerId: result.scheduledTriggerId } : {}),
          }, null, 2));
        } else {
          const scheduledNote = result?.scheduledTriggerId
            ? ` (scheduled, triggerId: ${result.scheduledTriggerId})`
            : '';
          console.log(`Wake message delivered to session ${sessionId}${scheduledNote}`);
        }
      }),
    );

  const bg = program
    .command('bg')
    .description('Manage background jobs with automatic wake-up callbacks');

  bg.command('run <command...>')
    .description('Run a shell command as a managed background job in the bot workspace (auto wake-up on exit)')
    .option('--session <id>', 'Session ID (or env BOTD_SESSION_ID)')
    .option('--bot <id>', 'Bot ID (or env BOTD_BOT_ID)')
    .option('--reply-to <botId>', 'Bot ID to hand off / mention when the job completes')
    .option('--no-turn', 'On completion, deliver the log summary without triggering an LLM turn')
    .action(
      (commandParts: string[], options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const sessionId = (options.session as string | undefined) || process.env.BOTD_SESSION_ID;
          const botId = (options.bot as string | undefined) || process.env.BOTD_BOT_ID;
          const replyToBotId = options.replyTo as string | undefined;
          const commandText = commandParts.join(' ');

          if (!sessionId || !botId || !commandText.trim()) {
            throw new CliError('Missing --session, --bot or <command> (or env BOTD_SESSION_ID / BOTD_BOT_ID)');
          }

          const socketPath = getDaemonSocketPath(dataDir);
          let job: BgJobRecord | undefined;
          try {
            const result = await postJsonOverSocket<{ ok: true; job: BgJobRecord }>(
              socketPath,
              '/bg/run',
              {
                sessionId,
                botId,
                command: commandText,
                ...(replyToBotId ? { replyToBotId } : {}),
                noTurnOnComplete: options.noTurn === true,
              },
              15_000,
            );
            job = result?.job;
          } catch (err: unknown) {
            throw new CliError(`Background job failed to start: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, job }, null, 2));
          } else {
            console.log(`Started background job ${job?.id} (pid ${job?.pid ?? 'n/a'})`);
            console.log(`  command: ${job?.command}`);
            console.log(`  log:     ${job?.logPath}`);
          }
        })(options, command),
    );

  bg.command('list')
    .description('List background jobs on this node')
    .option('--session <id>', 'Filter by Session ID')
    .option('--bot <id>', 'Filter by Bot ID')
    .option('--json', 'Output as JSON')
    .action(
      cliAction(async (options: Record<string, unknown>, command: Command) => {
        const { dataDir, json } = readGlobals(command);

        const query = new URLSearchParams();
        if (typeof options.session === 'string' && options.session) query.set('sessionId', options.session);
        if (typeof options.bot === 'string' && options.bot) query.set('botId', options.bot);

        const socketPath = getDaemonSocketPath(dataDir);
        let jobs: BgJobRecord[] = [];
        try {
          const { status, body } = await requestOverSocket(
            socketPath,
            'GET',
            `/bg/list${query.size ? `?${query.toString()}` : ''}`,
            10_000,
          );
          if (status !== 200) {
            const parsed = JSON.parse(body) as { error?: string };
            throw new CliError(parsed?.error || `Daemon returned status ${status}`);
          }
          jobs = (JSON.parse(body) as { jobs?: BgJobRecord[] }).jobs ?? [];
        } catch (err: unknown) {
          if (err instanceof CliError) throw err;
          throw new CliError(`Failed to list background jobs: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (json) {
          console.log(JSON.stringify({ ok: true, jobs }, null, 2));
          return;
        }
        if (jobs.length === 0) {
          console.log('No background jobs.');
          return;
        }
        for (const job of jobs) {
          const finished = job.finishedAt ? `, finished ${job.finishedAt}` : '';
          const exit = job.exitCode !== undefined && job.exitCode !== null ? `, exit ${job.exitCode}` : '';
          console.log(`${job.id}  [${job.status}]  ${job.command}  (started ${job.startedAt}${exit}${finished})`);
        }
      }),
    );

  bg.command('logs <jobId>')
    .description('Show the tail of a background job log')
    .option('--lines <n>', 'Number of trailing lines to show (default 100)', '100')
    .option('--json', 'Output as JSON')
    .action(
      (jobId: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const lines = Math.max(1, Number(options.lines) || 100);
          const query = new URLSearchParams({ jobId, lines: String(lines) });

          const socketPath = getDaemonSocketPath(dataDir);
          let logs = '';
          try {
            const { status, body } = await requestOverSocket(
              socketPath,
              'GET',
              `/bg/logs?${query.toString()}`,
              10_000,
            );
            if (status !== 200) {
              const parsed = JSON.parse(body) as { error?: string };
              throw new CliError(parsed?.error || `Daemon returned status ${status}`);
            }
            logs = (JSON.parse(body) as { logs?: string }).logs ?? '';
          } catch (err: unknown) {
            if (err instanceof CliError) throw err;
            throw new CliError(`Failed to read background job logs: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, jobId, logs }));
          } else {
            if (logs) console.log(logs);
          }
        })(options, command),
    );

  bg.command('kill <jobId>')
    .description('Terminate a running background job')
    .option('--json', 'Output as JSON')
    .action(
      (jobId: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const socketPath = getDaemonSocketPath(dataDir);
          let job: BgJobRecord | undefined;
          try {
            const result = await postJsonOverSocket<{ ok: true; job: BgJobRecord }>(
              socketPath,
              '/bg/kill',
              { jobId },
              10_000,
            );
            job = result?.job;
          } catch (err: unknown) {
            throw new CliError(`Failed to kill background job: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, job }, null, 2));
          } else {
            console.log(`Background job ${job?.id} is now ${job?.status ?? 'killed'}.`);
          }
        })(options, command),
    );

  program
    .command('ask <prompt>')
    .description('Ask the user an interactive question in the active session and wait for their response')
    .option('--options <items>', 'Comma-separated choices (e.g. "确认,取消")')
    .option('--timeout <seconds>', 'Timeout in seconds (default 300)', '300')
    .option('--session <id>', 'Session ID (or env BOTD_SESSION_ID)')
    .option('--bot <id>', 'Bot ID (or env BOTD_BOT_ID)')
    .action(
      (prompt: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json, timeoutMs } = readGlobals(command);

          const sessionId = (options.session as string | undefined) || process.env.BOTD_SESSION_ID;
          const botId = (options.bot as string | undefined) || process.env.BOTD_BOT_ID;
          const rawOptions = options.options as string | undefined;
          const timeoutSeconds = Number(options.timeout);

          if (!sessionId || !botId) {
            throw new CliError('Missing --session or --bot (or env BOTD_SESSION_ID / BOTD_BOT_ID)');
          }

          const effectiveTimeoutSeconds =
            Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 300;
          const timeoutMsForAsk = Math.max(timeoutMs, effectiveTimeoutSeconds * 1000);

          const socketPath = getDaemonSocketPath(dataDir);
          let answer: string;
          try {
            const result = await postJsonOverSocket<{ ok?: boolean; answer?: string }>(
              socketPath,
              '/ask',
              {
                sessionId,
                botId,
                prompt,
                options: rawOptions
                  ? rawOptions.split(',').map((item) => item.trim()).filter(Boolean)
                  : undefined,
                timeoutSeconds: effectiveTimeoutSeconds,
              },
              timeoutMsForAsk,
            );
            answer = typeof result?.answer === 'string' ? result.answer : '';
          } catch (err: unknown) {
            throw new CliError(`Ask failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, answer }));
          } else {
            // Print the raw answer so shell scripts can capture it:
            //   choice=$(botd ask "..." --options "yes,no")
            console.log(answer);
          }
        })(options, command),
    );

  program
    .command('install <source>')
    .description('Install a skill or extension on this node')
    .option('--id <customId>', 'Custom identifier for the resource')
    .addOption(
      new Option('--kind <kind>', 'Resource kind')
        .choices(['auto', 'skill', 'extension'])
        .default('auto')
    )
    .action(
      (source: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const customId = options.id as string | undefined;
          const kind = (options.kind as 'auto' | 'skill' | 'extension' | undefined) || 'auto';

          let result: { kind: 'skill' | 'extension'; id: string };
          try {
            result = await installResourceToNode(dataDir, { source, kind, customId });
          } catch (err: unknown) {
            throw new CliError(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          const socketPath = getDaemonSocketPath(dataDir);
          // Named pipes never exist on disk; probe liveness instead.
          const socketAlive = process.platform === 'win32'
            ? await getDaemonStatus(socketPath).then((s) => Boolean(s)).catch(() => false)
            : fs.existsSync(socketPath);
          if (socketAlive) {
            await requestOverSocket(socketPath, 'POST', '/reload', 10_000).catch(() => {});
          }

          if (json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Installed ${result.kind}: ${result.id}`);
          }
        })(options, command),
    );
}
