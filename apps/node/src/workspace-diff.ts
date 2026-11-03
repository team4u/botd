import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSafeId, type BotConfig, type WorkspaceDiffFile, type WorkspaceDiffResult } from '@botd/protocol';
import { assertSafeId, ensureDir, readBot } from './storage.js';
import { resolveBotPaths } from './runtime/bot-context.js';
import { isWindows, windowsShellPathPrefix } from './windows-shell.js';

const execFileAsync = promisify(execFile);

/** 单文件读盘上限（未跟踪文件内容合成的 diff 头） */
const UNTRACKED_READ_BYTES = 16 * 1024;
const UNTRACKED_MAX_LINES = 200;
/** 单文件 diff 截断阈值 */
const FILE_DIFF_MAX_BYTES = 24 * 1024;
/** 全部文件 diff 累计上限：超过后不再填充后续 diff */
const TOTAL_DIFF_MAX_BYTES = 200 * 1024;
const MAX_FILES = 80;
const STATUS_TIMEOUT_MS = 8_000;
/** 会话 jsonl 尾部扫描窗口：从中提取工具调用触碰的候选路径 */
const SESSION_TAIL_BYTES = 64 * 1024;
const SESSION_MAX_SUBDIRS = 10;

async function runGit(dataDir: string, args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  const prependPath = isWindows ? windowsShellPathPrefix(dataDir) : [];
  const pathKey = isWindows
    ? (Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH')
    : 'PATH';
  const currentPath = process.env[pathKey] ?? '';
  const nextPath = [...prependPath, ...currentPath.split(path.delimiter).filter(Boolean)].join(path.delimiter);
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, [pathKey]: nextPath, PATH: nextPath },
    });
    return stdout;
  } catch {
    return null;
  }
}

/** `git rev-parse --show-toplevel`：目录不属于任何仓库时返回 null */
async function gitRepoRoot(dataDir: string, dir: string): Promise<string | null> {
  const out = await runGit(dataDir, ['rev-parse', '--show-toplevel'], dir, 5_000);
  const root = out?.trim();
  return root ? path.resolve(root) : null;
}

/** 解析 porcelain 行：`XY PATH` 或 `XY ORIG -> PATH`（core.quotePath=false 时路径不转义） */
function parsePorcelainLine(line: string): { status: WorkspaceDiffFile['status']; filePath: string; untracked: boolean } | null {
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  const rest = line.slice(3);
  const renamed = rest.indexOf(' -> ');
  const filePath = renamed >= 0 ? rest.slice(renamed + 4) : rest;
  if (!filePath) return null;
  if (xy === '??') return { status: 'A', filePath, untracked: true };
  let status: WorkspaceDiffFile['status'];
  if (xy.includes('A')) status = 'A';
  else if (xy.includes('D')) status = 'D';
  else if (xy.includes('R')) status = 'R';
  else if (xy.includes('U')) status = 'U';
  else status = 'M';
  return { status, filePath, untracked: false };
}

/** 从会话 jsonl 尾部提取工具调用携带的候选文件路径（倒序，最新在前） */
function extractCandidatePaths(tail: string): string[] {
  const paths: string[] = [];
  for (const rawLine of tail.split('\n')) {
    const idx = rawLine.indexOf('"path"');
    if (idx < 0) continue;
    const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rawLine.slice(idx));
    if (!match) continue;
    try {
      paths.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      // 非法转义：跳过该候选
    }
  }
  return paths.reverse();
}

/**
 * 智能定位 Git 仓库根：
 * 1. 会话 jsonl 中最近触碰且仍存在于磁盘的路径 → 其所在仓库
 * 2. 工作区目录本身
 * 3. 工作区的一级子目录（最多 10 个，覆盖 worktree/子代理隔离场景）
 */
async function resolveTargetGitRoot(
  dataDir: string,
  workspaceDir: string,
  sessionDir: string,
  sessionId?: string,
): Promise<string | null> {
  if (sessionId && isSafeId(sessionId)) {
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
    if (existsSync(sessionFile)) {
      let handle: fs.FileHandle | null = null;
      try {
        handle = await fs.open(sessionFile, 'r');
        const { size } = await handle.stat();
        const readLen = Math.min(size, SESSION_TAIL_BYTES);
        const buffer = Buffer.alloc(readLen);
        await handle.read(buffer, 0, readLen, size - readLen);
        for (const candidate of extractCandidatePaths(buffer.toString('utf8'))) {
          const absolute = path.isAbsolute(candidate) ? candidate : path.join(workspaceDir, candidate);
          const dir = path.dirname(absolute);
          if (!existsSync(dir)) continue;
          const root = await gitRepoRoot(dataDir, dir);
          if (root) return root;
        }
      } catch {
        // 读取失败：降级到工作区探测
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    }
  }

  const root = await gitRepoRoot(dataDir, workspaceDir);
  if (root) return root;

  const entries = await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  const subdirs = entries.filter((entry) => entry.isDirectory()).slice(0, SESSION_MAX_SUBDIRS);
  for (const subdir of subdirs) {
    const root = await gitRepoRoot(dataDir, path.join(workspaceDir, subdir.name));
    if (root) return root;
  }
  return null;
}

/** 未跟踪文件：直接读盘合成 unified diff（最多 200 行；二进制文件只标记不展开） */
async function buildUntrackedDiff(repoRoot: string, filePath: string): Promise<WorkspaceDiffFile> {
  let diff = 'Binary file';
  let additions = 0;
  try {
    const handle = await fs.open(path.join(repoRoot, filePath), 'r');
    try {
      const buffer = Buffer.alloc(UNTRACKED_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, UNTRACKED_READ_BYTES, 0);
      const content = buffer.subarray(0, bytesRead);
      if (!content.includes(0)) {
        const lines = content.toString('utf8').split(/\r?\n/).slice(0, UNTRACKED_MAX_LINES);
        // 末尾空行是文件尾换行的解析产物，不算一行内容
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
        additions = lines.length;
      }
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    // 读盘失败（权限/竞态删除）：保留 Binary file 占位
  }
  return { path: filePath, status: 'A', additions, deletions: 0, diff };
}

/** 已跟踪文件：`git diff HEAD -- <path>`（未生成分支回退到无 HEAD 版本），统计 +/- 行数 */
async function buildTrackedDiff(
  dataDir: string,
  repoRoot: string,
  filePath: string,
  status: WorkspaceDiffFile['status'],
): Promise<WorkspaceDiffFile> {
  let diff = await runGit(
    dataDir,
    ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--unified=3', '--', filePath],
    repoRoot,
    STATUS_TIMEOUT_MS,
  );
  if (diff === null) {
    diff = await runGit(
      dataDir,
      ['-c', 'core.quotePath=false', 'diff', '--unified=3', '--', filePath],
      repoRoot,
      STATUS_TIMEOUT_MS,
    );
  }
  const text = diff ?? '';
  let additions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++')) continue;
    if (line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { path: filePath, status, additions, deletions, diff: text };
}

/**
 * 查询 BOT 工作区的 Git 净变更（只读）：
 * 解析 porcelain 状态逐文件生成 unified diff，供前端「代码变更」抽屉展示。
 * 找不到 Git 仓库时返回 isGitRepo=false 与空列表，由前端回退到会话触碰文件。
 */
export async function getWorkspaceDiff(
  dataDir: string,
  input: { botId: string; sessionId?: string },
): Promise<WorkspaceDiffResult> {
  assertSafeId(input.botId, 'Bot ID');

  const botData = await readBot(dataDir, input.botId).catch(() => null);
  const bot: Pick<BotConfig, 'id' | 'parentBotId'> = botData?.bot ?? { id: input.botId };
  const { workspaceDir, sessionDir } = resolveBotPaths(dataDir, bot as BotConfig);
  await ensureDir(workspaceDir).catch(() => {});

  const repoRoot = await resolveTargetGitRoot(dataDir, workspaceDir, sessionDir, input.sessionId);
  if (!repoRoot) {
    return { isGitRepo: false, repoRoot: workspaceDir, files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  const branchRaw = await runGit(dataDir, ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, 5_000);
  const branch = branchRaw?.trim() || 'HEAD';

  const statusOut = await runGit(
    dataDir,
    ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'],
    repoRoot,
    STATUS_TIMEOUT_MS,
  );
  if (statusOut === null || statusOut.trim() === '') {
    return { isGitRepo: true, repoRoot, branch, files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  const parsed = statusOut
    .split(/\r?\n/)
    .map((line) => parsePorcelainLine(line))
    .filter((item): item is { status: WorkspaceDiffFile['status']; filePath: string; untracked: boolean } => item !== null);
  const limited = parsed.slice(0, MAX_FILES);
  let truncated = parsed.length > limited.length;

  const files: WorkspaceDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalDiffBytes = 0;

  for (const item of limited) {
    const file = item.untracked
      ? await buildUntrackedDiff(repoRoot, item.filePath)
      : await buildTrackedDiff(dataDir, repoRoot, item.filePath, item.status);

    totalAdditions += file.additions;
    totalDeletions += file.deletions;

    if (file.diff.length > FILE_DIFF_MAX_BYTES) {
      file.diff = file.diff.slice(0, FILE_DIFF_MAX_BYTES);
      file.truncated = true;
    }
    if (totalDiffBytes < TOTAL_DIFF_MAX_BYTES) {
      totalDiffBytes += file.diff.length;
      files.push(file);
    } else {
      file.diff = '';
      file.truncated = true;
      files.push(file);
      truncated = true;
    }
  }

  return {
    isGitRepo: true,
    repoRoot,
    branch,
    files,
    totalAdditions,
    totalDeletions,
    ...(truncated ? { truncated: true } : {}),
  };
}
