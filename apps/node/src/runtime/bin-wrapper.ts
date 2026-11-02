import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDir } from '../storage.js';

/**
 * dataDir/bin/botd CLI 包装器的生成与解析：让 BOT 的脚本与 cron 能直接调用 `botd` 命令。
 * 幂等：内容相同不重写；原子：临时文件 + rename 落盘。
 */

let tsxLoaderUrl: string | undefined;
try {
  if (typeof import.meta.resolve === 'function') {
    tsxLoaderUrl = import.meta.resolve('tsx');
  }
} catch {
  // Ignore fallback if resolve is unavailable
}
if (!tsxLoaderUrl) {
  try {
    const req = createRequire(import.meta.url);
    tsxLoaderUrl = pathToFileURL(req.resolve('tsx')).href;
  } catch {
    // Ignore fallback if resolve is unavailable
  }
}

export function getTsxLoaderUrl(): string | undefined {
  return tsxLoaderUrl;
}

export function resolveCliEntry(): { cliPath: string; isTypeScript: boolean } {
  // 本文件位于 src/runtime/（构建后 dist/runtime/），CLI 入口在上级目录。
  const thisDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tsCli = path.join(thisDir, 'cli.ts');
  const jsCli = path.join(thisDir, 'cli.js');
  if (existsSync(tsCli)) {
    return { cliPath: tsCli, isTypeScript: true };
  }
  return { cliPath: jsCli, isTypeScript: false };
}

/**
 * POSIX-quote a path for embedding in a #!/usr/bin/env sh wrapper.
 * Windows paths get forward slashes so MSYS2/Git Bash parses them.
 */
function toPosixPath(p: string): string {
  return process.platform === 'win32' ? p.replaceAll('\\', '/') : p;
}

export async function ensureBotdBinWrapper(dataDir: string): Promise<string> {
  const binDir = path.join(dataDir, 'bin');
  await ensureDir(binDir);
  const botdBin = path.join(binDir, 'botd');
  const { cliPath, isTypeScript } = resolveCliEntry();
  const execPath = process.execPath;

  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const executable = shellQuote(toPosixPath(execPath));
  const cliEntry = shellQuote(toPosixPath(cliPath));
  if (isTypeScript && !tsxLoaderUrl) throw new Error('Cannot resolve the tsx loader for the development CLI');
  const scriptContent = isTypeScript
    ? `#!/usr/bin/env sh\nexec ${executable} --import ${shellQuote(tsxLoaderUrl!)} ${cliEntry} "$@"\n`
    : `#!/usr/bin/env sh\nexec ${executable} ${cliEntry} "$@"\n`;

  // Avoid rewriting file if it already exists with identical content
  try {
    const existing = await fs.readFile(botdBin, 'utf8');
    if (existing === scriptContent) {
      return binDir;
    }
  } catch {
    // File does not exist yet
  }

  // Atomic write via temp file
  const tmpFile = `${botdBin}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpFile, scriptContent, { encoding: 'utf8', mode: 0o755 });
  if (process.platform !== 'win32') {
    await fs.chmod(tmpFile, 0o755).catch(() => {});
  }
  await fs.rename(tmpFile, botdBin);

  // Windows: also emit botd.cmd so cmd/PowerShell and plain child processes
  // (which cannot exec #! scripts) can invoke `botd wake ...` directly.
  if (process.platform === 'win32') {
    const cmdWrapper = `${binDir}${path.sep}botd.cmd`;
    const cmdContent = isTypeScript
      ? `@echo off\r\n"${execPath}" --import "${tsxLoaderUrl!}" "${cliPath}" %*\r\n`
      : `@echo off\r\n"${execPath}" "${cliPath}" %*\r\n`;
    const tmpCmd = `${cmdWrapper}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpCmd, cmdContent, { encoding: 'utf8' });
    await fs.rename(tmpCmd, cmdWrapper);
  }

  return binDir;
}
