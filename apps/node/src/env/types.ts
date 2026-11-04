/**
 * 执行环境的类型定义（@earendil-works/pi-durable env 接口的结构子集，
 * 仅覆盖 env-rpc-server 用到的文件系统 / reader / shell 能力）。
 */

import type { Context } from './context.js';
import type { ExecutionError, FileError, Result } from './errors.js';
import type { LineScan } from './line-scan.js';

export type { Context } from './context.js';
export { BACKGROUND_CONTEXT, withCancel } from './context.js';
export type { LineScan } from './line-scan.js';
export { LineScanner } from './line-scan.js';
export { StreamDecoder, rangeDecoder, startsWithBom } from './decode.js';
export { err, ok, toError, ExecutionError, FileError } from './errors.js';
export type { Result, FileKind, FileErrorCode, ExecutionErrorCode } from './errors.js';

export interface FileInfo {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size: number;
  mtimeMs: number;
}

export interface TextLine {
  text: string;
  terminated: boolean;
}

export interface TextLineReader {
  readLine(context: Context): Promise<Result<TextLine | undefined, FileError>>;
  close(context: Context): Promise<void>;
}

/** 对单个已打开常规文件的位置读；所有调用看到的都是同一个文件，即使其路径已被改名。 */
export interface BinaryReader {
  /** 已打开文件的元数据，不是其当前路径所指的文件。 */
  info(context: Context): Promise<Result<FileInfo, FileError>>;
  /** `offset` 处最多 `length` 字节；仅文件末尾可能返回更少。 */
  read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>>;
  /**
   * 单次扫描定位行 `[startLine, endLine)`（缺省 `endLine` 到末尾），0 基，
   * 第 `k` 行从第 `k` 个换行字节之后开始。解码尺寸与整体解码语义一致，
   * 文件开头的字节序标记不计入。
   */
  scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>>;
  close(context: Context): Promise<void>;
}

/** 目录条目的分页读取器。 */
export interface DirReader {
  /**
   * 按文件系统返回的顺序读取至多 `maxEntries` 条，并从上次位置继续。
   * `done` 标记结束；读取失败或中止后应关闭 reader。
   */
  next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>>;
  close(context: Context): Promise<void>;
}

/** 溢写阈值：完整输出超过任一阈值后整体落盘到临时文件。 */
export interface ShellSpillOptions {
  afterBytes: number;
  /** 完整或部分行。 */
  afterLines: number;
}

export interface ShellExecResult {
  exitCode: number;
  /** 超过溢写阈值时保存完整原始输出的临时文件。 */
  spillPath?: string;
}

export interface ShellOutputSkip {
  /** 省略文本的 UTF-8 字节长度。 */
  bytes: number;
  /** 省略文本中的换行符（U+000A）数。 */
  newlines: number;
  /** 省略文本是否以换行符结束。 */
  endsWithNewline: boolean;
}

export interface ShellOutputInfo {
  stream: 'stdout' | 'stderr';
  /** 仅在设置 `window` 时存在：紧邻本块之前被省略的输出。 */
  skipped?: ShellOutputSkip;
}

export interface ShellOutputWindow {
  /** 保留在输出末尾的解码文本 UTF-8 字节数。 */
  maxBytes: number;
  /** 保留在输出末尾的行数。 */
  maxLines: number;
  /** 调用方采样输出的最小间隔。 */
  minIntervalMs: number;
  /** 每次采样还按其大小以该速率暂停调用方。 */
  bytesPerSecond: number;
}

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeout?: number;
  /**
   * stdout/stderr 每个解码块到达时回调（按到达顺序，标注来源流）：
   * 原始、无上限、不限速。每个流独立解码，跨块拆分的字符得以保留。
   */
  onOutput?: (text: string, context: Context, info: ShellOutputInfo) => void;
  spill?: ShellSpillOptions;
  /** 调用方只保留输出的该尾部窗口；环境可省略窗口外的输出并在 info.skipped 中报告。 */
  window?: ShellOutputWindow;
}

export interface Shell {
  /**
   * 运行命令。字符串经环境的 shell 执行；数组直接运行 `command[0]`（其余为参数，
   * 不经 shell 解析）。中止 Context 或超时只杀死该命令的进程树。
   */
  exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>>;
  /** 杀死该环境仍在运行的所有命令；供其所有者关停使用，绝不为单个请求调用。 */
  cleanup(context: Context): Promise<void>;
}
