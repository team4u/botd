import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = (repoDir: string, ...args: string[]) =>
  run('git', ['-C', repoDir, ...args], { env: { ...process.env, LC_ALL: 'C' } });

/** Only an explicit non-repository result permits execution without isolation. */
async function isGitRepo(repoDir: string): Promise<boolean> {
  try {
    const probe = await git(repoDir, 'rev-parse', '--git-dir');
    if (probe.stdout.trim()) return true;
    throw new Error('git returned an empty repository path');
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string };
    if (failure.code === 128 && /not a git repository/i.test(failure.stderr ?? '')) return false;
    throw new Error(`无法探测 ${repoDir} 的 git 仓库状态：${failure.stderr?.trim() || String(error)}`);
  }
}

/** Reuse registered worktrees without discarding changes; every real Git failure propagates. */
export async function acquireLocalWorktree(repoDir: string, worktreePath: string, branchName: string): Promise<string> {
  if (!(await isGitRepo(repoDir))) return repoDir;
  const resolvedPath = path.resolve(worktreePath);
  if (resolvedPath === path.resolve(repoDir)) throw new Error('隔离 worktree 不能复用主工作区');
  if (existsSync(resolvedPath)) {
    const listing = await git(repoDir, 'worktree', 'list', '--porcelain', '-z');
    const registered = listing.stdout.split('\0').some((field) =>
      field.startsWith('worktree ') && path.resolve(field.slice('worktree '.length)) === resolvedPath,
    );
    if (registered) return resolvedPath;
    throw new Error(`路径 ${worktreePath} 已存在但不是 ${repoDir} 的 git worktree，拒绝复用以避免假隔离`);
  }
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  try {
    await git(repoDir, 'worktree', 'add', '-B', branchName, resolvedPath, 'HEAD');
  } catch (error) {
    const failure = error as { stderr?: string };
    throw new Error(`在 git 仓库 ${repoDir} 获取 worktree ${worktreePath} 失败：${failure.stderr?.trim() || String(error)}`);
  }
  return resolvedPath;
}
