/**
 * botd durable documents: the persisted state of the Multi-Persona Super-agent.
 *
 * Every Bot persona runs as a `pi-durable` Router conversation. The documents
 * below track, per conversation or per session:
 *
 * - `TargetDoc` — what a conversation is (which bot, which role, where it runs);
 * - `WorkerRegistryDoc` — the background workers a Router spawned;
 * - `AskDoc` — pending and resolved human interaction requests;
 * - `RecallIndexDoc` — the session-wide Chain of Recall index (DeepSeek §3.3).
 */
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";

/** The role a conversation plays in the super-agent tree. */
export type BotdRole = "router" | "worker" | "subagent";

/** State stored on a `botd.target` document (conversation-scoped, forked as-of). */
export interface TargetState {
	/** Owning Bot persona (`botId`), e.g. `"architect"` or `"finance"`. */
	botId: string;
	/** Router = persona session; worker = spawned background worker; subagent = task-owned child. */
	role: BotdRole;
	/** For workers and subagents: the Router conversation that spawned us. */
	parentConversationId?: string;
	/** Host node the conversation is pinned to (botd node mesh). */
	nodeId: string;
	/** Working directory for tool execution. */
	cwd: string;
	/** Owning durable session id (conversation id string) for context env injection. */
	sessionId?: string;
	/** Branch of the isolated git worktree (`botd/<workerId>` when a worktree is in use). */
	branchName?: string;
	/** Optional isolated git worktree path for write-isolated workers. */
	worktreePath?: string;
	/** Channel thread keys this conversation feeds (IM threads, triggers, etc.). */
	threadKeys: string[];
	/** Human-readable title (topic sessions, worker tasks). */
	title?: string;
}
export type TargetStateJson = TargetState & { [key: string]: JsonValue };

/**
 * Identity of one conversation: what it is and where it belongs.
 * `fork: "asOf"` so a forked worker inherits the target state at its fork point,
 * then overwrites role/parent in its own creating commit.
 */
export const TargetDoc = defineDoc({
	kind: "botd.target",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: (): TargetStateJson => ({
		botId: "",
		role: "router",
		nodeId: "",
		cwd: "",
		threadKeys: [],
	}),
	checkpointWhen: () => false,
});

/** Lifecycle of one background worker tracked by its Router. */
export interface WorkerEntry {
	/** Stable worker handle: `w-<seq>` inside the spawning Router conversation. */
	workerId: string;
	/** The worker's own conversation. */
	conversationId: string;
	/** Bot persona the worker runs as (usually the Router's own bot). */
	botId: string;
	title: string;
	status: "running" | "completed" | "failed" | "aborted";
	threadKeys: string[];
	nodeId: string;
	cwd: string;
	/** Branch of the isolated git worktree, when the worker runs in one. */
	branchName?: string;
	worktreePath?: string;
	startedAt: number;
	finishedAt?: number;
	/** Final summary, written by the worker's report-back task. */
	summary?: string;
	/** Idempotency: the spawning tool task ("..." or "delegate:..."). */
	spawnedBy?: string;
}

/** State of a Router's `botd.workers` document. */
export type WorkerEntryJson = WorkerEntry & { [key: string]: JsonValue };


export interface WorkerRegistryState {
	workers: { [workerId: string]: WorkerEntryJson };
}
interface WorkerRegistryStateJson extends WorkerRegistryState {
	[kind: string]: JsonValue;
}

/**
 * Worker bookkeeping on the Router conversation. `fork: "fresh"`: a fork of a
 * Router starts with an empty registry, never the parent's workers.
 */
export const WorkerRegistryDoc = defineDoc({
	kind: "botd.workers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (): WorkerRegistryStateJson => ({ workers: {} }),
	checkpointWhen: (_value, ops) => ops.length > 64,
});

/** One human interaction request. */
export interface AskEntry {
	askId: string;
	prompt: string;
	options: string[];
	status: "pending" | "answered" | "expired";
	answer?: string;
	createdAt: number;
	/** Idempotency: the tool task that asked. */
	askedBy?: string;
	/** Generative UI preview kind; "ui" renders previewContent as a botd.v1 spec. */
	previewType?: "text" | "code" | "markdown" | "ui";
	/** Preview body: raw text or the JSON of a botd.v1 UI spec (previewType "ui"). */
	previewContent?: string;
}

/** State of a conversation's `botd.asks` document. */
export type AskEntryJson = AskEntry & { [key: string]: JsonValue };

export interface AskState {
	asks: { [askId: string]: AskEntryJson };
}
interface AskStateJson extends AskState {
	[kind: string]: JsonValue;
}

/** Pending and resolved asks of one conversation. */
export const AskDoc = defineDoc({
	kind: "botd.asks",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (): AskStateJson => ({ asks: {} }),
	checkpointWhen: () => false,
});

/** Node kinds in the Chain of Recall graph. */
export type RecallKind = "worker" | "trigger" | "entry" | "artifact" | "thread";

/** One recallable node: enough to route a multi-hop lookup without loading transcripts. */
export interface RecallNode {
	id: string;
	kind: RecallKind;
	title: string;
	/** One-to-three-line summary (Chain of Recall inline layer). */
	summary: string;
	/** Preview of the underlying content, capped for prompt-friendliness. */
	contentPreview: string;
	/** Conversation holding the full content (workers: their transcript). */
	conversationId?: string;
	/** Next-hop node ids for multi-hop `recall(id)` lookups. */
	relatedIds: string[];
	createdAt: number;
}

export type RecallNodeJson = RecallNode & { [key: string]: JsonValue };

/** Session-wide recall index shared by every Router and Worker. */
export interface RecallIndexState {
	nodes: { [id: string]: RecallNodeJson };
}
export type RecallIndexStateJson = RecallIndexState & { [kind: string]: JsonValue };

/**
 * Chain of Recall index (DeepSeek §3.3 Inline & Spill): everything worth
 * remembering gets an inline summary here; full content stays in its
 * conversation and is fetched on demand via `recall({ id })`.
 */
export const RecallIndexDoc = defineDoc({
	kind: "botd.recall",
	version: 1,
	scope: "session",
	initial: (): RecallIndexStateJson => ({ nodes: {} }),
	checkpointWhen: (_value, ops) => ops.length > 128,
});

/**
 * Main-session index: one family member per bot persona, keyed by `botId`,
 * holding that persona's 24/7 main session conversation id.
 */
export const SessionIndexDoc = defineDocFamily({
	kind: "botd.session-index",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversationId: "" }),
	checkpointWhen: () => false,
});
