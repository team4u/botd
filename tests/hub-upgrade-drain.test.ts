import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { startHub } from '../apps/hub/src/index.js';
import { HubDatabase, HUB_SCHEMA_VERSION } from '../apps/hub/src/db.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import type {
  BotConfig,
  HubRpcFunctions,
  MessageRecord,
  NodeRecord,
  NodeRpcFunctions,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
  SessionRecord,
} from '../packages/protocol/src/index.js';

const PASSWORD = 'upgrade-drain-password';

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for the expected state');
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

async function createTestFixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-upgrade-drain-test-'));
  const hub = await startHub({
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
    for (const socket of sockets) {
      socket.terminate();
    }
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  let cookie = '';
  const request = async (
    route: string,
    method = 'GET',
    body?: unknown,
    authenticated = true,
    cookieOverride?: string
  ) => {
    const effectiveCookie = cookieOverride ?? cookie;
    return fetch(base + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authenticated && effectiveCookie ? { cookie: effectiveCookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

  const loginAs = async (username: string, pass: string): Promise<string> => {
    const response = await request('/api/auth/login', 'POST', { username, password: pass }, false);
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

  const addNode = async (options?: {
    ids?: string[];
    version?: string;
    checkUpgrade?: NodeRpcFunctions['checkUpgrade'];
    upgradeDaemon?: NodeRpcFunctions['upgradeDaemon'];
    runTurn?: NodeRpcFunctions['runTurn'];
    cookieOverride?: string;
  }) => {
    const ids = options?.ids ?? ['bot-1'];
    const jsonAs = options?.cookieOverride ? forUser(options.cookieOverride).json : json;
    const pairing = await jsonAs('/api/nodes/pairing', 'POST');
    assert.match(pairing.code, /^\d{6}$/);

    const identity = await jsonAs('/api/nodes/pairing/exchange', 'POST', {
      code: pairing.code,
      name: 'Upgrade Drain Node',
      platform: 'linux',
    });

    const bots: BotConfig[] = ids.map((id) => ({
      id,
      nodeId: identity.nodeId,
      name: id,
      description: '',
      modelProvider: 'openai',
      modelId: 'test-model',
      thinkingLevel: 'medium',
      enabledSkills: [],
      updatedAt: new Date().toISOString(),
    }));

    const socket = new WebSocket(
      `${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`
    );
    sockets.push(socket);

    const rpcFunctions: Partial<NodeRpcFunctions> = {
      getModelCatalog: async () => getBuiltinModelCatalog(),
      getCommands: async () => [],
      restartDaemon: async () => ({ ok: true as const, pid: 4242 }),
      runTurn: options?.runTurn ?? (async (input) => ({
        replyText: `Reply from ${input.botId}`,
        modelBadge: 'openai/test-model',
      })),
      cancelTurn: async () => {},
    };

    if (options?.checkUpgrade) {
      rpcFunctions.checkUpgrade = options.checkUpgrade;
    }
    if (options?.upgradeDaemon) {
      rpcFunctions.upgradeDaemon = options.upgradeDaemon;
    }

    const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(rpcFunctions as NodeRpcFunctions, {
      post: (data) => socket.send(data),
      on: (callback) => socket.on('message', (data) => callback(data.toString())),
      serialize: serializeRpcMessage,
      deserialize: JSON.parse,
      timeout: 10_000,
    });

    await once(socket, 'open');
    await rpc.registerNode({
      nodeId: identity.nodeId,
      name: 'Upgrade Drain Node',
      platform: 'linux',
      bots,
      skills: ['demo-skill'],
      extensions: ['demo-ext'],
      version: options?.version,
    });

    return { identity, bots, socket, rpc };
  };

  return { hub, base, dir, request, json, loginAs, forUser, addNode, cookie: () => cookie };
}

test('1. 节点 registerNode 上报 version: "0.2.1" 后，GET /api/nodes 能正确返回 node.version === "0.2.1"', async (t) => {
  const f = await createTestFixture(t);

  const nodeWithVersion = await f.addNode({ ids: ['v-bot-1'], version: '0.2.1' });
  const nodes = await f.json<Array<NodeRecord & { bots: BotConfig[] }>>('/api/nodes');
  const matched = nodes.find((n) => n.id === nodeWithVersion.identity.nodeId);

  assert(matched, 'Registered node should be present in GET /api/nodes');
  assert.equal(matched.version, '0.2.1', 'Node version should match the reported version');

  // Verify node without version omits version property or keeps it undefined
  const nodeWithoutVersion = await f.addNode({ ids: ['v-bot-2'] });
  const nodesAfter = await f.json<Array<NodeRecord & { bots: BotConfig[] }>>('/api/nodes');
  const matchedNoVer = nodesAfter.find((n) => n.id === nodeWithoutVersion.identity.nodeId);
  assert(matchedNoVer, 'Node without version should be present');
  assert.equal(matchedNoVer.version, undefined, 'Node without version should not have version defined');
});

test('2. GET /api/nodes/:nodeId/upgrade/check 与 POST /api/nodes/:nodeId/upgrade 能正确转发给节点 RPC 并返回结果，离线节点返回 503，非 owner 返回 403', async (t) => {
  const f = await createTestFixture(t);

  let checkCalledWith: { registryUrl?: string } | undefined;
  let upgradeCalledWith: { targetVersion?: string; registryUrl?: string } | undefined;

  const mockCheckUpgrade = async (opts?: { registryUrl?: string }): Promise<NodeUpgradeCheckResult> => {
    checkCalledWith = opts;
    return {
      currentVersion: '0.2.1',
      latestVersion: '0.3.0',
      updateAvailable: true,
    };
  };

  const mockUpgradeDaemon = async (opts?: { targetVersion?: string; registryUrl?: string }): Promise<NodeUpgradeResult> => {
    upgradeCalledWith = opts;
    return {
      ok: true,
      previousVersion: '0.2.1',
      targetVersion: opts?.targetVersion ?? '0.3.0',
      upgraded: true,
      pid: 5678,
    };
  };

  const node = await f.addNode({
    ids: ['upgrade-bot'],
    version: '0.2.1',
    checkUpgrade: mockCheckUpgrade,
    upgradeDaemon: mockUpgradeDaemon,
  });

  const nodeId = node.identity.nodeId;

  // 2.1 GET /api/nodes/:nodeId/upgrade/check - success case
  const checkRes = await f.request(`/api/nodes/${nodeId}/upgrade/check?registryUrl=https://npm.example.com`);
  assert.equal(checkRes.status, 200);
  const checkBody = (await checkRes.json()) as NodeUpgradeCheckResult;
  assert.equal(checkBody.currentVersion, '0.2.1');
  assert.equal(checkBody.latestVersion, '0.3.0');
  assert.equal(checkBody.updateAvailable, true);
  assert.deepEqual(checkCalledWith, { registryUrl: 'https://npm.example.com' });

  // 2.2 POST /api/nodes/:nodeId/upgrade - success case
  const upgradeRes = await f.request(`/api/nodes/${nodeId}/upgrade`, 'POST', {
    targetVersion: '0.3.0',
    registryUrl: 'https://npm.example.com',
  });
  assert.equal(upgradeRes.status, 200);
  const upgradeBody = (await upgradeRes.json()) as NodeUpgradeResult;
  assert.equal(upgradeBody.ok, true);
  assert.equal(upgradeBody.upgraded, true);
  assert.equal(upgradeBody.previousVersion, '0.2.1');
  assert.equal(upgradeBody.targetVersion, '0.3.0');
  assert.equal(upgradeBody.pid, 5678);
  assert.deepEqual(upgradeCalledWith, {
    targetVersion: '0.3.0',
    registryUrl: 'https://npm.example.com',
  });

  // 2.3 Non-owner test (Forbidden -> 403)
  // Create another user 'alice'
  await f.json('/api/users', 'POST', {
    username: 'alice',
    password: 'alice-password',
    role: 'member',
  });
  const aliceCookie = await f.loginAs('alice', 'alice-password');
  const alice = f.forUser(aliceCookie);

  const checkAliceRes = await alice.request(`/api/nodes/${nodeId}/upgrade/check`);
  assert.equal(checkAliceRes.status, 403, 'Non-owner checkUpgrade should return 403');

  const upgradeAliceRes = await alice.request(`/api/nodes/${nodeId}/upgrade`, 'POST', { targetVersion: '0.3.0' });
  assert.equal(upgradeAliceRes.status, 403, 'Non-owner upgradeDaemon should return 403');

  // 2.4 Offline node test (503 Service Unavailable)
  node.rpc.$close();
  node.socket.terminate();

  await waitFor(
    async () => {
      const res = await f.request(`/api/nodes/${nodeId}/upgrade/check`);
      return res.status;
    },
    (status) => status === 503,
    5_000
  );

  const checkOfflineRes = await f.request(`/api/nodes/${nodeId}/upgrade/check`);
  assert.equal(checkOfflineRes.status, 503, 'Offline node checkUpgrade should return 503');
  const checkOfflineJson = (await checkOfflineRes.json()) as { error: string };
  assert.equal(checkOfflineJson.error, 'Node is offline');

  const upgradeOfflineRes = await f.request(`/api/nodes/${nodeId}/upgrade`, 'POST', { targetVersion: '0.3.0' });
  assert.equal(upgradeOfflineRes.status, 503, 'Offline node upgradeDaemon should return 503');
  const upgradeOfflineJson = (await upgradeOfflineRes.json()) as { error: string };
  assert.equal(upgradeOfflineJson.error, 'Node is offline');

  // 2.5 Node not supporting upgrade check / upgrade daemon returns 501
  const unsupportedNode = await f.addNode({ ids: ['unsupported-bot'] });
  const unsupportedNodeId = unsupportedNode.identity.nodeId;

  const noCheckRes = await f.request(`/api/nodes/${unsupportedNodeId}/upgrade/check`);
  assert.equal(noCheckRes.status, 501, 'Unsupported checkUpgrade should return 501');

  const noUpgradeRes = await f.request(`/api/nodes/${unsupportedNodeId}/upgrade`, 'POST');
  assert.equal(noUpgradeRes.status, 501, 'Unsupported upgradeDaemon should return 501');
});

test('3. SQLite 旧版本数据库（PRAGMA user_version = 0 或 1）通过 new HubDatabase({ dbPath }) 打开时，自动生成 ${dbPath}.bak-v0 快照备份文件，且备份文件是合法的 SQLite 数据库，新库 user_version 升为 HUB_SCHEMA_VERSION', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-db-migration-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Test case A: user_version = 0 legacy database
  const dbPath0 = path.join(dir, 'legacy-v0.sqlite');
  {
    const rawDb = new DatabaseSync(dbPath0);
    rawDb.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        skills_json TEXT NOT NULL DEFAULT '[]',
        extensions_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT,
        owner_id TEXT
      );
      INSERT INTO nodes (id, name, platform, token_hash, last_seen_at, created_at, owner_id)
      VALUES ('node-v0', 'Legacy V0 Node', 'linux', 'hash-v0', '2025-01-01', '2025-01-01', 'user_admin');
      PRAGMA user_version = 0;
    `);
    rawDb.close();
  }

  const expectedBackup0 = `${dbPath0}.bak-v0`;
  assert.equal(fs.existsSync(expectedBackup0), false, 'Backup file should not exist prior to migration');

  // Open with HubDatabase
  const hubDb0 = new HubDatabase({ dbPath: dbPath0 });

  // 3.1 Verify backup file was created automatically
  assert.equal(fs.existsSync(expectedBackup0), true, 'Backup file .bak-v0 should exist after migration');

  // 3.2 Verify backup file is a valid SQLite database with original user_version = 0 and legacy node record
  {
    const backupDb = new DatabaseSync(expectedBackup0);
    const versionRow = backupDb.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(versionRow.user_version, 0, 'Backup database user_version must remain 0');

    const nodeRow = backupDb.prepare('SELECT id, name FROM nodes WHERE id = ?').get('node-v0') as { id: string; name: string } | undefined;
    assert(nodeRow, 'Backup database should contain legacy rows');
    assert.equal(nodeRow.name, 'Legacy V0 Node');
    backupDb.close();
  }

  // 3.3 Verify upgraded database has user_version = HUB_SCHEMA_VERSION and retains data
  assert.equal(hubDb0.getSchemaVersion(), HUB_SCHEMA_VERSION, `Upgraded db user_version should be ${HUB_SCHEMA_VERSION}`);
  const migratedNode = hubDb0.getNode('node-v0');
  assert(migratedNode, 'Migrated database should retain node');
  assert.equal(migratedNode.name, 'Legacy V0 Node');
  hubDb0.close();

  // Test case B: user_version = 1 legacy database
  const dbPath1 = path.join(dir, 'legacy-v1.sqlite');
  {
    const rawDb1 = new DatabaseSync(dbPath1);
    rawDb1.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        skills_json TEXT NOT NULL DEFAULT '[]',
        extensions_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT,
        owner_id TEXT
      );
      INSERT INTO nodes (id, name, platform, token_hash, last_seen_at, created_at, owner_id)
      VALUES ('node-v1', 'Legacy V1 Node', 'linux', 'hash-v1', '2025-01-01', '2025-01-01', 'user_admin');
      PRAGMA user_version = 1;
    `);
    rawDb1.close();
  }

  const expectedBackup1 = `${dbPath1}.bak-v1`;
  const hubDb1 = new HubDatabase({ dbPath: dbPath1 });
  assert.equal(fs.existsSync(expectedBackup1), true, 'Backup file .bak-v1 should exist after migration');
  assert.equal(hubDb1.getSchemaVersion(), HUB_SCHEMA_VERSION);
  hubDb1.close();

  // 3.4 Reopening an already upgraded database should NOT create another backup
  const statsBefore = fs.statSync(expectedBackup1);
  const hubDb1Reopened = new HubDatabase({ dbPath: dbPath1 });
  assert.equal(hubDb1Reopened.getSchemaVersion(), HUB_SCHEMA_VERSION);
  const statsAfter = fs.statSync(expectedBackup1);
  assert.equal(statsBefore.mtimeMs, statsAfter.mtimeMs, 'Backup file should not be touched when opening an already upgraded database');
  hubDb1Reopened.close();
});

test('4. Hub drain() 优雅排空：当有一个慢速 runTurn 正在执行时调用 hub.drain(5000)，验证期间 GET /api/health 返回 draining: true, activeTurns: 1，新发 POST /api/sessions/:id/messages 返回 503，而正在执行的 runTurn 能够正常完成并写入助手回复，drain() 最终返回 { drained: true, remaining: 0 }', async (t) => {
  const f = await createTestFixture(t);

  const turnStarted = deferred<void>();
  const turnFinish = deferred<void>();

  await f.addNode({
    ids: ['drain-bot'],
    runTurn: async (input) => {
      turnStarted.resolve();
      await turnFinish.promise;
      return {
        replyText: `Slow reply completed for ${input.botId}`,
        modelBadge: 'openai/test-model',
      };
    },
  });

  // Create session with drain-bot
  const session = await f.json<SessionRecord>('/api/sessions', 'POST', {
    title: 'Drain Test Session',
    mode: 'direct',
    leadBotId: 'drain-bot',
    memberBotIds: ['drain-bot'],
  });

  // Initial health check: not draining, 0 active turns
  const initialHealth = await f.json<{ ok: boolean; draining: boolean; activeTurns: number }>('/api/health');
  assert.equal(initialHealth.ok, true);
  assert.equal(initialHealth.draining, false);
  assert.equal(initialHealth.activeTurns, 0);

  // Send initial message to start slow runTurn
  const firstMsgRes = await f.request(`/api/sessions/${session.id}/messages`, 'POST', {
    content: 'First message requiring slow processing',
  });
  assert.equal(firstMsgRes.status, 202, 'First message should be accepted (202)');

  // Wait until runTurn starts executing
  await turnStarted.promise;
  assert.equal(f.hub.router.getActiveTurnCount(), 1, 'Active turn count should be 1');

  // Trigger graceful drain
  const drainPromise = f.hub.drain(5000);

  // Verify during draining:
  // 4.1 GET /api/health returns draining: true, activeTurns: 1
  const healthDuringDrain = await f.json<{ ok: boolean; draining: boolean; activeTurns: number }>('/api/health');
  assert.equal(healthDuringDrain.ok, true);
  assert.equal(healthDuringDrain.draining, true, 'draining should be true during drain()');
  assert.equal(healthDuringDrain.activeTurns, 1, 'activeTurns should be 1 during slow turn');

  // 4.2 New message submission returns 503
  const secondMsgRes = await f.request(`/api/sessions/${session.id}/messages`, 'POST', {
    content: 'Second message sent while draining',
  });
  assert.equal(secondMsgRes.status, 503, 'New message during drain must return 503');
  const secondMsgBody = (await secondMsgRes.json()) as { error: string };
  assert.match(secondMsgBody.error, /Hub is draining for upgrade/i);

  // Allow the slow runTurn to complete
  turnFinish.resolve();

  // 4.3 drain() resolves successfully with { drained: true, remaining: 0 }
  const drainResult = await drainPromise;
  assert.deepEqual(drainResult, { drained: true, remaining: 0 });

  // 4.4 Health check after drain
  const healthAfterDrain = await f.json<{ ok: boolean; draining: boolean; activeTurns: number }>('/api/health');
  assert.equal(healthAfterDrain.ok, true);
  assert.equal(healthAfterDrain.draining, true);
  assert.equal(healthAfterDrain.activeTurns, 0);

  // 4.5 Verify messages in session:
  // The first user message and its assistant reply are successfully recorded.
  // The second rejected message is NOT recorded.
  const messages = await f.json<MessageRecord[]>(`/api/sessions/${session.id}/messages`);
  assert.equal(messages.length, 2, 'Should contain exactly 2 messages (1 user, 1 assistant)');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'First message requiring slow processing');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'Slow reply completed for drain-bot');
});
