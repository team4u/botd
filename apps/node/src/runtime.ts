import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  createAgentSession,
  createBashToolDefinition,
  type ToolDefinition,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai/compat';
import type { BirpcReturn } from 'birpc';
import type { HubRpcFunctions, NodeRpcFunctions, BotConfig } from '@botd/protocol';
import {
  assertSafeId,
  ensureDir,
  getBotDir,
  readBot,
  readSkill,
} from './storage.js';
import { createRuntimeForProvider, configureProviderAuth } from './models.js';
import { BUILTIN_SKILL_ID } from './builtin-skill.js';
import { collectBotCommands, loadBotResources } from './commands.js';
import { guardExtensionCommands } from './web-command-ui.js';
export { getBotCommands } from './commands.js';

const pendingRuns = new Set<string>();
const activeSessions = new Map<string, AgentSession>();
const cancelledRuns = new Set<string>();
const runKeyToDataDir = new Map<string, string>();

let tsxLoaderUrl: string | undefined;
try {
  tsxLoaderUrl = import.meta.resolve('tsx');
} catch {
  // Ignore fallback if resolve is unavailable
}

export function getTsxLoaderUrl(): string | undefined {
  return tsxLoaderUrl;
}

export function getActiveSessionCount(): number {
  return activeSessions.size + pendingRuns.size;
}

export function resolveCliEntry(): { cliPath: string; isTypeScript: boolean } {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const tsCli = path.join(thisDir, 'cli.ts');
  const jsCli = path.join(thisDir, 'cli.js');
  if (existsSync(tsCli)) {
    return { cliPath: tsCli, isTypeScript: true };
  }
  return { cliPath: jsCli, isTypeScript: false };
}

export async function ensureBotdBinWrapper(dataDir: string): Promise<string> {
  const binDir = path.join(dataDir, 'bin');
  await ensureDir(binDir);
  const botdBin = path.join(binDir, 'botd');
  const { cliPath, isTypeScript } = resolveCliEntry();
  const execPath = process.execPath;

  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const executable = shellQuote(execPath);
  const cliEntry = shellQuote(cliPath);
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

  return binDir;
}

export async function executeBotTurn(
  dataDir: string,
  bot: BotConfig,
  input: Parameters<NodeRpcFunctions['runTurn']>[0],
  hubRpc: BirpcReturn<HubRpcFunctions, NodeRpcFunctions>
): Promise<{ replyText: string; modelBadge: string }> {
  assertSafeId(bot.id, 'Bot ID');
  assertSafeId(input.sessionId, 'Session ID');

  const runKey = `${input.sessionId}:${bot.id}`;
  if (pendingRuns.has(runKey) || activeSessions.has(runKey)) {
    throw new Error(`Turn already running for session ${input.sessionId} and bot ${bot.id}`);
  }

  // Reserve runKey immediately before any awaits
  pendingRuns.add(runKey);
  runKeyToDataDir.set(runKey, dataDir);
  cancelledRuns.delete(runKey);

  let session: AgentSession | null = null;
  let unsubscribe: (() => void) | null = null;

  try {
    const botDir = getBotDir(dataDir, bot.id);
    const workspaceDir = path.join(botDir, 'workspace');
    const sessionDir = path.join(botDir, 'sessions');
    const sessionFile = path.join(sessionDir, `${input.sessionId}.jsonl`);

    await ensureDir(workspaceDir);
    await ensureDir(sessionDir);

    if (cancelledRuns.has(runKey)) {
      throw new Error('Turn was cancelled');
    }

    // 1. Prepare dataDir/bin/botd wrapper for local CLI wake invocations
    const binDir = await ensureBotdBinWrapper(dataDir);

    // 2. Setup isolated ModelRuntime under .agent and configure provider auth.
    //    Extension-registered providers (e.g. magpie gateway) activate on demand.
    const modelRuntime = await createRuntimeForProvider(dataDir, bot.modelProvider);
    await configureProviderAuth(modelRuntime, dataDir, bot.modelProvider);

    // 3. Resolve model
    let model: ReturnType<typeof getModel> | undefined =
      modelRuntime.getModel(bot.modelProvider, bot.modelId) ??
      getModel(bot.modelProvider as any, bot.modelId as any);

    // Extension-provider models may never have been catalogued (fresh install,
    // never opened the catalog page): fetch that provider's catalog once and retry.
    if (!model && modelRuntime.getProvider(bot.modelProvider)) {
      try {
        await modelRuntime.refresh({
          allowNetwork: true,
          providers: [bot.modelProvider],
          force: false,
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        // Network failure falls through to the not-found error below
      }
      model = modelRuntime.getModel(bot.modelProvider, bot.modelId);
    }

    if (!model) {
      throw new Error(`Model not found in catalog: ${bot.modelProvider}/${bot.modelId}`);
    }

    // 5. Read bot files and enabled skills
    const botData = await readBot(dataDir, bot.id);
    const systemMd = botData?.systemMd || '';
    const memoryMd = botData?.memoryMd || '';

    // Enabled skills are advertised natively by Pi (name + description + path in the
    // system prompt); their full instructions load on demand via /skill:name or the
    // model reading SKILL.md. Only the framework's builtin discipline stays inline.
    const skillContents: string[] = [];
    try {
      const builtin = await readSkill(dataDir, BUILTIN_SKILL_ID);
      if (builtin.trim()) {
        skillContents.push(`### Skill: ${BUILTIN_SKILL_ID} (builtin)\nPath: ${path.join(dataDir, 'skills', BUILTIN_SKILL_ID, 'SKILL.md')}\n\n${builtin}`);
      }
    } catch {
      // Builtin skill not installed yet; daemon seeds it on next start
    }

    // Use the same Pi resource configuration as command discovery.
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: bot.modelProvider,
      defaultModel: bot.modelId,
      compaction: { enabled: false },
    });
    const resourceLoader = await loadBotResources(dataDir, bot, settingsManager, () =>
      [
        `[系统上下文提醒]\n当前 Session ID: ${input.sessionId} | 当前 BOT: @${bot.id}\n- 如需通过后台脚本异步唤醒当前会话，请执行命令:\n  \`botd wake --session ${input.sessionId} --bot ${bot.id} --message "状态说明"\``,
        input.groupContextPrompt,
        input.commandText && input.incrementalMessages.trim()
          ? `[近期对话历史]\n${input.incrementalMessages}` : '',
        systemMd ? `[角色设定]\n${systemMd}` : '',
        `[长期记忆 (可通过 ../MEMORY.md 更新)]\n${memoryMd}\n（说明：你可以使用 edit/write 工具修改 \`../MEMORY.md\` 来更新长期记忆；当用户要求你学习某个本机 CLI 工具并保存为 Skill 时，可执行 \`<cli> --help\` 并将总结写入 \`../../../skills/<skillId>/SKILL.md\`。）`,
        skillContents.length > 0 ? `[框架内置 Skills]\n\n${skillContents.join('\n\n')}` : '',
      ].filter(Boolean),
    );

    // 8. Custom bash tool with per-turn env injection without mutating global process.env
    const rawBashDef = createBashToolDefinition(workspaceDir, {
      spawnHook: (ctx) => ({
        ...ctx,
        env: {
          ...ctx.env,
          PATH: `${binDir}:${ctx.env.PATH || ''}`,
          BOTD_SESSION_ID: input.sessionId,
          BOTD_BOT_ID: bot.id,
          BOTD_DATA_DIR: dataDir,
        },
      }),
    });
    // Omit optional UI renderers to satisfy invariant ToolDefinition generic bounds
    const { renderCall: _rc, renderResult: _rr, ...headlessBashTool } = rawBashDef;
    const customBashTool = headlessBashTool as unknown as ToolDefinition;

    // 9. Create durable agent session
    const sessionManager = SessionManager.open(sessionFile, sessionDir, workspaceDir);

    if (cancelledRuns.has(runKey)) {
      throw new Error('Turn was cancelled');
    }

    const created = await createAgentSession({
      cwd: workspaceDir,
      agentDir: botDir,
      model,
      thinkingLevel: bot.thinkingLevel ?? 'medium',
      modelRuntime,
      resourceLoader,
      customTools: [customBashTool],
      sessionManager,
      settingsManager,
    });

    session = created.session;
    pendingRuns.delete(runKey);
    activeSessions.set(runKey, session);

    if (cancelledRuns.has(runKey)) {
      throw new Error('Turn was cancelled');
    }

    // 10. Subscribe to streaming events and report to Hub
    unsubscribe = session.subscribe((event: any) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          deltaText: event.assistantMessageEvent.delta,
        });
      } else if (event.type === 'tool_execution_start') {
        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          toolName: event.toolName,
          toolStatus: 'running',
        });
      } else if (event.type === 'tool_execution_end') {
        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          toolName: event.toolName,
          toolStatus: 'done',
        });
      }
    });

    const boundSession = session;
    const extensionErrors: string[] = [];
    const messageCountBefore = session.messages.length;
    const unsupportedSessionAction = async (): Promise<never> => {
      throw new Error('此扩展命令的会话操作暂不支持在网页中运行');
    };
    await session.bindExtensions({
      mode: 'print',
      commandContextActions: {
        waitForIdle: () => boundSession.waitForIdle(),
        newSession: unsupportedSessionAction,
        fork: unsupportedSessionAction,
        navigateTree: unsupportedSessionAction,
        switchSession: unsupportedSessionAction,
        reload: unsupportedSessionAction,
      },
      onError: error => {
        if (!extensionErrors.includes(error.error)) extensionErrors.push(error.error);
      },
    });
    if (extensionErrors.length) throw new Error(extensionErrors.join('\n'));
    if (cancelledRuns.has(runKey)) throw new Error('Turn was cancelled');

    guardExtensionCommands(resourceLoader, error => {
      if (!extensionErrors.includes(error.message)) extensionErrors.push(error.message);
    });

    const promptText = input.commandText?.trim() || input.incrementalMessages?.trim() || '(continue)';
    if (input.commandText !== undefined) {
      const commandName = promptText.slice(1).split(' ', 1)[0];
      if (!/^\/[^\s/]+(?: |$)/.test(promptText)) throw new Error('无效的斜杠命令，请用空格分隔命令名与参数');
      if (!collectBotCommands(resourceLoader, session.extensionRunner).some(command => command.name === commandName)) {
        throw new Error(`未知或不可用的命令 /${commandName}`);
      }
    }
    await session.prompt(promptText);
    await session.waitForIdle();
    if (extensionErrors.length) throw new Error(extensionErrors.join('\n'));
    if (cancelledRuns.has(runKey)) throw new Error('Turn was cancelled');

    // A handled extension command may not create an assistant message. Inspect only
    // this run's messages so previous replies/errors never become the command result.
    const lastAssistant = session.messages.slice(messageCountBefore).filter(message => message.role === 'assistant').at(-1);
    if (lastAssistant?.stopReason === 'error') throw new Error(lastAssistant.errorMessage || 'Model inference failed');
    if (lastAssistant?.stopReason === 'aborted') throw new Error(lastAssistant.errorMessage || 'Turn was cancelled');
    const replyText = lastAssistant?.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      || '（已完成执行，无文本输出）';
    return {
      replyText,
      modelBadge: `${bot.modelProvider}/${bot.modelId}`,
    };
  } finally {
    if (unsubscribe) {
      unsubscribe();
    }
    pendingRuns.delete(runKey);
    activeSessions.delete(runKey);
    cancelledRuns.delete(runKey);
    runKeyToDataDir.delete(runKey);
    if (session) {
      session.dispose();
    }
  }
}

/**
 * 归档 (sessionId, botId) 的本地 Pi 会话文件（改名为 `.jsonl.bak-<ts>`，不删除），
 * 下一回合将从 Hub 历史全量重建上下文。文件不存在时静默成功（幂等）。
 */
export async function resetBotSession(dataDir: string, sessionId: string, botId: string): Promise<void> {
  assertSafeId(sessionId, 'Session ID');
  assertSafeId(botId, 'Bot ID');

  const runKey = `${sessionId}:${botId}`;
  if (pendingRuns.has(runKey)) {
    throw new Error('Turn is running and cannot be reset');
  }

  // Defensive: a live session for this key should not exist when idle, but if it
  // does, tear it down before deleting so it cannot write back to the old file.
  const activeSession = activeSessions.get(runKey);
  if (activeSession) {
    activeSessions.delete(runKey);
    activeSession.dispose();
  }

  const sessionFile = path.join(getBotDir(dataDir, botId), 'sessions', `${sessionId}.jsonl`);
  if (!existsSync(sessionFile)) {
    return;
  }
  await fs.rm(sessionFile);
}

export async function cancelBotTurn(sessionId: string, botId: string): Promise<void> {
  const runKey = `${sessionId}:${botId}`;
  cancelledRuns.add(runKey);
  const session = activeSessions.get(runKey);
  if (session) {
    await session.abort();
  }
}

export async function cancelAllBotTurns(dataDir?: string): Promise<void> {
  const abortPromises: Promise<void>[] = [];
  for (const [runKey, session] of activeSessions.entries()) {
    if (!dataDir || runKeyToDataDir.get(runKey) === dataDir) {
      cancelledRuns.add(runKey);
      abortPromises.push(session.abort().catch(() => {}));
    }
  }
  for (const runKey of pendingRuns.keys()) {
    if (!dataDir || runKeyToDataDir.get(runKey) === dataDir) {
      cancelledRuns.add(runKey);
    }
  }
  await Promise.all(abortPromises);
}
