import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  createAgentSession,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  type ToolDefinition,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai/compat';
import type { BirpcReturn } from 'birpc';
import type { HubRpcFunctions, NodeRpcFunctions, BotConfig, ToolCallRecord, TurnUsage } from '@botd/protocol';
import {
  assertSafeId,
  ensureDir,
  getBotDir,
  readBot,
  readBotEnv,
  readSkill,
} from './storage.js';
import { createRuntimeForProvider, configureProviderAuth } from './models.js';
import { BUILTIN_SKILL_ID } from './builtin-skill.js';
import { collectBotCommands, loadBotResources } from './commands.js';
import { guardExtensionCommands } from './web-command-ui.js';
import { resolveWindowsBash, windowsShellPathPrefix, isWindows } from './windows-shell.js';
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

export function buildBotShellEnv(
  baseEnv: Record<string, string | undefined>,
  options: {
    dataDir: string;
    binDir: string;
    sessionId: string;
    botId: string;
    botEnv: Record<string, string>;
  }
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
  };
}

export function extractToolSummary(toolName: string, args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  if (toolName === 'bash' && typeof args.command === 'string') {
    return args.command.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  if (['read', 'write', 'edit'].includes(toolName) && typeof args.path === 'string') {
    return args.path;
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string') {
      const compact = value.replace(/\s+/g, ' ').trim().slice(0, 100);
      if (compact) return compact;
    }
  }
  return undefined;
}

export async function executeBotTurn(
  dataDir: string,
  bot: BotConfig,
  input: Parameters<NodeRpcFunctions['runTurn']>[0],
  hubRpc: BirpcReturn<HubRpcFunctions, NodeRpcFunctions>
): Promise<{
  replyText: string;
  modelBadge: string;
  toolCalls?: ToolCallRecord[];
  usage?: TurnUsage;
}> {
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

    let attachmentNotice = '';
    const turnImages: { type: 'image'; data: string; mimeType: string }[] = [];
    const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    if (input.attachments && input.attachments.length > 0) {
      const inboxDir = path.join(workspaceDir, 'inbox');
      await ensureDir(inboxDir);
      for (const att of input.attachments) {
        try {
          const downloaded = await hubRpc.downloadArtifact(att.id);
          if (downloaded?.contentBase64) {
            const destPath = path.join(inboxDir, path.basename(att.filename));
            await fs.writeFile(destPath, Buffer.from(downloaded.contentBase64, 'base64'));
            const mime = (att.mimeType || downloaded.artifact?.mimeType || '').toLowerCase();
            if (VISION_MIME_TYPES.has(mime)) {
              turnImages.push({ type: 'image', data: downloaded.contentBase64, mimeType: mime });
            }
          }
        } catch {
          // If an attachment isn't in artifacts table, don't crash the turn
        }
      }
      const fileList = input.attachments
        .map((att) => `inbox/${path.basename(att.filename)} (id: ${att.id}, ${att.mimeType}, ${att.sizeBytes} bytes)`)
        .join('\n');
      attachmentNotice = `[本轮收到文件附件]\n已自动下载至工作区 inbox/ 目录：\n${fileList}`;
    }

    if (cancelledRuns.has(runKey)) {
      throw new Error('Turn was cancelled');
    }

    // 1. Prepare dataDir/bin/botd wrapper for local CLI wake invocations
    const binDir = await ensureBotdBinWrapper(dataDir);

    // 2. Setup isolated ModelRuntime under .agent and configure provider auth.
    //    Extension-registered providers (e.g. magpie gateway) activate on demand.
    const modelRuntime = await createRuntimeForProvider(dataDir, bot.modelProvider);
    await configureProviderAuth(modelRuntime, bot.modelProvider);

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
    const botEnv = await readBotEnv(dataDir, bot.id);
    const botEnvKeys = Object.keys(botEnv);

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
      compaction: { enabled: process.env.BOTD_AUTO_COMPACT === '1' },
    });
    const resourceLoader = await loadBotResources(dataDir, bot, settingsManager, () =>
      [
        `[系统上下文提醒]\n当前 Session ID: ${input.sessionId} | 当前 BOT: @${bot.id}\n- 如需通过后台脚本异步唤醒当前会话，请执行命令:\n  \`botd wake --session ${input.sessionId} --bot ${bot.id} --message "状态说明"\``,
        input.groupContextPrompt,
        attachmentNotice,
        input.commandText && input.incrementalMessages.trim()
          ? `[近期对话历史]\n${input.incrementalMessages}` : '',
        systemMd ? `[角色设定]\n${systemMd}` : '',
        `[长期记忆 (可通过 ../MEMORY.md 更新)]\n${memoryMd}\n（说明：你可以使用 edit/write 工具修改 \`../MEMORY.md\` 来更新长期记忆；当用户要求你学习某个本机 CLI 工具并保存为 Skill 时，可执行 \`<cli> --help\` 并将总结写入 \`../../../skills/<skillId>/SKILL.md\`。）`,
        botEnvKeys.length > 0
          ? `[已注入专属环境变量]\n当前命令执行环境已预置以下环境变量（可直接在命令或脚本中通过 $VAR 引用，请勿在公屏直接打印密钥明文）：${botEnvKeys.map((k) => `$${k}`).join(', ')}`
          : '',
        skillContents.length > 0 ? `[框架内置 Skills]\n\n${skillContents.join('\n\n')}` : '',
      ].filter(Boolean),
    );

    // 8. Custom bash tool with per-turn env injection without mutating global process.env.
    //    On Windows: pin the resolved bash.exe (Git Bash or managed MinGit) and extend
    //    PATH with the POSIX delimiter while preserving the platform's Path casing.
    const isWin = isWindows;
    const shellPath = isWin ? resolveWindowsBash(dataDir) : undefined;

    const rawBashDef = createBashToolDefinition(workspaceDir, {
      ...(shellPath ? { shellPath } : {}),
      spawnHook: (ctx) => ({
        ...ctx,
        env: buildBotShellEnv(ctx.env, {
          dataDir,
          binDir,
          sessionId: input.sessionId,
          botId: bot.id,
          botEnv,
        }),
      }),
    });
    // Omit optional UI renderers to satisfy invariant ToolDefinition generic bounds
    const { renderCall: _rc, renderResult: _rr, ...headlessBashTool } = rawBashDef;
    const customTools: ToolDefinition[] = [headlessBashTool as unknown as ToolDefinition];

    // Windows: also expose the native PowerShell tool so the model can drive
    // Windows-native workflows (registry, services, cmdlets) without bash.
    if (isWin) {
      try {
        const rawPsDef = createPowerShellToolDefinition(workspaceDir, {
          spawnHook: (ctx) => ({
            ...ctx,
            env: buildBotShellEnv(ctx.env, {
              dataDir,
              binDir,
              sessionId: input.sessionId,
              botId: bot.id,
              botEnv,
            }),
          }),
        });
        const { renderCall: _prc, renderResult: _prr, ...headlessPsTool } = rawPsDef;
        customTools.push(headlessPsTool as unknown as ToolDefinition);
      } catch {
        // PowerShell discovery failed (headless Windows core?) — bash remains.
      }
    }

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
      customTools,
      sessionManager,
      settingsManager,
    });

    session = created.session;
    pendingRuns.delete(runKey);
    activeSessions.set(runKey, session);

    if (cancelledRuns.has(runKey)) {
      throw new Error('Turn was cancelled');
    }

    const toolCalls: ToolCallRecord[] = [];
    const runningToolStarts = new Map<string, { index: number; startMs: number; summary?: string }>();

    // 10. Subscribe to streaming events and report to Hub
    unsubscribe = session.subscribe((event: any) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          deltaText: event.assistantMessageEvent.delta,
        });
      } else if (event.type === 'tool_execution_start') {
        const summary = extractToolSummary(event.toolName, event.args ?? event.input);
        const key = event.toolCallId || event.toolName;
        const index = toolCalls.length;
        toolCalls.push({
          name: event.toolName,
          ...(summary ? { summary } : {}),
          status: 'running',
        });
        runningToolStarts.set(key, { index, startMs: Date.now(), summary });
        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          toolName: event.toolName,
          toolStatus: 'running',
          toolSummary: summary,
        });
      } else if (event.type === 'tool_execution_end') {
        const key = event.toolCallId || event.toolName;
        const running = runningToolStarts.get(key);
        let summary: string | undefined;
        if (running) {
          runningToolStarts.delete(key);
          summary = running.summary;
          const entry = toolCalls[running.index];
          if (entry) {
            entry.status = event.isError ? 'error' : 'done';
            entry.durationMs = Math.max(0, Date.now() - running.startMs);
          }
        }
        if (!summary) {
          summary = extractToolSummary(event.toolName, event.args ?? event.input);
        }
        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          toolName: event.toolName,
          toolStatus: 'done',
          toolSummary: summary,
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

    let promptText = input.commandText?.trim() || input.incrementalMessages?.trim() || '(continue)';
    if (!input.commandText && attachmentNotice) {
      promptText = input.incrementalMessages?.trim()
        ? `${input.incrementalMessages.trim()}\n\n${attachmentNotice}`
        : attachmentNotice;
    }

    const isCompactCommand = input.commandText?.trim() === '/compact';
    if (input.commandText !== undefined && !isCompactCommand) {
      const commandName = promptText.slice(1).split(' ', 1)[0];
      if (!/^\/[^\s/]+(?: |$)/.test(promptText)) throw new Error('无效的斜杠命令，请用空格分隔命令名与参数');
      if (!collectBotCommands(resourceLoader, session.extensionRunner).some(command => command.name === commandName)) {
        throw new Error(`未知或不可用的命令 /${commandName}`);
      }
    }

    let isCompactSmall = false;
    if (isCompactCommand) {
      if (typeof (session as any).compact === 'function') {
        try {
          await (session as any).compact();
        } catch (err: any) {
          if (err?.message?.includes('Nothing to compact') || err?.message?.includes('too small')) {
            isCompactSmall = true;
          } else {
            throw err;
          }
        }
      } else {
        await session.prompt('/compact');
      }
    } else {
      const modelSupportsVision =
        !Array.isArray((model as any).input) || (model as any).input.includes('image');
      if (turnImages.length > 0 && modelSupportsVision) {
        await session.prompt(promptText, { images: turnImages });
      } else {
        await session.prompt(promptText);
      }
    }
    await session.waitForIdle();
    if (extensionErrors.length) throw new Error(extensionErrors.join('\n'));
    if (cancelledRuns.has(runKey)) throw new Error('Turn was cancelled');

    // A handled extension command may not create an assistant message. Inspect only
    // this run's messages so previous replies/errors never become the command result.
    const lastAssistant = session.messages.slice(messageCountBefore).filter(message => message.role === 'assistant').at(-1);
    if (lastAssistant?.stopReason === 'error') throw new Error(lastAssistant.errorMessage || 'Model inference failed');
    if (lastAssistant?.stopReason === 'aborted') throw new Error(lastAssistant.errorMessage || 'Turn was cancelled');
    const replyText = lastAssistant?.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      || (isCompactCommand
        ? (isCompactSmall ? '（无需压缩：当前会话上下文尚未达到压缩阈值）' : '（已完成会话上下文压缩）')
        : '（已完成执行，无文本输出）');

    let usage: TurnUsage | undefined;
    const rawUsage = (lastAssistant as any)?.usage;
    let inputTokens = Number(rawUsage?.input ?? rawUsage?.inputTokens ?? 0) || 0;
    let outputTokens = Number(rawUsage?.output ?? rawUsage?.outputTokens ?? 0) || 0;
    let totalTokens = Number(rawUsage?.totalTokens ?? rawUsage?.total ?? (inputTokens + outputTokens)) || 0;

    if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) {
      const turnAssistants = session.messages.slice(messageCountBefore).filter(message => message.role === 'assistant');
      for (const msg of turnAssistants) {
        const u = (msg as any)?.usage;
        if (u) {
          const inp = Number(u.input ?? u.inputTokens ?? 0) || 0;
          const out = Number(u.output ?? u.outputTokens ?? 0) || 0;
          const tot = Number(u.totalTokens ?? u.total ?? (inp + out)) || 0;
          inputTokens += inp;
          outputTokens += out;
          totalTokens += tot;
        }
      }
    }
    if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0)) {
      totalTokens = inputTokens + outputTokens;
    }

    if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
      usage = {
        inputTokens,
        outputTokens,
        totalTokens,
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
      };
    }

    return {
      replyText,
      modelBadge: `${bot.modelProvider}/${bot.modelId}`,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
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
 * 删除 (sessionId, botId) 的本地 Pi 会话文件（.jsonl），下一回合将从 Hub 历史全量重建上下文。文件不存在时静默成功（幂等）。
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
