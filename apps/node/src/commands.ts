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
import { assertSafeId, ensureDir, getBotDir, resolveSkillDir, writeAtomicFile } from './storage.js';
import subagentsExtension from '@tintinweb/pi-subagents/dist/index.js';
import { resolveSpawnType } from '@tintinweb/pi-subagents/dist/agent-types.js';
import type { ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent';
// 跨 Bot 协调 / 子会话 / 工作流机制已拆到 cross-bot/*，这里 re-export 保持对外导出签名兼容
import {
  getGlobalSubagentManager,
  requestSubagentsRpc,
  getActiveSubagentHandoffScope,
  beginSubagentHandoffScope,
  endSubagentHandoffScope,
  triggerActiveSubagentHandoff,
  rebindSubagentGlobalsForBot,
  createHandoffWatch,
  type SubagentHandoffScope,
} from './cross-bot/coordination.js';
import {
  connectHubAsNode,
  effectiveTimeoutSeconds,
  emitSubagentEvent,
  executeCrossBotSession,
  findCrossBotSession,
  getDefaultCrossBotTimeoutSeconds,
  sendSessionMessageAndWait,
} from './cross-bot/session.js';
import { parseAgentTypePrefix, wrapWorkflowToolForCrossBot } from './cross-bot/workflow.js';

export {
  getGlobalSubagentManager,
  requestSubagentsRpc,
  getActiveSubagentHandoffScope,
  beginSubagentHandoffScope,
  endSubagentHandoffScope,
  triggerActiveSubagentHandoff,
  rebindSubagentGlobalsForBot,
  createHandoffWatch,
  getDefaultCrossBotTimeoutSeconds,
};
export type { SubagentHandoffScope };

/** pi-subagents 扩展工厂：为主 BOT 提供 Agent / SubagentWorkflow 编排底座。 */
const subagentsExtensionFactory: ExtensionFactory = subagentsExtension as unknown as ExtensionFactory;

interface WrapAgentToolDeps {
  dataDir: string;
  bot: BotConfig;
  botDir: string;
  workspaceDir: string;
  sessionId?: string;
  pi: ExtensionAPI;
  handoffScope: SubagentHandoffScope | undefined;
}

function wrapAgentToolForHandoff(tool: any, deps: WrapAgentToolDeps): any {
  const originalExecute = tool.execute?.bind(tool);
  if (typeof originalExecute !== 'function') return tool;
  const { dataDir, botDir, pi, handoffScope } = deps;

  const dispatchWithThisBotsAgents = (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: any,
  ) => {
    // 同步重置全局注册表再进入原 execute：pi-subagents 的 execute 前缀
    // （reloadCustomAgents + resolveSpawnType）是同步的，JS 单线程内这一步
    // 之后、首个 await 之前的解析不会被并发回合的环境覆盖。
    if (botDir) rebindSubagentGlobalsForBot(botDir);
    return originalExecute(toolCallId, params, signal, onUpdate, ctx);
  };

  const makeTextResult = (text: string, isError = false) =>
    ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) }) as any;

  const findTool = (ctx: any, name: string): any => {
    try {
      const runner = ctx?.session?.extensionRunner ?? ctx?.extensionRunner;
      const def = runner?.getToolDefinition?.(name);
      if (def?.execute) return def;
    } catch {
      // fall through
    }
    return undefined;
  };

  // 扩展参数定义与工具描述
  const parameters = tool.parameters ? { ...tool.parameters } : { type: 'object', properties: {} };
  const properties = { ...(parameters.properties || {}) };

  if (properties.subagent_type) {
    properties.subagent_type = {
      ...properties.subagent_type,
      description:
        'The subagent type to spawn (local role subagent ID sharing this workspace) or target primary BOT ID ' +
        '(e.g. "@botId", "bot:botId", or "botId") to delegate via an isolated sub-session with zero-copy artifact sharing.',
    };
  }
  if (!properties.title) {
    properties.title = {
      type: 'string',
      description: 'Optional short title for cross-bot sub-session (defaults to description).',
    };
  }
  if (!properties.artifact_ids) {
    properties.artifact_ids = {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional list of parent session artifact IDs to share with the sub-session. Omit to share all current session artifacts.',
    };
  }
  if (!properties.timeout_seconds) {
    properties.timeout_seconds = {
      type: 'number',
      description: 'Maximum seconds to wait when run_in_background is false (default: 600 or BOTD_CROSS_BOT_TIMEOUT_SECONDS).',
    };
  }
  parameters.properties = properties;

  const description =
    'Spawn an autonomous subagent or delegate to another primary BOT. ' +
    'For subagent_type, you can pass either a local role subagent ID (shares your workspace) ' +
    'or another primary BOT ID (prefixed with "@", "bot:", or direct bot ID, runs in an isolated sub-session with zero-copy artifact sharing). ' +
    'Defaults to run_in_background: false (waits for completion inline; emit multiple Agent calls in one turn to run in parallel). ' +
    'Set run_in_background: true for long-running tasks that wake the parent session when done.';

  const wrappedExecute = async (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: any,
  ) => {
    // 1) 跨 Bot 子会话 resume 判定
    if (params?.resume) {
      const resumeRef = String(params.resume).trim();
      const remote = findCrossBotSession(resumeRef);
      if (remote) {
        const runId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const startMs = Date.now();
        const desc = String(params.description || params.prompt || '').slice(0, 80);
        emitSubagentEvent(pi, 'subagents:started', {
          id: runId,
          type: remote.botId,
          description: desc,
          childSessionId: remote.childSessionId,
        });
        const client = await connectHubAsNode(dataDir);
        const res = await sendSessionMessageAndWait(client, remote.childSessionId, String(params.prompt || ''), {
          waitSeconds: effectiveTimeoutSeconds(params?.timeout_seconds),
          signal,
        });
        emitSubagentEvent(
          pi,
          res.ok ? 'subagents:completed' : 'subagents:failed',
          { id: runId, type: remote.botId, description: desc, childSessionId: remote.childSessionId },
          {
            status: res.ok ? 'completed' : 'error',
            ...(res.ok ? { result: res.reply } : { error: res.reply || 'Resume failed' }),
            durationMs: Date.now() - startMs,
          },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Sub-session: ${remote.childSessionId} (@${remote.botId}) — ${res.status}\n${res.reply}`,
            },
          ],
          details: { ...res, agentId: runId, childSessionId: remote.childSessionId },
          ...(res.ok ? {} : { isError: true }),
        } as any;
      }
      return dispatchWithThisBotsAgents(toolCallId, params, signal, onUpdate, ctx);
    }

    // 2) 路由判定：本地子代理 vs 跨 Bot 子会话
    const { cleanType, forceRemote } = parseAgentTypePrefix(String(params?.subagent_type || ''));

    if (botDir) rebindSubagentGlobalsForBot(botDir);
    const localDispatch = !forceRemote ? resolveSpawnType(cleanType) : { ok: false as const };

    // Branch A：本地子代理
    if (localDispatch.ok) {
      const wantsForeground = params?.run_in_background === false || params?.run_in_background === undefined;
      // 仅拦截“新前台调用且非 resume”：resume / 后台 / 定时调用走原路径
      if (!wantsForeground || params?.schedule) {
        return dispatchWithThisBotsAgents(toolCallId, params, signal, onUpdate, ctx);
      }

      // 已被接管（用户已发新消息）：这次调用直接按后台跑，不再阻塞
      if (handoffScope?.wasTriggered()) {
        return dispatchWithThisBotsAgents(toolCallId, { ...params, run_in_background: true }, signal, onUpdate, ctx);
      }

      const getResultTool = findTool(ctx, 'get_subagent_result');
      if (!getResultTool) {
        // 找不到等待工具（扩展未激活）：退回原生行为
        return dispatchWithThisBotsAgents(toolCallId, params, signal, onUpdate, ctx);
      }

      // 以后台方式启动子代理，拿到 agentId
      const bgResult = await dispatchWithThisBotsAgents(toolCallId, { ...params, run_in_background: true }, signal, onUpdate, ctx);
      const agentId = String((bgResult as any)?.details?.agentId || '').trim();
      if (!agentId) {
        return bgResult;
      }

      // 组合信号：父级取消（整会话停止）或用户接管（主会话新消息）
      const watch = createHandoffWatch({
        parentSignal: signal,
        handoffScope,
        onParentAbort: () => {
          const manager = getGlobalSubagentManager();
          manager?.abort?.(agentId);
        },
      });

      try {
        const waitResult = await getResultTool.execute(
          `wait_${toolCallId}`,
          { agent_id: agentId, wait: true },
          watch.signal,
          undefined,
          ctx,
        );
        if (watch.isHandedOff()) {
          return makeTextResult(
            `Agent "${agentId}" (${params.subagent_type}) has been moved to the background because the user sent a new message in the session. It is STILL RUNNING. Read the user's new message and use stop_subagent, steer_subagent, or get_subagent_result with agent_id "${agentId}" as needed.`
          );
        }
        return waitResult;
      } finally {
        watch.cleanup();
      }
    }

    // Branch B：跨 Bot 子会话委派
    const parentSessionId = deps.sessionId || process.env.BOTD_SESSION_ID || '';
    if (!parentSessionId) {
      return makeTextResult('Missing session context: cannot resolve the parent session ID for subagent dispatch.', true);
    }
    if (!cleanType) {
      return makeTextResult('Missing required parameter: subagent_type.', true);
    }
    if (!params?.prompt || String(params.prompt).trim() === '') {
      return makeTextResult('Missing required parameter: prompt is required.', true);
    }

    const runId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const client = await connectHubAsNode(dataDir);
    const execRes = await executeCrossBotSession({
      client,
      pi,
      parentSessionId,
      botId: cleanType,
      prompt: String(params.prompt).trim(),
      title: params?.title || params?.description,
      artifactIds: params?.artifact_ids,
      runInBackground: params?.run_in_background === true,
      timeoutSeconds: effectiveTimeoutSeconds(params?.timeout_seconds),
      handoffScope,
      signal,
      stepRunId: runId,
      label: params?.description || cleanType,
    });

    return {
      content: [{ type: 'text', text: execRes.formattedText }],
      details: execRes.details,
      ...(execRes.status === 'failed' ? { isError: true } : {}),
    } as any;
  };

  return { ...tool, description, parameters, execute: wrappedExecute };
}

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
  options?: { enableSubagents?: boolean; sessionId?: string },
): Promise<DefaultResourceLoader> {
  const botDir = getBotDir(dataDir, bot.id);
  const workspaceDir = path.join(botDir, 'workspace');
  const promptsDir = path.join(botDir, 'prompts');
  const skillPaths = (bot.enabledSkills ?? []).map(id =>
    resolveSkillDir(dataDir, id, workspaceDir)
  );
  // 主 BOT 挂载 pi-subagents 底座（Agent / SubagentWorkflow 编排工具 + 子代理调度）；
  // 子代理不挂载（防套娃：子代理不能再派子代理），扩展内部另有 inChildSessionContext 防重入双保险。
  let extensionFactories: ExtensionFactory[] = [];
  if (options?.enableSubagents && !bot.parentBotId) {
    await ensureDir(path.join(botDir, 'agents'));
    await writeAtomicFile(
      path.join(botDir, 'subagents.json'),
      JSON.stringify(
        {
          disableDefaultAgents: false,
          disableDefaults: false,
          fallbackSubagent: 'none',
          backgroundByDefault: false,
          packageAgents: false,
          // smart：完成通知在空闲 200ms 窗口或回合边界即时投递，
          // 供主会话运行中新消息接管时能拿到实时结果。
          defaultJoinMode: 'smart',
        },
        null,
        2
      )
    );

    const wrappedSubagentsFactory: ExtensionFactory = async (pi) => {
      rebindSubagentGlobalsForBot(botDir);

      // 拦截 pi.registerTool：包一层 Agent 工具包装器（Auto-background on User Message）。
      // 主 Bot 前台等待子代理时，若用户在主会话发送新消息，steerBotTurn 会触发该回合的
      // handoffController，此时等待立即解除、子代理转后台继续运行，主 Bot 马上接管响应。
      const realRegisterTool = pi.registerTool.bind(pi);
      const handoffScope = getActiveSubagentHandoffScope();
      const wrappedRegisterTool: typeof pi.registerTool = ((tool: any) => {
        if (tool?.name === 'SubagentWorkflow') {
          return realRegisterTool(
            wrapWorkflowToolForCrossBot(tool, {
              dataDir,
              bot,
              botDir,
              workspaceDir,
              sessionId: options?.sessionId,
              pi,
              handoffScope,
            }),
          );
        }
        if (tool?.name !== 'Agent') {
          return realRegisterTool(tool);
        }
        const wrappedTool = wrapAgentToolForHandoff(tool, {
          dataDir,
          bot,
          botDir,
          workspaceDir,
          sessionId: options?.sessionId,
          pi,
          handoffScope,
        });
        return realRegisterTool(wrappedTool);
      }) as typeof pi.registerTool;
      const scopedPi = new Proxy(pi as ExtensionAPI, {
        get(target, prop) {
          if (prop === 'registerTool') return wrappedRegisterTool;
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? (value as any).bind(target) : value;
        },
      });

      await subagentsExtensionFactory(scopedPi as ExtensionAPI);
      rebindSubagentGlobalsForBot(botDir);

      // 注册 stop_subagent：按 agent_id（或 handle/subagent_type）单独停掉一个运行中的子代理，
      // 不中断主回合与其他并发子代理。优先直接命中 manager 记录，退化为事件总线 RPC。
      realRegisterTool({
        name: 'stop_subagent',
        label: 'Stop Subagent',
        description:
          'Stop a running subagent by its agent_id (or handle/subagent_type) without aborting the main turn. ' +
          'Use this when the user asks to stop/interrupt one specific subagent while others keep running.',
        promptSnippet: 'Stop a single running subagent without aborting the main turn',
        parameters: {
          type: 'object',
          properties: {
            agent_id: {
              type: 'string',
              description:
                'The agent ID to stop (the id returned by the Agent tool). The agent\'s handle or subagent_type also works.',
            },
          },
          required: ['agent_id'],
        } as any,
        execute: async (_toolCallId: string, params: { agent_id: string }) => {
          const ref = String(params?.agent_id || '').trim();
          if (!ref) {
            return { content: [{ type: 'text', text: 'Missing agent_id.' }], isError: true } as any;
          }
          const manager = getGlobalSubagentManager();
          if (manager?.getRecord) {
            let target: { id?: string; handle?: string; type?: string } | undefined =
              manager.getRecord(ref) as any;
            if (!target) {
              for (const record of manager.listAgents?.() ?? []) {
                const r = record as any;
                if (r?.handle === ref || r?.alias === ref || r?.type === ref) {
                  target = r;
                  break;
                }
              }
            }
            if (!target?.id) {
              return {
                content: [{ type: 'text', text: `Agent not found: "${ref}". It may have already finished or been cleaned up.` }],
              } as any;
            }
            const stopped = manager.abort?.(target.id);
            return {
              content: [
                {
                  type: 'text',
                  text: stopped
                    ? `Agent "${target.id}" stop requested. It will stop after its current tool execution; use get_subagent_result to read its partial output.`
                    : `Agent "${target.id}" is not running (it may have already finished).`,
                },
              ],
            } as any;
          }
          // 退化路径：通过事件总线 RPC 停止（跨激活的 manager 仍挂着 RPC 处理器）
          const stoppedViaRpc = await requestSubagentsRpc(pi, 'subagents:rpc:stop', { agentId: ref });
          return {
            content: [
              {
                type: 'text',
                text: stoppedViaRpc
                  ? `Agent "${ref}" stop requested.`
                  : `Could not stop agent "${ref}": not found or not running.`,
              },
            ],
          } as any;
        },
      } as any);

      pi.on('session_start', () => {
        rebindSubagentGlobalsForBot(botDir);
      });
      pi.on('before_agent_start', () => {
        rebindSubagentGlobalsForBot(botDir);
      });
    };

    extensionFactories = [wrappedSubagentsFactory];
  }
  const loader = new DefaultResourceLoader({
    cwd: workspaceDir,
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
    extensionFactories,
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
