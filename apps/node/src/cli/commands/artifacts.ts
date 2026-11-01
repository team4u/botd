import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import type { ArtifactRecord } from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { getDaemonSocketPath } from '../../storage.js';
import { postJsonOverSocket, requestOverSocket } from './node.js';

export interface DaemonArtifactListResponse {
  ok: boolean;
  artifacts: ArtifactRecord[];
  error?: string;
}

export function registerArtifactsCommands(program: Command): void {
  const artifacts = program
    .command('artifact')
    .alias('artifacts')
    .description('File artifact transfer between node sessions and the Hub');

  artifacts
    .command('put <filePath>')
    .description('Upload a local file as an artifact of a session')
    .option('--session <id>', 'Session ID (or env BOTD_SESSION_ID)')
    .option('--bot <id>', 'Bot ID (or env BOTD_BOT_ID)')
    .option(
      '--message <msg>',
      'Optional message delivered along with the artifact',
    )
    .action(
      (filePath: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const sessionId =
            (options.session as string | undefined) ||
            process.env.BOTD_SESSION_ID;
          const botId =
            (options.bot as string | undefined) || process.env.BOTD_BOT_ID;
          const message = options.message as string | undefined;

          if (!sessionId || !botId) {
            throw new CliError(
              'Missing --session or --bot (or env BOTD_SESSION_ID / BOTD_BOT_ID)',
            );
          }

          const absPath = path.resolve(filePath);
          if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            throw new CliError(`File not found: ${absPath}`);
          }

          const socketPath = getDaemonSocketPath(dataDir);
          let artifact: ArtifactRecord;
          try {
            artifact = await postJsonOverSocket<ArtifactRecord>(
              socketPath,
              '/artifact/put',
              {
                sessionId,
                botId,
                filePath: absPath,
                message,
              },
              60_000,
              dataDir,
            );
          } catch (err: unknown) {
            throw new CliError(
              `Artifact put failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, artifact }, null, 2));
          } else {
            console.log(
              `Artifact uploaded: ${artifact.id} (${artifact.filename})`,
            );
          }
        })(options, command),
    );

  artifacts
    .command('pull <artifactId>')
    .description('Download a session artifact to the local filesystem')
    .option(
      '-o, --output <path>',
      'Output file path (default ./<artifact.filename>)',
    )
    .action(
      (
        artifactId: string,
        options: Record<string, unknown>,
        command: Command,
      ) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const socketPath = getDaemonSocketPath(dataDir);
          let artifact: ArtifactRecord | undefined;
          let savedPath: string | undefined;
          try {
            const output = options.output as string | undefined;
            if (output) {
              // Daemon-side write: resolve here so the reported path is absolute.
              artifact = await postJsonOverSocket<ArtifactRecord>(
                socketPath,
                '/artifact/pull',
                {
                  artifactId,
                  outputPath: path.resolve(output),
                },
                60_000,
                dataDir,
              );
              savedPath = path.resolve(output);
            } else {
              const result = await postJsonOverSocket<{
                artifact: ArtifactRecord;
                contentBase64?: string;
              }>(socketPath, '/artifact/pull', { artifactId }, 60_000, dataDir);
              artifact = result?.artifact;
              // 默认输出名必须净化：只取最后的路径成分，防止 hub 返回的 filename 穿越 cwd（如 ../../.ssh/authorized_keys）
              const lastSegment = (artifact?.filename || '').split(/[\\/]/).pop()?.trim() || '';
              const sanitized = lastSegment && lastSegment !== '.' && lastSegment !== '..'
                ? lastSegment
                : `artifact-${artifactId}`;
              const target = path.resolve(sanitized);
              if (typeof result?.contentBase64 === 'string') {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(
                  target,
                  Buffer.from(result.contentBase64, 'base64'),
                );
                savedPath = target;
              } else if (fs.existsSync(target)) {
                // Daemon already wrote the file at the default location.
                savedPath = target;
              } else {
                throw new Error('Daemon returned no artifact content');
              }
            }
          } catch (err: unknown) {
            throw new CliError(
              `Artifact pull failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          if (json) {
            console.log(
              JSON.stringify({ ok: true, savedPath, artifact }, null, 2),
            );
          } else {
            console.log(`Artifact saved: ${savedPath}`);
          }
        })(options, command),
    );

  artifacts
    .command('list')
    .description('List artifacts of a session')
    .option('--session <id>', 'Session ID (or env BOTD_SESSION_ID)')
    .action(
      cliAction(async (options, command) => {
        const { dataDir, json } = readGlobals(command);

        const sessionId =
          (options.session as string | undefined) ||
          process.env.BOTD_SESSION_ID;
        if (!sessionId) {
          throw new CliError('Missing --session (or env BOTD_SESSION_ID)');
        }

        const socketPath = getDaemonSocketPath(dataDir);
        let list: ArtifactRecord[];
        try {
          const { status, body } = await requestOverSocket(
            socketPath,
            'GET',
            `/artifact/list?sessionId=${encodeURIComponent(sessionId)}`,
            30_000,
            dataDir,
          );
          if (status !== 200) {
            throw new Error(`Daemon returned status ${status}: ${body}`);
          }
          const response = JSON.parse(body) as DaemonArtifactListResponse;
          if (!response || !Array.isArray(response.artifacts)) {
            throw new Error(`Daemon returned unexpected response structure: ${body}`);
          }
          list = response.artifacts;
        } catch (err: unknown) {
          throw new CliError(
            `Artifact list failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (json) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }
        if (list.length === 0) {
          console.log('(no artifacts)');
          return;
        }
        for (const item of list) {
          console.log(
            `${item.id}  ${item.filename}  ${item.sizeBytes}B  ${item.createdAt}`,
          );
        }
      }),
    );
}
