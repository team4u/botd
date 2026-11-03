import { type Command, Option } from 'commander';
import type { ProviderAuthType, ProviderLoginState } from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { HubClient } from '../hub-client.js';
import { readInput } from '../input.js';
import { printResult } from '../render.js';
import { sleep } from '../../async-util.js';

function renderLoginState(state: ProviderLoginState, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`login ${state.id}  provider=${state.providerId}  method=${state.method}  status=${state.status}`);
  if (state.error) {
    console.log(`  error: ${state.error}`);
  }
  for (const event of state.events || []) {
    switch (event.type) {
      case 'info': {
        const linkSuffix =
          event.links && event.links.length > 0 ? ` -> ${event.links.map(l => l.url).join(', ')}` : '';
        console.log(`  · ${event.message}${linkSuffix}`);
        break;
      }
      case 'auth_url': {
        const instructions = event.instructions ? ` — ${event.instructions}` : '';
        console.log(`  · open: ${event.url}${instructions}`);
        break;
      }
      case 'device_code': {
        console.log(`  · code: ${event.userCode} at ${event.verificationUri}`);
        break;
      }
      case 'progress': {
        console.log(`  · ${event.message}`);
        break;
      }
    }
  }
  if (state.prompt) {
    console.log(`  prompt: ${state.prompt.message}`);
    console.log(`  answer with: botd providers respond <nodeId> <loginId> --prompt ${state.prompt.id} [--value <answer>]`);
  }
}

export function registerProvidersCommands(program: Command): void {
  const providers = program
    .command('providers')
    .description('Manage provider authentication on a node');

  const methodOption = new Option('--method <method>', 'authentication method')
    .choices(['api_key', 'oauth'])
    .makeOptionMandatory();

  const waitOption = new Option(
    '--wait [seconds]',
    'wait for login to complete (default: 120s if flag passed without value)',
  )
    .preset('120')
    .argParser((v: string | undefined) => (v === undefined ? 120 : Number(v)));

  providers
    .command('login <nodeId> <providerId>')
    .description('Start a provider login flow on a node')
    .addOption(methodOption)
    .addOption(waitOption)
    .action((nodeId: string, providerId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const method = options.method as ProviderAuthType;

        let wait: number | undefined;
        if (options.wait === true) {
          wait = 120;
        } else if (typeof options.wait === 'number') {
          if (!Number.isFinite(options.wait) || options.wait < 0) {
            throw new CliError(`Invalid --wait value: ${String(options.wait)}`);
          }
          wait = options.wait;
        } else if (typeof options.wait === 'string') {
          const parsed = Number(options.wait);
          if (!Number.isFinite(parsed) || parsed < 0) {
            throw new CliError(`Invalid --wait value: ${options.wait}`);
          }
          wait = parsed;
        }

        let state = await client.post<ProviderLoginState>(
          `/api/nodes/${encodeURIComponent(nodeId)}/providers/${encodeURIComponent(providerId)}/login`,
          { method },
        );

        if (wait !== undefined && state.status === 'pending') {
          const deadline = Date.now() + wait * 1000;
          while (Date.now() < deadline) {
            await sleep(2000);
            state = await client.get<ProviderLoginState>(
              `/api/nodes/${encodeURIComponent(nodeId)}/provider-logins/${encodeURIComponent(state.id)}`,
            );
            if (state.status !== 'pending') break;
          }
        }

        renderLoginState(state, g.json);

        if (wait !== undefined && state.status === 'pending') {
          process.exitCode = 1;
          console.error(`warning: still pending after ${wait}s`);
        }
      })(options, command),
    );

  providers
    .command('status <nodeId> <loginId>')
    .description('Get provider login status on a node')
    .action((nodeId: string, loginId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const state = await client.get<ProviderLoginState>(
          `/api/nodes/${encodeURIComponent(nodeId)}/provider-logins/${encodeURIComponent(loginId)}`,
        );
        renderLoginState(state, g.json);
      })(options, command),
    );

  providers
    .command('respond <nodeId> <loginId>')
    .description('Respond to a provider login prompt on a node')
    .requiredOption('--prompt <promptId>', 'prompt ID to respond to')
    .option('--value <value>', 'response value (reads from stdin if omitted)')
    .action((nodeId: string, loginId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const promptId = String(options.prompt);
        const value =
          typeof options.value === 'string'
            ? options.value
            : (await readInput()).replace(/\r?\n$/, '');
        const state = await client.post<ProviderLoginState>(
          `/api/nodes/${encodeURIComponent(nodeId)}/provider-logins/${encodeURIComponent(loginId)}/respond`,
          { promptId, value },
        );
        renderLoginState(state, g.json);
      })(options, command),
    );

  providers
    .command('cancel <nodeId> <loginId>')
    .description('Cancel an in-progress provider login on a node')
    .action((nodeId: string, loginId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.delete<{ ok: boolean }>(
          `/api/nodes/${encodeURIComponent(nodeId)}/provider-logins/${encodeURIComponent(loginId)}`,
        );
        printResult(result, g.json);
      })(options, command),
    );

  providers
    .command('logout <nodeId> <providerId>')
    .description('Log out a provider on a node')
    .action((nodeId: string, providerId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_options, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const result = await client.delete<{ ok: boolean }>(
          `/api/nodes/${encodeURIComponent(nodeId)}/providers/${encodeURIComponent(providerId)}/auth`,
        );
        printResult(result, g.json);
      })(options, command),
    );
}
