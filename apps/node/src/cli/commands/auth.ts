import { Command } from 'commander';
import { clearCliConfig, readCliConfig } from '../config.js';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

export function registerAuthCommands(program: Command): void {
  program
    .command('login <hubUrl>')
    .description('Log in to a Hub instance and store session token (--username/--password via flag, BOTD_USERNAME/BOTD_ADMIN_PASSWORD env)')
    .option('--username <name>', 'Hub login username (default: admin, env BOTD_USERNAME)')
    .option('--save-credentials', 'save user password in plaintext to cli.json (0600)')
    .action((hubUrl: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const globals = readGlobals(command);
        const pwd = globals.password;
        if (!pwd) {
          throw new CliError('Missing --password (or set BOTD_ADMIN_PASSWORD)');
        }
        const username =
          typeof options.username === 'string' && options.username.trim()
            ? options.username.trim()
            : process.env.BOTD_USERNAME || 'admin';
        const { dataDir, timeoutMs } = globals;
        const client = await HubClient.establish(hubUrl, username, pwd, {
          dataDir,
          timeoutMs,
          persistPassword: options.saveCredentials === true,
        });
        await client.get('/api/auth/me');
        if (globals.json) {
          console.log(JSON.stringify({ ok: true, hubUrl: client.url }, null, 2));
        } else {
          console.log(`Logged in to ${client.url}`);
        }
      })(options, command)
    );

  program
    .command('logout')
    .description('Log out from the current Hub and clear stored credentials')
    .action(
      cliAction(async (options, command) => {
        const globals = readGlobals(command);
        const { dataDir, timeoutMs, json } = globals;
        const { hubUrl } = await readCliConfig(dataDir);
        if (hubUrl) {
          await HubClient.anonymous(hubUrl, { timeoutMs }).post('/api/auth/logout').catch(() => undefined);
        }
        await clearCliConfig(dataDir);
        printResult({ ok: true }, json);
      })
    );

  program
    .command('health')
    .description('Check Hub health and reachability')
    .action(
      cliAction(async (options, command) => {
        const globals = readGlobals(command);
        const hubUrl = globals.hubUrl ?? (await readCliConfig(globals.dataDir)).hubUrl;
        if (!hubUrl) {
          throw new CliError('No Hub configured. Run: botd login <hubUrl> --password <password>');
        }
        const result = await HubClient.anonymous(hubUrl, { timeoutMs: globals.timeoutMs }).get('/api/health');
        printResult(result, globals.json);
      })
    );
}
