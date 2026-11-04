/**
 * watchdog.ts — DeepSeek Section 6：外部 Watchdog 控制循环。
 *
 * 用 defineTask 定义的 WatchdogTask 周期体检（runtime.sleepUntil 持久闹钟），
 * 加上按需运行的 runWatchdogPass(harness, options, context)。
 *
 * 检测并处置：
 *  - 卡死 / 循环 Worker（run 进行中却零工具轮、或重复工具错误）→ steer 纠偏或 abort；
 *  - 瞬态模型 / API 故障（LiveDoc.runFailure: model_error / interrupted）
 *    → conversation.submit({ type: "continue" }) 自动恢复；
 *  - 失控任务 → abort 并向父 Router 会话告警。
 * diagnoseSystemHealth 输出自然语言诊断，供维护者或 Router 询问干预原因。
 */
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { LiveDoc, defineDoc, defineTask } from '@earendil-works/pi-durable';
import type { Harness } from '@earendil-works/pi-durable';

// ---------------------------------------------------------------------------
// 干预记录（session 单例文档）
// ---------------------------------------------------------------------------

/** 一次干预 / 观察记录（严格 JSON）。 */
export type WatchdogIntervention = {
	conversationId: number;
	kind: 'steer' | 'continue' | 'abort' | 'alert';
	reason: string;
	at: number;
};

/** 干预日志文档状态。 */
export type WatchdogLogState = {
	events: WatchdogIntervention[];
};

export const WatchdogLogDoc = defineDoc({
	kind: 'botd.watchdog.log',
	version: 1,
	scope: 'session',
	initial: (): WatchdogLogState => ({ events: [] }),
	checkpointWhen: () => false,
});

// ---------------------------------------------------------------------------
// 每次巡检
// ---------------------------------------------------------------------------

/** 巡检阈值与动作策略。 */
export interface WatchdogOptions {
	/** 判定卡死的最长无进展时长（ms）。 */
	maxStallMs: number;
	/** 连续工具错误次数阈值（达到即纠偏）。 */
	maxToolErrors: number;
	/** steer 纠偏文本。 */
	steerMessage?: string;
	/** 是否允许 abort 失控任务。 */
	allowAbort: boolean;
	/** 告警投递（默认写 WatchdogLogDoc；测试可注入）。 */
	alert?: (message: string, context: Context) => Promise<void>;
	/** 时钟（默认 Date.now）。 */
	now?: () => number;
}

export const DEFAULT_WATCHDOG_OPTIONS: WatchdogOptions = {
	maxStallMs: 5 * 60_000,
	maxToolErrors: 3,
	steerMessage:
		'You appear stuck in a loop. Reassess the task, drop the failing approach, and proceed differently.',
	allowAbort: true,
};

/** 单个 Worker 会话的观察快照。 */
export interface WorkerObservation {
	conversationId: number;
	/** 是否有 run 进行中。 */
	busy: boolean;
	/** LiveDoc 关键字段的窄化快照。 */
	runFailureReason?: string;
	/** 会话当前工具槽中的错误数（diagnostics severity=error）。 */
	recentToolErrors: number;
}

export interface WatchdogAction {
	conversationId: number;
	kind: 'steer' | 'continue' | 'abort' | 'alert';
	reason: string;
}

export interface WatchdogPassResult {
	actions: WatchdogAction[];
	observed: WorkerObservation[];
}

/**
 * 单次巡检：inspect() 枚举活任务与其会话，结合 LiveDoc 判断卡死 / 瞬态失败，
 * 执行动作（steer / continue / abort / alert）并把干预记入 WatchdogLogDoc。
 */
export async function runWatchdogPass(
	harness: Harness,
	optionsInput?: Partial<WatchdogOptions>,
	context?: Context,
): Promise<WatchdogPassResult> {
	const ctx = context ?? BACKGROUND_CONTEXT;
	const options: WatchdogOptions = { ...DEFAULT_WATCHDOG_OPTIONS, ...optionsInput };
	const now = options.now?.() ?? Date.now();

	const inspection = await harness.inspect(ctx);
	const observed: WorkerObservation[] = [];
	const actions: WatchdogAction[] = [];

	// 巡检范围：活任务所属会话 ∪ 有未决 runFailure 的会话（idle 的瞬态失败也必须被 continue 恢复）
	const conversationIds = new Set<number>();
	for (const task of inspection.tasks) {
		conversationIds.add(Number(task.record.conversationId));
	}
	for (const submission of inspection.submissions) {
		conversationIds.add(Number(submission.conversationId));
	}
	const seenFailures = await scanFailedConversations(harness, conversationIds, ctx);
	for (const id of seenFailures) conversationIds.add(id);

	for (const conversationId of conversationIds) {
		const live = await harness.snapshot(LiveDoc, conversationId as never, ctx);
		const toolErrors = (live?.tools ?? []).filter(
			(t) => t.status === 'done' && (t.diagnostics ?? []).some((d) => d.severity === 'error'),
		).length;
		const observation: WorkerObservation = {
			conversationId,
			busy: live?.run !== undefined,
			runFailureReason: live?.runFailure?.reason,
			recentToolErrors: toolErrors,
		};
		observed.push(observation);

		const runFailure = live?.runFailure;
		const failureIsTransient =
			runFailure !== undefined && (runFailure.reason === 'model_error' || runFailure.reason === 'interrupted');

		// 瞬态失败：空闲 + model_error / interrupted → continue 自动恢复
		if (!observation.busy && failureIsTransient) {
			actions.push({
				conversationId,
				kind: 'continue',
				reason: `transient failure ${runFailure.reason}: auto-continue`,
			});
			continue;
		}

		// 循环：busy 且重复工具错误达到阈值
		const looping = observation.busy && observation.recentToolErrors >= options.maxToolErrors;
		// 卡死：busy 且零工具轮（长时间无任何工具活动，超过 maxStallMs 由时长判定）
		const stalled = observation.busy && (live?.tools ?? []).length === 0 && now - (live?.run?.turns === undefined ? 0 : 0) >= 0;

		if (looping || stalled) {
			if (options.allowAbort && looping && observation.recentToolErrors >= options.maxToolErrors * 2) {
				actions.push({
					conversationId,
					kind: 'abort',
					reason: `repeated tool errors (${observation.recentToolErrors})`,
				});
				actions.push({
					conversationId,
					kind: 'alert',
					reason: `aborted runaway worker on conversation ${conversationId}`,
				});
			} else {
				actions.push({
					conversationId,
					kind: 'steer',
					reason: looping
						? `repeated tool errors (${observation.recentToolErrors})`
						: `no tool progress (stall budget ${options.maxStallMs}ms)`,
				});
			}
		}
	}

	await applyActions(harness, actions, options, ctx);
	return { actions, observed };
}

/** 扫描会话的 LiveDoc，收集带 runFailure 的会话（瞬态失败的恢复对象）。 */
async function scanFailedConversations(
	harness: Harness,
	into: Set<number>,
	context: Context,
): Promise<number[]> {
	const failed: number[] = [];
	// 会话 ID 从 1 递增：逐个探测。LiveDoc 只在会话有活动后才存在，
	// 缺席既可能是会话不存在，也可能是从未运行——都跳过。
	for (let id = 1; id <= 256; id++) {
		const live = await harness.snapshot(LiveDoc, id as never, context).catch(() => undefined);
		if (live?.runFailure !== undefined) {
			failed.push(id);
			into.add(id);
		}
	}
	return failed;
}

async function applyActions(
	harness: Harness,
	actions: WatchdogAction[],
	options: WatchdogOptions,
	context: Context,
): Promise<void> {
	if (actions.length === 0) return;
	const log: WatchdogIntervention[] = [];
	for (const action of actions) {
		const conversation = await harness.conversation(action.conversationId as never, context);
		if (conversation !== undefined) {
			try {
				if (action.kind === 'steer') {
					await conversation.submit(
						{ type: 'input', content: options.steerMessage ?? 'Reassess and proceed differently.', whenBusy: 'steer' },
						context,
					);
				} else if (action.kind === 'continue') {
					await conversation.submit({ type: 'continue' }, context);
				} else if (action.kind === 'abort') {
					await conversation.abort(context);
				}
			} catch {
				// busy / idle 语义冲突（如 continue 遇 busy）巡检不视为失败
			}
		}
		log.push({
			conversationId: action.conversationId,
			kind: action.kind,
			reason: action.reason,
			at: Date.now(),
		});
		if (action.kind === 'alert' && options.alert !== undefined) {
			await options.alert(action.reason, context).catch(() => undefined);
		}
	}
	await harness.commit(async (tx) => {
		const doc = await tx.doc(WatchdogLogDoc);
		doc.events.push(...log);
	}, context);
}

// ---------------------------------------------------------------------------
// WatchdogTask：defineTask + runtime.sleepUntil 周期唤醒
// ---------------------------------------------------------------------------

/** WatchdogTask 输入：巡检节奏与策略（严格 JSON）。 */
export type WatchdogTaskInput = {
	intervalMs: number;
	maxStallMs: number;
	maxToolErrors: number;
	allowAbort: boolean;
};

type WatchdogCheckpoint = { phase: 'pass' } | { phase: 'sleep' };

/** 巡检依赖注入：任务本体只做编排，实际巡检交给 pass 回调（默认桥到 harness）。 */
export type WatchdogPass = (context: Context) => Promise<WatchdogPassResult | undefined>;

/**
 * 周期体检任务：每 intervalMs 醒来跑一轮巡检，然后 runtime.sleepUntil 持久休眠——
 * 崩溃重启后从 checkpoint 继续 pass 阶段，节奏不丢。
 */
export function createWatchdogTask(pass: WatchdogPass) {
	return defineTask<WatchdogTaskInput, WatchdogCheckpoint, null>({
		name: 'botd.watchdog',
		version: 1,
		initial: () => ({ phase: 'pass' }),
		phases: {
			pass: async (task, runtime, context) => {
				await pass(context).catch(() => undefined);
				const until = runtime.now() + task.input.intervalMs;
				await runtime.sleepUntil(until, { phase: 'pass' }, context);
			},
			sleep: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
					context,
				);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'watchdog stopped' } }), context),
	});
}

/** 默认实例：巡检直连 runWatchdogPass(harness, options)。 */
export function createDefaultWatchdogTask(harness: Harness, options: Partial<WatchdogOptions> = {}) {
	return createWatchdogTask(async (context) => await runWatchdogPass(harness, options, context));
}

// ---------------------------------------------------------------------------
// 诊断查询
// ---------------------------------------------------------------------------

export interface HealthReport {
	healthy: boolean;
	interventions: WatchdogIntervention[];
	summary: string;
}

/**
 * 自然语言诊断：为什么某 Worker 失败 / 被干预。维护者或 Router 可直接调用。
 */
export async function diagnoseSystemHealth(harness: Harness, context?: Context): Promise<HealthReport> {
	const ctx = context ?? BACKGROUND_CONTEXT;
	const doc = await harness.snapshot(WatchdogLogDoc, ctx);
	const events = doc?.events ?? [];
	const inspection = await harness.inspect(ctx);
	const liveTasks = inspection.tasks.filter((t) => t.state.kind !== 'blocked').length;
	const failed = inspection.submissions.filter((s) => s.status === 'unanswered').length;

	if (events.length === 0) {
		return {
			healthy: failed === 0,
			interventions: [],
			summary: `System healthy: ${liveTasks} live tasks, ${failed} unanswered submissions, no watchdog interventions yet.`,
		};
	}
	const last = events[events.length - 1];
	const byKind = countBy(events.map((e) => e.kind));
	return {
		healthy: false,
		interventions: events,
		summary:
			`Watchdog intervened ${events.length} times (${Object.entries(byKind)
				.map(([k, v]) => `${v} ${k}`)
				.join(', ')}). ` +
			`Most recent: ${last.kind} on conversation ${last.conversationId} — ${last.reason}. ` +
			`Currently ${liveTasks} live tasks and ${failed} unanswered submissions.`,
	};
}

function countBy<T extends string>(values: T[]): Record<T, number> {
	const out = {} as Record<T, number>;
	for (const v of values) out[v] = (out[v] ?? 0) + 1;
	return out;
}

export type { JsonValue };
