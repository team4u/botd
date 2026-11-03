import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { DelegateSessionResult, SessionRecord } from '../packages/protocol/src/index.js';
import { createHub } from '../apps/hub/src/index.js';
import {
  ArtifactError,
  ArtifactService,
} from '../apps/hub/src/artifact-service.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { SseHub } from '../apps/hub/src/sse.js';

/**
 * 交付物双向自动共享闭环测试：
 * 1. 子会话新产出的 Artifact 在子会话完成（idle）时自动零拷贝回传到父会话，
 *    父会话 callback 消息带有 attachments，父会话产物栏可见；
 * 2. 子代理（设置 parentBotId 的 Bot）可在主 Bot 所属会话中正常上传产物。
 */

async function createDelegationContext(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-delivery-loop-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const adminPassword = 'admin-password-loop';
  const hub = createHub({ dbPath, adminPassword, artifactsDir: path.join(dir, 'artifacts') });

  const mockRpcs = new Map<string, any>();
  hub.connections.getNodeRpc = (nodeId: string) => mockRpcs.get(nodeId);

  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const loginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  assert.equal(loginRes.status, 200);
  const adminCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
  const adminUser = hub.db.getUserWithHash('admin')!;

  const jsonRequest = async (url: string, method = 'GET', body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await hub.app.request(url, {
      method,
      headers: { ...headers, cookie: adminCookie },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, json };
  };

  const registerNodeWithBots = (
    ownerId: string,
    nodeId: string,
    bots: Array<{ id: string; parentBotId?: string }>
  ) => {
    hub.db.createNode({
      id: nodeId,
      name: `Node ${nodeId}`,
      platform: 'linux',
      tokenHash: 'dummy_hash',
      ownerId,
    });
    for (const bot of bots) {
      hub.db.saveBot({
        id: bot.id,
        nodeId,
        name: `Bot ${bot.id}`,
        description: '',
        modelProvider: 'openai',
        modelId: 'gpt-4o',
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        updatedAt: new Date().toISOString(),
        ...(bot.parentBotId ? { parentBotId: bot.parentBotId } : {}),
      });
    }
  };

  return { hub, adminUser, mockRpcs, registerNodeWithBots, jsonRequest };
}

const waitFor = async (predicate: () => boolean, timeout = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for condition');
};

test('交付物闭环: 子会话新产物在完成时零拷贝回传父会话，callback 消息带 attachments', async (t) => {
  const ctx = await createDelegationContext(t);
  const { hub, adminUser, mockRpcs, registerNodeWithBots, jsonRequest } = ctx;

  const nodeId = 'node_loop';
  const botLead = 'bot_loop_lead';
  const botWorker = 'bot_loop_worker';
  registerNodeWithBots(adminUser.id, nodeId, [
    { id: botLead },
    { id: botWorker },
  ]);

  mockRpcs.set(nodeId, {
    runTurn: async (input: any) => {
      // 模拟子会话执行期间远端 Bot 通过 artifact 产出新交付物（botd artifact put 路径）
      if (input.botId === botWorker) {
        hub.db.createArtifact({
          id: 'art_child_new_output',
          sessionId: input.sessionId,
          filename: 'analysis_report.md',
          mimeType: 'text/markdown',
          sizeBytes: 512,
          senderBotId: botWorker,
          storagePath: '/tmp/botd-test-child-output.md',
        });
        return { replyText: '分析完成，已产出报告', modelBadge: 'test' };
      }
      return { replyText: `turn:${input.botId}`, modelBadge: 'test' };
    },
    cancelTurn: async () => {},
    resetSession: async () => {},
  });

  // 1. 创建父会话并预置一条父会话产物（用于验证继承产物不回传）
  const parentRes = await jsonRequest('/api/sessions', 'POST', {
    title: '交付物闭环测试',
    leadBotId: botLead,
  });
  assert.equal(parentRes.status, 200, JSON.stringify(parentRes.json));
  const parentSession: SessionRecord = parentRes.json;

  // 预置一条父会话产物（用于验证：继承给子会话的产物不会被重复回传）
  hub.db.createArtifact({
    id: 'art_parent_seed_real',
    sessionId: parentSession.id,
    filename: 'input_data.csv',
    mimeType: 'text/csv',
    sizeBytes: 128,
    senderBotId: botLead,
    storagePath: '/tmp/botd-test-seed-input.csv',
  });

  // 2. 委派子会话（默认会带上父会话全部产物作为继承）
  const delegateRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker,
    prompt: '处理数据并产出报告',
  });
  assert.equal(delegateRes.status, 201, JSON.stringify(delegateRes.json));
  const delegateResult: DelegateSessionResult = delegateRes.json;
  const childSessionId = delegateResult.childSession.id;

  // 4. 等待子会话 idle -> 自动回传 -> 父会话收到完成 callback
  await waitFor(() => {
    const msgs = hub.db.getMessages(parentSession.id);
    return msgs.some((m) => m.role === 'callback' && m.content.includes('已完成'));
  });

  const parentMessages = hub.db.getMessages(parentSession.id);
  const completionMsg = parentMessages.find(
    (m) => m.role === 'callback' && m.content.includes('已完成')
  );
  assert.ok(completionMsg, '父会话必须收到完成 callback 消息');

  // 5. 验证 callback 消息带 attachments，且只包含新产物（不含继承产物）
  assert.ok(completionMsg.attachments, '完成 callback 消息必须带 attachments');
  assert.equal(completionMsg.attachments!.length, 1);
  const att = completionMsg.attachments![0];
  assert.equal(att.filename, 'analysis_report.md');
  assert.equal(att.mimeType, 'text/markdown');
  assert.equal(att.sizeBytes, 512);
  assert.ok(att.id.startsWith('art_'));
  assert.notEqual(att.id, 'art_child_new_output', '回传产物应为父会话中的新引用记录');
  assert.ok(completionMsg.content.includes('📦 产出交付物'));
  assert.ok(completionMsg.content.includes('analysis_report.md'));

  // 6. 验证父会话产物栏（listSessionArtifacts）能看到回传产物，且为同 storagePath 零拷贝引用
  const parentArtifacts = hub.db.listSessionArtifacts(parentSession.id);
  const returnedArt = parentArtifacts.find((a) => a.id === att.id);
  assert.ok(returnedArt, '父会话产物列表必须包含回传产物');
  assert.equal(returnedArt.sessionId, parentSession.id);
  assert.equal(returnedArt.senderBotId, botWorker);

  const childArtWithPath = hub.db.getArtifactWithStoragePath('art_child_new_output');
  const parentArtWithPath = hub.db.getArtifactWithStoragePath(att.id);
  assert.ok(childArtWithPath && parentArtWithPath);
  assert.equal(
    parentArtWithPath.storagePath,
    childArtWithPath.storagePath,
    '回传必须是同 storagePath 零拷贝引用'
  );

  // 7. 继承产物（input_data.csv）不应被重复回传为父会话新产物
  const duplicated = parentArtifacts.filter((a) => a.filename === 'input_data.csv');
  assert.equal(duplicated.length, 1, '继承产物不应被回传复制回父会话');

  // 8. 回传闭环已由 callback 消息 attachments + 产物行 + 零拷贝 storagePath 三重校验成立
});

test('交付物闭环: 子代理（parentBotId）可在主 Bot 所属会话上传产物', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-subagent-art-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const artifactsDir = path.join(dir, 'artifacts');
  const db = new HubDatabase({ dbPath });
  const sseHub = new SseHub();
  const service = new ArtifactService(db, sseHub, { artifactsDir });

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  db.createUser({ id: 'user_1', username: 'subOwner', passwordHash: 'h1', role: 'member' });
  db.createNode({
    id: 'node_sub',
    name: 'SubNode',
    platform: 'linux',
    tokenHash: 't1',
    ownerId: 'user_1',
  });
  db.saveBot({
    id: 'bot_primary',
    nodeId: 'node_sub',
    name: 'Primary Bot',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  });
  // 主 Bot 的子代理
  db.saveBot({
    id: 'bot_subagent',
    nodeId: 'node_sub',
    name: 'Researcher',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
    parentBotId: 'bot_primary',
  });

  db.createSession({
    id: 'sess_sub',
    title: 'Subagent Session',
    leadBotId: 'bot_primary',
    ownerId: 'user_1',
  });

  // 子代理以 node 身份上传产物（botd artifact put 的实际链路）
  const artifact = service.uploadArtifactBuffer(
    { type: 'node', nodeId: 'node_sub' },
    {
      sessionId: 'sess_sub',
      botId: 'bot_subagent',
      filename: 'subagent_report.txt',
      mimeType: 'text/plain',
      content: Buffer.from('subagent deliverable', 'utf8'),
    }
  );
  assert.equal(artifact.filename, 'subagent_report.txt');
  assert.equal(artifact.senderBotId, 'bot_subagent');
  assert.equal(artifact.sizeBytes, 'subagent deliverable'.length);

  // 产物在会话产物列表可见
  const list = service.listSessionArtifacts({ type: 'node', nodeId: 'node_sub' }, 'sess_sub');
  assert.equal(list.length, 1);
  assert.equal(list[0].senderBotId, 'bot_subagent');

  // 反向校验：无关子代理（主 Bot 不在会话中）仍被 403 拒绝
  db.saveBot({
    id: 'bot_other_primary',
    nodeId: 'node_sub',
    name: 'Other Primary',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  });
  db.saveBot({
    id: 'bot_other_subagent',
    nodeId: 'node_sub',
    name: 'Other Subagent',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
    parentBotId: 'bot_other_primary',
  });
  assert.throws(
    () =>
      service.uploadArtifactBuffer(
        { type: 'node', nodeId: 'node_sub' },
        {
          sessionId: 'sess_sub',
          botId: 'bot_other_subagent',
          filename: 'evil.txt',
          mimeType: 'text/plain',
          content: Buffer.from('x'),
        }
      ),
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 403);
      return true;
    },
    '主 Bot 非会话成员的子代理仍应被拒绝'
  );
});
