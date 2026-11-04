import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HubDatabase } from '../apps/hub/src/db.js';

/**
 * 长任务断连容错与重启恢复（long-task reliability）。
 *
 * Phase 3A（Brain in Hub, Hands on Node）后，回合执行与断连附着/回执机制
 * 已随 Hub Durable Runtime 迁入 Hub 侧（见 tests/hub-cancel-persist.test.ts、
 * tests/workflow-event-watchdog.test.ts）。本文件保留与 Node 无关的
 * Hub 重启恢复行为验证：
 *
 * 3. Hub 重启恢复：queued_offline 会话保持 queued，孤儿 running 会话变
 *    failed 并写入诚实中断提示。
 */


test('场景 3（Hub 重启恢复）：queued_offline 会话保持 queued；孤儿 running 会话变 failed 并写入含「继续」提示的系统消息', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reliability-restart-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  try {
    // 第一次初始化：构造 running 孤儿会话 + 含 queued_offline 待发任务的 queued 会话
    {
      const db = new HubDatabase({ dbPath });
      db.ensureBootstrapAdmin('dummy-hash');
      const admin = db.getUserWithHash('admin');
      assert(admin, 'admin must exist');
      db.createNode({
        id: 'node_r',
        name: 'Restart Node',
        platform: 'linux',
        tokenHash: 'x'.repeat(64),
        ownerId: admin.id,
      });
      db.saveBot({
        id: 'bot_r',
        nodeId: 'node_r',
        name: 'bot_r',
        description: '',
        modelProvider: 'openai',
        modelId: 'm',
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        updatedAt: new Date().toISOString(),
      });
      // 孤儿 running：Hub 在回合运行期间被杀，无任何待发任务
      db.createSession({
        id: 'sess_orphan',
        title: '孤儿运行中',
        leadBotId: 'bot_r',
        ownerId: admin.id,
      });
      db.updateSessionStatus('sess_orphan', 'running', 'bot_r');
      // queued + queued_offline 待发任务：断连转队列后 Hub 重启
      db.createSession({
        id: 'sess_pending',
        title: '待发排队',
        leadBotId: 'bot_r',
        ownerId: admin.id,
      });
      db.updateSessionStatus('sess_pending', 'queued', undefined);
      db.enqueueOutboundTask({
        nodeId: 'node_r',
        botId: 'bot_r',
        sessionId: 'sess_pending',
        taskType: 'turn',
        payload: { generation: 0 },
      });
      // 占位的 user 消息（避免空会话）
      db.createMessage({ id: 'msg_u1', sessionId: 'sess_orphan', role: 'user', content: '跑长任务' });
      db.db.close();
    }

    // 重新初始化（触发 resetStaleMetadata，模拟 Hub 重启）
    const db = new HubDatabase({ dbPath });
    t.after(() => db.db.close());

    // 含待发任务的会话保持 queued（不抹成 idle / failed）
    const pending = db.getSession('sess_pending');
    assert.ok(pending, 'sess_pending must exist');
    assert.equal(pending.status, 'queued', '有 queued_offline 待发任务的会话必须保持 queued');
    assert.equal(pending.activeBotId, undefined);

    // 孤儿 running 会话变 failed，且写入诚实中断的 system 消息
    const orphan = db.getSession('sess_orphan');
    assert.ok(orphan, 'sess_orphan must exist');
    assert.equal(orphan.status, 'failed', '无待发任务的孤儿 running 会话必须标记 failed');
    assert.equal(orphan.activeBotId, undefined);
    const orphanMessages = db.getMessages('sess_orphan');
    const restartNotice = orphanMessages.find(
      (m) => m.role === 'system' && m.content.includes('服务重启中断'),
    );
    assert.ok(restartNotice, `必须写入服务重启中断的 system 消息，实际：${JSON.stringify(orphanMessages.map((m) => m.content))}`);
    assert.match(restartNotice!.content, /继续/);
    assert.match(restartNotice!.content, /工作流断点已保留/);

    // 节点全部置 offline
    const node = db.getNode('node_r');
    assert.equal(node!.status, 'offline');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
