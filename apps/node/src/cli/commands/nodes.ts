import { Command, Option } from 'commander';
import type { NodeWithBots, PairingResult } from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

export function registerNodesCommands(program: Command): void {
  const nodes = program.command('nodes').description('Manage connected nodes and resources');

  nodes
    .command('list')
    .description('List connected nodes and their hosted bots')
    .action(
      cliAction(async (_options, command) => {
        const globals = readGlobals(command);
        const client = await HubClient.connect(globals);
        const result = await client.get<NodeWithBots[]>('/api/nodes');
        printResult(result, globals.json);
      })
    );

  nodes
    .command('pair')
    .description('Generate a pairing code to join a new node')
    .action(
      cliAction(async (_options, command) => {
        const globals = readGlobals(command);
        const client = await HubClient.connect(globals);
        const result = await client.post<PairingResult>('/api/nodes/pairing', {});
        if (globals.json) {
          printResult(result, true);
        } else {
          console.log(`Pairing code: ${result.code}`);
          console.log(`Expires: ${result.expiresAt}`);
          console.log(`On the target machine run: botd join <hubUrl> --code ${result.code} --name <name>`);
        }
      })
    );

  nodes
    .command('install <nodeId> <source>')
    .description('Install a skill or extension onto a node')
    .addOption(new Option('--kind <kind>', 'resource kind').choices(['auto', 'skill', 'extension']))
    .option('--id <customId>', 'custom identifier for the installed resource')
    .action((nodeId: string, source: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const targetNodeId = nodeId || (command.args[0] as string);
        const targetSource = source || (command.args[1] as string);
        const globals = readGlobals(command);
        const client = await HubClient.connect(globals);
        const kind = typeof options.kind === 'string' ? options.kind : undefined;
        const customId = typeof options.id === 'string' ? options.id : undefined;
        const body: Record<string, unknown> = {
          source: targetSource,
          ...(kind ? { kind } : {}),
          ...(customId ? { customId } : {}),
        };
        const result = await client.post(`/api/nodes/${encodeURIComponent(targetNodeId)}/install`, body);
        printResult(result, globals.json);
      })(options, command)
    );
}
