/**
 * session-model-override.test.ts — Session-Scoped Model Override & Auto-Continue.
 *
 * 覆盖两个能力：
 *  1. `TargetDoc.modelOverride`：会话级模型覆盖，与全局 BotPersonaConfig 隔离——
 *     切换单个会话的模型不影响同 persona 的兄弟会话；`syncPersonas` 重放全局配置时
 *     保留该覆盖；`null` 清除后回到 persona 默认模型。
 *  2. 失败回合自动续跑：会话空闲且带未决 `runFailure`（model_error）时，
 *     `setConversationModelOverride` 落完覆盖后自动提交 `{ type: "continue" }`，
 *     失败回合在新模型上完成（`resumed === true`）。
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

test('session model override switches one session and survives syncPersonas; null restores the persona default', { timeout: 60_000 }, async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const p = persona('architect');
		runtime.registerPersona(p);
		await runtime.syncPersonas([p]);

		// Session A and Session B of the same persona, both on faux/model-a.
		const sessionA = await runtime.ensureBotMainSession('architect');
		const sessionB = await runtime.createBotTopicSession('architect', 'session-b');
		assert.equal((await sessionA.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a');
		assert.equal((await sessionB.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a');

		// Override Session A only.
		const result = await runtime.setConversationModelOverride(String(sessionA.id), {
			provider: 'faux',
			modelId: 'model-b',
		});
		assert.equal(result.resumed, false, 'an idle healthy session must not resume');
		assert.equal((await sessionA.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-b');
		assert.equal((await sessionB.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a', 'sibling session stays untouched');

		// A global persona sync must not wipe the session-scoped override.
		await runtime.syncPersonas([{ ...p, instructions: 'You are the architect bot (v2).' }]);
		assert.equal(
			(await sessionA.agent(BACKGROUND_CONTEXT)).model?.modelId,
			'model-b',
			'session override survives syncPersonas',
		);
		assert.equal((await sessionB.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a', 'sibling picks the persona model');

		// Session A actually runs on the override model.
		faux.setResponses([fauxAssistantMessage('session A on model-b')]);
		const submissionA = await runtime.submitUserMessage(String(sessionA.id), 'hello from session A');
		assert.equal((await submissionA.wait(BACKGROUND_CONTEXT)).status, 'done');

		// Clearing the override restores the persona default.
		const cleared = await runtime.setConversationModelOverride(String(sessionA.id), null);
		assert.equal(cleared.resumed, false);
		assert.equal((await sessionA.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a');
		assert.equal((await sessionB.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a');
	} finally {
		await runtime.close();
	}
});

test('setConversationModelOverride auto-continues an idle session failed with model_error on the new model', { timeout: 60_000 }, async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const p = persona('architect');
		runtime.registerPersona(p);

		const session = await runtime.ensureBotMainSession('architect');
		assert.equal((await session.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-a');

		// No faux responses queued -> the turn fails with model_error.
		const failed = await runtime.submitUserMessage(String(session.id), 'this turn will fail');
		assert.equal((await failed.wait(BACKGROUND_CONTEXT)).status, 'unanswered');
		const liveFailed = await waitFor(
			async () => await runtime.harness.snapshot(LiveDoc, session.id, BACKGROUND_CONTEXT),
			(live) => live?.run === undefined && live?.runFailure?.reason === 'model_error',
			'runFailure(model_error) while idle',
		);
		assert.equal(liveFailed?.runFailure?.reason, 'model_error');

		// Switching the model while the failure is pending must auto-submit { type: "continue" }.
		faux.setResponses([fauxAssistantMessage('recovered on model-b')]);
		const result = await runtime.setConversationModelOverride(String(session.id), {
			provider: 'faux',
			modelId: 'model-b',
		});
		assert.equal(result.resumed, true, 'a failed idle session must auto-continue on the new model');

		// The failed turn completes on model-b: no live run, no runFailure, an answer landed.
		await waitFor(
			async () => await runtime.harness.snapshot(LiveDoc, session.id, BACKGROUND_CONTEXT),
			(live) => live?.run === undefined && live?.runFailure === undefined,
			'the continued run to finish cleanly',
		);
		assert.equal((await session.agent(BACKGROUND_CONTEXT)).model?.modelId, 'model-b');
	} finally {
		await runtime.close();
	}
});
