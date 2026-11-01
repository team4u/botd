import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import type { BotConfig, ChatCommand } from '@botd/protocol';
import { assertSafeId, getBotDir } from './storage.js';

async function resolveExtensionPaths(dataDir: string, ids: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const id of ids) {
    assertSafeId(id, 'Extension ID');
    const dir = path.join(dataDir, 'extensions', id);
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      if (pkg && typeof pkg === 'object' && 'pi' in pkg) {
        paths.push(dir);
        continue;
      }
    } catch {
      // A standalone extension need not have a package manifest.
    }
    if (existsSync(path.join(dir, 'index.ts'))) paths.push(path.join(dir, 'index.ts'));
    else if (existsSync(pkgPath)) paths.push(dir);
  }
  return paths;
}

/** Use the same explicit resource paths for discovery and execution. */
export async function loadBotResources(
  dataDir: string,
  bot: BotConfig,
  settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } }),
  appendSystemPrompt: () => string[] = () => [],
): Promise<DefaultResourceLoader> {
  const botDir = getBotDir(dataDir, bot.id);
  const promptsDir = path.join(botDir, 'prompts');
  const skillPaths = (bot.enabledSkills ?? []).map(id => {
    assertSafeId(id, 'Skill ID');
    return path.join(dataDir, 'skills', id);
  });
  const loader = new DefaultResourceLoader({
    cwd: path.join(botDir, 'workspace'),
    agentDir: botDir,
    settingsManager,
    noSkills: true,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: skillPaths,
    additionalExtensionPaths: await resolveExtensionPaths(dataDir, bot.enabledExtensions ?? []),
    additionalPromptTemplatePaths: existsSync(promptsDir) ? [promptsDir] : [],
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: appendSystemPrompt,
  });
  // Pi clears the module cache on reload so edited extensions are visible next time.
  (loader as unknown as { loaded: boolean }).loaded = true;
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw new Error(errors.map(error => `${error.path}: ${error.error}`).join('\n'));
  return loader;
}

/** Preserve Pi's native dispatch precedence and real invocation names across extensions, skills, and prompts. */
export function collectBotCommands(
  loader: ResourceLoader,
  runner: Pick<ExtensionRunner, 'getRegisteredCommands'>,
): ChatCommand[] {
  const commands: ChatCommand[] = [];
  const claimed = new Set<string>();
  for (const command of runner.getRegisteredCommands()) {
    claimed.add(command.invocationName);
    commands.push({ name: command.invocationName, description: command.description, source: 'extension' });
  }
  for (const skill of loader.getSkills().skills) {
    const name = `skill:${skill.name}`;
    if (claimed.has(name)) continue;
    claimed.add(name);
    commands.push({ name, description: skill.description, source: 'skill' });
  }
  for (const template of loader.getPrompts().prompts) {
    if (claimed.has(template.name)) continue;
    claimed.add(template.name);
    commands.push({ name: template.name, description: template.description, source: 'prompt', argumentHint: template.argumentHint });
  }
  return commands;
}

/** Discover commands without selecting a model or starting an extension session. */
export async function getBotCommands(dataDir: string, bot: BotConfig): Promise<ChatCommand[]> {
  const loader = await loadBotResources(dataDir, bot);
  const { extensions, runtime } = loader.getExtensions();
  const botDir = getBotDir(dataDir, bot.id);
  const cwd = path.join(botDir, 'workspace');
  // The runner's registry is unused during discovery; keep its backing store isolated
  // and skip model availability/authentication checks.
  const models = await ModelRuntime.create({
    authPath: path.join(dataDir, '.agent', 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), new ModelRegistry(models));
  try {
    return collectBotCommands(loader, runner);
  } finally {
    runner.invalidate();
  }
}
