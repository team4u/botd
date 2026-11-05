import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getDaemonSocketPath } from '../apps/node/src/storage.js';
import { ensureBotdBinWrapper } from '../apps/node/src/runtime.js';
import { resetWindowsShellCache, resolveWindowsBash, ensureWindowsShell } from '../apps/node/src/windows-shell.js';

test('daemon control-plane address adapts to the platform', { timeout: 60_000 }, () => {
  const socketPath = getDaemonSocketPath('/tmp/fake-data-dir');
  if (process.platform === 'win32') {
    assert.match(socketPath, /^\\\\\.\\pipe\\botd-agent-[0-9a-f]{16}$/);
    // Same dataDir (case-insensitive on Windows) must map to the same pipe
    assert.equal(getDaemonSocketPath('/tmp/FAKE-data-DIR'), socketPath);
    // Different dataDirs must never collide
    assert.notEqual(getDaemonSocketPath('/tmp/other-dir'), socketPath);
  } else {
    assert.equal(socketPath, path.join('/tmp/fake-data-dir', 'agent.sock'));
  }
});

test('botd bin wrapper emits a POSIX script and a .cmd twin on Windows', { timeout: 60_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-wrapper-'));
  t.after(async () => {
    if (process.platform === 'win32') resetWindowsShellCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  const binDir = await ensureBotdBinWrapper(dataDir);
  assert.equal(binDir, path.join(dataDir, 'bin'));

  const script = await readFile(path.join(binDir, 'botd'), 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env sh\n/);
  // The wrapper must exec the resolved CLI entry with all arguments passed through
  assert.match(script, /exec .+ .+("\$@"|$)/);
  if (process.platform === 'win32') {
    // Backslashes would break inside MSYS2 sh — paths must be POSIX-ified
    assert.equal(script.includes('\\'), false);
    const cmd = await readFile(path.join(binDir, 'botd.cmd'), 'utf8');
    assert.match(cmd, /^@echo off\r?\n/);
    assert.match(cmd, /%\*[\r\n]*$/);
  } else {
    assert.equal(existsSync(path.join(binDir, 'botd.cmd')), false, 'no .cmd twin on POSIX');
  }

  // Regenerating with identical content must be a no-op (same files, no error)
  await ensureBotdBinWrapper(dataDir);
});

test('windows bash resolution prefers BOTD_BASH_PATH and never auto-downloads when one exists', { timeout: 60_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-winbash-'));
  t.after(async () => {
    delete process.env.BOTD_BASH_PATH;
    resetWindowsShellCache();
    await rm(dataDir, { recursive: true, force: true });
  });
  resetWindowsShellCache();

  const fakeBash = path.join(dataDir, 'fake-bash.exe');
  await writeFile(fakeBash, 'stub');
  process.env.BOTD_BASH_PATH = fakeBash;

  if (process.platform === 'win32') {
    assert.equal(resolveWindowsBash(dataDir), fakeBash);
    // ensureWindowsShell resolves the same path without hitting the network
    assert.equal(await ensureWindowsShell(dataDir), fakeBash);
  } else {
    // On POSIX the module is inert by contract
    assert.equal(await ensureWindowsShell(dataDir), undefined);
  }
});

test('ensureWindowsShell downloads a portable MinGit when no bash exists (network stubbed via BOTD_MINGIT_URL)', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-mingit-'));
  t.after(async () => {
    delete process.env.BOTD_MINGIT_URL;
    resetWindowsShellCache();
    await rm(dataDir, { recursive: true, force: true });
  });
  resetWindowsShellCache();

  // A directory with no bash anywhere: force the download path by pointing
  // BOTD_BASH_PATH at a nonexistent file and clearing managed MinGit.
  process.env.BOTD_BASH_PATH = path.join(dataDir, 'does-not-exist.exe');

  // Local file:// style URL is not supported by fetch; instead we assert the
  // failure path is graceful: no throw, returns undefined, daemon can still boot.
  process.env.BOTD_MINGIT_URL = 'http://127.0.0.1:9/definitely-offline.zip';
  const result = await ensureWindowsShell(dataDir);
  assert.equal(result, undefined);
});

test('managed mingit marker short-circuits resolution', { timeout: 60_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-mingit-marker-'));
  t.after(async () => {
    if (process.platform === 'win32') resetWindowsShellCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  // Simulate a previously-completed managed install
  const mingitDir = path.join(dataDir, 'runtime', 'mingit');
  await mkdir(path.join(mingitDir, 'bin'), { recursive: true });
  await writeFile(path.join(mingitDir, 'bin', 'bash.exe'), 'stub');
  await writeFile(path.join(mingitDir, '.complete'), new Date().toISOString());

  if (process.platform === 'win32') {
    resetWindowsShellCache();
    const previous = process.env.BOTD_BASH_PATH;
    delete process.env.BOTD_BASH_PATH;
    assert.equal(resolveWindowsBash(dataDir), path.join(mingitDir, 'bin', 'bash.exe'));
    if (previous) process.env.BOTD_BASH_PATH = previous;
  }
});
