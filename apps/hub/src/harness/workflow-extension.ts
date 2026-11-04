/**
 * workflow-extension.ts — 基于 @earendil-works/pi-durable 的崩溃可续跑 SubagentWorkflow。
 *
 * 取代旧的文件日志式 apps/node/src/cross-bot/workflow.ts：不再用 JSONL journal +
 * resumeFromRunId 手工回放，而是把每一步的产出提交为 pi-durable task memo。
 * 进程崩溃重开后同一脚本重跑时，已完成步骤直接从 memo 命中（0ms、不再调模型），
 * 未完成步骤继续在 task 拥有的子 Conversation 上执行。WorkflowRunDoc 以 SQLite
 * 事务记录 phases / logs / step journal，UI 通过 api.details 实时观看进度。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
	configure,
	defineDocFamily,
	defineExtension,
	defineTool,
} from '@earendil-works/pi-durable';
import type {
	AgentChange,
	ConversationId,
	Extension,
	SettledSubmissionRecord,
	ToolExecutionApi,
	ToolExecutionResult,
} from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { arr, bool, obj, opt, str, unknown as unknownSchema } from '@earendil-works/pi-schema';
import {
	extractWorkflowJson,
	parseWorkflowScript,
	type WorkflowScriptModule,
} from './workflow-script.js';
import { TargetDoc } from './docs.js';

export { extractWorkflowJson, parseWorkflowScript };
export type { WorkflowScriptModule };

/** 一步在 run doc 中的 journal 形状（严格 JSON）。 */
export type WorkflowStepJournalEntry = {
	key: string;
	label: string | null;
	phase: string | null;
	ok: boolean;
	replayed: boolean;
	value: JsonValue;
	error: string | null;
};

/** WorkflowRunDoc 的持久状态。 */
export type WorkflowRunDocState = {
	name: string;
	status: 'running' | 'completed' | 'failed';
	phases: string[];
	logs: string[];
	steps: WorkflowStepJournalEntry[];
	startedAt: number;
	endedAt: number;
	value: JsonValue;
	error: string | null;
};

/** 一次工作流运行的持久文档（scope: session 的 family，key = runId）。 */
export const WorkflowRunDoc = defineDocFamily({
	kind: 'botd.workflow.run',
	version: 1,
	scope: 'session',
	family: true,
	initial: (seed: { name: string; script: string }): WorkflowRunDocState => ({
		name: seed.name,
		status: 'running',
		phases: [],
		logs: [],
		steps: [],
		startedAt: 0,
		endedAt: 0,
		value: null,
		error: null,
	}),
	checkpointWhen: () => false,
});

/** SubagentWorkflow 工具参数。 */
export interface SubagentWorkflowArgs {
	script: string;
	args?: unknown;
	name?: string;
}

/** agent() 的可选项：标签、阶段、结构化输出、模型、隔离与门禁。 */
export interface WorkflowAgentOptions {
	label?: string;
	phase?: string;
	schema?: object;
	model?: string;
	effort?: string;
	isolation?: 'off' | 'worktree';
	worktree?: boolean;
	agentType?: string;
	gate?: string;
	resume?: string;
}

/** 子代理一步的 memo 产出（严格 JSON）。 */
export type WorkflowStepOutcome = {
	text: string;
	value: JsonValue;
	ok: boolean;
};

/** 工具 details（UI 实时视图，严格 JSON）。 */
export type WorkflowRunDetails = {
	runId: string;
	status: 'running' | 'completed' | 'failed';
	name: string;
	phases: string[];
	logs: string[];
	steps: WorkflowStepJournalEntry[];
	value: JsonValue;
};

const workflowParameters = obj({
	script: str(),
	args: opt(unknownSchema()),
	name: opt(str()),
});

const workflowStructuredOutput = obj({
	runId: str(),
	status: str(),
	name: str(),
	value: opt(unknownSchema()),
	error: opt(str()),
	steps: arr(obj({ key: str(), label: opt(str()), ok: bool(), replayed: bool(), value: opt(unknownSchema()) })),
	phases: arr(str()),
	logs: arr(str()),
});

/** 生成确定性步骤键：stepIndex + label 决定 memo 命中。 */
function stepKey(stepIndex: number, label: string | undefined): string {
	return `step:${stepIndex}:${label ?? ''}`;
}

function textOfContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((block) => {
			if (block !== null && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
				return (block as { text: string }).text;
			}
			return '';
		})
		.filter(Boolean)
		.join('\n');
}

/** 解析 "provider/modelId" 或裸 modelId。 */
function parseModelRef(spec: string): { provider: string; modelId: string } | null {
	const slash = spec.indexOf('/');
	if (slash > 0) return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
	return null;
}

/** 轻量 JSON Schema 校验（type / required / properties.*.type）。 */
export function matchesSchema(value: unknown, schema: object): boolean {
	const s = schema as { type?: string; required?: string[]; properties?: Record<string, { type?: string }> };
	if (s.type !== undefined && !typeMatches(value, s.type)) return false;
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		if (s.required !== undefined) {
			for (const key of s.required) {
				if (!(key in value)) return false;
			}
		}
		if (s.properties !== undefined) {
			for (const [key, prop] of Object.entries(s.properties)) {
				const v = (value as Record<string, unknown>)[key];
				if (v !== undefined && prop.type !== undefined && !typeMatches(v, prop.type)) return false;
			}
		}
	}
	return true;
}

function typeMatches(value: unknown, type: string): boolean {
	if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
	if (type === 'number') return typeof value === 'number';
	const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
	return actual === type;
}

function asJson(value: unknown): JsonValue {
	return value as JsonValue;
}

/** 提供给脚本体的宿主钩子。 */
export interface WorkflowHostHooks {
	agent: (prompt: string, opts?: WorkflowAgentOptions) => Promise<unknown>;
	phase: (title: string) => Promise<void>;
	log: (message: string) => Promise<void>;
	pipeline: <T, R>(items: readonly T[], ...stages: Array<(item: T) => Promise<R>>) => Promise<R[]>;
	parallel: <T>(thunks: ReadonlyArray<() => Promise<T>>, concurrency?: number) => Promise<Array<T | null>>;
	args: unknown;
}

/** 脚本运行器：默认直接调用解析出的模块 run()（node:vm 编译见 workflow-script.ts）。 */
export type WorkflowSandbox = (module: WorkflowScriptModule, hooks: WorkflowHostHooks) => Promise<unknown>;

export function createWorkflowSandbox(): WorkflowSandbox {
	return async (mod, hooks) => await mod.run(hooks);
}

export type WorkflowStepReport = { key: string; label?: string; ok: boolean; replayed: boolean; value?: unknown };

function structuredOf(
	runId: string,
	status: string,
	name: string,
	state: { value: JsonValue; error: string | null; phases: string[]; logs: string[]; steps: WorkflowStepJournalEntry[] },
): JsonValue {
	return {
		runId,
		status,
		name,
		value: state.value,
		error: state.error === null ? undefined : state.error,
		steps: state.steps.map((s) => asJson({
			key: s.key,
			label: s.label === null ? undefined : s.label,
			ok: s.ok,
			replayed: s.replayed,
			value: s.value,
		})),
		phases: state.phases,
		logs: state.logs,
	} as JsonValue;
}

function detailsOf(runId: string, state: WorkflowRunDocState): WorkflowRunDetails {
	return {
		runId,
		status: state.status,
		name: state.name,
		phases: state.phases,
		logs: state.logs,
		steps: state.steps.map((s) => ({ ...s })),
		value: state.value,
	};
}

/**
 * 创建 SubagentWorkflow 工具及承载它的扩展。sandbox 决定脚本执行方式（默认 node:vm 解析器）。
 */
export function createWorkflowExtension(sandbox: WorkflowSandbox = createWorkflowSandbox()): Extension {
	const SubagentWorkflow = defineTool({
		name: 'SubagentWorkflow',
		description:
			'Run a deterministic multi-step agent workflow. The script exports `const meta = { name, description, phases }` and an async body using agent()/pipeline()/parallel()/phase()/log(). Completed steps memoize durably, so a crash restart resumes without re-running them.',
		parameters: workflowParameters,
		replay: 'safe',
		structuredOutputSchema: workflowStructuredOutput,
		execute: async (
			args: SubagentWorkflowArgs,
			api: ToolExecutionApi<WorkflowRunDetails>,
			context,
		): Promise<ToolExecutionResult<WorkflowRunDetails>> => {
			const runId = `wf_${Math.random().toString(36).slice(2, 12)}`;
			const parsed = parseWorkflowScript(args.script);
			const meta = 'error' in parsed ? { name: args.name ?? 'workflow' } : parsed.meta;

			// 标签 → 子会话：同一次执行内 resume(label) 直接复用对应子会话。
			const labelConversations = new Map<string, ConversationId>();
			const state: WorkflowRunDocState = {
				name: meta.name,
				status: 'running',
				phases: [],
				logs: [],
				steps: [],
				startedAt: 0,
				endedAt: 0,
				value: null,
				error: null,
			};
			let stepIndex = 0;
			let currentPhase = meta.phases?.[0] ?? '';

			if ('error' in parsed) {
				state.status = 'failed';
				state.error = parsed.error;
				return {
					isError: true,
					output: [{ type: 'text', text: `Workflow script error: ${parsed.error}` }],
					structuredOutput: structuredOf(runId, 'failed', state.name, state),
					details: detailsOf(runId, state),
				};
			}

			const persist = async (mutation: (doc: WorkflowRunDocState) => void): Promise<void> => {
				await api.commit(async (tx) => {
					const doc = await tx.doc(WorkflowRunDoc, runId, { name: meta.name, script: args.script });
					mutation(doc as WorkflowRunDocState);
				}, context);
			};

			const emit = async (): Promise<void> => {
				await api.details(detailsOf(runId, state), context);
			};

			/** 子代理答案文本：从 answer entry 的 assistant 消息提取。 */
			const answerText = async (settled: SettledSubmissionRecord): Promise<string> => {
				if (settled.status !== 'done' || settled.type !== 'input') return '';
				const answerEntry = settled.answer;
				let text = '';
				await api.commit(async (tx) => {
					const entry = await tx.entry(answerEntry);
					const message = entry?.model?.[0];
					if (message !== undefined && message.role === 'assistant') {
						text = textOfContent((message as { content?: unknown }).content);
					}
				}, context);
				return text;
			};

			/**
			 * agent(prompt, opts)：崩溃可续跑的子代理步骤。
			 * memo 命中即回放；否则在 task 拥有的子 Conversation 上以 requestId 幂等提交；
			 * gate 失败 / schema 校验失败判步失败；产出提交 memo。
			 */
			const runAgentStep = async (prompt: string, opts?: WorkflowAgentOptions): Promise<unknown> => {
				const key = stepKey(stepIndex++, opts?.label);
				if (opts?.phase) currentPhase = opts.phase;
				const label = opts?.label ?? null;
				const phaseName = currentPhase || null;

				const cached = await api.memo<WorkflowStepOutcome>(key, context);
				if (cached !== undefined) {
					state.steps.push({ key, label, phase: phaseName, ok: cached.ok, replayed: true, value: cached.value, error: null });
					await persist((doc) => {
						doc.steps.push({ key, label, phase: phaseName, ok: cached.ok, replayed: true, value: cached.value, error: null });
					});
					await emit();
					if (!cached.ok) return null;
					return cached.value !== null && cached.value !== undefined ? cached.value : cached.text;
				}

				const requestId = `${api.taskId}:${key}`;
				let stepWorktreePath = '';
				let stepBranchName = '';
				let childId: ConversationId;
				const resumed = opts?.resume !== undefined ? labelConversations.get(opts.resume) : undefined;
				if (resumed !== undefined) {
					childId = resumed;
				} else {
					childId = await api.commit(async (tx) => {
						// 崩溃重放：按 TargetDoc.title === key 命中本步已创建的子会话。
						// 不能只取第一个 —— 同一 workflow 的所有 step 和 parallel() 分支
						// 共享 ownerTaskId，各自拥有独立子会话。
						const owned = await tx.scanConversations({ ownerTaskId: api.taskId }, 256);
						for (const existing of owned.items) {
							const existingTarget = await tx.doc(TargetDoc, existing.id);
							if (existingTarget.title === key) return existing.id;
						}
						const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
						const change: { model?: AgentChange['model']; thinkingLevel?: AgentChange['thinkingLevel']; instructions?: string } = {};
						const modelRef = opts?.model !== undefined ? parseModelRef(opts.model) : null;
						if (modelRef !== null) change.model = modelRef;
						if (opts?.effort !== undefined) change.thinkingLevel = opts.effort as AgentChange['thinkingLevel'];
						if (opts?.agentType !== undefined) change.instructions = `You are a "${opts.agentType}" subagent.`;
						// 步骤子代理是干活的全能子代理：清空父会话可能携带的模型工具过滤器
						//（Router 剥掉了编码工具，子代理必须拿回来）。
						await configure(tx, created.id, { ...change, modelTools: null });

						// 隔离：显式 worktree 建独立分支；否则继承父会话的 worktree（若有）。
						const parentTarget = await tx.doc(TargetDoc, api.conversationId);
						const useWorktree = opts?.isolation === 'worktree' || opts?.worktree === true;
						let worktreePath = '';
						let branchName = '';
						if (useWorktree) {
							const baseCwd = parentTarget.cwd || process.cwd();
							const wfId = `wf-${created.id}`;
							worktreePath = `${baseCwd}/.botd-worktrees/${wfId}`;
							branchName = `botd/${wfId}`;
						} else if (opts?.isolation !== 'off' && parentTarget.worktreePath) {
							worktreePath = parentTarget.worktreePath;
							branchName = parentTarget.branchName ?? '';
						}
						const childTarget = await tx.doc(TargetDoc, created.id);
						Object.assign(childTarget, {
							botId: parentTarget.botId,
							role: 'subagent' as const,
							parentConversationId: String(api.conversationId),
							nodeId: parentTarget.nodeId,
							cwd: parentTarget.cwd,
							...(parentTarget.sessionId ? { sessionId: parentTarget.sessionId } : {}),
							...(worktreePath ? { worktreePath, branchName } : {}),
							threadKeys: [],
							title: key,
						});
						if (worktreePath !== '') {
							stepWorktreePath = worktreePath;
							stepBranchName = branchName;
						}
						return created.id;
					}, context);
				}
				if (opts?.label !== undefined) labelConversations.set(opts.label, childId);
				// resume 命中已存在子会话时也要拿到其 worktree 供 gate 使用。
				if (stepWorktreePath === '') {
					const childTarget = await api.snapshot(TargetDoc, childId, context);
					if (childTarget?.worktreePath !== undefined) {
						stepWorktreePath = childTarget.worktreePath;
						stepBranchName = childTarget.branchName ?? '';
					}
				}

				await api.details({ conversationId: childId } as unknown as WorkflowRunDetails, context);

				const child = await api.conversation(childId, context);
				if (child === undefined) throw new Error('workflow child conversation is gone');
				const settled = await (await child.submit({ type: 'input', content: prompt, requestId }, context)).wait(context);

				if (settled.status !== 'done') {
					const reason = settled.reason;
					const outcome: WorkflowStepOutcome = { text: '', value: null, ok: false };
					await api.memo(key, outcome, context);
					state.steps.push({ key, label, phase: phaseName, ok: false, replayed: false, value: null, error: reason });
					await persist((doc) => {
						doc.steps.push({ key, label, phase: phaseName, ok: false, replayed: false, value: null, error: reason });
					});
					await emit();
					return null;
				}

				const text = await answerText(settled);

				// gate：shell 门禁；非零退出码或执行错误判步失败。本步在独立 worktree
				// 中时，gate 必须在同一 worktree 目录下运行（先确保挂载，再 cd 进去执行）。
				if (opts?.gate !== undefined) {
					const env = await apiEnv(api, context);
					if (env === undefined) throw new Error('workflow gate requires an execution env');
					let gateCommand = opts.gate;
					if (stepWorktreePath !== '') {
						await ensureWorktree(stepWorktreePath, stepBranchName);
						gateCommand = `cd "${stepWorktreePath}" && (${opts.gate})`;
					}
					const gateResult = await env.exec(gateCommand, undefined, context);
					if (!gateResult.ok || gateResult.value?.exitCode !== 0) {
						const detail = gateResult.ok ? `exit ${gateResult.value?.exitCode}` : (gateResult.error?.message ?? 'exec failed');
						const outcome: WorkflowStepOutcome = { text: `gate failed: ${opts.gate} (${detail})`, value: null, ok: false };
						await api.memo(key, outcome, context);
						state.steps.push({ key, label, phase: phaseName, ok: false, replayed: false, value: null, error: outcome.text });
						await persist((doc) => {
							doc.steps.push({ key, label, phase: phaseName, ok: false, replayed: false, value: null, error: outcome.text });
						});
						await emit();
						return null;
					}
				}

				let value: JsonValue = null;
				if (opts?.schema !== undefined) {
					const extracted = extractWorkflowJson(text);
					if (extracted === undefined || !matchesSchema(extracted, opts.schema)) {
						const outcome: WorkflowStepOutcome = { text, value: null, ok: false };
						await api.memo(key, outcome, context);
						state.steps.push({ key, label, phase: phaseName, ok: false, replayed: false, value: null, error: 'schema validation failed' });
						await persist((doc) => {
							doc.steps.push({ key, label, phase: phaseName, ok: false, replayed: false, value: null, error: 'schema validation failed' });
						});
						await emit();
						return null;
					}
					value = asJson(extracted);
				}

				const outcome: WorkflowStepOutcome = { text, value: opts?.schema !== undefined ? value : null, ok: true };
				await api.memo(key, outcome, context);
				const storedValue = opts?.schema !== undefined ? value : asJson(text);
				state.steps.push({ key, label, phase: phaseName, ok: true, replayed: false, value: storedValue, error: null });
				await persist((doc) => {
					doc.steps.push({ key, label, phase: phaseName, ok: true, replayed: false, value: storedValue, error: null });
				});
				await emit();
				return opts?.schema !== undefined ? value : text;
			};

			const phase = async (title: string): Promise<void> => {
				currentPhase = title;
				if (!state.phases.includes(title)) state.phases.push(title);
				await persist((doc) => {
					if (!doc.phases.includes(title)) doc.phases.push(title);
				});
				await emit();
			};

			const log = async (message: string): Promise<void> => {
				state.logs.push(message);
				await persist((doc) => {
					doc.logs.push(message);
				});
				await emit();
			};

			/** pipeline(items, ...stages)：条目独立流过所有阶段，阶段间无 barrier。 */
			const pipeline = async <T, R>(items: readonly T[], ...stages: Array<(item: T) => Promise<R>>): Promise<R[]> => {
				const runners = items.map(async (item) => {
					let current: unknown = item;
					for (const stage of stages) {
						current = await stage(current as T);
					}
					return current as R;
				});
				const settledRuns = await Promise.allSettled(runners);
				const results: R[] = [];
				for (const s of settledRuns) if (s.status === 'fulfilled') results.push(s.value);
				return results;
			};

			/** parallel(thunks)：并发上限执行，失败 thunk 解析为 null。 */
			const parallel = async <T>(thunks: ReadonlyArray<() => Promise<T>>, concurrency = 4): Promise<Array<T | null>> => {
				const results: Array<T | null> = new Array<T | null>(thunks.length).fill(null);
				let cursor = 0;
				const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), thunks.length) }, async () => {
					for (;;) {
						const index = cursor++;
						if (index >= thunks.length) return;
						try {
							results[index] = await thunks[index]();
						} catch {
							results[index] = null;
						}
					}
				});
				await Promise.all(workers);
				return results;
			};

			state.startedAt = api.now();
			await persist((doc) => {
				doc.status = 'running';
				doc.startedAt = state.startedAt;
			});
			await phase(currentPhase || 'Run');

			try {
				const value = asJson(
					await sandbox(parsed.module, {
						agent: runAgentStep,
						phase,
						log,
						pipeline,
						parallel,
						args: args.args,
					}),
				);
				state.value = value;
				state.status = 'completed';
				await persist((doc) => {
					doc.value = value;
					doc.status = 'completed';
					doc.endedAt = api.now();
				});
				await emit();
				return {
					output: [{ type: 'text', text: `Workflow "${meta.name}" completed (runId: ${runId})\nResult: ${JSON.stringify(value)}` }],
					structuredOutput: structuredOf(runId, 'completed', meta.name, state),
					details: detailsOf(runId, state),
				};
			} catch (error) {
				state.status = 'failed';
				state.error = error instanceof Error ? error.message : String(error);
				await persist((doc) => {
					doc.status = 'failed';
					doc.endedAt = api.now();
					doc.error = state.error ?? null;
				});
				await emit();
				return {
					isError: true,
					output: [{ type: 'text', text: `Workflow "${meta.name}" failed (runId: ${runId}): ${state.error}` }],
					structuredOutput: structuredOf(runId, 'failed', meta.name, state),
					details: detailsOf(runId, state),
				};
			}
		},
	});

	return defineExtension({ name: 'subagent-workflow', tools: [SubagentWorkflow] });
}

/** 惰性幂等的本地 worktree 挂载：目录已存在则复用，否则从基准仓库创建；失败静默（gate 回退原目录）。 */
async function ensureWorktree(worktreePath: string, branchName: string): Promise<void> {
	try {
		if (existsSync(worktreePath)) return;
		const repoDir = dirname(dirname(worktreePath));
		await mkdir(dirname(worktreePath), { recursive: true });
		await new Promise<void>((resolve, reject) => {
			execFile('git', ['-C', repoDir, 'worktree', 'add', '-B', branchName, worktreePath, 'HEAD'], (error) => {
				if (error !== null && error !== undefined) reject(error);
				else resolve();
			});
		});
	} catch {
		// 非 git 仓库或创建失败：保持现状，gate 的 cd 会在同一命令里失败并给出可读错误。
	}
}

/** api.env 是 ToolExecutionApi 上的同步属性（可能为 undefined）。 */
function apiEnv(
	api: ToolExecutionApi,
	_context: unknown,
): Promise<
	| {
			exec: (
				command: string,
				options: unknown,
				context: unknown,
			) => Promise<{ ok: boolean; value?: { exitCode: number }; error?: Error }>;
	  }
	| undefined
> {
	const env = (api as unknown as { env?: unknown }).env;
	return Promise.resolve(
		env === undefined
			? undefined
			: env as {
					exec: (
						command: string,
						options: unknown,
						context: unknown,
					) => Promise<{ ok: boolean; value?: { exitCode: number }; error?: Error }>;
				},
	);
}
