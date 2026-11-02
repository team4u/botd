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
import {
  beginSubagentHandoffScope,
  endSubagentHandoffScope,
  getGlobalSubagentManager,
  triggerActiveSubagentHandoff,
  type SubagentHandoffScope,
} from './commands.js';

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

/**
 * 每个主回合的运行时上下文：接管作用域（steerBotTurn 触发前台分身转后台）、
 * 分身 runId 的元数据（subagentId / task / sessionFile）与实时流推送函数。
 * 供 steerBotTurn / stopSubagent / interactSubagent 等 RPC 在回合外部定位并操控。
 */
interface ActiveTurnContext {
  runKey: string;
  sessionId: string;
  botId: string;
  handoffScope: SubagentHandoffScope;
  subagentRunsMap: Map<string, SubagentRunRecord>;
  emitSubagentEvent: (run: SubagentRunRecord, patch?: Partial<SubagentRunRecord>) => void;
  resourceLoader: unknown;
}
const activeTurns = new Map<string, ActiveTurnContext>();

/** runId → 分身会话文件与身份映射（跨回合 resume 追问时重开同一上下文） */
const subagentSessionFiles = new Map<string, { sessionFile: string; subagentId: string; task: string }>();

/** 最近一次活跃回合的 hubRpc 引用：后台/resume 推流用（turn 结束后仍可能收到完成事件） */
let lastHubRpc: BirpcReturn<HubRpcFunctions, NodeRpcFunctions> | null = null;

/** 供 daemon 传入 hubRpc，使回合外的 resume / 后台完成也能推流给 Hub */
export function setRuntimeHubRpc(rpc: BirpcReturn<HubRpcFunctions, NodeRpcFunctions> | null): void {
  lastHubRpc = rpc;
}

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

/** 从环境或默认路径解析 daemon 数据目录（回合外 resume 需要重建资源时使用） */
function getDataDirSafe(): string {
  return process.env.BOTD_DATA_DIR || path.join(process.env.HOME || process.cwd(), '.botd');
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

/** 自动化事件环境变量：标识本轮由何种自动化来源触发（cron / webhook / 一次性定时 / 手动触发 / 后台任务）。 */
export interface AutomationEventEnv {
  BOTD_TURN_TRIGGER: 'automation' | 'manual';
  BOTD_TURN_EVENT_KIND: string;
  BOTD_TURN_EVENT_NAME: string;
  BOTD_TURN_EVENT_AT: string;
}

/**
 * 自动化唤醒标记格式（Hub 唤醒消息实际落地形态）：
 *   `[Wake-up] [定时任务: 每日巡检] ...`（tag 带冒号）
 *   `[Wake-up] [Background Job bg_1] 命令 ... 执行完成`（tag 无冒号，名称内嵌）
 */
const AUTOMATION_EVENT_TAGS: Array<{ tag: string; kind: string }> = [
  { tag: '定时任务', kind: 'cron' },
  { tag: 'Timer', kind: 'once' },
  { tag: 'Webhook', kind: 'webhook' },
  { tag: '手动触发', kind: 'manual-trigger' },
  { tag: '延时唤醒', kind: 'delayed-wake' },
  { tag: 'Background Job', kind: 'bg-job' },
];

/**
 * 从唤醒消息中解析自动化事件标记。用户手动发起（无自动化标记）时返回 undefined。
 */
export function detectAutomationEvent(incrementalMessages: string): { kind: string; name: string } | undefined {
  for (const { tag, kind } of AUTOMATION_EVENT_TAGS) {
    // `[<tag>: <名称>]`（冒号分隔）或 `[<tag> <名称>]`（空格分隔，如 Background Job / 延时唤醒）
    const match = incrementalMessages.match(
      new RegExp(`\\[Wake-up\\]\\s*\\[${tag}(?::\\s*|\\s+)([^\\]]*)\\]`),
    );
    if (match) {
      return { kind, name: (match[1] ?? '').trim() };
    }
  }
  return undefined;
}

/** 构建本轮自动化事件环境变量；用户发起（非自动化唤醒）时返回 manual 基准集。 */
export function buildAutomationEventEnv(incrementalMessages: string, now = new Date()): AutomationEventEnv {
  const event = detectAutomationEvent(incrementalMessages);
  return {
    BOTD_TURN_TRIGGER: event ? 'automation' : 'manual',
    BOTD_TURN_EVENT_KIND: event?.kind ?? 'chat',
    BOTD_TURN_EVENT_NAME: event?.name ?? '',
    BOTD_TURN_EVENT_AT: now.toISOString(),
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

  // 生命周期修复：上一轮异常退出可能残留全局 manager 注册表（pi-subagents 仅在自身
  // session_shutdown 里释放）。新回合开始前清掉陈旧注册，避免本回合 ownsManagerRegistry
  // 判定失效、旧 manager 的后台分身孤儿化。
  try {
    const managerKey = Symbol.for('pi-subagents:manager');
    const stale = (globalThis as any)[managerKey];
    if (stale && !activeTurns.size) {
      stale.abortAll?.();
      delete (globalThis as any)[managerKey];
    }
  } catch {
    // ignore
  }

  const activeSubagentIds = new Set<string>();
  const subagentRunsMap = new Map<string, SubagentRunRecord>();
  /** 已订阅分身 session 工具事件的取消函数（runId → unsub） */
  const subagentToolListeners = new Map<string, () => void>();

  // 主回合接管作用域：用户在主会话发新消息时（steerBotTurn），前台分身转后台、主 Bot 立即接管
  const handoffScope = beginSubagentHandoffScope();

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
      // 自动化事件上下文：让脚本/扩展能区分本轮是 cron/webhook/定时/后台任务还是用户手动发起
      ...buildAutomationEventEnv(input.incrementalMessages ?? ''),
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

    // 注册活跃回合上下文：供 steerBotTurn / stopSubagent / interactSubagent 在回合外操控
    const turnContext: ActiveTurnContext = {
      runKey,
      sessionId: input.sessionId,
      botId: bot.id,
      handoffScope,
      subagentRunsMap,
      resourceLoader,
      emitSubagentEvent: (run, patch) => {
        if (patch) Object.assign(run, patch);
        subagentRunsMap.set(run.id, run);
        try {
          hubRpc.onSessionStream.asEvent({
            sessionId: input.sessionId,
            botId: bot.id,
            subagentEvent: {
              id: run.id,
              subagentId: run.subagentId,
              task: run.task,
              status: run.status === 'skipped' ? 'done' : run.status,
              ...(run.replyFull !== undefined ? { result: run.replyFull } : {}),
              ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
              ...(run.toolCount !== undefined ? { toolUses: run.toolCount } : {}),
              ...(run.currentTool !== undefined ? { currentTool: run.currentTool } : {}),
              ...(run.startedAt ? { startedAt: run.startedAt } : {}),
              ...(run.blocks ? { blocks: run.blocks } : {}),
              ...(run.toolCalls ? { toolCalls: run.toolCalls } : {}),
              ...(run.steers ? { steers: run.steers } : {}),
            },
          });
        } catch {
          // 推流失败不影响回合本身
        }
      },
    };
    activeTurns.set(runKey, turnContext);

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

    // pi-subagents 事件桥接：将分身生命周期事件实时转发到 Hub，供 Web 端
    // SubagentFleetCard / SubagentRunDrawer 实时渲染分身协同进度与控制。
    // 主 BOT 未挂载扩展时此处静默不生效。
    unsubSubagentEvents = (() => {
      try {
        const eventBus = (resourceLoader as unknown as { eventBus?: { on: (channel: string, handler: (data: unknown) => void) => () => void } }).eventBus;
        if (!eventBus) return undefined;

        /** 同步 runRecord 基础字段到本地映射（含跨回合 resume 的既有记录） */
        const syncRecord = (d: {
          id?: string; type?: string; description?: string;
          toolUses?: number; durationMs?: number;
        }): SubagentRunRecord | undefined => {
          if (!d || typeof d !== 'object' || !d.id) return undefined;
          const existing = subagentRunsMap.get(d.id);
          const record: SubagentRunRecord = existing ?? {
            id: d.id,
            subagentId: d.type || 'agent',
            task: d.description || d.id,
            status: 'running',
            startedAt: new Date().toISOString(),
          };
          if (d.type) record.subagentId = d.type;
          if (d.description) record.task = d.description;
          if (typeof d.toolUses === 'number') record.toolCount = d.toolUses;
          subagentRunsMap.set(d.id, record);
          return record;
        };

        /** 从全局 manager 取分身记录（含 session / sessionFile / abortController） */
        const peekManagerRecord = (id: string) => {
          try {
            return getGlobalSubagentManager()?.getRecord?.(id) as
              | {
                  id: string; type: string; description: string;
                  status: string; result?: string; error?: string;
                  toolUses: number; startedAt: number; completedAt?: number;
                  sessionFile?: string; session?: AgentSession;
                }
              | undefined;
          } catch {
            return undefined;
          }
        };

        /** 订阅分身 session 的事件，实时收集交错 blocks（思考/文本流）与 toolCalls / currentTool */
        const attachToolListener = (runId: string, subSession: AgentSession) => {
          if (subagentToolListeners.has(runId)) return;
          const record = subagentRunsMap.get(runId);
          if (!record) return;
          record.toolCalls ??= [];
          record.blocks ??= [];
          const runningStarts = new Map<string, number>();
          let subThinkingStartMs: number | null = null;
          let subThinkingBlock: Extract<TurnBlock, { type: 'thinking' }> | null = null;
          const runningBlocks = new Map<string, Extract<TurnBlock, { type: 'tool' }>>();
          const pushBlock = (b: TurnBlock) => {
            record.blocks!.push(b);
          };
          const closeSubThinking = () => {
            if (subThinkingBlock && subThinkingBlock.status === 'running') {
              subThinkingBlock.status = 'done';
              subThinkingBlock.durationMs = Math.max(1, Date.now() - (subThinkingStartMs ?? Date.now()));
            }
            subThinkingBlock = null;
            subThinkingStartMs = null;
          };
          const unsub = subSession.subscribe((event: any) => {
            const current = subagentRunsMap.get(runId);
            if (!current) return;
            current.toolCalls ??= [];
            current.blocks ??= [];
            if (event.type === 'message_update') {
              const ame = event.assistantMessageEvent;
              if (ame?.type === 'thinking_start') {
                if (!subThinkingBlock || subThinkingBlock.status !== 'running') {
                  subThinkingStartMs = Date.now();
                  subThinkingBlock = { type: 'thinking', thinking: '', status: 'running' };
                  pushBlock(subThinkingBlock);
                }
              } else if (ame?.type === 'thinking_delta' && ame.delta) {
                if (!subThinkingBlock || subThinkingBlock.status !== 'running') {
                  subThinkingStartMs = Date.now();
                  subThinkingBlock = { type: 'thinking', thinking: ame.delta, status: 'running' };
                  pushBlock(subThinkingBlock);
                } else {
                  subThinkingBlock.thinking += ame.delta;
                }
              } else if (ame?.type === 'thinking_end') {
                closeSubThinking();
              } else if (ame?.type === 'text_delta' && ame.delta) {
                const last = current.blocks[current.blocks.length - 1];
                if (last && last.type === 'text' && !(last as any).closed) {
                  last.text += ame.delta;
                } else {
                  pushBlock({ type: 'text', text: ame.delta });
                }
              }
            } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
              closeSubThinking();
              const last = current.blocks[current.blocks.length - 1];
              if (last && last.type === 'text') (last as any).closed = true;
            } else if (event.type === 'tool_execution_start') {
              const key = event.toolCallId || `${event.toolName}_${current.toolCalls.length}`;
              runningStarts.set(key, Date.now());
              const summary = extractToolSummary(event.toolName, event.args ?? event.input);
              const sanitizedArgs = sanitizeToolArgs(event.args ?? event.input);
              current.toolCalls.push({
                id: key,
                name: event.toolName,
                ...(sanitizedArgs ? { args: sanitizedArgs } : {}),
                ...(summary ? { summary } : {}),
                status: 'running',
              });
              const toolBlock: Extract<TurnBlock, { type: 'tool' }> = {
                type: 'tool',
                id: key,
                name: event.toolName,
                ...(sanitizedArgs ? { args: sanitizedArgs } : {}),
                ...(summary ? { summary } : {}),
                status: 'running',
              };
              pushBlock(toolBlock);
              runningBlocks.set(key, toolBlock);
              current.currentTool = event.toolName;
              current.toolCount = current.toolCalls.length;
              turnContext.emitSubagentEvent(current);
            } else if (event.type === 'tool_execution_end') {
              const key = event.toolCallId || event.toolName;
              let entry = [...current.toolCalls].reverse().find((tc) => tc.id === key || tc.name === event.toolName);
              if (!entry) {
                entry = { id: key, name: event.toolName, status: 'running' };
                current.toolCalls.push(entry);
              }
              const block = runningBlocks.get(key);
              const startedAt = runningStarts.get(key) ?? (entry.id !== undefined ? runningStarts.get(entry.id) : undefined);
              runningStarts.delete(key);
              runningBlocks.delete(key);
              entry.status = event.isError ? 'error' : 'done';
              if (startedAt !== undefined) entry.durationMs = Math.max(0, Date.now() - startedAt);
              entry.isError = Boolean(event.isError);
              if (block) {
                block.status = event.isError ? 'error' : 'done';
                if (startedAt !== undefined) block.durationMs = Math.max(0, Date.now() - startedAt);
                block.isError = Boolean(event.isError);
              }
              const outputPreview = extractToolOutputPreview(
                event.result !== undefined ? event.result : event.output,
                Boolean(event.isError),
              );
              if (outputPreview) {
                entry.outputPreview = outputPreview;
                if (block) block.outputPreview = outputPreview;
              }
              // 仍有 running 项则保留 currentTool，否则清空
              if (!current.toolCalls.some((tc) => tc.status === 'running')) {
                current.currentTool = undefined;
              }
              current.toolCount = current.toolCalls.length;
              turnContext.emitSubagentEvent(current);
            }
          });
          subagentToolListeners.set(runId, unsub);
        };

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

          const managerRecord = peekManagerRecord(d.id);
          const record = syncRecord(d)!;
          // 记录 sessionFile 供跨回合 resume 追问重开同一上下文
          if (managerRecord?.sessionFile) {
            subagentSessionFiles.set(d.id, {
              sessionFile: managerRecord.sessionFile,
              subagentId: record.subagentId,
              task: record.task,
            });
          }

          if (channel === 'subagents:started' && managerRecord?.session) {
            attachToolListener(d.id, managerRecord.session);
          }

          // stopped/aborted 均映射为 'stopped'（用户主动停止单个分身）
          const status: SubagentRunRecord['status'] = isDone
            ? (channel === 'subagents:failed'
                ? (d.status === 'stopped' || d.status === 'aborted' ? 'stopped' : 'error')
                : 'done')
            : 'running';
          record.status = status;
          if (typeof d.durationMs === 'number') record.durationMs = d.durationMs;
          if (typeof d.toolUses === 'number') record.toolCount = d.toolUses;
          if (isDone) {
            const full = String(d.result || d.error || '');
            if (full) {
              record.replyFull = full;
              record.replyPreview = full.slice(0, 200);
            }
            record.currentTool = undefined;
            const unsubTools = subagentToolListeners.get(d.id);
            if (unsubTools) {
              unsubTools();
              subagentToolListeners.delete(d.id);
            }
          }

          // 推流给 Hub（含 toolCalls / steers / replyFull 全量字段）
          try {
            hubRpc.onSessionStream.asEvent({
              sessionId: input.sessionId,
              botId: bot.id,
              subagentEvent: {
                id: record.id,
                subagentId: record.subagentId,
                task: record.task,
                status,
                ...(record.replyFull !== undefined && isDone ? { result: record.replyFull } : {}),
                ...(channel === 'subagents:failed' && d.error ? { error: d.error } : {}),
                ...(typeof d.durationMs === 'number' ? { durationMs: d.durationMs } : {}),
                ...(record.toolCount !== undefined ? { toolUses: record.toolCount } : {}),
                ...(record.currentTool !== undefined ? { currentTool: record.currentTool } : {}),
                ...(record.startedAt ? { startedAt: record.startedAt } : {}),
                ...(record.blocks ? { blocks: record.blocks } : {}),
                ...(record.toolCalls ? { toolCalls: record.toolCalls } : {}),
                ...(record.steers ? { steers: record.steers } : {}),
              },
            });
            // 同步发一条 tool 状态摘要供卡片行内展示
            hubRpc.onSessionStream.asEvent({
              sessionId: input.sessionId,
              botId: bot.id,
              toolName: `subagent:${record.subagentId}`,
              toolStatus: isDone ? ('done' as const) : ('running' as const),
              toolSummary: `${isDone ? (record.status === 'error' ? '[失败] ' : record.status === 'stopped' ? '[已停止] ' : '[完成] ') : ''}${record.task}${isDone && typeof d.durationMs === 'number' ? ` · ${Math.round(d.durationMs / 1000)}s` : ''}`,
            });
          } catch {
            // 推流失败不影响回合
          }
        };

        const handleSteered = (data: unknown) => {
          const d = data as { id?: string; message?: string };
          if (!d || typeof d !== 'object' || !d.id || typeof d.message !== 'string') return;
          const record = subagentRunsMap.get(d.id);
          if (!record) return;
          record.steers ??= [];
          record.steers.push({ message: d.message, timestamp: new Date().toISOString() });
          turnContext.emitSubagentEvent(record);
        };

        const unsubs = [
          ...['subagents:created', 'subagents:started', 'subagents:completed', 'subagents:failed'].map((ch) =>
            eventBus.on(ch, handleLifecycle(ch)),
          ),
          eventBus.on('subagents:steered', handleSteered),
        ];
        return () => {
          unsubs.forEach((u) => u());
          for (const unsub of subagentToolListeners.values()) unsub();
          subagentToolListeners.clear();
        };
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
    for (const unsub of subagentToolListeners.values()) unsub();
    subagentToolListeners.clear();
    pendingRuns.delete(runKey);
    activeSessions.delete(runKey);
    activeTurns.delete(runKey);
    cancelledRuns.delete(runKey);
    runKeyToDataDir.delete(runKey);
    endSubagentHandoffScope(handoffScope);
    if (session) {
      // 生命周期修复：session.dispose() 不会触发扩展的 session_shutdown，
      // pi-subagents 的 manager/后台分身会残留（globalThis 注册表泄漏、后台分身孤儿化）。
      // 在 dispose 前显式向扩展发 session_shutdown，让扩展 abortAll + 释放注册表。
      try {
        const runner = (session as any).extensionRunner;
        if (runner?.hasHandlers?.('session_shutdown')) {
          await runner.emit({ type: 'session_shutdown', reason: 'quit' });
        } else {
          getGlobalSubagentManager()?.abortAll?.();
        }
      } catch {
        // shutdown 事件失败不阻塞会话销毁
      }
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
    // 取消前先停掉全部分身（含后台），避免 dispose 只断开主会话而分身孤儿化
    try {
      getGlobalSubagentManager()?.abortAll?.();
    } catch {
      // ignore
    }
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

// =============================================================================
// 主会话内分身（Subagent）的运行中控制 RPC：steerBotTurn / stopSubagent / interactSubagent
// =============================================================================

/** 按 sessionId 找当前活跃回合上下文（同一会话同刻只有一个主回合在跑） */
function findActiveTurn(sessionId: string): ActiveTurnContext | undefined {
  for (const ctx of activeTurns.values()) {
    if (ctx.sessionId === sessionId) return ctx;
  }
  return undefined;
}

/**
 * 主会话运行中收到用户新消息：将正在阻塞等待的前台分身切为后台继续运行，
 * 并把新消息 steer 进当前主 Bot 回合，让主 Bot 马上接管响应
 * （调用 stop_subagent / steer_subagent 控制分身）。
 */
export async function steerBotTurn(
  sessionId: string,
  botId: string,
  message: string,
): Promise<{ accepted: boolean }> {
  const runKey = `${sessionId}:${botId}`;
  const ctx = activeTurns.get(runKey) ?? findActiveTurn(sessionId);
  if (!ctx) return { accepted: false };
  const session = activeSessions.get(ctx.runKey);
  if (!session) return { accepted: false };
  if (!message.trim()) return { accepted: false };

  // 1) 触发前台分身转后台（解除 Agent 工具的阻塞等待）
  triggerActiveSubagentHandoff();

  // 2) 将用户新消息注入当前主 Bot 回合
  try {
    await session.steer(message);
    return { accepted: true };
  } catch {
    return { accepted: false };
  }
}

/** 单独停止某一个正在运行的子代理（按 runId），不中断主回合与其他分身 */
export async function stopSubagent(
  sessionId: string,
  botId: string,
  runId: string,
): Promise<{ ok: boolean; error?: string }> {
  const manager = getGlobalSubagentManager();
  const record = manager?.getRecord?.(runId);
  if (!record) {
    return { ok: false, error: `Subagent run "${runId}" not found on this node (it may have finished or been evicted).` };
  }
  const aborted = manager?.abort?.(runId) ?? false;
  if (!aborted) {
    return { ok: false, error: `Subagent run "${runId}" is not running (status: ${record.status}).` };
  }

  // 更新本地 runRecord 状态并推送流事件（事件桥也会收到 subagents:failed，此处立即反馈）
  const ctx = findActiveTurn(sessionId) ?? activeTurns.get(`${sessionId}:${botId}`);
  if (ctx) {
    const run = ctx.subagentRunsMap.get(runId);
    if (run) {
      run.status = 'stopped';
      run.currentTool = undefined;
      if (typeof record.result === 'string' && record.result) {
        run.replyFull = record.result;
        run.replyPreview = record.result.slice(0, 200);
      }
      ctx.emitSubagentEvent(run);
    }
  }
  return { ok: true };
}

/**
 * 直接向某个子代理发送 steer（运行中插话）或 resume（结束后继续追问）。
 * - steer：通过全局 manager.steer 将消息投递进运行中的分身会话；
 * - resume：若 manager 记录仍在则 manager.resume 同一 runId；否则用保存的 sessionFile
 *   重开同一分身上下文执行一轮追问（跨回合场景）。期间推送同一 runId 的
 *   running -> done 状态、steers、toolCalls 与更新后的 replyFull。
 */
export async function interactSubagent(input: {
  sessionId: string;
  botId: string;
  runId: string;
  subagentId?: string;
  message: string;
  mode: 'steer' | 'resume';
}): Promise<{ ok: boolean; run?: SubagentRunRecord; error?: string }> {
  const { sessionId, botId, runId, message, mode } = input;
  if (!message.trim()) return { ok: false, error: 'Message must be non-empty.' };

  const ctx = findActiveTurn(sessionId) ?? activeTurns.get(`${sessionId}:${botId}`);
  const manager = getGlobalSubagentManager();
  const managerRecord = manager?.getRecord?.(runId);

  // 取（或重建）runRecord
  let run: SubagentRunRecord | undefined = ctx?.subagentRunsMap.get(runId);
  if (!run) {
    const meta = subagentSessionFiles.get(runId);
    run = {
      id: runId,
      subagentId: input.subagentId || meta?.subagentId || managerRecord?.type || 'agent',
      task: meta?.task || managerRecord?.description || runId,
      status: 'running',
      ...(managerRecord?.startedAt ? { startedAt: new Date(managerRecord.startedAt).toISOString() } : {}),
    };
  }
  const pushEvent = (patch: Partial<SubagentRunRecord>) => {
    Object.assign(run!, patch);
    ctx?.emitSubagentEvent(run!);
    // 回合已结束（后台 resume）时直接通过 lastHubRpc 推流
    if (!ctx && lastHubRpc) {
      try {
        lastHubRpc.onSessionStream.asEvent({
          sessionId,
          botId,
          subagentEvent: {
            id: run!.id,
            subagentId: run!.subagentId,
            task: run!.task,
            status: run!.status === 'skipped' ? 'done' : run!.status,
            ...(run!.replyFull !== undefined ? { result: run!.replyFull } : {}),
            ...(run!.durationMs !== undefined ? { durationMs: run!.durationMs } : {}),
            ...(run!.toolCount !== undefined ? { toolUses: run!.toolCount } : {}),
            ...(run!.currentTool !== undefined ? { currentTool: run!.currentTool } : {}),
            ...(run!.startedAt ? { startedAt: run!.startedAt } : {}),
            ...(run!.blocks ? { blocks: run!.blocks } : {}),
            ...(run!.toolCalls ? { toolCalls: run!.toolCalls } : {}),
            ...(run!.steers ? { steers: run!.steers } : {}),
          },
        });
      } catch {
        // 推流失败不影响结果返回
      }
    }
  };

  if (mode === 'steer') {
    if (!managerRecord || managerRecord.status !== 'running') {
      return { ok: false, error: `Subagent run "${runId}" is not running (status: ${managerRecord?.status ?? 'unknown'}). Use resume mode instead.` };
    }
    const accepted = manager?.steer?.(runId, message) ?? false;
    if (!accepted) {
      return { ok: false, error: `Failed to steer subagent run "${runId}".` };
    }
    run.steers ??= [];
    run.steers.push({ message, timestamp: new Date().toISOString(), mode: 'steer' });
    pushEvent({});
    return { ok: true, run };
  }

  // ---- resume：在同一 runId / 同一分身上下文继续追问 ----
  const startedAt = Date.now();
  run.steers ??= [];
  run.steers.push({ message, timestamp: new Date().toISOString(), mode: 'resume' });
  pushEvent({ status: 'running', currentTool: undefined });

  try {
    // 优先：manager 记录仍在（同回合或记录未被清理）→ manager.resume 保持同一 runId
    if (managerRecord?.session) {
      const record = await manager?.resume?.(runId, message, undefined, { isBackground: true });
      if (!record) {
        pushEvent({ status: 'error', replyFull: 'Resume was rejected (the run may still be in progress).', durationMs: Date.now() - startedAt });
        return { ok: false, run, error: 'Resume rejected: the run may still be in progress.' };
      }
      const isStopped = record.status === 'stopped' || record.status === 'aborted';
      const full = String(record.result || record.error || '');
      pushEvent({
        status: record.status === 'error' ? 'error' : isStopped ? 'stopped' : 'done',
        ...(full ? { replyFull: full, replyPreview: full.slice(0, 200) } : {}),
        durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
        currentTool: undefined,
      });
      return { ok: true, run };
    }

    // 跨回合：用保存的 sessionFile 重开同一分身上下文执行一轮追问
    const meta = subagentSessionFiles.get(runId);
    if (!meta?.sessionFile || !existsSync(meta.sessionFile)) {
      pushEvent({ status: 'error', replyFull: `Subagent session file for "${runId}" is gone; cannot resume.`, durationMs: Date.now() - startedAt });
      return { ok: false, run, error: `Subagent run "${runId}" has no resumable session file on this node.` };
    }

    const { piAgent } = await loadTurnDeps();
    const { SessionManager: SM, SettingsManager: SMs } = piAgent;
    const turnDeps = await loadTurnDeps();
    const getModel = turnDeps.piAiCompat.getModel;
    const botData = await readBot(getDataDirSafe(), botId);
    const botConfig = (botData as any)?.config ?? botData?.bot;
    if (!botConfig) {
      pushEvent({ status: 'error', replyFull: `Bot "${botId}" not found on node; cannot resume.`, durationMs: Date.now() - startedAt });
      return { ok: false, run, error: `Bot "${botId}" not found on node.` };
    }

    const parentDir = botConfig.parentBotId ? getBotDir(getDataDirSafe(), botConfig.parentBotId) : getBotDir(getDataDirSafe(), botConfig.id);
    const subDir = getBotDir(getDataDirSafe(), botConfig.parentBotId || botConfig.id);
    const workspaceDir = getBotWorkspaceDir(getDataDirSafe(), botConfig.parentBotId || botConfig.id);

    const modelRuntime = await createRuntimeForProvider(getDataDirSafe(), botConfig.modelProvider);
    await configureProviderAuth(modelRuntime, botConfig.modelProvider);
    const model =
      modelRuntime.getModel(botConfig.modelProvider, botConfig.modelId) ??
      getModel(botConfig.modelProvider as any, botConfig.modelId as any);
    if (!model) {
      pushEvent({ status: 'error', replyFull: `Model not found: ${botConfig.modelProvider}/${botConfig.modelId}`, durationMs: Date.now() - startedAt });
      return { ok: false, run, error: `Model not found: ${botConfig.modelProvider}/${botConfig.modelId}` };
    }

    // 分身会话文件在 subDir 下：重开同一文件继续追问
    const sessionManager = SM.open(meta.sessionFile, path.join(subDir, 'sessions'), workspaceDir);
    const settingsManager = SMs.inMemory({
      defaultProvider: botConfig.modelProvider,
      defaultModel: botConfig.modelId,
      compaction: { enabled: false },
    });
    const { commandsMod } = turnDeps;
    const resourceLoader = await commandsMod.loadBotResources(
      getDataDirSafe(),
      botConfig,
      settingsManager,
      () => [],
      { enableSubagents: false }, // 分身不能再派分身
    );
    const created = await piAgent.createAgentSession({
      cwd: workspaceDir,
      agentDir: parentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    const subSession = created.session;

    // 订阅分身工具事件，实时更新 run.toolCalls
    run.toolCalls ??= [];
    const toolStarts = new Map<string, number>();
    const unsubTools = subSession.subscribe((event: any) => {
      if (event.type === 'tool_execution_start') {
        const key = event.toolCallId || `${event.toolName}_${run!.toolCalls!.length}`;
        toolStarts.set(key, Date.now());
        const summary = extractToolSummary(event.toolName, event.args ?? event.input);
        const sanitizedArgs = sanitizeToolArgs(event.args ?? event.input);
        run!.toolCalls!.push({ id: key, name: event.toolName, ...(sanitizedArgs ? { args: sanitizedArgs } : {}), ...(summary ? { summary } : {}), status: 'running' });
        run!.currentTool = event.toolName;
        run!.toolCount = run!.toolCalls!.length;
        pushEvent({});
      } else if (event.type === 'tool_execution_end') {
        const key = event.toolCallId || event.toolName;
        const entry = [...run!.toolCalls!].reverse().find((tc) => tc.id === key || tc.name === event.toolName);
        if (entry) {
          entry.status = event.isError ? 'error' : 'done';
          const started = toolStarts.get(key) ?? (entry.id ? toolStarts.get(entry.id) : undefined);
          toolStarts.delete(key);
          if (started !== undefined) entry.durationMs = Math.max(0, Date.now() - started);
          entry.isError = Boolean(event.isError);
          const outputPreview = extractToolOutputPreview(event.result !== undefined ? event.result : event.output, Boolean(event.isError));
          if (outputPreview) entry.outputPreview = outputPreview;
        }
        if (!run!.toolCalls!.some((tc) => tc.status === 'running')) run!.currentTool = undefined;
        run!.toolCount = run!.toolCalls!.length;
        pushEvent({});
      }
    });

    try {
      await subSession.prompt(message);
      await subSession.waitForIdle();
    } finally {
      unsubTools();
    }

    const assistants = subSession.messages.filter((m: any) => m.role === 'assistant');
    const texts = assistants.flatMap((m: any) =>
      (m.content || [])
        .filter((p: any) => p.type === 'text' && typeof p.text === 'string' && p.text.length > 0)
        .map((p: any) => p.text),
    );
    const reply = texts.join('\n\n').trim();
    const lastError = assistants.some((m: any) => m.stopReason === 'error');

    pushEvent({
      status: lastError ? 'error' : 'done',
      ...(reply ? { replyFull: reply, replyPreview: reply.slice(0, 200) } : {}),
      durationMs: Date.now() - startedAt,
      currentTool: undefined,
    });
    try {
      subSession.dispose();
    } catch {
      // ignore
    }
    return { ok: true, run };
  } catch (err: any) {
    const errorText = err?.message || String(err);
    pushEvent({ status: 'error', replyFull: errorText, durationMs: Date.now() - startedAt });
    return { ok: false, run, error: errorText };
  }
}
