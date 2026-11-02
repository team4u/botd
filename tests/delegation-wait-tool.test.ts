import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { BotConfig, DelegateSessionResult, MessageRecord, SessionRecord } from '../packages/protocol/src/index.js';
import { startHub } from '../apps/hub/src/index.js';
import { buildProgram } from '../apps/node/src/cli/program.js';
import { HubClient } from '../apps/node/src/cli/hub-client.js';
import { delegateSessionAndWait } from '../apps/node/src/cli/commands/sessions.js';
import { loadBotResources } from '../apps/node/src/commands.js';
import { loadTurnDeps } from '../apps/node/src/runtime/turn-deps.js';

const PASSWORD = '{{SECRET_cgxq2tsc}}';

const waitFor = async (predicate: () => boolean, timeout = 8000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for condition');
};

interface TestEnv {
  hub: Awaited<ReturnType<typeof startHub>>;
  dir: string;
  hubUrl: string;
  adminUser: { id: string; username: string };
  leadTurns: string[];
  workerTurns: string[];
}

/**
 * 启动真实 HTTP Hub（端口 0，绝不占用 3000），并用 HubClient.establish 预写 cli.json，
 * 使被测代码内部的 HubClient.connect({ dataDir }) 无需再次登录即可访问 Hub。
 */
async function createTestEnv(t: TestContext, options?: { workerTurn?: (input: any) => Promise<any> }): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-delegate-wait-'));
  const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'hub.sqlite'), adminPassword: PASSWORD });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const hubUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const adminUser = hub.db.getUserWithHash('admin')!;
  hub.db.createNode({
    id: 'node_del',
    name: 'Delegate Node',
    platform: 'linux',
    tokenHash: 'dummy_hash',
    ownerId: adminUser.id,
  });
  for (const botId of ['bot_lead', 'bot_worker']) {
    hub.db.saveBot({
      id: botId,
      nodeId: 'node_del',
      name: botId,
      description: '',
      modelProvider: 'openai',
      modelId: 'gpt-4o',
      thinkingLevel: 'medium',
      enabledSkills: [],
      enabledExtensions: [],
      updatedAt: new Date().toISOString(),
    });
  }

  const leadTurns: string[] = [];
  const workerTurns: string[] = [];
  (hub.connections as any).getNodeRpc = () => ({
    runTurn: async (input: any) => {
      if (input.botId === 'bot_worker') {
        workerTurns.push(input.sessionId);
        if (options?.workerTurn) return options.workerTurn(input);
        return { replyText: '子任务完成：报告已生成。', modelBadge: 'openai/gpt-4o' };
      }
      leadTurns.push(input.sessionId);
      return { replyText: '父会话汇总完成。', modelBadge: 'openai/gpt-4o' };
    },
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  // 预登录并把凭据写入 <dataDir>/cli.json：被测代码内部的 HubClient.connect({ dataDir }) 直接复用 token
  await HubClient.establish(hubUrl, 'admin', PASSWORD, { dataDir: dir });

  return { hub, dir, hubUrl, adminUser: { id: adminUser.id, username: adminUser.username }, leadTurns, workerTurns };
}

const createParentSession = (env: TestEnv): SessionRecord =>
  env.hub.db.createSession({
    id: `sess_parent_${Math.random().toString(36).slice(2, 8)}`,
    title: '跨 BOT 协同',
    mode: 'direct',
    leadBotId: 'bot_lead',
    memberBotIds: ['bot_lead'],
    ownerId: env.adminUser.id,
  });

test('CLI --wait: delegate 完成等待返回 status/reply/returnedArtifacts，autoWakeParent=false 不触发父会话第二轮', { timeout: 30_000 }, async (t) => {
  const env = await createTestEnv(t, {
    workerTurn: async (input) => {
      // 子会话执行期间产出一个新交付物：完成后应零拷贝回传父会话并出现在 returnedArtifacts
      env.hub.db.createArtifact({
        id: `art_out_${input.sessionId.slice(-6)}`,
        sessionId: input.sessionId,
        filename: 'analysis_report.md',
        mimeType: 'text/markdown',
        sizeBytes: 256,
        senderBotId: 'bot_worker',
        storagePath: '/tmp/botd-delwait-report.md',
      });
      return { replyText: '子任务完成：报告已生成。', modelBadge: 'openai/gpt-4o' };
    },
  });
  const parent = createParentSession(env);

  const program = buildProgram();
  program.exitOverride();
  let stdout = '';
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  };
  try {
    await program.parseAsync([
      'node', 'cli',
      '--data-dir', env.dir,
      '--hub', env.hubUrl,
      '--password', PASSWORD,
      '--json',
      'sessions', 'delegate', parent.id,
      '--bot', 'bot_worker',
      '--prompt', '请生成分析报告',
      '--wait', '10',
    ]);
  } finally {
    console.log = origLog;
  }

  const out = JSON.parse(stdout.trim());
  assert.equal(out.status, 'done', `status must be done: ${JSON.stringify(out)}`);
  assert.equal(out.reply, '子任务完成：报告已生成。');
  assert.ok(Array.isArray(out.returnedArtifacts) && out.returnedArtifacts.length === 1, 'worker artifact must be returned');
  assert.equal(out.returnedArtifacts[0].filename, 'analysis_report.md');
  assert.equal(out.parentSessionId, parent.id);
  assert.equal(out.childSession.leadBotId, 'bot_worker');

  // autoWakeParent=false：完成回传不唤醒父会话 lead bot（不会为汇总触发第二轮 runTurn）
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(env.leadTurns.length, 0, 'parent lead bot must NOT be triggered for a summary turn');
  assert.equal(env.workerTurns.length, 1, 'worker executes exactly one turn');

  // 父会话应有一条完成 callback 消息（带 attachments），子会话消息含 assistant 回复
  const parentMessages = env.hub.db.getMessages(parent.id);
  const completion = parentMessages.find(
    (m) => m.role === 'callback' && m.content.startsWith('✅') && m.content.includes(`(#?s=${out.childSession.id})`),
  );
  assert.ok(completion, 'parent session must contain the completion callback');
  assert.equal(completion.attachments?.length, 1);
  const childMessages = env.hub.db.getMessages(out.childSession.id);
  assert.ok(childMessages.some((m) => m.role === 'assistant' && m.content === '子任务完成：报告已生成。'));
});

test('delegateSessionAndWait: 子会话失败时返回 status=failed 与错误详情', { timeout: 30_000 }, async (t) => {
  const env = await createTestEnv(t, {
    workerTurn: async () => {
      throw new Error('模拟子任务执行崩溃');
    },
  });
  const parent = createParentSession(env);
  const client = await HubClient.connect({ dataDir: env.dir });

  const result = await delegateSessionAndWait(
    client,
    parent.id,
    { botId: 'bot_worker', prompt: '执行高危任务', autoWakeParent: false },
    { waitSeconds: 15 },
  );

  assert.equal(result.status, 'failed');
  assert.ok(result.reply.includes('模拟子任务执行崩溃'), `reply should carry the error detail: ${result.reply}`);
  assert.deepEqual(result.returnedArtifacts, []);
  assert.equal(result.childSession.leadBotId, 'bot_worker');

  // 失败 callback（❌ 前缀）必须已落到父会话公屏
  const parentMessages = env.hub.db.getMessages(parent.id);
  assert.ok(parentMessages.some((m) => m.role === 'callback' && m.content.startsWith('❌') && m.content.includes('模拟子任务执行崩溃')));
});

test('delegateSessionAndWait: 快速完成的子会话不因 SSE 开流竞态漏采结果', { timeout: 30_000 }, async (t) => {
  const env = await createTestEnv(t);
  const parent = createParentSession(env);
  const client = await HubClient.connect({ dataDir: env.dir });

  const result = await delegateSessionAndWait(
    client,
    parent.id,
    { botId: 'bot_worker', prompt: '快速任务', autoWakeParent: false },
    { waitSeconds: 15 },
  );

  assert.equal(result.status, 'done');
  assert.equal(result.reply, '子任务完成：报告已生成。');
});

test('loadBotResources: 主 BOT 注册 delegate_bot（含 Agent/stop_subagent），子代理不注册', { timeout: 60_000 }, async (t) => {
  const env = await createTestEnv(t);
  const { piAgent } = await loadTurnDeps();
  const { SettingsManager, ExtensionRunner, SessionManager, ModelRegistry, ModelRuntime } = piAgent;

  const buildRunner = async (bot: BotConfig, options: { enableSubagents?: boolean; sessionId?: string }) => {
    const loader = await loadBotResources(
      env.dir,
      bot,
      SettingsManager.inMemory({ compaction: { enabled: false } }),
      () => [],
      options,
    );
    const { extensions, runtime } = loader.getExtensions();
    const models = await ModelRuntime.create({
      authPath: path.join(env.dir, '.agent', 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const runner = new ExtensionRunner(extensions, runtime, env.dir, SessionManager.inMemory(env.dir), new ModelRegistry(models));
    return runner;
  };

  const leadBot: BotConfig = {
    id: 'bot_lead',
    nodeId: 'node_del',
    name: 'Lead',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  const parent = createParentSession(env);

  const primaryRunner = await buildRunner(leadBot, { enableSubagents: true, sessionId: parent.id });
  const delegateTool: any = primaryRunner.getToolDefinition('delegate_bot');
  assert.ok(delegateTool, 'primary bot must register delegate_bot');
  assert.ok(primaryRunner.getToolDefinition('Agent'), 'primary bot must register Agent');
  assert.ok(primaryRunner.getToolDefinition('stop_subagent'), 'primary bot must register stop_subagent');
  assert.ok((delegateTool.parameters as any).required, 'parameters must declare required fields');
  assert.deepEqual((delegateTool.parameters as any).required, ['bot_id', 'prompt']);

  const subRunner = await buildRunner(
    { ...leadBot, id: 'bot_sub', parentBotId: 'bot_lead' },
    { enableSubagents: false, sessionId: parent.id },
  );
  assert.ok(!subRunner.getToolDefinition('delegate_bot'), 'subagent (parentBotId set) must NOT register delegate_bot');
  assert.ok(!subRunner.getToolDefinition('Agent'), 'subagent must not register Agent');

  // 前台执行：等待完成并返回 reply（autoWakeParent=false 不触发父会话汇总回合）
  const fg = await delegateTool.execute(
    'tc_fg',
    { bot_id: '@bot_worker', prompt: '前台任务' },
    undefined,
    undefined,
    primaryRunner.createToolContext('tc_fg', undefined),
  );
  assert.equal(fg.isError, undefined, `foreground delegate must succeed: ${JSON.stringify(fg)}`);
  const fgText: string = fg.content[0].text;
  assert.match(fgText, /Sub-session: .+ \(@bot_worker\) — done/);
  assert.ok(fgText.includes('子任务完成：报告已生成。'));
  assert.equal((fg.details as any).status, 'done');
  assert.equal(env.leadTurns.length, 0, 'autoWakeParent=false must not wake the parent lead bot');
  assert.equal(env.workerTurns.length, 1);

  // 后台执行：立即返回子会话已派发的提示，autoWakeParent=true 在完成后唤醒父会话
  const bg = await delegateTool.execute(
    'tc_bg',
    { bot_id: 'bot_worker', prompt: '后台任务', run_in_background: true },
    undefined,
    undefined,
    primaryRunner.createToolContext('tc_bg', undefined),
  );
  const bgText: string = bg.content[0].text;
  assert.match(bgText, /Delegated background sub-session ".+" \(.+\) to @bot_worker\. The parent session will be woken up automatically/);
  assert.ok((bg.details as DelegateSessionResult).childSession.id);

  await waitFor(() => env.leadTurns.length > 0, 8000);
  assert.equal(env.workerTurns.length, 2, 'background delegation must also execute the worker turn');
});
