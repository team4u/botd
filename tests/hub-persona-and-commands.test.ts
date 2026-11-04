/**
 * hub-persona-and-commands.test.ts — Phase 8B 集成测试。
 *
 * 覆盖三块能力：
 *  1. BotPersonaConfig.thinkingLevel 下发到 Router 会话 Agent（含 'max' → 'xhigh' 钳制），
 *     submitUserMessage 携带 images 的多模态输入落成 text+image 内容块；
 *  2. HubDurableRuntime 上的 pi-durable 原生会话原语：forkConversation（零拷贝继承
 *     fork 点之前的上下文）、resetConversation（追加 pi.reset 并以 handoff 重启上下文）、
 *     compactConversation（落一个手动压缩任务）；
 *  3. Hub 直出 GET /api/bots/:botId/commands：零节点在线时从 Hub SQLite 的 Bot
 *     enabledSkills（含 inheritSkills 父继承）与 enabledExtensions 构造斜杠命令。
 *
 * 模型走确定性 faux provider，不触真实 LLM。
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
import { ensureRouterConversationId } from '../apps/hub/src/routes/workers.js';
import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';

const PASSWORD = 'test-admin-password';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const lastUserText = (messages: readonly { role: string; content: unknown }[]): string => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (typeof lastUser?.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? '');
  return '';
};

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => Promise<T> | T, check: (value: T) => boolean, message: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await read();
    if (check(last)) return last;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${message}`);
    await wait(20);
  }
}

interface RuntimeFixture {
  runtime: HubDurableRuntime;
  faux: ReturnType<typeof fauxProvider>;
}

async function openRuntime(): Promise<RuntimeFixture> {
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({
    storage: new MemoryStorage(),
    models,
    workerAgent: () => ({}),
  });
  return { runtime, faux };
}

const persona = (botId: string, overrides: Partial<BotPersonaConfig> = {}): BotPersonaConfig => ({
  botId,
  name: botId,
  model: { provider: 'faux', modelId: 'main' },
  instructions: `You are the ${botId} bot.`,
  nodeId: 'node-1',
  cwd: process.cwd(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. thinkingLevel 与多模态 submitUserMessage
// ---------------------------------------------------------------------------

test('persona thinkingLevel lands on the router conversation agent; max clamps to xhigh', async () => {
  const { runtime } = await openRuntime();
  try {
    runtime.registerPersona(persona('thinker', { thinkingLevel: 'high' }));
    runtime.registerPersona(persona('maxer', { thinkingLevel: 'max' }));

    const thinker = await runtime.ensureBotMainSession('thinker');
    assert.equal((await thinker.agent(BACKGROUND_CONTEXT)).thinkingLevel, 'high');

    const maxer = await runtime.ensureBotMainSession('maxer');
    assert.equal((await maxer.agent(BACKGROUND_CONTEXT)).thinkingLevel, 'xhigh', "'max' must clamp to pi-durable's 'xhigh'");
  } finally {
    await runtime.close();
  }
});

test('submitUserMessage with images records a user entry with text+image content blocks', { timeout: 30_000 }, async () => {
  const { runtime, faux } = await openRuntime();
  try {
    runtime.registerPersona(persona('architect'));
    faux.setResponses([...Array(16)].map(() => fauxAssistantMessage('Got the screenshot.')));
    const conv = await runtime.ensureBotMainSession('architect');

    const submission = await runtime.submitUserMessage(String(conv.id), 'What is in this image?', {
      requestId: 'img:1',
      images: [{ mimeType: 'image/png', data: PNG_1X1 }],
    });
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');

    const page = await conv.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
    const imageEntries = page.items.filter((entry) =>
      (entry.model ?? []).some(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === 'image' && (block as { data?: string }).data === PNG_1X1),
      ),
    );
    assert.equal(imageEntries.length, 1, 'exactly one user entry carries the image');
    const blocks = imageEntries[0]!.model![0]!.content as Array<{ type: string; text?: string; mimeType?: string }>;
    assert.deepEqual(
      blocks.map((block) => block.type),
      ['text', 'image'],
      'the multimodal entry interleaves the text block and the image block',
    );
    assert.equal(blocks[0]!.text, 'What is in this image?');
    assert.equal((blocks[1] as { mimeType?: string }).mimeType, 'image/png');
  } finally {
    await runtime.close();
  }
});

// ---------------------------------------------------------------------------
// 2. pi-durable 原生 fork / reset / compact
// ---------------------------------------------------------------------------

test('forkConversation inherits zero-copy context up to the fork entry only', { timeout: 30_000 }, async () => {
  const { runtime, faux } = await openRuntime();
  try {
    runtime.registerPersona(persona('architect'));
    faux.setResponses(
      [...Array(32)].map(
        () =>
          (context: { messages: readonly { role: string; content: unknown }[] }) =>
            /First turn/.test(lastUserText(context.messages))
              ? fauxAssistantMessage('First answer.')
              : fauxAssistantMessage('Second answer.'),
      ) as never[],
    );
    const conv = await runtime.ensureBotMainSession('architect');
    const first = await runtime.submitUserMessage(String(conv.id), 'First turn');
    assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, 'done');
    const second = await runtime.submitUserMessage(String(conv.id), 'Second turn');
    assert.equal((await second.wait(BACKGROUND_CONTEXT)).status, 'done');

    const page = await conv.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT);
    const firstReplyEntryId = page.items.find((entry) => entry.kind === 'pi.assistant')!.id;
    assert.ok(firstReplyEntryId !== undefined, 'first assistant reply entry exists');

    const forked = await runtime.forkConversation(conv.id, firstReplyEntryId, 'architect');
    assert.notEqual(forked.id, conv.id);

    const forkedContext = await forked.context(BACKGROUND_CONTEXT);
    const transcript = JSON.stringify(forkedContext.messages);
    assert.match(transcript, /First turn/, 'fork inherits the first turn (zero-copy via parent.at)');
    assert.match(transcript, /First answer/);
    assert.doesNotMatch(transcript, /Second turn/, 'the fork point excludes everything after the first reply');
    assert.doesNotMatch(transcript, /Second answer/);

    const sourceContext = await conv.context(BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(sourceContext.messages), /Second turn/, 'the source conversation keeps both turns');
  } finally {
    await runtime.close();
  }
});

test('resetConversation appends pi.reset and restarts the context with the handoff', { timeout: 30_000 }, async () => {
  const { runtime, faux } = await openRuntime();
  try {
    runtime.registerPersona(persona('architect'));
    faux.setResponses(
      [...Array(64)].map(
        () =>
          (context: { messages: readonly { role: string; content: unknown }[] }) => {
            const text = lastUserText(context.messages);
            if (/First turn/.test(text)) return fauxAssistantMessage('First answer.');
            if (/Second turn/.test(text)) return fauxAssistantMessage('Second answer.');
            return fauxAssistantMessage('Summary of everything so far: two answers were given.');
          },
      ) as never[],
    );
    const conv = await runtime.ensureBotMainSession('architect');
    const first = await runtime.submitUserMessage(String(conv.id), 'First turn');
    await first.wait(BACKGROUND_CONTEXT);
    const second = await runtime.submitUserMessage(String(conv.id), 'Second turn');
    await second.wait(BACKGROUND_CONTEXT);

    await runtime.resetConversation(conv.id, 'handoff summary');

    const history = await conv.entries({ order: 'descending' }, 1, undefined, BACKGROUND_CONTEXT);
    assert.equal(history.items[0]!.kind, 'pi.reset', 'a pi.reset entry is appended');

    const context = await conv.context(BACKGROUND_CONTEXT);
    assert.equal(context.head?.kind, 'pi.reset', 'the reset entry is the active head marker');
    const messages = JSON.stringify(context.messages);
    assert.match(messages, /handoff summary/, 'the fresh context starts with the handoff');
    assert.doesNotMatch(messages, /First turn/, 'pre-reset turns are out of the active context');
    assert.doesNotMatch(messages, /Second turn/);

    // compact：在 reset 后的新上下文上落一个手动压缩任务并等它完成。
    const taskId = await runtime.compactConversation(conv.id, 'Focus on decisions');
    assert.ok(taskId !== undefined, 'compactConversation returns the compaction task id');
    const settled = await runtime.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, 'completed');

    // 未知会话：fork 抛错、reset 静默、compact 返回 undefined。
    const unknownId = (999_999_999 as unknown) as Parameters<typeof runtime.forkConversation>[0];
    await assert.rejects(() => runtime.forkConversation(unknownId, 1 as never, 'architect'), /unknown conversation/);
    await runtime.resetConversation(unknownId, undefined); // unknown → no-op
    assert.equal(await runtime.compactConversation(unknownId), undefined);
  } finally {
    await runtime.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Hub 直出 GET /api/bots/:botId/commands（零节点在线）
// ---------------------------------------------------------------------------

interface HubFixture {
  base: string;
  cookie: string;
  hub: Awaited<ReturnType<typeof startHub>>;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
}

async function hubFixture(t: TestContext): Promise<HubFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-persona-commands-'));
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
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };
  return { base, cookie, hub, json };
}

test('GET /api/bots/:botId/commands serves skills from Hub SQLite with zero nodes online', { timeout: 30_000 }, async (t) => {
  const f = await hubFixture(t);

  // Skill 内容存 Hub SQLite（YAML frontmatter 携带 description）。
  await f.json('/api/skills/code-review', 'PUT', {
    content: `---\nname: code-review\ndescription: Automated code review\n---\n\n# Code Review\n\nReview the diff carefully.`,
  });

  // 父 Bot 启用该技能；子 Bot inheritSkills 继承；零节点在线（从未有 Node 连接）。
  await f.json('/api/bots', 'POST', {
    id: 'reviewer',
    nodeId: 'node-offline',
    name: 'Reviewer',
    description: 'Reviews code',
    modelProvider: 'faux',
    modelId: 'main',
    enabledSkills: ['code-review'],
    systemMd: 'You review code.',
  });
  await f.json('/api/bots', 'POST', {
    id: 'reviewer-child',
    nodeId: 'node-offline',
    name: 'Reviewer Child',
    description: 'Inherits skills',
    modelProvider: 'faux',
    modelId: 'main',
    enabledSkills: [],
    inheritSkills: true,
    parentBotId: 'reviewer',
    systemMd: 'You review code.',
  });
  // 纯扩展 Bot：命令来自 enabledExtensions。
  await f.json('/api/bots', 'POST', {
    id: 'extbot',
    nodeId: 'node-offline',
    name: 'Ext Bot',
    description: 'Extension-driven',
    modelProvider: 'faux',
    modelId: 'main',
    enabledSkills: [],
    enabledExtensions: ['status-card'],
    systemMd: 'You render status.',
  });

  const expectedSkillCommand = [{ name: 'code-review', description: 'Automated code review', source: 'skill' }];
  assert.deepEqual(await f.json('/api/bots/reviewer/commands'), expectedSkillCommand);
  assert.deepEqual(
    await f.json('/api/bots/reviewer-child/commands'),
    expectedSkillCommand,
    'inheritSkills child resolves the parent bot enabled skills',
  );
  assert.deepEqual(await f.json('/api/bots/extbot/commands'), [
    { name: 'status-card', description: '扩展 status-card', source: 'extension' },
  ]);
});

test(
  'HTTP routes wire native pi-durable fork (/api/sessions/:id/fork) and rewind (PUT /api/sessions/:id/messages/:messageId)',
  { timeout: 30_000 },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-fork-rewind-route-'));
    const { runtime, faux } = await openRuntime();
    const hub = await startHub({
      port: 0,
      host: '127.0.0.1',
      dbPath: path.join(dir, 'hub.sqlite'),
      adminPassword: PASSWORD,
      durableRuntime: runtime,
    });
    const addr = hub.server.address();
    assert(addr && typeof addr !== 'string');
    const base = `http://127.0.0.1:${addr.port}`;
    t.after(async () => {
      hub.server.closeAllConnections();
      await hub.close();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    });

    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
      const res = await fetch(base + route, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      assert(res.ok, `${method} ${route}: ${res.status} ${JSON.stringify(data)}`);
      return data as T;
    };

    await json('/api/bots', 'POST', {
      id: 'architect',
      nodeId: 'local',
      name: 'Architect',
      description: 'Lead',
      modelProvider: 'faux',
      modelId: 'main',
      thinkingLevel: 'high',
      enabledSkills: [],
      systemMd: 'You are the architect.',
    });

    const session = await json<{ id: string }>('/api/sessions', 'POST', {
      title: 'Fork & Rewind',
      leadBotId: 'architect',
    });

    // Turn 1
    faux.setResponses([fauxAssistantMessage('reply-1')]);
    await json<{ id: string }>(`/api/sessions/${session.id}/messages`, 'POST', {
      content: 'turn-1-question',
    });
    await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);

    const messagesAfterTurn1 = await waitFor(
      () => json<Array<{ id: string; role: string; content: string }>>(`/api/sessions/${session.id}/messages`),
      (list) => list.some((m) => m.role === 'assistant' && m.content === 'reply-1'),
      'reply-1 mirrored',
    );
    const reply1 = messagesAfterTurn1.find((m) => m.role === 'assistant' && m.content === 'reply-1')!;

    // Turn 2
    faux.setResponses([fauxAssistantMessage('reply-2')]);
    const userMsg2 = await json<{ id: string }>(`/api/sessions/${session.id}/messages`, 'POST', {
      content: 'turn-2-question',
    });
    await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);

    const extractContextTexts = async (convId: string): Promise<string[]> => {
      const conv = await runtime.conversation(convId, BACKGROUND_CONTEXT);
      assert(conv);
      const ctx = await conv.context(BACKGROUND_CONTEXT);
      return ctx.messages
        .map((m) => {
          if (typeof m.content === 'string') return m.content;
          if (Array.isArray(m.content)) {
            return m.content
              .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: string }).text ?? '') : ''))
              .filter(Boolean)
              .join('\n');
          }
          return '';
        })
        .filter(Boolean);
    };

    // 1. Native Fork at reply1 via POST /api/sessions/:id/fork
    const forkedSession = await json<{ id: string }>(`/api/sessions/${session.id}/fork`, 'POST', {
      anchorMessageId: reply1.id,
    });
    const forkedConvId = await ensureRouterConversationId(runtime, forkedSession.id, 'architect');
    assert.deepEqual(
      await extractContextTexts(forkedConvId),
      ['turn-1-question', 'reply-1'],
      'POST /api/sessions/:id/fork binds a native pi-durable forked conversation at reply1',
    );

    // 2. Native Rewind via PUT /api/sessions/:id/messages/:messageId on userMsg2
    faux.setResponses([fauxAssistantMessage('reply-2-edited')]);
    await json(`/api/sessions/${session.id}/messages/${userMsg2.id}`, 'PUT', {
      content: 'turn-2-edited',
    });
    await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);

    const rewoundConvId = await ensureRouterConversationId(runtime, session.id, 'architect');
    assert.deepEqual(
      await extractContextTexts(rewoundConvId),
      ['turn-1-question', 'reply-1', 'turn-2-edited', 'reply-2-edited'],
      'PUT /messages/:messageId rewinds via native conv.fork(prevEntryId) preserving turn 1 and replacing turn 2',
    );
  },
);
