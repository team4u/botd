import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isSafeId, isValidBotEnvKey, type BotConfig, type NodeIdentity } from '@botd/protocol';

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
    } catch {
      // Ignore unconfigured or partial directories
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

  const botWithTimestamp: BotConfig = {
    ...bot,
    enabledSkills: Array.isArray(bot.enabledSkills) ? bot.enabledSkills : [],
    enabledExtensions: Array.isArray(bot.enabledExtensions) ? bot.enabledExtensions : [],
    updatedAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(botDir, 'bot.json'), JSON.stringify(botWithTimestamp, null, 2), 'utf8');

  if (systemMd !== undefined) {
    await fs.writeFile(path.join(botDir, 'SYSTEM.md'), systemMd, 'utf8');
  }

  const memoryPath = path.join(botDir, 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    await fs.writeFile(memoryPath, '', 'utf8');
  }
}

export async function deleteBot(dataDir: string, botId: string): Promise<void> {
  assertSafeId(botId, 'Bot ID');
  const botDir = getBotDir(dataDir, botId);
  await fs.rm(botDir, { recursive: true, force: true });
}

export async function listSkills(dataDir: string): Promise<string[]> {
  const skillsDir = path.join(dataDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const skills: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
    if (existsSync(skillMd)) {
      skills.push(entry.name);
    }
  }
  return skills;
}

export async function readSkill(dataDir: string, skillId: string): Promise<string> {
  assertSafeId(skillId, 'Skill ID');
  const skillMd = path.join(getSkillDir(dataDir, skillId), 'SKILL.md');
  return fs.readFile(skillMd, 'utf8');
}

export async function writeSkill(dataDir: string, skillId: string, content: string): Promise<void> {
  assertSafeId(skillId, 'Skill ID');
  const skillDir = getSkillDir(dataDir, skillId);
  await ensureDir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8');
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
  await fs.writeFile(path.join(extDir, 'index.ts'), content, 'utf8');
}

export async function deleteResource(
  dataDir: string,
  target: { kind: 'skill' | 'extension'; id: string }
): Promise<void> {
  assertSafeId(target.id, `${target.kind === 'skill' ? 'Skill' : 'Extension'} ID`);
  if (target.kind === 'skill') {
    const skillDir = getSkillDir(dataDir, target.id);
    await fs.rm(skillDir, { recursive: true, force: true });
    return;
  }
  if (target.kind === 'extension') {
    const extDir = getExtensionDir(dataDir, target.id);
    await fs.rm(extDir, { recursive: true, force: true });
    return;
  }
  throw new Error(`Unsupported resource kind: ${(target as any).kind}`);
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
    await fs.writeFile(path.join(botDir, 'SYSTEM.md'), content, 'utf8');
    return;
  }
  if (target.kind === 'memory') {
    await fs.writeFile(path.join(botDir, 'MEMORY.md'), content, 'utf8');
    return;
  }

  throw new Error(`Unsupported write target kind: ${target.kind}`);
}

export async function seedStorageIfEmpty(dataDir: string, nodeId: string): Promise<void> {
  await ensureDir(dataDir);
  await ensureDir(path.join(dataDir, 'skills'));
  await ensureDir(path.join(dataDir, 'extensions'));
  await ensureDir(path.join(dataDir, 'bots'));

  // 1. Seed example skill if none exists
  const skills = await listSkills(dataDir);
  if (skills.length === 0) {
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
      modelProvider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
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
