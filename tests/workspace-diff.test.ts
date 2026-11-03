import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createBirpc } from 'birpc';
import { WebSocket } from 'ws';
import { getWorkspaceDiff } from '../apps/node/src/workspace-diff.js';
import { saveBot } from '../apps/node/src/storage.js';
import { startHub } from '../apps/hub/src/index.js';
import { serializeRpcMessage } from '../packages/protocol/src/index.js';
import type { BotConfig, HubRpcFunctions, NodeRpcFunctions, WorkspaceDiffResult } from '../packages/protocol/src/index.js';

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeBot(nodeId: string): BotConfig {
  return {
    id: 'bot-diff',
    nodeId,
    name: 'Diff Bot',
    description: '',
    modelProvider: 'openai',
    modelId: 'test-model',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 在 BOT 工作区初始化一个 Git 仓库并制造净变更：修改 tracked + 新增 untracked */
async function setupRepo(dataDir: string, nodeId: string) {
  await saveBot(dataDir, makeBot(nodeId), 'system');
  const workspaceDir = path.join(dataDir, 'bots', 'bot-diff', 'workspace');
  git(workspaceDir, 'init', '-b', 'main');
  git(workspaceDir, 'config', 'user.email', 'test@example.com');
  git(workspaceDir, 'config', 'user.name', 'Test');
  await writeFile(path.join(workspaceDir, 'hello.txt'), 'line1\nline2\n', 'utf8');
  git(workspaceDir, 'add', '.');
  git(workspaceDir, 'commit', '-m', 'init');
  // 净变更：修改 tracked 文件 + 新增 untracked 文件
  await writeFile(path.join(workspaceDir, 'hello.txt'), 'line1\nline2-changed\nline3\n', 'utf8');
  await writeFile(path.join(workspaceDir, 'new-file.txt'), 'brand new\ncontent line\n', 'utf8');
  return workspaceDir;
}

test('getWorkspaceDiff reports modified and untracked files in a Git workspace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-diff-test-'));
  try {
    const dataDir = path.join(dir, 'data');
    await setupRepo(dataDir, 'node-diff');

    const result = await getWorkspaceDiff(dataDir, { botId: 'bot-diff' });

    assert.equal(result.isGitRepo, true);
    assert.equal(result.branch, 'main');
    assert.ok(path.isAbsolute(result.repoRoot));

    const modified = result.files.find((f) => f.path === 'hello.txt');
    assert.ok(modified, 'modified file should be listed');
    assert.equal(modified?.status, 'M');
    assert.ok((modified?.additions ?? 0) >= 2, 'modified file has additions');
    assert.ok((modified?.deletions ?? 0) >= 1, 'modified file has deletions');
    assert.match(modified?.diff ?? '', /@@ -1,2 \+1,3 @@/, 'diff contains a hunk header');
    assert.match(modified?.diff ?? '', /\+line2-changed/, 'diff shows the changed line');

    const untracked = result.files.find((f) => f.path === 'new-file.txt');
    assert.ok(untracked, 'untracked file should be listed');
    assert.equal(untracked?.status, 'A');
    assert.equal(untracked?.additions, 2, 'untracked file counts its 2 lines');
    assert.equal(untracked?.deletions, 0);
    assert.match(untracked?.diff ?? '', /\+brand new/, 'untracked diff shows file content');

    assert.ok(result.totalAdditions >= 4);
    assert.ok(result.totalDeletions >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getWorkspaceDiff falls back to isGitRepo=false without Git and honors subdirectory repos', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-diff-nogit-'));
  try {
    // 1. 非 Git 工作区：返回 isGitRepo=false 与空列表
    const dataDir = path.join(dir, 'data');
    await saveBot(dataDir, makeBot('node-nogit'), 'system');
    const plain = await getWorkspaceDiff(dataDir, { botId: 'bot-diff' });
    assert.equal(plain.isGitRepo, false);
    assert.deepEqual(plain.files, []);
    assert.equal(plain.totalAdditions, 0);
    assert.equal(plain.totalDeletions, 0);

    // 2. 工作区一级子目录是 Git 仓库：应被发现
    const workspaceDir = path.join(dataDir, 'bots', 'bot-diff', 'workspace');
    const subRepo = path.join(workspaceDir, 'project');
    await mkdir(subRepo, { recursive: true });
    git(subRepo, 'init', '-b', 'develop');
    git(subRepo, 'config', 'user.email', 'test@example.com');
    git(subRepo, 'config', 'user.name', 'Test');
    await writeFile(path.join(subRepo, 'a.txt'), 'x\ny\n', 'utf8');
    git(subRepo, 'add', '.');
    git(subRepo, 'commit', '-m', 'init');
    await writeFile(path.join(subRepo, 'a.txt'), 'x\nY\nz\n', 'utf8');

    const sub = await getWorkspaceDiff(dataDir, { botId: 'bot-diff' });
    assert.equal(sub.isGitRepo, true);
    assert.equal(sub.branch, 'develop');
    const hit = sub.files.find((f) => f.path === 'a.txt');
    assert.ok(hit, 'file inside sub-repo should be listed');
    assert.equal(hit?.status, 'M');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getWorkspaceDiff rejects unsafe bot ids', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-diff-invalid-'));
  try {
    await assert.rejects(
      getWorkspaceDiff(path.join(dir, 'data'), { botId: '../escape' }),
      /invalid/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getWorkspaceDiff result shape matches protocol contract', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-diff-shape-'));
  try {
    const dataDir = path.join(dir, 'data');
    await setupRepo(dataDir, 'node-shape');
    const result: WorkspaceDiffResult = await getWorkspaceDiff(dataDir, { botId: 'bot-diff' });
    for (const file of result.files) {
      assert.ok(['M', 'A', 'D', 'R', 'U'].includes(file.status));
      assert.equal(typeof file.path, 'string');
      assert.equal(typeof file.additions, 'number');
      assert.equal(typeof file.deletions, 'number');
      assert.equal(typeof file.diff, 'string');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hub GET /api/nodes/:nodeId/bots/:botId/diff proxies workspace diff and enforces auth', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-diff-hub-'));
  const hub = await startHub({
    host: '127.0.0.1',
    port: 0,
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: 'diff-hub-pass',
  });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'diff-hub-pass' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  // 配对并注册一个模拟节点，其 getWorkspaceDiff 返回固定结果
  const pairing = await (await fetch(`${base}/api/nodes/pairing`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  })).json() as { code: string };
  const identity = await (await fetch(`${base}/api/nodes/pairing/exchange`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, name: 'Diff Node', platform: 'linux' }),
  })).json() as { nodeId: string; token: string };

  const bot: BotConfig = {
    id: 'bot-diff',
    nodeId: identity.nodeId,
    name: 'Diff Bot',
    description: '',
    modelProvider: 'openai',
    modelId: 'test-model',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  const diffCalls: { botId: string; sessionId?: string }[] = [];
  const stubResult: WorkspaceDiffResult = {
    isGitRepo: true,
    repoRoot: '/tmp/repo',
    branch: 'main',
    files: [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1, diff: '@@ -1 +1 @@\n+b' }],
    totalAdditions: 3,
    totalDeletions: 1,
  };

  const socket = new WebSocket(
    `${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`
  );
  sockets.push(socket);
  const rpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
    {
      getWorkspaceDiff: async (input) => {
        diffCalls.push(input);
        return stubResult;
      },
    } as Partial<NodeRpcFunctions> as NodeRpcFunctions,
    {
      post: (data) => socket.send(data),
      on: (callback) => socket.on('message', (data) => callback(data.toString())),
      serialize: serializeRpcMessage,
      deserialize: JSON.parse,
      timeout: 10_000,
    }
  );
  await once(socket, 'open');
  await rpc.registerNode({
    nodeId: identity.nodeId,
    name: 'Diff Node',
    platform: 'linux',
    bots: [bot],
    skills: [],
  });

  const route = `/api/nodes/${identity.nodeId}/bots/bot-diff/diff`;

  // 1. 未登录返回 401
  assert.equal((await fetch(base + route)).status, 401);

  // 2. owner 正常拿到透传结果，sessionId 透传到节点 RPC
  const ok = await fetch(`${base}${route}?sessionId=sess-1`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as WorkspaceDiffResult;
  assert.equal(body.isGitRepo, true);
  assert.equal(body.branch, 'main');
  assert.equal(body.files[0].path, 'src/a.ts');
  assert.deepEqual(diffCalls, [{ botId: 'bot-diff', sessionId: 'sess-1' }]);

  // 3. 非法 botId 返回 400
  assert.equal(
    (await fetch(`${base}/api/nodes/${identity.nodeId}/bots/${encodeURIComponent('../evil')}/diff`, { headers: { cookie } })).status,
    400
  );

  // 4. 其他用户的节点（无权使用该 BOT 且非 owner）返回 403
  await (await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member-diff', password: 'member-pass' }),
  })).json();
  const memberLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member-diff', password: 'member-pass' }),
  });
  const memberCookie = memberLogin.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await fetch(base + route, { headers: { cookie: memberCookie } })).status,
    403
  );

  // 5. 节点未实现 getWorkspaceDiff（版本过旧）返回 503
  const legacySocket = new WebSocket(
    `${base.replace('http:', 'ws:')}/ws/node?nodeId=${identity.nodeId}&token=${identity.token}`
  );
  sockets.push(legacySocket);
  const legacyRpc = createBirpc<HubRpcFunctions, NodeRpcFunctions>(
    {} as NodeRpcFunctions,
    {
      post: (data) => legacySocket.send(data),
      on: (callback) => legacySocket.on('message', (data) => callback(data.toString())),
      serialize: serializeRpcMessage,
      deserialize: JSON.parse,
      timeout: 10_000,
    }
  );
  await once(legacySocket, 'open');
  await legacyRpc.registerNode({
    nodeId: identity.nodeId,
    name: 'Legacy Node',
    platform: 'linux',
    bots: [bot],
    skills: [],
  });
  const legacy = await fetch(base + route, { headers: { cookie } });
  assert.equal(legacy.status, 503);
  assert.match(((await legacy.json()) as { error: string }).error, /过旧/);
});
