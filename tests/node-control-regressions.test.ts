import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import test, { describe } from 'node:test';
import { buildProgram } from '../apps/node/src/cli/program.js';

import { readCliConfig, updateCliConfig, writeCliConfig } from '../apps/node/src/cli/config.js';
import { HubClient } from '../apps/node/src/cli/hub-client.js';
import { registerNodeCommands } from '../apps/node/src/cli/commands/node.js';
import { registerArtifactsCommands } from '../apps/node/src/cli/commands/artifacts.js';
import { buildDaemonSpawnSpec, spawnReplacementDaemon } from '../apps/node/src/daemon-launch.js';
import { getDaemonSocketPath, writeNodeIdentity } from '../apps/node/src/storage.js';
import { startHub } from '../apps/hub/src/index.js';
import type { NodeWithBots } from '../packages/protocol/src/index.js';

const Command = buildProgram().constructor as new () => ReturnType<typeof buildProgram>;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeout = 25_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (matches(value)) return value;
    await delay(50);
  }
  throw new Error('Condition timed out');
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(2000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// 1. HubClient & Config Scoping
// ---------------------------------------------------------------------------

describe('HubClient & CLI Config Scoping', () => {
  test('updateCliConfig deletes explicit undefined properties and keeps omitted ones', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-cli-config-test-'));
    try {
      await writeCliConfig(dir, {
        hubUrl: 'http://hub-a.local:8080',
        token: 'tok-a',
        username: 'alice',
        password: 'secret-password',
      });

      // Explicit undefined for password should delete password; omitted username should be preserved
      const updated = await updateCliConfig(dir, {
        hubUrl: 'http://hub-b.local:8080',
        token: 'tok-b',
        password: undefined,
      });

      assert.equal(updated.hubUrl, 'http://hub-b.local:8080');
      assert.equal(updated.token, 'tok-b');
      assert.equal(updated.username, 'alice');
      assert.equal(updated.password, undefined);

      const disk = await readCliConfig(dir);
      assert.equal(disk.hubUrl, 'http://hub-b.local:8080');
      assert.equal(disk.token, 'tok-b');
      assert.equal(disk.username, 'alice');
      assert.equal(disk.password, undefined);

      // Omitting password in next update preserves undefined
      await updateCliConfig(dir, { token: 'tok-c' });
      const disk2 = await readCliConfig(dir);
      assert.equal(disk2.token, 'tok-c');
      assert.equal(disk2.username, 'alice');
      assert.equal(disk2.password, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('HubClient.connect never leaks credentials to a different Hub via --hub', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-hub-client-test-'));
    const originalFetch = globalThis.fetch;
    const interceptedCalls: { url: string; body: unknown }[] = [];

    try {
      // Save credentials for Hub A
      await writeCliConfig(dir, {
        hubUrl: 'http://hub-a.local:8080/',
        username: 'user-a',
        password: 'password-a',
        token: 'token-a',
      });

      // Mock fetch: intercept any calls, verify no credentials sent to Hub B
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        let parsedBody: unknown = null;
        if (init?.body && typeof init.body === 'string') {
          try {
            parsedBody = JSON.parse(init.body);
          } catch {}
        }
        interceptedCalls.push({ url: urlStr, body: parsedBody });
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      // Connect to Hub B without passing password flag
      await assert.rejects(
        async () => {
          await HubClient.connect({
            dataDir: dir,
            hubUrl: 'http://hub-b.local:9090',
          });
        },
        (err: any) => {
          assert.equal(err.status, 401);
          assert.match(err.message, /Not logged in to http:\/\/hub-b\.local:9090/);
          return true;
        },
      );

      // Verify that Hub A's password or token was NEVER sent to Hub B
      assert.equal(interceptedCalls.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('automatic login preserves credentials previously saved for the same Hub', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-cli-saved-login-'));
    const originalFetch = globalThis.fetch;
    try {
      await writeCliConfig(dir, { hubUrl: 'https://saved-hub.invalid/', username: 'saved-user', password: 'saved-test-password' });
      globalThis.fetch = async () => new Response('{}', {
        headers: { 'set-cookie': 'botd_token=saved-test-token; HttpOnly' },
      });
      await HubClient.connect({ dataDir: dir, hubUrl: 'https://saved-hub.invalid' });
      const saved = await readCliConfig(dir);
      assert.equal(saved.password, 'saved-test-password');
      assert.equal(saved.token, 'saved-test-token');
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('HubClient.connect accepts explicit credentials for a new Hub', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-hub-client-test-'));
    const originalFetch = globalThis.fetch;
    const loginRequests: { url: string; body: any }[] = [];

    try {
      await writeCliConfig(dir, {
        hubUrl: 'http://hub-a.local:8080',
        username: 'user-a',
        password: 'password-a',
      });

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        if (urlStr.endsWith('/api/auth/login')) {
          loginRequests.push({ url: urlStr, body: JSON.parse(init?.body as string) });
          const headers = new Headers();
          headers.append('set-cookie', 'botd_token=tok-b-new; Path=/');
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers,
          });
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }) as typeof fetch;

      const client = await HubClient.connect({
        dataDir: dir,
        hubUrl: 'http://hub-b.local:9090',
        username: 'explicit-user',
        password: 'explicit-password',
      });

      assert.equal(client.url, 'http://hub-b.local:9090');
      assert.equal(loginRequests.length, 1);
      assert.equal(loginRequests[0].url, 'http://hub-b.local:9090/api/auth/login');
      assert.equal(loginRequests[0].body.username, 'explicit-user');
      assert.equal(loginRequests[0].body.password, 'explicit-password');
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('HubClient.connect node.json fallback only allows matching Hub', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-hub-client-test-'));
    try {
      // Write node.json paired to Hub A
      await writeNodeIdentity(dir, {
        nodeId: 'node-1',
        token: 'node-token-a',
        hubUrl: 'http://hub-a.local:8080/',
        name: 'test-node',
      });

      // Asking for Hub B without password must NOT fall back to node.json for Hub A
      await assert.rejects(
        async () => {
          await HubClient.connect({
            dataDir: dir,
            hubUrl: 'http://hub-b.local:9090',
          });
        },
        (err: any) => {
          assert.equal(err.status, 401);
          assert.match(err.message, /Not logged in to http:\/\/hub-b\.local:9090/);
          return true;
        },
      );

      // Connecting to Hub A (with trailing slash difference normalized) succeeds via node.json
      const client = await HubClient.connect({
        dataDir: dir,
        hubUrl: 'http://hub-a.local:8080',
      });
      assert.equal(client.url, 'http://hub-a.local:8080');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Commander --no-turn Option Resolution
// ---------------------------------------------------------------------------

describe('CLI --no-turn Option Resolution', () => {
  test('wake --no-turn sends noTurn: true in socket payload', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-no-turn-wake-'));
    const socketPath = getDaemonSocketPath(dir);
    let receivedPayload: any = null;

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        receivedPayload = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, scheduledTriggerId: 'trig-1' }));
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      const program = new Command();
      program.option('--data-dir <path>', 'Data dir');
      program.option('--json', 'JSON output');
      registerNodeCommands(program);

      await program.parseAsync([
        'node',
        'cli',
        'wake',
        '--data-dir',
        dir,
        '--session',
        'sess-123',
        '--bot',
        'bot-abc',
        '--message',
        'wake up now',
        '--no-turn',
      ]);

      assert.notEqual(receivedPayload, null);
      assert.equal(receivedPayload.sessionId, 'sess-123');
      assert.equal(receivedPayload.botId, 'bot-abc');
      assert.equal(receivedPayload.message, 'wake up now');
      assert.equal(receivedPayload.noTurn, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('wake without --no-turn does not send noTurn: true', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-turn-wake-'));
    const socketPath = getDaemonSocketPath(dir);
    let receivedPayload: any = null;

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        receivedPayload = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      const program = new Command();
      program.option('--data-dir <path>', 'Data dir');
      program.option('--json', 'JSON output');
      registerNodeCommands(program);

      await program.parseAsync([
        'node',
        'cli',
        'wake',
        '--data-dir',
        dir,
        '--session',
        'sess-123',
        '--bot',
        'bot-abc',
        '--message',
        'normal turn',
      ]);

      assert.notEqual(receivedPayload, null);
      assert.equal(receivedPayload.noTurn, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Artifact List Response Contract
// ---------------------------------------------------------------------------

describe('Artifact List Response Contract', () => {
  test('parses { ok: true, artifacts } and displays rows for non-empty list', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-art-list-'));
    const socketPath = getDaemonSocketPath(dir);

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        artifacts: [
          {
            id: 'art-001',
            sessionId: 'sess-1',
            botId: 'bot-1',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            storagePath: '/data/report.pdf',
            createdAt: '2025-01-01T12:00:00Z',
          },
        ],
      }));
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    try {
      const program = new Command();
      program.option('--data-dir <path>', 'Data dir');
      program.option('--json', 'JSON output');
      registerArtifactsCommands(program);

      await program.parseAsync([
        'node',
        'cli',
        'artifact',
        'list',
        '--data-dir',
        dir,
        '--session',
        'sess-1',
      ]);

      assert.equal(logs.length, 1);
      assert.match(logs[0], /art-001/);
      assert.match(logs[0], /report\.pdf/);
      assert.match(logs[0], /1024B/);
    } finally {
      console.log = originalLog;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('parses { ok: true, artifacts: [] } and displays (no artifacts)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-art-empty-'));
    const socketPath = getDaemonSocketPath(dir);

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, artifacts: [] }));
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    try {
      const program = new Command();
      program.option('--data-dir <path>', 'Data dir');
      program.option('--json', 'JSON output');
      registerArtifactsCommands(program);

      await program.parseAsync([
        'node',
        'cli',
        'artifact',
        'list',
        '--data-dir',
        dir,
        '--session',
        'sess-1',
      ]);

      assert.equal(logs.length, 1);
      assert.equal(logs[0], '(no artifacts)');
    } finally {
      console.log = originalLog;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('artifact list --json outputs raw artifacts array for empty and non-empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-art-json-'));
    const socketPath = getDaemonSocketPath(dir);

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        artifacts: [
          {
            id: 'art-002',
            sessionId: 'sess-1',
            botId: 'bot-1',
            filename: 'data.json',
            mimeType: 'application/json',
            sizeBytes: 42,
            storagePath: '/data/data.json',
            createdAt: '2025-01-01T12:00:00Z',
          },
        ],
      }));
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    try {
      const program = new Command();
      program.option('--data-dir <path>', 'Data dir');
      program.option('--json', 'JSON output');
      registerArtifactsCommands(program);

      await program.parseAsync([
        'node',
        'cli',
        'artifact',
        'list',
        '--data-dir',
        dir,
        '--session',
        'sess-1',
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const parsed = JSON.parse(logs[0]);
      assert(Array.isArray(parsed));
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'art-002');
    } finally {
      console.log = originalLog;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Daemon Launch & Remote Restart
// ---------------------------------------------------------------------------

describe('Daemon Launch & Remote Restart', () => {
  test('daemon invocation uses the resolved data directory and source loader', () => {
    const spec = buildDaemonSpawnSpec({ dataDir: '/var/lib/botd-test' });
    assert.equal(spec.execPath, process.execPath);
    assert(spec.args.some((arg) => arg.includes('tsx')));
    assert.deepEqual(spec.args.slice(-3), ['start', '--data-dir', '/var/lib/botd-test']);
    assert(!spec.args.includes('restart'));
    assert(!spec.args.includes('--detach'));
  });

  test('spawnReplacementDaemon handles IPC ready signal and rejects on failure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-spawn-ipc-'));
    try {
      // 1. Success case: child sends botd:daemon-ready
      const successScript = `
        if (typeof process.send === 'function') {
          process.send({ type: 'botd:daemon-ready', pid: process.pid });
        }
        setTimeout(() => {}, 2000);
      `;
      const successPid = await spawnReplacementDaemon({
        dataDir: dir,
        timeoutMs: 5000,
        spawnFn: ((_cmd: string, _args: string[], opts: any) =>
          spawn(process.execPath, ['-e', successScript], opts)) as any,
      });

      assert(typeof successPid === 'number' && successPid > 0);
      try { process.kill(successPid, 'SIGKILL'); } catch {}

      // 2. Failure case: child exits immediately with code 1 before sending ready
      await assert.rejects(
        async () => {
          await spawnReplacementDaemon({
            dataDir: dir,
            timeoutMs: 5000,
            spawnFn: ((_cmd: string, _args: string[], opts: any) =>
              spawn(process.execPath, ['-e', 'process.exit(1);'], opts)) as any,
          });
        },
        /Replacement daemon exited prematurely with code 1/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('full remote restart lifecycle via Hub RPC (port 0)', { timeout: 60_000 }, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botd-restart-test-'));
    const dataDir = path.join(dir, 'node');
    const dbPath = path.join(dir, 'hub.sqlite');

    // Never port 3000: start Hub on port 0
    const hub = await startHub({
      host: '127.0.0.1',
      port: 0,
      dbPath,
      adminPassword: 'restart-test-pass',
    });

    const address = hub.server.address();
    assert(address && typeof address !== 'string');
    const hubUrl = `http://127.0.0.1:${address.port}`;

    const env = {
      ...process.env,
      BOTD_DATA_DIR: dataDir,
      BOTD_DAEMON_BIND_RETRY_MS: '20000',
    };

    const processes: ChildProcess[] = [];
    t.after(async () => {
      for (const child of processes) await stopChild(child);
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    });

    // 1. Login to Hub
    const loginRes = await fetch(`${hubUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'restart-test-pass' }),
    });
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0];
    const api = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await fetch(hubUrl + route, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
      return value as T;
    };

    // 2. Pair node
    const pairing = await api('/api/nodes/pairing', 'POST');
    const cliPath = path.resolve('apps/node/src/cli.ts');
    const joinChild = spawn(
      process.execPath,
      ['--import', 'tsx', cliPath, 'join', hubUrl, '--code', pairing.code, '--name', 'Restart Node'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    processes.push(joinChild);
    const joinExit = await new Promise<number | null>((resolve) => joinChild.on('exit', resolve));
    assert.equal(joinExit, 0);

    // 3. Start first daemon via CLI
    const daemon1 = spawn(
      process.execPath,
      ['--import', 'tsx', cliPath, 'start'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    processes.push(daemon1);

    // Wait for node to come online
    const nodes = await waitFor(
      () => api<NodeWithBots[]>('/api/nodes'),
      (list) => list.length > 0 && list[0]?.status === 'online',
    );
    const node = nodes[0];
    assert.equal(node.name, 'Restart Node');
    const originalPid = daemon1.pid;
    assert(typeof originalPid === 'number');

    // 4. Trigger remote restart via Hub API -> Node RPC
    const restartResult = await api<{ ok: boolean; pid: number }>(`/api/nodes/${node.id}/restart`, 'POST');
    assert.equal(restartResult.ok, true);
    assert(typeof restartResult.pid === 'number');
    assert.notEqual(restartResult.pid, originalPid);

    // Track the replacement child process for cleanup
    try {
      const replacementChild = { pid: restartResult.pid } as ChildProcess;
      processes.push(replacementChild);
    } catch {}

    // Wait for the replacement daemon to be online and serving on Hub
    await waitFor(
      () => api<NodeWithBots[]>('/api/nodes'),
      (list) => list.length > 0 && list[0]?.status === 'online',
    );

    // Verify replacement socket is alive
    const socketPath = getDaemonSocketPath(dataDir);
    const isSocketAlive = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(socketPath);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); resolve(false); });
    });
    assert.equal(isSocketAlive, true);

    // Kill replacement daemon
    try {
      process.kill(restartResult.pid, 'SIGTERM');
    } catch {}
  });
});
