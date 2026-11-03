import path from 'node:path';
import fs from 'node:fs';
import { Command } from 'commander';
import {
  type AskPreviewType,
  BOTD_UI_CATALOG_VERSION,
  BOTD_UI_COMPONENT_TYPES,
  BOTD_UI_SCHEMA_DOC,
  validateUiSpec,
} from '@botd/protocol';
import { cliAction, readGlobals } from '../../context.js';
import { CliError } from '../../errors.js';
import { getDaemonSocketPath } from '../../../storage.js';
import { postJsonOverSocket } from './shared.js';
import { buildApprovalCardSpec, extractApprovalDecision } from './approval-card.js';

// ---------------------------------------------------------------------------
// Interactive ask: ask [prompt]
// ---------------------------------------------------------------------------

export function registerAskCommands(program: Command): void {
  program
    .command('ask [prompt]')
    .description('Ask the user an interactive question in the active session and wait for their response')
    .option('--options <items>', 'Comma-separated choices (e.g. "确认,取消")')
    .option('--timeout <seconds>', 'Timeout in seconds (default 300, 0 for infinite)', '300')
    .option('--session <id>', 'Session ID (or env BOTD_SESSION_ID)')
    .option('--bot <id>', 'Bot ID (or env BOTD_BOT_ID)')
    .option('--file <path>', 'File to attach as preview (diff, markdown, or text)')
    .option('--diff', 'Set preview type to diff (reads stdin if --file is omitted)')
    .option('--ui', 'Render preview content (from --file or --stdin) as an interactive json-render UI card')
    .option('--ui-schema', 'Print the botd.v1 Generative UI Spec schema & component catalog and exit')
    .option('--stdin', 'Read preview content from stdin')
    .option('--risk <level>', 'Auto-build a risk approval card (low | medium | high) unless --ui is given')
    .option('--reason <text>', 'Why human approval is needed (callout body of the approval card)')
    .option('--resource <target>', 'Affected resource/service/path shown in the approval card')
    .action(
      (prompt: string | undefined, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json, timeoutMs } = readGlobals(command);

          if (options.uiSchema) {
            if (json) {
              console.log(
                JSON.stringify(
                  {
                    ok: true,
                    version: BOTD_UI_CATALOG_VERSION,
                    componentTypes: BOTD_UI_COMPONENT_TYPES,
                    schemaDoc: BOTD_UI_SCHEMA_DOC,
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(BOTD_UI_SCHEMA_DOC);
            }
            return;
          }

          if (!prompt || prompt.trim().length === 0) {
            throw new CliError('Missing prompt');
          }

          const sessionId = (options.session as string | undefined) || process.env.BOTD_SESSION_ID;
          const botId = (options.bot as string | undefined) || process.env.BOTD_BOT_ID;
          const rawOptions = options.options as string | undefined;
          const rawTimeout = options.timeout as string | undefined;
          const timeoutSeconds = rawTimeout !== undefined ? Number(rawTimeout) : 300;
          const filePath = options.file as string | undefined;
          const isUi = Boolean(options.ui);
          const isDiff = Boolean(options.diff);
          const isStdin = Boolean(options.stdin);

          if (!sessionId || !botId) {
            throw new CliError('Missing --session or --bot (or env BOTD_SESSION_ID / BOTD_BOT_ID)');
          }

          const riskRaw = options.risk as string | undefined;
          const reason = options.reason as string | undefined;
          const resource = options.resource as string | undefined;
          if (riskRaw !== undefined && riskRaw !== 'low' && riskRaw !== 'medium' && riskRaw !== 'high') {
            throw new CliError(`Invalid --risk value "${riskRaw}". Allowed values: low, medium, high`);
          }
          const risk = riskRaw as 'low' | 'medium' | 'high' | undefined;
          // One-shot approval card: --risk/--reason/--resource auto-build a Generative UI
          // card unless the user hand-writes a UI spec via --ui.
          const approvalMode = Boolean(risk || reason || resource) && !isUi;
          const optionsList = rawOptions
            ? rawOptions.split(',').map((item) => item.trim()).filter(Boolean)
            : approvalMode
              ? ['批准', '拒绝']
              : undefined;

          const MAX_PREVIEW_BYTES = 256 * 1024;
          let previewContent: string | undefined;
          let previewType: AskPreviewType | undefined;

          if (filePath) {
            try {
              const fileData = await fs.promises.readFile(path.resolve(filePath), 'utf8');
              if (Buffer.byteLength(fileData, 'utf8') > MAX_PREVIEW_BYTES) {
                previewContent = Buffer.from(fileData, 'utf8').subarray(0, MAX_PREVIEW_BYTES).toString('utf8');
              } else {
                previewContent = fileData;
              }
            } catch (err: unknown) {
              throw new CliError(`Failed to read preview file: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (isUi || /\.ui\.json$/i.test(filePath)) {
              previewType = 'ui';
            } else if (isDiff || /\.(diff|patch)$/i.test(filePath)) {
              previewType = 'diff';
            } else if (/\.md$/i.test(filePath)) {
              previewType = 'markdown';
            } else {
              previewType = 'text';
            }
          } else if (isUi || isDiff || isStdin || (!process.stdin.isTTY && !approvalMode)) {
            // Approval cards only fold preview content passed explicitly via --file/--stdin;
            // a silently piped stdin must not be captured as card preview.
            previewType = isUi ? 'ui' : isDiff ? 'diff' : 'text';
            if (!process.stdin.isTTY) {
              try {
                previewContent = await new Promise<string>((resolve, reject) => {
                  const chunks: Buffer[] = [];
                  let totalBytes = 0;
                  const onData = (chunk: Buffer | string) => {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    chunks.push(buf);
                    totalBytes += buf.length;
                    if (totalBytes >= MAX_PREVIEW_BYTES) {
                      process.stdin.removeListener('data', onData);
                      process.stdin.removeListener('end', onEnd);
                      process.stdin.removeListener('error', onError);
                      process.stdin.pause();
                      resolve(Buffer.concat(chunks).subarray(0, MAX_PREVIEW_BYTES).toString('utf8'));
                    }
                  };
                  const onEnd = () => {
                    process.stdin.removeListener('data', onData);
                    process.stdin.removeListener('error', onError);
                    resolve(Buffer.concat(chunks).subarray(0, MAX_PREVIEW_BYTES).toString('utf8'));
                  };
                  const onError = (err: Error) => {
                    process.stdin.removeListener('data', onData);
                    process.stdin.removeListener('end', onEnd);
                    reject(err);
                  };
                  process.stdin.on('data', onData);
                  process.stdin.on('end', onEnd);
                  process.stdin.on('error', onError);
                  process.stdin.resume();
                });
              } catch (err: unknown) {
                throw new CliError(`Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          if (approvalMode) {
            const rawPreview = previewContent && previewContent.trim().length > 0 ? previewContent : undefined;
            const validation = validateUiSpec(
              buildApprovalCardSpec({
                prompt: prompt || '需要人工审批',
                risk,
                reason,
                resource,
                filePath,
                rawPreview,
                diffPreview: isDiff || Boolean(filePath && /\.(diff|patch)$/i.test(filePath)),
                optionList: optionsList ?? [],
              }),
            );
            if (!validation.ok) {
              throw new CliError(`Failed to build approval card: ${validation.errors.join('; ')}`);
            }
            previewType = 'ui';
            previewContent = validation.normalizedJson;
          } else if (isUi || previewType === 'ui') {
            if (!previewContent || previewContent.trim().length === 0) {
              throw new CliError(
                'UI spec content is required when --ui is specified (provide via --file <path> or --stdin)',
              );
            }
            const validation = validateUiSpec(previewContent);
            if (!validation.ok) {
              throw new CliError(`Invalid UI spec:\n  - ${validation.errors.join('\n  - ')}`);
            }
            previewType = 'ui';
            previewContent = validation.normalizedJson;
          } else {
            if (!previewContent || previewContent.length === 0) {
              previewContent = undefined;
              if (!filePath && !isDiff) {
                previewType = undefined;
              }
            }
          }

          const effectiveTimeoutSeconds =
            Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0 ? timeoutSeconds : 300;
          const timeoutMsForAsk =
            effectiveTimeoutSeconds === 0 ? 0 : Math.max(timeoutMs, effectiveTimeoutSeconds * 1000);

          const socketPath = getDaemonSocketPath(dataDir);
          let answer: string;
          try {
            const result = await postJsonOverSocket<{ ok?: boolean; answer?: string }>(
              socketPath,
              '/ask',
              {
                sessionId,
                botId,
                prompt,
                ...(optionsList ? { options: optionsList } : {}),
                timeoutSeconds: effectiveTimeoutSeconds,
                ...(previewType ? { previewType } : {}),
                ...(previewContent ? { previewContent } : {}),
              },
              timeoutMsForAsk,
              dataDir,
            );
            answer = typeof result?.answer === 'string' ? result.answer : '';
          } catch (err: unknown) {
            throw new CliError(`Ask failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, answer }));
          } else if (approvalMode) {
            // Auto-generated approval cards answer with `{ decision, state }` JSON;
            // print the plain decision so `choice=$(botd ask ...)` keeps the same
            // shell-friendly behavior as plain `--options` asks.
            console.log(extractApprovalDecision(answer));
          } else {
            // Print the raw answer so shell scripts can capture it:
            //   choice=$(botd ask "..." --options "yes,no")
            console.log(answer);
          }
        })(options, command),
    );
}
