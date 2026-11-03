import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { CliError } from '../../errors.js';
import { getDaemonSocketPath } from '../../../storage.js';
import { buildDaemonSpawnSpec } from '../../../daemon-launch.js';

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
 *  Shared by the wake/ask/bg commands here and the artifact commands. */
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

export interface WakeResponse {
  ok?: boolean;
  scheduledTriggerId?: string;
}

export async function sendWakeRequest(
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
// Daemon lifecycle helpers
// ---------------------------------------------------------------------------

export interface DaemonStatus {
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

export async function getDaemonStatus(socketPath: string, dataDir?: string): Promise<DaemonStatus | null> {
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
export async function stopDaemon(dataDir: string): Promise<'stopped' | 'not-running'> {
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
export function spawnDetachedDaemon(logFile: string, dataDir: string): number {
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
