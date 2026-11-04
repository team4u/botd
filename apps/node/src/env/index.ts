/**
 * Node 本地执行环境（vendored）：@earendil-works/pi-durable env 纯 Node 子集。
 *
 * 上游 dist/env/{index,node,decode,line-scan}.js 只依赖 Node 标准库，
 * 在此内联维护，让 @botd/node 摆脱 pi-durable/chord 的 LLM/WASM 传递依赖。
 */

export { NodeExecutionEnv, type NodeExecutionEnvOptions } from './node.js';
export { BACKGROUND_CONTEXT, withCancel, type Context } from './context.js';
export { LineScanner, type LineScan } from './line-scan.js';
export { StreamDecoder, rangeDecoder, startsWithBom } from './decode.js';
export { err, ok, toError, ExecutionError, FileError } from './errors.js';
export type { Result, FileKind, FileErrorCode, ExecutionErrorCode } from './errors.js';
export type {
  BinaryReader,
  DirReader,
  FileInfo,
  Shell,
  ShellExecOptions,
  ShellExecResult,
  ShellOutputInfo,
  ShellOutputSkip,
  ShellOutputWindow,
  ShellSpillOptions,
  TextLine,
  TextLineReader,
} from './types.js';
