import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import test, { describe, beforeEach, afterEach } from 'node:test';
import {
  getNodeVersion,
  compareSemver,
  checkNodeUpgrade,
  stageReleaseFromNpm,
  performNodeUpgrade,
  readCurrentRelease,
  writeCurrentRelease,
  readPreviousRelease,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
} from '../apps/node/src/upgrader.js';
import {
  generateServiceDescriptor,
  installNodeService,
  uninstallNodeService,
  getNodeServiceStatus,
} from '../apps/node/src/service.js';
import { buildDaemonSpawnSpec } from '../apps/node/src/daemon-launch.js';
import { createLocalIpcServer } from '../apps/node/src/local-ipc.js';
import { getDaemonSocketPath } from '../apps/node/src/storage.js';
import { buildProgram } from '../apps/node/src/cli/program.js';
import { registerNodeCommands } from '../apps/node/src/cli/commands/node.js';
import { registerNodesCommands } from '../apps/node/src/cli/commands/nodes.js';

const Command = buildProgram().constructor as new () => ReturnType<typeof buildProgram>;

// ---------------------------------------------------------------------------
// 1. Version Detection & Semver Comparison
// ---------------------------------------------------------------------------

describe('Version Detection & Semver Utilities', () => {
  const originalEnvVersion = process.env.BOTD_VERSION_OVERRIDE;

  afterEach(() => {
    if (originalEnvVersion !== undefined) {
      process.env.BOTD_VERSION_OVERRIDE = originalEnvVersion;
    } else {
      delete process.env.BOTD_VERSION_OVERRIDE;
    }
  });

  test('getNodeVersion returns BOTD_VERSION_OVERRIDE when set', () => {
    process.env.BOTD_VERSION_OVERRIDE = '1.2.3-custom';
    assert.equal(getNodeVersion(), '1.2.3-custom');
  });

  test('getNodeVersion falls back to package.json version', () => {
    delete process.env.BOTD_VERSION_OVERRIDE;
    const ver = getNodeVersion();
    assert.match(ver, /^[0-9]+\.[0-9]+\.[0-9]+/);
  });

  test('compareSemver correctly compares versions', () => {
    assert.equal(compareSemver('0.2.0', '0.1.0'), 1);
    assert.equal(compareSemver('0.1.0', '0.2.0'), -1);
    assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
    assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
    assert.equal(compareSemver('1.10.0', '1.2.0'), 1);
    assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
    assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
    assert.equal(compareSemver('1.0.0', '1.0.0-beta'), 1);
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
  });
});

// ---------------------------------------------------------------------------
// 2. Check Node Upgrade
// ---------------------------------------------------------------------------

describe('checkNodeUpgrade', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'botd-check-upgrade-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('detects update available when registry has newer version', async () => {
    const mockFetch: typeof fetch = async (input) => {
      assert.match(String(input), /\/botd\/latest$/);
      return new Response(JSON.stringify({ version: '0.5.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await checkNodeUpgrade(tempDir, {
      currentVersion: '0.1.0',
      fetchFn: mockFetch,
    });

    assert.equal(result.currentVersion, '0.1.0');
    assert.equal(result.latestVersion, '0.5.0');
    assert.equal(result.updateAvailable, true);
    assert.equal(result.blocked, undefined);
  });

  test('detects no update when current version is equal or newer', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ version: '0.1.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await checkNodeUpgrade(tempDir, {
      currentVersion: '0.1.0',
      fetchFn: mockFetch,
    });

    assert.equal(result.updateAvailable, false);
  });

  test('includes blocked record when update-blocked.json exists', async () => {
    await writeBlockedRelease(tempDir, {
      version: '0.5.0',
      reason: 'Canary startup failed',
      at: '2025-01-01T00:00:00Z',
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ version: '0.5.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await checkNodeUpgrade(tempDir, {
      currentVersion: '0.1.0',
      fetchFn: mockFetch,
    });

    assert.equal(result.updateAvailable, true);
    assert.notEqual(result.blocked, undefined);
    assert.equal(result.blocked?.version, '0.5.0');
    assert.equal(result.blocked?.reason, 'Canary startup failed');
  });

  test('rejects when registry returns non-200 error', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    };

    await assert.rejects(
      async () => {
        await checkNodeUpgrade(tempDir, {
          fetchFn: mockFetch,
        });
      },
      /Registry responded with HTTP 404/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Stage Release from NPM
// ---------------------------------------------------------------------------

describe('stageReleaseFromNpm', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'botd-stage-release-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('rejects invalid target version format to prevent traversal', async () => {
    await assert.rejects(
      async () => {
        await stageReleaseFromNpm(tempDir, '../evil/version');
      },
      /Invalid target version format/,
    );
  });

  test('stages release using custom stageExtractor and writes .complete marker', async () => {
    const staged = await stageReleaseFromNpm(tempDir, '0.3.0', {
      stageExtractor: async (stagingDir) => {
        await mkdir(path.join(stagingDir, 'bin'), { recursive: true });
        const entry = path.join(stagingDir, 'bin', 'cli.js');
        await writeFile(entry, '// dummy cli\n', 'utf8');
        return 'bin/cli.js';
      },
    });

    assert.equal(staged.version, '0.3.0');
    assert.equal(staged.releaseDir, path.join(tempDir, 'releases', '0.3.0'));
    assert.equal(staged.entryPath, path.join(tempDir, 'releases', '0.3.0', 'bin', 'cli.js'));

    const markerRaw = await readFile(path.join(staged.releaseDir, '.complete'), 'utf8');
    const marker = JSON.parse(markerRaw);
    assert.equal(marker.version, '0.3.0');
    assert.equal(marker.entryPath, staged.entryPath);

    // Second call should return cached release without running extractor again
    let extractorCalled = false;
    const cached = await stageReleaseFromNpm(tempDir, '0.3.0', {
      stageExtractor: async () => {
        extractorCalled = true;
        return 'bin/cli.js';
      },
    });

    assert.equal(extractorCalled, false);
    assert.equal(cached.version, '0.3.0');
    assert.equal(cached.entryPath, staged.entryPath);
  });

  test('stages release using BOTD_TEST_STAGE_ENTRY and BOTD_TEST_STAGE_FAIL', async () => {
    process.env.BOTD_TEST_STAGE_ENTRY = '1';
    process.env.BOTD_TEST_STAGE_FAIL = '1';

    try {
      const staged = await stageReleaseFromNpm(tempDir, '0.4.0');
      assert.equal(staged.version, '0.4.0');
      const content = await readFile(staged.entryPath, 'utf8');
      assert.match(content, /process\.exit\(1\)/);
    } finally {
      delete process.env.BOTD_TEST_STAGE_ENTRY;
      delete process.env.BOTD_TEST_STAGE_FAIL;
    }

    process.env.BOTD_TEST_STAGE_ENTRY = '1';
    try {
      const staged2 = await stageReleaseFromNpm(tempDir, '0.4.1');
      assert.equal(staged2.version, '0.4.1');
      const content = await readFile(staged2.entryPath, 'utf8');
      assert.match(content, /botd:daemon-ready/);
    } finally {
      delete process.env.BOTD_TEST_STAGE_ENTRY;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. performNodeUpgrade - Success, Canary Rollback, Drain Protection
// ---------------------------------------------------------------------------

describe('performNodeUpgrade Lifecycle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'botd-upgrade-lifecycle-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('returns upgraded: false when already at target version without force', async () => {
    await writeCurrentRelease(tempDir, {
      version: '0.2.0',
      entryPath: '/dummy/cli.js',
      updatedAt: new Date().toISOString(),
    });

    const result = await performNodeUpgrade(tempDir, {
      targetVersion: '0.2.0',
    });

    assert.equal(result.ok, true);
    assert.equal(result.previousVersion, '0.2.0');
    assert.equal(result.targetVersion, '0.2.0');
    assert.equal(result.upgraded, false);
  });

  test('successful upgrade: stages release, canary handshake succeeds, updates current.json', async () => {
    await writeCurrentRelease(tempDir, {
      version: '0.1.0',
      entryPath: '/old/cli.js',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    // Set a blocked release to verify clearBlockedRelease is called on success
    await writeBlockedRelease(tempDir, {
      version: '0.2.0',
      reason: 'earlier failure',
      at: '2025-01-01T00:00:00Z',
    });

    let shutdownScheduled = false;

    const result = await performNodeUpgrade(tempDir, {
      targetVersion: '0.2.0',
      stageExtractor: async (stagingDir) => {
        const entry = path.join(stagingDir, 'cli.js');
        await writeFile(entry, '// mocked new cli\n', 'utf8');
        return 'cli.js';
      },
      spawnReplacementFn: async (opts) => {
        assert(opts.cliEntryOverride?.includes('0.2.0'));
        return 99999;
      },
      onScheduleShutdown: () => {
        shutdownScheduled = true;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.previousVersion, '0.1.0');
    assert.equal(result.targetVersion, '0.2.0');
    assert.equal(result.upgraded, true);
    assert.equal(result.pid, 99999);
    assert.equal(shutdownScheduled, true);

    // current.json updated
    const current = await readCurrentRelease(tempDir);
    assert.equal(current?.version, '0.2.0');
    assert.equal(current?.entryPath, path.join(tempDir, 'releases', '0.2.0', 'cli.js'));

    // previous.json backed up
    const previous = await readPreviousRelease(tempDir);
    assert.equal(previous?.version, '0.1.0');
    assert.equal(previous?.entryPath, '/old/cli.js');

    // blocked release cleared
    const blocked = await readBlockedRelease(tempDir);
    assert.equal(blocked, null);
  });

  test('canary failure: rolls back current.json, records update-blocked.json, avoids shutdown', async () => {
    await writeCurrentRelease(tempDir, {
      version: '0.1.0',
      entryPath: '/old/cli.js',
      updatedAt: '2025-01-01T00:00:00Z',
    });

    let shutdownScheduled = false;

    await assert.rejects(
      async () => {
        await performNodeUpgrade(tempDir, {
          targetVersion: '0.2.0',
          stageExtractor: async (stagingDir) => {
            const entry = path.join(stagingDir, 'cli.js');
            await writeFile(entry, '// crash cli\n', 'utf8');
            return 'cli.js';
          },
          spawnReplacementFn: async () => {
            throw new Error('Replacement daemon exited prematurely with code 1');
          },
          onScheduleShutdown: () => {
            shutdownScheduled = true;
          },
        });
      },
      (err: Error) => {
        assert.match(
          err.message,
          /Upgrade to 0\.2\.0 failed canary check and was rolled back to 0\.1\.0/,
        );
        assert.match(err.message, /Replacement daemon exited prematurely/);
        return true;
      },
    );

    // Old daemon was not told to shut down
    assert.equal(shutdownScheduled, false);

    // current.json was restored to 0.1.0
    const current = await readCurrentRelease(tempDir);
    assert.equal(current?.version, '0.1.0');
    assert.equal(current?.entryPath, '/old/cli.js');

    // update-blocked.json recorded failure
    const blocked = await readBlockedRelease(tempDir);
    assert.notEqual(blocked, null);
    assert.equal(blocked?.version, '0.2.0');
    assert.match(blocked?.reason || '', /Replacement daemon exited prematurely/);
  });

  test('canary failure when no previous current.json exists: removes current.json and records blocked', async () => {
    // No current.json initially
    await assert.rejects(
      async () => {
        await performNodeUpgrade(tempDir, {
          targetVersion: '0.2.0',
          stageExtractor: async (stagingDir) => {
            const entry = path.join(stagingDir, 'cli.js');
            await writeFile(entry, '// crash\n', 'utf8');
            return 'cli.js';
          },
          spawnReplacementFn: async () => {
            throw new Error('Canary check failed');
          },
        });
      },
      /Upgrade to 0\.2\.0 failed canary check and was rolled back/,
    );

    // current.json should be removed
    const current = await readCurrentRelease(tempDir);
    assert.equal(current, null);

    // update-blocked.json exists
    const blocked = await readBlockedRelease(tempDir);
    assert.equal(blocked?.version, '0.2.0');
    assert.match(blocked?.reason || '', /Canary check failed/);
  });

  test('drain protection: aborts with timeout when active turns do not drain', async () => {
    await writeCurrentRelease(tempDir, {
      version: '0.1.0',
      entryPath: '/old/cli.js',
      updatedAt: '2025-01-01T00:00:00Z',
    });

    await assert.rejects(
      async () => {
        await performNodeUpgrade(tempDir, {
          targetVersion: '0.2.0',
          drainTimeoutMs: 250,
          getActiveTurnsCount: () => 2, // simulated active sessions
          stageExtractor: async (stagingDir) => {
            const entry = path.join(stagingDir, 'cli.js');
            await writeFile(entry, '// cli\n', 'utf8');
            return 'cli.js';
          },
          spawnReplacementFn: async () => 12345,
        });
      },
      /Timed out waiting for active turns to drain before upgrade/,
    );

    // current.json unchanged
    const current = await readCurrentRelease(tempDir);
    assert.equal(current?.version, '0.1.0');
  });

  test('drain protection: waits and succeeds when active turns drain within timeout', async () => {
    await writeCurrentRelease(tempDir, {
      version: '0.1.0',
      entryPath: '/old/cli.js',
      updatedAt: '2025-01-01T00:00:00Z',
    });

    let count = 2;
    setTimeout(() => {
      count = 0; // drain after 100ms
    }, 100);

    const result = await performNodeUpgrade(tempDir, {
      targetVersion: '0.2.0',
      drainTimeoutMs: 1000,
      getActiveTurnsCount: () => count,
      stageExtractor: async (stagingDir) => {
        const entry = path.join(stagingDir, 'cli.js');
        await writeFile(entry, '// cli\n', 'utf8');
        return 'cli.js';
      },
      spawnReplacementFn: async () => 77777,
    });

    assert.equal(result.ok, true);
    assert.equal(result.upgraded, true);
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-platform Service Management
// ---------------------------------------------------------------------------

describe('Cross-Platform Service Management', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'botd-service-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('generateServiceDescriptor for linux contains systemd user unit directives', () => {
    const desc = generateServiceDescriptor(tempDir, 'linux');
    assert.equal(desc.platform, 'linux');
    assert.equal(desc.configPath, path.join(tempDir, 'service', 'botd.service'));
    assert.match(desc.content, /\[Unit\]/);
    assert.match(desc.content, /Description=Botd Node Agent/);
    assert.match(desc.content, /ExecStart=/);
    assert.match(desc.content, /Restart=always/);
    assert.match(desc.content, /RestartSec=5/);
    assert.deepEqual(desc.installCmd, ['systemctl', '--user', 'enable', '--now', 'botd.service']);
    assert.deepEqual(desc.uninstallCmd, ['systemctl', '--user', 'disable', '--now', 'botd.service']);
  });

  test('generateServiceDescriptor for darwin contains LaunchAgent plist directives', () => {
    const desc = generateServiceDescriptor(tempDir, 'darwin');
    assert.equal(desc.platform, 'darwin');
    assert.equal(desc.configPath, path.join(tempDir, 'service', 'dev.botd.agent.plist'));
    assert.match(desc.content, /<string>dev\.botd\.agent<\/string>/);
    assert.match(desc.content, /<key>ProgramArguments<\/key>/);
    assert.match(desc.content, /<key>RunAtLoad<\/key>/);
    assert.match(desc.content, /<key>KeepAlive<\/key>/);
  });

  test('generateServiceDescriptor for win32 contains cmd script and schtasks command', () => {
    const desc = generateServiceDescriptor(tempDir, 'win32');
    assert.equal(desc.platform, 'win32');
    assert.equal(desc.configPath, path.join(tempDir, 'service', 'start-botd.cmd'));
    assert.match(desc.content, /@echo off/);
    assert.equal(desc.installCmd[0], 'schtasks');
    assert(desc.installCmd.includes('BotdNodeAgent'));
    assert(desc.installCmd.includes('ONLOGON'));
  });

  test('installNodeService, getNodeServiceStatus, and uninstallNodeService lifecycle (dryRun)', async () => {
    // Initial status: not installed
    const statusBefore = await getNodeServiceStatus(tempDir);
    assert.equal(statusBefore.installed, false);

    // Install dryRun on linux
    const installRes = await installNodeService(tempDir, {
      dryRun: true,
      platformOverride: 'linux',
    });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.dryRun, true);
    assert.equal(installRes.platform, 'linux');

    // Status is now installed
    const statusInstalled = await getNodeServiceStatus(tempDir);
    assert.equal(statusInstalled.installed, true);
    assert.equal(statusInstalled.platform, 'linux');
    assert.equal(statusInstalled.configPath, installRes.configPath);

    // Uninstall dryRun
    const uninstallRes = await uninstallNodeService(tempDir, {
      dryRun: true,
      platformOverride: 'linux',
    });
    assert.equal(uninstallRes.ok, true);

    // Status returns to not installed
    const statusAfter = await getNodeServiceStatus(tempDir);
    assert.equal(statusAfter.installed, false);
  });
});

// ---------------------------------------------------------------------------
// 6. daemon-launch.ts current.json resolution
// ---------------------------------------------------------------------------

describe('daemon-launch current.json Entry Resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'botd-launch-spec-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('uses current.json entryPath when present without cliEntryOverride', async () => {
    const customEntry = path.join(tempDir, 'custom-cli.js');
    await writeFile(customEntry, '// custom\n', 'utf8');

    await writeCurrentRelease(tempDir, {
      version: '1.5.0',
      entryPath: customEntry,
      updatedAt: new Date().toISOString(),
    });

    const spec = buildDaemonSpawnSpec({ dataDir: tempDir });
    assert(spec.args.includes(customEntry));
  });

  test('prefers cliEntryOverride over current.json entryPath', async () => {
    const customEntry = path.join(tempDir, 'custom-cli.js');
    const overrideEntry = path.join(tempDir, 'override-cli.js');
    await writeFile(customEntry, '// custom\n', 'utf8');
    await writeFile(overrideEntry, '// override\n', 'utf8');

    await writeCurrentRelease(tempDir, {
      version: '1.5.0',
      entryPath: customEntry,
      updatedAt: new Date().toISOString(),
    });

    const spec = buildDaemonSpawnSpec({
      dataDir: tempDir,
      cliEntryOverride: overrideEntry,
    });
    assert(spec.args.includes(overrideEntry));
    assert(!spec.args.includes(customEntry));
  });
});

// ---------------------------------------------------------------------------
// 7. Local IPC /status includes version and /upgrade endpoints
// ---------------------------------------------------------------------------

describe('Local IPC Integration', () => {
  let tempDir: string;
  let socketPath: string;
  let server: http.Server;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'botd-ipc-upgrade-'));
    socketPath = getDaemonSocketPath(tempDir);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test('GET /status includes version string', async () => {
    process.env.BOTD_VERSION_OVERRIDE = '0.9.9-test';

    server = createLocalIpcServer({
      identity: {
        nodeId: 'node-test-1',
        name: 'test-node',
        hubUrl: 'http://localhost:3000',
      },
      dataDir: tempDir,
      socketPath,
      startedAt: Date.now(),
      isHubConnected: () => true,
      getHubRpc: () => null,
      bgManager: {} as any,
      syncRegistrationWithHub: async () => {},
      handleShutdown: async () => {},
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ socketPath, path: '/status', method: 'GET' }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.version, '0.9.9-test');
    delete process.env.BOTD_VERSION_OVERRIDE;
  });

  test('GET /upgrade/check and POST /upgrade over local socket', async () => {
    let upgradeCalled = false;
    let shutdownCalled = false;

    await writeCurrentRelease(tempDir, {
      version: '0.1.0',
      entryPath: '/dummy/cli.js',
      updatedAt: new Date().toISOString(),
    });

    server = createLocalIpcServer({
      identity: {
        nodeId: 'node-test-upgrade',
        name: 'test-node',
        hubUrl: 'http://localhost:3000',
      },
      dataDir: tempDir,
      socketPath,
      startedAt: Date.now(),
      isHubConnected: () => true,
      getHubRpc: () => null,
      bgManager: {} as any,
      syncRegistrationWithHub: async () => {},
      handleShutdown: async () => {
        shutdownCalled = true;
      },
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    // Test GET /upgrade/check (with custom mock fetch in checkNodeUpgrade)
    // Create an override or pre-staged file
    process.env.BOTD_TEST_STAGE_ENTRY = '1';

    // Test POST /upgrade
    const postRes = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = JSON.stringify({ targetVersion: '0.2.0' });
      const req = http.request(
        {
          socketPath,
          path: '/upgrade',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(raw) }));
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    assert.equal(postRes.status, 200);
    assert.equal(postRes.body.ok, true);
    assert.equal(postRes.body.targetVersion, '0.2.0');
    assert.equal(postRes.body.upgraded, true);

    delete process.env.BOTD_TEST_STAGE_ENTRY;
  });
});

// ---------------------------------------------------------------------------
// 8. CLI Command Integration (botd upgrade, botd service)
// ---------------------------------------------------------------------------

describe('CLI Commands: upgrade & service', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'botd-cli-cmds-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('botd upgrade --check invokes checkNodeUpgrade and prints output', async () => {
    await writeCurrentRelease(tempDir, {
      version: '0.1.0',
      entryPath: '/dummy/cli.js',
      updatedAt: new Date().toISOString(),
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    try {
      const program = new Command();
      program.option('--data-dir <path>', 'Data dir');
      program.option('--json', 'JSON output');
      registerNodeCommands(program);

      // Using mock fetch via BOTD_NPM_REGISTRY mock server
      const mockServer = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '0.3.0' }));
      });
      await new Promise<void>((resolve) => mockServer.listen(0, resolve));
      const port = (mockServer.address() as any).port;
      const registryUrl = `http://127.0.0.1:${port}`;

      await program.parseAsync([
        'node',
        'cli',
        'upgrade',
        '--data-dir',
        tempDir,
        '--registry',
        registryUrl,
        '--check',
        '--json',
      ]);

      await new Promise<void>((resolve) => mockServer.close(() => resolve()));

      assert(logs.length > 0);
      const parsed = JSON.parse(logs[0]);
      assert.equal(parsed.currentVersion, '0.1.0');
      assert.equal(parsed.latestVersion, '0.3.0');
      assert.equal(parsed.updateAvailable, true);
    } finally {
      console.log = origLog;
    }
  });

  test('botd service install/status/uninstall CLI commands', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    try {
      const program = new Command();
      program.option('--data-dir <path>', 'Data dir');
      program.option('--json', 'JSON output');
      registerNodeCommands(program);

      // 1. service install --dry-run
      await program.parseAsync([
        'node',
        'cli',
        'service',
        'install',
        '--data-dir',
        tempDir,
        '--dry-run',
        '--json',
      ]);

      assert(logs.length > 0);
      const installRes = JSON.parse(logs[logs.length - 1]);
      assert.equal(installRes.ok, true);
      assert.equal(installRes.dryRun, true);

      // 2. service status
      await program.parseAsync([
        'node',
        'cli',
        'service',
        'status',
        '--data-dir',
        tempDir,
        '--json',
      ]);

      const statusRes = JSON.parse(logs[logs.length - 1]);
      assert.equal(statusRes.installed, true);

      // 3. service uninstall --dry-run
      await program.parseAsync([
        'node',
        'cli',
        'service',
        'uninstall',
        '--data-dir',
        tempDir,
        '--dry-run',
        '--json',
      ]);

      const uninstallRes = JSON.parse(logs[logs.length - 1]);
      assert.equal(uninstallRes.ok, true);
      assert.equal(uninstallRes.dryRun, true);
    } finally {
      console.log = origLog;
    }
  });

  test('botd nodes upgrade <nodeId> --check and post', async () => {
    let checkCalled = false;
    let postCalled = false;
    let postBody: any = null;

    const mockHub = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/auth/login') {
        res.setHeader('Set-Cookie', 'botd_token=test-tok; Path=/');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: 'test-tok' }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/nodes/node-123/upgrade/check')) {
        checkCalled = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          currentVersion: '0.1.0',
          latestVersion: '0.3.0',
          updateAvailable: true,
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/nodes/node-123/upgrade') {
        postCalled = true;
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          postBody = body ? JSON.parse(body) : {};
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            previousVersion: '0.1.0',
            targetVersion: '0.3.0',
            upgraded: true,
            pid: 8888,
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockHub.listen(0, resolve));
    const port = (mockHub.address() as any).port;
    const hubUrl = `http://127.0.0.1:${port}`;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    try {
      const program = new Command();
      program.option('--data-dir <path>', 'Data dir');
      program.option('--hub <url>', 'Hub URL');
      program.option('--username <name>', 'Username');
      program.option('--password <pass>', 'Password');
      program.option('--json', 'JSON output');
      registerNodesCommands(program);

      // Test 1: check
      await program.parseAsync([
        'node',
        'cli',
        'nodes',
        'upgrade',
        'node-123',
        '--data-dir',
        tempDir,
        '--hub',
        hubUrl,
        '--password',
        'secret',
        '--check',
        '--json',
      ]);

      assert.equal(checkCalled, true);
      const parsedCheck = JSON.parse(logs[logs.length - 1]);
      assert.equal(parsedCheck.currentVersion, '0.1.0');
      assert.equal(parsedCheck.latestVersion, '0.3.0');
      assert.equal(parsedCheck.updateAvailable, true);

      // Test 2: execute upgrade
      await program.parseAsync([
        'node',
        'cli',
        'nodes',
        'upgrade',
        'node-123',
        '--data-dir',
        tempDir,
        '--hub',
        hubUrl,
        '--password',
        'secret',
        '--version',
        '0.3.0',
        '--json',
      ]);

      assert.equal(postCalled, true);
      assert.equal(postBody?.targetVersion, '0.3.0');
      const parsedPost = JSON.parse(logs[logs.length - 1]);
      assert.equal(parsedPost.ok, true);
      assert.equal(parsedPost.upgraded, true);
    } finally {
      console.log = origLog;
      await new Promise<void>((resolve) => mockHub.close(() => resolve()));
    }
  });
});
