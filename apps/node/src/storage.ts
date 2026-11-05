import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isSafeId, isValidBotEnvKey, type BotConfig, type NodeIdentity } from '@botd/protocol';
import {
  encodePackageFile,
  type ResourcePackage,
  type ResourcePackageFile,
} from '@botd/protocol';

export { isValidBotEnvKey } from '@botd/protocol';

export async function readBotEnv(dataDir: string, botId: string): Promise<Record<string, string>> {
  assertSafeId(botId, 'Bot ID');
  const envPath = path.join(getBotDir(dataDir, botId), 'env.json');
  try {
    const raw = await fs.readFile(envPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && isValidBotEnvKey(key)) {
        env[key] = value;
      }
    }
    return env;
  } catch {
    return {};
  }
}

export async function writeBotEnv(
  dataDir: string,
  botId: string,
  env: Record<string, string>
): Promise<Record<string, string>> {
  assertSafeId(botId, 'Bot ID');
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isValidBotEnvKey(key)) {
      throw new Error(`Invalid or reserved environment variable key: "${key}"`);
    }
    sanitized[key] = value;
  }
  await writeSecureFile(path.join(getBotDir(dataDir, botId), 'env.json'), JSON.stringify(sanitized, null, 2));
  return sanitized;
}

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

export function getBotWorkspaceDir(dataDir: string, botId: string): string {
  return path.join(getBotDir(dataDir, botId), 'workspace');
}

/** Bot 级主题记忆目录：<dataDir>/bots/<botId>/memory（分层渐进式披露的详细归档层） */
export function getBotMemoryDir(dataDir: string, botId: string): string {
  return path.join(getBotDir(dataDir, botId), 'memory');
}

/** 列出 Bot 的主题记忆文件（仅 .md，字母序）；目录不存在时返回空数组 */
export async function listBotMemoryTopics(dataDir: string, botId: string): Promise<string[]> {
  const memoryDir = getBotMemoryDir(dataDir, botId);
  if (!existsSync(memoryDir)) return [];
  const entries = await fs.readdir(memoryDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/** 读取节点级共享记忆 <dataDir>/MEMORY.md（不存在时返回空串） */
export async function readNodeMemory(dataDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(dataDir, 'MEMORY.md'), 'utf-8');
  } catch {
    return '';
  }
}

/** 原子写入节点级共享记忆 <dataDir>/MEMORY.md */
export async function writeNodeMemory(dataDir: string, content: string): Promise<void> {
  await ensureDir(dataDir);
  await writeAtomicFile(path.join(dataDir, 'MEMORY.md'), content);
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
  const existing = await readBot(dataDir, bot.id).catch(() => null);
  if (existing?.bot.parentBotId && existing.bot.parentBotId !== bot.parentBotId) {
    const oldParentDir = getBotDir(dataDir, existing.bot.parentBotId);
    await fs.rm(path.join(oldParentDir, 'agents', `${bot.id}.md`), { force: true }).catch(() => {});
  }

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

  const subagentsJsonContent = JSON.stringify(
    {
      disableDefaultAgents: false,
      disableDefaults: false,
      fallbackSubagent: 'none',
      backgroundByDefault: false,
      packageAgents: false,
      defaultJoinMode: 'smart',
    },
    null,
    2
  );

  if (bot.parentBotId) {
    assertSafeId(bot.parentBotId, 'Parent Bot ID');
    const parentBotDir = getBotDir(dataDir, bot.parentBotId);
    const parentAgentsDir = path.join(parentBotDir, 'agents');
    await ensureDir(parentAgentsDir);

    const frontmatterLines = [
      '---',
      `name: ${bot.id}`,
      `display_name: ${bot.name}`,
      `description: ${bot.description || ''}`,
    ];
    if (!bot.inheritModel && bot.modelProvider && bot.modelId) {
      frontmatterLines.push(`model: ${bot.modelProvider}/${bot.modelId}`);
    }
    if (bot.thinkingLevel) {
      frontmatterLines.push(`thinking: ${bot.thinkingLevel}`);
    }
    if (bot.toolScope === 'readonly') {
      frontmatterLines.push('tools: read, grep, find, ls');
    } else if (bot.toolScope === 'custom' && bot.customTools?.length) {
      frontmatterLines.push(`tools: ${bot.customTools.join(', ')}`);
    }
    frontmatterLines.push('---');
    const agentMdContent = `${frontmatterLines.join('\n')}\n\n${systemMd ?? ''}`;

    await writeAtomicFile(path.join(parentAgentsDir, `${bot.id}.md`), agentMdContent);
    await writeAtomicFile(path.join(parentBotDir, 'subagents.json'), subagentsJsonContent);
  } else {
    await ensureDir(path.join(botDir, 'agents'));
    await writeAtomicFile(path.join(botDir, 'subagents.json'), subagentsJsonContent);
  }
}

export async function deleteBot(dataDir: string, botId: string): Promise<void> {
  assertSafeId(botId, 'Bot ID');
  const existing = await readBot(dataDir, botId).catch(() => null);
  if (existing?.bot.parentBotId) {
    const parentBotDir = getBotDir(dataDir, existing.bot.parentBotId);
    const agentMd = path.join(parentBotDir, 'agents', `${botId}.md`);
    await fs.rm(agentMd, { force: true }).catch(() => {});
  }
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

export async function deleteResource(
  dataDir: string,
  target: { kind: 'skill' | 'extension'; id: string }
): Promise<void> {
  assertSafeId(target.id, `${target.kind === 'skill' ? 'Skill' : 'Extension'} ID`);
  if (target.kind === 'skill') {
    await fs.rm(getSkillDir(dataDir, target.id), { recursive: true, force: true });
    // Discovery also surfaces copies under the Agent Skills standard dirs.
    await fs.rm(path.join(dataDir, '.agents', 'skills', target.id), { recursive: true, force: true });
    await fs.rm(path.join(dataDir, '.agent', 'skills', target.id), { recursive: true, force: true });
    return;
  }
  if (target.kind === 'extension') {
    const extDir = getExtensionDir(dataDir, target.id);
    await fs.rm(extDir, { recursive: true, force: true });
    return;
  }
  throw new Error(`Unsupported resource kind: ${(target as any).kind}`);
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

export async function readFileTarget(
  dataDir: string,
  target: { kind: 'system' | 'memory' | 'env' | 'skill' | 'extension'; botId?: string; id: string }
): Promise<string> {
  if (target.kind === 'env') {
    const botId = target.botId || target.id;
    if (!botId) throw new Error('Bot ID required');
    const env = await readBotEnv(dataDir, botId);
    return JSON.stringify(env, null, 2);
  }
  if (target.kind === 'skill') {
    const skillId = target.id || target.botId;
    if (!skillId) throw new Error('Skill ID required');
    return readSkill(dataDir, skillId);
  }
  if (target.kind === 'extension') {
    const extId = target.id || target.botId;
    if (!extId) throw new Error('Extension ID required');
    return readExtension(dataDir, extId);
  }

  const botId = target.botId || target.id;
  if (!botId) throw new Error('Bot ID required');
  assertSafeId(botId, 'Bot ID');
  const botDir = getBotDir(dataDir, botId);

  if (target.kind === 'system') {
    return fs.readFile(path.join(botDir, 'SYSTEM.md'), 'utf8').catch(() => '');
  }
  if (target.kind === 'memory') {
    return fs.readFile(path.join(botDir, 'MEMORY.md'), 'utf8').catch(() => '');
  }

  throw new Error(`Unsupported read target kind: ${target.kind}`);
}

export async function writeFileTarget(
  dataDir: string,
  target: { kind: 'system' | 'memory' | 'env' | 'skill' | 'extension'; botId?: string; id: string },
  content: string
): Promise<void> {
  if (target.kind === 'env') {
    const botId = target.botId || target.id;
    if (!botId) throw new Error('Bot ID required');
    const parsed = content.trim() ? (JSON.parse(content) as Record<string, string>) : {};
    await writeBotEnv(dataDir, botId, parsed);
    return;
  }
  if (target.kind === 'skill') {
    const skillId = target.id || target.botId;
    if (!skillId) throw new Error('Skill ID required');
    await writeSkill(dataDir, skillId, content);
    return;
  }
  if (target.kind === 'extension') {
    const extId = target.id || target.botId;
    if (!extId) throw new Error('Extension ID required');
    await writeExtension(dataDir, extId, content);
    return;
  }

  const botId = target.botId || target.id;
  if (!botId) throw new Error('Bot ID required');
  assertSafeId(botId, 'Bot ID');
  const botDir = getBotDir(dataDir, botId);
  await ensureDir(botDir);

  if (target.kind === 'system') {
    await writeAtomicFile(path.join(botDir, 'SYSTEM.md'), content);
    return;
  }
  if (target.kind === 'memory') {
    await writeAtomicFile(path.join(botDir, 'MEMORY.md'), content);
    return;
  }

  throw new Error(`Unsupported write target kind: ${target.kind}`);
}

export async function seedStorageIfEmpty(dataDir: string, nodeId: string): Promise<void> {
  await ensureDir(dataDir);
  await ensureDir(path.join(dataDir, 'skills'));
  await ensureDir(path.join(dataDir, 'extensions'));
  await ensureDir(path.join(dataDir, 'bots'));

  // 1. Seed example skill if the primary skills dir has none. Discovery also
  // surfaces ~/.agents/skills etc., so check <dataDir>/skills directly: the
  // default bot enables cli-helper and seeding always targets the primary dir.
  if ((await listSkillEntriesInDir(path.join(dataDir, 'skills'))).length === 0) {
    const exampleSkill = `# CLI Helper Skill

This node executes tasks using local CLI tools.

## Guidelines
- When learning a new CLI tool, run \`<command> --help\` first.
- Execute bash commands directly to perform operations.
- Long-running background jobs can asynchronously wake the current session using:
  \`botd wake --session "$BOTD_SESSION_ID" --bot "$BOTD_BOT_ID" --message "Result"\`
`;
    await writeSkill(dataDir, 'cli-helper', exampleSkill);
  }

  // 2. Seed default bot if none exists
  const bots = await listBots(dataDir);
  if (bots.length === 0) {
    const safeNodeSuffix = nodeId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const defaultBotId = `assistant-${safeNodeSuffix}`;
    const defaultBot: BotConfig = {
      id: defaultBotId,
      nodeId,
      name: '默认助手',
      description: 'Default personal assistant for this node',
      // 不预填任何模型：等用户在已配置凭据的服务商中选型，避免「未配置却在用」的假象
      modelProvider: '',
      modelId: '',
      thinkingLevel: 'medium',
      enabledSkills: ['cli-helper'],
      enabledExtensions: [],
      updatedAt: new Date().toISOString(),
    };

    const systemPrompt = `You are a helpful AI assistant operating on node "${nodeId}".
You have access to local tools and command-line execution to solve user problems concisely and accurately.`;

    await saveBot(dataDir, defaultBot, systemPrompt);
  }
}
