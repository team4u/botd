import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition, AgentSession } from '@earendil-works/pi-coding-agent';
import type { BirpcReturn } from 'birpc';
import type { HubRpcFunctions, NodeRpcFunctions, BotConfig, ToolCallRecord, TurnUsage, SubagentRunRecord, TurnBlock } from '@botd/protocol';
import {
  assertSafeId,
  ensureDir,
  getBotDir,
  getBotWorkspaceDir,
  readBot,
  readBotEnv,
  readNodeIdentity,
  readSkill,
} from './storage.js';
import { createRuntimeForProvider, configureProviderAuth } from './models.js';
import { BUILTIN_SKILL_ID } from './builtin-skill.js';
import { resolveWindowsBash, windowsShellPathPrefix, isWindows } from './windows-shell.js';

let turnDepsPromise: Promise<{
  piAgent: typeof import('@earendil-works/pi-coding-agent');
  piAiCompat: typeof import('@earendil-works/pi-ai/compat');
  commandsMod: typeof import('./commands.js');
  webCommandUiMod: typeof import('./web-command-ui.js');
}> | undefined;

function loadTurnDeps() {
  return (turnDepsPromise ??= Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai/compat'),
    import('./commands.js'),
    import('./web-command-ui.js'),
  ]).then(([piAgent, piAiCompat, commandsMod, webCommandUiMod]) => ({
    piAgent,
    piAiCompat,
    commandsMod,
    webCommandUiMod,
  })));
}

export async function getBotCommands(
  ...args: Parameters<typeof import('./commands.js').getBotCommands>
): ReturnType<typeof import('./commands.js').getBotCommands> {
  const { commandsMod } = await loadTurnDeps();
  return commandsMod.getBotCommands(...args);
}

const pendingRuns = new Set<string>();
const activeSessions = new Map<string, AgentSession>();
const cancelledRuns = new Set<string>();
const runKeyToDataDir = new Map<string, string>();

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
    turnEnv?: Record<string, string | undefined>;
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
    ...options.turnEnv,
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
  if (toolName === 'Agent') {
    const subType = args.subagent_type ?? 'agent';
    const desc = args.description ?? '';
    return desc ? `${subType}: ${desc}`.trim().slice(0, 120) : `${subType}`;
  }
  if (toolName === 'SubagentWorkflow') {
    const summary = args.description || args.name;
    if (typeof summary === 'string') {
      return summary.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string') {
      const compact = value.replace(/\s+/g, ' ').trim().slice(0, 100);
      if (compact) return compact;
    }
  }
  return undefined;
}

export function extractToolOutputPreview(result: any, _isError?: boolean): string | undefined {
  if (result === null || result === undefined) return undefined;

  let rawText = '';
  if (typeof result === 'string') {
    rawText = result;
  } else if (Array.isArray(result.content)) {
    rawText = result.content
      .map((part: any) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  } else if (typeof result.error === 'string') {
    rawText = result.error;
  } else if (result.error && typeof result.error === 'object') {
    rawText = result.error.message || JSON.stringify(result.error);
  } else if (typeof result.errorMessage === 'string') {
    rawText = result.errorMessage;
  } else if (typeof result.message === 'string') {
    rawText = result.message;
  } else if (typeof result.output === 'string') {
    rawText = result.output;
  } else if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
    rawText = [result.stderr, result.stdout].filter(Boolean).join('\n');
  } else if (typeof result.details === 'string') {
    rawText = result.details;
  } else if (result instanceof Error) {
    rawText = result.stack || result.message;
  } else {
    try {
      rawText = JSON.stringify(result);
    } catch {
      rawText = String(result);
    }
  }

  const trimmed = rawText.trim();
  if (!trimmed) return undefined;

  if (trimmed.length <= 4000) return trimmed;
  return `${trimmed.slice(0, 2200)}\n...\n${trimmed.slice(-1500)}`;
}

export function sanitizeToolArgs(args: any, depth = 0): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args) || depth > 5) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    result[key] = sanitizeToolValue(val, depth + 1);
  }
  return result;
}

function sanitizeToolValue(val: any, depth: number): unknown {
  if (typeof val === 'string') {
    if (val.length > 4000) {
      return val.slice(0, 4000) + '...(truncated)';
    }
    return val;
  }
  if (Array.isArray(val)) {
    if (depth > 5) return val.slice(0, 50);
    return val.slice(0, 100).map((item) => sanitizeToolValue(item, depth + 1));
  }
  if (val !== null && typeof val === 'object') {
    if (depth > 5) return val;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = sanitizeToolValue(v, depth + 1);
    }
    return obj;
  }
  return val;
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
  blocks?: TurnBlock[];
  usage?: TurnUsage;
  subagentRuns?: SubagentRunRecord[];
  aborted?: boolean;
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

  const activeSubagentIds = new Set<string>();
  const subagentRunsMap = new Map<string, SubagentRunRecord>();

  let session: AgentSession | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubSubagentEvents: (() => void) | undefined;

  try {
    const { piAgent, piAiCompat, commandsMod, webCommandUiMod } = await loadTurnDeps();
    const {
      createAgentSession,
      createBashToolDefinition,
      createPowerShellToolDefinition,
      SessionManager,
      SettingsManager,
    } = piAgent;
    const { getModel } = piAiCompat;
    const { collectBotCommands, loadBotResources } = commandsMod;
    const { guardExtensionCommands } = webCommandUiMod;

    let parentBotData: Awaited<ReturnType<typeof readBot>> = null;
    if (bot.parentBotId) {
      parentBotData = await readBot(dataDir, bot.parentBotId);
    }
    const parentBotConfig = (parentBotData as any)?.config ?? parentBotData?.bot;

    const effectiveBot: BotConfig = {
      ...bot,
      modelProvider: bot.inheritModel && parentBotConfig ? parentBotConfig.modelProvider : bot.modelProvider,
      modelId: bot.inheritModel && parentBotConfig ? parentBotConfig.modelId : bot.modelId,
      enabledSkills:
        bot.inheritSkills && parentBotConfig ? [...parentBotConfig.enabledSkills] : bot.enabledSkills || [],
    };

    const botDir = getBotDir(dataDir, bot.id);
    const workspaceDir = bot.parentBotId
      ? getBotWorkspaceDir(dataDir, bot.parentBotId)
      : path.join(botDir, 'workspace');
    const sessionDir = path.join(botDir, 'sessions');
    const sessionFile = path.join(sessionDir, `${input.sessionId}.jsonl`);

    await ensureDir(workspaceDir);
    await ensureDir(sessionDir);

    let attachmentNotice = '';
    const turnImages: { type: 'image'; data: string; mimeType: string }[] = [];
    const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    const downloadedAttachmentIds = new Set<string>();

    if (input.attachments && input.attachments.length > 0) {
      const inboxDir = path.join(workspaceDir, 'inbox');
      await ensureDir(inboxDir);
      for (const att of input.attachments) {
        try {
          const downloaded = await hubRpc.downloadArtifact(att.id);
          downloadedAttachmentIds.add(att.id);
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

    if (input.incomingArtifacts && input.incomingArtifacts.length > 0) {
      const inboxDir = path.join(workspaceDir, 'inbox');
      await ensureDir(inboxDir);
      const incomingNotices: string[] = [];

      for (const art of input.incomingArtifacts) {
        if (downloadedAttachmentIds.has(art.id)) {
          continue;
        }
        downloadedAttachmentIds.add(art.id);
        try {
          const downloaded = await hubRpc.downloadArtifact(art.id);
          if (downloaded?.contentBase64) {
            const baseName = path.basename(art.filename || 'artifact');
            let actualFilename = baseName;
            if (existsSync(path.join(inboxDir, baseName))) {
              actualFilename = `${Date.now()}_${baseName}`;
            }
            const destPath = path.join(inboxDir, actualFilename);
            await fs.writeFile(destPath, Buffer.from(downloaded.contentBase64, 'base64'));
            const mime = (art.mimeType || downloaded.artifact?.mimeType || '').toLowerCase();
            if (VISION_MIME_TYPES.has(mime)) {
              turnImages.push({ type: 'image', data: downloaded.contentBase64, mimeType: mime });
            }
            incomingNotices.push(
              `[系统提示：来自上游任务的产物文件已自动同步至本机工作区 ./inbox/${actualFilename}，可直接读取处理]`
            );
          }
        } catch {
          // If artifact download fails, don't crash the turn
        }
      }

      if (incomingNotices.length > 0) {
        const noticeBlock = incomingNotices.join('\n');
        attachmentNotice = attachmentNotice
          ? `${attachmentNotice}\n\n${noticeBlock}`
          : noticeBlock;
      }
    }

    if (cancelledRuns.has(runKey)) {
      throw new Error('Turn was cancelled');
    }

    // 1. Prepare dataDir/bin/botd wrapper for local CLI wake invocations
    const binDir = await ensureBotdBinWrapper(dataDir);

    // 2. Setup isolated ModelRuntime under .agent and configure provider auth.
    //    Extension-registered providers (e.g. magpie gateway) activate on demand.
    const modelRuntime = await createRuntimeForProvider(dataDir, effectiveBot.modelProvider);
    await configureProviderAuth(modelRuntime, effectiveBot.modelProvider);

    // 3. Resolve model
    let model: ReturnType<typeof getModel> | undefined =
      modelRuntime.getModel(effectiveBot.modelProvider, effectiveBot.modelId) ??
      getModel(effectiveBot.modelProvider as any, effectiveBot.modelId as any);

    // Extension-provider models may never have been catalogued (fresh install,
    // never opened the catalog page): fetch that provider's catalog once and retry.
    if (!model && modelRuntime.getProvider(effectiveBot.modelProvider)) {
      try {
        await modelRuntime.refresh({
          allowNetwork: true,
          providers: [effectiveBot.modelProvider],
          force: false,
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        // Network failure falls through to the not-found error below
      }
      model = modelRuntime.getModel(effectiveBot.modelProvider, effectiveBot.modelId);
    }

    if (!model) {
      throw new Error(`Model not found in catalog: ${effectiveBot.modelProvider}/${effectiveBot.modelId}`);
    }

    // 5. Read bot files and enabled skills
    const botData = await readBot(dataDir, bot.id);
    const systemMd = botData?.systemMd || '';
    const memoryMd = botData?.memoryMd || '';
    const subagentEnv = await readBotEnv(dataDir, bot.id);
    const parentEnv = bot.parentBotId ? await readBotEnv(dataDir, bot.parentBotId) : {};
    const botEnv = { ...parentEnv, ...subagentEnv };
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
      defaultProvider: effectiveBot.modelProvider,
      defaultModel: effectiveBot.modelId,
      compaction: { enabled: process.env.BOTD_AUTO_COMPACT !== '0' },
    });
    // 主 BOT 挂载 pi-subagents 底座：获得 Agent / SubagentWorkflow 工具，可调度 .pi/agents/ 下的角色分身。
    // 分身（parentBotId 已设置）不挂载，防套娃；扩展内部另有 inChildSessionContext 防重入双保险。
    const resourceLoader = await loadBotResources(
      dataDir,
      effectiveBot,
      settingsManager,
      () =>
        [
          `[系统上下文提醒]\n当前 Session ID: ${input.sessionId} | 当前 BOT: @${bot.id}\n- 如需通过后台脚本异步唤醒当前会话，请执行命令:\n  \`botd wake --session ${input.sessionId} --bot ${bot.id} --message "状态说明"\``,
          input.groupContextPrompt,
          attachmentNotice,
        bot.toolScope === 'readonly'
          ? `[工具权限说明]\n你当前处于只读分析模式（readonly），仅被允许使用读取与检索工具（read, grep, find, ls），严禁修改或写入任何文件。`
          : '',
        input.commandText && input.incrementalMessages.trim()
          ? `[近期对话历史]\n${input.incrementalMessages}` : '',
        systemMd ? `[角色设定]\n${systemMd}` : '',
        `[长期记忆 (可通过 ../MEMORY.md 更新)]\n${memoryMd}\n（说明：你可以使用 edit/write 工具修改 \`../MEMORY.md\` 来更新长期记忆；当用户要求你学习某个本机 CLI 工具并保存为 Skill 时，可执行 \`<cli> --help\` 并将总结写入 \`../../../skills/<skillId>/SKILL.md\`。）`,
        botEnvKeys.length > 0
          ? `[已注入专属环境变量]\n当前命令执行环境已预置以下环境变量（可直接在命令或脚本中通过 $VAR 引用，请勿在公屏直接打印密钥明文）：${botEnvKeys.map((k) => `$${k}`).join(', ')}`
          : '',
        skillContents.length > 0 ? `[框架内置 Skills]\n\n${skillContents.join('\n\n')}` : '',
      ].filter(Boolean),
      { enableSubagents: !bot.parentBotId },
    );

    // 8. Custom bash tool with per-turn env injection without mutating global process.env.
    //    On Windows: pin the resolved bash.exe (Git Bash or managed MinGit) and extend
    //    PATH with the POSIX delimiter while preserving the platform's Path casing.
    const isWin = isWindows;
    const shellPath = isWin ? resolveWindowsBash(dataDir) : undefined;
    const nodeIdentity = await readNodeIdentity(dataDir);

    const turnEnv: Record<string, string | undefined> = {
      BOTD_NODE_ID: bot.nodeId || nodeIdentity?.nodeId || '',
      ...(nodeIdentity?.hubUrl ? { BOTD_HUB_URL: nodeIdentity.hubUrl } : {}),
      PI_CODING_AGENT_DIR: bot.parentBotId ? getBotDir(dataDir, bot.parentBotId) : botDir,
    };

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
          turnEnv,
        }),
      }),
    });
    // Omit optional UI renderers to satisfy invariant ToolDefinition generic bounds
    const { renderCall: _rc, renderResult: _rr, ...headlessBashTool } = rawBashDef;
    const customTools: ToolDefinition[] = [];
    if (bot.toolScope !== 'readonly') {
      customTools.push(headlessBashTool as unknown as ToolDefinition);

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
                turnEnv,
              }),
            }),
          });
          const { renderCall: _prc, renderResult: _prr, ...headlessPsTool } = rawPsDef;
          customTools.push(headlessPsTool as unknown as ToolDefinition);
        } catch {
          // PowerShell discovery failed (headless Windows core?) — bash remains.
        }
      }
    }

    // 9. Create durable agent session
    const sessionManager = SessionManager.open(sessionFile, sessionDir, workspaceDir);

    if (cancelledRuns.has(runKey)) {
      throw new Error('Turn was cancelled');
    }
    let sessionTools: string[] | undefined;
    if (bot.toolScope === 'readonly') {
      sessionTools = ['read', 'grep', 'find', 'ls'];
    } else if (bot.toolScope === 'custom' && bot.customTools?.length) {
      sessionTools = bot.customTools;
    }

    const created = await createAgentSession({
      cwd: workspaceDir,
      agentDir: botDir,
      model,
      thinkingLevel: effectiveBot.thinkingLevel ?? 'medium',
      modelRuntime,
      resourceLoader,
      customTools,
      sessionManager,
      settingsManager,
      ...(sessionTools ? { tools: sessionTools } : {}),
    });

    session = created.session;
    pendingRuns.delete(runKey);
    activeSessions.set(runKey, session);

    if (cancelledRuns.has(runKey)) {
      throw new Error('Turn was cancelled');
    }

    const toolCalls: ToolCallRecord[] = [];
    const blocks: TurnBlock[] = [];
    const runningToolStarts = new Map<
      string,
      {
        index: number;
        blockIndex: number;
        startMs: number;
        summary?: string;
        args?: Record<string, unknown>;
      }
    >();
    let activeThinkingStartMs: number | null = null;
    let activeThinkingBlock: Extract<TurnBlock, { type: 'thinking' }> | null = null;

    const closeActiveThinking = () => {
      if (activeThinkingBlock && activeThinkingBlock.status === 'running') {
        activeThinkingBlock.status = 'done';
        activeThinkingBlock.durationMs = Math.max(1, Date.now() - (activeThinkingStartMs ?? Date.now()));
        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          thinkingStatus: 'done',
          thinkingDurationMs: activeThinkingBlock.durationMs,
        });
      }
      activeThinkingBlock = null;
      activeThinkingStartMs = null;
    };

    // 10. Subscribe to streaming events and report to Hub
    // 跨 assistant 消息的文本补段落分隔只能依赖 message_start 事件标记边界。
    // 严禁用 event.message 引用比较判定“新消息”——pi 每次 message_update 都会传
    // 新快照对象（引用必然不同），会把同一条消息的相邻 chunk 误判成两条消息，
    // 在 chunk 之间插入 \n\n，撕裂 markdown 块级结构（blockquote/表格/代码块被拦腰截断）。
    let hasPriorAssistantEmittedText = false;
    let currentAssistantEmittedText = false;

    unsubscribe = session.subscribe((event: any) => {
      if (event.type === 'message_start') {
        if (event.message?.role === 'assistant') {
          if (currentAssistantEmittedText) {
            hasPriorAssistantEmittedText = true;
          }
          currentAssistantEmittedText = false;
        }
      } else if (event.type === 'message_update') {
        const ame = event.assistantMessageEvent;
        if (ame?.type === 'thinking_start') {
          if (!activeThinkingBlock || activeThinkingBlock.status !== 'running') {
            activeThinkingStartMs = Date.now();
            activeThinkingBlock = {
              type: 'thinking',
              thinking: '',
              status: 'running',
            };
            blocks.push(activeThinkingBlock);
          }
          hubRpc.onSessionStream.asEvent({
            sessionId: input.sessionId,
            botId: bot.id,
            thinkingStatus: 'running',
          });
        } else if (ame?.type === 'thinking_delta' && ame.delta) {
          if (!activeThinkingBlock || activeThinkingBlock.status !== 'running') {
            activeThinkingStartMs = Date.now();
            activeThinkingBlock = {
              type: 'thinking',
              thinking: ame.delta,
              status: 'running',
            };
            blocks.push(activeThinkingBlock);
          } else {
            activeThinkingBlock.thinking += ame.delta;
          }
          hubRpc.onSessionStream.asEvent({
            sessionId: input.sessionId,
            botId: bot.id,
            thinkingDelta: ame.delta,
            thinkingStatus: 'running',
          });
        } else if (ame?.type === 'thinking_end') {
          closeActiveThinking();
        } else if (ame?.type === 'text_delta') {
          closeActiveThinking();
          let delta = ame.delta;
          // 仅在跨 assistant 消息边界（由 message_start 标记）为首个 chunk 补段落分隔；
          // 同一消息内的 chunk 原样透传，不得插入任何字符。
          if (hasPriorAssistantEmittedText && !currentAssistantEmittedText && delta) {
            if (delta.startsWith('\n\n')) {
              // Already starts with double newline
            } else if (delta.startsWith('\n')) {
              delta = `\n${delta}`;
            } else {
              delta = `\n\n${delta}`;
            }
          }
          if (delta) {
            currentAssistantEmittedText = true;
            const lastBlock = blocks[blocks.length - 1];
            if (lastBlock && lastBlock.type === 'text') {
              lastBlock.text += delta;
            } else {
              blocks.push({ type: 'text', text: delta });
            }
          }
          hubRpc.onSessionStream.asEvent({
            sessionId: input.sessionId,
            botId: bot.id,
            deltaText: delta,
          });
        }
      } else if (event.type === 'tool_execution_start') {
        closeActiveThinking();
        const summary = extractToolSummary(event.toolName, event.args ?? event.input);
        const sanitizedArgs = sanitizeToolArgs(event.args ?? event.input);
        const key = event.toolCallId || `${event.toolName}_${toolCalls.length}`;
        const index = toolCalls.length;
        toolCalls.push({
          id: key,
          name: event.toolName,
          ...(sanitizedArgs ? { args: sanitizedArgs } : {}),
          ...(summary ? { summary } : {}),
          status: 'running',
        });
        const blockIndex = blocks.length;
        blocks.push({
          type: 'tool',
          id: key,
          name: event.toolName,
          ...(sanitizedArgs ? { args: sanitizedArgs } : {}),
          ...(summary ? { summary } : {}),
          status: 'running',
        });
        runningToolStarts.set(key, { index, blockIndex, startMs: Date.now(), summary, args: sanitizedArgs });
        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          toolCallId: key,
          toolName: event.toolName,
          toolStatus: 'running',
          toolSummary: summary,
          toolArgs: sanitizedArgs,
        });
      } else if (event.type === 'tool_execution_end') {
        closeActiveThinking();
        const key = event.toolCallId || event.toolName;
        let running = runningToolStarts.get(key);
        if (!running) {
          for (const [k, r] of runningToolStarts.entries()) {
            if (k.startsWith(`${event.toolName}_`) || k === event.toolName) {
              running = r;
              runningToolStarts.delete(k);
              break;
            }
          }
        } else {
          runningToolStarts.delete(key);
        }

        let summary: string | undefined;
        let sanitizedArgs: Record<string, unknown> | undefined;
        const isError = Boolean(event.isError);
        const rawOutput = event.result !== undefined ? event.result : event.output;
        const outputPreview = extractToolOutputPreview(rawOutput, isError);
        const durationMs = running ? Math.max(0, Date.now() - running.startMs) : undefined;

        if (running) {
          summary = running.summary;
          sanitizedArgs = running.args;
          const entry = toolCalls[running.index];
          if (entry) {
            entry.status = isError ? 'error' : 'done';
            if (durationMs !== undefined) entry.durationMs = durationMs;
            entry.isError = isError;
            if (outputPreview) {
              entry.outputPreview = outputPreview;
            }
          }
          const block = blocks[running.blockIndex];
          if (block && block.type === 'tool') {
            block.status = isError ? 'error' : 'done';
            if (durationMs !== undefined) block.durationMs = durationMs;
            block.isError = isError;
            if (outputPreview) {
              block.outputPreview = outputPreview;
            }
          }
        } else {
          const block = [...blocks].reverse().find(
            (b) => b.type === 'tool' && (b.id === key || b.name === event.toolName) && b.status === 'running'
          );
          if (block && block.type === 'tool') {
            block.status = isError ? 'error' : 'done';
            block.isError = isError;
            if (outputPreview) block.outputPreview = outputPreview;
          }
        }

        if (!summary) {
          summary = extractToolSummary(event.toolName, event.args ?? event.input);
        }
        if (!sanitizedArgs) {
          sanitizedArgs = sanitizeToolArgs(event.args ?? event.input);
        }

        hubRpc.onSessionStream.asEvent({
          sessionId: input.sessionId,
          botId: bot.id,
          toolCallId: key,
          toolName: event.toolName,
          toolStatus: isError ? 'error' : 'done',
          toolSummary: summary,
          toolArgs: sanitizedArgs,
          toolOutput: outputPreview,
          toolDurationMs: durationMs,
          toolIsError: isError,
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

    // pi-subagents 事件桥接：将分身生命周期事件（created/started/completed/failed）实时转发到 Hub，
    // 供 Web 端 SubagentFleetCard 实时渲染分身协同进度。主 BOT 未挂载扩展时此处静默不生效。
    unsubSubagentEvents = (() => {
      try {
        const eventBus = (resourceLoader as unknown as { eventBus?: { on: (channel: string, handler: (data: unknown) => void) => () => void } }).eventBus;
        if (!eventBus) return undefined;
        const handleLifecycle = (channel: string) => (data: unknown) => {
          const d = data as {
            id?: string; type?: string; description?: string; status?: string;
            result?: string; error?: string; durationMs?: number; toolUses?: number;
          };
          if (!d || typeof d !== 'object' || !d.id) return;
          const isDone = channel === 'subagents:completed' || channel === 'subagents:failed';
          if (channel === 'subagents:created' || channel === 'subagents:started') {
            activeSubagentIds.add(d.id);
          } else if (isDone) {
            activeSubagentIds.delete(d.id);
          }

          const prev = subagentRunsMap.get(d.id);
          const status = isDone ? (channel === 'subagents:failed' ? 'error' : 'done') : 'running';
          const subagentId = d.type || prev?.subagentId || 'agent';
          const task = d.description || prev?.task || d.id;
          const runRecord: SubagentRunRecord = {
            id: d.id,
            subagentId,
            task,
            status,
            ...(typeof d.toolUses === 'number' ? { toolCount: d.toolUses } : {}),
            ...(typeof d.durationMs === 'number' ? { durationMs: d.durationMs } : {}),
            ...(isDone && (d.result || d.error) ? { replyPreview: String(d.result || d.error).slice(0, 200) } : {}),
          };
          subagentRunsMap.set(d.id, runRecord);

          hubRpc.onSessionStream.asEvent({
            sessionId: input.sessionId,
            botId: bot.id,
            toolName: `subagent:${subagentId}`,
            toolStatus: isDone ? ('done' as const) : ('running' as const),
            toolSummary: `${isDone ? (channel === 'subagents:failed' ? '[失败] ' : '[完成] ') : ''}${task}${isDone && d.durationMs ? ` · ${Math.round(d.durationMs / 1000)}s` : ''}`,
            subagentEvent: {
              id: d.id,
              subagentId,
              task,
              status,
              ...(d.result ? { result: d.result } : {}),
              ...(d.error ? { error: d.error } : {}),
              ...(typeof d.durationMs === 'number' ? { durationMs: d.durationMs } : {}),
              ...(typeof d.toolUses === 'number' ? { toolUses: d.toolUses } : {}),
            },
          });
        };
        const unsubs = ['subagents:created', 'subagents:started', 'subagents:completed', 'subagents:failed'].map((ch) =>
          eventBus.on(ch, handleLifecycle(ch)),
        );
        return () => unsubs.forEach((u) => u());
      } catch {
        return undefined;
      }
    })();

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

    const getGlobalSubagentManager = () =>
      (globalThis as any)[Symbol.for('pi-subagents:manager')] as
        | { hasRunning?: () => boolean; waitForAll?: () => Promise<void> }
        | undefined;
    const drainDeadline = Date.now() + 120_000;
    let drainedBackground = false;
    while (
      !cancelledRuns.has(runKey) &&
      Date.now() < drainDeadline &&
      (activeSubagentIds.size > 0 || Boolean(getGlobalSubagentManager()?.hasRunning?.()))
    ) {
      drainedBackground = true;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (drainedBackground && !cancelledRuns.has(runKey)) {
      // Wait briefly for CompletionOutbox (500ms hold) to deliver follow-up turn into session
      await new Promise((r) => setTimeout(r, 600));
      await session.waitForIdle();
    }

    closeActiveThinking();
    if (extensionErrors.length) throw new Error(extensionErrors.join('\n'));

    // 用户中止：不再地丢弃已产生的 thinking/工具/文本，标记取消后继续走统一的 blocks 落盘返回路径。
    // 等待中的 running 工具标记为 cancelled，Hub 侧据此持久化部分输出。
    const wasCancelled = cancelledRuns.has(runKey);
    if (wasCancelled) {
      for (const tc of toolCalls) {
        if (tc.status === 'running') tc.status = 'cancelled';
      }
      for (const b of blocks) {
        if (b.type === 'tool' && b.status === 'running') b.status = 'cancelled';
      }
      for (const [key, running] of runningToolStarts.entries()) {
        const tc = toolCalls[running.index];
        if (tc && tc.status === 'cancelled' && tc.durationMs === undefined) {
          tc.durationMs = Math.max(0, Date.now() - running.startMs);
        }
        const block = blocks[running.blockIndex];
        if (block && block.type === 'tool' && block.status === 'cancelled' && block.durationMs === undefined) {
          block.durationMs = Math.max(0, Date.now() - running.startMs);
        }
        runningToolStarts.delete(key);
      }
    }

    // A handled extension command may not create an assistant message. Inspect only
    // this run's messages so previous replies/errors never become the command result.
    const turnAssistants = session.messages.slice(messageCountBefore).filter(message => message.role === 'assistant');
    const lastAssistant = turnAssistants.at(-1);
    if (lastAssistant?.stopReason === 'error') throw new Error(lastAssistant.errorMessage || 'Model inference failed');

    const assistantTexts: string[] = [];
    for (const msg of turnAssistants) {
      const textParts = (msg.content || [])
        .filter((part: any) => part.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
        .map((part: any) => part.text);
      const msgText = textParts.join('\n').trim();
      if (msgText.length > 0) {
        assistantTexts.push(msgText);
      }
    }

    // 中止且无任何文本输出时不用「已完成执行」占位；空文本由 Hub 侧标记 aborted
    const replyText = assistantTexts.join('\n\n')
      || (wasCancelled
        ? ''
        : (isCompactCommand
          ? (isCompactSmall ? '（无需压缩：当前会话上下文尚未达到压缩阈值）' : '（已完成会话上下文压缩）')
          : '（已完成执行，无文本输出）'));

    let usage: TurnUsage | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;

    if (turnAssistants.length > 1) {
      for (const msg of turnAssistants) {
        const u = (msg as any)?.usage;
        if (u) {
          const inp = Number(u.input ?? u.inputTokens ?? 0) || 0;
          const out = Number(u.output ?? u.outputTokens ?? 0) || 0;
          const cr = Number(u.cacheRead ?? u.cacheReadTokens ?? 0) || 0;
          const cw = Number(u.cacheWrite ?? u.cacheWriteTokens ?? 0) || 0;
          const rawTot = u.totalTokens ?? u.total;
          const tot = Number(rawTot ?? (inp + out + cr + cw)) || 0;
          inputTokens += inp;
          outputTokens += out;
          cacheReadTokens += cr;
          cacheWriteTokens += cw;
          totalTokens += tot;
        }
      }
    } else {
      const rawUsage = (lastAssistant as any)?.usage;
      inputTokens = Number(rawUsage?.input ?? rawUsage?.inputTokens ?? 0) || 0;
      outputTokens = Number(rawUsage?.output ?? rawUsage?.outputTokens ?? 0) || 0;
      cacheReadTokens = Number(rawUsage?.cacheRead ?? rawUsage?.cacheReadTokens ?? 0) || 0;
      cacheWriteTokens = Number(rawUsage?.cacheWrite ?? rawUsage?.cacheWriteTokens ?? 0) || 0;
      const rawTot = rawUsage?.totalTokens ?? rawUsage?.total;
      totalTokens = Number(rawTot ?? (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens)) || 0;
    }

    if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0)) {
      totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    }

    if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0) {
      usage = {
        inputTokens,
        outputTokens,
        totalTokens,
        ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
      };
    }

    if (blocks.length === 0 && (turnAssistants.length > 0 || toolCalls.length > 0)) {
      for (const msg of turnAssistants) {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > 0) {
              blocks.push({
                type: 'thinking',
                thinking: part.thinking,
                status: 'done',
              });
            } else if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
              const lastBlock = blocks[blocks.length - 1];
              if (lastBlock && lastBlock.type === 'text') {
                lastBlock.text += `\n\n${part.text}`;
              } else {
                blocks.push({
                  type: 'text',
                  text: part.text,
                });
              }
            }
          }
        }
      }
      if (toolCalls.length > 0 && !blocks.some((b) => b.type === 'tool')) {
        const toolBlocks: TurnBlock[] = toolCalls.map((tc, idx) => ({
          type: 'tool',
          id: tc.id || `${tc.name}_${idx}`,
          name: tc.name,
          ...(tc.args ? { args: tc.args } : {}),
          ...(tc.summary ? { summary: tc.summary } : {}),
          status: tc.status,
          ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
          ...(tc.outputPreview !== undefined ? { outputPreview: tc.outputPreview } : {}),
          ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
        }));
        const firstTextIdx = blocks.findIndex((b) => b.type === 'text');
        if (firstTextIdx >= 0) {
          blocks.splice(firstTextIdx, 0, ...toolBlocks);
        } else {
          blocks.push(...toolBlocks);
        }
      }
    }
    // 落库前校准：流式阶段拼接的 text 块若与定稿消息的文本总量一致（即未被截断/中止），
    // 按定稿顺序重建，保证 blocks 文本与 content 字段一字不差，消除任何流式期间的拼接瑕疵。
    if (blocks.length > 0) {
      const finalizedTexts: string[] = [];
      for (const msg of turnAssistants) {
        for (const part of msg.content || []) {
          if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
            finalizedTexts.push(part.text);
          }
        }
      }
      if (finalizedTexts.length > 0) {
        // 比较时忽略每段首尾空白（流式拼接可能在消息边界注入 \n\n 前缀）：
        // 内容一致才重建，用定稿文本消除流式期间的任何拼接瑕疵。
        const normalize = (parts: string[]) => parts.map(p => p.replace(/^\s+|\s+$/g, '')).join('\u0000');
        const streamedTexts = blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text);
        if (normalize(streamedTexts) === normalize(finalizedTexts)) {
          // 文本完全一致：按定稿块结构重建（可能把流式期间被 tool 块分隔的多个 text 块
          // 重新归位为模型真实的段落切分）
          const nextBlocks: TurnBlock[] = [];
          let textIdx = 0;
          for (const block of blocks) {
            if (block.type === 'text') {
              if (textIdx < finalizedTexts.length) {
                nextBlocks.push({ type: 'text', text: finalizedTexts[textIdx] });
                textIdx++;
              }
            } else {
              nextBlocks.push(block);
            }
          }
          // 流式期间 text 块数多于定稿（如同一段文本被拆成多块）：合并多余的尾块
          while (textIdx < finalizedTexts.length) {
            const last = nextBlocks[nextBlocks.length - 1];
            if (last && last.type === 'text') {
              last.text += `\n\n${finalizedTexts[textIdx]}`;
            } else {
              nextBlocks.push({ type: 'text', text: finalizedTexts[textIdx] });
            }
            textIdx++;
          }
          blocks.length = 0;
          blocks.push(...nextBlocks);
        }
      }
    }
    if (blocks.length === 0 && replyText && replyText.length > 0) {
      blocks.push({ type: 'text', text: replyText });
    }

    return {
      replyText,
      modelBadge: `${effectiveBot.modelProvider}/${effectiveBot.modelId}`,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(usage ? { usage } : {}),
      ...(subagentRunsMap.size > 0 ? { subagentRuns: Array.from(subagentRunsMap.values()) } : {}),
      ...(wasCancelled ? { aborted: true } : {}),
    };
  } finally {
    if (unsubscribe) {
      unsubscribe();
    }
    if (unsubSubagentEvents) {
      unsubSubagentEvents();
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
