/**
 * Fail-Closed Integrity 集成测试。
 *
 * 覆盖：
 *  1. Session-Scoped SecretStash：机密按会话隔离——sess_A stash 的机密只注入
 *     sess_A 的执行环境，绝不泄漏给 sess_B；无 scope 的旧路径完全向后兼容；
 *  2. Fail-Closed Git Worktree：真实 git 仓库中 worktree 获取失败时显式抛错，
 *     不再静默回落到 repoDir 弄脏主分支；非 git 目录仍优雅降级。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createNodeEnvRpcServer } from '../apps/node/src/env-rpc-server.js';
import { SecretStash, redactSecretAskAnswer, withSecretEnv } from '../apps/hub/src/harness/secret-stash.js';

const run = promisify(execFile);

/** 机密表单 spec：密码绑定 /credentials/password。 */
const secretUiSpec = {
  root: 'card',
  elements: {
    card: {
      type: 'Card',
      props: { title: '部署凭据' },
      children: ['pass_input', 'submit_btn'],
    },
    pass_input: {
      type: 'TextInput',
      props: {
        label: '密码',
        secret: true,
        value: { $bindState: '/credentials/password' },
      },
    },
    submit_btn: { type: 'Button', props: { label: '提交', variant: 'primary' } },
  },
  state: { credentials: { password: '' } },
};

// ---------------------------------------------------------------------------
// 1. Session-Scoped SecretStash
// ---------------------------------------------------------------------------

test('session-scoped stash：sess_A 的机密只注入 sess_A，绝不泄漏给 sess_B', { timeout: 60_000 }, () => {
  const stash = new SecretStash();
  const answer = JSON.stringify({
    decision: '提交',
    state: { credentials: { password: 'sess-A-password' } },
  });

  const { redactedAnswer, stashedEnvKeys } = redactSecretAskAnswer(
    answer,
    'ui',
    JSON.stringify(secretUiSpec),
    stash,
    'sess_A',
  );
  const envKey = stashedEnvKeys['/credentials/password'];
  assert.ok(envKey, 'secret path should be stashed');
  assert.ok(!redactedAnswer.includes('sess-A-password'), 'plaintext must not survive');
  assert.match(redactedAnswer, /\[REDACTED:\$BOTD_SECRET_[0-9A-F]{8}\]/);

  // scopeId 绑定：peek 按 sess_A 可读，sess_B 不可读。
  assert.equal(stash.peek(envKey, 'sess_A'), 'sess-A-password');
  assert.equal(stash.peek(envKey, 'sess_B'), undefined, 'sess_B must not read sess_A secret');

  // withSecretEnv：env 内的 BOTD_SESSION_ID 决定可见范围。
  const envA = withSecretEnv({ BOTD_SESSION_ID: 'sess_A' }, stash);
  assert.equal(envA?.[envKey], 'sess-A-password', 'sess_A env receives the secret');

  const envB = withSecretEnv({ BOTD_SESSION_ID: 'sess_B' }, stash);
  assert.equal(envB?.[envKey], undefined, 'sess_B env must not receive sess_A secret');
  assert.ok(!JSON.stringify(envB).includes('sess-A-password'), 'zero cross-session leakage');

  // 无 session id 的 env（未指定 scope）按向后兼容语义拿到全部条目（含会话绑定机密）。
  const envAnon = withSecretEnv({ OTHER: '1' }, stash);
  assert.equal(envAnon?.[envKey], 'sess-A-password', 'unscoped getEnvRecord keeps legacy all-entries behavior');

  // 显式 scopeId 参数覆盖 env 推断。
  const envExplicit = withSecretEnv({ BOTD_SESSION_ID: 'sess_B' }, stash, 'sess_A');
  assert.equal(envExplicit?.[envKey], 'sess-A-password', 'explicit scopeId wins over env');

  // getEnvRecord(scopeId)：sess_B 视角看不到 sess_A 的条目，sess_A 视角看得到。
  assert.equal(stash.getEnvRecord('sess_B')[envKey], undefined);
  assert.equal(stash.getEnvRecord('sess_A')[envKey], 'sess-A-password');
});

test('unscoped stash 与 unscoped getEnvRecord 保持向后兼容', { timeout: 60_000 }, () => {
  const stash = new SecretStash();

  // 无 scope stash：任何会话（含未指定 scope 的 getEnvRecord）都可见——旧行为。
  const legacyKey = stash.stash('legacy-secret');
  assert.equal(stash.peek(legacyKey), 'legacy-secret');
  assert.equal(stash.getEnvRecord()[legacyKey], 'legacy-secret');
  assert.equal(stash.getEnvRecord('sess_any')[legacyKey], 'legacy-secret', 'unscoped entries are visible to every session');

  // scoped + unscoped 混合：unscoped getEnvRecord() 返回全部（兼容旧调用）。
  const { stashedEnvKeys } = redactSecretAskAnswer(
    JSON.stringify({ state: { credentials: { password: 'scoped-secret' } } }),
    'ui',
    JSON.stringify(secretUiSpec),
    stash,
    'sess_X',
  );
  const scopedKey = stashedEnvKeys['/credentials/password'];
  assert.ok(scopedKey);
  const all = stash.getEnvRecord();
  assert.equal(all[legacyKey], 'legacy-secret');
  assert.equal(all[scopedKey], 'scoped-secret');

  // TTL 过期仍按原语义清理。
  const ttlKey = stash.stash('ephemeral', 1);
  assert.ok(stash.getEnvRecord()[ttlKey] !== undefined);
});

// ---------------------------------------------------------------------------
// 2. Fail-Closed envAcquireWorktree
// ---------------------------------------------------------------------------

test('envAcquireWorktree：非 git 目录优雅降级为 repoDir', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-failclosed-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
  const rpc = createNodeEnvRpcServer({ defaultCwd: root });
  t.after(async () => {
    await rpc.envCleanup();
  });

  const plain = await mkdtemp(path.join(tmpdir(), 'botd-plain-'));
  t.after(async () => {
    await rm(plain, { recursive: true, force: true }).catch(() => undefined);
  });
  const result = await rpc.envAcquireWorktree({ repoDir: plain, workerId: 'w1' });
  assert.deepEqual(result, { worktreePath: plain, branchName: '', isGitRepo: false });
});

test('envAcquireWorktree：git 仓库中 worktree 获取失败显式抛错（fail-closed）', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-failclosed-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
  const rpc = createNodeEnvRpcServer({ defaultCwd: root });
  t.after(async () => {
    await rpc.envCleanup();
  });

  // git init 但零提交：HEAD 指向未出生分支，worktree add ... HEAD 必然失败。
  const repoDir = await mkdtemp(path.join(tmpdir(), 'botd-emptyrepo-'));
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
  });
  await run('git', ['init', '-q'], { cwd: repoDir });

  await assert.rejects(
    () => rpc.envAcquireWorktree({ repoDir, workerId: 'w-fail' }),
    (error: Error) => {
      assert.match(error.message, /Failed to acquire git worktree/);
      assert.ok(error.message.includes(repoDir), 'error names the repository');
      return true;
    },
    'must not silently fall back to repoDir when worktree add fails in a real git repo',
  );
});
