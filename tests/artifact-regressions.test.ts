import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HubDatabase } from '../apps/hub/src/db.js';
import { SseHub } from '../apps/hub/src/sse.js';
import {
  ArtifactError,
  ArtifactService,
  MAX_ARTIFACT_BYTES,
} from '../apps/hub/src/artifact-service.js';
import { NodeConnectionManager } from '../apps/hub/src/ws-hub.js';
import { AuthManager } from '../apps/hub/src/auth.js';

async function setupTestEnv() {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-artifact-test-'));
  const dbPath = path.join(dir, 'test-hub.sqlite');
  const artifactsDir = path.join(dir, 'artifacts');
  const db = new HubDatabase({ dbPath });
  const sseHub = new SseHub();
  const service = new ArtifactService(db, sseHub, { artifactsDir });
  const auth = new AuthManager();

  return {
    dir,
    dbPath,
    artifactsDir,
    db,
    sseHub,
    service,
    auth,
    cleanup: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('Database helper contracts: getSessionOwner and row mappings', { timeout: 60_000 }, async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const { db } = env;

  db.createUser({
    id: 'user_1',
    username: 'bob',
    passwordHash: 'hash',
    role: 'member',
  });

  db.createSession({
    id: 'sess_contract',
    title: 'Owner Test',
    leadBotId: 'bot_1',
    ownerId: 'user_1',
  });

  assert.equal(db.getSessionOwner('sess_contract'), 'user_1');
  assert.equal(db.getSessionOwner('non_existent'), undefined);

  // Node and Bot creation and mapping
  db.createNode({
    id: 'node_1',
    name: 'Node One',
    platform: 'linux',
    tokenHash: 'token_hash',
    ownerId: 'user_1',
  });

  const node = db.getNode('node_1');
  assert.ok(node);
  assert.equal(node.id, 'node_1');
  assert.equal(node.name, 'Node One');
  assert.deepEqual(node.skills, []);

  db.saveBot({
    id: 'bot_1',
    nodeId: 'node_1',
    name: 'Bot One',
    description: 'A test bot',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: ['skill-a'],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  });

  const bot = db.getBot('bot_1');
  assert.ok(bot);
  assert.equal(bot.id, 'bot_1');
  assert.equal(bot.name, 'Bot One');
  assert.deepEqual(bot.enabledSkills, ['skill-a']);
});

test('Path traversal rejection: download does not fall back to disk path', { timeout: 60_000 }, async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const { dir, db, service } = env;

  // Create sentinel file outside artifacts dir
  const sentinelPath = path.join(dir, 'sentinel.txt');
  await writeFile(sentinelPath, 'SENSITIVE_DATA', 'utf8');

  db.createUser({
    id: 'user_1',
    username: 'traversal_user',
    passwordHash: 'hash',
    role: 'member',
  });
  db.createNode({
    id: 'node_1',
    name: 'Node 1',
    platform: 'linux',
    tokenHash: 'tok',
    ownerId: 'user_1',
  });

  // Attempt download using path traversal in artifactId via Node actor
  assert.throws(
    () => {
      service.downloadArtifact({ type: 'node', nodeId: 'node_1' }, '../sentinel.txt');
    },
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 404);
      assert.match(err.message, /not found/i);
      return true;
    }
  );

  // Attempt via User actor
  assert.throws(
    () => {
      service.getArtifactContent({ type: 'user', userId: 'user_1' }, '../../sentinel.txt');
    },
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('Access control: cross-user owner rejected, same-owner cross-node allowed', { timeout: 60_000 }, async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const { db, service } = env;

  // User 1 owns session_1, node_1a, and node_1b
  db.createUser({ id: 'user_1', username: 'u1', passwordHash: 'h1', role: 'member' });
  db.createNode({ id: 'node_1a', name: 'N1A', platform: 'linux', tokenHash: 't1', ownerId: 'user_1' });
  db.createNode({ id: 'node_1b', name: 'N1B', platform: 'linux', tokenHash: 't2', ownerId: 'user_1' });
  db.saveBot({
    id: 'bot_1a',
    nodeId: 'node_1a',
    name: 'Bot 1A',
    description: 'Bot 1A description',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    thinkingLevel: 'medium',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  });

  db.createSession({
    id: 'session_1',
    title: 'Shared Session',
    leadBotId: 'bot_1a',
    ownerId: 'user_1',
  });

  // User 2 owns node_2
  db.createUser({ id: 'user_2', username: 'u2', passwordHash: 'h2', role: 'member' });
  db.createNode({ id: 'node_2', name: 'N2', platform: 'linux', tokenHash: 't3', ownerId: 'user_2' });

  // 1. Node 1a uploads an artifact into session 1
  const contentStr = 'Hello from Node 1A';
  const artifact = service.uploadArtifact(
    { type: 'node', nodeId: 'node_1a' },
    {
      sessionId: 'session_1',
      botId: 'bot_1a',
      filename: 'output.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from(contentStr, 'utf8').toString('base64'),
    }
  );
  assert.ok(artifact.id);

  // 2. Cross-user rejection: Node 2 (User 2) cannot list or download
  assert.throws(
    () => service.listSessionArtifacts({ type: 'node', nodeId: 'node_2' }, 'session_1'),
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 403);
      return true;
    }
  );
  assert.throws(
    () => service.downloadArtifact({ type: 'node', nodeId: 'node_2' }, artifact.id),
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 403);
      return true;
    }
  );
  assert.throws(
    () =>
      service.uploadArtifact(
        { type: 'node', nodeId: 'node_2' },
        {
          sessionId: 'session_1',
          filename: 'hacked.txt',
          contentBase64: Buffer.from('bad').toString('base64'),
        }
      ),
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 403);
      return true;
    }
  );

  // 3. Same-owner cross-node allowed: Node 1b (User 1) can list and download
  const listFrom1b = service.listSessionArtifacts({ type: 'node', nodeId: 'node_1b' }, 'session_1');
  assert.equal(listFrom1b.length, 1);
  assert.equal(listFrom1b[0].id, artifact.id);

  const downloadedBy1b = service.downloadArtifact({ type: 'node', nodeId: 'node_1b' }, artifact.id);
  assert.equal(
    Buffer.from(downloadedBy1b.contentBase64, 'base64').toString('utf8'),
    contentStr
  );

  // 4. User 1 can also access
  const downloadedByUser = service.getArtifactContent({ type: 'user', userId: 'user_1' }, artifact.id);
  assert.equal(downloadedByUser.content.toString('utf8'), contentStr);
});

test('Upload size limit and validation are unified', { timeout: 60_000 }, async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const { db, service } = env;

  db.createUser({ id: 'user_u', username: 'uploader', passwordHash: 'h', role: 'member' });
  db.createSession({
    id: 'sess_size',
    title: 'Size Check',
    leadBotId: 'bot_lead',
    ownerId: 'user_u',
  });

  // Empty content rejection
  assert.throws(
    () =>
      service.uploadArtifact(
        { type: 'user', userId: 'user_u' },
        {
          sessionId: 'sess_size',
          filename: 'empty.txt',
          contentBase64: '',
        }
      ),
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 400);
      return true;
    }
  );

  // Exceeding MAX_ARTIFACT_BYTES
  const hugeBuffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1024);
  assert.throws(
    () =>
      service.uploadArtifact(
        { type: 'user', userId: 'user_u' },
        {
          sessionId: 'sess_size',
          filename: 'huge.bin',
          contentBase64: hugeBuffer.toString('base64'),
        }
      ),
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 413);
      return true;
    }
  );

  // Invalid filename type rejection
  assert.throws(
    () =>
      service.uploadArtifact(
        { type: 'user', userId: 'user_u' },
        {
          sessionId: 'sess_size',
          filename: '   ',
          contentBase64: Buffer.from('hello').toString('base64'),
        }
      ),
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('Fork session: attachments rewritten, cross-owner clone rejected, survives source deletion, and cleans up on last reference', { timeout: 60_000 }, async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const { db, service } = env;

  db.createUser({ id: 'user_f', username: 'forker', passwordHash: 'h', role: 'member' });
  db.createUser({ id: 'user_victim', username: 'victim', passwordHash: 'h', role: 'member' });

  // 1. Victim session and artifact
  db.createSession({
    id: 'sess_victim',
    title: 'Victim Session',
    leadBotId: 'bot_victim',
    ownerId: 'user_victim',
  });
  const victimArt = service.uploadArtifact(
    { type: 'user', userId: 'user_victim' },
    {
      sessionId: 'sess_victim',
      filename: 'victim_secret.txt',
      contentBase64: Buffer.from('VICTIM_SECRET').toString('base64'),
    }
  );

  // 2. Attacker session
  db.createSession({
    id: 'sess_attacker',
    title: 'Attacker Session',
    leadBotId: 'bot_lead',
    ownerId: 'user_f',
  });

  // Legitimate artifact in attacker's session
  const artifactContent = 'Important File Content For Fork';
  const artifact = service.uploadArtifact(
    { type: 'user', userId: 'user_f' },
    {
      sessionId: 'sess_attacker',
      filename: 'doc.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from(artifactContent).toString('base64'),
    }
  );

  const artWithStorage = db.getArtifactWithStoragePath(artifact.id);
  assert.ok(artWithStorage);
  const diskPath = artWithStorage.storagePath;
  assert.ok(fs.existsSync(diskPath));

  // Attacker creates a message with both legitimate attachment and malicious pointer to victim's artifact
  db.createMessage({
    id: 'msg_1',
    sessionId: 'sess_attacker',
    role: 'assistant',
    content: 'Here is your doc',
    attachments: [
      {
        id: artifact.id,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        url: `/api/artifacts/${artifact.id}/content`,
      },
      {
        id: victimArt.id,
        filename: victimArt.filename,
        mimeType: victimArt.mimeType,
        sizeBytes: victimArt.sizeBytes,
        url: `/api/artifacts/${victimArt.id}/content`,
      },
    ],
  });

  // Fork attacker session from msg_1
  const forkedSession = db.forkSession('sess_attacker', 'msg_1');
  assert.ok(forkedSession);
  assert.notEqual(forkedSession.id, 'sess_attacker');

  // Verify forked session's messages
  const forkedMessages = db.getMessages(forkedSession.id);
  assert.equal(forkedMessages.length, 1);
  const forkedMsg = forkedMessages[0];
  assert.ok(forkedMsg.attachments);

  // Legitimate attachment must be rewritten to a new ID
  const legitimateForkedAttachment = forkedMsg.attachments.find((a) => a.filename === 'doc.txt');
  assert.ok(legitimateForkedAttachment);
  assert.notEqual(legitimateForkedAttachment.id, artifact.id);
  assert.equal(legitimateForkedAttachment.url, `/api/artifacts/${legitimateForkedAttachment.id}/content`);

  // Malicious victim attachment MUST NOT be cloned into forkedSession
  const victimAttachmentInFork = forkedMsg.attachments.find((a) => a.filename === 'victim_secret.txt');
  assert.ok(victimAttachmentInFork);
  // It must still retain original id without a new clone in forkedSession's artifacts table
  assert.equal(victimAttachmentInFork.id, victimArt.id);
  // And attacker cannot download it via user actor because victimArt belongs to user_victim
  assert.throws(
    () => service.getArtifactContent({ type: 'user', userId: 'user_f' }, victimArt.id),
    (err: any) => {
      assert.ok(err instanceof ArtifactError);
      assert.equal(err.status, 403);
      return true;
    }
  );

  // Delete attacker's source session
  const deletedSource = service.deleteSession('sess_attacker');
  assert.equal(deletedSource, true);

  // Source session and its artifact records are deleted
  assert.equal(db.getSession('sess_attacker'), undefined);
  assert.equal(db.getArtifact(artifact.id), undefined);

  // The physical file MUST NOT be deleted because forkedSession still references it!
  assert.ok(fs.existsSync(diskPath), 'Physical file must still exist while forked session references it');

  // Forked artifact can STILL be downloaded!
  const forkedContent = service.getArtifactContent({ type: 'user', userId: 'user_f' }, legitimateForkedAttachment.id);
  assert.equal(forkedContent.content.toString('utf8'), artifactContent);

  // Now delete the forked session: last reference is gone!
  const deletedFork = service.deleteSession(forkedSession.id);
  assert.equal(deletedFork, true);
  assert.equal(db.getSession(forkedSession.id), undefined);
  assert.equal(db.getArtifact(legitimateForkedAttachment.id), undefined);

  // Physical file MUST now be reclaimed (unlinked)!
  assert.equal(fs.existsSync(diskPath), false, 'Physical file must be unlinked after last reference is deleted');
});

test('Persistent cleanup GC records failures and retries on service operations', { timeout: 60_000 }, async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const { dir, db, sseHub } = env;

  const dummyPath = path.join(dir, 'dummy-to-gc.bin');
  await writeFile(dummyPath, 'content', 'utf8');
  assert.ok(fs.existsSync(dummyPath));

  // Record failure to DB
  db.recordArtifactCleanupPending(dummyPath, 'EACCES simulated error');
  const pendingList = db.listArtifactCleanupPending();
  assert.equal(pendingList.length, 1);
  assert.equal(pendingList[0].storagePath, dummyPath);

  // New service instance starts up and runs retryPendingCleanups
  const service2 = new ArtifactService(db, sseHub, { artifactsDir: path.join(dir, 'artifacts') });
  assert.ok(service2);

  // File should now be unlinked and removed from pending table
  assert.equal(fs.existsSync(dummyPath), false);
  assert.equal(db.listArtifactCleanupPending().length, 0);
});

test('NodeConnectionManager integrates with ArtifactService default and custom instance', { timeout: 60_000 }, async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const { db, auth, sseHub, service } = env;

  // ArtifactService 注入入口随 WS 回退双轨删除而移除：管理器只维护连接与 envRpc
  const manager = new NodeConnectionManager(db, auth, sseHub);
  assert.ok(manager);
  assert.ok(service);
});
