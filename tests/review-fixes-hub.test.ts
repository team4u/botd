import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { HubDatabase } from '../apps/hub/src/db.js';
import { SseHub } from '../apps/hub/src/sse.js';
import { ArtifactService } from '../apps/hub/src/artifact-service.js';
import { createHub } from '../apps/hub/src/index.js';
import type { DelegateSessionResult } from '../packages/protocol/src/index.js';

interface TestContextEnv {
  hub: ReturnType<typeof createHub>;
  dir: string;
  adminUser: { id: string; username: string };
  adminCookie: string;
  registerNodeWithBots: (ownerId: string, nodeId: string, botIds: string[]) => void;
  jsonRequest: (url: string, method?: string, body?: unknown, cookieOverride?: string) => Promise<{ status: number; ok: boolean; json: any }>;
}

async function createTestEnv(t: TestContext): Promise<TestContextEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-review-fixes-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const adminPassword = 'admin-password-review';
  const hub = createHub({ dbPath, adminPassword });

  const mockRpcs = new Map<string, any>();
  hub.connections.getNodeRpc = (nodeId: string) => mockRpcs.get(nodeId);

  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const jsonRequest = async (url: string, method = 'GET', body?: unknown, cookieOverride?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookieOverride) headers['cookie'] = cookieOverride;
    const res = await hub.app.request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, json };
  };

  const rawLoginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  assert.equal(rawLoginRes.status, 200, 'admin login failed');
  const adminCookie = rawLoginRes.headers.get('set-cookie')?.split(';')[0] || '';
  const adminUser = hub.db.getUserWithHash('admin')!;

  const registerNodeWithBots = (ownerId: string, nodeId: string, botIds: string[]) => {
    hub.db.createNode({
      id: nodeId,
      name: `Node ${nodeId}`,
      platform: 'linux',
      tokenHash: 'dummy_hash',
      ownerId,
    });
    for (const botId of botIds) {
      hub.db.saveBot({
        id: botId,
        nodeId,
        name: `Bot ${botId}`,
        description: `Description for ${botId}`,
        modelProvider: 'openai',
        modelId: 'gpt-4o',
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        updatedAt: new Date().toISOString(),
      });
    }
  };

  return {
    hub,
    dir,
    adminUser: { id: adminUser.id, username: adminUser.username },
    adminCookie,
    registerNodeWithBots,
    jsonRequest,
  };
}

test('Fix 1 — getAllSessions omits participants field while getSession preserves participants', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-participants-test-'));
  const dbPath = path.join(dir, 'test-hub.sqlite');
  const db = new HubDatabase({ dbPath });

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  db.createUser({
    id: 'user_alice',
    username: 'alice',
    passwordHash: 'hash_alice',
    role: 'member',
  });
  db.createUser({
    id: 'user_bob',
    username: 'bob',
    passwordHash: 'hash_bob',
    role: 'member',
  });

  const session = db.createSession({
    id: 'sess_collab_1',
    title: 'Collab Session',
    mode: 'direct',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
    ownerId: 'user_alice',
  });

  // Before participant: participants array in getSession is empty
  const singleBefore = db.getSession(session.id);
  assert.ok(singleBefore);
  assert.deepEqual(singleBefore.participants, []);

  // Add participant
  db.addSessionParticipant(session.id, 'user_bob', 'member');

  // getSession includes participants
  const singleAfter = db.getSession(session.id);
  assert.ok(singleAfter);
  assert.ok(singleAfter.participants);
  assert.equal(singleAfter.participants.length, 1);
  assert.equal(singleAfter.participants[0].userId, 'user_bob');

  // getAllSessions for session owner (alice) DOES NOT include participants field (must be undefined)
  const aliceSessions = db.getAllSessions('user_alice');
  assert.equal(aliceSessions.length, 1);
  assert.equal(aliceSessions[0].id, session.id);
  assert.equal(aliceSessions[0].participants, undefined);
  assert.equal('participants' in aliceSessions[0], false);

  // getAllSessions for participant (bob) also DOES NOT include participants field
  const bobSessions = db.getAllSessions('user_bob');
  assert.equal(bobSessions.length, 1);
  assert.equal(bobSessions[0].id, session.id);
  assert.equal(bobSessions[0].participants, undefined);
  assert.equal('participants' in bobSessions[0], false);

  // getAccessibleSessions 语义已并入 getAllSessions，同样不含 participants 字段
  const accessible = db.getAllSessions('user_alice');
  assert.equal(accessible.length, 1);
  assert.equal(accessible[0].participants, undefined);
});

test('Fix 4 — Delegation artifact copy shares storagePath and deletion does not unlink while child references it', async (t) => {
  const env = await createTestEnv(t);
  const { hub, dir, adminUser, adminCookie, registerNodeWithBots, jsonRequest } = env;

  const botLead = 'bot_lead_del';
  const botWorker = 'bot_worker_del';
  registerNodeWithBots(adminUser.id, 'node_del', [botLead, botWorker]);

  // Mock RPC to handle delegation task
  hub.connections.getNodeRpc = () => ({
    runTurn: async () => ({ replyText: 'ok', modelBadge: 'test/model' }),
    resetSession: async () => {},
  } as any);

  const parentSession = hub.db.createSession({
    id: 'sess_del_parent',
    title: 'Parent Session for Delegation',
    mode: 'direct',
    leadBotId: botLead,
    memberBotIds: [botLead, botWorker],
    ownerId: adminUser.id,
  });

  // Create temporary file with test content
  const tempFilePath = path.join(dir, 'shared-report.csv');
  const fileContent = 'id,name,status\n1,task,done\n';
  await writeFile(tempFilePath, fileContent, 'utf8');
  assert.ok(fs.existsSync(tempFilePath));

  // Create artifact on parent session
  const parentArt = hub.db.createArtifact({
    id: 'art_parent_doc',
    sessionId: parentSession.id,
    filename: 'shared-report.csv',
    mimeType: 'text/csv',
    sizeBytes: Buffer.byteLength(fileContent),
    senderBotId: botLead,
    storagePath: tempFilePath,
  });

  // Delegate child session passing artifactIds
  const delegateRes = await jsonRequest(`/api/sessions/${parentSession.id}/delegate`, 'POST', {
    botId: botWorker,
    prompt: 'Please review the shared report',
    artifactIds: [parentArt.id],
  }, adminCookie);

  assert.equal(delegateRes.status, 201, `Delegation failed: ${JSON.stringify(delegateRes.json)}`);
  const delegateResult: DelegateSessionResult = delegateRes.json;
  const childSessionId = delegateResult.childSession.id;

  // Assert child session has an artifact row sharing the exact same storagePath
  const childArtifacts = hub.db.listSessionArtifacts(childSessionId);
  assert.equal(childArtifacts.length, 1);
  const childArtWithStorage = hub.db.getArtifactWithStoragePath(childArtifacts[0].id);
  assert.ok(childArtWithStorage);
  assert.notEqual(childArtWithStorage.id, parentArt.id);
  assert.equal(childArtWithStorage.storagePath, tempFilePath);

  // Delete parent session via HTTP API (which triggers artifacts.deleteSession)
  const delRes = await jsonRequest(`/api/sessions/${parentSession.id}`, 'DELETE', undefined, adminCookie);
  assert.equal(delRes.status, 200);

  // Parent session and its artifact row are deleted
  assert.equal(hub.db.getSession(parentSession.id), undefined);
  assert.equal(hub.db.getArtifact(parentArt.id), undefined);

  // The physical file MUST NOT be unlinked because child session still references it!
  assert.ok(fs.existsSync(tempFilePath), 'Physical file must remain while child session references it');

  // Child artifact content can still be downloaded/read via API
  const contentRes = await hub.app.request(`/api/artifacts/${childArtWithStorage.id}/content`, {
    method: 'GET',
    headers: { cookie: adminCookie },
  });
  assert.equal(contentRes.status, 200);
  const text = await contentRes.text();
  assert.equal(text, fileContent);

  // Delete child session
  const delChildRes = await jsonRequest(`/api/sessions/${childSessionId}`, 'DELETE', undefined, adminCookie);
  assert.equal(delChildRes.status, 200);

  // Both referencing sessions are deleted, physical file MUST now be reclaimed
  assert.equal(fs.existsSync(tempFilePath), false, 'Physical file must be unlinked once child session is deleted');
});

test('Fix 4 — reclaimUnreferencedFiles invariant: shared storagePath kept until last reference deleted', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reclaim-invariant-'));
  const dbPath = path.join(dir, 'test-hub.sqlite');
  const artifactsDir = path.join(dir, 'artifacts');
  const db = new HubDatabase({ dbPath });
  const sseHub = new SseHub();
  const service = new ArtifactService(db, sseHub, { artifactsDir });

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  db.createUser({
    id: 'user_owner',
    username: 'owner',
    passwordHash: 'hash_owner',
    role: 'member',
  });

  db.createSession({
    id: 'sess_alpha',
    title: 'Session Alpha',
    mode: 'direct',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
    ownerId: 'user_owner',
  });

  db.createSession({
    id: 'sess_beta',
    title: 'Session Beta',
    mode: 'direct',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
    ownerId: 'user_owner',
  });

  const sharedDiskFile = path.join(dir, 'shared-data.bin');
  const rawBytes = Buffer.from('Invariant test data: 42');
  await writeFile(sharedDiskFile, rawBytes);
  assert.ok(fs.existsSync(sharedDiskFile));

  // Create two artifact records in different sessions pointing to the same storage path
  db.createArtifact({
    id: 'art_alpha_1',
    sessionId: 'sess_alpha',
    filename: 'shared-data.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: rawBytes.length,
    senderBotId: 'bot_1',
    storagePath: sharedDiskFile,
  });

  db.createArtifact({
    id: 'art_beta_1',
    sessionId: 'sess_beta',
    filename: 'shared-data.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: rawBytes.length,
    senderBotId: 'bot_1',
    storagePath: sharedDiskFile,
  });

  assert.equal(db.isArtifactStoragePathReferenced(sharedDiskFile), true);

  // Delete session Alpha
  const deletedAlpha = service.deleteSession('sess_alpha');
  assert.equal(deletedAlpha, true);
  assert.equal(db.getSession('sess_alpha'), undefined);
  assert.equal(db.getArtifact('art_alpha_1'), undefined);

  // File must still exist because session Beta references it
  assert.ok(fs.existsSync(sharedDiskFile), 'File must not be deleted while session Beta references it');

  // Content is still readable via session Beta
  const betaContent = service.getArtifactContent({ type: 'user', userId: 'user_owner' }, 'art_beta_1');
  assert.equal(betaContent.content.toString('utf8'), 'Invariant test data: 42');

  // Delete session Beta (last referencing session)
  const deletedBeta = service.deleteSession('sess_beta');
  assert.equal(deletedBeta, true);
  assert.equal(db.getSession('sess_beta'), undefined);
  assert.equal(db.getArtifact('art_beta_1'), undefined);

  // File must now be unlinked
  assert.equal(fs.existsSync(sharedDiskFile), false, 'File must be unlinked after all referencing sessions deleted');
});

test('Fix 5 — mapBotRowWithOwner and mapNodeRowWithOwner behavior parity', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-mapping-test-'));
  const dbPath = path.join(dir, 'test-hub.sqlite');
  const db = new HubDatabase({ dbPath });

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  db.createUser({
    id: 'user_u1',
    username: 'user1',
    passwordHash: 'hash1',
    role: 'member',
  });
  db.createUser({
    id: 'user_u2',
    username: 'user2',
    passwordHash: 'hash2',
    role: 'member',
  });

  // Create node owned by user_u1
  db.createNode({
    id: 'node_test_1',
    name: 'Node 1',
    platform: 'linux',
    tokenHash: 'hash_token',
    ownerId: 'user_u1',
    visibility: 'team',
  });

  db.saveBot({
    id: 'bot_test_1',
    nodeId: 'node_test_1',
    name: 'Bot 1',
    description: 'Test Bot',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    visibility: 'team',
    updatedAt: new Date().toISOString(),
  });

  // getNode: ownerId and ownerName populated, isTeamShared undefined
  const node = db.getNode('node_test_1');
  assert.ok(node);
  assert.equal(node.ownerId, 'user_u1');
  assert.equal(node.ownerName, 'user1');
  assert.equal(node.isTeamShared, undefined);

  // getNodeWithSecret: tokenHash present, isTeamShared undefined
  const nodeSecret = db.getNodeWithSecret('node_test_1');
  assert.ok(nodeSecret);
  assert.equal(nodeSecret.tokenHash, 'hash_token');
  assert.equal(nodeSecret.isTeamShared, undefined);

  // getAllNodesWithBots:
  // For owner (user_u1): isTeamShared is undefined/falsy
  const ownerNodes = db.getAllNodesWithBots('user_u1');
  assert.equal(ownerNodes.length, 1);
  assert.equal(ownerNodes[0].isTeamShared, undefined);

  // For other user (user_u2): isTeamShared is true
  const guestNodes = db.getAllNodesWithBots('user_u2');
  assert.equal(guestNodes.length, 1);
  assert.equal(guestNodes[0].isTeamShared, true);

  // getBot: isTeamShared undefined
  const bot = db.getBot('bot_test_1');
  assert.ok(bot);
  assert.equal(bot.ownerId, 'user_u1');
  assert.equal(bot.ownerName, 'user1');
  assert.equal(bot.isTeamShared, undefined);

  // getBotsForNode: isTeamShared undefined
  const botsForNode = db.getBotsForNode('node_test_1');
  assert.equal(botsForNode.length, 1);
  assert.equal(botsForNode[0].isTeamShared, undefined);

  // getAllBots: isTeamShared undefined
  const allBots = db.getAllBots('user_u1');
  assert.equal(allBots.length, 1);
  assert.equal(allBots[0].isTeamShared, undefined);

  // getAccessibleBots:
  // For owner (user_u1): isTeamShared is false
  const user1Bots = db.getAccessibleBots('user_u1');
  assert.equal(user1Bots.length, 1);
  assert.equal(user1Bots[0].isTeamShared, false);

  // For other user (user_u2): isTeamShared is true
  const user2Bots = db.getAccessibleBots('user_u2');
  assert.equal(user2Bots.length, 1);
  assert.equal(user2Bots[0].isTeamShared, true);
});
