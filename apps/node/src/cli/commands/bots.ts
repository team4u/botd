import { Command, Option } from 'commander';
import type {
  BotConfig,
  NodeWithBots,
  SaveBotInput,
  SubagentToolScope as BotToolScope,
  ThinkingLevel,
} from '@botd/protocol';
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
    .command('list')
    .description('List BOTs and subagents')
    .option('--node <nodeId>', 'Filter by node ID')
    .option('--parent <parentBotId>', 'Filter subagents by parent BOT ID')
    .action((options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const nodes = await client.get<NodeWithBots[]>('/api/nodes');
        let allBots = nodes.flatMap((n) => n.bots);
        if (options.node) {
          allBots = allBots.filter((b) => b.nodeId === (options.node as string));
        }
        if (options.parent) {
          allBots = allBots.filter((b) => b.parentBotId === (options.parent as string));
        }
        printResult(allBots, g.json);
      })(options, command),
    );

  bots
    .command('create <botId>')
    .description('Create a new BOT configuration')
    .requiredOption('--node <nodeId>', 'Node ID that owns this BOT')
    .requiredOption('--name <name>', 'BOT display name')
    .option(
      '--model <provider/modelId>',
      'Model in <provider>/<modelId> format (optional for subagents with --parent, which inherit parent model by default)',
    )
    .option('--desc <description>', 'BOT description')
    .addOption(
      new Option('--thinking <level>', 'Thinking budget level')
        .choices(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .default('medium'),
    )
    .option('--skill <ids...>', 'Skill ID(s) to enable')
    .option('--extension <ids...>', 'Extension ID(s) to enable')
    .option('--system-file <path>', 'Path to SYSTEM.md file or - for stdin')
    .option('--parent <parentBotId>', 'Parent primary BOT ID (creates a role subagent under that BOT)')
    .option('--inherit-model', 'Inherit model from parent BOT (default true when --parent is set and --model is omitted)')
    .option('--no-inherit-model', 'Use explicit --model instead of inheriting from parent BOT')
    .option('--inherit-skills', 'Inherit enabled skills from parent BOT (default true for subagents)')
    .option('--no-inherit-skills', 'Use explicit --skill list instead of inheriting from parent BOT')
    .addOption(new Option('--tool-scope <scope>', 'Subagent tool permission scope').choices(['all', 'readonly', 'custom']))
    .option('--custom-tools <tools...>', 'Allowed tool names when --tool-scope is custom')
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);

        const parentBotId = options.parent as string | undefined;
        const modelStr = options.model as string | undefined;

        let modelProvider: string;
        let modelId: string;
        let inheritModel: boolean | undefined;

        if (modelStr) {
          const parsed = parseModel(modelStr);
          modelProvider = parsed.modelProvider;
          modelId = parsed.modelId;
          inheritModel = parentBotId ? (options.inheritModel === true ? true : false) : undefined;
        } else {
          if (!parentBotId) {
            throw new CliError(
              'Missing required option --model <provider/modelId> (or specify --parent <parentBotId> to create a subagent that inherits its parent model)',
            );
          }
          const nodes = await client.get<NodeWithBots[]>('/api/nodes');
          const parentBot = nodes.flatMap((n) => n.bots).find((b) => b.id === parentBotId);
          modelProvider = parentBot?.modelProvider ?? 'anthropic';
          modelId = parentBot?.modelId ?? 'claude-sonnet-4-5';
          inheritModel = options.inheritModel !== false;
        }

        const inheritSkills =
          parentBotId !== undefined
            ? options.inheritSkills !== undefined
              ? Boolean(options.inheritSkills)
              : !(Array.isArray(options.skill) && options.skill.length > 0)
            : undefined;
        const toolScope = (options.toolScope as BotToolScope | undefined) ?? 'all';
        const customTools = options.customTools as string[] | undefined;

        const systemFile = options.systemFile as string | undefined;
        const systemMd = systemFile ? await readInput(systemFile) : '';

        const body: SaveBotInput = {
          id: botId,
          nodeId: options.node as string,
          name: options.name as string,
          description: (options.desc as string | undefined) ?? '',
          modelProvider,
          modelId,
          thinkingLevel: options.thinking as ThinkingLevel,
          enabledSkills: (options.skill as string[] | undefined) ?? [],
          enabledExtensions: (options.extension as string[] | undefined) ?? [],
          systemMd,
          ...(parentBotId
            ? {
                parentBotId,
                inheritModel,
                inheritSkills,
                toolScope,
                ...(toolScope === 'custom' && customTools ? { customTools } : {}),
              }
            : {}),
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
        .choices(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    )
    .option('--skill <ids...>', 'Skill ID(s) to enable')
    .option('--extension <ids...>', 'Extension ID(s) to enable')
    .option('--system-file <path>', 'Path to SYSTEM.md file or - for stdin')
    .option('--inherit-model', 'Inherit model from parent BOT')
    .option('--no-inherit-model', 'Use explicit model instead of inheriting')
    .option('--inherit-skills', 'Inherit enabled skills from parent BOT')
    .option('--no-inherit-skills', 'Do not inherit skills from parent BOT')
    .addOption(new Option('--tool-scope <scope>', 'Subagent tool permission scope').choices(['all', 'readonly', 'custom']))
    .option('--custom-tools <tools...>', 'Allowed tool names when --tool-scope is custom')
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
          body.thinkingLevel = options.thinking as ThinkingLevel;
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
        if (options.inheritModel !== undefined) {
          body.inheritModel = Boolean(options.inheritModel);
        }
        if (options.inheritSkills !== undefined) {
          body.inheritSkills = Boolean(options.inheritSkills);
        }
        if (options.toolScope !== undefined) {
          body.toolScope = options.toolScope as BotToolScope;
        }
        if (options.customTools !== undefined) {
          body.customTools = options.customTools as string[];
        }

        const result = await client.put<BotConfig>(`/api/bots/${encodeURIComponent(botId)}`, body);
        printResult(result, g.json);
      })(options, command),
    );

  bots
    .command('delete <botId>')
    .description('Delete a BOT configuration')
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, command) => {
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
      cliAction(async (_options, command) => {
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
      cliAction(async (_options, command) => {
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

  const env = new Command('env').description("Manage a BOT's environment variables (secrets)");

  env
    .command('list <botId>')
    .description("List a BOT's environment variables")
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const result = await client.get<{ keys: string[]; env: Record<string, string> }>(
          `/api/bots/${encodeURIComponent(botId)}/env`,
        );
        printResult(result, g.json);
      })(options, command),
    );

  env
    .command('set <botId> <pairs...>')
    .description("Set one or more KEY=VALUE environment variables (e.g. GITHUB_TOKEN=xxx)")
    .option('--replace', 'Replace all existing variables instead of merging')
    .action((botId: string, pairs: string[], options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const parsedEnv: Record<string, string> = {};
        for (const pair of pairs) {
          const eq = pair.indexOf('=');
          const key = eq > 0 ? pair.slice(0, eq) : '';
          const value = eq >= 0 ? pair.slice(eq + 1) : '';
          if (eq < 0 || !key) {
            throw new CliError(`Invalid KEY=VALUE pair: "${pair}"`);
          }
          parsedEnv[key] = value;
        }
        const result = await client.put(`/api/bots/${encodeURIComponent(botId)}/env`, {
          env: parsedEnv,
          merge: !options.replace,
        });
        printResult(result, g.json);
      })(options, command),
    );

  env
    .command('unset <botId> <keys...>')
    .description("Remove environment variables by key")
    .action((botId: string, keys: string[], options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        let lastResult: unknown;
        for (const key of keys) {
          lastResult = await client.delete(`/api/bots/${encodeURIComponent(botId)}/env/${encodeURIComponent(key)}`);
        }
        printResult(lastResult, g.json);
      })(options, command),
    );

  bots.addCommand(env);

  program.addCommand(bots);
}
