import path from 'node:path';
import { Command, Option } from 'commander';
import { type NodeUpgradeResult } from '@botd/protocol';
import { cliAction, readGlobals } from '../../context.js';
import { CliError } from '../../errors.js';
import { getDaemonSocketPath } from '../../../storage.js';
import type { DaemonHandle } from '../../../daemon.js';
import { checkNodeUpgrade, performNodeUpgrade } from '../../../upgrader.js';
import { installNodeService, uninstallNodeService, getNodeServiceStatus } from '../../../service.js';
import { requestOverSocket, postJsonOverSocket, getDaemonStatus, stopDaemon, spawnDetachedDaemon } from './shared.js';

// ---------------------------------------------------------------------------
// Daemon lifecycle commands: start / restart / reload / stop / status / upgrade / service
// ---------------------------------------------------------------------------

const detachOption = new Option('-d, --detach', 'run in the background, logging to --log-file');
const logFileOption = new Option('--log-file <path>', 'log file for --detach (default: <dataDir>/daemon.log)');

export async function runStart(options: Record<string, unknown>, command: Command): Promise<void> {
  const { dataDir, json } = readGlobals(command);
  const detach = options.detach === true && process.env.BOTD_DAEMON_DETACHED !== '1';

  if (detach) {
    const logFile =
      typeof options.logFile === 'string' && options.logFile
        ? path.resolve(options.logFile)
        : path.join(dataDir, 'daemon.log');
    const pid = spawnDetachedDaemon(logFile, dataDir);
    if (json) {
      console.log(JSON.stringify({ ok: true, pid, logFile }, null, 2));
    } else {
      console.log(`botd daemon started in background. PID: ${pid}, Log: ${logFile}`);
      console.log('Check with: botd status');
    }
    return;
  }

  let daemon: DaemonHandle;
  try {
    const { startDaemon } = await import('../../../daemon.js');
    daemon = await startDaemon(dataDir);
  } catch (err: unknown) {
    throw new CliError(`Daemon start error: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`botd daemon started. Node ID: ${daemon.nodeId}, Socket: ${daemon.socketPath}`);

  const shutdown = async () => {
    console.log('Shutting down botd daemon...');
    try {
      await daemon.close();
    } catch {
      // ignore shutdown errors
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>(() => {});
}

export function registerLifecycleCommands(program: Command): void {
  program
    .command('start')
    .description('Start the Node Agent daemon')
    .addOption(detachOption)
    .addOption(logFileOption)
    .action(cliAction(runStart));

  program
    .command('restart')
    .description('Restart the Node Agent daemon (stop if running, then start)')
    .addOption(detachOption)
    .addOption(logFileOption)
    .action(
      cliAction(async (options, command) => {
        const { dataDir, json } = readGlobals(command);
        const result = await stopDaemon(dataDir);
        if (json) console.log(JSON.stringify({ stopped: result === 'stopped' }));
        else if (result === 'stopped') console.log('Stopped running daemon.');
        // restart 一律分离(detach)开启新 daemon：若沿用前台分支，本命令会变成 daemon 宿主
        // 进程且永不返回，Ctrl+C 还会连带杀掉刚启动的 daemon。前台语义留给 `botd start`。
        await runStart({ ...options, detach: true }, command);
      }),
    );

  program
    .command('reload')
    .description('Re-register this node\'s skills/extensions/bots with the Hub (picks up files written outside the Web UI)')
    .action(
      cliAction(async (_options, command) => {
        const { dataDir, json } = readGlobals(command);
        const socketPath = getDaemonSocketPath(dataDir);
        try {
          const { status, body } = await requestOverSocket(socketPath, 'POST', '/reload', 15_000, dataDir);
          if (status !== 200) {
            let detail = body;
            try {
              const parsed = JSON.parse(body) as { error?: string };
              if (parsed && typeof parsed.error === 'string') detail = parsed.error;
            } catch {
              // keep raw text
            }
            throw new CliError(detail || `Daemon returned status ${status}`);
          }
        } catch (err: unknown) {
          if (err instanceof CliError) throw err;
          throw new CliError('botd daemon is not running');
        }
        if (json) console.log(JSON.stringify({ ok: true }));
        else console.log('Resources re-registered with Hub.');
      }),
    );

  program
    .command('stop')
    .description('Stop the Node Agent daemon gracefully')
    .action(
      cliAction(async (_options, command) => {
        const { dataDir, json } = readGlobals(command);
        const result = await stopDaemon(dataDir);
        if (json) console.log(JSON.stringify({ ok: true, wasRunning: result === 'stopped' }, null, 2));
        else console.log(result === 'stopped' ? 'botd daemon stopped.' : 'botd daemon is not running.');
      }),
    );

  program
    .command('status')
    .description('Show whether the Node Agent daemon is running')
    .action(
      cliAction(async (_options, command) => {
        const { dataDir, json } = readGlobals(command);
        const status = await getDaemonStatus(getDaemonSocketPath(dataDir), dataDir);
        if (status) {
          if (json) {
            console.log(JSON.stringify({ running: true, ...status }, null, 2));
          } else {
            console.log(`daemon:  running (pid ${status.pid}, up ${status.uptimeSeconds}s)`);
            if (status.version) {
              console.log(`version: ${status.version}`);
            }
            console.log(`node:    ${status.name} (${status.nodeId})`);
            console.log(`hub:     ${status.hubUrl} (${status.hubConnected ? 'connected' : 'disconnected'})`);
            console.log(`socket:  ${status.socketPath}`);
          }
          return;
        }
        if (json) console.log(JSON.stringify({ running: false }, null, 2));
        else console.log('daemon: not running');
        process.exitCode = 1;
      }),
    );

  program
    .command('upgrade')
    .description('Check for or perform a node upgrade')
    .option('--version <ver>', 'target version to upgrade to')
    .option('--registry <url>', 'npm registry URL')
    .option('--check', 'check for available upgrade without upgrading')
    .option('--force', 'force upgrade even if version matches current')
    .action(
      cliAction(async (options, command) => {
        const { dataDir, json } = readGlobals(command);
        const registryUrl = typeof options.registry === 'string' ? options.registry : undefined;
        const targetVersion = typeof options.version === 'string' ? options.version : undefined;
        const force = Boolean(options.force);

        if (options.check) {
          const result = await checkNodeUpgrade(dataDir, { registryUrl, currentVersion: targetVersion });
          if (json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Current version:  ${result.currentVersion}`);
            console.log(`Latest version:   ${result.latestVersion}`);
            console.log(`Update available: ${result.updateAvailable ? 'yes' : 'no'}`);
            if (result.blocked) {
              console.log(`Blocked version:  ${result.blocked.version} (reason: ${result.blocked.reason}, at: ${result.blocked.at})`);
            }
          }
          return;
        }

        const socketPath = getDaemonSocketPath(dataDir);
        const status = await getDaemonStatus(socketPath, dataDir);
        let result: NodeUpgradeResult;

        if (status) {
          result = await postJsonOverSocket<NodeUpgradeResult>(
            socketPath,
            '/upgrade',
            { targetVersion, registryUrl, force },
            600_000,
            dataDir,
          );
        } else {
          result = await performNodeUpgrade(dataDir, { targetVersion, registryUrl, force });
        }

        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.upgraded) {
            console.log(
              `Successfully upgraded from ${result.previousVersion} to ${result.targetVersion} (new PID: ${result.pid ?? 'unknown'})`,
            );
          } else {
            console.log(`Already at target version ${result.targetVersion} (no upgrade needed)`);
          }
        }
      }),
    );

  program
    .command('service <action>')
    .description('Manage OS-level background service (install, uninstall, status)')
    .option('--dry-run', 'generate service configuration without applying system changes')
    .action((action: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (options, command) => {
        const act = action || (command.args[0] as string);
        const { dataDir, json } = readGlobals(command);
        const dryRun = Boolean(options.dryRun);

        if (act === 'install') {
          const res = await installNodeService(dataDir, { dryRun });
          if (json) console.log(JSON.stringify(res, null, 2));
          else console.log(res.message || `Service installed (${res.platform})`);
        } else if (act === 'uninstall') {
          const res = await uninstallNodeService(dataDir, { dryRun });
          if (json) console.log(JSON.stringify(res, null, 2));
          else console.log(res.message || `Service uninstalled (${res.platform})`);
        } else if (act === 'status') {
          const res = await getNodeServiceStatus(dataDir);
          if (json) console.log(JSON.stringify(res, null, 2));
          else console.log(res.installed ? `Service installed: ${res.platform} (${res.configPath})` : 'Service not installed');
        } else {
          throw new CliError(`Unknown service action: "${act}". Valid actions: install, uninstall, status`);
        }
      })(options, command)
    );
}
