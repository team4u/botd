import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type BgJobRecord } from '@botd/protocol';
import { assertSafeId, ensureDir, getBotDir, readBotEnv } from './storage.js';
import { buildBotShellEnv, ensureBotdBinWrapper } from './runtime.js';
import { isWindows, resolveWindowsBash } from './windows-shell.js';
import { isSafePid, terminateProcessTree, type TerminateTreeOptions } from './process-tree.js';

export interface BgJobWakeInput {
  sessionId: string;
  botId: string;
  wakeupMessage: string;
  replyToBotId?: string;
  noTurn?: boolean;
}

export interface StartBgJobInput {
  sessionId: string;
  botId: string;
  command: string;
  replyToBotId?: string;
  noTurnOnComplete?: boolean;
}

interface JobEntry {
  record: BgJobRecord;
  child?: ChildProcess;
  logFd: fs.FileHandle | null;
  writeChain: Promise<unknown>;
  killRequested: boolean;
  settled: boolean;
  terminationPromise?: Promise<BgJobRecord>;
}

/** Managed background jobs (UNIX jobs/nohup philosophy): spawn a command in
 *  the bot workspace, tee its output to <workspace>/.bg/<jobId>.log, and wake
 *  the session automatically when the command exits. */
export class BgJobManager {
  private readonly jobs = new Map<string, JobEntry>();
  private closing = false;

  constructor(
    private readonly dataDir: string,
    private readonly onJobWake: (input: BgJobWakeInput) => Promise<void>,
    private readonly terminateOptions?: TerminateTreeOptions,
  ) {}

  private async cleanupEntryResources(entry: JobEntry): Promise<void> {
    if (entry.child) {
      try { entry.child.stdout?.destroy(); } catch {}
      try { entry.child.stderr?.destroy(); } catch {}
      try { entry.child.stdin?.destroy(); } catch {}
    }
    try {
      await entry.writeChain;
    } catch {}
    if (entry.logFd) {
      try {
        await entry.logFd.close();
      } catch {}
      entry.logFd = null;
    }
  }

  private async terminateEntry(entry: JobEntry): Promise<BgJobRecord> {
    if (entry.terminationPromise) {
      return entry.terminationPromise;
    }

    entry.terminationPromise = (async () => {
      // Do not overwrite finished/failed status to 'killed'
      if (entry.record.status !== 'running') {
        await this.cleanupEntryResources(entry);
        return entry.record;
      }

      entry.killRequested = true;

      try {
        await terminateProcessTree(entry.child, entry.record.pid, this.terminateOptions);
      } catch (err) {
        // Termination confirmation failed: processes still alive after force timeout!
        // Clear cached promise to allow subsequent retries.
        // Do NOT set record.status = 'killed'.
        entry.terminationPromise = undefined;
        throw err;
      }

      entry.record.status = 'killed';
      entry.record.finishedAt = new Date().toISOString();
      entry.settled = true;

      await this.cleanupEntryResources(entry);
      return entry.record;
    })();

    return entry.terminationPromise;
  }

  async startJob(input: StartBgJobInput): Promise<BgJobRecord> {
    if (this.closing) throw new Error('BgJobManager is shutting down');
    assertSafeId(input.sessionId, 'Session ID');
    assertSafeId(input.botId, 'Bot ID');
    if (input.replyToBotId) assertSafeId(input.replyToBotId, 'Reply-To Bot ID');
    if (typeof input.command !== 'string' || !input.command.trim()) {
      throw new Error('Command must be a non-empty string');
    }

    const jobId = `bg_${randomUUID().slice(0, 8)}`;
    const botDir = getBotDir(this.dataDir, input.botId);
    const workspaceDir = path.join(botDir, 'workspace');
    await ensureDir(workspaceDir);

    const bgDir = path.join(workspaceDir, '.bg');
    await ensureDir(bgDir);
    const logPath = path.join(bgDir, `${jobId}.log`);

    if (this.closing) throw new Error('BgJobManager is shutting down');

    // PATH: botd bin wrapper + Windows MinGit utils first, then inherited PATH.
    const binDir = await ensureBotdBinWrapper(this.dataDir);
    const botEnv = await readBotEnv(this.dataDir, input.botId).catch(() => ({}));
    const childEnv = buildBotShellEnv(process.env, {
      dataDir: this.dataDir,
      binDir,
      sessionId: input.sessionId,
      botId: input.botId,
      botEnv,
    });

    if (this.closing) throw new Error('BgJobManager is shutting down');

    const logFd = await fs.open(logPath, 'a').catch(() => null);

    const record: BgJobRecord = {
      id: jobId,
      sessionId: input.sessionId,
      botId: input.botId,
      command: input.command,
      cwd: workspaceDir,
      status: 'running',
      ...(input.replyToBotId ? { replyToBotId: input.replyToBotId } : {}),
      ...(input.noTurnOnComplete ? { noTurnOnComplete: true } : {}),
      logPath,
      startedAt: new Date().toISOString(),
    };

    const entry: JobEntry = {
      record,
      logFd,
      writeChain: Promise.resolve(),
      killRequested: false,
      settled: false,
    };

    this.jobs.set(jobId, entry);

    if (this.closing) {
      if (logFd) {
        await logFd.close().catch(() => {});
        entry.logFd = null;
      }
      this.jobs.delete(jobId);
      throw new Error('BgJobManager is shutting down');
    }

    const writeLog = (chunk: Buffer | string) => {
      if (!entry.logFd) return;
      entry.writeChain = entry.writeChain.then(async () => {
        if (entry.logFd) {
          await entry.logFd.appendFile(chunk).catch(() => {});
        }
      }).catch(() => {});
    };

    let child: ChildProcess;
    try {
      child = spawn(input.command, {
        cwd: workspaceDir,
        shell: isWindows ? resolveWindowsBash(this.dataDir) || true : (process.env.BOTD_SHELL_PATH || true),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWindows,
      });
      entry.child = child;
      if (typeof child.pid === 'number' && isSafePid(child.pid)) {
        record.pid = child.pid;
      }
    } catch (err: any) {
      record.status = 'failed';
      record.finishedAt = new Date().toISOString();
      entry.settled = true;
      if (logFd) {
        await logFd.close().catch(() => {});
        entry.logFd = null;
      }
      throw err;
    }

    if (this.closing) {
      await this.terminateEntry(entry);
      throw new Error('BgJobManager is shutting down');
    }

    child.stdout?.on('data', (chunk: Buffer) => writeLog(chunk));
    child.stderr?.on('data', (chunk: Buffer) => writeLog(chunk));

    child.on('error', async (err: Error) => {
      writeLog(`\nProcess spawn error: ${err.message}\n`);
      if (entry.killRequested) {
        // Was manually requested to terminate, wait for terminateEntry
        return;
      }

      if (!entry.settled) {
        record.status = 'failed';
        record.exitCode = null;
        record.finishedAt = new Date().toISOString();
        entry.settled = true;
        await this.cleanupEntryResources(entry);

        if (!this.closing) {
          const msg = `[Background Job ${jobId}] 命令 "${input.command}" 执行失败 (spawn error: ${err.message})`;
          await this.onJobWake({
            sessionId: input.sessionId,
            botId: input.botId,
            wakeupMessage: msg,
            ...(input.replyToBotId ? { replyToBotId: input.replyToBotId } : {}),
            ...(input.noTurnOnComplete ? { noTurn: true } : {}),
          }).catch(() => {});
        }
      }
    });

    child.on('close', async (code, signal) => {
      if (entry.killRequested) {
        // Direct child process exited during manual kill/closeAll.
        // Do NOT set record.status = 'killed' here: terminateEntry will confirm
        // the whole process tree has exited before finalizing 'killed'.
        // Do NOT trigger wake notification.
        // Flush writeChain so logs are flushed and not lost.
        try {
          await entry.writeChain;
        } catch {}
        return;
      }

      if (entry.settled) {
        await this.cleanupEntryResources(entry);
        return;
      }

      record.status = code === 0 ? 'done' : 'failed';
      record.exitCode = code ?? null;
      record.finishedAt = new Date().toISOString();
      entry.settled = true;

      await this.cleanupEntryResources(entry);

      if (this.closing) return;

      let tail = '';
      try {
        const content = await fs.readFile(logPath, 'utf8');
        tail = content.length > 2000 ? content.slice(-2000) : content;
        const lines = tail.split(/\r?\n/).filter((line) => line.length > 0);
        tail = lines.slice(-20).join('\n');
      } catch {
        tail = '';
      }

      const msg =
        `[Background Job ${jobId}] 命令 "${input.command}" 执行${record.status === 'done' ? '完成' : '失败'}` +
        ` (exit code: ${code ?? signal ?? 'unknown'})` +
        (tail ? `\n--- 输出摘要 ---\n${tail}` : '');

      await this.onJobWake({
        sessionId: input.sessionId,
        botId: input.botId,
        wakeupMessage: msg,
        ...(input.replyToBotId ? { replyToBotId: input.replyToBotId } : {}),
        ...(input.noTurnOnComplete ? { noTurn: true } : {}),
      }).catch(() => {});
    });

    return record;
  }

  listJobs(filter?: { sessionId?: string; botId?: string }): BgJobRecord[] {
    return Array.from(this.jobs.values())
      .map(({ record }) => record)
      .filter(
        (record) =>
          (!filter?.sessionId || record.sessionId === filter.sessionId) &&
          (!filter?.botId || record.botId === filter.botId),
      )
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async getJobLogs(jobId: string, tailLines = 100): Promise<{ job: BgJobRecord; logs: string }> {
    const entry = this.jobs.get(jobId);
    if (!entry) throw new Error(`Background job "${jobId}" not found`);
    await entry.writeChain.catch(() => {});
    const content = await fs.readFile(entry.record.logPath, 'utf8').catch(() => '');
    const lines = content.split(/\r?\n/);
    if (lines.length > tailLines) {
      return { job: entry.record, logs: lines.slice(-tailLines).join('\n') };
    }
    return { job: entry.record, logs: lines.join('\n') };
  }

  async killJob(jobId: string): Promise<BgJobRecord> {
    const entry = this.jobs.get(jobId);
    if (!entry) throw new Error(`Background job "${jobId}" not found`);
    return this.terminateEntry(entry);
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    const entries = Array.from(this.jobs.values());
    await Promise.all(entries.map((entry) => this.terminateEntry(entry)));
  }
}
