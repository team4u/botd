import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ArtifactRecord, BotConfig, SessionRecord } from '../packages/protocol/src/index.js';
import { startHub } from '../apps/hub/src/index.js';
import { HubClient } from '../apps/node/src/cli/hub-client.js';
import { loadBotResources } from '../apps/node/src/commands.js';
import { loadTurnDeps } from '../apps/node/src/runtime/turn-deps.js';
import { writeNodeIdentity } from '../apps/node/src/storage.js';

const ADMIN_PASSWORD = '{{SECRET_mnwf_a91x7k4d}}';
const OPS_PASSWORD = '{{SECRET_mnwf_qz82m5tv}}';

const waitFor = async (predicate: () => boolean, timeout = 10_000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for condition');
};

interface TurnInput {
  sessionId: string;
  botId: string;
  incrementalMessages: string;
  attachments?: Array<{ id: string; filename: string }>;
  incomingArtifacts?: Array<{ id: string; filename: string; fromBotName?: string }>;
}

/** 模拟节点回合返回；以 `__THROW__` 前缀触发远端节点执行失败 */
interface NodeSimReply {
  replyText: string;
  /** 本回合产出并关联到子会话的产物（零拷贝 storagePath 引用） */
  artifact?: { filename: string; mimeType: string; content: string };
}

interface NodeCall {
  nodeId: string;
  botId: string;
  sessionId: string;
  prompt: string;
}

interface TestEnv {
  hub: Awaited<ReturnType<typeof startHub>>;
  dir: string;
  hubUrl: string;
  adminUser: { id: string; username: string };
  opsUser: { id: string; username: string };
  /** 每次 runTurn 实际落到的 nodeId / botId / sessionId（验证按 nodeId 分发） */
  nodeCalls: NodeCall[];
  /** botId -> live 回合调用次数 */
  turnCounts: Map<string, number>;
  /** botId -> 最新一次收到的 prompt（校验 schema 注入与版本号传递） */
  lastPrompts: Map<string, string>;
  /** botId -> 最新一次回合的附件与传入产物引用 */
  lastAttachments: Map<string, Array<{ id: string; filename: string }> | undefined>;
  lastIncomingArtifacts: Map<string, Array<{ id: string; filename: string; fromBotName?: string }> | undefined>;
  /** botId -> 回复（字符串或按调用序号动态计算，支持“失败后修复”） */
  replies: Map<string, string | ((input: TurnInput, call: number) => string)>;
  /** botId -> 本回合产出物（构建节点产出 release-v1.tar.gz 等） */
  replyArtifacts: Map<string, NodeSimReply['artifact']>;
}

/**
 * 启动真实 HTTP Hub（port 0，绝不占用 3000），构建三个独立节点：
 * - node_coord（admin 所有，bot_coord 主控；dataDir 只写 node.json 节点凭据，不写 cli.json）
 * - node_linux（admin 所有，bot_linux_builder / bot_linux_tester）
 * - node_mac（opsUser 所有，bot_mac_tester 团队共享）
 *
 * 主控 Bot 通过真实 writeNodeIdentity 落盘 node.json，connectHubAsNode 走
 * x-botd-node-id / x-botd-node-token 节点 Token 认证（无管理员密码）。
 */
async function createTestEnv(t: TestContext): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-mnode-workflow-'));
  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: ADMIN_PASSWORD,
  });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const hubUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    hub.server.closeAllConnections();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const adminUser = hub.db.getUserWithHash('admin')!;

  // 第二位团队成员 opsUser：拥有 node_mac（macOS 测试节点）。仅作归属方，无需真实登录，
  // 密码哈希写入任意不可逆占位串即可满足 NOT NULL 约束。
  const opsUser = { id: 'user_ops_mn', username: 'opsUser' };
  hub.db.createUser({
    id: opsUser.id,
    username: opsUser.username,
    passwordHash: createHash('sha256').update(`ops-pw:${OPS_PASSWORD}`).digest('hex'),
    role: 'member',
  });

  const nodeToken = (nodeId: string) => `mnwf-token-${nodeId}`;
  const tokenHashOf = (token: string) => createHash('sha256').update(token).digest('hex');

  // 三个独立节点：node_coord / node_linux 归 admin，node_mac 归 opsUser
  for (const [nodeId, ownerId, platform] of [
    ['node_coord', adminUser.id, 'linux'],
    ['node_linux', adminUser.id, 'linux'],
    ['node_mac', opsUser.id, 'darwin'],
  ] as const) {
    hub.db.createNode({
      id: nodeId,
      name: nodeId,
      platform,
      tokenHash: tokenHashOf(nodeToken(nodeId)),
      ownerId,
    });
  }

  // 各节点上的 Bot：node_mac 的 tester 团队共享（跨用户可见）
  const bots: Array<[string, string, BotConfig['visibility']?]> = [
    ['bot_coord', 'node_coord'],
    ['bot_linux_builder', 'node_linux'],
    ['bot_linux_tester', 'node_linux'],
    ['bot_mac_tester', 'node_mac', 'team'],
  ];
  for (const [botId, nodeId, visibility] of bots) {
    hub.db.saveBot({
      id: botId,
      nodeId,
      name: botId,
      description: `bot on ${nodeId}`,
      modelProvider: 'openai',
      modelId: 'gpt-4o',
      thinkingLevel: 'medium',
      enabledSkills: [],
      enabledExtensions: [],
      ...(visibility ? { visibility } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  // 真实写入 node_coord 节点身份（node.json），不写 cli.json —— 强制走节点 Token 认证
  await writeNodeIdentity(dir, {
    nodeId: 'node_coord',
    name: 'node_coord',
    hubUrl,
    token: nodeToken('node_coord'),
  });

  const nodeCalls: NodeCall[] = [];
  const turnCounts = new Map<string, number>();
  const lastPrompts = new Map<string, string>();
  const lastAttachments = new Map<string, Array<{ id: string; filename: string }> | undefined>();
  const lastIncomingArtifacts = new Map<string, Array<{ id: string; filename: string; fromBotName?: string }> | undefined>();
  const replies = new Map<string, string | ((input: TurnInput, call: number) => string)>();
  const replyArtifacts = new Map<string, NodeSimReply['artifact']>();

  // hub.connections.getNodeRpc(nodeId) 按 nodeId 分发到各自独立的节点 RPC 模拟器
  const nodeIds = new Set(['node_coord', 'node_linux', 'node_mac']);
  (hub.connections as any).getNodeRpc = (nodeId: string) => {
    if (!nodeIds.has(nodeId)) return undefined;
    return {
      runTurn: async (input: any) => {
        const call = (turnCounts.get(input.botId) ?? 0) + 1;
        turnCounts.set(input.botId, call);
        nodeCalls.push({
          nodeId,
          botId: input.botId,
          sessionId: input.sessionId,
          prompt: String(input.incrementalMessages || ''),
        });
        lastPrompts.set(input.botId, String(input.incrementalMessages || ''));
        lastAttachments.set(input.botId, input.attachments);
        lastIncomingArtifacts.set(input.botId, input.incomingArtifacts);

        // 模拟远端节点在当前子会话产出真实 Artifact（零拷贝 storagePath 引用 + SSE 广播）
        const artifact = replyArtifacts.get(input.botId);
        if (artifact) {
          const storagePath = path.join(dir, 'artifact-store', `${input.botId}-${call}-${artifact.filename}`);
          hub.db.createArtifact({
            id: `art_mn_${input.botId}_${call}_${Math.random().toString(36).slice(2, 8)}`,
            sessionId: input.sessionId,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.content.length,
            senderBotId: input.botId,
            storagePath,
          });
          hub.sseHub.broadcast(input.sessionId, {
            type: 'artifact_created',
            sessionId: input.sessionId,
            artifact: hub.db.listSessionArtifacts(input.sessionId).slice(-1)[0],
          });
        }

        const configured = replies.get(input.botId);
        const replyText =
          typeof configured === 'function'
            ? configured(input as TurnInput, call)
            : configured ?? `ok:${input.botId}@${nodeId}`;
        if (replyText.startsWith('__THROW__')) {
          throw new Error(replyText.slice('__THROW__'.length));
        }
        return { replyText, modelBadge: 'openai/gpt-4o' };
      },
      cancelTurn: async () => {},
      resetSession: async () => {},
    };
  };

  return {
    hub,
    dir,
    hubUrl,
    adminUser: { id: adminUser.id, username: adminUser.username },
    opsUser,
    nodeCalls,
    turnCounts,
    lastPrompts,
    lastAttachments,
    lastIncomingArtifacts,
    replies,
    replyArtifacts,
  };
}

const createCoordinatorSession = (env: TestEnv): SessionRecord =>
  env.hub.db.createSession({
    id: `sess_mn_${Math.random().toString(36).slice(2, 8)}`,
    title: '跨节点多阶段发布',
    leadBotId: 'bot_coord',
    ownerId: env.adminUser.id,
  });

interface WorkflowRunOutcome {
  text: string;
  details: {
    taskId: string;
    runId: string;
    scriptPath: string;
    status: string;
    value?: unknown;
    replayedCount: number;
    agentCount: number;
  };
  isError?: boolean;
}

/** 构建挂载跨 BOT SubagentWorkflow 包装器的主控 bot_coord（node_coord 节点凭据） */
async function buildWorkflowTool(
  env: TestEnv,
  sessionId: string,
): Promise<{ tool: any; ctx: any; workspaceDir: string; loader: unknown }> {
  const { piAgent } = await loadTurnDeps();
  const { SettingsManager, ExtensionRunner, SessionManager, ModelRegistry, ModelRuntime } = piAgent;

  const coordBot: BotConfig = {
    id: 'bot_coord',
    nodeId: 'node_coord',
    name: 'Coordinator',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  const loader = await loadBotResources(
    env.dir,
    coordBot,
    SettingsManager.inMemory({ compaction: { enabled: false } }),
    () => [],
    { enableSubagents: true, sessionId },
  );
  const { extensions, runtime } = loader.getExtensions();
  const models = await ModelRuntime.create({
    authPath: path.join(env.dir, '.agent', 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(extensions, runtime, env.dir, SessionManager.inMemory(env.dir), new ModelRegistry(models));
  const tool = runner.getToolDefinition('SubagentWorkflow');
  assert.ok(tool, 'SubagentWorkflow tool must be registered on bot_coord');
  const botDir = path.join(env.dir, 'bots', 'bot_coord');
  return { tool, ctx: runner.createToolContext('tc_mn', undefined), workspaceDir: path.join(botDir, 'workspace'), loader };
}

const runWorkflowTool = async (tool: any, ctx: any, params: Record<string, unknown>): Promise<WorkflowRunOutcome> => {
  const res: any = await tool.execute(`tc_mn_${Math.random().toString(36).slice(2, 6)}`, params, undefined, undefined, ctx);
  return {
    text: String(res.content?.[0]?.text ?? ''),
    details: (res.details ?? {}) as WorkflowRunOutcome['details'],
    isError: res.isError === true ? true : undefined,
  };
};

test('SubagentWorkflow: 跨 3 节点（含团队共享跨用户节点）多阶段并行工作流 + 结构化 Schema + 跨节点产物零拷贝回传', { timeout: 120_000 }, async (t) => {
  const env = await createTestEnv(t);

  // Phase 1：node_linux 上的 builder 返回结构化版本号并产出构建产物
  env.replies.set(
    'bot_linux_builder',
    JSON.stringify({ version: '2.4.1', artifactName: 'release-v2.4.1.tar.gz' }),
  );
  env.replyArtifacts.set('bot_linux_builder', {
    filename: 'release-v2.4.1.tar.gz',
    mimeType: 'application/gzip',
    content: 'fake-gzip-payload-release-v2.4.1',
  });
  // Phase 2：两个平台的 tester 回显收到的版本号
  env.replies.set('bot_linux_tester', 'linux-node: PASS (version 2.4.1)');
  env.replies.set('bot_mac_tester', 'mac-node: PASS (version 2.4.1)');

  const parent = createCoordinatorSession(env);
  const { tool, ctx, workspaceDir } = await buildWorkflowTool(env, parent.id);

  const script = `
export const meta = { name: "multi-node-release", description: "Build on linux node, test on linux + team-shared mac nodes" }
phase("Build")
const build = await agent("produce the release artifact and report the version", {
  agentType: "@bot_linux_builder",
  label: "build-linux",
  schema: {
    type: "object",
    properties: { version: { type: "string" }, artifactName: { type: "string" } },
    required: ["version", "artifactName"],
  },
});
if (!build) throw new Error("build step on node_linux failed");
phase("Test")
const reports = await parallel([
  () => agent("regress-test version " + build.version + " on the linux node", { agentType: "@bot_linux_tester", label: "test-linux" }),
  () => agent("regress-test version " + build.version + " on the team-shared mac node", { agentType: "@bot_mac_tester", label: "test-mac" }),
]);
return { version: build.version, artifactName: build.artifactName, reports: reports.filter(Boolean) };
`.trim();

  const out = await runWorkflowTool(tool, ctx, { script });

  assert.equal(out.details.status, 'completed', `workflow must complete: ${out.text}`);
  assert.equal(out.isError, undefined);
  assert.equal((out.details.value as any).version, '2.4.1');
  assert.equal((out.details.value as any).artifactName, 'release-v2.4.1.tar.gz');
  assert.deepEqual((out.details.value as any).reports, [
    'linux-node: PASS (version 2.4.1)',
    'mac-node: PASS (version 2.4.1)',
  ]);
  assert.equal(out.details.agentCount, 3);
  assert.equal(out.details.replayedCount, 0);

  // 每个 Bot 恰好 live 调用一次
  assert.equal(env.turnCounts.get('bot_linux_builder'), 1);
  assert.equal(env.turnCounts.get('bot_linux_tester'), 1);
  assert.equal(env.turnCounts.get('bot_mac_tester'), 1);

  // 关键断言：RPC 按 nodeId 正确分发 —— builder/tester-linux 落在 node_linux，tester-mac 落在 node_mac
  const nodeOf = (botId: string) => env.nodeCalls.filter((c) => c.botId === botId).map((c) => c.nodeId);
  assert.deepEqual(nodeOf('bot_linux_builder'), ['node_linux']);
  assert.deepEqual(nodeOf('bot_linux_tester'), ['node_linux']);
  assert.deepEqual(nodeOf('bot_mac_tester'), ['node_mac'], 'team-shared mac tester must be routed to node_mac (owned by opsUser)');
  // 三次子会话调用各自拥有独立的 sessionId（分属三个不同节点的子会话）
  const childSessionIds = new Set(env.nodeCalls.map((c) => c.sessionId));
  assert.equal(childSessionIds.size, 3, 'three sub-sessions on three distinct nodes');
  assert.ok(env.nodeCalls.every((c) => c.sessionId !== parent.id));

  // Schema 注入了结构化输出要求；两个 Tester 都拿到了 Phase 1 解析出的版本号
  assert.ok(env.lastPrompts.get('bot_linux_builder')!.includes('[Structured Output Requirement]'));
  assert.ok(env.lastPrompts.get('bot_linux_tester')!.includes('2.4.1'));
  assert.ok(env.lastPrompts.get('bot_mac_tester')!.includes('2.4.1'));

  // 跨节点产物回传：builder 的构建产物零拷贝回到父会话（同 storagePath 新引用行）
  const parentArtifacts = env.hub.db.listSessionArtifacts(parent.id);
  assert.equal(parentArtifacts.length, 1, `parent artifacts: ${JSON.stringify(parentArtifacts)}`);
  assert.equal(parentArtifacts[0].filename, 'release-v2.4.1.tar.gz');
  assert.equal(parentArtifacts[0].senderBotId, 'bot_linux_builder');
  const returnedWith = env.hub.db.getArtifactWithStoragePath(parentArtifacts[0].id)!;
  const builderSession = env.nodeCalls.find((c) => c.botId === 'bot_linux_builder')!.sessionId;
  const producedWith = env.hub.db
    .listSessionArtifacts(builderSession)
    .map((a) => env.hub.db.getArtifactWithStoragePath(a.id)!)
    .find((a) => a.filename === 'release-v2.4.1.tar.gz')!;
  assert.equal(returnedWith.storagePath, producedWith.storagePath, 'zero-copy: parent reference shares the child storagePath');

  // 后续派生的 Tester 子会话自动继承了该 Artifact（附件 + 初始消息产物清单 + incomingArtifacts）
  const macSession = env.nodeCalls.find((c) => c.botId === 'bot_mac_tester')!.sessionId;
  const macInherited = env.hub.db.listSessionArtifacts(macSession);
  assert.equal(macInherited.length, 1, `mac tester session artifacts: ${JSON.stringify(macInherited)}`);
  assert.equal(macInherited[0].filename, 'release-v2.4.1.tar.gz');
  assert.ok(env.lastPrompts.get('bot_mac_tester')!.includes('[关联产物文件]'));
  assert.ok(env.lastPrompts.get('bot_mac_tester')!.includes('release-v2.4.1.tar.gz'));
  const macIncoming = env.lastIncomingArtifacts.get('bot_mac_tester') ?? [];
  assert.equal(macIncoming.filter((a) => a.filename === 'release-v2.4.1.tar.gz').length, 1, `mac incomingArtifacts: ${JSON.stringify(macIncoming)}`);
  const linuxIncoming = env.lastIncomingArtifacts.get('bot_linux_tester') ?? [];
  assert.equal(linuxIncoming.filter((a) => a.filename === 'release-v2.4.1.tar.gz').length, 1, `linux incomingArtifacts: ${JSON.stringify(linuxIncoming)}`);
  const macAttachments = env.lastAttachments.get('bot_mac_tester') ?? [];
  assert.equal(macAttachments.filter((a) => a.filename === 'release-v2.4.1.tar.gz').length, 1, `mac message attachments: ${JSON.stringify(macAttachments)}`);

  // journal 落盘：三个步骤各一条成功记录
  const workflowsDir = path.join(workspaceDir, '.workflows');
  assert.ok(existsSync(path.join(workflowsDir, `${out.details.runId}.mjs`)), 'script copy persisted');
  const journalFile = path.join(workflowsDir, `${out.details.runId}.workflow.jsonl`);
  assert.ok(existsSync(journalFile), 'journal persisted');
  const journalEntries = (await readFile(journalFile, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(journalEntries.length, 3);
  assert.ok(journalEntries.every((e: any) => e.ok === true));

  // 父会话下挂三个子会话，leadBot 分别是三个远端 Bot
  const subs = await (await HubClient.connect({ dataDir: env.dir })).get<SessionRecord[]>(
    `/api/sessions/${encodeURIComponent(parent.id)}/subsessions`,
  );
  assert.equal(subs.length, 3);
  assert.deepEqual(new Set(subs.map((s) => s.leadBotId)), new Set(['bot_linux_builder', 'bot_linux_tester', 'bot_mac_tester']));
});

test('SubagentWorkflow: 跨节点工作流远端节点失败后 resumeFromRunId 断点续跑（node_linux 缓存回放 / node_mac 重跑）', { timeout: 180_000 }, async (t) => {
  const env = await createTestEnv(t);

  const parent = createCoordinatorSession(env);
  const { tool, ctx } = await buildWorkflowTool(env, parent.id);

  const script = `
export const meta = { name: "multi-node-retry", description: "linux steps succeed, mac step fails then gets fixed" }
phase("Build")
const build = await agent("build the candidate release", {
  agentType: "@bot_linux_builder",
  label: "build-linux",
  schema: {
    type: "object",
    properties: { version: { type: "string" }, artifactName: { type: "string" } },
    required: ["version", "artifactName"],
  },
});
if (!build) throw new Error("build step on node_linux failed");
phase("Test")
const reports = await parallel([
  () => agent("test version " + build.version + " on the linux node", { agentType: "@bot_linux_tester", label: "test-linux" }),
  () => agent("test version " + build.version + " on the mac node", { agentType: "@bot_mac_tester", label: "test-mac" }),
]);
const failed = reports.some((r) => !r);
if (failed) throw new Error("remote node step failed: " + reports.map((r) => r ?? "FAILED").join(" | "));
return { version: build.version, reports: reports.filter(Boolean) };
`.trim();

  // 第一次运行：builder 与 linux tester 成功，mac tester（node_mac）模拟远端节点执行崩溃
  env.replies.set('bot_linux_builder', JSON.stringify({ version: '3.0.0', artifactName: 'release-v3.0.0.tar.gz' }));
  env.replies.set('bot_linux_tester', 'linux-node: PASS (version 3.0.0)');
  env.replies.set('bot_mac_tester', '__THROW__simulated crash on node_mac');

  const firstRun = await runWorkflowTool(tool, ctx, { script });
  assert.equal(firstRun.details.status, 'failed', `first run must fail: ${firstRun.text}`);
  assert.equal(firstRun.isError, true);
  assert.ok(firstRun.details.runId.startsWith('wf_'));
  assert.match(firstRun.text, /resumeFromRunId: "wf_[a-z0-9]+"/);
  assert.ok(firstRun.text.includes('remote node step failed'), `failure text: ${firstRun.text}`);
  assert.equal(env.turnCounts.get('bot_linux_builder'), 1);
  assert.equal(env.turnCounts.get('bot_linux_tester'), 1);
  assert.equal(env.turnCounts.get('bot_mac_tester'), 1);

  // 修复 node_mac 的模拟回复后断点续跑
  env.replies.set('bot_mac_tester', 'mac-node: PASS (version 3.0.0)');
  const secondRun = await runWorkflowTool(tool, ctx, {
    scriptPath: firstRun.details.scriptPath,
    resumeFromRunId: firstRun.details.runId,
  });

  assert.equal(secondRun.details.status, 'completed', `resume run must complete: ${secondRun.text}`);
  assert.equal(secondRun.isError, undefined);
  assert.equal(secondRun.details.agentCount, 3);
  assert.equal(secondRun.details.replayedCount, 2, 'build + linux-test replayed from journal cache');
  assert.deepEqual((secondRun.details.value as any).reports, [
    'linux-node: PASS (version 3.0.0)',
    'mac-node: PASS (version 3.0.0)',
  ]);
  assert.equal((secondRun.details.value as any).version, '3.0.0');
  assert.match(secondRun.text, /Replayed from wf_[a-z0-9]+: 2\/3 step\(s\) from journal cache\./);

  // 关键断言：node_linux 上的两个 Bot 均从 journal 缓存回放（调用次数保持 1），
  // 只有 node_mac 上的 mac tester 被重新调用（1 -> 2）
  assert.equal(env.turnCounts.get('bot_linux_builder'), 1, 'bot_linux_builder must NOT be re-called on resume');
  assert.equal(env.turnCounts.get('bot_linux_tester'), 1, 'bot_linux_tester must NOT be re-called on resume');
  assert.equal(env.turnCounts.get('bot_mac_tester'), 2, 'bot_mac_tester must re-run live after the fix');

  // 重跑的 mac tester 仍被路由到 node_mac，且 prompt 来自回放的 Phase 1 版本号
  const macCalls = env.nodeCalls.filter((c) => c.botId === 'bot_mac_tester');
  assert.equal(macCalls.length, 2);
  assert.ok(macCalls.every((c) => c.nodeId === 'node_mac'));
  assert.ok(env.lastPrompts.get('bot_mac_tester')!.includes('3.0.0'), 're-run mac tester must receive the replayed version');
});
