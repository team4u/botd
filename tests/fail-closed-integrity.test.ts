/**
 * Fail-Closed Integrity 集成测试。
 *
 * 覆盖：
 *  1. Session-Scoped SecretStash：机密按会话严格隔离——sess_A stash 的机密只注入
 *     sess_A 的执行环境，绝不泄漏给 sess_B；无信任作用域时不注入任何机密（fail-closed），
 *     逐调用 env 伪造 BOTD_SESSION_ID 无法改变作用域；
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
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
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
    'sess_A',
    'ui',
    JSON.stringify(secretUiSpec),
    stash,
  );
  const envKey = stashedEnvKeys['/credentials/password'];
  assert.ok(envKey, 'secret path should be stashed');
  assert.ok(!redactedAnswer.includes('sess-A-password'), 'plaintext must not survive');
  assert.match(redactedAnswer, /\[REDACTED:\$BOTD_SECRET_[0-9A-F]{8}\]/);

  // scope 严格匹配：peek 按 sess_A 可读，sess_B 不可读。
  assert.equal(stash.peek(envKey, 'sess_A'), 'sess-A-password');
  assert.equal(stash.peek(envKey, 'sess_B'), undefined, 'sess_B must not read sess_A secret');

  // withSecretEnv：作用域来自可信参数，与逐调用 env 无关。
  const envA = withSecretEnv({ BOTD_SESSION_ID: 'sess_A' }, 'sess_A', stash);
  assert.equal(envA?.[envKey], 'sess-A-password', 'sess_A env receives the secret');

  const envB = withSecretEnv({ BOTD_SESSION_ID: 'sess_B' }, 'sess_B', stash);
  assert.equal(envB?.[envKey], undefined, 'sess_B env must not receive sess_A secret');
  assert.ok(!JSON.stringify(envB).includes('sess-A-password'), 'zero cross-session leakage');

  // 伪造逐调用 env 的 BOTD_SESSION_ID 不能改变作用域：sess_B 的 env 声称自己是 sess_A 也拿不到机密，
  // 反之 sess_A 的可信作用域即使 env 里带别人的会话 id 仍按 sess_A 注入。
  const forged = withSecretEnv({ BOTD_SESSION_ID: 'sess_A' }, 'sess_B', stash);
  assert.equal(forged?.[envKey], undefined, 'forged env BOTD_SESSION_ID must not unlock sess_A secrets');
  const trusted = withSecretEnv({ BOTD_SESSION_ID: 'sess_B' }, 'sess_A', stash);
  assert.equal(trusted?.[envKey], 'sess-A-password', 'trusted scope wins over per-call env');

  // getEnvRecord(scopeId)：sess_B 视角看不到 sess_A 的条目，sess_A 视角看得到。
  assert.equal(stash.getEnvRecord('sess_B')[envKey], undefined);
  assert.equal(stash.getEnvRecord('sess_A')[envKey], 'sess-A-password');
});

test('无信任作用域时 fail-closed：不注入任何机密，stash 拒绝空 scope', { timeout: 60_000 }, async () => {
  const stash = new SecretStash();
  const key = stash.stash('scoped-secret', 'sess_X');
  assert.equal(stash.peek(key, 'sess_X'), 'scoped-secret');

  // 作用域缺失或为空：原样返回 env，绝不注入（也不从 env 推断）。
  assert.equal(withSecretEnv(undefined, undefined, stash), undefined, 'no scope, no env: nothing injected');
  assert.deepEqual(
    withSecretEnv({ BOTD_SESSION_ID: 'sess_X' }, undefined, stash),
    { BOTD_SESSION_ID: 'sess_X' },
    'env-carried session id is not a trusted scope',
  );
  assert.deepEqual(withSecretEnv({ OTHER: '1' }, '', stash), { OTHER: '1' }, 'empty scope injects nothing');

  // 作用域不匹配也没有“全部条目”回退：sess_Y 只能看到自己的机密。
  assert.deepEqual(stash.getEnvRecord('sess_Y'), {}, 'no all-entries read exists');

  // stash 拒绝空/非字符串 scope：不存在无主机密。
  assert.throws(() => stash.stash('orphan', ''), /non-empty scopeId/);
  assert.throws(() => stash.stash('orphan', undefined as unknown as string), /non-empty scopeId/);

  // TTL 过期后条目被清理，注入也随之消失（同作用域其余机密仍在）。
  const ttlKey = stash.stash('ephemeral', 'sess_X', 1);
  assert.equal(stash.getEnvRecord('sess_X')[ttlKey], 'ephemeral');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stash.peek(ttlKey, 'sess_X'), undefined, 'expired entry is pruned');
  assert.deepEqual(stash.getEnvRecord('sess_X'), { [key]: 'scoped-secret' }, 'only expired entries disappear');

  // consume 一次性且受作用域约束：错误作用域读不到也删不掉。
  const oneShot = stash.stash('one-shot', 'sess_C');
  assert.equal(stash.consume(oneShot, 'sess_D'), undefined, 'consume with wrong scope fails');
  assert.equal(stash.consume(oneShot, 'sess_C'), 'one-shot');
  assert.equal(stash.consume(oneShot, 'sess_C'), undefined, 'consume is one-shot');
});

test('SecretInjectingEnv/RemoteExecutionEnv 隔离：本地与远端执行环境按可信会话注入，伪造 env 无效', { timeout: 60_000 }, async () => {
  const { SecretInjectingEnv } = await import('../apps/hub/src/harness/hub-harness.js');
  const { RemoteExecutionEnv } = await import('../apps/hub/src/harness/remote-env.js');
  const { globalSecretStash } = await import('../apps/hub/src/harness/secret-stash.js');
  // SecretInjectingEnv/RemoteExecutionEnv 生产上固定使用 globalSecretStash，作用域取自构造时的会话 shellEnv。
  const envKeyA = globalSecretStash.stash('local-A-secret', 'sess_A');
  const envKeyB = globalSecretStash.stash('remote-B-secret', 'sess_B');
  // 1) 本地 A 会话环境拿到 A 的机密，拿不到 B 的。
  const localEnvA = new SecretInjectingEnv({ cwd: process.cwd(), shellEnv: { BOTD_SESSION_ID: 'sess_A' } });
  const captureA: string[] = [];
  const resA = await localEnvA.exec(
    'node -e "process.stdout.write(process.env.' + envKeyA + ' || \'\')"',
    { onOutput: (t: string) => captureA.push(t) },
    BACKGROUND_CONTEXT,
  );
  assert.ok(resA.ok, resA.ok ? '' : resA.error.message);
  assert.equal(captureA.join(''), 'local-A-secret', 'sess_A local env receives its own secret');

  // 2) 同一会话执行时伪造 options.env.BOTD_SESSION_ID 也不能看到 B 的机密。
  const forgeChunks: string[] = [];
  const resForge = await localEnvA.exec(
    'node -e "process.stdout.write(process.env.' + envKeyB + ' || \'\')"',
    { env: { BOTD_SESSION_ID: 'sess_B' }, onOutput: (t: string) => forgeChunks.push(t) },
    BACKGROUND_CONTEXT,
  );
  assert.ok(resForge.ok, resForge.ok ? '' : resForge.error.message);
  assert.equal(forgeChunks.join(''), '', 'forged options.env.BOTD_SESSION_ID cannot unlock another session secret');

  // 3) 无作用域（无 shellEnv）的本地环境完全不注入。
  const noScopeEnv = new SecretInjectingEnv({ cwd: process.cwd() });
  const noScopeChunks: string[] = [];
  const resNoScope = await noScopeEnv.exec(
    'node -e "process.stdout.write(process.env.' + envKeyA + ' || \'\')"',
    { onOutput: (t: string) => noScopeChunks.push(t) },
    BACKGROUND_CONTEXT,
  );
  assert.ok(resNoScope.ok, resNoScope.ok ? '' : resNoScope.error.message);
  assert.equal(noScopeChunks.join(''), '', 'no trusted scope means no injection');

  // 4) 远端 RemoteExecutionEnv：作用域取自会话 shellEnv，逐调用 env 无法伪造。
  const captured: Array<Record<string, string> | undefined> = [];
  const rpc = {
    envExec: async (input: { env?: Record<string, string> }) => {
      captured.push(input.env);
      return { ok: true as const, value: { exitCode: 0 } };
    },
  };
  const remote = new RemoteExecutionEnv(
    { getNodeEnvRpc: () => rpc as never },
    { nodeId: 'node-1', cwd: '/tmp', shellEnv: { BOTD_SESSION_ID: 'sess_B' } },
  );
  const resRemote = await remote.exec('true', undefined, BACKGROUND_CONTEXT);
  assert.ok(resRemote.ok, resRemote.ok ? '' : resRemote.error.message);
  const remoteEnv = captured.at(-1) ?? {};
  assert.equal(remoteEnv[envKeyB], 'remote-B-secret', 'remote env injects its own session secret');
  assert.equal(remoteEnv[envKeyA], undefined, 'remote env must not see sess_A secret');

  const resRemoteForge = await remote.exec('true', { env: { BOTD_SESSION_ID: 'sess_A' } }, BACKGROUND_CONTEXT);
  assert.ok(resRemoteForge.ok, resRemoteForge.ok ? '' : resRemoteForge.error.message);
  const remoteForged = captured.at(-1) ?? {};
  assert.equal(remoteForged[envKeyA], undefined, 'forged per-call env cannot widen remote injection scope');
  assert.equal(remoteForged[envKeyB], 'remote-B-secret', 'remote scope stays bound to shellEnv session');

  const remoteNoScope = new RemoteExecutionEnv({ getNodeEnvRpc: () => rpc as never }, { nodeId: 'node-2', cwd: '/tmp' });
  const resRemoteNoScope = await remoteNoScope.exec('true', undefined, BACKGROUND_CONTEXT);
  assert.ok(resRemoteNoScope.ok, resRemoteNoScope.ok ? '' : resRemoteNoScope.error.message);
  const remoteNoScopeEnv = captured.at(-1);
  assert.equal(remoteNoScopeEnv, undefined, 'remote env without trusted scope passes no env at all');
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
