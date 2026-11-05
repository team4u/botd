/**
 * session-model-override.test.ts — 会话级模型覆盖：状态一致性 + 机制/策略分离。
 *
 * 契约（机制层，纯保存，绝不续跑）：
 *  - `setConversationModelOverride` 返回本次提交实际保存的 `{override, effective}`；
 *  - `getConversationModelConfig` 返回同形状的当前配置；
 *  - `resumeFailedConversation` 只在空闲 model_error/interrupted 会话上恢复，
 *    事务内读 LiveDoc + submit(tx)，并发/忙碌返回 false 且不影响保存结果。
 *
 * 一致性规则：
 *  - 新 worker / 换 persona 的 fork 一律目标 persona 默认配置（TargetDoc 清继承覆盖）；
 *  - 同 persona 用户会话 fork 可继承覆盖，但创建时立即应用一致的有效配置；
 *  - 清除/替换覆盖时 thinking 显式清档（configure null），`max` 规范为 `xhigh`。
 *
 * 模型走确定性 faux provider，不触真实 LLM。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { LiveDoc, MemoryStorage } from '@earendil-works/pi-durable';

import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
	read: () => Promise<T> | T,
	check: (value: T) => boolean,
	message: string,
	timeoutMs = 8_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T;
	for (;;) {
		last = await read();
		if (check(last)) return last;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${message}`);
		await wait(20);
	}
}

const persona = (botId: string, overrides: Partial<BotPersonaConfig> = {}): BotPersonaConfig => ({
	botId,
	name: botId,
	model: { provider: 'faux', modelId: 'model-a' },
	instructions: `You are the ${botId} bot.`,
	nodeId: 'node-1',
	cwd: process.cwd(),
	...overrides,
});

async function openRuntime() {
	const faux = fauxProvider({ models: [{ id: 'model-a' }, { id: 'model-b' }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = await HubDurableRuntime.open({
		storage: new MemoryStorage(),
		models,
		workerAgent: () => ({}),
	});
	return { runtime, faux };
}

const agentModel = async (runtime: HubDurableRuntime, id: string) =>
	(await runtime.conversation(id, BACKGROUND_CONTEXT))!.agent(BACKGROUND_CONTEXT);
const agentThinking = async (runtime: HubDurableRuntime, id: string) =>
	(await agentModel(runtime, id)).thinkingLevel;

test('setter 纯保存返回实际配置，不产生执行；getter 同形状', { timeout: 60_000 }, async () => {
	const { runtime } = await openRuntime();
	try {
		const p = persona('architect');
		runtime.registerPersona(p);
		await runtime.syncPersonas([p]);
		const session = await runtime.ensureBotMainSession('architect');

		// 保存前：无覆盖，effective = persona 默认。
		const before = await runtime.getConversationModelConfig(String(session.id));
		assert.equal(before.override, null);
		assert.deepEqual(before.effective, { provider: 'faux', modelId: 'model-a' });

		// setter 返回本次提交实际保存的配置，且不产生任何执行（无 run 出现）。
		const saved = await runtime.setConversationModelOverride(String(session.id), {
			provider: 'faux',
			modelId: 'model-b',
		});
		assert.deepEqual(saved.override, { provider: 'faux', modelId: 'model-b' });
		assert.equal(saved.effective.modelId, 'model-b');
		const live = await runtime.harness.snapshot(LiveDoc, session.id, BACKGROUND_CONTEXT);
		assert.equal(live?.run, undefined, 'setter must never start a run');

		// getter 与 setter 返回形状一致。
		const after = await runtime.getConversationModelConfig(String(session.id));
		assert.deepEqual(after, saved);
	} finally {
		await runtime.close();
	}
});

test('显式 resume 恢复空闲 model_error 会话；健康会话返回 false', { timeout: 60_000 }, async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const p = persona('architect');
		runtime.registerPersona(p);
		const session = await runtime.ensureBotMainSession('architect');

		// 健康空闲会话：resume 无事可做。
		assert.equal(await runtime.resumeFailedConversation(String(session.id)), false);

		// 无响应队列 -> 回合 model_error 失败。
		const failed = await runtime.submitUserMessage(String(session.id), 'this turn will fail');
		assert.equal((await failed.wait(BACKGROUND_CONTEXT)).status, 'unanswered');
		await waitFor(
			async () => await runtime.harness.snapshot(LiveDoc, session.id, BACKGROUND_CONTEXT),
			(live) => live?.run === undefined && live?.runFailure?.reason === 'model_error',
			'runFailure(model_error) while idle',
		);

		// 换模型（纯保存）后显式 resume：失败回合在新模型上完成。
		const saved = await runtime.setConversationModelOverride(String(session.id), {
			provider: 'faux',
			modelId: 'model-b',
		});
		assert.equal(saved.effective.modelId, 'model-b');
		faux.setResponses([fauxAssistantMessage('recovered on model-b')]);
		assert.equal(await runtime.resumeFailedConversation(String(session.id)), true);
		await waitFor(
			async () => await runtime.harness.snapshot(LiveDoc, session.id, BACKGROUND_CONTEXT),
			(live) => live?.run === undefined && live?.runFailure === undefined,
			'the continued run to finish cleanly',
		);

		// 已恢复（无未决失败）后再 resume 返回 false，不重复续跑。
		assert.equal(await runtime.resumeFailedConversation(String(session.id)), false);
	} finally {
		await runtime.close();
	}
});

test('forkContext worker 使用目标 persona 默认配置：创建即一致，sync 后不漂移', { timeout: 60_000 }, async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const p = persona('architect');
		runtime.registerPersona(p);
		await runtime.syncPersonas([p]);
		const session = await runtime.ensureBotMainSession('architect');

		// 父会话覆盖为 model-b 并跑一轮，使 fork 点带上下文。
		await runtime.setConversationModelOverride(String(session.id), { provider: 'faux', modelId: 'model-b' });
		faux.setResponses([fauxAssistantMessage('parent on model-b')]);
		const sub = await runtime.submitUserMessage(String(session.id), 'hello');
		assert.equal((await sub.wait(BACKGROUND_CONTEXT)).status, 'done');

		// forkContext worker：Agent 是 persona A，TargetDoc 不得残留覆盖 B。
		faux.setResponses([fauxAssistantMessage('worker answer')]);
		const { conversation: worker } = await runtime.forkSessionToWorker(String(session.id), {
			botId: 'architect',
			title: 'fork worker',
			task: 'do work',
			forkContext: true,
		});
		assert.equal((await worker.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a');
		assert.equal((await runtime.getConversationModelConfig(String(worker.id))).override, null);

		// syncPersonas 后仍与 persona 默认一致（不漂移回继承的覆盖）。
		await runtime.syncPersonas([{ ...p, instructions: 'You are the architect bot (v2).' }]);
		assert.equal((await worker.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a');
		const cfg = await runtime.getConversationModelConfig(String(worker.id));
		assert.equal(cfg.override, null);
		assert.equal(cfg.effective.modelId, 'model-a');

		// 父会话覆盖不受 worker 创建影响。
		const parentCfg = await runtime.getConversationModelConfig(String(session.id));
		assert.equal(parentCfg.override?.modelId, 'model-b');
	} finally {
		await runtime.close();
	}
});

test('跨 persona 分叉不泄漏来源覆盖；worktree worker 的 sessionId/worktree 不丢', { timeout: 60_000 }, async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const architect = persona('architect', { thinkingLevel: 'high' });
		const finance = persona('finance', {
			model: { provider: 'faux', modelId: 'model-b' },
			instructions: 'You are the finance bot.',
		});
		runtime.registerPersona(architect);
		runtime.registerPersona(finance);
		await runtime.syncPersonas([architect, finance]);
		const session = await runtime.ensureBotMainSession('architect');

		// architect 会话覆盖 model-b（与 finance 默认相同模型也不得泄漏状态），并跑一轮产生 fork 点。
		await runtime.setConversationModelOverride(String(session.id), {
			provider: 'faux',
			modelId: 'model-b',
			thinkingLevel: 'max',
		});
		faux.setResponses([fauxAssistantMessage('architect on model-b')]);
		const turn = await runtime.submitUserMessage(String(session.id), 'prepare context');
		assert.equal((await turn.wait(BACKGROUND_CONTEXT)).status, 'done');

		// 换 persona 的 worker 分叉：目标 persona 默认，覆盖清除。
		faux.setResponses([fauxAssistantMessage('finance worker answer')]);
		const { conversation: worker } = await runtime.forkSessionToWorker(String(session.id), {
			botId: 'finance',
			title: 'finance worker',
			task: 'do finance work',
			forkContext: true,
			worktree: true,
		});
		const workerCfg = await runtime.getConversationModelConfig(String(worker.id));
		assert.equal(workerCfg.override, null, 'cross-persona fork must not leak the source override');
		assert.equal(workerCfg.effective.modelId, 'model-b', 'finance persona default');
		assert.equal(workerCfg.effective.thinkingLevel, undefined, 'finance persona sets no thinking');
		assert.equal((await worker.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-b');
		assert.equal((await worker.agent(BACKGROUND_CONTEXT)).thinkingLevel, 'off', 'the worker must not inherit parent thinking');

		// worktree 分叉的执行上下文字段不因清覆盖而丢失。
		const target = await runtime.harness.snapshot(
			(await import('../apps/hub/src/harness/docs.js')).TargetDoc,
			worker.id,
			BACKGROUND_CONTEXT,
		);
		assert.equal(target?.role, 'worker');
		assert.equal(target?.botId, 'finance');
		assert.ok(target?.worktreePath, 'worktreePath preserved');
		assert.ok(target?.branchName, 'branchName preserved');
		assert.ok(target?.sessionId, 'sessionId preserved');

		// 同 persona 用户会话 fork：继承覆盖，但创建即应用一致的有效配置（含 max->xhigh）。
		const newest = await session.entries({ order: 'descending' }, 1, undefined, BACKGROUND_CONTEXT);
		const latestId = newest.items[0]?.id;
		assert.ok(latestId !== undefined, 'the source conversation has an entry to fork at');
		const fork = await runtime.forkConversation(session.id, latestId, 'architect');
		const forkCfg = await runtime.getConversationModelConfig(String(fork.id));
		assert.equal(forkCfg.override?.modelId, 'model-b', 'same-persona user fork inherits the override');
		assert.equal(forkCfg.effective.thinkingLevel, 'xhigh', "'max' normalizes to 'xhigh'");
		assert.equal((await fork.agent(BACKGROUND_CONTEXT)).thinkingLevel, 'xhigh');
		assert.equal((await fork.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-b');

		// 跨 persona 的用户会话 fork：清覆盖，用 finance 默认。
		const crossFork = await runtime.forkConversation(session.id, latestId, 'finance');
		const crossCfg = await runtime.getConversationModelConfig(String(crossFork.id));
		assert.equal(crossCfg.override, null);
		assert.equal(crossCfg.effective.modelId, 'model-b');
		assert.equal(crossCfg.effective.thinkingLevel, undefined);
		assert.equal((await crossFork.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-b');

		// 来源随后切换模型，历史分叉仍应采用锚点处的覆盖，而非来源最新配置。
		await runtime.setConversationModelOverride(String(session.id), {
			provider: 'faux', modelId: 'model-a', thinkingLevel: 'low',
		});
		const historical = await runtime.forkConversation(session.id, latestId, 'architect');
		assert.equal((await runtime.getConversationModelConfig(String(historical.id))).override?.modelId, 'model-b');
		assert.equal((await historical.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-b');
		assert.equal((await historical.agent(BACKGROUND_CONTEXT)).thinkingLevel, 'xhigh');
	} finally {
		await runtime.close();
	}
});

test('清除/替换覆盖时 thinking 显式清档；省略时回退 persona 默认', { timeout: 60_000 }, async () => {
	const { runtime } = await openRuntime();
	try {
		// persona 未设 thinking：默认 agent 解析为 'off'。
		const p = persona('architect');
		runtime.registerPersona(p);
		await runtime.syncPersonas([p]);
		const session = await runtime.ensureBotMainSession('architect');
		assert.equal(await agentThinking(runtime, String(session.id)), 'off');

		// 设置 high：effective 为 high。
		await runtime.setConversationModelOverride(String(session.id), {
			provider: 'faux',
			modelId: 'model-a',
			thinkingLevel: 'high',
		});
		assert.equal(await agentThinking(runtime, String(session.id)), 'high');

		// 替换覆盖（省略 thinking）：回退 persona 默认（未设 -> 清档为 off）。
		const replaced = await runtime.setConversationModelOverride(String(session.id), {
			provider: 'faux',
			modelId: 'model-b',
		});
		assert.equal(replaced.effective.thinkingLevel, undefined);
		assert.equal(await agentThinking(runtime, String(session.id)), 'off', 'omitted thinking must clear, not keep high');

		// 再次设置 high 后 override:null 清除：回到 persona 默认（off）。
		await runtime.setConversationModelOverride(String(session.id), {
			provider: 'faux',
			modelId: 'model-b',
			thinkingLevel: 'high',
		});
		assert.equal(await agentThinking(runtime, String(session.id)), 'high');
		const cleared = await runtime.setConversationModelOverride(String(session.id), null);
		assert.equal(cleared.override, null);
		assert.equal(cleared.effective.modelId, 'model-a');
		assert.equal(await agentThinking(runtime, String(session.id)), 'off', 'clearing the override must clear thinking too');

		// persona 自带 thinking 时：省略回退 persona 档位。
		const pHigh = persona('architect', { thinkingLevel: 'high' });
		await runtime.setConversationModelOverride(String(session.id), { provider: 'faux', modelId: 'model-b' });
		await runtime.syncPersonas([pHigh]);
		assert.equal(await agentThinking(runtime, String(session.id)), 'high', 'falls back to the persona level');
	} finally {
		await runtime.close();
	}
});

test('并发恢复不报假保存失败：第二次 resume 返回 false，保存结果不受影响', { timeout: 60_000 }, async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const p = persona('architect');
		runtime.registerPersona(p);
		const session = await runtime.ensureBotMainSession('architect');

		const failed = await runtime.submitUserMessage(String(session.id), 'this turn will fail');
		assert.equal((await failed.wait(BACKGROUND_CONTEXT)).status, 'unanswered');
		await waitFor(
			async () => await runtime.harness.snapshot(LiveDoc, session.id, BACKGROUND_CONTEXT),
			(live) => live?.run === undefined && live?.runFailure?.reason === 'model_error',
			'runFailure(model_error) while idle',
		);

		// 并发保存 + 两次 resume：一次接纳成功，另一侧看到忙碌/已恢复返回 false；
		// 保存本身不因续跑竞争被误报失败。
		faux.setResponses([fauxAssistantMessage('recovered once')]);
		const [, first, second] = await Promise.all([
			runtime.setConversationModelOverride(String(session.id), { provider: 'faux', modelId: 'model-b' }),
			runtime.resumeFailedConversation(String(session.id)),
			runtime.resumeFailedConversation(String(session.id)),
		]);
		const resumedCount = [first, second].filter(Boolean).length;
		assert.ok(resumedCount >= 1, 'at least one resume must win');
		const cfg = await runtime.getConversationModelConfig(String(session.id));
		assert.equal(cfg.override?.modelId, 'model-b', 'the save is intact regardless of resume races');

		await waitFor(
			async () => await runtime.harness.snapshot(LiveDoc, session.id, BACKGROUND_CONTEXT),
			(live) => live?.run === undefined && live?.runFailure === undefined,
			'the continued run to finish cleanly',
		);
	} finally {
		await runtime.close();
	}
});
