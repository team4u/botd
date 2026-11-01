import { spawn, type ChildProcess } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { getTsxLoaderUrl, resolveCliEntry } from './runtime.js';

export interface DaemonSpawnSpec {
  execPath: string;
  args: string[];
}

export interface BuildDaemonSpawnSpecOptions {
  dataDir: string;
  cliEntryOverride?: string;
  envOverrides?: Record<string, string>;
}

export function buildDaemonSpawnSpec(options: BuildDaemonSpawnSpecOptions): DaemonSpawnSpec {
  let targetCliPath: string | undefined;
  let isTypeScript = false;

  if (options.cliEntryOverride && options.cliEntryOverride.trim() !== '') {
    targetCliPath = path.resolve(options.cliEntryOverride);
    isTypeScript = targetCliPath.endsWith('.ts');
  } else {
    try {
      const currentJsonPath = path.join(options.dataDir, 'current.json');
      if (fsSync.existsSync(currentJsonPath)) {
        const raw = fsSync.readFileSync(currentJsonPath, 'utf8');
        const parsed = JSON.parse(raw) as { entryPath?: string };
        if (parsed && typeof parsed.entryPath === 'string' && fsSync.existsSync(parsed.entryPath)) {
          targetCliPath = path.resolve(parsed.entryPath);
          isTypeScript = targetCliPath.endsWith('.ts');
        }
      }
    } catch {
      // ignore read or parse errors
    }
  }

  if (!targetCliPath) {
    const defaultEntry = resolveCliEntry();
    targetCliPath = defaultEntry.cliPath;
    isTypeScript = defaultEntry.isTypeScript;
  }

  const cliArgs = ['start', '--data-dir', options.dataDir];

  const loaderUrl = isTypeScript ? getTsxLoaderUrl() : undefined;
  if (isTypeScript && !loaderUrl) {
    throw new Error('TypeScript source execution mode requires tsx loader, but getTsxLoaderUrl() returned undefined');
  }
  const loaderArgs = loaderUrl ? ['--import', loaderUrl] : [];

  return {
    execPath: process.execPath,
    args: [...loaderArgs, targetCliPath, ...cliArgs],
  };
}

/**
 * Called by child daemon when initialized and ready to bind the socket.
 * Transmits IPC ready signal if spawned with an IPC channel.
 */
export function notifyDaemonReady(): void {
  if (typeof process.send === 'function') {
    try {
      process.send({ type: 'botd:daemon-ready', pid: process.pid });
    } catch {
      // IPC channel may already be closed; ignore safely
    }
  }
}

export interface SpawnReplacementDaemonOptions {
  dataDir: string;
  logFile?: string;
  timeoutMs?: number;
  bindRetryMs?: number;
  spawnFn?: typeof spawn;
  cliEntryOverride?: string;
  envOverrides?: Record<string, string>;
}

/**
 * Spawns a replacement daemon in detached mode with an IPC channel.
 * Resolves with the new PID once the replacement reports it is ready to bind the socket.
 * If the child exits prematurely, fails to spawn, or times out, the promise rejects
 * and the caller must keep the existing daemon instance alive.
 */
export function spawnReplacementDaemon(
  options: SpawnReplacementDaemonOptions,
): Promise<number> {
  const spawnImpl = options.spawnFn ?? spawn;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const bindRetryMs = options.bindRetryMs ?? 20_000;
  const logFile = options.logFile || path.join(options.dataDir, 'daemon.log');

  const { execPath, args } = buildDaemonSpawnSpec({
    dataDir: options.dataDir,
    cliEntryOverride: options.cliEntryOverride,
    envOverrides: options.envOverrides,
  });

  return new Promise((resolve, reject) => {
    let outFd: number;
    try {
      outFd = fsSync.openSync(logFile, 'a');
    } catch (err) {
      return reject(err);
    }

    let child: ChildProcess;
    try {
      child = spawnImpl(execPath, args, {
        detached: true,
        stdio: ['ignore', outFd, outFd, 'ipc'],
        windowsHide: true,
        env: {
          ...process.env,
          ...options.envOverrides,
          BOTD_DAEMON_DETACHED: '1',
          BOTD_DAEMON_LOG: logFile,
          BOTD_DAEMON_BIND_RETRY_MS: String(bindRetryMs),
        },
      });
    } catch (err) {
      return reject(err);
    } finally {
      fsSync.closeSync(outFd);
    }

    const pid = child.pid;
    if (typeof pid !== 'number') {
      child.once('error', () => {});
      try { child.disconnect(); } catch {}
      child.unref();
      return reject(new Error('Failed to spawn replacement daemon: no PID returned'));
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };

    const finishSuccess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.disconnect();
      } catch {}
      child.unref();
      resolve(pid);
    };

    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.disconnect();
      } catch {}
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      child.unref();
      reject(err);
    };

    const onMessage = (msg: unknown) => {
      if (
        msg &&
        typeof msg === 'object' &&
        (msg as { type?: string }).type === 'botd:daemon-ready'
      ) {
        finishSuccess();
      }
    };

    const onError = (err: Error) => {
      finishError(new Error(`Replacement daemon process error: ${err.message}`));
    };

    const onExit = (code: number | null, signal: string | null) => {
      finishError(
        new Error(
          `Replacement daemon exited prematurely with code ${code ?? 'null'} signal ${signal ?? 'null'}`,
        ),
      );
    };

    // Install listeners immediately to catch synchronous/asynchronous errors
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);

    timer = setTimeout(() => {
      finishError(
        new Error(`Timed out waiting for replacement daemon ready signal (${timeoutMs}ms)`),
      );
    }, timeoutMs);
    timer.unref();
  });
}
