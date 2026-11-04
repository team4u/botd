import { Command, Option } from 'commander';
import type {
  BotConfig,
  NodeWithBots,
  SaveBotInput,
  ThinkingLevel,
} from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { HubClient } from '../hub-client.js';
import { readInput } from '../input.js';
import { printContent, printResult } from '../render.js';
import { readNodeIdentity } from '../../storage.js';

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
    .option('--node <nodeId>', 'Node ID that owns this BOT (default: BOTD_NODE_ID or "local")')
    .requiredOption('--name <name>', 'BOT display name')
    .requiredOption('--model <provider/modelId>', 'Model in <provider>/<modelId> format (e.g. anthropic/claude-sonnet-4-5)')
    .option('--desc <description>', 'BOT description')
    .addOption(
      new Option('--thinking <level>', 'Thinking budget level')
        .choices(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .default('medium'),
    )
    .option('--skill <ids...>', 'Skill ID(s) to enable')
    .option('--extension <ids...>', 'Extension ID(s) to enable')
    .option('--system-file <path>', 'Path to SYSTEM.md file or - for stdin')
    .option('--workspace <dir>', 'Working directory for this BOT (its workers execute there)')
    .action((botId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);

        const { modelProvider, modelId } = parseModel(options.model as string);

        const systemFile = options.systemFile as string | undefined;
        const systemMd = systemFile ? await readInput(systemFile) : '';

        // 归属节点：--node > BOTD_NODE_ID > 本机已配对节点（node.json）> 'local'。
        // 分身回合里 bots create 不传 --node 时，落到本机真实节点而不是虚拟 local。
        const fallbackNodeId =
          process.env.BOTD_NODE_ID || (await readNodeIdentity(g.dataDir))?.nodeId || 'local';

        const body: SaveBotInput = {
          id: botId,
          nodeId: (options.node as string) || fallbackNodeId,
          name: options.name as string,
          description: (options.desc as string | undefined) ?? '',
          modelProvider,
          modelId,
          thinkingLevel: options.thinking as ThinkingLevel,
          enabledSkills: (options.skill as string[] | undefined) ?? [],
          enabledExtensions: (options.extension as string[] | undefined) ?? [],
          systemMd,
          ...(typeof options.workspace === 'string' && options.workspace.trim()
            ? { workspaceDir: options.workspace.trim() }
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
    .option('--workspace <dir>', 'Working directory for this BOT (its workers execute there)')
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
        if (typeof options.workspace === 'string' && options.workspace.trim()) {
          body.workspaceDir = options.workspace.trim();
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
        const result = await client.get<{ content: string }>(`/api/bots/${encodeURIComponent(botId)}/files/system`);
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
        const result = await client.put<{ ok: true }>(`/api/bots/${encodeURIComponent(botId)}/files/system`, { content });
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
        const result = await client.get<{ content: string }>(`/api/bots/${encodeURIComponent(botId)}/files/memory`);
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
        const result = await client.put<{ ok: true }>(`/api/bots/${encodeURIComponent(botId)}/files/memory`, { content });
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
