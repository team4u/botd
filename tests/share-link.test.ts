import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SharedSessionSnapshot, SessionShareRecord } from '../packages/protocol/src/index.js';
import { createHub, startHub } from '../apps/hub/src/index.js';
import { buildProgram } from '../apps/node/src/cli/program.js';
import { registerSessionsCommands } from '../apps/node/src/cli/commands/sessions.js';

const Command = buildProgram().constructor as new () => ReturnType<typeof buildProgram>;

async function setupTestContext() {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-share-test-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const artifactsDir = path.join(dir, 'artifacts');
  const adminPassword = 'admin-password-test';
  const hub = createHub({ dbPath, adminPassword, artifactsDir });

  // 1. Login as admin
  const adminLoginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  assert.equal(adminLoginRes.status, 200, 'admin login failed');
  const adminCookie = adminLoginRes.headers.get('set-cookie')?.split(';')[0] || '';
  const adminUser = hub.db.getUserWithHash('admin')!;

  // 2. Helper to create a second user
  const createUser = async (username: string, password: string) => {
    const res = await hub.app.request('/api/users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({ username, password, role: 'member' }),
    });
    assert.equal(res.status, 200);

    const loginRes = await hub.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(loginRes.status, 200);
    const userCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
    const user = hub.db.getUserWithHash(username)!;
    return { user: { id: user.id, username: user.username }, cookie: userCookie };
  };

  const registerNodeWithBots = (ownerId: string, nodeId: string, bots: Array<{ id: string; name: string; provider: string; model: string }>) => {
    hub.db.createNode({
      id: nodeId,
      name: `Node ${nodeId}`,
      platform: 'linux',
      tokenHash: 'dummy_hash',
      ownerId,
    });
    for (const b of bots) {
      hub.db.saveBot({
        id: b.id,
        nodeId,
        name: b.name,
        description: `Description for ${b.name}`,
        modelProvider: b.provider,
        modelId: b.model,
        thinkingLevel: 'medium',
        enabledSkills: [],
        enabledExtensions: [],
        updatedAt: new Date().toISOString(),
      });
    }
  };

  const cleanup = async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  };

  return {
    hub,
    dir,
    adminUser,
    adminCookie,
    createUser,
    registerNodeWithBots,
    cleanup,
  };
}

test('Session share link: full lifecycle and authorization', async (t) => {
  const ctx = await setupTestContext();
  t.after(ctx.cleanup);

  const { hub, adminUser, adminCookie, createUser, registerNodeWithBots } = ctx;

  // Create second user
  const { user: user2, cookie: user2Cookie } = await createUser('user2', 'user2password');

  // Register bots for admin
  registerNodeWithBots(adminUser.id, 'node_main', [
    { id: 'bot_lead', name: 'Lead Architect', provider: 'anthropic', model: 'claude-3-7-sonnet' },
    { id: 'bot_worker', name: 'Code Reviewer', provider: 'openai', model: 'gpt-4o' },
  ]);

  // Create session for admin
  const session = hub.db.createSession({
    id: 'sess_share_test',
    title: 'Distributed System Design Review',
    leadBotId: 'bot_lead',
    ownerId: adminUser.id,
  });

  // Upload an artifact into session
  const artifactUploadRes = await hub.app.request(`/api/sessions/${session.id}/artifacts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: adminCookie,
    },
    body: JSON.stringify({
      filename: 'architecture.md',
      mimeType: 'text/markdown',
      contentBase64: Buffer.from('# Architecture Blueprint\n\nHigh-throughput streaming.').toString('base64'),
    }),
  });
  assert.equal(artifactUploadRes.status, 201);
  const artifact = await artifactUploadRes.json();
  assert.ok(artifact.id);

  // Add messages: User message and Assistant reply with ToolCalls, Usage and Attachment
  hub.db.createMessage({
    id: 'msg_user_1',
    sessionId: session.id,
    role: 'user',
    content: 'Please evaluate the distributed cache design.',
  });

  hub.db.createMessage({
    id: 'msg_assistant_1',
    sessionId: session.id,
    role: 'assistant',
    senderBotId: 'bot_lead',
    modelBadge: 'anthropic/claude-3-7-sonnet',
    content: 'Review complete. See attached blueprint.',
    toolCalls: [
      {
        name: 'benchmark_cache',
        summary: 'Benchmarking 10000 QPS',
        status: 'done',
        durationMs: 340,
      },
    ],
    usage: {
      inputTokens: 120,
      outputTokens: 250,
      totalTokens: 370,
    },
    attachments: [
      {
        id: artifact.id,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        url: `/api/artifacts/${artifact.id}/content`,
      },
    ],
  });

  // 1. Initial state: no share link created yet
  const initialShareRes = await hub.app.request(`/api/sessions/${session.id}/share`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(initialShareRes.status, 200);
  const initialShare = await initialShareRes.json();
  assert.deepEqual(initialShare, { share: null });

  // 2. Non-owner (user2) access to share routes -> 403 Forbidden
  const forbiddenGet = await hub.app.request(`/api/sessions/${session.id}/share`, {
    headers: { cookie: user2Cookie },
  });
  assert.equal(forbiddenGet.status, 403);

  const forbiddenPost = await hub.app.request(`/api/sessions/${session.id}/share`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: user2Cookie,
    },
    body: JSON.stringify({}),
  });
  assert.equal(forbiddenPost.status, 403);

  const forbiddenDelete = await hub.app.request(`/api/sessions/${session.id}/share`, {
    method: 'DELETE',
    headers: { cookie: user2Cookie },
  });
  assert.equal(forbiddenDelete.status, 403);

  // 3. Non-existent session -> 404 Not Found
  const notFoundGet = await hub.app.request('/api/sessions/non_existent_id/share', {
    headers: { cookie: adminCookie },
  });
  assert.equal(notFoundGet.status, 404);

  // 4. Create share link as owner -> 201 Created
  const createShareRes = await hub.app.request(`/api/sessions/${session.id}/share`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: adminCookie,
    },
    body: JSON.stringify({}),
  });
  assert.equal(createShareRes.status, 201);
  const createdShare: SessionShareRecord = await createShareRes.json();
  assert.ok(createdShare.id.startsWith('shr_'));
  assert.equal(createdShare.sessionId, session.id);
  assert.ok(createdShare.token.length >= 32);
  assert.ok(createdShare.createdAt);

  // 5. Query share link as owner -> returns the record
  const getShareRes = await hub.app.request(`/api/sessions/${session.id}/share`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(getShareRes.status, 200);
  const queryShareResult = await getShareRes.json();
  assert.deepEqual(queryShareResult.share, createdShare);

  // 6. Idempotent create without regenerate returns same share record
  const secondCreateRes = await hub.app.request(`/api/sessions/${session.id}/share`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: adminCookie,
    },
    body: JSON.stringify({}),
  });
  assert.equal(secondCreateRes.status, 200);
  const secondShare = await secondCreateRes.json();
  assert.equal(secondShare.token, createdShare.token);

  // 7. Regenerate creates a new token
  const regenRes = await hub.app.request(`/api/sessions/${session.id}/share`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: adminCookie,
    },
    body: JSON.stringify({ regenerate: true }),
  });
  assert.equal(regenRes.status, 201);
  const regeneratedShare: SessionShareRecord = await regenRes.json();
  assert.notEqual(regeneratedShare.token, createdShare.token);
  assert.equal(regeneratedShare.sessionId, session.id);

  // The old token should now be invalid
  const oldTokenRes = await hub.app.request(`/api/public/shares/${createdShare.token}`);
  assert.equal(oldTokenRes.status, 404);

  // 8. Public anonymous access to the active share token (NO cookies)
  const publicRes = await hub.app.request(`/api/public/shares/${regeneratedShare.token}`);
  assert.equal(publicRes.status, 200);
  const snapshot: SharedSessionSnapshot = await publicRes.json();

  // Verify share metadata
  assert.equal(snapshot.share.token, regeneratedShare.token);
  assert.equal(snapshot.share.sessionId, session.id);

  // Verify session metadata
  assert.equal(snapshot.session.id, session.id);
  assert.equal(snapshot.session.title, 'Distributed System Design Review');
  assert.equal(snapshot.session.leadBotId, 'bot_lead');

  // Verify bot summaries (sensitive fields like prompt / env stripped)
  assert.equal(snapshot.bots.length, 1);
  const leadBot = snapshot.bots.find((b: { id: string }) => b.id === 'bot_lead');
  assert.ok(leadBot);
  assert.equal(leadBot.name, 'Lead Architect');
  assert.equal(leadBot.modelProvider, 'anthropic');
  assert.equal(leadBot.modelId, 'claude-3-7-sonnet');
  assert.equal((leadBot as any).prompt, undefined);

  // Verify messages, tool calls, and usage
  assert.equal(snapshot.messages.length, 2);
  const userMsg = snapshot.messages[0];
  assert.equal(userMsg.role, 'user');
  assert.equal(userMsg.content, 'Please evaluate the distributed cache design.');

  const assistantMsg = snapshot.messages[1];
  assert.equal(assistantMsg.role, 'assistant');
  assert.equal(assistantMsg.senderBotId, 'bot_lead');
  assert.equal(assistantMsg.modelBadge, 'anthropic/claude-3-7-sonnet');
  assert.ok(assistantMsg.toolCalls && assistantMsg.toolCalls.length === 1);
  assert.equal(assistantMsg.toolCalls[0].name, 'benchmark_cache');
  assert.equal(assistantMsg.toolCalls[0].durationMs, 340);
  assert.deepEqual(assistantMsg.usage, {
    inputTokens: 120,
    outputTokens: 250,
    totalTokens: 370,
  });

  // Verify attachment URL was rewritten to public path
  assert.ok(assistantMsg.attachments && assistantMsg.attachments.length === 1);
  const att = assistantMsg.attachments[0];
  assert.equal(att.id, artifact.id);
  const expectedPublicUrl = `/api/public/shares/${encodeURIComponent(regeneratedShare.token)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
  assert.equal(att.url, expectedPublicUrl);

  // Verify artifacts list
  assert.equal(snapshot.artifacts.length, 1);
  assert.equal(snapshot.artifacts[0].id, artifact.id);

  // 9. Public artifact download without cookie
  const publicArtifactRes = await hub.app.request(att.url);
  assert.equal(publicArtifactRes.status, 200);
  assert.equal(publicArtifactRes.headers.get('content-type'), 'text/markdown');
  assert.ok(publicArtifactRes.headers.get('content-disposition')?.includes('architecture.md'));
  const artifactBody = await publicArtifactRes.text();
  assert.ok(artifactBody.includes('# Architecture Blueprint'));

  // 10. Accessing artifact with invalid token returns 404
  const invalidTokenArtifactRes = await hub.app.request(
    `/api/public/shares/invalid_token/artifacts/${artifact.id}/content`
  );
  assert.equal(invalidTokenArtifactRes.status, 404);

  // 11. Accessing non-existent artifact with valid token returns 404
  const invalidArtIdRes = await hub.app.request(
    `/api/public/shares/${regeneratedShare.token}/artifacts/non_existent_art/content`
  );
  assert.equal(invalidArtIdRes.status, 404);

  // 12. Revoke share link
  const deleteShareRes = await hub.app.request(`/api/sessions/${session.id}/share`, {
    method: 'DELETE',
    headers: { cookie: adminCookie },
  });
  assert.equal(deleteShareRes.status, 200);
  const deleteJson = await deleteShareRes.json();
  assert.deepEqual(deleteJson, { ok: true });

  // Share query should now return null
  const postDeleteShareRes = await hub.app.request(`/api/sessions/${session.id}/share`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(postDeleteShareRes.status, 200);
  assert.deepEqual(await postDeleteShareRes.json(), { share: null });

  // Public access to the revoked token must return 404
  const revokedAccessRes = await hub.app.request(`/api/public/shares/${regeneratedShare.token}`);
  assert.equal(revokedAccessRes.status, 404);

  // Public artifact download with revoked token must return 404
  const revokedArtifactRes = await hub.app.request(att.url);
  assert.equal(revokedArtifactRes.status, 404);
});

test('CLI: botd sessions share command supports create, regenerate, and revoke', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-cli-share-test-'));
  const cliDir = path.join(dir, 'cli-data');
  const dbPath = path.join(dir, 'hub.sqlite');
  const artifactsDir = path.join(dir, 'artifacts');
  const adminPassword = 'cli-test-admin-password';

  const hubInstance = await startHub({
    port: 0,
    adminPassword,
    dbPath,
    artifactsDir,
  });

  t.after(async () => {
    await hubInstance.close();
    await new Promise<void>((resolve) => hubInstance.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const adminUser = hubInstance.db.getUserWithHash('admin')!;
  const session = hubInstance.db.createSession({
    id: 'sess_cli_test',
    title: 'CLI Share Test Session',
    leadBotId: 'bot_dummy',
    ownerId: adminUser.id,
  });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '));
  };

  const runCli = async (args: string[]) => {
    logs.length = 0;
    const program = new Command();
    program.option('--data-dir <path>', 'Data dir');
    program.option('--hub <url>', 'Hub URL');
    program.option('--username <name>', 'Username');
    program.option('--password <pass>', 'Password');
    program.option('--json', 'JSON output');
    registerSessionsCommands(program);

    await program.parseAsync([
      'node',
      'cli',
      '--data-dir',
      cliDir,
      '--hub',
      `http://127.0.0.1:${hubInstance.port}`,
      '--username',
      'admin',
      '--password',
      adminPassword,
      '--json',
      ...args,
    ]);
  };

  try {
    // 1. Create share link via CLI
    await runCli(['sessions', 'share', session.id]);
    assert.equal(logs.length, 1);
    const parsed1 = JSON.parse(logs[0]);
    assert.ok(parsed1.id.startsWith('shr_'));
    assert.equal(parsed1.sessionId, session.id);
    assert.ok(parsed1.token);
    assert.equal(parsed1.url, `http://127.0.0.1:${hubInstance.port}/?share=${parsed1.token}`);

    const token1 = parsed1.token;

    // 2. Run without flags -> returns existing active share record
    await runCli(['sessions', 'share', session.id]);
    assert.equal(logs.length, 1);
    const parsed2 = JSON.parse(logs[0]);
    assert.equal(parsed2.token, token1);

    // 3. Regenerate share token via CLI
    await runCli(['sessions', 'share', session.id, '--regenerate']);
    assert.equal(logs.length, 1);
    const parsed3 = JSON.parse(logs[0]);
    assert.notEqual(parsed3.token, token1);
    assert.equal(parsed3.url, `http://127.0.0.1:${hubInstance.port}/?share=${parsed3.token}`);

    // 4. Revoke share link via CLI
    await runCli(['sessions', 'share', session.id, '--revoke']);
    assert.equal(logs.length, 1);
    const parsed4 = JSON.parse(logs[0]);
    assert.deepEqual(parsed4, { ok: true });
  } finally {
    console.log = originalLog;
  }
});
