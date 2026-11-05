/**
 * watchdog-error-classification.test.ts — Watchdog 窄错误分类与有界自愈。
 *
 *  1. classifyRunFailure 纯分类：401/403→auth、400→request、402/余额不足→quota、
 *     404→not_found、429/503/interrupted/裸 model_error→transient；
 *  2. 永久错误（401 / 400）：首轮 1 次 alert、0 次 continue，次轮 0 动作（无死循环）；
 *  3. 持续瞬态错误（429）：continue 次数封顶 maxContinueRetries，之后只告警一次并停发 continue；
 *  4. abort 优先调用 options.stopWorker。
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, LiveDoc, MemoryStorage } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Harness as HarnessType } from '@earendil-works/pi-durable';
import {
	classifyRunFailure,
	runWatchdogPass,
	type WatchdogOptions,
} from '../apps/hub/src/harness/watchdog.js';

function createFauxEnv() {
	const faux = fauxProvider({ models: [{ id: 'botd-worker' }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

const openHarness = (models: ReturnType<typeof createModels>) =>
	HarnessType.open(
		new MemoryStorage(),
		{
			models,
			registry: createRegistry(),
			env: () => new NodeExecutionEnv({ cwd: process.cwd() }),
			// 关闭请求级重试：错误注入一次性落定为 model_error，细节确定可断言
			// （watchdog 的 run 级 continue 重试不受影响）。
			settings: { retry: { enabled: false } },
		},
		BACKGROUND_CONTEXT,
	);

/** 提交无响应输入，制造空闲 + model_error 的会话；detail 由 faux errorMessage 决定。 */
async function failConversation(
	harness: HarnessType,
	faux: ReturnType<typeof fauxProvider>,
	errorMessage: string,
): Promise<number> {
	const conv = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await conv.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);
	faux.setResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage })]);
	const submission = await conv.submit({ type: 'input', content: 'trigger failure' }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT).catch(() => undefined);
	const live = await harness.snapshot(LiveDoc, conv.id, BACKGROUND_CONTEXT);
	assert.equal(live?.runFailure?.reason, 'model_error', `faux error must produce model_error (got ${JSON.stringify(live?.runFailure?.reason)})`);
	assert.equal(live?.runFailure?.detail, errorMessage, 'model_error detail must carry the faux errorMessage');
	return Number(conv.id);
}

/** 等待全部会话空闲（continue 触发的新 run 落定）。 */
async function waitForIdle(harness: HarnessType): Promise<void> {
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	await new Promise((r) => setTimeout(r, 50));
}

/** 对已有会话注入一次新的 model_error 失败。 */
async function failConversationOn(
	harness: HarnessType,
	faux: ReturnType<typeof fauxProvider>,
	conversationId: number,
	errorMessage: string,
): Promise<void> {
	const conv = await harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
	assert.ok(conv !== undefined, 'conversation must exist');
	faux.setResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage })]);
	const submission = await conv.submit({ type: 'input', content: 'trigger failure again' }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT).catch(() => undefined);
	const live = await harness.snapshot(LiveDoc, conv.id, BACKGROUND_CONTEXT);
	assert.equal(live?.runFailure?.reason, 'model_error');
	assert.equal(live?.runFailure?.detail, errorMessage);
}

// ---------------------------------------------------------------------------

test('1. classifyRunFailure: permanent vs transient categories', { timeout: 60_000 }, () => {
	// auth：401 / 403 / 关键词
	for (const detail of ['HTTP 401 Unauthorized', 'HTTP 403 forbidden', 'invalid_api_key provided', 'authentication_error from provider']) {
		const c = classifyRunFailure({ reason: 'model_error', detail });
		assert.equal(c.retryable, false, `"${detail}" must be non-retryable`);
		assert.equal(c.category, 'auth', `"${detail}" must classify as auth`);
	}
	// request：400 / 413 / 422 / 上下文超长
	for (const detail of ['HTTP 400 bad request', 'HTTP 422 unprocessable', 'context_length_exceeded', 'prompt is too long']) {
		const c = classifyRunFailure({ reason: 'model_error', detail });
		assert.equal(c.retryable, false, `"${detail}" must be non-retryable`);
		assert.equal(c.category, 'request', `"${detail}" must classify as request`);
	}
	// quota：402 / 余额不足（含 \u 转义形态）
	assert.equal(classifyRunFailure({ reason: 'model_error', detail: 'HTTP 402 payment required' }).category, 'quota');
	const escaped = classifyRunFailure({ reason: 'model_error', detail: '\\u4f59\\u989d\\u4e0d\\u8db3' });
	assert.equal(escaped.retryable, false, 'escaped 余额不足 must be non-retryable');
	assert.equal(escaped.category, 'quota');
	assert.ok(escaped.summary.includes('余额不足'), 'summary must carry the decoded text');
	assert.equal(classifyRunFailure({ reason: 'model_error', detail: 'insufficient_quota: you exceeded your quota' }).category, 'quota');
	// not_found：404 / model_not_found
	for (const detail of ['HTTP 404 not found', 'model_not_found: no such model', 'model does not exist']) {
		assert.equal(classifyRunFailure({ reason: 'model_error', detail }).category, 'not_found');
	}
	// transient：429 / 5xx / interrupted / 裸 model_error / 网络错误
	for (const detail of ['HTTP 429 too many requests', 'HTTP 503 service unavailable', 'HTTP 502 bad gateway', 'network error: connection reset', undefined]) {
		const c = classifyRunFailure({ reason: 'model_error', detail });
		assert.equal(c.retryable, true, `"${detail}" must be retryable`);
		assert.equal(c.category, 'transient');
	}
	assert.deepEqual(classifyRunFailure({ reason: 'interrupted', detail: 'cut off' }), {
		retryable: true,
		category: 'transient',
		summary: 'interrupted',
	});
	// 非瞬态 reason 一律不重试
	assert.deepEqual(classifyRunFailure({ reason: 'aborted' }), { retryable: false, category: 'request', summary: 'aborted' });
	assert.deepEqual(classifyRunFailure(undefined), { retryable: false, category: 'request', summary: 'none' });
	// 状态码不得误配更长数字（如请求 ID 14042）
	assert.equal(classifyRunFailure({ reason: 'model_error', detail: 'request id 14042 failed after retry' }).retryable, true);
});

test('2. non-retryable 401/400 failure: alert once on pass 1, no actions on pass 2 (no infinite loop)', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	const authId = await failConversation(harness, env.faux, 'HTTP 401 Unauthorized: invalid_api_key');
	const badRequestId = await failConversation(harness, env.faux, 'HTTP 400 Bad Request: invalid_request_error');

	const options: Partial<WatchdogOptions> = { allowAbort: false };
	const pass1 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	const alerts1 = pass1.actions.filter((a) => a.kind === 'alert');
	const continues1 = pass1.actions.filter((a) => a.kind === 'continue');
	assert.equal(alerts1.length, 2, `both permanent failures must alert once (got ${JSON.stringify(pass1.actions)})`);
	assert.equal(continues1.length, 0, 'permanent failures must never emit continue');
	assert.ok(alerts1.some((a) => Number(a.conversationId) === authId && a.reason.includes('non-retryable auth')));
	assert.ok(alerts1.some((a) => Number(a.conversationId) === badRequestId && a.reason.includes('non-retryable request')));

	// continue 都没发 → 两个会话仍是空闲失败态，但已告警：第二轮必须零动作
	await waitForIdle(harness);
	const pass2 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	assert.equal(
		pass2.actions.length,
		0,
		`already-alerted permanent failures must produce no actions on pass 2 (got ${JSON.stringify(pass2.actions)})`,
	);
});

test('3. persistent retryable 429: continue caps at maxContinueRetries, then alerts once and stops', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	const RATE_LIMIT = 'HTTP 429 Too Many Requests: rate limit exceeded, retry later';
	const workerId = await failConversation(harness, env.faux, RATE_LIMIT);
	const options: Partial<WatchdogOptions> = { allowAbort: false, maxContinueRetries: 2 };
	const counts = (actions: { kind: string; conversationId: number }[]) => ({
		continue: actions.filter((a) => a.kind === 'continue' && Number(a.conversationId) === workerId).length,
		alert: actions.filter((a) => a.kind === 'alert' && Number(a.conversationId) === workerId).length,
	});

	// pass 1 / 2：每次 continue 后都因 429 再次失败 → continue×2 封顶
	for (let i = 1; i <= 2; i++) {
		env.faux.setResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage: RATE_LIMIT })]);
		const pass = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
		const c = counts(pass.actions);
		assert.equal(c.continue, 1, `pass ${i} must emit exactly 1 continue (got ${JSON.stringify(pass.actions)})`);
		assert.equal(c.alert, 0, `pass ${i} must not alert yet`);
		await waitForIdle(harness);
	}
	// pass 3：attempts(2) >= max(2) → 告警一次、不再 continue
	env.faux.setResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage: RATE_LIMIT })]);
	const pass3 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	const c3 = counts(pass3.actions);
	assert.equal(c3.continue, 0, 'retry limit reached must stop continue');
	assert.equal(c3.alert, 1, `retry limit reached must alert exactly once (got ${JSON.stringify(pass3.actions)})`);
	assert.ok(pass3.actions.some((a) => a.reason.includes('transient retry limit (2) reached')));
	// pass 4：已告警 → 零动作
	await waitForIdle(harness);
	const pass4 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	const c4 = counts(pass4.actions);
	assert.equal(c4.continue + c4.alert, 0, `post-alert passes must stay silent (got ${JSON.stringify(pass4.actions)})`);
});

test('3b. recovery clears failure tracking: a fresh transient failure starts the retry budget over', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	const RATE_LIMIT = 'HTTP 429 Too Many Requests: rate limit exceeded, retry later';
	const workerId = await failConversation(harness, env.faux, RATE_LIMIT);
	const options: Partial<WatchdogOptions> = { allowAbort: false, maxContinueRetries: 2 };
	const continues = (actions: { kind: string; conversationId: number }[]) =>
		actions.filter((a) => a.kind === 'continue' && Number(a.conversationId) === workerId).length;

	// pass 1：429 → continue（attempts 1），这次排上正常响应 → 会话真正恢复
	env.faux.setResponses([fauxAssistantMessage(fauxText('recovered answer'))]);
	const pass1 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	assert.equal(continues(pass1.actions), 1);
	await waitForIdle(harness);
	const live = await harness.snapshot(LiveDoc, workerId as never, BACKGROUND_CONTEXT);
	assert.equal(live?.runFailure, undefined, 'continue with a queued answer must clear the run failure');
	assert.equal(live?.run, undefined, 'worker must be idle after recovery');

	// pass 2：恢复后的会话无失败 → 清空追踪（零动作）
	const pass2 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	assert.equal(continues(pass2.actions), 0);

	// pass 3：全新的 429 失败 → 计数从头开始，仍可 continue 而不是直接告警
	await failConversationOn(harness, env.faux, workerId, RATE_LIMIT);
	const pass3 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	assert.equal(
		continues(pass3.actions),
		1,
		`a fresh failure after recovery must start a new retry budget (got ${JSON.stringify(pass3.actions)})`,
	);
});

test('4. abort action calls options.stopWorker when provided', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	const stopped: number[] = [];
	const options: Partial<WatchdogOptions> = { stopWorker: async (id) => (stopped.push(id), true) };
	// 直接驱动 applyActions 路径：abort 在 recentToolErrors >= maxToolErrors*2 时触发
	const worker = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await worker.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);
	const workerId = Number(worker.id);

	// 注入 6 个完成但带 error 诊断的工具槽 + busy run，凑满 loop + abort 阈值
	await harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, workerId as never);
		live.run = { taskId: 'task_test_abort' as never, inputs: [] as never, turns: 0 } as never;
		live.tools = Array.from({ length: 6 }, (_, i) => ({
			callId: `call_${i}`,
			name: 'boom',
			status: 'done',
			output: 'error',
			diagnostics: [{ severity: 'error', message: 'boom' }],
		})) as never;
	}, BACKGROUND_CONTEXT);
	// 话术注入后，人为把该会话加入巡检范围：给它补一个 runFailure
	// （run 注入不产生 inspection 记录，靠 runFailure 让扫描发现该会话）
	await harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, workerId as never);
		live.runFailure = { taskId: 'task_test_abort' as never, inputs: [] as never, reason: 'interrupted' } as never;
	}, BACKGROUND_CONTEXT);

	const pass = await runWatchdogPass(harness, { ...options, maxToolErrors: 3, allowAbort: true }, BACKGROUND_CONTEXT);
	const aborts = pass.actions.filter((a) => a.kind === 'abort' && Number(a.conversationId) === workerId);
	assert.equal(aborts.length, 1, `repeated tool errors must trigger abort (got ${JSON.stringify(pass.actions)})`);
	assert.deepEqual(stopped, [workerId], 'abort must route through options.stopWorker');
});
