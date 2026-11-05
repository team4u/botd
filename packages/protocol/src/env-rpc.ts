/**
 * 远端执行环境 RPC 协议（Brain in Hub, Hands on Node）。
 *
 * Hub 通过本协议把 `@earendil-works/pi-durable` 的 `ExecutionEnv`（FileSystem + Shell）
 * 桥接到 Node 侧执行：文件操作、shell 执行与流式输出、Git Worktree 并发隔离，
 * 以及超级代理（Super-agent）共享的工作者/订阅/回忆链类型。
 *
 * 约定：所有跨 RPC 的二进制内容一律 base64 编码；错误以 `RpcEnvError` 结构返回而非抛出，
 * 便于 birpc/WebSocket 双向通道两侧统一还原为 `FileError` / `ExecutionError`。
 *
 * 注意：本文件保持零运行时依赖（与 cron.ts 一致）。`RpcFileKind` / `RpcFileErrorCode` /
 * `RpcExecutionErrorCode` / `RpcLineScan` 与 `@earendil-works/pi-durable/env` 中的同名类型
 * 结构完全一致（靠这种结构化兼容互通），升级 pi-durable 时需同步核对。
 */

// ---------------------------------------------------------------------------
// pi-durable env 类型的结构镜像（零依赖，见文件头说明）
// ---------------------------------------------------------------------------

export type RpcFileKind = 'file' | 'directory' | 'symlink';

export type RpcFileErrorCode =
  | 'aborted'
  | 'not_found'
  | 'permission_denied'
  | 'not_directory'
  | 'is_directory'
  | 'invalid'
  | 'not_supported'
  | 'unknown';

export type RpcExecutionErrorCode =
  | 'aborted'
  | 'timeout'
  | 'shell_unavailable'
  | 'spawn_error'
  | 'callback_error'
  | 'unknown';

/** `BinaryReader.scanLines` 的返回结构（pi-durable `LineScan` 的镜像）。 */
export interface RpcLineScan {
  newlines: number;
  start: number;
  end: number;
  firstLineEnd: number;
  lastLineStart: number;
  selectedBytes: number;
  firstLineBytes: number;
}

// ---------------------------------------------------------------------------
// RPC 基础结构
// ---------------------------------------------------------------------------

/** RPC 侧的失败结构：`code` 对应 `FileErrorCode` 或 `ExecutionErrorCode`。 */
export interface RpcEnvError {
  code: RpcFileErrorCode | RpcExecutionErrorCode;
  message: string;
  /** 产物文件（超时/中止后完整输出的 spill 文件），供 Hub 侧继续读取。 */
  spillPath?: string;
}

/** RPC 值形式：成功携带 value，失败携带 error 结构。 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcEnvError };

export interface RpcFileInfo {
  name: string;
  path: string;
  kind: RpcFileKind;
  size: number;
  mtimeMs: number;
}

export interface RpcTextLine {
  text: string;
  terminated: boolean;
}

/** 行读取器游标：Node 侧持有打开的句柄，Hub 侧只持有该 id。 */
export interface RpcTextReaderHandle {
  readerId: string;
}

export interface RpcBinaryReaderHandle {
  readerId: string;
}

export interface RpcDirReaderHandle {
  readerId: string;
}

/** 命令的一次输出分块（流式回调，Hub 侧实现）。 */
export interface EnvExecOutputEvent {
  execId: string;
  text: string;
  stream: 'stdout' | 'stderr';
  skipped?: { bytes: number; newlines: number; endsWithNewline: boolean };
}

export interface EnvExecSpillOptions {
  afterBytes: number;
  afterLines: number;
}

export interface EnvExecWindowOptions {
  maxBytes: number;
  maxLines: number;
  minIntervalMs: number;
  bytesPerSecond: number;
}

export interface EnvExecInput {
  /** 本次命令的唯一标识，由 Hub 生成；流式输出与 envAbortExec 均按它路由。 */
  execId: string;
  command: string | readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** 秒，与 pi-durable `ShellExecOptions.timeout` 一致。 */
  timeout?: number;
  spill?: EnvExecSpillOptions;
  window?: EnvExecWindowOptions;
}

export interface EnvExecOk {
  exitCode: number;
  spillPath?: string;
}

export interface EnvAcquireWorktreeInput {
  repoDir: string;
  workerId: string;
  branchPrefix?: string;
  /** 新 worktree 分支的起点引用（commit/branch/tag），缺省为 HEAD。 */
  baseRef?: string;
}

export interface EnvAcquireWorktreeResult {
  worktreePath: string;
  branchName: string;
  isGitRepo: boolean;
}

export interface EnvReleaseWorktreeInput {
  repoDir: string;
  worktreePath: string;
  branchName?: string;
  deleteBranch?: boolean;
}

export interface EnvReleaseWorktreeResult {
  ok: boolean;
}

/**
 * Node 侧实现、Hub 侧调用的远端 ExecutionEnv 函数集。
 * 每个方法对应 `ExecutionEnv` 的一个能力；参数均为可 JSON 序列化的普通对象。
 */
export interface NodeEnvRpcFunctions {
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

  /** 打开行读取器，返回 readerId；随后用 envTextReaderRead 拉取行。 */
  envOpenTextLineReader(input: { path: string; cwd?: string }): Promise<RpcResult<RpcTextReaderHandle>>;
  envTextReaderRead(input: { readerId: string }): Promise<RpcResult<RpcTextLine | null>>;
  envTextReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;

  /** 打开二进制读取器；info/read/scanLines 均按 readerId 定位。 */
  envOpenBinaryReader(input: { path: string; noFollow?: boolean; cwd?: string }): Promise<RpcResult<RpcBinaryReaderHandle>>;
  envBinaryReaderInfo(input: { readerId: string }): Promise<RpcResult<RpcFileInfo>>;
  /** base64 编码的字节区间读取。 */
  envBinaryReaderRead(input: { readerId: string; offset: number; length: number }): Promise<RpcResult<{ base64: string; byteLength: number }>>;
  envBinaryReaderScanLines(input: { readerId: string; startLine: number; endLine?: number }): Promise<RpcResult<RpcLineScan>>;
  envBinaryReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;

  /** 打开目录分页读取器；next 拉取至多 maxEntries 项。 */
  envOpenDirReader(input: { path: string; cwd?: string }): Promise<RpcResult<RpcDirReaderHandle>>;
  envDirReaderNext(input: { readerId: string; maxEntries: number }): Promise<RpcResult<{ entries: RpcFileInfo[]; done: boolean }>>;
  envDirReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;

  envExec(input: EnvExecInput): Promise<RpcResult<EnvExecOk>>;
  envAbortExec(execId: string): Promise<void>;
  envCleanup(cwd?: string): Promise<void>;

  /** Git Worktree 并发隔离：为 worker 在 <repoDir>/.botd-worktrees/<workerId> 下创建隔离工作树。 */
  envAcquireWorktree(input: EnvAcquireWorktreeInput): Promise<EnvAcquireWorktreeResult>;
  /** 释放并清理 worktree（--force 移除 + prune）；非 git 仓库时为幂等 no-op。 */
  envReleaseWorktree(input: EnvReleaseWorktreeInput): Promise<EnvReleaseWorktreeResult>;
}

/**
 * Hub 侧实现、Node 侧回调的流式输出函数集。
 * birpc 场景下与 `NodeEnvRpcFunctions` 组成双向通道。
 */
export interface HubEnvStreamFunctions {
  onEnvExecOutput(event: EnvExecOutputEvent): void;
}

// ---------------------------------------------------------------------------
// Super-agent 共享协议类型
// ---------------------------------------------------------------------------

/** 超级代理：一个活跃 worker（子代理会话）的运行摘要。 */
export interface ActiveWorkerSummary {
  workerId: string;
  conversationId: string;
  parentSessionId: string;
  botId: string;
  title: string;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'aborted';
  nodeId: string;
  cwd: string;
  /** 该 worker 的 Git Worktree 隔离路径（git 仓库时存在）。 */
  worktreePath?: string;
  threadKeys: string[];
  startedAt: string;
  updatedAt: string;
  currentTool?: string;
  summary?: string;
}

/** 父会话对 worker 线程的订阅记录（事件投递路由依据）。 */
export interface ThreadSubscriptionRecord {
  threadKey: string;
  workerConversationId: string;
  parentSessionId: string;
  botId: string;
  createdAt: string;
}

/** 回忆链引用：跨会话记忆锚点（Chain of Recall）。 */
export interface ChainOfRecallRef {
  id: string;
  kind: 'worker' | 'trigger' | 'entry' | 'artifact' | 'thread';
  summary: string;
  relatedIds: string[];
  createdAt: string;
}
