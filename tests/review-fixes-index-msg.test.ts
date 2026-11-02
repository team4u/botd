import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHub } from '../apps/hub/src/index.js';
import type { BotConfig, MessageRecord, SessionRecord } from '../packages/protocol/src/index.js';

interface TestEnv {
  hub: ReturnType<typeof createHub>;
  dir: string;
  adminUser: { id: string; username: string };
  adminCookie: string;
  mockRpcs: Map<string, any>;
  createUser: (username: string, password?: string, role?: 'admin' | 'member') => Promise<{
    user: { id: string; username: string };
    cookie: string;
  }>;
  registerNodeWithBots: (
    ownerId: string,
    nodeId: string,
    bots: Array<string | { id: string; visibility?: 'private' | 'team' }>
  ) => void;
  jsonRequest: (
    url: string,
    method?: string,
    body?: unknown,
    cookieOverride?: string
  ) => Promise<{ status: number; ok: boolean; json: any; headers: Headers }>;
}

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 5000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for expected state');
};

async function createTestContext(t: TestContext): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-review-fixes-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const adminPassword = 'admin-password-test';
  const hub = createHub({ dbPath, adminPassword });

  const mockRpcs = new Map<string, any>();
  hub.connections.getNodeRpc = (nodeId: string) => mockRpcs.get(nodeId);

  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const jsonRequest = async (url: string, method = 'GET', body?: unknown, cookieOverride?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookieOverride) headers['cookie'] = cookieOverride;
    const res = await hub.app.request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, json, headers: res.headers };
  };

  const rawLoginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  assert.equal(rawLoginRes.status, 200, 'admin login failed');
  const adminCookie = rawLoginRes.headers.get('set-cookie')?.split(';')[0] || '';
  assert.ok(adminCookie, 'admin cookie missing');
  const adminUser = hub.db.getUserWithHash('admin')!;

  const createUser = async (username: string, password = 'user-password', role: 'admin' | 'member' = 'member') => {
    const res = await jsonRequest(
      '/api/users',
      'POST',
      { username, password, role },
      adminCookie
    );
    assert.equal(res.status, 200, `create user ${username} failed: ${JSON.stringify(res.json)}`);

    const userLoginRes = await hub.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(userLoginRes.status, 200);
    const userCookie = userLoginRes.headers.get('set-cookie')?.split(';')[0] || '';
    const user = hub.db.getUserWithHash(username)!;
    return { user: { id: user.id, username: user.username }, cookie: userCookie };
  };

  const registerNodeWithBots = (
    ownerId: string,
    nodeId: string,
    botConfigs: Array<string | { id: string; visibility?: 'private' | 'team' }>
  ) => {
    hub.db.createNode({
      id: nodeId,
      name: `Node ${nodeId}`,
      platform: 'linux',
      tokenHash: 'dummy-token-hash',
      ownerId,
    });
    for (const item of botConfigs) {
      const botId = typeof item === 'string' ? item : item.id;
      const visibility = typeof item === 'string' ? 'private' : (item.visibility ?? 'private');
      hub.db.saveBot({
        id: botId,
        nodeId,
        name: `Bot ${botId}`,
        description: `Bot ${botId} description`,
        modelProvider: 'openai',
        modelId: 'gpt-4',
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        visibility,
        updatedAt: new Date().toISOString(),
      });
    }
  };

  return {
    hub,
    dir,
    adminUser: { id: adminUser.id, username: adminUser.username },
    adminCookie,
    mockRpcs,
    createUser,
    registerNodeWithBots,
    jsonRequest,
  };
}

test('Fix 1 — D2: dead routes POST /api/nodes/:nodeId/bots and PUT /api/nodes/:nodeId/bots/:botId return 404', async (t) => {
  const ctx = await createTestContext(t);

  const postRes = await ctx.jsonRequest('/api/nodes/node_1/bots', 'POST', {
    id: 'bot_test',
    name: 'Bot Test',
    modelProvider: 'openai',
    modelId: 'gpt-4',
    systemMd: 'test system',
  }, ctx.adminCookie);
  assert.equal(postRes.status, 404, 'POST /api/nodes/:nodeId/bots must return 404');

  const putRes = await ctx.jsonRequest('/api/nodes/node_1/bots/bot_test', 'PUT', {
    name: 'Bot Test Updated',
  }, ctx.adminCookie);
  assert.equal(putRes.status, 404, 'PUT /api/nodes/:nodeId/bots/:botId must return 404');
});

test('Fix 2 & 4 — D3: multi-user message stores clean content and structured senderUserId/senderUsername; smoke tests mock runTurn', async (t) => {
  const ctx = await createTestContext(t);
  const userA = ctx.adminUser;
  const { user: userB, cookie: userBCookie } = await ctx.createUser('alice_user', 'alice-pass');

  ctx.registerNodeWithBots(userA.id, 'node_main', [
    { id: 'lead_bot', visibility: 'team' },
    { id: 'worker_bot', visibility: 'team', parentBotId: 'lead_bot' },
  ]);

  const runTurnCalls: any[] = [];
  ctx.mockRpcs.set('node_main', {
    runTurn: async (input: any) => {
      runTurnCalls.push(input);
      return {
        replyText: 'Acknowledged! Happy to collaborate.',
        modelBadge: 'openai/gpt-4',
      };
    },
    resetSession: async () => {},
  });

  // UserA creates a lead-mode group session
  const sessionRes = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Multi User Collab Session',
    mode: 'lead',
    leadBotId: 'lead_bot',
    memberBotIds: ['lead_bot', 'worker_bot'],
  }, ctx.adminCookie);
  assert.equal(sessionRes.status, 200);
  const session: SessionRecord = sessionRes.json;

  // Add userB as participant
  const addPartRes = await ctx.jsonRequest(
    `/api/sessions/${session.id}/participants`,
    'POST',
    { username: userB.username },
    ctx.adminCookie
  );
  assert.equal(addPartRes.status, 200);
  assert.equal(addPartRes.json.ok, true);

  // UserB posts a message in the session
  const postMsgRes = await ctx.jsonRequest(
    `/api/sessions/${session.id}/messages`,
    'POST',
    { content: 'Hello team, this is userB speaking' },
    userBCookie
  );
  assert.equal(postMsgRes.status, 202);

  // Wait for the turn to complete and session to return to idle
  await waitFor(
    async () => {
      const s = ctx.hub.db.getSession(session.id);
      return s?.status;
    },
    (status) => status === 'idle'
  );

  // Inspect messages directly from DB
  const dbMessages = ctx.hub.db.getMessages(session.id);
  const userMsg = dbMessages.find((m) => m.role === 'user');
  assert(userMsg, 'User message must exist in DB');

  // Verify: clean content with NO [User: ...] prefix
  assert.equal(userMsg.content, 'Hello team, this is userB speaking');
  assert.doesNotMatch(userMsg.content, /^\[User:/);

  // Verify: structured fields are populated
  assert.equal(userMsg.senderUserId, userB.id);
  assert.equal(userMsg.senderUsername, userB.username);

  assert(runTurnCalls.length > 0, 'runTurn must have been called');
  const runTurnInput = runTurnCalls[0];
  // Incremental messages read from DB contains clean content
  assert.match(runTurnInput.incrementalMessages, /Hello team, this is userB speaking/);

  // Verify assistant replied
  const assistantMsg = dbMessages.find((m) => m.role === 'assistant');
  assert(assistantMsg, 'Assistant reply must exist');
  assert.match(assistantMsg.content, /Acknowledged! Happy to collaborate\./);
});

test('Fix 2 — D3: single-user message also stores senderUserId/senderUsername and clean content', async (t) => {
  const ctx = await createTestContext(t);
  const userA = ctx.adminUser;

  ctx.registerNodeWithBots(userA.id, 'node_single', ['solo_bot']);

  ctx.mockRpcs.set('node_single', {
    runTurn: async () => ({
      replyText: 'Solo bot reply',
      modelBadge: 'openai/gpt-4',
    }),
    resetSession: async () => {},
  });

  const sessionRes = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Single User Session',
    mode: 'direct',
    leadBotId: 'solo_bot',
    memberBotIds: ['solo_bot'],
  }, ctx.adminCookie);
  assert.equal(sessionRes.status, 200);
  const session: SessionRecord = sessionRes.json;

  const postMsgRes = await ctx.jsonRequest(
    `/api/sessions/${session.id}/messages`,
    'POST',
    { content: 'Solo message from userA' },
    ctx.adminCookie
  );
  assert.equal(postMsgRes.status, 202);

  // Inspect DB messages
  const dbMessages = ctx.hub.db.getMessages(session.id);
  const userMsg = dbMessages.find((m) => m.role === 'user');
  assert(userMsg, 'User message must exist');
  assert.equal(userMsg.content, 'Solo message from userA');
  assert.equal(userMsg.senderUserId, userA.id);
  assert.equal(userMsg.senderUsername, userA.username);
});

test('Fix 3 — GET /api/bots returns accessible bots for user', async (t) => {
  const ctx = await createTestContext(t);
  const admin = ctx.adminUser;
  const { user: bob, cookie: bobCookie } = await ctx.createUser('bob_user', 'bob-pass');

  ctx.registerNodeWithBots(admin.id, 'node_admin', [
    { id: 'admin_private_bot', visibility: 'private' },
    { id: 'admin_team_bot', visibility: 'team' },
  ]);

  // Admin lists bots: should see both private and team bot
  const adminBotsRes = await ctx.jsonRequest('/api/bots', 'GET', undefined, ctx.adminCookie);
  assert.equal(adminBotsRes.status, 200);
  const adminBots: BotConfig[] = adminBotsRes.json;
  assert(adminBots.some((b) => b.id === 'admin_private_bot'), 'Admin must see own private bot');
  assert(adminBots.some((b) => b.id === 'admin_team_bot'), 'Admin must see own team bot');

  // Bob lists bots: should see team bot with isTeamShared: true, but NOT admin_private_bot
  const bobBotsRes = await ctx.jsonRequest('/api/bots', 'GET', undefined, bobCookie);
  assert.equal(bobBotsRes.status, 200);
  const bobBots: BotConfig[] = bobBotsRes.json;
  assert.equal(
    bobBots.some((b) => b.id === 'admin_private_bot'),
    false,
    'Bob must not see admin private bot'
  );
  const sharedBot = bobBots.find((b) => b.id === 'admin_team_bot');
  assert(sharedBot, 'Bob must see admin team bot');
  assert.equal(sharedBot.isTeamShared, true);
});
