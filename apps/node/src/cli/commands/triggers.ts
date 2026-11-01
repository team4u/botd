import { Command, Option } from 'commander';
import { isValidCronExpr, parseDelayDuration, type CreateTriggerInput, type TriggerRecord } from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

export function registerTriggersCommands(program: Command): void {
  const triggers = program
    .command('triggers')
    .description('Session trigger management');

  triggers
    .command('list <sessionId>')
    .description('List triggers of a session')
    .action(
      (sessionId: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async (_opts, cmd) => {
          const g = readGlobals(cmd);
          const client = await HubClient.connect(g);
          const list = await client.get<TriggerRecord[]>(
            `/api/sessions/${encodeURIComponent(sessionId)}/triggers`,
          );
          printResult(list, g.json);
        })(options, command),
    );

  triggers
    .command('create <sessionId>')
    .description(
      'Create a trigger for a session, e.g. --kind cron --cron "*/15 * * * *" or --kind cron --cron "30 9 * * *"',
    )
    .requiredOption('--name <name>', 'Trigger name')
    .requiredOption('--bot <botId>', 'Bot ID to run when the trigger fires')
    .requiredOption('--prompt <prompt>', 'Prompt delivered on trigger')
    .addOption(
      new Option('--kind <kind>', 'Trigger kind')
        .choices(['webhook', 'cron', 'once'])
        .default('webhook'),
    )
    .option(
      '--cron <expr>',
      'Standard 5-field cron expression, e.g. */30 * * * * (server local time)',
    )
    .option('--delay <duration>', 'Delay duration for --kind once (e.g. 30s, 15m, 2h)')
    .option('--at <isoOrDuration>', 'ISO timestamp or duration for --kind once')
    .action(
      (sessionId: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async (_opts, cmd) => {
          const g = readGlobals(cmd);
          const client = await HubClient.connect(g);

          const kind = String(options.kind) as CreateTriggerInput['kind'];
          const body: CreateTriggerInput = {
            name: String(options.name).trim(),
            botId: String(options.bot).trim(),
            kind,
            prompt: String(options.prompt).trim(),
          };

          const cronExpr =
            typeof options.cron === 'string' ? options.cron.trim() : '';
          if (kind === 'cron') {
            if (!cronExpr) {
              throw new Error('--cron is required for --kind cron');
            }
            if (!isValidCronExpr(cronExpr)) {
              throw new Error(
                '--cron must be a valid 5-field cron expression (minute hour dom month dow)',
              );
            }
            body.cronExpr = cronExpr;
          } else if (cronExpr) {
            throw new Error('--cron is only valid for --kind cron');
          }

          const delay = typeof options.delay === 'string' ? options.delay.trim() : '';
          const at = typeof options.at === 'string' ? options.at.trim() : '';
          if (kind === 'once') {
            if (delay) {
              const delaySeconds = parseDelayDuration(delay);
              if (delaySeconds === null) {
                throw new Error('--delay must be a valid duration (e.g. 30s, 15m, 2h)');
              }
              body.delaySeconds = delaySeconds;
            } else if (at) {
              body.runAt = at;
            } else {
              throw new Error('--delay or --at is required for --kind once');
            }
          } else if (delay || at) {
            throw new Error('--delay/--at is only valid for --kind once');
          }

          const trigger = await client.post<TriggerRecord>(
            `/api/sessions/${encodeURIComponent(sessionId)}/triggers`,
            body,
          );
          printResult(trigger, g.json);
        })(options, command),
    );

  triggers
    .command('delete <triggerId>')
    .description('Delete a trigger')
    .action(
      (triggerId: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async (_opts, cmd) => {
          const g = readGlobals(cmd);
          const client = await HubClient.connect(g);
          const res = await client.delete<{ ok: boolean }>(
            `/api/triggers/${encodeURIComponent(triggerId)}`,
          );
          printResult(res, g.json);
        })(options, command),
    );
}
