import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  isSafeId,
  type BotConfig,
  type WorkspaceDiffFile,
  type WorkspaceDiffResult,
  type WorkspaceSpaceInfo,
} from '@botd/protocol';
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
  boundWorkspaceDir?: string,
): Promise<string | null> {
  // 显式绑定的项目 Space（真实目录）：优先直接探测其所在仓库
  if (boundWorkspaceDir?.trim()) {
    const boundRoot = await gitRepoRoot(dataDir, boundWorkspaceDir.trim());
    if (boundRoot) return boundRoot;
  }

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
  input: { botId: string; sessionId?: string; workspaceDir?: string },
): Promise<WorkspaceDiffResult> {
  assertSafeId(input.botId, 'Bot ID');

  const botData = await readBot(dataDir, input.botId).catch(() => null);
  const bot: Pick<BotConfig, 'id' | 'parentBotId' | 'workspaceDir'> = botData?.bot ?? { id: input.botId };
  const { workspaceDir, sessionDir } = resolveBotPaths(dataDir, bot as BotConfig, input.workspaceDir);
  await ensureDir(workspaceDir).catch(() => {});

  const repoRoot = await resolveTargetGitRoot(dataDir, workspaceDir, sessionDir, input.sessionId, input.workspaceDir);
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

// --- Space（项目工作目录绑定）---

/**
 * 扫描节点上可绑定的项目 Space：
 * 默认扫 BOTD_CODE_DIR 或 ~/code 下的一级目录，同时包含进程当前目录；
 * 目录不存在时回退扫描 process.cwd() 的父目录（含 cwd 自身）。
 * 并发探测每个目录的 Git 仓库归属与当前分支。
 */
export async function listSpaces(dataDir: string): Promise<WorkspaceSpaceInfo[]> {
  const codeDir = process.env.BOTD_CODE_DIR || path.join(os.homedir(), 'code');
  const candidates = new Set<string>();
  if (existsSync(codeDir)) {
    const entries = await fs.readdir(codeDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.add(path.join(codeDir, entry.name));
    }
  } else {
    // 回退：扫描 cwd 的父目录下的一级目录（并包含 cwd 自身）
    const parentDir = path.dirname(process.cwd());
    if (existsSync(parentDir)) {
      const entries = await fs.readdir(parentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) candidates.add(path.join(parentDir, entry.name));
      }
    }
  }
  candidates.add(process.cwd());

  const spaces = await Promise.all(
    Array.from(candidates).map(async (dir) => {
      const root = await gitRepoRoot(dataDir, dir);
      if (!root) {
        return { path: dir, name: path.basename(dir) || dir, isGitRepo: false } satisfies WorkspaceSpaceInfo;
      }
      const branchRaw = await runGit(dataDir, ['rev-parse', '--abbrev-ref', 'HEAD'], root, 5_000);
      const branch = branchRaw?.trim();
      return {
        path: dir,
        name: path.basename(dir) || dir,
        ...(branch && branch !== 'HEAD' ? { branch } : {}),
        isGitRepo: true,
      } satisfies WorkspaceSpaceInfo;
    }),
  );
  return spaces.sort((a, b) => a.name.localeCompare(b.name));
}

/** 解析 listWorkspaceFiles / revertWorkspaceFile 的目标工作目录 */
async function resolveWorkspaceTargetDir(
  dataDir: string,
  input: { botId: string; sessionId?: string; workspaceDir?: string },
): Promise<string> {
  if (input.workspaceDir?.trim()) return path.resolve(input.workspaceDir.trim());

  assertSafeId(input.botId, 'Bot ID');
  const botData = await readBot(dataDir, input.botId).catch(() => null);
  const bot: Pick<BotConfig, 'id' | 'parentBotId' | 'workspaceDir'> = botData?.bot ?? { id: input.botId };
  const { workspaceDir, sessionDir } = resolveBotPaths(dataDir, bot as BotConfig);
  if (bot.workspaceDir?.trim()) return path.resolve(workspaceDir);

  const repoRoot = await resolveTargetGitRoot(dataDir, workspaceDir, sessionDir, input.sessionId);
  return repoRoot ?? workspaceDir;
}

/** 大小写不敏感的路径字符顺序子序列匹配（如 `pk/i` 匹配 `packages/protocol/index.ts`） */
function isFuzzySubsequence(query: string, target: string): boolean {
  let i = 0;
  for (const ch of target) {
    if (i < query.length && ch === query[i]) i++;
  }
  return i === query.length;
}

/** 匹配优先级：文件名包含 > 完整路径包含 > 字符顺序子序列 */
function matchScore(query: string, relPath: string): number {
  const lowerQuery = query.toLowerCase();
  const fileName = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase();
  const lowerPath = relPath.toLowerCase();
  if (fileName.includes(lowerQuery)) return 0;
  if (lowerPath.includes(lowerQuery)) return 1;
  if (isFuzzySubsequence(lowerQuery, lowerPath)) return 2;
  return -1;
}

/** 非 Git 目录回退：浅层（最多 2 层）文件扫描，忽略 .git / node_modules / dist 等 */
async function shallowListFiles(dir: string, maxEntries: number): Promise<string[]> {
  const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage']);
  const results: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 2 || results.length >= maxEntries) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= maxEntries) return;
      const rel = path.relative(dir, path.join(current, entry.name));
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name)) continue;
        await walk(path.join(current, entry.name), depth + 1);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  await walk(dir, 0);
  return results;
}

/**
 * 工作区文件模糊检索（前端 # 文件补全）：基于 `git ls-files -co --exclude-standard`
 * （非 Git 目录回退浅层扫描），按 query 子串/路径缩写匹配，默认最多返回 50 条。
 */
export async function listWorkspaceFiles(
  dataDir: string,
  input: { botId: string; sessionId?: string; workspaceDir?: string; query?: string; limit?: number },
): Promise<string[]> {
  const targetDir = await resolveWorkspaceTargetDir(dataDir, input);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const gitOut = await runGit(dataDir, ['-c', 'core.quotePath=false', 'ls-files', '-co', '--exclude-standard'], targetDir, 5_000);
  const files = gitOut !== null
    ? gitOut.split(/\r?\n/).filter(Boolean)
    : await shallowListFiles(targetDir, 2000);

  const query = input.query?.trim().toLowerCase();
  if (!query) return files.slice(0, limit);

  const scored = files
    .map((file) => ({ file, score: matchScore(query, file) }))
    .filter((item) => item.score >= 0);
  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((item) => item.file);
}

/**
 * 单文件一键回滚：已跟踪文件 `git checkout HEAD -- <path>`，未跟踪文件直接删除。
 * 严格校验路径不逃逸仓库根，防止路径穿越。
 */
export async function revertWorkspaceFile(
  dataDir: string,
  input: { botId: string; sessionId?: string; workspaceDir?: string; filePath: string },
): Promise<{ ok: boolean; error?: string }> {
  const filePath = input.filePath?.trim();
  if (!filePath) return { ok: false, error: 'filePath is required' };

  const targetDir = await resolveWorkspaceTargetDir(dataDir, input);
  const repoRoot = await gitRepoRoot(dataDir, targetDir);
  if (!repoRoot) return { ok: false, error: 'Not a Git repository' };

  const resolved = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: 'Invalid file path: outside repository root' };
  }

  // 检查文件在 Git 中的状态：未跟踪（??）直接删除，否则 checkout HEAD
  const statusOut = await runGit(
    dataDir,
    ['-c', 'core.quotePath=false', 'status', '--porcelain', '--', filePath],
    repoRoot,
    STATUS_TIMEOUT_MS,
  );
  if (statusOut === null) return { ok: false, error: 'Failed to read Git status' };

  const line = statusOut.split(/\r?\n/).find((l) => l.length >= 4);
  if (line?.startsWith('??')) {
    try {
      await fs.rm(resolved, { force: true });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to delete untracked file' };
    }
  }

  const checkoutOut = await runGit(dataDir, ['checkout', 'HEAD', '--', filePath], repoRoot, STATUS_TIMEOUT_MS);
  if (checkoutOut === null) {
    // 无 HEAD（空仓库）等场景：git 会失败，把原样错误返回给调用方
    return { ok: false, error: 'git checkout HEAD failed (repository may have no commits)' };
  }
  return { ok: true };
}
