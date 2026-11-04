/**
 * Durable 内核深度打磨（Phase 6A）集成测试。
 *
 * 覆盖：
 *  1. 热同步：Bot SYSTEM/MEMORY 更新与节点 Skill 安装（install 回读真实内容，
 *     不再写空串）后自动刷新 HubDurableRuntime 分身；
 *  2. Durable AskDoc 全闭环：ask_human 产生的 pending ask 透出到
 *     GET /api/sessions/:id/asks，respond 落 answered、广播 interaction_resolved、
 *     并把答案 steer 回 Durable 会话；
 *  3. DurableSessionMirror 全保真：带工具调用与 token 用量的 assistant 回合，
 *     toolCalls 与 usage 落到 MessageRecord；
 *  4. 会话 cancel 停止 Durable 侧 running Worker；
 *  5. Worker 挂载 codemode 扩展（QuickJS 沙箱）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import type { Extension } from '@earendil-works/pi-durable';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import type { BotConfig, HubRpcFunctions, NodeRpcFunctions, ProviderLoginState } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';
import { ensureRouterConversationId } from '../apps/hub/src/routes/workers.js';

const PASSWORD = 'deep-polish-password';

const waitFor = async <T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  message: string,
  timeout = 10_000,
): Promise<T> => {
  const end = Date.now() + timeout;
  let last: T;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The extensions an AgentChange adds: the object form's `add` list. */
const addedExtensions = (change: import('@earendil-works/pi-durable').AgentChange): Extension[] => {
  const extensions: unknown = change.extensions;
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) return [];
  return [...(((extensions as { add?: readonly Extension[] }).add ?? []))];
};

const lastUserText = (messages: readonly { role: string; content?: unknown }[]): string => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (typeof lastUser?.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? '');
  return '';
};

const toolResultSeen = (messages: readonly { role: string; content?: unknown }[]): boolean => {
  const reversed = [...messages].reverse();
  const lastUser = reversed.findIndex((m) => m.role === 'user');
  return lastUser >= 0 && reversed.slice(0, lastUser).some((m) => m.role === 'toolResult');
};

interface Fixture {
  base: string;
  cookie: string;
  hub: Awaited<ReturnType<typeof startHub>>;
  faux: ReturnType<typeof fauxProvider>;
  runtime: HubDurableRuntime;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
  request: (route: string, method?: string, body?: unknown) => Promise<Response>;
  connectNode: (files: Map<string, string>) => Promise<{ nodeId: string; socket: WebSocket }>;
  events: Array<{ sessionId: string; event: any }>;
}

/**
 * 全链路 fixture：真实 HTTP Hub + HubDurableRuntime（faux provider）+ SSE 捕获。
 * durableRuntime 走注入路径（主线切流立即可用，与生产 startHub 打开后等价）。
 */
async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-deep-polish-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableRuntime: runtime,
    durableModels: models,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
  });

  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  const request = async (route: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(route, method, body);
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  // SSE 事件捕获：AskCard 弹出（interaction_request）与 interaction_resolved 都要广播。
  const events: Array<{ sessionId: string; event: any }> = [];
  hub.sseHub.onBroadcast((sessionId, event) => {
    events.push({ sessionId, event });
  });

  // 种子：节点 + Bot + 会话（Hub SQLite 权威存储）。
  const db = hub.db;
  db.createNode({
    id: 'node-1',
    name: 'Test node',
    platform: 'linux',
    tokenHash: 'x'.repeat(64),
    ownerId: 'user_admin',
  });
  const now = new Date().toISOString();
  db.saveBot({
    id: 'architect',
    nodeId: 'node-1',
    name: 'Architect',
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: now,
  });
  db.setBotFile('architect', 'system', 'You are the architect bot.');
  db.createSession({
    id: 'sess_polish',
    title: 'Deep polish',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });
  // 种子就绪后同步分身（与生产 startHub 的 ensureDurableRuntime 时机一致）。
  await hub.ensureDurableRuntime();
  assert.ok(runtime.getPersona('architect'), 'persona must be synced from Hub SQLite');

  /** 配对一个真实 WebSocket 节点：install/readFile 由 files Map 支撑。 */
  const connectNode = async (files: Map<string, string>) => {
    const pairing = await json<{ code: string }>('/api/nodes/pairing', 'POST');
    const identity = await json<{ nodeId: string; token: string }>(
      '/api/nodes/pairing/exchange',
      'POST',
      { code: pairing.code, name: 'Remote node', platform: 'linux' },
    );
    const socket = new WebSocket(
      `${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`,
    );
    t.after(() => socket.terminate());
    const bots: BotConfig[] = [];
    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>({
      getModelCatalog: async () => getBuiltinModelCatalog(),
      startProviderLogin: async (input) => ({
        id: `login_${input.providerId}`,
        providerId: input.providerId,
        method: input.method,
        status: 'pending' as const,
        events: [],
      }),
      getProviderLogin: async (loginId) => ({ id: loginId } as ProviderLoginState),
      respondProviderLogin: async (input) => ({ id: input.loginId } as ProviderLoginState),
      cancelProviderLogin: async () => {},
      logoutProvider: async () => {},
      saveBot: async () => {},
      deleteBot: async () => {},
      readFile: async (target) => files.get(`${target.kind}:${target.id}`) ?? '',
      writeFile: async (target, content) => {
        files.set(`${target.kind}:${target.id}`, content);
      },
      installResource: async (input) => {
        const kind = input.kind && input.kind !== 'auto' ? input.kind : input.source.includes('extension') ? 'extension' : 'skill';
        const id = input.customId || (kind === 'skill' ? 'installed-skill' : 'installed-ext');
        files.set(`${kind}:${id}`, `# Installed from ${input.source}\nReal content body.`);
        return { kind: kind as 'skill' | 'extension', id };
      },
      deleteResource: async (target) => {
        files.delete(`${target.kind}:${target.id}`);
      },
      restartDaemon: async () => ({ ok: true as const, pid: 4321 }),
      getCommands: async () => [],
      runTurn: async (input) => ({ replyText: `Reply from ${input.botId}`, modelBadge: 'faux/main' }),
      cancelTurn: async () => {},
      resetSession: async () => {},
    }, {
      post: (data) => socket.send(data),
      on: (callback) => socket.on('message', (d) => callback(d.toString())),
      serialize: serializeRpcMessage as never,
      deserialize: JSON.parse,
      timeout: 10_000,
    });
    await once(socket, 'open');
    await rpc.registerNode({
      nodeId: identity.nodeId,
      name: 'Remote node',
      platform: 'linux',
      bots,
      skills: [],
      extensions: [],
    });
    return { nodeId: identity.nodeId, socket };
  };

  return { base, cookie, hub, faux, runtime, json, request, connectNode, events };
}

// ---------------------------------------------------------------------------

test('1. hot persona sync + install content sync populate real skill content and refresh the runtime', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const db = f.hub.db;
  const files = new Map<string, string>();

  // 持久运行时先打开（注入路径已就绪）；分身初始指令来自注册时的 persona。
  await f.hub.ensureDurableRuntime();
  assert.match(f.runtime.getPersona('architect')!.instructions, /architect bot/);

  // 热同步：PUT /api/bots/:id/system 更新 SYSTEM.md → persona 指令即时刷新。
  await f.request('/api/bots/architect/system', 'PUT', {
    content: 'You are the architect v2. Always prefer reversible migrations.',
  });
  await waitFor(
    () => f.runtime.getPersona('architect')!.instructions,
    (instructions) => instructions.includes('reversible migrations'),
    'persona instructions to refresh after SYSTEM.md update',
  );

  // 热同步：MEMORY.md 同样生效。
  await f.request('/api/bots/architect/memory', 'PUT', { content: 'Team ships on Fridays.' });
  await waitFor(
    () => f.runtime.getPersona('architect')!.memory ?? '',
    (memory) => memory.includes('Fridays'),
    'persona memory to refresh after MEMORY.md update',
  );

  // 节点在线后安装 Skill：install 内容回读真实文件（不再写空串）。
  const { nodeId } = await f.connectNode(files);
  const installed = await f.json<{ kind: string; id: string }>(`/api/nodes/${nodeId}/install`, 'POST', {
    source: 'https://github.com/example/deploy-skill',
    kind: 'skill',
  });
  assert.equal(installed.kind, 'skill');
  assert.equal(installed.id, 'installed-skill');
  const content = db.getSkillContent(installed.id);
  assert.ok(
    typeof content === 'string' && content.includes('Real content body'),
    `installed skill content must be the real file body, got: ${JSON.stringify(content)}`,
  );

  // Bot 启用该 Skill → 热同步后 persona.enabledSkills 带上它，load_skill 能读到内容。
  await f.request('/api/bots/architect', 'PUT', { enabledSkills: [installed.id] });
  await waitFor(
    () => f.runtime.getPersona('architect')!.enabledSkills ?? [],
    (skills) => skills.includes(installed.id),
    'persona enabledSkills to refresh after bot update',
  );
});

test('2. durable AskDoc full loop: pending ask surfaced, respond marks answered + broadcasts + steers the answer back', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_polish';

  // Router：收到问题 → ask_human 发起确认 → 工具结果返回后等待用户响应。
  f.faux.setResponses(
    [...Array(64)].map(
      () =>
        ((context: { messages: readonly { role: string; content?: unknown }[] }) => {
          const text = lastUserText(context.messages);
          if (/please confirm the rollout plan/.test(text) && !toolResultSeen(context.messages)) {
            return fauxAssistantMessage(
              [fauxToolCall('ask_human', { prompt: 'Roll out to production now?', options: ['yes', 'no'] })],
              { stopReason: 'toolUse' },
            );
          }
          return fauxAssistantMessage('Standing by for your confirmation.');
        }) as never,
    ),
  );

  // 用户消息走主线切流：Durable Router 会话建立并驱动 ask_human。
  const posted = await f.json<{ role: string }>('/api/sessions/sess_polish/messages', 'POST', {
    content: 'please confirm the rollout plan',
  });
  assert.equal(posted.role, 'user');

  // pending ask 透出到 GET /api/sessions/:id/asks（AskDoc，非 pending_asks 表）。
  const asks = await waitFor(
    async () => await f.json<Array<{ id: string; prompt: string; status: string }>>(`/api/sessions/${sid}/asks`),
    (list) => list.some((a) => /Roll out to production/.test(a.prompt) && a.status === 'pending'),
    'durable pending ask to surface via GET /asks',
  );
  const askId = asks.find((a) => /Roll out to production/.test(a.prompt))!.id;

  // 镜像 watch：新 pending ask 广播 interaction_request（前端 AskCard 弹出）。
  await waitFor(
    () => f.events,
    (events) =>
      events.some(
        ({ sessionId, event }) =>
          sessionId === sid && event.type === 'interaction_request' && event.ask?.id === askId,
      ),
    'interaction_request broadcast for the new pending ask',
  );

  // respond：AskDoc 落 answered + 广播 interaction_resolved + 答案 steer 回会话。
  const responded = await f.json<{ ok: boolean; ask: { id: string; status: string; answer: string } }>(
    `/api/sessions/${sid}/asks/${encodeURIComponent(askId)}/respond`,
    'POST',
    { answer: 'yes' },
  );
  assert.equal(responded.ok, true);
  assert.equal(responded.ask.status, 'answered');
  assert.equal(responded.ask.answer, 'yes');

  await waitFor(
    () => f.events,
    (events) =>
      events.some(
        ({ sessionId, event }) =>
          sessionId === sid && event.type === 'interaction_resolved' && event.askId === askId,
      ),
    'interaction_resolved broadcast after respond',
  );

  // 答案已作为用户消息 steer 回 Router 会话（唤醒等待中的 agent）。
  const rt = f.runtime;
  const routerConversation = await ensureRouterConversationId(rt, sid, 'architect');
  const routerConv = await rt.conversation(routerConversation, BACKGROUND_CONTEXT);
  assert.ok(routerConv, 'router conversation must exist');
  await waitFor(
    async () => {
      const page = await routerConv!.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT);
      return page.items.some((entry) => {
        const first = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
        if (first?.role !== 'user') return false;
        const text =
          typeof first.content === 'string'
            ? first.content
            : Array.isArray(first.content)
              ? JSON.stringify(first.content)
              : '';
        return text.includes('[Human Response to Ask "Roll out to production now?"]: yes');
      });
    },
    (found) => found,
    'the human answer steered back into the durable conversation',
  );

  // AskDoc 状态已 answered（GET /asks 不再列出 pending）。
  const after = await f.json<Array<{ id: string; status: string }>>(`/api/sessions/${sid}/asks`);
  assert.equal(after.some((a) => a.id === askId && a.status === 'pending'), false);
});

test('3. DurableSessionMirror rich fidelity: toolCalls and usage persist onto MessageRecord', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // Router 直接调 load_skill（persona-skills 扩展自带）然后总结：两段 assistant。
  f.faux.setResponses(
    [...Array(64)].map(
      () =>
        ((context: { messages: readonly { role: string; content?: unknown }[] }) => {
          const text = lastUserText(context.messages);
          if (/load the deploy notes/.test(text) && !toolResultSeen(context.messages)) {
            return fauxAssistantMessage(
              [fauxToolCall('ask_human', { prompt: 'Which deploy env?' })],
              { stopReason: 'toolUse' },
            );
          }
          return fauxAssistantMessage('Deploy notes loaded: staging then prod.');
        }) as never,
    ),
  );

  await f.json('/api/sessions/sess_polish/messages', 'POST', { content: 'load the deploy notes' });

  // 镜像落库：assistant 消息出现在会话消息里（faux 估算非零 usage）。
  await waitFor(
    async () =>
      await f.json<Array<{ id: string; role: string; content: string; toolCalls?: any[]; usage?: any }>>(
        '/api/sessions/sess_polish/messages',
      ),
    (list) => list.some((m) => m.role === 'assistant' && /Deploy notes loaded/.test(m.content)),
    'mirrored assistant message to appear',
  );

  // 工具调用回合：toolCall 助手消息带 toolCalls（name + args + done）。
  await waitFor(
    async () =>
      await f.json<Array<{ id: string; role: string; toolCalls?: any[]; usage?: any }>>(
        '/api/sessions/sess_polish/messages',
      ),
    (list) => list.some((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0),
    'assistant message with toolCalls to be mirrored',
  );

  // usage：所有 assistant 镜像消息都带 usage 且 token 口径齐全。
  const withUsage = await waitFor(
    async () =>
      await f.json<Array<{ id: string; role: string; usage?: any }>>('/api/sessions/sess_polish/messages'),
    (list) =>
      list.filter((m) => m.role === 'assistant').length > 0 &&
      list.filter((m) => m.role === 'assistant').every((m) => m.usage !== undefined),
    'assistant messages to carry usage',
  );
  const assistantUsages = withUsage.filter((m) => m.role === 'assistant').map((m) => m.usage);
  assert.ok(
    assistantUsages.every((u) => typeof u.totalTokens === 'number' && u.totalTokens > 0),
    `every mirrored assistant message must carry positive totalTokens: ${JSON.stringify(assistantUsages)}`,
  );

  // toolCalls：工具调用回合的镜像消息带 name/args/status=done。
  const withCalls = await f.json<Array<{ id: string; role: string; toolCalls?: any[] }>>(
    '/api/sessions/sess_polish/messages',
  );
  const callMessage = withCalls.find((m) => (m.toolCalls ?? []).length > 0);
  assert.ok(callMessage, 'a mirrored assistant message with toolCalls must exist');
  const call = callMessage!.toolCalls![0];
  assert.equal(call.name, 'ask_human');
  assert.equal(call.status, 'done');
  assert.ok(call.args && (call.args as Record<string, unknown>).prompt !== undefined);
});

test('4. session cancel stops running durable workers on the session', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_polish';

  // Router 派生一个长任务 Worker（faux 慢流式让 Worker 保持 running）。
  await f.json(`/api/sessions/${sid}/workers`, 'POST', {
    title: 'long task',
    task: 'Do something long-running.',
  });

  // Worker 出现且处于 running。
  const workers = await waitFor(
    async () => await f.json<{ workers: Array<{ workerId: string; status: string }> }>(`/api/sessions/${sid}/workers`),
    (result) => result.workers.some((w) => w.status === 'running'),
    'spawned worker to be running',
  );
  const workerId = workers.workers.find((w) => w.status === 'running')!.workerId;

  // 会话 cancel：GroupRouter 队列失效 + Durable 侧 Worker 停止。
  await f.json(`/api/sessions/${sid}/cancel`, 'POST');

  const after = await waitFor(
    async () => await f.json<{ workers: Array<{ workerId: string; status: string }> }>(`/api/sessions/${sid}/workers`),
    (result) => result.workers.find((w) => w.workerId === workerId)?.status !== 'running',
    `worker ${workerId} to stop after session cancel`,
  );
  assert.equal(after.workers.find((w) => w.workerId === workerId)!.status, 'aborted');
});

test('5. worker agent mounts the codemode extension (QuickJS sandbox)', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const persona = f.runtime.getPersona('architect')!;

  const worker = f.runtime.workerAgentFor(persona);
  const names = addedExtensions(worker).map((e) => e.name);
  assert.ok(
    names.includes('codemode'),
    `worker agent must mount the codemode extension: got ${names.join(', ')}`,
  );
  assert.ok(names.includes('botd-worker'));

  // codemode 工具在注册表里可用（沙箱懒初始化，工具描述完整）。
  const codemode = f.runtime.getCodemodeExtension();
  assert.ok(codemode, 'codemode extension must be installed in the registry');
  const tool = (codemode.tools ?? []).find((tool) => tool.name === 'codemode');
  assert.ok(tool, 'codemode tool registered');
});
