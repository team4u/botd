import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupRouter } from '../apps/hub/src/group-router.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import type { SessionSseEvent, TurnBlock } from '../packages/protocol/src/index.js';

/**
 * 中止回合的部分输出持久化回归测试：
 * 取消后 generation 已递增、runTurn 抛 cancelled/返回 aborted 时，
 * hub 必须把已产生的 blocks 落盘广播，而不是当作失败丢弃。
 */

function createHarness() {
  const db = new HubDatabase({ dbPath: ':memory:' });
  const events: SessionSseEvent[] = [];
  const sseHub = {
    broadcast: (_sessionId: string, event: SessionSseEvent) => {
      events.push(event);
    },
  };
  return { db, events, sseHub };
}

test('cancelSession 后飞行中的 runTurn 返回 aborted=true：部分输出仍持久化', async () => {
  const { db, events, sseHub } = createHarness();
  const router = new GroupRouter(db, {} as any, sseHub as any);

  db.createUser({ id: 'u1', username: 'admin', passwordHash: 'h', role: 'admin' });
  db.createNode({ id: 'n1', name: 'n1', platform: 'linux', tokenHash: 'h', ownerId: 'u1' });
  db.saveBot({
    id: 'bot1',
    nodeId: 'n1',
    name: 'B1',
    description: '',
    modelProvider: 'p',
    modelId: 'm',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });
  db.createSession({
    id: 'sess_c',
    title: 'cancel',
    mode: 'direct',
    leadBotId: 'bot1',
    memberBotIds: ['bot1'],
    ownerId: 'u1',
  });
  db.createMessage({
    id: 'msg_u1',
    sessionId: 'sess_c',
    role: 'user',
    content: 'go',
  });

  const blocks: TurnBlock[] = [
    { type: 'thinking', thinking: 'partial thinking', status: 'done', durationMs: 100 },
    { type: 'tool', id: 't1', name: 'bash', args: { command: 'ls' }, status: 'cancelled', durationMs: 500 },
  ];

  // runTurn 模拟：先被 cancelSession 打断（延迟返回 aborted），此时 generation 已变
  const rpc = {
    runTurn: async () => {
      // 用户在回合飞行中点了停止
      await router.cancelSession('sess_c');
      return {
        replyText: '',
        modelBadge: 'p/m',
        blocks,
        aborted: true,
      };
    },
    cancelTurn: async () => {},
  };
  (router as any).connections = { getNodeRpc: () => rpc };

  await (router as any).handleUserMessage('sess_c', 'msg_u1', 'go');
  // 等待 processQueue 完成
  await new Promise((r) => setTimeout(r, 100));

  const msgs = db.getMessages('sess_c');
  const abortedMsg = msgs.find((m) => m.role === 'assistant' && m.aborted);
  assert(abortedMsg, 'cancelled turn must persist a partial assistant message with aborted flag');
  assert(abortedMsg.blocks, 'partial blocks must be persisted');
  assert.equal(abortedMsg.blocks!.length, 2);
  const toolBlock = abortedMsg.blocks!.find((b) => b.type === 'tool') as any;
  assert.equal(toolBlock.status, 'cancelled');

  // 广播了部分输出消息（SSE 客户端据此落位已展示内容）
  const broadcast = events.find(
    (e) => e.type === 'message_created' && (e as any).message.aborted
  );
  assert(broadcast, 'partial output message must be broadcast via SSE');
});
