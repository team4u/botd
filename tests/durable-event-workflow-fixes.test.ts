/**
 * durable-event-workflow-fixes.test.ts — EventRouter 外溢索引 / SubagentWorkflow
 * worktree 门禁 / TriggerService 线程直通三项修复的针对性测试。
 *
 *  1. formatEventInlineAndSpill：外溢事件同时登记 RecallIndexDoc（kind: 'trigger'，
 *     title / summary / relatedIds / contentPreview）与 SpillStoreDoc（全文）；
 *  2. SubagentWorkflow isolation: 'worktree' + gate：宿主文件系统未预建 worktree 时，
 *     gate 命令在目标 ExecutionEnv 上幂等挂载（本地 NodeExecutionEnv 演练远端路径）；
 *  3. TriggerService.processWebhook：GitHub PR webhook 直通 ThreadSubscriptionsDoc
 *     中订阅该 threadKey 的 Durable Worker（passthrough: true，0 Router LLM 调用）。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { createRegistry, MemoryStorage } from '@earendil-works/pi-durable';
import { Harness as HarnessType } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

import {
	formatEventInlineAndSpill,
	recallSpill,
	SpillStoreDoc,
	ThreadSubscriptionsDoc,
	type IncomingEvent,
} from '../apps/hub/src/harness/event-router.js';
import { RecallIndexDoc, TargetDoc } from '../apps/hub/src/harness/docs.js';
import { createWorkflowExtension } from '../apps/hub/src/harness/workflow-extension.js';
import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';
import { TriggerService, deriveWebhookThreadKey } from '../apps/hub/src/trigger-service.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { GroupRouter } from '../apps/hub/src/group-router.js';
import { NodeConnectionManager } from '../apps/hub/src/ws-hub.js';
import { AuthManager } from '../apps/hub/src/auth.js';
import { SseHub } from '../apps/hub/src/sse.js';

const run = promisify(execFile);

function createFauxEnv() {
	const faux = fauxProvider({ models: [{ id: 'botd-worker' }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

/** 构造一个带 PR 目标线程的 GitHub 事件。 */
const prEvent = (summary: string, payload?: string): IncomingEvent => ({
	source: 'github',
	type: 'pr.comment',
	sender: 'reviewer',
	target: { kind: 'pr', repo: 'botd', number: 42 },
	summary,
	payload,
	adjacent: ['previous review comment: LGTM aside from nits'],
});

// ---------------------------------------------------------------------------
// 1. Spill 登记 RecallIndexDoc
// ---------------------------------------------------------------------------

test('1. formatEventInlineAndSpill registers the spilled event in RecallIndexDoc next to SpillStoreDoc', { timeout: 30_000 }, async (t) => {
	const env = createFauxEnv();
	const registry = createRegistry();
	const harness = await HarnessType.open(
		new MemoryStorage(),
		{ models: env.models, registry, env: () => new NodeExecutionEnv({ cwd: process.cwd() }) },
		BACKGROUND_CONTEXT,
	);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));

	const bigPayload = 'x'.repeat(500);
	const result = await formatEventInlineAndSpill(harness, prEvent('huge diff', bigPayload), BACKGROUND_CONTEXT, {
		inlineCharLimit: 40,
	});
	assert.equal(result.spilled, true);
	assert.ok(result.spillId !== undefined);

	// SpillStoreDoc 保有全文（Chain of Recall 全文层不变）
	assert.equal(await recallSpill(harness, result.spillId!, BACKGROUND_CONTEXT), bigPayload);
	const spillDoc = await harness.snapshot(SpillStoreDoc, result.spillId!, BACKGROUND_CONTEXT);
	assert.ok(spillDoc !== undefined);
	assert.equal(spillDoc.fullContent, bigPayload);
	assert.equal(spillDoc.threadKey, 'github:pr:botd#42');

	// RecallIndexDoc 登记了同一 spillId 的 trigger 节点（目录卡，不存全文）
	const index = await harness.snapshot(RecallIndexDoc, BACKGROUND_CONTEXT);
	const node = index?.nodes[result.spillId!];
	assert.ok(node !== undefined, 'RecallIndexDoc must index the spilled event');
	assert.equal(node.kind, 'trigger');
	assert.equal(node.title, '[github] pr.comment');
	assert.equal(node.summary, 'huge diff');
	assert.deepEqual(node.relatedIds, [`${result.spillId}:adjacent:0`]);
	assert.equal(node.contentPreview, bigPayload.slice(0, 800));
	assert.ok(typeof node.createdAt === 'number');

	// 未外溢的小载荷不产生索引节点
	const before = Object.keys((await harness.snapshot(RecallIndexDoc, BACKGROUND_CONTEXT))?.nodes ?? {}).length;
	const small = await formatEventInlineAndSpill(harness, prEvent('tiny', 'short body'), BACKGROUND_CONTEXT, {
		inlineCharLimit: 120,
	});
	assert.equal(small.spilled, false);
	const after = Object.keys((await harness.snapshot(RecallIndexDoc, BACKGROUND_CONTEXT))?.nodes ?? {}).length;
	assert.equal(after, before, 'non-spilled events must not touch the recall index');
});

// ---------------------------------------------------------------------------
// 2. SubagentWorkflow gate 在目标 ExecutionEnv 上幂等挂载 worktree
// ---------------------------------------------------------------------------

const WORKFLOW_SCRIPT = `
export const meta = { name: "gate-mount", description: "gate mounts its own worktree", phases: ["Verify"] }
const out = await agent("produce verification info", { label: "prep" })
if (!out) throw new Error("prep step failed")
const verified = await agent("verify in isolation", { label: "iso", isolation: "worktree", gate: "git rev-parse --abbrev-ref HEAD > branch-marker.txt && cat branch-marker.txt" })
return { verified }
`;

/** 从根会话的 SubagentWorkflow 工具结果文本提取 `Result: {...}` JSON。 */
async function readWorkflowResult(root: Awaited<ReturnType<HarnessType['root']>>) {
	const text = await rootEntriesText(root);
	const match = text.match(/Result: (\{[\s\S]*?\})(?:\n|$)/);
	return match !== null ? (JSON.parse(match[1]) as Record<string, unknown>) : undefined;
}

/** 拼接根会话全部工具结果文本。 */
async function rootEntriesText(root: Awaited<ReturnType<HarnessType['root']>>): Promise<string> {
	const entries = await root.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
	return entries.items
		.map((entry) => entry.model?.[0])
		.filter((m) => m !== undefined && m.role === 'toolResult')
		.map((m) => {
			const content = (m as { content?: unknown }).content;
			return typeof content === 'string'
				? content
				: Array.isArray(content)
					? content.map((b) => (b as { text?: string }).text ?? '').join('')
					: '';
		})
		.join('\n');
}

test('2. SubagentWorkflow worktree gate mounts the worktree on the ExecutionEnv when the host never pre-created it', { timeout: 90_000 }, async (t) => {
	// 本地 git 仓库（含初始提交），供 worktree 挂载
	const repoDir = await mkdtemp(path.join(tmpdir(), 'botd-wf-gate-'));
	t.after(async () => await rm(repoDir, { recursive: true, force: true }).catch(() => undefined));
	await run('git', ['-C', repoDir, 'init', '-q']);
	await run('git', ['-C', repoDir, 'config', 'user.email', 'botd@test']);
	await run('git', ['-C', repoDir, 'config', 'user.name', 'botd-test']);
	await writeFile(path.join(repoDir, 'README.md'), '# repo\n');
	await run('git', ['-C', repoDir, 'add', '.']);
	await run('git', ['-C', repoDir, 'commit', '-q', '-m', 'init']);

	const env = createFauxEnv();
	const registry = createRegistry();
	registry.install(createWorkflowExtension());
	// 关键：NodeExecutionEnv 锚定在 git 仓库内，但目录挂载完全交给 gate 命令自身——
	// 模拟远端 ExecutionEnv（Hub 本机从未预建 worktree 的场景）。
	const harness = await HarnessType.open(
		new MemoryStorage(),
		{ models: env.models, registry, env: () => new NodeExecutionEnv({ cwd: repoDir }) },
		BACKGROUND_CONTEXT,
	);
	t.after(async () => await harness.close(BACKGROUND_CONTEXT).catch(() => undefined));
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: 'faux', modelId: 'botd-worker' } },
	});
	// 子会话 TargetDoc 继承根会话的 cwd：worktree 路径必须落在 git 仓库内，
	// 否则挂载点解析到测试运行目录（非 git 仓库）。
	await harness.commit(async (tx) => {
		const target = await tx.doc(TargetDoc, root.id);
		target.cwd = repoDir;
	}, BACKGROUND_CONTEXT);

	const toolCall = fauxAssistantMessage(
		{
			type: 'toolCall',
			id: `tc_${Math.random().toString(36).slice(2, 8)}`,
			name: 'SubagentWorkflow',
			arguments: { script: WORKFLOW_SCRIPT },
		},
		{ stopReason: 'toolUse' },
	);
	env.faux.setResponses([
		toolCall,
		fauxAssistantMessage(fauxText('prep done: ready to verify')),
		fauxAssistantMessage(fauxText('branch-name from gate')),
		fauxAssistantMessage(fauxText('workflow finished')),
	]);

	const settled = await (await root.submit({ type: 'input', content: 'run workflow' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	assert.equal(settled.status, 'done');

	const result = await readWorkflowResult(root);
	assert.ok(result, 'tool result must carry workflow output');
	// 工作流整体跑完且隔离 gate 步骤成功：verified 是 agent 回复文本，
	// 只有 gate 在挂载出的 worktree 分支里跑通（exit 0）步骤才会产出
	assert.ok(
		result.verified !== undefined && /branch-name from gate/.test(String(result.verified)),
		`the isolated gate step must succeed (got ${JSON.stringify(result)})`,
	);

	// 挂载确实发生在文件系统上（gate 的 branch-marker 落在 worktree 目录里）
	const worktreesDir = path.join(repoDir, '.botd-worktrees');
	assert.ok(existsSync(worktreesDir), 'the worktree directory must exist after the gate ran');
	const mounted = (await run('ls', [worktreesDir])).stdout.trim().split('\n').filter(Boolean);
	assert.ok(mounted.length > 0, 'at least one worktree must be mounted');
	const markerPath = path.join(worktreesDir, mounted[0], 'branch-marker.txt');
	assert.ok(existsSync(markerPath), 'gate output must land inside the mounted worktree');
});

// ---------------------------------------------------------------------------
// 3. TriggerService webhook → ThreadSubscriptionsDoc 直通
// ---------------------------------------------------------------------------

/** 组装最小 Hub 侧组件：HubDatabase（内存）+ GroupRouter + SseHub。 */
async function createHubSide() {
	const db = new HubDatabase({ dbPath: ':memory:' });
	const auth = new AuthManager();
	const sseHub = new SseHub();
	const connections = new NodeConnectionManager(db, auth, sseHub);
	const router = new GroupRouter(db, connections, sseHub);
	return { db, auth, sseHub, connections, router };
}

const persona = (botId: string, cwd: string): BotPersonaConfig => ({
	botId,
	name: botId,
	model: { provider: 'faux', modelId: 'botd-worker' },
	instructions: `You are ${botId}.`,
	nodeId: 'local',
	cwd,
});

test('3. processWebhook passes a GitHub PR event straight to the Worker subscribed to its threadKey (0 Router turns)', { timeout: 90_000 }, async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), 'botd-trigger-pt-'));
	t.after(async () => await rm(dir, { recursive: true, force: true }).catch(() => undefined));

	const { db, auth, sseHub, connections, router } = await createHubSide();
	t.after(() => {
		connections.close();
		router.close();
	});

	const env = createFauxEnv();
	const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models: env.models, codemode: false });
	t.after(async () => await runtime.close().catch(() => undefined));
	runtime.registerPersona(persona('reviewer', dir));

	// 会话 + 触发器 + 成员 Bot
	db.createNode({ id: 'node-1', name: 'Node 1', platform: 'linux', tokenHash: 'h', ownerId: 'user-1' });
	db.saveBot({
		id: 'reviewer',
		nodeId: 'node-1',
		name: 'Reviewer',
		description: '',
		modelProvider: 'faux',
		modelId: 'botd-worker',
		enabledSkills: [],
		enabledExtensions: [],
		updatedAt: new Date().toISOString(),
	});
	db.createSession({ id: 'sess_pr', title: 'PR watch', leadBotId: 'reviewer', ownerId: 'user-1' });
	const trigger = db.createTrigger({
		id: 'trg_pr',
		sessionId: 'sess_pr',
		ownerId: 'user-1',
		name: 'pr hook',
		botId: 'reviewer',
		kind: 'webhook',
		token: 'tok-pr-42',
		prompt: 'review the PR',
		enabled: true,
	});

	// 订阅 Worker：Durable 会话登记进 ThreadSubscriptionsDoc（github:pr:team4u/botd#42）
	const workerConversation = await runtime.harness.createConversation(
		{ ownership: { kind: 'ownerless' } },
		BACKGROUND_CONTEXT,
	);
	const workerId = String(workerConversation.id);
	await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(ThreadSubscriptionsDoc);
		doc.subs['github:pr:team4u/botd#42'] = [workerId];
	}, BACKGROUND_CONTEXT);

	// Router 侧零调用的证据：faux 队列为空——任何 Router LLM 调用都会因队列为空报 model_error
	env.faux.setResponses([]);
	const routerTurnsBefore = env.faux.state.callCount;

	const service = new TriggerService(db, router, undefined, {
		sseHub,
		shouldUseDurable: () => true,
		getDurableRuntime: async () => runtime,
	});

	const payload = JSON.stringify({
		action: 'synchronize',
		repository: { full_name: 'team4u/botd' },
		pull_request: { number: 42 },
	});
	const result = await service.processWebhook('tok-pr-42', async () => payload, (name) =>
		name === 'x-github-event' ? 'pull_request' : undefined,
	);

	assert.equal(result.status, 200);
	assert.equal(result.body.passthrough, true, `webhook must pass through (got ${JSON.stringify(result.body)})`);
	assert.equal(result.body.threadKey, 'github:pr:team4u/botd#42');
	assert.deepEqual(result.body.deliveredTo, [workerId]);
	assert.equal(env.faux.state.callCount, routerTurnsBefore, 'passthrough must consume 0 Router LLM calls');

	// Worker 会话收到直通投递（含触发器署名的唤醒文本）
	await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
	const page = await workerConversation.entries({ order: 'ascending' }, 20, undefined, BACKGROUND_CONTEXT);
	const userInputs = page.items
		.map((e) => e.model?.[0] as { role?: string; content?: unknown } | undefined)
		.filter((m) => m?.role === 'user')
		.map((m) => (typeof m!.content === 'string' ? m!.content : ''));
	assert.ok(
		userInputs.some((c) => c.includes('[Trigger "pr hook" (@reviewer)]')),
		'the subscribed worker conversation must receive the passthrough wakeup',
	);

	// 未订阅线程照常走 Router 唤醒路径（响应体不带 passthrough）
	service.webhookGuard.resetRateLimit(trigger.id);
	const payload2 = JSON.stringify({
		action: 'opened',
		repository: { full_name: 'team4u/botd' },
		pull_request: { number: 43 },
	});
	const result2 = await service.processWebhook('tok-pr-42', async () => payload2, (name) =>
		name === 'x-github-event' ? 'pull_request' : undefined,
	);
	assert.equal(result2.status, 200);
	assert.equal(result2.body.passthrough, undefined, 'unsubscribed threads keep the legacy wakeup response');
});

test('4. deriveWebhookThreadKey: GitHub conventions, shorthand fields and explicit threadKey', () => {
	// GitHub 原生约定：repository.full_name + pull_request.number
	assert.equal(
		deriveWebhookThreadKey({
			source: 'github',
			eventType: 'pull_request.opened',
			parsedObject: { repository: { full_name: 'team4u/botd' }, pull_request: { number: 42 } },
		}),
		'github:pr:team4u/botd#42',
	);
	// issue 线程
	assert.equal(
		deriveWebhookThreadKey({
			source: 'github',
			eventType: 'issue_comment.created',
			parsedObject: { repository: { full_name: 'team4u/botd' }, issue: { number: 7 } },
		}),
		'github:issue:team4u/botd#7',
	);
	// 简写约定
	assert.equal(
		deriveWebhookThreadKey({ source: 'github', eventType: 'x', parsedObject: { repo: 'a/b', prNumber: 3 } }),
		'github:pr:a/b#3',
	);
	// 显式 threadKey 优先
	assert.equal(
		deriveWebhookThreadKey({ source: 'slack', eventType: 'e', parsedObject: { threadKey: ' im:thread:c:t ' } }),
		'im:thread:c:t',
	);
	// 无法推导
	assert.equal(deriveWebhookThreadKey({ source: 'github', eventType: 'push', parsedObject: { ref: 'refs/heads/main' } }), undefined);
	assert.equal(deriveWebhookThreadKey({ source: 'webhook', eventType: 'webhook.received' }), undefined);
});
