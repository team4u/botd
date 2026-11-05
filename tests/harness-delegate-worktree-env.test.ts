/**
 * Harness delegate/worktree/env 集成测试。
 *
 * 覆盖：
 *  1. delegate_to_bot 走完整 Worker 栈（HubDurableRuntime 默认 workerAgentFor：
 *     CodingTools + botd-worker 扩展），完成后自动在 WorkerRegistryDoc 标记
 *     completed 并向父 Router 会话汇报；
 *  2. forkSessionToWorker({ worktree: true }) 在 TargetDoc / WorkerRegistryDoc /
 *     RecallIndexDoc 三处落 worktreePath + branchName；真实 startHub（懒创建
 *     runtime + 本地 git 仓库）下 worker 的 bash 工具在隔离工作树分支
 *     botd/w-... 内执行，且子进程带 BOTD_BOT_ID / BOTD_SESSION_ID；
 *  3. startHub 零节点连接时自动种子化 botd-cli（SKILL.md + references/*），
 *     且任意 persona 可 load_skill({ skillId: 'botd-cli' })。
 *
 * Provider 为脚本化 faux provider，无真实 LLM。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage, type ConversationId } from '@earendil-works/pi-durable';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';
import { RecallIndexDoc, TargetDoc, WorkerRegistryDoc } from '../apps/hub/src/harness/docs.js';

const run = promisify(execFile);
const PASSWORD = 'pw-harness-delegate';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const lastUserText = (messages: readonly { role: string; content: unknown }[]): string => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (typeof lastUser?.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? '');
  return '';
};

async function waitFor<T>(
  read: () => Promise<T> | T,
  check: (value: T) => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await read();
    if (check(last)) return last;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${message}`);
    await wait(20);
  }
}

/** 脚本化 faux：按最后一条用户消息的语义应答，router/worker 竞争同一队列也可预测。 */
/** Whether a tool result follows the last user message (this turn already ran its tool round). */
const toolResultThisTurn = (messages: readonly { role: string; content: unknown }[]): boolean => {
  const reversed = [...messages].reverse();
  const lastUser = reversed.findIndex((m) => m.role === 'user');
  return lastUser >= 0 && reversed.slice(0, lastUser).some((m) => m.role === 'toolResult');
};

const scriptRouter = (
  faux: ReturnType<typeof fauxProvider>,
  step: (ctx: { messages: readonly { role: string; content: unknown }[] }) => ReturnType<typeof fauxAssistantMessage>,
): void => {
  faux.setResponses([...Array(64)].map(() => step as never));
};

const persona = (botId: string, name: string, instructions: string, cwd: string): BotPersonaConfig => ({
  botId,
  name,
  model: { provider: 'faux', modelId: 'main' },
  instructions,
  nodeId: 'local',
  cwd,
});

/** 在 Hub DB 里落一个 Bot 配置（懒创建 runtime 经 syncBotPersonas 注册为分身）。 */
const seedBot = (
  hub: Awaited<ReturnType<typeof startHub>>,
  bot: { id: string; name: string; workspaceDir: string; systemMd?: string },
): void => {
  hub.db.saveBot({
    id: bot.id,
    nodeId: 'local',
    name: bot.name,
    description: '',
    modelProvider: 'faux',
    modelId: 'main',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
    workspaceDir: bot.workspaceDir,
  });
  if (bot.systemMd !== undefined) hub.db.setBotFile(bot.id, 'system', bot.systemMd);
};

// ---------------------------------------------------------------------------
// 1. delegate_to_bot：完整 Worker 栈 + 完成回报
// ---------------------------------------------------------------------------

test('1. delegate_to_bot runs the full worker stack and reports back completed', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-delegate-'));
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  // 不传 workerAgent 覆盖：走 HubDurableRuntime 默认（workerAgentFor 全栈）。
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  try {
    runtime.registerPersona(persona('assistant', 'Assistant', 'You are the personal assistant.', dir));
    runtime.registerPersona({ ...persona('architect', 'Architect', 'You design systems.', dir), thinkingLevel: 'high' });

    const assistant = await runtime.ensureBotMainSession('assistant');

    scriptRouter(faux, (ctx) => {
      const text = lastUserText(ctx.messages);
      if (/Review the outbox design/.test(text)) {
        return fauxAssistantMessage('Outbox review: add an idempotency key per aggregate.');
      }
      if (/\[Worker Completed:/.test(text)) {
        return fauxAssistantMessage('The architect finished the review.');
      }
      const toolResultSeen = ctx.messages.some((m) => m.role === 'toolResult');
      if (/delegate the design review/.test(text) && !toolResultSeen) {
        return fauxAssistantMessage(
          [
            fauxToolCall('delegate_to_bot', {
              targetBotId: 'architect',
              title: 'design review',
              task: 'Review the outbox design for idempotency.',
            }),
          ],
          { stopReason: 'toolUse' },
        );
      }
      return fauxAssistantMessage('Asked the architect bot.');
    });

    const submission = await runtime.submitUserMessage(String(assistant.id), 'delegate the design review');
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');

    const workers = await runtime.getActiveWorkers(String(assistant.id));
    assert.equal(workers.length, 1);
    assert.equal(workers[0].botId, 'architect', 'worker must run as the target persona');
    const delegated = await runtime.conversation(workers[0].conversationId);
    assert.ok(delegated);
    assert.equal((await delegated.agent(BACKGROUND_CONTEXT)).thinkingLevel, 'high', 'delegate uses the target persona worker configuration');

    // 完成回报：registry 翻转 completed + 父 Router transcript 收到 worker-report。
    const completed = await waitFor(
      async () => (await runtime.getActiveWorkers(String(assistant.id)))[0],
      (w) => w?.status === 'completed',
      'delegated worker completion',
    );
    assert.match(completed.summary ?? '', /idempotency/);

    const routerCtx = await assistant.context(BACKGROUND_CONTEXT);
    assert.ok(
      routerCtx.messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[Worker Completed:'),
      ),
      'router transcript must contain the worker report',
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Router keeps coding tools; spawn_worker runs the full worker stack and reports back completed', { timeout: 60_000 }, async () => {
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models, codemode: false });
  try {
    runtime.registerPersona(persona('coder', 'Coder', 'Implement coding tasks.', process.cwd()));
    const router = await runtime.ensureBotMainSession('coder');
    // Router 现在自带编码工具（当场干活）；toolScope: 'readonly' 才会剥夺它们。
    const routerTools = (await router.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    for (const name of ['read', 'bash']) assert.ok(routerTools.includes(name), `Router must offer ${name}`);
    scriptRouter(faux, (ctx) => {
      const text = lastUserText(ctx.messages);
      if (text === 'Inspect the coding task') return fauxAssistantMessage('Coding task inspected.');
      if (text === 'Start a coding worker' && !ctx.messages.some((m) => m.role === 'toolResult')) {
        return fauxAssistantMessage([fauxToolCall('spawn_worker', {
          title: 'coding tools',
          task: 'Inspect the coding task',
        })], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('Worker acknowledged.');
    });
    await (await runtime.submitUserMessage(String(router.id), 'Start a coding worker')).wait(BACKGROUND_CONTEXT);
    const worker = await waitFor(
      async () => (await runtime.getActiveWorkers(String(router.id)))[0],
      (entry) => entry?.status === 'completed',
      'coding worker completion',
    );
    const conversation = await runtime.conversation(worker.conversationId);
    assert.ok(conversation);
    const tools = (await conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    for (const name of ['read', 'write', 'edit', 'bash']) assert.ok(tools.includes(name), `${name} must be offered to the worker`);
  } finally {
    await runtime.close();
  }
});

// ---------------------------------------------------------------------------
// 2. forkSessionToWorker worktree: 文档三处落位 + 真实 startHub 隔离执行
// ---------------------------------------------------------------------------

test('2. forkSessionToWorker worktree populates docs and executes bash inside the isolated worktree', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-worktree-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  // 本地 git 仓库：一个文件 + 初始提交（worktree 挂载需要 HEAD）
  await run('git', ['init', '-q', dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 'botd@test']);
  await run('git', ['-C', dir, 'config', 'user.name', 'botd-test']);
  await writeFile(path.join(dir, 'README.md'), '# repo\n');
  await run('git', ['-C', dir, 'add', '.']);
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);

  // 真实 startHub（懒创建 runtime）：Hub 的 env 工厂负责 worktree 挂载与
  // BOTD_BOT_ID / BOTD_SESSION_ID 注入 —— 本测试的核心被测对象。
  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableModels: models,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
  });
  const runtime = await hub.ensureDurableRuntime();
  seedBot(hub, { id: 'architect', name: 'Architect', workspaceDir: dir, systemMd: 'You design systems.' });
  // 重新取用会重新同步分身：后置种子的 Bot 被注册进 runtime（与生产提交路径一致）。
  await hub.ensureDurableRuntime();

  const router = await runtime.ensureBotMainSession('architect');

  // worker 用 bash 探测分支与上下文环境变量后作答。
  scriptRouter(faux, (ctx) => {
    const text = lastUserText(ctx.messages);
    if (/Report the git branch/.test(text)) {
      const ranTools = ctx.messages.some((m) => m.role === 'toolResult');
      return ranTools
        ? fauxAssistantMessage('branch reported')
        : fauxAssistantMessage(
            [
              fauxToolCall('bash', {
                command:
                  'echo "BRANCH=$(git rev-parse --abbrev-ref HEAD) BOT=$BOTD_BOT_ID SESSION_SET=${BOTD_SESSION_ID:+yes}" > env-probe.txt',
              }),
            ],
            { stopReason: 'toolUse' },
          );
    }
    return fauxAssistantMessage('nothing to do');
  });

  const { workerId, conversation } = await runtime.forkSessionToWorker(String(router.id), {
    botId: 'architect',
    title: 'worktree probe',
    task: 'Report the git branch and context env vars.',
    worktree: true,
  });

  // --- 文档三处落位 ---
  const target = await runtime.harness.snapshot(TargetDoc, conversation.id, BACKGROUND_CONTEXT);
  assert.ok(target?.worktreePath, 'TargetDoc must carry worktreePath');
  assert.equal(target?.branchName, `botd/${workerId}`);
  assert.ok(target?.worktreePath.endsWith(`.botd-worktrees/${workerId}`));
  assert.equal(target?.sessionId, String(router.id), 'TargetDoc must carry the parent sessionId');

  const registry = await runtime.harness.snapshot(WorkerRegistryDoc, router.id, BACKGROUND_CONTEXT);
  const entry = registry?.workers[workerId];
  assert.ok(entry?.worktreePath, 'WorkerRegistryDoc entry must carry worktreePath');
  assert.equal(entry?.branchName, `botd/${workerId}`);

  const recall = await runtime.harness.snapshot(RecallIndexDoc, BACKGROUND_CONTEXT);
  const node = recall?.nodes[workerId];
  assert.ok(node, 'RecallIndexDoc must index the worker');
  const nodeData = (node as unknown as { data?: { node?: { worktreePath?: string; branchName?: string } } }).data;
  assert.equal(nodeData?.node?.worktreePath, target?.worktreePath);
  assert.equal(nodeData?.node?.branchName, `botd/${workerId}`);

  // --- 真实执行：worker 的 bash 在隔离 worktree 分支内、带上下文环境变量 ---
  const settled = await (
    await conversation.submit(
      {
        type: 'input',
        content: 'Report the git branch and context env vars.',
        requestId: 'worktree-probe',
        entry: { kind: 'botd.worker-task', data: { workerId, title: 'worktree probe' } },
      },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, 'done', `worker run must finish (got ${JSON.stringify(settled)})`);

  const worktreePath = target!.worktreePath!;
  const probe = await readFile(path.join(worktreePath, 'env-probe.txt'), 'utf8');
  assert.match(probe, new RegExp(`BRANCH=botd/${workerId}`), `bash must run on the isolated branch (got: ${probe.trim()})`);
  assert.match(probe, /BOT=architect/, 'BOTD_BOT_ID must be injected');
  assert.match(probe, /SESSION_SET=yes/, 'BOTD_SESSION_ID must be injected');

  // 主仓工作区保持干净（worktree 隔离写）
  const mainStatus = await run('git', ['-C', dir, 'status', '--porcelain']);
  assert.ok(!mainStatus.stdout.includes('env-probe.txt'), 'main worktree must stay clean');
});

// ---------------------------------------------------------------------------
// 3. startHub 种子化 botd-cli（零节点连接）
// ---------------------------------------------------------------------------

test('3. startHub seeds builtin skill botd-cli for every persona', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-seed-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableModels: models,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
  });

  // 零节点连接：SQLite 里有完整技能内容
  assert.equal(hub.connections.getNodeRpc('any-node'), undefined);
  const skill = hub.db.getSkillContent('botd-cli');
  assert.match(skill, /botd-skill: botd-cli v16/, 'SKILL.md must be seeded with the version marker');
  assert.match(skill, /Multi-Persona Super-agent/);
  const files = hub.db.listSkillFiles('botd-cli');
  assert.ok(files.includes('SKILL.md'));
  assert.ok(files.some((f) => f.startsWith('references/')), `references must be seeded (got: ${files.join(', ')})`);

  // 每个 persona 可 load_skill：Router 会话经 faux 调用 load_skill 工具
  const runtime = await hub.ensureDurableRuntime();
  seedBot(hub, { id: 'finance', name: 'Finance', workspaceDir: dir, systemMd: 'You manage money.' });
  await hub.ensureDurableRuntime(); // 重新同步：后置种子的 Bot 注册进 runtime
  const router = await runtime.ensureBotMainSession('finance');

  scriptRouter(faux, (ctx) => {
    const text = lastUserText(ctx.messages);
    if (/load the builtin skill/.test(text)) {
      const ranTools = ctx.messages.some((m) => m.role === 'toolResult');
      return ranTools
        ? fauxAssistantMessage('skill loaded')
        : fauxAssistantMessage([fauxToolCall('load_skill', { skillId: 'botd-cli' })], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  const submission = await runtime.submitUserMessage(String(router.id), 'load the builtin skill');
  assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');

  // 工具结果确实带回了种子化的技能内容
  const ctxAfter = await router.context(BACKGROUND_CONTEXT);
  const toolResults = ctxAfter.messages.filter((m) => m.role === 'toolResult');
  assert.ok(
    toolResults.some((m) => JSON.stringify(m.content).includes('botd-skill: botd-cli')),
    'load_skill must return the seeded SKILL.md',
  );
});

// ---------------------------------------------------------------------------
// 4. spawn_worker({ isolation: 'worktree' }) / delegate_to_bot({ worktree: true })
// ---------------------------------------------------------------------------

test('4. spawn_worker isolation alias and delegate_to_bot worktree populate worktreePath + branchName', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-alias-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await run('git', ['init', '-q', dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 'botd@test']);
  await run('git', ['-C', dir, 'config', 'user.name', 'botd-test']);
  await writeFile(path.join(dir, 'README.md'), '# repo\n');
  await run('git', ['-C', dir, 'add', '.']);
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  t.after(async () => {
    await runtime.close();
  });
  runtime.registerPersona(persona('assistant', 'Assistant', 'You are the assistant.', dir));
  runtime.registerPersona(persona('architect', 'Architect', 'You design systems.', dir));

  const router = await runtime.ensureBotMainSession('assistant');
  scriptRouter(faux, (ctx) => {
    const text = lastUserText(ctx.messages);
    if (/Run the isolated probe/.test(text)) return fauxAssistantMessage('Isolated probe finished.');
    if (/Write branch docs/.test(text)) return fauxAssistantMessage('Branch docs written.');
    if (/\[Worker Completed:/.test(text)) return fauxAssistantMessage('Noted the completion.');
    const toolResultSeen = ctx.messages.some((m) => m.role === 'toolResult');
    if (/spawn isolated workers/.test(text) && !toolResultSeen) {
      return fauxAssistantMessage(
        [
          fauxToolCall('spawn_worker', {
            title: 'isolated probe',
            task: 'Run the isolated probe.',
            isolation: 'worktree',
          }),
          fauxToolCall('delegate_to_bot', {
            targetBotId: 'architect',
            title: 'branch docs',
            task: 'Write branch docs.',
            worktree: true,
          }),
        ],
        { stopReason: 'toolUse' },
      );
    }
    return fauxAssistantMessage('ok');
  });

  await (await runtime.submitUserMessage(String(router.id), 'spawn isolated workers')).wait(BACKGROUND_CONTEXT);
  const workers = await waitFor(
    async () => await runtime.getActiveWorkers(String(router.id)),
    (list) => list.length === 2,
    'both workers registered',
  );
  const spawned = workers.find((w) => w.title === 'isolated probe');
  const delegated = workers.find((w) => w.title === 'branch docs');
  assert.ok(spawned, 'spawn_worker worker must exist');
  assert.ok(delegated, 'delegate_to_bot worker must exist');

  // spawn_worker({ isolation: 'worktree' }): TargetDoc / registry / recall 三处落位
  const spawnedTarget = await runtime.harness.snapshot(
    TargetDoc,
    Number(spawned.conversationId) as ConversationId,
    BACKGROUND_CONTEXT,
  );
  assert.equal(spawnedTarget?.branchName, `botd/${spawned.workerId}`);
  assert.ok(spawnedTarget?.worktreePath?.endsWith(`.botd-worktrees/${spawned.workerId}`));
  assert.equal(spawned.worktreePath, spawnedTarget?.worktreePath);
  assert.equal(spawned.branchName, `botd/${spawned.workerId}`);
  const recallSpawned = await runtime.recall(spawned.workerId, BACKGROUND_CONTEXT);
  const recallData = (recallSpawned as unknown as { data?: { node?: { worktreePath?: string } } }).data;
  assert.equal(recallData?.node?.worktreePath, spawnedTarget?.worktreePath, 'recall node must carry worktree data');

  // delegate_to_bot({ worktree: true }): 同样三处落位
  const delegatedTarget = await runtime.harness.snapshot(
    TargetDoc,
    Number(delegated.conversationId) as ConversationId,
    BACKGROUND_CONTEXT,
  );
  assert.equal(delegatedTarget?.branchName, `botd/${delegated.workerId}`);
  assert.ok(delegatedTarget?.worktreePath?.endsWith(`.botd-worktrees/${delegated.workerId}`));
  assert.equal(delegated.worktreePath, delegatedTarget?.worktreePath);

  // 回执文本带 [worktree: ...] 注记（从 router transcript 的 toolResult 中提取）
  const routerEntries = await router.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
  const toolResultText = routerEntries.items
    .map((e) => e.model?.[0])
    .filter((m) => m !== undefined && m.role === 'toolResult')
    .map((m) => JSON.stringify((m as { content?: unknown }).content))
    .join('\n');
  assert.match(toolResultText, /\[worktree: botd\/w-\d+-\d+ at [^\]]+\]/, 'tool receipts must mention the worktree');

  // 等 Worker 完成回报（Worktree: 行出现在通知里）
  const doneWorkers = await waitFor(
    async () => await runtime.getActiveWorkers(String(router.id)),
    (list) => list.every((w) => w.status === 'completed'),
    'both workers completed',
  );
  const doneSpawned = doneWorkers.find((w) => w.workerId === spawned.workerId);
  assert.equal(doneSpawned?.status, 'completed');
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Worker 的 subagent 工具：isolation: 'worktree' 独立分支 / 默认继承父 worktree
// ---------------------------------------------------------------------------

test('5. worker subagent isolation: worktree gets its own branch; default inherits the parent worktree', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-subagent-wt-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await run('git', ['init', '-q', dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 'botd@test']);
  await run('git', ['-C', dir, 'config', 'user.name', 'botd-test']);
  await writeFile(path.join(dir, 'README.md'), '# repo\n');
  await run('git', ['-C', dir, 'add', '.']);
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  t.after(async () => {
    await runtime.close();
  });
  runtime.registerPersona(persona('coder', 'Coder', 'You implement coding tasks.', dir));

  const router = await runtime.ensureBotMainSession('coder');
  scriptRouter(faux, (ctx) => {
    const text = lastUserText(ctx.messages);
    // 子代理回合：把当前分支写入 marker 文件（落在自己 cwd = 各自 worktree 里）
    const subMarker = text.match(/probe your branch into (\w+)/)?.[1];
    if (subMarker !== undefined) {
      const ranTools = toolResultThisTurn(ctx.messages);
      return ranTools
        ? fauxAssistantMessage(`branch probe ${subMarker} done`)
        : fauxAssistantMessage(
            [fauxToolCall('bash', { command: `git rev-parse --abbrev-ref HEAD > branch-probe-${subMarker}.txt` })],
            { stopReason: 'toolUse' },
          );
    }
    // Worker 回合：一次发两个 subagent 调用（isolation + 默认继承）
    if (/dispatch two subagents/.test(text)) {
      const ranTools = toolResultThisTurn(ctx.messages);
      if (!ranTools) {
        return fauxAssistantMessage(
          [
            fauxToolCall('subagent', { task: 'probe your branch into ISO', isolation: 'worktree' }),
            fauxToolCall('subagent', { task: 'probe your branch into INH' }),
          ],
          { stopReason: 'toolUse' },
        );
      }
      return fauxAssistantMessage('subagents dispatched');
    }
    if (/\[Worker Completed:/.test(text)) return fauxAssistantMessage('Subagent branches received.');
    const toolResultSeen = toolResultThisTurn(ctx.messages);
    if (/run the subagent dispatch/.test(text) && !toolResultSeen) {
      return fauxAssistantMessage(
        [fauxToolCall('spawn_worker', {
          title: 'subagent dispatch',
          task: 'dispatch two subagents',
          worktree: true,
        })],
        { stopReason: 'toolUse' },
      );
    }
    return fauxAssistantMessage('ok');
  });

  await (await runtime.submitUserMessage(String(router.id), 'run the subagent dispatch')).wait(BACKGROUND_CONTEXT);
  const worker = await waitFor(
    async () => (await runtime.getActiveWorkers(String(router.id)))[0],
    (w) => w?.status === 'completed',
    'dispatch worker completion',
  );
  const workerTarget = await runtime.harness.snapshot(
    TargetDoc,
    Number(worker.conversationId) as ConversationId,
    BACKGROUND_CONTEXT,
  );
  assert.ok(workerTarget?.worktreePath, 'worker must run in a worktree');

  // 找到该 worker 派生的两个 subagent 子会话（MemoryStorage 下 id 顺序紧随 worker）
  const subs: { id: number; target: NonNullable<typeof workerTarget> }[] = [];
  for (let id = Number(worker.conversationId) + 1; id <= Number(worker.conversationId) + 40 && subs.length < 2; id++) {
    const target = await runtime.harness.snapshot(TargetDoc, id as ConversationId, BACKGROUND_CONTEXT);
    if (target?.role === 'subagent' && target.parentConversationId === worker.conversationId) {
      subs.push({ id, target });
    }
  }
  assert.equal(subs.length, 2, 'worker must have spawned two subagent conversations');
  const iso = subs.find((s) => s.target.worktreePath?.includes(`/sub-${s.id}`));
  const inherited = subs.find((s) => s !== iso);
  assert.ok(iso, 'the isolation subagent must own its own worktree path');
  assert.ok(inherited, 'the default subagent must exist');

  // isolation: 'worktree' → 独立分支 botd/sub-<id>
  assert.equal(iso.target.branchName, `botd/sub-${iso.id}`);
  assert.ok(iso.target.worktreePath?.endsWith(`.botd-worktrees/sub-${iso.id}`));
  // 不传 isolation → 继承父 Worker 的 worktreePath + branchName
  assert.equal(inherited.target.worktreePath, workerTarget?.worktreePath);
  assert.equal(inherited.target.branchName, workerTarget?.branchName);

  // 真实执行隔离：每个子代理的 bash 落在各自 cwd（隔离 worktree）里
  const isoProbe = await readFile(path.join(iso.target.worktreePath!, 'branch-probe-ISO.txt'), 'utf8');
  assert.match(isoProbe.trim(), new RegExp(`^botd/sub-${iso.id}$`), 'isolated subagent must execute on its own branch');
  const inhProbe = await readFile(path.join(workerTarget!.worktreePath!, 'branch-probe-INH.txt'), 'utf8');
  assert.equal(inhProbe.trim(), workerTarget?.branchName, 'default subagent must execute on the inherited worker branch');

  // subagent 返回正文 + worktree 注记都出现在 worker transcript 的工具结果里
  const workerConversation = await runtime.conversation(worker.conversationId);
  assert.ok(workerConversation);
  const page = await workerConversation.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT);
  const subagentResults = page.items
    .map((e) => e.model?.[0])
    .filter((m): m is NonNullable<typeof m> => m !== undefined && m.role === 'toolResult')
    .map((m) => JSON.stringify((m as { content?: unknown }).content));
  const isoResult = subagentResults.find((r) => r.includes('branch probe ISO done'));
  assert.ok(isoResult, 'isolated subagent answer must surface in the worker transcript');
  assert.match(isoResult, /\[worktree: botd\/sub-\d+ at [^\]]+\]/, 'subagent result must append the worktree note');
});

// ---------------------------------------------------------------------------
// 6. SubagentWorkflow：parallel() 并发 worktree 隔离 + resume(label) 复用子会话
// ---------------------------------------------------------------------------

test('6. SubagentWorkflow parallel worktree steps get independent branches; resume reuses the labeled conversation', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-wf-worktree-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await run('git', ['init', '-q', dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 'botd@test']);
  await run('git', ['-C', dir, 'config', 'user.name', 'botd-test']);
  await writeFile(path.join(dir, 'README.md'), '# repo\n');
  await run('git', ['-C', dir, 'add', '.']);
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  t.after(async () => {
    await runtime.close();
  });
  runtime.registerPersona(persona('lead', 'Lead', 'You orchestrate workflows.', dir));
  const router = await runtime.ensureBotMainSession('lead');

  const WORKFLOW_SCRIPT = `
export const meta = { name: "wt-parallel", description: "parallel isolated probes", phases: ["Probe"] }
const results = await parallel([
  () => agent("probe branch into LEFT", { label: "left", isolation: "worktree" }),
  () => agent("probe branch into RIGHT", { label: "right", isolation: "worktree" }),
])
const follow = await agent("probe branch into FOLLOW", { resume: "left" })
return { results: results.filter(Boolean), follow }
`;

  scriptRouter(faux, (ctx) => {
    const text = lastUserText(ctx.messages);
    // 工作流子代理回合：把当前分支写入 marker 文件（cwd = 步骤自己的 worktree）
    const wfMarker = text.match(/probe branch into (\w+)/)?.[1];
    if (wfMarker !== undefined) {
      const ranTools = toolResultThisTurn(ctx.messages);
      return ranTools
        ? fauxAssistantMessage(`probe ${wfMarker} done`)
        : fauxAssistantMessage(
            [fauxToolCall('bash', { command: `git rev-parse --abbrev-ref HEAD > branch-probe-${wfMarker}.txt` })],
            { stopReason: 'toolUse' },
          );
    }
    if (/run the parallel workflow/.test(text) && !toolResultThisTurn(ctx.messages)) {
      return fauxAssistantMessage([fauxToolCall('SubagentWorkflow', { script: WORKFLOW_SCRIPT })], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('workflow finished');
  });

  const settled = await (await runtime.submitUserMessage(String(router.id), 'run the parallel workflow')).wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, 'done', 'router turn must finish');

  // 找到本 workflow 派生的子会话：title 形如 step:N:left / step:N:right
  const wfChildren: { id: number; title: string; worktreePath?: string; branchName?: string }[] = [];
  for (let id = Number(router.id) + 1; id <= Number(router.id) + 60; id++) {
    const target = await runtime.harness.snapshot(TargetDoc, id as ConversationId, BACKGROUND_CONTEXT);
    if (target?.role === 'subagent' && target.parentConversationId === String(router.id) && (target.title ?? '').startsWith('step:')) {
      wfChildren.push({ id, title: target.title ?? '', worktreePath: target.worktreePath, branchName: target.branchName });
    }
  }
  assert.equal(
    wfChildren.length, 2,
    `parallel steps must create exactly two child conversations (got ${wfChildren.length}: ${wfChildren.map((c) => c.title).join(', ')})`,
  );
  const left = wfChildren.find((c) => c.title.endsWith(':left'));
  const right = wfChildren.find((c) => c.title.endsWith(':right'));
  assert.ok(left && right, 'both labeled child conversations must exist');

  // 独立子会话 + 独立 worktree 分支，互不干扰
  assert.notEqual(left.id, right.id);
  assert.notEqual(left.branchName, right.branchName);
  assert.equal(left.branchName, `botd/wf-${left.id}`);
  assert.equal(right.branchName, `botd/wf-${right.id}`);
  assert.ok(left.worktreePath?.endsWith(`.botd-worktrees/wf-${left.id}`));
  assert.ok(right.worktreePath?.endsWith(`.botd-worktrees/wf-${right.id}`));

  // 子代理真实在各自 worktree 分支下执行
  const leftProbe = await readFile(path.join(left.worktreePath!, 'branch-probe-LEFT.txt'), 'utf8');
  assert.equal(leftProbe.trim(), `botd/wf-${left.id}`, 'left step must execute on its own branch');
  const rightProbe = await readFile(path.join(right.worktreePath!, 'branch-probe-RIGHT.txt'), 'utf8');
  assert.equal(rightProbe.trim(), `botd/wf-${right.id}`, 'right step must execute on its own branch');
  // resume 的 follow-up 落在 left 的 worktree 分支上
  const followProbe = await readFile(path.join(left.worktreePath!, 'branch-probe-FOLLOW.txt'), 'utf8');
  assert.equal(followProbe.trim(), `botd/wf-${left.id}`, 'resumed follow-up must run on the left branch');

  // resume: "left" 复用 label=left 的子会话（同一会话收到第二条输入）
  const leftConversation = await runtime.conversation(String(left.id));
  assert.ok(leftConversation);
  const leftEntries = await leftConversation.entries({ order: 'ascending' }, 50, undefined, BACKGROUND_CONTEXT);
  const leftInputs = leftEntries.items
    .map((e) => e.model?.[0])
    .filter((m): m is NonNullable<typeof m> => m !== undefined && m.role === 'user')
    .map((m) => (typeof (m as { content?: unknown }).content === 'string' ? (m as { content: string }).content : ''));
  assert.ok(leftInputs.some((c) => c.includes('probe branch into LEFT')), 'left conversation must hold the first step input');
  assert.ok(leftInputs.some((c) => c.includes('probe branch into FOLLOW')), 'resume must reuse the left conversation for the follow-up');
});
