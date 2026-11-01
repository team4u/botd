import type { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { readInput } from '../input.js';
import { printContent, printResult } from '../render.js';

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command('skills')
    .description('Manage skills on a node (requires the node to be online)');

  skills
    .command('get <nodeId> <skillId>')
    .description('Get skill content from a node')
    .action((nodeId: string, skillId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.get<{ content: string }>(
          `/api/nodes/${encodeURIComponent(nodeId)}/skills/${encodeURIComponent(skillId)}`,
        );
        printContent(result, g.json);
      })(options, command),
    );

  skills
    .command('put <nodeId> <skillId>')
    .description('Upload or update a skill on a node (reads from stdin by default)')
    .option('--file <path>', 'path to skill file, or - for stdin (default: stdin)')
    .action((nodeId: string, skillId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const file = typeof options.file === 'string' ? options.file : undefined;
        const content = await readInput(file);
        const result = await client.put<{ ok: boolean }>(
          `/api/nodes/${encodeURIComponent(nodeId)}/skills/${encodeURIComponent(skillId)}`,
          { content },
        );
        printResult(result, g.json);
      })(options, command),
    );

  skills
    .command('delete <nodeId> <skillId>')
    .description('Delete a skill from a node')
    .action((nodeId: string, skillId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.delete<{ ok: boolean }>(
          `/api/nodes/${encodeURIComponent(nodeId)}/skills/${encodeURIComponent(skillId)}`,
        );
        printResult(result, g.json);
      })(options, command),
    );
}
