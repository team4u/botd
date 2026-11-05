/**
 * Targeted regressions for the durable Router/Worker fixes:
 *
 *  1. `ask_human` called twice with the same prompt reuses the same askId
 *     (no duplicate pending asks) and returns the answer once resolved;
 *  2. `spawn_worker({ threadKey })` registers the worker conversation in
 *     `ThreadSubscriptionsDoc` (event passthrough) and `stop_worker` removes it;
 *  3. a background Worker has the `recall` tool, can recall a SpillStoreDoc id
 *     (`spill_xxx`, not in the recall index) and a worker id (durable spill copy
 *     of a long report), and sees its parent bot's subagents in its prompt.
 *
 * Provider is the scripted faux provider; no real LLM.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage, type Conversation } from "@earendil-works/pi-durable";

import { HubDurableRuntime, type BotPersonaConfig } from "../apps/hub/src/harness/hub-harness.js";
import { AskDoc, TargetDoc } from "../apps/hub/src/harness/docs.js";
import { SpillStoreDoc, ThreadSubscriptionsDoc } from "../apps/hub/src/harness/event-router.js";

const lastUserText = (messages: readonly { role: string; content: unknown }[]): string => {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	if (typeof lastUser?.content === "string") return lastUser.content;
	if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? "");
	return "";
};

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tool results after the last user message (this turn's completed tool calls). */
const toolResultsThisTurn = (messages: readonly { role: string; content: unknown }[]): Array<{ role: string; content: unknown }> => {
	const reversed = [...messages].reverse();
	const lastUser = reversed.findIndex((m) => m.role === "user");
	return lastUser >= 0 ? reversed.slice(0, lastUser).filter((m) => m.role === "toolResult") : [];
};

type ScriptStep = (context: { messages: readonly { role: string; content: unknown }[] }) => ReturnType<typeof fauxAssistantMessage>;
const scriptRouter = (faux: ReturnType<typeof fauxProvider>, step: ScriptStep): void => {
	faux.setResponses([...Array(64)].map(() => step as never));
};

async function waitFor<T>(read: () => Promise<T> | T, check: (value: T) => boolean, message: string, timeoutMs = 8_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T;
	for (;;) {
		last = await read();
		if (check(last)) return last;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${message}`);
		await wait(20);
	}
}

const persona = (botId: string, name: string, instructions: string, cwd: string): BotPersonaConfig => ({
	botId,
	name,
	model: { provider: "faux", modelId: "main" },
	instructions,
	nodeId: "node-1",
	cwd,
});

/** All toolResult texts of a conversation's transcript (newest-first window). */
async function toolResultTexts(conversation: Conversation): Promise<string> {
	const page = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
	return page.items
		.map((e) => e.model?.[0])
		.filter((m) => m !== undefined && m.role === "toolResult")
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
}

// ---------------------------------------------------------------------------
// 1. ask_human twice with the same prompt: one ask, answer returned on poll
// ---------------------------------------------------------------------------

test("1. ask_human with the same prompt twice reuses one ask and returns the answer once resolved", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "botd-ask-dedup-"));
	try {
		const faux = fauxProvider({ models: [{ id: "main" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models, workerAgent: () => ({}) });
		try {
			runtime.registerPersona(persona("architect", "Architect", "You design systems.", dir));
			const router = await runtime.ensureBotMainSession("architect");
			const PROMPT = "Roll out to production now?";

			scriptRouter(faux, (ctx) => {
				const text = lastUserText(ctx.messages);
				const askResults = toolResultsThisTurn(ctx.messages).length;
				if (/please confirm the deploy/.test(text)) {
					// Two sequential tool rounds asking the SAME question (a model
					// "polling" the ask in a new tool call): distinct tool tasks.
					if (askResults === 0) {
						return fauxAssistantMessage(
							[fauxToolCall("ask_human", { prompt: PROMPT, options: ["yes", "no"] })],
							{ stopReason: "toolUse" },
						);
					}
					if (askResults === 1) {
						return fauxAssistantMessage([fauxToolCall("ask_human", { prompt: PROMPT })], { stopReason: "toolUse" });
					}
					return fauxAssistantMessage("Waiting for the human.");
				}
				if (/poll the deploy ask/.test(text)) {
					if (toolResultsThisTurn(ctx.messages).length === 0) {
						return fauxAssistantMessage([fauxToolCall("ask_human", { prompt: PROMPT })], { stopReason: "toolUse" });
					}
					return fauxAssistantMessage("The human said yes.");
				}
				return fauxAssistantMessage("Ok.");
			});

			await (await runtime.submitUserMessage(String(router.id), "please confirm the deploy")).wait(BACKGROUND_CONTEXT);

			// Exactly one ask exists: the second call reused the first askId.
			const doc1 = await runtime.harness.snapshot(AskDoc, router.id, BACKGROUND_CONTEXT);
			const asks = Object.values(doc1?.asks ?? {});
			assert.equal(asks.length, 1, `ask_human twice with the same prompt must not duplicate asks (got ${asks.length})`);
			assert.equal(asks[0].status, "pending");
			const askId = asks[0].askId;

			// The hub (or test) resolves the ask.
			await runtime.harness.commit(async (tx) => {
				const doc = await tx.doc(AskDoc, router.id);
				const ask = doc.asks[askId];
				if (ask === undefined || ask.status !== "pending") throw new Error("ask missing or not pending");
				ask.status = "answered";
				ask.answer = "yes";
				ask.answeredAt = Date.now();
			}, BACKGROUND_CONTEXT);

			// A later ask_human with the same prompt returns the recorded answer.
			await (await runtime.submitUserMessage(String(router.id), "poll the deploy ask")).wait(BACKGROUND_CONTEXT);
			const results = await toolResultTexts(router);
			assert.match(results, /Human answered: yes/, "re-asking the resolved prompt must return the answer");

			// Still exactly one ask.
			const doc2 = await runtime.harness.snapshot(AskDoc, router.id, BACKGROUND_CONTEXT);
			assert.equal(Object.keys(doc2?.asks ?? {}).length, 1, "no new ask after the answered poll");
		} finally {
			await runtime.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// 2. spawn_worker threadKey -> ThreadSubscriptionsDoc; stop_worker unsubscribes
// ---------------------------------------------------------------------------

test("2. spawn_worker({ threadKey }) subscribes the worker in ThreadSubscriptionsDoc; stop_worker removes it", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "botd-thread-sub-"));
	try {
		// Slow streaming keeps the worker genuinely busy while the test stops it.
		const faux = fauxProvider({ models: [{ id: "main" }], tokensPerSecond: 40 });
		const models = createModels();
		models.setProvider(faux.provider);
		const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models, workerAgent: () => ({}) });
		try {
			runtime.registerPersona(persona("architect", "Architect", "You design systems.", dir));
			const router = await runtime.ensureBotMainSession("architect");
			const THREAD_KEY = "github:pr:botd#99";

			scriptRouter(faux, (ctx) => {
				const text = lastUserText(ctx.messages);
				if (/\[Worker Completed:/.test(text)) return fauxAssistantMessage("Noted the PR watch.");
				if (/Watch PR 99/.test(text)) {
					// Long answer: still streaming while the test stops the worker.
					return fauxAssistantMessage(`PR watch: ${"detail ".repeat(80)}done.`);
				}
				const ranTools = toolResultsThisTurn(ctx.messages).length > 0;
				if (/deploy the pr worker/.test(text) && !ranTools) {
					return fauxAssistantMessage(
						[fauxToolCall("spawn_worker", { title: "pr watch", task: "Watch PR 99.", threadKey: THREAD_KEY })],
						{ stopReason: "toolUse" },
					);
				}
				if (/please stop/.test(text) && !ranTools) {
					return fauxAssistantMessage(
						[fauxToolCall("stop_worker", { workerId: text.match(/w-\d+-\d+/)?.[0] ?? "" })],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Ok.");
			});

			await (await runtime.submitUserMessage(String(router.id), "deploy the pr worker")).wait(BACKGROUND_CONTEXT);
			const worker = await waitFor(
				async () => (await runtime.getActiveWorkers(String(router.id)))[0],
				(w) => w !== undefined,
				"worker registered",
			);

			// The worker's conversation is subscribed to its threadKey (event
			// passthrough), written inside the spawning commit.
			const subs = await waitFor(
				async () => await runtime.harness.snapshot(ThreadSubscriptionsDoc, BACKGROUND_CONTEXT),
				(doc) => (doc?.subs[THREAD_KEY] ?? []).includes(worker.conversationId),
				"worker subscription in ThreadSubscriptionsDoc",
			);
			assert.deepEqual(subs!.subs[THREAD_KEY], [worker.conversationId], "no duplicate subscriptions");

			// stop_worker through the router tool: the thread feed must stop.
			await (await runtime.submitUserMessage(String(router.id), `please stop ${worker.workerId}`)).wait(BACKGROUND_CONTEXT);
			await waitFor(
				async () => (await runtime.getActiveWorkers(String(router.id)))[0],
				(w) => w?.status === "aborted",
				"worker aborted",
			);
			const after = await runtime.harness.snapshot(ThreadSubscriptionsDoc, BACKGROUND_CONTEXT);
			assert.equal(
				(after?.subs[THREAD_KEY] ?? []).includes(worker.conversationId),
				false,
				"stop_worker must unsubscribe the worker conversation",
			);
			assert.equal(after?.subs[THREAD_KEY], undefined, "the empty subscription list is cleaned up");
		} finally {
			await runtime.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// 3. Worker: recall tool + spill id lookup + subagents prompt section
// ---------------------------------------------------------------------------

test("3. worker mounts recall (spill id + worker id) and lists its parent bot's subagents", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "botd-worker-recall-"));
	try {
		const faux = fauxProvider({ models: [{ id: "main" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		// No workerAgent override: the default factory gives the full worker stack
		// (CodingTools + SubagentWorkflow + botd-worker with recall + subagents section).
		const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
		try {
			runtime.registerPersona(persona("lead", "Lead", "You orchestrate work.", dir));
			runtime.registerPersona({
				...persona("reviewer", "Reviewer", "You review code carefully.", dir),
				parentBotId: "lead",
				description: "Careful code reviewer",
			});
			const router = await runtime.ensureBotMainSession("lead");

			const SPILL_ID = "spill_test01";
			const SPILL_CONTENT = `SPILL-HEAD\n${"payload ".repeat(60)}\nSPILL-TAIL`;
			const LONG = `LONG-MARKER-HEAD\n${"x".repeat(5000)}\nLONG-MARKER-TAIL`;
			let workerAId = "";
			/** System prompt sections shown to the worker (captured from the request context). */
			const workerPrompts: string[] = [];

			scriptRouter(faux, (ctx) => {
				const text = lastUserText(ctx.messages);
				// Worker A: the long report (spills to disk AND the durable SpillStore).
				if (/Run the long probe report/.test(text)) return fauxAssistantMessage(LONG);
				// Worker B: capture its prompt, then recall the spill id and worker A.
				if (/Probe recall/.test(text)) {
					const shown = new Map<string, string>();
					for (const m of ctx.messages) {
						if (m.role !== "system") continue;
						const sections = (m as { sections?: Record<string, string | null> }).sections;
						if (sections === undefined) continue;
						for (const [k, v] of Object.entries(sections)) {
							if (v === null) shown.delete(k);
							else shown.set(k, v);
						}
					}
					workerPrompts.push([...shown.values()].join("\n"));
					const ran = toolResultsThisTurn(ctx.messages).length;
					if (ran === 0) {
						return fauxAssistantMessage([fauxToolCall("recall", { id: SPILL_ID })], { stopReason: "toolUse" });
					}
					if (ran === 1 && workerAId !== "") {
						return fauxAssistantMessage([fauxToolCall("recall", { id: workerAId })], { stopReason: "toolUse" });
					}
					return fauxAssistantMessage("RECALL-PROBE-DONE");
				}
				if (/\[Worker Completed:/.test(text)) return fauxAssistantMessage("Noted the probe.");
				const ranTools = toolResultsThisTurn(ctx.messages).length > 0;
				if (/run the long probe/.test(text) && !ranTools) {
					return fauxAssistantMessage(
						[fauxToolCall("spawn_worker", { title: "long probe", task: "Run the long probe report." })],
						{ stopReason: "toolUse" },
					);
				}
				if (/probe recall now/.test(text) && !ranTools) {
					return fauxAssistantMessage(
						[fauxToolCall("spawn_worker", { title: "recall probe", task: "Probe recall for the test." })],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Ok.");
			});

			// A spilled event payload (as formatEventInlineAndSpill writes it).
			await runtime.harness.commit(async (tx) => {
				const doc = await tx.doc(SpillStoreDoc, SPILL_ID, { spillId: SPILL_ID, fullContent: SPILL_CONTENT });
				doc.fullContent = SPILL_CONTENT;
				doc.createdAt = Date.now();
			}, BACKGROUND_CONTEXT);

			// Worker A: long report -> completed.
			await (await runtime.submitUserMessage(String(router.id), "run the long probe")).wait(BACKGROUND_CONTEXT);
			const workerA = await waitFor(
				async () => (await runtime.getActiveWorkers(String(router.id)))[0],
				(w) => w?.status === "completed",
				"long-report worker completion",
			);
			workerAId = workerA.workerId;

			// The long report was also copied into the durable SpillStore (the disk
			// spill file may be unreachable when the worker ran on a remote Node).
			const durableSpill = await runtime.harness.snapshot(SpillStoreDoc, workerAId, BACKGROUND_CONTEXT);
			assert.ok(durableSpill, "long worker report must be copied into SpillStoreDoc");
			assert.equal(durableSpill!.fullContent, LONG, "the durable spill copy holds the complete report");

			// Worker B: has the recall tool, recalls the spill id and the worker id.
			await (await runtime.submitUserMessage(String(router.id), "probe recall now")).wait(BACKGROUND_CONTEXT);
			const workers = await waitFor(
				async () => await runtime.getActiveWorkers(String(router.id)),
				(list) => list.length === 2 && list.every((w) => w.status === "completed"),
				"recall-probe worker completion",
			);
			const workerB = workers.find((w) => w.title === "recall probe")!;

			// The worker agent carries the recall tool (mounted on botd-worker).
			const workerBConv = await runtime.conversation(workerB.conversationId);
			assert.ok(workerBConv, "worker B conversation exists");
			const workerBAgent = await workerBConv!.agent(BACKGROUND_CONTEXT);
			const toolNames = workerBAgent.tools.map((t) => t.name);
			assert.ok(toolNames.includes("recall"), `worker tools must include recall (got: ${toolNames.join(", ")})`);
			assert.ok(toolNames.includes("subagent"), "worker keeps the subagent tool");

			// Both recalls resolved from the worker's own tool calls.
			const results = await toolResultTexts(workerBConv!);
			assert.match(results, /SPILL-TAIL/, "worker recall(spill id) returns the spilled full content");
			assert.ok(!results.includes(`No recall node: ${SPILL_ID}`), "spill id must resolve even outside the recall index");
			assert.match(results, /LONG-MARKER-TAIL/, "worker recall(workerId) returns the full worker report");

			// The worker's prompt lists its parent bot's subagents.
			assert.ok(workerPrompts.length > 0, "worker prompt captured");
			const prompt = workerPrompts.at(-1)!;
			assert.match(prompt, /## Your Subagents \(same workspace\)/, "worker prompt must list its subagents");
			assert.match(prompt, /- reviewer \(Reviewer\): Careful code reviewer/, "the reviewer subagent is described");
			assert.match(prompt, /subagent\(\{ agentType: "<subagentId"/, "the subagent dispatch instructions ride along");

			// The runtime-level recall resolves the spill id too.
			const recalled = (await runtime.recall(SPILL_ID, BACKGROUND_CONTEXT)) as { fullContent?: string };
			assert.equal(recalled?.fullContent, SPILL_CONTENT, "runtime recall resolves a spill id");

			// Sanity: the worker ran as the lead bot (so reviewer is its subagent).
			const workerBTarget = await runtime.harness.snapshot(
				TargetDoc,
				Number(workerB.conversationId) as never,
				BACKGROUND_CONTEXT,
			);
			assert.equal(workerBTarget?.botId, "lead");
		} finally {
			await runtime.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});
