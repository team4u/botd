import type { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { readInput } from '../input.js';
import { printContent, printResult } from '../render.js';

/**
 * 解析目标路由：单参数视为全局 skillId，双参数视为节点维度 (nodeId, skillId)。
 */
const skillRoute = (skillIdOrNodeId: string, skillId: string | undefined): string =>
  skillId === undefined
    ? `/api/skills/${encodeURIComponent(skillIdOrNodeId)}`
    : `/api/nodes/${encodeURIComponent(skillIdOrNodeId)}/skills/${encodeURIComponent(skillId)}`;

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command('skills')
    .description('Manage Hub-hosted skills');

  skills
    .command('list')
    .description('List all skills hosted on the Hub')
    .action(cliAction(async (_options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);
      const result = await client.get<Array<{ id: string; updatedAt: string }>>('/api/skills');
      printResult(result, g.json);
    }));

  skills
    .command('get <skillIdOrNodeId> [skillId]')
    .description('Get skill content (global by id, or node-scoped with nodeId prefix)')
    .action(cliAction(async (skillIdOrNodeId: string, skillId: string | undefined, _options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);
      const result = await client.get<{ content: string }>(skillRoute(skillIdOrNodeId, skillId));
      printContent(result, g.json);
    }));

  skills
    .command('put <skillIdOrNodeId> [skillId]')
    .description('Upload or update a skill (reads from stdin by default)')
    .option('--file <path>', 'path to skill file, or - for stdin (default: stdin)')
    .action(cliAction(async (skillIdOrNodeId: string, skillId: string | undefined, options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);
      const file = typeof options.file === 'string' ? options.file : undefined;
      const content = await readInput(file);
      const result = await client.put<{ ok: boolean }>(skillRoute(skillIdOrNodeId, skillId), { content });
      printResult(result, g.json);
    }));

  skills
    .command('delete <skillIdOrNodeId> [skillId]')
    .description('Delete a skill (global by id, or node-scoped with nodeId prefix)')
    .action(cliAction(async (skillIdOrNodeId: string, skillId: string | undefined, _options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);
      const result = await client.delete<{ ok: boolean }>(skillRoute(skillIdOrNodeId, skillId));
      printResult(result, g.json);
    }));
}
