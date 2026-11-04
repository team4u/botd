import type { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { readInput } from '../input.js';
import { printContent, printResult } from '../render.js';

/**
 * 解析目标路由：单参数视为全局 extId，双参数视为节点维度 (nodeId, extId)。
 */
const extensionRoute = (extIdOrNodeId: string, extId: string | undefined): string =>
  extId === undefined
    ? `/api/extensions/${encodeURIComponent(extIdOrNodeId)}`
    : `/api/nodes/${encodeURIComponent(extIdOrNodeId)}/extensions/${encodeURIComponent(extId)}`;

export function registerExtensionsCommands(program: Command): void {
  const extensions = program
    .command('extensions')
    .description('Manage Hub-hosted durable extensions');

  extensions
    .command('list')
    .description('List all extensions hosted on the Hub')
    .action((options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.get<Array<{ id: string; updatedAt: string }>>('/api/extensions');
        printResult(result, g.json);
      })(options, command),
    );

  extensions
    .command('get <extIdOrNodeId> [extId]')
    .description('Get extension content (global by id, or node-scoped with nodeId prefix)')
    .action((extIdOrNodeId: string, extId: string | undefined, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.get<{ content: string }>(extensionRoute(extIdOrNodeId, extId));
        printContent(result, g.json);
      })(options, command),
    );

  extensions
    .command('put <extIdOrNodeId> [extId]')
    .description('Upload or update an extension (reads from stdin by default)')
    .option('--file <path>', 'path to extension file, or - for stdin (default: stdin)')
    .action((extIdOrNodeId: string, extId: string | undefined, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const file = typeof options.file === 'string' ? options.file : undefined;
        const content = await readInput(file);
        const result = await client.put<{ ok: boolean }>(extensionRoute(extIdOrNodeId, extId), { content });
        printResult(result, g.json);
      })(options, command),
    );

  extensions
    .command('delete <extIdOrNodeId> [extId]')
    .description('Delete an extension (global by id, or node-scoped with nodeId prefix)')
    .action((extIdOrNodeId: string, extId: string | undefined, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.delete<{ ok: boolean }>(extensionRoute(extIdOrNodeId, extId));
        printResult(result, g.json);
      })(options, command),
    );
}
