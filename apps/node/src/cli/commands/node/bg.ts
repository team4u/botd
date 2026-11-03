import { Command } from 'commander';
import { type BgJobRecord } from '@botd/protocol';
import { cliAction, readGlobals } from '../../context.js';
import { CliError } from '../../errors.js';
import { getDaemonSocketPath } from '../../../storage.js';
import { requestOverSocket, postJsonOverSocket } from './shared.js';

// ---------------------------------------------------------------------------
// Background jobs: bg run / bg list / bg logs / bg kill
// ---------------------------------------------------------------------------

export function registerBgCommands(program: Command): void {
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
                noTurnOnComplete: options.turn === false,
              },
              15_000,
              dataDir,
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
            dataDir,
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
              dataDir,
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
              dataDir,
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
}
