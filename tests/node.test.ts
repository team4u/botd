import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startHub } from '../apps/hub/src/index.js';
import { resetBotSession } from '../apps/node/src/runtime.js';
import type { NodeWithBots, SessionRecord } from '../packages/protocol/src/index.js';

const cli = path.resolve('apps/node/src/cli.ts');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (matches(value)) return value; await delay(40); }
  throw new Error('Node integration state timed out');
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
function command(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
  return { child, done, output: () => output };
}

test('resetBotSession deletes the session file and is idempotent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-reset-test-'));
  try {
    const dataDir = path.join(dir, 'data');
    const botId = 'bot-alpha';
    const sessionId = 'sess-1';
    const sessionDir = path.join(dataDir, 'bots', botId, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
    const original = '{"role":"user","content":"hello"}\n';
    await writeFile(sessionFile, original, 'utf8');

    await resetBotSession(dataDir, sessionId, botId);

    assert.equal(existsSync(sessionFile), false);
    const entries = await readdir(sessionDir);
    assert.equal(entries.length, 0, `session dir must be empty after reset, got: ${entries.join(', ')}`);

    // Idempotent: resetting again without a session file must not throw and
    // must not leave anything behind.
    await resetBotSession(dataDir, sessionId, botId);
    assert.equal((await readdir(sessionDir)).length, 0);

    // Note: the "pendingRuns occupied" guard is not asserted here because
    // pendingRuns is module-private and only populated during a live turn,
    // which requires a full model/catalog fixture.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real botd join/start/wake, file management and missing-key failure', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-node-test-'));
  const dataDir = path.join(dir, 'node');
  const hub = await startHub({ host: '127.0.0.1', port: 0, dbPath: path.join(dir, 'hub.sqlite'), adminPassword: 'node-integration' });
  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|AUTH_TOKEN|BOTD_(DATA_DIR|SESSION_ID|BOT_ID)/.test(key))) as NodeJS.ProcessEnv;
  env.BOTD_DATA_DIR = dataDir;
  const processes: ChildProcess[] = [];
  t.after(async () => {
    for (const child of processes) await stop(child);
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'node-integration' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const api = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
    return value as T;
  };
  const pairing = await api('/api/nodes/pairing', 'POST');
  const join = command(['join', base, '--code', pairing.code, '--name', 'Integration node'], env);
  processes.push(join.child);
  const joined = await join.done;
  assert.equal(joined.code, 0, joined.output);
  const identity = JSON.parse(await readFile(path.join(dataDir, 'node.json'), 'utf8'));
  assert.equal(identity.hubUrl, base);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(dataDir, 'node.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  }
  const daemon = command(['start'], env);
  processes.push(daemon.child);
  const nodes = await waitFor(() => api<NodeWithBots[]>('/api/nodes'), nodes => nodes[0]?.status === 'online' && nodes[0].bots.length > 0);
  const bot = nodes[0].bots[0];
  assert.equal(bot.nodeId, identity.nodeId);
  // PartySocket must create a usable new RPC peer after the underlying socket is lost.
  for (const socket of hub.connections.wss.clients) socket.terminate();
  await waitFor(() => api<NodeWithBots[]>('/api/nodes'), nodes => nodes[0]?.status === 'offline');
  await waitFor(() => api<NodeWithBots[]>('/api/nodes'), nodes => nodes[0]?.status === 'online');
  const catalog = await api(`/api/models/catalog?nodeId=${identity.nodeId}`);
  assert(catalog.providers.some((provider: any) => provider.id === 'mistral' && provider.models.length > 0));
  const nativeLogin = await api(`/api/nodes/${identity.nodeId}/providers/mistral/login`, 'POST', { method: 'api_key' });
  const nativePrompt = await waitFor(() => api<any>(`/api/nodes/${identity.nodeId}/provider-logins/${nativeLogin.id}`), state => Boolean(state.prompt));
  assert.equal(nativePrompt.prompt.type, 'secret');
  await api(`/api/nodes/${identity.nodeId}/provider-logins/${nativeLogin.id}`, 'DELETE');
  assert.equal((await api(`/api/nodes/${identity.nodeId}/provider-logins/${nativeLogin.id}`)).status, 'cancelled');
  await api(`/api/bots/${bot.id}/memory`, 'PUT', { content: 'Persistent integration memory.' });
  assert.equal(await readFile(path.join(dataDir, 'bots', bot.id, 'MEMORY.md'), 'utf8'), 'Persistent integration memory.');
  await api(`/api/nodes/${identity.nodeId}/skills/integration`, 'PUT', { content: '# Integration Skill\nUse local CLI help.' });
  assert.match(await readFile(path.join(dataDir, 'skills/integration/SKILL.md'), 'utf8'), /Integration Skill/);

  // 1. Online extension CRUD via Hub API -> Node RPC
  await api(`/api/nodes/${identity.nodeId}/extensions/web-guard`, 'PUT', { content: 'export default function (pi) {}' });
  assert.equal(await readFile(path.join(dataDir, 'extensions/web-guard/index.ts'), 'utf8'), 'export default function (pi) {}');
  assert.equal((await api(`/api/nodes/${identity.nodeId}/extensions/web-guard`)).content, 'export default function (pi) {}');
  assert((await api<NodeWithBots[]>('/api/nodes'))[0].extensions.includes('web-guard'));

  // 2. botd install CLI with local .ts file and live daemon /reload notification
  await writeFile(path.join(dir, 'my-guard.ts'), 'export default function (pi) {}', 'utf8');
  const installCli = command(['install', path.join(dir, 'my-guard.ts'), '--id', 'bash-guard'], env);
  processes.push(installCli.child);
  assert.equal((await installCli.done).code, 0);
  assert(existsSync(path.join(dataDir, 'extensions/bash-guard/index.ts')));
  await waitFor(() => api<NodeWithBots[]>('/api/nodes'), nodes => nodes[0].extensions.includes('bash-guard'));

  // 3. POST /api/nodes/:nodeId/install with a local Git repository
  const gitSkillDir = path.join(dir, 'sample-git-skill');
  await mkdir(gitSkillDir, { recursive: true });
  await writeFile(path.join(gitSkillDir, 'SKILL.md'), '# Sample Git Skill\nTest skill.', 'utf8');
  execFileSync('git', ['init'], { cwd: gitSkillDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitSkillDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitSkillDir });
  execFileSync('git', ['add', '.'], { cwd: gitSkillDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: gitSkillDir });

  const installed = await api(`/api/nodes/${identity.nodeId}/install`, 'POST', {
    source: `file://${path.join(dir, 'sample-git-skill')}`,
    kind: 'auto',
    customId: 'git-skill',
  });
  assert.equal(installed.kind, 'skill');
  assert.equal(installed.id, 'git-skill');
  assert(existsSync(path.join(dataDir, 'skills/git-skill/SKILL.md')));
  assert(!existsSync(path.join(dataDir, 'skills/git-skill/.git')));

  // 4. Delete extension via DELETE /api/nodes/:nodeId/extensions/web-guard
  await api(`/api/nodes/${identity.nodeId}/extensions/web-guard`, 'DELETE');
  assert(!(await api<NodeWithBots[]>('/api/nodes'))[0].extensions.includes('web-guard'));
  const session = await api<SessionRecord>('/api/sessions', 'POST', { title: 'Real node session', mode: 'direct', leadBotId: bot.id, memberBotIds: [bot.id] });
  const wake = command(['wake', '--session', session.id, '--bot', bot.id, '--message', 'The background job finished.'], env);
  processes.push(wake.child);
  const woke = await wake.done;
  assert.equal(woke.code, 0, woke.output + daemon.output());
  const messages = await waitFor(() => api<any[]>(`/api/sessions/${session.id}/messages`), messages => messages.some(message => message.role === 'callback'));
  assert.match(messages.find(message => message.role === 'callback').content, /background job finished/);
  await waitFor(() => api<SessionRecord[]>('/api/sessions'), sessions => sessions.find(s => s.id === session.id)?.status === 'failed');
  const history = await api<any[]>(`/api/sessions/${session.id}/messages`);
  assert.equal(history.filter(message => message.role === 'assistant').length, 0);
  assert(history.some(message => message.role === 'system'));
  // A second daemon must not take over the first daemon's local wake socket.
  const duplicate = command(['start'], env);
  processes.push(duplicate.child);
  const duplicateResult = await Promise.race([duplicate.done, delay(8_000).then(() => ({ code: null, output: 'Second daemon did not reject the live socket' }))]);
  assert.notEqual(duplicateResult.code, 0, duplicateResult.output);
  assert.notEqual(duplicateResult.code, null, duplicateResult.output);
  const wakeViaEnv = command(['wake', '--message', 'Environment fallback works'], { ...env, BOTD_SESSION_ID: session.id, BOTD_BOT_ID: bot.id });
  processes.push(wakeViaEnv.child);
  assert.equal((await wakeViaEnv.done).code, 0);
});
