import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { BotConfig, SessionRecord } from '../packages/protocol/src/index.js';
import { startHub } from '../apps/hub/src/index.js';
import { HubClient } from '../apps/node/src/cli/hub-client.js';
import { loadBotResources } from '../apps/node/src/commands.js';
import { loadTurnDeps } from '../apps/node/src/runtime/turn-deps.js';

const PASSWORD = '{{SECRET_wf4k2m9z}}';

const waitFor = async (predicate: () => boolean, timeout = 10_000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for condition');
};

interface TurnInput {
  sessionId: string;
  botId: string;
  incrementalMessages: string;
}

interface TestEnv {
  hub: Awaited<ReturnType<typeof startHub>>;
  dir: string;
  hubUrl: string;
  adminUser: { id: string; username: string };
  /** 每个 botId 的回合执行计数（live 调用次数） */
  turnCounts: Map<string, number>;
  /** botId -> 最新一次收到的 prompt（用于校验 schema 注入与上游结果传递） */
  lastPrompts: Map<string, string>;
  /** botId -> 回复文本（每次 runTurn 动态读取，支持“修复后成功”；函数可为 async 以模拟耗时） */
  replies: Map<string, string | ((input: TurnInput, call: number) => string | Promise<string>)>;
}

/**
 * 启动真实 HTTP Hub（端口 0，绝不占用 3000）并预写 cli.json 凭据，
 * 使被测代码内部的 HubClient.connect({ dataDir }) 无需再次登录即可访问 Hub。
 */
async function createTestEnv(t: TestContext): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-xbot-workflow-'));
  const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'hub.sqlite'), adminPassword: PASSWORD });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const hubUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const adminUser = hub.db.getUserWithHash('admin')!;
  hub.db.createNode({
    id: 'node_wf',
    name: 'Workflow Node',
    platform: 'linux',
    tokenHash: '{{SECRET_kz3p8wqn}}',
    ownerId: adminUser.id,
  });
  for (const botId of ['bot_lead', 'bot_builder', 'bot_tester_linux', 'bot_tester_mac', 'bot_step1', 'bot_step2', 'bot_slow']) {
    hub.db.saveBot({
      id: botId,
      nodeId: 'node_wf',
      name: botId,
      description: '',
      modelProvider: 'openai',
      modelId: 'gpt-4o',
      thinkingLevel: 'medium',
      enabledSkills: [],
      enabledExtensions: [],
      updatedAt: new Date().toISOString(),
    });
  }

  const turnCounts = new Map<string, number>();
  const lastPrompts = new Map<string, string>();
  const replies = new Map<string, string | ((input: TurnInput, call: number) => string | Promise<string>)>();

  (hub.connections as any).getNodeRpc = () => ({
    runTurn: async (input: any) => {
      const call = (turnCounts.get(input.botId) ?? 0) + 1;
      turnCounts.set(input.botId, call);
      lastPrompts.set(input.botId, String(input.incrementalMessages || ''));
      const configured = replies.get(input.botId);
      const replyText =
        typeof configured === 'function'
          ? await configured(input as TurnInput, call)
          : configured ?? `ok:${input.botId}`;
      if (replyText.startsWith('__THROW__')) {
        throw new Error(replyText.slice('__THROW__'.length));
      }
      return { replyText, modelBadge: 'openai/gpt-4o' };
    },
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  await HubClient.establish(hubUrl, 'admin', PASSWORD, { dataDir: dir });
  return { hub, dir, hubUrl, adminUser: { id: adminUser.id, username: adminUser.username }, turnCounts, lastPrompts, replies };
}

const createParentSession = (env: TestEnv): SessionRecord =>
  env.hub.db.createSession({
    id: `sess_wf_${Math.random().toString(36).slice(2, 8)}`,
    title: '跨 BOT 工作流',
    mode: 'direct',
    leadBotId: 'bot_lead',
    memberBotIds: ['bot_lead'],
    ownerId: env.adminUser.id,
  });

interface WorkflowRunOutcome {
  text: string;
  details: {
    taskId: string;
    runId: string;
    scriptPath: string;
    status: string;
    value?: unknown;
    replayedCount: number;
    agentCount: number;
  };
  isError?: boolean;
}

/** 构建挂载了跨 BOT SubagentWorkflow 包装器的主 BOT ExtensionRunner 并返回 SubagentWorkflow 工具 */
async function buildWorkflowTool(
  env: TestEnv,
  sessionId: string,
): Promise<{ tool: any; ctx: any; workspaceDir: string; loader: unknown }> {
  const { piAgent } = await loadTurnDeps();
  const { SettingsManager, ExtensionRunner, SessionManager, ModelRegistry, ModelRuntime } = piAgent;

  const leadBot: BotConfig = {
    id: 'bot_lead',
    nodeId: 'node_wf',
    name: 'Lead',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  const loader = await loadBotResources(
    env.dir,
    leadBot,
    SettingsManager.inMemory({ compaction: { enabled: false } }),
    () => [],
    { enableSubagents: true, sessionId },
  );
  const { extensions, runtime } = loader.getExtensions();
  const models = await ModelRuntime.create({
    authPath: path.join(env.dir, '.agent', 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(extensions, runtime, env.dir, SessionManager.inMemory(env.dir), new ModelRegistry(models));
  const tool = runner.getToolDefinition('SubagentWorkflow');
  assert.ok(tool, 'SubagentWorkflow tool must be registered on the primary bot');
  const botDir = path.join(env.dir, 'bots', 'bot_lead');
  return { tool, ctx: runner.createToolContext('tc_wf', undefined), workspaceDir: path.join(botDir, 'workspace'), loader };
}

const runWorkflowTool = async (tool: any, ctx: any, params: Record<string, unknown>): Promise<WorkflowRunOutcome> => {
  const res: any = await tool.execute(`tc_wf_${Math.random().toString(36).slice(2, 6)}`, params, undefined, undefined, ctx);
  return {
    text: String(res.content?.[0]?.text ?? ''),
    details: (res.details ?? {}) as WorkflowRunOutcome['details'],
    isError: res.isError === true ? true : undefined,
  };
};

test('SubagentWorkflow: 多阶段跨 BOT 流水线（Build→并行 Test）完成并携带 phase/childSessionId 事件', { timeout: 90_000 }, async (t) => {
  const env = await createTestEnv(t);

  env.replies.set(
    'bot_builder',
    JSON.stringify({ version: '1.2.0', artifact: 'app.tar.gz' }),
  );
  env.replies.set('bot_tester_linux', 'linux: PASS (version 1.2.0)');
  env.replies.set('bot_tester_mac', 'mac: PASS (version 1.2.0)');

  const parent = createParentSession(env);
  const { tool, ctx, workspaceDir, loader } = await buildWorkflowTool(env, parent.id);

  const script = `
export const meta = { name: "cross-bot-release", description: "Build once, test on two platforms" }
phase("Build")
const build = await agent("produce the release artifact and report the version", {
  agentType: "@bot_builder",
  label: "build",
  schema: {
    type: "object",
    properties: { version: { type: "string" }, artifact: { type: "string" } },
    required: ["version", "artifact"],
  },
});
if (!build) throw new Error("build step failed");
const reports = await parallel([
  () => agent("test version " + build.version + " on linux", { agentType: "@bot_tester_linux", label: "test-linux", phase: "Test" }),
  () => agent("test version " + build.version + " on mac", { agentType: "@bot_tester_mac", label: "test-mac", phase: "Test" }),
]);
return { version: build.version, artifact: build.artifact, reports: reports.filter(Boolean) };
`.trim();

  const events = { started: [] as any[], completed: [] as any[], failed: [] as any[] };
  // 与被测工具同一条事件总线：loadBotResources 返回的 loader 持有 extensions 共享的 eventBus
  const bus = (loader as any).eventBus as
    | { on: (ch: string, fn: (d: unknown) => void) => () => void }
    | undefined;
  assert.ok(bus, 'resource loader must expose an eventBus');
  const unsubs = [
    bus.on('subagents:started', (d: unknown) => events.started.push(d as any)),
    bus.on('subagents:completed', (d: unknown) => events.completed.push(d as any)),
    bus.on('subagents:failed', (d: unknown) => events.failed.push(d as any)),
  ];
  t.after(() => unsubs.forEach((u) => u()));

  const out = await runWorkflowTool(tool, ctx, { script });

  assert.equal(out.details.status, 'completed', `workflow must complete: ${out.text}`);
  assert.equal(out.isError, undefined);
  assert.equal((out.details.value as any).version, '1.2.0');
  assert.equal((out.details.value as any).artifact, 'app.tar.gz');
  assert.deepEqual((out.details.value as any).reports, ['linux: PASS (version 1.2.0)', 'mac: PASS (version 1.2.0)']);
  assert.equal(out.details.agentCount, 3, 'build + two parallel tests');
  assert.equal(out.details.replayedCount, 0, 'fresh run replays nothing');
  assert.match(out.text, /Workflow "cross-bot-release" completed \(runId: wf_[a-z0-9]+\)/);
  assert.match(out.text, /Result: /);

  // 每个目标 bot 恰好被 live 调用一次
  assert.equal(env.turnCounts.get('bot_builder'), 1);
  assert.equal(env.turnCounts.get('bot_tester_linux'), 1);
  assert.equal(env.turnCounts.get('bot_tester_mac'), 1);

  // schema 注入了结构化输出要求；Stage2 拿到了 Stage1 的 version
  assert.ok(env.lastPrompts.get('bot_builder')!.includes('[Structured Output Requirement]'));
  assert.ok(env.lastPrompts.get('bot_tester_linux')!.includes('1.2.0'));
  assert.ok(env.lastPrompts.get('bot_tester_mac')!.includes('1.2.0'));

  // 生命周期事件：3 started + 3 completed，携带 phase 与 childSessionId（跨 BOT 分支）
  assert.equal(events.started.length, 3, `started events: ${JSON.stringify(events.started)}`);
  assert.equal(events.completed.length, 3, `completed events: ${JSON.stringify(events.completed)}`);
  assert.equal(events.failed.length, 0);
  const startedTypes = events.started.map((e) => e.type).sort();
  assert.deepEqual(startedTypes, ['bot_builder', 'bot_tester_linux', 'bot_tester_mac']);
  for (const e of events.started) {
    assert.ok(e.childSessionId, 'cross-bot step started events must carry childSessionId');
    assert.ok(e.phase === 'Build' || e.phase === 'Test', `phase must be carried: ${JSON.stringify(e)}`);
  }
  const buildDone = events.completed.find((e) => e.type === 'bot_builder');
  assert.ok(buildDone, 'build completed event exists');
  assert.equal(buildDone.phase, 'Build');
  assert.equal(buildDone.status, 'completed');
  assert.ok(buildDone.childSessionId);
  assert.ok(buildDone.result.includes('1.2.0'));
  assert.equal(buildDone.durationMs !== undefined && typeof buildDone.durationMs === 'number', true);

  // 脚本副本与 journal 落盘在 <workspace>/.workflows/
  const workflowsDir = path.join(workspaceDir, '.workflows');
  assert.ok(existsSync(path.join(workflowsDir, `${out.details.runId}.mjs`)), 'script copy persisted');
  const journalFile = path.join(workflowsDir, `${out.details.runId}.workflow.jsonl`);
  assert.ok(existsSync(journalFile), 'journal persisted');
  const journalLines = (await readFile(journalFile, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(journalLines.length, 3, 'one journal entry per settled step');
  for (const line of journalLines) {
    const entry = JSON.parse(line);
    assert.equal(entry.ok, true);
  }

  // 子会话均挂在父会话之下
  const subs = await (await HubClient.connect({ dataDir: env.dir })).get<SessionRecord[]>(
    `/api/sessions/${encodeURIComponent(parent.id)}/subsessions`,
  );
  assert.equal(subs.length, 3);
});

test('SubagentWorkflow: 断点续跑 resumeFromRunId 只重放已完成步骤，失败步骤修复后 live 重跑', { timeout: 120_000 }, async (t) => {
  const env = await createTestEnv(t);

  const parent = createParentSession(env);
  const { tool, ctx, workspaceDir } = await buildWorkflowTool(env, parent.id);

  const script = `
export const meta = { name: "two-stage-retry", description: "Stage 1 succeeds, stage 2 fails then gets fixed" }
phase("Prepare")
const first = await agent("prepare the artifact", { agentType: "@bot_step1", label: "step1" });
if (!first) throw new Error("step1 failed");
phase("Finish")
const second = await agent("finish using " + first, { agentType: "@bot_step2", label: "step2" });
if (!second) throw new Error("step2 failed");
return { first, second };
`.trim();

  // 第一次运行：step1 成功，step2 失败
  env.replies.set('bot_step1', 'artifact-ready-42');
  env.replies.set('bot_step2', '__THROW__模拟 step2 执行崩溃');

  const firstRun = await runWorkflowTool(tool, ctx, { script });
  assert.equal(firstRun.details.status, 'failed', `first run must fail: ${firstRun.text}`);
  assert.equal(firstRun.isError, true);
  assert.ok(firstRun.details.runId.startsWith('wf_'), 'failed run reports runId');
  assert.ok(firstRun.details.scriptPath.endsWith('.mjs'), 'failed run reports scriptPath');
  assert.ok(existsSync(path.join(workspaceDir, '.workflows', `${firstRun.details.runId}.workflow.jsonl`)), 'journal written despite failure');
  assert.match(firstRun.text, /resumeFromRunId: "wf_[a-z0-9]+"/);
  assert.equal(env.turnCounts.get('bot_step1'), 1);
  assert.equal(env.turnCounts.get('bot_step2'), 1);

  // 修复 step2 并断点续跑：step1 从 journal 缓存回放（不再调用），step2 live 成功
  env.replies.set('bot_step2', 'finished-using-artifact-ready-42');
  const secondRun = await runWorkflowTool(tool, ctx, {
    scriptPath: firstRun.details.scriptPath,
    resumeFromRunId: firstRun.details.runId,
  });

  assert.equal(secondRun.details.status, 'completed', `resume run must complete: ${secondRun.text}`);
  assert.equal(secondRun.isError, undefined);
  assert.equal(secondRun.details.replayedCount, 1, 'exactly one step replayed from journal cache');
  assert.equal(secondRun.details.agentCount, 2);
  assert.deepEqual((secondRun.details.value as any), {
    first: 'artifact-ready-42',
    second: 'finished-using-artifact-ready-42',
  });
  assert.match(secondRun.text, /Replayed from wf_[a-z0-9]+: 1\/2 step\(s\) from journal cache\./);

  // 关键断言：bot_step1 两次运行合计只被调用一次（100% 缓存命中）；bot_step2 被调了两次（失败一次 + 重跑一次）
  assert.equal(env.turnCounts.get('bot_step1'), 1, 'bot_step1 must NOT be re-called on resume');
  assert.equal(env.turnCounts.get('bot_step2'), 2, 'bot_step2 must re-run live after the fix');
  assert.ok(env.lastPrompts.get('bot_step2')!.includes('artifact-ready-42'), 'step2 re-run receives step1 replayed output');

  // 第二次运行的 journal 完整独立（replay 被重新记录，供 resume-of-resume）
  const journal2 = path.join(workspaceDir, '.workflows', `${secondRun.details.runId}.workflow.jsonl`);
  assert.ok(existsSync(journal2));
  const entries2 = (await readFile(journal2, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(entries2.length, 2);
  assert.ok(entries2.every((e: any) => e.ok === true));
});

test('SubagentWorkflow: resumeFromRunId 指向不存在的 run 时返回明确错误', { timeout: 30_000 }, async (t) => {
  const env = await createTestEnv(t);
  const parent = createParentSession(env);
  const { tool, ctx } = await buildWorkflowTool(env, parent.id);

  const out = await runWorkflowTool(tool, ctx, { resumeFromRunId: 'wf_doesnotexist99' });
  assert.equal(out.isError, true);
  assert.match(out.text, /Cannot resume workflow "wf_doesnotexist99": run journal not found in/);
});

test('SubagentWorkflow: 跨 Bot 步骤 resume 能在同一 childSessionId 子会话中继续追问并拿到回复', { timeout: 90_000 }, async (t) => {
  const env = await createTestEnv(t);

  // bot_step1: 第一次收到任务返回初始结果，第二次（resume）收到跟进 prompt 返回追问结果
  env.replies.set('bot_step1', (input, call) => {
    if (call === 1) return 'initial-analysis-done';
    return `followup-analysis-done: received "${input.incrementalMessages}"`;
  });

  const parent = createParentSession(env);
  const { tool, ctx, loader } = await buildWorkflowTool(env, parent.id);

  const script = `
export const meta = { name: "cross-bot-resume", description: "Test resuming a cross-bot step" }
phase("Analysis")
const initial = await agent("please run initial analysis", {
  agentType: "@bot_step1",
  label: "step1",
});
if (!initial) throw new Error("step1 failed");
phase("Refinement")
const refined = await agent("refine with additional depth", {
  resume: "step1",
});
return { initial, refined };
`.trim();

  const events = { started: [] as any[], completed: [] as any[], failed: [] as any[] };
  const bus = (loader as any).eventBus as
    | { on: (ch: string, fn: (d: unknown) => void) => () => void }
    | undefined;
  assert.ok(bus, 'resource loader must expose an eventBus');
  const unsubs = [
    bus.on('subagents:started', (d: unknown) => events.started.push(d as any)),
    bus.on('subagents:completed', (d: unknown) => events.completed.push(d as any)),
    bus.on('subagents:failed', (d: unknown) => events.failed.push(d as any)),
  ];
  t.after(() => unsubs.forEach((u) => u()));

  const out = await runWorkflowTool(tool, ctx, { script });

  assert.equal(out.details.status, 'completed', `workflow must complete: ${out.text}`);
  assert.equal(out.isError, undefined);
  assert.equal((out.details.value as any).initial, 'initial-analysis-done');
  assert.ok(
    String((out.details.value as any).refined).includes('followup-analysis-done'),
    `refined result: ${(out.details.value as any).refined}`,
  );

  // bot_step1 经历了两次 live 调用
  assert.equal(env.turnCounts.get('bot_step1'), 2);

  // 两次 started 与两次 completed
  assert.equal(events.started.length, 2);
  assert.equal(events.completed.length, 2);
  assert.equal(events.failed.length, 0);

  // 关键：两个步骤携带的 childSessionId 必须完全相同（在同一子会话中续跑）
  const initialChildSessionId = events.started[0].childSessionId;
  assert.ok(initialChildSessionId, 'initial step must have childSessionId');
  assert.equal(
    events.started[1].childSessionId,
    initialChildSessionId,
    'resumed step must reuse the same childSessionId',
  );
  assert.equal(events.completed[0].childSessionId, initialChildSessionId);
  assert.equal(events.completed[1].childSessionId, initialChildSessionId);

  // 子会话总数只有 1 个（没有为 resume 派生新的子会话）
  const subs = await (await HubClient.connect({ dataDir: env.dir })).get<SessionRecord[]>(
    `/api/sessions/${encodeURIComponent(parent.id)}/subsessions`,
  );
  assert.equal(subs.length, 1);
});

test('SubagentWorkflow: 跨 Bot 步骤等待超时返回 timed_out 结果，断点续跑幂等重连同一子会话不重复创建', { timeout: 120_000 }, async (t) => {
  const env = await createTestEnv(t);

  // bot_slow 每次真实耗时 1500ms（超过第一次运行的 1s 等待超时）
  env.replies.set('bot_slow', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    return 'slow-bot-finally-done';
  });

  const parent = createParentSession(env);
  const { tool, ctx, workspaceDir, loader } = await buildWorkflowTool(env, parent.id);

  const script = `
export const meta = { name: "cross-bot-timeout-resume", description: "Slow step times out then resume re-attaches" }
phase("Slow")
const res = await agent("do the slow work", { agentType: "@bot_slow", label: "slow-step" });
if (!res) throw new Error("slow step failed");
return { res };
`.trim();

  // 监听子代理事件：超时步骤的 failed 事件必须携带超时说明与子会话 ID
  const failedEvents: any[] = [];
  const bus = (loader as any).eventBus as
    | { on: (ch: string, fn: (d: unknown) => void) => () => void }
    | undefined;
  assert.ok(bus, 'resource loader must expose an eventBus');
  const unsubFailed = bus.on('subagents:failed', (d: unknown) => failedEvents.push(d as any));
  t.after(() => unsubFailed());

  // 第一次运行：1 秒等待超时，工作流 failed，超时说明携带子会话 ID
  const run1 = await runWorkflowTool(tool, ctx, { script, timeout_seconds: 1 });
  assert.equal(run1.details.status, 'failed', `first run must fail on timeout: ${run1.text}`);
  assert.equal(run1.isError, true);
  assert.ok(existsSync(path.join(workspaceDir, '.workflows', `${run1.details.runId}.sessions.json`)), 'sessions map persisted for timed-out step');
  const timeoutFailed = failedEvents.find((e) => e.type === 'bot_slow');
  assert.ok(timeoutFailed, `timed-out step must emit subagents:failed: ${JSON.stringify(failedEvents)}`);
  assert.match(timeoutFailed.error, /timed out after 1s while still running/);
  assert.ok(timeoutFailed.childSessionId, 'failed event must carry childSessionId');
  const timedOutChildSessionId = timeoutFailed.childSessionId;
  // 关键：bot_slow 只被触发了一次（超时未取消子会话，仍在后台继续跑）
  assert.equal(env.turnCounts.get('bot_slow'), 1, 'bot_slow must be triggered exactly once in the first run');

  // 等待后台子会话真正跑完（或接近跑完），再断点续跑
  await new Promise((r) => setTimeout(r, 1200));

  const run2 = await runWorkflowTool(tool, ctx, {
    scriptPath: run1.details.scriptPath,
    resumeFromRunId: run1.details.runId,
    timeout_seconds: 5,
  });

  assert.equal(run2.details.status, 'completed', `resume run must complete: ${run2.text}`);
  assert.equal(run2.isError, undefined);
  assert.deepEqual((run2.details.value as any), { res: 'slow-bot-finally-done' });

  // 幂等重连：bot_slow 依然只被调用 1 次，没有为续跑创建第二个子会话
  assert.equal(env.turnCounts.get('bot_slow'), 1, 'resume must NOT re-trigger bot_slow');
  const subs2 = await (await HubClient.connect({ dataDir: env.dir })).get<SessionRecord[]>(
    `/api/sessions/${encodeURIComponent(parent.id)}/subsessions`,
  );
  assert.equal(subs2.length, 1, 'no duplicate child session after resume');
  assert.equal(subs2[0].id, timedOutChildSessionId, 'resumed step re-attached the same child session');

  // 续跑运行的映射文件也落盘（支持 resume-of-resume）
  assert.ok(existsSync(path.join(workspaceDir, '.workflows', `${run2.details.runId}.sessions.json`)));
});
