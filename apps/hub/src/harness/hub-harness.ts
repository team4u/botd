/**
 * HubDurableRuntime: the Hub's single durable harness.
 *
 * One `Harness` over one storage (MemoryStorage for tests, SQLite for
 * production) hosts every Bot persona. Each persona gets a 24/7 main session
 * (a Router conversation) plus any number of topic sessions; workers are
 * forked/created off them by the router extension. All state — personas,
 * sessions, workers, asks, recall — lives in durable documents, so a restart
 * resumes exactly where the process left off.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai";
import {
	configure,
	createRegistry,
	Harness,
	MemoryStorage,
	type AgentChange,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type Extension,
	type HarnessOptions,
	type Registry,
	type Storage,
	type Submission,
	type TaskGraph,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createPersonaSkillsExtension, PERSONA_SKILLS_EXTENSION, type PersonaSkillsOptions } from "./persona-skills-extension.js";
import { createRouterExtension, type PersonaResolver, ROUTER_EXTENSION, type WorkerAgentFactory, WORKER_EXTENSION } from "./router-extension.js";
import { createWorkerExtension, WORKER_EXTENSION_NAME } from "./worker-extension.js";
import { createWorkflowExtension } from "./workflow-extension.js";
import { RecallIndexDoc, SessionIndexDoc, TargetDoc, WorkerRegistryDoc, type WorkerEntry } from "./docs.js";

/** Configuration of one Bot persona. */
export interface BotPersonaConfig {
	botId: string;
	name: string;
	/** Provider/model the persona runs with. */
	model: { provider: string; modelId: string };
	/** Persona instructions (SYSTEM.md contents). */
	instructions: string;
	/** Memory notes (MEMORY.md contents), folded into the persona prompt. */
	memory?: string;
	/** Hub skill ids enabled for this persona (loaded via `load_skill`). */
	enabledSkills?: string[];
	/** Dynamic extension names enabled for this persona (mounted on Router and Worker). */
	enabledExtensions?: string[];
	nodeId: string;
	cwd: string;
}

export interface HubRuntimeOptions {
	storage?: Storage;
	/** SQLite database file; used when `storage` is omitted. */
	dbPath?: string;
	/** Table prefix for the SQLite storage (default "pi_"). */
	tablePrefix?: string;
	models?: Models;
	registry?: Registry;
	extensions?: Extension[];
	/** Resolve worker agent overrides; default keeps the host default selection (CodingTools + botd-worker). */
	workerAgent?: WorkerAgentFactory;
	/** Builds a conversation's execution env; defaults to a NodeExecutionEnv on the target cwd. */
	env?: HarnessOptions["env"];
	/** Disable the shared codemode sandbox (tests without QuickJS); default enabled. */
	codemode?: boolean;
	/** Hub-backed skills & memory callbacks for the persona-skills extension. */
	skills?: PersonaSkillsOptions;
	onReport?: (report: unknown) => void;
}

// ---------------------------------------------------------------------------
// ConversationId <-> string helpers. The branded ids are numbers at run time;
// the documents store plain strings, so these helpers convert at the edges.
// ---------------------------------------------------------------------------

export function conversationIdToString(id: ConversationId): string {
	return String(id);
}

export function stringToConversationId(value: string): ConversationId {
	const numeric = Number(value);
	if (!Number.isInteger(numeric)) throw new Error(`invalid conversation id: ${value}`);
	return numeric as ConversationId;
}

/** The persona prompt section body for a bot's router conversations. */
function personaInstructions(persona: BotPersonaConfig): string {
	const parts = [persona.instructions];
	if (persona.memory !== undefined && persona.memory !== "") parts.push("", "## Memory", persona.memory);
	return parts.join("\n");
}

/** Session index: one main-session conversation id per bot persona (keyed by botId). */
const SessionIndex = SessionIndexDoc;

export class HubDurableRuntime {
	readonly harness: import("@earendil-works/pi-durable").Harness;
	readonly registry: Registry;
	readonly models: Models;
	private readonly personas = new Map<string, BotPersonaConfig>();
	private readonly mainSessions = new Map<string, Conversation>();
	private readonly routerExtension: Extension;
	private readonly workerExtension: Extension;
	private readonly personaSkillsExtension: Extension | undefined;
	private readonly dynamicExtensions = new Map<string, Extension>();
	/** Shared QuickJS sandbox behind the durable `codemode` tool; closed with the runtime. */
	private readonly codemodeSandbox: CodemodeSandbox | undefined;
	/** The installed `codemode` extension, added to every worker agent. */
	private readonly codemodeExtension: Extension | undefined;

	private constructor(
		harness: import("@earendil-works/pi-durable").Harness,
		registry: Registry,
		models: Models,
		routerExtension: Extension,
		workerExtension: Extension,
		personaSkillsExtension: Extension | undefined,
		codemodeSandbox?: CodemodeSandbox,
		codemodeExtension?: Extension,
	) {
		this.harness = harness;
		this.registry = registry;
		this.models = models;
		this.routerExtension = routerExtension;
		this.workerExtension = workerExtension;
		this.personaSkillsExtension = personaSkillsExtension;
		this.codemodeSandbox = codemodeSandbox;
		this.codemodeExtension = codemodeExtension;
	}

	static async open(options: HubRuntimeOptions = {}, context: Context = BACKGROUND_CONTEXT): Promise<HubDurableRuntime> {
		const storage =
			options.storage ??
			(options.dbPath !== undefined
				? await openNodeSqliteStorage(options.dbPath, { prefix: options.tablePrefix ?? "pi_" })
				: new MemoryStorage());
		const models = options.models ?? createModels();
		const registry = options.registry ?? createRegistry();
		registry.install(CodingTools);
		const workerExtension = createWorkerExtension();
		registry.install(workerExtension);
		// SubagentWorkflow is a session-wide capability: every Router and Worker
		// conversation can run deterministic crash-resumable multi-step workflows.
		registry.install(createWorkflowExtension());
		const personas = new Map<string, BotPersonaConfig>();
		const routerExtension = createRouterExtension({
			resolvePersona: (botId) => {
				const persona = personas.get(botId);
				if (persona === undefined) return undefined;
				return {
					botId: persona.botId,
					model: persona.model,
					instructions: personaInstructions(persona),
					nodeId: persona.nodeId,
					cwd: persona.cwd,
				};
			},
			workerAgent: options.workerAgent,
		});
		registry.install(routerExtension);
		// Persona skills & memory: every Router and Worker conversation can call
		// `load_skill` and `update_memory` against Hub SQLite, and the persona's
		// enabled skills are advertised as a prompt section.
		const personaSkillsExtension = options.skills === undefined ? undefined : createPersonaSkillsExtension(options.skills);
		if (personaSkillsExtension !== undefined) registry.install(personaSkillsExtension);
		// Codemode: model-written JavaScript in a shared QuickJS sandbox, with
		// deterministic replay across restarts. Installed registry-wide; worker
		// agents add the extension explicitly (see workerAgentFor).
		let codemodeSandbox: CodemodeSandbox | undefined;
		let codemodeExtension: Extension | undefined;
		if (options.codemode !== false) {
			try {
				codemodeSandbox = new CodemodeSandbox();
				codemodeExtension = createCodemodeExtension({ sandbox: codemodeSandbox });
				registry.install(codemodeExtension);
			} catch (err) {
				console.warn("[hub] codemode sandbox unavailable, continuing without:", err instanceof Error ? err.message : err);
			}
		}
		for (const extension of options.extensions ?? []) registry.install(extension);

		const harnessOptions: HarnessOptions = {
			models,
			registry,
			env:
				options.env === undefined
					? ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() })
					: options.env,
			...(options.onReport === undefined ? {} : { onReport: options.onReport as never }),
		};
		const harness = await Harness.open(storage, harnessOptions, context);
		const runtime = new HubDurableRuntime(
			harness,
			registry,
			models,
			routerExtension,
			workerExtension,
			personaSkillsExtension,
			codemodeSandbox,
			codemodeExtension,
		);
		// Persona lookups from tools run through this map (set via registerPersona).
		(runtime as unknown as { personas: Map<string, BotPersonaConfig> }).personas === personas; // keep reference alive
		runtime.#personaSource = personas;
		return runtime;
	}

	#personaSource: Map<string, BotPersonaConfig> | undefined;

	/** Register (or replace) a Bot persona available in this runtime. */
	registerPersona(persona: BotPersonaConfig): void {
		this.personas.set(persona.botId, persona);
		// The router extension resolves personas through the map captured at open;
		// sync it so late registrations AND persona updates propagate.
		if (this.#personaSource !== undefined) {
			this.#personaSource.set(persona.botId, persona);
		}
	}

	getPersona(botId: string): BotPersonaConfig | undefined {
		return this.personas.get(botId);
	}

	listPersonas(): BotPersonaConfig[] {
		return [...this.personas.values()];
	}

	/** Extensions mounted on a persona's Router and Worker conversations. */
	private personaExtensions(persona: BotPersonaConfig): Extension[] {
		const extensions: Extension[] = [];
		if (this.personaSkillsExtension !== undefined) extensions.push(this.personaSkillsExtension);
		for (const name of persona.enabledExtensions ?? []) {
			const ext = this.dynamicExtensions.get(name);
			if (ext !== undefined) extensions.push(ext);
		}
		return extensions;
	}

	/**
	 * Install a dynamic (user-authored) extension into the registry and track it
	 * by name, so personas listing it in `enabledExtensions` mount it on their
	 * Router and Worker conversations.
	 */
	installDynamicExtension(ext: Extension): void {
		this.registry.install(ext);
		this.dynamicExtensions.set(ext.name, ext);
	}

	/** A dynamically-installed extension by name, if any. */
	getDynamicExtension(name: string): Extension | undefined {
		return this.dynamicExtensions.get(name);
	}

	/** The installed codemode extension, when the sandbox is available. */
	getCodemodeExtension(): Extension | undefined {
		return this.codemodeExtension;
	}

	/**
	 * The router agent for a bot: persona model + persona instructions + the
	 * `botd-router` extension, with the raw coding tools (`read`/`write`/`edit`/
	 * `bash`) stripped from the model's tool surface — the foreground Router only
	 * answers, recalls, and dispatches; any hands-on work belongs to a worker.
	 */
	routerAgent(persona: BotPersonaConfig): AgentChange {
		return {
			model: persona.model,
			instructions: personaInstructions(persona),
			cwd: persona.cwd,
			extensions: { add: [this.routerExtension, ...this.personaExtensions(persona)] },
			modelTools: { remove: [...(CodingTools.tools ?? [])] },
		};
	}

	/** Each persona's 24/7 main session: one durable Router conversation per bot. */
	async ensureBotMainSession(botId: string, context: Context = BACKGROUND_CONTEXT): Promise<Conversation> {
		const persona = this.personas.get(botId);
		if (persona === undefined) throw new Error(`unknown persona: ${botId}`);
		const existing = this.mainSessions.get(botId);
		if (existing !== undefined) return existing;

		// Find a previously-created main session for this bot (restart recovery).
		const remembered = await this.harness.snapshot(SessionIndex, botId, context);
		if (remembered !== undefined) {
			const conversation = await this.harness.conversation(stringToConversationId(remembered.conversationId), context);
			if (conversation !== undefined) {
				this.mainSessions.set(botId, conversation);
				return conversation;
			}
		}

		const conversation = await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.routerAgent(persona),
				init: async (tx, id) => {
					const target = await tx.doc(TargetDoc, id);
					Object.assign(target, {
						botId,
						role: "router" as const,
						nodeId: persona.nodeId,
						cwd: persona.cwd,
						threadKeys: [],
						title: "main",
					});
					const index = await tx.doc(SessionIndex, botId, null);
					index.conversationId = conversationIdToString(id);
				},
			},
			context,
		);
		this.mainSessions.set(botId, conversation);
		return conversation;
	}

	/** An additional topic session for a bot (shows in the session list). */
	async createBotTopicSession(
		botId: string,
		title: string,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<Conversation> {
		const persona = this.personas.get(botId);
		if (persona === undefined) throw new Error(`unknown persona: ${botId}`);
		return this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.routerAgent(persona),
				init: async (tx, id) => {
					const target = await tx.doc(TargetDoc, id);
					Object.assign(target, {
						botId,
						role: "router" as const,
						nodeId: persona.nodeId,
						cwd: persona.cwd,
						threadKeys: [],
						title,
					});
				},
			},
			context,
		);
	}

	/**
	 * Fork a session into a background worker conversation. Used by hosts that
	 * spawn workers directly (tests, triggers); the router tool goes through
	 * `spawn_worker` instead, which also registers the worker.
	 */
	async forkSessionToWorker(
		sessionId: string,
		options: {
			botId: string;
			title: string;
			task: string;
			threadKey?: string;
			forkContext?: boolean;
		},
		context: Context = BACKGROUND_CONTEXT,
	): Promise<{ workerId: string; conversation: Conversation }> {
		const persona = this.personas.get(options.botId);
		if (persona === undefined) throw new Error(`unknown persona: ${options.botId}`);
		const parent = await this.harness.conversation(stringToConversationId(sessionId), context);
		if (parent === undefined) throw new Error(`unknown session: ${sessionId}`);

		let workerId = "";
		let conversationId = "";
		await this.harness.commit(async (tx) => {
			const fork = options.forkContext !== false;
			const latest = await tx.latestEntryId(stringToConversationId(sessionId));
			const record =
				fork && latest !== undefined
					? await tx.forkConversation(stringToConversationId(sessionId), latest, { ownership: { kind: "ownerless" } })
					: await tx.createConversation({ ownership: { kind: "ownerless" } });
			conversationId = conversationIdToString(record.id);
			await configure(tx, record.id, this.workerAgentFor(persona));
			const target = await tx.doc(TargetDoc, record.id);
			Object.assign(target, {
				botId: options.botId,
				role: "worker" as const,
				parentConversationId: sessionId,
				nodeId: persona.nodeId,
				cwd: persona.cwd,
				threadKeys: options.threadKey === undefined ? [] : [options.threadKey],
				title: options.title,
			});
			const registry = await tx.doc(WorkerRegistryDoc, stringToConversationId(sessionId));
			workerId = `w-${Object.keys(registry.workers).length + 1}-${record.id}`;
			registry.workers[workerId] = {
				workerId,
				conversationId,
				botId: options.botId,
				title: options.title,
				status: "running",
				threadKeys: options.threadKey === undefined ? [] : [options.threadKey],
				nodeId: persona.nodeId,
				cwd: persona.cwd,
				startedAt: Date.now(),
			};
			const recall = await tx.doc(RecallIndexDoc);
			recall.nodes[workerId] = {
				id: workerId,
				kind: "worker",
				title: options.title,
				summary: `Worker started: ${options.title}`,
				contentPreview: options.task.slice(0, 240),
				conversationId,
				relatedIds: [],
				createdAt: Date.now(),
			};
		}, context);

		const conversation = (await this.harness.conversation(stringToConversationId(conversationId), context))!;
		const submission = await conversation.submit(
			{
				type: "input",
				content: options.task,
				requestId: `worker-task:${workerId}`,
				entry: { kind: "botd.worker-task", data: { workerId, title: options.title } },
			},
			context,
		);
		return { workerId, conversation, ...({ submission } as object) } as { workerId: string; conversation: Conversation };
	}

	/**
	 * Worker agent: persona model + the `botd-worker` extension. CodingTools and
	 * SubagentWorkflow are installed host-wide, so the worker's default selection
	 * (all installed extensions) already carries them. `modelTools: null` clears
	 * any filter a forked parent carried: a worker always gets the coding tools back.
	 */
	workerAgentFor(persona: BotPersonaConfig): AgentChange {
		return {
			model: persona.model,
			instructions: personaInstructions(persona),
			cwd: persona.cwd,
			extensions: {
				add: [
					this.workerExtension,
					...(this.codemodeExtension === undefined ? [] : [this.codemodeExtension]),
					...this.personaExtensions(persona),
				],
			},
			modelTools: null,
		};
	}

	/** Submit a user message to a conversation (optionally steer a busy one). */
	async submitUserMessage(
		conversationId: string,
		content: string,
		options?: { requestId?: string; whenBusy?: "steer" | "followUp" },
		context: Context = BACKGROUND_CONTEXT,
	): Promise<Submission> {
		const conversation = await this.harness.conversation(stringToConversationId(conversationId), context);
		if (conversation === undefined) throw new Error(`unknown conversation: ${conversationId}`);
		return conversation.submit(
			{
				type: "input",
				content,
				...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
				...(options?.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
			},
			context,
		);
	}

	/** Active and recent workers of a Router conversation. */
	async getActiveWorkers(
		routerConversationId: string,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<WorkerEntry[]> {
		const registry = await this.harness.snapshot(
			WorkerRegistryDoc,
			stringToConversationId(routerConversationId),
			context,
		);
		if (registry === undefined) return [];
		return Object.values(registry.workers).sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Watch one conversation's structural view. */
	async watchConversationView(
		conversationId: string,
		onUpdate: (view: ConversationView) => void,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<() => Promise<void>> {
		const conversation = await this.harness.conversation(stringToConversationId(conversationId), context);
		if (conversation === undefined) throw new Error(`unknown conversation: ${conversationId}`);
		const watch = await conversation.watch(context);
		onUpdate(watch.value);
		await watch.start(async (call) => {
			if (call.kind === "value") onUpdate(call.value);
		});
		return async () => {
			await watch.stop();
		};
	}

	/** Watch the live task graph of the session. */
	async watchTasks(
		onUpdate: (graph: TaskGraph) => void,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<() => Promise<void>> {
		const watch = await this.harness.watchTaskGraph(context);
		onUpdate(watch.value);
		await watch.start(async (call) => {
			if (call.kind === "value") onUpdate(call.value);
		});
		return async () => {
			await watch.stop();
		};
	}

	/**
	 * Steer (or follow up on) a worker registered under a Router conversation.
	 * Returns false when the worker or its conversation is unknown.
	 */
	async steerWorker(
		routerConversationId: string,
		workerId: string,
		message: string,
		mode: "steer" | "followUp" = "steer",
		context: Context = BACKGROUND_CONTEXT,
	): Promise<boolean> {
		const entry = await this.findWorkerEntry(routerConversationId, workerId, context);
		if (entry === undefined) return false;
		const conversation = await this.harness.conversation(stringToConversationId(entry.conversationId), context);
		if (conversation === undefined) return false;
		await conversation.submit(
			{
				type: "input",
				content: message,
				whenBusy: mode,
				requestId: `steer:${workerId}:${Date.now()}`,
			},
			context,
		);
		return true;
	}

	/**
	 * Abort a worker registered under a Router conversation and mark it aborted.
	 * Returns false when the worker is unknown (an already-finished worker still
	 * aborts its conversation idempotently).
	 */
	async stopWorker(
		routerConversationId: string,
		workerId: string,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<boolean> {
		const entry = await this.findWorkerEntry(routerConversationId, workerId, context);
		if (entry === undefined) return false;
		// Mark first, then abort: an explicit stop wins over a completion report
		// that lands while the abort is in flight (same ordering as stop_worker).
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(WorkerRegistryDoc, stringToConversationId(routerConversationId));
			const record = doc.workers[workerId];
			if (record !== undefined && record.status === "running") {
				record.status = "aborted";
				record.finishedAt = Date.now();
			}
		}, context);
		const conversation = await this.harness.conversation(stringToConversationId(entry.conversationId), context);
		if (conversation !== undefined) await conversation.abort(context, { background: true }).catch(() => undefined);
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(WorkerRegistryDoc, stringToConversationId(routerConversationId));
			const record = doc.workers[workerId];
			if (record !== undefined && record.status === "running") {
				record.status = "aborted";
				record.finishedAt = Date.now();
			}
		}, context);
		return true;
	}

	/** Chain of Recall lookup by node id (worker, spill, thread, ...). */
	async recall(id: string, context: Context = BACKGROUND_CONTEXT): Promise<unknown> {
		const index = await this.harness.snapshot(RecallIndexDoc, context);
		return index?.nodes[id];
	}

	private async findWorkerEntry(
		routerConversationId: string,
		workerId: string,
		context: Context,
	): Promise<WorkerEntry | undefined> {
		const registry = await this.harness.snapshot(
			WorkerRegistryDoc,
			stringToConversationId(routerConversationId),
			context,
		);
		return registry?.workers[workerId];
	}

	/** Session-wide recall index. */
	async recallIndex(context: Context = BACKGROUND_CONTEXT) {
		return this.harness.snapshot(RecallIndexDoc, context);
	}
	async conversation(id: string, context: Context = BACKGROUND_CONTEXT): Promise<Conversation | undefined> {
		return this.harness.conversation(stringToConversationId(id), context);
	}

	async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.harness.close(context);
		// The sandbox owns worker threads outside the Harness; free them explicitly.
		await this.codemodeSandbox?.close().catch(() => undefined);
	}
}

export { ROUTER_EXTENSION, WORKER_EXTENSION, WORKER_EXTENSION_NAME, PERSONA_SKILLS_EXTENSION };
export type { PersonaResolver, WorkerAgentFactory, ToolRegistration, Registry, Storage };
