import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Command, Option } from 'commander';
import {
  parseDelayDuration,
  type BgJobRecord,
  type NodeUpgradeResult,
  type AskPreviewType,
  BOTD_UI_CATALOG_VERSION,
  BOTD_UI_COMPONENT_TYPES,
  BOTD_UI_SCHEMA_DOC,
  validateUiSpec,
  type BotdUiSpec,
} from '@botd/protocol';
import { cliAction, readGlobals } from '../context.js';
import { CliError } from '../errors.js';
import { writeNodeIdentity, getDaemonSocketPath } from '../../storage.js';
import type { DaemonHandle } from '../../daemon.js';
import { buildDaemonSpawnSpec } from '../../daemon-launch.js';
import { checkNodeUpgrade, performNodeUpgrade } from '../../upgrader.js';
import { installNodeService, uninstallNodeService, getNodeServiceStatus } from '../../service.js';

// ---------------------------------------------------------------------------
// Daemon control-plane helpers (Unix socket / Windows named pipe)
// ---------------------------------------------------------------------------

interface SocketResponse {
  status: number;
  body: string;
}

const IPC_TOKEN_FILE = 'ipc-token';
const IPC_TOKEN_HEADER = 'x-botd-ipc-token';
const IPC_VERSION_MISMATCH =
  'Local daemon rejected the IPC request (HTTP 401): daemon and CLI versions do not match. ' +
  'Restart the daemon (botd restart) or upgrade botd to a matching version.';

/** 新版 daemon 会在 <dataDir>/ipc-token (0600) 写入随机令牌；缺失（老版本 daemon）时不带该头。 */
function ipcAuthHeaders(dataDir: string | undefined): Record<string, string> {
  if (!dataDir) return {};
  try {
    const token = fs.readFileSync(path.join(dataDir, IPC_TOKEN_FILE), 'utf8').trim();
    return token ? { [IPC_TOKEN_HEADER]: token } : {};
  } catch {
    return {};
  }
}

/** GET/POST a bodyless request over the local daemon socket (raw response). */
export function requestOverSocket(
  socketPath: string,
  method: 'GET' | 'POST',
  url: string,
  timeoutMs: number,
  dataDir?: string,
): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: url, method, headers: { 'content-length': '0', ...ipcAuthHeaders(dataDir) } },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401) {
            reject(new CliError(IPC_VERSION_MISMATCH, 401));
            return;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Daemon request timed out')));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/** POST a JSON payload to the local daemon socket and parse the JSON response.
 *  Shared by the wake/ask commands here and the artifact commands. */
export async function postJsonOverSocket<T>(
  socketPath: string,
  url: string,
  payload: unknown,
  timeoutMs: number,
  dataDir?: string,
): Promise<T> {
  const data = JSON.stringify(payload);
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: url,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...ipcAuthHeaders(dataDir),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401) {
            reject(new CliError(IPC_VERSION_MISMATCH, 401));
            return;
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (!responseBody) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(responseBody) as T);
            } catch {
              reject(new Error(`Daemon returned invalid JSON: ${responseBody.slice(0, 200)}`));
            }
            return;
          }
          let detail = responseBody;
          try {
            const parsed = JSON.parse(responseBody) as { error?: string };
            if (parsed && typeof parsed.error === 'string') detail = parsed.error;
          } catch {
            // keep raw text
          }
          reject(new Error(`Daemon returned status ${res.statusCode}: ${detail}`));
        });
      },
    );
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Daemon request timed out')));
    }
    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

interface WakeResponse {
  ok?: boolean;
  scheduledTriggerId?: string;
}

async function sendWakeRequest(
  socketPath: string,
  payload: {
    sessionId: string;
    botId: string;
    message: string;
    replyToBotId?: string;
    noTurn?: boolean;
    delaySeconds?: number;
  },
  dataDir?: string,
): Promise<WakeResponse | undefined> {
  return await postJsonOverSocket<WakeResponse>(socketPath, '/wake', payload, 15_000, dataDir);
}

// ---------------------------------------------------------------------------
// Risk approval card (botd ask --risk/--reason/--resource)
// ---------------------------------------------------------------------------

export type AskRiskLevel = 'low' | 'medium' | 'high';

export interface ApprovalCardInput {
  /** Ask prompt; used as the card title and callout fallback content. */
  prompt: string;
  risk?: AskRiskLevel;
  reason?: string;
  resource?: string;
  filePath?: string;
  /** Raw preview text read from --file/--stdin, folded into an Accordion. */
  rawPreview?: string;
  /** Label the Accordion as a diff preview. */
  diffPreview?: boolean;
  /** Quick-reply options rendered as ActionBar buttons. */
  optionList: string[];
}

const APPROVAL_CALLOUT_META: Record<'low' | 'medium' | 'high' | 'none', { variant: 'info' | 'warn' | 'error'; title: string }> = {
  high: { variant: 'error', title: '高风险操作确认' },
  medium: { variant: 'warn', title: '中风险操作确认' },
  low: { variant: 'info', title: '低风险操作确认' },
  none: { variant: 'warn', title: '人工审批确认' },
};

/** Buttons whose label matches these (negative) words render as danger. */
const NEGATIVE_DECISION_RE = /拒绝|取消|中止|reject|cancel|deny/i;

/** Keep the generated spec far below the 64KB UI spec limit. */
const MAX_ACCORDION_PREVIEW_CHARS = 20_000;

function clampAccordionPreview(text: string): string {
  if (text.length <= MAX_ACCORDION_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_ACCORDION_PREVIEW_CHARS - 2_000)}\n...(已截断)...\n${text.slice(-1_500)}`;
}

/**
 * Build a botd.v1 Generative UI approval card: Card(Callout, KeyValueList?,
 * Accordion?, ActionBar+Buttons). The result always passes validateUiSpec.
 */
export function buildApprovalCardSpec(input: ApprovalCardInput): BotdUiSpec {
  const calloutMeta = APPROVAL_CALLOUT_META[input.risk ?? 'none'];
  const children: string[] = ['approval_callout'];
  const elements: Record<string, BotdUiSpec['elements'][string]> = {
    approval_card: {
      type: 'Card',
      props: {
        title: input.prompt || '需要人工审批',
        badge: input.risk ? input.risk.toUpperCase() : 'APPROVAL',
        icon: 'shield',
      },
      children,
    },
    approval_callout: {
      type: 'Callout',
      props: {
        title: calloutMeta.title,
        content: input.reason || input.prompt || '需要人工审批',
        variant: calloutMeta.variant,
      },
    },
  };

  const kvItems: { key: string; value: string; mono: true }[] = [];
  if (input.resource) kvItems.push({ key: '目标资源', value: input.resource, mono: true });
  if (input.filePath) kvItems.push({ key: '关联文件', value: input.filePath, mono: true });
  if (kvItems.length > 0) {
    elements.approval_details = { type: 'KeyValueList', props: { items: kvItems } };
    children.push('approval_details');
  }

  if (input.rawPreview && input.rawPreview.trim().length > 0) {
    elements.approval_preview = {
      type: 'Accordion',
      props: {
        items: [
          {
            title: input.diffPreview ? '变更差异预览 (Diff)' : '附加内容预览',
            content: clampAccordionPreview(input.rawPreview),
            defaultOpen: true,
            mono: true,
          },
        ],
      },
    };
    children.push('approval_preview');
  }

  const buttonIds: string[] = [];
  let primaryAssigned = false;
  input.optionList.forEach((opt, idx) => {
    const id = `approval_btn_${idx}`;
    let variant: 'primary' | 'secondary' | 'danger';
    if (NEGATIVE_DECISION_RE.test(opt)) {
      variant = 'danger';
    } else if (!primaryAssigned) {
      variant = 'primary';
      primaryAssigned = true;
    } else {
      variant = 'secondary';
    }
    elements[id] = {
      type: 'Button',
      props: { label: opt, variant },
      on: { press: { action: 'submit', params: { decision: opt } } },
    };
    buttonIds.push(id);
  });
  if (buttonIds.length > 0) {
    elements.approval_actions = { type: 'ActionBar', children: buttonIds };
    children.push('approval_actions');
  }

  return { root: 'approval_card', elements };
}

/**
 * Approval cards return `{ decision, params, state }` JSON from the UI form.
 * Extract the plain decision so `choice=$(botd ask ...)` keeps working;
 * non-JSON answers (quick-reply chips) pass through unchanged.
 */
export function extractApprovalDecision(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const decision = (parsed as { decision?: unknown }).decision;
      if (typeof decision === 'string' && decision.trim().length > 0) {
        return decision;
      }
    }
  } catch {
    // Not JSON: fall through and return the raw answer.
  }
  return answer;
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

interface DaemonStatus {
  ok: boolean;
  nodeId: string;
  name: string;
  hubUrl: string;
  dataDir: string;
  socketPath: string;
  pid: number;
  uptimeSeconds: number;
  hubConnected: boolean;
  version?: string;
}

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getDaemonStatus(socketPath: string, dataDir?: string): Promise<DaemonStatus | null> {
  try {
    const { status, body } = await requestOverSocket(socketPath, 'GET', '/status', 2_000, dataDir);
    if (status !== 200) return null;
    return JSON.parse(body) as DaemonStatus;
  } catch {
    return null;
  }
}

function readPidFile(pidFile: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Graceful stop: socket /shutdown first, SIGTERM via pid file as fallback. */
async function stopDaemon(dataDir: string): Promise<'stopped' | 'not-running'> {
  const socketPath = getDaemonSocketPath(dataDir);
  const pidFile = path.join(dataDir, 'daemon.pid');
  const status = await getDaemonStatus(socketPath, dataDir);

  if (status) {
    try {
      await requestOverSocket(socketPath, 'POST', '/shutdown', 5_000, dataDir);
    } catch (err) {
      throw new CliError(`Failed to stop daemon: ${(err as Error).message}`);
    }
    for (let i = 0; i < 50; i += 1) {
      await waitMs(200);
      if (!isPidAlive(status.pid) || !fs.existsSync(socketPath)) break;
    }
    fs.rmSync(pidFile, { force: true });
    return 'stopped';
  }

  // Daemon socket is dead: fall back to the pid file (e.g. killed mid-shutdown).
  const pid = readPidFile(pidFile);
  if (pid && isPidAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50; i += 1) {
      await waitMs(200);
      if (!isPidAlive(pid)) break;
    }
    fs.rmSync(pidFile, { force: true });
    return 'stopped';
  }

  fs.rmSync(pidFile, { force: true });
  return 'not-running';
}

/** Spawn `botd start` again as a detached background process logging to a file. */
function spawnDetachedDaemon(logFile: string, dataDir: string): number {
  const out = fs.openSync(logFile, 'a');
  try {
    const { execPath, args } = buildDaemonSpawnSpec({ dataDir });
    const child = spawn(execPath, args, {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: { ...process.env, BOTD_DAEMON_DETACHED: '1', BOTD_DAEMON_LOG: logFile },
    });
    child.unref();
    if (typeof child.pid !== 'number') {
      throw new CliError('Failed to spawn the background daemon');
    }
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerNodeCommands(program: Command): void {
  const detachOption = new Option('-d, --detach', 'run in the background, logging to --log-file');
  const logFileOption = new Option('--log-file <path>', 'log file for --detach (default: <dataDir>/daemon.log)');

  const runStart = async (options: Record<string, unknown>, command: Command): Promise<void> => {
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
      const { startDaemon } = await import('../../daemon.js');
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
  };

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

  program
    .command('join <hubUrl>')
    .description('Pair this node with a Cloud Hub')
    .requiredOption('--code <code>', 'Pairing code from Hub')
    .requiredOption('--name <name>', 'Node name')
    .action(
      (hubUrl: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const code = options.code as string | undefined;
          const name = options.name as string | undefined;

          if (!code || !name) {
            throw new CliError('Missing required arguments: --code or --name');
          }

          const cleanHubUrl = hubUrl.replace(/\/+$/, '');

          let response: Response;
          try {
            response = await fetch(`${cleanHubUrl}/api/nodes/pairing/exchange`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code, name, platform: process.platform }),
              signal: AbortSignal.timeout(15_000),
            });
          } catch (err: unknown) {
            throw new CliError(`Join error: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new CliError(`Pairing failed (${response.status}): ${text}`);
          }

          let result: { nodeId: string; token: string };
          try {
            result = (await response.json()) as { nodeId: string; token: string };
          } catch (err: unknown) {
            throw new CliError(`Join error: ${err instanceof Error ? err.message : String(err)}`);
          }

          await writeNodeIdentity(dataDir, {
            nodeId: result.nodeId,
            name,
            hubUrl: cleanHubUrl,
            token: result.token,
          });

          if (json) {
            console.log(JSON.stringify({ ok: true, nodeId: result.nodeId, hubUrl: cleanHubUrl }, null, 2));
          } else {
            console.log(`Node successfully paired! Node ID: ${result.nodeId}`);
          }
        })(options, command),
    );

  program
    .command('wake')
    .description('Send wake trigger to active session')
    .option('--session <id>', 'Session ID (or env BOTD_SESSION_ID)')
    .option('--bot <id>', 'Bot ID (or env BOTD_BOT_ID)')
    .option('--message <msg>', 'Wake message to deliver')
    .option('--reply-to <botId>', 'Bot ID to hand off / mention after wakeup')
    .option('--no-turn', 'Deliver message to session without triggering an LLM turn')
    .option('--delay <duration>', 'Schedule delayed wake-up (e.g. 30s, 15m, 2h, 1d)')
    .action(
      cliAction(async (options, command) => {
        const { dataDir, json } = readGlobals(command);

        const sessionId = (options.session as string | undefined) || process.env.BOTD_SESSION_ID;
        const botId = (options.bot as string | undefined) || process.env.BOTD_BOT_ID;
        const message = options.message as string | undefined;
        const replyToBotId = options.replyTo as string | undefined;
        const noTurn = options.turn === false;

        let delaySeconds: number | undefined;
        if (typeof options.delay === 'string' && options.delay) {
          const parsedDelay = parseDelayDuration(options.delay);
          if (parsedDelay === null) {
            throw new CliError('Invalid --delay format. Examples: 30s, 15m, 2h, 1d');
          }
          delaySeconds = parsedDelay;
        }

        if (!sessionId || !botId || !message) {
          throw new CliError('Missing --session, --bot or --message (or env BOTD_SESSION_ID / BOTD_BOT_ID)');
        }

        const socketPath = getDaemonSocketPath(dataDir);
        let result: WakeResponse | undefined;
        try {
          result = await sendWakeRequest(socketPath, {
            sessionId,
            botId,
            message,
            ...(replyToBotId ? { replyToBotId } : {}),
            ...(noTurn ? { noTurn: true } : {}),
            ...(delaySeconds !== undefined ? { delaySeconds } : {}),
          }, dataDir);
        } catch (err: unknown) {
          throw new CliError(`Wake failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (json) {
          console.log(JSON.stringify({
            ok: true,
            sessionId,
            botId,
            ...(noTurn ? { noTurn: true } : {}),
            ...(delaySeconds !== undefined ? { delaySeconds } : {}),
            ...(result?.scheduledTriggerId ? { scheduledTriggerId: result.scheduledTriggerId } : {}),
          }, null, 2));
        } else {
          const scheduledNote = result?.scheduledTriggerId
            ? ` (scheduled, triggerId: ${result.scheduledTriggerId})`
            : '';
          console.log(`Wake message delivered to session ${sessionId}${scheduledNote}`);
        }
      }),
    );

  const bg = program
    .command('bg')
    .description('Manage background jobs with automatic wake-up callbacks');

  bg.command('run <command...>')
    .description('Run a shell command as a managed background job in the bot workspace (auto wake-up on exit)')
    .option('--session <id>', 'Session ID (or env BOTD_SESSION_ID)')
    .option('--bot <id>', 'Bot ID (or env BOTD_BOT_ID)')
    .option('--reply-to <botId>', 'Bot ID to hand off / mention when the job completes')
    .option('--no-turn', 'On completion, deliver the log summary without triggering an LLM turn')
    .action(
      (commandParts: string[], options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const sessionId = (options.session as string | undefined) || process.env.BOTD_SESSION_ID;
          const botId = (options.bot as string | undefined) || process.env.BOTD_BOT_ID;
          const replyToBotId = options.replyTo as string | undefined;
          const commandText = commandParts.join(' ');

          if (!sessionId || !botId || !commandText.trim()) {
            throw new CliError('Missing --session, --bot or <command> (or env BOTD_SESSION_ID / BOTD_BOT_ID)');
          }

          const socketPath = getDaemonSocketPath(dataDir);
          let job: BgJobRecord | undefined;
          try {
            const result = await postJsonOverSocket<{ ok: true; job: BgJobRecord }>(
              socketPath,
              '/bg/run',
              {
                sessionId,
                botId,
                command: commandText,
                ...(replyToBotId ? { replyToBotId } : {}),
                noTurnOnComplete: options.turn === false,
              },
              15_000,
              dataDir,
            );
            job = result?.job;
          } catch (err: unknown) {
            throw new CliError(`Background job failed to start: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, job }, null, 2));
          } else {
            console.log(`Started background job ${job?.id} (pid ${job?.pid ?? 'n/a'})`);
            console.log(`  command: ${job?.command}`);
            console.log(`  log:     ${job?.logPath}`);
          }
        })(options, command),
    );

  bg.command('list')
    .description('List background jobs on this node')
    .option('--session <id>', 'Filter by Session ID')
    .option('--bot <id>', 'Filter by Bot ID')
    .option('--json', 'Output as JSON')
    .action(
      cliAction(async (options: Record<string, unknown>, command: Command) => {
        const { dataDir, json } = readGlobals(command);

        const query = new URLSearchParams();
        if (typeof options.session === 'string' && options.session) query.set('sessionId', options.session);
        if (typeof options.bot === 'string' && options.bot) query.set('botId', options.bot);

        const socketPath = getDaemonSocketPath(dataDir);
        let jobs: BgJobRecord[] = [];
        try {
          const { status, body } = await requestOverSocket(
            socketPath,
            'GET',
            `/bg/list${query.size ? `?${query.toString()}` : ''}`,
            10_000,
            dataDir,
          );
          if (status !== 200) {
            const parsed = JSON.parse(body) as { error?: string };
            throw new CliError(parsed?.error || `Daemon returned status ${status}`);
          }
          jobs = (JSON.parse(body) as { jobs?: BgJobRecord[] }).jobs ?? [];
        } catch (err: unknown) {
          if (err instanceof CliError) throw err;
          throw new CliError(`Failed to list background jobs: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (json) {
          console.log(JSON.stringify({ ok: true, jobs }, null, 2));
          return;
        }
        if (jobs.length === 0) {
          console.log('No background jobs.');
          return;
        }
        for (const job of jobs) {
          const finished = job.finishedAt ? `, finished ${job.finishedAt}` : '';
          const exit = job.exitCode !== undefined && job.exitCode !== null ? `, exit ${job.exitCode}` : '';
          console.log(`${job.id}  [${job.status}]  ${job.command}  (started ${job.startedAt}${exit}${finished})`);
        }
      }),
    );

  bg.command('logs <jobId>')
    .description('Show the tail of a background job log')
    .option('--lines <n>', 'Number of trailing lines to show (default 100)', '100')
    .option('--json', 'Output as JSON')
    .action(
      (jobId: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const lines = Math.max(1, Number(options.lines) || 100);
          const query = new URLSearchParams({ jobId, lines: String(lines) });

          const socketPath = getDaemonSocketPath(dataDir);
          let logs = '';
          try {
            const { status, body } = await requestOverSocket(
              socketPath,
              'GET',
              `/bg/logs?${query.toString()}`,
              10_000,
              dataDir,
            );
            if (status !== 200) {
              const parsed = JSON.parse(body) as { error?: string };
              throw new CliError(parsed?.error || `Daemon returned status ${status}`);
            }
            logs = (JSON.parse(body) as { logs?: string }).logs ?? '';
          } catch (err: unknown) {
            if (err instanceof CliError) throw err;
            throw new CliError(`Failed to read background job logs: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, jobId, logs }));
          } else {
            if (logs) console.log(logs);
          }
        })(options, command),
    );

  bg.command('kill <jobId>')
    .description('Terminate a running background job')
    .option('--json', 'Output as JSON')
    .action(
      (jobId: string, options: Record<string, unknown>, command: Command) =>
        cliAction(async () => {
          const { dataDir, json } = readGlobals(command);

          const socketPath = getDaemonSocketPath(dataDir);
          let job: BgJobRecord | undefined;
          try {
            const result = await postJsonOverSocket<{ ok: true; job: BgJobRecord }>(
              socketPath,
              '/bg/kill',
              { jobId },
              10_000,
              dataDir,
            );
            job = result?.job;
          } catch (err: unknown) {
            throw new CliError(`Failed to kill background job: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, job }, null, 2));
          } else {
            console.log(`Background job ${job?.id} is now ${job?.status ?? 'killed'}.`);
          }
        })(options, command),
    );

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
            const { installResourceToNode } = await import('../../installer.js');
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
