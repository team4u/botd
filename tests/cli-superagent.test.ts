/**
 * cli-superagent.test.ts — 一等公民 Super-agent CLI 命令体系测试。
 *
 * 覆盖 Phase 4B：
 *  1. buildProgram() 命令注册：新命令组（workers/events/watchdog/asks）就位，
 *     旧命令（bg / ask / install / sessions delegate）绝迹；
 *  2. workers list/spawn/steer/stop/recall、events ingest、watchdog health
 *     对真实 Hono app（HubDurableRuntime + faux provider）全链路验证；
 *  3. asks list/respond 走 Hub 的 Durable AskDoc（createDurableAsk 同构入口）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';
import { createDurableAsk } from '../apps/hub/src/harness/session-bridge.js';
import { buildProgram } from '../apps/node/src/cli/program.js';
import { HubClient } from '../apps/node/src/cli/hub-client.js';

const PASSWORD = 'test-admin-password';

// ---------------------------------------------------------------------------
// 1. Command registration surface
// ---------------------------------------------------------------------------

const commandNames = (program: ReturnType<typeof buildProgram>): string[] =>
  program.commands.map((c) => c.name());

const subcommandNames = (program: ReturnType<typeof buildProgram>, name: string): string[] => {
  const cmd = program.commands.find((c) => c.name() === name);
  return cmd ? cmd.commands.map((c) => c.name()) : [];
};

test('buildProgram registers the Super-agent command groups with their subcommands', { timeout: 60_000 }, () => {
  const program = buildProgram();
  const top = commandNames(program);

  // 新命令组就位
  for (const group of ['workers', 'events', 'watchdog', 'asks', 'bots', 'sessions', 'chat', 'triggers', 'artifact', 'nodes', 'skills', 'extensions', 'providers', 'models']) {
    assert.ok(top.includes(group), `command group "${group}" must be registered`);
  }

  // workers 1:1 对齐 Hub 路由
  assert.deepEqual(subcommandNames(program, 'workers').sort(), ['list', 'recall', 'spawn', 'steer', 'stop']);
  assert.deepEqual(subcommandNames(program, 'events'), ['ingest']);
  assert.deepEqual(subcommandNames(program, 'watchdog'), ['health']);
  assert.deepEqual(subcommandNames(program, 'asks').sort(), ['list', 'respond']);

  // 生命周期节点命令保留
  for (const cmd of ['start', 'stop', 'restart', 'status', 'upgrade', 'wake', 'join', 'reload']) {
    assert.ok(top.includes(cmd), `node command "${cmd}" must stay registered`);
  }

  // sessions 核心子命令保留
  const sessionsSubs = subcommandNames(program, 'sessions');
  for (const sub of ['list', 'create', 'update', 'delete', 'messages', 'search', 'cancel', 'share', 'subsessions']) {
    assert.ok(sessionsSubs.includes(sub), `sessions ${sub} must stay registered`);
  }
});

test('removed legacy commands are gone from the program', { timeout: 60_000 }, () => {
  const program = buildProgram();
  const top = commandNames(program);

  // 顶层：bg / ask / install 已删除
  for (const gone of ['bg', 'ask', 'install']) {
    assert.ok(!top.includes(gone), `legacy command "${gone}" must be removed`);
  }

  // sessions delegate 已删除
  assert.ok(
    !subcommandNames(program, 'sessions').includes('delegate'),
    'sessions delegate must be removed',
  );

  // bots create 不再有 --parent/--tool-scope（pi-subagents 遗产）
  const bots = program.commands.find((c) => c.name() === 'bots')!;
  const create = bots.commands.find((c) => c.name() === 'create')!;
  const createOpts = create.options.map((o) => o.long);
  assert.ok(!createOpts.includes('--parent'), 'bots create --parent must be removed');
  assert.ok(!createOpts.includes('--tool-scope'), 'bots create --tool-scope must be removed');
  assert.ok(!createOpts.includes('--custom-tools'), 'bots create --custom-tools must be removed');
  // --node 变为可选（requiredOption 才会置 mandatory）
  const nodeOpt = create.options.find((o) => o.long === '--node')!;
  assert.equal(nodeOpt.mandatory, false, 'bots create --node must be optional');
  // workers spawn 的选项面
  const workers = program.commands.find((c) => c.name() === 'workers')!;
  const spawn = workers.commands.find((c) => c.name() === 'spawn')!;
  const spawnOpts = spawn.options.map((o) => o.long);
  for (const opt of ['--title', '--task', '--bot', '--worktree', '--thread-key']) {
    assert.ok(spawnOpts.includes(opt), `workers spawn must register ${opt}`);
  }
});

test('workers list takes an optional [sessionId] and sessions clear accepts --keep-workers', { timeout: 60_000 }, () => {
  const program = buildProgram();

  // botd workers list [sessionId]：sessionId 可选（省略 → GET /api/workers 跨会话全局列表）
  const workers = program.commands.find((c) => c.name() === 'workers')!;
  const list = workers.commands.find((c) => c.name() === 'list')!;
  const listArgs = list.registeredArguments.map((a) => ({ name: a.name(), required: a.required }));
  assert.deepEqual(listArgs, [{ name: 'sessionId', required: false }],
    'workers list sessionId must be optional');

  // botd sessions clear <sessionId> --keep-workers：保留运行中的后台 Worker
  const sessions = program.commands.find((c) => c.name() === 'sessions')!;
  const clear = sessions.commands.find((c) => c.name() === 'clear')!;
  const clearArgs = clear.registeredArguments.map((a) => ({ name: a.name(), required: a.required }));
  assert.deepEqual(clearArgs, [{ name: 'sessionId', required: true }],
    'sessions clear sessionId must stay required');
  const clearOpts = clear.options.map((o) => o.long);
  assert.ok(clearOpts.includes('--keep-workers'), 'sessions clear must register --keep-workers');
  const keepWorkers = clear.options.find((o) => o.long === '--keep-workers')!;
  assert.equal(keepWorkers.mandatory, false, '--keep-workers must be optional');
});

// ---------------------------------------------------------------------------
// 2. Full-stack fixture: real Hono app + HubDurableRuntime (faux provider)
// ---------------------------------------------------------------------------

interface Fixture {
  hubUrl: string;
  dataDir: string;
  sessionId: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-cli-superagent-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'main' }], tokensPerSecond: 40 });
  const models = createModels();
  models.setProvider(faux.provider);

  const runtime = await HubDurableRuntime.open({
    storage: new MemoryStorage(),
    models,
    workerAgent: () => ({}),
  });
  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableRuntime: runtime,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
  });

  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const hubUrl = `http://127.0.0.1:${address.port}`;

  // 种子数据：节点 + Bot + 会话（直接写 Hub DB，绕过需要在线 Node 的路由）。
  const db = hub.db;
  const adminUser = db.getUserWithHash('admin')!;
  db.createNode({
    id: 'node-1',
    name: 'Test node',
    platform: 'linux',
    tokenHash: 'x'.repeat(64),
    ownerId: adminUser.id,
  });
  db.saveBot({
    id: 'architect',
    nodeId: 'node-1',
    name: 'Architect',
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });
  const session = db.createSession({
    id: 'sess_cli_1',
    title: 'Super-agent CLI',
    leadBotId: 'architect',
    ownerId: adminUser.id,
  });

  const persona: BotPersonaConfig = {
    botId: 'architect',
    name: 'Architect',
    model: { provider: 'faux', modelId: 'main' },
    instructions: 'You are the architect bot.',
    nodeId: 'node-1',
    cwd: process.cwd(),
  };
  runtime.registerPersona(persona);
  // Worker 首轮任务的长回答：持续流式中，直到测试 stop 它。
  faux.setResponses([fauxAssistantMessage(`Working on it: ${'detail '.repeat(60)}done.`)]);

  // 预登录并把凭据写入 <dataDir>/cli.json：被测 CLI 内部的 HubClient.connect 直接复用 token
  await HubClient.establish(hubUrl, 'admin', PASSWORD, { dataDir: dir });

  return { hubUrl, dataDir: dir, sessionId: session.id };
}

/** 在拦截 console.log 的环境下运行一次 CLI 解析，返回捕获的 stdout。 */
async function runCli(args: string[]): Promise<string> {
  const program = buildProgram();
  program.exitOverride();
  let stdout = '';
  const origLog = console.log;
  console.log = (...argv: unknown[]) => {
    stdout += argv.map(String).join(' ') + '\n';
  };
  try {
    await program.parseAsync(['node', 'cli', '--data-dir', args[0], ...args.slice(1)]);
  } finally {
    console.log = origLog;
  }
  return stdout;
}

const cliArgs = (f: Fixture, ...rest: string[]): string[] => [
  f.dataDir,
  '--hub', f.hubUrl,
  '--password', PASSWORD,
  '--json',
  ...rest,
];

const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, message: string, timeout = 8_000): Promise<T> => {
  const end = Date.now() + timeout;
  let last: T;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('workers spawn → list → steer → recall → stop full lifecycle via CLI', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // spawn：返回 worker 项（--json）
  const spawnOut = JSON.parse(
    (
      await runCli(cliArgs(
        f,
        'workers', 'spawn', f.sessionId,
        '--title', '检查发布清单',
        '--task', '逐项核对发布清单并输出结论',
        '--worktree',
      ))
    ).trim(),
  );
  assert.equal(spawnOut.status, 'running');
  assert.ok(typeof spawnOut.workerId === 'string' && spawnOut.workerId.length > 0, 'spawn must return a workerId');
  assert.equal(spawnOut.parentSessionId, f.sessionId);
  const workerId = spawnOut.workerId as string;

  // list：能查到该 worker
  const listOut = JSON.parse(
    (
      await runCli(cliArgs(f, 'workers', 'list', f.sessionId))
    ).trim(),
  );
  const listed = (listOut as Array<{ workerId: string; threadKeys?: string[] }>).find((w) => w.workerId === workerId);
  assert.ok(listed, 'workers list must include the spawned worker');

  // steer：插话改向（运行中默认 steer）
  const steerOut = JSON.parse(
    (
      await runCli(cliArgs(f, 'workers', 'steer', f.sessionId, workerId, '优先检查数据库迁移'))
    ).trim(),
  );
  assert.deepEqual(steerOut, { ok: true });

  // recall：取回 Chain of Recall 节点与 transcript
  const recallOut = JSON.parse(
    (
      await runCli(cliArgs(f, 'workers', 'recall', f.sessionId, workerId))
    ).trim(),
  );
  assert.equal(recallOut.node.id, workerId);
  assert.equal(recallOut.node.kind, 'worker');
  assert.ok(Array.isArray(recallOut.transcript));

  // stop：中止后状态变为 aborted
  const stopOut = JSON.parse(
    (
      await runCli(cliArgs(f, 'workers', 'stop', f.sessionId, workerId))
    ).trim(),
  );
  assert.deepEqual(stopOut, { ok: true });
  const after = await waitFor(
    async () => {
      const out = JSON.parse((await runCli(cliArgs(f, 'workers', 'list', f.sessionId))).trim());
      return (out as Array<{ workerId: string; status: string }>).find((w) => w.workerId === workerId);
    },
    (item) => item?.status === 'aborted',
    `worker ${workerId} to be aborted`,
  );
  assert.equal(after!.status, 'aborted');
});

test('workers spawn maps --bot/--worktree/--thread-key onto the spawn payload', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  const spawnOut = JSON.parse(
    (
      await runCli(cliArgs(
        f,
        'workers', 'spawn', f.sessionId,
        '--title', '跟进 CI 事件',
        '--task', '分析 CI 失败原因',
        '--bot', 'architect',
        '--thread-key', 'github:owner/repo#42',
      ))
    ).trim(),
  );
  assert.equal(spawnOut.status, 'running');
  assert.equal(spawnOut.botId, 'architect');
  assert.deepEqual(spawnOut.threadKeys, ['github:owner/repo#42']);

  // 清理：停掉 worker，避免 fixture 关闭时仍占用流
  await runCli(cliArgs(f, 'workers', 'stop', f.sessionId, spawnOut.workerId));
});

test('events ingest reaches the EventRouter (threadKey-subscribed worker gets pass-through delivery)', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 准备订阅：派生一个订阅 github:pr:owner/repo#42 的 Worker。
  const spawnOut = JSON.parse(
    (
      await runCli(cliArgs(
        f,
        'workers', 'spawn', f.sessionId,
        '--title', 'pr watcher',
        '--task', 'Watch the PR and summarize new comments.',
        '--thread-key', 'github:pr:owner/repo#42',
      ))
    ).trim(),
  );
  const watcherId = spawnOut.workerId as string;
  const watcherConversationId = spawnOut.conversationId as string;

  // 同线程事件：已订阅 → 直通 Worker（pass_through，0 Router LLM 调用）
  const passed = JSON.parse(
    (
      await runCli(cliArgs(
        f,
        'events', 'ingest',
        '--source', 'github',
        '--type', 'pr.comment',
        '--content', 'Please address the nits in src/index.ts.',
        '--repo', 'owner/repo',
        '--pr', '42',
        '--session', f.sessionId,
      ))
    ).trim(),
  );
  assert.equal(passed.action, 'pass_through', `expected pass-through, got: ${JSON.stringify(passed)}`);
  assert.equal(passed.threadKey, 'github:pr:owner/repo#42');
  assert.equal(passed.routerLlmCalls, 0);
  assert.deepEqual(passed.deliveredTo, [watcherConversationId]);

  // 清理：停掉 watcher
  await runCli(cliArgs(f, 'workers', 'stop', f.sessionId, watcherId));
});

test('watchdog health returns structured diagnostics via CLI (--run-pass appends the query)', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  const report = JSON.parse(
    (
      await runCli(cliArgs(f, 'watchdog', 'health', '--run-pass'))
    ).trim(),
  );
  assert.equal(typeof report.healthy, 'boolean');
  assert.equal(typeof report.summary, 'string');
  assert.ok(Array.isArray(report.findings));
});

// ---------------------------------------------------------------------------
// 3. asks: pending human-interaction asks over the Hub Durable AskDoc
// ---------------------------------------------------------------------------

test('asks list/respond answers a pending ask via the Hub', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-cli-asks-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
  });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const hubUrl = `http://127.0.0.1:${address.port}`;

  const adminUser = hub.db.getUserWithHash('admin')!;
  hub.db.createNode({
    id: 'node_a',
    name: 'Asks Node',
    platform: 'linux',
    tokenHash: 'x'.repeat(64),
    ownerId: adminUser.id,
  });
  hub.db.saveBot({
    id: 'bot_ask',
    nodeId: 'node_a',
    name: 'Ask Bot',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });
  const session = hub.db.createSession({
    id: 'sess_asks',
    title: 'Asks',
    leadBotId: 'bot_ask',
    ownerId: adminUser.id,
  });
  // Ask 统一走 Durable AskDoc：懒开运行时（同步 bot_ask persona）后直接写入。
  const durableRuntime = await hub.ensureDurableRuntime();

  await HubClient.establish(hubUrl, 'admin', PASSWORD, { dataDir: dir });
  const f: Fixture = { hubUrl, dataDir: dir, sessionId: session.id };

  // 种子一个 pending ask（写入会话 Router 会话的 AskDoc）
  await createDurableAsk(durableRuntime, session.id, {
    botId: 'bot_ask',
    prompt: '是否发布 v1.2.0？',
    options: ['发布', '暂缓'],
  });

  const pending = await waitFor(
    async () => JSON.parse((await runCli(cliArgs(f, 'asks', 'list', session.id))).trim()),
    (list) => Array.isArray(list) && list.some((a) => a.status === 'pending'),
    'pending ask to be listed',
  );
  const askId = pending.find((a: { status: string }) => a.status === 'pending').id;
  assert.equal(pending.find((a: { id: string }) => a.id === askId).prompt, '是否发布 v1.2.0？');

  const respondOut = JSON.parse(
    (
      await runCli(cliArgs(f, 'asks', 'respond', session.id, askId, '发布'))
    ).trim(),
  );
  assert.equal(respondOut.ok, true);
  assert.equal(respondOut.ask.answer, '发布');
});

// ---------------------------------------------------------------------------
// 4. Node-less global ergonomics: skills / extensions / providers without nodeId
// ---------------------------------------------------------------------------

test('skills/extensions/providers operate on global Hub routes with no nodeId', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-cli-global-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
  });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const hubUrl = `http://127.0.0.1:${address.port}`;

  await HubClient.establish(hubUrl, 'admin', PASSWORD, { dataDir: dir });
  const f: Fixture = { hubUrl, dataDir: dir, sessionId: 'unused' };

  // --- skills：put → list → get → delete，全程不传 nodeId ---
  const skillFile = path.join(dir, 'my-skill.md');
  await writeFile(skillFile, '# My Skill\ncontent');

  assert.deepEqual(
    JSON.parse((await runCli(cliArgs(f, 'skills', 'put', 'my-skill', '--file', skillFile))).trim()),
    { ok: true },
  );

  const skillList = JSON.parse((await runCli(cliArgs(f, 'skills', 'list'))).trim()) as Array<{ id: string }>;
  assert.ok(skillList.some((s) => s.id === 'my-skill'), 'skills list must include my-skill');

  assert.equal(
    JSON.parse((await runCli(cliArgs(f, 'skills', 'get', 'my-skill'))).trim()).content,
    '# My Skill\ncontent',
  );

  assert.deepEqual(
    JSON.parse((await runCli(cliArgs(f, 'skills', 'delete', 'my-skill'))).trim()),
    { ok: true },
  );

  // --- extensions：同构验证 ---
  const extFile = path.join(dir, 'my-ext.md');
  await writeFile(extFile, '# My Extension\ncontent');

  assert.deepEqual(
    JSON.parse((await runCli(cliArgs(f, 'extensions', 'put', 'my-ext', '--file', extFile))).trim()),
    { ok: true },
  );

  const extList = JSON.parse((await runCli(cliArgs(f, 'extensions', 'list'))).trim()) as Array<{ id: string }>;
  assert.ok(extList.some((e) => e.id === 'my-ext'), 'extensions list must include my-ext');

  assert.equal(
    JSON.parse((await runCli(cliArgs(f, 'extensions', 'get', 'my-ext'))).trim()).content,
    '# My Extension\ncontent',
  );

  assert.deepEqual(
    JSON.parse((await runCli(cliArgs(f, 'extensions', 'delete', 'my-ext'))).trim()),
    { ok: true },
  );

  // --- providers：login → respond，免 nodeId 直连 Hub 全局路由 ---
  const login = JSON.parse(
    (await runCli(cliArgs(f, 'providers', 'login', 'anthropic', '--method', 'api_key'))).trim(),
  );
  assert.equal(login.status, 'pending');
  assert.equal(login.prompt.id, 'api_key');

  const respond = JSON.parse(
    (
      await runCli(cliArgs(f, 'providers', 'respond', login.id, '--prompt', 'api_key', '--value', 'sk-test'))
    ).trim(),
  );
  assert.equal(respond.status, 'success');
  assert.equal(respond.id, login.id);
});
