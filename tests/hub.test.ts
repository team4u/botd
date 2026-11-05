import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { startHub } from '../apps/hub/src/index.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import type { ProviderLoginState } from '../packages/protocol/src/index.js';
import type { BotConfig, HubRpcFunctions, MessageRecord, NodeRpcFunctions, SessionRecord, TriggerRecord } from '../packages/protocol/src/index.js';

const PASSWORD = 'integration-password';
const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for the expected state');
};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-hub-test-'));
  // 新回合引擎主线：注入 faux provider 的 HubDurableRuntime，消息提交走 Durable 会话，
  // 不再依赖节点侧已废弃的 runTurn RPC。
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const durableRuntime = await HubDurableRuntime.open({
    storage: new MemoryStorage(),
    models,
    workerAgent: () => ({}),
  });
  faux.setResponses(Array.from({ length: 32 }, () => fauxAssistantMessage('ok')));
  t.after(async () => {
    await durableRuntime.close();
  });
  const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'hub.sqlite'), adminPassword: PASSWORD, durableRuntime });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  let cookie = '';
  const request = async (route: string, method = 'GET', body?: unknown, authenticated = true, cookieOverride?: string) => {
    const effectiveCookie = cookieOverride ?? cookie;
    const response = await fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated && effectiveCookie ? { cookie: effectiveCookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  };
  const login = await request('/api/auth/login', 'POST', { username: 'admin', password: PASSWORD });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(route, method, body);
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };
  const loginAs = async (username: string, password: string): Promise<string> => {
    const response = await request('/api/auth/login', 'POST', { username, password }, false);
    assert.equal(response.status, 200, `login as ${username} failed`);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const forUser = (cookieHeader: string) => {
    const jsonAs = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await request(route, method, body, true, cookieHeader);
      const result = await response.json();
      assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
      return result as T;
    };
    const requestAs = (route: string, method = 'GET', body?: unknown) => request(route, method, body, true, cookieHeader);
    return { json: jsonAs, request: requestAs };
  };
  const addNode = async (
    ids: string[],
    extensions: string[] = ['demo-ext'],
    cookieOverride?: string
  ) => {
    const jsonAs = cookieOverride ? forUser(cookieOverride).json : json;
    const pairing = await jsonAs('/api/nodes/pairing', 'POST');
    assert.match(pairing.code, /^\d{6}$/);
    const identity = await jsonAs('/api/nodes/pairing/exchange', 'POST', { code: pairing.code, name: 'Test node', platform: 'linux' });
    const bots: BotConfig[] = ids.map(id => ({ id, nodeId: identity.nodeId, name: id, description: '', modelProvider: 'faux', modelId: 'main', thinkingLevel: 'medium', enabledSkills: [], updatedAt: new Date().toISOString() }));
    const files = new Map<string, string>();
    const logins = new Map<string, ProviderLoginState>();
    const authCalls: string[] = [];
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`);
    sockets.push(socket);
    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>({
      getModelCatalog: async () => getBuiltinModelCatalog(),
      startProviderLogin: async input => {
        const id = `login_${logins.size}`;
        const state: ProviderLoginState = { id, providerId: input.providerId, method: input.method, status: 'pending', events: [{ type: 'auth_url', url: 'https://example.com/auth' }], prompt: { id: 'prompt_1', type: 'manual_code', message: 'Paste authorization code' } };
        logins.set(id, state);
        return state;
      },
      getProviderLogin: async id => logins.get(id)!,
      respondProviderLogin: async input => {
        const state = logins.get(input.loginId)!;
        assert.equal(input.promptId, state.prompt?.id);
        state.status = 'success';
        delete state.prompt;
        return state;
      },
      cancelProviderLogin: async id => { logins.get(id)!.status = 'cancelled'; },
      logoutProvider: async providerId => { authCalls.push(providerId); },
      saveBot: async bot => { const i = bots.findIndex(existing => existing.id === bot.id); if (i < 0) bots.push(bot); else bots[i] = bot; },
      deleteBot: async id => { const index = bots.findIndex(bot => bot.id === id); if (index >= 0) bots.splice(index, 1); },
      readFile: async target => files.get(`${target.kind}:${target.botId ?? target.id}`) ?? '',
      writeFile: async (target, content) => { files.set(`${target.kind}:${target.botId ?? target.id}`, content); },
      installResource: async input => {
        const kind = input.kind && input.kind !== 'auto' ? input.kind : (input.source.includes('skill') ? 'skill' : 'extension');
        const id = input.customId || 'installed-res';
        files.set(`${kind}:${id}`, `installed from ${input.source}`);
        return { kind, id };
      },
      deleteResource: async target => {
        files.delete(`${target.kind}:${target.id}`);
      },
      restartDaemon: async () => ({ ok: true as const, pid: 4242 }),
      readResourcePackage: async (target: { kind: 'skill' | 'extension'; id: string }) => ({
        kind: target.kind,
        id: target.id,
        files: [
          {
            path: target.kind === 'skill' ? 'SKILL.md' : 'index.ts',
            content: files.get(`${target.kind}:${target.id}`) ?? '',
          },
        ],
      }),
    }, {
      post: data => socket.send(data),
      on: callback => socket.on('message', data => callback(data.toString())),
      serialize: serializeRpcMessage,
      deserialize: JSON.parse,
      timeout: 10_000,
    });
    await once(socket, 'open');
    await rpc.registerNode({ nodeId: identity.nodeId, name: 'Test node', platform: 'linux', bots, skills: ['demo'], extensions });
    return { identity, bots, socket, rpc, files, authCalls };
  };
  const session = (ids: string[], mode = 'direct') => json<SessionRecord>('/api/sessions', 'POST', { title: 'Test session', mode: 'direct', leadBotId: ids[0], memberBotIds: [ids[0]] });
  const messages = (id: string) => json<MessageRecord[]>(`/api/sessions/${id}/messages`);
  const idle = async (id: string) => waitFor(() => json<SessionRecord[]>('/api/sessions'), list => list.find(s => s.id === id)?.status !== 'running');
  return { hub, base, request, json, addNode, session, messages, idle, cookie: () => cookie, loginAs, forUser, faux, durableRuntime };
}

test('Pi catalog exposes full public metadata and Hub-owned api_key provider login', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/models/catalog', 'GET', undefined, false)).status, 401);
  const catalog = await f.json('/api/models/catalog');
  assert.equal(catalog.source, 'pi');
  const ids = new Set(catalog.providers.map((provider: any) => provider.id));
  for (const id of ['mistral', 'groq', 'github-copilot', 'xai', 'zai-coding-cn', 'minimax-cn']) assert(ids.has(id), `SDK provider ${id} is missing`);
  const codex = catalog.providers.find((provider: any) => provider.id === 'openai-codex');
  assert(codex.authMethods.some((method: any) => method.type === 'oauth'));
  assert.equal(codex.authMethods.some((method: any) => method.type === 'api_key'), false);
  // 未配置任何凭据时，内置目录不把任何 provider 标记为 configured
  assert(catalog.providers.every((provider: any) => provider.configured === false));

  const node = await f.addNode(['worker']);
  // 目录不再依赖节点：nodeId 仅做归属校验，结果与全局目录一致
  const nodeCatalog = await f.json(`/api/models/catalog?nodeId=${node.identity.nodeId}`);
  assert.equal(nodeCatalog.providers.length, catalog.providers.length);

  // Hub 直连 api_key 登录：不接触任何节点 RPC
  const prefix = `/api/nodes/${node.identity.nodeId}`;
  const login = await f.json('/api/providers/openai/login', 'POST', { method: 'api_key' });
  assert.equal(login.status, 'pending');
  assert.equal(login.prompt.id, 'api_key');
  assert.equal(login.prompt.type, 'secret');
  const state = await f.json(`/api/provider-logins/${login.id}`);
  assert.equal(state.prompt.id, 'api_key');
  assert.equal((await f.request(`/api/provider-logins/${login.id}/respond`, 'POST', { value: 'sk-test' })).status, 400);
  const completed = await f.json(`/api/provider-logins/${login.id}/respond`, 'POST', { promptId: 'api_key', value: 'sk-test-123' });
  assert.equal(completed.status, 'success');
  assert.equal(JSON.stringify(completed).includes('sk-test-123'), false, 'API key must never be echoed');

  // 目录标记 configured + credentialType
  const configured = await f.json('/api/models/catalog');
  const openai = configured.providers.find((provider: any) => provider.id === 'openai');
  assert.equal(openai.configured, true);
  assert.equal(openai.credentialType, 'api_key');

  // 凭据查询不泄露密钥
  const credentials = await f.json('/api/providers/openai/credentials');
  assert.deepEqual(Object.keys(credentials).sort(), ['authType', 'configured', 'updatedAt']);

  // 节点维度别名路由映射到同一 Hub 实现
  const alias = await f.json(`${prefix}/providers/anthropic/login`, 'POST', { method: 'api_key' });
  assert.equal(alias.status, 'pending');
  const aliasDone = await f.json(`${prefix}/provider-logins/${alias.id}/respond`, 'POST', { promptId: 'api_key', value: 'sk-ant' });
  assert.equal(aliasDone.status, 'success');

  // 注销：凭据删除后回到未配置状态
  await f.json('/api/providers/openai/auth', 'DELETE');
  const afterLogout = await f.json('/api/models/catalog');
  assert.equal(afterLogout.providers.find((provider: any) => provider.id === 'openai').configured, false);

  // 取消与校验路径
  const other = await f.json(`${prefix}/providers/openai/login`, 'POST', { method: 'api_key' });
  await f.json(`${prefix}/provider-logins/${other.id}`, 'DELETE');
  assert.equal((await f.request(`${prefix}/provider-logins/${other.id}`)).status, 404, 'cancelled login sessions are gone');
  assert.equal((await f.request('/api/providers/openai/login', 'POST', { method: 'invalid' })).status, 400);
  assert.equal((await f.request('/api/providers/ghost-provider/login', 'POST', { method: 'api_key' })).status, 501);
});

test('auth, one-time pairing and authenticated node registration', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/nodes', 'GET', undefined, false)).status, 401);
  assert.equal((await f.request('/api/auth/login', 'POST', { username: 'admin', password: 'wrong' }, false)).status, 401);
  assert.equal((await f.request('/api/nodes/pairing/exchange', 'POST', { code: '000000', name: 'Bad', platform: 'linux' }, false)).status, 400);
  assert.equal((await f.request('/api/nodes/pairing', 'POST', undefined, false)).status, 401, 'pairing requires a logged-in user');
  const node = await f.addNode(['alpha']);
  const nodes = await f.json('/api/nodes');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].status, 'online');
  assert.equal(nodes[0].bots[0].id, 'alpha');
  assert.equal(JSON.stringify(nodes).includes(node.identity.token), false);
  const pairing = await f.json('/api/nodes/pairing', 'POST');
  const input = { code: pairing.code, name: 'Once', platform: 'linux' };
  await f.json('/api/nodes/pairing/exchange', 'POST', input);
  assert.equal((await f.request('/api/nodes/pairing/exchange', 'POST', input)).status, 400);
  await node.rpc.registerNode({ nodeId: node.identity.nodeId, name: 'Test node', platform: 'linux', bots: [], skills: ['demo'] });
  // Hub SQLite 是 Bot 配置的权威存储：节点上报空清单不再清除 Hub 侧存量 Bot
  assert.equal((await f.json('/api/nodes'))[0].bots.length, 1, 'Hub-owned bots survive node re-registration');
});

test('isolates resources per user', { timeout: 60_000 }, async t => {
  const f = await fixture(t);

  // 1. Admin creates a member account
  const createUser = await f.request('/api/users', 'POST', { username: 'bob', password: 'bob-pass' });
  assert.equal(createUser.status, 200);
  const bob = await createUser.json();
  assert.equal(bob.username, 'bob');
  assert.equal(bob.role, 'member');

  // 2. bob logs in with his own cookie; /api/auth/me reflects bob, user management stays admin-only
  const bobCookie = await f.loginAs('bob', 'bob-pass');
  const bobApi = f.forUser(bobCookie);
  const me = await bobApi.json('/api/auth/me');
  assert.equal(me.authenticated, true);
  assert.equal(me.user.username, 'bob');
  assert.equal((await bobApi.request('/api/users')).status, 403, 'members cannot manage users');
  assert.equal((await bobApi.request('/api/users', 'POST', { username: 'eve', password: 'eve-pass' })).status, 403);

  // 3. bob pairs his own node; each user only sees nodes they own
  const bobNode = await f.addNode(['bob-bot'], ['demo-ext'], bobCookie);
  const bobNodes = await bobApi.json('/api/nodes');
  assert.deepEqual(bobNodes.map((node: any) => node.id), [bobNode.identity.nodeId]);
  assert.equal(bobNodes[0].bots[0].id, 'bob-bot');
  const adminNodes = await f.json('/api/nodes');
  assert.equal(adminNodes.some((node: any) => node.id === bobNode.identity.nodeId), false, 'admin must not see bob nodes');

  // 4. admin acting on bob's node is rejected before any RPC reaches it
  const bobNodeId = bobNode.identity.nodeId;
  assert.equal((await f.request(`/api/nodes/${bobNodeId}`, 'DELETE')).status, 403);
  assert.equal((await f.request(`/api/nodes/${bobNodeId}/restart`, 'POST')).status, 403);
  assert.equal((await f.request(`/api/nodes/${bobNodeId}/skills/demo`, 'GET')).status, 403);
  assert.equal((await f.request(`/api/models/catalog?nodeId=${bobNodeId}`)).status, 403);
  assert.equal((await f.request('/api/nodes/ghost/restart', 'POST')).status, 404, 'unknown nodes still 404');

  // 5. bob creates a session with his own bot; admin cannot read or stream it
  const bobSession = await bobApi.json<SessionRecord>('/api/sessions', 'POST', { title: 'Bob private session', mode: 'direct', leadBotId: 'bob-bot', memberBotIds: ['bob-bot'] });
  const adminSessions = await f.json<SessionRecord[]>('/api/sessions');
  assert.equal(adminSessions.some(s => s.id === bobSession.id), false, 'admin must not see bob sessions');
  assert.equal((await f.request(`/api/sessions/${bobSession.id}/messages`)).status, 403);
  assert.equal((await f.request(`/api/sessions/${bobSession.id}/events`)).status, 403);
  assert.equal((await f.request(`/api/sessions/${bobSession.id}/fork`, 'POST', { anchorMessageId: 'msg_missing' })).status, 403);
  assert.equal((await f.request('/api/sessions/sess_missing/messages')).status, 404, 'unknown sessions still 404');

  // 6. Users owning nodes cannot be deleted; admins cannot delete themselves
  assert.equal((await f.request(`/api/users/${bob.id}`, 'DELETE')).status, 409, 'user with nodes cannot be deleted');
  const adminMe = await f.json('/api/auth/me');
  assert.equal((await f.request(`/api/users/${adminMe.user.id}`, 'DELETE')).status, 400, 'cannot delete yourself');
  assert.equal((await f.request('/api/users/user_missing', 'DELETE')).status, 404);
});
test('node removal disconnects the agent and revokes its credentials', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const node = await f.addNode(['bot-a']);

  // A node still hosting bots must not be removable
  const blocked = await f.request(`/api/nodes/${node.identity.nodeId}`, 'DELETE');
  assert.equal(blocked.status, 409, 'node hosting bots cannot be removed');
  assert.equal((await f.json('/api/nodes')).length, 1, 'node is retained when removal is blocked');

  // After its bots are gone, removal succeeds and drops the live connection
  await f.json('/api/bots/bot-a', 'DELETE');
  const [closed] = await Promise.all([
    once(node.socket, 'close'),
    f.json(`/api/nodes/${node.identity.nodeId}`, 'DELETE'),
  ]);
  assert(closed, 'live node connection must be closed on removal');
  assert.equal((await f.json('/api/nodes')).length, 0, 'removed node disappears from the registry');

  // Old credentials no longer authenticate a reconnect
  const stale = new WebSocket(`${f.base.replace('http:', 'ws:')}/ws/node?nodeId=${node.identity.nodeId}&token=${node.identity.token}`);
  stale.on('error', () => {});
  const [, response] = (await once(stale, 'unexpected-response')) as [any, any];
  assert.equal(response.statusCode, 401, 'stale node token must be rejected after removal');
  stale.terminate();

  // Removing an unknown node is a 404, not an error
  assert.equal((await f.request('/api/nodes/ghost', 'DELETE')).status, 404);
});

test('force removal discards an offline node together with its cached bots', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const node = await f.addNode(['bot-x', 'bot-y']);

  // Simulate the machine vanishing: the socket drops and the node goes offline
  node.socket.terminate();
  await waitFor(() => f.json('/api/nodes'), list => list[0]?.status === 'offline');

  // Regular removal is still blocked (its bots cannot be deleted without the agent)
  const blocked = await f.request(`/api/nodes/${node.identity.nodeId}`, 'DELETE');
  assert.equal(blocked.status, 409, 'offline node hosting bots cannot be removed regularly');

  // Hub 权威存储：节点离线也能直接删除 Bot（历史死锁已解除）
  assert.deepEqual(await f.json('/api/bots/bot-x', 'DELETE'), { ok: true });

  // Force removal unlocks it: cache dropped, node gone, bot records purged
  await f.json(`/api/nodes/${node.identity.nodeId}?force=1`, 'DELETE');
  assert.equal((await f.json('/api/nodes')).length, 0, 'forced node disappears from the registry');
  assert.equal((await f.request('/api/bots/bot-y/system', 'GET')).status, 404, 'cached bots of the forced node are purged');

  // Old credentials no longer authenticate a reconnect
  const stale = new WebSocket(`${f.base.replace('http:', 'ws:')}/ws/node?nodeId=${node.identity.nodeId}&token=${node.identity.token}`);
  stale.on('error', () => {});
  const [, response] = (await once(stale, 'unexpected-response')) as [any, any];
  assert.equal(response.statusCode, 401, 'stale node token must be rejected after force removal');
  stale.terminate();
});

test('force removal of an online node best-effort deletes its local bots', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const node = await f.addNode(['bot-z']);

  const [closed] = await Promise.all([
    once(node.socket, 'close'),
    f.json(`/api/nodes/${node.identity.nodeId}?force=1`, 'DELETE'),
  ]);
  assert(closed, 'live node connection must be closed on force removal');
  assert.deepEqual(node.bots.map(bot => bot.id), [], 'online node is asked to delete its local bots');
  assert.equal((await f.json('/api/nodes')).length, 0);
});

test('SQLite schema migration adds extensions columns to legacy tables without losing rows', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-hub-migration-'));
  const dbPath = path.join(dir, 'legacy.sqlite');
  const setupDb = new DatabaseSync(dbPath);
  setupDb.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      skills_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'offline',
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      model_provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      thinking_level TEXT DEFAULT 'medium',
      enabled_skills_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );

    INSERT INTO nodes (id, name, platform, token_hash, skills_json, status, last_seen_at, created_at)
    VALUES ('legacy-node', 'Legacy Node', 'linux', 'token-hash-1', '["legacy-skill"]', 'offline', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');

    INSERT INTO bots (id, node_id, name, description, model_provider, model_id, thinking_level, enabled_skills_json, updated_at)
    VALUES ('legacy-bot', 'legacy-node', 'Legacy Bot', 'Legacy Bot Description', 'openai', 'test-model', 'medium', '["legacy-skill"]', '2025-01-01T00:00:00.000Z');
  `);
  setupDb.close();

  const hubDb = new HubDatabase({ dbPath });
  t.after(async () => {
    hubDb.close();
    await rm(dir, { recursive: true, force: true });
  });

  const nodeColumns = hubDb.db.prepare(`PRAGMA table_info(nodes)`).all() as Array<{ name: string }>;
  assert(nodeColumns.some(c => c.name === 'extensions_json'), 'nodes table must have extensions_json column');

  const botColumns = hubDb.db.prepare(`PRAGMA table_info(bots)`).all() as Array<{ name: string }>;
  assert(botColumns.some(c => c.name === 'enabled_extensions_json'), 'bots table must have enabled_extensions_json column');

  const migratedNode = hubDb.getNode('legacy-node');
  assert(migratedNode, 'Legacy node must be retained');
  assert.equal(migratedNode.id, 'legacy-node');
  assert.equal(migratedNode.name, 'Legacy Node');
  assert.deepEqual(migratedNode.skills, ['legacy-skill']);
  assert.deepEqual(migratedNode.extensions, []);

  const migratedBot = hubDb.getBot('legacy-bot');
  assert(migratedBot, 'Legacy bot must be retained');
  assert.equal(migratedBot.id, 'legacy-bot');
  assert.equal(migratedBot.name, 'Legacy Bot');
  assert.deepEqual(migratedBot.enabledSkills, ['legacy-skill']);
  assert.deepEqual(migratedBot.enabledExtensions, []);

  const allNodesWithBots = hubDb.getAllNodesWithBots('user_admin');
  assert.equal(allNodesWithBots.length, 1);
  assert.equal(allNodesWithBots[0].id, 'legacy-node');
  assert.deepEqual(allNodesWithBots[0].extensions, []);
  assert.equal(allNodesWithBots[0].bots.length, 1);
  assert.equal(allNodesWithBots[0].bots[0].id, 'legacy-bot');
  assert.deepEqual(allNodesWithBots[0].bots[0].enabledExtensions, []);
});

test('restarts a node daemon via HTTP', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const node = await f.addNode(['bot']);

  const restartResult = await f.json(`/api/nodes/${node.identity.nodeId}/restart`, 'POST');
  assert.deepEqual(restartResult, { ok: true, pid: 4242 });

  const notFound = await f.request('/api/nodes/non-existent-node/restart', 'POST');
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: 'Node not found' });

  node.socket.close();
  await once(node.socket, 'close');
  const offline = await f.request(`/api/nodes/${node.identity.nodeId}/restart`, 'POST');
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: 'Node is offline' });
});

test('GET /api/bots/:botId/commands: auth, not-found and Hub SQLite direct output', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const node = await f.addNode(['bot1']);

  // 1. Unauthenticated -> 401
  const unauth = await f.request('/api/bots/bot1/commands', 'GET', undefined, false);
  assert.equal(unauth.status, 401);

  // 2. Not found -> 404
  const notFound = await f.request('/api/bots/non-existent/commands', 'GET');
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: 'Bot not found' });

  // 3. Hub SQLite 直出：启用技能/扩展即时为命令，节点离线也可用
  await f.json('/api/bots/bot1', 'PUT', { enabledSkills: ['code-review', 'calc'], enabledExtensions: ['bash-guard'] });
  const commands = await f.json('/api/bots/bot1/commands', 'GET');
  assert.deepEqual(commands, [
    { name: 'code-review', description: '加载技能 code-review', source: 'skill' },
    { name: 'calc', description: '加载技能 calc', source: 'skill' },
    { name: 'bash-guard', description: '扩展 bash-guard', source: 'extension' },
  ]);

  // 4. 节点离线后命令列表不变（Hub 权威存储）
  node.socket.close();
  await once(node.socket, 'close');
  const offline = await f.request('/api/bots/bot1/commands', 'GET');
  assert.equal(offline.status, 200);
  assert.equal((await offline.json()).length, 3);
});

test('slash command and @ mention routing validation via /api/sessions/:id/messages', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['lead', 'coder', 'reviewer']);
  const session = await f.session(['lead', 'coder', 'reviewer']);
  const endpoint = `/api/sessions/${session.id}/messages`;

  // 1. 多个前导 @ 提及 + 斜杠命令 -> 400
  const multiAt = await f.request(endpoint, 'POST', { content: '@coder @reviewer /review' });
  assert.equal(multiAt.status, 400);

  // 2. 未知前导 @ 提及 -> 400
  const unknownAt = await f.request(endpoint, 'POST', { content: '@unknown_bot /review' });
  assert.equal(unknownAt.status, 400);

  // 3. 文件路径不是命令：/tmp/report.md 正常入库（202）
  const pathMsg = await f.request(endpoint, 'POST', { content: '/tmp/report.md please inspect' });
  assert.equal(pathMsg.status, 202);

  // 4. 空内容 -> 400
  assert.equal((await f.request(endpoint, 'POST', { content: '   ' })).status, 400);

  // 5. 定向命令 @coder：mentions 落库为 ['coder']
  const targeted = await f.json<{ mentions: string[] }>(endpoint, 'POST', { content: '@coder /review please ask @reviewer to check' });
  assert.deepEqual(targeted.mentions, ['coder']);

  // 6. 普通 @ 提及消息：mentions 提取不重复、顺序保留
  const mentioned = await f.json<{ mentions: string[] }>(endpoint, 'POST', { content: 'Please coordinate @reviewer and @coder twice @coder' });
  assert.deepEqual(mentioned.mentions, ['reviewer', 'coder']);
});

test('edit user message truncates follow-ups and validates edit rules', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['solo']);
  const session = await f.session(['solo'], 'direct');

  // 直插两条用户消息作为编辑锚点（编辑路由是纯 DB 操作，镜像器关闭后不触发改写回合）
  f.faux.setResponses([]);
  const first = await f.json<MessageRecord>(`/api/sessions/${session.id}/messages`, 'POST', { content: 'first question' });
  const second = await f.json<MessageRecord>(`/api/sessions/${session.id}/messages`, 'POST', { content: 'second question' });
  await f.idle(session.id);

  // Editing the first user message rewrites it and drops everything after it
  const edited = await f.json<MessageRecord>(`/api/sessions/${session.id}/messages/${first.id}`, 'PUT', { content: 'edited first question' });
  assert.equal(edited.content, 'edited first question');

  const truncated = await f.messages(session.id);
  const userKept = truncated.filter(m => m.role === 'user');
  assert.deepEqual(userKept.map(m => m.id), [first.id], 'only the edited anchor survives from the old history');
  assert.equal(userKept.find(m => m.id === first.id)!.content, 'edited first question');
  assert.equal(userKept.some(m => m.id === second.id), false, 'later messages are dropped');

  // A running session refuses edits
  const busySession = await f.session(['solo'], 'direct');
  const busyMsg = await f.json<MessageRecord>(`/api/sessions/${busySession.id}/messages`, 'POST', { content: 'long work' });
  await f.idle(busySession.id);
  f.hub.db.updateSessionStatus(busySession.id, 'running', 'solo');
  const busyEdit = await f.request(`/api/sessions/${busySession.id}/messages/${busyMsg.id}`, 'PUT', { content: 'nope' });
  assert.equal(busyEdit.status, 409);
  assert.deepEqual(await busyEdit.json(), { error: 'Stop the session before editing messages' });
  f.hub.db.updateSessionStatus(busySession.id, 'idle');

  // Only user messages can be edited; unknown ids and empty content are rejected
  assert.equal((await f.request(`/api/sessions/${session.id}/messages/msg_missing`, 'PUT', { content: 'nope' })).status, 404);
  assert.equal((await f.request(`/api/sessions/${session.id}/messages/${first.id}`, 'PUT', { content: '   ' })).status, 400);
});

test('session deletion, message clearing and enriched session list', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['solo']);
  f.faux.setResponses([]);

  // 1. Deleting an existing session removes it and cascades to its messages
  const session = await f.session(['solo'], 'direct');
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: 'hello there' });
  await f.idle(session.id);
  assert.deepEqual(await f.json(`/api/sessions/${session.id}`, 'DELETE'), { ok: true });
  const afterDelete = await f.json<SessionRecord[]>('/api/sessions');
  assert.equal(afterDelete.some(s => s.id === session.id), false, 'deleted session must disappear from the list');
  assert.equal((await f.request(`/api/sessions/${session.id}/messages`)).status, 404);
  assert.deepEqual(f.hub.db.getMessages(session.id), [], 'messages must be cascaded away with the session');
  assert.equal(f.hub.db.getSession(session.id), undefined);

  // 2. Deleting a missing session is a 404
  assert.equal((await f.request('/api/sessions/sess_missing', 'DELETE')).status, 404);
  assert.deepEqual(await (await f.request('/api/sessions/sess_missing', 'DELETE')).json(), { error: 'Session not found' });

  // 3. Enriched list fields, running guard, and message clearing
  //    用 DB 直改 status 模拟 running 守卫（不依赖旧 fake-node 慢回合）
  const busySession = await f.session(['solo'], 'direct');
  await f.json<MessageRecord>(`/api/sessions/${busySession.id}/messages`, 'POST', {
    content: '# Release notes `v1.2` see [changelog](https://example.com) *now*',
  });
  await f.idle(busySession.id);
  // 等镜像器把 faux 空队列的失败系统消息落库后，再模拟 running 守卫
  await waitFor(() => f.messages(busySession.id), list => list.some(m => m.role === 'system' && /模型执行异常/.test(m.content)));
  f.hub.db.updateSessionStatus(busySession.id, 'running', 'solo');

  const enriched = await f.json<SessionRecord[]>('/api/sessions');
  const busyItem = enriched.find(s => s.id === busySession.id)!;
  const expectedCount = (await f.messages(busySession.id)).length;
  assert.equal(busyItem.messageCount, expectedCount, 'messageCount 与消息列表一致（仅统计本会话）');
  assert.match(busyItem.lastMessagePreview ?? '', /模型执行异常/);

  // A running session refuses both deletion and message clearing
  assert.equal((await f.request(`/api/sessions/${busySession.id}`, 'DELETE')).status, 409);
  assert.deepEqual(await (await f.request(`/api/sessions/${busySession.id}`, 'DELETE')).json(), { error: 'Stop the session before deleting it' });
  assert.equal((await f.request(`/api/sessions/${busySession.id}/messages`, 'DELETE')).status, 409);
  assert.deepEqual(await (await f.request(`/api/sessions/${busySession.id}/messages`, 'DELETE')).json(), { error: 'Stop the session before clearing messages' });

  f.hub.db.updateSessionStatus(busySession.id, 'idle');

  // Clearing wipes messages and resets the incremental cursors
  f.hub.db.updateSessionCursor(busySession.id, 'solo', 123);
  assert.deepEqual(await f.json(`/api/sessions/${busySession.id}/messages`, 'DELETE'), { ok: true });
  assert.deepEqual(await f.messages(busySession.id), []);
  assert.deepEqual(f.hub.db.getSession(busySession.id)!.cursorMap, {}, 'clearing messages must reset cursor_map');
  const cleared = await f.json<SessionRecord[]>('/api/sessions');
  const clearedItem = cleared.find(s => s.id === busySession.id)!;
  assert.equal(clearedItem.messageCount, 0);
  assert.equal(clearedItem.lastMessagePreview, undefined);
  assert.equal(clearedItem.lastMessageAt, undefined);

  // The emptied session can still be deleted afterwards
  assert.deepEqual(await f.json(`/api/sessions/${busySession.id}`, 'DELETE'), { ok: true });
  assert.equal((await f.json<SessionRecord[]>('/api/sessions')).length, 0);
});

test('session archive flag toggles via PATCH, validates input and migrates legacy databases', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['solo']);
  const session = await f.session(['solo'], 'direct');

  // 1. Archive: PATCH response and session list both reflect archived === true
  const archived = await f.json<SessionRecord>(`/api/sessions/${session.id}`, 'PATCH', { archived: true });
  assert.equal(archived.archived, true);
  const listArchived = await f.json<SessionRecord[]>('/api/sessions');
  assert.equal(listArchived.find(s => s.id === session.id)!.archived, true);

  // 2. Restore: archived === false again
  const restored = await f.json<SessionRecord>(`/api/sessions/${session.id}`, 'PATCH', { archived: false });
  assert.equal(restored.archived, false);
  const listRestored = await f.json<SessionRecord[]>('/api/sessions');
  assert.equal(listRestored.find(s => s.id === session.id)!.archived, false);

  // A PATCH without the archived flag keeps the current value
  await f.json(`/api/sessions/${session.id}`, 'PATCH', { archived: true });
  const retitled = await f.json<SessionRecord>(`/api/sessions/${session.id}`, 'PATCH', { title: 'Renamed' });
  assert.equal(retitled.title, 'Renamed');
  assert.equal(retitled.archived, true, 'patching other fields must not reset the archived flag');

  // 3. Non-boolean archived value is rejected
  const bad = await f.request(`/api/sessions/${session.id}`, 'PATCH', { archived: 'yes' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'Invalid archived flag' });

  // 4. Legacy database without the archived column is migrated automatically
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-hub-archive-migration-'));
  const dbPath = path.join(dir, 'legacy.sqlite');
  const setupDb = new DatabaseSync(dbPath);
  setupDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'direct',
      lead_bot_id TEXT NOT NULL,
      member_bot_ids_json TEXT NOT NULL DEFAULT '[]',
      cursor_map_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'idle',
      active_bot_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO sessions (id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, created_at, updated_at)
    VALUES ('legacy-sess', 'Legacy Session', 'direct', 'legacy-bot', '[]', '{}', 'idle', NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
  `);
  setupDb.close();

  const hubDb = new HubDatabase({ dbPath });
  t.after(async () => {
    hubDb.close();
    await rm(dir, { recursive: true, force: true });
  });

  const columns = hubDb.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  assert(columns.some(c => c.name === 'archived'), 'sessions table must gain the archived column');

  const legacySession = hubDb.getSession('legacy-sess')!;
  assert.equal(legacySession.title, 'Legacy Session');
  assert.equal(legacySession.archived, false, 'migrated rows default to archived = 0');
  assert.equal(hubDb.getAllSessions('user_admin')[0].archived, false);

  const migratedUpdate = hubDb.updateSession('legacy-sess', { archived: true })!;
  assert.equal(migratedUpdate.archived, true);
  assert.equal(hubDb.getSession('legacy-sess')!.archived, true);
});

test('session fork clones config and history up to the anchor without touching the source', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['solo']);
  const session = await f.session(['solo'], 'direct');

  // 1. Two settled user turns leave at least 4 messages (user + assistant each)
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: 'first question' });
  await f.idle(session.id);
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: 'second question' });
  const history = await waitFor(() => f.messages(session.id), list => list.filter(m => m.role === 'assistant').length === 2);
  await f.idle(session.id);
  assert(history.length >= 4);

  // 2. Fork anchored at the first user message clones the config and only that prefix
  const anchor = history[0];
  assert.equal(anchor.role, 'user');
  const fork1 = await f.json<SessionRecord>(`/api/sessions/${session.id}/fork`, 'POST', { anchorMessageId: anchor.id });
  assert(fork1.title.endsWith('（分叉）'));
  assert.notEqual(fork1.id, session.id);
  assert.equal(fork1.leadBotId, session.leadBotId);
  assert.equal(fork1.messageCount, 1);

  // 3. The forked session holds exactly the anchor message (same content/createdAt, new id)
  const fork1Messages = await f.messages(fork1.id);
  assert.equal(fork1Messages.length, 1);
  assert.equal(fork1Messages[0].content, anchor.content);
  assert.equal(fork1Messages[0].createdAt, anchor.createdAt);
  assert.notEqual(fork1Messages[0].id, anchor.id);

  // 4. The source session is untouched: same messages, title and status
  const afterFork = await f.messages(session.id);
  assert.equal(afterFork.length, history.length);
  assert.deepEqual(afterFork.map(m => m.id), history.map(m => m.id));
  const sourceItem = (await f.json<SessionRecord[]>('/api/sessions')).find(s => s.id === session.id)!;
  assert.equal(sourceItem.title, 'Test session');
  assert.equal(sourceItem.status, 'idle');
  assert.equal(sourceItem.messageCount, history.length);

  // 5. Forking at the last message copies the full history with enriched fields
  const fork2 = await f.json<SessionRecord>(`/api/sessions/${session.id}/fork`, 'POST', { anchorMessageId: history[history.length - 1].id });
  assert.equal(fork2.messageCount, history.length);
  assert(typeof fork2.lastMessagePreview === 'string' && fork2.lastMessagePreview.length > 0);
  assert(typeof fork2.lastMessageAt === 'string' && fork2.lastMessageAt.length > 0);
  assert.deepEqual((await f.messages(fork2.id)).map(m => m.content), history.map(m => m.content));

  // 6. Error cases: unknown session, foreign anchor message and missing body
  const missingSession = await f.request(`/api/sessions/sess_missing/fork`, 'POST', { anchorMessageId: anchor.id });
  assert.equal(missingSession.status, 404);
  assert.deepEqual(await missingSession.json(), { error: 'Session not found' });

  const second = await f.session(['solo'], 'direct');
  const foreign = await f.json<MessageRecord>(`/api/sessions/${second.id}/messages`, 'POST', { content: 'other session message' });
  const foreignAnchor = await f.request(`/api/sessions/${session.id}/fork`, 'POST', { anchorMessageId: foreign.id });
  assert.equal(foreignAnchor.status, 404);
  assert.deepEqual(await foreignAnchor.json(), { error: 'Session or anchor message not found' });

  const noBody = await f.request(`/api/sessions/${session.id}/fork`, 'POST');
  assert.equal(noBody.status, 400);
  assert.deepEqual(await noBody.json(), { error: 'Invalid anchorMessageId' });
});

test('archiving is allowed while a session is running, but config patches are still refused', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['busy']);
  const session = await f.session(['busy'], 'direct');

  // DB 直改 status 模拟 running（不依赖旧 fake-node 慢回合）
  f.hub.db.updateSessionStatus(session.id, 'running', 'busy');

  // archived 是纯 UI 分类标记，running 中允许归档（支撑「开启新话题」时旧会话仍在后台执行）
  const archivedWhileRunning = await f.json<SessionRecord>(`/api/sessions/${session.id}`, 'PATCH', { archived: true });
  assert.equal(archivedWhileRunning.archived, true);
  assert.equal(archivedWhileRunning.status, 'running', 'archiving must not disturb the running status');

  // 混入配置字段（标题/负责人）时，running 仍拒绝
  assert.equal((await f.request(`/api/sessions/${session.id}`, 'PATCH', { archived: false, title: 'nope' })).status, 409);
  assert.equal((await f.request(`/api/sessions/${session.id}`, 'PATCH', { leadBotId: 'busy' })).status, 409);

  f.hub.db.updateSessionStatus(session.id, 'idle');
  const settled = await f.json<SessionRecord[]>('/api/sessions');
  const settledItem = settled.find(s => s.id === session.id)!;
  assert.equal(settledItem.status, 'idle');
  assert.equal(settledItem.archived, true, 'archived flag must survive the running window');
});

test('message pagination: no params stays full, before/around windows and hasMore', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['solo']);
  const session = await f.session(['solo'], 'direct');

  // 直插 db 造出 20 条消息，拿到 rowid 升序的 id 列表
  for (let i = 1; i <= 20; i++) {
    f.hub.db.createMessage({
      id: `msg_paging_${String(i).padStart(2, '0')}`,
      sessionId: session.id,
      role: 'user',
      content: `paging message ${i}`,
    });
  }
  const full = await f.messages(session.id);
  assert.equal(full.length, 20, 'no query params keeps the full history');
  assert.deepEqual(full.map(m => m.content).at(-1), 'paging message 20', 'full list stays ascending');

  // before：取 rowid 严格小于锚点的最新 5 条，升序，hasMore=true
  const beforePage = await f.json<{ messages: MessageRecord[]; hasMore: boolean }>(
    `/api/sessions/${session.id}/messages?before=${full[19].id}&limit=5`
  );
  assert.deepEqual(beforePage.messages.map(m => m.content), [
    'paging message 15', 'paging message 16', 'paging message 17', 'paging message 18', 'paging message 19',
  ]);
  assert.equal(beforePage.hasMore, true);

  // 再往前翻一页：到头部后 hasMore=false
  const firstPage = await f.json<{ messages: MessageRecord[]; hasMore: boolean }>(
    `/api/sessions/${session.id}/messages?before=${beforePage.messages[0].id}&limit=5`
  );
  assert.deepEqual(firstPage.messages.map(m => m.content), [
    'paging message 10', 'paging message 11', 'paging message 12', 'paging message 13', 'paging message 14',
  ]);
  const topPage = await f.json<{ messages: MessageRecord[]; hasMore: boolean }>(
    `/api/sessions/${session.id}/messages?before=${full[0].id}&limit=5`
  );
  assert.deepEqual(topPage.messages, []);
  assert.equal(topPage.hasMore, false);

  // around：窗口 [rowid-15, rowid+45]，锚点是第 18 条 → 从第 3 条到末尾
  const aroundPage = await f.json<{ messages: MessageRecord[]; hasMore: boolean }>(
    `/api/sessions/${session.id}/messages?around=${full[17].id}`
  );
  assert.equal(aroundPage.messages.length, 18);
  assert.equal(aroundPage.messages[0].content, 'paging message 3');
  assert.equal(aroundPage.messages.at(-1)!.content, 'paging message 20');
  assert.equal(aroundPage.hasMore, true, 'messages below rowid-15 leave hasMore=true');

  // 锚点靠前时窗口覆盖全部消息，hasMore=false
  const earlyPage = await f.json<{ messages: MessageRecord[]; hasMore: boolean }>(
    `/api/sessions/${session.id}/messages?around=${full[0].id}`
  );
  assert.equal(earlyPage.messages.length, 20);
  assert.equal(earlyPage.hasMore, false);

  // 锚点不存在 / 属于其他会话 / limit 非法
  assert.equal((await f.request(`/api/sessions/${session.id}/messages?before=msg_missing`)).status, 404);
  const other = await f.session(['solo'], 'direct');
  const foreign = await f.json<MessageRecord>(`/api/sessions/${other.id}/messages`, 'POST', { content: 'other' });
  assert.equal((await f.request(`/api/sessions/${session.id}/messages?around=${foreign.id}`)).status, 404);
  assert.equal((await f.request(`/api/sessions/${session.id}/messages?limit=abc`)).status, 400);

  // 仅 limit：返回最新 N 条
  const tailPage = await f.json<{ messages: MessageRecord[]; hasMore: boolean }>(
    `/api/sessions/${session.id}/messages?limit=3`
  );
  assert.deepEqual(tailPage.messages.map(m => m.content), ['paging message 18', 'paging message 19', 'paging message 20']);
  assert.equal(tailPage.hasMore, true);
});

test('POST /api/triggers/:triggerId/run fires a wakeup turn into the session', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['solo']);
  f.faux.setResponses([]);
  const session = await f.session(['solo'], 'direct');

  const trigger = await f.json<TriggerRecord>(`/api/sessions/${session.id}/triggers`, 'POST', {
    name: 'manual check',
    botId: 'solo',
    kind: 'webhook',
    prompt: 'run the daily check',
  });
  assert.equal(trigger.kind, 'webhook');

  // 手动执行：立即 200，Durable 主线提交成功（会话进入 running 后回落 idle）
  const run = await f.json<{ ok: boolean }>(`/api/triggers/${trigger.id}/run`, 'POST');
  assert.deepEqual(run, { ok: true });
  await f.idle(session.id);

  // 归属与存在性校验
  assert.equal((await f.request('/api/triggers/trg_missing/run', 'POST')).status, 404);
});

test('GET /api/events streams hello and forwards this user session events', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.addNode(['solo']);
  const session = await f.session(['solo'], 'direct');

  // 未登录拒绝
  assert.equal((await f.request('/api/events', 'GET', undefined, false)).status, 401);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${f.base}/api/events`, { headers: { cookie: f.cookie() }, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  const reader = stream.body!.getReader();
  const chunks: string[] = [];
  const consuming = (async () => {
    try { while (true) { const next = await reader.read(); if (next.done) return; chunks.push(new TextDecoder().decode(next.value)); } } catch { /* client closed */ }
  })();

  // 先收到 hello，再收到该用户会话的 message_created
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: 'ping the global stream' });
  await f.idle(session.id);
  await waitFor(() => chunks.join(''), text => text.includes('hello') && text.includes('message_created') && text.includes('ping the global stream'));
  controller.abort();
  await consuming;
});

test('global SSE delivers node online/offline events only to the node owner', { timeout: 60_000 }, async t => {
  const f = await fixture(t);

  // bob 与他的专属订阅流
  const createUser = await f.request('/api/users', 'POST', { username: 'carol', password: 'carol-pass' });
  assert.equal(createUser.status, 200);
  const carolCookie = await f.loginAs('carol', 'carol-pass');
  const carol = f.forUser(carolCookie);
  const carolNode = await f.addNode(['carol-bot'], ['demo-ext'], carolCookie);

  const adminController = new AbortController();
  const carolController = new AbortController();
  t.after(() => { adminController.abort(); carolController.abort(); });
  const adminStream = await fetch(`${f.base}/api/events`, { headers: { cookie: f.cookie() }, signal: adminController.signal });
  const carolStream = await fetch(`${f.base}/api/events`, { headers: { cookie: carolCookie }, signal: carolController.signal });
  const readAll = async (stream: Response, bucket: string[]) => {
    const reader = stream.body!.getReader();
    try { while (true) { const next = await reader.read(); if (next.done) return; bucket.push(new TextDecoder().decode(next.value)); } } catch { /* client closed */ }
  };
  const adminChunks: string[] = [];
  const carolChunks: string[] = [];
  const adminRead = readAll(adminStream, adminChunks);
  const carolRead = readAll(carolStream, carolChunks);

  // bob 的节点断开下线：carol 收到 offline，admin 什么也收不到
  carolNode.socket.close();
  await once(carolNode.socket, 'close');
  await waitFor(() => carolChunks.join(''), text => text.includes('node_status') && text.includes('offline'));
  await new Promise(resolve => setTimeout(resolve, 200));
  const adminText = adminChunks.join('');
  assert.equal(adminText.includes('node_status'), false, 'admin must not receive carol node events');
  assert(carolChunks.join('').includes(`"nodeId":"${carolNode.identity.nodeId}"`));

  adminController.abort();
  carolController.abort();
  await Promise.allSettled([adminRead, carolRead]);
});

test('Hub full ownership: Bot CRUD, SYSTEM/MEMORY, env, skills, extensions and provider api_key with NO node connected', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  // 全程不连接任何 Node：Hub SQLite 是唯一事实源

  // 1. Bot CRUD on a virtual "local" node
  const botBody = {
    id: 'hub-owned-bot',
    nodeId: 'local',
    name: 'Hub Owned',
    description: 'Created without any node',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium' as const,
    enabledSkills: [],
    systemMd: 'You are hub owned.',
  };
  const created = await f.json<BotConfig>('/api/bots', 'POST', botBody);
  assert.equal(created.id, 'hub-owned-bot');
  assert.equal(created.nodeId, 'local');
  assert.ok((await f.json('/api/nodes')).some((n: any) => n.id === 'local'));

  // system markdown persisted in Hub
  assert.deepEqual(await f.json('/api/bots/hub-owned-bot/system'), { content: 'You are hub owned.' });
  await f.json('/api/bots/hub-owned-bot/memory', 'PUT', { content: 'Remember hub ownership.' });
  assert.deepEqual(await f.json('/api/bots/hub-owned-bot/memory'), { content: 'Remember hub ownership.' });
  // node-dimension alias route reads the same Hub storage
  assert.deepEqual(await f.json('/api/nodes/local/bots/hub-owned-bot/files/memory'), { content: 'Remember hub ownership.' });

  // env CRUD entirely on Hub
  await f.json('/api/bots/hub-owned-bot/env', 'PUT', { env: { GITHUB_TOKEN: 'gh-token', DB_URL: 'sqlite://x' } });
  const env = await f.json<{ keys: string[]; env: Record<string, string> }>('/api/bots/hub-owned-bot/env');
  assert.deepEqual(env.keys.sort(), ['DB_URL', 'GITHUB_TOKEN']);
  await f.json('/api/bots/hub-owned-bot/env/GITHUB_TOKEN', 'DELETE');
  assert.deepEqual((await f.json<{ env: Record<string, string> }>('/api/bots/hub-owned-bot/env')).env, { DB_URL: 'sqlite://x' });

  // 2. Skills & extensions on global Hub routes
  await f.json('/api/skills/review-skill', 'PUT', { content: '# Review skill' });
  assert.deepEqual(await f.json('/api/skills/review-skill'), { content: '# Review skill', files: ['SKILL.md'] });
  await f.json('/api/extensions/lint-ext', 'PUT', { content: 'export default 1' });
  assert.deepEqual(await f.json('/api/extensions/lint-ext'), { content: 'export default 1', files: ['index.ts'] });

  // 3. Provider api_key login with zero nodes
  const login = await f.json('/api/providers/openai/login', 'POST', { method: 'api_key' });
  assert.equal(login.status, 'pending');
  assert.equal(login.prompt.id, 'api_key');
  const done = await f.json(`/api/provider-logins/${login.id}/respond`, 'POST', { promptId: 'api_key', value: 'sk-hub-only' });
  assert.equal(done.status, 'success');
  const catalog = await f.json('/api/models/catalog');
  const openai = catalog.providers.find((p: any) => p.id === 'openai');
  assert.equal(openai.configured, true);
  assert.equal(openai.credentialType, 'api_key');

  // 4. Update + delete the bot with no node ever connected
  const updated = await f.json<BotConfig>('/api/bots/hub-owned-bot', 'PUT', { thinkingLevel: 'high', systemMd: 'Updated prompt.' });
  assert.equal(updated.thinkingLevel, 'high');
  assert.deepEqual(await f.json('/api/bots/hub-owned-bot/system'), { content: 'Updated prompt.' });
  // PUT without systemMd keeps the stored markdown
  await f.json('/api/bots/hub-owned-bot', 'PUT', { name: 'Renamed' });
  assert.deepEqual(await f.json('/api/bots/hub-owned-bot/system'), { content: 'Updated prompt.' });
  assert.deepEqual(await f.json('/api/bots/hub-owned-bot', 'DELETE'), { ok: true });
  assert.equal((await f.request('/api/bots/hub-owned-bot/system')).status, 404);
  // bot files are cascade-deleted
  assert.equal(f.hub.db.getBotFile('hub-owned-bot', 'system'), '');
});
