import type { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

/**
 * 人机协同 Ask：列出会话的待确认请求并代用户答复。
 */
export function registerAsksCommands(program: Command): void {
  const asks = program.command('asks').description('Pending human-interaction asks of a session');

  asks
    .command('list <sessionId>')
    .description('List pending asks of a session')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const list = await client.get<unknown[]>(
          `/api/sessions/${encodeURIComponent(sessionId)}/asks`,
        );
        printResult(list, g.json);
      })(options, command),
    );

  asks
    .command('respond <sessionId> <askId> <answer...>')
    .description('Answer a pending ask (e.g. botd asks respond <sid> ask_1 批准)')
    .action((sessionId: string, askId: string, answer: string[], options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const text = answer.join(' ').trim();
        if (!text) throw new Error('Provide the answer as trailing arguments');
        const client = await HubClient.connect(g);
        const result = await client.post<{ ok: true; ask: unknown }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/asks/${encodeURIComponent(askId)}/respond`,
          { answer: text },
        );
        printResult(result, g.json);
      })(options, command),
    );
}
