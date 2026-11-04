/**
 * Router layer of the Multi-Persona Super-agent (DeepSeek §2.1 + Full-Duplex §4.1).
 *
 * A Router conversation answers quick questions directly and dispatches any
 * multi-step coding/shell/long work to background workers via `spawn_worker`,
 * so the foreground conversation never blocks. Workers are their own durable
 * conversations: they survive crashes, and report back to the Router through
 * the `botd-worker` extension's afterRun machinery (see worker-extension.ts).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

import {
	configure,
	defineExtension,
	defineTool,
	section,
	type AgentChange,
	type ConversationId,
	type Extension,
} from "@earendil-works/pi-durable";
import {
	AskDoc,
	RecallIndexDoc,
	type RecallIndexState,
	TargetDoc,
	WorkerRegistryDoc,
	type WorkerEntry,
} from "./docs.js";

export const ROUTER_EXTENSION = "botd-router";
export const WORKER_EXTENSION = "botd-worker";

/** How the Router resolves the persona config of a bot (registered by HubDurableRuntime). */
export interface PersonaResolver {
	(botId: string): {
		botId: string;
		model: { provider: string; modelId: string };
		instructions: string;
		nodeId: string;
		cwd: string;
	} | undefined;
}

/** Resolves an agent change for a worker conversation (host hook, default: worker extension + CodingTools). */
export interface WorkerAgentFactory {
	(args: { botId: string; cwd?: string; threadKey?: string }): AgentChange;
}

const fallbackWorkerAgent: WorkerAgentFactory = ({ cwd }) => ({
	...(cwd === undefined ? {} : { cwd }),
});

/** Cap for `contentPreview` / `summary` strings stored in the recall index. */
// Branded ConversationId <-> string: documents store plain strings.
const toId = (value: string): ConversationId => {
	const numeric = Number(value);
	if (!Number.isInteger(numeric)) throw new Error(`invalid conversation id: ${value}`);
	return numeric as ConversationId;
};
const idToString = (id: ConversationId): string => String(id);
const conversationIdToString = idToString;
const stringToConversationId = toId;

const PREVIEW_LIMIT = 240;

export const preview = (text: string, limit = PREVIEW_LIMIT): string =>
	text.length <= limit ? text : `${text.slice(0, limit)}…`;

/** The shared `ask_human` tool (mounted on both Router and Worker extensions). */
export const askHumanTool = defineTool({
	name: "ask_human",
	description:
		"Ask the human a question and record it as a pending ask. The hub UI (or test) resolves it; " +
		"call `ask_human` again with the same prompt to poll its answer. Use previewType \"ui\" with a " +
		"botd.v1 JSON spec in previewContent to render a rich form card (TextInput props.secret masks " +
		"passwords and the answer is redacted into env vars, never stored in plaintext).",
	parameters: obj({
		prompt: str(),
		options: opt(arr(str())),
		previewType: opt(oneOf(["text", "code", "markdown", "ui"])),
		previewContent: opt(str()),
	}),
	replay: "safe",
	async execute(args, api, context) {
		let askId = "";
		const askedBy = String(api.taskId);
		await api.commit(async (tx) => {
			const doc = await tx.doc(AskDoc, api.conversationId);
			// Replay-safe: the ask records its creating tool task.
			const existing = Object.values(doc.asks).find((a) => a.askedBy === askedBy);
			if (existing !== undefined) {
				askId = existing.askId;
				return;
			}
			askId = `ask-${api.conversationId}-${Object.keys(doc.asks).length + 1}`;
			doc.asks[askId] = {
				askId,
				prompt: args.prompt,
				options: args.options ?? [],
				status: "pending",
				createdAt: api.now(),
				askedBy,
				...(args.previewType === undefined ? {} : { previewType: args.previewType }),
				...(args.previewContent === undefined ? {} : { previewContent: args.previewContent }),
			};
		}, context);
		const doc = await api.snapshot(AskDoc, api.conversationId, context);
		const ask = doc?.asks[askId];
		if (ask === undefined) throw new Error("ask disappeared");
		const optionsText =
			ask.options.length > 0 ? `\nOptions: ${ask.options.join(" / ")}` : "";
		return {
			output: [
				{
					type: "text",
					text:
						ask.status === "answered"
							? `Human answered: ${ask.answer}`
							: `Asked the human [${ask.askId}]: ${ask.prompt}${optionsText} — status: ${ask.status}`,
				},
			],
			};
	},
});

const listWorkers = (registry: { workers: Record<string, WorkerEntry> }): WorkerEntry[] =>
	Object.values(registry.workers).sort((a, b) => b.startedAt - a.startedAt);

/** A Router's persona prompt, rendered from its TargetDoc + persona config. */
function renderPersona(
	target: { botId: string; role: string; title?: string; threadKeys: string[] },
	persona: ReturnType<PersonaResolver> | undefined,
): string {
	const lines = [
		`You are the "${target.botId}" bot persona, running as a full-duplex Router.`,
		`Role: ${target.role}.`,
	];
	if (target.title !== undefined) lines.push(`Session: ${target.title}`);
	if (target.threadKeys.length > 0) lines.push(`Threads: ${target.threadKeys.join(", ")}`);
	if (persona !== undefined) {
		lines.push("", "## Persona instructions", persona.instructions || "(none)");
		lines.push("", `Default model: ${persona.model.provider}/${persona.model.modelId}`);
		lines.push(`Node: ${persona.nodeId} — cwd: ${persona.cwd}`);
	}
	lines.push(
		"",
		"## How to route work",
		"- Quick questions and short answers: answer directly in this conversation; never spawn a worker for them.",
		"- Multi-step coding, shell, research, or long-running work: call `spawn_worker` and answer the user at once with the worker id.",
		"- Work for another persona: call `delegate_to_bot`; it runs as that bot in the background.",
		"- While a worker runs, keep chatting: `steer_worker` redirects it, `stop_worker` cancels it, `recall({ id })` loads its results.",
		"- When a worker finishes it reports back here automatically; summarize its report for the user.",
	);
	return lines.join("\n");
}

/** Compact inline summary of active and recently finished workers. */
function renderWorkers(registry: { workers: Record<string, WorkerEntry> }): string {
	const workers = listWorkers(registry);
	if (workers.length === 0) return "No background workers.";
	const lines = workers.slice(0, 12).map((worker) => {
		const where = worker.status === "running" ? "running" : worker.status;
		const summary = worker.summary === undefined ? "" : ` — ${preview(worker.summary, 80)}`;
		return `- ${worker.workerId} [${where}] ${worker.title}${summary}`;
	});
	if (workers.length > lines.length) lines.push(`… ${workers.length - lines.length} more`);
	return lines.join("\n");
}

export function createRouterExtension(options: {
	resolvePersona: PersonaResolver;
	workerAgent?: WorkerAgentFactory;
}): Extension {
	const workerAgent = options.workerAgent ?? fallbackWorkerAgent;

	const spawnWorker = defineTool({
		name: "spawn_worker",
		description:
			"Spawn a background worker conversation for multi-step work and return immediately. " +
			"The worker runs the task with full coding tools and reports back when done; " +
			"the foreground conversation stays free for the user.",
		parameters: obj({
			title: str({ description: "Short task title shown in the worker list" }),
			task: str({ description: "Full task instructions for the worker" }),
			forkContext: opt(bool({ description: "Fork this conversation's context into the worker (default true)" })),
			threadKey: opt(str({ description: "Channel thread key the worker feeds" })),
			cwd: opt(str({ description: "Working directory for the worker" })),
			worktree: opt(bool({ description: "Give the worker an isolated git worktree" })),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const forkContext = args.forkContext !== false;
			let workerId = "";
			let conversationId = "";
			let title = args.title;

			const spawnedBy = String(api.taskId);
			await api.commit(async (tx) => {
				// Replay-safe without in-commit memos (a memo write is its own commit and
				// would deadlock the line this commit holds): the registry entry records
				// the spawning tool task, so a crash-rerun finds the same worker.
				const registryBefore = await tx.doc(WorkerRegistryDoc, api.conversationId);
				const existing = Object.values(registryBefore.workers).find((w) => w.spawnedBy === spawnedBy);
				if (existing !== undefined) {
					workerId = existing.workerId;
					conversationId = existing.conversationId;
					title = existing.title;
					return;
				}

				const target = await tx.doc(TargetDoc, api.conversationId);
				const cwd = args.cwd ?? target.cwd;
				const agent = workerAgent({
					botId: target.botId,
					cwd: cwd === "" ? undefined : cwd,
					threadKey: args.threadKey,
				});

				// 1. Create the worker conversation. With context forking, fork at the
				//    latest entry; otherwise create a fresh conversation owned by this
				//    conversation (so an ordinary router abort does not kill background
				//    work; only abort({ background: true }) reaches it).
				let record;
				if (forkContext) {
					const latest = await tx.latestEntryId(api.conversationId);
					record =
						latest === undefined
							? await tx.createConversation({ ownership: { kind: "ownerless" } })
							: await tx.forkConversation(api.conversationId, latest, {
									ownership: { kind: "ownerless" },
								});
				} else {
					record = await tx.createConversation({ ownership: { kind: "ownerless" } });
				}
				conversationId = conversationIdToString(record.id);

				// 2. Worker agent: the worker extension (which brings CodingTools at the
				//    host level) instead of the router extension.
				await configure(tx, record.id, agent);

				// 3. Target doc: role worker, parent = this router.
				const workerTarget = await tx.doc(TargetDoc, record.id);
				Object.assign(workerTarget, {
					botId: target.botId,
					role: "worker" as const,
					parentConversationId: conversationIdToString(api.conversationId),
					nodeId: target.nodeId,
					cwd,
					...(args.worktree === true ? { worktreePath: `${cwd}.botd-workers/${record.id}` } : {}),
					threadKeys: args.threadKey === undefined ? [] : [args.threadKey],
					title: args.title,
				});

				// 4. Register in the router's worker registry.
				const seq = Object.keys(registryBefore.workers).length + 1;
				workerId = `w-${seq}-${record.id}`;
				registryBefore.workers[workerId] = {
					workerId,
					conversationId,
					botId: target.botId,
					title: args.title,
					status: "running",
					threadKeys: args.threadKey === undefined ? [] : [args.threadKey],
					nodeId: target.nodeId,
					cwd,
					...(args.worktree === true ? { worktreePath: `${cwd}.botd-workers/${record.id}` } : {}),
					startedAt: api.now(),
					spawnedBy,
				};

				// 5. Index in the session-wide Chain of Recall.
				const recall = await tx.doc(RecallIndexDoc);
				recall.nodes[workerId] = {
					id: workerId,
					kind: "worker",
					title: args.title,
					summary: `Worker started: ${args.title}`,
					contentPreview: preview(args.task),
					conversationId,
					relatedIds: [],
					createdAt: api.now(),
				};

			}, context);

			// 6. Submit the task without waiting for the worker to finish.
			const worker = await api.conversation(stringToConversationId(conversationId), context);
			if (worker !== undefined) {
				await worker.submit(
					{
						type: "input",
						content: args.task,
						requestId: `worker-task:${workerId}`,
						entry: { kind: "botd.worker-task", data: { workerId, title } },
					},
					context,
				);
			}

			return {
				output: [
					{
						type: "text",
						text: `Worker started: ${workerId} (${title}). It runs in the background and will report back here when finished. Keep chatting with me meanwhile.`,
					},
				],
			};
		},
	});

	const delegateToBot = defineTool({
		name: "delegate_to_bot",
		description:
			"Delegate a task to another Bot persona. Spawns a background worker running as the target bot " +
			"(its model and instructions) and returns immediately; the target bot's report arrives when done.",
		parameters: obj({
			targetBotId: str({ description: "Bot persona to run the task (e.g. 'architect')" }),
			title: str({ description: "Short task title" }),
			task: str({ description: "Full task instructions" }),
			threadKey: opt(str({ description: "Channel thread key the result feeds" })),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const persona = options.resolvePersona(args.targetBotId);
			if (persona === undefined) {
				return {
					isError: true,
					output: [{ type: "text", text: `Unknown bot persona: ${args.targetBotId}` }],
				};
			}
			let workerId = "";
			let conversationId = "";
			const delegateAgent: AgentChange = {
				model: persona.model,
				instructions: persona.instructions,
				...(persona.cwd === "" ? {} : { cwd: persona.cwd }),
			};

			const spawnedBy = `delegate:${api.taskId}`;
			await api.commit(async (tx) => {
				const registryBefore = await tx.doc(WorkerRegistryDoc, api.conversationId);
				const existing = Object.values(registryBefore.workers).find((w) => w.spawnedBy === spawnedBy);
				if (existing !== undefined) {
					workerId = existing.workerId;
					conversationId = existing.conversationId;
					return;
				}

				const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
				conversationId = conversationIdToString(record.id);
				await configure(tx, record.id, delegateAgent);

				const workerTarget = await tx.doc(TargetDoc, record.id);
				Object.assign(workerTarget, {
					botId: args.targetBotId,
					role: "worker" as const,
					parentConversationId: conversationIdToString(api.conversationId),
					nodeId: persona.nodeId,
					cwd: persona.cwd,
					threadKeys: args.threadKey === undefined ? [] : [args.threadKey],
					title: args.title,
				});

				const seq = Object.keys(registryBefore.workers).length + 1;
				workerId = `w-${seq}-${record.id}`;
				registryBefore.workers[workerId] = {
					workerId,
					conversationId,
					botId: args.targetBotId,
					title: args.title,
					status: "running",
					threadKeys: args.threadKey === undefined ? [] : [args.threadKey],
					nodeId: persona.nodeId,
					cwd: persona.cwd,
					startedAt: api.now(),
					spawnedBy,
				};

				const recall = await tx.doc(RecallIndexDoc);
				recall.nodes[workerId] = {
					id: workerId,
					kind: "worker",
					title: args.title,
					summary: `Delegated to ${args.targetBotId}: ${args.title}`,
					contentPreview: preview(args.task),
					conversationId,
					relatedIds: [],
					createdAt: api.now(),
				};

			}, context);

			const worker = await api.conversation(stringToConversationId(conversationId), context);
			if (worker !== undefined) {
				await worker.submit(
					{
						type: "input",
						content: args.task,
						requestId: `worker-task:${workerId}`,
						entry: { kind: "botd.worker-task", data: { workerId, title: args.title, botId: args.targetBotId } },
					},
					context,
				);
			}

			return {
				output: [{ type: "text", text: `Delegated to ${args.targetBotId}: worker ${workerId} started.` }],
			};
		},
	});

	const steerWorker = defineTool({
		name: "steer_worker",
		description: "Send a message to a running worker: steer it mid-run, or queue a follow-up.",
		parameters: obj({
			workerId: str(),
			message: str(),
			mode: opt(oneOf(["steer", "followUp"])),
		}),
		async execute(args, api, context) {
			const registry = await api.snapshot(WorkerRegistryDoc, api.conversationId, context);
			const entry = registry?.workers[args.workerId];
			if (entry === undefined) {
				return { isError: true, output: [{ type: "text", text: `Unknown worker: ${args.workerId}` }] };
			}
			const worker = await api.conversation(stringToConversationId(entry.conversationId), context);
			if (worker === undefined) {
				return { isError: true, output: [{ type: "text", text: `Worker conversation missing: ${args.workerId}` }] };
			}
			await worker.submit(
				{
					type: "input",
					content: args.message,
					whenBusy: args.mode ?? "steer",
					requestId: `steer:${args.workerId}:${api.now()}`,
				},
				context,
			);
			return {
				output: [{ type: "text", text: `Delivered to ${args.workerId} (${args.mode ?? "steer"}).` }],
			};
		},
	});

	const stopWorker = defineTool({
		name: "stop_worker",
		description: "Abort a running background worker.",
		parameters: obj({ workerId: str() }),
		async execute(args, api, context) {
			const registry = await api.snapshot(WorkerRegistryDoc, api.conversationId, context);
			const entry = registry?.workers[args.workerId];
			if (entry === undefined) {
				return { isError: true, output: [{ type: "text", text: `Unknown worker: ${args.workerId}` }] };
			}
			// Mark first, then abort: an explicit stop wins over a completion report
			// that lands while the abort is in flight.
			await api.commit(async (tx) => {
				const doc = await tx.doc(WorkerRegistryDoc, api.conversationId);
				const record = doc.workers[args.workerId];
				if (record !== undefined && record.status === "running") {
					record.status = "aborted";
					record.finishedAt = api.now();
				}
			}, context);
			const worker = await api.conversation(stringToConversationId(entry.conversationId), context);
			if (worker !== undefined) await worker.abort(context, { background: true }).catch(() => undefined);
			// A queued follow-up may have been placed by the abort boundary and started
			// a new run; stop wins, so re-assert the aborted status after the abort.
			await api.commit(async (tx) => {
				const doc = await tx.doc(WorkerRegistryDoc, api.conversationId);
				const record = doc.workers[args.workerId];
				if (record !== undefined && record.status === "running") {
					record.status = "aborted";
					record.finishedAt = api.now();
				}
			}, context);
			return {
				output: [{ type: "text", text: `Worker ${args.workerId} aborted.` }],
			};
		},
	});

	const recall = defineTool({
		name: "recall",
		description:
			"Chain of Recall lookup: load a worker/trigger/entry/artifact/thread node by id, with its full content " +
			"and one-line summaries of related nodes for multi-hop recall.",
		parameters: obj({
			id: str({ description: "Node id: a workerId, or any id registered in the recall index" }),
		}),
		async execute(args, api, context) {
			const snapshot = await api.snapshot(RecallIndexDoc, context);
			const nodes: RecallIndexState["nodes"] = snapshot?.nodes ?? {};
			const node = nodes[args.id];
			if (node === undefined) {
				return { isError: true, output: [{ type: "text", text: `No recall node: ${args.id}` }] };
			}
			// Multi-hop: one-line summaries of the next-hop nodes.
			const related = node.relatedIds
				.map((id) => nodes[id])
				.filter((next): next is NonNullable<typeof next> => next !== undefined)
				.map((next) => `- ${next.id} (${next.kind}): ${preview(next.summary, 100)}`);
			const lines = [
				`# ${node.id} — ${node.title}`,
				`kind: ${node.kind}  created: ${new Date(node.createdAt).toISOString()}`,
				`summary: ${node.summary}`,
				`content: ${node.contentPreview}`,
			];
			if (related.length > 0) lines.push("related (next hops):", ...related);
			return {
				output: [{ type: "text", text: lines.join("\n") }],
			};
		},
	});

	const askHuman = askHumanTool;

	return defineExtension({
		name: ROUTER_EXTENSION,
		sections: [
			section("persona", async (input) => {
				const target = await input.read.snapshot(TargetDoc, input.conversationId, BACKGROUND_CONTEXT);
				if (target === undefined) return undefined;
				return renderPersona(target, options.resolvePersona(target.botId));
			}),
			section("active_workers", async (input) => {
				const registry = await input.read.snapshot(WorkerRegistryDoc, input.conversationId, BACKGROUND_CONTEXT);
				if (registry === undefined) return undefined;
				return renderWorkers(registry);
			}),
		],
		tools: [spawnWorker, delegateToBot, steerWorker, stopWorker, recall, askHuman],
	});
}
