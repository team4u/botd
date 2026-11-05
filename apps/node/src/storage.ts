import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isSafeId, type BotConfig, type NodeIdentity } from '@botd/protocol';
import {
  encodePackageFile,
  type ResourcePackage,
  type ResourcePackageFile,
} from '@botd/protocol';

export { isValidBotEnvKey } from '@botd/protocol';

export function assertSafeId(id: string, label = 'Identifier'): string {
  if (!isSafeId(id)) {
    throw new Error(`${label} "${id}" is invalid. Only alphanumeric, underscore and dash characters are allowed.`);
  }
  return id;
}

export function getDataDir(override?: string): string {
  const dir = override || process.env.BOTD_DATA_DIR || path.join(os.homedir(), '.botd');
  return path.resolve(dir);
}

/**
 * Local daemon control-plane address: Unix domain socket on POSIX, named
 * pipe on Windows. Both work with http request({ socketPath }) / listen().
 * The pipe name hashes the dataDir so multiple instances never collide.
 */
export function getDaemonSocketPath(dataDir: string): string {
  if (process.platform === 'win32') {
    const hash = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\botd-agent-${hash}`;
  }
  return path.join(dataDir, 'agent.sock');
}

export async function ensureDir(dirPath: string, mode?: number): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode });
  if (mode !== undefined && process.platform !== 'win32') await fs.chmod(dirPath, mode);
}

export async function writeSecureFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Atomic write (tmp + rename) that keeps the file's default permission
 *  semantics instead of forcing 0600 — for non-secret data files such as
 *  bot.json / SKILL.md. A crash mid-write never leaves a truncated file. */
export async function writeAtomicFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Path of the local IPC auth token file (<dataDir>/ipc-token). */
export function getIpcTokenFilePath(dataDir: string): string {
  return path.join(dataDir, 'ipc-token');
}

/** Reads the local IPC token, or null when absent/unreadable. */
export async function readIpcToken(dataDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(getIpcTokenFilePath(dataDir), 'utf8');
    const token = raw.trim();
    return token || null;
  } catch {
    return null;
  }
}

/** Ensures <dataDir>/ipc-token exists (0600, atomic write): 64-hex random
 *  token generated once; subsequent calls keep the existing token so CLI
 *  clients on the same machine stay valid across daemon restarts. */
export async function ensureIpcToken(dataDir: string): Promise<void> {
  const tokenPath = getIpcTokenFilePath(dataDir);
  if (existsSync(tokenPath)) {
    const existing = await readIpcToken(dataDir);
    if (existing) return;
  }
  const token = randomBytes(32).toString('hex'); // 64 hex chars
  await writeSecureFile(tokenPath, token + '\n');
}

export async function readNodeIdentity(dataDir: string): Promise<NodeIdentity | null> {
  const file = path.join(dataDir, 'node.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as NodeIdentity;
  } catch {
    return null;
  }
}

export async function writeNodeIdentity(dataDir: string, identity: NodeIdentity): Promise<void> {
  assertSafeId(identity.nodeId, 'Node ID');
  await ensureDir(dataDir, 0o700);
  const file = path.join(dataDir, 'node.json');
  await writeSecureFile(file, JSON.stringify(identity, null, 2));
}

export function getBotDir(dataDir: string, botId: string): string {
  assertSafeId(botId, 'Bot ID');
  return path.join(dataDir, 'bots', botId);
}

export function getSkillDir(dataDir: string, skillId: string): string {
  assertSafeId(skillId, 'Skill ID');
  return path.join(dataDir, 'skills', skillId);
}

/**
 * Skill discovery roots in priority order: the writable botd-managed
 * <dataDir>/skills first, then the Agent Skills standard dirs
 * (.agents/skills / .agent/skills) inside dataDir and workspace, plus the
 * user-home level when dataDir is ~/.botd (so `npx skills add` installs work
 * without copying; temp/test data dirs stay isolated because their basename
 * is not ".botd"). BOTD_SKILLS_DIRS (path.delimiter-separated) appends extras.
 */
export function getSkillSearchDirs(dataDir: string, workspaceDir?: string): string[] {
  const dirs = [
    path.join(dataDir, 'skills'),
    path.join(dataDir, '.agents', 'skills'),
    path.join(dataDir, '.agent', 'skills'),
  ];
  const resolvedDataDir = path.resolve(dataDir);
  if (path.basename(resolvedDataDir) === '.botd') {
    const home = path.dirname(resolvedDataDir);
    dirs.push(path.join(home, '.agents', 'skills'), path.join(home, '.agent', 'skills'));
  }
  if (workspaceDir) {
    dirs.push(path.join(workspaceDir, '.agents', 'skills'), path.join(workspaceDir, '.agent', 'skills'));
  }
  const extra = (process.env.BOTD_SKILLS_DIRS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  return [...new Set([...dirs, ...extra].map((dir) => path.resolve(dir)))];
}

/** Resolve a skill's actual directory: the first search root containing
 *  <id>/SKILL.md wins (primary dir first); fall back to the writable primary
 *  dir so a missing skill fails at read time with the canonical path. */
export function resolveSkillDir(dataDir: string, skillId: string, workspaceDir?: string): string {
  assertSafeId(skillId, 'Skill ID');
  for (const rootDir of getSkillSearchDirs(dataDir, workspaceDir)) {
    if (existsSync(path.join(rootDir, skillId, 'SKILL.md'))) {
      return path.join(rootDir, skillId);
    }
  }
  return getSkillDir(dataDir, skillId);
}

export function getExtensionDir(dataDir: string, extId: string): string {
  assertSafeId(extId, 'Extension ID');
  return path.join(dataDir, 'extensions', extId);
}

export async function listBots(dataDir: string): Promise<BotConfig[]> {
  const botsDir = path.join(dataDir, 'bots');
  if (!existsSync(botsDir)) return [];
  const entries = await fs.readdir(botsDir, { withFileTypes: true });
  const bots: BotConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const botJsonPath = path.join(botsDir, entry.name, 'bot.json');
    try {
      const raw = await fs.readFile(botJsonPath, 'utf8');
      const bot = JSON.parse(raw) as BotConfig;
      bot.enabledSkills = Array.isArray(bot.enabledSkills) ? bot.enabledSkills : [];
      bot.enabledExtensions = Array.isArray(bot.enabledExtensions) ? bot.enabledExtensions : [];
      bots.push(bot);
    } catch (err) {
      // Directory exists but bot.json is missing/corrupt: log it instead of
      // silently dropping, so operators can repair the data dir.
      console.error(`listBots: failed to read ${botJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return bots;
}

export async function readBot(
  dataDir: string,
  botId: string
): Promise<{ bot: BotConfig; systemMd: string; memoryMd: string } | null> {
  assertSafeId(botId, 'Bot ID');
  const botDir = getBotDir(dataDir, botId);
  const botJsonPath = path.join(botDir, 'bot.json');
  try {
    const raw = await fs.readFile(botJsonPath, 'utf8');
    const bot = JSON.parse(raw) as BotConfig;
    bot.enabledSkills = Array.isArray(bot.enabledSkills) ? bot.enabledSkills : [];
    bot.enabledExtensions = Array.isArray(bot.enabledExtensions) ? bot.enabledExtensions : [];
    const systemMd = await fs.readFile(path.join(botDir, 'SYSTEM.md'), 'utf8').catch(() => '');
    const memoryMd = await fs.readFile(path.join(botDir, 'MEMORY.md'), 'utf8').catch(() => '');
    return { bot, systemMd, memoryMd };
  } catch {
    return null;
  }
}

export async function saveBot(dataDir: string, bot: BotConfig, systemMd?: string): Promise<void> {
  assertSafeId(bot.id, 'Bot ID');
  const botDir = getBotDir(dataDir, bot.id);
  const workspaceDir = path.join(botDir, 'workspace');
  const sessionsDir = path.join(botDir, 'sessions');

  await ensureDir(workspaceDir);
  await ensureDir(sessionsDir);
  await ensureDir(path.join(botDir, 'memory'));

  const botWithTimestamp: BotConfig = {
    ...bot,
    enabledSkills: Array.isArray(bot.enabledSkills) ? bot.enabledSkills : [],
    enabledExtensions: Array.isArray(bot.enabledExtensions) ? bot.enabledExtensions : [],
    updatedAt: new Date().toISOString(),
  };

  await writeAtomicFile(path.join(botDir, 'bot.json'), JSON.stringify(botWithTimestamp, null, 2));

  if (systemMd !== undefined) {
    await writeAtomicFile(path.join(botDir, 'SYSTEM.md'), systemMd);
  }

  const memoryPath = path.join(botDir, 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    await writeAtomicFile(memoryPath, '');
  }
}

export async function deleteBot(dataDir: string, botId: string): Promise<void> {
  assertSafeId(botId, 'Bot ID');
  const botDir = getBotDir(dataDir, botId);
  await fs.rm(botDir, { recursive: true, force: true });
}

/** Scan one skills root; symlinks count because `npx skills add` creates them. */
async function listSkillEntriesInDir(skillsDir: string): Promise<string[]> {
  if (!existsSync(skillsDir)) return [];
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !isSafeId(entry.name)) continue;
    if (existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
      names.push(entry.name);
    }
  }
  return names;
}

export async function listSkills(dataDir: string, workspaceDir?: string): Promise<string[]> {
  const seen = new Set<string>();
  for (const skillsDir of getSkillSearchDirs(dataDir, workspaceDir)) {
    for (const name of await listSkillEntriesInDir(skillsDir)) {
      seen.add(name);
    }
  }
  return [...seen];
}

export async function readSkill(dataDir: string, skillId: string): Promise<string> {
  const skillMd = path.join(resolveSkillDir(dataDir, skillId), 'SKILL.md');
  return fs.readFile(skillMd, 'utf8');
}

export async function writeSkill(dataDir: string, skillId: string, content: string): Promise<void> {
  assertSafeId(skillId, 'Skill ID');
  const skillDir = getSkillDir(dataDir, skillId);
  await ensureDir(skillDir);
  await writeAtomicFile(path.join(skillDir, 'SKILL.md'), content);
}

export async function listExtensions(dataDir: string): Promise<string[]> {
  const extensionsDir = path.join(dataDir, 'extensions');
  if (!existsSync(extensionsDir)) return [];
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  const extensions: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extDir = path.join(extensionsDir, entry.name);
    if (
      existsSync(path.join(extDir, 'index.ts')) ||
      existsSync(path.join(extDir, 'index.js')) ||
      existsSync(path.join(extDir, 'package.json'))
    ) {
      extensions.push(entry.name);
    }
  }
  return extensions;
}

export async function readExtension(dataDir: string, extId: string): Promise<string> {
  assertSafeId(extId, 'Extension ID');
  const extDir = getExtensionDir(dataDir, extId);
  const tsPath = path.join(extDir, 'index.ts');
  try {
    return await fs.readFile(tsPath, 'utf8');
  } catch {
    const jsPath = path.join(extDir, 'index.js');
    return await fs.readFile(jsPath, 'utf8');
  }
}

export async function writeExtension(dataDir: string, extId: string, content: string): Promise<void> {
  assertSafeId(extId, 'Extension ID');
  const extDir = getExtensionDir(dataDir, extId);
  await ensureDir(extDir);
  await writeAtomicFile(path.join(extDir, 'index.ts'), content);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 目录内全部文件（POSIX 相对路径，排除 .git；node_modules 仅在 includeDeps 时随包）。 */
async function collectPackageFiles(
  root: string,
  includeDeps: boolean,
): Promise<ResourcePackageFile[]> {
  const files: ResourcePackageFile[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (entry.name === 'node_modules' && !includeDeps) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const data = await fs.readFile(full);
        const executable = ((await fs.stat(full)).mode & 0o111) !== 0;
        files.push(encodePackageFile(rel, data, executable));
      }
    }
  };
  await walk(root, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 读取节点本地资源包完整目录为 ResourcePackage（多文件 + 二进制保真）。 */
export async function readResourcePackageDir(
  dataDir: string,
  target: { kind: 'skill' | 'extension'; id: string },
): Promise<ResourcePackage> {
  assertSafeId(target.id, `${target.kind === 'skill' ? 'Skill' : 'Extension'} ID`);
  const dir = target.kind === 'skill'
    ? resolveSkillDir(dataDir, target.id)
    : getExtensionDir(dataDir, target.id);
  if (!(await fileExists(path.join(dir, target.kind === 'skill' ? 'SKILL.md' : 'package.json')))
    && !(await fileExists(path.join(dir, 'index.ts')))
    && !(await fileExists(path.join(dir, 'index.js')))) {
    throw new Error(`${target.kind === 'skill' ? 'Skill' : 'Extension'} "${target.id}" not found on node`);
  }
  const includeDeps = target.kind === 'extension';
  const files = await collectPackageFiles(dir, includeDeps);
  if (files.length === 0) {
    throw new Error(`${target.kind === 'skill' ? 'Skill' : 'Extension'} "${target.id}" package is empty`);
  }
  let packageName: string | undefined;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
    if (typeof pkg.name === 'string' && pkg.name) packageName = pkg.name;
  } catch {
    // 无 package.json 或非法 JSON：非致命
  }
  return {
    kind: target.kind,
    id: target.id,
    files,
    ...(packageName ? { packageName } : {}),
    ...(target.kind === 'skill' ? { entry: 'SKILL.md' } : {}),
  };
}
