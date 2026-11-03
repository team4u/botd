import path from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type {
  BotConfig,
  NodeRpcFunctions,
  SubagentRunRecord,
  ToolCallRecord,
  TurnBlock,
  TurnUsage,
} from '@botd/protocol';
import {
  assertSafeId,
  ensureDir,
  listBotMemoryTopics,
  readBot,
  readBotEnv,
  readNodeIdentity,
  readNodeMemory,
  readSkill,
} from '../storage.js';
import { createRuntimeForProvider, configureProviderAuth } from '../models.js';
import { BUILTIN_SKILL_ID } from '../builtin-skill.js';
import {
  beginSubagentHandoffScope,
  endSubagentHandoffScope,
  getGlobalSubagentManager,
  type SubagentHandoffScope,
} from '../commands.js';
import { loadTurnDeps } from './turn-deps.js';
import { createHubStreamSink, type HubStream } from './hub-stream.js';
import { runRegistry, purgeStaleSubagentManager, subagentSessionFiles } from './run-registry.js';
import { resolveEffectiveBot, resolveBotPaths, cleanupEphemeralAgents } from './bot-context.js';
import { buildMemoryPromptSection, canBotWriteMemory } from './memory-prompt.js';
import { ensureBotdBinWrapper } from './bin-wrapper.js';
import { buildAutomationEventEnv } from './automation-event.js';
import { buildShellTools, resolveSessionTools, disposeSession } from './shell-tools.js';
import { ingestTurnAttachments, modelSupportsVision } from './attachments.js';
import { TurnEventRecorder } from './turn-events.js';
import { createSubagentBridge } from './subagent-bridge.js';
import {
  collectTurnUsage,
  collectAssistantText,
  buildBlocksFromFinalized,
  calibrateTextBlocks,
} from './turn-result.js';

/**
 * 主回合编排：从 Hub 的 runTurn 输入到回合结果。
 * 步骤本身薄，每步的实现都在对应单一职责模块里；本文件只负责顺序与生命周期。
 */

type RunTurnInput = Parameters<NodeRpcFunctions['runTurn']>[0];

export interface BotTurnResult {
  replyText: string;
  modelBadge: string;
  toolCalls?: ToolCallRecord[];
  blocks?: TurnBlock[];
  usage?: TurnUsage;
  subagentRuns?: SubagentRunRecord[];
  aborted?: boolean;
}

export async function executeBotTurn(
  dataDir: string,
  bot: BotConfig,
  input: RunTurnInput,
  hubRpc: HubStream,
): Promise<BotTurnResult> {
  assertSafeId(bot.id, 'Bot ID');
  assertSafeId(input.sessionId, 'Session ID');

  const runKey = `${input.sessionId}:${bot.id}`;
  if (!runRegistry.reserve(runKey, dataDir)) {
    throw new Error(`Turn already running for session ${input.sessionId} and bot ${bot.id}`);
  }

  const sink = createHubStreamSink(hubRpc);

  let handoffScope: SubagentHandoffScope | undefined;
  let session: AgentSession | null = null;
  let unsubscribeMain: (() => void) | null = null;
  let bridge: ReturnType<typeof createSubagentBridge> = undefined;
  // 临时子代理（agents/tmp-*.md）在主 BOT 回合结束时统一清理；主目录不随子代理回合变化，提前解析
  const mainAgentDir = resolveBotPaths(dataDir, bot).mainAgentDir;

  try {
    // 工作区互斥：子代理与其父主 Bot 共享同一 workspace 目录，同一主 Bot 的回合跨会话串行。
    // 必须在 purgeStaleSubagentManager / beginSubagentHandoffScope 之前排队等待，
    // 否则排队中的回合会提前清掉或覆盖正在运行回合的全局状态（subagent manager / handoff scope）。
    const workspaceBotId = bot.parentBotId || bot.id;
    await runRegistry.acquireWorkspace(runKey, dataDir, workspaceBotId);

    // 生命周期修复：上一轮异常退出可能残留全局 manager 注册表
    // （与原始语义一致：activeTurns 为空时清理；pending 中的回合不算已注册）
    purgeStaleSubagentManager(!runRegistry.hasRegisteredTurns());

    handoffScope = beginSubagentHandoffScope();
    const { piAgent, piAiCompat, commandsMod, webCommandUiMod } = await loadTurnDeps();
    const { createAgentSession, SessionManager, SettingsManager } = piAgent;
    const { getModel } = piAiCompat;
    const { collectBotCommands, loadBotResources } = commandsMod;
    const { guardExtensionCommands } = webCommandUiMod;

    // --- 1. 生效配置与目录 ---
    let parentBotData: Awaited<ReturnType<typeof readBot>> = null;
    if (bot.parentBotId) {
      parentBotData = await readBot(dataDir, bot.parentBotId);
    }
    const parentBotConfig = (parentBotData as any)?.config ?? parentBotData?.bot;
    const effectiveBot = resolveEffectiveBot(bot, parentBotConfig ?? null);
    const { botDir, workspaceDir, sessionDir } = resolveBotPaths(dataDir, bot);
    const sessionFile = path.join(sessionDir, `${input.sessionId}.jsonl`);
    await ensureDir(workspaceDir);
    await ensureDir(sessionDir);

    // --- 2. 附件 / 上游产物落盘 ---
    const { notice: attachmentNotice, images: turnImages } = await ingestTurnAttachments(
      workspaceDir,
      input,
      hubRpc,
    );

    if (runRegistry.isCancelled(runKey)) throw new Error('Turn was cancelled');

    // --- 3. bin 包装器 / 模型运行时 / 模型解析 ---
    const binDir = await ensureBotdBinWrapper(dataDir);
    const modelRuntime = await createRuntimeForProvider(dataDir, effectiveBot.modelProvider);
    await configureProviderAuth(modelRuntime, effectiveBot.modelProvider);

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

    // --- 4. BOT 文件 / 环境变量 / 内置技能 ---
    const botData = await readBot(dataDir, bot.id);
    const systemMd = botData?.systemMd || '';
    const memoryMd = botData?.memoryMd || '';
    const nodeMemoryMd = await readNodeMemory(dataDir);
    // 主题记忆目录索引：主 Bot 读自身目录；子代理合并主 Bot 与自身目录并去重
    const mainBotId = bot.parentBotId || bot.id;
    const memoryTopics = Array.from(
      new Set([
        ...(await listBotMemoryTopics(dataDir, mainBotId)),
        ...(bot.parentBotId ? await listBotMemoryTopics(dataDir, bot.id) : []),
      ]),
    );
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

    // --- 5. 资源加载（技能 / 扩展 / 提示词 + 追加系统提示） ---
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: effectiveBot.modelProvider,
      defaultModel: effectiveBot.modelId,
      compaction: { enabled: process.env.BOTD_AUTO_COMPACT !== '0' },
    });
    // 主 BOT 挂载 pi-subagents 底座：获得 Agent / SubagentWorkflow 工具，可调度 .pi/agents/ 下的子代理。
    // 子代理（parentBotId 已设置）不挂载，防套娃；扩展内部另有 inChildSessionContext 防重入双保险。
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
          buildMemoryPromptSection({
            memoryMd,
            parentMemoryMd: parentBotData?.memoryMd,
            nodeMemoryMd,
            memoryTopics,
            canWrite: canBotWriteMemory(bot),
          }),
          botEnvKeys.length > 0
            ? `[已注入专属环境变量]\n当前命令执行环境已预置以下环境变量（可直接在命令或脚本中通过 $VAR 引用，请勿在公屏直接打印密钥明文）：${botEnvKeys.map((k) => `$${k}`).join(', ')}`
            : '',
          skillContents.length > 0 ? `[框架内置 Skills]\n\n${skillContents.join('\n\n')}` : '',
        ].filter(Boolean),
      { enableSubagents: !bot.parentBotId, sessionId: input.sessionId },
    );

    // --- 6. 回合环境与 shell 工具 ---
    const nodeIdentity = await readNodeIdentity(dataDir);
    const turnEnv: Record<string, string | undefined> = {
      BOTD_NODE_ID: bot.nodeId || nodeIdentity?.nodeId || '',
      ...(nodeIdentity?.hubUrl ? { BOTD_HUB_URL: nodeIdentity.hubUrl } : {}),
      PI_CODING_AGENT_DIR: mainAgentDir,
      // 自动化事件上下文：让脚本/扩展能区分本轮是 cron/webhook/定时/后台任务还是用户手动发起
      ...buildAutomationEventEnv(input.incrementalMessages ?? ''),
    };
    const customTools =
      bot.toolScope === 'readonly'
        ? []
        : buildShellTools(
            {
              createBashToolDefinition: piAgent.createBashToolDefinition,
              createPowerShellToolDefinition: piAgent.createPowerShellToolDefinition,
            },
            workspaceDir,
            { dataDir, binDir, sessionId: input.sessionId, botId: bot.id, botEnv, turnEnv },
          );

    // --- 7. 建立持久会话 ---
    const sessionManager = SessionManager.open(sessionFile, sessionDir, workspaceDir);
    if (runRegistry.isCancelled(runKey)) throw new Error('Turn was cancelled');

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
      ...(resolveSessionTools(bot) ? { tools: resolveSessionTools(bot)! } : {}),
    });
    session = created.session;
    runRegistry.activate(runKey, session);

    // --- 8. 事件记录与推流 ---
    const toolCalls: ToolCallRecord[] = [];
    const blocks: TurnBlock[] = [];
    const recorder = new TurnEventRecorder(
      { blocks, toolCalls },
      {
        paragraphBetweenMessages: true,
        onThinking: (payload) => sink.thinking(input.sessionId, bot.id, payload),
        onText: (delta) => sink.text(input.sessionId, bot.id, delta),
        onTool: ({ status, toolCall, outputPreview, durationMs }) =>
          sink.tool(input.sessionId, bot.id, {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            toolStatus: status,
            toolSummary: toolCall.summary,
            toolArgs: toolCall.args,
            toolOutput: outputPreview,
            toolDurationMs: durationMs,
            toolIsError: toolCall.isError,
          }),
      },
    );
    unsubscribeMain = recorder.attach(session);

    // 注册活跃回合上下文：供 steerBotTurn / stopSubagent / interactSubagent 在回合外操控
    bridge = createSubagentBridge(resourceLoader, {
      sessionId: input.sessionId,
      botId: bot.id,
      sink,
      sessionFiles: subagentSessionFiles,
    });
    runRegistry.registerTurn({
      runKey,
      sessionId: input.sessionId,
      botId: bot.id,
      dataDir,
      handoffScope,
      session,
      subagentBridge: bridge,
      sessionFiles: subagentSessionFiles,
      emitSubagentEvent: (run, patch) => bridge?.emit(run, patch),
      peekSubagentRun: (runId) => bridge?.runs.get(runId),
    });

    // --- 9. 扩展绑定（print 模式 + 网页不支持的会话动作显式拒绝） ---
    // messageCountBefore 在 bindExtensions 之前拍快照：只看本回合消息，扩展命令可能不产生 assistant 消息
    const extensionErrors: string[] = [];
    const messageCountBefore = session.messages.length;
    const boundSession = session;
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
      onError: (error: { error: string }) => {
        if (!extensionErrors.includes(error.error)) extensionErrors.push(error.error);
      },
    });
    if (extensionErrors.length) throw new Error(extensionErrors.join('\n'));
    if (runRegistry.isCancelled(runKey)) throw new Error('Turn was cancelled');

    guardExtensionCommands(resourceLoader, (error) => {
      if (!extensionErrors.includes(error.message)) extensionErrors.push(error.message);
    });

    // --- 10. 提示词组装（附件通知 / 斜杠命令校验） ---
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
      if (!collectBotCommands(resourceLoader, session.extensionRunner).some((command) => command.name === commandName)) {
        throw new Error(`未知或不可用的命令 /${commandName}`);
      }
    }

    // --- 11. 执行回合 ---
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
      if (turnImages.length > 0 && modelSupportsVision(model)) {
        await session.prompt(promptText, { images: turnImages });
      } else {
        await session.prompt(promptText);
      }
    }
    await session.waitForIdle();

    // --- 12. 后台子代理排空（CompletionOutbox 会在主回合后补投递） ---
    const drainDeadline = Date.now() + 120_000;
    let drainedBackground = false;
    while (
      !runRegistry.isCancelled(runKey) &&
      Date.now() < drainDeadline &&
      ((bridge ? bridgeHasRunning(bridge) : false) || Boolean(getGlobalSubagentManager()?.hasRunning?.()))
    ) {
      drainedBackground = true;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (drainedBackground && !runRegistry.isCancelled(runKey)) {
      // Wait briefly for CompletionOutbox (500ms hold) to deliver follow-up turn into session
      await new Promise((r) => setTimeout(r, 600));
      await session.waitForIdle();
    }

    recorder.markThinkingDone();
    if (extensionErrors.length) throw new Error(extensionErrors.join('\n'));

    // --- 13. 用户中止收尾：保留部分输出，标记 cancelled ---
    const wasCancelled = runRegistry.isCancelled(runKey);
    if (wasCancelled) recorder.markCancelled();

    // A handled extension command may not create an assistant message. Inspect only
    // this run's messages so previous replies/errors never become the command result.
    const turnAssistants = session.messages.slice(messageCountBefore).filter((message) => message.role === 'assistant');
    const lastAssistant = turnAssistants.at(-1) as any;
    if (lastAssistant?.stopReason === 'error') throw new Error(lastAssistant.errorMessage || 'Model inference failed');

    // --- 14. 回复文本 / 用量 / blocks 定稿 ---
    const assistantText = collectAssistantText(turnAssistants);
    const replyText = assistantText
      || (wasCancelled
        ? ''
        : (isCompactCommand
          ? (isCompactSmall ? '（无需压缩：当前会话上下文尚未达到压缩阈值）' : '（已完成会话上下文压缩）')
          : '（已完成执行，无文本输出）'));

    const usage = collectTurnUsage(turnAssistants, (model as any).contextWindow);

    let finalBlocks =
      blocks.length > 0 ? blocks : buildBlocksFromFinalized(turnAssistants, toolCalls);
    finalBlocks = calibrateTextBlocks(finalBlocks, turnAssistants);
    if (finalBlocks.length === 0 && replyText.length > 0) {
      finalBlocks = [{ type: 'text', text: replyText }];
    }

    return {
      replyText,
      modelBadge: `${effectiveBot.modelProvider}/${effectiveBot.modelId}`,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(finalBlocks.length > 0 ? { blocks: finalBlocks } : {}),
      ...(usage ? { usage } : {}),
      ...(bridge && bridge.runs.size > 0 ? { subagentRuns: Array.from(bridge.runs.values()) } : {}),
      ...(wasCancelled ? { aborted: true } : {}),
    };
  } finally {
    unsubscribeMain?.();
    bridge?.dispose();
    runRegistry.release(runKey);
    endSubagentHandoffScope(handoffScope);
    if (session) {
      await disposeSession(session);
    }
    // 主 BOT 回合结束（含中止/异常）：清理本轮临时子代理定义（子代理回合跑在主回合内，由主回合统一清理）
    if (!bot.parentBotId) {
      await cleanupEphemeralAgents(mainAgentDir);
    }
  }
}

/** 本回合子代理仍有运行记录（bridge 记录状态）或全局 manager 仍在跑（其他回合遗留） */
function bridgeHasRunning(bridge: NonNullable<ReturnType<typeof createSubagentBridge>>): boolean {
  for (const run of bridge.runs.values()) {
    if (run.status === 'running') return true;
  }
  return false;
}
