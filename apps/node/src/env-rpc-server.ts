/**
 * Node 侧远端执行环境 RPC 服务端（Brain in Hub, Hands on Node）。
 *
 * 用 `NodeExecutionEnv` 承载真实文件系统与 shell 能力，按 RPC 协议
 * （`packages/protocol/src/env-rpc.ts` 的 `NodeEnvRpcFunctions`）暴露给 Hub：
 * - 每个 cwd 缓存一个 `NodeExecutionEnv`（cwd 变更即换实例，互不污染）；
 * - `envExec` 以 `withCancel` 派生可取消 Context，`envAbortExec(execId)` 立即终止该命令；
 * - 每个 `NodeExecutionEnv` 以 `shellEnv`（buildBotShellEnv 结果）为基底：
 *   PATH 头部挂 ~/.botd/bin（botd CLI 包装器）、写入 BOTD_DATA_DIR，
 *   AI Worker 在回合内执行 bash 时可直接调用 `botd` 命令；
 * - 输出经 `onExecOutput` 回调流式回传 Hub（birpc/WebSocket 双向通道的另一侧）；
 * - Git Worktree 并发隔离：`envAcquireWorktree` 在 `<repoDir>/.botd-worktrees/<workerId>`
 *   下以 `git worktree add -B botd/<workerId> <path> HEAD` 创建隔离工作树，
 *   取代旧的全局工作区互斥锁，两个 worker 可并发改同一文件互不干扰。
 *
 * 说明：本文件的本地 RPC 类型是协议文件的结构镜像（协议包的 index 未导出 env-rpc，
 * 跨包源引用会破坏 rootDir），由 tests/remote-env-worktree.test.ts 做结构一致性校验。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { withCancel, type Context } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import {
  err,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionErrorCode,
  type FileErrorCode,
  type Result,
  type TextLineReader,
} from '@earendil-works/pi-durable/env';

// ---------------------------------------------------------------------------
// 协议类型镜像（与 packages/protocol/src/env-rpc.ts 保持结构一致）
// ---------------------------------------------------------------------------

type RpcFileKind = 'file' | 'directory' | 'symlink';
type RpcErrorCode = FileErrorCode | ExecutionErrorCode;

interface RpcEnvError {
  code: RpcErrorCode;
  message: string;
  spillPath?: string;
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcEnvError };

interface RpcFileInfo {
  name: string;
  path: string;
  kind: RpcFileKind;
  size: number;
  mtimeMs: number;
}

interface RpcTextLine {
  text: string;
  terminated: boolean;
}

interface EnvExecOutputEvent {
  execId: string;
  text: string;
  stream: 'stdout' | 'stderr';
  skipped?: { bytes: number; newlines: number; endsWithNewline: boolean };
}

interface EnvExecInput {
  execId: string;
  command: string | readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeout?: number;
  spill?: { afterBytes: number; afterLines: number };
  window?: { maxBytes: number; maxLines: number; minIntervalMs: number; bytesPerSecond: number };
}

interface EnvExecOk {
  exitCode: number;
  spillPath?: string;
}

interface EnvAcquireWorktreeInput {
  repoDir: string;
  workerId: string;
  branchPrefix?: string;
}

interface EnvAcquireWorktreeResult {
  worktreePath: string;
  branchName: string;
  isGitRepo: boolean;
}

interface EnvReleaseWorktreeInput {
  repoDir: string;
  worktreePath: string;
  branchName?: string;
  deleteBranch?: boolean;
}

interface NodeEnvRpcFunctions {
  envAbsolutePath(input: { path: string; cwd?: string }): Promise<RpcResult<string>>;
  envJoinPath(input: { parts: string[]; cwd?: string }): Promise<RpcResult<string>>;
  envReadTextFile(input: { path: string; cwd?: string }): Promise<RpcResult<string>>;
  envReadTextLines(input: { path: string; maxLines?: number; cwd?: string }): Promise<RpcResult<string[]>>;
  envReadBinaryFile(input: { path: string; cwd?: string }): Promise<RpcResult<{ base64: string }>>;
  envWriteFile(input: { path: string; content: string; encoding?: 'utf8' | 'base64'; cwd?: string }): Promise<RpcResult<null>>;
  envAppendFile(input: { path: string; content: string; encoding?: 'utf8' | 'base64'; cwd?: string }): Promise<RpcResult<null>>;
  envTruncateFile(input: { path: string; size: number; cwd?: string }): Promise<RpcResult<null>>;
  envRenameFile(input: { sourcePath: string; destinationPath: string; cwd?: string }): Promise<RpcResult<null>>;
  envFileInfo(input: { path: string; cwd?: string }): Promise<RpcResult<RpcFileInfo>>;
  envListDir(input: { path: string; cwd?: string }): Promise<RpcResult<RpcFileInfo[]>>;
  envListFiles(input: { path: string; cwd?: string }): Promise<RpcResult<{ entries: { path: string; kind: RpcFileKind }[]; truncated: boolean }>>;
  envCanonicalPath(input: { path: string; cwd?: string }): Promise<RpcResult<string>>;
  envExists(input: { path: string; cwd?: string }): Promise<RpcResult<boolean>>;
  envCreateDir(input: { path: string; recursive?: boolean; cwd?: string }): Promise<RpcResult<null>>;
  envRemove(input: { path: string; recursive?: boolean; force?: boolean; cwd?: string }): Promise<RpcResult<null>>;
  envCreateTempDir(input: { prefix?: string; cwd?: string }): Promise<RpcResult<string>>;
  envCreateTempFile(input: { prefix?: string; suffix?: string; cwd?: string }): Promise<RpcResult<string>>;
  envOpenTextLineReader(input: { path: string; cwd?: string }): Promise<RpcResult<{ readerId: string }>>;
  envTextReaderRead(input: { readerId: string }): Promise<RpcResult<RpcTextLine | null>>;
  envTextReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;
  envOpenBinaryReader(input: { path: string; noFollow?: boolean; cwd?: string }): Promise<RpcResult<{ readerId: string }>>;
  envBinaryReaderInfo(input: { readerId: string }): Promise<RpcResult<RpcFileInfo>>;
  envBinaryReaderRead(input: { readerId: string; offset: number; length: number }): Promise<RpcResult<{ base64: string; byteLength: number }>>;
  envBinaryReaderScanLines(input: { readerId: string; startLine: number; endLine?: number }): Promise<RpcResult<import('@earendil-works/pi-durable/env').LineScan>>;
  envBinaryReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;
  envOpenDirReader(input: { path: string; cwd?: string }): Promise<RpcResult<{ readerId: string }>>;
  envDirReaderNext(input: { readerId: string; maxEntries: number }): Promise<RpcResult<{ entries: RpcFileInfo[]; done: boolean }>>;
  envDirReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;
  envExec(input: EnvExecInput): Promise<RpcResult<EnvExecOk>>;
  envAbortExec(execId: string): Promise<void>;
  envCleanup(cwd?: string): Promise<void>;
  envAcquireWorktree(input: EnvAcquireWorktreeInput): Promise<EnvAcquireWorktreeResult>;
  envReleaseWorktree(input: EnvReleaseWorktreeInput): Promise<{ ok: boolean }>;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

const toRpcError = (error: unknown): RpcEnvError => {
  const anyError = error as { code?: string; message?: string; spillPath?: string } | null;
  if (anyError && typeof anyError === 'object' && anyError.code && anyError.message !== undefined) {
    return {
      code: anyError.code as RpcErrorCode,
      message: anyError.message,
      ...(anyError.spillPath !== undefined ? { spillPath: anyError.spillPath } : {}),
    };
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
};

const rpcFail = <T>(error: unknown): RpcResult<T> => ({ ok: false, error: toRpcError(error) });

const BACKGROUND: Context = {
  abortSignal: undefined,
  telemetry: undefined as unknown as Context['telemetry'],
  value: () => undefined,
  toString: () => 'botd-node-env-rpc',
};

export interface NodeEnvRpcServerOptions {
  defaultCwd: string;
  /** shell 输出流式回调（通常转发回 Hub 的 onEnvExecOutput）。 */
  onExecOutput?: (event: EnvExecOutputEvent) => void;
  /**
   * 注入到每个 shell 子进程的环境（Brain in Hub, Hands on Node）：
   * 通常由 daemon 传入 buildBotShellEnv() 的结果——把 ~/.botd/bin（botd CLI 包装器）
   * 挂到 PATH 头部并写入 BOTD_DATA_DIR，让 Worker 在回合内直接可用 `botd` 命令。
   */
  shellEnv?: Record<string, string | undefined>;
}

interface RunningExec {
  cancel: (reason?: unknown) => void;
}

/**
 * 创建 Node 侧 env RPC 函数集。返回对象可直接挂到 birpc server 上：
 * `createNodeEnvRpcServer({ defaultCwd, onExecOutput: (e) => hubNotify.onEnvExecOutput(e) })`
 */
export function createNodeEnvRpcServer(options: NodeEnvRpcServerOptions): NodeEnvRpcFunctions {
  const { defaultCwd, onExecOutput, shellEnv } = options;

  const envs = new Map<string, NodeExecutionEnv>();
  const envFor = (cwd?: string): NodeExecutionEnv => {
    const base = cwd ?? defaultCwd;
    let env = envs.get(base);
    if (env === undefined) {
      env = new NodeExecutionEnv({ cwd: base, ...(shellEnv ? { shellEnv: shellEnv as NodeJS.ProcessEnv } : {}) });
      envs.set(base, env);
    }
    return env;
  };

  // ---- reader 句柄注册表 -------------------------------------------------
  type ReaderHandle =
    | { kind: 'text'; reader: TextLineReader }
    | { kind: 'binary'; reader: BinaryReader }
    | { kind: 'dir'; reader: DirReader };

  const readers = new Map<string, ReaderHandle>();
  let readerSeq = 0;
  const putReader = (handle: ReaderHandle): string => {
    const id = `r${++readerSeq}`;
    readers.set(id, handle);
    return id;
  };

  const running = new Map<string, RunningExec>();

  /** pi-durable Result -> RpcResult（void 结果归一为 null，便于 JSON 序列化）。 */
  const unwrap = async <T>(promise: Promise<Result<T, unknown>>): Promise<RpcResult<T extends void ? null : T>> => {
    try {
      const result = await promise;
      return result.ok ? { ok: true, value: (result.value ?? null) as T extends void ? null : T } : rpcFail(result.error);
    } catch (error) {
      return rpcFail(error);
    }
  };

  const getReader = <R extends TextLineReader | BinaryReader | DirReader>(
    readerId: string,
    kind: ReaderHandle['kind'],
  ): R | undefined => {
    const handle = readers.get(readerId);
    return handle !== undefined && handle.kind === kind ? (handle.reader as R) : undefined;
  };

  const rpc: NodeEnvRpcFunctions = {
    async envAbsolutePath({ path, cwd }) {
      return unwrap(envFor(cwd).absolutePath(path, BACKGROUND));
    },
    async envJoinPath({ parts, cwd }) {
      return unwrap(envFor(cwd).joinPath(parts, BACKGROUND));
    },

    async envReadTextFile({ path, cwd }) {
      return unwrap(envFor(cwd).readTextFile(path, BACKGROUND));
    },
    async envReadTextLines({ path, maxLines, cwd }) {
      return unwrap(envFor(cwd).readTextLines(path, { maxLines }, BACKGROUND));
    },
    async envReadBinaryFile({ path, cwd }) {
      const result = await envFor(cwd).readBinaryFile(path, BACKGROUND);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { base64: Buffer.from(result.value).toString('base64') } };
    },

    async envWriteFile({ path, content, encoding, cwd }) {
      const bytes = encoding === 'base64' ? new Uint8Array(Buffer.from(content, 'base64')) : content;
      return unwrap(envFor(cwd).writeFile(path, bytes, BACKGROUND));
    },
    async envAppendFile({ path, content, encoding, cwd }) {
      const bytes = encoding === 'base64' ? new Uint8Array(Buffer.from(content, 'base64')) : content;
      return unwrap(envFor(cwd).appendFile(path, bytes, BACKGROUND));
    },
    async envTruncateFile({ path, size, cwd }) {
      return unwrap(envFor(cwd).truncateFile(path, size, BACKGROUND));
    },
    async envRenameFile({ sourcePath, destinationPath, cwd }) {
      return unwrap(envFor(cwd).renameFile(sourcePath, destinationPath, BACKGROUND));
    },

    async envFileInfo({ path, cwd }) {
      return unwrap(envFor(cwd).fileInfo(path, BACKGROUND));
    },
    async envListDir({ path, cwd }) {
      return unwrap(envFor(cwd).listDir(path, BACKGROUND));
    },
    async envListFiles() {
      // NodeExecutionEnv 未实现可选的 listFiles：按协议返回 not_supported，调用方自行回退遍历。
      return { ok: false, error: { code: 'not_supported', message: 'listFiles is not available on this environment' } };
    },
    async envCanonicalPath({ path, cwd }) {
      return unwrap(envFor(cwd).canonicalPath(path, BACKGROUND));
    },
    async envExists({ path, cwd }) {
      return unwrap(envFor(cwd).exists(path, BACKGROUND));
    },

    async envCreateDir({ path, recursive, cwd }) {
      return unwrap(envFor(cwd).createDir(path, { recursive }, BACKGROUND));
    },
    async envRemove({ path, recursive, force, cwd }) {
      return unwrap(envFor(cwd).remove(path, { recursive, force }, BACKGROUND));
    },
    async envCreateTempDir({ prefix, cwd }) {
      return unwrap(envFor(cwd).createTempDir(prefix, BACKGROUND));
    },
    async envCreateTempFile({ prefix, suffix, cwd }) {
      return unwrap(envFor(cwd).createTempFile({ prefix, suffix }, BACKGROUND));
    },

    async envOpenTextLineReader({ path, cwd }) {
      const result = await envFor(cwd).openTextLineReader(path, BACKGROUND);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: putReader({ kind: 'text', reader: result.value }) } };
    },
    async envTextReaderRead({ readerId }) {
      const reader = getReader<TextLineReader>(readerId, 'text');
      if (reader === undefined) {
        return { ok: false, error: { code: 'not_found', message: `Unknown text reader: ${readerId}` } };
      }
      const result = await reader.readLine(BACKGROUND);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: result.value ?? null };
    },
    async envTextReaderClose({ readerId }) {
      const reader = getReader<TextLineReader>(readerId, 'text');
      if (reader !== undefined) {
        readers.delete(readerId);
        await reader.close(BACKGROUND).catch(() => undefined);
      }
      return { ok: true, value: null };
    },

    async envOpenBinaryReader({ path, noFollow, cwd }) {
      const result = await envFor(cwd).openBinaryReader(path, { noFollow }, BACKGROUND);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: putReader({ kind: 'binary', reader: result.value }) } };
    },
    async envBinaryReaderInfo({ readerId }) {
      const reader = getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) {
        return { ok: false, error: { code: 'not_found', message: `Unknown binary reader: ${readerId}` } };
      }
      return unwrap(reader.info(BACKGROUND));
    },
    async envBinaryReaderRead({ readerId, offset, length }) {
      const reader = getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) {
        return { ok: false, error: { code: 'not_found', message: `Unknown binary reader: ${readerId}` } };
      }
      const result = await reader.read(offset, length, BACKGROUND);
      if (!result.ok) return rpcFail(result.error);
      return {
        ok: true,
        value: { base64: Buffer.from(result.value).toString('base64'), byteLength: result.value.byteLength },
      };
    },
    async envBinaryReaderScanLines({ readerId, startLine, endLine }) {
      const reader = getReader<BinaryReader>(readerId, 'binary');
      if (reader === undefined) {
        return { ok: false, error: { code: 'not_found', message: `Unknown binary reader: ${readerId}` } };
      }
      return unwrap(reader.scanLines({ startLine, ...(endLine === undefined ? {} : { endLine }) }, BACKGROUND));
    },
    async envBinaryReaderClose({ readerId }) {
      const reader = getReader<BinaryReader>(readerId, 'binary');
      if (reader !== undefined) {
        readers.delete(readerId);
        await reader.close(BACKGROUND).catch(() => undefined);
      }
      return { ok: true, value: null };
    },

    async envOpenDirReader({ path, cwd }) {
      const result = await envFor(cwd).openDirReader(path, BACKGROUND);
      if (!result.ok) return rpcFail(result.error);
      return { ok: true, value: { readerId: putReader({ kind: 'dir', reader: result.value }) } };
    },
    async envDirReaderNext({ readerId, maxEntries }) {
      const reader = getReader<DirReader>(readerId, 'dir');
      if (reader === undefined) {
        return { ok: false, error: { code: 'not_found', message: `Unknown dir reader: ${readerId}` } };
      }
      return unwrap(reader.next(maxEntries, BACKGROUND));
    },
    async envDirReaderClose({ readerId }) {
      const reader = getReader<DirReader>(readerId, 'dir');
      if (reader !== undefined) {
        readers.delete(readerId);
        await reader.close(BACKGROUND).catch(() => undefined);
      }
      return { ok: true, value: null };
    },

    async envExec(input: EnvExecInput): Promise<RpcResult<EnvExecOk>> {
      const { execId, command, cwd, env, inheritEnv, timeout, spill, window } = input;
      const executionEnv = envFor(cwd);
      const { context, cancel } = withCancel(BACKGROUND);
      running.set(execId, { cancel });
      try {
        const result = await executionEnv.exec(
          command,
          {
            ...(cwd === undefined ? {} : { cwd }),
            ...(env === undefined ? {} : { env }),
            ...(inheritEnv === undefined ? {} : { inheritEnv }),
            ...(timeout === undefined ? {} : { timeout }),
            ...(spill === undefined ? {} : { spill }),
            ...(window === undefined ? {} : { window }),
            ...(onExecOutput === undefined
              ? {}
              : {
                  onOutput: (
                    text: string,
                    _context: Context,
                    info: { stream: 'stdout' | 'stderr'; skipped?: { bytes: number; newlines: number; endsWithNewline: boolean } },
                  ) => {
                    onExecOutput({ execId, text, stream: info.stream, ...(info.skipped === undefined ? {} : { skipped: info.skipped }) });
                  },
                }),
          },
          context,
        );
        return result.ok
          ? {
              ok: true,
              value: { exitCode: result.value.exitCode, ...(result.value.spillPath === undefined ? {} : { spillPath: result.value.spillPath }) },
            }
          : rpcFail(result.error);
      } finally {
        running.delete(execId);
      }
    },

    async envAbortExec(execId: string): Promise<void> {
      running.get(execId)?.cancel(new Error('aborted by hub'));
    },

    async envCleanup(cwd?: string): Promise<void> {
      await Promise.all(
        [...envs.values()].map(async (env) => {
          if (cwd !== undefined && env.cwd !== cwd) return;
          await env.cleanup(BACKGROUND).catch(() => undefined);
        }),
      );
    },

    async envAcquireWorktree({ repoDir, workerId, branchPrefix }): Promise<EnvAcquireWorktreeResult> {
      const notARepo = (): EnvAcquireWorktreeResult => ({ worktreePath: repoDir, branchName: '', isGitRepo: false });
      const git = (...args: string[]) => runGit(repoDir, args);
      const probe = await git('rev-parse', '--is-inside-work-tree');
      if (!probe.ok || probe.value.exitCode !== 0 || probe.value.stdout.trim() !== 'true') return notARepo();

      const branchName = `${branchPrefix ?? 'botd'}/${workerId}`;
      const worktreePath = join(repoDir, '.botd-worktrees', workerId);
      // 已存在则先清理，保证幂等
      await git('worktree', 'remove', '--force', worktreePath).catch(() => undefined);
      await git('worktree', 'prune').catch(() => undefined);
      const add = await git('worktree', 'add', '-B', branchName, worktreePath, 'HEAD');
      if (!add.ok || add.value.exitCode !== 0) return notARepo();
      return { worktreePath, branchName, isGitRepo: true };
    },

    async envReleaseWorktree({ repoDir, worktreePath, branchName, deleteBranch }): Promise<{ ok: boolean }> {
      const git = (...args: string[]) => runGit(repoDir, args);
      await git('worktree', 'remove', '--force', worktreePath).catch(() => undefined);
      await git('worktree', 'prune').catch(() => undefined);
      if (deleteBranch === true && branchName) {
        await git('branch', '-D', branchName).catch(() => undefined);
      }
      return { ok: true };
    },
  };

  return rpc;
}

/** 服务端内部 git 子进程执行（一次性，与 envExec 的流式通道无关）。 */
function runGit(cwd: string, args: string[]): Promise<Result<{ exitCode: number; stdout: string }, Error>> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', () => undefined);
    child.on('error', (error) => resolve(err(error)));
    child.on('close', (exitCode) => resolve(ok({ exitCode: exitCode ?? -1, stdout })));
  });
}
