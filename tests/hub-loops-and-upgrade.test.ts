/**
 * Phase 7B：Hub 全链路闭环（外部通道 Ask 回调 / Durable 触发器 / 会话重置 /
 * Hub 管控节点自动升级 / 免节点本地安装）集成测试。
 *
 * 覆盖：
 *  1. 公开免登录 `/api/public/asks/:askId/respond` 能回答 Durable AskDoc 的
 *     pending ask（飞书/Webhook 一键确认链路），落 answered 并 steer 回会话；
 *  2. 触发器（POST /api/triggers/:id/run）在 Durable 主线激活时把唤醒直接
 *     提交进会话的 Durable Router 会话；
 *  3. DELETE /api/sessions/:id/messages 停止运行中的 Worker 并重置
 *     SessionRouterDoc（下一条消息得到全新 Router 会话）；
 *     `/api/sessions/:id/subagents/:runId/stop` 已删除（404）；
 *  4. Hub 管控节点版本对齐：BOTD_AUTO_UPGRADE_NODES=1 且节点版本落后时自动
 *     下发 upgradeDaemon({ targetVersion })；默认关闭时不下发；
 *  5. POST /api/nodes/local/install 与 POST /api/install 在零外部节点下完成
 *     本地 Skill/Extension 安装并落 db.getSkillContent。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import type {
  BotConfig,
  HubRpcFunctions,
  NodeRpcFunctions,
} from '../packages/protocol/src/index.js';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { signAskToken } from '../apps/hub/src/ask-token.js';
import { ensureRouterConversationId } from '../apps/hub/src/routes/workers.js';

const PASSWORD = 'loops-upgrade-password';
const BACKGROUND = await import('@earendil-works/chord/context').then((m) => m.BACKGROUND_CONTEXT);

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
  hub: Awaited<ReturnType<typeof startHub>>;
  faux: ReturnType<typeof fauxProvider>;
  runtime: HubDurableRuntime;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
  request: (route: string, method?: string, body?: unknown) => Promise<Response>;
  events: Array<{ sessionId: string; event: any }>;
}

/** Durable 主线 fixture：注入 HubDurableRuntime + faux provider + SSE 捕获。 */
async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-loops-'));
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
    const result = await response.json().catch(() => undefined);
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  const events: Array<{ sessionId: string; event: any }> = [];
  hub.sseHub.onBroadcast((sessionId, event) => {
    events.push({ sessionId, event });
  });

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
    id: 'sess_loops',
    title: 'Loops',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });
  await hub.ensureDurableRuntime();
  assert.ok(runtime.getPersona('architect'), 'persona must be synced from Hub SQLite');

  return { base, hub, faux, runtime, json, request, events };
}

/** 让 Router 命中「ask_human 后等待回复」的 faux 响应集。 */
const askHumanResponses = () =>
  [...Array(64)].map(
    () =>
      ((context: { messages: readonly { role: string; content?: unknown }[] }) => {
        const text = lastUserText(context.messages);
        if (/please confirm/.test(text) && !toolResultSeen(context.messages)) {
          return fauxAssistantMessage(
            [fauxToolCall('ask_human', { prompt: 'Deploy now?', options: ['yes', 'no'] })],
            { stopReason: 'toolUse' },
          );
        }
        return fauxAssistantMessage('Standing by for your confirmation.');
      }) as never,
  );

/** 测试节点 RPC 最小实现（birpc 客户端需覆盖完整接口形状）。 */
const nodeRpcStub = (overrides: {
  upgradeDaemon?: NodeRpcFunctions['upgradeDaemon'];
}): NodeRpcFunctions => ({
  getModelCatalog: async () => getBuiltinModelCatalog(),
  startProviderLogin: async (input) => ({
    id: `login_${input.providerId}`,
    providerId: input.providerId,
    method: input.method,
    status: 'pending' as const,
    events: [],
  }),
  getProviderLogin: async (loginId) => ({ id: loginId, providerId: 'openai', method: 'api_key', status: 'pending', events: [] }),
  respondProviderLogin: async (input) => ({ id: input.loginId, providerId: 'openai', method: 'api_key', status: 'success', events: [] }),
  cancelProviderLogin: async () => {},
  logoutProvider: async () => {},
  saveBot: async () => {},
  deleteBot: async () => {},
  readFile: async () => '',
  writeFile: async () => {},
  installResource: async (input) => ({ kind: 'skill' as const, id: input.customId ?? 'stub' }),
  deleteResource: async () => {},
  restartDaemon: async () => ({ ok: true as const, pid: 1111 }),
  getCommands: async () => [],
  runTurn: async (input) => ({ replyText: `Reply from ${input.botId}`, modelBadge: 'x/y' }),
  cancelTurn: async () => {},
  resetSession: async () => {},
  ...(overrides.upgradeDaemon ? { upgradeDaemon: overrides.upgradeDaemon } : {}),
});

// ---------------------------------------------------------------------------

test('1. public ask token callback answers a pending durable AskDoc and steers the answer back', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_loops';
  f.faux.setResponses(askHumanResponses());

  // 驱动 ask_human 产生 Durable pending ask
  await f.json('/api/sessions/sess_loops/messages', 'POST', { content: 'please confirm the deploy' });
  const asks = await waitFor(
    async () => await f.json<Array<{ id: string; prompt: string; status: string; options: string[] }>>(`/api/sessions/${sid}/asks`),
    (list) => list.some((a) => /Deploy now\?/.test(a.prompt) && a.status === 'pending'),
    'durable pending ask to surface',
  );
  const askId = asks.find((a) => /Deploy now\?/.test(a.prompt))!.id;
  assert.equal(asks.find((a) => a.id === askId)!.options.includes('yes'), true);

  // 构造与 channel-notifier 同源的一键确认链接：GET /api/public/asks/:askId/respond
  const { resolveAskSecret } = await import('../apps/hub/src/ask-token.js');
  const secret = resolveAskSecret(f.hub.db);
  const token = signAskToken(sid, askId, secret);
  const respondUrl = `/api/public/asks/${encodeURIComponent(askId)}/respond` +
    `?sessionId=${encodeURIComponent(sid)}&answer=${encodeURIComponent('yes')}&token=${encodeURIComponent(token)}`;

  // 免登录 GET（Accept: text/html 的浏览器一键确认路径）
  const htmlRes = await fetch(f.base + respondUrl, { headers: { accept: 'text/html' } });
  assert.equal(htmlRes.status, 200, 'public ask callback (GET, Feishu one-click style) must succeed');
  assert.match(await htmlRes.text(), /yes/);

  // AskDoc 已 answered：GET /asks 不再列出 pending
  await waitFor(
    async () => await f.json<Array<{ id: string; status: string }>>(`/api/sessions/${sid}/asks`),
    (list) => !list.some((a) => a.id === askId && a.status === 'pending'),
    'ask to be answered in AskDoc',
  );

  // interaction_resolved 已广播；答案已 steer 回 Durable 会话
  await waitFor(
    () => f.events,
    (events) =>
      events.some(
        ({ sessionId, event }) => sessionId === sid && event.type === 'interaction_resolved' && event.askId === askId,
      ),
    'interaction_resolved broadcast',
  );
  const routerId = await ensureRouterConversationId(f.runtime, sid, 'architect');
  const routerConv = await f.runtime.conversation(routerId, BACKGROUND);
  assert.ok(routerConv);
  await waitFor(
    async () => {
      const page = await routerConv!.entries({ order: 'ascending' }, 200, undefined, BACKGROUND);
      return page.items.some((entry) => {
        const first = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
        if (first?.role !== 'user') return false;
        const text = typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '');
        return text.includes('[Human Response to Ask "Deploy now?"]: yes');
      });
    },
    (found) => found,
    'answer steered back into the durable conversation',
  );

  // 回调幂等：同一 ask 二次回答返回 404（已非 pending）
  const again = await fetch(f.base + respondUrl, { headers: { accept: 'application/json' } });
  assert.equal(again.status, 404, 'answering an already-answered durable ask must 404');
});

test('2. durable trigger dispatch: POST /api/triggers/:id/run submits the wakeup into the durable router conversation', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_loops';

  const trigger = await f.json<{ id: string }>('/api/sessions/sess_loops/triggers', 'POST', {
    name: 'nightly check',
    botId: 'architect',
    kind: 'webhook',
    prompt: 'run the nightly check',
  });

  await f.json(`/api/triggers/${trigger.id}/run`, 'POST');

  // 唤醒已提交进 Durable Router 会话（带触发器署名）
  const routerId = await ensureRouterConversationId(f.runtime, sid, 'architect');
  const routerConv = await f.runtime.conversation(routerId, BACKGROUND);
  assert.ok(routerConv, 'durable router conversation must exist after trigger run');
  await waitFor(
    async () => {
      const page = await routerConv!.entries({ order: 'ascending' }, 200, undefined, BACKGROUND);
      return page.items.some((entry) => {
        const first = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
        if (first?.role !== 'user') return false;
        const text = typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '');
        return text.includes('[Trigger "nightly check" (@architect)]') && text.includes('run the nightly check');
      });
    },
    (found) => found,
    'trigger wakeup submitted into the durable conversation',
  );
});

test('3. session clear resets the durable side: workers stop, router mapping cleared, dead subagent routes removed', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_loops';

  // 派生一个长任务 Worker
  await f.json(`/api/sessions/${sid}/workers`, 'POST', {
    title: 'long task',
    task: 'Do something long-running.',
  });
  const workers = await waitFor(
    async () => await f.json<{ workers: Array<{ workerId: string; status: string }> }>(`/api/sessions/${sid}/workers`),
    (result) => result.workers.some((w) => w.status === 'running'),
    'spawned worker to be running',
  );
  const workerId = workers.workers.find((w) => w.status === 'running')!.workerId;

  // 建立既有 Router 会话映射（触发器分发已建立；确保存在）
  const routerIdBefore = await ensureRouterConversationId(f.runtime, sid, 'architect');

  // 清空消息：Durable 侧同步重置
  await f.json(`/api/sessions/${sid}/messages`, 'DELETE');

  // Worker 已停止（aborted）——旧 Router 会话下的 WorkerRegistry 依然可查
  const after = await waitFor(
    async () => {
      const workers = await f.runtime.getActiveWorkers(routerIdBefore);
      return workers.find((w) => w.workerId === workerId)?.status;
    },
    (status) => status !== undefined && status !== 'running',
    `worker ${workerId} to stop after session clear`,
  );
  assert.equal(after, 'aborted');

  // SessionRouterDoc 映射已清空：下一条消息懒建全新 Router 会话
  await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: 'fresh start after clear' });
  const routerIdAfter = await ensureRouterConversationId(f.runtime, sid, 'architect');
  assert.notEqual(routerIdAfter, routerIdBefore, 'cleared session must get a fresh durable router conversation');

  // 旧 /subagents 路由已删除（迁移到 /workers/:workerId/stop|steer）
  const stopRes = await f.request(`/api/sessions/${sid}/subagents/${workerId}/stop`, 'POST', {});
  assert.equal(stopRes.status, 404, 'legacy /subagents/:runId/stop must be gone (404)');
  const interactRes = await f.request(`/api/sessions/${sid}/subagents/${workerId}/interact`, 'POST', { message: 'hi' });
  assert.equal(interactRes.status, 404, 'legacy /subagents/:runId/interact must be gone (404)');
});

test('4. hub-controlled node auto-upgrade dispatches upgradeDaemon when enabled and node version is behind', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-upgrade-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const originalOverride = process.env.BOTD_VERSION_OVERRIDE;
  const originalAuto = process.env.BOTD_AUTO_UPGRADE_NODES;
  process.env.BOTD_VERSION_OVERRIDE = '0.1.0';
  process.env.BOTD_AUTO_UPGRADE_NODES = '1';
  t.after(() => {
    if (originalOverride === undefined) delete process.env.BOTD_VERSION_OVERRIDE;
    else process.env.BOTD_VERSION_OVERRIDE = originalOverride;
    if (originalAuto === undefined) delete process.env.BOTD_AUTO_UPGRADE_NODES;
    else process.env.BOTD_AUTO_UPGRADE_NODES = originalAuto;
  });

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
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
  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => undefined);
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  const upgradeCalls: Array<{ targetVersion?: string }> = [];
  const connectNode = async (version?: string) => {
    const pairing = await json<{ code: string }>('/api/nodes/pairing', 'POST');
    const identity = await json<{ nodeId: string; token: string }>('/api/nodes/pairing/exchange', 'POST', {
      code: pairing.code,
      name: 'Auto-upgrade node',
      platform: 'linux',
    });
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`);
    t.after(() => socket.terminate());
    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
      nodeRpcStub({
        upgradeDaemon: async (options) => {
          upgradeCalls.push({ targetVersion: options?.targetVersion });
          return {
            ok: true as const,
            previousVersion: version ?? '',
            targetVersion: options?.targetVersion ?? '',
            upgraded: true,
          };
        },
      }),
      {
        post: (data) => socket.send(data),
        on: (callback) => socket.on('message', (d) => callback(d.toString())),
        serialize: serializeRpcMessage as never,
        deserialize: JSON.parse,
        timeout: 10_000,
      },
    );
    await once(socket, 'open');
    await rpc.registerNode({
      nodeId: identity.nodeId,
      name: 'Auto-upgrade node',
      platform: 'linux',
      bots: [],
      skills: [],
      extensions: [],
      ...(version ? { version } : {}),
    });
    return identity.nodeId;
  };

  // 落后节点：Hub 0.1.0 vs 节点 0.0.9 → 自动下发 upgradeDaemon({ targetVersion: '0.1.0' })
  await connectNode('0.0.9');
  await waitFor(
    () => upgradeCalls,
    (calls) => calls.some((c) => c.targetVersion === '0.1.0'),
    'auto-upgrade dispatch for the outdated node',
  );

  // 同版本节点：不下发额外升级
  const before = upgradeCalls.length;
  await connectNode('0.1.0');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(upgradeCalls.length, before, 'no auto-upgrade for a node already at the hub version');

  // 默认关闭（BOTD_AUTO_UPGRADE_NODES 未设）：不触发自动升级
  delete process.env.BOTD_AUTO_UPGRADE_NODES;
  const hub2 = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub2.sqlite'),
    adminPassword: PASSWORD,
  });
  t.after(async () => {
    (hub2.server as any).closeAllConnections?.();
    await hub2.close();
  });
  const address2 = hub2.server.address();
  assert(address2 && typeof address2 !== 'string');
  const base2 = `http://127.0.0.1:${address2.port}`;
  const login2 = await fetch(`${base2}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login2.status, 200);
  const cookie2 = login2.headers.get('set-cookie')!.split(';')[0];

  const disabledCalls: Array<{ targetVersion?: string }> = [];
  const pairing2 = await (async () => {
    const response = await fetch(`${base2}/api/nodes/pairing`, {
      method: 'POST',
      headers: { cookie: cookie2 },
    });
    return response.json() as Promise<{ code: string }>;
  })();
  const identity2 = await (async () => {
    const response = await fetch(`${base2}/api/nodes/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie2 },
      body: JSON.stringify({ code: pairing2.code, name: 'Disabled node', platform: 'linux' }),
    });
    return response.json() as Promise<{ nodeId: string; token: string }>;
  })();
  const socket2 = new WebSocket(`${base2.replace('http:', 'ws:')}/ws/node?nodeId=${identity2.nodeId}&token=${identity2.token}`);
  t.after(() => socket2.terminate());
  const rpc2 = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
    nodeRpcStub({
      upgradeDaemon: async (options) => {
        disabledCalls.push({ targetVersion: options?.targetVersion });
        return { ok: true as const, previousVersion: '0.0.9', targetVersion: options?.targetVersion ?? '', upgraded: true };
      },
    }),
    {
      post: (data) => socket2.send(data),
      on: (callback) => socket2.on('message', (d) => callback(d.toString())),
      serialize: serializeRpcMessage as never,
      deserialize: JSON.parse,
      timeout: 10_000,
    },
  );
  await once(socket2, 'open');
  await rpc2.registerNode({
    nodeId: identity2.nodeId,
    name: 'Disabled node',
    platform: 'linux',
    bots: [],
    skills: [],
    extensions: [],
    version: '0.0.9',
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(disabledCalls.length, 0, 'auto-upgrade must stay disabled by default');
});

test('5. hub local install: /api/nodes/local/install and /api/install work with zero external nodes', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 本地素材：单文件 skill、目录 skill（SKILL.md）、单文件 extension
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-local-install-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const skillFile = path.join(dir, 'deploy-notes.md');
  await writeFile(skillFile, '# Deploy Notes\n\nRoll out staging first, then prod.\n', 'utf8');
  const skillDir = path.join(dir, 'review-checklist');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '# Review Checklist\n\n1. Read the diff twice.\n', 'utf8');
  const extFile = path.join(dir, 'shout-extension.ts');
  await writeFile(extFile, "import { defineExtension } from '@earendil-works/pi-durable';\nexport default defineExtension({ name: 'shout' });\n", 'utf8');

  // 零外部节点（fixture 从未连接 WebSocket 节点）：
  // 1) 本地 .md 文件 → skill，内容落 db.getSkillContent
  const fromFile = await f.json<{ kind: string; id: string }>('/api/nodes/local/install', 'POST', {
    source: skillFile,
    kind: 'skill',
  });
  assert.equal(fromFile.kind, 'skill');
  assert.equal(fromFile.id, 'deploy-notes');
  const fileContent = f.hub.db.getSkillContent('deploy-notes');
  assert.ok(fileContent.includes('Roll out staging first'), `skill content must be stored, got: ${JSON.stringify(fileContent)}`);

  // 2) 本地目录（含 SKILL.md）→ skill
  const fromDir = await f.json<{ kind: string; id: string }>('/api/nodes/local/install', 'POST', {
    source: skillDir,
  });
  assert.equal(fromDir.kind, 'skill');
  assert.ok(f.hub.db.getSkillContent(fromDir.id).includes('Read the diff twice'));

  // 3) 本地 .ts 文件 → extension，内容落 db.getExtensionContent
  const fromExt = await f.json<{ kind: string; id: string }>('/api/nodes/local/install', 'POST', {
    source: extFile,
  });
  assert.equal(fromExt.kind, 'extension');
  assert.ok(f.hub.db.getExtensionContent(fromExt.id).includes("defineExtension"));

  // 4) 全局 /api/install 路由同构可用（等价 local 节点直装）
  const globalInstall = await f.json<{ kind: string; id: string }>('/api/install', 'POST', {
    source: skillFile,
    kind: 'skill',
    customId: 'deploy-notes-global',
  });
  assert.equal(globalInstall.kind, 'skill');
  assert.equal(globalInstall.id, 'deploy-notes-global');
  assert.ok(f.hub.db.getSkillContent('deploy-notes-global').includes('Roll out staging first'));

  // 虚拟 local 节点已自动创建并登记清单
  const nodes = await f.json<Array<{ id: string; skills: string[] }>>('/api/nodes');
  const local = nodes.find((n) => n.id === 'local');
  assert.ok(local, 'virtual local node must be auto-created');
  assert.ok(local.skills.includes('deploy-notes'));
});
