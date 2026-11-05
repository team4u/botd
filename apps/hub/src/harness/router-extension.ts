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
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	AskDoc,
	conversationIdToString,
	RecallIndexDoc,
	type RecallIndexState,
	type RecallNode,
	stringToConversationId,
	TargetDoc,
	WorkerRegistryDoc,
	type WorkerEntry,
} from "./docs.js";
import { SpillStoreDoc, ThreadSubscriptionsDoc } from "./event-router.js";
import {
	capRecallContent,
	resolveRecallBody,
} from "./recall-content.js";

export const ROUTER_EXTENSION = "botd-router";
export const WORKER_EXTENSION = "botd-worker";

/** 系统内置「⚡ 中枢总管」Router 分身 id：不落 SQLite bots 表，动态注册到运行时。 */
export const HUB_ROUTER_BOT_ID = "hub-router";

/** How the Router resolves the persona config of a bot (registered by HubDurableRuntime). */
export interface PersonaResolver {
	(botId: string): {
		botId: string;
		/** Present on subagent personas (their parent primary bot's id). */
		parentBotId?: string;
		/** One-line role description. */
		description?: string;
		model: { provider: string; modelId: string };
		instructions: string;
		nodeId: string;
		cwd: string;
		toolScope?: "all" | "readonly" | "custom";
	} | undefined;
}

/** One persona as listed for the Router prompt (subagents and peer bots). */
export interface PersonaListing {
	botId: string;
	name?: string;
	description?: string;
	parentBotId?: string;
	model: { provider: string; modelId: string };
	toolScope?: string;
	nodeId: string;
	cwd: string;
}

/** Resolves an agent change for a worker conversation (host hook, default: worker extension + CodingTools). */
export interface WorkerAgentFactory {
	(args: { botId: string; cwd?: string; threadKey?: string }): AgentChange;
}

const fallbackWorkerAgent: WorkerAgentFactory = ({ cwd }) => ({
	...(cwd === undefined ? {} : { cwd }),
});

/** Cap for `contentPreview` / `summary` strings stored in the recall index. */
const PREVIEW_LIMIT = 240;

export const preview = (text: string, limit = PREVIEW_LIMIT): string =>
	text.length <= limit ? text : `${text.slice(0, limit)}…`;

/**
 * Best-effort release of a locally-mounted git worktree: `git worktree remove
 * --force` + `prune`. Never throws — a non-git cwd, an already-gone or
 * unmounted worktree must not fail the stop that cleans it up.
 */
export async function releaseLocalWorktree(
	baseCwd: string,
	worktreePath: string,
	_branchName?: string,
): Promise<void> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		await run("git", ["-C", baseCwd, "worktree", "remove", "--force", worktreePath]);
	} catch {
		// already removed / not a git repo / unmounted: prune below still runs
	}
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		await run("git", ["-C", baseCwd, "worktree", "prune"]);
	} catch {
		// ignore: never fail the caller on cleanup
	}
}

/** The shared `ask_human` tool (mounted on Router, Worker and any subagent extension). */
export const askHumanTool = defineTool({
	name: "ask_human",
	description:
		"Ask the human a question and record it as a pending ask. The hub UI (or test) resolves it; once recorded, " +
		"finish your turn and wait for the human's response to arrive as a message (or if already answered in this " +
		"conversation, returns the answer). Use previewType \"ui\" with a botd.v1 JSON spec in previewContent to render " +
		"a rich form card (TextInput props.secret masks passwords and the answer is redacted into env vars, never " +
		"stored in plaintext).",
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
			// Same-prompt dedup: a repeated ask with an identical prompt reuses the
			// recorded ask instead of piling up duplicate pending asks (polling or
			// re-asking the same question returns the same askId, answered or not).
			const byPrompt = Object.values(doc.asks).find(
				(a) => a.prompt === args.prompt && (a.status === "pending" || a.status === "answered"),
			);
			if (byPrompt !== undefined) {
				askId = byPrompt.askId;
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

/**
 * Register a worker conversation under its threadKeys in the session-wide
 * passthrough subscription table (`ThreadSubscriptionsDoc`), so later events
 * on those threads bypass the Router LLM and reach the worker directly.
 * Idempotent; call inside the spawning commit.
 */
async function subscribeWorkerThreads(
	tx: Parameters<Parameters<import("@earendil-works/pi-durable").ToolExecutionApi["commit"]>[0]>[0],
	conversationId: string,
	threadKeys: readonly string[],
): Promise<void> {
	if (threadKeys.length === 0) return;
	const subsDoc = await tx.doc(ThreadSubscriptionsDoc);
	for (const key of threadKeys) {
		const list = subsDoc.subs[key] ?? [];
		if (!list.includes(conversationId)) list.push(conversationId);
		subsDoc.subs[key] = list;
	}
}

/**
 * Remove a worker conversation from the passthrough subscription table
 * (stopping a worker must stop its thread feed); empty lists are deleted.
 * Call inside the stopping commit.
 */
async function unsubscribeWorkerThreads(
	tx: Parameters<Parameters<import("@earendil-works/pi-durable").ToolExecutionApi["commit"]>[0]>[0],
	conversationId: string,
	threadKeys: readonly string[],
): Promise<void> {
	if (threadKeys.length === 0) return;
	const subsDoc = await tx.doc(ThreadSubscriptionsDoc);
	for (const key of threadKeys) {
		const list = subsDoc.subs[key];
		if (list === undefined) continue;
		const next = list.filter((id) => id !== conversationId);
		if (next.length === 0) delete subsDoc.subs[key];
		else subsDoc.subs[key] = next;
	}
}

/** The shared `recall` tool (mounted on both Router and Worker extensions). */
export const recallTool: ToolRegistration = defineTool({
	name: "recall",
	description:
		"Chain of Recall lookup: load a worker/trigger/entry/artifact/thread node by id (or a spilled payload id `spill_xxx`), " +
		"with its full content and one-line summaries of related nodes for multi-hop recall.",
	parameters: obj({
		id: str({ description: "Node id: a workerId, a spill id (spill_xxx), or any id registered in the recall index" }),
	}),
	async execute(args, api, context) {
		const snapshot = await api.snapshot(RecallIndexDoc, context);
		const nodes: RecallIndexState["nodes"] = snapshot?.nodes ?? {};
		const node = nodes[args.id];
		if (node === undefined) {
			// Unknown to the index: a spilled event payload lives directly in the
			// SpillStore (formatEventInlineAndSpill tells the model `recall({ id: "spill_xxx" })`).
			const spill = await api.snapshot(SpillStoreDoc, args.id, context);
			if (spill !== undefined) {
				return {
					output: [
						{
							type: "text",
							text: [
								`# ${spill.spillId} — spilled content`,
								...(spill.threadKey === null ? [] : [`thread: ${spill.threadKey}`]),
								`content: ${capRecallContent(spill.fullContent, { id: spill.spillId, kind: "entry", title: spill.spillId, summary: "spilled payload", contentPreview: "", relatedIds: [], createdAt: spill.createdAt })}`,
							].join("\n"),
						},
					],
				};
			}
			return { isError: true, output: [{ type: "text", text: `No recall node: ${args.id}` }] };
		}
		// The index is a pure pointer store: follow it to the real body — the
		// spill file, else the worker conversation's last assistant entry, else
		// the catalog preview. A spilled worker report also lives in the
		// SpillStore under its workerId: on an unreadable spill file (remote
		// Node cwd) it beats degrading to the truncated preview.
		let body = await resolveRecallBody(node as RecallNode, (query, limit) =>
			api.commit((tx) => tx.scanEntries(query, limit), context),
		);
		if (body.source === "preview" || body.notice !== undefined) {
			const spill = await api.snapshot(SpillStoreDoc, args.id, context);
			if (spill !== undefined && spill.fullContent !== "") {
				// Keep the unreadable-file notice: the pointer is still broken even
			// though the durable copy serves the body.
				body = {
					content: spill.fullContent,
					source: "spill-file",
					...(body.notice === undefined ? {} : { notice: body.notice }),
				};
			}
		}
		const content = capRecallContent(body.content, node);
		// Multi-hop: one-line summaries of the next-hop nodes.
		const related = node.relatedIds
			.map((id) => nodes[id])
			.filter((next): next is NonNullable<typeof next> => next !== undefined)
			.map((next) => `- ${next.id} (${next.kind}): ${preview(next.summary, 100)}`);
		const lines = [
			`# ${node.id} — ${node.title}`,
			`kind: ${node.kind}  created: ${new Date(node.createdAt).toISOString()}`,
			`summary: ${node.summary}`,
			...(body.notice === undefined ? [] : [body.notice]),
			`content: ${content}`,
		];
		if (related.length > 0) lines.push("related (next hops):", ...related);
		return {
			output: [{ type: "text", text: lines.join("\n") }],
		};
	},
});

/** A Router's persona prompt, rendered from its TargetDoc + persona config. */
function renderPersona(
	target: { botId: string; role: string; title?: string; threadKeys: string[] },
	persona: ReturnType<PersonaResolver> | undefined,
	listPersonas?: () => ReadonlyArray<PersonaListing>,
): string {
	const lines = [
		`You are the "${target.botId}" bot persona, running as a full-duplex Router.`,
		`Role: ${target.role}.`,
	];
	if (target.title !== undefined) lines.push(`Session: ${target.title}`);
	if (target.threadKeys.length > 0) lines.push(`Threads: ${target.threadKeys.join(", ")}`);
	if (persona !== undefined) {
		lines.push("", "## Persona instructions", persona.instructions || "(none)");
		if (persona.description !== undefined) lines.push(``, `Description: ${persona.description}`);
		lines.push("", `Default model: ${persona.model.provider}/${persona.model.modelId}`);
		lines.push(`Node: ${persona.nodeId} — cwd: ${persona.cwd}`);
	}

	// Subagents (children of this bot) and peer primary bots, listed from the
	// registered persona set so the Router can dispatch by real identity.
	const personas = listPersonas?.() ?? [];
	const subagents = personas.filter((p) => p.parentBotId === target.botId);
	// hub-router 是系统内置总管：普通业务分身不把它列为可派发的 peer；
	// 而它自身（target.botId === HUB_ROUTER_BOT_ID）则看到全部用户主分身。
	const peers =
		target.botId === HUB_ROUTER_BOT_ID
			? personas.filter((p) => p.parentBotId === undefined && p.botId !== target.botId)
			: personas.filter(
					(p) => p.parentBotId === undefined && p.botId !== target.botId && p.botId !== HUB_ROUTER_BOT_ID,
			);
	if (subagents.length > 0) {
		lines.push(
			"",
			"## Your Subagents (same workspace)",
			"Dispatch a subagent with `spawn_worker({ subagent: \"<subagentId>\", title, task })` " +
				"or inside a SubagentWorkflow script via `agent(prompt, { agentType: \"<subagentId>\" })`. " +
				"A subagent runs with its own model, instructions and toolScope while sharing this workspace cwd.",
		);
		for (const sub of subagents) {
			const bits = [
				`model ${sub.model.provider}/${sub.model.modelId}`,
				...(sub.toolScope === undefined ? [] : [`toolScope ${sub.toolScope}`]),
			];
			lines.push(`- ${sub.botId}${sub.name === undefined ? "" : ` (${sub.name})`}: ${sub.description ?? "(no description)"} [${bits.join(", ")}]`);
		}
	}
	if (peers.length > 0) {
		lines.push(
			"",
			"## Peer Bots (cross-workspace / cross-node)",
			"Delegate cross-bot work with `delegate_to_bot({ targetBotId, title, task })` — it runs as that bot (its model, persona and workspace) in the background.",
		);
		for (const peer of peers) {
			const bits = [
				`model ${peer.model.provider}/${peer.model.modelId}`,
				`node ${peer.nodeId}`,
				...(peer.toolScope === undefined ? [] : [`toolScope ${peer.toolScope}`]),
			];
			lines.push(`- ${peer.botId}${peer.name === undefined ? "" : ` (${peer.name})`}: ${peer.description ?? "(no description)"} [${bits.join(", ")}] cwd ${peer.cwd}`);
		}
	}

	lines.push(
		"",
		"## How to route work",
		"- Quick Q&A, single-file or few-file reads, light one-off commands, and skill-driven lookups (accounts/status checks, CLI queries): do them right here with your own tools — never spawn a worker for them.",
		"- Multi-step coding or refactors, long-running commands, research, or work that needs parallelism / worktree isolation: call `spawn_worker` and answer the user at once with the worker id.",
		"- Work for another persona: call `delegate_to_bot`; it runs as that bot in the background.",
		"- While a worker runs, keep chatting: `steer_worker` redirects or resumes it, `stop_worker` cancels it, `recall({ id })` loads its results.",
		"- When a worker finishes it reports back here automatically; summarize its report for the user.",
	);
	if (target.botId === HUB_ROUTER_BOT_ID || (target.title !== undefined && target.title.includes("中枢"))) {
		lines.push(
			"",
			"## Central Hub Dispatcher Rules (中枢总管守则)",
			"- You are the Global Central Dispatcher (中枢总管). Keep this central conversation 100% clean, fast, and non-blocking.",
			"- NEVER run heavy file edits, multi-step coding, or long shell commands directly in this foreground session.",
			"- Always dispatch tasks to isolated background workers via `spawn_worker` (default `forkContext: false` for a clean context; pass `cwd` and `worktree: true` when modifying a repository) or `delegate_to_bot` (when the task belongs to another specialized bot persona).",
			"- Use `steer_worker`, `stop_worker`, and `recall` to coordinate, redirect, or inspect background workers on the user's behalf.",
		);
	}
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

/** Where a worker's registry entry lives: the owning Router conversation id. */
interface WorkerTarget {
	registryConvId: ConversationId;
	entry: WorkerEntry;
}

/**
 * Resolve a worker's registry entry across sessions: the local registry first,
 * then (for workers spawned by other Router conversations) the
 * RecallIndexDoc → TargetDoc.parentConversationId chain back to the owning
 * Router's WorkerRegistryDoc. Lets the Central Hub steer/stop any worker in
 * the Hub without new tools.
 */
async function resolveWorkerTargetRegistry(
	api: import("@earendil-works/pi-durable").ToolExecutionApi,
	context: unknown,
	workerId: string,
): Promise<WorkerTarget | undefined> {
	const local = (await api.snapshot(
		WorkerRegistryDoc as never,
		api.conversationId,
		context as never,
	)) as { workers: Record<string, WorkerEntry> } | undefined;
	if (local?.workers[workerId] !== undefined) {
		return { registryConvId: api.conversationId, entry: local.workers[workerId] };
	}
	const recall = (await api.snapshot(RecallIndexDoc as never, context as never)) as
		| { nodes: Record<string, { conversationId?: string }> }
		| undefined;
	const node = recall?.nodes[workerId];
	if (node?.conversationId === undefined) return undefined;
	let workerConvId: ConversationId;
	try {
		workerConvId = stringToConversationId(node.conversationId);
	} catch {
		return undefined;
	}
	const workerTarget = (await api.snapshot(
		TargetDoc as never,
		workerConvId,
		context as never,
	)) as { parentConversationId?: string } | undefined;
	if (workerTarget?.parentConversationId === undefined) return undefined;
	let parentConvId: ConversationId;
	try {
		parentConvId = stringToConversationId(workerTarget.parentConversationId);
	} catch {
		return undefined;
	}
	const parentReg = (await api.snapshot(
		WorkerRegistryDoc as never,
		parentConvId,
		context as never,
	)) as { workers: Record<string, WorkerEntry> } | undefined;
	if (parentReg?.workers[workerId] === undefined) return undefined;
	return { registryConvId: parentConvId, entry: parentReg.workers[workerId] };
}

/** Releases a worker's git worktree wherever it lives: local disk or a remote node (see HubDurableRuntimeOptions.releaseWorktree). */
export type WorktreeReleaser = (info: {
	nodeId: string;
	cwd: string;
	worktreePath: string;
	workerId: string;
}) => Promise<void>;

/** Default release: best-effort local `git worktree remove` + prune (never throws). */
const defaultWorktreeRelease: WorktreeReleaser = async (info) => {
	await releaseLocalWorktree(info.cwd, info.worktreePath);
};

export function createRouterExtension(options: {
	resolvePersona: PersonaResolver;
	/** All registered personas, so the Router prompt can list its subagents and peer bots. */
	listPersonas?: () => ReadonlyArray<PersonaListing>;
	workerAgent?: WorkerAgentFactory;
	/** Host hook releasing a stopped worker's worktree (local `git worktree remove` or a remote node RPC); default: local release only. */
	releaseWorktree?: WorktreeReleaser;
}): Extension {
	const workerAgent = options.workerAgent ?? fallbackWorkerAgent;

	const spawnWorker = defineTool({
		name: "spawn_worker",
		description:
			"Spawn a background worker conversation for multi-step work and return immediately. " +
			"The worker runs the task with full coding tools and reports back when done; " +
			"the foreground conversation stays free for the user. Pass `subagent` to run one of " +
			"your registered subagent personas (its model/instructions/toolScope, this workspace) " +
			"or `resume` to continue an existing worker with its conversation history.",
		parameters: obj({
			title: str({ description: "Short task title shown in the worker list" }),
			task: str({ description: "Full task instructions for the worker" }),
			subagent: opt(str({ description: "Optional subagent persona id (under this bot) to run the worker with its specialized model, instructions, and toolScope while sharing this workspace cwd" })),
			resume: opt(str({ description: "Optional existing workerId (e.g. 'w-1-2') to resume instead of creating a new worker, preserving its conversation history and worktree" })),
			forkContext: opt(bool({ description: "Fork this conversation's context into the worker (default false)" })),
			threadKey: opt(str({ description: "Channel thread key the worker feeds" })),
			cwd: opt(str({ description: "Working directory for the worker" })),
			worktree: opt(bool({ description: "Give the worker an isolated git worktree" })),
			isolation: opt(oneOf(["off", "worktree"])),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const forkContext = args.forkContext === true;
			const useWorktree = args.worktree === true || args.isolation === "worktree";
			let workerId = "";
			let conversationId = "";
			let title = args.title;
			let worktreePath = "";
			let branchName = "";
			let resumed = false;

			// A subagent persona must exist before anything is created.
			if (args.subagent !== undefined && options.resolvePersona(args.subagent) === undefined) {
				return {
					isError: true,
					output: [{ type: "text", text: `Unknown subagent persona: ${args.subagent}` }],
				};
			}

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
					worktreePath = existing.worktreePath ?? "";
					branchName = existing.branchName ?? "";
					return;
				}

				const target = await tx.doc(TargetDoc, api.conversationId);

				// Resume path: reuse the existing worker's conversation, status and (new)
				// title; the task is submitted below as a follow-up on that conversation.
				if (args.resume !== undefined) {
					const entry = registryBefore.workers[args.resume];
					if (entry !== undefined) {
						workerId = entry.workerId;
						conversationId = entry.conversationId;
						if (args.title !== undefined && args.title !== "") entry.title = args.title;
						title = entry.title;
						if (entry.status !== "running") {
							entry.status = "running";
							delete entry.finishedAt;
						}
						resumed = true;
						return;
					}
				}

				// Subagent workers keep the workspace cwd (target.cwd / args.cwd) but run
				// with the subagent persona's identity (model, SYSTEM.md, toolScope).
				const runBotId = args.subagent ?? target.botId;
				const cwd = args.cwd ?? target.cwd;
				// Compute seq up front so the workerTarget, registry entry, and recall
				// node below all agree on the same worktreePath / branchName.
				const seq = Object.keys(registryBefore.workers).length + 1;
				const agent = workerAgent({
					botId: runBotId,
					cwd: cwd === "" ? undefined : cwd,
					threadKey: args.threadKey,
				});
				// A non-forked worker is a brand-new conversation: it inherits nothing.
				// A factory that leaves the model unset (custom hosts) falls back to the
				// persona's, so a clean worker never runs into `no_model`.
				const runPersona = options.resolvePersona(runBotId);
				const agentWithModel: AgentChange =
					agent.model === undefined && runPersona !== undefined
						? { ...agent, model: runPersona.model }
						: agent;

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
				workerId = `w-${seq}-${record.id}`;
				branchName = `botd/${workerId}`;
				worktreePath = `${cwd}/.botd-worktrees/${workerId}`;

				// 2. Worker agent: the worker extension (which brings CodingTools at the
				//    host level) instead of the router extension. A forked worker inherits
				//    the router's EXACT extension list; an agent without an explicit
				//    `extensions` selection resets to the host default (all installed),
				//    so the worker keeps the coding tools and the report-back hook.
				await configure(tx, record.id, {
					...agentWithModel,
					...(agentWithModel.extensions === undefined ? { extensions: null } : {}),
				});

				// 3. Target doc: role worker, parent = this router.
				const workerTarget = await tx.doc(TargetDoc, record.id);
				// 新 worker 一律目标 persona 默认配置：fork:asOf 继承的会话级模型覆盖
				//（含跨 persona 分叉残留）在此显式清除，与上面 configure 的 agent 保持一致。
				delete workerTarget.modelOverride;
				Object.assign(workerTarget, {
					botId: runBotId,
					role: "worker" as const,
					parentConversationId: conversationIdToString(api.conversationId),
					nodeId: target.nodeId,
					cwd,
					...(target.sessionId ? { sessionId: target.sessionId } : {}),
					...(useWorktree ? { worktreePath, branchName } : {}),
					threadKeys: args.threadKey === undefined ? [] : [args.threadKey],
					title: args.title,
				});

				// 4. Register in the router's worker registry.
				registryBefore.workers[workerId] = {
					workerId,
					conversationId,
					botId: runBotId,
					title: args.title,
					status: "running",
					threadKeys: args.threadKey === undefined ? [] : [args.threadKey],
					nodeId: target.nodeId,
					cwd,
					...(useWorktree ? { worktreePath, branchName } : {}),
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
				if (useWorktree) {
					(recall.nodes[workerId] as unknown as Record<string, unknown>).data = { node: { worktreePath, branchName } };
				}

				// 6. Subscribe the worker to its threadKeys (event passthrough).
				await subscribeWorkerThreads(
					tx,
					conversationId,
					args.threadKey === undefined ? [] : [args.threadKey],
				);

			}, context);

			// 6. Submit the task without waiting for the worker to finish. A resumed
			//    worker may already be mid-run, so the task queues as a follow-up; the
			//    requestId carries a nonce so every resumed round is a distinct input.
			const worker = await api.conversation(stringToConversationId(conversationId), context);
			if (worker !== undefined) {
				await worker.submit(
					{
						type: "input",
						content: args.task,
						...(resumed ? { whenBusy: "followUp" as const } : {}),
						requestId: `worker-task:${workerId}${resumed ? `:r${api.now()}` : ""}`,
						entry: { kind: "botd.worker-task", data: { workerId, title } },
					},
					context,
				);
			}

			const worktreeNote = useWorktree ? `\n[worktree: ${branchName} at ${worktreePath}]` : "";
			const head = resumed ? `Worker resumed: ${workerId} (${title})` : `Worker started: ${workerId} (${title})`;
			return {
				output: [
					{
						type: "text",
						text:
							`${head}. It runs in the background and will report back here when finished. Keep chatting with me meanwhile.${worktreeNote}`,
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
			worktree: opt(bool({ description: "Give the delegated worker an isolated git worktree" })),
			isolation: opt(oneOf(["off", "worktree"])),
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
			const useWorktree = args.worktree === true || args.isolation === "worktree";
			let workerId = "";
			let conversationId = "";
			let branchName = "";
			let worktreePath = "";
			// The full worker stack (CodingTools + WORKER_EXTENSION + persona skills +
			// codemode + thinkingLevel) comes from the host's workerAgent factory, so a
			// delegated bot reports back through the same afterRun machinery. Delegation
			// targets another persona, so the factory change is layered over the target
			// persona's identity (model / instructions / cwd): a factory that leaves a
			// field unset falls back to the persona's, never to an unset model.
			const factoryChange: AgentChange = options.workerAgent
				? options.workerAgent({
						botId: args.targetBotId,
						cwd: persona.cwd === "" ? undefined : persona.cwd,
						threadKey: args.threadKey,
					})
				: {};
			const delegateAgent: AgentChange = {
				...factoryChange,
				...(factoryChange.model === undefined ? { model: persona.model } : {}),
				...(factoryChange.instructions === undefined ? { instructions: persona.instructions } : {}),
				...(factoryChange.cwd === undefined && persona.cwd !== "" ? { cwd: persona.cwd } : {}),
			};

			const spawnedBy = `delegate:${api.taskId}`;
			await api.commit(async (tx) => {
				const registryBefore = await tx.doc(WorkerRegistryDoc, api.conversationId);
				const existing = Object.values(registryBefore.workers).find((w) => w.spawnedBy === spawnedBy);
				if (existing !== undefined) {
					workerId = existing.workerId;
					conversationId = existing.conversationId;
					worktreePath = existing.worktreePath ?? "";
					branchName = existing.branchName ?? "";
					return;
				}

				const target = await tx.doc(TargetDoc, api.conversationId);
				const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
				conversationId = conversationIdToString(record.id);
				await configure(tx, record.id, delegateAgent);

				const seq = Object.keys(registryBefore.workers).length + 1;
				workerId = `w-${seq}-${record.id}`;
				branchName = `botd/${workerId}`;
				worktreePath = `${persona.cwd}/.botd-worktrees/${workerId}`;

				const workerTarget = await tx.doc(TargetDoc, record.id);
				// 委托目标是另一 persona：同样不继承任何会话级模型覆盖。
				delete workerTarget.modelOverride;
				Object.assign(workerTarget, {
					botId: args.targetBotId,
					role: "worker" as const,
					parentConversationId: conversationIdToString(api.conversationId),
					nodeId: persona.nodeId,
					cwd: persona.cwd,
					...(target.sessionId ? { sessionId: target.sessionId } : {}),
					...(useWorktree ? { worktreePath, branchName } : {}),
					threadKeys: args.threadKey === undefined ? [] : [args.threadKey],
					title: args.title,
				});

				registryBefore.workers[workerId] = {
					workerId,
					conversationId,
					botId: args.targetBotId,
					title: args.title,
					status: "running",
					threadKeys: args.threadKey === undefined ? [] : [args.threadKey],
					nodeId: persona.nodeId,
					cwd: persona.cwd,
					...(useWorktree ? { worktreePath, branchName } : {}),
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
				if (useWorktree) {
					(recall.nodes[workerId] as unknown as Record<string, unknown>).data = { node: { worktreePath, branchName } };
				}

				// Subscribe the delegated worker to its threadKeys (event passthrough).
				await subscribeWorkerThreads(
					tx,
					conversationId,
					args.threadKey === undefined ? [] : [args.threadKey],
				);

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

			const worktreeNote = useWorktree ? `\n[worktree: ${branchName} at ${worktreePath}]` : "";
			return {
				output: [{ type: "text", text: `Delegated to ${args.targetBotId}: worker ${workerId} started.${worktreeNote}` }],
			};
		},
	});

	const steerWorker = defineTool({
		name: "steer_worker",
		description:
			"Send a message to a worker: steer a running worker mid-run, queue a followUp, " +
			"or resume a completed/failed/aborted worker with new instructions while preserving its full conversation context.",
		parameters: obj({
			workerId: str(),
			message: str(),
			mode: opt(oneOf(["steer", "followUp"])),
		}),
		async execute(args, api, context) {
			const target = await resolveWorkerTargetRegistry(api, context, args.workerId);
			if (target === undefined) {
				return { isError: true, output: [{ type: "text", text: `Unknown worker: ${args.workerId}` }] };
			}
			const { registryConvId, entry } = target;
			const worker = await api.conversation(stringToConversationId(entry.conversationId), context);
			if (worker === undefined) {
				return { isError: true, output: [{ type: "text", text: `Worker conversation missing: ${args.workerId}` }] };
			}
			// A steer on a finished (or stopped) worker wakes it for another round:
			// reset its registry status so the second round's report-back is accepted again.
			await api.commit(async (tx) => {
				const doc = await tx.doc(WorkerRegistryDoc, registryConvId);
				const record = doc.workers[args.workerId];
				if (
					record !== undefined &&
					(record.status === "completed" || record.status === "failed" || record.status === "aborted")
				) {
					record.status = "running";
					delete record.finishedAt;
				}
			}, context);
			await worker.submit(
				{
					type: "input",
					content: args.message,
					whenBusy: args.mode ?? "steer",
					requestId: `steer:${args.workerId}:${api.now()}`,
					// Tagged like a worker task so the run's afterRun names the worker and
					// the second round reports back exactly like the first one did.
					entry: { kind: "botd.worker-task", data: { workerId: args.workerId, title: entry.title } },
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
			const target = await resolveWorkerTargetRegistry(api, context, args.workerId);
			if (target === undefined) {
				return { isError: true, output: [{ type: "text", text: `Unknown worker: ${args.workerId}` }] };
			}
			const { registryConvId, entry } = target;
			// Mark first, then abort: an explicit stop wins over a completion report
			// that lands while the abort is in flight.
			await api.commit(async (tx) => {
				const doc = await tx.doc(WorkerRegistryDoc, registryConvId);
				const record = doc.workers[args.workerId];
				if (record !== undefined && record.status === "running") {
					record.status = "aborted";
					record.finishedAt = api.now();
				}
				// A stopped worker stops feeding its threads: drop its passthrough
				// subscriptions whatever the status (stop on a finished worker too).
				if (record !== undefined) {
					await unsubscribeWorkerThreads(tx, record.conversationId, record.threadKeys ?? []);
				}
			}, context);
			const worker = await api.conversation(stringToConversationId(entry.conversationId), context);
			if (worker !== undefined) await worker.abort(context, { background: true }).catch(() => undefined);
			// A queued follow-up may have been placed by the abort boundary and started
			// a new run; stop wins, so re-assert the aborted status after the abort.
			await api.commit(async (tx) => {
				const doc = await tx.doc(WorkerRegistryDoc, registryConvId);
				const record = doc.workers[args.workerId];
				if (record !== undefined && record.status === "running") {
					record.status = "aborted";
					record.finishedAt = api.now();
				}
				if (record !== undefined) {
					await unsubscribeWorkerThreads(tx, record.conversationId, record.threadKeys ?? []);
				}
			}, context);
			// An explicitly aborted worktree worker is nobody's to inspect: release its
			// git worktree (local or remote per the worker's node) so `.botd-worktrees/`
			// does not accumulate dead checkouts. (A completed worker's worktree
			// survives: its branch may be merged later.)
			if (entry.worktreePath !== undefined && entry.worktreePath !== "") {
				const release = options.releaseWorktree ?? defaultWorktreeRelease;
				await release({
					nodeId: entry.nodeId,
					cwd: entry.cwd === "" ? process.cwd() : entry.cwd,
					worktreePath: entry.worktreePath,
					workerId: args.workerId,
				}).catch(() => undefined);
			}
			return {
				output: [{ type: "text", text: `Worker ${args.workerId} aborted.` }],
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
				return renderPersona(target, options.resolvePersona(target.botId), options.listPersonas);
			}),
			section("active_workers", async (input) => {
				const registry = await input.read.snapshot(WorkerRegistryDoc, input.conversationId, BACKGROUND_CONTEXT);
				const target = await input.read.snapshot(TargetDoc, input.conversationId, BACKGROUND_CONTEXT);
				// 中枢总管看全局：合并本会话 registry 与 RecallIndex 里属于其他 Router
				// 会话的近期 Worker（TargetDoc.parentConversationId 指向别处的），
				// hub-router 的 active_workers 永远覆盖全 Hub。
				if (target?.botId === HUB_ROUTER_BOT_ID) {
					const recall = await input.read.snapshot(RecallIndexDoc, BACKGROUND_CONTEXT);
					const merged: Record<string, WorkerEntry> = { ...(registry?.workers ?? {}) };
					for (const node of Object.values(recall?.nodes ?? {})) {
						if (node.kind !== "worker" || node.conversationId === undefined) continue;
						if (merged[node.id] !== undefined) continue;
						let workerConvId: ConversationId;
						try {
							workerConvId = stringToConversationId(node.conversationId);
						} catch {
							continue;
						}
						const workerTarget = await input.read.snapshot(
							TargetDoc,
							workerConvId,
							BACKGROUND_CONTEXT,
						);
						const parent = workerTarget?.parentConversationId;
						if (parent === undefined) continue;
						let parentConvId: ConversationId;
						try {
							parentConvId = stringToConversationId(parent);
						} catch {
							continue;
						}
						const parentReg = await input.read.snapshot(
							WorkerRegistryDoc,
							parentConvId,
							BACKGROUND_CONTEXT,
						);
						const entry = parentReg?.workers[node.id];
						if (entry !== undefined) merged[node.id] = entry;
					}
					return renderWorkers({ workers: merged });
				}
				if (registry === undefined) return undefined;
				return renderWorkers(registry);
			}),
		],
		tools: [spawnWorker, delegateToBot, steerWorker, stopWorker, recallTool, askHuman],
	});
}
