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
import { createModels, type ModelThinkingLevel, type Models } from "@earendil-works/pi-ai";
import {
	configure,
	createRegistry,
	Harness,
	MemoryStorage,
	type AgentChange,
	type CompactionResult,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type EntryId,
	type Extension,
	type HarnessOptions,
	type Registry,
	type Storage,
	type Submission,
	type TaskGraph,
	type TaskId,
	type ToolRegistration,
	type UserInput,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withSecretEnv } from "./secret-stash.js";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createPersonaSkillsExtension, PERSONA_SKILLS_EXTENSION, type PersonaSkillsOptions } from "./persona-skills-extension.js";
import { createRouterExtension, type PersonaResolver, ROUTER_EXTENSION, type WorkerAgentFactory, WORKER_EXTENSION } from "./router-extension.js";
import { createWorkerExtension, WORKER_EXTENSION_NAME } from "./worker-extension.js";
import { createWorkflowExtension } from "./workflow-extension.js";
import { RecallIndexDoc, SessionIndexDoc, TargetDoc, WorkerRegistryDoc, type WorkerEntry } from "./docs.js";
import type { Cursor } from "@earendil-works/pi-durable";

/** Configuration of one Bot persona. */
export interface BotPersonaConfig {
	botId: string;
	name: string;
	/** Subagents carry their parent primary bot's id here. */
	parentBotId?: string;
	/** One-line role description (subagent picker / persona listings). */
	description?: string;
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
	/** Thinking effort for the persona's model requests; `'max'` clamps to pi-durable's `'xhigh'`. */
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Extra env vars for the persona's shell commands, merged over the Hub process env. */
	env?: Record<string, string>;
	nodeId: string;
	cwd: string;
	/** 工具权限范围：all（默认全部工具）、readonly（禁用 write/edit/bash）、custom（仅启用 customTools 列表中的工具）。 */
	toolScope?: "all" | "readonly" | "custom";
	/** 当 toolScope === "custom" 时允许的工具名列表。 */
	customTools?: string[];
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

/** Persona thinking level as pi-durable's `ModelThinkingLevel`: `'max'` clamps to `'xhigh'`. */
function thinkingLevelFor(persona: BotPersonaConfig): ModelThinkingLevel | undefined {
	if (persona.thinkingLevel === undefined) return undefined;
	return persona.thinkingLevel === "max" ? "xhigh" : persona.thinkingLevel;
}

/** Session index: one main-session conversation id per bot persona (keyed by botId). */
const SessionIndex = SessionIndexDoc;

/**
 * NodeExecutionEnv with SecretStash injection: every shell exec receives the
 * active `BOTD_SECRET_*` env vars, so stashed secrets are consumable
 * cross-platform via process.env without appearing in command lines or LLM
 * context. Explicit per-call env entries win over the injected secrets.
 */
export class SecretInjectingEnv extends NodeExecutionEnv {
	async exec(
		command: string | readonly string[],
		options: import("@earendil-works/pi-durable/env").ShellExecOptions | undefined,
		context: Context,
	): Promise<import("@earendil-works/pi-durable/env").Result<import("@earendil-works/pi-durable/env").ShellExecResult, import("@earendil-works/pi-durable/env").ExecutionError>> {
		return super.exec(command, { ...options, env: withSecretEnv(options?.env) }, context);
	}
}

/**
 * 惰性幂等的本地 worktree 挂载：目录已存在则复用；否则 `git worktree add -B
 * <branchName> <worktreePath> HEAD`。非 git 仓库或任何失败回退 baseCwd。
 */
async function acquireLocalWorktree(
	baseCwd: string,
	worktreePath: string,
	branchName: string,
): Promise<string> {
	try {
		if (existsSync(worktreePath)) return worktreePath;
		const probe = await promisify(execFile)("git", ["-C", baseCwd, "rev-parse", "--is-inside-work-tree"]);
		if (probe.stdout.trim() !== "true") return baseCwd;
		await mkdir(path.dirname(worktreePath), { recursive: true });
		await promisify(execFile)("git", [
			"-C",
			baseCwd,
			"worktree",
			"add",
			"-B",
			branchName,
			worktreePath,
			"HEAD",
		]);
		return worktreePath;
	} catch {
		return baseCwd;
	}
}

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
	/** The shared workflow extension (SubagentWorkflow), added to every worker agent. */
	private readonly workflowExtension: Extension;
	/** Host-level extensions from `options.extensions`, appended after the builtin ones. */
	private readonly hostExtensions: readonly Extension[];

	private constructor(
		harness: import("@earendil-works/pi-durable").Harness,
		registry: Registry,
		models: Models,
		routerExtension: Extension,
		workerExtension: Extension,
		personaSkillsExtension: Extension | undefined,
		codemodeSandbox?: CodemodeSandbox,
		codemodeExtension?: Extension,
		workflowExtension?: Extension,
		hostExtensions?: readonly Extension[],
	) {
		this.harness = harness;
		this.registry = registry;
		this.models = models;
		this.routerExtension = routerExtension;
		this.workerExtension = workerExtension;
		this.personaSkillsExtension = personaSkillsExtension;
		this.codemodeSandbox = codemodeSandbox;
		this.codemodeExtension = codemodeExtension;
		this.workflowExtension = workflowExtension ?? createWorkflowExtension();
		this.hostExtensions = hostExtensions ?? [];
	}

	static async open(options: HubRuntimeOptions = {}, context: Context = BACKGROUND_CONTEXT): Promise<HubDurableRuntime> {
		/** conversationId -> mounted worktree path: each conversation acquires once. */
		const acquiredWorktrees = new Map<string, string>();
		const storage =
			options.storage ??
			(options.dbPath !== undefined
				? await openNodeSqliteStorage(options.dbPath, { prefix: options.tablePrefix ?? "pi_" })
				: new MemoryStorage());
		const models = options.models ?? createModels();
		const registry = options.registry ?? createRegistry();
		registry.install(CodingTools);
		const personas = new Map<string, BotPersonaConfig>();
		let runtime: HubDurableRuntime | undefined;
		/** Resolves a registered persona (or bot) as a real AgentChange: its own model, instructions, extensions and toolScope filter. */
		const resolveSubagentChange = (agentType: string, cwd?: string): AgentChange | undefined => {
			const persona = personas.get(agentType.replace(/^@/, ""));
			if (persona === undefined || runtime === undefined) return undefined;
			return { ...runtime.workerAgentFor(persona), cwd: cwd ?? persona.cwd };
		};
		const workerExtension = createWorkerExtension({ resolveSubagentChange });
		registry.install(workerExtension);
		// SubagentWorkflow is a session-wide capability: every Router and Worker
		// conversation can run deterministic crash-resumable multi-step workflows.
		// `agent(prompt, { agentType })` hits a registered subagent persona and runs
		// the step with that persona's real model/instructions/toolScope.
		const workflowExtension = createWorkflowExtension(undefined, { resolveSubagentChange });
		registry.install(workflowExtension);
		const routerExtension = createRouterExtension({
			resolvePersona: (botId) => {
				const persona = personas.get(botId);
				if (persona === undefined) return undefined;
				return {
					botId: persona.botId,
					...(persona.parentBotId === undefined ? {} : { parentBotId: persona.parentBotId }),
					...(persona.description === undefined || persona.description === "" ? {} : { description: persona.description }),
					model: persona.model,
					instructions: personaInstructions(persona),
					nodeId: persona.nodeId,
					cwd: persona.cwd,
					...(persona.toolScope === undefined ? {} : { toolScope: persona.toolScope }),
				};
			},
			listPersonas: () =>
				[...personas.values()].map((persona) => ({
					botId: persona.botId,
					name: persona.name,
					...(persona.parentBotId === undefined ? {} : { parentBotId: persona.parentBotId }),
					...(persona.description === undefined || persona.description === "" ? {} : { description: persona.description }),
					model: persona.model,
					...(persona.toolScope === undefined ? {} : { toolScope: persona.toolScope }),
					nodeId: persona.nodeId,
					cwd: persona.cwd,
				})),
			workerAgent: options.workerAgent ?? (({ botId, cwd }) => {
				const persona = personas.get(botId);
				if (persona === undefined || runtime === undefined) throw new Error(`unknown persona: ${botId}`);
				return { ...runtime.workerAgentFor(persona), cwd: cwd ?? persona.cwd };
			}),
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
					? async (target, context) => {
							// Persona env vars ride along as the conversation's shell env (merged over the process env).
							const targetState = await target.read.snapshot(TargetDoc, target.conversationId, context);
							const personaEnv = personas.get(targetState?.botId ?? "")?.env;
							const shellEnv: Record<string, string> = { ...(personaEnv ?? {}) };
							if (targetState?.botId) shellEnv.BOTD_BOT_ID = targetState.botId;
							if (targetState?.sessionId) shellEnv.BOTD_SESSION_ID = targetState.sessionId;
							// A target with a worktreePath executes in its isolated git worktree:
							// lazily mounted once per conversation (idempotent), falling back to
							// the base cwd outside a git repo or on failure.
							let cwd = target.cwd ?? process.cwd();
							if (targetState?.worktreePath) {
								const cached = acquiredWorktrees.get(String(target.conversationId));
								if (cached !== undefined) {
									cwd = cached;
								} else {
									const baseCwd = targetState.cwd || target.cwd || process.cwd();
									cwd = await acquireLocalWorktree(
										baseCwd,
										targetState.worktreePath,
										targetState.branchName ?? `botd/w-${target.conversationId}`,
									);
									acquiredWorktrees.set(String(target.conversationId), cwd);
								}
							}
							return new SecretInjectingEnv({
								cwd,
								...(Object.keys(shellEnv).length === 0 ? {} : { shellEnv }),
							});
					}
					: options.env,
			...(options.onReport === undefined ? {} : { onReport: options.onReport as never }),
		};
		const harness = await Harness.open(storage, harnessOptions, context);
		runtime = new HubDurableRuntime(
			harness,
			registry,
			models,
			routerExtension,
			workerExtension,
			personaSkillsExtension,
			codemodeSandbox,
			codemodeExtension,
			workflowExtension,
			options.extensions ?? [],
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

	/**
	 * Re-apply the current persona set to every existing conversation: after a
	 * config change (model, thinking, SYSTEM/MEMORY, toolScope, extensions),
	 * already-created Router and Worker conversations pick the new agent up on
	 * their next submission — no restart, no new conversation required.
	 */
	async syncPersonas(personas: readonly BotPersonaConfig[], context: Context = BACKGROUND_CONTEXT): Promise<void> {
		for (const persona of personas) this.registerPersona(persona);
		await this.harness.commit(async (tx) => {
			let next: Cursor | undefined;
			for (;;) {
				const page = await tx.scanConversations({}, 256, next);
				for (const record of page.items) {
					const target = await tx.doc(TargetDoc, record.id);
					const persona = target.botId === undefined ? undefined : this.personas.get(target.botId);
					if (persona === undefined) continue;
					const effectiveCwd = target.cwd || persona.cwd;
					if (target.role === "router") {
						await configure(tx, record.id, { ...this.routerAgent(persona), cwd: effectiveCwd });
					} else if (target.role === "worker") {
						await configure(tx, record.id, { ...this.workerAgentFor(persona), cwd: effectiveCwd });
					}
				}
				if (page.next === undefined) break;
				next = page.next;
			}
		}, context);
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
	 * `botd-router` extension + CodingTools, so the foreground Router can answer
	 * quick questions hands-on (read a file, run a light command) instead of
	 * spawning a worker for every trivium. Multi-step coding, long-running work
	 * and anything needing isolation still belongs to `spawn_worker` — the
	 * routing discipline lives in the router prompt. The persona's `toolScope`
	 * applies to the Router exactly as it does to workers (a `readonly` bot has
	 * no write/edit/bash anywhere).
	 *
	 * `extensions` is an EXACT array (not `{add}`): pi-durable treats an array as
	 * the whole selection, so no uninstalled-for-this-persona extension (other
	 * bots' dynamic extensions) can leak onto the Router's tool surface.
	 */
	routerAgent(persona: BotPersonaConfig): AgentChange {
		const thinkingLevel = thinkingLevelFor(persona);
		const extensions: Extension[] = [
			this.routerExtension,
			// CodingTools 回归 Router：快速问答、单步读文件、轻量命令当场完成。
			CodingTools,
			// SubagentWorkflow 是会话级能力：Router 也能直接跑确定性多步工作流
			//（历史上由 host 默认选择隐式携带，精确选择后必须显式列出）。
			this.workflowExtension,
			...this.personaExtensions(persona),
			...this.hostExtensions,
		];
		return {
			model: persona.model,
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			instructions: personaInstructions(persona),
			cwd: persona.cwd,
			extensions,
			...this.toolFilterFor(persona, extensions),
		};
	}

	/** Persona `toolScope` as a `tools`+`modelTools` pair, limiting BOTH the
	 * model-visible tool list and the caller (tools/codemode) layer. */
	private toolFilterFor(
		persona: BotPersonaConfig,
		extensions: readonly Extension[],
	): { tools: AgentChange["tools"]; modelTools: AgentChange["modelTools"] } {
		if (persona.toolScope === "readonly") {
			const writeTools = (CodingTools.tools ?? []).filter((tool) =>
				["write", "edit", "bash"].includes(tool.name),
			);
			return { tools: { remove: writeTools }, modelTools: { remove: writeTools } };
		}
		if (persona.toolScope === "custom") {
			const allowed = new Set(persona.customTools ?? []);
			const allowedTools = extensions.flatMap((ext) => (ext.tools ?? []).filter((tool) => allowed.has(tool.name)));
			return { tools: allowedTools, modelTools: allowedTools };
		}
		return { tools: null, modelTools: null };
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
			threadKeys?: string[];
			worktree?: boolean;
			cwd?: string;
			sessionId?: string;
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
			// Parent target first: the worker inherits its cwd / sessionId unless the
			// caller overrides them explicitly.
			const parentTarget = await tx.doc(TargetDoc, stringToConversationId(sessionId));
			const effectiveCwd = options.cwd || parentTarget.cwd || persona.cwd;
			// 上下文会话链：显式 sessionId > 父 target 继承 > 父会话本身
			//（Router 主会话未显式落 sessionId 时，worker 以父会话为上下文根）。
			const effectiveSessionId = options.sessionId || parentTarget.sessionId || sessionId;
			const threadKeys = options.threadKeys?.length ? options.threadKeys : (options.threadKey ? [options.threadKey] : []);
			const fork = options.forkContext === true;
			const latest = await tx.latestEntryId(stringToConversationId(sessionId));
			const record =
				fork && latest !== undefined
					? await tx.forkConversation(stringToConversationId(sessionId), latest, { ownership: { kind: "ownerless" } })
					: await tx.createConversation({ ownership: { kind: "ownerless" } });
			conversationId = conversationIdToString(record.id);
			const workerAgent = this.workerAgentFor(persona);
			// 分叉 worker 继承 Router 的精确扩展清单：未显式指定 extensions 的 agent
			// 重置为主机默认选择（全部已安装），保住编码工具与回报钩子。
			await configure(tx, record.id, {
				...workerAgent,
				cwd: effectiveCwd,
				...(workerAgent.extensions === undefined ? { extensions: null } : {}),
			});
			const registry = await tx.doc(WorkerRegistryDoc, stringToConversationId(sessionId));
			workerId = `w-${Object.keys(registry.workers).length + 1}-${record.id}`;
			const branchName = `botd/${workerId}`;
			const worktreePath = `${effectiveCwd}/.botd-worktrees/${workerId}`;
			const target = await tx.doc(TargetDoc, record.id);
			Object.assign(target, {
				botId: options.botId,
				role: "worker" as const,
				parentConversationId: sessionId,
				nodeId: persona.nodeId,
				cwd: effectiveCwd,
				...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
				...(options.worktree === true ? { worktreePath, branchName } : {}),
				threadKeys,
				title: options.title,
			});
			registry.workers[workerId] = {
				workerId,
				conversationId,
				botId: options.botId,
				title: options.title,
				status: "running",
				threadKeys,
				nodeId: persona.nodeId,
				cwd: effectiveCwd,
				...(options.worktree === true ? { worktreePath, branchName } : {}),
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
			if (options.worktree === true) {
				(recall.nodes[workerId] as unknown as Record<string, unknown>).data = { node: { worktreePath, branchName } };
			}
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
	 * Worker agent: persona model + the `botd-worker` extension + coding tools.
	 * `extensions` is an EXACT array (not `{add}`), so only CodingTools,
	 * SubagentWorkflow, botd-worker, codemode, the persona's own dynamic
	 * extensions and host extensions are mounted — nothing else from the
	 * registry leaks in. `modelTools`/`tools` enforce the persona's toolScope
	 * on both the model-visible and the caller layer.
	 */
	workerAgentFor(persona: BotPersonaConfig): AgentChange {
		const thinkingLevel = thinkingLevelFor(persona);
		const extensions: Extension[] = [
			CodingTools,
			this.workflowExtension,
			this.workerExtension,
			...(this.codemodeExtension === undefined ? [] : [this.codemodeExtension]),
			...this.personaExtensions(persona),
			...this.hostExtensions,
		];
		return {
			model: persona.model,
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			instructions: personaInstructions(persona),
			cwd: persona.cwd,
			extensions,
			...this.toolFilterFor(persona, extensions),
		};
	}

	/** Submit a user message to a conversation — plain text or text + images; optionally steer a busy one. */
	async submitUserMessage(
		conversationId: string,
		content: string,
		options?: {
			requestId?: string;
			whenBusy?: "steer" | "followUp" | "queue" | "reject";
			images?: Array<{ mimeType: string; data: string }>;
		},
		context: Context = BACKGROUND_CONTEXT,
	): Promise<Submission> {
		const conversation = await this.harness.conversation(stringToConversationId(conversationId), context);
		if (conversation === undefined) throw new Error(`unknown conversation: ${conversationId}`);
		const images = options?.images ?? [];
		const message: UserInput =
			images.length === 0
				? content
				: [
						{ type: "text", text: content },
						...images.map((image) => ({
							type: "image" as const,
							data: image.data,
							mimeType: image.mimeType,
						})),
					];
		// pi-durable has no queued `whenBusy`; a queued follow-up is the closest behavior.
		const whenBusy: "steer" | "followUp" | "reject" | undefined =
			options?.whenBusy === undefined
				? undefined
				: options.whenBusy === "queue"
					? "followUp"
					: options.whenBusy;
		return conversation.submit(
			{
				type: "input",
				content: message,
				...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
				...(whenBusy === undefined ? {} : { whenBusy }),
			},
			context,
		);
	}

	/** Fork a conversation at an entry via pi-durable's native zero-copy fork; `botId` re-targets the fork. */
	async forkConversation(
		sourceConversationId: ConversationId,
		atEntryId: EntryId,
		botId?: string,
		ctx: Context = BACKGROUND_CONTEXT,
	): Promise<Conversation> {
		const source = await this.harness.conversation(sourceConversationId, ctx);
		if (source === undefined) throw new Error(`unknown conversation: ${sourceConversationId}`);
		const persona = botId === undefined ? undefined : this.personas.get(botId);
		return source.fork(
			atEntryId,
			{
				ownership: { kind: "ownerless" },
				...(persona === undefined
					? {}
					: {
						agent: this.routerAgent(persona),
						init: async (tx, id) => {
							const target = await tx.doc(TargetDoc, id);
							target.botId = persona.botId;
							target.nodeId = persona.nodeId;
							target.cwd = persona.cwd;
						},
					}),
			},
			ctx,
		);
	}

	/** Reset a conversation's context via pi-durable's native `pi.reset` entry, carrying a handoff summary. */
	async resetConversation(
		conversationId: ConversationId,
		handoff?: string,
		ctx: Context = BACKGROUND_CONTEXT,
	): Promise<void> {
		const conv = await this.harness.conversation(conversationId, ctx);
		await conv?.reset(handoff, ctx);
	}

	/** Admit a manual compaction task; returns its id, or undefined for an unknown conversation. */
	async compactConversation(
		conversationId: ConversationId,
		instructions?: string,
		ctx: Context = BACKGROUND_CONTEXT,
	): Promise<TaskId<CompactionResult> | undefined> {
		const conv = await this.harness.conversation(conversationId, ctx);
		if (conv === undefined) return undefined;
		return conv.compact(instructions, ctx);
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
		// A message on a finished (completed/failed/aborted) worker wakes it for
		// another round: reset its status first so the new run's afterRun report is
		// accepted again and the UI light flips back to running immediately.
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(WorkerRegistryDoc, stringToConversationId(routerConversationId));
			const record = doc.workers[workerId];
			if (
				record !== undefined &&
				(record.status === "completed" || record.status === "failed" || record.status === "aborted")
			) {
				record.status = "running";
				delete record.finishedAt;
			}
		}, context);
		await conversation.submit(
			{
				type: "input",
				content: message,
				whenBusy: mode,
				requestId: `steer:${workerId}:${Date.now()}`,
				// Tagged like a worker task so the woken run's afterRun names the worker
				// and reports back exactly like the first round did.
				entry: { kind: "botd.worker-task", data: { workerId, title: entry.title } },
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
