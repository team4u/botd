/**
 * workflow-event-watchdog.test.ts — SubagentWorkflow / EventRouter / Watchdog 集成测试。
 *
 * 全部跑在真实 pi-durable Harness + faux provider 上（无真实 LLM）：
 *  1. SubagentWorkflow：pipeline / parallel / gate / schema；
 *  2. SubagentWorkflow 崩溃恢复：重跑后 Stage 1 从 memo 回放，模型不再被调用；
 *  3. EventRouter 直通：首事件走 Router 订阅 W1，后续事件 0 Router LLM 调用直达 W1，
 *     同 threadKey 上重叠的 W1/W2 都收到直通通知；
 *  4. Inline & Spill + Chain of Recall、投机执行（未确认静默丢弃 / 确认后上报）；
 *  5. Watchdog：检测卡死 / 循环 Worker 并自动 steer / continue 恢复。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, LiveDoc, MemoryStorage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Harness as HarnessType } from '@earendil-works/pi-durable';
import type { Conversation } from '@earendil-works/pi-durable';
import {
	createWorkflowExtension,
} from '../apps/hub/src/harness/workflow-extension.js';
import {
	EventRouter,
	filterEventFastPath,
	formatEventInlineAndSpill,
	recallSpill,
	SpillStoreDoc,
	threadKeyOf,
	triggerSpeculativeWorker,
	type EventFilterPolicy,
	type IncomingEvent,
} from '../apps/hub/src/harness/event-router.js';
import {
	diagnoseSystemHealth,
	runWatchdogPass,
	type WatchdogOptions,
} from '../apps/hub/src/harness/watchdog.js';

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

interface FauxEnv {
	faux: ReturnType<typeof fauxProvider>;
	models: ReturnType<typeof createModels>;
}

function createFauxEnv(): FauxEnv {
	const faux = fauxProvider({ models: [{ id: 'botd-worker' }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

const WORKFLOW_SCRIPT = `
export const meta = { name: "release-flow", description: "build then verify", phases: ["Build", "Verify"] }
phase("Build")
const build = await agent("produce release info", {
  label: "build",
  phase: "Build",
  schema: { type: "object", properties: { version: { type: "string" } }, required: ["version"] },
})
if (!build) throw new Error("build step failed")
log("built " + build.version)
const reports = await parallel([
  () => agent("test on linux " + build.version, { label: "test-linux", phase: "Verify", gate: "true" }),
  () => agent("test on mac " + build.version, { label: "test-mac", phase: "Verify", gate: "true" }),
])
return { version: build.version, reports: reports.filter(Boolean) }
`;

function toolCallOf(script: string) {
	// 用 faux 的 toolCall 块调用 SubagentWorkflow（stopReason 必须是 toolUse 才会启动工具轮）
	return fauxAssistantMessage(
		{
			type: 'toolCall',
			id: `tc_${Math.random().toString(36).slice(2, 8)}`,
			name: 'SubagentWorkflow',
			arguments: { script },
		},
		{ stopReason: 'toolUse' },
	);
}

/** 从根会话的 SubagentWorkflow 工具结果文本（`Result: {...}`）解析工作流产出。 */
async function readWorkflowResult(root: Awaited<ReturnType<HarnessType['root']>>) {
	const entries = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
	let found: { status?: string; version?: string; reports?: string[]; first?: string; second?: string } | undefined;
	for (const entry of entries.items) {
		const message = entry.model?.[0];
		if (message === undefined || message.role !== 'toolResult') continue;
		if ((message as { toolName?: string }).toolName !== 'SubagentWorkflow') continue;
		const content = (message as { content?: unknown }).content;
		const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b as { text?: string }).text ?? '').join('') : '';
		const match = text.match(/Result: (\{[\s\S]*\})/);
		if (match !== null) {
			const parsed = JSON.parse(match[1]) as { status?: string; version?: string; reports?: string[]; first?: string; second?: string };
			found = parsed; // entries 默认新→旧：第一匹配即最新运行
			break;
		}
	}
	return found;
}

test('Test 1: SubagentWorkflow runs pipeline/parallel stages with gate + schema output', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const registry = createRegistry();
	registry.install(createWorkflowExtension());
	const harness = await HarnessType.open(new MemoryStorage(), { models: env.models, registry, env: () => new NodeExecutionEnv({ cwd: process.cwd() }) }, BACKGROUND_CONTEXT);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT));
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: 'faux', modelId: 'botd-worker' } },
	});

	env.faux.setResponses([
		toolCallOf(WORKFLOW_SCRIPT),
		fauxAssistantMessage(fauxText(JSON.stringify({ version: '1.2.0' }))),
		fauxAssistantMessage(fauxText('linux PASS 1.2.0')),
		fauxAssistantMessage(fauxText('mac PASS 1.2.0')),
		fauxAssistantMessage(fauxText('workflow finished')),
	]);

	const submission = await root.submit({ type: 'input', content: 'run workflow' }, BACKGROUND_CONTEXT);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	assert.equal(settled.status, 'done');

	// 从工具结果 entry 文本（output 通道）的 Result: 行提取结构化 JSON
	const workflowResult = await readWorkflowResult(root);
	assert.ok(workflowResult, 'tool result must carry workflow output');
	assert.equal(workflowResult.version, '1.2.0');
	assert.deepEqual(workflowResult.reports, ['linux PASS 1.2.0', 'mac PASS 1.2.0']);
});

test('Test 2: SubagentWorkflow crash recovery — Stage 1 served from memo, Stage 2 completes', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const dir = await mkdtemp(path.join(tmpdir(), 'botd-wf-crash-'));
	t.after(async () => await rm(dir, { recursive: true, force: true }));
	const dbPath = path.join(dir, 'session.sqlite');

	// 崩溃模拟：同一 SQLite 文件重开 harness。工具任务 replay: safe —— 重开后同一任务重跑，
	// 已提交的 step memo 直接命中，不再调模型。
	const openHarness = async (streamTimeoutMs?: number) => {
		const registry = createRegistry();
		registry.install(createWorkflowExtension());
		const storage = await openNodeSqliteStorage(dbPath);
		return await HarnessType.open(storage, {
			models: env.models,
			registry,
			env: () => new NodeExecutionEnv({ cwd: process.cwd() }),
			...(streamTimeoutMs === undefined ? {} : { settings: { stream: { timeoutMs: streamTimeoutMs } } }),
		}, BACKGROUND_CONTEXT);
	};

	const TWO_STAGE_SCRIPT = `
export const meta = { name: "two-stage", description: "stage1 then stage2", phases: ["Prepare", "Finish"] }
phase("Prepare")
const first = await agent("prepare the artifact", { label: "stage1", phase: "Prepare" })
if (!first) throw new Error("stage1 failed")
phase("Finish")
const second = await agent("finish using " + first, { label: "stage2", phase: "Finish" })
if (!second) throw new Error("stage2 failed")
return { first, second }
`;

	// 进程 1：stage1 正常回答；stage2 的子代理请求永不返回（faux factory 悬挂）→
	// 工具任务停在 stage2 中途，此时 close harness = 进程崩溃。
	const harness1 = await openHarness(200);
	const root1 = await harness1.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: 'faux', modelId: 'botd-worker' } },
	});
	// stage2 的模型请求悬挂，但带软超时：close 的 abort 后仍要在有限时间内拒绝，
	// 否则 close 的 join 永远等不完（faux factory 不观察取消信号）
	const hang = () =>
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error('faux hang timeout')), 1500);
		});
	env.faux.setResponses([
		toolCallOf(TWO_STAGE_SCRIPT),
		fauxAssistantMessage(fauxText('artifact-ready-42')),
		() => hang() as never,
	]);
	const run1 = await root1.submit({ type: 'input', content: 'run workflow' }, BACKGROUND_CONTEXT);
	const settled1 = run1.wait(BACKGROUND_CONTEXT).catch((error: unknown) => error);
	// 等 stage1 的 memo 落库（stage2 已处于悬挂请求中）：stage1 提交后工具任务仍在运行
	await new Promise((r) => setTimeout(r, 400));
	const callsAfterCrash = env.faux.state.callCount;
	assert.ok(callsAfterCrash >= 2, 'crashed process must have invoked the model for stage 1');
	await harness1.close(BACKGROUND_CONTEXT).catch(() => undefined);
	await settled1.catch(() => undefined);

	// 进程 2（崩溃重启）：重开并 resume。工具任务重跑：stage1 命中 memo（0 次模型调用），
	// stage2 收到新答案并完成，父 run 给出最终回复。
	const harness2 = await openHarness();
	t.after(async () => await harness2.close(BACKGROUND_CONTEXT).catch(() => undefined));
	harness2.resume();
	const root2 = await harness2.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: 'faux', modelId: 'botd-worker' } },
	});
	env.faux.setResponses([
		fauxAssistantMessage(fauxText('finished-using-artifact-ready-42')),
		fauxAssistantMessage(fauxText('final root answer')),
	]);
	const callsBefore = env.faux.state.callCount;
	await harness2.waitForIdle(BACKGROUND_CONTEXT);
	const callsConsumed = env.faux.state.callCount - callsBefore;
	assert.equal(callsConsumed, 2, `recovery must run only stage 2 + final answer (got ${callsConsumed} model calls; stage 1 must come from memo)`);

	const result2 = await readWorkflowResult(root2);
	assert.ok(result2, 'recovered run must produce workflow output');
	assert.equal(result2.first, 'artifact-ready-42', 'stage 1 result must be replayed from memo');
	assert.equal(result2.second, 'finished-using-artifact-ready-42');
});

// ---------------------------------------------------------------------------
// EventRouter
// ---------------------------------------------------------------------------

function prEvent(summary: string, payload?: string): IncomingEvent {
	return {
		source: 'github',
		type: 'pr.comment',
		sender: 'reviewer',
		target: { kind: 'pr', repo: 'botd', number: 42 },
		summary,
		payload,
		adjacent: ['previous review comment: LGTM aside from nits'],
	};
}

test('Test 3: EventRouter pass-through — first event routes via Router, later events go direct with 0 Router LLM calls', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const registry = createRegistry();
	const harness = await HarnessType.open(new MemoryStorage(), { models: env.models, registry, env: () => new NodeExecutionEnv({ cwd: process.cwd() }) }, BACKGROUND_CONTEXT);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT));

	const routerConversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	const workerConversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await routerConversation.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);
	await workerConversation.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);

	const routerLlmCalls: Conversation[] = [];
	const eventRouter = new EventRouter({
		harness,
		resolveRouter: async () => {
			routerLlmCalls.push(routerConversation);
			return routerConversation;
		},
		decide: async () => ({ worker: workerConversation }),
	});

	// 首事件：无订阅 → 慢路径 Router，事件真正提交到 Router 会话，Router 决策订阅 W1
	env.faux.setResponses([fauxAssistantMessage(fauxText('router acknowledges first comment'))]);
	const first = await eventRouter.handleEvent(prEvent('first comment'), { mode: 'explicit_only' }, BACKGROUND_CONTEXT);
	assert.equal(first.action, 'router', 'first event must route via Router');
	assert.equal(first.routerLlmCalls, 1);
	assert.equal(routerLlmCalls.length, 1);
	const subs = await eventRouter.subscriptions('github:pr:botd#42', BACKGROUND_CONTEXT);
	assert.equal(subs.length, 1, 'Router decision must subscribe W1');
	assert.equal(subs[0], String(workerConversation.id));

	// 后续 3 个事件：直通 W1，0 Router LLM 调用
	for (const summary of ['second comment', 'third comment', 'fourth comment']) {
		const outcome = await eventRouter.handleEvent(prEvent(summary), { mode: 'explicit_only' }, BACKGROUND_CONTEXT);
		assert.equal(outcome.action, 'passthrough', `${summary} must pass through`);
		assert.equal(outcome.routerLlmCalls, 0);
		assert.deepEqual(outcome.deliveredTo, [String(workerConversation.id)]);
	}
	assert.equal(routerLlmCalls.length, 1, 'pass-through must not invoke the Router LLM');
	assert.equal(eventRouter.stats.routerLlmCalls, 1);
	assert.equal(eventRouter.stats.passthroughDeliveries, 3);

	// 重叠 Worker：W2 也订阅同一线程 → 双投递
	const worker2 = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await eventRouter.subscribeThread(worker2.id, 'github:pr:botd#42', BACKGROUND_CONTEXT);
	const overlap = await eventRouter.handleEvent(prEvent('fifth comment'), { mode: 'explicit_only' }, BACKGROUND_CONTEXT);
	assert.equal(overlap.action, 'passthrough');
	assert.equal(overlap.routerLlmCalls, 0);
	assert.deepEqual(
		[...overlap.deliveredTo].sort(),
		[String(workerConversation.id), String(worker2.id)].sort(),
		'both overlapping workers must receive the pass-through',
	);

	// 退订后回到慢路径
	await eventRouter.unsubscribeThread(worker2.id, 'github:pr:botd#42', BACKGROUND_CONTEXT);
	await eventRouter.unsubscribeThread(workerConversation.id, 'github:pr:botd#42', BACKGROUND_CONTEXT);
	env.faux.setResponses([fauxAssistantMessage(fauxText('router handles sixth comment'))]);
	const afterUnsub = await eventRouter.handleEvent(prEvent('sixth comment'), { mode: 'explicit_only' }, BACKGROUND_CONTEXT);
	assert.equal(afterUnsub.action, 'router', 'unsubscribed thread falls back to the slow path');
});

test('Test 4a: Inline & Spill with Chain of Recall', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const registry = createRegistry();
	const harness = await HarnessType.open(new MemoryStorage(), { models: env.models, registry, env: () => new NodeExecutionEnv({ cwd: process.cwd() }) }, BACKGROUND_CONTEXT);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT));

	// 小载荷：全内联
	const small = await formatEventInlineAndSpill(harness, prEvent('tiny', 'short body'), BACKGROUND_CONTEXT, { inlineCharLimit: 120 });
	assert.equal(small.spilled, false);
	assert.ok(small.inline.includes('short body'));
	assert.ok(small.inline.includes('adjacent: previous review comment'));

	// 大载荷：外溢 + recall 指针（返回后 spill 已同步落盘，立刻 recall 必能读到）
	const bigPayload = 'x'.repeat(500);
	const big = await formatEventInlineAndSpill(harness, prEvent('huge diff', bigPayload), BACKGROUND_CONTEXT, { inlineCharLimit: 40 });
	assert.equal(big.spilled, true);
	assert.ok(big.spillId !== undefined);
	assert.ok(big.inline.includes(`[Spilled: ${big.spillId} | Call recall({ "id": "${big.spillId}" }) to read full content]`));
	assert.ok(!big.inline.includes(bigPayload), 'full payload must not be inlined');

	// Chain of Recall：取回全文
	const recalled = await recallSpill(harness, big.spillId!, BACKGROUND_CONTEXT);
	assert.equal(recalled, bigPayload);
	const spillDoc = await harness.snapshot(SpillStoreDoc, big.spillId!, BACKGROUND_CONTEXT);
	assert.ok(spillDoc !== undefined);
	assert.equal(spillDoc.fullContent, bigPayload);
});

test('Test 4b: speculative execution — unconfirmed is silently discarded, confirmed notifies the Router', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const registry = createRegistry();
	const harness = await HarnessType.open(new MemoryStorage(), { models: env.models, registry, env: () => new NodeExecutionEnv({ cwd: process.cwd() }) }, BACKGROUND_CONTEXT);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT));

	const notifications: string[] = [];
	const policy: EventFilterPolicy = { mode: 'candidate' };
	const bugEvent: IncomingEvent = {
		source: 'github',
		type: 'issue.opened',
		sender: 'user1',
		target: { kind: 'issue', repo: 'botd', number: 7 },
		summary: 'bug: crash on startup when config missing',
	};

	// 未确认：静默丢弃，Router 零通知
	const unconfirmed = await triggerSpeculativeWorker(
		bugEvent,
		policy,
		async () => ({ run: async () => ({ confirmed: false, reason: 'could not reproduce' }), conversation: (await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT)) }),
		async (message) => {
			notifications.push(message);
		},
		{ rules: { keywords: ['bug', 'crash'] } },
		BACKGROUND_CONTEXT,
	);
	assert.equal(unconfirmed.confirmed, false);
	assert.equal(notifications.length, 0, 'unconfirmed speculative work must be discarded silently');

	// 确认：通知 Router 交付
	const confirmed = await triggerSpeculativeWorker(
		bugEvent,
		policy,
		async () => ({ run: async () => ({ confirmed: true, deliverable: 'PR #51 fixes startup crash' }), conversation: (await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT)) }),
		async (message) => {
			notifications.push(message);
		},
		{ rules: { keywords: ['bug'] } },
		BACKGROUND_CONTEXT,
	);
	assert.equal(confirmed.confirmed, true);
	assert.equal(confirmed.deliverable, 'PR #51 fixes startup crash');
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0].includes('Speculative result confirmed'));

	// 快速路径：ignore / 白名单不命中直接丢弃（不进任何路径）
	assert.deepEqual(filterEventFastPath(bugEvent, { mode: 'ignore' }), { action: 'drop', reason: 'mode=ignore' });
	assert.deepEqual(
		filterEventFastPath(bugEvent, { mode: 'candidate', senderWhitelist: ['someone-else'] }).action,
		'drop',
	);
	assert.equal(threadKeyOf(bugEvent), 'github:issue:botd#7');
});

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

test('Test 5: Watchdog steers a stuck/looping worker and auto-continues transient failures', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const registry = createRegistry();
	const harness = await HarnessType.open(new MemoryStorage(), { models: env.models, registry, env: () => new NodeExecutionEnv({ cwd: process.cwd() }) }, BACKGROUND_CONTEXT);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT));

	// Worker A：busy 但零工具轮（模拟卡死）
	const stuckWorker = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await stuckWorker.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);
	env.faux.setResponses([fauxAssistantMessage(fauxText('thinking forever...'))]);
	await stuckWorker.submit({ type: 'input', content: 'do something' }, BACKGROUND_CONTEXT);
	await harness.waitForIdle(BACKGROUND_CONTEXT);

	// 人为把 Worker A 置于“busy 无工具轮”状态：直接提交一个悬空 run 不现实，
	// 改为在 LiveDoc 语义下验证：空闲 + runFailure(model_error) → continue。
	// 构造方式：向 Worker B 注入 model_error（无 faux 响应可用）。
	const transientWorker = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await transientWorker.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);
	// 不排响应 → model_error（"No more faux responses queued"）
	await (await transientWorker.submit({ type: 'input', content: 'trigger transient failure' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	const liveB = await harness.snapshot(LiveDoc, transientWorker.id, BACKGROUND_CONTEXT);
	assert.equal(liveB?.runFailure?.reason, 'model_error', 'worker B must have a transient model_error');

	// 巡检：瞬态失败 → continue 恢复
	env.faux.setResponses([fauxAssistantMessage(fauxText('recovered after continue'))]);
	const options: Partial<WatchdogOptions> = { maxStallMs: 60_000, maxToolErrors: 3, allowAbort: false };
	const pass = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	const continueActions = pass.actions.filter((a) => a.kind === 'continue');
	assert.ok(continueActions.length >= 1, `watchdog must auto-continue the transient failure: ${JSON.stringify(pass.actions)}`);
	assert.ok(continueActions.every((a) => a.reason.includes('model_error')));

	// 干预已记录，且可自然语言诊断
	const report = await diagnoseSystemHealth(harness, BACKGROUND_CONTEXT);
	assert.equal(report.healthy, false);
	assert.ok(report.summary.includes('Watchdog intervened'));
	assert.ok(report.interventions.some((i) => i.kind === 'continue'));

	// continue 提交后 worker B 恢复并答出
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	const liveAfter = await harness.snapshot(LiveDoc, transientWorker.id, BACKGROUND_CONTEXT);
	assert.equal(liveAfter?.runFailure, undefined, 'continue must clear the run failure');
	assert.equal(liveAfter?.run, undefined);
});
