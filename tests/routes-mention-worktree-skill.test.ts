/**
 * routes-mention-worktree-skill.test.ts — Hub 路由三项优化集成测试：
 *  1. POST /api/sessions/:id/workers 接收 Web 派发载荷（instructions/isolation/
 *     threadKeys），落 worktreePath + branchName 并订阅全部 threadKeys；
 *  2. 多分身群聊：@reviewer 消息把 Durable 回合路由到 reviewer 分身（其 persona
 *     指令/模型生效），镜像回复 senderBotId === 'reviewer'；
 *  3. /code-review 斜杠命令在 Hub SQLite 存在该技能时改写为 load_skill 引导提示；
 *  4. 自定义 workspaceDir 的会话把 Router 会话 TargetDoc.cwd 覆盖为该目录。
 *
 * 全部跑在真实 Hono app + HubDurableRuntime（faux provider，无真实 LLM）上。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';
import { TargetDoc } from '../apps/hub/src/harness/docs.js';
import { ensureRouterConversationId } from '../apps/hub/src/routes/workers.js';

const PASSWORD = 'test-admin-password';

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T> | T,
  check: (value: T) => boolean,
  message: string,
  timeoutMs = 8_000,
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

interface Fixture {
  base: string;
  cookie: string;
  hub: Awaited<ReturnType<typeof startHub>>;
  runtime: HubDurableRuntime;
  faux: ReturnType<typeof fauxProvider>;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
  request: (route: string, method?: string, body?: unknown) => Promise<Response>;
}

/**
 * 完整 fixture：faux provider + 注入式 HubDurableRuntime + 双分身（pm / reviewer）
 * 会话与 Hub SQLite 技能 code-review。faux 响应按 transcript 内容脚本化。
 */
async function fixture(t: TestContext, options?: { workspaceDir?: string }): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-mention-worktree-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'main' }] });
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
    await runtime.close();
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
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = async (route: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(route, method, body);
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  // 种子：节点 + 双 Bot（pm / reviewer）+ 多分身会话 + Hub 技能 code-review。
  const db = hub.db;
  db.createNode({
    id: 'node-1',
    name: 'Test node',
    platform: 'linux',
    tokenHash: 'x'.repeat(64),
    ownerId: 'user_admin',
  });
  const now = new Date().toISOString();
  for (const [id, name] of [
    ['pm', 'PM'],
    ['reviewer', 'Reviewer'],
  ] as const) {
    db.saveBot({
      id,
      nodeId: 'node-1',
      name,
      description: `You are ${name}.`,
      modelProvider: 'faux',
      modelId: 'main',
      enabledSkills: [],
      updatedAt: now,
    });
    // SYSTEM.md 走 Hub 权威存储：ensureDurableRuntime 每次重同步分身时以它为准。
    db.setBotFile(id, 'system', `You are the ${id} bot with reviewer-grade instincts.`);
  }
  // 先触发一次 ensureDurableRuntime，把 db 分身同步进 runtime；再显式注册
  // 同源分身（保 persona 注册在位），后续提交前的重同步保持一致。
  await hub.ensureDurableRuntime();
  for (const id of ['pm', 'reviewer']) {
    const bot = db.getBot(id)!;
    const persona: BotPersonaConfig = {
      botId: id,
      name: bot.name,
      model: { provider: 'faux', modelId: 'main' },
      instructions: `You are the ${id} bot with reviewer-grade instincts.`,
      nodeId: 'node-1',
      cwd: process.cwd(),
    };
    runtime.registerPersona(persona);
  }
  db.createSession({
    id: 'sess_group',
    title: 'Mention routing',
    leadBotId: 'pm',
    ownerId: 'user_admin',
    ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
  });
  // Hub SQLite 技能：dataDir/skills/code-review/SKILL.md（getSkillContent 可见）。
  db.saveSkillContent(
    'code-review',
    '---\nname: code-review\ndescription: Review code for defects.\n---\n\nReview the diff carefully.',
  );

  return { base, cookie, hub, runtime, faux, json, request };
}

const lastUserText = (messages: readonly { role: string; content: unknown }[]): string => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (typeof lastUser?.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? '');
  return '';
};

test(
  'Web worker payload: instructions/isolation/threadKeys spawn worktree worker with branch + multi-thread subscriptions',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const sid = 'sess_group';
    f.faux.setResponses([...Array(32)].map(() => fauxAssistantMessage('Working in the worktree.')));

    // Web 端 spawnSuperAgentWorker 的真实载荷形态。
    const spawned = await f.json<{
      ok: boolean;
      worker: { workerId: string; conversationId: string; worktreePath?: string; branchName?: string; threadKeys?: string[] };
    }>(`/api/sessions/${sid}/workers`, 'POST', {
      title: 'Fix auth',
      instructions: 'Check token',
      isolation: 'worktree',
      threadKeys: ['github:pr#42', 'ci:run#9'],
    });
    assert.equal(spawned.ok, true);
    const workerId = spawned.worker.workerId;
    const spawnedWorkerConvId = spawned.worker.conversationId;
    assert.match(workerId, /^w-\d+-\d+$/);
    assert.equal(spawned.worker.threadKeys?.length, 2);
    assert.deepEqual(spawned.worker.threadKeys, ['github:pr#42', 'ci:run#9']);
    assert.ok(spawned.worker.worktreePath, 'worktreePath set on the spawned worker');
    assert.ok(spawned.worker.worktreePath!.includes(`.botd-worktrees/${workerId}`));
    assert.equal(spawned.worker.branchName, `botd/${workerId}`);

    // 列表同样带 worktreePath / branchName / threadKeys。
    const listed = await waitFor(
      async () =>
        await f.json<{
          workers: Array<{ workerId: string; worktreePath?: string; branchName?: string; threadKeys: string[] }>;
        }>(`/api/sessions/${sid}/workers`),
      (result) =>
        result.workers.some(
          (w) => w.workerId === workerId && w.worktreePath !== undefined && w.branchName === `botd/${workerId}`,
        ),
      'spawned worker to appear with worktreePath + branchName',
    );
    const item = listed.workers.find((w) => w.workerId === workerId)!;
    assert.deepEqual(item.threadKeys, ['github:pr#42', 'ci:run#9']);

    // 两个 threadKey 都已写入直通订阅表（ThreadSubscriptionsDoc），
    // 后续同线程事件将 pass_through 到 Worker 会话。
    const { ThreadSubscriptionsDoc } = await import('../apps/hub/src/harness/event-router.js');
    const subs = await f.runtime.harness.snapshot(ThreadSubscriptionsDoc, BACKGROUND_CONTEXT);
    for (const threadKey of ['github:pr#42', 'ci:run#9']) {
      const list = (subs?.subs as Record<string, string[]> | undefined)?.[threadKey] ?? [];
      assert.ok(
        list.includes(String(spawnedWorkerConvId)),
        `${threadKey} subscribed to the worker conversation`,
      );
    }

    // 清场：停掉 Worker，避免后续断言与流式回合竞争。
    await f.json(`/api/sessions/${sid}/workers/${encodeURIComponent(workerId)}/stop`, 'POST');
  },
);

test(
  'multi-bot mention: @reviewer routes the durable turn to the reviewer persona and mirrors senderBotId',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const sid = 'sess_group';

    // 先发一条给 lead (pm) 的消息建立 Router 会话，再 @reviewer 切换目标分身。
    f.faux.setResponses([
      fauxAssistantMessage('pm ack.'),
      fauxAssistantMessage('reviewer ack: LGTM with nits.'),
    ]);
    await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: 'pm please plan the release' });
    await f.runtime.harness.waitForIdle(BACKGROUND_CONTEXT);

    const posted = await f.json<{ id: string; role: string; mentions: string[] }>(
      `/api/sessions/${sid}/messages`,
      'POST',
      { content: '@reviewer please check this' },
    );
    assert.deepEqual(posted.mentions, ['reviewer']);
    await f.runtime.harness.waitForIdle(BACKGROUND_CONTEXT);

    // Router 会话的 agent 已切到 reviewer 分身（persona 指令生效）。
    const routerId = await ensureRouterConversationId(f.runtime, sid, 'reviewer');
    const conv = await f.runtime.conversation(routerId, BACKGROUND_CONTEXT);
    assert(conv, 'router conversation exists');
    const agent = await conv.agent(BACKGROUND_CONTEXT);
    assert.match(agent.instructions ?? '', /reviewer bot/, 'reviewer persona instructions active');
    assert.equal(agent.model?.provider, 'faux');

    // 镜像回复带 reviewer 归属（@ 前缀而非裸 id）。
    const messages = await waitFor(
      async () => await f.json<Array<{ role: string; content: string; senderBotId?: string }>>(`/api/sessions/${sid}/messages`),
      (list) => list.some((m) => m.role === 'assistant' && /reviewer ack/.test(m.content)),
      'reviewer reply mirrored',
    );
    const reply = messages.find((m) => m.role === 'assistant' && /reviewer ack/.test(m.content))!;
    assert.equal(reply.senderBotId, 'reviewer');

    // TargetDoc 已随 @ 切换更新 botId。
    const target = await f.runtime.harness.snapshot(
      TargetDoc,
      Number(routerId) as any,
      BACKGROUND_CONTEXT,
    );
    assert.equal(target?.botId, 'reviewer');
  },
);

test(
  'skill slash command: /code-review exists in Hub SQLite and prompts load_skill',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const sid = 'sess_group';

    let seenPrompt = '';
    f.faux.setResponses([
      (context: any) => {
        seenPrompt = lastUserText(context.messages);
        return fauxAssistantMessage('Skill loaded, review done.');
      },
    ] as never);

    await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: '/code-review check auth.ts' });
    await f.runtime.harness.waitForIdle(BACKGROUND_CONTEXT);

    assert.match(
      seenPrompt,
      /\[Slash Command \/code-review\]: Call `load_skill\(\{ skillId: "code-review" \}\)` and follow its instructions/,
      'final content guides the model to load_skill',
    );
    assert.match(seenPrompt, /for the user request:\s*check auth\.ts/, 'skill args ride along');
  },
);

test(
  'custom workspaceDir: session creation overrides the router conversation TargetDoc.cwd',
  { timeout: 60_000 },
  async (t) => {
    const customDir = await mkdtemp(path.join(tmpdir(), 'custom-space-'));
    t.after(async () => {
      await rm(customDir, { recursive: true, force: true });
    });
    const f = await fixture(t, { workspaceDir: customDir });
    const sid = 'sess_group';

    f.faux.setResponses([fauxAssistantMessage('ack in the custom space.')]);
    await f.json(`/api/sessions/${sid}/messages`, 'POST', { content: 'where do you run?' });
    await f.runtime.harness.waitForIdle(BACKGROUND_CONTEXT);

    const routerId = await ensureRouterConversationId(f.runtime, sid, 'pm');
    const target = await f.runtime.harness.snapshot(
      TargetDoc,
      Number(routerId) as any,
      BACKGROUND_CONTEXT,
    );
    assert.equal(target?.cwd, customDir, 'TargetDoc.cwd follows the session workspaceDir');
    assert.equal((target as any)?.sessionId, sid, 'TargetDoc carries the botd session id');
  },
);
