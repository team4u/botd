import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupRouter } from '../apps/hub/src/group-router.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { toSubagentPayload } from '../apps/node/src/runtime/hub-stream.js';
import { createSubagentBridge } from '../apps/node/src/runtime/subagent-bridge.js';
import type { SessionSseEvent, SubagentRunRecord } from '../packages/protocol/src/index.js';

/**
 * phase / childSessionId 全链路透传回归测试：
 * 1. Node 端 toSubagentPayload / createSubagentBridge 在生命周期事件（started/completed）上携带并转发两个新字段；
 * 2. Hub 端 GroupRouter.handleNativeSubagentStreamEvent 将字段落到镜像 run、随 subagent_status SSE 广播、
 *    并持久化到消息的 subagentRuns。
 */

test('toSubagentPayload 透传 phase / childSessionId（未设置时省略）', () => {
  const base: SubagentRunRecord = {
    id: 'run_1',
    subagentId: 'researcher',
    task: '调研 A',
    status: 'running',
  };
  assert.equal(toSubagentPayload(base).phase, undefined);
  assert.equal(toSubagentPayload(base).childSessionId, undefined);

  const enriched: SubagentRunRecord = {
    ...base,
    phase: '调研阶段',
    childSessionId: 'sess_child_1',
  };
  const payload = toSubagentPayload(enriched);
  assert.equal(payload.phase, '调研阶段');
  assert.equal(payload.childSessionId, 'sess_child_1');
});

test('createSubagentBridge 在 started / completed 事件上转发 phase / childSessionId 并在 toolSummary 中展示阶段名', () => {
  const subagentEvents: Array<Record<string, unknown>> = [];
  const toolEvents: Array<Record<string, unknown>> = [];
  const sink = {
    text: () => {},
    thinking: () => {},
    tool: (_s: string, _b: string, payload: Record<string, unknown>) => {
      toolEvents.push(payload);
    },
    subagent: (_s: string, _b: string, payload: Record<string, unknown>) => {
      subagentEvents.push(payload);
    },
  };

  const handlers = new Map<string, (data: unknown) => void>();
  const eventBus = {
    on: (channel: string, handler: (data: unknown) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  };
  const resourceLoader = { eventBus };

  const bridge = createSubagentBridge(resourceLoader, {
    sessionId: 'sess_bridge',
    botId: 'bot_parent',
    sink: sink as any,
    sessionFiles: new Map(),
  });
  assert(bridge, 'bridge must be created when eventBus is present');

  const emit = (channel: string, data: unknown) => handlers.get(channel)!(data);

  // started：携带 phase 与 childSessionId
  emit('subagents:started', {
    id: 'run_wf_1',
    type: 'worker',
    description: '跨 BOT 执行步骤',
    phase: 'build',
    childSessionId: 'sess_child_42',
  });
  let started = subagentEvents.at(-1)! as any;
  assert.equal(started.status, 'running');
  assert.equal(started.phase, 'build');
  assert.equal(started.childSessionId, 'sess_child_42');
  assert.equal(bridge.runs.get('run_wf_1')!.phase, 'build');
  assert.equal(bridge.runs.get('run_wf_1')!.childSessionId, 'sess_child_42');
  // 阶段名同时出现在行内 tool 状态摘要里
  const runningTool = toolEvents.at(-1)! as any;
  assert.match(runningTool.toolSummary, /\[build\] 跨 BOT 执行步骤/);

  // completed：字段仍然保留在最终推流中
  emit('subagents:completed', {
    id: 'run_wf_1',
    type: 'worker',
    description: '跨 BOT 执行步骤',
    phase: 'build',
    childSessionId: 'sess_child_42',
    result: 'done',
    durationMs: 1200,
  });
  const completed = subagentEvents.at(-1)! as any;
  assert.equal(completed.status, 'done');
  assert.equal(completed.phase, 'build');
  assert.equal(completed.childSessionId, 'sess_child_42');
  const doneTool = toolEvents.at(-1)! as any;
  assert.match(doneTool.toolSummary, /\[build\] 跨 BOT 执行步骤/);

  bridge!.dispose();
});

function createHubHarness() {
  const db = new HubDatabase({ dbPath: ':memory:' });
  const events: SessionSseEvent[] = [];
  const sseHub = {
    broadcast: (_sessionId: string, event: SessionSseEvent) => {
      events.push(event);
    },
  };
  db.createUser({ id: 'u1', username: 'admin', passwordHash: 'h', role: 'admin' });
  db.createNode({ id: 'n1', name: 'n1', platform: 'linux', tokenHash: 'h', ownerId: 'u1' });
  db.saveBot({
    id: 'bot_parent',
    nodeId: 'n1',
    name: 'Parent',
    description: '',
    modelProvider: 'p',
    modelId: 'm',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });
  db.createSession({
    id: 'sess_mirror',
    title: 'mirror',
    mode: 'direct',
    leadBotId: 'bot_parent',
    memberBotIds: ['bot_parent'],
    ownerId: 'u1',
  });
  // 预先落库一条包含该 run 的父消息，验证字段会被持久化回 subagentRuns
  db.createMessage({
    id: 'msg_mirror',
    sessionId: 'sess_mirror',
    role: 'assistant',
    senderBotId: 'bot_parent',
    content: 'parent reply',
    subagentRuns: [
      {
        id: 'run_mirror_1',
        subagentId: 'worker',
        task: '跨 BOT 步骤',
        status: 'running',
      },
    ],
  });
  const router = new GroupRouter(db, {} as any, sseHub as any);
  return { db, events, router };
}

test('GroupRouter.handleNativeSubagentStreamEvent 存储 / 广播 / 持久化 phase 与 childSessionId', () => {
  const { db, events, router } = createHubHarness();

  // 首个事件：新建镜像 run 时即携带两个新字段
  const started = router.handleNativeSubagentStreamEvent('sess_mirror', 'bot_parent', {
    id: 'run_mirror_1',
    subagentId: 'worker',
    task: '跨 BOT 步骤',
    status: 'running',
    phase: 'deploy',
    childSessionId: 'sess_child_deploy',
  });
  assert(started, 'started run must be mirrored');
  assert.equal(started!.phase, 'deploy');
  assert.equal(started!.childSessionId, 'sess_child_deploy');

  let sse = events.find((e) => e.type === 'subagent_status') as any;
  assert(sse, 'subagent_status SSE must be broadcast');
  assert.equal(sse.run.phase, 'deploy');
  assert.equal(sse.run.childSessionId, 'sess_child_deploy');

  // 完成事件：更新既有镜像 run，字段保留并持久化到消息 subagentRuns
  const done = router.handleNativeSubagentStreamEvent('sess_mirror', 'bot_parent', {
    id: 'run_mirror_1',
    subagentId: 'worker',
    task: '跨 BOT 步骤',
    status: 'done',
    phase: 'deploy',
    childSessionId: 'sess_child_deploy',
    result: 'ok',
    durationMs: 900,
  });
  assert.equal(done!.phase, 'deploy');
  assert.equal(done!.childSessionId, 'sess_child_deploy');

  const statusEvents = events.filter((e) => e.type === 'subagent_status') as any[];
  const lastStatus = statusEvents.at(-1)!;
  assert.equal(lastStatus.run.status, 'done');
  assert.equal(lastStatus.run.phase, 'deploy');
  assert.equal(lastStatus.run.childSessionId, 'sess_child_deploy');

  // 等待持久化路径（同步调用，直接读回）落库
  const persisted = db
    .getMessages('sess_mirror')
    .find((m) => m.id === 'msg_mirror')!
    .subagentRuns!.find((r) => r.id === 'run_mirror_1')!;
  assert.equal(persisted.phase, 'deploy');
  assert.equal(persisted.childSessionId, 'sess_child_deploy');
  assert.equal(persisted.status, 'done');

  // 消息更新本身也会触发 message_created 广播（卡片热更新）
  const messageRefresh = events.find((e) => e.type === 'message_created') as any;
  assert(messageRefresh, 'message_created SSE must be broadcast after persistence');
});
