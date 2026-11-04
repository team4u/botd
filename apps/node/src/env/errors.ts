/**
 * Result 类型与文件/执行错误（@earendil-works/pi-durable env 的结构子集）。
 * 可失败操作以返回值而非抛出表达预期失败。
 */

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
  return { ok: true, value };
}

export function err<TValue, TError>(error: TError): Result<TValue, TError> {
  return { ok: false, error };
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export type FileKind = 'file' | 'directory' | 'symlink';

export type FileErrorCode =
  | 'aborted'
  | 'not_found'
  | 'permission_denied'
  | 'not_directory'
  | 'is_directory'
  | 'invalid'
  | 'not_supported'
  | 'unknown';

export class FileError extends Error {
  readonly code: FileErrorCode;
  readonly path?: string;

  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FileError';
    this.code = code;
    this.path = path;
  }
}

export type ExecutionErrorCode = 'aborted' | 'timeout' | 'shell_unavailable' | 'spawn_error' | 'callback_error' | 'unknown';

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  /** 命令超时或中止后，输出越过溢写阈值时保存完整输出的临时文件。 */
  spillPath?: string;

  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExecutionError';
    this.code = code;
  }
}
