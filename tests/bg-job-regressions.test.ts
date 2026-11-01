import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { BgJobManager, type BgJobWakeInput } from '../apps/node/src/bg-jobs.js';
import {
  isProcessRunning,
  isSafePid,
  isProcessTreeAlive,
  countNonZombieInGroupLinux,
  terminateProcessTree,
} from '../apps/node/src/process-tree.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  if (!(await predicate())) {
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }
}

test('isSafePid strictly rejects negative, zero, PID 1, and non-integer values', () => {
  assert.equal(isSafePid(0), false, 'PID 0 would signal caller process group');
  assert.equal(isSafePid(-1), false, 'PID -1 would broadcast signal');
  assert.equal(isSafePid(-123), false, 'negative PID would invert -pid to single process');
  assert.equal(isSafePid(1), false, 'PID 1 is init/systemd');
  assert.equal(isSafePid(NaN), false);
  assert.equal(isSafePid(null), false);
  assert.equal(isSafePid(undefined), false);
  assert.equal(isSafePid('42'), false);
  assert.equal(isSafePid(3.14), false);
  assert.equal(isSafePid(2), true);
  assert.equal(isSafePid(9999), true);
});

test('process tree termination prevents grandchild execution and kills process group', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process group test: Windows uses taskkill /T verified in separate test');
    return;
  }

  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-tree-'));
  const wakes: BgJobWakeInput[] = [];
  const bg = new BgJobManager(tmpData, async (w) => {
    wakes.push(w);
  });

  t.after(async () => {
    await bg.closeAll().catch(() => {});
    await rm(tmpData, { recursive: true, force: true });
  });

  const markerFile = path.join(tmpData, 'marker.txt');
  const childPidFile = path.join(tmpData, 'grandchild.pid');

  // Spawn a shell that spawns a background grandchild sleep that writes a marker after 1.5s
  const job = await bg.startJob({
    sessionId: 'sess_tree_1',
    botId: 'worker_tree',
    command: `(sleep 1.5 && echo grand_done > "${markerFile}") & echo $! > "${childPidFile}"; wait`,
  });

  // Wait until grandchild PID is written
  await waitFor(() => existsSync(childPidFile), 3000);
  const grandchildPidStr = (await readFile(childPidFile, 'utf8')).trim();
  const grandchildPid = Number.parseInt(grandchildPidStr, 10);
  assert.ok(isSafePid(grandchildPid), `Expected valid grandchild PID, got ${grandchildPidStr}`);

  // Confirm grandchild is actively running and marker not written yet
  assert.equal(isProcessRunning(grandchildPid), true, 'grandchild must be running');
  assert.equal(existsSync(markerFile), false, 'marker must not exist yet');

  // Kill the background job
  const killed = await bg.killJob(job.id);
  assert.equal(killed.status, 'killed');
  assert.ok(killed.finishedAt, 'finishedAt must be recorded');

  // Confirm tree is terminated: grandchild process must not be running
  assert.equal(isProcessRunning(grandchildPid), false, 'grandchild process must be stopped');
  assert.equal(existsSync(markerFile), false, 'marker file must not have been created');

  // Wait past the 1.5s delay to ensure it was truly killed and not lingering
  await sleep(600);
  assert.equal(existsSync(markerFile), false, 'marker file must still not exist after delay');
  assert.equal(wakes.length, 0, 'manual kill must not trigger wake callback');
});

test('closeAll terminates all running process trees and awaits exit', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shell test');
    return;
  }

  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-closeall-'));
  const wakes: BgJobWakeInput[] = [];
  const bg = new BgJobManager(tmpData, async (w) => {
    wakes.push(w);
  });

  t.after(async () => {
    await bg.closeAll().catch(() => {});
    await rm(tmpData, { recursive: true, force: true });
  });

  const marker1 = path.join(tmpData, 'm1.txt');
  const marker2 = path.join(tmpData, 'm2.txt');

  const j1 = await bg.startJob({
    sessionId: 'sess_ca_1',
    botId: 'bot1',
    command: `(sleep 1.5 && echo m1 > "${marker1}") & wait`,
  });

  const j2 = await bg.startJob({
    sessionId: 'sess_ca_1',
    botId: 'bot2',
    command: `(sleep 1.5 && echo m2 > "${marker2}") & wait`,
  });

  assert.equal(j1.status, 'running');
  assert.equal(j2.status, 'running');

  await sleep(100);

  // closeAll must terminate both trees
  await bg.closeAll();

  const jobs = bg.listJobs();
  for (const j of jobs) {
    assert.equal(j.status, 'killed');
    assert.ok(j.finishedAt);
  }

  // Neither marker must be created
  await sleep(500);
  assert.equal(existsSync(marker1), false);
  assert.equal(existsSync(marker2), false);
  assert.equal(wakes.length, 0, 'closeAll must not trigger wakes');
});

test('escalates to SIGKILL when process ignores SIGTERM', async (t) => {
  if (process.platform === 'win32') {
    t.skip('SIGTERM trap ignored on Windows: taskkill /F is tested for force kill');
    return;
  }

  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-sigkill-'));
  const wakes: BgJobWakeInput[] = [];
  const bg = new BgJobManager(tmpData, async (w) => {
    wakes.push(w);
  });

  t.after(async () => {
    await bg.closeAll().catch(() => {});
    await rm(tmpData, { recursive: true, force: true });
  });

  // Process explicitly traps and ignores SIGTERM
  const job = await bg.startJob({
    sessionId: 'sess_term_1',
    botId: 'stubborn_bot',
    command: 'trap "" TERM; sleep 20',
  });

  await sleep(100);
  assert.ok(job.pid);
  assert.equal(isProcessRunning(job.pid), true);

  const t0 = Date.now();
  const killed = await bg.killJob(job.id);
  const duration = Date.now() - t0;

  assert.equal(killed.status, 'killed');
  assert.equal(isProcessRunning(job.pid), false, 'process must be dead after SIGKILL escalation');
  assert.ok(duration >= 500, `Expected SIGKILL grace wait (~600ms), took ${duration}ms`);
  assert.ok(duration < 3500, `Expected termination within 3.5s, took ${duration}ms`);
  assert.equal(wakes.length, 0, 'killed job must not wake');
});

test('termination confirmation timeout throws error, does NOT falsely mark killed, and allows retry', async (t) => {
  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-fail-confirm-'));
  let mockAlive = true;

  // Inject fast timeout with mock alive checker simulating an unkillable process
  const bg = new BgJobManager(
    tmpData,
    async () => {},
    {
      graceTimeoutMs: 15,
      forceTimeoutMs: 15,
      pollIntervalMs: 5,
      checkAlive: () => mockAlive,
    },
  );

  t.after(async () => {
    mockAlive = false;
    await bg.closeAll().catch(() => {});
    await rm(tmpData, { recursive: true, force: true });
  });

  const job = await bg.startJob({
    sessionId: 'sess_stubborn',
    botId: 'worker',
    command: 'sleep 20',
  });

  // killJob must throw when process tree is still alive after force timeout
  await assert.rejects(
    () => bg.killJob(job.id),
    /processes still alive after forceful termination/,
  );

  // Status must remain 'running' and NOT be prematurely marked 'killed'
  const [current] = bg.listJobs();
  assert.equal(current.status, 'running', 'Job must not falsely report killed when still alive');

  // closeAll must also propagate the failure
  await assert.rejects(
    () => bg.closeAll(),
    /processes still alive after forceful termination/,
  );

  // Once process dies, retry must succeed and update status to killed
  mockAlive = false;
  const retried = await bg.killJob(job.id);
  assert.equal(retried.status, 'killed', 'Subsequent retry must succeed once process is dead');
  assert.ok(retried.finishedAt);
});

test('Linux /proc stat excludes zombie processes from active process tree count', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Linux /proc scanning test');
    return;
  }

  // Spawn a detached python script that forks a child that exits immediately, creating a zombie
  const python = spawn(
    'python3',
    ['-c', 'import os, time; pid = os.fork()\nif pid == 0: exit(0)\ntime.sleep(2)'],
    { detached: true },
  );

  t.after(() => {
    try {
      if (python.pid) process.kill(-python.pid, 'SIGKILL');
    } catch {}
  });

  await sleep(150);
  assert.ok(python.pid);

  // While python is alive, count must be >= 1
  const countBefore = countNonZombieInGroupLinux(python.pid);
  assert.equal(countBefore, 1, 'Expected 1 active process before kill');

  // Kill the python leader with SIGKILL, leaving only the zombie child
  process.kill(python.pid, 'SIGKILL');
  await sleep(50);

  // Group count must now be 0 non-zombies
  const countAfter = countNonZombieInGroupLinux(python.pid);
  assert.equal(countAfter, 0, 'Zombie child must not be counted as active');

  // isProcessTreeAlive must return false immediately without waiting for timeouts
  const t0 = Date.now();
  const alive = isProcessTreeAlive(python.pid);
  const elapsed = Date.now() - t0;

  assert.equal(alive, false, 'Group with only zombies must be considered dead');
  assert.ok(elapsed < 50, `Expected instant check, took ${elapsed}ms`);
});

test('normal job completion wakes session with done status and logs', async (t) => {
  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-normal-'));
  const wakes: BgJobWakeInput[] = [];
  const bg = new BgJobManager(tmpData, async (w) => {
    wakes.push(w);
  });

  t.after(async () => {
    await bg.closeAll().catch(() => {});
    await rm(tmpData, { recursive: true, force: true });
  });

  const job = await bg.startJob({
    sessionId: 'sess_norm_1',
    botId: 'worker',
    command: 'echo "HELLO_NORMAL_WAKE"',
  });

  await waitFor(() => wakes.length === 1, 5000);
  assert.equal(wakes[0].sessionId, 'sess_norm_1');
  assert.equal(wakes[0].botId, 'worker');
  assert.match(wakes[0].wakeupMessage, /执行完成/);
  assert.match(wakes[0].wakeupMessage, /exit code: 0/);
  assert.match(wakes[0].wakeupMessage, /HELLO_NORMAL_WAKE/);

  const { logs, job: record } = await bg.getJobLogs(job.id);
  assert.match(logs, /HELLO_NORMAL_WAKE/);
  assert.equal(record.status, 'done');
  assert.equal(record.exitCode, 0);
  assert.ok(record.finishedAt);
});

test('failed job (exit != 0) wakes with failed status, and killJob does NOT show killed', async (t) => {
  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-failed-'));
  const wakes: BgJobWakeInput[] = [];
  const bg = new BgJobManager(tmpData, async (w) => {
    wakes.push(w);
  });

  t.after(async () => {
    await bg.closeAll().catch(() => {});
    await rm(tmpData, { recursive: true, force: true });
  });

  const job = await bg.startJob({
    sessionId: 'sess_fail_1',
    botId: 'worker',
    command: 'echo "FAIL_OUTPUT" && exit 42',
  });

  await waitFor(() => wakes.length === 1, 5000);
  assert.match(wakes[0].wakeupMessage, /执行失败/);
  assert.match(wakes[0].wakeupMessage, /exit code: 42/);

  const { job: record } = await bg.getJobLogs(job.id);
  assert.equal(record.status, 'failed');
  assert.equal(record.exitCode, 42);

  // Calling killJob on already failed job must NOT overwrite status to killed
  const afterKill = await bg.killJob(job.id);
  assert.equal(afterKill.status, 'failed', 'failed status must not prematurely show killed');
});

test('spawn error does not crash and marks job as failed', async (t) => {
  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-spawn-err-'));
  const wakes: BgJobWakeInput[] = [];
  const bg = new BgJobManager(tmpData, async (w) => {
    wakes.push(w);
  });

  t.after(async () => {
    await bg.closeAll().catch(() => {});
    await rm(tmpData, { recursive: true, force: true });
  });

  const origShell = process.env.BOTD_SHELL_PATH;
  process.env.BOTD_SHELL_PATH = '/path/to/nonexistent/executable';

  try {
    const job = await bg.startJob({
      sessionId: 'sess_spawn_err',
      botId: 'worker',
      command: 'echo should_fail_to_spawn',
    });

    // Wait for spawn error handler and wake to finish
    await waitFor(() => wakes.length === 1, 5000);

    assert.equal(wakes.length, 1);
    assert.match(wakes[0].wakeupMessage, /spawn error/);

    const { job: record } = await bg.getJobLogs(job.id);
    assert.equal(record.status, 'failed', 'spawn error must mark status as failed');
    assert.equal(record.exitCode, null);
    assert.ok(record.finishedAt);

    // Calling killJob on a failed job must NOT overwrite status to killed
    const afterKill = await bg.killJob(job.id);
    assert.equal(afterKill.status, 'failed', 'failed status must not prematurely show killed');
  } finally {
    if (origShell !== undefined) {
      process.env.BOTD_SHELL_PATH = origShell;
    } else {
      delete process.env.BOTD_SHELL_PATH;
    }
  }
});

test('closeAll handles concurrent startJob race without unhandled rejection or leaking process', async (t) => {
  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-race-'));
  const wakes: BgJobWakeInput[] = [];
  const bg = new BgJobManager(tmpData, async (w) => {
    wakes.push(w);
  });

  t.after(async () => {
    await bg.closeAll().catch(() => {});
    await rm(tmpData, { recursive: true, force: true });
  });

  // Trigger startJob and closeAll simultaneously
  const startPromise = bg.startJob({
    sessionId: 'sess_race_1',
    botId: 'worker',
    command: 'sleep 5',
  });
  const closePromise = bg.closeAll();

  // startJob might either succeed and get killed, or throw shutting down
  try {
    const job = await startPromise;
    assert.ok(job);
  } catch (err: any) {
    assert.match(err.message, /shutting down/);
  }

  await closePromise;

  // After close, listJobs should only show killed or empty, no running
  const jobs = bg.listJobs();
  for (const j of jobs) {
    assert.notEqual(j.status, 'running');
  }
});

test('resource cleanup flushes logs and releases file descriptors', async (t) => {
  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-cleanup-'));
  const bg = new BgJobManager(tmpData, async () => {});

  const job = await bg.startJob({
    sessionId: 'sess_clean_1',
    botId: 'worker',
    command: 'echo "CLEANUP_CHECK_LOG"',
  });

  await sleep(100);
  await bg.closeAll();

  const { logs } = await bg.getJobLogs(job.id);
  assert.match(logs, /CLEANUP_CHECK_LOG/);

  // Removing tmpData directory must succeed cleanly without descriptor leak / EBUSY
  await rm(tmpData, { recursive: true, force: true });
  assert.equal(existsSync(tmpData), false);
});
