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
import { MemoryStorage } from '@earendil-works/pi-durable';

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

test('1. delegate_to_bot runs the full worker stack and reports back completed', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-delegate-'));
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  // 不传 workerAgent 覆盖：走 HubDurableRuntime 默认（workerAgentFor 全栈）。
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  try {
    runtime.registerPersona(persona('assistant', 'Assistant', 'You are the personal assistant.', dir));
    runtime.registerPersona(persona('architect', 'Architect', 'You design systems.', dir));

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
  assert.match(skill, /botd-skill: botd-cli v15/, 'SKILL.md must be seeded with the version marker');
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
