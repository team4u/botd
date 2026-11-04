import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerArtifactsCommands } from './commands/artifacts.js';
import { registerAsksCommands } from './commands/asks.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerBotsCommands } from './commands/bots.js';
import { registerChatCommands } from './commands/chat.js';
import { registerEventsCommands } from './commands/events.js';
import { registerExtensionsCommands } from './commands/extensions.js';
import { registerModelsCommands } from './commands/models.js';
import { registerNodeCommands } from './commands/node.js';
import { registerNodesCommands } from './commands/nodes.js';
import { registerProvidersCommands } from './commands/providers.js';
import { registerSessionsCommands } from './commands/sessions.js';
import { registerSkillsCommands } from './commands/skills.js';
import { registerTriggersCommands } from './commands/triggers.js';
import { registerWatchdogCommands } from './commands/watchdog.js';
import { registerWorkersCommands } from './commands/workers.js';

export function buildProgram(): Command {
  const program = new Command();
  // createRequire 读 JSON：import attributes（with { type: 'json' }）在最早的
  // Node 20 上不可用，而 @botd/node 承诺 engines >=20.0.0。
  const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

  program
    .name('botd')
    .description('botd — Node Agent daemon & Hub admin CLI')
    .version(pkg.version)
    .option('--json', 'emit machine-readable JSON (for AI agents and scripts)')
    .option('--data-dir <dir>', 'data directory (default ~/.botd, env BOTD_DATA_DIR)')
    .option('--hub <url>', 'Hub URL override (default: the URL saved by botd login)')
    .option('--password <password>', 'Hub user password (default: env BOTD_ADMIN_PASSWORD)')
    .option('--timeout <seconds>', 'HTTP request timeout in seconds (default 30)');

  // Node Agent role — operate this machine's botd daemon
  registerNodeCommands(program);
  registerArtifactsCommands(program);   // artifact put/pull/list

  // Hub admin role — everything the Web UI can do
  registerAuthCommands(program);      // login, logout, health
  registerNodesCommands(program);     // nodes list/pair/install
  registerBotsCommands(program);      // bots create/update/delete/system/memory
  registerSessionsCommands(program);  // sessions list/create/update/messages/cancel
  registerWorkersCommands(program);   // workers list/spawn/steer/stop/recall (super-agent)
  registerAsksCommands(program);      // asks list/respond (human-in-the-loop)
  registerEventsCommands(program);    // events ingest (EventRouter pipeline)
  registerWatchdogCommands(program);  // watchdog health diagnostics
  registerTriggersCommands(program);   // triggers list/create/delete
  registerChatCommands(program);      // chat send/watch (SSE)
  registerSkillsCommands(program);    // skills get/put/delete
  registerExtensionsCommands(program);// extensions get/put/delete
  registerProvidersCommands(program); // providers login/status/respond/cancel/logout
  registerModelsCommands(program);    // models catalog

  return program;
}
