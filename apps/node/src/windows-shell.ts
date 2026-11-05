import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureDir } from './storage.js';

export const isWindows = process.platform === 'win32';

/** Portable MinGit layout root: <dataDir>/runtime/mingit */
const mingitRoot = (dataDir: string) => path.join(dataDir, 'runtime', 'mingit');
const mingitBash = (dataDir: string) => path.join(mingitRoot(dataDir), 'bin', 'bash.exe');

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Legacy WSL launcher (System32/bash.exe) is an empty shell without a distro — skip it. */
export function isLegacyWslBashPath(p: string): boolean {
  const normalized = p.toLowerCase();
  const systemRoot = process.env.SystemRoot;
  if (systemRoot && /^[a-z]:[\\/]/i.test(systemRoot)) {
    return ['system32', 'sysnative'].some((dir) =>
      normalized === path.win32.join(systemRoot, dir, 'bash.exe').toLowerCase()
    );
  }
  return /^c:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

/** Find bash.exe on PATH via `where` (Windows equivalent of `which`). */
function findBashOnPath(): string | null {
  try {
    const result = spawnSync('where', ['bash.exe'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.status === 0 && result.stdout) {
      const first = result.stdout.trim().split(/\r?\n/)[0];
      if (first && !isLegacyWslBashPath(first)) return first;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolve a bash.exe for the Pi `bash` tool on Windows.
 * Priority: BOTD_BASH_PATH env → managed MinGit → Git for Windows → PATH.
 * Returns undefined when nothing is available yet (caller may trigger a download).
 */
export function resolveWindowsBash(dataDir: string): string | undefined {
  const explicit = process.env.BOTD_BASH_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const managed = mingitBash(dataDir);
  if (existsSync(managed)) return managed;

  const candidates: string[] = [];
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  if (process.env.LocalAppData) candidates.push(path.join(process.env.LocalAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return findBashOnPath() ?? undefined;
}

/** PATH entries (bash + gnu coreutils + git) contributed by the managed MinGit. */
export function windowsShellPathPrefix(dataDir: string): string[] {
  if (!isWindows) return [];
  if (!existsSync(mingitRoot(dataDir))) return [];
  const root = mingitRoot(dataDir);
  return [path.join(root, 'usr', 'bin'), path.join(root, 'cmd'), path.join(root, 'bin')].filter(existsSync);
}

const MINGIT_VERSION = '2.47.1';

function mingitAssetName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : '64';
  return `MinGit-${MINGIT_VERSION}-${arch}-bit.zip`;
}

function mingitDownloadUrl(): string {
  return process.env.BOTD_MINGIT_URL ||
    `https://github.com/git-for-windows/git/releases/download/v${MINGIT_VERSION}.windows.1/${mingitAssetName()}`;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(dest));
}

/** Windows ships bsdtar as tar.exe which also extracts zip archives. */
function extractZip(archivePath: string, extractDir: string): void {
  const systemTar = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
    : 'tar.exe';
  const tar = existsSync(systemTar) ? systemTar : 'tar.exe';
  const result = spawnSync(tar, ['-xf', archivePath, '-C', extractDir], { stdio: 'pipe', windowsHide: true });
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr?.toString().trim() || `exit ${result.status}`;
    throw new Error(`Failed to extract MinGit with ${tar}: ${detail}`);
  }
}

let ensurePromise: Promise<string | undefined> | null = null;

/**
 * Make sure a bash.exe is usable on this Windows machine:
 * resolve an existing one, or download a portable MinGit (~30MB, no installer,
 * no admin rights, no registry) into <dataDir>/runtime/mingit exactly once.
 * Returns the bash.exe path, or undefined when offline and nothing exists.
 */
export function ensureWindowsShell(dataDir: string): Promise<string | undefined> {
  if (!isWindows) return Promise.resolve(undefined);
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const existing = resolveWindowsBash(dataDir);
    if (existing) return existing;

    const marker = path.join(mingitRoot(dataDir), '.complete');
    if (await fileExists(marker)) return mingitBash(dataDir);

    console.log('[botd] No bash found (Git for Windows not installed). Downloading portable MinGit...');
    const runtimeDir = path.join(dataDir, 'runtime');
    await ensureDir(runtimeDir);

    const archivePath = path.join(runtimeDir, mingitAssetName());
    const stagingDir = path.join(runtimeDir, `mingit-stage-${process.pid}`);
    const targetDir = mingitRoot(dataDir);

    try {
      await downloadTo(mingitDownloadUrl(), archivePath);
      await ensureDir(stagingDir);
      extractZip(archivePath, stagingDir);

      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.rename(stagingDir, targetDir);
      await fs.writeFile(marker, new Date().toISOString(), 'utf8');

      const bash = mingitBash(dataDir);
      if (!existsSync(bash)) throw new Error('MinGit extracted but bash.exe not found');
      console.log(`[botd] Portable bash ready: ${bash}`);
      return bash;
    } catch (err) {
      console.warn(
        `[botd] Automatic MinGit download failed (${err instanceof Error ? err.message : String(err)}). ` +
        'Bash tool unavailable. Install Git for Windows or set BOTD_BASH_PATH.'
      );
      return undefined;
    } finally {
      await fs.rm(archivePath, { force: true }).catch(() => {});
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  return ensurePromise;
}

/** Test seam: reset the once-per-process download guard. */
export function resetWindowsShellCache(): void {
  ensurePromise = null;
}
