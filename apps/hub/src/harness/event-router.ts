/**
 * event-router.ts — DeepSeek Section 3：事件驱动触发、订阅与直通、内联外溢、投机执行。
 *
 * 3.1 两级事件过滤：filterEventFastPath 用确定性规则在 0ms 内丢弃噪声（不调 LLM）。
 * 3.2 线程订阅与直通路由：threadKey（如 github:pr:botd#42）→ 活跃 Worker 会话的多对多
 *     订阅表（ThreadSubscriptionsDoc）；已订阅线程上的事件绕过 Router LLM，直接投递。
 * 3.3 内联与外溢：超限载荷外溢进 SpillStoreDoc，正文留下 recall 指针（Chain of Recall）。
 * 3.4 投机执行：候选事件静默起后台 Worker，仅验证成功（confirmed）才上报 Router。
 */
import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import type { Conversation, ConversationId, Harness } from '@earendil-works/pi-durable';
import { RecallIndexDoc } from './docs.js';

// ---------------------------------------------------------------------------
// 事件模型
// ---------------------------------------------------------------------------

/** 入站事件的确定性字段。 */
export interface IncomingEvent {
	/** 事件来源标识，如 "github"、"slack"。 */
	source: string;
	/** 事件类型，如 "pr.comment"、"issue.opened"、"im.message"。 */
	type: string;
	/** 发送者标识（用户 / bot / webhook 名）。 */
	sender: string;
	/** 目标线程标识载荷，用于推导 threadKey。 */
	target?: { kind?: string; repo?: string; number?: number | string; chatId?: string; threadId?: string };
	/** 事件摘要（内联展示用）。 */
	summary: string;
	/** 事件唯一 ID（如 webhook delivery id）；缺省时每次投递生成单调递增序号避免去重碰撞。 */
	id?: string;
	/** 全文载荷（超限外溢）。 */
	payload?: string;
	/** 时间 / 空间上相邻的消息（回复引用、相邻 review 评论等）。 */
	adjacent?: string[];
}

/** 3.1 快速路径过滤策略。 */
export interface EventFilterPolicy {
	/** 允许的来源；空数组 = 不限。 */
	source?: string[];
	/** 允许的事件类型；空数组 = 不限。 */
	eventTypes?: string[];
	/** 发送者白名单；空数组 = 不限。 */
	senderWhitelist?: string[];
	/** 处置模式：仅显式触发 / 候选（可投机）/ 忽略。 */
	mode: 'explicit_only' | 'candidate' | 'ignore';
}

export type FastPathVerdict =
	| { action: 'drop'; reason: string }
	| { action: 'accept'; mode: 'explicit_only' | 'candidate' };

/** 3.1 两级过滤的快速路径：纯规则判定，永不调 LLM。 */
export function filterEventFastPath(event: IncomingEvent, policy: EventFilterPolicy): FastPathVerdict {
	if (policy.mode === 'ignore') return { action: 'drop', reason: `mode=ignore` };
	if (policy.source !== undefined && policy.source.length > 0 && !policy.source.includes(event.source)) {
		return { action: 'drop', reason: `source ${event.source} not allowed` };
	}
	if (policy.eventTypes !== undefined && policy.eventTypes.length > 0 && !policy.eventTypes.includes(event.type)) {
		return { action: 'drop', reason: `event type ${event.type} not allowed` };
	}
	if (policy.senderWhitelist !== undefined && policy.senderWhitelist.length > 0 && !policy.senderWhitelist.includes(event.sender)) {
		return { action: 'drop', reason: `sender ${event.sender} not whitelisted` };
	}
	return { action: 'accept', mode: policy.mode };
}

// ---------------------------------------------------------------------------
// 3.2 线程订阅与直通
// ---------------------------------------------------------------------------

/** threadKey ↔ 活跃 Worker conversationId 的多对多映射（scope: session 单例）。 */
export type ThreadSubscriptionsState = {
	/** threadKey -> 订阅的 worker conversationId（数字转字符串）。 */
	subs: Record<string, string[]>;
};

export const ThreadSubscriptionsDoc = defineDoc<ThreadSubscriptionsState>({
	kind: 'botd.event.threadSubscriptions',
	version: 1,
	scope: 'session',
	initial: (): ThreadSubscriptionsState => ({ subs: {} }),
	checkpointWhen: () => false,
});

/** 从事件推导确定性 threadKey：github:pr:<repo>#<n> / github:issue:<repo>#<n> / im:thread:<chat>:<thread>。 */
export function threadKeyOf(event: IncomingEvent): string | undefined {
	const t = event.target ?? {};
	if (t.repo !== undefined && t.number !== undefined) {
		const kind = t.kind === 'issue' ? 'issue' : 'pr';
		return `github:${kind}:${t.repo}#${t.number}`;
	}
	if (t.chatId !== undefined && t.threadId !== undefined) {
		return `im:thread:${t.chatId}:${t.threadId}`;
	}
	return undefined;
}

/** 路由结果：直通（绕过 Router）或慢路径（交给 Router 会话）。 */
export type RouteOutcome =
	| {
			action: 'passthrough';
			threadKey: string;
			deliveredTo: string[];
			/** 直通路径不消耗 Router LLM 调用。 */
			routerLlmCalls: 0;
	  }
	| {
			action: 'router';
			threadKey: string | undefined;
			/** Router 会话（慢路径必填）。 */
			router: Conversation;
			routerLlmCalls: 1;
	  };

/** Router 决策产物：默认实现是“起一个 Worker 并订阅线程”。 */
export interface RouterDecision {
	/** Router 决定订阅该线程的 Worker 会话。 */
	worker: Conversation;
	/** Router 自己回复事件的文本（可选）。 */
	reply?: string;
}

/** EventRouter 的宿主依赖：Router 会话来源、Worker 工厂、投机执行工厂。 */
export interface EventRouterDeps {
	harness: Harness;
	/** 慢路径时取得目标 Bot 的 Router 会话。 */
	resolveRouter: (event: IncomingEvent) => Promise<Conversation>;
	/** Router 决策：真实实现由 Router LLM 输出；测试可注入确定性决策。 */
	decide: (event: IncomingEvent, router: Conversation) => Promise<RouterDecision | undefined>;
	/** 投机执行（3.4）：静默后台 Worker；默认 triggerSpeculativeWorker。 */
	speculative?: (event: IncomingEvent, policy: EventFilterPolicy, context: Context) => Promise<SpeculativeResult | undefined>;
}

export interface RouterStats {
	routerLlmCalls: number;
	passthroughDeliveries: number;
}

/** handleEvent 的可选参数：触发器侧（webhook/cron）与常规路由共用的统一入口配置。 */
export interface HandleEventOptions {
	/** 调用方已推导的 threadKey（如 webhook 的 GitHub 约定推导），优先于 threadKeyOf(event)。 */
	explicitThreadKey?: string;
}

/**
 * 事件路由器。用法：
 *   const router = new EventRouter(deps);
 *   await router.handleEvent(event, policy, context);
 */
export class EventRouter {
	#deps: EventRouterDeps;
	#stats: RouterStats = { routerLlmCalls: 0, passthroughDeliveries: 0 };

	constructor(deps: EventRouterDeps) {
		this.#deps = deps;
	}

	get stats(): RouterStats {
		return { ...this.#stats };
	}

	/** 读取线程的当前订阅（持久文档快照）。 */
	async subscriptions(threadKey: string, context: Context): Promise<string[]> {
		const doc = await this.#deps.harness.snapshot(ThreadSubscriptionsDoc, context);
		return doc?.subs[threadKey] ? [...doc.subs[threadKey]] : [];
	}

	/** 订阅：把 worker 会话加入 threadKey 的订阅表（幂等）。 */
	async subscribeThread(workerConversationId: ConversationId, threadKey: string, context: Context): Promise<void> {
		const id = String(workerConversationId);
		await this.#deps.harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadSubscriptionsDoc);
			const list = doc.subs[threadKey] ?? [];
			if (!list.includes(id)) list.push(id);
			doc.subs[threadKey] = list;
		}, context);
	}

	/** 退订：从 threadKey 移除 worker；空表项清理。 */
	async unsubscribeThread(workerConversationId: ConversationId, threadKey: string, context: Context): Promise<void> {
		const id = String(workerConversationId);
		await this.#deps.harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadSubscriptionsDoc);
			const list = doc.subs[threadKey];
			if (list === undefined) return;
			const next = list.filter((w) => w !== id);
			if (next.length === 0) delete doc.subs[threadKey];
			else doc.subs[threadKey] = next;
		}, context);
	}

	/**
	 * 仅线程直通（无慢路径）：threadKey 命中活跃 Worker 订阅时，把事件经
	 * Inline & Spill 格式化后投递给全部订阅 Worker（requestId 基于去重键，
	 * 基于 event.id 幂等）；无订阅或订阅会话已不存在时返回 undefined，
	 * 调用方自行走慢路径。供触发器侧（webhook/cron）复用统一管线。
	 */
	async tryThreadPassthrough(
		threadKey: string,
		event: IncomingEvent,
		context: Context,
	): Promise<string[] | undefined> {
		const subscribers = await this.subscriptions(threadKey, context);
		if (subscribers.length === 0) return undefined;
		const reqKey = eventKey(event);
		const formatted = await formatEventInlineAndSpill(this.#deps.harness, event, context);
		const delivered: string[] = [];
		for (const id of subscribers) {
			const worker = await this.#deps.harness.conversation(Number(id) as ConversationId, context);
			if (worker === undefined) continue;
			await worker.submit(
				{
					type: 'input',
					content: formatted.inline,
					whenBusy: 'steer',
					requestId: `event:${threadKey}:${reqKey}`,
				},
				context,
			);
			delivered.push(id);
		}
		if (delivered.length === 0) return undefined;
		this.#stats.passthroughDeliveries += delivered.length;
		return delivered;
	}

	/**
	 * 事件主入口：快速过滤 → 直通（已订阅）→ 慢路径 Router。
	 * candidate 模式的事件同时触发投机执行。
	 * options.explicitThreadKey 允许触发器侧传入已推导的线程键；事件路由、
	 * 线程直通与 Inline & Spill（含 RecallIndex 登记）在这里统一。
	 */
	async handleEvent(
		event: IncomingEvent,
		policy: EventFilterPolicy,
		context: Context,
		options?: HandleEventOptions,
	): Promise<RouteOutcome> {
		const verdict = filterEventFastPath(event, policy);
		if (verdict.action === 'drop') throw new EventDropped(verdict.reason);

		if (verdict.mode === 'candidate' && this.#deps.speculative !== undefined) {
			void this.#deps.speculative(event, policy, context).catch(() => undefined);
		}

		const threadKey = options?.explicitThreadKey ?? threadKeyOf(event);
		if (threadKey !== undefined) {
			const delivered = await this.tryThreadPassthrough(threadKey, event, context);
			if (delivered !== undefined) {
				return { action: 'passthrough', threadKey, deliveredTo: delivered, routerLlmCalls: 0 };
			}
		}

		const reqKey = eventKey(event);
		const formatted = await formatEventInlineAndSpill(this.#deps.harness, event, context);
		const router = await this.#deps.resolveRouter(event);
		this.#stats.routerLlmCalls += 1;
		await router.submit(
			{
				type: 'input',
				content: formatted.inline,
				whenBusy: 'steer',
				requestId: `event:router:${reqKey}`,
			},
			context,
		);
		const decision = await this.#deps.decide(event, router);
		if (decision !== undefined && threadKey !== undefined) {
			await this.subscribeThread(decision.worker.id, threadKey, context);
		}
		return { action: 'router', threadKey, router, routerLlmCalls: 1 };
	}

	/**
	 * Worker 处理不了超出其范围的事件时交还 Router：退订 + 慢路径重投。
	 */
	async handbackToRouter(workerConversationId: ConversationId, event: IncomingEvent, context: Context): Promise<RouteOutcome> {
		const threadKey = threadKeyOf(event);
		if (threadKey !== undefined) await this.unsubscribeThread(workerConversationId, threadKey, context);
		const reqKey = eventKey(event);
		const formatted = await formatEventInlineAndSpill(this.#deps.harness, event, context);
		const router = await this.#deps.resolveRouter(event);
		this.#stats.routerLlmCalls += 1;
		await router.submit(
			{
				type: 'input',
				content: formatted.inline,
				whenBusy: 'steer',
				requestId: `event:handback:${reqKey}`,
			},
			context,
		);
		await this.#deps.decide(event, router);
		return { action: 'router', threadKey, router, routerLlmCalls: 1 };
	}
}

/** 快速路径丢弃时抛出（调用方据此静默落 inbox 或忽略）。 */
export class EventDropped extends Error {
	constructor(reason: string) {
		super(`event dropped: ${reason}`);
		this.name = 'EventDropped';
	}
}

/** 匿名事件（无 id）的单调递增序号：确保同源同发送者的不同事件生成不同去重键。 */
let eventSeq = 0;

/** 去重键：优先事件自带 id（如 webhook delivery id），否则以单调序号区分匿名事件。 */
export function eventKey(event: IncomingEvent): string {
	if (typeof event.id === 'string' && event.id.trim() !== '') return `id:${event.id.trim()}`;
	return `anon:${++eventSeq}:${event.source}:${event.type}:${event.sender}`;
}

// ---------------------------------------------------------------------------
// 3.3 内联与外溢（Inline & Spill）+ Chain of Recall
// ---------------------------------------------------------------------------

/** 外溢存储（scope: session family，key = spillId）。 */
export type SpillStoreState = {
	spillId: string;
	threadKey: string | null;
	fullContent: string;
	/** 关联对象图链接（事件 id、同线程相邻 spill 等）。 */
	relatedIds: string[];
	createdAt: number;
};

export const SpillStoreDoc = defineDocFamily<SpillStoreState, { spillId: string; fullContent: string }>({
	kind: 'botd.event.spill',
	version: 1,
	scope: 'session',
	family: true,
	initial: (seed: { spillId: string; fullContent: string }): SpillStoreState => ({
		spillId: seed.spillId,
		fullContent: seed.fullContent,
		relatedIds: [] as string[],
		createdAt: 0,
		threadKey: null,
	}),
	checkpointWhen: () => false,
});

export const DEFAULT_INLINE_CHAR_LIMIT = 120;

export interface InlineAndSpillOptions {
	inlineCharLimit?: number;
	/** 时间 / 空间相邻消息（回复引用、相邻 review 评论）。 */
	adjacentMessages?: string[];
}

export interface InlineAndSpillResult {
	/** 提交给 Router / Worker 的内联文本。 */
	inline: string;
	/** 载荷被外溢时非空。 */
	spillId?: string;
	spilled: boolean;
}

/**
 * 3.3：内联对象 id / summary / 前 inlineCharLimit 字符与相邻消息；
 * 超限部分外溢进 SpillStoreDoc 并追加 recall 指针。
 * Chain of Recall：worker 之后用 recallSpill(harness, spillId) 取回全文。
 */
export async function formatEventInlineAndSpill(
	harness: Harness,
	event: IncomingEvent,
	context: Context,
	options?: InlineAndSpillOptions,
): Promise<InlineAndSpillResult> {
	const limit = options?.inlineCharLimit ?? DEFAULT_INLINE_CHAR_LIMIT;
	const adjacent = options?.adjacentMessages ?? event.adjacent ?? [];
	const payload = event.payload ?? event.summary;

	const lines: string[] = [`[${event.source}] ${event.type} from ${event.sender}`, `summary: ${event.summary}`];
	if (adjacent.length > 0) lines.push(`adjacent: ${adjacent.join(' | ')}`);

	let spillId: string | undefined;
	if (payload.length > limit) {
		spillId = `spill_${Math.random().toString(36).slice(2, 12)}`;
		lines.push(`content: ${payload.slice(0, limit)}…`);
		lines.push(`[Spilled: ${spillId} | Call recall({ "id": "${spillId}" }) to read full content]`);
		await persistSpill(harness, { spillId, event, fullContent: payload, threadKey: threadKeyOf(event), relatedIds: adjacent.map((_, i) => `${spillId}:adjacent:${i}`), context });
	} else if (payload.length > 0) {
		lines.push(`content: ${payload}`);
	}
	return { inline: lines.join('\n'), spillId, spilled: spillId !== undefined };
}

async function persistSpill(
	harness: Harness,
	input: { spillId: string; event: IncomingEvent; fullContent: string; threadKey?: string; relatedIds: string[]; context: Context },
): Promise<void> {
	await harness.commit(async (tx) => {
		const now = Date.now();
		const doc = await tx.doc(SpillStoreDoc, input.spillId, { spillId: input.spillId, fullContent: input.fullContent });
		doc.fullContent = input.fullContent;
		doc.relatedIds = input.relatedIds;
		doc.createdAt = now;
		doc.threadKey = input.threadKey ?? null;
		// Chain of Recall 索引：spill 同时登记为 trigger 节点，recall({ id: spillId })
		// 才能路由到该事件；索引只存目录卡（summary/800 字预览），全文仍在 SpillStoreDoc。
		const recall = await tx.doc(RecallIndexDoc);
		recall.nodes[input.spillId] = {
			id: input.spillId,
			kind: 'trigger',
			title: `[${input.event.source}] ${input.event.type}`,
			summary: input.event.summary.slice(0, 160),
			contentPreview: input.fullContent.slice(0, 800),
			relatedIds: input.relatedIds,
			createdAt: now,
		};
	}, input.context);
}

/** Chain of Recall：按 spillId 取回外溢全文。 */
export async function recallSpill(harness: Harness, spillId: string, context: Context): Promise<string | undefined> {
	const doc = await harness.snapshot(SpillStoreDoc, spillId, context);
	return doc?.fullContent;
}

// ---------------------------------------------------------------------------
// 3.4 投机执行（Speculative Execution）
// ---------------------------------------------------------------------------

/** 投机策略：哪些事件值得静默复现。 */
export interface SpeculativePolicy {
	/** 命中关键词（大小写不敏感）即候选。 */
	keywords?: string[];
	/** 允许投机的来源。 */
	source?: string[];
}

/** 投机 Worker 的结果：仅 confirmed 才上报。 */
export interface SpeculativeResult {
	confirmed: boolean;
	/** 验证成功时交付给 Router 的产物（PR 链接 / 答案）。 */
	deliverable?: string;
	/** 静默丢弃原因（未确认时）。 */
	reason?: string;
}

/** 投机执行宿主：静默后台 Worker（speculative: true），验证后产出结果。 */
export type SpeculativeWorkerFactory = (
	event: IncomingEvent,
	context: Context,
) => Promise<{ run: () => Promise<{ confirmed: boolean; deliverable?: string; reason?: string }>; conversation: Conversation }>;

/**
 * 3.4：candidate 事件（候选 bug 报告 / 功能讨论）命中投机规则时，
 * 静默起后台 Worker（speculative: true）。仅 confirmed 结果通知 Router 交付，
 * 未确认则静默丢弃——Router 会话零打扰。
 */
export async function triggerSpeculativeWorker(
	event: IncomingEvent,
	policy: EventFilterPolicy,
	factory: SpeculativeWorkerFactory,
	notifyRouter: (message: string, context: Context) => Promise<void>,
	options?: { rules?: SpeculativePolicy },
	context?: Context,
): Promise<SpeculativeResult> {
	const ctx = context ?? (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT;
	const rules = options?.rules;
	void policy;
	const hay = `${event.type} ${event.summary}`.toLowerCase();
	const keywordHit = rules?.keywords === undefined || rules.keywords.some((k) => hay.includes(k.toLowerCase()));
	const sourceHit = rules?.source === undefined || rules.source.includes(event.source);
	if (!keywordHit || !sourceHit) {
		return { confirmed: false, reason: 'speculative rules not matched' };
	}

	const worker = await factory(event, ctx);
	const outcome = await worker.run();
	if (outcome.confirmed) {
		await notifyRouter(
			`[Speculative result confirmed] ${event.summary}\nDeliverable: ${outcome.deliverable ?? '(none)'}`,
			ctx,
		);
		return { confirmed: true, deliverable: outcome.deliverable };
	}
	return { confirmed: false, reason: outcome.reason ?? 'not confirmed' };
}
