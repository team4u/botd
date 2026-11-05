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
import { HubDatabase, HUB_SCHEMA_VERSION } from '../apps/hub/src/db.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import type {
  BotConfig,
  HubRpcFunctions,
  NodeRecord,
  NodeRpcFunctions,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
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
      restartDaemon: async () => ({ ok: true as const, pid: 4242 }),
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

test('1. 节点 registerNode 上报 version: "0.2.1" 后，GET /api/nodes 能正确返回 node.version === "0.2.1"', { timeout: 60_000 }, async (t) => {
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

test('2. GET /api/nodes/:nodeId/upgrade/check 与 POST /api/nodes/:nodeId/upgrade 能正确转发给节点 RPC 并返回结果，离线节点返回 503，非 owner 返回 403', { timeout: 60_000 }, async (t) => {
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

