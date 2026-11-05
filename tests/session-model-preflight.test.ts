import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MessageRecord } from '../packages/protocol/src/index.js';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { startHub } from '../apps/hub/src/index.js';

test('production message validation uses session overrides without configuring sibling sessions', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'botd-model-preflight-'));
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    const faux = fauxProvider({ models: [{ id: 'session-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const password = randomUUID();
    hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: path.join(directory, 'hub.sqlite'), adminPassword: password, durableModels: models });
    const base = `http://127.0.0.1:${hub.port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const request = async <T>(route: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await fetch(base + route, {
        method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) assert.fail(`${method} ${route}: ${response.status} ${await response.text()}`);
      return await response.json() as T;
    };
    const owner = hub.db.getUserWithHash('admin')!;
    hub.db.createNode({ id: 'node_preflight', name: 'Preflight node', platform: 'linux', tokenHash: 'x'.repeat(64), ownerId: owner.id });
    hub.db.saveBot({ id: 'preflight_bot', nodeId: 'node_preflight', name: 'Preflight Bot', description: '', modelProvider: '', modelId: '', enabledSkills: [], updatedAt: new Date().toISOString() });
    for (const id of ['sess_preflight_a', 'sess_preflight_b']) {
      hub.db.createSession({ id, title: id, leadBotId: 'preflight_bot', ownerId: owner.id });
    }
    hub.db.saveProviderCredential({ providerId: 'faux', authType: 'api_key', apiKey: randomUUID() });
    await hub.ensureDurableRuntime();
    await request('/api/sessions/sess_preflight_a/model', 'PUT', { override: { provider: 'faux', modelId: 'session-model' } });
    faux.setResponses([fauxAssistantMessage('The session model answered.')]);
    await request('/api/sessions/sess_preflight_a/messages', 'POST', { content: 'Use the session override.' });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const messages = await request<MessageRecord[]>('/api/sessions/sess_preflight_a/messages');
      if (messages.some((message) => message.role === 'assistant' && message.content === 'The session model answered.')) break;
      assert.ok(!messages.some((message) => message.role === 'system' && message.content.includes('尚未配置')), 'the global default must not reject a configured session model');
      if (Date.now() >= deadline) assert.fail('the session model did not answer');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(hub.db.getBot('preflight_bot')!.modelProvider, '');
    assert.equal(hub.db.getBot('preflight_bot')!.modelId, '');
    await request('/api/sessions/sess_preflight_b/messages', 'POST', { content: 'This sibling has no model.' });
    const sibling = await request<MessageRecord[]>('/api/sessions/sess_preflight_b/messages');
    assert.ok(sibling.some((message) => message.role === 'system' && message.content.includes('尚未配置')));
    assert.ok(!sibling.some((message) => message.role === 'assistant'));
    await request('/api/sessions/sess_preflight_a/model', 'PUT', { override: null });
    await request('/api/sessions/sess_preflight_a/messages', 'POST', { content: 'The override was cleared.' });
    const cleared = await request<MessageRecord[]>('/api/sessions/sess_preflight_a/messages');
    assert.ok(cleared.some((message) => message.role === 'system' && message.content.includes('尚未配置')));
  } finally {
    await hub?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
