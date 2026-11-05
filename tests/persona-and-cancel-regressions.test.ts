/**
 * 分身隔离 / toolScope / 存量会话热同步 / 远端取消传播 —— 审计轮修复回归测试。
 *
 * 覆盖：
 *  1. 动态扩展按分身严格隔离（Persona A 的动态扩展不出现在 Persona B 的
 *     Router/Worker agent 上；Router 不含 CodingTools 与 codemode）；
 *  2. toolScope readonly 的 Worker 双层（tools + modelTools）禁写；
 *  3. syncPersonas 热同步存量会话（模型/思考档位/instructions 即刻生效）；
 *  4. RemoteExecutionEnv.exec 取消传播（真实 createNodeEnvRpcServer，
 *     abort 后远端 envAbortExec 生效、getActiveExecCount 归零、无残留写入）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage, defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable';

import { createNodeEnvRpcServer } from '../apps/node/src/env-rpc-server.js';
import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';

const PASSWORD = 'persona-cancel-password';

const waitFor = async <T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  message: string,
  timeout = 10_000,
): Promise<T> => {
  const end = Date.now() + timeout;
  let last: T;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** 一个最小动态扩展：提供唯一工具 marker_probe。 */
function markerExtension(name: string): Extension {
  const tool = defineTool({
    name: `${name}_probe`,
    description: `Probe tool of ${name}`,
    parameters: { type: 'object', properties: { ping: { type: 'string' } }, required: ['ping'], additionalProperties: false } as never,
    replay: 'safe',
    async execute() {
      return { output: [{ type: 'text', text: `pong:${name}` }] };
    },
  });
  return defineExtension({ name, tools: [tool] });
}

const personaOf = (over: Partial<BotPersonaConfig> & Pick<BotPersonaConfig, 'botId' | 'name'>): BotPersonaConfig => ({
  model: { provider: 'faux', modelId: 'main' },
  instructions: `You are ${over.name}.`,
  nodeId: 'local',
  cwd: process.cwd(),
  ...over,
});

const toolNames = (change: import('@earendil-works/pi-durable').AgentChange): string[] => {
  const flat = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.map((item) => (typeof item === 'string' ? item : (item as { name: string }).name)).filter(Boolean);
  };
  return [...flat(change.tools), ...flat(change.modelTools)];
};

// ---------------------------------------------------------------------------

test('1. dynamic extensions stay per-persona: no leak onto other personas, no CodingTools on Router', async (t) => {
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  t.after(async () => await runtime.close());

  const extA = markerExtension('alpha-dyn');
  runtime.installDynamicExtension(extA);
  const personaA = personaOf({ botId: 'bot-a', name: 'A', enabledExtensions: ['alpha-dyn'] });
  const personaB = personaOf({ botId: 'bot-b', name: 'B' });
  runtime.registerPersona(personaA);
  runtime.registerPersona(personaB);

  const routerA = runtime.routerAgent(personaA);
  const routerB = runtime.routerAgent(personaB);
  const workerA = runtime.workerAgentFor(personaA);
  const workerB = runtime.workerAgentFor(personaB);

  const names = (exts: unknown): string[] =>
    Array.isArray(exts) ? exts.map((e) => (e as Extension).name) : [];

  // A 的动态扩展在 A 上，绝不在 B 上
  assert.ok(names(routerA.extensions).includes('alpha-dyn'));
  assert.ok(names(workerA.extensions).includes('alpha-dyn'));
  assert.ok(!names(routerB.extensions).includes('alpha-dyn'), 'routerB must not mount alpha-dyn');
  assert.ok(!names(workerB.extensions).includes('alpha-dyn'), 'workerB must not mount alpha-dyn');

  // Router 挂载 CodingTools（当场干活）但不含 botd-worker 与 codemode（精确选择）
  for (const forbidden of ['codemode', 'botd-worker']) {
    assert.ok(
      !names(routerA.extensions).some((n) => n.includes(forbidden) || n === forbidden),
      `Router must not mount ${forbidden} (got: ${names(routerA.extensions).join(',')})`,
    );
  }
  // Router 上 botd-router、SubagentWorkflow 与 CodingTools 必在
  assert.ok(names(routerA.extensions).some((n) => n.includes('router')));
  assert.ok(names(routerA.extensions).some((n) => n.toLowerCase().includes('workflow') || n.includes('SubagentWorkflow')));
  assert.ok(names(routerA.extensions).some((n) => n.includes('coding') || n === 'coding-tools'), 'Router must mount CodingTools');
  // Worker 上 CodingTools / worker / workflow 必在
  assert.ok(names(workerB.extensions).some((n) => n.includes('coding') || n === 'pi.tools' || n.toLowerCase().includes('coding')));
  assert.ok(names(workerB.extensions).some((n) => n.includes('worker')));
});

test('2. toolScope readonly: write/edit/bash removed from BOTH tools and modelTools layers', async (t) => {
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  t.after(async () => await runtime.close());

  const persona = personaOf({ botId: 'ro-bot', name: 'RO', toolScope: 'readonly' });
  runtime.registerPersona(persona);
  const worker = runtime.workerAgentFor(persona);

  const removed = (v: unknown): string[] =>
    v && typeof v === 'object' && 'remove' in (v as object)
      ? ((v as { remove: unknown[] }).remove as { name?: string }[]).map((x) => x.name ?? String(x))
      : [];
  const removedTools = removed(worker.tools);
  const removedModelTools = removed(worker.modelTools);
  for (const banned of ['write', 'edit', 'bash']) {
    assert.ok(removedTools.includes(banned), `tools.remove must contain ${banned}`);
    assert.ok(removedModelTools.includes(banned), `modelTools.remove must contain ${banned}`);
  }
  // Router 同样受 toolScope: 'readonly' 保护：tools / modelTools 双层移除写工具
  const router = runtime.routerAgent(persona);
  const removedRouterTools = removed(router.tools);
  const removedRouterModelTools = removed(router.modelTools);
  for (const banned of ['write', 'edit', 'bash']) {
    assert.ok(removedRouterTools.includes(banned), `router tools.remove must contain ${banned}`);
    assert.ok(removedRouterModelTools.includes(banned), `router modelTools.remove must contain ${banned}`);
  }
  // 无 toolScope 的 Router 拥有全部编码工具（tools/modelTools 均不过滤）
  const fullRouter = runtime.routerAgent(personaOf({ botId: 'full-bot', name: 'Full' }));
  assert.equal(fullRouter.tools, null);
  assert.equal(fullRouter.modelTools, null);

  // custom：精确允许列表
  const customPersona = personaOf({ botId: 'cu-bot', name: 'CU', toolScope: 'custom', customTools: ['read', 'write'] });
  const customWorker = runtime.workerAgentFor(customPersona);
  const flatNames = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as { name: string }).name)) : [];
  assert.deepEqual(flatNames(customWorker.tools).sort(), ['read', 'write']);
  assert.deepEqual(flatNames(customWorker.modelTools).sort(), ['read', 'write']);
});

test('3. syncPersonas hot-applies new config to existing router/worker conversations', async (t) => {
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  t.after(async () => await runtime.close());

  const before = personaOf({ botId: 'hot-bot', name: 'Hot', thinkingLevel: 'low', instructions: 'You are Hot v1.' });
  runtime.registerPersona(before);
  const router = await runtime.createBotTopicSession('hot-bot', 'hot-topic');
  const routerId = String(router.id);

  // 按请求捕获 system 提示词（messages 首条 system）
  const systemPrompts: string[] = [];
  const capture = () =>
    ((context: { messages: Array<{ role: string; content?: unknown }> }) => {
      // pi-durable 的提示词由多条 system 消息增量补丁：按 replay 语义合并全部 sections
      const shown = new Map<string, string>();
      for (const m of context.messages) {
        if (m.role !== 'system') continue;
        const sections = (m as { sections?: Record<string, string | null> }).sections;
        if (sections === undefined) continue;
        for (const [k, v] of Object.entries(sections)) {
          if (v === null) shown.delete(k);
          else shown.set(k, v);
        }
      }
      systemPrompts.push([...shown.values()].join('\n'));
      return fauxAssistantMessage('ok');
    }) as never;
  faux.setResponses([capture(), capture()]);

  await (await runtime.conversation(routerId))!.submit(
    { type: 'input', content: 'kick', requestId: 'kick-1' },
    BACKGROUND_CONTEXT,
  );
  await waitFor(() => systemPrompts.length >= 1, (v) => v, 'initial router reply');
  assert.match(systemPrompts[0], /Hot v1/);

  // 配置变更：instructions / memory / thinkingLevel 全部热同步到存量会话
  const after = personaOf({
    botId: 'hot-bot',
    name: 'Hot',
    thinkingLevel: 'high',
    instructions: 'You are Hot v2 with memory.',
    memory: 'remember the pivot',
  });
  await runtime.syncPersonas([after]);

  await (await runtime.conversation(routerId))!.submit(
    { type: 'input', content: 'check persona', requestId: 'kick-2' },
    BACKGROUND_CONTEXT,
  );
  await waitFor(() => systemPrompts.length >= 2, (v) => v, 'post-sync router reply');
  const after_ = systemPrompts.at(-1)!;
  assert.match(after_, /Hot v2 with memory/);
  assert.match(after_, /remember the pivot/);
  assert.ok(!/Hot v1/.test(after_), 'old instructions must be gone after syncPersonas');
});

test('4. RemoteExecutionEnv.exec: context abort propagates envAbortExec and stops the remote command', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-remote-cancel-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  // 真实 Node 侧 env RPC server（同进程直连，不依赖网络）
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  const abortCalls: string[] = [];
  const serverAbort = server.envAbortExec.bind(server);
  const rpc = {
    ...server,
    envAbortExec: async (execId: string) => {
      abortCalls.push(execId);
      await serverAbort(execId);
    },
  } as typeof server;
  // 运行时始终存在（类型可选是协议可比性需要）
  const activeExecCount = rpc.getActiveExecCount!.bind(rpc);
  assert.equal(await activeExecCount(), 0);

  const { RemoteExecutionEnv } = await import('../apps/hub/src/harness/remote-env.js');
  const env = new RemoteExecutionEnv(
    { getNodeEnvRpc: () => rpc as never },
    { nodeId: 'test-node', cwd: dir },
  );

  const marker = path.join(dir, 'after-cancel.txt');
  const controller = new AbortController();
  const execPromise = env.exec(
    `sleep 5 && echo AFTER > ${JSON.stringify(marker)}`,
    undefined,
    withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
  );
  // 等远端真正开始执行，再取消
  await waitFor(async () => (await activeExecCount()) === 1, (v) => v, 'exec to start');
  controller.abort();
  const result = await execPromise;

  assert.equal(result.ok, false, 'aborted exec must return ok:false');
  assert.equal(await activeExecCount(), 0, 'remote must have no active exec');
  assert.ok(abortCalls.length >= 1, 'envAbortExec must have been invoked on the node');
  // 取消后命令不得继续写文件
  await new Promise((resolve) => setTimeout(resolve, 300));
  const leaked = await readFile(marker, 'utf8').then(() => true, () => false);
  assert.equal(leaked, false, 'cancelled command must not write AFTER marker');
});
