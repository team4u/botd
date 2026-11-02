import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHub } from '../apps/hub/src/index.js';

interface TestEnv {
  hub: ReturnType<typeof createHub>;
  dir: string;
  cookie: string;
  mockRpcs: Map<string, any>;
  jsonRequest: (url: string, method?: string, body?: unknown) => Promise<{ status: number; ok: boolean; json: any }>;
}

async function createTestContext(t: TestContext): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-primary-subagent-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const adminPassword = 'test-admin-password';
  const hub = createHub({ dbPath, adminPassword });

  const mockRpcs = new Map<string, any>();
  hub.connections.getNodeRpc = (nodeId: string) => mockRpcs.get(nodeId);

  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const jsonRequest = async (url: string, method = 'GET', body?: unknown) => {
    const headers: Record<string, string> = { cookie };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const res = await hub.app.request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, ok: res.ok, json };
  };

  const loginRes = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

  return { hub, dir, cookie, mockRpcs, jsonRequest };
}

test('1 Node = 1 Primary Bot: POST /api/bots enforces single primary bot per node', async (t) => {
  const ctx = await createTestContext(t);

  // 1. Register a node with 1 primary bot
  ctx.hub.db.createNode({
    id: 'node_alpha',
    name: 'Node Alpha',
    platform: 'linux',
    tokenHash: 'hash',
    ownerId: 'user_admin',
  });

  ctx.mockRpcs.set('node_alpha', {
    saveBot: async () => {},
    readFile: async () => '',
  });

  const firstBot = await ctx.jsonRequest('/api/bots', 'POST', {
    id: 'bot_primary',
    nodeId: 'node_alpha',
    name: 'Primary Bot',
    description: 'Primary',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    systemMd: 'I am primary',
  });
  assert.equal(firstBot.status, 200);
  assert.equal(firstBot.json.id, 'bot_primary');
  assert.equal(firstBot.json.parentBotId, undefined);

  // 2. Creating another primary bot on node_alpha without parentBotId must return 409
  const secondPrimary = await ctx.jsonRequest('/api/bots', 'POST', {
    id: 'bot_second_primary',
    nodeId: 'node_alpha',
    name: 'Second Primary Bot',
    description: 'Should fail',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    systemMd: 'I should be rejected',
  });
  assert.equal(secondPrimary.status, 409);
  assert.match(secondPrimary.json.error, /该节点已有主 BOT，如需新增角色请新建角色分身（Subagent）/);

  // 3. Creating a subagent with parentBotId set succeeds
  const subagent = await ctx.jsonRequest('/api/bots', 'POST', {
    id: 'bot_sub_1',
    nodeId: 'node_alpha',
    parentBotId: 'bot_primary',
    name: 'Subagent 1',
    description: 'Role',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    systemMd: 'I am subagent',
  });
  assert.equal(subagent.status, 200);
  assert.equal(subagent.json.id, 'bot_sub_1');
  assert.equal(subagent.json.parentBotId, 'bot_primary');

  // 4. PUT /api/bots/:botId: changing parentBotId from set to unset on node with primary bot returns 409
  const unnestSubagent = await ctx.jsonRequest('/api/bots/bot_sub_1', 'PUT', {
    parentBotId: undefined,
  });
  // Note: if parentBotId is undefined in JSON, it is omitted, so body.parentBotId is undefined, fallback to existing.
  // But if parentBotId is explicitly set to empty string or null:
  const promoteSubagent = await ctx.jsonRequest('/api/bots/bot_sub_1', 'PUT', {
    parentBotId: '' as any,
  });
  assert.equal(promoteSubagent.status, 409);
  assert.match(promoteSubagent.json.error, /该节点已有主 BOT/);
});

test('Session validation: rejects non-direct mode and validates lead bot', async (t) => {
  const ctx = await createTestContext(t);

  ctx.hub.db.createNode({
    id: 'node_beta',
    name: 'Node Beta',
    platform: 'linux',
    tokenHash: 'hash',
    ownerId: 'user_admin',
  });

  // Save bots
  ctx.hub.db.saveBot({
    id: 'bot_lead',
    nodeId: 'node_beta',
    name: 'Lead',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });
  ctx.hub.db.saveBot({
    id: 'bot_sub',
    nodeId: 'node_beta',
    parentBotId: 'bot_lead',
    name: 'Sub',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  });

  // 1. Creating session with mode 'roundtable' is rejected with 400
  const rtRes = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Roundtable Attempt',
    mode: 'roundtable',
    leadBotId: 'bot_lead',
    memberBotIds: ['bot_lead'],
  });
  assert.equal(rtRes.status, 400);
  assert.equal(rtRes.json.error, 'Invalid session mode');

  // 2. Creating lead mode session is rejected with 400
  const leadRes = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Lead Attempt',
    mode: 'lead',
    leadBotId: 'bot_lead',
    memberBotIds: ['bot_lead'],
  });
  assert.equal(leadRes.status, 400);
  assert.equal(leadRes.json.error, 'Invalid session mode');

  // 3. Creating direct mode session succeeds
  const validDirect = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Valid Direct Session',
    mode: 'direct',
    leadBotId: 'bot_lead',
    memberBotIds: ['bot_lead'],
  });
  assert.equal(validDirect.status, 200);

  // 4. Non-existent bot is rejected
  const invalidBot = await ctx.jsonRequest('/api/sessions', 'POST', {
    title: 'Invalid Bot Session',
    mode: 'direct',
    leadBotId: 'bot_nonexistent',
    memberBotIds: ['bot_nonexistent'],
  });
  assert.equal(invalidBot.status, 400);
  assert.match(invalidBot.json.error, /not found/);
});
