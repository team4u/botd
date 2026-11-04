/**
 * 事件路由与巡检器回归测试（审计轮修复）。
 *
 * 覆盖：
 *  1. 同长度摘要的不同匿名事件不再因去重键碰撞被吞（LGTM 与 DONE 都投递）；
 *  2. 慢路径事件真正提交到 Router 会话（Router user entry 数量增加且含事件内容）；
 *  3. Watchdog：24 小时 stall 预算下刚启动任务绝不误触发 steer；
 *     20ms 预算下两次巡检无进展才触发、steer 后计时重置；
 *  4. scanFailedConversations 分页扫描覆盖高 ID（> 256）会话的瞬态失败并恢复。
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, MemoryStorage } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Harness as HarnessType } from '@earendil-works/pi-durable';
import {
	EventRouter,
	type IncomingEvent,
} from '../apps/hub/src/harness/event-router.js';
import { runWatchdogPass, type WatchdogOptions } from '../apps/hub/src/harness/watchdog.js';

type Conversation = NonNullable<Awaited<ReturnType<HarnessType['conversation']>>>;

function createFauxEnv() {
	const faux = fauxProvider({ models: [{ id: 'botd-worker' }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

const prEvent = (summary: string): IncomingEvent => ({
	source: 'github',
	type: 'pr.comment',
	sender: 'reviewer',
	target: { kind: 'pr', repo: 'botd', number: 42 },
	summary,
});

/** 读取会话中全部 user 消息文本。 */
async function userTexts(conv: Conversation): Promise<string[]> {
	const page = await conv.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
	return page.items
		.map((e) => e.model?.[0] as { role?: string; content?: unknown } | undefined)
		.filter((m) => m?.role === 'user')
		.map((m) => (typeof m!.content === 'string' ? m!.content : String((m!.content as unknown as { text?: string })?.text ?? '')));
}

const openHarness = (models: ReturnType<typeof createModels>) =>
	HarnessType.open(
		new MemoryStorage(),
		{ models, registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd: process.cwd() }) },
		BACKGROUND_CONTEXT,
	);

// ---------------------------------------------------------------------------

test('1. same-length summaries: LGTM and DONE both deliver (no dedup-key collision)', { timeout: 30_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	const worker = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await worker.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);
	const router = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await router.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);

	const eventRouter = new EventRouter({
		harness,
		resolveRouter: async () => router,
		decide: async () => undefined,
	});
	// 预订阅 threadKey：两条事件都直通 worker
	await eventRouter.subscribeThread(worker.id, 'github:pr:botd#42', BACKGROUND_CONTEXT);

	env.faux.setResponses([fauxAssistantMessage(fauxText('ack1')), fauxAssistantMessage(fauxText('ack2'))]);
	const a = await eventRouter.handleEvent(prEvent('LGTM'), { mode: 'explicit_only' }, BACKGROUND_CONTEXT);
	const b = await eventRouter.handleEvent(prEvent('DONE'), { mode: 'explicit_only' }, BACKGROUND_CONTEXT);
	assert.equal(a.action, 'passthrough');
	assert.equal(b.action, 'passthrough');

	// 直通的投递是异步 run：等 worker 收到两条输入
	await new Promise((r) => setTimeout(r, 300));
	const texts = (await userTexts(worker)).join('\n');
	assert.match(texts, /LGTM/, 'first same-length summary must be delivered');
	assert.match(texts, /DONE/, 'second same-length summary must also be delivered (was swallowed by the length-based dedup key)');
});

test('2. slow path: an event with no subscribers is really submitted to the Router conversation', { timeout: 30_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	const router = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await router.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);

	const before = (await userTexts(router)).length;
	env.faux.setResponses([fauxAssistantMessage(fauxText('router saw it'))]);
	const eventRouter = new EventRouter({
		harness,
		resolveRouter: async () => router,
		decide: async () => undefined,
	});
	const outcome = await eventRouter.handleEvent(prEvent('please triage this thread'), { mode: 'explicit_only' }, BACKGROUND_CONTEXT);
	assert.equal(outcome.action, 'router');

	const texts = await userTexts(router);
	assert.ok(
		texts.length > before,
		`slow-path event must land in the Router conversation (user entries: ${before} -> ${texts.length})`,
	);
	assert.match(texts.at(-1) ?? '', /please triage this thread/);
});

/** 提交一条长时间悬挂（有限时长，防 close 死锁）的输入，制造 busy 且无进展的会话。 */
async function hangBusyConversation(
	harness: HarnessType,
	faux: ReturnType<typeof fauxProvider>,
): Promise<Conversation> {
	const conv = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	await conv.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);
	const hang = () =>
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error('faux hang timeout')), 8000);
		});
	faux.setResponses([hang as never]);
	await conv.submit({ type: 'input', content: 'stall me' }, BACKGROUND_CONTEXT);
	await new Promise((r) => setTimeout(r, 150));
	return conv;
}

test('3a. watchdog with a 24h stall budget never steers a freshly-started busy task', { timeout: 30_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	await hangBusyConversation(harness, env.faux);
	// 旧缺陷：刚启动无工具轮 + `maxStallMs <= 默认值` 恒真 → 立即 steer。
	const options: Partial<WatchdogOptions> = { maxStallMs: 24 * 60 * 60 * 1000, allowAbort: false };
	const pass1 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	assert.equal(
		pass1.actions.filter((a) => a.kind === 'steer').length,
		0,
		'a freshly-started task with a 24h budget must never be steered',
	);
	const pass2 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	assert.equal(pass2.actions.filter((a) => a.kind === 'steer').length, 0, 'still no steer within budget');
});

test('3b. watchdog with a 20ms stall budget steers after two passes without progress', { timeout: 30_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	await hangBusyConversation(harness, env.faux);
	const options: Partial<WatchdogOptions> = { maxStallMs: 20, allowAbort: false };
	await runWatchdogPass(harness, options, BACKGROUND_CONTEXT); // 建立基线签名
	await new Promise((r) => setTimeout(r, 30));
	const pass2 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	assert.equal(
		pass2.actions.filter((a) => a.kind === 'steer').length,
		1,
		'no-progress beyond the tiny budget must steer exactly once',
	);
	// steer 后计时被重置：紧接着的下一轮不再重复 steer
	const pass3 = await runWatchdogPass(harness, options, BACKGROUND_CONTEXT);
	assert.equal(pass3.actions.filter((a) => a.kind === 'steer').length, 0, 'post-steer timer reset prevents immediate re-steer');
});

test('4. watchdog scan covers conversation ids beyond the old 256 hard cap', { timeout: 60_000 }, async (t) => {
	const env = createFauxEnv();
	const harness = await openHarness(env.models);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	// 批量创建超过 256 个会话，把瞬态失败会话推到高 ID 区
	for (let i = 0; i < 300; i++) {
		await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	}
	const highConv = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	const highId = Number(highConv.id);
	assert.ok(highId > 256, `expected conversation id beyond 256 (got ${highId})`);

	await highConv.configure({ model: { provider: 'faux', modelId: 'botd-worker' } }, BACKGROUND_CONTEXT);
	// 不排响应 → model_error（瞬态失败），等其落定
	await (await highConv.submit({ type: 'input', content: 'trigger transient failure' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT).catch(() => undefined);

	// 巡检 + 恢复响应：高 ID 会话的 model_error 必须被扫到并 continue
	env.faux.setResponses([fauxAssistantMessage(fauxText('recovered answer'))]);
	const pass = await runWatchdogPass(harness, { allowAbort: false }, BACKGROUND_CONTEXT);
	const continueActions = pass.actions.filter((a) => a.kind === 'continue');
	assert.ok(
		continueActions.some((a) => Number(a.conversationId) === highId),
		`scan must reach the high-id conversation ${highId} and continue it (actions: ${JSON.stringify(pass.actions.map((a) => ({ k: a.kind, c: Number(a.conversationId) })))})`,
	);
});
