import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { DelegateSessionResult, MessageRecord, SessionRecord } from '@botd/protocol';
import { createHub, startHub } from '../apps/hub/src/index.js';
import { buildProgram } from '../apps/node/src/cli/program.js';

interface TestEnv {
  hub: ReturnType<typeof createHub>;
  dir: string;
  adminUser: { id: string; username: string };
  adminCookie: string;
  mockRpcs: Map<string, any>;
  createUser: (username: string, password: string) => Promise<{ user: { id: string; username: string }; cookie: string }>;
  registerNodeWithBots: (ownerId: string, nodeId: string, botIds: string[]) => void;
  jsonRequest: (url: string, method?: string, body?: unknown, cookieOverride?: string) => Promise<{ status: number; ok: boolean; json: any }>;
}

async function createTestContext(t: TestContext): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-delegation-test-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const adminPassword = 'admin-password-delegation';
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

  const rawLoginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  assert.equal(rawLoginRes.status, 200, 'admin login failed');
  const adminCookie = rawLoginRes.headers.get('set-cookie')?.split(';')[0] || '';
  const adminUser = hub.db.getUserWithHash('admin')!;

  const createUser = async (username: string, password: string) => {
    const res = await jsonRequest('/api/users', 'POST', {
      username,
      password,
      role: 'member',
    }, adminCookie);
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
      tokenHash: 'dummy_hash',
      ownerId,
    });
    for (const botId of botIds) {
      hub.db.saveBot({
        id: botId,
        nodeId,
        name: `Bot ${botId}`,
        description: `Description for ${botId}`,
        modelProvider: 'openai',
        modelId: 'gpt-4o',
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
    adminUser: { id: adminUser.id, username: adminUser.username },
    adminCookie,
    mockRpcs,
    createUser,
    registerNodeWithBots,
    jsonRequest,
  };
}

const waitFor = async (predicate: () => Promise<boolean> | boolean, timeout = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for condition');
};

test('Sub-Session Delegation: 创建子会话、父会话通知、subsessions 列表与执行完成后回传摘要', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, mockRpcs, registerNodeWithBots, jsonRequest } = ctx;

  const nodeId = 'node_primary';
  const botLead = 'bot_lead';
  const botWorker = 'bot_worker';
  registerNodeWithBots(adminUser.id, nodeId, [botLead, botWorker]);

  let turnRan = false;
  mockRpcs.set(nodeId, {
    runTurn: async (input: any) => {
      turnRan = true;
      assert.equal(input.botId, botWorker);
      return {
        replyText: '子任务执行完毕：已成功处理 42 条数据。',
        modelBadge: 'openai/gpt-4o',
      };
    },
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  // 1. 创建父会话
  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '主项目群',
    mode: 'lead',
    leadBotId: botLead,
    memberBotIds: [botLead, botWorker],
  }, adminCookie);
  assert.equal(parentRes.status, 200);
  const parentSession: SessionRecord = parentRes.json;

  // 2. 调用 POST /api/sessions/:id/delegate 创建子会话
  const delegateRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker,
    prompt: '请分析近期的系统错误日志并提供优化建议',
  }, adminCookie);
  assert.equal(delegateRes.status, 201, `Delegate failed: ${JSON.stringify(delegateRes.json)}`);

  const delegateResult: DelegateSessionResult = delegateRes.json;
  assert.equal(delegateResult.parentSessionId, parentSession.id);
  assert.ok(delegateResult.childSession);
  assert.equal(delegateResult.childSession.parentSessionId, parentSession.id);
  assert.equal(delegateResult.childSession.leadBotId, botWorker);
  assert.deepEqual(delegateResult.childSession.memberBotIds, [botWorker]);
  assert.equal(delegateResult.childSession.title, '[子任务] 请分析近期的系统错误日志并提供优化建议');
  assert.equal(delegateResult.initialMessage.role, 'user');
  assert.equal(delegateResult.initialMessage.content, '请分析近期的系统错误日志并提供优化建议');

  // 3. 验证 GET /api/sessions/:id/subsessions 列出子会话
  const subsessionsRes = await jsonRequest(`/api/sessions/${parentSession.id}/subsessions`, 'GET', undefined, adminCookie);
  assert.equal(subsessionsRes.status, 200);
  const subsessions: SessionRecord[] = subsessionsRes.json;
  assert.equal(subsessions.length, 1);
  assert.equal(subsessions[0].id, delegateResult.childSession.id);
  assert.equal(subsessions[0].parentSessionId, parentSession.id);

  // 4. 验证父会话收到了派生通知公屏消息（role: 'callback', senderBotId: botWorker）
  const parentMessagesBefore = hub.db.getMessages(parentSession.id);
  const noticeMsg = parentMessagesBefore.find((m) => m.role === 'callback');
  assert.ok(noticeMsg, 'Parent session should contain a notice callback message');
  assert.equal(noticeMsg.senderBotId, botWorker);
  assert.ok(
    noticeMsg.content.includes(`已派生子会话「[${delegateResult.childSession.title}](#?s=${delegateResult.childSession.id})」交由 @${botWorker} 执行任务。`),
    `Notice content mismatch: ${noticeMsg.content}`
  );

  // 5. 等待子会话执行完成，自动向父会话回传完成摘要
  await waitFor(() => {
    const parentMessages = hub.db.getMessages(parentSession.id);
    return parentMessages.some((m) => m.role === 'callback' && m.content.includes('已完成'));
  });

  assert.ok(turnRan, 'runTurn must have been called');

  const parentMessagesAfter = hub.db.getMessages(parentSession.id);
  const completionMsg = parentMessagesAfter.find((m) => m.role === 'callback' && m.content.includes('已完成'));
  assert.ok(completionMsg, 'Parent session must have received the completion summary callback');
  assert.equal(completionMsg.senderBotId, botWorker);
  assert.ok(
    completionMsg.content.includes(`✅ 子会话「[${delegateResult.childSession.title}](#?s=${delegateResult.childSession.id})」已完成：\n\n子任务执行完毕：已成功处理 42 条数据。`),
    `Completion message mismatch: ${completionMsg.content}`
  );

  // 6. 验证子会话历史消息：初始用户消息 + assistant 回复
  const childMessages = hub.db.getMessages(delegateResult.childSession.id);
  assert.equal(childMessages.length, 2);
  assert.equal(childMessages[0].role, 'user');
  assert.equal(childMessages[0].content, '请分析近期的系统错误日志并提供优化建议');
  assert.equal(childMessages[1].role, 'assistant');
  assert.equal(childMessages[1].content, '子任务执行完毕：已成功处理 42 条数据。');
});

test('Sub-Session Delegation: 自定义标题与模式，多个子会话按 created_at 排序', async (t) => {
  const ctx = await createTestContext(t);
  const { adminUser, adminCookie, mockRpcs, registerNodeWithBots, jsonRequest } = ctx;

  const nodeId = 'node_custom';
  const botLead = 'bot_lead2';
  const botWorker1 = 'bot_worker1';
  const botWorker2 = 'bot_worker2';
  registerNodeWithBots(adminUser.id, nodeId, [botLead, botWorker1, botWorker2]);

  mockRpcs.set(nodeId, {
    runTurn: async () => ({ replyText: 'Done', modelBadge: 'test' }),
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '复杂项目',
    mode: 'lead',
    leadBotId: botLead,
    memberBotIds: [botLead, botWorker1, botWorker2],
  }, adminCookie);
  const parentSession: SessionRecord = parentRes.json;

  // 第一个子会话
  const sub1 = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker1,
    title: '自定义子任务一',
    mode: 'direct',
    prompt: 'Prompt 1',
  }, adminCookie);
  assert.equal(sub1.status, 201);
  assert.equal(sub1.json.childSession.title, '自定义子任务一');
  assert.equal(sub1.json.childSession.mode, 'direct');

  // 第二个子会话（指定 memberBotIds 与 mode）
  const sub2 = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker2,
    title: '自定义子任务二（圆桌）',
    mode: 'roundtable',
    memberBotIds: [botWorker1, botWorker2],
    prompt: 'Prompt 2',
  }, adminCookie);
  assert.equal(sub2.status, 201);
  assert.equal(sub2.json.childSession.title, '自定义子任务二（圆桌）');
  assert.equal(sub2.json.childSession.mode, 'roundtable');
  assert.deepEqual(sub2.json.childSession.memberBotIds.sort(), [botWorker1, botWorker2].sort());

  // 验证 subsessions 包含两个且顺序正确
  const listRes = await jsonRequest(`/api/sessions/${parentSession.id}/subsessions`, 'GET', undefined, adminCookie);
  assert.equal(listRes.status, 200);
  const list: SessionRecord[] = listRes.json;
  assert.equal(list.length, 2);
  assert.equal(list[0].id, sub1.json.childSession.id);
  assert.equal(list[1].id, sub2.json.childSession.id);
});

test('Sub-Session Delegation: 权限与校验边界测试', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, createUser, registerNodeWithBots, jsonRequest } = ctx;

  const { user: user2, cookie: user2Cookie } = await createUser('member2', 'password123');

  registerNodeWithBots(adminUser.id, 'node_admin', ['bot_admin']);
  registerNodeWithBots(user2.id, 'node_user2', ['bot_user2']);

  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: 'Admin Parent',
    mode: 'direct',
    leadBotId: 'bot_admin',
    memberBotIds: ['bot_admin'],
  }, adminCookie);
  const adminParentId = parentRes.json.id;

  // 1. 父会话不存在 -> 404
  const resNotFound = await jsonRequest('/api/sessions/sess_non_existent/delegate', 'POST', {
    botId: 'bot_admin',
    prompt: 'Test',
  }, adminCookie);
  assert.equal(resNotFound.status, 404);

  // 2. 访问其他用户的父会话派单 -> 403
  const resForbiddenParent = await jsonRequest(`/api/sessions/${adminParentId}/delegate`, 'POST', {
    botId: 'bot_user2',
    prompt: 'Test',
  }, user2Cookie);
  assert.equal(resForbiddenParent.status, 403);

  // 3. 目标 bot 不存在 -> 404
  const resBotNotFound = await jsonRequest(`/api/sessions/${adminParentId}/delegate`, 'POST', {
    botId: 'bot_ghost',
    prompt: 'Test',
  }, adminCookie);
  assert.equal(resBotNotFound.status, 404);

  // 4. 派单给其他用户的 bot -> 403
  const resForbiddenBot = await jsonRequest(`/api/sessions/${adminParentId}/delegate`, 'POST', {
    botId: 'bot_user2',
    prompt: 'Test',
  }, adminCookie);
  assert.equal(resForbiddenBot.status, 403);

  // 5. prompt 为空 -> 400
  const resEmptyPrompt = await jsonRequest(`/api/sessions/${adminParentId}/delegate`, 'POST', {
    botId: 'bot_admin',
    prompt: '   ',
  }, adminCookie);
  assert.equal(resEmptyPrompt.status, 400);

  // 6. 缺少 botId -> 400
  const resMissingBot = await jsonRequest(`/api/sessions/${adminParentId}/delegate`, 'POST', {
    prompt: 'Test',
  }, adminCookie);
  assert.equal(resMissingBot.status, 400);

  // 7. 无效的 mode -> 400
  const resInvalidMode = await jsonRequest(`/api/sessions/${adminParentId}/delegate`, 'POST', {
    botId: 'bot_admin',
    prompt: 'Test',
    mode: 'invalid_mode' as any,
  }, adminCookie);
  assert.equal(resInvalidMode.status, 400);

  // 8. 其他用户请求 subsessions -> 403
  const resSubForbidden = await jsonRequest(`/api/sessions/${adminParentId}/subsessions`, 'GET', undefined, user2Cookie);
  assert.equal(resSubForbidden.status, 403);

  // 9. 不存在的 session 请求 subsessions -> 404
  const resSubNotFound = await jsonRequest('/api/sessions/sess_ghost/subsessions', 'GET', undefined, adminCookie);
  assert.equal(resSubNotFound.status, 404);
});

test('POST /api/sessions 透传 parentSessionId 与 updateSession 字段映射', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, registerNodeWithBots, jsonRequest } = ctx;

  registerNodeWithBots(adminUser.id, 'node_pass', ['bot_pass']);

  // 通过 POST /api/sessions 透传 parentSessionId 创建
  const res = await jsonRequest('/api/sessions', 'POST', {
    title: '透传测试',
    mode: 'direct',
    leadBotId: 'bot_pass',
    memberBotIds: ['bot_pass'],
    parentSessionId: 'sess_custom_parent_123',
  }, adminCookie);
  assert.equal(res.status, 200);
  assert.equal(res.json.parentSessionId, 'sess_custom_parent_123');

  // getSession 读出 parentSessionId
  const dbSession = hub.db.getSession(res.json.id);
  assert.equal(dbSession?.parentSessionId, 'sess_custom_parent_123');

  // getAllSessions 包含 parentSessionId
  const allSessions = hub.db.getAllSessions(adminUser.id);
  const found = allSessions.find((s) => s.id === res.json.id);
  assert.equal(found?.parentSessionId, 'sess_custom_parent_123');

  // updateSession 更新 parentSessionId
  const updated = hub.db.updateSession(res.json.id, { parentSessionId: 'sess_custom_parent_456' });
  assert.equal(updated?.parentSessionId, 'sess_custom_parent_456');
  assert.equal(hub.db.getSession(res.json.id)?.parentSessionId, 'sess_custom_parent_456');

  // listSubSessions 查询
  const subs = hub.db.listSubSessions('sess_custom_parent_456');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].id, res.json.id);
});

test('CLI: botd sessions delegate 与 subsessions', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-cli-del-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const password = 'cli-password-123';
  const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath, adminPassword: password });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const hubUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Setup node and bot
  const adminUser = hub.db.getUserWithHash('admin')!;
  hub.db.createNode({
    id: 'cli_node',
    name: 'CLI Node',
    platform: 'linux',
    tokenHash: 'dummy_hash',
    ownerId: adminUser.id,
  });
  hub.db.saveBot({
    id: 'cli_bot',
    nodeId: 'cli_node',
    name: 'CLI Bot',
    description: 'desc',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    webCommandNames: [],
    updatedAt: new Date().toISOString(),
  });

  const parent = hub.db.createSession({
    id: 'sess_cli_parent',
    title: 'CLI Parent Session',
    mode: 'direct',
    leadBotId: 'cli_bot',
    memberBotIds: ['cli_bot'],
    ownerId: adminUser.id,
  });

  // Test delegate CLI
  const program = buildProgram();
  program.exitOverride();

  let stdout = '';
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  };
  try {
    await program.parseAsync([
      'node',
      'cli',
      '--hub',
      hubUrl,
      '--password',
      password,
      '--json',
      'sessions',
      'delegate',
      parent.id,
      '--bot',
      'cli_bot',
      '--prompt',
      'Task from CLI',
      '--title',
      'CLI Child Session',
    ]);
  } finally {
    console.log = origLog;
  }

  const delegateOut = JSON.parse(stdout.trim());
  assert.equal(delegateOut.parentSessionId, parent.id);
  assert.equal(delegateOut.childSession.title, 'CLI Child Session');
  assert.equal(delegateOut.childSession.leadBotId, 'cli_bot');

  // Test subsessions CLI
  stdout = '';
  console.log = (...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  };
  try {
    const program2 = buildProgram();
    program2.exitOverride();
    await program2.parseAsync([
      'node',
      'cli',
      '--hub',
      hubUrl,
      '--password',
      password,
      '--json',
      'sessions',
      'subsessions',
      parent.id,
    ]);
  } finally {
    console.log = origLog;
  }

  const subsessionsOut = JSON.parse(stdout.trim());
  assert.ok(Array.isArray(subsessionsOut));
  assert.equal(subsessionsOut.length, 1);
  assert.equal(subsessionsOut[0].id, delegateOut.childSession.id);
  assert.equal(subsessionsOut[0].parentSessionId, parent.id);
});
