/**
 * Chain of Recall pure-index + long-report spill tests.
 *
 * The recall index (`RecallIndexDoc`) is a pure index: worker reports split by
 * length at completion — short answers ride inline in the notification in
 * full (the Router reads them with zero extra tool calls), long ones spill to
 * `<cwd>/.botd/recall/<workerId>.md` and every consumer (`recall` tool, the
 * hub runtime, the API) follows the pointer to the real body.
 *
 *  1. short report: full inline notification, no spill marker, index stays a
 *     catalog card (contentPreview <= 800);
 *  2. long report: spill file on disk with the complete body, notification
 *     carries preview + pointer, node records spillPath/spillBytes;
 *  3. recall returns the real body — spill file first, worker transcript as
 *     the fallback (spill file removed), preview as the last resort;
 *  4. spill failure (unwritable cwd): degrade to 4000-char inline + note,
 *     never drop the report;
 *  5. unit edges: content cap and assistant-entry extraction.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";

import { HubDurableRuntime, type BotPersonaConfig } from "../apps/hub/src/harness/hub-harness.js";
import {
	assistantEntryText,
	capRecallContent,
	RECALL_CONTENT_LIMIT,
} from "../apps/hub/src/harness/recall-content.js";

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

const persona = (botId: string, cwd: string): BotPersonaConfig => ({
	botId,
	name: botId,
	model: { provider: "faux", modelId: "main" },
	instructions: "You design systems.",
	nodeId: "node-1",
	cwd,
});

async function openRuntime(cwd: string): Promise<{ runtime: HubDurableRuntime; faux: ReturnType<typeof fauxProvider> }> {
	const faux = fauxProvider({ models: [{ id: "main" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = await HubDurableRuntime.open({
		storage: new MemoryStorage(),
		models,
		workerAgent: () => ({}),
	});
	runtime.registerPersona(persona("architect", cwd));
	return { runtime, faux };
}

/** The worker-completion notification text from the router transcript ("" until it lands). */
async function notificationOf(router: { context: (context: typeof BACKGROUND_CONTEXT) => Promise<{ messages: readonly { role: string; content: unknown }[] }> }): Promise<string> {
	const ctx = await router.context(BACKGROUND_CONTEXT);
	const message = [...ctx.messages]
		.reverse()
		.find((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Worker Completed:"));
	return typeof message?.content === "string" ? message.content : "";
}

/** Pull `w-...` out of a text like "[Worker Completed: w-1-17 | title]". */
function extractWorkerId(text: string): string {
	const match = text.match(/w-\d+-\d+/);
	if (match === null) throw new Error(`no worker id in prompt: ${text}`);
	return match[0];
}

// ---------------------------------------------------------------------------
// 1. 短报告内联：完整正文进通知，索引保持目录卡片
// ---------------------------------------------------------------------------

test("1. short worker report rides inline in full; recall index stays a catalog card", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "botd-recall-inline-"));
	const { runtime, faux } = await openRuntime(dir);
	try {
		const router = await runtime.ensureBotMainSession("architect");
		const SHORT = "Auth tests written: 12 files, coverage 94%, zero regressions.";

		scriptRouter(faux, (ctx) => {
			const text = lastUserText(ctx.messages);
			if (/Write the auth test suite/.test(text)) return fauxAssistantMessage(SHORT);
			if (/\[Worker Completed:/.test(text)) return fauxAssistantMessage("The test worker finished.");
			if (/please write the auth tests/.test(text) && !ctx.messages.some((m) => m.role === "toolResult")) {
				return fauxAssistantMessage(
					[fauxToolCall("spawn_worker", { title: "write tests", task: "Write the auth test suite." })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Started the test worker.");
		});

		await (await runtime.submitUserMessage(String(router.id), "please write the auth tests")).wait(BACKGROUND_CONTEXT);

		const completed = await waitFor(
			async () => (await runtime.getActiveWorkers(String(router.id)))[0],
			(w) => w?.status === "completed",
			"short-report worker completion",
		);
		const workerId = completed.workerId;

		// The notification carries the FULL body inline: no extra tool call needed.
		const notification = await waitFor(() => notificationOf(router), (n) => n !== "", "short-report notification");
		assert.ok(notification.includes(SHORT), "notification must inline the complete short report");
		assert.ok(!notification.includes("[Spilled"), "short report must not spill");
		assert.ok(!notification.includes("[Spill failed"), "short report must not hit the spill fallback");
		assert.ok(
			notification.includes(`(Use recall({ id: "${workerId}" })`),
			"notification must keep the recall reference line",
		);

		// The index node is a pure catalog card: preview <= 800, no spill pointer.
		const index = await runtime.recallIndex();
		const node = index?.nodes[workerId];
		assert.ok(node, "worker indexed in recall");
		assert.ok((node.contentPreview?.length ?? 0) <= 800, "contentPreview must stay a catalog card (<=800)");
		assert.ok(node.contentPreview.includes("coverage 94%"), "preview still identifies the report");
		assert.equal(node.spillPath, undefined, "short report never spills");
		assert.equal(node.spillBytes, undefined);
		assert.ok((node.summary?.length ?? 0) <= 160, "summary stays one line");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// 2. 长报告落盘：完整正文进文件，通知带指针，索引带 spillPath
// ---------------------------------------------------------------------------

test("2. long worker report spills to <cwd>/.botd/recall/<workerId>.md", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "botd-recall-spill-"));
	const { runtime, faux } = await openRuntime(dir);
	try {
		const router = await runtime.ensureBotMainSession("architect");
		const LONG = `LONG-MARKER-HEAD\n${"x".repeat(5000)}\nLONG-MARKER-TAIL`;

		scriptRouter(faux, (ctx) => {
			const text = lastUserText(ctx.messages);
			if (/Write the deep report/.test(text)) return fauxAssistantMessage(LONG);
			if (/\[Worker Completed:/.test(text)) return fauxAssistantMessage("Noted the deep report.");
			if (/please write the deep report/.test(text) && !ctx.messages.some((m) => m.role === "toolResult")) {
				return fauxAssistantMessage(
					[fauxToolCall("spawn_worker", { title: "deep report", task: "Write the deep report." })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Started the deep report worker.");
		});

		await (await runtime.submitUserMessage(String(router.id), "please write the deep report")).wait(BACKGROUND_CONTEXT);

		const completed = await waitFor(
			async () => (await runtime.getActiveWorkers(String(router.id)))[0],
			(w) => w?.status === "completed",
			"long-report worker completion",
		);
		const workerId = completed.workerId;

		// Notification: 1500-char preview + pointer line, never the full body.
		const notification = await waitFor(() => notificationOf(router), (n) => n !== "", "long-report notification");
		assert.ok(notification.includes("[Spilled"), "notification must carry the spill pointer line");
		assert.ok(
			notification.includes(`[Spilled ${LONG.length} chars -> full report: `),
			"spill pointer names the char count and file",
		);
		assert.ok(!notification.includes("LONG-MARKER-TAIL"), "notification must not inline the full body");
		assert.ok(notification.includes(LONG.slice(0, 1500)), "notification carries the 1500-char preview");

		// The index node points at the spilled file.
		const index = await runtime.recallIndex();
		const node = index?.nodes[workerId];
		assert.ok(node, "worker indexed in recall");
		const expectedPath = path.join(dir, ".botd", "recall", `${workerId}.md`);
		assert.equal(node.spillPath, expectedPath, "node.spillPath must point at the spill file");
		assert.equal(node.spillBytes, Buffer.byteLength(LONG, "utf8"), "node.spillBytes records the file size");
		assert.ok((node.contentPreview?.length ?? 0) <= 800, "contentPreview must stay <=800 even for a spilled report");
		assert.equal(node.contentPreview, LONG.slice(0, 800), "preview is the capped head of the report");

		// The file on disk holds the complete report.
		const spilled = await readFile(expectedPath, "utf8");
		assert.equal(spilled, LONG, "spill file must contain the complete report");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// 3. recall 顺指针取真正文：spill 文件 → worker 会话 → 目录卡片
// ---------------------------------------------------------------------------

test("3. recall follows the pointer: spill file, then worker transcript fallback", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "botd-recall-full-"));
	const { runtime, faux } = await openRuntime(dir);
	try {
		const router = await runtime.ensureBotMainSession("architect");
		const LONG = `FULL-MARKER-HEAD\n${"y".repeat(5000)}\nFULL-MARKER-TAIL`;

		scriptRouter(faux, (ctx) => {
			const text = lastUserText(ctx.messages);
			if (/\[Worker Completed:/.test(text)) {
				// The report turn: first round calls recall, second round acks the result.
				if (!toolResultThisTurn(ctx.messages)) {
					return fauxAssistantMessage(
						[fauxToolCall("recall", { id: extractWorkerId(text) })],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("RECALL-ACKED");
			}
			if (/Write the long task/.test(text)) return fauxAssistantMessage(LONG);
			if (/run the long task/.test(text) && !ctx.messages.some((m) => m.role === "toolResult")) {
				return fauxAssistantMessage(
					[fauxToolCall("spawn_worker", { title: "long task", task: "Write the long task report." })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Started.");
		});

		await (await runtime.submitUserMessage(String(router.id), "run the long task")).wait(BACKGROUND_CONTEXT);

		const completed = await waitFor(
			async () => (await runtime.getActiveWorkers(String(router.id)))[0],
			(w) => w?.status === "completed",
			"long-task worker completion",
		);
		const workerId = completed.workerId;

		// The router's recall tool result (via the router transcript) holds the full
		// body from the spill file — not the 800-char catalog preview.
		// Poll until the recall turn settles: under concurrent test load the
		// report-triggered round may still be mid-flight (its toolCall shows up as a
		// synthesized "Tool result unavailable" placeholder), so an immediate read races.
		const ctx = await waitFor(
			() => router.context(BACKGROUND_CONTEXT),
			(view) =>
				view.messages.some(
					(m) =>
						m.role === "assistant" &&
						JSON.stringify(m.content).includes("RECALL-ACKED"),
			),
			"router recall round to settle",
		);
		const toolResultText = ctx.messages
			.filter((m) => m.role === "toolResult")
			.map((m) => JSON.stringify(m.content))
			.join("\n");
		assert.ok(toolResultText.includes("FULL-MARKER-TAIL"), "recall tool result must contain the full body");
		assert.ok(toolResultText.includes(`content: FULL-MARKER-HEAD`), "recall result keeps the content line format");
		assert.ok(
			ctx.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("RECALL-ACKED")),
			"router must finish the recall turn",
		);

		// Runtime-layer recall resolves the same way (spill file).
		const recalled = (await runtime.recall(workerId)) as { fullContent?: string; notice?: string; spillPath?: string };
		assert.ok(recalled.spillPath !== undefined, "runtime recall keeps the node fields");
		assert.equal(recalled.fullContent, LONG, "runtime recall fullContent is the complete report");
		assert.equal(recalled.notice, undefined, "no notice while the spill file is readable");

		// Spill file gone (disk cleaned): recall degrades to the worker transcript,
		// which still holds the full final answer, and reports the unreadable file.
		await unlink(recalled.spillPath!);
		const degraded = (await runtime.recall(workerId)) as { fullContent?: string; notice?: string };
		assert.ok((degraded.notice ?? "").includes("spill file unreadable"), "recall reports the unreadable spill file");
		assert.equal(degraded.fullContent, LONG, "recall falls back to the worker transcript full answer");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// 4. 落盘失败降级：内联前 4000 字 + 注记，绝不丢汇报
// ---------------------------------------------------------------------------

test("4. unwritable spill cwd degrades to 4000-char inline + note, never drops the report", { timeout: 60_000 }, async () => {
	// /proc/self/cmdline is a file: mkdir under it fails with ENOTDIR even for root.
	const { runtime, faux } = await openRuntime("/proc/self/cmdline");
	try {
		const router = await runtime.ensureBotMainSession("architect");
		const LONG = `DEGRADE-MARKER-HEAD\n${"z".repeat(5000)}\nDEGRADE-MARKER-TAIL`;

		scriptRouter(faux, (ctx) => {
			const text = lastUserText(ctx.messages);
			if (/Write the report/.test(text)) return fauxAssistantMessage(LONG);
			if (/\[Worker Completed:/.test(text)) return fauxAssistantMessage("Noted the degraded report.");
			if (/please write the report/.test(text) && !ctx.messages.some((m) => m.role === "toolResult")) {
				return fauxAssistantMessage(
					[fauxToolCall("spawn_worker", { title: "report", task: "Write the report." })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Started.");
		});

		await (await runtime.submitUserMessage(String(router.id), "please write the report")).wait(BACKGROUND_CONTEXT);

		// The report lands (completed) despite the unusable cwd: no throw, no loss.
		const completed = await waitFor(
			async () => (await runtime.getActiveWorkers(String(router.id)))[0],
			(w) => w?.status === "completed",
			"degraded-report worker completion",
		);
		const workerId = completed.workerId;

		const notification = await waitFor(() => notificationOf(router), (n) => n !== "", "degraded-report notification");
		assert.ok(notification.includes("[Spill failed:"), "notification must carry the spill-failure note");
		assert.ok(notification.includes("DEGRADE-MARKER-HEAD"), "notification inlines the first 4000 chars");
		assert.ok(notification.includes(LONG.slice(0, 4000)), "the inline prefix is the first 4000 chars");
		assert.ok(!notification.includes("DEGRADE-MARKER-TAIL"), "nothing beyond the inline prefix leaks");
		assert.ok(!notification.includes("[Spilled "), "no spill pointer on failure");

		// The index node stays a pure card without a spill pointer.
		const index = await runtime.recallIndex();
		const node = index?.nodes[workerId];
		assert.ok(node, "worker indexed in recall");
		assert.equal(node.spillPath, undefined, "failed spill leaves no pointer");
		assert.ok((node.contentPreview?.length ?? 0) <= 800, "preview still capped");
	} finally {
		await runtime.close();
	}
});

// ---------------------------------------------------------------------------
// 5. 单元边界：内容截断与 assistant 文本提取
// ---------------------------------------------------------------------------

test("5. capRecallContent caps at 24k with a pointer line; assistantEntryText extracts text blocks", { timeout: 60_000 }, () => {
	const node = { id: "w-1-1", kind: "worker" as const, title: "t", summary: "s", contentPreview: "p", relatedIds: [], createdAt: 0, spillPath: "/tmp/spill.md" };
	const short = capRecallContent("hello", node);
	assert.equal(short, "hello");

	const long = "a".repeat(RECALL_CONTENT_LIMIT + 5);
	const capped = capRecallContent(long, node);
	assert.ok(capped.startsWith("a".repeat(RECALL_CONTENT_LIMIT)));
	assert.ok(capped.includes(`[truncated: full content at /tmp/spill.md]`), "cap points at the spill file");
	assert.ok(!capped.includes("aaaaa]"), "cap keeps only the allowed prefix");

	const nodeNoSpill = { ...node, spillPath: undefined, conversationId: "42" };
	const cappedConv = capRecallContent(long, nodeNoSpill);
	assert.ok(cappedConv.includes("[truncated: full content at 42]"), "cap falls back to the conversation id");

	assert.equal(assistantEntryText(undefined), "");
	assert.equal(
		assistantEntryText({ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }),
		"a\nb",
	);
	assert.equal(
		assistantEntryText({ kind: "pi.assistant", model: [{ role: "user", content: "not assistant" }] }),
		"",
		"non-assistant entries extract nothing",
	);
});
