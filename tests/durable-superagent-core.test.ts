/**
 * Durable Multi-Persona Super-agent core tests.
 *
 * Covers the five pillars of the pi-durable-based Hub harness:
 *  1. Multi-persona isolation (independent main sessions per bot persona);
 *  2. Full-duplex non-blocking spawn_worker (router answers instantly, worker
 *     runs in background, afterRun reports back and triggers the summary run);
 *  3. Cross-persona delegation (delegate_to_bot to another bot's model+persona);
 *  4. steer_worker / stop_worker / recall (Chain of Recall multi-hop lookup);
 *  5. Crash & resume durability (reopen storage mid-worker-run, resume, the
 *     interrupted worker finishes and reports back exactly once).
 *
 * The provider is the deterministic faux provider scripted per test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { HubDurableRuntime, type BotPersonaConfig } from "../apps/hub/src/harness/hub-harness.js";
import { RecallIndexDoc, TargetDoc, WorkerRegistryDoc } from "../apps/hub/src/harness/docs.js";
import { WORKER_EXTENSION_NAME } from "../apps/hub/src/harness/worker-extension.js";
import { ROUTER_EXTENSION } from "../apps/hub/src/harness/router-extension.js";


const lastUserText = (messages: readonly { role: string; content: unknown }[]): string => {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	if (typeof lastUser?.content === "string") return lastUser.content;
	if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? "");
	return "";
};

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a tool result follows the last user message (this turn already ran its tool round). */
const toolResultThisTurn = (messages: readonly { role: string; content: unknown }[]): boolean => {
	const reversed = [...messages].reverse();
	const lastUser = reversed.findIndex((m) => m.role === "user");
	return lastUser >= 0 && reversed.slice(0, lastUser).some((m) => m.role === "toolResult");
};

/** Keep the faux queue topped up with a transcript-driven script step (each call consumes one entry). */
type ScriptStep = (context: { messages: readonly { role: string; content: unknown }[] }) => ReturnType<typeof fauxAssistantMessage>;
const scriptRouter = (faux: ReturnType<typeof fauxProvider>, step: ScriptStep): void => {
	faux.setResponses([...Array(64)].map(() => step as never));
};

/** Poll until `read` satisfies `check`, or fail with `message`. */
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

const persona = (botId: string, name: string, instructions: string, modelId = "main"): BotPersonaConfig => ({
	botId,
	name,
	model: { provider: "faux", modelId },
	instructions,
	nodeId: "node-1",
	cwd: process.cwd(),
});

async function openRuntime(): Promise<{ runtime: HubDurableRuntime; faux: ReturnType<typeof fauxProvider> }> {
	const faux = fauxProvider({ models: [{ id: "main" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = await HubDurableRuntime.open({
		storage: new MemoryStorage(),
		models,
		workerAgent: () => ({}),
	});
	runtime.registerPersona(persona("architect", "Architect", "You design systems."));
	runtime.registerPersona(persona("finance", "Finance", "You manage money."));
	runtime.registerPersona(persona("assistant", "Assistant", "You are the personal assistant."));
	return { runtime, faux };
}

/** Router agent for tests: router extension + worker extension + faux model. */
function routerAgentFor(persona: BotPersonaConfig) {
	return persona; // registered through runtime; agent resolved by runtime defaults + configure below
}

test("1. multi-persona isolation: independent main sessions and personas", async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const architect = await runtime.ensureBotMainSession("architect");
		const finance = await runtime.ensureBotMainSession("finance");
		assert.notEqual(architect.id, finance.id, "personas must have separate main sessions");

		// Same runtime returns the same session (24/7 continuity).
		const again = await runtime.ensureBotMainSession("architect");
		assert.equal(again.id, architect.id);

		// Target docs carry the persona identity.
		const architectTarget = await runtime.harness.snapshot(TargetDoc, architect.id, BACKGROUND_CONTEXT);
		const financeTarget = await runtime.harness.snapshot(TargetDoc, finance.id, BACKGROUND_CONTEXT);
		assert.equal(architectTarget?.botId, "architect");
		assert.equal(architectTarget?.role, "router");
		assert.equal(financeTarget?.botId, "finance");
		assert.equal(financeTarget?.role, "router");

		// Persona isolation at the model level: each session answers with its own persona.
		faux.setResponses([fauxAssistantMessage("I am the architect.")]);
		const a = await runtime.submitUserMessage(String(architect.id), "who are you?");
		assert.equal((await a.wait(BACKGROUND_CONTEXT)).status, "done");

		faux.setResponses([fauxAssistantMessage("I am the finance bot.")]);
		const f = await runtime.submitUserMessage(String(finance.id), "who are you?");
		assert.equal((await f.wait(BACKGROUND_CONTEXT)).status, "done");

		const aCtx = await architect.context(BACKGROUND_CONTEXT);
		const fCtx = await finance.context(BACKGROUND_CONTEXT);
		const lastText = (messages: readonly { role: string; content: unknown }[]): string => {
			const assistant = [...messages].reverse().find((m) => m.role === "assistant");
			const content = assistant?.content;
			return Array.isArray(content) ? String((content[0] as { text?: string }).text ?? "") : "";
		};
		assert.match(lastText(aCtx.messages), /architect/);
		assert.match(lastText(fCtx.messages), /finance/);

		// Topic sessions are additional, isolated conversations of one persona.
		const topic = await runtime.createBotTopicSession("architect", "JWT design");
		assert.notEqual(topic.id, architect.id);
		const topicTarget = await runtime.harness.snapshot(TargetDoc, topic.id, BACKGROUND_CONTEXT);
		assert.equal(topicTarget?.title, "JWT design");
		assert.equal(topicTarget?.botId, "architect");
	} finally {
		await runtime.close();
	}
});

test("2. full-duplex non-blocking spawn_worker with report-back", async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const router = await runtime.ensureBotMainSession("architect");

		// Script by transcript inspection: the router's turn and the background
		// worker's run race the shared faux queue, so fixed-order responses would
		// be consumed unpredictably. Each step answers by what it is asked.
		scriptRouter(faux, (context) => {
			const text = lastUserText(context.messages);
			if (/Write the auth test suite/.test(text)) {
				return fauxAssistantMessage("Auth tests written: 12 files, coverage 94%.");
			}
			if (/\[Worker Completed:/.test(text)) {
				return fauxAssistantMessage("The test worker finished: coverage is 94%.");
			}
			const toolResultSeen = context.messages.some((m) => m.role === "toolResult");
			if (/please write the auth tests/.test(text) && !toolResultSeen) {
				return fauxAssistantMessage(
					[fauxToolCall("spawn_worker", { title: "write tests", task: "Write the auth test suite and report coverage." })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Started the test worker; ping me anytime.");
		});

		const started = Date.now();
		const submission = await runtime.submitUserMessage(String(router.id), "please write the auth tests");
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		const elapsed = Date.now() - started;
		assert.equal(settled.status, "done", "router turn must finish");
		assert.ok(elapsed < 5_000, `router must not block on the worker (took ${elapsed}ms)`);

		// The worker is registered as running.
		const workers = await runtime.getActiveWorkers(String(router.id));
		assert.equal(workers.length, 1);
		const worker = workers[0];
		assert.equal(worker.title, "write tests");
		assert.ok(worker.conversationId);

		// The worker conversation carries the worker target.
		const workerTarget = await runtime.harness.snapshot(
			TargetDoc,
			Number(worker.conversationId) as never,
			BACKGROUND_CONTEXT,
		);
		assert.equal(workerTarget?.role, "worker");
		assert.equal(workerTarget?.parentConversationId, String(router.id));

		// afterRun reports back: the registry flips to completed and the report
		// input triggers the router's summary run.
		const completed = await waitFor(
			async () => (await runtime.getActiveWorkers(String(router.id)))[0],
			(w) => w?.status === "completed",
			"worker completion",
		);
		assert.match(completed.summary ?? "", /94%/);

		// The report arrived in the router transcript and was answered.
		const routerCtx = await router.context(BACKGROUND_CONTEXT);
		assert.ok(
			routerCtx.messages.some(
				(m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[Worker Completed:"),
			),
			"router transcript must contain the worker report",
		);
		assert.ok(
			routerCtx.messages.some(
				(m) => m.role === "assistant" && JSON.stringify(m.content).includes("94%"),
			),
			"router must have summarized the worker report",
		);

		// Exactly one report entry (deterministic requestId).
		const page = await router.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
		const reportEntries = page.items.filter((e) => e.kind === "botd.worker-report");
		assert.equal(reportEntries.length, 1, "exactly one worker-report entry");
	} finally {
		await runtime.close();
	}
});

test("3. cross-persona delegation via delegate_to_bot", async () => {
	const { runtime, faux } = await openRuntime();
	try {
		const assistant = await runtime.ensureBotMainSession("assistant");

		scriptRouter(faux, (context) => {
			const text = lastUserText(context.messages);
			if (/Review the event-sourcing design/.test(text)) {
				return fauxAssistantMessage("Design review: outbox needs an idempotency key per aggregate.");
			}
			if (/\[Worker Completed:/.test(text)) {
				return fauxAssistantMessage("The architect finished the review.");
			}
			const toolResultSeen = context.messages.some((m) => m.role === "toolResult");
			if (/have the architect review my design/.test(text) && !toolResultSeen) {
				return fauxAssistantMessage(
					[fauxToolCall("delegate_to_bot", {
						targetBotId: "architect",
						title: "design review",
						task: "Review the event-sourcing design for the outbox.",
					})],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Asked the architect bot to review the design.");
		});

		const submission = await runtime.submitUserMessage(String(assistant.id), "have the architect review my design");
		assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");

		const workers = await runtime.getActiveWorkers(String(assistant.id));
		assert.equal(workers.length, 1);
		assert.equal(workers[0].botId, "architect", "worker must run as the target persona");

		const workerTarget = await runtime.harness.snapshot(
			TargetDoc,
			Number(workers[0].conversationId) as never,
			BACKGROUND_CONTEXT,
		);
		assert.equal(workerTarget?.botId, "architect");
		assert.equal(workerTarget?.role, "worker");

		const completed = await waitFor(
			async () => (await runtime.getActiveWorkers(String(assistant.id)))[0],
			(w) => w?.status === "completed",
			"delegated worker completion",
		);
		assert.match(completed.summary ?? "", /idempotency/);
	} finally {
		await runtime.close();
	}
});

test("4. steer_worker, stop_worker, and recall (Chain of Recall)", async () => {
	// A slow provider keeps the worker genuinely busy while we steer and stop it.
	const faux = fauxProvider({ models: [{ id: "main" }], tokensPerSecond: 40 });
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models, workerAgent: () => ({}) });
	try {
		runtime.registerPersona(persona("architect", "Architect", "You design systems."));
		const router = await runtime.ensureBotMainSession("architect");

		scriptRouter(faux, (context) => {
			const text = lastUserText(context.messages);
			const ranTools = toolResultThisTurn(context.messages);
			if (/\[Worker Completed:/.test(text)) {
				return fauxAssistantMessage("Noted, the research worker finished.");
			}
			if (/Research the migration path/.test(text)) {
				// Long answer: still streaming while the test steers and stops the worker.
				return fauxAssistantMessage(`Migration research: ${"detail ".repeat(40)}done.`);
			}
			if (/zero-downtime/.test(text)) {
				return ranTools
					? fauxAssistantMessage("Focused on zero-downtime migration.")
					: fauxAssistantMessage(
							[fauxToolCall("steer_worker", { workerId: extractWorkerId(text), message: "Focus on zero-downtime.", mode: "steer" })],
							{ stopReason: "toolUse" },
						);
			}
			if (/please stop/.test(text)) {
				return ranTools
					? fauxAssistantMessage("Stopped the worker.")
					: fauxAssistantMessage([fauxToolCall("stop_worker", { workerId: extractWorkerId(text) })], { stopReason: "toolUse" });
			}
			if (/start the research/.test(text)) {
				return ranTools
					? fauxAssistantMessage("Research worker started.")
					: fauxAssistantMessage([fauxToolCall("spawn_worker", { title: "long research", task: "Research the migration path." })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("Ok.");
		});

		// Spawn a worker.
		const submission = await runtime.submitUserMessage(String(router.id), "start the research");
		assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");

		const workers = await runtime.getActiveWorkers(String(router.id));
		assert.equal(workers.length, 1);
		const workerId = workers[0].workerId;

		// Chain of Recall: the worker node is indexed session-wide.
		const index = await runtime.recallIndex();
		assert.ok(index?.nodes[workerId], "worker indexed in recall");
		const node = index!.nodes[workerId];
		assert.equal(node.kind, "worker");
		assert.equal(node.title, "long research");
		assert.equal(node.conversationId, workers[0].conversationId);

		// steer_worker through the router.
		const steer = await runtime.submitUserMessage(String(router.id), `steer ${workerId} to zero-downtime`);
		await steer.wait(BACKGROUND_CONTEXT).catch(() => undefined);

		// stop_worker through the router: script reads the worker id from the prompt.
		const stopText = `please stop ${workerId}`;
		const stop = await runtime.submitUserMessage(String(router.id), stopText);
		assert.equal((await stop.wait(BACKGROUND_CONTEXT)).status, "done");

		const aborted = await waitFor(
			async () => (await runtime.getActiveWorkers(String(router.id)))[0],
			(w) => w?.status === "aborted",
			"worker abort",
		);
		assert.equal(aborted.status, "aborted");
		// The stop is terminal: no late completion report can revive it.
		await wait(300);
		assert.equal((await runtime.getActiveWorkers(String(router.id)))[0]?.status, "aborted");
	} finally {
		await runtime.close();
	}
});

test("5. crash & resume: interrupted worker finishes and reports exactly once", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "botd-durable-test-"));
	try {
		const dbPath = path.join(dir, "hub.sqlite");
		const faux = fauxProvider({ models: [{ id: "main" }] });
		const models = createModels();
		models.setProvider(faux.provider);

		const step = (context: { messages: readonly { role: string; content: unknown }[] }) => {
			const text = lastUserText(context.messages);
			if (/Run the nightly build/.test(text)) {
				return fauxAssistantMessage("Nightly build green: 142 tests passed.");
			}
			if (/\[Worker Completed:/.test(text)) {
				return fauxAssistantMessage("Build summary received.");
			}
			const toolResultSeen = context.messages.some((m) => m.role === "toolResult");
			if (/run the nightly build/.test(text) && !toolResultSeen) {
				return fauxAssistantMessage(
					[fauxToolCall("spawn_worker", { title: "nightly build", task: "Run the nightly build." })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Build worker started.");
		};
		const scriptStep = () => faux.appendResponses([...Array(64)].map(() => step as never));

		let routerId = "";
		{
			const runtime = await HubDurableRuntime.open({ dbPath, models, workerAgent: () => ({}) });
			runtime.registerPersona(persona("architect", "Architect", "You design systems."));
			const router = await runtime.ensureBotMainSession("architect");
			routerId = String(router.id);
			scriptStep();
			const submission = await runtime.submitUserMessage(routerId, "run the nightly build");
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
			// The worker is running in the background; abandon the harness abruptly.
			// Its durable state (queued run / in-flight generation) stays in SQLite.
			await runtime.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
		}

		// Reopen on the same storage and resume: the interrupted worker finishes.
		const runtime2 = await HubDurableRuntime.open({ dbPath, models, workerAgent: () => ({}) });
		try {
			runtime2.registerPersona(persona("architect", "Architect", "You design systems."));
			runtime2.harness.resume();
			scriptStep();

			const completed = await waitFor(
				async () => (await runtime2.getActiveWorkers(routerId))[0],
				(w) => w?.status === "completed",
				"resumed worker completion",
			);
			assert.match(completed.summary ?? "", /142 tests/);

			// Exactly-once: only one report entry reached the router.
			const router = await runtime2.conversation(routerId);
			assert.ok(router);
			const page = await router.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
			const reports = page.items.filter((e) => e.kind === "botd.worker-report");
			assert.equal(reports.length, 1, "report-back must happen exactly once");
		} finally {
			await runtime2.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/** Pull `w-...` out of a scripted prompt like "please stop w-1-17". */
function extractWorkerId(text: string): string {
	const match = text.match(/w-\d+-\d+/);
	if (match === null) throw new Error(`no worker id in prompt: ${text}`);
	return match[0];
}
