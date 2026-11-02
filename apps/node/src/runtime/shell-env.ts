import path from 'node:path';
import { isWindows, windowsShellPathPrefix } from '../windows-shell.js';

/**
 * BOT 回合内 shell 子进程的环境构建：注入 botd 数据目录 / 会话标识 / BOT 专属变量，
 * 并把 bin/ 与（Windows 下）shell 前缀挂到 PATH 头部。纯函数，不改全局 process.env。
 */

export interface BotShellEnvOptions {
  dataDir: string;
  binDir: string;
  sessionId: string;
  botId: string;
  botEnv: Record<string, string>;
  turnEnv?: Record<string, string | undefined>;
}

export function buildBotShellEnv(
  baseEnv: Record<string, string | undefined>,
  options: BotShellEnvOptions,
): Record<string, string | undefined> {
  const isWin = isWindows;
  const pathKey = isWin
    ? (Object.keys(baseEnv).find((key) => key.toLowerCase() === 'path') ??
       Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ??
       'PATH')
    : 'PATH';
  const shellPathPrefix = isWin ? windowsShellPathPrefix(options.dataDir) : [];
  const currentPath = baseEnv[pathKey] ?? baseEnv.PATH ?? '';
  const prefix = [options.binDir, ...shellPathPrefix].filter(Boolean);
  const nextPath = [...prefix, ...currentPath.split(path.delimiter).filter(Boolean)].join(path.delimiter);

  return {
    ...baseEnv,
    [pathKey]: nextPath,
    PATH: nextPath,
    ...options.botEnv,
    BOTD_SESSION_ID: options.sessionId,
    BOTD_BOT_ID: options.botId,
    BOTD_DATA_DIR: options.dataDir,
    ...options.turnEnv,
  };
}

/** 从环境或默认路径解析 daemon 数据目录（回合外 resume 需要重建资源时使用） */
export function getDataDirSafe(): string {
  return process.env.BOTD_DATA_DIR || path.join(process.env.HOME || process.cwd(), '.botd');
}
