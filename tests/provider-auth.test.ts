import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Provider, ProviderAuthInteraction } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { ProviderAuthManager } from '../apps/node/src/provider-auth.js';
import { configureProviderAuth, createIsolatedModelRuntime, getNodeModelCatalog } from '../apps/node/src/models.js';

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Provider login state timed out');
}

async function fixture(t: TestContext, options: { ttlMs?: number; oauth?: (interaction: ProviderAuthInteraction) => Promise<any>; rejectKey?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-provider-auth-'));
  const base = builtinProviders()[0];
  let refreshes = 0;
  const fake: Provider = {
    id: 'auth-test', name: 'Local auth test', getModels: () => [],
    stream: base.stream, streamSimple: base.streamSimple,
    auth: {
      apiKey: {
        name: 'Test API key',
        login: async interaction => {
          const region = await interaction.prompt({ type: 'select', message: 'Region', options: [{ id: 'local', label: 'Local' }] });
          const account = await interaction.prompt({ type: 'text', message: 'Account' });
          const key = await interaction.prompt({ type: 'secret', message: 'API Key' });
          if (options.rejectKey) throw new Error(`Rejected credential ${key}`);
          return { type: 'api_key', key, env: { TEST_REGION: region, TEST_ACCOUNT: account } };
        },
        resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, env: credential.env, source: 'SDK stored credential' } : undefined,
      },
      oauth: {
        name: 'Test OAuth', isSubscription: true,
        login: options.oauth ?? (async interaction => {
          interaction.notify({ type: 'auth_url', url: 'https://example.com/authorize', instructions: 'Sign in' });
          interaction.notify({ type: 'device_code', userCode: 'ABCD', verificationUri: 'https://example.com/device' });
          await interaction.prompt({ type: 'manual_code', message: 'Paste redirect URL or code' });
          return { type: 'oauth', access: 'local-access', refresh: 'local-refresh', expires: Date.now() + 3_600_000 };
        }),
        refresh: async credential => { refreshes++; return { ...credential, access: 'refreshed-local-access', expires: Date.now() + 3_600_000 }; },
        toAuth: async credential => ({ apiKey: credential.access }),
      },
    },
  };
  const createRuntime = async () => {
    const runtime = await createIsolatedModelRuntime(dir);
    runtime.registerNativeProvider(fake);
    return runtime;
  };
  const manager = new ProviderAuthManager(dir, { createRuntime, ttlMs: options.ttlMs });
  t.after(async () => { await manager.close(); await rm(dir, { force: true, recursive: true }); });
  return { dir, manager, createRuntime, refreshes: () => refreshes };
}

test('native Pi API-key login preserves SDK extra fields without exposing the key through RPC state', async t => {
  const f = await fixture(t);
  const login = await f.manager.start({ providerId: 'auth-test', method: 'api_key' });
  const selection = await waitFor(() => f.manager.get(login.id), state => state.prompt?.type === 'select');
  await assert.rejects(f.manager.respond({ loginId: login.id, promptId: selection.prompt!.id, value: 'invalid' }), /selection/);
  await assert.rejects(f.manager.respond({ loginId: login.id, promptId: 'stale_prompt', value: 'local' }), /no longer active/);
  await f.manager.respond({ loginId: login.id, promptId: selection.prompt!.id, value: 'local' });
  const text = await waitFor(() => f.manager.get(login.id), state => state.prompt?.type === 'text');
  await f.manager.respond({ loginId: login.id, promptId: text.prompt!.id, value: 'account-123' });
  const secret = await waitFor(() => f.manager.get(login.id), state => state.prompt?.type === 'secret');
  await f.manager.respond({ loginId: login.id, promptId: secret.prompt!.id, value: 'private-local-test-key' });
  const completed = await waitFor(() => f.manager.get(login.id), state => state.status === 'success');
  assert.equal(JSON.stringify(completed).includes('private-local-test-key'), false);
  assert.equal(completed.prompt, undefined);
  const stored = JSON.parse(await readFile(path.join(f.dir, '.agent/auth.json'), 'utf8'));
  assert.equal(stored['auth-test'].type, 'api_key');
  assert.equal(stored['auth-test'].env.TEST_ACCOUNT, 'account-123');
  if (process.platform !== 'win32') assert.equal((await stat(path.join(f.dir, '.agent/auth.json'))).mode & 0o777, 0o600);
  const runtime = await f.createRuntime();
  await configureProviderAuth(runtime, f.dir, 'auth-test');
  assert.equal((await runtime.getAuth('auth-test'))!.auth.apiKey, 'private-local-test-key');
  await f.manager.logout('auth-test');
  const loggedOut = await f.createRuntime();
  assert.equal((await loggedOut.listCredentials()).some(item => item.providerId === 'auth-test'), false);
  await assert.rejects(configureProviderAuth(loggedOut, f.dir, 'auth-test'), /not configured/);
});

test('native SDK OAuth persists credentials and reuses its token refresh', async t => {
  const f = await fixture(t);
  const login = await f.manager.start({ providerId: 'auth-test', method: 'oauth' });
  const state = await waitFor(() => f.manager.get(login.id), state => state.prompt?.type === 'manual_code');
  assert(state.events.some(event => event.type === 'auth_url'));
  assert(state.events.some(event => event.type === 'device_code'));
  await f.manager.respond({ loginId: login.id, promptId: state.prompt!.id, value: 'private-authorization-code' });
  const success = await waitFor(() => f.manager.get(login.id), state => state.status === 'success');
  assert.equal(JSON.stringify(success).includes('private-authorization-code'), false);
  const runtime = await f.createRuntime();
  await configureProviderAuth(runtime, f.dir, 'auth-test');
  assert.equal((await runtime.getAuth('auth-test'))!.auth.apiKey, 'local-access');
  const storePath = path.join(f.dir, '.agent/auth.json');
  const stored = JSON.parse(await readFile(storePath, 'utf8'));
  // Force an expiring token through the SDK's cross-runtime refresh implementation.
  stored['auth-test'].expires = Date.now() - 1;
  const fs = await import('node:fs/promises');
  await fs.writeFile(storePath, JSON.stringify(stored), { mode: 0o600 });
  const refreshed = await f.createRuntime();
  assert.equal((await refreshed.getAuth('auth-test'))!.auth.apiKey, 'refreshed-local-access');
  assert.equal(f.refreshes(), 1);
  assert.equal((await f.manager.get(login.id)).status, 'success');
});

test('OAuth callback can abort its manual prompt without cancelling a successful login', async t => {
  let completeCallback!: () => void;
  const callback = new Promise<void>(resolve => { completeCallback = resolve; });
  const f = await fixture(t, { oauth: async interaction => {
    const promptController = new AbortController();
    const manual = interaction.prompt({ type: 'manual_code', message: 'Manual fallback', signal: promptController.signal }).catch(error => {
      assert.equal(error.name, 'AbortError');
    });
    await callback;
    promptController.abort();
    await manual;
    return { type: 'oauth', access: 'callback-access', refresh: 'callback-refresh', expires: Date.now() + 3_600_000 };
  } });
  const login = await f.manager.start({ providerId: 'auth-test', method: 'oauth' });
  const prompt = await waitFor(() => f.manager.get(login.id), state => Boolean(state.prompt));
  completeCallback();
  const success = await waitFor(() => f.manager.get(login.id), state => state.status === 'success');
  assert.equal(success.prompt, undefined);
  await assert.rejects(f.manager.respond({ loginId: login.id, promptId: prompt.prompt!.id, value: 'too late' }), /no longer active/);
});

test('provider login supports cancellation, duplicate rejection, expiry and secret-redacted failures', async t => {
  const f = await fixture(t, { ttlMs: 1000, rejectKey: true });
  await assert.rejects(f.manager.start({ providerId: 'unknown', method: 'oauth' }), /Unknown provider/);
  const login = await f.manager.start({ providerId: 'auth-test', method: 'oauth' });
  await waitFor(() => f.manager.get(login.id), state => Boolean(state.prompt));
  await assert.rejects(f.manager.start({ providerId: 'auth-test', method: 'oauth' }), /already pending/);
  await f.manager.cancel(login.id);
  assert.equal((await f.manager.get(login.id)).status, 'cancelled');
  const expires = await f.manager.start({ providerId: 'auth-test', method: 'oauth' });
  const expired = await waitFor(() => f.manager.get(expires.id), state => state.status === 'error');
  assert.match(expired.error!, /expired/);
  const failure = await f.manager.start({ providerId: 'auth-test', method: 'api_key' });
  for (const value of ['local', 'account', 'secret-that-must-not-leak']) {
    const state = await waitFor(() => f.manager.get(failure.id), state => Boolean(state.prompt));
    await f.manager.respond({ loginId: failure.id, promptId: state.prompt!.id, value });
  }
  const failed = await waitFor(() => f.manager.get(failure.id), state => state.status === 'error');
  assert.equal(JSON.stringify(failed).includes('secret-that-must-not-leak'), false);
  assert.match(failed.error!, /redacted/);
});

test('node catalog includes isolated custom models and only non-secret auth metadata', async t => {
  const f = await fixture(t);
  const fs = await import('node:fs/promises');
  await f.createRuntime();
  await fs.writeFile(path.join(f.dir, '.agent/models.json'), JSON.stringify({ providers: { 'private-local': { baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', apiKey: 'catalog-secret', headers: { 'x-private': 'private-header' }, models: [{ id: 'my-local-model' }] } } }));
  // Credentials live in the node-local Pi SDK credential store; the Hub never stores keys
  await fs.writeFile(path.join(f.dir, '.agent/auth.json'), JSON.stringify({ mistral: { type: 'api_key', key: 'node-local-secret-key' } }), 'utf8');
  const catalog = await getNodeModelCatalog(f.dir);
  const mistralProvider = catalog.providers.find(provider => provider.id === 'mistral')!;
  assert.equal(mistralProvider.configured, true);
  assert.equal(mistralProvider.credentialType, 'api_key', 'A node SDK login must be presented as configured');
  assert.equal(JSON.stringify(catalog).includes('node-local-secret-key'), false, 'Stored keys must never leak through the catalog');
  const local = catalog.providers.find(provider => provider.id === 'private-local');
  assert(local?.models.some(model => model.id === 'my-local-model'));
  assert.equal(JSON.stringify(catalog).includes('catalog-secret'), false);
  assert.equal(JSON.stringify(catalog).includes('private-header'), false);
  assert.equal(JSON.stringify(catalog).includes('127.0.0.1:9999'), false);
});
