import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { NodeUpgradeCheckResult, NodeUpgradeResult } from '@botd/protocol';
import { writeSecureFile } from './storage.js';
import { getActiveSessionCount } from './runtime.js';
import { spawnReplacementDaemon } from './daemon-launch.js';

let cachedPackageVersion: string | undefined;

export function getNodeVersion(): string {
  if (process.env.BOTD_VERSION_OVERRIDE && process.env.BOTD_VERSION_OVERRIDE.trim() !== '') {
    return process.env.BOTD_VERSION_OVERRIDE.trim();
  }
  if (!cachedPackageVersion) {
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const pkgPath = path.resolve(thisDir, '../package.json');
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: string };
      cachedPackageVersion = parsed.version || '0.1.0';
    } catch {
      cachedPackageVersion = '0.1.0';
    }
  }
  return cachedPackageVersion;
}

export interface CurrentReleaseRecord {
  version: string;
  entryPath: string;
  updatedAt: string;
}

export interface PreviousReleaseRecord {
  version: string;
  entryPath: string;
  updatedAt: string;
}

export interface BlockedReleaseRecord {
  version: string;
  reason: string;
  at: string;
}

export async function readCurrentRelease(dataDir: string): Promise<CurrentReleaseRecord | null> {
  const filePath = path.join(dataDir, 'current.json');
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as CurrentReleaseRecord;
  } catch {
    return null;
  }
}

export async function writeCurrentRelease(dataDir: string, record: CurrentReleaseRecord): Promise<void> {
  const filePath = path.join(dataDir, 'current.json');
  await writeSecureFile(filePath, JSON.stringify(record, null, 2));
}

export async function deleteCurrentRelease(dataDir: string): Promise<void> {
  const filePath = path.join(dataDir, 'current.json');
  await fsPromises.rm(filePath, { force: true });
}

export async function readPreviousRelease(dataDir: string): Promise<PreviousReleaseRecord | null> {
  const filePath = path.join(dataDir, 'previous.json');
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as PreviousReleaseRecord;
  } catch {
    return null;
  }
}

export async function writePreviousRelease(dataDir: string, record: PreviousReleaseRecord): Promise<void> {
  const filePath = path.join(dataDir, 'previous.json');
  await writeSecureFile(filePath, JSON.stringify(record, null, 2));
}

export async function readBlockedRelease(dataDir: string): Promise<BlockedReleaseRecord | null> {
  const filePath = path.join(dataDir, 'update-blocked.json');
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as BlockedReleaseRecord;
  } catch {
    return null;
  }
}

export async function writeBlockedRelease(dataDir: string, record: BlockedReleaseRecord): Promise<void> {
  const filePath = path.join(dataDir, 'update-blocked.json');
  await writeSecureFile(filePath, JSON.stringify(record, null, 2));
}

export async function clearBlockedRelease(dataDir: string): Promise<void> {
  const filePath = path.join(dataDir, 'update-blocked.json');
  await fsPromises.rm(filePath, { force: true });
}

export function compareSemver(a: string, b: string): number {
  if (a === b) return 0;
  const cleanA = a.trim().replace(/^v/, '');
  const cleanB = b.trim().replace(/^v/, '');
  if (cleanA === cleanB) return 0;

  const [coreA, preA] = cleanA.split('-', 2);
  const [coreB, preB] = cleanB.split('-', 2);

  const partsA = coreA.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const partsB = coreB.split('.').map((p) => Number.parseInt(p, 10) || 0);

  const maxLen = Math.max(partsA.length, partsB.length, 3);
  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  // Pre-release tag comparison
  if (!preA && preB) return 1; // standard version > pre-release (e.g. 1.0.0 > 1.0.0-beta)
  if (preA && !preB) return -1;
  if (preA && preB) {
    const segsA = preA.split('.');
    const segsB = preB.split('.');
    const segsLen = Math.max(segsA.length, segsB.length);
    for (let i = 0; i < segsLen; i++) {
      const segA = segsA[i];
      const segB = segsB[i];
      if (segA === undefined) return -1;
      if (segB === undefined) return 1;
      if (segA === segB) continue;
      const numA = Number(segA);
      const numB = Number(segB);
      const isNumA = Number.isInteger(numA) && String(numA) === segA;
      const isNumB = Number.isInteger(numB) && String(numB) === segB;
      if (isNumA && isNumB) {
        return numA > numB ? 1 : -1;
      }
      if (isNumA && !isNumB) return -1;
      if (!isNumA && isNumB) return 1;
      return segA.localeCompare(segB) > 0 ? 1 : -1;
    }
  }

  return 0;
}

export interface CheckNodeUpgradeOptions {
  registryUrl?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
}

export async function checkNodeUpgrade(
  dataDir: string,
  options?: CheckNodeUpgradeOptions,
): Promise<NodeUpgradeCheckResult> {
  const rawRegistry =
    options?.registryUrl ||
    process.env.BOTD_NPM_REGISTRY ||
    'https://registry.npmjs.org';
  const registryUrl = rawRegistry.trim().replace(/\/+$/, '');
  const pkgName = process.env.BOTD_NPM_PACKAGE || 'botd';

  const fetchImpl = options?.fetchFn ?? fetch;
  const url = `${registryUrl}/${encodeURIComponent(pkgName)}/latest`;

  let latestVersion: string;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Registry responded with HTTP ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as { version?: string };
    if (!data || typeof data.version !== 'string') {
      throw new Error(`Registry response missing version property: ${JSON.stringify(data)}`);
    }
    latestVersion = data.version;
  } catch (err: any) {
    throw new Error(`Failed to check latest version from ${url}: ${err?.message || String(err)}`);
  }

  const currentVersion =
    options?.currentVersion ??
    (await readCurrentRelease(dataDir))?.version ??
    getNodeVersion();

  const blocked = (await readBlockedRelease(dataDir)) || undefined;
  const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    ...(blocked ? { blocked } : {}),
  };
}

export interface StageReleaseOptions {
  registryUrl?: string;
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<string>;
}

const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+([0-9A-Za-z.-]*)$/;

export async function stageReleaseFromNpm(
  dataDir: string,
  targetVersion: string,
  options?: StageReleaseOptions,
): Promise<{ version: string; releaseDir: string; entryPath: string }> {
  if (!SEMVER_REGEX.test(targetVersion)) {
    throw new Error(`Invalid target version format: "${targetVersion}"`);
  }

  const releaseDir = path.join(dataDir, 'releases', targetVersion);
  const completeFile = path.join(releaseDir, '.complete');

  if (fs.existsSync(completeFile)) {
    try {
      const raw = await fsPromises.readFile(completeFile, 'utf8');
      const marker = JSON.parse(raw) as { version?: string; entryPath?: string };
      if (marker && marker.entryPath && fs.existsSync(marker.entryPath)) {
        return { version: targetVersion, releaseDir, entryPath: marker.entryPath };
      }
    } catch {
      // corrupt marker, restage
    }
  }

  const stagingDir = path.join(
    dataDir,
    'releases',
    `${targetVersion}-staging-${process.pid}-${Date.now()}`,
  );
  await fsPromises.mkdir(stagingDir, { recursive: true });

  let entryRelative: string;

  try {
    if (options?.stageExtractor) {
      const returnedEntry = await options.stageExtractor(stagingDir, targetVersion);
      if (path.isAbsolute(returnedEntry)) {
        entryRelative = path.relative(stagingDir, returnedEntry);
      } else {
        entryRelative = returnedEntry;
      }
    } else if (process.env.BOTD_TEST_STAGE_ENTRY) {
      const entryFile = path.join(stagingDir, 'cli.js');
      if (process.env.BOTD_TEST_STAGE_FAIL === '1') {
        await fsPromises.writeFile(
          entryFile,
          'console.error("Simulated canary startup crash"); process.exit(1);\n',
          'utf8',
        );
      } else if (
        process.env.BOTD_TEST_STAGE_ENTRY !== '1' &&
        fs.existsSync(process.env.BOTD_TEST_STAGE_ENTRY)
      ) {
        const content = await fsPromises.readFile(process.env.BOTD_TEST_STAGE_ENTRY, 'utf8');
        await fsPromises.writeFile(
          entryFile,
          `process.env.BOTD_VERSION_OVERRIDE = ${JSON.stringify(targetVersion)};\n` + content,
          'utf8',
        );
      } else {
        await fsPromises.writeFile(
          entryFile,
          `process.env.BOTD_VERSION_OVERRIDE = ${JSON.stringify(targetVersion)};\n` +
            `if (typeof process.send === 'function') { process.send({ type: 'botd:daemon-ready', pid: process.pid }); }\n` +
            `setInterval(() => {}, 60000);\n`,
          'utf8',
        );
      }
      entryRelative = 'cli.js';
    } else {
      const pkgName = process.env.BOTD_NPM_PACKAGE || 'botd';
      const rawRegistry =
        options?.registryUrl ||
        process.env.BOTD_NPM_REGISTRY ||
        'https://registry.npmjs.org';
      const registryUrl = rawRegistry.trim().replace(/\/+$/, '');

      await fsPromises.writeFile(
        path.join(stagingDir, 'package.json'),
        JSON.stringify({ name: 'botd-release', private: true }),
        'utf8',
      );

      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const npmArgs = [
        'install',
        `${pkgName}@${targetVersion}`,
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--registry',
        registryUrl,
      ];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(npmCmd, npmArgs, {
          cwd: stagingDir,
          stdio: 'inherit',
          windowsHide: true,
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`npm install failed with exit code ${code}`));
        });
      });

      const candidate1 = path.join(stagingDir, 'node_modules', pkgName, 'dist', 'cli.js');
      const candidate2 = path.join(stagingDir, 'node_modules', '@botd/node', 'dist', 'cli.js');
      if (fs.existsSync(candidate1)) {
        entryRelative = path.relative(stagingDir, candidate1);
      } else if (fs.existsSync(candidate2)) {
        entryRelative = path.relative(stagingDir, candidate2);
      } else {
        throw new Error(`Cannot locate dist/cli.js in staged release for ${pkgName}@${targetVersion}`);
      }
    }

    // Atomic rename
    await fsPromises.rm(releaseDir, { recursive: true, force: true });
    await fsPromises.rename(stagingDir, releaseDir);

    const finalEntryPath = path.resolve(releaseDir, entryRelative);
    const completeData = {
      version: targetVersion,
      entryPath: finalEntryPath,
      completedAt: new Date().toISOString(),
    };
    await writeSecureFile(completeFile, JSON.stringify(completeData, null, 2));

    return {
      version: targetVersion,
      releaseDir,
      entryPath: finalEntryPath,
    };
  } catch (err) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export interface PerformNodeUpgradeOptions {
  targetVersion?: string;
  registryUrl?: string;
  force?: boolean;
  drainTimeoutMs?: number;
  canaryTimeoutMs?: number;
  spawnReplacementFn?: typeof spawnReplacementDaemon;
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<string>;
  getActiveTurnsCount?: () => number;
  onScheduleShutdown?: () => void;
}

export async function performNodeUpgrade(
  dataDir: string,
  options?: PerformNodeUpgradeOptions,
): Promise<NodeUpgradeResult> {
  const previousVersion =
    (await readCurrentRelease(dataDir))?.version ?? getNodeVersion();

  let targetVersion = options?.targetVersion;
  if (!targetVersion) {
    const check = await checkNodeUpgrade(dataDir, {
      registryUrl: options?.registryUrl,
      currentVersion: previousVersion,
    });
    targetVersion = check.latestVersion;
  }

  if (!options?.force && targetVersion === previousVersion) {
    return {
      ok: true,
      previousVersion,
      targetVersion,
      upgraded: false,
    };
  }

  const staged = await stageReleaseFromNpm(dataDir, targetVersion, {
    registryUrl: options?.registryUrl,
    stageExtractor: options?.stageExtractor,
  });

  // Drain check
  const drainTimeoutMs = options?.drainTimeoutMs ?? 30_000;
  const getTurnsCount = options?.getActiveTurnsCount ?? getActiveSessionCount;
  const drainStart = Date.now();

  while (getTurnsCount() > 0) {
    if (Date.now() - drainStart > drainTimeoutMs) {
      throw new Error('Timed out waiting for active turns to drain before upgrade');
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Canary deployment and rollback protection
  const existingCurrent = await readCurrentRelease(dataDir);
  if (existingCurrent) {
    await writePreviousRelease(dataDir, existingCurrent);
  }

  await writeCurrentRelease(dataDir, {
    version: targetVersion,
    entryPath: staged.entryPath,
    updatedAt: new Date().toISOString(),
  });

  const spawnFn = options?.spawnReplacementFn ?? spawnReplacementDaemon;
  let pid: number;

  try {
    pid = await spawnFn({
      dataDir,
      cliEntryOverride: staged.entryPath,
      timeoutMs: options?.canaryTimeoutMs ?? 15_000,
    });
  } catch (err: any) {
    // Canary failed; restore previous release and block targetVersion
    if (existingCurrent) {
      await writeCurrentRelease(dataDir, existingCurrent);
    } else {
      await deleteCurrentRelease(dataDir);
    }

    const errMsg = err?.message || String(err);
    await writeBlockedRelease(dataDir, {
      version: targetVersion,
      reason: errMsg,
      at: new Date().toISOString(),
    });

    throw new Error(
      `Upgrade to ${targetVersion} failed canary check and was rolled back to ${previousVersion}: ${errMsg}`,
    );
  }

  // Canary succeeded
  await clearBlockedRelease(dataDir);

  if (options?.onScheduleShutdown) {
    options.onScheduleShutdown();
  }

  return {
    ok: true,
    previousVersion,
    targetVersion,
    upgraded: true,
    pid,
  };
}
