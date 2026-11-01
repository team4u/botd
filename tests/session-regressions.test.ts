import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHub } from '../apps/hub/src/index.js';
import { HubDatabase } from '../apps/hub/src/db.js';

interface TestEnv {
  hub: ReturnType<typeof createHub>;
  dir: string;
  user: { id: string; username: string };
  cookie: string;
  mockRpcs: Map<string, any>;
  createUser: (username: string, password: string) => Promise<{ user: { id: string; username: string }; cookie: string }>;
  registerNodeWithBots: (ownerId: string, nodeId: string, botIds: string[]) => void;
  jsonRequest: (url: string, method?: string, body?: unknown, cookieOverride?: string) => Promise<{ status: number; ok: boolean; json: any }>;
}

async function createTestContext(t: TestContext): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-session-reg-'));
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
    return { status: res.status, ok: res.ok, json };
  };

  const adminUser = hub.db.getUserWithHash('admin')!;
  const rawLoginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  assert.equal(rawLoginRes.status, 200, 'admin login failed');
  const effectiveAdminCookie = rawLoginRes.headers.get('set-cookie')?.split(';')[0];
  assert.ok(effectiveAdminCookie, 'login must provide a session cookie');

  const createUser = async (username: string, password: string) => {
    const res = await jsonRequest('/api/users', 'POST', {
      username,
      password,
      role: 'member',
    }, effectiveAdminCookie);
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

  const registerNodeWithBots = (ownerId: string, nodeId: string, botIds: string[]) => {
    hub.db.createNode({
      id: nodeId,
      name: `Node ${nodeId}`,
      platform: 'linux',
      tokenHash: 'dummy-token-hash',
      ownerId,
    });
    for (const botId of botIds) {
      hub.db.saveBot({
        id: botId,
        nodeId,
        name: `Bot ${botId}`,
        description: 'test bot description',
        modelProvider: 'openai',
        modelId: 'gpt-4',
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        webCommandNames: [],
        updatedAt: new Date().toISOString(),
      });
    }
  };

  return {
    hub,
    dir,
    user: { id: adminUser.id, username: adminUser.username },
    cookie: effectiveAdminCookie,
    mockRpcs,
    createUser,
    registerNodeWithBots,
    jsonRequest,
  };
}

test('1. POST/PATCH 跨 user 拒绝', async (t) => {
  const ctx = await createTestContext(t);
  const { user: userAdmin, cookie: adminCookie } = ctx;
  const { user: user2, cookie: user2Cookie } = await ctx.createUser('user2', 'user2password');

  ctx.registerNodeWithBots(userAdmin.id, 'node_admin', ['bot_admin', 'bot_admin_2']);
  ctx.registerNodeWithBots(user2.id, 'node_user2', ['bot_user2']);

  // 1a: POST with lead belonging to other user -> 403
  const post1 = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Cross lead',
    mode: 'direct',
    leadBotId: 'bot_user2',
    memberBotIds: ['bot_user2'],
  }, adminCookie);
  assert.equal(post1.status, 403);

  // 1b: POST with members containing other user bot -> 403
  const post2 = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Cross member',
    mode: 'roundtable',
    leadBotId: 'bot_admin',
    memberBotIds: ['bot_admin', 'bot_user2'],
  }, adminCookie);
  assert.equal(post2.status, 403);

  // 1c: Direct mode with multiple members -> 400
  const postDirect = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Direct invalid cardinality',
    mode: 'direct',
    leadBotId: 'bot_admin',
    memberBotIds: ['bot_admin', 'bot_admin_2'],
  }, adminCookie);
  assert.equal(postDirect.status, 400);

  // 1d: Valid session creation by admin
  const postValid = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Admin Session',
    mode: 'lead',
    leadBotId: 'bot_admin',
    memberBotIds: ['bot_admin', 'bot_admin_2'],
  }, adminCookie);
  assert.equal(postValid.status, 200);
  const sessionId = postValid.json.id;

  // 1e: userAdmin attempts PATCH to add bot_user2 to members -> 403
  const patch1 = await ctx.jsonRequest(`/api/sessions/${sessionId}`, 'PATCH', {
    memberBotIds: ['bot_admin', 'bot_admin_2', 'bot_user2'],
  }, adminCookie);
  assert.equal(patch1.status, 403);

  // 1f: userAdmin attempts PATCH to set lead to bot_user2 -> 403
  const patch2 = await ctx.jsonRequest(`/api/sessions/${sessionId}`, 'PATCH', {
    leadBotId: 'bot_user2',
  }, adminCookie);
  assert.equal(patch2.status, 403);

  // 1g: user2 attempts PATCH on userAdmin's session -> 403
  const patchOther = await ctx.jsonRequest(`/api/sessions/${sessionId}`, 'PATCH', {
    title: 'Hijack title',
  }, user2Cookie);
  assert.equal(patchOther.status, 403);
});

test('2. queued clear/edited 后旧 task 失效，新编辑只执行一次', async (t) => {
  const ctx = await createTestContext(t);
  const { user, cookie } = ctx;
  ctx.registerNodeWithBots(user.id, 'node_1', ['bot_1']);

  // Node is offline initially
  ctx.mockRpcs.delete('node_1');

  const created = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Queued Invalidation Test',
    mode: 'direct',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
  }, cookie);
  assert.equal(created.status, 200);
  const sessionId = created.json.id;

  // Post message 1 while offline -> session becomes queued
  const msg1 = await ctx.jsonRequest(`/api/sessions/${sessionId}/messages`, 'POST', {
    content: 'original message 1',
  }, cookie);
  assert.equal(msg1.status, 202);

  let sessionInDb = ctx.hub.db.getSession(sessionId)!;
  assert.equal(sessionInDb.status, 'queued');

  // Case A: Clear messages while queued -> old task is invalidated
  const clearRes = await ctx.jsonRequest(`/api/sessions/${sessionId}/messages`, 'DELETE', undefined, cookie);
  assert.equal(clearRes.status, 200);

  sessionInDb = ctx.hub.db.getSession(sessionId)!;
  assert.equal(sessionInDb.status, 'idle');

  // Bring node online
  const runTurnCallsA: any[] = [];
  ctx.mockRpcs.set('node_1', {
    runTurn: async (args: any) => {
      runTurnCallsA.push(args);
      return { replyText: 'reply A', modelBadge: 'badge' };
    },
    resetSession: async () => {},
  });
  ctx.hub.router.onNodeOnline('node_1');
  await new Promise((r) => setTimeout(r, 60));

  // Old turn must not execute
  assert.equal(runTurnCallsA.length, 0);

  // Case B: Edit message while queued -> only the fresh edited message executes once
  ctx.mockRpcs.delete('node_1'); // take offline again
  const msg2 = await ctx.jsonRequest(`/api/sessions/${sessionId}/messages`, 'POST', {
    content: 'stale message before edit',
  }, cookie);
  assert.equal(msg2.status, 202);
  const msg2Id = msg2.json.id;

  sessionInDb = ctx.hub.db.getSession(sessionId)!;
  assert.equal(sessionInDb.status, 'queued');

  // Edit the queued message
  const editRes = await ctx.jsonRequest(`/api/sessions/${sessionId}/messages/${msg2Id}`, 'PUT', {
    content: 'fresh edited content',
  }, cookie);
  assert.equal(editRes.status, 200);

  const runTurnCallsB: any[] = [];
  ctx.mockRpcs.set('node_1', {
    runTurn: async (args: any) => {
      runTurnCallsB.push(args);
      return { replyText: 'reply from edited', modelBadge: 'badge' };
    },
    resetSession: async () => {},
  });
  ctx.hub.router.onNodeOnline('node_1');
  await new Promise((r) => setTimeout(r, 100));

  // Must execute exactly once with the edited content
  assert.equal(runTurnCallsB.length, 1);
  assert.match(runTurnCallsB[0].incrementalMessages, /fresh edited content/);
  assert.doesNotMatch(runTurnCallsB[0].incrementalMessages, /stale message before edit/);
});

test('3. 离线 clear 保留 pending mark，下一 runTurn 前 reset 成功才 run、reset 失败不 run，覆盖串行和并行', async (t) => {
  const ctx = await createTestContext(t);
  const { user, cookie } = ctx;
  ctx.registerNodeWithBots(user.id, 'node_s', ['bot_s']);
  ctx.registerNodeWithBots(user.id, 'node_p1', ['bot_p1']);
  ctx.registerNodeWithBots(user.id, 'node_p2', ['bot_p2']);
  ctx.registerNodeWithBots(user.id, 'node_lead', ['bot_lead']);

  // --- Part 1: Serial mode ---
  const sRes = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Serial Reset Test',
    mode: 'direct',
    leadBotId: 'bot_s',
    memberBotIds: ['bot_s'],
  }, cookie);
  const sId = sRes.json.id;

  // Node offline -> clear messages -> pending reset must be marked in db
  ctx.mockRpcs.delete('node_s');
  await ctx.jsonRequest(`/api/sessions/${sId}/messages`, 'DELETE', undefined, cookie);
  assert.equal(ctx.hub.db.hasPendingSessionReset(sId, 'bot_s'), true);

  // Subcase 1a: reset fails -> runTurn does NOT run
  let sResetCalled = false;
  let sRunTurnCalled = false;
  ctx.mockRpcs.set('node_s', {
    resetSession: async () => {
      sResetCalled = true;
      throw new Error('Reset failed simulated');
    },
    runTurn: async () => {
      sRunTurnCalled = true;
      return { replyText: 'should not run', modelBadge: 'badge' };
    },
  });

  await ctx.jsonRequest(`/api/sessions/${sId}/messages`, 'POST', { content: 'turn 1' }, cookie);
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(sResetCalled, true);
  assert.equal(sRunTurnCalled, false);
  assert.equal(ctx.hub.db.hasPendingSessionReset(sId, 'bot_s'), true);

  // Subcase 1b: reset succeeds -> runTurn runs
  sResetCalled = false;
  sRunTurnCalled = false;
  ctx.mockRpcs.set('node_s', {
    resetSession: async () => {
      sResetCalled = true;
    },
    runTurn: async () => {
      sRunTurnCalled = true;
      return { replyText: 'turn success', modelBadge: 'badge' };
    },
  });

  await ctx.jsonRequest(`/api/sessions/${sId}/messages`, 'POST', { content: 'turn retry' }, cookie);
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(sResetCalled, true);
  assert.equal(sRunTurnCalled, true);
  assert.equal(ctx.hub.db.hasPendingSessionReset(sId, 'bot_s'), false);

  // --- Part 2: Parallel mode (Roundtable) ---
  const pRes = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Parallel Reset Test',
    mode: 'roundtable',
    leadBotId: 'bot_lead',
    memberBotIds: ['bot_p1', 'bot_p2', 'bot_lead'],
    parallelRoundtable: true,
  }, cookie);
  const pId = pRes.json.id;

  // Offline clear
  ctx.mockRpcs.delete('node_p1');
  ctx.mockRpcs.delete('node_p2');
  ctx.mockRpcs.delete('node_lead');
  await ctx.jsonRequest(`/api/sessions/${pId}/messages`, 'DELETE', undefined, cookie);

  assert.equal(ctx.hub.db.hasPendingSessionReset(pId, 'bot_p1'), true);
  assert.equal(ctx.hub.db.hasPendingSessionReset(pId, 'bot_p2'), true);

  // Online: p1 fails reset, p2 succeeds reset
  let p1RunTurnCalled = false;
  let p2RunTurnCalled = false;
  ctx.mockRpcs.set('node_p1', {
    resetSession: async () => { throw new Error('p1 reset failure'); },
    runTurn: async () => { p1RunTurnCalled = true; return { replyText: 'p1', modelBadge: 'b' }; },
  });
  ctx.mockRpcs.set('node_p2', {
    resetSession: async () => {},
    runTurn: async () => { p2RunTurnCalled = true; return { replyText: 'p2', modelBadge: 'b' }; },
  });
  ctx.mockRpcs.set('node_lead', {
    resetSession: async () => {},
    runTurn: async () => ({ replyText: 'lead summary', modelBadge: 'b' }),
  });

  await ctx.jsonRequest(`/api/sessions/${pId}/messages`, 'POST', { content: 'roundtable parallel question' }, cookie);
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(p1RunTurnCalled, false);
  assert.equal(p2RunTurnCalled, true);
});

test('4. 持久 db 重新打开 pending mark 仍在', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-pending-persist-'));
  const dbPath = path.join(dir, 'test.sqlite');

  try {
    // 1. Open first instance, mark pending
    const db1 = new HubDatabase({ dbPath });
    db1.markSessionResetPending('sess_persist', 'bot_persist');
    assert.equal(db1.hasPendingSessionReset('sess_persist', 'bot_persist'), true);
    db1.close();

    // 2. Reopen second instance, verify mark persisted
    const db2 = new HubDatabase({ dbPath });
    assert.equal(db2.hasPendingSessionReset('sess_persist', 'bot_persist'), true);

    // 3. Clear mark and close
    db2.clearSessionResetPending('sess_persist', 'bot_persist');
    assert.equal(db2.hasPendingSessionReset('sess_persist', 'bot_persist'), false);
    db2.close();

    // 4. Reopen third instance, verify cleared state persisted
    const db3 = new HubDatabase({ dbPath });
    assert.equal(db3.hasPendingSessionReset('sess_persist', 'bot_persist'), false);
    db3.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('5. remove 成员后 trigger disabled/webhook 403/直接 handleWakeup 拒绝、调度阶段不 run 移除成员', async (t) => {
  const ctx = await createTestContext(t);
  const { user, cookie } = ctx;
  ctx.registerNodeWithBots(user.id, 'node_rem', ['bot_lead', 'bot_rem']);

  const sRes = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Trigger Remove Test',
    mode: 'lead',
    leadBotId: 'bot_lead',
    memberBotIds: ['bot_lead', 'bot_rem'],
  }, cookie);
  const sessionId = sRes.json.id;

  // Create a webhook trigger targeting bot_rem
  const trgRes = await ctx.jsonRequest(`/api/sessions/${sessionId}/triggers`, 'POST', {
    name: 'Rem Webhook',
    botId: 'bot_rem',
    kind: 'webhook',
    prompt: 'wake payload',
  }, cookie);
  assert.equal(trgRes.status, 201);
  const triggerId = trgRes.json.id;
  const token = trgRes.json.token;

  let trgInDb = ctx.hub.db.getTrigger(triggerId)!;
  assert.equal(trgInDb.enabled, true);

  // Remove bot_rem from session members via PATCH
  const patchRes = await ctx.jsonRequest(`/api/sessions/${sessionId}`, 'PATCH', {
    memberBotIds: ['bot_lead'],
  }, cookie);
  assert.equal(patchRes.status, 200);

  // 1. Verify trigger was disabled in DB
  trgInDb = ctx.hub.db.getTrigger(triggerId)!;
  assert.equal(trgInDb.enabled, false);

  // 2. Webhook call returns 403
  const hookRes1 = await ctx.jsonRequest(`/api/webhooks/${token}`, 'POST', { message: 'hello' });
  assert.equal(hookRes1.status, 403);

  // Even if manually re-enabled while bot_rem is not a member:
  ctx.hub.db.updateTrigger(triggerId, { enabled: true });
  const hookRes2 = await ctx.jsonRequest(`/api/webhooks/${token}`, 'POST', { message: 'hello again' });
  assert.equal(hookRes2.status, 403);
  assert.equal(ctx.hub.db.getTrigger(triggerId)!.enabled, false);

  // 3. Direct handleWakeup throws / rejects
  await assert.rejects(async () => {
    await ctx.hub.router.handleWakeup(sessionId, 'bot_rem', 'wake up removed bot');
  }, /Forbidden: bot @bot_rem cannot run in session/);

  // 4. Scheduling stage filter: canRunBot is false
  assert.equal(ctx.hub.router.canRunBot(sessionId, 'bot_rem'), false);
  assert.equal(ctx.hub.router.canRunBot(sessionId, 'bot_lead'), true);
});

test('6. reset 异步中被取消/再次 clear 时老 reset 完成不能抹掉新的 pending 或 run 旧 task', async (t) => {
  const ctx = await createTestContext(t);
  const { user, cookie } = ctx;
  ctx.registerNodeWithBots(user.id, 'node_race', ['bot_race']);

  const sRes = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Race Condition Test',
    mode: 'direct',
    leadBotId: 'bot_race',
    memberBotIds: ['bot_race'],
  }, cookie);
  const sessionId = sRes.json.id;

  // Setup a hanging resetSession promise for bot_race
  let resolveReset1!: () => void;
  const reset1Promise = new Promise<void>((r) => { resolveReset1 = r; });

  let runTurnCalled = false;
  ctx.mockRpcs.set('node_race', {
    resetSession: async () => {
      await reset1Promise;
    },
    runTurn: async () => {
      runTurnCalled = true;
      return { replyText: 'race reply', modelBadge: 'b' };
    },
    cancelTurn: async () => {},
  });

  // Call resetMemberSessions (generation = 0)
  const resetMemberPromise = ctx.hub.router.resetMemberSessions(sessionId);

  // While resetSession is still pending, cancelSession / clear session messages (advances generation)
  await ctx.hub.router.cancelSession(sessionId);

  // Ensure pending reset was marked
  ctx.hub.db.markSessionResetPending(sessionId, 'bot_race');
  assert.equal(ctx.hub.db.hasPendingSessionReset(sessionId, 'bot_race'), true);

  // Now resolve the old resetSession
  resolveReset1();
  await resetMemberPromise;

  // The old resetSession completion must NOT clear the new pending mark because generation changed!
  assert.equal(ctx.hub.db.hasPendingSessionReset(sessionId, 'bot_race'), true);

  // In processQueue: if a turn is executing a reset and cancellation occurs during reset:
  let resolveReset2!: () => void;
  const reset2Promise = new Promise<void>((r) => { resolveReset2 = r; });

  ctx.mockRpcs.set('node_race', {
    resetSession: async () => {
      await reset2Promise;
    },
    runTurn: async () => {
      runTurnCalled = true;
      return { replyText: 'stale turn reply', modelBadge: 'b' };
    },
    cancelTurn: async () => {},
  });

  // Post message to start turn
  await ctx.jsonRequest(`/api/sessions/${sessionId}/messages`, 'POST', { content: 'turn with slow reset' }, cookie);
  await new Promise((r) => setTimeout(r, 40));

  // Cancel session while reset is waiting
  await ctx.hub.router.cancelSession(sessionId);

  // Now let the slow reset complete
  resolveReset2();
  await new Promise((r) => setTimeout(r, 60));

  // runTurn must NOT have been called for the cancelled task!
  assert.equal(runTurnCalled, false);
});
