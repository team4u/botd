import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { startHub } from '../apps/hub/src/index.js';

const PASSWORD = 'hub-magpie-catalog-test';

/**
 * Hub 模型目录必须吸收 node CLI 时代的 `.agent/` 遗产：
 * - `.agent/auth.json` 里的凭据（magpie）让 provider 标记 configured
 * - `.agent/models-store.json` 里的动态模型目录（含 thinkingLevelMap）完整暴露
 * - API key 本体绝不外泄
 */
test('model catalog picks up .agent auth.json credentials and models-store.json models', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-magpie-catalog-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const agentDir = path.join(dir, '.agent');
  await mkdir(agentDir, { recursive: true });
  const API_KEY = 'sk-magpie-secret-do-not-leak';
  await writeFile(
    path.join(agentDir, 'auth.json'),
    JSON.stringify({
      magpie: {
        type: 'api_key',
        key: API_KEY,
        env: { MAGPIE_GW_URL: 'https://ap.fjay.fun' },
      },
    }, null, 2)
  );
  await writeFile(
    path.join(agentDir, 'models-store.json'),
    JSON.stringify({
      magpie: {
        checkedAt: 1730000000000,
        models: [
          {
            id: 'zhipu/glm-5.3',
            name: 'GLM-5.3',
            api: 'openai-responses',
            provider: 'magpie',
            baseUrl: 'https://ap.fjay.fun/v1',
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            magpieOwnedBy: 'zhipu',
            thinkingLevelMap: {
              off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: 'max',
            },
          },
          {
            id: 'codex/gpt-6.1-sol',
            name: 'GPT-6.1-Sol',
            api: 'openai-responses',
            provider: 'magpie',
            baseUrl: 'https://ap.fjay.fun/v1',
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            reasoning: true,
            contextWindow: 500_000,
            maxTokens: 128_000,
            magpieOwnedBy: 'codex',
            thinkingLevelMap: {
              off: null, minimal: null, low: null, medium: null,
              high: 'high', xhigh: 'xhigh', max: 'max',
            },
          },
        ],
      },
    }, null, 2)
  );

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
  });
  t.after(async () => {
    hub.server.closeAllConnections();
    await hub.close();
  });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  const response = await fetch(base + '/api/models/catalog', { headers: { cookie } });
  assert(response.ok, `catalog: ${response.status}`);
  const catalog = await response.json() as {
    providers: Array<{
      id: string;
      name: string;
      configured?: boolean;
      credentialType?: string;
      models: Array<{ id: string; thinkingLevels?: string[] }>;
    }>;
  };

  const magpie = catalog.providers.find(p => p.id === 'magpie');
  assert(magpie, 'magpie provider missing from catalog');
  assert.equal(magpie.configured, true, 'magpie must be configured via .agent/auth.json');
  assert.equal(magpie.credentialType, 'api_key');

  const glm = magpie.models.find(m => m.id === 'zhipu/glm-5.3');
  assert(glm, 'zhipu/glm-5.3 missing from magpie models');
  assert.deepEqual(glm.thinkingLevels, ['max']);

  const sol = magpie.models.find(m => m.id === 'codex/gpt-6.1-sol');
  assert(sol, 'codex/gpt-6.1-sol missing from magpie models');
  assert.deepEqual(sol.thinkingLevels, ['high', 'xhigh', 'max']);

  // API key secret must never appear in the catalog payload
  const raw = JSON.stringify(catalog);
  assert.equal(raw.includes(API_KEY), false, 'API key leaked in catalog JSON');
});
