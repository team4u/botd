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
import { randomUUID } from 'node:crypto';
import { resolveOwnedSession } from '../http-helpers.js';
import type { PendingAskRecord, ToolCallRecord, TurnUsage } from '@botd/protocol';
import type { HubDurableRuntime } from '../harness/hub-harness.js';
import { AskDoc, type AskEntry } from '../harness/docs.js';
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

/** 读取会话下所有可能挂 AskDoc 的会话：Router 会话 + 其全部后台 Worker 会话。 */
async function askConversations(
  rt: HubDurableRuntime,
  routerId: string,
): Promise<string[]> {
  const ids = [routerId];
  for (const w of await rt.getActiveWorkers(routerId)) {
    if (!ids.includes(w.conversationId)) ids.push(w.conversationId);
  }
  return ids;
}

export function registerWorkerRoutes(app: HubApp, ctx: HubContext): void {
  const { db, router, sseHub } = ctx;

  /** 取 Durable 运行时：直接携带者优先，否则走懒加载单例；均缺失时 503。 */
  const runtime = async (): Promise<HubDurableRuntime | undefined> =>
    ctx.durableRuntime ?? (ctx.getDurableRuntime ? await ctx.getDurableRuntime() : undefined);

  // --- 会话 Ask（人机协同）路由 -------------------------------------------
  // GroupRouter 路径：内存 + pending_asks 表（router.getPendingAsks/respondToAsk）。
  // Durable 路径：ask_human 工具写入会话 Router/Worker 会话的 AskDoc，这里合并透出。

  const durablePendingAsks = async (sessionId: string): Promise<PendingAskRecord[]> => {
    const rt = await runtime();
    if (rt === undefined) return [];
    const routerId = await findRouterConversationId(rt, sessionId);
    if (routerId === undefined) return [];
    const botId = db.getSession(sessionId)?.leadBotId ?? '';
    const out: PendingAskRecord[] = [];
    // Router 与其全部 Worker 的 AskDoc 都要透出：Worker 一样能调 ask_human。
    for (const conversationId of await askConversations(rt, routerId)) {
      try {
        const numeric = Number(conversationId);
        if (!Number.isInteger(numeric)) continue;
        const doc = await rt.harness.snapshot(
          AskDoc,
          numeric as import('@earendil-works/pi-durable').ConversationId,
          BACKGROUND_CONTEXT,
        );
        if (!doc) continue;
        for (const ask of Object.values(doc.asks as Record<string, AskEntry>)) {
          if (ask.status !== 'pending') continue;
          out.push({
            id: ask.askId,
            sessionId,
            botId,
            prompt: ask.prompt,
            options: ask.options ?? [],
            status: 'pending' as const,
            createdAt: new Date(ask.createdAt).toISOString(),
          });
        }
      } catch {
        // 会话缺失等：跳过该会话
      }
    }
    return out;
  };

  app.get('/api/sessions/:id/asks', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const asks = router.getPendingAsks(id);
    const durable = await durablePendingAsks(id);
    const seen = new Set(asks.map((a) => a.id));
    return c.json([...asks, ...durable.filter((a) => !seen.has(a.id))]);
  });

  // 手工创建待确认 ask（UI / 外部集成入口）：落 pending_asks 并广播 SSE
  app.post('/api/sessions/:id/asks', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

    const body = await (async () => {
      try {
        return await c.req.json<{ prompt?: string; options?: string[]; timeoutSeconds?: number; previewType?: PendingAskRecord['previewType']; previewContent?: string }>();
      } catch {
        return null;
      }
    })();
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return c.json({ error: 'prompt is required' }, 400);
    }
    const timeoutSeconds = typeof body.timeoutSeconds === 'number' && body.timeoutSeconds >= 0 ? body.timeoutSeconds : 0;
    const now = new Date();
    const record: PendingAskRecord = {
      id: `ask_${randomUUID()}`,
      sessionId: id,
      botId: session.leadBotId,
      prompt: body.prompt.trim(),
      options: Array.isArray(body.options) ? body.options : [],
      status: 'pending',
      createdAt: now.toISOString(),
      ...(timeoutSeconds > 0 ? { expiresAt: new Date(now.getTime() + timeoutSeconds * 1000).toISOString() } : {}),
      ...(body.previewType ? { previewType: body.previewType } : {}),
      ...(body.previewContent ? { previewContent: body.previewContent } : {}),
    };
    db.savePendingAsk(record);
    sseHub.broadcast(id, { type: 'interaction_request', sessionId: id, ask: record });
    return c.json(record, 201);
  });

  app.post('/api/sessions/:id/asks/:askId/respond', async (c) => {
    const id = c.req.param('id');
    const askId = c.req.param('askId');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const body = await c.req.json<{ answer?: string }>().catch(() => null);
    if (!body || typeof body.answer !== 'string' || !body.answer.trim()) {
      return c.json({ error: 'Missing answer' }, 400);
    }

    const resolved = router.respondToAsk(id, askId, body.answer.trim());
    if (resolved) {
      return c.json({ ok: true, ask: resolved });
    }

    // Durable 路径：在会话的 Router/Worker 会话 AskDoc 里找这条 pending ask，
    // 落 answered 并把答案作为用户消息 steer 回提问的会话（唤醒等待中的 agent）。
    const rt = await runtime();
    const answer = body.answer.trim();
    if (rt !== undefined) {
      const routerId = await findRouterConversationId(rt, id);
      if (routerId !== undefined) {
        for (const conversationId of await askConversations(rt, routerId)) {
          const numeric = Number(conversationId);
          if (!Number.isInteger(numeric)) continue;
          let prompt: string | undefined;
          try {
            await rt.harness.commit(async (tx) => {
              const doc = await tx.doc(
                AskDoc,
                numeric as import('@earendil-works/pi-durable').ConversationId,
              );
              const ask = doc.asks[askId];
              if (ask !== undefined && ask.status === 'pending') {
                ask.status = 'answered';
                ask.answer = answer;
                ask.answeredAt = Date.now();
                // doc 代理在 commit 结算后不可读：所需字段在事务内拷出。
                prompt = String(ask.prompt);
              }
            }, BACKGROUND_CONTEXT);
          } catch {
            continue;
          }
          if (prompt === undefined) continue;
          sseHub.broadcast(id, { type: 'interaction_resolved', sessionId: id, askId, answer });
          // 唤醒提问方：答案以用户消息 steer 回去，等待中的回合继续推进。
          await rt
            .submitUserMessage(
              String(conversationId),
              `[Human Response to Ask "${prompt}"]: ${answer}`,
              { requestId: `ask-reply:${askId}`, whenBusy: 'steer' },
            )
            .catch(() => undefined);
          return c.json({ ok: true, ask: { id: askId, sessionId: id, status: 'answered', answer } });
        }
      }
    }
    return c.json({ error: 'Ask not found' }, 404);
  });

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

/**
 * 提取 assistant 消息里的 toolCalls（ToolCallRecord[]）：工具调用按调用次序，
 * 状态统一 done（镜像写入点在回合落定后），输出预览取调用参数摘要。
 */
function assistantEntryToolCalls(entry: { model?: readonly unknown[] }): ToolCallRecord[] | undefined {
  const first = entry.model?.[0] as
    | { role?: string; content?: unknown }
    | undefined;
  if (first === undefined || first.role !== 'assistant' || !Array.isArray(first.content)) return undefined;
  const calls: ToolCallRecord[] = [];
  for (const block of first.content) {
    if (block === null || typeof block !== 'object') continue;
    const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
    if (call.type !== 'toolCall' || typeof call.name !== 'string') continue;
    calls.push({
      ...(typeof call.id === 'string' ? { id: call.id } : {}),
      name: call.name,
      ...(call.arguments !== null && typeof call.arguments === 'object'
        ? { args: call.arguments as Record<string, unknown> }
        : {}),
      status: 'done',
    });
  }
  return calls.length > 0 ? calls : undefined;
}

/** 提取 assistant 消息上的 token 用量（pi-ai Usage → botd TurnUsage）。 */
function assistantEntryUsage(entry: { model?: readonly unknown[] }): TurnUsage | undefined {
  const first = entry.model?.[0] as
    | {
        role?: string;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
        };
      }
    | undefined;
  if (first === undefined || first.role !== 'assistant' || first.usage === undefined) return undefined;
  const u = first.usage;
  return {
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    totalTokens: u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0),
    ...(u.cacheRead !== undefined ? { cacheReadTokens: u.cacheRead } : {}),
    ...(u.cacheWrite !== undefined ? { cacheWriteTokens: u.cacheWrite } : {}),
  };
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
 * `message_created`，前端时间线自动更新；新 pending 的 AskDoc 条目同步广播
 * `interaction_request`（前端 AskCard 即时弹出）。
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
  /** 已广播过 interaction_request 的 askId（按会话去重，重启后由 GET /asks 兜底）。 */
  const broadcastAskIds = new Map<string, Set<string>>();
  let closed = false;

  const mirror = (sessionId: string, botId: string, entry: { id: unknown; kind: string; model?: readonly unknown[] }): void => {
    if (closed) return;
    if (entry.kind === 'botd.worker-report') {
      const text = workerReportText(entry);
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
      return;
    }
    const text = assistantEntryText(entry);
    const toolCalls = assistantEntryToolCalls(entry);
    const usage = assistantEntryUsage(entry);
    // 纯工具调用回合无文本，但 toolCalls/usage 仍是时间线的一部分：照常镜像。
    if (text === undefined && toolCalls === undefined) return;
    let message;
    try {
      message = db.createMessage({
        id: `msg_dur_${sessionId}_${Number(entry.id)}`,
        sessionId,
        role: 'assistant',
        senderBotId: botId,
        content: text ?? '',
        ...(toolCalls ? { toolCalls } : {}),
        ...(usage ? { usage } : {}),
      });
    } catch {
      return; // 主键冲突：重启重放，该条已落库
    }
    sseHub.broadcast(sessionId, { type: 'message_created', message: message.message });
  };

  /** 新 pending ask 广播：同一 askId 只广播一次 interaction_request。 */
  const broadcastNewAsks = async (sessionId: string, botId: string, conversationId: string): Promise<void> => {
    const rt = ctx.durableRuntime;
    if (rt === undefined || closed) return;
    const numeric = Number(conversationId);
    if (!Number.isInteger(numeric)) return;
    try {
      const doc = await rt.harness.snapshot(
        AskDoc,
        numeric as import('@earendil-works/pi-durable').ConversationId,
        BACKGROUND_CONTEXT,
      );
      if (!doc) return;
      const seen = broadcastAskIds.get(sessionId) ?? new Set<string>();
      broadcastAskIds.set(sessionId, seen);
      for (const ask of Object.values(doc.asks as Record<string, AskEntry>)) {
        if (ask.status !== 'pending' || seen.has(ask.askId)) continue;
        seen.add(ask.askId);
        sseHub.broadcast(sessionId, {
          type: 'interaction_request',
          sessionId,
          ask: {
            id: ask.askId,
            sessionId,
            botId,
            prompt: ask.prompt,
            options: ask.options ?? [],
            status: 'pending' as const,
            createdAt: new Date(ask.createdAt).toISOString(),
          },
        });
      }
    } catch {
      // 快照失败：GET /asks 轮询兜底
    }
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
        void broadcastNewAsks(sessionId, botId, conversationId);
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
  // getDurableRuntime 优先：每次提交前重新同步分身（新建 Bot 即刻可路由），
  // 同一 Hub 生命周期内返回同一实例。
  const rt = ctx.getDurableRuntime ? await ctx.getDurableRuntime() : ctx.durableRuntime;
  if (rt === undefined) return undefined;
  const routerId = await ensureRouterConversationId(rt, sessionId, botId);
  await mirror?.ensure(sessionId);
  await rt.submitUserMessage(routerId, content, {
    requestId: `hub-msg:${sessionId}:${Date.now()}`,
    whenBusy: 'steer',
  });
  return routerId;
}

/**
 * 停止会话的 Durable 侧：全部 running Worker 置 aborted 并中止其会话，
 * 再中止 Router 会话自身正在进行的回合。找不到映射时静默返回（会话从未走 Durable）。
 */
export async function cancelDurableSession(rt: HubDurableRuntime, sessionId: string): Promise<void> {
  const routerId = await findRouterConversationId(rt, sessionId);
  if (routerId === undefined) return;
  for (const w of await rt.getActiveWorkers(routerId)) {
    if (w.status === 'running') {
      await rt.stopWorker(routerId, w.workerId).catch(() => undefined);
    }
  }
  const conv = await rt.conversation(routerId, BACKGROUND_CONTEXT);
  await conv?.abort(BACKGROUND_CONTEXT).catch(() => undefined);
}
