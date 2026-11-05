/**
 * Durable LiveDoc（pi.live）→ SSE 桥与生命周期镜像测试。
 *
 * createDurableSessionMirror 此前只镜像 view.entries、完全忽略 view.docs['pi.live']，
 * 导致 Durable 会话运行期间：
 *  - db.updateSessionStatus('running'/'idle') 与 session_status SSE 从不触发；
 *  - text_delta / thinking_stream / tool_status 流式事件从不广播；
 *  - watchSubSessionCompletion（等 session_status: idle）对 Durable 子会话永不回调。
 *
 * 本套件用 faux provider + MemoryStorage 的真实 HubDurableRuntime 验证：
 *  1. submitSessionMessageToDurable 提交后，SSE 依序出现 session_status(running)
 *     → message_created（含流式/工具事件）→ session_status(idle)，
 *     db 会话状态在运行中为 running、收敛后回到 idle；
 *  2. Durable 子会话经 watchSubSessionCompletion 在 assistant 消息镜像落库之后
 *     收到 idle 并向父会话回传完成 callback；
 *  3. 磁盘附件的 [Attached Files] 上下文同时含 path:（Hub 本机路径）与
 *     artifactId:（远端 Node 可用 botd artifact pull 拉取）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import type { SessionSseEvent } from '../packages/protocol/src/index.js';

import { HubDatabase } from '../apps/hub/src/db.js';
import { SseHub } from '../apps/hub/src/sse.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import {
  createDurableSessionMirror,
  submitSessionMessageToDurable,
  type DurableSessionMirror,
} from '../apps/hub/src/routes/workers.js';
import { watchSubSessionCompletion } from '../apps/hub/src/harness/session-bridge.js';

/** 会话 SSE 事件订阅器：按会话收集事件 + 挂起的 Promise 唤醒。 */
class EventRecorder {
  private events: SessionSseEvent[] = [];
  private waiters: Array<{ predicate: (e: SessionSseEvent) => boolean; resolve: () => void }> = [];
  unsubscribe: () => void;

  constructor(sseHub: SseHub, sessionId: string) {
    this.unsubscribe = sseHub.subscribe(sessionId, (event) => {
      this.events.push(event);
      for (const w of [...this.waiters]) {
        if (w.predicate(event)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    });
  }

  all(): SessionSseEvent[] {
    return [...this.events];
  }

  of<K extends SessionSseEvent['type']>(type: K): Extract<SessionSseEvent, { type: K }>[] {
    return this.events.filter((e) => e.type === type) as Extract<SessionSseEvent, { type: K }>[];
  }

  /** 等到出现满足 predicate 的事件（含已收集的）。 */
  async waitFor(predicate: (e: SessionSseEvent) => boolean, message: string, timeoutMs = 15_000): Promise<void> {
    if (this.events.some(predicate)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timeout waiting for ${message}; got: ${JSON.stringify(this.events.map((e) => e.type))}`));
      }, timeoutMs);
      const waiter = { predicate, resolve: () => { clearTimeout(timer); resolve(); } };
      this.waiters.push(waiter);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }
}

interface Fixture {
  db: HubDatabase;
  sseHub: SseHub;
  runtime: HubDurableRuntime;
  mirror: DurableSessionMirror;
  faux: ReturnType<typeof fauxProvider>;
  dir: string;
}

const PERSONA = {
  botId: 'architect',
  name: 'Architect',
  model: { provider: 'faux', modelId: 'main' },
  instructions: 'You are the architect bot.',
  nodeId: 'local',
  cwd: process.cwd(),
};

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-durable-live-'));
  t.after(async () => {
    mirror.close();
    await runtime.close();
    sseHub.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
  db.saveBot({
    id: PERSONA.botId,
    nodeId: PERSONA.nodeId,
    name: PERSONA.name,
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'main',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });
  db.createSession({
    id: 'sess_live',
    title: 'Durable live bridge',
    leadBotId: PERSONA.botId,
    ownerId: 'user_admin',
  });

  const sseHub = new SseHub();
  const faux = fauxProvider({ models: [{ id: 'main', reasoning: true }], tokensPerSecond: 60 });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });
  runtime.registerPersona(PERSONA);
  const mirror = createDurableSessionMirror({ db, sseHub, durableRuntime: runtime });

  return { db, sseHub, runtime, mirror, faux, dir };
}

// ---------------------------------------------------------------------------

test('1. durable submit drives session_status running -> message_created -> idle, with streaming events', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 带 thinking + 长 text 的流式回答：faux 逐 delta 推进，pi.live.generation.message 随节流提交，
  // 多次 flush 保证有买打telta 可观测（末尾残余由 message_created 兜底，流式只承诺前缀）。
  const thinkingText = 'Let me think this through step by step.';
  const answerText = `The answer is 42. ${'Here is the detailed reasoning behind it. '.repeat(6)}That is all.`;
  f.faux.setResponses([
    fauxAssistantMessage([fauxThinking(thinkingText), fauxText(answerText)]),
  ]);

  const recorder = new EventRecorder(f.sseHub, 'sess_live');
  t.after(() => recorder.dispose());

  let sawRunningStatus = false;
  const statuses: string[] = [];
  f.sseHub.subscribe('sess_live', (e) => {
    if (e.type === 'session_status') {
      statuses.push(e.status);
      if (e.status === 'running') sawRunningStatus = true;
    }
  });

  const submitted = await submitSessionMessageToDurable(
    { db: f.db, sseHub: f.sseHub, durableRuntime: f.runtime },
    'sess_live',
    PERSONA.botId,
    'What is the answer?',
    f.mirror,
  );
  assert.ok(submitted, 'durable submit must succeed');

  // 运行中：db 状态为 running（等首个 running 广播落地后再断言）。
  await recorder.waitFor((e) => e.type === 'session_status' && e.status === 'running', 'session_status running');
  assert.equal(f.db.getSession('sess_live')?.status, 'running');

  // 收敛：idle 广播 + db 状态回 idle。
  await recorder.waitFor((e) => e.type === 'session_status' && e.status === 'idle', 'session_status idle');
  assert.equal(f.db.getSession('sess_live')?.status, 'idle');

  // 事件次序：running 先于 message_created，message_created 先于 idle。
  const types = recorder.all().map((e) => e.type);
  const firstRunning = types.indexOf('session_status'); // 第一个 session_status 必是 running
  const messageAt = types.indexOf('message_created');
  const lastStatusAt = types.map((v, i) => (v === 'session_status' ? i : -1)).filter((i) => i >= 0).at(-1)!;
  assert.ok(firstRunning >= 0 && recorder.of('session_status')[0].status === 'running', 'first session_status must be running');
  assert.ok(messageAt > firstRunning, 'message_created must follow session_status running');
  assert.ok(lastStatusAt > messageAt, 'session_status idle must follow message_created');

  // assistant 消息已镜像落库（全文以 message_created 为准）。
  const assistant = f.db.getMessages('sess_live').find((m) => m.role === 'assistant');
  assert.ok(assistant, 'mirrored assistant message must exist');
  assert.equal(assistant.content, answerText);

  // 流式增量：thinking_stream 与 text_delta 按前缀差分广播。末次 flush 后的尾部
  // 残余可能未及提交（由最终 assistant entry 兜底），因此断言拼接结果是全文前缀。
  const thinkingDelta = recorder.of('thinking_stream').map((e) => e.delta ?? '').join('');
  assert.ok(thinkingDelta.length > 0, 'at least one thinking_stream delta must be broadcast');
  assert.ok(thinkingText.startsWith(thinkingDelta), `thinking deltas must be a prefix, got: ${thinkingDelta}`);
  assert.ok(recorder.of('thinking_stream').some((e) => e.status === 'done'), 'thinking_stream done must be broadcast');
  const textDelta = recorder.of('text_delta').map((e) => e.delta).join('');
  assert.ok(textDelta.length > 0, 'at least one text_delta must be broadcast');
  assert.ok(answerText.startsWith(textDelta), `text deltas must be a prefix, got: ${textDelta}`);
});

test('2. tool round broadcasts tool_status and mirrors the tool-calling turn', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 第一轮：调 read 工具（CodingTools 自带）；第二轮：总结。
  const toolCall = fauxToolCall('read', { path: path.join(f.dir, 'note.txt') });
  await writeFile(path.join(f.dir, 'note.txt'), 'tool round payload\n', 'utf8');
  f.faux.setResponses([
    fauxAssistantMessage([toolCall], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxThinking('Read it.'), { type: 'text', text: 'Read the note successfully.' }]),
  ]);

  const recorder = new EventRecorder(f.sseHub, 'sess_live');
  t.after(() => recorder.dispose());

  await submitSessionMessageToDurable(
    { db: f.db, sseHub: f.sseHub, durableRuntime: f.runtime },
    'sess_live',
    PERSONA.botId,
    'Read the note file and summarize.',
    f.mirror,
  );

  await recorder.waitFor((e) => e.type === 'session_status' && e.status === 'idle', 'session_status idle');
  assert.equal(f.db.getSession('sess_live')?.status, 'idle');

  // 工具状态流：同一次调用 pending/running -> done 至少两次推进（done 时 output 已被
  // finishSlot 清空，工具输出由 pi.tool-result 回填进 db 的 blocks/toolCalls）。
  const toolEvents = recorder.of('tool_status').filter((e) => e.toolCallId === toolCall.id);
  assert.ok(toolEvents.length >= 2, `expected >= 2 tool_status events for ${toolCall.id}, got ${toolEvents.length}`);
  assert.equal(toolEvents.at(-1)!.status, 'done', 'last tool_status must be done');
  assert.equal(toolEvents[0].toolName, 'read');

  // 两个 assistant 回合（工具调用回合 + 总结回合）都镜像落库。
  const messages = f.db.getMessages('sess_live').filter((m) => m.role === 'assistant');
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((m) => m.content),
    ['', 'Read the note successfully.'],
  );
  assert.ok(messages[0].toolCalls?.some((c) => c.name === 'read'), 'tool-calling turn must carry toolCalls');
  // 工具输出回填：read 的文件内容出现在镜像消息的 toolCalls 与 blocks 预览里。
  assert.match(messages[0].toolCalls?.find((c) => c.name === 'read')?.outputPreview ?? '', /tool round payload/);
  const toolBlock = messages[0].blocks?.find((b) => b.type === 'tool');
  assert.ok(toolBlock, 'tool block must exist after backfill');
  assert.match((toolBlock as { outputPreview?: string }).outputPreview ?? '', /tool round payload/);
});

test('3. watchSubSessionCompletion fires for a durable subsession after the assistant message is mirrored', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 父会话 + 子会话（模拟 trigger-service 的 subsession 分发形态）。
  f.db.createSession({
    id: 'sess_parent',
    title: 'Parent',
    leadBotId: PERSONA.botId,
    ownerId: 'user_admin',
  });
  const child = f.db.createSession({
    id: 'sess_child',
    title: 'Child task',
    leadBotId: PERSONA.botId,
    ownerId: 'user_admin',
    parentSessionId: 'sess_parent',
  });

  f.faux.setResponses([fauxAssistantMessage('Subtask done: report attached.')]);

  let settled: 'idle' | 'failed' | undefined;
  const parentRecorder = new EventRecorder(f.sseHub, 'sess_parent');
  t.after(() => parentRecorder.dispose());
  const stopWatch = watchSubSessionCompletion({
    db: f.db,
    sseHub: f.sseHub,
    parentSessionId: 'sess_parent',
    childSession: { id: child.id, title: child.title },
    botId: PERSONA.botId,
    onSettled: (status: 'idle' | 'failed') => {
      settled = status;
    },
  });
  t.after(() => stopWatch());

  await submitSessionMessageToDurable(
    { db: f.db, sseHub: f.sseHub, durableRuntime: f.runtime },
    child.id,
    PERSONA.botId,
    'Run the subtask.',
    f.mirror,
  );

  // 子会话 idle 广播先于父会话 callback；完成回调把子会话末条 assistant 摘要带回父会话。
  await parentRecorder.waitFor((e) => e.type === 'message_created' && e.message.role === 'callback', 'parent callback');
  assert.equal(settled, 'idle');

  // 关键次序：父会话收到 idle 时，子会话的 assistant 消息必须已经镜像进 db
  // （watchSubSessionCompletion 回调里读 db.getMessages 找末条 assistant 摘要）。
  const childAssistant = f.db.getMessages(child.id).find((m) => m.role === 'assistant');
  assert.ok(childAssistant, 'child assistant message must be mirrored before idle fires');
  const callback = f.db.getMessages('sess_parent').find((m) => m.role === 'callback');
  assert.ok(callback, 'parent callback message must exist');
  assert.match(callback.content, /Subtask done: report attached\./);
});

test('4. attached files context carries both path: and artifactId: (remote node pull hint)', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  // 磁盘产物：模拟 WebUI 上传链路（附件只带产物指针）。
  const content = Buffer.from('date,amount\n2025-01-01,-42.00\n', 'utf8');
  const artifactId = 'art_live_1';
  const storagePath = path.join(f.dir, `${artifactId}.csv`);
  fs.writeFileSync(storagePath, content);
  f.db.createArtifact({
    id: artifactId,
    sessionId: 'sess_live',
    filename: 'statement.csv',
    mimeType: 'text/csv',
    sizeBytes: content.byteLength,
    storagePath,
  });

  let submittedText = '';
  f.faux.setResponses(
    [...Array(16)].map(
      () =>
        ((context: { messages: readonly { role: string; content?: unknown }[] }) => {
          const lastUser = [...context.messages].reverse().find((m) => m.role === 'user');
          submittedText =
            typeof lastUser?.content === 'string'
              ? lastUser.content
              : Array.isArray(lastUser?.content)
                ? String((lastUser.content[0] as { text?: string }).text ?? '')
                : '';
          return fauxAssistantMessage('Bill parsed.');
        }) as never,
    ),
  );

  await submitSessionMessageToDurable(
    { db: f.db, sseHub: f.sseHub, durableRuntime: f.runtime },
    'sess_live',
    PERSONA.botId,
    'Parse the attached bill',
    f.mirror,
    {
      attachments: [
        { id: artifactId, filename: 'statement.csv', mimeType: 'text/csv', sizeBytes: content.byteLength, url: `/api/artifacts/${artifactId}` },
      ],
    },
  );

  // 模型侧收到的正文：同时含 Hub 本机 path 与 artifactId 拉取指引。
  const deadline = Date.now() + 15_000;
  while (!submittedText.includes('[Attached Files]') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(
    submittedText,
    new RegExp(
      `\\[Attached Files\\]:\\n- statement\\.csv \\(text/csv, ${content.byteLength} bytes\\) -> path: \\S+ \\(artifactId: ${artifactId}; on remote nodes run: botd artifact pull ${artifactId} --output \\./statement\\.csv\\)`,
    ),
  );
});
