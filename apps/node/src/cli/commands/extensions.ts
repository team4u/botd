import type { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { readInput } from '../input.js';
import { printContent, printResult } from '../render.js';

export function registerExtensionsCommands(program: Command): void {
  const extensions = program
    .command('extensions')
    .description('Manage extensions on a node (requires the node to be online)');

  extensions
    .command('get <nodeId> <extId>')
    .description('Get extension content from a node')
    .action((nodeId: string, extId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.get<{ content: string }>(
          `/api/nodes/${encodeURIComponent(nodeId)}/extensions/${encodeURIComponent(extId)}`,
        );
        printContent(result, g.json);
      })(options, command),
    );

  extensions
    .command('put <nodeId> <extId>')
    .description('Upload or update an extension on a node (reads from stdin by default)')
    .option('--file <path>', 'path to extension file, or - for stdin (default: stdin)')
    .action((nodeId: string, extId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const file = typeof options.file === 'string' ? options.file : undefined;
        const content = await readInput(file);
        const result = await client.put<{ ok: boolean }>(
          `/api/nodes/${encodeURIComponent(nodeId)}/extensions/${encodeURIComponent(extId)}`,
          { content },
        );
        printResult(result, g.json);
      })(options, command),
    );

  extensions
    .command('delete <nodeId> <extId>')
    .description('Delete an extension from a node')
    .action((nodeId: string, extId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.delete<{ ok: boolean }>(
          `/api/nodes/${encodeURIComponent(nodeId)}/extensions/${encodeURIComponent(extId)}`,
        );
        printResult(result, g.json);
      })(options, command),
    );
}
