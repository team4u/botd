import fs from 'node:fs';
import { Command, Option } from 'commander';
import { cliAction, readGlobals } from '../../context.js';
import { CliError } from '../../errors.js';
import { getDaemonSocketPath } from '../../../storage.js';
import { requestOverSocket, getDaemonStatus } from './shared.js';

// ---------------------------------------------------------------------------
// Resource installation: install <source>
// ---------------------------------------------------------------------------

export function registerInstallCommands(program: Command): void {
  program
    .command('install <source>')
    .description('Install a skill or extension on this node')
    .option('--id <customId>', 'Custom identifier for the resource')
    .addOption(
      new Option('--kind <kind>', 'Resource kind')
        .choices(['auto', 'skill', 'extension'])
        .default('auto')
    )
    .action(
      (source: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const customId = options.id as string | undefined;
          const kind = (options.kind as 'auto' | 'skill' | 'extension' | undefined) || 'auto';

          let result: { kind: 'skill' | 'extension'; id: string };
          try {
            const { installResourceToNode } = await import('../../../installer.js');
            result = await installResourceToNode(dataDir, { source, kind, customId });
          } catch (err: unknown) {
            throw new CliError(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          const socketPath = getDaemonSocketPath(dataDir);
          // Named pipes never exist on disk; probe liveness instead.
          const socketAlive = process.platform === 'win32'
            ? await getDaemonStatus(socketPath, dataDir).then((s) => Boolean(s)).catch(() => false)
            : fs.existsSync(socketPath);
          if (socketAlive) {
            await requestOverSocket(socketPath, 'POST', '/reload', 10_000, dataDir).catch(() => {});
          }

          if (json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Installed ${result.kind}: ${result.id}`);
          }
        })(options, command),
    );
}
