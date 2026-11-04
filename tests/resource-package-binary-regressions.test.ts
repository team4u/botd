/**
 * 资源包二进制与可执行位保真回归测试：
 *  1. 本地目录安装（/api/nodes/local/install 与 /api/install）：PNG 等二进制
 *     文件逐字节落盘（不再被 utf8 读取损坏成 0 字节/乱码），.sh 与无扩展名
 *     脚本的可执行位保留 0o755；
 *  2. 远端节点回读（readResourcePackageDir 生成真实 ResourcePackage →
 *     decodePackageFile 落盘）：Hub 磁盘上的 logo.png 逐字节一致，
 *     run.sh 权限位 0o755；
 *  3. 全局 PUT/DELETE /api/skills/:id 与 /api/extensions/:id 管理员鉴权：
 *     member 403，admin 200。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';

import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import { getBuiltinModelCatalog } from '../packages/models/src/index.js';
import type { HubRpcFunctions, NodeRpcFunctions } from '../packages/protocol/src/index.js';

import { startHub, type StartHubResult } from '../apps/hub/src/index.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { readResourcePackageDir } from '../apps/node/src/storage.js';

const PASSWORD = 'binary-fidelity-pass';

/** PNG 头 + 随机字节的伪二进制载荷（含非 UTF-8 序列）。 */
const fakePng = (size = 4096): Buffer => {
  const data = Buffer.alloc(size);
  data[0] = 0x89;
  data[1] = 0x50;
  data[2] = 0x4e;
  data[3] = 0x47;
  data[4] = 0x0d;
  data[5] = 0x0a;
  data[6] = 0x1a;
  data[7] = 0x0a;
  for (let i = 8; i < size; i++) data[i] = (i * 7 + 13) & 0xff;
  return data;
};

interface Fixture {
  hub: StartHubResult;
  base: string;
  dir: string;
  request: (route: string, method?: string, body?: unknown, cookieOverride?: string) => Promise<Response>;
  json: <T = any>(route: string, method?: string, body?: unknown, cookieOverride?: string) => Promise<T>;
  adminCookie: string;
}

async function createFixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-binary-regressions-'));
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub', 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableRuntime: runtime,
    durableModels: models,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const adminCookie = login.headers.get('set-cookie')!.split(';')[0];

  const request = async (
    route: string,
    method = 'GET',
    body?: unknown,
    cookieOverride?: string,
  ): Promise<Response> =>
    fetch(base + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie: cookieOverride ?? adminCookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = any>(
    route: string,
    method = 'GET',
    body?: unknown,
    cookieOverride?: string,
  ): Promise<T> => {
    const response = await request(route, method, body, cookieOverride);
    const result = await response.json().catch(() => undefined);
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  return { hub, base, dir, request, json, adminCookie };
}

/** 本地技能目录素材：SKILL.md + 二进制 PNG + 0o755 脚本（含无扩展名可执行）。 */
async function makeSkillDir(root: string): Promise<{ dir: string; png: Buffer; id: string }> {
  const dir = path.join(root, 'binary-skill');
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await mkdir(path.join(dir, 'bin'), { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '# Binary Skill\n\nKeeps binary assets intact.\n', 'utf8');
  const png = fakePng();
  await writeFile(path.join(dir, 'assets', 'logo.png'), png);
  await writeFile(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho run\n', 'utf8');
  await chmod(path.join(dir, 'scripts', 'run.sh'), 0o755);
  await writeFile(path.join(dir, 'bin', 'tool'), '#!/bin/sh\necho tool\n', 'utf8');
  await chmod(path.join(dir, 'bin', 'tool'), 0o755);
  return { dir, png, id: 'binary-skill' };
}

// ---------------------------------------------------------------------------

test('1. local dir install preserves binary bytes and executable bits on Hub disk', { timeout: 60_000 }, async (t) => {
  const f = await createFixture(t);
  const { dir: skillDir, png, id } = await makeSkillDir(f.dir);
  const hubSkillDir = path.join(f.hub.db.getSkillDir(id));

  // /api/nodes/local/install：目录 → skill，落盘走保真 packageFiles
  const installed = await f.json<{ kind: string; id: string }>('/api/nodes/local/install', 'POST', {
    source: skillDir,
    kind: 'skill',
    customId: id,
  });
  assert.equal(installed.kind, 'skill');
  assert.equal(installed.id, id);

  const onDisk = await readFile(path.join(hubSkillDir, 'assets', 'logo.png'));
  assert.ok(onDisk.equals(png), `logo.png must be byte-identical after local dir install (got ${onDisk.length} bytes, want ${png.length})`);
  const shMode = (await stat(path.join(hubSkillDir, 'scripts', 'run.sh'))).mode & 0o777;
  assert.equal(shMode, 0o755, `run.sh must keep 0o755 (got ${shMode.toString(8)})`);
  const toolMode = (await stat(path.join(hubSkillDir, 'bin', 'tool'))).mode & 0o777;
  assert.equal(toolMode, 0o755, `bin/tool must keep 0o755 (got ${toolMode.toString(8)})`);

  // 全局 /api/install 路由同构（等价 local 节点直装）
  const globalId = 'binary-skill-global';
  const globalInstall = await f.json<{ kind: string; id: string }>('/api/install', 'POST', {
    source: skillDir,
    kind: 'skill',
    customId: globalId,
  });
  assert.equal(globalInstall.kind, 'skill');
  assert.equal(globalInstall.id, globalId);
  const globalPng = await readFile(path.join(f.hub.db.getSkillDir(globalId), 'assets', 'logo.png'));
  assert.ok(globalPng.equals(png), 'logo.png must be byte-identical via /api/install');
  const globalShMode = (await stat(path.join(f.hub.db.getSkillDir(globalId), 'scripts', 'run.sh'))).mode & 0o777;
  assert.equal(globalShMode, 0o755);
});

test('2. remote node readResourcePackage round-trip preserves binary bytes and executable bits', { timeout: 60_000 }, async (t) => {
  const f = await createFixture(t);

  // 节点侧真实安装素材（dataDir/skills/<id>）→ readResourcePackageDir 生成真实 ResourcePackage
  const nodeId = 'binary-node';
  const nodeDataDir = path.join(f.dir, 'node-data');
  const { dir: skillDir } = await makeSkillDir(f.dir);
  const nodeSkillDir = path.join(nodeDataDir, 'skills', 'remote-skill');
  await mkdir(path.dirname(nodeSkillDir), { recursive: true });
  await (await import('node:fs/promises')).cp(skillDir, nodeSkillDir, { recursive: true });
  const bundle = await readResourcePackageDir(nodeDataDir, { kind: 'skill', id: 'remote-skill' });
  assert.ok(bundle.files.some((file) => file.path === 'assets/logo.png' && file.contentBase64 !== undefined),
    'PNG must be carried as contentBase64 in the resource package');

  // 连接节点（RPC readResourcePackage 走真实 readResourcePackageDir）
  const pairing = await f.json<{ code: string }>('/api/nodes/pairing', 'POST');
  const identity = await f.json<{ nodeId: string; token: string }>('/api/nodes/pairing/exchange', 'POST', {
    code: pairing.code,
    name: 'Binary node',
    platform: 'linux',
  });
  const socket = new WebSocket(`${f.base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`);
  t.after(() => socket.terminate());
  const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
    {
      getModelCatalog: async () => getBuiltinModelCatalog(),
      startProviderLogin: async () => { throw new Error('Not implemented'); },
      getProviderLogin: async () => { throw new Error('Not implemented'); },
      respondProviderLogin: async () => { throw new Error('Not implemented'); },
      cancelProviderLogin: async () => {},
      logoutProvider: async () => {},
      saveBot: async () => {},
      deleteBot: async () => {},
      readFile: async () => '',
      writeFile: async () => {},
      installResource: async () => ({ kind: 'skill' as const, id: 'remote-skill' }),
      deleteResource: async () => {},
      restartDaemon: async () => ({ ok: true as const, pid: 1234 }),
      getCommands: async () => [],
      runTurn: async () => ({ replyText: 'ok', modelBadge: 'test/model' }),
      cancelTurn: async () => {},
      resetSession: async () => {},
      readResourcePackage: async (target) => await readResourcePackageDir(nodeDataDir, target),
    },
    {
      post: (data) => socket.send(data),
      on: (callback) => socket.on('message', (d) => callback(d.toString())),
      serialize: serializeRpcMessage as never,
      deserialize: JSON.parse,
      timeout: 10_000,
    },
  );
  await once(socket, 'open');
  await rpc.registerNode({
    nodeId: identity.nodeId,
    name: 'Binary node',
    platform: 'linux',
    bots: [],
    skills: ['remote-skill'],
    extensions: [],
  });

  const originalPng = await readFile(path.join(nodeSkillDir, 'assets', 'logo.png'));
  const installed = await f.json<{ kind: string; id: string }>(`/api/nodes/${identity.nodeId}/install`, 'POST', {
    source: skillDir,
    kind: 'skill',
    customId: 'remote-skill',
  });
  assert.equal(installed.kind, 'skill');

  const hubPng = await readFile(path.join(f.hub.db.getSkillDir('remote-skill'), 'assets', 'logo.png'));
  assert.ok(hubPng.length > 0, 'logo.png must not be a 0-byte file on Hub disk');
  assert.ok(hubPng.equals(originalPng), 'logo.png must be byte-identical after remote round-trip');
  const shMode = (await stat(path.join(f.hub.db.getSkillDir('remote-skill'), 'scripts', 'run.sh'))).mode & 0o777;
  assert.equal(shMode, 0o755, `run.sh must keep 0o755 after remote round-trip (got ${shMode.toString(8)})`);
  void nodeId;
});

test('3. global skill/extension PUT/DELETE routes are admin-only', { timeout: 60_000 }, async (t) => {
  const f = await createFixture(t);

  // 建一个 member 用户并登录
  const createRes = await f.request('/api/users', 'POST', { username: 'member1', password: 'member-pass', role: 'member' });
  assert.equal(createRes.status, 200);
  const memberLogin = await fetch(`${f.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member1', password: 'member-pass' }),
  });
  assert.equal(memberLogin.status, 200);
  const memberCookie = memberLogin.headers.get('set-cookie')!.split(';')[0];

  // admin 预置技能，供 member PUT/DELETE
  await f.json('/api/skills/botd-cli', 'PUT', { content: '# botd cli\n\nhelper skill\n' });

  // member：PUT / DELETE 全局技能 → 403
  assert.equal((await f.request('/api/skills/botd-cli', 'PUT', { content: 'overwrite' }, memberCookie)).status, 403);
  assert.equal((await f.request('/api/skills/botd-cli', 'DELETE', undefined, memberCookie)).status, 403);
  // member：PUT 全局扩展 → 403
  assert.equal(
    (await f.request('/api/extensions/evil', 'PUT', { content: 'export default {};' }, memberCookie)).status,
    403,
  );

  // admin：同路由 → 200
  assert.equal((await f.request('/api/skills/botd-cli', 'PUT', { content: '# updated\n' })).status, 200);
  assert.equal((await f.request('/api/extensions/evil', 'PUT', { content: 'export default {};' })).status, 200);
  assert.equal((await f.request('/api/skills/botd-cli', 'DELETE')).status, 200);
  assert.equal((await f.request('/api/extensions/evil', 'DELETE')).status, 200);
});
