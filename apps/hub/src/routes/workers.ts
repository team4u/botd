/**
 * Super-agent HTTP 路由：后台 Worker 生命周期、事件摄入（EventRouter 四步管线）
 * 与 Watchdog 健康诊断。
 *
 * 会话（botd `sess_*`）通过 `SessionRouterDoc` 映射到一个持久的 Router 会话
 * （首次派生 Worker 时按 lead bot 分身懒建话题会话）。所有写操作走
 * `HubDurableRuntime` 的文档事务，重启后状态原样恢复。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { configure, defineDocFamily, type LiveState } from '@earendil-works/pi-durable';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { requireAdmin, resolveOwnedSession } from '../http-helpers.js';
import type { MessageAttachment, PendingAskRecord, ToolCallRecord, TurnBlock, TurnUsage } from '@botd/protocol';
import { stringToConversationId, type HubDurableRuntime } from '../harness/hub-harness.js';
import { AskDoc, type AskEntry, RecallIndexDoc, TargetDoc, WorkerRegistryDoc, type WorkerEntry } from '../harness/docs.js';
import { redactSecretAskAnswer } from '../harness/secret-stash.js';
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
import type { SseHub } from '../sse.js';

/** botd 会话 → Router 会话 映射（scope: session 的 family，key = sessionId），含会话 Space 绑定的 workspaceDir（粘性）。 */
const SessionRouterDoc = defineDocFamily<{ conversationId: string; workspaceDir?: string }, null>({
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

/**
 * 读取（或懒建）会话对应的 Router 会话 id，并按需校正 TargetDoc：
 * - 新建后补记 `sessionId` 与生效 `cwd`；
 * - `options.workspaceDir`（会话 Space 绑定）优先于分身默认 cwd；
 * - 同一会话改 @ 另一个分身时，把 Router 会话整体切到该分身的模型与系统提示。
 */
export async function ensureRouterConversationId(
  runtime: HubDurableRuntime,
  sessionId: string,
  botId: string,
  options?: { workspaceDir?: string },
): Promise<string> {
  const remembered = await runtime.harness.snapshot(SessionRouterDoc, sessionId, BACKGROUND_CONTEXT);
  // workspaceDir 粘性：首次携带后记住在映射文档里，后续不带 options 的调用
  // （如 getDurablePendingAsks）不会把会话 cwd 意外重置回分身默认值。
  const workspaceDir = options?.workspaceDir?.trim() || remembered?.workspaceDir || '';
  const convId = remembered?.conversationId || '';
  if (convId) {
    if (options?.workspaceDir?.trim() && remembered?.workspaceDir !== options.workspaceDir.trim()) {
      await runtime.harness.commit(async (tx) => {
        const doc = await tx.doc(SessionRouterDoc, sessionId, null);
        doc.workspaceDir = options.workspaceDir!.trim();
      }, BACKGROUND_CONTEXT);
    }
    await syncRouterTargetDoc(runtime, convId, sessionId, botId, workspaceDir || undefined);
    return convId;
  }
  if (runtime.getPersona(botId) === undefined) throw new Error(`unknown persona: ${botId}`);
  const conversation = await runtime.createBotTopicSession(botId, sessionId);
  const newId = String(conversation.id);
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(SessionRouterDoc, sessionId, null);
    doc.conversationId = newId;
    if (workspaceDir) doc.workspaceDir = workspaceDir;
  }, BACKGROUND_CONTEXT);
  await syncRouterTargetDoc(runtime, newId, sessionId, botId, workspaceDir || undefined);
  return newId;
}

/** Router 会话 TargetDoc 的懒校正：sessionId 标记、Space cwd 覆盖与多分身 @ 切换。 */
async function syncRouterTargetDoc(
  runtime: HubDurableRuntime,
  convId: string,
  sessionId: string,
  botId: string,
  workspaceDir?: string,
): Promise<void> {
  const persona = runtime.getPersona(botId);
  if (persona === undefined) return;
  const effectiveCwd = workspaceDir?.trim() || persona.cwd || process.cwd();
  const numeric = Number(convId);
  if (!Number.isInteger(numeric)) return;
  const id = numeric as import('@earendil-works/pi-durable').ConversationId;
  // 先只读快照判断是否需要写（文档事务有成本，无变更时不落盘）。
  const current = await runtime.harness.snapshot(TargetDoc, id, BACKGROUND_CONTEXT);
  if (
    current !== undefined &&
    (current as { sessionId?: string }).sessionId === sessionId &&
    current.botId === botId &&
    current.cwd === effectiveCwd
  ) {
    return;
  }
  await runtime.harness.commit(async (tx) => {
    const target = await tx.doc(TargetDoc, id);
    (target as unknown as Record<string, unknown>).sessionId = sessionId;
    if (persona && target.botId !== botId) {
      target.botId = botId;
      target.nodeId = persona.nodeId;
      await configure(tx, id, {
        ...runtime.routerAgent(persona),
        cwd: effectiveCwd,
      });
    } else if (workspaceDir?.trim() && target.cwd !== effectiveCwd) {
      await configure(tx, id, { cwd: effectiveCwd });
    }
    target.cwd = effectiveCwd;
  }, BACKGROUND_CONTEXT);
}

/** 按会话定位 Router 会话；映射缺失时返回 undefined（不自动创建）。 */
async function findRouterConversationId(
  runtime: HubDurableRuntime,
  sessionId: string,
): Promise<string | undefined> {
  const remembered = await runtime.harness.snapshot(SessionRouterDoc, sessionId, BACKGROUND_CONTEXT);
  return remembered?.conversationId || undefined;
}

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

/**
 * 读取会话的 Durable pending asks（AskDoc）：覆盖会话的 Router 会话与其全部
 * 活跃 Worker 会话（Worker 一样能调 ask_human）。无 Durable 映射时返回空数组。
 */
export async function getDurablePendingAsks(
  rt: HubDurableRuntime,
  sessionId: string,
  leadBotId?: string,
): Promise<PendingAskRecord[]> {
  const routerId = await findRouterConversationId(rt, sessionId);
  if (routerId === undefined) return [];
  const out: PendingAskRecord[] = [];
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
          botId: leadBotId ?? '',
          prompt: ask.prompt,
          options: ask.options ?? [],
          status: 'pending' as const,
          createdAt: new Date(ask.createdAt).toISOString(),
          ...(ask.previewType ? { previewType: ask.previewType as PendingAskRecord['previewType'] } : {}),
          ...(ask.previewContent ? { previewContent: ask.previewContent } : {}),
        });
      }
    } catch {
      // 会话缺失等：跳过该会话
    }
  }
  return out;
}

/**
 * 回答一条 Durable pending ask（AskDoc）：在会话的 Router/Worker 会话里定位，
 * 落 `status = 'answered'` + `answer` + `answeredAt`，广播 `interaction_resolved`，
 * 并把答案以用户消息 steer 回提问的会话（唤醒等待中的 agent）。
 * 找不到（或已非 pending）时返回 null；调用方负责 GroupRouter 路径兜底。
 */
export async function respondToDurableAsk(input: {
  rt: HubDurableRuntime;
  sseHub: SseHub;
  sessionId: string;
  askId: string;
  answer: string;
}): Promise<PendingAskRecord | null> {
  const { rt, sseHub, sessionId, askId, answer } = input;
  const routerId = await findRouterConversationId(rt, sessionId);
  if (routerId === undefined) return null;
  for (const conversationId of await askConversations(rt, routerId)) {
    const numeric = Number(conversationId);
    if (!Number.isInteger(numeric)) continue;
    // 先只读快照定位 pending ask 与其预览（doc 代理在事务外不可读）。
    let prompt: string | undefined;
    let previewType: string | undefined;
    let previewContent: string | undefined;
    try {
      const doc = await rt.harness.snapshot(
        AskDoc,
        numeric as import('@earendil-works/pi-durable').ConversationId,
        BACKGROUND_CONTEXT,
      );
      const ask = doc?.asks[askId];
      if (ask === undefined || ask.status !== 'pending') continue;
      prompt = String(ask.prompt);
      previewType = ask.previewType;
      previewContent = ask.previewContent;
    } catch {
      continue;
    }
    if (prompt === undefined) continue;
    // 机密表单字段只 stash 一次：明文进内存 SecretStash，落库/广播/上下文只留
    // [REDACTED:$BOTD_SECRET_...] 占位符。
    const { redactedAnswer, stashedEnvKeys } = redactSecretAskAnswer(answer, previewType, previewContent, undefined, sessionId);
    let answered = false;
    try {
      await rt.harness.commit(async (tx) => {
        const doc = await tx.doc(
          AskDoc,
          numeric as import('@earendil-works/pi-durable').ConversationId,
        );
        const ask = doc.asks[askId];
        if (ask !== undefined && ask.status === 'pending') {
          ask.status = 'answered';
          ask.answer = redactedAnswer;
          ask.answeredAt = Date.now();
          answered = true;
        }
      }, BACKGROUND_CONTEXT);
    } catch {
      continue;
    }
    if (!answered) continue;
    sseHub.broadcast(sessionId, { type: 'interaction_resolved', sessionId, askId, answer: redactedAnswer });
    // 唤醒提问方：答案以用户消息 steer 回去，等待中的回合继续推进；带机密时附
    // 跨平台消费说明（明文永不出现在命令行或上下文里）。
    const firstEnvKey = Object.values(stashedEnvKeys)[0];
    const secretNote =
      firstEnvKey === undefined
        ? ''
        : '\n[Secret Stash]: Sensitive input(s) were securely stashed as environment variable(s): ' +
          `${Object.entries(stashedEnvKeys)
            .map(([p, k]) => `${p} -> ${k}`)
            .join(', ')}.` +
          `\nCross-platform usage (Windows/macOS/Linux): node -e "process.stdout.write(process.env.${firstEnvKey} || '')" | <command>`;
    await rt
      .submitUserMessage(
        String(conversationId),
        `[Human Response to Ask "${prompt}"]: ${redactedAnswer}${secretNote}`,
        { requestId: `ask-reply:${askId}`, whenBusy: 'steer' },
      )
      .catch(() => undefined);
    return {
      id: askId,
      sessionId,
      botId: '',
      prompt,
      options: [],
      status: 'answered',
      answer: redactedAnswer,
      createdAt: new Date().toISOString(),
    };
  }
  return null;
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
    if (!db.getBot(botId)) return c.json({ error: `Bot ${botId} not found` }, 400);
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
      // 隔离参数在 forkSessionToWorker 创建事务内生效（Worker 首轮任务提交前就绑定
      // worktree/threadKeys/cwd），不存在“先共享 cwd 再补落”的隔离竞态；旧签名忽略多余字段。
      const spawnOptions = {
        botId,
        title: body.title.trim(),
        task: taskText,
        ...(threadKeys[0] ? { threadKey: threadKeys[0] } : {}),
        ...(body.forkContext === true ? { forkContext: true } : {}),
        ...(worktree ? { worktree: true } : {}),
        ...(threadKeys.length > 0 ? { threadKeys } : {}),
        ...(session.workspaceDir?.trim() ? { cwd: session.workspaceDir.trim() } : {}),
        sessionId: id,
      };
      const spawned = await rt.forkSessionToWorker(
        routerId,
        spawnOptions as Parameters<HubDurableRuntime['forkSessionToWorker']>[1],
      );

      // 兼容兜底（幂等）：若 harness 已在创建事务内落齐 worktree/threadKeys 元数据则
      // 全部保留；仅补齐缺失字段（旧签名路径），保证 TargetDoc / WorkerRegistryDoc /
      // RecallIndex 三处的 branchName + worktreePath + threadKeys 完整可观测。
      if (worktree || threadKeys.length > 0) {
        const baseCwd = session.workspaceDir?.trim() || rt.getPersona(botId)?.cwd || process.cwd();
        const registered = (await rt.getActiveWorkers(routerId)).find((w) => w.workerId === spawned.workerId);
        const worktreePath = registered?.worktreePath || `${baseCwd}/.botd-worktrees/${spawned.workerId}`;
        const branchName = `botd/${spawned.workerId}`;
        await rt.harness.commit(
          async (tx) => {
            const workerConvId = Number(spawned.conversation.id);
            if (Number.isInteger(workerConvId)) {
              const target = await tx.doc(
                TargetDoc,
                workerConvId as import('@earendil-works/pi-durable').ConversationId,
              );
              if (threadKeys.length > 0 && JSON.stringify(target.threadKeys) !== JSON.stringify(threadKeys)) {
                target.threadKeys = threadKeys;
              }
              if (worktree && !target.worktreePath) target.worktreePath = worktreePath;
            }
            const registry = await tx.doc(WorkerRegistryDoc, stringToConversationId(routerId));
            const entry = registry.workers[spawned.workerId] as
              | (Record<string, unknown> & { threadKeys?: string[]; worktreePath?: string })
              | undefined;
            if (entry !== undefined) {
              if (threadKeys.length > 0 && JSON.stringify(entry.threadKeys ?? []) !== JSON.stringify(threadKeys)) {
                entry.threadKeys = threadKeys;
              }
              if (worktree && !entry.worktreePath) {
                entry.worktreePath = worktreePath;
                entry.branchName = branchName;
              }
            }
            if (worktree) {
              const recall = await tx.doc(RecallIndexDoc);
              const recallNode = recall.nodes[spawned.workerId] as Record<string, unknown> | undefined;
              if (recallNode !== undefined && recallNode.data === undefined) {
                recallNode.data = { node: { worktreePath, branchName } };
              }
            }
          },
          BACKGROUND_CONTEXT,
        );
      }

      // threadKey 直通订阅：Worker 直接接收这些线程上的后续事件（全部 key）。
      if (threadKeys.length > 0) {
        const eventRouter = new EventRouter({
          harness: rt.harness,
          resolveRouter: async () => (await rt.conversation(routerId, BACKGROUND_CONTEXT))!,
          decide: async () => undefined,
        });
        for (const key of threadKeys) {
          await eventRouter.subscribeThread(spawned.conversation.id, key, BACKGROUND_CONTEXT);
        }
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

/**
 * 提取 assistant 回合的完整 TurnBlock[]：thinking / toolCall / text 按原生顺序保留，
 * 驱动主会话消息的思考过程与工具分组渲染（与旧 GroupRouter 路径的 blocks 同构）。
 */
function assistantEntryBlocks(entry: { model?: readonly unknown[] }): TurnBlock[] | undefined {
  const first = entry.model?.[0] as
    | { role?: string; content?: unknown }
    | undefined;
  if (first === undefined || first.role !== 'assistant' || !Array.isArray(first.content)) return undefined;
  const blocks: TurnBlock[] = [];
  for (const block of first.content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as { type?: string; thinking?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
      blocks.push({ type: 'thinking', thinking: b.thinking, status: 'done' });
    } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
      blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'toolCall' && typeof b.name === 'string') {
      blocks.push({
        type: 'tool',
        id: typeof b.id === 'string' ? b.id : `${b.name}_${blocks.length}`,
        name: b.name,
        ...(b.arguments !== null && typeof b.arguments === 'object'
          ? { args: b.arguments as Record<string, unknown> }
          : {}),
        status: 'done',
      });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * pi.tool-result entry → 回填最近一条镜像 assistant 消息：把工具输出（outputPreview /
 * isError / durationMs）写入 blocks 与 toolCalls 里对应 toolCallId 的块并落库。
 */
function makeToolResultBackfiller(db: HubContext['db']) {
  return (sessionId: string, entry: { model?: readonly unknown[] }): void => {
  const result = entry.model?.[0] as
    | {
        role?: string;
        toolCallId?: string;
        toolName?: string;
        content?: unknown;
        isError?: boolean;
        durationMs?: number;
      }
    | undefined;
  if (result === undefined || result.role !== 'toolResult') return;
  const toolCallId = typeof result.toolCallId === 'string' ? result.toolCallId : undefined;
  if (!toolCallId) return;
  const preview = Array.isArray(result.content)
    ? result.content
        .map((c) =>
          c !== null && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
            ? (c as { text: string }).text
            : '',
        )
        .filter(Boolean)
        .join('\n')
    : typeof result.content === 'string'
      ? result.content
      : '';
  if (!preview && result.isError !== true) return;

  const msg = db.getLastDurableAssistantMessage(sessionId);
  if (!msg) return;
  let blocks: TurnBlock[] = msg.blocks ?? [];
  let toolCalls: ToolCallRecord[] = msg.toolCalls ?? [];
  let changed = false;
  blocks = blocks.map((b) => {
    if (b.type === 'tool' && b.id === toolCallId) {
      changed = true;
      return {
        ...b,
        ...(preview ? { outputPreview: preview.slice(0, 4000) } : {}),
        ...(result.isError === true ? { isError: true, status: 'error' as const } : {}),
        ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
      };
    }
    return b;
  });
  toolCalls = toolCalls.map((tc) => {
    if (tc.id === toolCallId) {
      return {
        ...tc,
        ...(preview ? { outputPreview: preview.slice(0, 2000) } : {}),
        ...(result.isError === true ? { isError: true, status: 'error' as const } : {}),
        ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
      };
    }
    return tc;
  });
  if (!changed) return;
  db.updateMessageBlocksAndToolCalls(msg.id, blocks, toolCalls);
  };
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
  /** 每个被 watch 的 Router 会话的镜像推进状态（lastMirrored 增量游标 + Live 流水位）。 */
  interface WatchMirrorState {
    unwatch: () => Promise<void>;
    lastMirrored: number;
    /** 上一帧是否处于 running（pi.live.run 存在）：驱动 running/idle 状态机的边沿检测。 */
    wasRunning: boolean;
    /** 本轮回合中是否有思考流输出：收尾时广播 status: 'done'。 */
    hadThinking: boolean;
    /** 已广播为 text_delta 的累计正文（live.generation.message 前缀差分）。 */
    streamedText: string;
    /** 已广播为 thinking_stream delta 的累计思考文本。 */
    streamedThinking: string;
    /** 已广播 tool_status 的工具调用快照（status/outputLen 变更才重播）。 */
    toolSnapshots: Map<string, { status: string; outputLen: number }>;
  }
  const watches = new Map<string, WatchMirrorState>();
  const backfillToolResult = makeToolResultBackfiller(db);
  /** 已广播过 interaction_request 的 askId（按会话去重，重启后由 GET /asks 兜底）。 */
  const broadcastAskIds = new Map<string, Set<string>>();
  /** 已广播过失败系统消息的 runFailure 标识（按会话去重，防止重放重复报错）。 */
  const broadcastFailureKeys = new Map<string, Set<string>>();
  let closed = false;

  const mirror = (sessionId: string, botId: string, entry: { id: unknown; kind: string; model?: readonly unknown[] }): void => {
    if (closed) return;
    // 群聊多分身：本会话最近被 @ 的分身优先于创建时固定的 lead bot。
    const session = db.getSession(sessionId);
    const activeBotId = lastActiveBotBySession.get(sessionId) ?? session?.leadBotId;
    const bot = db.getBot(activeBotId ?? '') ?? (session ? db.getBot(session.leadBotId) : undefined);
    const senderBotId = bot?.id ?? activeBotId ?? botId;
    const senderBotName = bot?.name ?? senderBotId;
    if (entry.kind === 'botd.worker-report') {
      const text = workerReportText(entry);
      if (text === undefined) return;
      // worker 完成回执不是分身的发言，而是系统通知：落 role:'callback'，
      // 前端以轻量回执卡（默认折叠）呈现，避免与 Router 随后的正式汇总重复刷屏。
      let message;
      try {
        message = db.createMessage({
          id: `msg_dur_${sessionId}_${Number(entry.id)}`,
          sessionId,
          role: 'callback',
          senderBotId,
          ...(senderBotName !== senderBotId ? { senderBotName } : {}),
          content: text,
        });
      } catch {
        return; // 主键冲突：重启重放，该条已落库
      }
      sseHub.broadcast(sessionId, { type: 'message_created', message: message.message });
      return;
    }
    if (entry.kind === 'pi.tool-result') {
      // 工具返回值回填：pi-ai 把 toolCall(assistant entry) 与 toolResult(tool-result entry)
      // 拆成两个 entry；此处把结果写回该会话最近一条镜像 assistant 消息的 blocks/toolCalls，
      // 刷新/翻历史时工具输出完整可见（实时期间前端有流式预览，不重复广播）。
      backfillToolResult(sessionId, entry);
      return;
    }
    const text = assistantEntryText(entry);
    const toolCalls = assistantEntryToolCalls(entry);
    const usage = assistantEntryUsage(entry);
    const blocks = assistantEntryBlocks(entry);
    // 纯工具调用回合无文本，但 toolCalls/usage/blocks 仍是时间线的一部分：照常镜像。
    if (text === undefined && toolCalls === undefined && (blocks?.length ?? 0) === 0) return;
    let message;
    try {
      message = db.createMessage({
        id: `msg_dur_${sessionId}_${Number(entry.id)}`,
        sessionId,
        role: 'assistant',
        senderBotId,
        ...(senderBotName !== senderBotId ? { senderBotName } : {}),
        content: text ?? '',
        ...(toolCalls ? { toolCalls } : {}),
        ...(blocks && blocks.length > 0 ? { blocks } : {}),
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
            ...(ask.previewType ? { previewType: ask.previewType as PendingAskRecord['previewType'] } : {}),
            ...(ask.previewContent ? { previewContent: ask.previewContent } : {}),
          },
        });
      }
    } catch {
      // 快照失败：GET /asks 轮询兜底
    }
  };

  /** 拼接 LiveDoc 半成品 assistant 消息里全部 thinking 块 / text 块的文本。 */
  const liveStreamedText = (message: unknown, field: 'thinking' | 'text'): string => {
    if (message === null || typeof message !== 'object') return '';
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) =>
        block !== null && typeof block === 'object' && (block as { type?: unknown }).type === field &&
          typeof (block as Record<string, unknown>)[field] === 'string'
          ? ((block as Record<string, unknown>)[field] as string)
          : '',
      )
      .filter(Boolean)
      .join('');
  };

  /** 记录并广播未处理的模型失败（runFailure）：同一失败标识只落库一条系统消息。 */
  const reportRunFailure = (sessionId: string, live: LiveState | undefined): boolean => {
    const failure = live?.runFailure;
    if (!failure || failure.reason === 'aborted' || failure.reason === 'reset' || failure.reason === 'nothing_to_answer') {
      return false;
    }
    const reason = failure.reason || 'unknown';
    const detail = failure.detail || '';
    const failureKey = `${String(failure.taskId ?? '')}:${reason}:${detail}`;
    const seen = broadcastFailureKeys.get(sessionId) ?? new Set<string>();
    if (!seen.has(failureKey)) {
      seen.add(failureKey);
      broadcastFailureKeys.set(sessionId, seen);
      const description = detail ? `${reason}: ${String(detail).slice(0, 300)}` : reason;
      const errorMsg = db.createMessage({
        id: `msg_durfail_${sessionId}_${Date.now()}`,
        sessionId,
        role: 'system',
        content: `⚠️ 模型执行异常（${description}）：请检查模型服务商凭据、配额或网络连接后重试。`,
      });
      sseHub.broadcast(sessionId, { type: 'message_created', message: errorMsg.message });
    }
    db.updateSessionStatus(sessionId, 'failed');
    sseHub.broadcast(sessionId, { type: 'session_status', sessionId, status: 'failed' });
    return true;
  };

  const attach = async (sessionId: string, conversationId: string): Promise<void> => {
    if (closed || watches.has(conversationId)) return;
    const botId = db.getSession(sessionId)?.leadBotId;
    if (botId === undefined) return;
    const state: WatchMirrorState = {
      unwatch: async () => undefined,
      lastMirrored: 0,
      wasRunning: false,
      hadThinking: false,
      streamedText: '',
      streamedThinking: '',
      toolSnapshots: new Map(),
    };
    watches.set(conversationId, state);
    try {
      const unwatch = await ctx.durableRuntime!.watchConversationView(conversationId, (view) => {
        const current = watches.get(conversationId);
        if (current === undefined) return;
        // 群聊多分身：最近被 @ 的分身优先于会话固定的 lead bot。
        const session = db.getSession(sessionId);
        const activeBotId = lastActiveBotBySession.get(sessionId) ?? session?.leadBotId ?? botId;

        // --- LiveDoc（pi.live）桥：流式增量 + 会话 running/idle 状态 ----------------
        // pi.live 在 Durable 回合进行中持续演进（run/generation/tools），这里把它的
        // 每次提交差分转成 text_delta / thinking_stream / tool_status SSE 事件，并驱动
        // db.updateSessionStatus 与 session_status 广播 —— 否则前端时间线静止、
        // watchSubSessionCompletion（等 session_status: idle）永不触发。
        const live = (view.docs as Record<string, unknown> | undefined)?.['pi.live'] as LiveState | undefined;
        const isRunning = live?.run !== undefined;

        // A. 空闲 -> running：复位流水位并广播运行中状态。
        if (isRunning && !current.wasRunning) {
          current.wasRunning = true;
          current.hadThinking = false;
          current.streamedText = '';
          current.streamedThinking = '';
          current.toolSnapshots.clear();
          db.updateSessionStatus(sessionId, 'running', activeBotId);
          sseHub.broadcast(sessionId, {
            type: 'session_status',
            sessionId,
            status: 'running',
            activeBotId,
            activeBotIds: [activeBotId],
          });
        }

        // B. running 期间：半成品 assistant 消息（live.generation.message）按前缀差分
        // 广播 thinking/text 增量；工具槽（live.tools）按 status/输出长度变更广播。
        if (isRunning) {
          const partial = live?.generation?.message;
          const thinkingFull = liveStreamedText(partial, 'thinking');
          if (!thinkingFull.startsWith(current.streamedThinking) && thinkingFull.length > 0) {
            current.streamedThinking = '';
          }
          if (thinkingFull.startsWith(current.streamedThinking) && thinkingFull.length > current.streamedThinking.length) {
            const delta = thinkingFull.slice(current.streamedThinking.length);
            current.streamedThinking = thinkingFull;
            current.hadThinking = true;
            sseHub.broadcast(sessionId, {
              type: 'thinking_stream',
              sessionId,
              botId: activeBotId,
              delta,
              status: 'running',
            });
          }
          const textFull = liveStreamedText(partial, 'text');
          if (!textFull.startsWith(current.streamedText) && textFull.length > 0) {
            current.streamedText = '';
          }
          if (textFull.startsWith(current.streamedText) && textFull.length > current.streamedText.length) {
            const delta = textFull.slice(current.streamedText.length);
            current.streamedText = textFull;
            sseHub.broadcast(sessionId, { type: 'text_delta', sessionId, botId: activeBotId, delta });
          }
          for (const slot of live?.tools ?? []) {
            const outLen = slot.output?.length ?? 0;
            const prev = current.toolSnapshots.get(slot.callId);
            if (!prev || prev.status !== slot.status || prev.outputLen !== outLen) {
              current.toolSnapshots.set(slot.callId, { status: slot.status, outputLen: outLen });
              sseHub.broadcast(sessionId, {
                type: 'tool_status',
                sessionId,
                botId: activeBotId,
                toolCallId: slot.callId,
                toolName: slot.name,
                status: slot.status === 'done' ? 'done' : 'running',
                ...(slot.output ? { outputPreview: slot.output.slice(0, 2000) } : {}),
              });
            }
          }
        }

        // C. 先镜像本帧已提交的 entries（pi.assistant / pi.tool-result /
        // botd.worker-report 落库并广播 message_created），再宣布 idle：保证
        // watchSubSessionCompletion 等监听者在看到 session_status: idle 时，最终
        // assistant 消息已经写进 db 时间线。
        const entries = view.entries as unknown as Array<{ id: unknown; kind: string; model?: readonly unknown[] }>;
        for (const entry of entries) {
          const entryId = Number(entry.id);
          if (!Number.isInteger(entryId) || entryId <= current.lastMirrored) continue;
          current.lastMirrored = entryId;
          mirror(sessionId, botId, entry);
          if (entry.kind === 'pi.assistant') {
            current.streamedText = '';
            current.streamedThinking = '';
          }
        }

        // D. running -> 空闲：收尾思考流，复位水位，若存在 runFailure 则报 failed，否则会话置 idle 并广播（子会话完成
        // 监听、前端运行指示灯由此解锁）。
        if (!isRunning && current.wasRunning) {
          if (current.hadThinking) {
            sseHub.broadcast(sessionId, {
              type: 'thinking_stream',
              sessionId,
              botId: activeBotId,
              status: 'done',
            });
          }
          current.wasRunning = false;
          current.hadThinking = false;
          current.streamedText = '';
          current.streamedThinking = '';
          current.toolSnapshots.clear();
          if (!reportRunFailure(sessionId, live)) {
            db.updateSessionStatus(sessionId, 'idle', undefined);
            sseHub.broadcast(sessionId, {
              type: 'session_status',
              sessionId,
              status: 'idle',
              activeBotId: undefined,
              activeBotIds: [],
              queuePlan: [],
            });
          }
        } else if (!isRunning && live?.runFailure) {
          reportRunFailure(sessionId, live);
        }

        // E. 新 pending ask 广播（不变）。
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

const DATA_URL_PATTERN = /^data:([^;]+);base64,([\s\S]+)$/;

/** 磁盘产物指针：附件 id 在 Artifact 表中可解析且物理文件存在。 */
interface DiskArtifact {
  storagePath: string;
  sizeBytes: number;
  mimeType: string;
  filename: string;
}

/** 按附件 id 解析磁盘产物（文件存在才算数）。 */
function resolveDiskArtifact(
  att: MessageAttachment,
  db?: Pick<HubContext['db'], 'getArtifactWithStoragePath'>,
): DiskArtifact | undefined {
  if (!db || typeof att.id !== 'string' || !att.id) return undefined;
  const art = db.getArtifactWithStoragePath(att.id);
  if (!art || !fs.existsSync(art.storagePath)) return undefined;
  return {
    storagePath: art.storagePath,
    sizeBytes: art.sizeBytes,
    mimeType: att.mimeType || art.mimeType,
    filename: att.filename || art.filename,
  };
}

/**
 * 从 MessageAttachment[] 提取可供 pi-ai 多模态消费的 base64 图片列表。
 * 优先读磁盘产物（WebUI 上传链路：附件只带产物指针，不带内联字节），
 * 回退解析内联 dataUrl（如直连 submitSessionMessageToDurable 的调用方）。
 */
function extractImageAttachments(
  attachments: readonly MessageAttachment[] | undefined,
  db?: Pick<HubContext['db'], 'getArtifactWithStoragePath'>,
): Array<{ mimeType: string; data: string }> {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const att of attachments) {
    if (!att) continue;
    // 1) 磁盘产物：直接读文件字节（多 MB 图片也不进 SQLite，只在提交时读盘）
    const disk = resolveDiskArtifact(att, db);
    if (disk && disk.mimeType.startsWith('image/')) {
      const data = fs.readFileSync(disk.storagePath).toString('base64');
      if (data) images.push({ mimeType: disk.mimeType, data });
      continue;
    }
    // 2) 内联 dataUrl 回退
    const dataUrl = (att as { dataUrl?: unknown }).dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl) continue;
    const match = DATA_URL_PATTERN.exec(dataUrl);
    const mimeType = att.mimeType || match?.[1] || '';
    const data = match ? match[2] : dataUrl;
    if (mimeType.startsWith('image/') && data) {
      images.push({ mimeType, data });
    }
  }
  return images;
}

/** 活跃分身登记表：submitSessionMessageToDurable 提交时写入，镜像器读取（跨模块单例）。 */
const lastActiveBotBySession = new Map<string, string>();

/**
 * Durable 回合结束回调：置 idle 并广播。镜像器在 assistant 消息落库/回合结束时调用，
 * 与 submitSessionMessageToDurable 开头的 running 广播配对，保证会话状态不会永久卡在 running。
 */
function markDurableSessionIdle(
  ctx: Pick<HubContext, 'db' | 'sseHub'>,
  sessionId: string,
): void {
  ctx.db.updateSessionStatus(sessionId, 'idle');
  ctx.sseHub.broadcast(sessionId, {
    type: 'session_status',
    sessionId,
    status: 'idle',
    activeBotId: undefined,
    activeBotIds: [],
  });
}

/**
 * 附件上下文块：把磁盘产物清单（文件名 / 类型 / 大小 / 绝对路径）拼进用户消息，
 * 让模型知道用户附了什么文件、能从哪里读到它（read / CLI 工具均可消费该路径）。
 */
function formatAttachedFilesContext(
  attachments: readonly MessageAttachment[] | undefined,
  db?: Pick<HubContext['db'], 'getArtifactWithStoragePath'>,
): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const lines: string[] = [];
  for (const att of attachments) {
    if (!att) continue;
    const disk = resolveDiskArtifact(att, db);
    if (!disk) continue;
    // 远端 Node 提示：storagePath 是 Hub 本机路径，远端分身拿不到；附上 artifactId
    // 与 `botd artifact pull` 拉取指引，让 RemoteExecutionEnv 上的模型也能取到文件。
    lines.push(
      `- ${disk.filename} (${disk.mimeType}, ${disk.sizeBytes} bytes) -> path: ${disk.storagePath} (artifactId: ${att.id}; on remote nodes run: botd artifact pull ${att.id} --output ./${disk.filename})`,
    );
  }
  if (lines.length === 0) return '';
  return `[Attached Files]:\n${lines.join('\n')}`;
}

/**
 * 用户消息 → Durable Router 会话提交（全双工：`whenBusy: "steer"`）：
 * - 支持内置斜杠原语：`/compact [instructions]` 直接触发 `pi-durable` 原生非阻塞上下文压缩，
 *   `/new [handoff]` 直接触发 `pi-durable` 原生 `pi.reset` 开启新上下文；
 * - `/skillName [args]` 且 Hub SQLite 存在该技能时，改写为引导模型调 `load_skill` 的提示；
 * - 支持多模态图片附件：磁盘产物优先读盘、内联 dataUrl 回退，自动转 `ImageContent`；
 * - 附件磁盘路径以 `[Attached Files]` 块拼进消息文本（非图片附件对模型可见可读）；
 * - 无 durable runtime 时返回 undefined，调用方继续走原 GroupRouter 路径。
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
  options?: {
    attachments?: readonly MessageAttachment[];
    commandText?: string;
  },
): Promise<string | undefined> {
  // getDurableRuntime 优先：每次提交前重新同步分身（新建 Bot 即刻可路由），
  // 同一 Hub 生命周期内返回同一实例。
  const rt = ctx.getDurableRuntime ? await ctx.getDurableRuntime() : ctx.durableRuntime;
  if (rt === undefined) return undefined;
  lastActiveBotBySession.set(sessionId, botId);
  // 立即置为 running 并广播：前端在首条流式事件前就能亮起「正在思考」占位态，
  // 杜绝发送后长时间石沉大海的焦虑。
  ctx.db.updateSessionStatus(sessionId, 'running', botId);
  ctx.sseHub.broadcast(sessionId, {
    type: 'session_status',
    sessionId,
    status: 'running',
    activeBotId: botId,
    activeBotIds: [botId],
  });
  const routerId = await ensureRouterConversationId(rt, sessionId, botId, {
    workspaceDir: ctx.db.getSession(sessionId)?.workspaceDir,
  });
  await mirror?.ensure(sessionId);

  const rawCommand = (options?.commandText ?? content).trim();
  const compactMatch = /^\/compact(?:\s+([\s\S]*))?$/i.exec(rawCommand);
  if (compactMatch) {
    const instructions = compactMatch[1]?.trim() || undefined;
    await rt.compactConversation(stringToConversationId(routerId), instructions, BACKGROUND_CONTEXT);
    markDurableSessionIdle(ctx, sessionId);
    return routerId;
  }

  const newMatch = /^\/new(?:\s+([\s\S]*))?$/i.exec(rawCommand);
  if (newMatch) {
    const handoff = newMatch[1]?.trim() || undefined;
    await rt.resetConversation(stringToConversationId(routerId), handoff, BACKGROUND_CONTEXT);
    markDurableSessionIdle(ctx, sessionId);
    return routerId;
  }

  // Skill 斜杠命令（/skillName [args]）：Hub SQLite 存在该技能时，引导模型调
  // load_skill 加载技能正文再执行用户请求，而不是把裸斜杠当普通文本。
  const skillMatch = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(rawCommand);
  let finalContent = content;
  if (skillMatch) {
    const skillId = skillMatch[1];
    const skillArgs = skillMatch[2]?.trim() ?? '';
    const skillMd = ctx.db.getSkillContent?.(skillId, 'SKILL.md') ?? '';
    if (skillMd.trim().length > 0) {
      finalContent =
        `[Slash Command /${skillId}]: Call \`load_skill({ skillId: "${skillId}" })\` and follow its instructions` +
        (skillArgs ? ` for the user request:\n${skillArgs}` : '.');
    }
  }

  const images = extractImageAttachments(options?.attachments, ctx.db);
  // 附件清单拼进消息文本：模型得以感知非图片附件（csv/pdf/zip…）及其磁盘路径；
  // 纯附件（空文本）消息也不至于提交空字符串。
  const attachedFiles = formatAttachedFilesContext(options?.attachments, ctx.db);
  if (attachedFiles) {
    finalContent = finalContent.trim() ? `${finalContent}\n\n${attachedFiles}` : attachedFiles;
  }
  await rt.submitUserMessage(routerId, finalContent, {
    requestId: `hub-msg:${sessionId}:${Date.now()}`,
    whenBusy: 'steer',
    ...(images.length > 0 ? { images } : {}),
  });
  return routerId;
}

/**
 * Durable 侧用户消息文本与 SQL 侧原始文本的匹配：提交给 Durable 的正文可能被
 * 改写（追加 `[Attached Files]:` 块、`/skill` 斜杠改写为 `[Slash Command /x]: ...`），
 * 精确相等之外按这些已知形态做前缀匹配，保证 Fork/编辑回滚能定位到锚点。
 */
function matchesDurableMessageText(durableText: string, sqlContent: string): boolean {
  if (durableText === sqlContent) return true;
  // 带正文附件：`<原文>\n\n[Attached Files]:…`
  if (sqlContent.trim() !== '' && durableText.startsWith(`${sqlContent}\n\n[Attached Files]:`)) return true;
  // 纯附件空文本消息：整条就是 `[Attached Files]:…`
  if (sqlContent.trim() === '' && durableText.startsWith('[Attached Files]:')) return true;
  // 斜杠技能命令：`/x args` → `[Slash Command /x]: …`
  const slash = /^\/([a-zA-Z0-9_-]+)/.exec(sqlContent.trim());
  if (slash && durableText.startsWith(`[Slash Command /${slash[1]}]:`)) return true;
  return false;
}

/**
 * 在 Durable Router 会话的 Entry 历史中定位某条 botd 消息对应的 EntryId：
 * 1. 若消息 id 为镜像生成的 `msg_dur_<sessionId>_<entryId>`，直接提取 `<entryId>`；
 * 2. 否则按升序遍历会话 Entry，按角色与文本序号匹配对应的 `pi.user` / `pi.assistant` 条目。
 */
async function resolveDurableEntryIdForMessage(
  rt: HubDurableRuntime,
  conversationId: string,
  anchorMessage: { id: string; role: string; content: string },
  messagesUpToAnchor?: ReadonlyArray<{ id: string; role: string; content: string }>,
): Promise<import('@earendil-works/pi-durable').EntryId | undefined> {
  const mirroredMatch = /^msg_dur_.+_(\d+)$/.exec(anchorMessage.id);
  if (mirroredMatch) {
    return Number(mirroredMatch[1]) as import('@earendil-works/pi-durable').EntryId;
  }
  const conv = await rt.conversation(conversationId, BACKGROUND_CONTEXT);
  if (!conv) return undefined;
  const page = await conv.entries({ order: 'ascending' }, 500, undefined, BACKGROUND_CONTEXT);
  const targetRole = anchorMessage.role === 'assistant' ? 'assistant' : 'user';
  // 计算在锚点之前（含锚点）同角色同文本出现的次数，确保重复文本也能精确定位第 N 次出现
  const desiredOccurrence = messagesUpToAnchor
    ? Math.max(
        1,
        messagesUpToAnchor.filter(
          (m) => (m.role === 'assistant' ? 'assistant' : 'user') === targetRole && matchesDurableMessageText(m.content, anchorMessage.content),
        ).length,
      )
    : 1;
  let seenSameContent = 0;
  let lastMatchedId: import('@earendil-works/pi-durable').EntryId | undefined;
  for (const entry of page.items) {
    const first = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
    if (!first || first.role !== targetRole) continue;
    const text = (entry.model ?? []).map(messageText).filter(Boolean).join('\n');
    if (matchesDurableMessageText(text, anchorMessage.content)) {
      lastMatchedId = entry.id;
      seenSameContent++;
      if (seenSameContent === desiredOccurrence) return entry.id;
    }
  }
  return lastMatchedId;
}

/**
 * 使用 `pi-durable` 原生 `conv.fork(atEntryId)` 分叉会话：
 * 将源会话 Router Conversation 在 `anchorMessage` 对应的 `EntryId` 处零拷贝分叉，
 * 并将新 `ConversationId` 绑定到 `targetSessionId` 的 `SessionRouterDoc`。
 */
export async function forkDurableSession(
  rt: HubDurableRuntime,
  input: {
    sourceSessionId: string;
    targetSessionId: string;
    anchorMessage: { id: string; role: string; content: string };
    botId: string;
    messagesUpToAnchor?: ReadonlyArray<{ id: string; role: string; content: string }>;
  },
): Promise<string | undefined> {
  const sourceRouterId = await findRouterConversationId(rt, input.sourceSessionId);
  if (sourceRouterId === undefined) return undefined;
  const entryId = await resolveDurableEntryIdForMessage(
    rt,
    sourceRouterId,
    input.anchorMessage,
    input.messagesUpToAnchor,
  );
  if (entryId === undefined) return undefined;
  const forkedConv = await rt.forkConversation(
    stringToConversationId(sourceRouterId),
    entryId,
    input.botId,
    BACKGROUND_CONTEXT,
  );
  await rt.harness.commit(async (tx) => {
    const doc = await tx.doc(SessionRouterDoc, input.targetSessionId, null);
    doc.conversationId = String(forkedConv.id);
  }, BACKGROUND_CONTEXT);
  return String(forkedConv.id);
}

/**
 * 编辑历史用户消息时的原生 `pi-durable` 时间线回滚（Rewind）：
 * - 若被编辑的是会话第一条消息（`previousMessage === undefined`），直接重置 `SessionRouterDoc` 开启全新上下文；
 * - 若前面已有历史消息，调用原生 `conv.fork(prevEntryId)` 生成精确停在 `previousMessage` 时刻的分支并切流过去，
 *   完整保留编辑点之前的全部工具调用与模型上下文！
 */
export async function rewindDurableSessionBeforeMessage(
  rt: HubDurableRuntime,
  input: {
    sessionId: string;
    botId: string;
    previousMessage?: { id: string; role: string; content: string };
    messagesBeforeEdited?: ReadonlyArray<{ id: string; role: string; content: string }>;
  },
): Promise<string | undefined> {
  await cancelDurableSession(rt, input.sessionId);
  if (!input.previousMessage) {
    await resetDurableSession(rt, input.sessionId);
    return undefined;
  }
  return await forkDurableSession(rt, {
    sourceSessionId: input.sessionId,
    targetSessionId: input.sessionId,
    anchorMessage: input.previousMessage,
    botId: input.botId,
    messagesUpToAnchor: input.messagesBeforeEdited,
  });
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

/**
 * 重置会话的 Durable 侧（清空消息 / 删除会话前调用）：先 `cancelDurableSession`
 * 停掉全部运行中的 Worker 与 Router 回合，再清掉 `SessionRouterDoc` 的映射，
 * 让清空后的会话下一条消息重新懒建一个全新的 Durable Router 会话。
 */
export async function resetDurableSession(rt: HubDurableRuntime, sessionId: string): Promise<void> {
  await cancelDurableSession(rt, sessionId);
  await rt.harness
    .commit(async (tx) => {
      const doc = await tx.doc(SessionRouterDoc, sessionId, null);
      doc.conversationId = '';
    }, BACKGROUND_CONTEXT)
    .catch(() => undefined);
}
