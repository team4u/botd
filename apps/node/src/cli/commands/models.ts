import { Command } from 'commander';
import type { ModelCatalog } from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

export function registerModelsCommands(program: Command): void {
  const models = program.command('models').description('Inspect model providers and catalog');

  models
    .command('catalog')
    .description('List available model providers and their supported models')
    .option('--node <nodeId>', 'query catalog from a specific node')
    .action(
      cliAction(async (options, command) => {
        const globals = readGlobals(command);
        const client = await HubClient.connect(globals);
        const nodeId = typeof options.node === 'string' && options.node.trim() ? options.node.trim() : undefined;
        const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
        const catalog = await client.get<ModelCatalog>(`/api/models/catalog${query}`);

        if (globals.json) {
          printResult(catalog, true);
          return;
        }

        console.log(`source: ${catalog.source}  sdk: ${catalog.sdkVersion}`);
        for (const provider of catalog.providers ?? []) {
          const authStr = (provider.authMethods ?? []).map(a => a.type).join(',');
          const configuredStr = provider.configured !== undefined ? `  configured=${provider.configured}` : '';
          console.log(
            `${provider.id.padEnd(24)} ${provider.name}  auth=[${authStr}]${configuredStr}  models=${(provider.models ?? []).length}`
          );
          for (const model of provider.models ?? []) {
            const reasoningStr = model.reasoning ? ', reasoning' : '';
            console.log(`  ${model.id}  (${model.name}${reasoningStr})`);
          }
        }
      })
    );
}
