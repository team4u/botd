import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { startHub, type StartHubResult } from '../apps/hub/src/index.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import type {
  BotConfig,
  HubRpcFunctions,
  MessageRecord,
  NodeRpcFunctions,
  PendingAskRecord,
  SessionRecord,
} from '../packages/protocol/src/index.js';

const PASSWORD = 'integration-password';

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for expected state');
};

async function createMeshFixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-mesh-test-'));
  const hub: StartHubResult = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
  });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];

  t.after(async () => {
    for (const s of sockets) s.terminate();
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  let adminCookie = '';
  const request = async (
    route: string,
    method = 'GET',
    body?: unknown,
    cookieOverride?: string
  ) => {
    const cookie = cookieOverride ?? adminCookie;
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  };

  const loginRes = await request('/api/auth/login', 'POST', { username: 'admin', password: PASSWORD }, '');
  assert.equal(loginRes.status, 200);
  adminCookie = loginRes.headers.get('set-cookie')!.split(';')[0];

  const json = async <T = any>(route: string, method = 'GET', body?: unknown, cookie?: string): Promise<T> => {
    const res = await request(route, method, body, cookie);
    const data = await res.json();
    assert(res.ok, `${method} ${route} failed with status ${res.status}: ${JSON.stringify(data)}`);
    return data as T;
  };

  const createUser = async (username: string, password = 'user-pass', role: 'admin' | 'member' = 'member') => {
    const res = await request('/api/users', 'POST', { username, password, role });
    assert.equal(res.status, 200, `create user ${username} failed`);
    const loginRes = await request('/api/auth/login', 'POST', { username, password }, '');
    assert.equal(loginRes.status, 200);
    const userCookie = loginRes.headers.get('set-cookie')!.split(';')[0];
    const user = await res.json();
    return { user, cookie: userCookie };
  };

  const connectNode = async (
    identity: { nodeId: string; token: string; name: string },
    bots: BotConfig[],
    runTurn?: NodeRpcFunctions['runTurn']
  ) => {
    const socket = new WebSocket(
      `${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`
    );
    sockets.push(socket);

    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
      {
        getModelCatalog: async () => getBuiltinModelCatalog(),
        startProviderLogin: async () => { throw new Error('Not implemented'); },
        getProviderLogin: async () => { throw new Error('Not implemented'); },
        respondProviderLogin: async () => { throw new Error('Not implemented'); },
        cancelProviderLogin: async () => {},
        logoutProvider: async () => {},
        saveBot: async (b) => {
          const idx = bots.findIndex((x) => x.id === b.id);
          if (idx < 0) bots.push(b);
          else bots[idx] = b;
        },
        deleteBot: async (id) => {
          const idx = bots.findIndex((x) => x.id === id);
          if (idx >= 0) bots.splice(idx, 1);
        },
        readFile: async () => '',
        writeFile: async () => {},
        installResource: async () => ({ kind: 'skill' as const, id: 'demo' }),
        deleteResource: async () => {},
        restartDaemon: async () => ({ ok: true as const, pid: 1234 }),
        getCommands: async () => [],
        runTurn: runTurn ?? (async (input) => ({ replyText: `Reply from @${input.botId}`, modelBadge: 'test/model' })),
        cancelTurn: async () => {},
        resetSession: async () => {},
      },
      {
        post: (data) => socket.send(data),
        on: (cb) => socket.on('message', (d) => cb(d.toString())),
        serialize: serializeRpcMessage,
        deserialize: JSON.parse,
        timeout: 10_000,
      }
    );

    await once(socket, 'open');
    await rpc.registerNode({
      nodeId: identity.nodeId,
      name: identity.name,
      platform: 'linux',
      bots,
      skills: ['demo'],
      extensions: [],
    });

    return { socket, rpc };
  };

  const addNode = async (
    botConfigs: Array<string | { id: string; visibility?: 'private' | 'team' }>,
    runTurn?: NodeRpcFunctions['runTurn'],
    cookie?: string
  ) => {
    const pairing = await json<{ code: string }>('/api/nodes/pairing', 'POST', undefined, cookie);
    const identity = await json<{ nodeId: string; token: string; name: string }>(
      '/api/nodes/pairing/exchange',
      'POST',
      { code: pairing.code, name: 'Node-' + Math.random().toString(36).slice(2, 6), platform: 'linux' },
      cookie
    );

    const bots: BotConfig[] = botConfigs.map((item) => {
      const id = typeof item === 'string' ? item : item.id;
      const visibility = typeof item === 'string' ? 'private' : (item.visibility ?? 'private');
      return {
        id,
        nodeId: identity.nodeId,
        name: id,
        description: `Bot ${id}`,
        modelProvider: 'openai',
        modelId: 'gpt-4o',
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        visibility,
        updatedAt: new Date().toISOString(),
      };
    });

    const conn = await connectNode(identity, bots, runTurn);
    return { identity, bots, socket: conn.socket, rpc: conn.rpc };
  };

  return { hub, base, request, json, createUser, addNode, connectNode, adminCookie };
}

test('Task 2.1 & 2.2: pending_asks with previewType, previewContent, timeoutSeconds: 0 and GET /api/approvals/pending', async (t) => {
  const f = await createMeshFixture(t);
  const node = await f.addNode(['ask-bot']);

  // Create session
  const session = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: 'Code Review Session',
    mode: 'direct',
    leadBotId: 'ask-bot',
    memberBotIds: ['ask-bot'],
  });

  // Node triggers an interactive human input ask with diff preview and timeoutSeconds = 0
  const askPromise = node.rpc.requestHumanInput({
    sessionId: session.id,
    botId: 'ask-bot',
    prompt: 'Do you approve the PR merge?',
    options: ['Approve', 'Reject'],
    timeoutSeconds: 0,
    previewType: 'diff',
    previewContent: '--- a/main.ts\n+++ b/main.ts\n+console.log("hello");',
  });

  // Give a moment for Hub to save pending ask
  await new Promise((r) => setTimeout(r, 60));

  // Call GET /api/approvals/pending
  const pendingList = await f.json<PendingAskRecord[]>('/api/approvals/pending');
  assert.equal(pendingList.length, 1);
  const pendingAsk = pendingList[0];
  assert.equal(pendingAsk.sessionId, session.id);
  assert.equal(pendingAsk.botId, 'ask-bot');
  assert.equal(pendingAsk.prompt, 'Do you approve the PR merge?');
  assert.equal(pendingAsk.previewType, 'diff');
  assert.equal(pendingAsk.previewContent, '--- a/main.ts\n+++ b/main.ts\n+console.log("hello");');
  assert.equal(pendingAsk.expiresAt, undefined);
  assert.equal(pendingAsk.sessionTitle, 'Code Review Session');

  // Respond to the ask
  const respondRes = await f.json<{ ok: boolean; ask: PendingAskRecord }>(
    `/api/sessions/${session.id}/asks/${pendingAsk.id}/respond`,
    'POST',
    { answer: 'Approve' }
  );
  assert.equal(respondRes.ok, true);
  assert.equal(respondRes.ask.status, 'answered');

  // Wait for the node RPC promise to resolve
  const result = await askPromise;
  assert.equal(result.answer, 'Approve');

  // GET /api/approvals/pending should now be empty
  const pendingAfter = await f.json<PendingAskRecord[]>('/api/approvals/pending');
  assert.equal(pendingAfter.length, 0);
});

test('Task 2.3: outbound_task_queue store-and-forward when node is offline and auto-recovery on reconnect', async (t) => {
  const f = await createMeshFixture(t);

  let turnReceived = false;
  let turnCommandText: string | undefined;

  const node = await f.addNode(['offline-worker'], async (input) => {
    turnReceived = true;
    turnCommandText = input.commandText;
    return { replyText: 'Worker finished task', modelBadge: 'test/badge' };
  });

  const session = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: 'Offline Queue Test',
    mode: 'direct',
    leadBotId: 'offline-worker',
    memberBotIds: ['offline-worker'],
  });

  // Disconnect node so it goes offline
  node.socket.terminate();
  await new Promise((r) => setTimeout(r, 60));

  // Post user message to the session while node is offline
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', {
    content: 'Process background data',
  });

  // Verify session entered 'queued' status
  await waitFor(
    async () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((s) => s.id === session.id)?.status === 'queued'
  );

  // Verify outbound task was recorded in outbound_task_queue
  const pendingTasks = f.hub.db.listPendingOutboundTasks(node.identity.nodeId);
  assert.equal(pendingTasks.length, 1);
  assert.equal(pendingTasks[0].botId, 'offline-worker');
  assert.equal(pendingTasks[0].sessionId, session.id);
  assert.equal(pendingTasks[0].status, 'queued_offline');

  // Reconnect node with the same identity
  await f.connectNode(node.identity, node.bots, async (input) => {
    turnReceived = true;
    turnCommandText = input.commandText;
    return { replyText: 'Worker finished task after reconnect', modelBadge: 'test/badge' };
  });

  // Wait for the turn to be processed and session to become idle
  await waitFor(
    async () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((s) => s.id === session.id)?.status === 'idle'
  );

  assert.equal(turnReceived, true);

  // Check task in outbound_task_queue is dispatched
  const pendingTasksAfter = f.hub.db.listPendingOutboundTasks(node.identity.nodeId);
  assert.equal(pendingTasksAfter.length, 0);

  const taskRecord = f.hub.db.getOutboundTask(pendingTasks[0].id);
  assert.equal(taskRecord?.status, 'dispatched');

  // Verify assistant message was created
  const msgs = await f.json<MessageRecord[]>(`/api/sessions/${session.id}/messages`);
  const assistantMsg = msgs.find((m) => m.role === 'assistant');
  assert(assistantMsg);
  assert.match(assistantMsg.content, /Worker finished task after reconnect/);
});

test('Task 3.1: visibility = "team" bot sharing across users and access control', async (t) => {
  const f = await createMeshFixture(t);

  // Admin creates node with a team-shared bot and a private bot
  const adminNode = await f.addNode([
    { id: 'shared-bot', visibility: 'team' },
    { id: 'private-bot', visibility: 'private' },
  ]);

  // Create member user 'bob'
  const bob = await f.createUser('bob', 'bob-password', 'member');

  // Bob lists bots: should see shared-bot with isTeamShared: true, but not private-bot
  const bobBots = await f.json<BotConfig[]>('/api/bots', 'GET', undefined, bob.cookie);
  assert(bobBots.some((b) => b.id === 'shared-bot' && b.isTeamShared === true && b.ownerName === 'admin'));
  assert.equal(bobBots.some((b) => b.id === 'private-bot'), false);

  // Bob lists nodes: should see the node hosting shared-bot with isTeamShared: true
  const bobNodes = await f.json<any[]>('/api/nodes', 'GET', undefined, bob.cookie);
  const sharedNode = bobNodes.find((n) => n.id === adminNode.identity.nodeId);
  assert(sharedNode, 'Node hosting shared bot must be visible');
  assert.equal(sharedNode.isTeamShared, true);
  assert.equal(sharedNode.bots.length, 1);
  assert.equal(sharedNode.bots[0].id, 'shared-bot');

  // Bob attempts to edit admin's shared-bot -> 403 Forbidden!
  const editRes = await f.request(
    '/api/bots/shared-bot',
    'PUT',
    { name: 'Hacked Name' },
    bob.cookie
  );
  assert.equal(editRes.status, 403);

  // Bob attempts to delete admin's shared-bot -> 403 Forbidden!
  const deleteRes = await f.request('/api/bots/shared-bot', 'DELETE', undefined, bob.cookie);
  assert.equal(deleteRes.status, 403);

  // Bob creates a session using admin's shared-bot
  const bobSession = await f.json<SessionRecord>(
    '/api/sessions',
    'POST',
    {
      title: 'Bob Shared Chat',
      mode: 'direct',
      leadBotId: 'shared-bot',
      memberBotIds: ['shared-bot'],
    },
    bob.cookie
  );
  assert.equal(bobSession.leadBotId, 'shared-bot');

  // Bob chats with the shared bot
  await f.json(
    `/api/sessions/${bobSession.id}/messages`,
    'POST',
    { content: 'Hello shared bot!' },
    bob.cookie
  );

  // Wait for turn to complete
  await waitFor(
    async () => f.json<SessionRecord[]>('/api/sessions', 'GET', undefined, bob.cookie),
    (list) => list.find((s) => s.id === bobSession.id)?.status === 'idle'
  );

  const bobMsgs = await f.json<MessageRecord[]>(`/api/sessions/${bobSession.id}/messages`, 'GET', undefined, bob.cookie);
  const botReply = bobMsgs.find((m) => m.role === 'assistant');
  assert(botReply);
  assert.match(botReply.content, /Reply from @shared-bot/);
});

test('Task 3.2: session_participants multi-user group session collaboration', async (t) => {
  const f = await createMeshFixture(t);

  // Create node for admin
  await f.addNode(['bot-lead', 'bot-helper']);

  // Admin creates a session
  const groupSession = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: 'War Room Discussion',
    mode: 'direct',
    leadBotId: 'bot-lead',
    memberBotIds: ['bot-lead'],
  });

  // Create member user 'alice'
  const alice = await f.createUser('alice', 'alice-pass', 'member');

  // Alice cannot view or access the session initially -> 403 Forbidden
  const aliceInitialAccess = await f.request(
    `/api/sessions/${groupSession.id}/messages`,
    'GET',
    undefined,
    alice.cookie
  );
  assert.equal(aliceInitialAccess.status, 403);

  // Admin invites Alice to the session
  const inviteRes = await f.json<{ ok: boolean; participant: any }>(
    `/api/sessions/${groupSession.id}/participants`,
    'POST',
    { username: 'alice' }
  );
  assert.equal(inviteRes.ok, true);
  assert.equal(inviteRes.participant.username, 'alice');
  assert.equal(inviteRes.participant.role, 'member');

  // View participants list
  const participants = await f.json<any[]>(`/api/sessions/${groupSession.id}/participants`);
  assert(participants.some((p) => p.userId === alice.user.id && p.username === 'alice'));

  // Alice lists sessions: groupSession is now included!
  const aliceSessions = await f.json<SessionRecord[]>('/api/sessions', 'GET', undefined, alice.cookie);
  assert(aliceSessions.some((s) => s.id === groupSession.id));

  // Alice can now read messages
  const aliceMessages = await f.json<MessageRecord[]>(
    `/api/sessions/${groupSession.id}/messages`,
    'GET',
    undefined,
    alice.cookie
  );
  assert.equal(Array.isArray(aliceMessages), true);

  // Alice posts a message in the session
  await f.json(
    `/api/sessions/${groupSession.id}/messages`,
    'POST',
    { content: 'Here to help debug' },
    alice.cookie
  );

  // Check the message in DB: multi-user session stores clean content and structured sender info
  const updatedMsgs = await f.json<MessageRecord[]>(`/api/sessions/${groupSession.id}/messages`);
  const aliceMsg = updatedMsgs.find((m) => m.role === 'user');
  assert(aliceMsg);
  assert.equal(aliceMsg.content, 'Here to help debug');
  assert.equal(aliceMsg.senderUsername, 'alice');
  assert.equal(aliceMsg.senderUserId, alice.user.id);

  // Alice tries to delete the session -> 403 Forbidden (only owner can delete)
  const aliceDeleteRes = await f.request(`/api/sessions/${groupSession.id}`, 'DELETE', undefined, alice.cookie);
  assert.equal(aliceDeleteRes.status, 403);

  // Alice leaves the session
  const leaveRes = await f.json<{ ok: boolean }>(
    `/api/sessions/${groupSession.id}/participants/${alice.user.id}`,
    'DELETE',
    undefined,
    alice.cookie
  );
  assert.equal(leaveRes.ok, true);

  // After leaving, Alice can no longer access the session
  const aliceAccessAfter = await f.request(
    `/api/sessions/${groupSession.id}/messages`,
    'GET',
    undefined,
    alice.cookie
  );
  assert.equal(aliceAccessAfter.status, 403);
});

test('Task 1.4: Cross-node incomingArtifacts passed into rpc.runTurn', async (t) => {
  const f = await createMeshFixture(t);

  let bobReceivedArtifacts: any[] | undefined;

  // Node 1 hosts bot-alice
  const nodeAlice = await f.addNode(['bot-alice']);

  // Node 2 hosts bot-bob
  await f.addNode(['bot-bob'], async (input) => {
    bobReceivedArtifacts = input.incomingArtifacts;
    return { replyText: 'Bob received artifacts', modelBadge: 'test/bob' };
  });

  const session = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: 'Cross Node Artifacts',
    mode: 'direct',
    leadBotId: 'bot-alice',
    memberBotIds: ['bot-alice'],
  });

  // Alice uploads an artifact into the session
  await nodeAlice.rpc.uploadArtifact({
    sessionId: session.id,
    botId: 'bot-alice',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    contentBase64: Buffer.from('PDF_CONTENT').toString('base64'),
  });

  // Trigger turn for bot-bob (slash command directly routes to target bot)
  await f.json(`/api/sessions/${session.id}/messages`, 'POST', {
    content: '@bot-bob /review please check the report',
  });

  // Wait for session to finish running
  await waitFor(
    async () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((s) => s.id === session.id)?.status === 'idle'
  );

  assert(bobReceivedArtifacts, 'Bob must receive incomingArtifacts');
  assert.equal(bobReceivedArtifacts.length, 1);
  assert.equal(bobReceivedArtifacts[0].filename, 'report.pdf');
  assert.equal(bobReceivedArtifacts[0].mimeType, 'application/pdf');
  assert.equal(bobReceivedArtifacts[0].fromBotName, 'bot-alice');
  assert.match(bobReceivedArtifacts[0].url, /^\/api\/artifacts\/.+\/download$/);
});
