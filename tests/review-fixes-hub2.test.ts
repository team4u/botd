/**
 * Review fixes (hub batch 2) regression tests:
 *  1. artifacts.ts     — 上传体大小限制：Content-Length 预检 413 / chunked 流式累计超限中断
 *  2. artifact-service — 上传 filename 净化：拒绝路径分隔符、'..'、Windows 反斜杠、NUL
 *  3. triggers.ts      — webhook X-Botd-Dedup 重放去重（200 吞掉）与 token 最小间隔 429
 *  4. share.ts         — expiresInHours 写入 expires_at、参数校验 400、默认 NULL 不变
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHub } from '../apps/hub/src/index.js';
import { ArtifactService, MAX_ARTIFACT_BYTES } from '../apps/hub/src/artifact-service.js';
import { SseHub } from '../apps/hub/src/sse.js';
import { HubDatabase } from '../apps/hub/src/db.js';

async function setupHub(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-review-fixes-hub2-'));
  const hub = createHub({
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: 'admin-pass-review-fixes',
    artifactsDir: path.join(dir, 'artifacts'),
  });
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const loginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-review-fixes' }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0];

  return { hub, dir, cookie };
}

function createSessionFixture(hub: ReturnType<typeof createHub>, userId: string, sessionId: string, botId: string) {
  hub.db.createNode({
    id: `node_${sessionId}`,
    name: `Node ${sessionId}`,
    platform: 'linux',
    tokenHash: 'dummy-hash',
    ownerId: userId,
  });
  hub.db.saveBot({
    id: botId,
    nodeId: `node_${sessionId}`,
    name: `Bot ${botId}`,
    description: 'test bot',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  });
  hub.db.createSession({
    id: sessionId,
    title: `Session ${sessionId}`,
    leadBotId: botId,
    ownerId: userId,
  });
}

// ---------------------------------------------------------------------------
// 1. 上传体大小限制
// ---------------------------------------------------------------------------

test('artifact upload rejects oversized Content-Length before reading body', { timeout: 60_000 }, async (t) => {
  const { hub, cookie } = await setupHub(t);
  const admin = hub.db.getUserWithHash('admin')!;
  createSessionFixture(hub, admin.id, 'sess_cl', 'bot_cl');

  // 伪造超大 Content-Length：服务端应在读取 body 前直接 413，不看实际内容
  const res = await hub.app.request('/api/sessions/sess_cl/artifacts', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/octet-stream',
      'x-artifact-filename': 'huge.bin',
      'content-length': String(MAX_ARTIFACT_BYTES * 2),
    },
    body: Buffer.from('tiny-but-lying-content-length'),
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/i);
});

test('artifact upload aborts chunked streaming body over the limit', { timeout: 60_000 }, async (t) => {
  const { hub, cookie } = await setupHub(t);
  const admin = hub.db.getUserWithHash('admin')!;
  createSessionFixture(hub, admin.id, 'sess_chunked', 'bot_chunked');

  // 无 Content-Length 的 chunked 请求（TransformStream 禁用长度旁路），
  // 实际 body 超过 base64 膨胀后的上限：流式累计读取应中断并返回 413
  const bigBody = Buffer.alloc(MAX_ARTIFACT_BYTES + 1024, 0x61);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 分块推送，确保走流式累计路径
      const chunkSize = 1024 * 1024;
      for (let offset = 0; offset < bigBody.length; offset += chunkSize) {
        controller.enqueue(new Uint8Array(bigBody.subarray(offset, offset + chunkSize)));
      }
      controller.close();
    },
  });

  const res = await hub.app.request('/api/sessions/sess_chunked/artifacts', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/octet-stream',
      'x-artifact-filename': 'huge-chunked.bin',
      'transfer-encoding': 'chunked',
    },
    body: stream,
    // @ts-expect-error duplex 仅在 body 为流时需要，undici 请求直传使用
    duplex: 'half',
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/i);

  // 正常大小 chunked 上传不受影响
  const okStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(Buffer.from('stream-ok')));
      controller.close();
    },
  });
  const okRes = await hub.app.request('/api/sessions/sess_chunked/artifacts', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/octet-stream',
      'x-artifact-filename': 'stream-ok.bin',
    },
    body: okStream,
    // @ts-expect-error 同上
    duplex: 'half',
  });
  assert.equal(okRes.status, 201);
  const okJson = await okRes.json();
  assert.equal(okJson.sizeBytes, 9);
});

// ---------------------------------------------------------------------------
// 2. filename 净化（服务层，覆盖 HTTP / RPC / IPC 全部入口）
// ---------------------------------------------------------------------------

test('artifact service rejects filename containing path components', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-review-fixes-svc-'));
  const db = new HubDatabase({ dbPath: path.join(dir, 'svc.sqlite') });
  const service = new ArtifactService(db, new SseHub(), { artifactsDir: path.join(dir, 'artifacts') });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  db.createUser({ id: 'user_p', username: 'purifier', passwordHash: 'h', role: 'member' });
  db.createNode({ id: 'node_p', name: 'NP', platform: 'linux', tokenHash: 't', ownerId: 'user_p' });
  db.saveBot({
    id: 'bot_p',
    nodeId: 'node_p',
    name: 'Bot P',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });
  db.createSession({
    id: 'sess_p',
    title: 'P',
    leadBotId: 'bot_p',
    ownerId: 'user_p',
  });

  const badFilenames = [
    '../../.ssh/authorized_keys',
    'sub/dir/file.txt',
    '..\\..\\windows\\evil.txt',
    'C:\\Users\\victim\\pw.txt',
    'a..b/../escape.txt',
    'ends-with-slash/',
    'hidden\0nul.txt',
    '..',
    '.',
  ];
  for (const filename of badFilenames) {
    assert.throws(
      () =>
        service.uploadArtifact(
          { type: 'user', userId: 'user_p' },
          { sessionId: 'sess_p', filename, contentBase64: Buffer.from('x').toString('base64') }
        ),
      (err: any) => err.status === 400 && /path separators/i.test(err.message),
      `filename ${JSON.stringify(filename)} must be rejected`
    );
  }

  // 合法文件名不受影响（含中文、空格、多个点）
  const legit = service.uploadArtifact(
    { type: 'user', userId: 'user_p' },
    { sessionId: 'sess_p', filename: '  报告 v1.2.final.md  ', contentBase64: Buffer.from('ok').toString('base64') }
  );
  assert.equal(legit.filename, '报告 v1.2.final.md', '合法文件名仅做 trim，不被改写');

  // HTTP 层同样拒绝（二进制流入口）
  const { hub, cookie } = await setupHub(t);
  const admin = hub.db.getUserWithHash('admin')!;
  createSessionFixture(hub, admin.id, 'sess_http_p', 'bot_http_p');
  const res = await hub.app.request('/api/sessions/sess_http_p/artifacts', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/octet-stream',
      'x-artifact-filename': encodeURIComponent('../../.ssh/authorized_keys'),
    },
    body: Buffer.from('ssh-ed25519 AAAA evil'),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /path separators/i);
});

// ---------------------------------------------------------------------------
// 3. webhook 去重与频率限制
// ---------------------------------------------------------------------------

test('webhook: X-Botd-Dedup replays are swallowed with 200; token rate limit returns 429', { timeout: 60_000 }, async (t) => {
  const { hub, cookie } = await setupHub(t);
  const admin = hub.db.getUserWithHash('admin')!;
  createSessionFixture(hub, admin.id, 'sess_hook', 'bot_hook');

  // 直接落库创建 webhook trigger（token 生成逻辑在 POST 路由，测试用固定值即可）
  const trigger = hub.db.createTrigger({
    id: 'trg_dedup_test',
    sessionId: 'sess_hook',
    ownerId: admin.id,
    name: 'dedup hook',
    botId: 'bot_hook',
    kind: 'webhook',
    token: 'a'.repeat(36),
    prompt: 'handle the payload',
    enabled: true,
  });
  assert.ok(trigger.token);

  const fire = (body: unknown, headers: Record<string, string> = {}) =>
    hub.app.request(`/api/webhooks/${trigger.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  // 1. 首次触发（带 dedup 头，真实幂等发送方的用法）：200 并真正执行
  const hash = createHash('sha256').update(JSON.stringify({ message: 'deploy done' })).digest('hex');
  const first = await fire({ message: 'deploy done' }, { 'x-botd-dedup': hash });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).deduplicated, undefined, '首次不应被去重');

  // 2. 相同 dedup hash 的重放：200 但 deduplicated=true，不执行（优先于限流判定）
  const replay = await fire({ message: 'deploy done' }, { 'x-botd-dedup': hash });
  assert.equal(replay.status, 200);
  const replayJson = await replay.json();
  assert.equal(replayJson.deduplicated, true);
  assert.equal(replayJson.triggerId, trigger.id);

  // 3. 不同 dedup hash 且仍在最小间隔内：429（被限流拒绝的请求不登记去重，重试窗口不被污染）
  const otherHash = createHash('sha256').update(JSON.stringify({ message: 'another event' })).digest('hex');
  const tooFast = await fire({ message: 'another event' }, { 'x-botd-dedup': otherHash });
  assert.equal(tooFast.status, 429);
  assert.match((await tooFast.json()).error, /rate limit/i);

  // 4. 所有者 PATCH 重置限流窗口后可再次触发
  const patch = await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'updated prompt' }),
  });
  assert.equal(patch.status, 200);
  const refire = await fire({ message: 'after patch' });
  assert.equal(refire.status, 200);

  // 5. 无 dedup 头时同样受最小间隔限制
  await hub.app.request(`/api/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'reset again' }),
  });
  const burst1 = await fire({ message: 'burst 1' });
  assert.equal(burst1.status, 200);
  const burst2 = await fire({ message: 'burst 2' });
  assert.equal(burst2.status, 429, '无 dedup 头的快速重复触发应被 429');

  // 6. 不存在的 webhook：404 保持
  const missing = await hub.app.request('/api/webhooks/nonexistent-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// 4. 分享链接 expiresInHours
// ---------------------------------------------------------------------------

test('share link: expiresInHours sets expiresAt, validation rejects bad input, default stays NULL', { timeout: 60_000 }, async (t) => {
  const { hub, cookie } = await setupHub(t);
  const admin = hub.db.getUserWithHash('admin')!;
  hub.db.createSession({
    id: 'sess_share_exp',
    title: 'Share Expiry',
    leadBotId: 'bot_share',
    ownerId: admin.id,
  });

  const post = (body: unknown) =>
    hub.app.request('/api/sessions/sess_share_exp/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  // 1. 默认行为不变：expiresAt 缺省（NULL 永久）
  const permanent = await post({});
  assert.equal(permanent.status, 201);
  const permanentJson = await permanent.json();
  assert.equal(permanentJson.expiresAt, undefined);

  // 2. 合法 expiresInHours 写入 expires_at = now + hours
  const timed = await post({ regenerate: true, expiresInHours: 24 });
  assert.equal(timed.status, 201);
  const timedJson = await timed.json();
  assert.ok(timedJson.expiresAt, 'expiresAt must be present');
  const deltaMs = Date.parse(timedJson.expiresAt) - Date.now();
  assert.ok(deltaMs > 23 * 3600_000 && deltaMs <= 24 * 3600_000, `expiresAt 应在 24h ± 容差内，实际 ${deltaMs}ms`);

  // 3. 参数校验：0 / 负数 / 非整数 / 超上限 / 非数字 -> 400
  for (const bad of [0, -1, 1.5, 721, '24' as unknown as number, NaN]) {
    const res = await post({ expiresInHours: bad });
    assert.equal(res.status, 400, `expiresInHours=${JSON.stringify(bad)} 应返回 400`);
    assert.match((await res.json()).error, /expiresInHours/i);
  }

  // 4. 上限边界 720 合法
  const maxValid = await post({ regenerate: true, expiresInHours: 720 });
  assert.equal(maxValid.status, 201);

  // 5. 过期语义：已过期 token 在读取端返回 404（读取路径已有判断，验证串联生效）
  const db = hub.db.db;
  db.prepare('UPDATE session_shares SET expires_at = ? WHERE session_id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    'sess_share_exp'
  );
  const expiredGet = await hub.app.request('/api/sessions/sess_share_exp/share', {
    headers: { cookie },
  });
  assert.deepEqual(await expiredGet.json(), { share: null }, '过期后 owner 查询返回 null');

  const publicRes = await hub.app.request(`/api/public/shares/${timedJson.token}`);
  assert.equal(publicRes.status, 404, '过期后公开访问 404');
});

test('share link: regenerate with expiresInHours=undefined keeps NULL semantics', { timeout: 60_000 }, async (t) => {
  const { hub, cookie } = await setupHub(t);
  const admin = hub.db.getUserWithHash('admin')!;
  hub.db.createSession({
    id: 'sess_share_reg',
    title: 'Share Regenerate',
    leadBotId: 'bot_reg',
    ownerId: admin.id,
  });

  // 先带过期时间创建，再不带 expiresInHours regenerate：应回到 NULL（永久）
  const timed = await hub.app.request('/api/sessions/sess_share_reg/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ expiresInHours: 1 }),
  });
  assert.equal(timed.status, 201);
  assert.ok((await timed.json()).expiresAt);

  const regen = await hub.app.request('/api/sessions/sess_share_reg/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ regenerate: true }),
  });
  assert.equal(regen.status, 201);
  const regenJson = await regen.json();
  assert.equal(regenJson.expiresAt, undefined, 'regenerate 不带 expiresInHours 应回到永久');
});
