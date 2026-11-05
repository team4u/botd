import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HubDatabase } from '../apps/hub/src/db.js';

/**
 * Hub 重启恢复（long-task reliability）。
 *
 * 回合执行与断连容错已随 Hub Durable Runtime 收敛（见 tests/hub-cancel-persist.test.ts、
 * tests/workflow-event-watchdog.test.ts）。本文件验证 resetStaleMetadata 的重启语义：
 *
 * - queued 会话：内存队列已随重启丢失，统一归位 idle；
 * - running 孤儿且库内无 pi_* 表（无持久化可恢复）：诚实标记 failed 并写入
 *   含「继续」提示的系统消息；
 * - running 且库内存在 pi_conversations 表（单库 pi-durable 共存）：保持原状，
 *   交由 pi-durable 重启接管。
 */


test('Hub 重启恢复：queued 归位 idle；无 pi_* 表的孤儿 running 变 failed 并写入「继续」提示；有 pi_conversations 的 running 保持原状', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reliability-restart-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  try {
    // 第一次初始化：构造 queued / 孤儿 running / durable running 三类会话
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
      // 孤儿 running：Hub 在回合运行期间被杀，库内尚无 pi_* 持久表
      db.createSession({
        id: 'sess_orphan',
        title: '孤儿运行中',
        leadBotId: 'bot_r',
        ownerId: admin.id,
      });
      db.updateSessionStatus('sess_orphan', 'running', 'bot_r');
      // queued：内存队列已随重启丢失
      db.createSession({
        id: 'sess_pending',
        title: '待发排队',
        leadBotId: 'bot_r',
        ownerId: admin.id,
      });
      db.updateSessionStatus('sess_pending', 'queued', undefined);
      // durable running：与 pi_* 表同库共存，重启后交由 pi-durable 接管
      db.createSession({
        id: 'sess_durable',
        title: '持久运行中',
        leadBotId: 'bot_r',
        ownerId: admin.id,
      });
      db.updateSessionStatus('sess_durable', 'running', 'bot_r');
      // 占位的 user 消息（避免空会话）
      db.createMessage({ id: 'msg_u1', sessionId: 'sess_orphan', role: 'user', content: '跑长任务' });
      db.close();
    }

    // 模拟 pi-durable 已在库内建立 pi_* 表（单库共存标记）
    {
      const raw = new DatabaseSync(dbPath);
      raw.exec('CREATE TABLE pi_conversations (id INTEGER PRIMARY KEY)');
      raw.close();
    }

    // 重新初始化（触发 resetStaleMetadata，模拟 Hub 重启）
    const db = new HubDatabase({ dbPath });
    t.after(() => db.close());

    // queued 会话：内存队列已丢，归位 idle
    const pending = db.getSession('sess_pending');
    assert.ok(pending, 'sess_pending must exist');
    assert.equal(pending.status, 'idle', 'queued 会话重启后必须归位 idle');
    assert.equal(pending.activeBotId, undefined);

    // durable running 会话：pi_conversations 在场，保持原状等待恢复
    const durable = db.getSession('sess_durable');
    assert.ok(durable, 'sess_durable must exist');
    assert.equal(durable.status, 'running', 'pi_* 表在场时 running 会话必须保持原状');

    // 节点全部置 offline
    const node = db.getNode('node_r');
    assert.equal(node!.status, 'offline');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('无 pi_* 表时孤儿 running 会话变 failed 并写入诚实中断提示', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reliability-orphan-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  try {
    {
      const db = new HubDatabase({ dbPath });
      db.ensureBootstrapAdmin('dummy-hash');
      const admin = db.getUserWithHash('admin')!;
      db.createNode({
        id: 'node_o',
        name: 'Orphan Node',
        platform: 'linux',
        tokenHash: 'x'.repeat(64),
        ownerId: admin.id,
      });
      db.saveBot({
        id: 'bot_o',
        nodeId: 'node_o',
        name: 'bot_o',
        description: '',
        modelProvider: 'openai',
        modelId: 'm',
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        updatedAt: new Date().toISOString(),
      });
      db.createSession({
        id: 'sess_orphan',
        title: '孤儿运行中',
        leadBotId: 'bot_o',
        ownerId: admin.id,
      });
      db.updateSessionStatus('sess_orphan', 'running', 'bot_o');
      db.close();
    }

    const db = new HubDatabase({ dbPath });
    t.after(() => db.close());

    const orphan = db.getSession('sess_orphan');
    assert.ok(orphan, 'sess_orphan must exist');
    assert.equal(orphan.status, 'failed', '无 pi_* 持久表的孤儿 running 会话必须标记 failed');
    assert.equal(orphan.activeBotId, undefined);
    const orphanMessages = db.getMessages('sess_orphan');
    const restartNotice = orphanMessages.find(
      (m) => m.role === 'system' && m.content.includes('服务重启中断'),
    );
    assert.ok(restartNotice, `必须写入服务重启中断的 system 消息，实际：${JSON.stringify(orphanMessages.map((m) => m.content))}`);
    assert.match(restartNotice!.content, /继续/);
    assert.match(restartNotice!.content, /工作流断点已保留/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
