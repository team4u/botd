import { spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

export const isWindows = process.platform === 'win32';

/**
 * Validates that a PID is a positive integer strictly greater than 1.
 * PID 0 targets the caller's process group, and PID 1 is init/systemd.
 * Negative numbers or non-integers must never be passed to group signals.
 */
export function isSafePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1;
}

/**
 * Checks whether a specific process is currently alive and executing
 * (excluding zombie states on Linux).
 */
export function isProcessRunning(pid?: number): boolean {
  if (!isSafePid(pid)) return false;

  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err.code === 'ESRCH') return false;
    if (err.code !== 'EPERM') return false;
  }

  if (process.platform === 'linux') {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = /^State:\s+(\w)/m.exec(status);
      if (match && match[1] === 'Z') {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Scans /proc on Linux to count non-zombie processes belonging to targetPgrp.
 * Returns:
 *   number >= 0: count of active (non-zombie) processes in targetPgrp
 *   null: unable to determine (e.g. non-Linux or permission/read failure),
 *         caller should use conservative fallback.
 */
export function countNonZombieInGroupLinux(targetPgrp: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const entries = fs.readdirSync('/proc');
    let nonZombieCount = 0;
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i];
      if (name.charCodeAt(0) >= 48 && name.charCodeAt(0) <= 57) {
        try {
          const content = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
          const lastParen = content.lastIndexOf(')');
          if (lastParen === -1) continue;
          const rest = content.slice(lastParen + 2).split(' ');
          const state = rest[0];
          const pgrp = Number.parseInt(rest[2], 10);
          if (pgrp === targetPgrp && state !== 'Z') {
            nonZombieCount++;
          }
        } catch (err: any) {
          if (err?.code === 'EACCES' || err?.code === 'EPERM') {
            return null; // Conservative fallback if unable to inspect
          }
        }
      }
    }
    return nonZombieCount;
  } catch {
    return null;
  }
}

/**
 * Checks whether any process in the process tree / process group is still alive.
 * On POSIX, uses process group signaling (-pid, 0) and scans Linux /proc to
 * distinguish active processes from dead zombies.
 * On Windows, checks process existence.
 */
export function isProcessTreeAlive(pid?: number): boolean {
  if (!isSafePid(pid)) return false;

  if (isWindows) {
    return isProcessRunning(pid);
  }

  // POSIX: check process group
  let groupHasProcesses = false;
  try {
    process.kill(-pid, 0);
    groupHasProcesses = true;
  } catch (err: any) {
    if (err.code === 'EPERM') return true; // Permission error: conservatively assume alive
  }

  if (groupHasProcesses) {
    if (process.platform === 'linux') {
      const nonZombies = countNonZombieInGroupLinux(pid);
      if (nonZombies !== null) {
        if (nonZombies > 0) return true;
        // All members in group are zombies (state Z), check individual pid
        return isProcessRunning(pid);
      }
    }
    return true;
  }

  // Fallback to checking single pid
  return isProcessRunning(pid);
}

/**
 * Sends a signal to the entire POSIX process group. If group signaling fails
 * (e.g. process was not the group leader / detached was false), falls back
 * directly to signaling the individual PID.
 */
function killPosixGroup(pid: number, signal: NodeJS.Signals): void {
  if (!isSafePid(pid)) return;
  let groupSent = false;
  try {
    process.kill(-pid, signal);
    groupSent = true;
  } catch {
    // Process group signal failed; fall back to individual pid
  }
  if (!groupSent) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

/**
 * Terminates process tree on Windows using taskkill /T (/F for force).
 * In Node.js, spawnSync does not throw on non-zero exit or error; inspects
 * result and falls back to process.kill if taskkill failed.
 */
function killWindowsTree(pid: number, force: boolean): void {
  if (!isSafePid(pid)) return;
  const args = ['/T'];
  if (force) args.push('/F');
  args.push('/PID', String(pid));
  try {
    const result = spawnSync('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    });
    if (result.error || (result.status !== null && result.status !== 0)) {
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {}
    }
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {}
  }
}

export interface TerminateTreeOptions {
  graceTimeoutMs?: number;
  forceTimeoutMs?: number;
  pollIntervalMs?: number;
  checkAlive?: (pid?: number) => boolean;
}

/**
 * Polls until the process tree is confirmed terminated or timeout expires.
 */
async function waitForTreeExit(
  child: ChildProcess | undefined,
  pid: number | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
  checkAlive: (p?: number) => boolean = isProcessTreeAlive,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const treeAlive = pid ? checkAlive(pid) : false;
    const childAlive = child ? (child.exitCode === null && child.signalCode === null) : false;
    if (!treeAlive && !childAlive) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const treeAlive = pid ? checkAlive(pid) : false;
  const childAlive = child ? (child.exitCode === null && child.signalCode === null) : false;
  return !treeAlive && !childAlive;
}

/**
 * Reliably terminates an entire process tree (shell + children + grandchildren):
 * 1. Sends SIGTERM to the process group (POSIX) or taskkill /T (Windows).
 * 2. Waits for exit up to graceTimeoutMs.
 * 3. If still running (e.g. trapped SIGTERM), escalates to SIGKILL / taskkill /F.
 * 4. Waits for exit up to forceTimeoutMs. If processes remain alive, throws an Error.
 */
export async function terminateProcessTree(
  child: ChildProcess | undefined,
  pid: number | undefined,
  options: TerminateTreeOptions = {},
): Promise<void> {
  const {
    graceTimeoutMs = 600,
    forceTimeoutMs = 600,
    pollIntervalMs = 25,
    checkAlive = isProcessTreeAlive,
  } = options;

  const targetPid = isSafePid(pid) ? pid : (isSafePid(child?.pid) ? child!.pid : undefined);

  if (!targetPid && !child) {
    return;
  }

  // If already completely dead, nothing to do
  if (
    (!targetPid || !checkAlive(targetPid)) &&
    (!child || child.exitCode !== null || child.signalCode !== null)
  ) {
    return;
  }

  // Phase 1: Graceful termination
  if (isWindows) {
    if (targetPid) killWindowsTree(targetPid, false);
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
  } else {
    if (targetPid) killPosixGroup(targetPid, 'SIGTERM');
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  const exitedGracefully = await waitForTreeExit(child, targetPid, graceTimeoutMs, pollIntervalMs, checkAlive);
  if (exitedGracefully) {
    return;
  }

  // Phase 2: Forceful termination escalation
  if (isWindows) {
    if (targetPid) killWindowsTree(targetPid, true);
    if (child) {
      try { child.kill('SIGKILL'); } catch {}
    }
  } else {
    if (targetPid) killPosixGroup(targetPid, 'SIGKILL');
    if (child) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  const exitedForcefully = await waitForTreeExit(child, targetPid, forceTimeoutMs, pollIntervalMs, checkAlive);
  if (!exitedForcefully) {
    throw new Error(
      `Failed to terminate process tree for PID ${targetPid}: processes still alive after forceful termination`,
    );
  }
}
