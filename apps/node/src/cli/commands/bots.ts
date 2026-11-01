import { Command, Option } from 'commander';
import type { BotConfig, SaveBotInput } from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { HubClient } from '../hub-client.js';
import { readInput } from '../input.js';
import { printContent, printResult } from '../render.js';

function parseModel(model: string): { modelProvider: string; modelId: string } {
  const idx = model.indexOf('/');
  if (idx <= 0 || idx === model.length - 1) {
    throw new CliError('Invalid --model, expected <provider>/<modelId> (e.g. anthropic/claude-sonnet-4-5)');
  }
  return {
    modelProvider: model.slice(0, idx),
    modelId: model.slice(idx + 1),
  };
}

export function registerBotsCommands(program: Command): void {
  const bots = new Command('bots').description('Manage BOTs (create, update, delete, system prompt, memory)');

  bots
    .command('create <botId>')
    .description('Create a new BOT configuration')
    .requiredOption('--node <nodeId>', 'Node ID that owns this BOT')
    .requiredOption('--name <name>', 'BOT display name')
    .requiredOption('--model <provider/modelId>', 'Model in <provider>/<modelId> format')
    .option('--desc <description>', 'BOT description')
    .addOption(
      new Option('--thinking <level>', 'Thinking budget level')
        .choices(['low', 'medium', 'high'])
        .default('medium'),
    )
    .option('--skill <ids...>', 'Skill ID(s) to enable')
    .option('--extension <ids...>', 'Extension ID(s) to enable')
    .option('--system-file <path>', 'Path to SYSTEM.md file or - for stdin')
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);

        const modelStr = options.model as string;
        const { modelProvider, modelId } = parseModel(modelStr);

        const systemFile = options.systemFile as string | undefined;
        const systemMd = systemFile ? await readInput(systemFile) : '';

        const body: SaveBotInput = {
          id: botId,
          nodeId: options.node as string,
          name: options.name as string,
          description: (options.desc as string | undefined) ?? '',
          modelProvider,
          modelId,
          thinkingLevel: options.thinking as 'low' | 'medium' | 'high',
          enabledSkills: (options.skill as string[] | undefined) ?? [],
          enabledExtensions: (options.extension as string[] | undefined) ?? [],
          systemMd,
        };

        const result = await client.post<BotConfig>('/api/bots', body);
        printResult(result, g.json);
      })(options, command),
    );

  bots
    .command('update <botId>')
    .description('Update an existing BOT configuration')
    .option('--name <name>', 'BOT display name')
    .option('--desc <description>', 'BOT description')
    .option('--model <provider/modelId>', 'Model in <provider>/<modelId> format')
    .addOption(
      new Option('--thinking <level>', 'Thinking budget level')
        .choices(['low', 'medium', 'high']),
    )
    .option('--skill <ids...>', 'Skill ID(s) to enable')
    .option('--extension <ids...>', 'Extension ID(s) to enable')
    .option('--system-file <path>', 'Path to SYSTEM.md file or - for stdin')
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);

        const body: Partial<BotConfig> & { systemMd?: string } = {};

        if (options.name !== undefined) {
          body.name = options.name as string;
        }
        if (options.desc !== undefined) {
          body.description = options.desc as string;
        }
        if (options.model !== undefined) {
          const { modelProvider, modelId } = parseModel(options.model as string);
          body.modelProvider = modelProvider;
          body.modelId = modelId;
        }
        if (options.thinking !== undefined) {
          body.thinkingLevel = options.thinking as 'low' | 'medium' | 'high';
        }
        if (options.skill !== undefined) {
          body.enabledSkills = options.skill as string[];
        }
        if (options.extension !== undefined) {
          body.enabledExtensions = options.extension as string[];
        }
        if (options.systemFile !== undefined) {
          body.systemMd = await readInput(options.systemFile as string);
        }

        const result = await client.put<BotConfig>(`/api/bots/${encodeURIComponent(botId)}`, body);
        printResult(result, g.json);
      })(options, command),
    );

  bots
    .command('delete <botId>')
    .description('Delete a BOT configuration')
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const result = await client.delete<{ ok: true }>(`/api/bots/${encodeURIComponent(botId)}`);
        printResult(result, g.json);
      })(options, command),
    );

  const system = new Command('system').description("Read or write a BOT's SYSTEM.md");

  system
    .command('get <botId>')
    .description("Read a BOT's SYSTEM.md")
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const result = await client.get<{ content: string }>(`/api/bots/${encodeURIComponent(botId)}/system`);
        printContent(result, g.json);
      })(options, command),
    );

  system
    .command('put <botId>')
    .description("Write a BOT's SYSTEM.md")
    .option('--file <path>', 'Path to file or - for stdin')
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const content = await readInput(options.file as string | undefined);
        const result = await client.put<{ ok: true }>(`/api/bots/${encodeURIComponent(botId)}/system`, { content });
        printResult(result, g.json);
      })(options, command),
    );

  bots.addCommand(system);

  const memory = new Command('memory').description("Read or write a BOT's MEMORY.md");

  memory
    .command('get <botId>')
    .description("Read a BOT's MEMORY.md")
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const result = await client.get<{ content: string }>(`/api/bots/${encodeURIComponent(botId)}/memory`);
        printContent(result, g.json);
      })(options, command),
    );

  memory
    .command('put <botId>')
    .description("Write a BOT's MEMORY.md")
    .option('--file <path>', 'Path to file or - for stdin')
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const content = await readInput(options.file as string | undefined);
        const result = await client.put<{ ok: true }>(`/api/bots/${encodeURIComponent(botId)}/memory`, { content });
        printResult(result, g.json);
      })(options, command),
    );

  bots.addCommand(memory);

  program.addCommand(bots);
}
