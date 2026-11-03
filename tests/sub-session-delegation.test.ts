import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { BotConfig, DelegateSessionResult, MessageRecord, SessionRecord } from '../packages/protocol/src/index.js';
import { createHub, startHub } from '../apps/hub/src/index.js';
import { buildGroupContextPrompt } from '../apps/hub/src/group-router.js';
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

  const turnsCalled: string[] = [];
  mockRpcs.set(nodeId, {
    runTurn: async (input: any) => {
      turnsCalled.push(input.botId);
      if (input.botId === botWorker) {
        return {
          replyText: '子任务执行完毕：已成功处理 42 条数据。',
          modelBadge: 'openai/gpt-4o',
        };
      }
      return {
        replyText: '收到子任务汇报，已完成汇总。',
        modelBadge: 'openai/gpt-4o',
      };
    },
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  // 1. 创建父会话
  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '主项目群',
    mode: 'direct',
    leadBotId: botLead,
    memberBotIds: [botLead],
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

  assert.ok(turnsCalled.includes(botWorker), 'botWorker runTurn must have been called');

  // 等待父会话 leadBot 被唤醒执行汇总回合
  await waitFor(() => {
    const parentMessages = hub.db.getMessages(parentSession.id);
    return parentMessages.some((m) => m.role === 'assistant' && m.senderBotId === botLead);
  });
  assert.ok(turnsCalled.includes(botLead), 'botLead must have been woken up');

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
    mode: 'direct',
    leadBotId: botLead,
    memberBotIds: [botLead],
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

  // 第二个子会话（指定 mode）
  const sub2 = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker2,
    title: '自定义子任务二',
    mode: 'direct',
    prompt: 'Prompt 2',
  }, adminCookie);
  assert.equal(sub2.status, 201);
  assert.equal(sub2.json.childSession.title, '自定义子任务二');
  assert.equal(sub2.json.childSession.mode, 'direct');
  assert.deepEqual(sub2.json.childSession.memberBotIds, [botWorker2]);

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

test('Sub-Session Delegation: 子会话执行失败时向父会话回传失败通知并唤醒父会话', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, mockRpcs, registerNodeWithBots, jsonRequest } = ctx;

  const nodeId = 'node_fail_test';
  const botLead = 'bot_lead_f';
  const botWorker = 'bot_worker_f';
  registerNodeWithBots(adminUser.id, nodeId, [botLead, botWorker]);

  const turnsCalled: string[] = [];
  mockRpcs.set(nodeId, {
    runTurn: async (input: any) => {
      turnsCalled.push(input.botId);
      if (input.botId === botWorker) {
        throw new Error('模拟子任务执行崩溃');
      }
      return {
        replyText: '已收到子任务执行失败通知，正在处理降级方案。',
        modelBadge: 'openai/gpt-4o',
      };
    },
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '失败测试群',
    mode: 'direct',
    leadBotId: botLead,
    memberBotIds: [botLead],
  }, adminCookie);
  const parentSession: SessionRecord = parentRes.json;

  const delegateRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker,
    prompt: '执行高危任务',
  }, adminCookie);
  assert.equal(delegateRes.status, 201);
  const delegateResult: DelegateSessionResult = delegateRes.json;

  // 等待父会话收到失败通知 callback 消息
  await waitFor(() => {
    const parentMessages = hub.db.getMessages(parentSession.id);
    return parentMessages.some((m) => m.role === 'callback' && m.content.includes('执行失败'));
  });

  const parentMessages = hub.db.getMessages(parentSession.id);
  const failCallback = parentMessages.find((m) => m.role === 'callback' && m.content.includes('执行失败'));
  assert.ok(failCallback, '父会话中必须存在失败通知回调消息');
  assert.equal(failCallback.senderBotId, botWorker);
  assert.ok(
    failCallback.content.includes(`❌ 子会话「[${delegateResult.childSession.title}](#?s=${delegateResult.childSession.id})」执行失败：`),
    `失败通知格式不匹配: ${failCallback.content}`
  );
  assert.ok(
    failCallback.content.includes('模拟子任务执行崩溃'),
    `失败通知应包含 system 报错详情: ${failCallback.content}`
  );

  // 验证父会话 Lead Bot 收到唤醒并执行了异常处理回合
  await waitFor(() => {
    const msgs = hub.db.getMessages(parentSession.id);
    return msgs.some((m) => m.role === 'assistant' && m.senderBotId === botLead);
  });
  assert.ok(turnsCalled.includes(botLead), '父会话 leadBot 应被自动唤醒');
});

test('Sub-Session Delegation: 产物文件关联/复制至子会话', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, mockRpcs, registerNodeWithBots, jsonRequest } = ctx;

  const nodeId = 'node_art_test';
  const botLead = 'bot_lead_art';
  const botWorker = 'bot_worker_art';
  registerNodeWithBots(adminUser.id, nodeId, [botLead, botWorker]);

  mockRpcs.set(nodeId, {
    runTurn: async () => ({ replyText: '已分析关联产物', modelBadge: 'test' }),
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '产物传递测试群',
    mode: 'direct',
    leadBotId: botLead,
    memberBotIds: [botLead],
  }, adminCookie);
  const parentSession: SessionRecord = parentRes.json;

  // 在父会话创建一条产物
  const parentArt = hub.db.createArtifact({
    id: 'art_parent_file_1',
    sessionId: parentSession.id,
    filename: 'data_report.csv',
    mimeType: 'text/csv',
    sizeBytes: 2048,
    senderBotId: botLead,
    storagePath: '/tmp/data_report.csv',
  });

  // 委派时指定 artifactIds
  const delegateRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker,
    prompt: '请分析该数据报表',
    artifactIds: [parentArt.id],
  }, adminCookie);
  assert.equal(delegateRes.status, 201);
  const delegateResult: DelegateSessionResult = delegateRes.json;

  // 1. 验证子会话初始消息带有 attachments
  assert.ok(delegateResult.initialMessage.attachments);
  assert.equal(delegateResult.initialMessage.attachments.length, 1);
  assert.equal(delegateResult.initialMessage.attachments[0].filename, 'data_report.csv');
  assert.ok(delegateResult.initialMessage.content.includes('data_report.csv'));

  // 2. 验证子会话 artifacts 列表中已记录此产物
  const childArtifacts = hub.db.listSessionArtifacts(delegateResult.childSession.id);
  assert.equal(childArtifacts.length, 1);
  assert.equal(childArtifacts[0].filename, 'data_report.csv');
  assert.equal(childArtifacts[0].sessionId, delegateResult.childSession.id);
});

test('Sub-Session Delegation: 显式 artifactIds: [] 不携带产物，undefined 则继承全部父会话产物', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, mockRpcs, registerNodeWithBots, jsonRequest } = ctx;

  const nodeId = 'node_art_empty';
  const botLead = 'bot_lead_art_e';
  const botWorker = 'bot_worker_art_e';
  registerNodeWithBots(adminUser.id, nodeId, [botLead, botWorker]);

  mockRpcs.set(nodeId, {
    runTurn: async () => ({ replyText: 'ok', modelBadge: 'test' }),
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '空产物测试群',
    mode: 'direct',
    leadBotId: botLead,
    memberBotIds: [botLead],
  }, adminCookie);
  const parentSession: SessionRecord = parentRes.json;

  // 父会话预置两条产物
  for (let i = 1; i <= 2; i++) {
    hub.db.createArtifact({
      id: `art_seed_${i}`,
      sessionId: parentSession.id,
      filename: `seed_${i}.csv`,
      mimeType: 'text/csv',
      sizeBytes: 100 + i,
      senderBotId: botLead,
      storagePath: `/tmp/botd-seed-${i}.csv`,
    });
  }

  // 1. 显式传 artifactIds: [] —— 不携带任何产物
  const emptyRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker,
    prompt: '干净上下文执行',
    artifactIds: [],
  }, adminCookie);
  assert.equal(emptyRes.status, 201, JSON.stringify(emptyRes.json));
  assert.equal(emptyRes.json.initialMessage.attachments, undefined);
  assert.equal(hub.db.listSessionArtifacts(emptyRes.json.childSession.id).length, 0);
  assert.equal(
    emptyRes.json.initialMessage.content.includes('[关联产物文件]'),
    false,
    '显式空 artifactIds 时初始消息不应追加产物清单'
  );

  // 2. 不传 artifactIds（undefined）—— 继承父会话全部产物
  const inheritRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker,
    prompt: '继承全部产物',
  }, adminCookie);
  assert.equal(inheritRes.status, 201, JSON.stringify(inheritRes.json));
  assert.equal(inheritRes.json.initialMessage.attachments.length, 2);
  assert.equal(hub.db.listSessionArtifacts(inheritRes.json.childSession.id).length, 2);
});

test('Sub-Session Delegation: 团队共享 bot 可被其他用户委派，私有 bot 仍 403', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, createUser, registerNodeWithBots, jsonRequest } = ctx;

  const { user: owner2 } = await createUser('teamOwner', '{{SECRET_8shdmfy2}}');

  // 另一用户节点上的两个 bot：一个团队共享、一个私有
  registerNodeWithBots(owner2.id, 'node_team', ['bot_team_shared', 'bot_team_private']);
  hub.db.saveBot({ ...hub.db.getBot('bot_team_shared')!, visibility: 'team' });

  // 管理员自己的节点与主控 bot
  registerNodeWithBots(adminUser.id, 'node_admin_x', ['bot_admin_x']);

  // 管理员自己的父会话
  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '跨用户团队协同',
    mode: 'direct',
    leadBotId: 'bot_admin_x',
    memberBotIds: ['bot_admin_x'],
  }, adminCookie);
  assert.equal(parentRes.status, 200);
  const parentSession: SessionRecord = parentRes.json;

  // 1. 委派给其他用户的团队共享 bot -> 201
  const teamRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: 'bot_team_shared',
    prompt: '请以团队身份执行任务',
  }, adminCookie);
  assert.equal(teamRes.status, 201, `Delegate to team bot should succeed: ${JSON.stringify(teamRes.json)}`);
  assert.equal(teamRes.json.childSession.leadBotId, 'bot_team_shared');
  assert.equal(hub.db.getSession(teamRes.json.childSession.id)?.ownerId, adminUser.id);

  // 2. 委派给其他用户的私有 bot -> 403
  const privateRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: 'bot_team_private',
    prompt: 'should be forbidden',
  }, adminCookie);
  assert.equal(privateRes.status, 403);

  // 3. 子会话消息可正常读取（权限链路完整）
  const childMessages = hub.db.getMessages(teamRes.json.childSession.id);
  assert.equal(childMessages.length, 1);
  assert.equal(childMessages[0].role, 'user');
});

test('Sub-Session Delegation: 并发多子会话 All-Settled Barrier —— 全部收敛后才唤醒父会话且仅唤醒一次', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, mockRpcs, registerNodeWithBots, jsonRequest } = ctx;

  const nodeId = 'node_barrier';
  const botLead = 'bot_lead';
  const botWorker1 = 'bot_worker1';
  const botWorker2 = 'bot_worker2';
  registerNodeWithBots(adminUser.id, nodeId, [botLead, botWorker1, botWorker2]);

  const leadTurns: any[] = [];
  const workerResolvers = new Map<string, () => void>();

  mockRpcs.set(nodeId, {
    runTurn: (input: any) =>
      new Promise<any>((resolve) => {
        if (input.botId === botLead) {
          leadTurns.push(input);
          resolve({ replyText: '汇总完成', modelBadge: 'test' });
          return;
        }
        // worker 回合挂起，测试端显式放行以精确控制完成时序
        workerResolvers.set(input.botId, () =>
          resolve({ replyText: `${input.botId} 完成`, modelBadge: 'test' })
        );
      }),
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: 'Barrier 测试群',
    mode: 'direct',
    leadBotId: botLead,
    memberBotIds: [botLead],
  }, adminCookie);
  const parentSession: SessionRecord = parentRes.json;

  // 并发派发两个子会话
  const [sub1, sub2] = await Promise.all([
    jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
      botId: botWorker1,
      title: '任务一',
      prompt: '并发任务一',
    }, adminCookie),
    jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
      botId: botWorker2,
      title: '任务二',
      prompt: '并发任务二',
    }, adminCookie),
  ]);
  assert.equal(sub1.status, 201, JSON.stringify(sub1.json));
  assert.equal(sub2.status, 201, JSON.stringify(sub2.json));

  const child1Id = sub1.json.childSession.id as string;
  const child2Id = sub2.json.childSession.id as string;

  // 两个 worker 回合均已进入 running（挂起中）
  await waitFor(() => workerResolvers.size === 2);
  await waitFor(() => {
    const subs = hub.db.listSubSessions(parentSession.id);
    return subs.filter((s) => s.status === 'running').length === 2;
  });

  // 放行 worker1：此时 worker2 仍在 running，Barrier 应阻止唤醒 bot_lead
  workerResolvers.get(botWorker1)!();
  await waitFor(() =>
    hub.db
      .getMessages(parentSession.id)
      .some((m) => m.role === 'callback' && m.content.includes('任务一') && m.content.includes('已完成'))
  );

  assert.equal(
    workerResolvers.has(botLead),
    false,
    'Barrier 生效：worker2 未完成时父会话主控 Bot 不得被唤醒'
  );
  assert.equal(leadTurns.length, 0);
  assert.equal(
    hub.db.getMessages(parentSession.id).some((m) => m.role === 'assistant' && m.senderBotId === botLead),
    false,
    'bot_lead 在 Barrier 收敛前不得产生任何 assistant 回复'
  );
  assert.equal(hub.db.getSession(child2Id)?.status, 'running', 'bot_worker2 子会话应仍在运行');

  // 放行 worker2：全部子会话收敛，Barrier 放行最后一次唤醒
  workerResolvers.get(botWorker2)!();
  await waitFor(() =>
    hub.db
      .getMessages(parentSession.id)
      .some((m) => m.role === 'callback' && m.content.includes('任务二') && m.content.includes('已完成'))
  );
  await waitFor(() =>
    hub.db
      .getMessages(parentSession.id)
      .some((m) => m.role === 'assistant' && m.senderBotId === botLead)
  );

  assert.ok(leadTurns.length >= 1, '全部子会话完成后 bot_lead 应被唤醒');
  assert.equal(leadTurns.length, 1, 'bot_lead 应恰好被唤醒一次，而不是被两个子会话分别唤醒');
  // 唤醒回合的增量输入应同时包含两份完成汇报
  assert.ok(leadTurns[0].incrementalMessages.includes('任务一'));
  assert.ok(leadTurns[0].incrementalMessages.includes('任务二'));
});

test('Sub-Session Delegation: autoWakeParent: false 仅落库完成回调，不唤醒父会话主控 Bot', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser, adminCookie, mockRpcs, registerNodeWithBots, jsonRequest } = ctx;

  const nodeId = 'node_autowake';
  const botLead = 'bot_lead_nw';
  const botWorker = 'bot_worker_nw';
  registerNodeWithBots(adminUser.id, nodeId, [botLead, botWorker]);

  const turnsCalled: string[] = [];
  mockRpcs.set(nodeId, {
    runTurn: async (input: any) => {
      turnsCalled.push(input.botId);
      if (input.botId === botWorker) {
        return { replyText: '静默子任务完成', modelBadge: 'test' };
      }
      return { replyText: 'should not run', modelBadge: 'test' };
    },
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '静默委派测试群',
    mode: 'direct',
    leadBotId: botLead,
    memberBotIds: [botLead],
  }, adminCookie);
  const parentSession: SessionRecord = parentRes.json;

  const delegateRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker,
    title: '静默任务',
    prompt: '静默执行，勿打扰父会话',
    autoWakeParent: false,
  }, adminCookie);
  assert.equal(delegateRes.status, 201, JSON.stringify(delegateRes.json));
  const delegateResult: DelegateSessionResult = delegateRes.json;

  // 等待完成回调落库
  await waitFor(() =>
    hub.db
      .getMessages(parentSession.id)
      .some((m) => m.role === 'callback' && m.content.includes('静默任务') && m.content.includes('已完成'))
  );

  // 回调消息必须存在且带摘要
  const parentMessages = hub.db.getMessages(parentSession.id);
  const completionMsg = parentMessages.find(
    (m) => m.role === 'callback' && m.content.includes('静默任务') && m.content.includes('已完成')
  );
  assert.ok(completionMsg, 'autoWakeParent=false 时完成回调消息仍应落库');
  assert.equal(completionMsg.senderBotId, botWorker);
  assert.ok(completionMsg.content.includes('静默子任务完成'));

  // 等待潜在（不应发生的）异步唤醒落地
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    turnsCalled.includes(botLead),
    false,
    'autoWakeParent=false 时父会话主控 Bot 不得被唤醒'
  );
  assert.equal(
    hub.db.getMessages(parentSession.id).some((m) => m.role === 'assistant' && m.senderBotId === botLead),
    false,
    'autoWakeParent=false 时父会话不得出现主控 Bot 的 assistant 消息'
  );
  assert.equal(hub.db.getSession(delegateResult.childSession.id)?.status, 'idle');
});

test('buildGroupContextPrompt: 注入可协同的其他主 BOT 与 delegate_bot 协同规范', async (t) => {
  const ctx = await createTestContext(t);
  const { hub, adminUser } = ctx;

  // 主 bot（无 parentBotId）：当前视角 bot，位于本机节点
  hub.db.createNode({
    id: 'node_prompt_local',
    name: 'Local Node',
    platform: 'linux',
    tokenHash: 'dummy_hash',
    ownerId: adminUser.id,
  });
  hub.db.saveBot({
    id: 'bot_prompt_me',
    nodeId: 'node_prompt_local',
    name: 'My Primary',
    description: '当前主控',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  } as BotConfig);

  // 跨节点团队共享主 bot
  hub.db.createNode({
    id: 'node_prompt_peer',
    name: 'Peer Node',
    platform: 'linux',
    tokenHash: 'dummy_hash',
    ownerId: adminUser.id,
  });
  hub.db.saveBot({
    id: 'bot_prompt_peer',
    nodeId: 'node_prompt_peer',
    name: 'Peer Primary',
    description: '跨节点数据工程师',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: ['data-analysis'],
    enabledExtensions: [],
    visibility: 'team',
    updatedAt: new Date().toISOString(),
  } as BotConfig);

  // 我自己的子代理：不应出现在跨主 BOT 列表中
  hub.db.saveBot({
    id: 'bot_prompt_sub',
    nodeId: 'node_prompt_local',
    name: 'My Subagent',
    description: '子代理',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
    parentBotId: 'bot_prompt_me',
  } as BotConfig);

  const session = hub.db.createSession({
    id: 'sess_prompt_ctx',
    title: 'Prompt 注入测试',
    mode: 'direct',
    leadBotId: 'bot_prompt_me',
    memberBotIds: ['bot_prompt_me'],
    ownerId: adminUser.id,
  });

  const prompt = buildGroupContextPrompt(session, hub.db, 'bot_prompt_me');

  // 注入跨主 BOT 协同区块
  assert.ok(
    prompt.includes('### 🌐 可协同的其他主 BOT (跨节点 / 独立工作区)'),
    `Prompt 应包含跨主 BOT 区块：\n${prompt}`
  );
  // 列出 peer 主 bot（含节点名与团队共享标签），排除自身与子代理
  assert.ok(prompt.includes('@bot_prompt_peer'));
  assert.ok(prompt.includes('Peer Primary'));
  assert.ok(prompt.includes('跨节点数据工程师'));
  assert.ok(prompt.includes('节点:Peer Node·离线'));
  assert.ok(prompt.includes('团队共享'));
  assert.ok(prompt.includes('技能:data-analysis'));
  assert.ok(!prompt.includes('@bot_prompt_sub'), '子代理不得出现在跨主 BOT 列表');
  const peerBlock = prompt.split('### 🌐 可协同的其他主 BOT')[1] ?? '';
  assert.ok(!peerBlock.includes('@bot_prompt_me'), '不得把当前 bot 自身列为协同对象');

  // 注入 delegate_bot / SubagentWorkflow 使用规范
  assert.ok(prompt.includes('【跨 BOT 协同规范】'));
  assert.ok(prompt.includes('`delegate_bot`'));
  assert.ok(prompt.includes('`SubagentWorkflow`'));
  assert.ok(prompt.includes('agentType: "<botId>"'));
  assert.ok(prompt.includes('phase: "<阶段名>"'));
  assert.ok(prompt.includes('优先使用 `Agent` / `SubagentWorkflow`'));

  // 不传 db 时不注入该区块
  const promptNoDb = buildGroupContextPrompt(session);
  assert.ok(!promptNoDb.includes('可协同的其他主 BOT'));
});
