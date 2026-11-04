/**
 * Super-agent HTTP 路由：后台 Worker 生命周期、事件摄入（EventRouter 四步管线）
 * 与 Watchdog 健康诊断。
 *
 * 会话（botd `sess_*`）通过 `SessionRouterDoc` 映射到一个持久的 Router 会话
 * （首次派生 Worker 时按 lead bot 分身懒建话题会话）。所有写操作走
 * `HubDurableRuntime` 的文档事务，重启后状态原样恢复。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { resolveOwnedSession } from '../http-helpers.js';
import type { HubDurableRuntime } from '../harness/hub-harness.js';
import type { WorkerEntry } from '../harness/docs.js';
import {
  EventDropped,
  EventRouter,
  filterEventFastPath,
  type EventFilterPolicy,
  type IncomingEvent,
  type RouteOutcome,
} from '../harness/event-router.js';
import { diagnoseSystemHealth, runWatchdogPass } from '../harness/watchdog.js';
import type { HubApp, HubContext } from './context.js';

/** botd 会话 → Router 会话 映射（scope: session 的 family，key = sessionId）。 */
const SessionRouterDoc = defineDocFamily<{ conversationId: string }, null>({
  kind: 'botd.session-router',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ conversationId: '' }),
  checkpointWhen: () => false,
});

/** GET /api/sessions/:id/workers 的列表项（与前端 SuperAgentWorkerItem 对齐）。 */
interface WorkerListItem {
  workerId: string;
  conversationId: string;
  parentSessionId: string;
  botId: string;
  title: string;
  kind: 'worker';
  status: WorkerEntry['status'];
  nodeId?: string;
  cwd?: string;
  worktreePath?: string;
  threadKeys: string[];
  startedAt: string;
  updatedAt?: string;
  summary?: string;
}

const toListItem = (entry: WorkerEntry, sessionId: string): WorkerListItem => ({
  workerId: entry.workerId,
  conversationId: entry.conversationId,
  parentSessionId: sessionId,
  botId: entry.botId,
  title: entry.title,
  kind: 'worker',
  status: entry.status,
  ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
  ...(entry.cwd ? { cwd: entry.cwd } : {}),
  ...(entry.worktreePath ? { worktreePath: entry.worktreePath } : {}),
  threadKeys: entry.threadKeys,
  startedAt: new Date(entry.startedAt).toISOString(),
  ...(entry.finishedAt ? { updatedAt: new Date(entry.finishedAt).toISOString() } : {}),
  ...(entry.summary ? { summary: entry.summary } : {}),
});

/** 读取（或懒建）会话对应的 Router 会话 id。 */
export async function ensureRouterConversationId(
  runtime: HubDurableRuntime,
  sessionId: string,
  botId: string,
): Promise<string> {
  const remembered = await runtime.harness.snapshot(SessionRouterDoc, sessionId, BACKGROUND_CONTEXT);
  if (remembered?.conversationId) return remembered.conversationId;
  if (runtime.getPersona(botId) === undefined) throw new Error(`unknown persona: ${botId}`);
  const conversation = await runtime.createBotTopicSession(botId, sessionId);
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(SessionRouterDoc, sessionId, null);
    doc.conversationId = String(conversation.id);
  }, BACKGROUND_CONTEXT);
  return String(conversation.id);
}

/** 按会话定位 Router 会话；映射缺失时返回 undefined（不自动创建）。 */
async function findRouterConversationId(
  runtime: HubDurableRuntime,
  sessionId: string,
): Promise<string | undefined> {
  const remembered = await runtime.harness.snapshot(SessionRouterDoc, sessionId, BACKGROUND_CONTEXT);
  return remembered?.conversationId || undefined;
}

/** 事件摄入请求体。 */
interface EventIngestBody {
  source?: string;
  type?: string;
  sender?: string;
  title?: string;
  content?: string;
  repo?: string;
  prNumber?: number;
  issueNumber?: number;
  chatId?: string;
  threadId?: string;
  botId?: string;
  sessionId?: string;
  adjacentMessages?: string[];
  policy?: Partial<EventFilterPolicy>;
}

/** 请求体 → EventRouter 的 IncomingEvent。 */
function toIncomingEvent(body: EventIngestBody): IncomingEvent {
  const target: IncomingEvent['target'] = {};
  if (body.repo !== undefined || body.prNumber !== undefined || body.issueNumber !== undefined) {
    target.repo = body.repo;
    target.number = body.prNumber ?? body.issueNumber;
    target.kind = body.issueNumber !== undefined && body.prNumber === undefined ? 'issue' : 'pr';
  }
  if (body.chatId !== undefined || body.threadId !== undefined) {
    target.chatId = body.chatId;
    target.threadId = body.threadId;
  }
  const summary =
    body.title ??
    (typeof body.content === 'string' && body.content.length > 0 ? body.content.slice(0, 120) : '(no content)');
  return {
    source: body.source ?? 'unknown',
    type: body.type ?? 'event',
    sender: body.sender ?? 'anonymous',
    ...(Object.keys(target).length > 0 ? { target } : {}),
    summary,
    ...(typeof body.content === 'string' && body.content !== summary ? { payload: body.content } : {}),
    ...(Array.isArray(body.adjacentMessages) ? { adjacent: body.adjacentMessages } : {}),
  };
}

/** 事件路由的会话来源：body.botId / body.sessionId 优先，否则第一个已注册分身。 */
async function resolveRouterForEvent(
  runtime: HubDurableRuntime,
  body: EventIngestBody,
): Promise<string | undefined> {
  if (typeof body.sessionId === 'string' && body.sessionId) {
    const mapped = await findRouterConversationId(runtime, body.sessionId);
    if (mapped !== undefined) return mapped;
  }
  const botId =
    typeof body.botId === 'string' && body.botId
      ? body.botId
      : runtime.listPersonas()[0]?.botId;
  if (botId === undefined || runtime.getPersona(botId) === undefined) return undefined;
  try {
    const conversation = await runtime.ensureBotMainSession(botId);
    return String(conversation.id);
  } catch {
    return undefined;
  }
}

export function registerWorkerRoutes(app: HubApp, ctx: HubContext): void {
  const { db } = ctx;

  /** 取 Durable 运行时：直接携带者优先，否则走懒加载单例；均缺失时 503。 */
  const runtime = async (): Promise<HubDurableRuntime | undefined> =>
    ctx.durableRuntime ?? (ctx.getDurableRuntime ? await ctx.getDurableRuntime() : undefined);

  // --- Workers 生命周期 -------------------------------------------------

  app.get('/api/sessions/:id/workers', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const rt = await runtime();
    if (rt === undefined) return c.json({ error: 'Durable runtime unavailable' }, 503);

    const routerId = await findRouterConversationId(rt, id);
    const workers = routerId === undefined ? [] : await rt.getActiveWorkers(routerId);
    return c.json({ workers: workers.map((w) => toListItem(w, id)) });
  });

  app.post('/api/sessions/:id/workers', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;
    const rt = await runtime();
    if (rt === undefined) return c.json({ error: 'Durable runtime unavailable' }, 503);

    const body = await c.req
      .json<{ title?: string; task?: string; botId?: string; worktree?: boolean; threadKey?: string; forkContext?: boolean }>()
      .catch(() => null);
    if (
      !body ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      typeof body.task !== 'string' ||
      !body.task.trim()
    ) {
      return c.json({ error: 'title and task are required' }, 400);
    }

    const botId = typeof body.botId === 'string' && body.botId ? body.botId : session.leadBotId;
    if (!db.getBot(botId)) return c.json({ error: `Bot ${botId} not found` }, 400);
    if (rt.getPersona(botId) === undefined) {
      return c.json({ error: `Bot ${botId} has no durable persona registered` }, 400);
    }

    try {
      const routerId = await ensureRouterConversationId(rt, id, botId);
      const spawned = await rt.forkSessionToWorker(routerId, {
        botId,
        title: body.title.trim(),
        task: body.task.trim(),
        ...(body.threadKey ? { threadKey: body.threadKey } : {}),
        forkContext: body.forkContext !== false,
      });
      // threadKey 直通订阅：Worker 直接接收该线程上的后续事件。
      if (body.threadKey) {
        const eventRouter = new EventRouter({
          harness: rt.harness,
          resolveRouter: async () => (await rt.conversation(routerId, BACKGROUND_CONTEXT))!,
          decide: async () => undefined,
        });
        await eventRouter.subscribeThread(
          spawned.conversation.id,
          body.threadKey,
          BACKGROUND_CONTEXT,
        );
      }
      const workers = await rt.getActiveWorkers(routerId);
      const entry = workers.find((w) => w.workerId === spawned.workerId);
      return c.json(
        { ok: true, worker: entry !== undefined ? toListItem(entry, id) : { workerId: spawned.workerId } },
        201,
      );
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to spawn worker' }, 500);
    }
  });

  app.post('/api/sessions/:id/workers/:workerId/steer', async (c) => {
    const id = c.req.param('id');
    const workerId = c.req.param('workerId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const rt = await runtime();
    if (rt === undefined) return c.json({ error: 'Durable runtime unavailable' }, 503);

    const body = await c.req.json<{ message?: string; mode?: 'steer' | 'followUp' }>().catch(() => null);
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }
    const mode = body.mode === 'followUp' ? 'followUp' : 'steer';
    const routerId = await findRouterConversationId(rt, id);
    if (routerId === undefined) return c.json({ error: 'Worker not found' }, 404);
    const ok = await rt.steerWorker(routerId, workerId, body.message.trim(), mode);
    if (!ok) return c.json({ error: 'Worker not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/workers/:workerId/stop', async (c) => {
    const id = c.req.param('id');
    const workerId = c.req.param('workerId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const rt = await runtime();
    if (rt === undefined) return c.json({ error: 'Durable runtime unavailable' }, 503);

    const routerId = await findRouterConversationId(rt, id);
    if (routerId === undefined) return c.json({ error: 'Worker not found' }, 404);
    const ok = await rt.stopWorker(routerId, workerId);
    if (!ok) return c.json({ error: 'Worker not found' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/sessions/:id/workers/:workerId/recall', async (c) => {
    const id = c.req.param('id');
    const workerId = c.req.param('workerId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const rt = await runtime();
    if (rt === undefined) return c.json({ error: 'Durable runtime unavailable' }, 503);

    const node = await rt.recall(workerId);
    if (node === undefined) return c.json({ error: 'No recall node' }, 404);

    // Chain of Recall：节点之外附最近 Transcript 摘录（供检视抽屉展示）。
    const conversationId = (node as { conversationId?: string }).conversationId;
    let transcript: Array<{ id: string; kind: string; role?: string; text: string }> = [];
    if (typeof conversationId === 'string' && conversationId !== '') {
      const conversation = await rt.conversation(conversationId, BACKGROUND_CONTEXT);
      if (conversation !== undefined) {
        transcript = await transcriptOf(conversation);
      }
    }
    return c.json({ node, transcript });
  });

  // --- 事件摄入（EventRouter 管线） ------------------------------------

  app.post('/api/events/ingest', async (c) => {
    const rt = await runtime();
    if (rt === undefined) return c.json({ error: 'Durable runtime unavailable' }, 503);

    const body = await c.req.json<EventIngestBody>().catch(() => null);
    if (!body || typeof body.source !== 'string' || typeof body.type !== 'string') {
      return c.json({ error: 'source and type are required' }, 400);
    }

    const event = toIncomingEvent(body);
    const policy: EventFilterPolicy = {
      mode: 'explicit_only',
      ...(body.policy ?? {}),
    };

    // 第 1 步：快速路径过滤（确定性规则，0 LLM 调用）。
    const verdict = filterEventFastPath(event, policy);
    if (verdict.action === 'drop') {
      return c.json({ action: 'dropped', reason: verdict.reason });
    }

    const routerId = await resolveRouterForEvent(rt, body);
    if (routerId === undefined) {
      return c.json({ error: 'No bot persona available to route the event' }, 400);
    }

    const eventRouter = new EventRouter({
      harness: rt.harness,
      resolveRouter: async () => (await rt.conversation(routerId, BACKGROUND_CONTEXT))!,
      decide: async () => undefined,
    });

    try {
      const outcome: RouteOutcome = await eventRouter.handleEvent(event, policy, BACKGROUND_CONTEXT);
      if (outcome.action === 'passthrough') {
        return c.json({
          action: 'pass_through',
          threadKey: outcome.threadKey,
          deliveredTo: outcome.deliveredTo,
          routerLlmCalls: outcome.routerLlmCalls,
        });
      }
      return c.json({
        action: 'routed_to_router',
        threadKey: outcome.threadKey ?? null,
        routerConversationId: String(outcome.router.id),
        routerLlmCalls: outcome.routerLlmCalls,
      });
    } catch (error) {
      if (error instanceof EventDropped) {
        return c.json({ action: 'dropped', reason: error.message });
      }
      throw error;
    }
  });

  // --- Watchdog 健康诊断 ------------------------------------------------

  app.get('/api/watchdog/health', async (c) => {
    const rt = await runtime();
    if (rt === undefined) return c.json({ error: 'Durable runtime unavailable' }, 503);

    if (c.req.query('runPass') === '1') {
      await runWatchdogPass(rt.harness, undefined, BACKGROUND_CONTEXT);
    }
    const report = await diagnoseSystemHealth(rt.harness, BACKGROUND_CONTEXT);
    return c.json({
      healthy: report.healthy,
      summary: report.summary,
      findings: report.interventions,
      interventions: report.interventions,
    });
  });
}

/** 会话最近 Transcript 条目的轻量摘录（id / kind / role / 文本）。 */
async function transcriptOf(conversation: NonNullable<Awaited<ReturnType<HubDurableRuntime['conversation']>>>): Promise<Array<{ id: string; kind: string; role?: string; text: string }>> {
  const page = await conversation.entries({ order: 'ascending' }, 50, undefined, BACKGROUND_CONTEXT);
  const messageText = (message: unknown): string => {
    if (message === null || typeof message !== 'object') return '';
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) =>
        block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
  };
  return page.items.map((entry) => {
    const first = entry.model?.[0];
    return {
      id: String(entry.id),
      kind: entry.kind,
      ...(first !== undefined && typeof (first as { role?: unknown }).role === 'string'
        ? { role: (first as { role: string }).role }
        : {}),
      text: (entry.model ?? []).map(messageText).filter(Boolean).join('\n'),
    };
  });
}

// --- Durable 会话 → botd 会话消息镜像（SSE 桥） ---------------------------

/** 提取 EntryRecord.model 中 assistant 文本。 */
function assistantEntryText(entry: { model?: readonly unknown[] }): string | undefined {
  const first = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
  if (first === undefined || first.role !== 'assistant') return undefined;
  const content = first.content;
  if (typeof content === 'string') return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

/** worker 完成通知（以 UserMessage 提交给 Router）：透传以 [Worker Completed: 开头的文本。 */
function workerReportText(entry: { model?: readonly unknown[] }): string | undefined {
  const first = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
  if (first === undefined || first.role !== 'user') return undefined;
  const content = first.content;
  if (typeof content !== 'string') return undefined;
  return content.startsWith('[Worker Completed:') ? content : undefined;
}

/** durable Router 会话的镜像器：把新 assistant 回复 / worker 完成通知同步回 botd 会话。 */
export interface DurableSessionMirror {
  /** 确保 sessionId 的 Router 会话已建立 watch（幂等）。 */
  ensure: (sessionId: string) => Promise<void>;
  /** 停止全部 watch（Hub 关闭时调用）。 */
  close: () => void;
}

/**
 * Durable Router 会话 → botd 会话消息镜像：`HubDurableRuntime` 产生新的 assistant
 * 回复或 worker 完成通知时落库 `db.createMessage({ role: 'assistant' })` 并广播
 * `message_created`，前端时间线自动更新。
 *
 * - 每个 Router 会话一个 watch，按已镜像的最大 entry id 增量推进；
 * - message id 确定性（`msg_dur_<sessionId>_<entryId>`），重启重放幂等（主键冲突吞掉）；
 * - worker 完成后 `GET /api/sessions/:id/workers` 直接可查 completed 状态与 summary。
 */
export function createDurableSessionMirror(
  ctx: Pick<HubContext, 'db' | 'sseHub'> & { durableRuntime?: HubDurableRuntime },
): DurableSessionMirror {
  const { db, sseHub } = ctx;
  const watches = new Map<string, { unwatch: () => Promise<void>; lastMirrored: number }>();
  let closed = false;

  const mirror = (sessionId: string, botId: string, entry: { id: unknown; kind: string; model?: readonly unknown[] }): void => {
    if (closed) return;
    const text = entry.kind === 'botd.worker-report' ? workerReportText(entry) : assistantEntryText(entry);
    if (text === undefined) return;
    let message;
    try {
      message = db.createMessage({
        id: `msg_dur_${sessionId}_${Number(entry.id)}`,
        sessionId,
        role: 'assistant',
        senderBotId: botId,
        content: text,
      });
    } catch {
      return; // 主键冲突：重启重放，该条已落库
    }
    sseHub.broadcast(sessionId, { type: 'message_created', message: message.message });
  };

  const attach = async (sessionId: string, conversationId: string): Promise<void> => {
    if (closed || watches.has(conversationId)) return;
    const botId = db.getSession(sessionId)?.leadBotId;
    if (botId === undefined) return;
    const state: { unwatch: () => Promise<void>; lastMirrored: number } = {
      unwatch: async () => undefined,
      lastMirrored: 0,
    };
    watches.set(conversationId, state);
    try {
      const unwatch = await ctx.durableRuntime!.watchConversationView(conversationId, (view) => {
        const current = watches.get(conversationId);
        if (current === undefined) return;
        const entries = view.entries as unknown as Array<{ id: unknown; kind: string; model?: readonly unknown[] }>;
        for (const entry of entries) {
          const entryId = Number(entry.id);
          if (!Number.isInteger(entryId) || entryId <= current.lastMirrored) continue;
          current.lastMirrored = entryId;
          mirror(sessionId, botId, entry);
        }
      });
      if (closed) {
        watches.delete(conversationId);
        await unwatch().catch(() => undefined);
        return;
      }
      state.unwatch = unwatch;
    } catch {
      watches.delete(conversationId); // watch 失败（会话缺失等）：下次提交重试
    }
  };

  return {
    ensure: async (sessionId) => {
      const rt = ctx.durableRuntime;
      if (rt === undefined || closed) return;
      const conversationId = await findRouterConversationId(rt, sessionId);
      if (conversationId !== undefined) await attach(sessionId, conversationId);
    },
    close: () => {
      closed = true;
      for (const state of watches.values()) void state.unwatch().catch(() => undefined);
      watches.clear();
    },
  };
}

/**
 * 用户消息 → Durable Router 会话提交（全双工：`whenBusy: "steer"`）：
 * 确保 Router 会话存在（懒建）并提交用户消息，镜像先行挂接。
 * 无 durable runtime 时返回 undefined，调用方继续走原 GroupRouter 路径。
 */
export async function submitSessionMessageToDurable(
  ctx: Pick<HubContext, 'db' | 'sseHub'> & {
    durableRuntime?: HubDurableRuntime;
    getDurableRuntime?: () => Promise<HubDurableRuntime>;
  },
  sessionId: string,
  botId: string,
  content: string,
  mirror?: DurableSessionMirror,
): Promise<string | undefined> {
  const rt = ctx.durableRuntime ?? (ctx.getDurableRuntime ? await ctx.getDurableRuntime() : undefined);
  if (rt === undefined) return undefined;
  const routerId = await ensureRouterConversationId(rt, sessionId, botId);
  await mirror?.ensure(sessionId);
  await rt.submitUserMessage(routerId, content, {
    requestId: `hub-msg:${sessionId}:${Date.now()}`,
    whenBusy: 'steer',
  });
  return routerId;
}
