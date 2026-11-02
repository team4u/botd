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
import { assertSafeId, ensureDir, getBotDir, writeAtomicFile } from './storage.js';
import subagentsExtension from '@tintinweb/pi-subagents/dist/index.js';
import {
  setDefaultsDisabled,
  setFallbackSubagent,
  NO_FALLBACK,
  registerAgents,
} from '@tintinweb/pi-subagents/dist/agent-types.js';
import { loadCustomAgents } from '@tintinweb/pi-subagents/dist/custom-agents.js';
import type { ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** pi-subagents 扩展工厂：为主 BOT 提供 Agent / SubagentWorkflow 编排底座。 */
const subagentsExtensionFactory: ExtensionFactory = subagentsExtension as unknown as ExtensionFactory;

/**
 * 全局 subagent manager 注册表（由 pi-subagents 扩展用 Symbol.for 挂载）。
 * 只读出运行/停止能力，不持有具体类型引用，避免与扩展内部结构耦合。
 */
export function getGlobalSubagentManager():
  | {
      hasRunning?: () => boolean;
      waitForAll?: () => Promise<void>;
      abort?: (id: string) => boolean;
      abortAll?: () => number;
      steer?: (id: string, message: string) => boolean;
      resume?: (id: string, prompt: string, signal?: AbortSignal, options?: any) => Promise<any>;
      spawn?: (pi: unknown, ctx: unknown, type: string, prompt: string, options: any) => string;
      getRecord?: (id: string) => any;
      listAgents?: () => any[];
    }
  | undefined {
  return (globalThis as any)[Symbol.for('pi-subagents:manager')];
}

/** 通过 pi.events 事件总线调用 subagents 扩展的 RPC（stop / steer 等），返回是否成功 */
export function requestSubagentsRpc(
  pi: { events: { on: (ch: string, fn: (d: unknown) => void) => () => void; emit: (ch: string, d: unknown) => void } },
  channel: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const requestId = `botd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `${channel}:reply:${requestId}`;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        unsub();
        resolve(false);
      }
    }, timeoutMs);
    const unsub = pi.events.on(replyChannel, (reply: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(Boolean((reply as any)?.success));
    });
    pi.events.emit(channel, { ...params, requestId });
  });
}

/**
 * 主会话“用户新消息接管”（steerBotTurn）时需要释放的前台子代理等待句柄。
 * 每个主回合开始时创建，回合结束时消费并清理。
 */
export interface SubagentHandoffScope {
  /** 触发前台等待解除（子代理转后台继续运行，主 Bot 立即接管响应） */
  triggerHandoff(): void;
  /** 本回合是否已触发过接管 */
  wasTriggered(): boolean;
  /** 当回栈解绑，返回是否曾被触发 */
  settle(): boolean;
}

let activeHandoffScope: SubagentHandoffScope | undefined;

function getActiveSubagentHandoffScope(): SubagentHandoffScope | undefined {
  return activeHandoffScope;
}

/** 开始一个主回合的接管作用域（runtime.runBotTurn 在 session 建立前后调用均可） */
export function beginSubagentHandoffScope(): SubagentHandoffScope {
  const previous = activeHandoffScope;
  if (previous) previous.settle();
  let triggered = false;
  activeHandoffScope = {
    triggerHandoff() {
      triggered = true;
    },
    wasTriggered: () => triggered,
    settle() {
      const was = triggered;
      triggered = false;
      if (activeHandoffScope === this) activeHandoffScope = undefined;
      return was;
    },
  };
  return activeHandoffScope;
}

/** 结束接管作用域（finally 路径统一调用，防止残留到下一回合） */
export function endSubagentHandoffScope(scope: SubagentHandoffScope | undefined): void {
  if (scope) scope.settle();
  else activeHandoffScope = undefined;
}

/** 供 runtime 导出给 daemon 的 steerBotTurn 使用：触发当前主回合的前台子代理转后台 */
export function triggerActiveSubagentHandoff(): boolean {
  const scope = activeHandoffScope;
  if (!scope) return false;
  scope.triggerHandoff();
  return true;
}

/**
 * 包装 Agent 工具 execute：主 Bot 前台等待子代理时，若用户在主会话发新消息
 * （steerBotTurn → triggerActiveSubagentHandoff），等待立即解除，返回提示文本让主 Bot
 * 接管新消息并用 stop_subagent / steer_subagent / get_subagent_result 控制子代理。
 *
 * 实现方式：先以 run_in_background: true 调原 Agent.execute 拿到 agentId，
 * 再立即用扩展注册的 get_subagent_result（wait: true）等待。waitSignal 被接管触发时，
 * get_subagent_result 只退出等待、子代理继续后台运行且保留完成通知；父级会话取消信号
 * （用户点了整个会话的停止）则额外停掉该子代理。
 */
function wrapAgentToolForHandoff(tool: any, handoffScope: SubagentHandoffScope): any {
  const originalExecute = tool.execute?.bind(tool);
  if (typeof originalExecute !== 'function') return tool;

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

  const wrappedExecute = async (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: any,
  ) => {
    const wantsForeground = params?.run_in_background === false || params?.run_in_background === undefined;
    // 仅拦截“新前台调用且非 resume”：resume / 后台 / 定时调用走原路径
    if (!wantsForeground || params?.resume || params?.schedule) {
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
    }

    // 已被接管（用户已发新消息）：这次调用直接按后台跑，不再阻塞
    if (handoffScope.wasTriggered()) {
      return originalExecute(toolCallId, { ...params, run_in_background: true }, signal, onUpdate, ctx);
    }

    const getResultTool = findTool(ctx, 'get_subagent_result');
    if (!getResultTool) {
      // 找不到等待工具（扩展未激活）：退回原生行为
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
    }

    // 以后台方式启动子代理，拿到 agentId
    const bgResult = await originalExecute(toolCallId, { ...params, run_in_background: true }, signal, onUpdate, ctx);
    const agentId = String((bgResult as any)?.details?.agentId || '').trim();
    if (!agentId) {
      // 启动失败（未知类型等）：原样返回错误/结果
      return bgResult;
    }

    // 组合信号：父级取消（整会话停止）或用户接管（主会话新消息）
    const combo = new AbortController();
    const onParentAbort = () => {
      // 用户点了整个会话的停止：同时停掉该子代理
      const manager = getGlobalSubagentManager();
      manager?.abort?.(agentId);
      combo.abort();
    };
    const onHandoff = () => {
      handedOff = true;
      combo.abort();
    };
    if (signal?.aborted) {
      onParentAbort();
    } else {
      signal?.addEventListener('abort', onParentAbort, { once: true });
    }

    let handedOff = false;
    const handoffPoll = setInterval(onHandoff, 80);
    const cleanupListeners = () => {
      clearInterval(handoffPoll);
      signal?.removeEventListener?.('abort', onParentAbort);
    };

    try {
      // get_subagent_result(wait: true)：正常跑完会自动标记 resultConsumed 并取消完成通知，
      // 向主 Bot 返回完整结果；信号被取消时仅退出等待，子代理在后台继续运行。
      const waitResult = await getResultTool.execute(
        `wait_${toolCallId}`,
        { agent_id: agentId, wait: true },
        combo.signal,
        undefined,
        ctx,
      );
      if (handedOff) {
        return makeTextResult(
          `Agent "${agentId}" (${params.subagent_type}) has been moved to the background because the user sent a new message in the session. It is STILL RUNNING. Read the user's new message and use stop_subagent, steer_subagent, or get_subagent_result with agent_id "${agentId}" as needed.`
        );
      }
      return waitResult;
    } finally {
      cleanupListeners();
    }
  };

  return { ...tool, execute: wrappedExecute };
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
  options?: { enableSubagents?: boolean },
): Promise<DefaultResourceLoader> {
  const botDir = getBotDir(dataDir, bot.id);
  const workspaceDir = path.join(botDir, 'workspace');
  const promptsDir = path.join(botDir, 'prompts');
  const skillPaths = (bot.enabledSkills ?? []).map(id => {
    assertSafeId(id, 'Skill ID');
    return path.join(dataDir, 'skills', id);
  });
  // 主 BOT 挂载 pi-subagents 底座（Agent / SubagentWorkflow 编排工具 + 子代理调度）；
  // 子代理不挂载（防套娃：子代理不能再派子代理），扩展内部另有 inChildSessionContext 防重入双保险。
  let extensionFactories: ExtensionFactory[] = [];
  if (options?.enableSubagents && !bot.parentBotId) {
    await ensureDir(path.join(botDir, 'agents'));
    await writeAtomicFile(
      path.join(botDir, 'subagents.json'),
      JSON.stringify(
        {
          disableDefaultAgents: true,
          disableDefaults: true,
          fallbackSubagent: 'none',
          backgroundByDefault: false,
          packageAgents: false,
          // async：完成通知逐个即时投递，避免 group 批次延迟到回合尾才可见，
          // 供主会话运行中新消息接管时能拿到实时结果。
          defaultJoinMode: 'async',
        },
        null,
        2
      )
    );

    const wrappedSubagentsFactory: ExtensionFactory = async (pi) => {
      process.env.PI_CODING_AGENT_DIR = botDir;
      setDefaultsDisabled(true);
      setFallbackSubagent(NO_FALLBACK);

      // 拦截 pi.registerTool：包一层 Agent 工具包装器（Auto-background on User Message）。
      // 主 Bot 前台等待子代理时，若用户在主会话发送新消息，steerBotTurn 会触发该回合的
      // handoffController，此时等待立即解除、子代理转后台继续运行，主 Bot 马上接管响应。
      const realRegisterTool = pi.registerTool.bind(pi);
      const handoffScope = getActiveSubagentHandoffScope();
      const wrappedRegisterTool: typeof pi.registerTool = ((tool: any) => {
        if (tool?.name !== 'Agent') {
          return realRegisterTool(tool);
        }
        const wrappedTool = handoffScope ? wrapAgentToolForHandoff(tool, handoffScope) : tool;
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
      setDefaultsDisabled(true);
      setFallbackSubagent(NO_FALLBACK);
      registerAgents(loadCustomAgents(botDir));

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
        process.env.PI_CODING_AGENT_DIR = botDir;
        setDefaultsDisabled(true);
        setFallbackSubagent(NO_FALLBACK);
        registerAgents(loadCustomAgents(botDir));
      });
      pi.on('before_agent_start', () => {
        process.env.PI_CODING_AGENT_DIR = botDir;
        setDefaultsDisabled(true);
        setFallbackSubagent(NO_FALLBACK);
        registerAgents(loadCustomAgents(botDir));
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
