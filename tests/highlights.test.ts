import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { startHub } from '../apps/hub/src/index.js';
import { BUILTIN_SKILL_MD, BUILTIN_SKILL_VERSION } from '../apps/node/src/builtin-skill.js';
import { BgJobManager } from '../apps/node/src/bg-jobs.js';
import { HubClient } from '../apps/node/src/cli/hub-client.js';
import { isValidBotEnvKey, readBotEnv, saveBot as saveLocalBot, writeBotEnv, writeNodeIdentity } from '../apps/node/src/storage.js';
import { cronMatches, describeCronExpr, isValidCronExpr, parseDelayDuration, serializeRpcMessage } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import type { MessageSearchHit, ProviderLoginState } from '../packages/protocol/src/index.js';
import type { ArtifactRecord, BotConfig, HubRpcFunctions, MessageAttachment, MessageRecord, NodeRpcFunctions, SessionRecord } from '../packages/protocol/src/index.js';

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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

/**
 * Starts an isolated Hub (own SQLite DB, own artifacts dir) plus a logged-in
 * admin client, and exposes helpers to attach mock nodes over real WebSockets.
 */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-highlights-'));
  const previousDataDir = process.env.BOTD_HUB_DATA_DIR;
  process.env.BOTD_HUB_DATA_DIR = path.join(dir, 'hub-data');
  const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'hub.sqlite'), adminPassword: PASSWORD });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    hub.server.closeAllConnections();
    await hub.close();
    if (previousDataDir === undefined) delete process.env.BOTD_HUB_DATA_DIR;
    else process.env.BOTD_HUB_DATA_DIR = previousDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  let cookie = '';
  const request = async (route: string, method = 'GET', body?: unknown, authenticated = true) => {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated && cookie ? { cookie } : {}) },
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

  const addNode = async (ids: string[], runTurn?: NodeRpcFunctions['runTurn']) => {
    const pairing = await json('/api/nodes/pairing', 'POST');
    assert.match(pairing.code, /^\d{6}$/);
    const identity = await json('/api/nodes/pairing/exchange', 'POST', { code: pairing.code, name: 'Test node', platform: 'linux' });
    const bots: BotConfig[] = ids.map(id => ({ id, nodeId: identity.nodeId, name: id, description: '', modelProvider: 'openai', modelId: 'test-model', thinkingLevel: 'medium', enabledSkills: [], updatedAt: new Date().toISOString() }));
    const files = new Map<string, string>();
    const logins = new Map<string, ProviderLoginState>();
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`);
    sockets.push(socket);
    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>({
      getModelCatalog: async () => getBuiltinModelCatalog(),
      startProviderLogin: async input => {
        const id = `login_${logins.size}`;
        const state: ProviderLoginState = { id, providerId: input.providerId, method: input.method, status: 'pending', events: [] };
        logins.set(id, state);
        return state;
      },
      getProviderLogin: async id => logins.get(id)!,
      respondProviderLogin: async input => logins.get(input.loginId)!,
      cancelProviderLogin: async id => { logins.get(id)!.status = 'cancelled'; },
      logoutProvider: async () => {},
      saveBot: async bot => { const i = bots.findIndex(existing => existing.id === bot.id); if (i < 0) bots.push(bot); else bots[i] = bot; },
      deleteBot: async id => { const index = bots.findIndex(bot => bot.id === id); if (index >= 0) bots.splice(index, 1); },
      readFile: async target => files.get(`${target.kind}:${target.botId ?? target.id}`) ?? '',
      writeFile: async (target, content) => { files.set(`${target.kind}:${target.botId ?? target.id}`, content); },
      installResource: async input => ({ kind: 'skill', id: input.customId || 'installed-res' }),
      deleteResource: async target => { files.delete(`${target.kind}:${target.id}`); },
      restartDaemon: async () => ({ ok: true as const, pid: 4242 }),
      getCommands: async () => [],
      runTurn: runTurn ?? (async input => ({ replyText: `Reply from ${input.botId}`, modelBadge: 'openai/test-model' })),
      cancelTurn: async () => {},
      resetSession: async () => {},
    }, {
      post: data => socket.send(data),
      on: callback => socket.on('message', data => callback(data.toString())),
      serialize: serializeRpcMessage,
      deserialize: JSON.parse,
      timeout: 10_000,
    });
    await once(socket, 'open');
    await rpc.registerNode({ nodeId: identity.nodeId, name: 'Test node', platform: 'linux', bots, skills: ['demo'], extensions: ['demo-ext'] });
    return { identity, bots, socket, rpc, files };
  };

  const session = (ids: string[], mode = 'direct', extra: Record<string, unknown> = {}) =>
    json<SessionRecord>('/api/sessions', 'POST', { title: 'Test session', mode, leadBotId: ids[0], memberBotIds: ids, ...extra });
  const messages = (id: string) => json<MessageRecord[]>(`/api/sessions/${id}/messages`);
  const asks = (id: string) => json<any[]>(`/api/sessions/${id}/asks`);
  const idle = async (id: string) => waitFor(() => json<SessionRecord[]>('/api/sessions'), list => list.find(s => s.id === id)?.status !== 'running');

  return { hub, base, request, json, addNode, session, messages, asks, idle, cookie: () => cookie };
}

// --- 1. Tool execution trace & token usage persistence ---

test('runTurn toolCalls and usage persist on the assistant MessageRecord', async t => {
  const f = await fixture(t);
  const calls: Parameters<NodeRpcFunctions['runTurn']>[0][] = [];
  await f.addNode(['worker'], async input => {
    calls.push(input);
    return {
      replyText: 'Listed 3 files',
      modelBadge: 'openai/test-model',
      toolCalls: [{ name: 'bash', summary: 'ls -la', status: 'done', durationMs: 42 }],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, contextWindow: 200000 },
    };
  });
  const session = await f.session(['worker'], 'direct');
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: 'run ls -la' });
  const history = await waitFor(() => f.messages(session.id), list => list.some(m => m.role === 'assistant'));
  await f.idle(session.id);

  assert.equal(calls.length, 1);
  const assistant = history.find(m => m.role === 'assistant')!;
  assert.equal(assistant.senderBotId, 'worker');
  assert.equal(assistant.content, 'Listed 3 files');
  assert.deepEqual(assistant.toolCalls, [{ name: 'bash', summary: 'ls -la', status: 'done', durationMs: 42 }]);
  assert.deepEqual(assistant.usage, { inputTokens: 100, outputTokens: 50, totalTokens: 150, contextWindow: 200000 });

  const user = history.find(m => m.role === 'user')!;
  assert.equal(user.toolCalls, undefined, 'user messages carry no tool trace');
  assert.equal(user.usage, undefined, 'user messages carry no usage');
});

// --- 2. Cross-node artifact pipe + message attachments forwarding ---

test('artifacts upload/download/list over HTTP and node RPC, attachments forwarded to runTurn', async t => {
  const f = await fixture(t);
  const turns: Parameters<NodeRpcFunctions['runTurn']>[0][] = [];
  const node = await f.addNode(['writer'], async input => {
    turns.push(input);
    return { replyText: 'ok', modelBadge: 'test/model' };
  });
  const session = await f.session(['writer'], 'direct');

  // 1. User message attachments are forwarded verbatim to the node's runTurn
  const httpBody = 'http artifact body';
  const attachment: MessageAttachment = {
    id: 'att_input_1', filename: 'input.txt', mimeType: 'text/plain', sizeBytes: httpBody.length, url: '/api/artifacts/att_input_1/content',
  };
  const posted = await f.json<MessageRecord>(`/api/sessions/${session.id}/messages`, 'POST', {
    content: 'analyze the attached input', attachments: [attachment],
  });
  assert.deepEqual(posted.attachments, [attachment]);
  await waitFor(() => turns.length, count => count === 1);
  assert.deepEqual(turns[0].attachments, [attachment]);
  await f.idle(session.id);

  // 2. Upload via the HTTP API
  const uploaded = await f.json<ArtifactRecord & { url: string }>(`/api/sessions/${session.id}/artifacts`, 'POST', {
    filename: 'report.txt', mimeType: 'text/plain', contentBase64: Buffer.from(httpBody).toString('base64'),
  });
  assert.match(uploaded.id, /^art_/);
  assert.equal(uploaded.sessionId, session.id);
  assert.equal(uploaded.filename, 'report.txt');
  assert.equal(uploaded.mimeType, 'text/plain');
  assert.equal(uploaded.sizeBytes, httpBody.length);
  assert.equal(uploaded.url, `/api/artifacts/${uploaded.id}/content`);
  assert.equal((await f.request(`/api/sessions/${session.id}/artifacts`, 'POST', { filename: 'x' })).status, 400, 'missing contentBase64 rejected');

  // 3. Upload via node RPC; an optional message becomes an assistant record with attachments
  const rpcBody = 'rpc artifact body';
  const rpcArtifact = await node.rpc.uploadArtifact({
    sessionId: session.id,
    botId: 'writer',
    filename: 'notes.md',
    mimeType: 'text/markdown',
    contentBase64: Buffer.from(rpcBody).toString('base64'),
    message: 'Produced notes.md',
  });
  assert.equal(rpcArtifact.filename, 'notes.md');
  assert.equal(rpcArtifact.sizeBytes, rpcBody.length);
  assert.equal(rpcArtifact.senderBotId, 'writer');

  const producer = await waitFor(
    () => f.messages(session.id),
    list => list.some(m => m.role === 'assistant' && (m.attachments?.length ?? 0) > 0),
  ).then(list => list.find(m => m.role === 'assistant' && (m.attachments?.length ?? 0) > 0)!);
  assert.equal(producer.senderBotId, 'writer');
  assert.equal(producer.content, 'Produced notes.md');
  assert.deepEqual(producer.attachments, [{
    id: rpcArtifact.id, filename: 'notes.md', mimeType: 'text/markdown',
    sizeBytes: rpcBody.length, url: `/api/artifacts/${rpcArtifact.id}/content`,
  }]);

  // 4. List via HTTP and RPC both see the two artifacts
  const httpList = await f.json<ArtifactRecord[]>(`/api/sessions/${session.id}/artifacts`);
  assert.deepEqual(httpList.map(a => a.filename).sort(), ['notes.md', 'report.txt']);
  const rpcList = await node.rpc.listSessionArtifacts(session.id);
  assert.deepEqual(rpcList.map(a => a.id).sort(), [rpcArtifact.id, uploaded.id].sort());

  // 5. Download content via HTTP and RPC (cross-compatible storage)
  const contentResponse = await f.request(`/api/artifacts/${uploaded.id}/content`);
  assert.equal(contentResponse.status, 200);
  assert.match(contentResponse.headers.get('content-type')!, /text\/plain/);
  assert.equal(await contentResponse.text(), httpBody);

  const downloaded = await node.rpc.downloadArtifact(uploaded.id);
  assert.equal(downloaded.artifact.id, uploaded.id);
  assert.equal(Buffer.from(downloaded.contentBase64, 'base64').toString('utf8'), httpBody);

  const cross = await f.request(`/api/artifacts/${rpcArtifact.id}/content`);
  assert.equal(await cross.text(), rpcBody, 'HTTP can download an RPC-uploaded artifact');

  assert.equal((await f.request('/api/artifacts/art_missing/content')).status, 404);
});

// --- 3. botd ask: interactive human-in-the-loop card ---

test('requestHumanInput surfaces a pending ask, resolves on respond and expires on timeout', async t => {
  const f = await fixture(t);
  let expectTimeout = false;
  const nodeHolder: { rpc?: HubRpcFunctions } = {};
  const node = await f.addNode(['deployer'], async input => {
    const rpc = nodeHolder.rpc!;
    if (!expectTimeout) {
      const answer = await rpc.requestHumanInput({
        sessionId: input.sessionId, botId: input.botId,
        prompt: 'Confirm deploy?', options: ['Approve', 'Cancel'], timeoutSeconds: 30,
      });
      return { replyText: `Deploy ${answer.answer}`, modelBadge: 'test/model' };
    }
    await rpc.requestHumanInput({
      sessionId: input.sessionId, botId: input.botId,
      prompt: 'Still there?', options: [], timeoutSeconds: 1,
    });
    return { replyText: 'unreachable', modelBadge: 'test/model' };
  });
  nodeHolder.rpc = node.rpc;
  const session = await f.session(['deployer'], 'direct');

  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: 'ship it to prod' });

  // The pending ask is listed for the session owner
  const pending = await waitFor(() => f.asks(session.id), list => list.length === 1);
  assert.match(pending[0].id, /^ask_/);
  assert.equal(pending[0].sessionId, session.id);
  assert.equal(pending[0].botId, 'deployer');
  assert.equal(pending[0].prompt, 'Confirm deploy?');
  assert.deepEqual(pending[0].options, ['Approve', 'Cancel']);
  assert.equal(pending[0].status, 'pending');
  assert.equal(typeof pending[0].expiresAt, 'string');

  // Validation: missing answer -> 400, unknown ask -> 404
  assert.equal((await f.request(`/api/sessions/${session.id}/asks/${pending[0].id}/respond`, 'POST', {})).status, 400);
  assert.equal((await f.request(`/api/sessions/${session.id}/asks/ask_missing/respond`, 'POST', { answer: 'no' })).status, 404);

  // Responding resolves the ask and unblocks the awaiting turn
  const responded = await f.json(`/api/sessions/${session.id}/asks/${pending[0].id}/respond`, 'POST', { answer: 'Approve' });
  assert.equal(responded.ok, true);
  assert.equal(responded.ask.status, 'answered');
  assert.equal(responded.ask.answer, 'Approve');

  const history = await waitFor(() => f.messages(session.id), list => list.some(m => m.role === 'assistant' && m.content === 'Deploy Approve'));
  await f.idle(session.id);
  assert.equal(history.filter(m => m.role === 'assistant').length, 1);
  assert.deepEqual(await f.asks(session.id), [], 'answered asks leave the pending list');
  assert.equal((await f.request(`/api/sessions/${session.id}/asks/${pending[0].id}/respond`, 'POST', { answer: 'Cancel' })).status, 404, 'double respond rejected');

  // Timeout path: the ask expires and the failed turn surfaces as a system message
  expectTimeout = true;
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: 'restart the service' });
  await waitFor(() => f.messages(session.id), list => list.some(m => m.role === 'system' && /timed out/i.test(m.content)));
  assert.deepEqual(await f.asks(session.id), [], 'expired asks leave the pending list');
  assert.equal((await f.request(`/api/sessions/${session.id}/asks`, 'GET')).status, 200);
});

// --- 4. Mention relay workflow ---

test('user @mentions route to lead with dispatch prompt and no cascading relay', async t => {
  const f = await fixture(t);
  const events: string[] = [];
  const turns = new Map<string, Parameters<NodeRpcFunctions['runTurn']>[0]>();
  await f.addNode(['lead', 'reviewer-a'], async input => {
    turns.set(input.botId, input);
    events.push(input.botId);
    return { replyText: 'Lead coordinating @reviewer-a', modelBadge: 'test/model' };
  });

  const session = await f.session(['lead', 'reviewer-a']);
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', { content: '@reviewer-a Audit the release' });
  const history = await waitFor(() => f.messages(session.id), list => list.filter(m => m.role === 'assistant').length === 1);
  await f.idle(session.id);

  // 统一路由给 lead，不会让 reviewer-a 跑顶层回合，也不会级联接力
  assert.deepEqual(events, ['lead']);

  const lead = turns.get('lead')!;
  assert.match(lead.incrementalMessages, /Audit the release/);
  assert.match(lead.groupContextPrompt, /本轮用户 @ 提及分派指令/);
  assert.match(lead.groupContextPrompt, /@reviewer-a/);

  // History: 只有 lead 的回复
  const assistants = history.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].senderBotId, 'lead');
});

// --- 5. Triggers: incoming webhook + scheduled trigger CRUD ---

test('cron expression helpers validate, match and describe 5-field expressions', () => {
  // Validation: common valid forms
  for (const valid of ['*/5 * * * *', '30 9 * * *', '0 9 * * 1-5', '15,45 8-18 * * 2']) {
    assert.equal(isValidCronExpr(valid), true, `${valid} should be valid`);
  }
  // Validation: out-of-range values, wrong field count, garbage, zero step
  for (const invalid of ['61 * * * *', '* * *', 'bogus', '*/0 * * * *']) {
    assert.equal(isValidCronExpr(invalid), false, `${invalid} should be invalid`);
  }

  // Matching: step, fixed time and weekday range
  assert.equal(cronMatches('*/5 * * * *', new Date(2024, 0, 1, 10, 0)), true);
  assert.equal(cronMatches('*/5 * * * *', new Date(2024, 0, 1, 10, 3)), false);
  assert.equal(cronMatches('30 9 * * *', new Date(2024, 0, 1, 9, 30)), true);
  assert.equal(cronMatches('30 9 * * *', new Date(2024, 0, 1, 10, 30)), false);
  assert.equal(cronMatches('0 9 * * 1-5', new Date(2024, 0, 1, 9, 0)), true, '2024-01-01 is a Monday');
  assert.equal(cronMatches('0 9 * * 1-5', new Date(2024, 0, 6, 9, 0)), false, '2024-01-06 is a Saturday');
  assert.equal(cronMatches('15,45 8-18 * * 2', new Date(2024, 0, 2, 8, 15)), true, '2024-01-02 is a Tuesday');
  assert.equal(cronMatches('15,45 8-18 * * 2', new Date(2024, 0, 2, 8, 20)), false);
  assert.equal(cronMatches('bogus', new Date()), false, 'invalid expressions never match');

  // Human-readable descriptions for common patterns
  assert.equal(describeCronExpr('*/30 * * * *'), '每 30 分钟');
  assert.equal(describeCronExpr('30 9 * * *'), '每天 09:30');
  assert.equal(describeCronExpr('0 9 * * 1-5'), '每个工作日 09:00');
  assert.equal(describeCronExpr('15,45 8-18 * * 2'), '15,45 8-18 * * 2', 'unknown patterns fall through verbatim');
});

test('webhook trigger fires an unauthenticated wakeup turn; trigger CRUD validates input', async t => {
  const f = await fixture(t);
  const calls: Parameters<NodeRpcFunctions['runTurn']>[0][] = [];
  await f.addNode(['watcher'], async input => {
    calls.push(input);
    return { replyText: 'CI checked', modelBadge: 'test/model' };
  });
  const session = await f.session(['watcher'], 'direct');

  // Webhook trigger creation returns a secret token
  const trigger = await f.json<any>(`/api/sessions/${session.id}/triggers`, 'POST', {
    name: 'CI webhook', botId: 'watcher', kind: 'webhook', prompt: 'Check the failing CI pipeline',
  });
  assert.equal(trigger.kind, 'webhook');
  assert.equal(trigger.botId, 'watcher');
  assert.equal(trigger.enabled, true);
  assert.match(trigger.token!, /^[0-9a-f]{36}$/);
  assert.equal((await f.json<any[]>(`/api/sessions/${session.id}/triggers`)).length, 1);

  // Validation: non-member bot, unknown kind
  assert.equal((await f.request(`/api/sessions/${session.id}/triggers`, 'POST', { name: 'x', botId: 'ghost', kind: 'webhook', prompt: 'p' })).status, 400);
  assert.equal((await f.request(`/api/sessions/${session.id}/triggers`, 'POST', { name: 'x', botId: 'watcher', kind: 'nope', prompt: 'p' })).status, 400);

  // Fire the webhook WITHOUT any auth cookie; it must wake the session's bot
  const fire = await f.request(`/api/webhooks/${trigger.token}`, 'POST', { message: 'CI build #128 failed' }, false);
  assert.equal(fire.status, 200);
  assert.deepEqual(await fire.json(), { ok: true, triggerId: trigger.id, sessionId: session.id });
  await waitFor(() => calls.length, count => count === 1);
  assert.match(calls[0].incrementalMessages, /\[Webhook: CI webhook\] Check the failing CI pipeline/);
  assert.match(calls[0].incrementalMessages, /CI build #128 failed/);
  await f.idle(session.id);
  assert(typeof (await f.json<any[]>(`/api/sessions/${session.id}/triggers`))[0].lastTriggeredAt === 'string', 'lastTriggeredAt recorded');

  // Disabled triggers refuse webhook delivery; re-enabling restores it
  await f.json(`/api/triggers/${trigger.id}`, 'PATCH', { enabled: false });
  assert.equal((await f.request(`/api/webhooks/${trigger.token}`, 'POST', { message: 'again' }, false)).status, 403);
  await f.json(`/api/triggers/${trigger.id}`, 'PATCH', { enabled: true });
  const refire = await f.request(`/api/webhooks/${trigger.token}`, 'POST', { message: 'CI build #129 failed' }, false);
  assert.equal(refire.status, 200);
  await waitFor(() => calls.length, count => count === 2);
  await f.idle(session.id);

  // Scheduled trigger CRUD
  const cron = await f.json<any>(`/api/sessions/${session.id}/triggers`, 'POST', {
    name: 'heartbeat', botId: 'watcher', kind: 'cron', cronExpr: '*/60 * * * *', prompt: 'poll status',
  });
  assert.equal(cron.kind, 'cron');
  assert.equal(cron.cronExpr, '*/60 * * * *');
  assert.equal(cron.token, undefined, 'only webhook triggers carry a token');
  const daily = await f.json<any>(`/api/sessions/${session.id}/triggers`, 'POST', {
    name: 'daily', botId: 'watcher', kind: 'cron', cronExpr: '30 9 * * *', prompt: 'daily report',
  });
  assert.equal(daily.kind, 'cron');
  assert.equal(daily.cronExpr, '30 9 * * *');

  assert.equal((await f.request(`/api/sessions/${session.id}/triggers`, 'POST', { name: 'bad', botId: 'watcher', kind: 'cron', prompt: 'p' })).status, 400, 'cron requires cronExpr');
  assert.equal((await f.request(`/api/sessions/${session.id}/triggers`, 'POST', { name: 'bad', botId: 'watcher', kind: 'cron', cronExpr: 'bogus', prompt: 'p' })).status, 400, 'cronExpr must be a valid 5-field cron');
  assert.equal((await f.request(`/api/sessions/${session.id}/triggers`, 'POST', { name: 'bad', botId: 'watcher', kind: 'webhook', cronExpr: '*/5 * * * *', prompt: 'p' })).status, 400, 'webhook rejects cronExpr');
  assert.equal((await f.request(`/api/triggers/${cron.id}`, 'PATCH', { cronExpr: 'not valid' })).status, 400, 'invalid cronExpr is rejected');
  assert.equal((await f.request(`/api/triggers/${cron.id}`, 'PATCH', { cronExpr: '*/5 * * * *' })).status, 200);

  // Deletion removes the webhook endpoint
  await f.json(`/api/triggers/${cron.id}`, 'DELETE');
  await f.json(`/api/triggers/${daily.id}`, 'DELETE');
  await f.json(`/api/triggers/${trigger.id}`, 'DELETE');
  assert.deepEqual(await f.json<any[]>(`/api/sessions/${session.id}/triggers`), []);
  assert.equal((await f.request(`/api/webhooks/${trigger.token}`, 'POST', { message: 'x' }, false)).status, 404);
  assert.equal((await f.request('/api/webhooks/nonexistent-token', 'POST', { message: 'x' }, false)).status, 404);
  assert.equal((await f.request('/api/triggers/trg_missing', 'DELETE')).status, 404);
});

// --- 6. Cross-node skill sync ---

test('skill sync copies a skill between nodes', async t => {
  const f = await fixture(t);
  const nodeA = await f.addNode(['author']);
  const nodeB = await f.addNode(['reader']);

  // Seed a skill on node A
  const skillMd = '# shared-skill\n\nAlways run tests before deploy.';
  await f.json(`/api/nodes/${nodeA.identity.nodeId}/skills/shared-skill`, 'PUT', { content: skillMd });

  // Sync node A -> node B
  const sync = await f.json<any>(`/api/nodes/${nodeA.identity.nodeId}/skills/shared-skill/sync`, 'POST', {
    targetNodeIds: [nodeB.identity.nodeId],
  });
  assert.deepEqual(sync, { ok: true, syncedNodeIds: [nodeB.identity.nodeId], failedNodeIds: [] });
  assert.deepEqual(await f.json(`/api/nodes/${nodeB.identity.nodeId}/skills/shared-skill`), { content: skillMd });
  const nodesAfterSync = await f.json<any[]>('/api/nodes');
  assert(nodesAfterSync.find(n => n.id === nodeB.identity.nodeId)!.skills.includes('shared-skill'), 'target node lists the synced skill');

  // Sync validation and error paths
  assert.equal((await f.request(`/api/nodes/${nodeA.identity.nodeId}/skills/shared-skill/sync`, 'POST', {})).status, 400);
  assert.equal((await f.request(`/api/nodes/${nodeA.identity.nodeId}/skills/shared-skill/sync`, 'POST', { targetNodeIds: [] })).status, 400);
  assert.equal((await f.request('/api/nodes/node_ghost/skills/shared-skill/sync', 'POST', { targetNodeIds: [nodeB.identity.nodeId] })).status, 404);

  // An offline target lands in failedNodeIds instead of failing the request
  nodeB.socket.close();
  await once(nodeB.socket, 'close');
  const partial = await f.json<any>(`/api/nodes/${nodeA.identity.nodeId}/skills/shared-skill/sync`, 'POST', {
    targetNodeIds: [nodeB.identity.nodeId],
  });
  assert.deepEqual(partial, { ok: true, syncedNodeIds: [], failedNodeIds: [nodeB.identity.nodeId] });
});

// --- 7. Builtin skill creator meta-skill ---

test('builtin skill documents the skill creator and botd reload', () => {
  assert.equal(BUILTIN_SKILL_VERSION, 11, 'version marker bumped to v11');
  assert.match(BUILTIN_SKILL_MD, /<!-- botd-skill: botd-cli v11 -->/);
  assert.match(BUILTIN_SKILL_MD, /## Subagents/);
  assert.match(BUILTIN_SKILL_MD, /botd bots create reviewer/);
  assert.match(BUILTIN_SKILL_MD, /subagent_type/);
  assert.match(BUILTIN_SKILL_MD, /isolation: "worktree"/);
  // v9：主会话内子代理控制（stop_subagent / steer_subagent / Agent resume）
  assert.match(BUILTIN_SKILL_MD, /### 3\. Control running \/ finished subagents/);
  assert.match(BUILTIN_SKILL_MD, /stop_subagent/);
  assert.match(BUILTIN_SKILL_MD, /steer_subagent/);
  assert.match(BUILTIN_SKILL_MD, /resume: "<agent_id>"/);
  assert.match(BUILTIN_SKILL_MD, /## Skill creator/);
  assert.match(BUILTIN_SKILL_MD, /botd reload/);
  assert.match(BUILTIN_SKILL_MD, /botd bg run/);
  assert.match(BUILTIN_SKILL_MD, /--no-turn/);
  assert.match(BUILTIN_SKILL_MD, /--delay/);
  assert.match(BUILTIN_SKILL_MD, /~\/\.botd\/skills\/<skill-id>\/SKILL\.md/);
  assert.match(BUILTIN_SKILL_MD, /\*\*When to use\*\*.*\*\*Gotchas\*\*/);
  // v9: one-shot risk approval card syntax
  assert.match(BUILTIN_SKILL_MD, /--risk low\|medium\|high/);
  assert.match(BUILTIN_SKILL_MD, /--resource/);
});

// --- 8. Atomic primitives: no-turn wake, delayed wake / once trigger, bot env secrets, bg jobs, search & node-credential proxy ---

test('parseDelayDuration parses duration strings and rejects invalid inputs', () => {
  assert.equal(parseDelayDuration(45), 45);
  assert.equal(parseDelayDuration('30s'), 30);
  assert.equal(parseDelayDuration('15m'), 900);
  assert.equal(parseDelayDuration('2h'), 7200);
  assert.equal(parseDelayDuration('1d'), 86400);
  assert.equal(parseDelayDuration(''), null);
  assert.equal(parseDelayDuration('0s'), null);
  assert.equal(parseDelayDuration('-5m'), null);
  assert.equal(parseDelayDuration('abc'), null);
});

test('requestWakeupTurn supports noTurn silent callback and delaySeconds one-shot scheduling', async t => {
  const prevPoll = process.env.BOTD_TRIGGER_POLL_MS;
  process.env.BOTD_TRIGGER_POLL_MS = '200';
  t.after(() => {
    if (prevPoll === undefined) delete process.env.BOTD_TRIGGER_POLL_MS;
    else process.env.BOTD_TRIGGER_POLL_MS = prevPoll;
  });

  const f = await fixture(t);
  let turnCount = 0;
  const node = await f.addNode(['ops'], async input => {
    turnCount += 1;
    return {
      replyText: `Ops turn #${turnCount} on: ${input.incrementalMessages.replaceAll('@', '')}`,
      modelBadge: 'openai/test-model',
    };
  });
  const session = await f.session(['ops']);

  // 1. Silent wake (noTurn: true) posts callback message without triggering an LLM turn
  await node.rpc.requestWakeupTurn({
    sessionId: session.id,
    botId: 'ops',
    wakeupMessage: 'Step 1/2: image downloaded',
    noTurn: true,
  });
  const afterSilent = await f.json<MessageRecord[]>(`/api/sessions/${session.id}/messages`);
  assert.equal(afterSilent.length, 1);
  assert.equal(afterSilent[0].role, 'callback');
  assert.equal(afterSilent[0].content, '[Wake-up] Step 1/2: image downloaded');
  assert.equal(turnCount, 0, 'noTurn must not invoke runTurn');

  // 2. Delayed wake (delaySeconds: 1) schedules a one-shot trigger that fires once and disables itself
  const scheduled = await node.rpc.requestWakeupTurn({
    sessionId: session.id,
    botId: 'ops',
    wakeupMessage: 'Delayed health check',
    delaySeconds: 1,
  });
  assert(scheduled && typeof scheduled === 'object' && typeof scheduled.scheduledTriggerId === 'string');

  const triggersBefore = await f.json<any[]>(`/api/sessions/${session.id}/triggers`);
  assert.equal(triggersBefore.length, 1);
  assert.equal(triggersBefore[0].kind, 'once');
  assert.equal(triggersBefore[0].enabled, true);

  const afterDelayed = await waitFor(
    () => f.json<MessageRecord[]>(`/api/sessions/${session.id}/messages`),
    msgs => msgs.some(m => m.role === 'assistant' && m.content.includes('Delayed health check')),
    5_000,
  );
  assert(afterDelayed.some(m => m.role === 'callback' && m.content.includes('Delayed health check')));
  assert.equal(turnCount, 1);

  const triggersAfter = await f.json<any[]>(`/api/sessions/${session.id}/triggers`);
  assert.equal(triggersAfter[0].enabled, false, 'once trigger disables itself after firing');
  assert(triggersAfter[0].lastTriggeredAt, 'lastTriggeredAt is recorded');
});

test('bot env secrets CRUD, reserved key guard, and local storage isolation', async t => {
  const f = await fixture(t);
  await f.addNode(['coder']);

  assert.equal(isValidBotEnvKey('GITHUB_TOKEN'), true);
  assert.equal(isValidBotEnvKey('PATH'), false);
  assert.equal(isValidBotEnvKey('BOTD_SESSION_ID'), false);
  assert.equal(isValidBotEnvKey('123_BAD'), false);

  // Initial env is empty
  const initial = await f.json<{ keys: string[]; env: Record<string, string> }>('/api/bots/coder/env');
  assert.deepEqual(initial, { keys: [], env: {} });

  // Reject reserved or invalid keys
  assert.equal((await f.request('/api/bots/coder/env', 'PUT', { env: { PATH: '/tmp' } })).status, 400);
  assert.equal((await f.request('/api/bots/coder/env', 'PUT', { env: { BOTD_SECRET: '1' } })).status, 400);

  // Put and merge env vars
  const putRes = await f.json<{ ok: boolean; keys: string[]; env: Record<string, string> }>(
    '/api/bots/coder/env',
    'PUT',
    { env: { GITHUB_TOKEN: 'ghp_test123', API_ENDPOINT: 'https://api.example.com' } },
  );
  assert.equal(putRes.ok, true);
  assert.deepEqual(putRes.keys.sort(), ['API_ENDPOINT', 'GITHUB_TOKEN']);

  // Delete single key
  const delRes = await f.json<{ ok: boolean; keys: string[]; env: Record<string, string> }>(
    '/api/bots/coder/env/GITHUB_TOKEN',
    'DELETE',
  );
  assert.deepEqual(delRes.env, { API_ENDPOINT: 'https://api.example.com' });

  // Local storage helper validation
  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-env-local-'));
  t.after(() => rm(tmpData, { recursive: true, force: true }));
  await writeBotEnv(tmpData, 'coder', { DB_PASS: 's3cr3t' });
  assert.deepEqual(await readBotEnv(tmpData, 'coder'), { DB_PASS: 's3cr3t' });
});

test('BgJobManager runs background jobs, captures logs, wakes on exit, and supports kill', async t => {
  const tmpData = await mkdtemp(path.join(tmpdir(), 'botd-bg-test-'));
  t.after(() => rm(tmpData, { recursive: true, force: true }));

  await saveLocalBot(tmpData, {
    id: 'worker',
    nodeId: 'node_1',
    name: 'Worker',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  }, '');
  await writeBotEnv(tmpData, 'worker', { CUSTOM_GREETING: 'HELLO_FROM_ENV' });

  const wakes: any[] = [];
  const bg = new BgJobManager(tmpData, async input => {
    wakes.push(input);
  });
  t.after(() => bg.closeAll());

  const job = await bg.startJob({
    sessionId: 'sess_test1',
    botId: 'worker',
    command: 'echo "$CUSTOM_GREETING:$BOTD_SESSION_ID"',
    replyToBotId: 'lead',
  });
  assert.equal(job.sessionId, 'sess_test1');

  await waitFor(() => wakes.length, len => len === 1, 5_000);
  assert.equal(wakes[0].sessionId, 'sess_test1');
  assert.equal(wakes[0].botId, 'worker');
  assert.equal(wakes[0].replyToBotId, 'lead');
  assert.match(wakes[0].wakeupMessage, /HELLO_FROM_ENV:sess_test1/);

  const { logs } = await bg.getJobLogs(job.id, 10);
  assert.match(logs, /HELLO_FROM_ENV:sess_test1/);

  // Long running job can be killed without firing a completion wake
  const longJob = await bg.startJob({
    sessionId: 'sess_test1',
    botId: 'worker',
    command: 'sleep 30',
  });
  const killed = await bg.killJob(longJob.id);
  assert.equal(killed.status, 'killed');
  assert.equal(wakes.length, 1, 'killed job must not fire completion wake');
});

test('global message search and passwordless node-credential HubClient proxy', async t => {
  const f = await fixture(t);
  const node = await f.addNode(['alpha']);
  const s1 = await f.session(['alpha'], 'direct', { title: '数据库迁移方案' });
  const s2 = await f.session(['alpha'], 'direct', { title: '日常闲聊' });

  await f.json(`/api/sessions/${s1.id}/messages`, 'POST', { content: '生产环境 PostgreSQL 端口改为 5433' });
  await f.json(`/api/sessions/${s2.id}/messages`, 'POST', { content: '今天天气不错' });
  await f.json(`/api/sessions/${s1.id}`, 'PATCH', { archived: true });

  // Search across active + archived sessions
  const hits = await f.json<MessageSearchHit[]>(`/api/messages/search?q=${encodeURIComponent('PostgreSQL')}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].message.sessionId, s1.id);
  assert.equal(hits[0].sessionTitle, '数据库迁移方案');
  assert.equal(hits[0].sessionArchived, true);

  // Node-credential fallback in HubClient (no login cookie or password needed on a paired node)
  const nodeDir = await mkdtemp(path.join(tmpdir(), 'botd-node-proxy-'));
  t.after(() => rm(nodeDir, { recursive: true, force: true }));
  await writeNodeIdentity(nodeDir, {
    nodeId: node.identity.nodeId,
    name: 'Test node',
    hubUrl: node.identity.hubUrl,
    token: node.identity.token,
  });

  const client = await HubClient.connect({ dataDir: nodeDir });
  const sessionsViaNodeAuth = await client.get<SessionRecord[]>('/api/sessions');
  assert.equal(sessionsViaNodeAuth.length, 2);
  const searchViaNodeAuth = await client.get<MessageSearchHit[]>(`/api/messages/search?q=${encodeURIComponent('5433')}`);
  assert.equal(searchViaNodeAuth.length, 1);
  assert.equal(searchViaNodeAuth[0].message.sessionId, s1.id);
});

