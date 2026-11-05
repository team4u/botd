/**
 * Super-agent HTTP 路由：后台 Worker 生命周期、事件摄入（EventRouter 四步管线）
 * 与 Watchdog 健康诊断。
 *
 * 会话（botd `sess_*`）通过 `SessionRouterDoc` 映射到一个持久的 Router 会话
 * （首次派生 Worker 时按 lead bot 分身懒建话题会话），映射与消息镜像逻辑见
 * `harness/session-bridge.ts`；本文件只做 HTTP 编排与鉴权。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { randomUUID } from 'node:crypto';
import { requireAdmin, resolveOwnedSession } from '../http-helpers.js';
import type { PendingAskRecord } from '@botd/protocol';
import { stringToConversationId, type HubDurableRuntime } from '../harness/hub-harness.js';
import { TargetDoc, type WorkerEntry } from '../harness/docs.js';
import {
  EventDropped,
  EventRouter,
  filterEventFastPath,
  type EventFilterPolicy,
  type IncomingEvent,
  type RouteOutcome,
} from '../harness/event-router.js';
import { diagnoseSystemHealth, runWatchdogPass } from '../harness/watchdog.js';
import {
  ensureRouterConversationId,
  findRouterConversationId,
  getDurablePendingAsks,
  respondToDurableAsk,
} from '../harness/session-bridge.js';
import { HUB_ROUTER_BOT_ID as ROUTER_EXTENSION_HUB_ROUTER_BOT_ID } from '../harness/router-extension.js';
import type { HubApp, HubContext } from './context.js';

// 会话桥接核心逻辑已迁至 harness/session-bridge.ts；此处重导出保持既有导入路径
// （index.ts / messages.ts / sessions.ts / ask-token.ts / trigger-service.ts）不变。
export {
  cancelDurableSession,
  clearDurableSessionContext,
  createDurableSessionMirror,
  ensureRouterConversationId,
  forkDurableSession,
  getDurablePendingAsks,
  resetDurableSession,
  respondToDurableAsk,
  rewindDurableSessionBeforeMessage,
  submitSessionMessageToDurable,
} from '../harness/session-bridge.js';
export type { DurableSessionMirror } from '../harness/session-bridge.js';

/** 系统内置「⚡ 中枢总管」Router 分身 id（与 harness/router-extension 同源）。 */
export const HUB_ROUTER_BOT_ID = ROUTER_EXTENSION_HUB_ROUTER_BOT_ID;

/**
 * 构造系统内置「⚡ 中枢总管」（hub-router）虚拟分身配置：
 * - 不写入 SQLite bots 表，绝不污染用户的业务分身列表与「个人助理」通讯录；
 * - 默认模型取首个已配置模型的主分身；
 * - 默认节点取配置分身所在节点（兑底 'local'）。
 */
export function resolveHubRouterBotConfig(db: HubContext['db']): import('@botd/protocol').BotConfig {
  const allBots = db.getAllBots();
  const configuredBot =
    allBots.find(
      (b) =>
        (!b.parentBotId || !allBots.some((p) => p.id === b.parentBotId)) &&
        b.modelProvider?.trim() &&
        b.modelId?.trim(),
    ) ?? allBots.find((b) => b.modelProvider?.trim() && b.modelId?.trim());
  // 节点解析：配置分身所在节点优先（用户意图最明确），否则兜底 'local'。
  return {
    id: HUB_ROUTER_BOT_ID,
    name: '中枢总管',
    description: '系统内置全局调度总管（自然语言派发跨项目与跨分身后台任务）',
    nodeId: configuredBot?.nodeId ?? 'local',
    modelProvider: configuredBot?.modelProvider ?? '',
    modelId: configuredBot?.modelId ?? '',
    thinkingLevel: configuredBot?.thinkingLevel ?? 'medium',
    enabledSkills: db.listSkills().map((s) => s.id),
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  };
}

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
  branchName?: string;
  threadKeys: string[];
  startedAt: string;
  updatedAt?: string;
  summary?: string;
}

const toListItem = (entry: WorkerEntry, sessionId: string): WorkerListItem => {
  // worktree 隔离的 Worker默认分支名 botd/<workerId>（Web 派发路径未显式落 branchName 时兜底）。
  const branchName = (entry as { branchName?: string }).branchName ?? (entry.worktreePath ? `botd/${entry.workerId}` : undefined);
  return {
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
    ...(branchName ? { branchName } : {}),
    threadKeys: entry.threadKeys,
    startedAt: new Date(entry.startedAt).toISOString(),
    ...(entry.finishedAt ? { updatedAt: new Date(entry.finishedAt).toISOString() } : {}),
    ...(entry.summary ? { summary: entry.summary } : {}),
  };
};

/** POST /api/sessions/:id/workers 请求体：兼容旧字段（task/worktree/threadKey）与 Web 派发载荷（instructions/isolation/threadKeys）。 */
type SpawnWorkerBody = {
  title?: string;
  task?: string;
  instructions?: string;
  botId?: string;
  worktree?: boolean;
  isolation?: 'off' | 'worktree';
  threadKey?: string;
  threadKeys?: string[];
  forkContext?: boolean;
};

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
  /** 事件唯一 ID（如 webhook delivery id）：透传为 IncomingEvent.id，幂等去重的优先键。 */
  eventId?: string | number;
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
    ...(body.eventId !== undefined ? { id: String(body.eventId) } : {}),
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

/** 会话最近 Transcript 条目的轻量摘录（id / kind / role / 文本）。 */
async function transcriptOf(conversation: NonNullable<Awaited<ReturnType<HubDurableRuntime['conversation']>>>): Promise<Array<{ id: string; kind: string; role?: string; text: string; content?: unknown[] }>> {
  const page = await conversation.entries({ order: 'ascending' }, 50, undefined, BACKGROUND_CONTEXT);
  return page.items.map((entry) => {
    const first = entry.model?.[0];
    return {
      id: String(entry.id),
      kind: entry.kind,
      ...(first !== undefined && typeof (first as { role?: unknown }).role === 'string'
        ? { role: (first as { role: string }).role }
        : {}),
      text: (entry.model ?? []).map(messageText).filter(Boolean).join('\n'),
      // 结构化 content（thinking / toolCall / text / toolResult 原生块）：
      // 检视抽屉据此重建完整时间线（含思考过程与工具返回值），与主会话 blocks 同构。
      ...(first !== null && typeof first === 'object' && Array.isArray((first as { content?: unknown }).content)
        ? { content: (first as { content: unknown[] }).content }
        : {}),
    };
  });
}

export function registerWorkerRoutes(app: HubApp, ctx: HubContext): void {
  const { db, router, sseHub } = ctx;

  /** 取 Durable 运行时：直接携带者优先，否则走懒加载单例；均缺失时 503。 */
  const runtime = async (): Promise<HubDurableRuntime | undefined> =>
    ctx.durableRuntime ?? (ctx.getDurableRuntime ? await ctx.getDurableRuntime() : undefined);

  // --- 会话 Ask（人机协同）路由 -------------------------------------------
  // GroupRouter 路径：内存 + pending_asks 表（router.getPendingAsks/respondToAsk）。
  // Durable 路径：ask_human 工具写入会话 Router/Worker 会话的 AskDoc，这里合并透出。

  app.get('/api/sessions/:id/asks', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;

    const asks = router.getPendingAsks(id);
    const rt = await runtime();
    const durable = rt === undefined ? [] : await getDurablePendingAsks(rt, id, sRes.session.leadBotId);
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
    const durableResolved = rt === undefined
      ? null
      : await respondToDurableAsk({ rt, sseHub, sessionId: id, askId, answer: body.answer.trim() });
    if (durableResolved !== null) {
      return c.json({ ok: true, ask: durableResolved });
    }
    return c.json({ error: 'Ask not found' }, 404);
  });

  // --- Workers 生命周期 -------------------------------------------------

  // 全局 Worker 聚合：跨当前用户全部未归档会话汇总后台 Worker（中枢总管视图），
  // running 优先、其次按更新时间倒序；无 Durable 运行时时安全返回空列表。
  app.get('/api/workers', async (c) => {
    const user = c.get('user');
    const rt = await runtime();
    if (rt === undefined) return c.json({ workers: [] });

    const sessions = db.getAllSessions(user.id).filter((s) => !s.archived);
    const collected: Array<WorkerListItem & { sessionTitle?: string; workspaceDir?: string }> = [];
    for (const session of sessions) {
      const routerId = await findRouterConversationId(rt, session.id);
      if (routerId === undefined) continue;
      const workers = await rt.getActiveWorkers(routerId);
      for (const w of workers) {
        collected.push({
          ...toListItem(w, session.id),
          sessionTitle: session.title,
          ...(session.workspaceDir ? { workspaceDir: session.workspaceDir } : {}),
        });
      }
    }
    collected.sort((a, b) => {
      const aActive = a.status === 'running' ? 1 : 0;
      const bActive = b.status === 'running' ? 1 : 0;
      if (bActive !== aActive) return bActive - aActive;
      const ta = Date.parse(a.updatedAt || a.startedAt || '') || 0;
      const tb = Date.parse(b.updatedAt || b.startedAt || '') || 0;
      return tb - ta;
    });
    return c.json({ workers: collected });
  });

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

    const body = await c.req.json<SpawnWorkerBody>().catch(() => null);
    const taskText =
      typeof body?.task === 'string' && body.task.trim()
        ? body.task.trim()
        : typeof body?.instructions === 'string'
          ? body.instructions.trim()
          : '';
    if (!body || typeof body.title !== 'string' || !body.title.trim() || !taskText) {
      return c.json({ error: 'title and task are required' }, 400);
    }

    const botId = typeof body.botId === 'string' && body.botId ? body.botId : session.leadBotId;
    if (botId !== HUB_ROUTER_BOT_ID && !db.getBot(botId)) return c.json({ error: `Bot ${botId} not found` }, 400);
    // hub-router：可能尚未经 syncBotPersonas 注册（懒打开/直连），先确保分身存在。
    if (botId === HUB_ROUTER_BOT_ID && rt.getPersona(botId) === undefined) {
      await ensureRouterConversationId(rt, id, HUB_ROUTER_BOT_ID);
    }
    if (rt.getPersona(botId) === undefined) {
      return c.json({ error: `Bot ${botId} has no durable persona registered` }, 400);
    }

    const worktree = body.worktree === true || body.isolation === 'worktree';
    const threadKeys = Array.isArray(body.threadKeys)
      ? body.threadKeys
          .filter((k): k is string => typeof k === 'string' && Boolean(k.trim()))
          .map((k) => k.trim())
      : typeof body.threadKey === 'string' && body.threadKey.trim()
        ? [body.threadKey.trim()]
        : [];

    try {
      const routerId = await ensureRouterConversationId(rt, id, botId, { workspaceDir: session.workspaceDir });
      // forkSessionToWorker 在单个创建事务内完整落齐 TargetDoc / WorkerRegistryDoc /
      // RecallIndexDoc / ThreadSubscriptionsDoc（worktree 元数据、branchName 与全部
      // threadKey 直通订阅均已写入），路由层无需再补二次事务。
      const spawned = await rt.forkSessionToWorker(routerId, {
        botId,
        title: body.title.trim(),
        task: taskText,
        ...(threadKeys[0] ? { threadKey: threadKeys[0] } : {}),
        ...(body.forkContext === true ? { forkContext: true } : {}),
        ...(worktree ? { worktree: true } : {}),
        ...(threadKeys.length > 0 ? { threadKeys } : {}),
        ...(session.workspaceDir?.trim() ? { cwd: session.workspaceDir.trim() } : {}),
        sessionId: id,
      });

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

    // 归属校验：workerId 必须属于本会话 —— 先查本会话 Router 的 WorkerRegistry，
    // 再验证 RecallIndex 命中节点的会话链（TargetDoc.sessionId / 父会话）指向本会话，
    // 防止拿别人的 workerId 经自己的会话路径读取他人 Worker 对话。
    const routerId = await findRouterConversationId(rt, id);
    let belongsToSession = false;
    if (routerId !== undefined) {
      belongsToSession = (await rt.getActiveWorkers(routerId)).some((w) => w.workerId === workerId);
    }
    const node = await rt.recall(workerId);
    if (node === undefined) return c.json({ error: 'No recall node' }, 404);
    if (!belongsToSession) {
      const conversationId = (node as { conversationId?: string }).conversationId;
      if (typeof conversationId === 'string' && conversationId !== '') {
        const target = await rt.harness.snapshot(
          TargetDoc,
          stringToConversationId(conversationId),
          BACKGROUND_CONTEXT,
        );
        belongsToSession =
          target?.sessionId === id ||
          (routerId !== undefined && target?.parentConversationId === routerId);
      }
    }
    if (!belongsToSession) {
      return c.json({ error: 'Worker not found in this session' }, 404);
    }

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

    // 目标会话归属校验：指定 sessionId 时必须是当前用户自己的会话，
    // 否则任何人都能把事件直通注入他人正在运行的 Worker（steer 注入）。
    if (typeof body.sessionId === 'string' && body.sessionId) {
      const sRes = resolveOwnedSession(c, db, body.sessionId);
      if (!sRes.ok) return sRes.response;
    } else {
      const user = c.get('user');
      if (user.role !== 'admin' && typeof body.botId === 'string' && body.botId) {
        // 指定 botId 且非 admin：Bot 必须对当前用户可见（自己的或 team 的），
        // 否则同样构成向他人分身注入事件。
        const bot = db.getBot(body.botId);
        if (!bot || (bot.ownerId !== user.id && bot.visibility !== 'team')) {
          return c.json({ error: 'Forbidden' }, 403);
        }
      }
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

    // runPass=1 会真实触发一次巡检（含自动干预）：仅限管理员。
    if (c.req.query('runPass') === '1') {
      const adminErr = requireAdmin(c);
      if (adminErr) return adminErr;
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
