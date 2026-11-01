import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type BgJobRecord, type BgJobStatus } from '@botd/protocol';
import { assertSafeId, ensureDir, getBotDir, readBotEnv } from './storage.js';
import { ensureBotdBinWrapper } from './runtime.js';
import { isWindows, resolveWindowsBash, windowsShellPathPrefix } from './windows-shell.js';

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

/** Managed background jobs (UNIX jobs/nohup philosophy): spawn a command in
 *  the bot workspace, tee its output to <workspace>/.bg/<jobId>.log, and wake
 *  the session automatically when the command exits. */
export class BgJobManager {
  private readonly jobs = new Map<string, { record: BgJobRecord; child?: ChildProcess }>();
  private closing = false;

  constructor(
    private readonly dataDir: string,
    private readonly onJobWake: (input: BgJobWakeInput) => Promise<void>,
  ) {}

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

    // PATH: botd bin wrapper + Windows MinGit utils first, then inherited PATH.
    const binDir = await ensureBotdBinWrapper(this.dataDir);
    const botEnv = await readBotEnv(this.dataDir, input.botId).catch(() => ({}));
    const winPrefix = isWindows ? windowsShellPathPrefix(this.dataDir) : [];
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...botEnv,
      PATH: [binDir, ...winPrefix, process.env.PATH]
        .filter(Boolean)
        .join(path.delimiter),
      BOTD_SESSION_ID: input.sessionId,
      BOTD_BOT_ID: input.botId,
      BOTD_DATA_DIR: this.dataDir,
    };

    const logFd = await fs.open(logPath, 'a').catch(() => null);
    let writeChain: Promise<unknown> = Promise.resolve();
    const writeLog = (chunk: Buffer | string) => {
      if (!logFd) return;
      writeChain = writeChain.then(() => logFd.appendFile(chunk)).catch(() => {});
    };

    const child = spawn(input.command, {
      cwd: workspaceDir,
      shell: isWindows ? resolveWindowsBash(this.dataDir) || true : true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout?.on('data', (chunk: Buffer) => writeLog(chunk));
    child.stderr?.on('data', (chunk: Buffer) => writeLog(chunk));

    const record: BgJobRecord = {
      id: jobId,
      sessionId: input.sessionId,
      botId: input.botId,
      command: input.command,
      cwd: workspaceDir,
      ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
      status: 'running',
      ...(input.replyToBotId ? { replyToBotId: input.replyToBotId } : {}),
      ...(input.noTurnOnComplete ? { noTurnOnComplete: true } : {}),
      logPath,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, { record, child });

    child.on('close', async (code, signal) => {
      await writeChain;
      if (logFd) {
        await logFd.close().catch(() => {});
      }
      if (record.status === 'killed') {
        record.finishedAt = new Date().toISOString();
        return;
      }
      record.status = code === 0 ? 'done' : 'failed';
      record.exitCode = code ?? null;
      record.finishedAt = new Date().toISOString();

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
    const { record, child } = entry;
    if (record.status === 'running' && child) {
      record.status = 'killed';
      record.finishedAt = new Date().toISOString();
      child.kill('SIGTERM');
    }
    return record;
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    for (const { record, child } of this.jobs.values()) {
      if (record.status === 'running' && child && !child.killed) {
        record.status = 'killed';
        record.finishedAt = new Date().toISOString();
        try {
          child.kill('SIGTERM');
        } catch {
          // process may have already exited
        }
      }
    }
  }
}
