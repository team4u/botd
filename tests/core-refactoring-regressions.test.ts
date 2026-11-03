import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { startHub } from '../apps/hub/src/index.js';
import {
  isSafeId,
  isValidBotEnvKey,
  isBotConfig,
  serializeRpcMessage,
  type BotConfig,
  type HubRpcFunctions,
  type MessageRecord,
  type NodeRpcFunctions,
  type ProviderLoginState,
  type SessionRecord,
  type ThinkingLevel,
} from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';

const PASSWORD = 'integration-password';

const waitFor = async <T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeout = 10_000
): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for expected condition');
};

async function createHubFixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-core-regr-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  process.env.BOTD_HUB_DATA_DIR = dir;

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath,
    adminPassword: PASSWORD,
  });

  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];

  t.after(async () => {
    for (const socket of sockets) {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
    }
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  let adminCookie = '';
  const request = async (
    route: string,
    method = 'GET',
    body?: unknown,
    authenticated = true,
    cookieOverride?: string
  ) => {
    const effectiveCookie = cookieOverride ?? adminCookie;
    return fetch(base + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authenticated && effectiveCookie ? { cookie: effectiveCookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  const loginRes = await request('/api/auth/login', 'POST', { username: 'admin', password: PASSWORD });
  assert.equal(loginRes.status, 200);
  adminCookie = loginRes.headers.get('set-cookie')!.split(';')[0];

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
    const requestAs = (route: string, method = 'GET', body?: unknown) =>
      request(route, method, body, true, cookieHeader);
    return { json: jsonAs, request: requestAs };
  };

  const addNode = async (
    botInputs: (string | BotConfig)[],
    runTurn?: NodeRpcFunctions['runTurn'],
    cancelTurn?: NodeRpcFunctions['cancelTurn'],
    extensions: string[] = ['demo-ext'],
    cookieOverride?: string
  ) => {
    const jsonAs = cookieOverride ? forUser(cookieOverride).json : json;
    const pairing = await jsonAs('/api/nodes/pairing', 'POST');
    assert.match(pairing.code, /^\d{6}$/);

    const identity = await jsonAs('/api/nodes/pairing/exchange', 'POST', {
      code: pairing.code,
      name: 'Regression test node',
      platform: 'linux',
    });

    const bots: BotConfig[] = botInputs.map((input) => {
      if (typeof input === 'string') {
        return {
          id: input,
          nodeId: identity.nodeId,
          name: input,
          description: '',
          modelProvider: 'openai',
          modelId: 'gpt-4o',
          thinkingLevel: 'medium' as ThinkingLevel,
          enabledSkills: [],
          updatedAt: new Date().toISOString(),
        };
      }
      return {
        ...input,
        nodeId: identity.nodeId,
      };
    });

    const socket = new WebSocket(
      `${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`
    );
    sockets.push(socket);

    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
      {
        getModelCatalog: async () => getBuiltinModelCatalog(),
        startProviderLogin: async () => ({
          id: 'mock_login',
          providerId: 'openai',
          method: 'api_key',
          status: 'success',
          events: [],
        }),
        getProviderLogin: async () => ({
          id: 'mock_login',
          providerId: 'openai',
          method: 'api_key',
          status: 'success',
          events: [],
        }),
        respondProviderLogin: async () => ({
          id: 'mock_login',
          providerId: 'openai',
          method: 'api_key',
          status: 'success',
          events: [],
        }),
        cancelProviderLogin: async () => {},
        logoutProvider: async () => {},
        saveBot: async (bot) => {
          const idx = bots.findIndex((b) => b.id === bot.id);
          if (idx < 0) bots.push(bot);
          else bots[idx] = bot;
        },
        deleteBot: async (id) => {
          const idx = bots.findIndex((b) => b.id === id);
          if (idx >= 0) bots.splice(idx, 1);
        },
        readFile: async () => '',
        writeFile: async () => {},
        installResource: async (input) => ({ kind: 'skill', id: input.customId || 'installed' }),
        deleteResource: async () => {},
        restartDaemon: async () => ({ ok: true as const, pid: 1234 }),
        getCommands: async () => [],
        runTurn: runTurn ?? (async (input) => ({
          replyText: `Reply from ${input.botId}`,
          modelBadge: 'openai/gpt-4o',
        })),
        cancelTurn: cancelTurn ?? (async () => {}),
        resetSession: async () => {},
      },
      {
        post: (data) => socket.send(data),
        on: (cb) => socket.on('message', (data) => cb(data.toString())),
        serialize: serializeRpcMessage,
        deserialize: JSON.parse,
        timeout: 10_000,
      }
    );

    await once(socket, 'open');
    await rpc.registerNode({
      nodeId: identity.nodeId,
      name: 'Regression test node',
      platform: 'linux',
      bots,
      skills: ['demo'],
      extensions,
    });

    return { identity, bots, socket, rpc };
  };

  const messages = (id: string) => json<MessageRecord[]>(`/api/sessions/${id}/messages`);
  const idle = async (id: string) =>
    waitFor(
      () => json<SessionRecord[]>('/api/sessions'),
      (list) => list.find((s) => s.id === id)?.status !== 'running'
    );

  return {
    hub,
    base,
    request,
    json,
    addNode,
    messages,
    idle,
    loginAs,
    forUser,
    cookie: () => adminCookie,
  };
}

// -------------------------------------------------------------------------------------------------
// 测试 1：全量 7 档 ThinkingLevel（off, minimal, low, medium, high, xhigh, max）
// -------------------------------------------------------------------------------------------------
test('全量 7 档 ThinkingLevel 在节点 registerNode 与 HTTP /api/bots 中的完整支持', async (t) => {
  const f = await createHubFixture(t);

  const allLevels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  const botsWithAllLevels: BotConfig[] = allLevels.map((level) => ({
    id: `bot_${level}`,
    nodeId: '',
    name: `Bot ${level}`,
    description: `Bot with thinkingLevel ${level}`,
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: level,
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  }));

  const { identity } = await f.addNode(botsWithAllLevels);

  // 1. GET /api/nodes: 断言注册成功且每个 BOT 保留了对应的 thinkingLevel
  const nodes = await f.json<any[]>('/api/nodes');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].bots.length, allLevels.length);

  for (const level of allLevels) {
    const found = nodes[0].bots.find((b: any) => b.id === `bot_${level}`);
    assert(found, `Bot bot_${level} should be found in registered node bots`);
    assert.equal(found.thinkingLevel, level, `Bot bot_${level} should have thinkingLevel '${level}'`);
  }

  // 2. HTTP POST /api/bots: 支持创建指定 thinkingLevel 的 BOT
  const postRes = await f.json<BotConfig>('/api/bots', 'POST', {
    id: 'bot_http_max',
    nodeId: identity.nodeId,
    parentBotId: 'bot_off',
    name: 'HTTP Max Bot',
    description: 'Created via HTTP with max thinking level',
    modelProvider: 'openai',
    modelId: 'o3-mini',
    thinkingLevel: 'max',
    enabledSkills: [],
    systemMd: 'You are an expert analyst.',
  });
  assert.equal(postRes.id, 'bot_http_max');
  assert.equal(postRes.thinkingLevel, 'max');

  // 3. HTTP PUT /api/bots/:botId: 支持修改 thinkingLevel 为任意有效档位
  const putMinimalRes = await f.json<BotConfig>('/api/bots/bot_http_max', 'PUT', {
    thinkingLevel: 'minimal',
  });
  assert.equal(putMinimalRes.thinkingLevel, 'minimal');

  const putOffRes = await f.json<BotConfig>('/api/bots/bot_http_max', 'PUT', {
    thinkingLevel: 'off',
  });
  assert.equal(putOffRes.thinkingLevel, 'off');

  const putXhighRes = await f.json<BotConfig>('/api/bots/bot_http_max', 'PUT', {
    thinkingLevel: 'xhigh',
  });
  assert.equal(putXhighRes.thinkingLevel, 'xhigh');

  // 4. HTTP PUT /api/bots/:botId: 非法 thinkingLevel 返回 400
  const putInvalidRes = await f.request('/api/bots/bot_http_max', 'PUT', {
    thinkingLevel: 'super_ultra_high',
  });
  assert.equal(putInvalidRes.status, 400);

  // 5. 再次验证节点 BOT 列表中更新后的 thinkingLevel
  const nodesAfter = await f.json<any[]>('/api/nodes');
  const updatedBot = nodesAfter[0].bots.find((b: any) => b.id === 'bot_http_max');
  assert(updatedBot);
  assert.equal(updatedBot.thinkingLevel, 'xhigh');
});

// -------------------------------------------------------------------------------------------------
// 测试 2：删除会话（DELETE /api/sessions/:id）与删除用户（DELETE /api/users/:id）时物理清理磁盘上的 Artifact 文件
// -------------------------------------------------------------------------------------------------
test('删除会话与删除用户时物理清理磁盘上的 Artifact 文件', async (t) => {
  const f = await createHubFixture(t);

  // --- Part A: 会话删除触发物理清理 ---
  const sessionA = f.hub.db.createSession({
    id: 'sess_art_session_del',
    title: 'Artifact Session Deletion Test',
    leadBotId: 'bot_dummy',
    ownerId: 'user_admin',
  });

  const uploadResA = await f.json<{ id: string }>(`/api/sessions/${sessionA.id}/artifacts`, 'POST', {
    filename: 'session-doc.txt',
    mimeType: 'text/plain',
    contentBase64: Buffer.from('Content to be deleted on session delete').toString('base64'),
  });
  assert(uploadResA.id, 'Artifact upload should return id');

  const artRecordA = f.hub.db.getArtifactWithStoragePath(uploadResA.id);
  assert(artRecordA && artRecordA.storagePath, 'Artifact record with storage path must exist');
  assert(fs.existsSync(artRecordA.storagePath), 'Artifact file must exist on disk before session delete');

  const delSessionRes = await f.json<{ ok: boolean }>(`/api/sessions/${sessionA.id}`, 'DELETE');
  assert.equal(delSessionRes.ok, true);

  assert.equal(
    fs.existsSync(artRecordA.storagePath),
    false,
    'Artifact file must be physically removed from disk upon DELETE /api/sessions/:id'
  );

  // --- Part B: 用户删除级联会话并物理清理 Artifact ---
  const memberUser = await f.json<{ id: string }>('/api/users', 'POST', {
    username: 'artifact_victim',
    password: 'Password123!',
    role: 'member',
  });
  assert(memberUser.id);

  const memberCookie = await f.loginAs('artifact_victim', 'Password123!');
  const memberClient = f.forUser(memberCookie);

  const memberSession = f.hub.db.createSession({
    id: 'sess_art_user_del',
    title: 'Member User Artifact Session',
    leadBotId: 'bot_dummy',
    ownerId: memberUser.id,
  });

  const uploadResB = await memberClient.json<{ id: string }>(
    `/api/sessions/${memberSession.id}/artifacts`,
    'POST',
    {
      filename: 'user-private-data.bin',
      mimeType: 'application/octet-stream',
      contentBase64: Buffer.from('Sensitive member file payload').toString('base64'),
    }
  );
  assert(uploadResB.id);

  const artRecordB = f.hub.db.getArtifactWithStoragePath(uploadResB.id);
  assert(artRecordB && artRecordB.storagePath);
  assert(fs.existsSync(artRecordB.storagePath), 'Member artifact file must exist on disk before user delete');

  // 管理员调用 DELETE /api/users/:id
  const delUserRes = await f.json<{ ok: boolean }>(`/api/users/${memberUser.id}`, 'DELETE');
  assert.equal(delUserRes.ok, true);

  assert.equal(
    fs.existsSync(artRecordB.storagePath),
    false,
    'Member artifact file must be physically removed from disk upon DELETE /api/users/:id'
  );
});

// -------------------------------------------------------------------------------------------------
// 测试 3：协议层权威校验原语（isSafeId, isValidBotEnvKey, isBotConfig）一致性测试
// -------------------------------------------------------------------------------------------------
test('协议层权威校验原语（isSafeId, isValidBotEnvKey, isBotConfig）一致性测试', () => {
  // 1. isValidBotEnvKey
  // 合法 Key: 大小写、数字、下划线（不能以数字开头，不能有连字符/空格/特殊符号）
  const validEnvKeys = [
    'API_KEY',
    'api_key',
    'OpenAI_Key',
    'PORT_8080',
    '_INTERNAL_SETTING',
    'DATABASE_URL',
    'A',
    'z',
  ];
  for (const k of validEnvKeys) {
    assert.equal(isValidBotEnvKey(k), true, `Expected "${k}" to be a valid bot env key`);
  }

  // 保留环境变量名（大小写均必须拒绝）
  const reservedEnvKeys = [
    'PATH', 'path', 'Path',
    'PWD', 'pwd', 'Pwd',
    'HOME', 'home', 'Home',
    'USER', 'user', 'User',
    'SHELL', 'shell', 'Shell',
  ];
  for (const k of reservedEnvKeys) {
    assert.equal(isValidBotEnvKey(k), false, `Expected reserved key "${k}" to be rejected`);
  }

  // BOTD_ 前缀保护（大小写均必须拒绝）
  const botdPrefixedKeys = [
    'BOTD_TOKEN', 'botd_token',
    'BOTD_SECRET', 'botd_secret',
    'BOTD_PORT', 'Botd_Port',
    'BOTD_', 'botd_',
  ];
  for (const k of botdPrefixedKeys) {
    assert.equal(isValidBotEnvKey(k), false, `Expected botd-prefixed key "${k}" to be rejected`);
  }

  // 格式非法：数字开头、连字符、空格、特殊符号、非字符串
  const invalidEnvKeys: unknown[] = [
    '1API_KEY',
    '0_VAR',
    'MY-ENV-KEY',
    'foo-bar',
    'ENV KEY',
    'ENV.KEY',
    'KEY$VAR',
    'KEY/SLASH',
    '',
    null,
    undefined,
    12345,
    {},
    [],
  ];
  for (const k of invalidEnvKeys) {
    assert.equal(isValidBotEnvKey(k), false, `Expected invalid key ${JSON.stringify(k)} to be rejected`);
  }

  // 2. isSafeId
  const validIds = ['bot_1', 'node-2', 'user-abc_123', 'session-123-abc', 'ABC', 'a', '0'];
  for (const id of validIds) {
    assert.equal(isSafeId(id), true, `Expected "${id}" to be a safe id`);
  }

  const invalidIds: unknown[] = [
    '',
    'bot/1',
    '../node',
    'a b',
    'bot@node',
    'hello.world',
    'id!',
    'id:colon',
    null,
    undefined,
    123,
    {},
  ];
  for (const id of invalidIds) {
    assert.equal(isSafeId(id), false, `Expected ${JSON.stringify(id)} to be rejected by isSafeId`);
  }

  // 3. isBotConfig
  const baseConfig: BotConfig = {
    id: 'bot_alpha',
    nodeId: 'node_alpha',
    name: 'Alpha Bot',
    description: 'An AI assistant',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: ['skill-1'],
    enabledExtensions: ['ext-1'],
    updatedAt: new Date().toISOString(),
  };

  assert.equal(isBotConfig(baseConfig), true);

  // 7 档合法 ThinkingLevel 均通过
  const allLevels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  for (const tl of allLevels) {
    assert.equal(isBotConfig({ ...baseConfig, thinkingLevel: tl }), true);
  }

  // thinkingLevel 为 undefined 时也允许
  const { thinkingLevel: _, ...withoutTl } = baseConfig;
  assert.equal(isBotConfig(withoutTl), true);

  // 非法 thinkingLevel
  assert.equal(isBotConfig({ ...baseConfig, thinkingLevel: 'super_high' as any }), false);
  assert.equal(isBotConfig({ ...baseConfig, thinkingLevel: 'none' as any }), false);
  assert.equal(isBotConfig({ ...baseConfig, thinkingLevel: '' as any }), false);

  // 字段缺失或格式非法
  assert.equal(isBotConfig({ ...baseConfig, id: 'bad/id' }), false);
  assert.equal(isBotConfig({ ...baseConfig, nodeId: 'bad/node' }), false);
  assert.equal(isBotConfig({ ...baseConfig, name: '' }), false);
  assert.equal(isBotConfig({ ...baseConfig, name: '   ' }), false);
  assert.equal(isBotConfig({ ...baseConfig, modelProvider: '' }), false);
  assert.equal(isBotConfig({ ...baseConfig, modelId: '' }), false);
  assert.equal(isBotConfig({ ...baseConfig, enabledSkills: ['bad/skill'] }), false);
  assert.equal(isBotConfig({ ...baseConfig, enabledExtensions: ['bad/ext'] }), false);
  assert.equal(isBotConfig(null), false);
  assert.equal(isBotConfig([]), false);
  assert.equal(isBotConfig('string'), false);
});

// -------------------------------------------------------------------------------------------------
// 测试 4：GroupRouter 串/并行统一管线的回合执行与错误隔离验证
// -------------------------------------------------------------------------------------------------
test('GroupRouter 串/并行统一管线的回合执行与错误隔离验证', async (t) => {
  const f = await createHubFixture(t);

  const deliveredIncremental = new Map<string, string[]>();
  let failingBotId: string | null = null;

  await f.addNode(
    [
      {
        id: 'lead_bot',
        nodeId: '',
        name: 'Lead Bot',
        description: 'Session Leader',
        modelProvider: 'openai',
        modelId: 'gpt-4o',
        thinkingLevel: 'medium',
        enabledSkills: [],
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'member_a',
        nodeId: '',
        name: 'Member A',
        description: 'Reviewer A',
        modelProvider: 'openai',
        modelId: 'gpt-4o',
        thinkingLevel: 'medium',
        enabledSkills: [],
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'member_b',
        nodeId: '',
        name: 'Member B',
        description: 'Reviewer B',
        modelProvider: 'openai',
        modelId: 'gpt-4o',
        thinkingLevel: 'medium',
        enabledSkills: [],
        updatedAt: new Date().toISOString(),
      },
    ],
    async (input) => {
      const history = deliveredIncremental.get(input.botId) ?? [];
      history.push(input.incrementalMessages);
      deliveredIncremental.set(input.botId, history);

      if (input.botId === failingBotId) {
        throw new Error(`Turn execution exploded for @${input.botId}`);
      }

      return {
        replyText: `Review reply from @${input.botId}`,
        modelBadge: 'openai/gpt-4o',
      };
    }
  );

  // --- Part 4: 单主控 Bot 回合执行与错误隔离验证 ---
  failingBotId = null;
  deliveredIncremental.clear();

  const normalSession = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: 'Normal Direct Session',
    leadBotId: 'lead_bot',
  });

  await f.json(`/api/sessions/${normalSession.id}/messages`, 'POST', {
    content: 'User message to lead bot',
  });

  await waitFor(
    () => f.messages(normalSession.id),
    (msgs) => msgs.some((m) => m.senderBotId === 'lead_bot')
  );
  await f.idle(normalSession.id);

  const normalMessages = await f.messages(normalSession.id);
  const leadReply = normalMessages.find((m) => m.role === 'assistant' && m.senderBotId === 'lead_bot');
  assert(leadReply, 'lead_bot reply must exist and succeed');
  assert.equal(leadReply.content, 'Review reply from @lead_bot');

  const finalNormalSess = (await f.json<SessionRecord[]>('/api/sessions')).find((s) => s.id === normalSession.id);
  assert.equal(finalNormalSess?.status, 'idle', 'Successful session must end in idle status');

  // 失败隔离验证
  failingBotId = 'lead_bot';
  deliveredIncremental.clear();

  const failSession = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: 'Failing Direct Session',
    leadBotId: 'lead_bot',
  });

  await f.json(`/api/sessions/${failSession.id}/messages`, 'POST', {
    content: 'User message causing turn error',
  });

  await waitFor(
    () => f.json<SessionRecord[]>('/api/sessions'),
    (list) => list.find((s) => s.id === failSession.id)?.status === 'failed'
  );

  const failMessages = await f.messages(failSession.id);
  const sysMsg = failMessages.find((m) => m.role === 'system' && m.content.includes('lead_bot'));
  assert(sysMsg, 'System error message must be recorded for failed bot turn');
  assert(sysMsg.content.includes('Turn execution exploded for @lead_bot'));

  const finalFailSess = (await f.json<SessionRecord[]>('/api/sessions')).find((s) => s.id === failSession.id);
  assert.equal(finalFailSess?.status, 'failed', 'Failing session must terminate with failed status');
});
