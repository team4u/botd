import { Command } from 'commander';
import { parseDelayDuration } from '@botd/protocol';
import { cliAction, readGlobals } from '../../context.js';
import { CliError } from '../../errors.js';
import { writeNodeIdentity, getDaemonSocketPath } from '../../../storage.js';
import { sendWakeRequest } from './shared.js';

// ---------------------------------------------------------------------------
// Hub pairing & wake: join / wake
// ---------------------------------------------------------------------------

export function registerJoinCommands(program: Command): void {
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
        const noTurn = options.turn === false;

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
        let result;
        try {
          result = await sendWakeRequest(socketPath, {
            sessionId,
            botId,
            message,
            ...(replyToBotId ? { replyToBotId } : {}),
            ...(noTurn ? { noTurn: true } : {}),
            ...(delaySeconds !== undefined ? { delaySeconds } : {}),
          }, dataDir);
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
}
