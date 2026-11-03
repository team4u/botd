import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHubStreamSink, type HubStream } from '../apps/node/src/runtime/hub-stream.js';

/**
 * 回归：rpc 已关闭时 asEvent 返回 rejected Promise（birpc 的 _call 是 async 函数，
 * 同步 throw 会转为 rejection）。旧实现只包了同步 try/catch，rejection 无人接，
 * 触发 unhandledRejection 直接击穿 daemon 进程。
 */

test('closed-rpc stream rejection must not escape as unhandledRejection', async () => {
  // 模拟已关闭的 birpc：asEvent 返回 rejected promise 而非同步 throw
  const closedRpc = {
    onSessionStream: Object.assign(
      () => {
        throw new Error('[birpc] rpc is closed, cannot call "onSessionStream"');
      },
      {
        asEvent: (() => Promise.reject(new Error('[birpc] rpc is closed, cannot call "onSessionStream"'))),
      },
    ),
  } as unknown as HubStream;

  const sink = createHubStreamSink(closedRpc);

  // 关键：在 unhandledRejection 监视下执行推流，不得触发进程级事件
  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    sink.text('sess_x', 'bot_y', 'hello');
    sink.thinking('sess_x', 'bot_y', { status: 'running', delta: 'th' });
    sink.tool('sess_x', 'bot_y', { toolName: 'bash', toolStatus: 'running' });
    sink.subagent('sess_x', 'bot_y', {
      id: 'run_1',
      subagentId: 'sub',
      task: 't',
      status: 'done',
    });
    // 给微任务队列一个周期，让潜在 rejection 浮出
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled, false, 'rejection escaped as unhandledRejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('open-rpc stream still forwards events', async () => {
  const sent: unknown[] = [];
  const openRpc = {
    onSessionStream: Object.assign(() => {}, {
      asEvent: (ev: unknown) => {
        sent.push(ev);
        return Promise.resolve();
      },
    }),
  } as unknown as HubStream;

  const sink = createHubStreamSink(openRpc);
  sink.text('sess_x', 'bot_y', 'delta');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { sessionId: 'sess_x', botId: 'bot_y', deltaText: 'delta' });
});
