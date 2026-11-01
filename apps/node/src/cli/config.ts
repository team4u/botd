import fs from 'node:fs/promises';
import path from 'node:path';
import { writeSecureFile } from '../storage.js';

/**
 * Persisted CLI session state, stored at `<dataDir>/cli.json` with 0600 permissions.
 * `password` is only written when the user explicitly passes --save-credentials to `botd login`.
 */
export interface CliConfig {
  hubUrl?: string;
  token?: string;
  username?: string;
  password?: string;
}

const configFileName = 'cli.json';

export function cliConfigPath(dataDir: string): string {
  return path.join(dataDir, configFileName);
}

export async function readCliConfig(dataDir: string): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(cliConfigPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      hubUrl: typeof parsed.hubUrl === 'string' ? parsed.hubUrl : undefined,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      password: typeof parsed.password === 'string' ? parsed.password : undefined,
    };
  } catch {
    return {};
  }
}

export async function writeCliConfig(dataDir: string, config: CliConfig): Promise<void> {
  await writeSecureFile(cliConfigPath(dataDir), `${JSON.stringify(config, null, 2)}\n`);
}

/** Read-modify-write merge. Explicit `undefined` patch values are removed from the stored config; omitted properties are preserved. */
export async function updateCliConfig(dataDir: string, patch: Partial<CliConfig>): Promise<CliConfig> {
  const current = await readCliConfig(dataDir);
  const next: CliConfig = {};

  const keys: (keyof CliConfig)[] = ['hubUrl', 'token', 'username', 'password'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const val = patch[key];
      if (val !== undefined) {
        next[key] = val;
      }
    } else {
      const val = current[key];
      if (val !== undefined) {
        next[key] = val;
      }
    }
  }

  await writeCliConfig(dataDir, next);
  return next;
}

export async function clearCliConfig(dataDir: string): Promise<void> {
  await writeCliConfig(dataDir, {});
}
