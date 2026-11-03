import assert from 'node:assert/strict';
import test from 'node:test';

import { RunRegistry } from '../apps/node/src/runtime/run-registry.js';

/**
 * 工作目录级互斥（workspace mutex）测试：
 * 同一主 Bot（共享 workspace）跨会话串行；不同主 Bot 并行；排队期间取消立即退出。
 * 完整模拟 executeBotTurn 的调用序：reserve → acquireWorkspace → 执行 → release。
 */

const DATA_DIR = '/data/botd-test';

/** 逻辑时钟：记录进入/退出顺序，验证串行与并发窗口 */
let clock = 0;
const spans = new Map<string, { enter: number; exit: number }>();
const order: string[] = [];

interface TurnHandle {
  runKey: string;
  /** 回合 promise：done（正常走完）或 rejected（排队期间被取消） */
  done: Promise<'done' | 'rejected'>;
  /** 持锁并进入执行区后 resolve */
  entered: Promise<void>;
  /** 模拟回合结束：释放工作区锁（触发队首接力） */
  release(): void;
}

/** 模拟一个回合：reserve → 排队/持锁 →（测试手动控制时机）→ release */
function beginTurn(registry: RunRegistry, runKey: string, workspaceBotId: string): TurnHandle {
  assert.equal(registry.reserve(runKey, DATA_DIR), true, 'reserve 必须成功（占位在任何 await 之前）');
  let resolveEnter!: () => void;
  const entered = new Promise<void>((r) => {
    resolveEnter = r;
  });
  const done = registry.acquireWorkspace(runKey, DATA_DIR, workspaceBotId).then(
    () => {
      spans.set(runKey, { enter: ++clock, exit: 0 });
      order.push(runKey);
      resolveEnter();
      return 'done' as const;
    },
    (err: Error) => {
      order.push(`${runKey}:rejected:${err.message}`);
      return 'rejected' as const;
    },
  );
  return {
    runKey,
    done,
    entered,
    release() {
      const span = spans.get(runKey);
      if (span) span.exit = ++clock;
      registry.release(runKey);
    },
  };
}

/** 等待微任务链与一个宏任务排空（promise 级联 resolve / reject 均已落地） */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

test('同 Bot 跨会话串行互斥：sess_b 严格等待 sess_a release 后才执行', async () => {
  const registry = new RunRegistry();
  clock = 0;
  spans.clear();
  order.length = 0;

  const a = beginTurn(registry, 'sess_a:bot_1', 'bot_1');
  await a.entered;
  assert.equal(spans.size, 1, 'sess_a 应立即持锁执行');
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_1'), true);

  const b = beginTurn(registry, 'sess_b:bot_1', 'bot_1');
  await settle();
  assert.equal(spans.size, 1, 'sess_b 必须排队，不得与 sess_a 重叠执行');
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 1, '排队长度应为 1');
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_1'), true);

  a.release();
  await b.entered;
  assert.equal(spans.size, 2, 'sess_a 释放后 sess_b 才进入执行');
  b.release();

  // 无重叠执行窗口：b 的 enter 必须在 a 的 exit 之后
  const spanA = spans.get('sess_a:bot_1')!;
  const spanB = spans.get('sess_b:bot_1')!;
  assert.ok(spanB.enter > spanA.exit, `sess_b(${spanB.enter}) 必须晚于 sess_a 退出(${spanA.exit})`);
  assert.deepEqual(order, ['sess_a:bot_1', 'sess_b:bot_1'], '执行顺序必须 FIFO');

  assert.deepEqual(await Promise.all([a.done, b.done]), ['done', 'done']);
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_1'), false, '全部结束后工作区应空闲');
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 0);
});

test('主 Bot 与其子代理共享工作目录：bot_sub 与 bot_1 跨会话互斥排队', async () => {
  const registry = new RunRegistry();
  clock = 0;
  spans.clear();
  order.length = 0;

  // 主 Bot 在 sess_a 运行；子代理（parentBotId=bot_1 → workspaceBotId = parentBotId || id）在 sess_b 触发
  const a = beginTurn(registry, 'sess_a:bot_1', 'bot_1');
  await a.entered;
  const b = beginTurn(registry, 'sess_b:bot_sub', 'bot_1');
  await settle();

  assert.equal(spans.size, 1, '子代理回合必须等待主 Bot 释放共享 workspace');
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 1);

  a.release();
  await b.entered;
  b.release();

  const spanA = spans.get('sess_a:bot_1')!;
  const spanB = spans.get('sess_b:bot_sub')!;
  assert.ok(spanB.enter > spanA.exit, '子代理回合必须等主 Bot 回合完全结束后才进入 workspace');
  await Promise.all([a.done, b.done]);
});

test('不同主 Bot 完全并发：bot_1 与 bot_2 互不阻塞', async () => {
  const registry = new RunRegistry();
  clock = 0;
  spans.clear();
  order.length = 0;

  const a = beginTurn(registry, 'sess_a:bot_1', 'bot_1');
  await a.entered;
  const b = beginTurn(registry, 'sess_b:bot_2', 'bot_2');
  await b.entered;

  assert.equal(spans.size, 2, '不同主 Bot 的工作区必须立即可并发进入');
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_1'), true);
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_2'), true);
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 0);
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_2'), 0);

  // 两者均已进入执行区（重叠窗口存在），随后各自结束
  a.release();
  b.release();
  assert.deepEqual(await Promise.all([a.done, b.done]), ['done', 'done']);

  // 并发窗口重叠：后进入者的 enter 早于先进入者的 exit（release 时才盖 exit 时间戳）
  const spanA = spans.get('sess_a:bot_1')!;
  const spanB = spans.get('sess_b:bot_2')!;
  assert.ok(spanB.enter < spanA.exit, '两个不同主 Bot 的执行窗口必须重叠（真并发）');
});

test('排队期间取消：sess_b 立即以 Turn was cancelled 拒绝，sess_c 正常接力', async () => {
  const registry = new RunRegistry();
  clock = 0;
  spans.clear();
  order.length = 0;

  const a = beginTurn(registry, 'sess_a:bot_1', 'bot_1');
  await a.entered;

  const b = beginTurn(registry, 'sess_b:bot_1', 'bot_1');
  const c = beginTurn(registry, 'sess_c:bot_1', 'bot_1');
  await settle();
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 2, 'b、c 依次排队');
  assert.ok(!spans.has('sess_b:bot_1'), 'sess_b 不得提前执行');
  assert.ok(!spans.has('sess_c:bot_1'), 'sess_c 不得提前执行');

  // 用户在排队期间点击「停止」：必须立即拒绝、绝不死等前序回合跑完
  assert.equal(registry.cancel('sess_b:bot_1'), true, 'cancel 应报告成功取消一个排队/运行中的回合');
  assert.equal(await b.done, 'rejected');
  assert.equal(order.at(-1), 'sess_b:bot_1:rejected:Turn was cancelled', '必须以 Turn was cancelled 拒绝');
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 1, 'b 出队后只剩 c 排队');

  // a 完成后锁直接移交给 c（跳过已取消的 b）
  a.release();
  await c.entered;
  c.release();

  assert.equal(await a.done, 'done');
  assert.equal(await c.done, 'done', 'sess_c 必须正常获得锁继续执行');
  const spanA = spans.get('sess_a:bot_1')!;
  const spanC = spans.get('sess_c:bot_1')!;
  assert.ok(spanC.enter > spanA.exit, 'sess_c 必须在 sess_a 释放后才执行');
  assert.ok(!spans.has('sess_b:bot_1'), '被取消的 sess_b 从未执行');
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_1'), false);
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 0);
});

test('acquire 前已取消：立即拒绝，不进入队列', async () => {
  const registry = new RunRegistry();
  // 模拟 reserve 之后、acquireWorkspace 之前被用户取消（reserve 会清除旧取消标记，故在此补标记）
  const runKey = 'sess_x:bot_1';
  assert.equal(registry.reserve(runKey, DATA_DIR), true);
  registry.cancel(runKey);
  await assert.rejects(
    registry.acquireWorkspace(runKey, DATA_DIR, 'bot_1'),
    /Turn was cancelled/,
  );
  registry.release(runKey);
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_1'), false, '拒绝路径不得留下锁痕迹');
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 0);
});

test('持锁回合被取消后 release：锁正常移交给下一个等待者', async () => {
  const registry = new RunRegistry();
  clock = 0;
  spans.clear();
  order.length = 0;

  const a = beginTurn(registry, 'sess_a:bot_1', 'bot_1');
  await a.entered;
  const b = beginTurn(registry, 'sess_b:bot_1', 'bot_1');
  await settle();
  assert.equal(registry.getWorkspaceQueueLength(DATA_DIR, 'bot_1'), 1);

  // 持锁者被取消：标记后仍由其 finally 路径 release，b 应立即接力拿锁
  assert.equal(registry.cancel('sess_a:bot_1'), true);
  a.release();
  await b.entered;
  b.release();

  assert.deepEqual(order, ['sess_a:bot_1', 'sess_b:bot_1'], '等待者必须接力执行');
  assert.deepEqual(await Promise.all([a.done, b.done]), ['done', 'done']);
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_1'), false);
});

test('队列中间的等待者被取消：不阻塞后续等待者接力（跳过已取消槽位）', async () => {
  const registry = new RunRegistry();
  clock = 0;
  spans.clear();
  order.length = 0;

  const a = beginTurn(registry, 'sess_a:bot_1', 'bot_1');
  await a.entered;
  const b = beginTurn(registry, 'sess_b:bot_1', 'bot_1');
  const c = beginTurn(registry, 'sess_c:bot_1', 'bot_1');
  await settle();

  // b 排在队首却被取消：release 时必须跳过 b，直接让 c 拿锁
  registry.cancel('sess_b:bot_1');
  assert.equal(await b.done, 'rejected');

  a.release();
  await c.entered;
  c.release();

  assert.deepEqual(order, ['sess_a:bot_1', 'sess_b:bot_1:rejected:Turn was cancelled', 'sess_c:bot_1']);
  assert.ok(!spans.has('sess_b:bot_1'), '被取消的 b 从未进入执行区');
  await Promise.all([a.done, c.done]);
  assert.equal(registry.isWorkspaceBusy(DATA_DIR, 'bot_1'), false);
});
