/**
 * Hub 侧远端执行环境（Brain in Hub, Hands on Node）。
 *
 * `RemoteExecutionEnv` 实现 pi-durable 的 `ExecutionEnv`（FileSystem + Shell），
 * 把每个操作翻译为对 Node 侧 `NodeEnvRpcFunctions` 的 RPC 调用：
 * - 文件与目录操作直连对应的 envXxx RPC；
 * - `openTextLineReader` / `openBinaryReader` / `openDirReader` 以 readerId 句柄桥接；
 * - `exec` 把 `onOutput` 分块经 `ExecOutputHub` 分发器回放（Node 侧流式推送，Hub 侧按 execId 路由）；
 * - BYOM 离线韧性（DeepSeek §5.2）：操作开始时节点离线且提供了 `waitForNodeOnline`，
 *   则等待节点重连（尊重 Chord context 取消）后无缝执行。
 *
 * 说明：本文件使用的 RPC 协议类型定义在 packages/protocol/src/env-rpc.ts，
 * 经 @botd/protocol 引入并 re-export，避免手抄镜像产生字段漂移。
 */

import { withoutAbortSignal, type Context } from '@earendil-works/chord/context';
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  RpcEnvError,
  RpcLineScan,
  RpcResult,
} from '@botd/protocol';
import { withSecretEnv } from './secret-stash.js';
import {
  ExecutionError,
  FileError,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileListing,
  type ListFilesOptions,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchTarget,
  type FileWatcher,
  type FileChange,
} from '@earendil-works/pi-durable/env';

// ---------------------------------------------------------------------------
// 协议类型（定义见 packages/protocol/src/env-rpc.ts）
// ---------------------------------------------------------------------------

export type {
  ActiveWorkerSummary,
  ChainOfRecallRef,
  EnvAcquireWorktreeInput,
  EnvAcquireWorktreeResult,
  EnvExecInput,
  EnvExecOk,
  EnvExecOutputEvent,
  EnvExecSpillOptions,
  EnvExecWindowOptions,
  EnvReleaseWorktreeInput,
  EnvReleaseWorktreeResult,
  HubEnvStreamFunctions,
  NodeEnvRpcFunctions,
  RpcBinaryReaderHandle,
  RpcDirReaderHandle,
  RpcEnvError,
  RpcFileErrorCode,
  RpcFileKind,
  RpcFileInfo,
  RpcLineScan,
  RpcResult,
  RpcTextLine,
  RpcTextReaderHandle,
  ThreadSubscriptionRecord,
} from '@botd/protocol';

// ---------------------------------------------------------------------------

/** 按 nodeId 解析 Node 侧 env RPC 的定位器（由宿主接线，如 ws-hub 的连接表）。 */
export interface NodeRpcResolver {
  getNodeEnvRpc(nodeId: string): NodeEnvRpcFunctions | undefined;
  /** BYOM 离线韧性：节点离线时等待重连（尊重 context 取消）；未提供则不等待。 */
  waitForNodeOnline?(nodeId: string, context: Context): Promise<NodeEnvRpcFunctions>;
}

export interface RemoteExecutionEnvOptions {
  nodeId: string;
  cwd: string;
  /**
   * 附加 shell 环境变量（会话/分身上下文注入，如 BOTD_SESSION_ID / BOTD_BOT_ID），逐调用 env 可覆盖。
   * 其中 BOTD_SESSION_ID 是机密注入的唯一信任作用域来源。
   */
  shellEnv?: Record<string, string>;
}

/**
 * 把流式输出事件按 execId 分发给等待中的 exec 调用。
 * 每个 `exec` 在发起 RPC 前注册 handler；Node 回调 `onEnvExecOutput` 时命中分发。
 */
export class ExecOutputHub {
  #handlers = new Map<string, (event: EnvExecOutputEvent) => void>();

  /** Node 侧流式回调入口（挂到 birpc 客户端的 onEnvExecOutput 上）。 */
  readonly onEnvExecOutput = (event: EnvExecOutputEvent): void => {
    this.#handlers.get(event.execId)?.(event);
  };

  subscribe(execId: string, handler: (event: EnvExecOutputEvent) => void): void {
    this.#handlers.set(execId, handler);
  }

  unsubscribe(execId: string): void {
    this.#handlers.delete(execId);
  }
}

let execSeq = 0;

const fileError = (error: RpcEnvError, path?: string): FileError =>
  new FileError(error.code as FileError['code'], error.message, path);

const execError = (error: RpcEnvError): ExecutionError => {
  const e = new ExecutionError(error.code as ExecutionError['code'], error.message);
  if (error.spillPath !== undefined) e.spillPath = error.spillPath;
  return e;
};

/** 以 ok/err 形式还原 RPC 结果。 */
const unwrapFile = <T>(result: RpcResult<T>, path?: string): Result<T, FileError> =>
  result.ok ? { ok: true, value: result.value } : { ok: false, error: fileError(result.error, path) };

/**
 * 远端 `ExecutionEnv`：所有文件与 shell 能力都在 nodeId 指向的 Node 上执行。
 * 离线时（且 resolver 支持 waitForNodeOnline）阻塞等待重连，而非立即失败。
 */
export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #resolver: NodeRpcResolver;
  readonly #outputHub: ExecOutputHub;
  readonly #nodeIdValue: string;
  readonly #shellEnv?: Record<string, string>;

  constructor(resolver: NodeRpcResolver, options: RemoteExecutionEnvOptions, outputHub = new ExecOutputHub()) {
    this.#resolver = resolver;
    this.cwd = options.cwd;
    this.id = `remote:${options.nodeId}`;
    this.#nodeIdValue = options.nodeId;
    this.#outputHub = outputHub;
    this.#shellEnv = options.shellEnv;
  }

  /** Node 侧流式回调入口（转发给内部 ExecOutputHub）。 */
  get onEnvExecOutput(): (event: EnvExecOutputEvent) => void {
    return this.#outputHub.onEnvExecOutput;
  }

  /** 取得在线节点的 RPC；离线且可等待时先等待（BYOM 离线韧性）。 */
  async #rpc(context: Context): Promise<NodeEnvRpcFunctions> {
    const rpc = this.#resolver.getNodeEnvRpc(this.#nodeIdValue);
    if (rpc !== undefined) return rpc;
    const wait = this.#resolver.waitForNodeOnline;
    if (wait !== undefined) {
      const restored = await wait(this.#nodeIdValue, context);
      if (restored !== undefined) return restored;
    }
    throw new Error(`Node ${this.#nodeIdValue} is offline`);
  }

  // ---- FileSystem ---------------------------------------------------------

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envAbsolutePath({ path, cwd: this.cwd }), path);
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envJoinPath({ parts, cwd: this.cwd }));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envReadTextFile({ path, cwd: this.cwd }), path);
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return unwrapFile(
      await (await this.#rpc(context)).envReadTextLines({ path, maxLines: options?.maxLines, cwd: this.cwd }),
      path,
    );
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const rpc = await this.#rpc(context);
    const result = await rpc.envOpenTextLineReader({ path, cwd: this.cwd });
    if (!result.ok) return unwrapFile(result, path);
    const { readerId } = result.value;
    const reader: TextLineReader = {
      readLine: async (_context: Context) => {
        const line = await rpc.envTextReaderRead({ readerId });
        if (!line.ok) return unwrapFile(line, path);
        return { ok: true, value: line.value ?? undefined };
      },
      close: async (_context: Context) => {
        await rpc.envTextReaderClose({ readerId });
      },
    };
    return { ok: true, value: reader };
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const result = await (await this.#rpc(context)).envReadBinaryFile({ path, cwd: this.cwd });
    if (!result.ok) return unwrapFile(result, path);
    return { ok: true, value: new Uint8Array(Buffer.from(result.value.base64, 'base64')) };
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const rpc = await this.#rpc(context);
    const result = await rpc.envOpenBinaryReader({ path, noFollow: options?.noFollow, cwd: this.cwd });
    if (!result.ok) return unwrapFile(result, path);
    const { readerId } = result.value;
    const reader: BinaryReader = {
      info: async (_context: Context) => unwrapFile(await rpc.envBinaryReaderInfo({ readerId }), path),
      read: async (offset: number, length: number, _context: Context): Promise<Result<Uint8Array, FileError>> => {
        const read = await rpc.envBinaryReaderRead({ readerId, offset, length });
        if (!read.ok) return unwrapFile(read, path);
        return { ok: true, value: new Uint8Array(Buffer.from(read.value.base64, 'base64')) };
      },
      scanLines: async (
        scan: { startLine: number; endLine?: number },
        _context: Context,
      ): Promise<Result<RpcLineScan, FileError>> =>
        unwrapFile(await rpc.envBinaryReaderScanLines({ readerId, ...scan }), path),
      close: async (_context: Context) => {
        await rpc.envBinaryReaderClose({ readerId });
      },
    };
    return { ok: true, value: reader };
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#write(path, content, false, context);
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#write(path, content, true, context);
  }

  async #write(path: string, content: string | Uint8Array, append: boolean, context: Context): Promise<Result<void, FileError>> {
    const rpc = await this.#rpc(context);
    const payload =
      typeof content === 'string'
        ? { content, encoding: 'utf8' as const }
        : { content: Buffer.from(content).toString('base64'), encoding: 'base64' as const };
    const result = append
      ? await rpc.envAppendFile({ path, ...payload, cwd: this.cwd })
      : await rpc.envWriteFile({ path, ...payload, cwd: this.cwd });
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: fileError(result.error, path) };
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const result = await (await this.#rpc(context)).envTruncateFile({ path, size, cwd: this.cwd });
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: fileError(result.error, path) };
  }

  async flushFile(_path: string, _context: Context): Promise<Result<void, FileError>> {
    // RPC 侧无对应操作：写路径上 Node 的 writeFile 已落盘，视为成功。
    return { ok: true, value: undefined };
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const result = await (await this.#rpc(context)).envRenameFile({ sourcePath, destinationPath, cwd: this.cwd });
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: fileError(result.error, sourcePath) };
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envFileInfo({ path, cwd: this.cwd }), path);
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envListDir({ path, cwd: this.cwd }), path);
  }

  async listFiles(path: string, _options: ListFilesOptions | undefined, context: Context): Promise<Result<FileListing, FileError>> {
    const result = await (await this.#rpc(context)).envListFiles({ path, cwd: this.cwd });
    if (!result.ok) return unwrapFile(result, path);
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } };
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const rpc = await this.#rpc(context);
    const result = await rpc.envOpenDirReader({ path, cwd: this.cwd });
    if (!result.ok) return unwrapFile(result, path);
    const { readerId } = result.value;
    const reader: DirReader = {
      next: async (maxEntries: number, _context: Context) =>
        unwrapFile(await rpc.envDirReaderNext({ readerId, maxEntries }), path),
      close: async (_context: Context) => {
        await rpc.envDirReaderClose({ readerId });
      },
    };
    return { ok: true, value: reader };
  }

  async watch(
    _targets: readonly WatchTarget[],
    onChange: (change: FileChange) => void,
    _context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    // 远端 watch 超出本协议范围：按契约返回 failed 变更 + not_supported，
    // 让宿主退回自己的轮询/刷新策略。
    onChange({ kind: 'failed', error: new FileError('not_supported', 'Remote env watch is not supported') });
    return { ok: true, value: { mode: 'polling', stop: async () => undefined } };
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envCanonicalPath({ path, cwd: this.cwd }), path);
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envExists({ path, cwd: this.cwd }), path);
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const result = await (await this.#rpc(context)).envCreateDir({ path, recursive: options?.recursive, cwd: this.cwd });
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: fileError(result.error, path) };
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const result = await (await this.#rpc(context)).envRemove({
      path,
      recursive: options?.recursive,
      force: options?.force,
      cwd: this.cwd,
    });
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: fileError(result.error, path) };
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envCreateTempDir({ prefix, cwd: this.cwd }));
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return unwrapFile(await (await this.#rpc(context)).envCreateTempFile({ prefix: options?.prefix, suffix: options?.suffix, cwd: this.cwd }));
  }

  async cleanup(context: Context): Promise<void> {
    // 清理不能被会话取消阻断：用剥离取消信号的 context 确保节点侧临时目录仍被回收。
    await (await this.#rpc(withoutAbortSignal(context))).envCleanup(this.cwd).catch(() => undefined);
  }

  // ---- Shell ---------------------------------------------------------------

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) {
      return { ok: false, error: new ExecutionError('aborted', 'Command aborted') };
    }
    const rpc = await this.#rpc(context);
    const execId = `exec-${++execSeq}-${Math.random().toString(36).slice(2, 8)}`;
    const onOutput = options?.onOutput;
    if (onOutput !== undefined) {
      this.#outputHub.subscribe(execId, (event) => {
        onOutput(event.text, context, {
          stream: event.stream,
          ...(event.skipped === undefined ? {} : { skipped: event.skipped }),
        });
      });
    }
    // 取消传播：会话 abort 时立刻通知 Node 侧杀掉子进程，而不是等命令自然结束。
    const signal = context.abortSignal;
    const onAbort = () => {
      void rpc.envAbortExec(execId).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // 会话 shellEnv 与逐调用 env 合并（逐调用优先），再叠加 SecretStash 机密注入。
      const mergedEnv =
        this.#shellEnv !== undefined || options?.env !== undefined
          ? { ...(this.#shellEnv ?? {}), ...(options?.env ?? {}) }
          : undefined;
      const result = await rpc.envExec({
        execId,
        command,
        ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
        // SecretStash：机密以环境变量注入远端子进程（明文不进命令行/上下文）。
        // 作用域只收信任的会话 shellEnv，绝不从逐调用 env 推断（可伪造）；
        // 无可信作用域时不注入任何机密（fail-closed）。
        env: withSecretEnv(mergedEnv, this.#shellEnv?.BOTD_SESSION_ID),
        ...(options?.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options?.spill === undefined ? {} : { spill: options.spill }),
        ...(options?.window === undefined ? {} : { window: options.window }),
      });
      if (context.abortSignal?.aborted) {
        return { ok: false, error: new ExecutionError('aborted', 'Command aborted') };
      }
      if (result.ok) {
        return {
          ok: true,
          value: { exitCode: result.value.exitCode, ...(result.value.spillPath === undefined ? {} : { spillPath: result.value.spillPath }) },
        };
      }
      return { ok: false, error: execError(result.error) };
    } catch (err) {
      // 取消导致的连接中断/拒收也归一为 aborted，而不是上抛网络错误。
      if (context.abortSignal?.aborted) {
        return { ok: false, error: new ExecutionError('aborted', 'Command aborted') };
      }
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#outputHub.unsubscribe(execId);
    }
  }

  /** 取消指定的运行中命令（透传 Node 侧 envAbortExec）。 */
  async abortExec(execId: string, context: Context): Promise<void> {
    await (await this.#rpc(context)).envAbortExec(execId);
  }

  /** 获取底层 ExecOutputHub（宿主挂接 birpc 回调用）。 */
  get outputHub(): ExecOutputHub {
    return this.#outputHub;
  }
}
