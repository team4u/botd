import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureBotdBinWrapper } from '../apps/node/src/runtime.js';
import { createNodeEnvRpcServer } from '../apps/node/src/env-rpc-server.js';
import {
  deleteResource,
  getSkillSearchDirs,
  listSkills,
  readSkill,
  resolveSkillDir,
  saveBot,
  seedStorageIfEmpty,
  writeExtension,
  writeSkill,
} from '../apps/node/src/storage.js';
import { installResourceToNode, parseGitSource } from '../apps/node/src/installer.js';

// ---------------------------------------------------------------------------
// Hands on Node：env-rpc-server（NodeExecutionEnv + Git Worktree 隔离）
// ---------------------------------------------------------------------------

test('createNodeEnvRpcServer serves files and streaming exec locally (Hands on Node)', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-sdk-env-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const outputs: { text: string; stream: string }[] = [];
  const rpc = createNodeEnvRpcServer({
    defaultCwd: root,
    onExecOutput: (event) => outputs.push({ text: event.text, stream: event.stream }),
  });
  t.after(() => rpc.envCleanup().catch(() => undefined));

  const write = await rpc.envWriteFile({ path: 'hello.txt', content: 'line1\nline2\n' });
  assert.equal(write.ok, true, JSON.stringify(write));
  const text = await rpc.envReadTextFile({ path: 'hello.txt' });
  assert.equal(text.ok && text.value, 'line1\nline2\n');

  const exec = await rpc.envExec({ execId: 'sdk-exec-1', command: 'printf out; printf err >&2' });
  assert.equal(exec.ok && exec.value.exitCode, 0, JSON.stringify(exec));
  assert(outputs.some((o) => o.stream === 'stdout' && o.text.includes('out')));
  assert(outputs.some((o) => o.stream === 'stderr' && o.text.includes('err')));

  // envAbortExec：运行中的命令可被中止
  const slow = rpc.envExec({ execId: 'sdk-exec-2', command: 'sleep 30', timeout: 30 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rpc.envAbortExec('sdk-exec-2');
  const aborted = await slow;
  assert.equal(aborted.ok, false, 'aborted exec must return a failed RpcResult');
});

test('createNodeEnvRpcServer isolates concurrent workers with git worktrees', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-sdk-worktree-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const repoDir = path.join(root, 'repo');
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, 'shared.txt'), 'base\n');
  const gitArgs: string[][] = [
    ['init', '-q'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'test'],
    ['add', '.'],
    ['commit', '-q', '-m', 'init'],
  ];
  for (const args of gitArgs) {
    execFileSync('git', args, { cwd: repoDir });
  }

  const rpc = createNodeEnvRpcServer({ defaultCwd: root });
  t.after(() => rpc.envCleanup().catch(() => undefined));

  const first = await rpc.envAcquireWorktree({ repoDir, workerId: 'w1' });
  const second = await rpc.envAcquireWorktree({ repoDir, workerId: 'w2' });
  assert.equal(first.isGitRepo && second.isGitRepo, true);
  assert.notEqual(first.worktreePath, second.worktreePath);

  // 两个 worker 并发改同一文件互不干扰
  const w1write = await rpc.envWriteFile({ path: 'shared.txt', content: 'from-w1\n', cwd: first.worktreePath });
  const w2write = await rpc.envWriteFile({ path: 'shared.txt', content: 'from-w2\n', cwd: second.worktreePath });
  assert.equal(w1write.ok && w2write.ok, true);
  const w1read = await rpc.envReadTextFile({ path: 'shared.txt', cwd: first.worktreePath });
  const w2read = await rpc.envReadTextFile({ path: 'shared.txt', cwd: second.worktreePath });
  assert.equal(w1read.ok && w1read.value, 'from-w1\n');
  assert.equal(w2read.ok && w2read.value, 'from-w2\n');
  assert.equal(await readFile(path.join(repoDir, 'shared.txt'), 'utf8'), 'base\n', 'main worktree must stay untouched');

  await rpc.envReleaseWorktree({ repoDir, worktreePath: first.worktreePath, branchName: first.branchName, deleteBranch: true });
  await rpc.envReleaseWorktree({ repoDir, worktreePath: second.worktreePath, branchName: second.branchName, deleteBranch: true });
});

// ---------------------------------------------------------------------------
// Hands on Node：bin 包装器（botd CLI 供 BOT 脚本调用）
// ---------------------------------------------------------------------------

test('ensureBotdBinWrapper writes an executable wrapper and is idempotent', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-sdk-bin-'));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const binDir = await ensureBotdBinWrapper(dataDir);
  assert.equal(existsSync(path.join(binDir, 'botd')), true);
  if (process.platform !== 'win32') {
    assert.notEqual((await stat(path.join(binDir, 'botd'))).mode & 0o111, 0, 'wrapper must be executable');
  }
  // 幂等：再次执行不报错
  await ensureBotdBinWrapper(dataDir);
});

// ---------------------------------------------------------------------------
// Storage / installer（保持原 sdk.test.ts 的资源管理覆盖；
// 模型目录与 Provider 认证已 100% 迁至 Hub，由 tests/hub.test.ts 覆盖）
// ---------------------------------------------------------------------------

test('skill discovery reads .agents/skills and .agent/skills with precedence and symlinks', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'botd-skill-home-'));
  const dataDir = path.join(home, '.botd');
  t.after(() => rm(home, { recursive: true, force: true }));

  // Skills in the standard Agent Skills dirs inside dataDir (one symlinked).
  await mkdir(path.join(dataDir, '.agents', 'skills', 'shared-skill'), { recursive: true });
  await writeFile(path.join(dataDir, '.agents', 'skills', 'shared-skill', 'SKILL.md'), 'AGENTS_DIR_SKILL_BODY');
  const realSkill = path.join(home, 'real-skill');
  await mkdir(realSkill, { recursive: true });
  await writeFile(path.join(realSkill, 'SKILL.md'), 'SYMLINKED_SKILL_BODY');
  await mkdir(path.join(dataDir, '.agent', 'skills'), { recursive: true });
  await symlink(realSkill, path.join(dataDir, '.agent', 'skills', 'linked-skill'));

  // Home-level .agents/skills is discovered because basename(dataDir) === '.botd'.
  await mkdir(path.join(home, '.agents', 'skills', 'home-skill'), { recursive: true });
  await writeFile(path.join(home, '.agents', 'skills', 'home-skill', 'SKILL.md'), 'HOME_AGENTS_SKILL_BODY');
  await mkdir(path.join(home, '.agent', 'skills', 'legacy-skill'), { recursive: true });
  await writeFile(path.join(home, '.agent', 'skills', 'legacy-skill', 'SKILL.md'), 'HOME_AGENT_SKILL_BODY');

  const skills = await listSkills(dataDir);
  for (const expected of ['shared-skill', 'linked-skill', 'home-skill', 'legacy-skill']) {
    assert(skills.includes(expected), `listSkills must discover ${expected}, got: ${skills.join(', ')}`);
  }
  assert.equal(await readSkill(dataDir, 'shared-skill'), 'AGENTS_DIR_SKILL_BODY');
  assert.equal(await readSkill(dataDir, 'linked-skill'), 'SYMLINKED_SKILL_BODY');
  assert.equal(await readSkill(dataDir, 'home-skill'), 'HOME_AGENTS_SKILL_BODY');
  assert.equal(await readSkill(dataDir, 'legacy-skill'), 'HOME_AGENT_SKILL_BODY');
  assert.equal(
    resolveSkillDir(dataDir, 'home-skill'),
    path.join(home, '.agents', 'skills', 'home-skill')
  );

  // The writable primary dir overrides the standard dirs for the same id.
  await writeSkill(dataDir, 'shared-skill', 'PRIMARY_DIR_WINS');
  assert.equal(await readSkill(dataDir, 'shared-skill'), 'PRIMARY_DIR_WINS');
  assert.equal(resolveSkillDir(dataDir, 'shared-skill'), path.join(dataDir, 'skills', 'shared-skill'));

  // Temp test dirs (basename !== .botd) stay isolated from the home-level dirs.
  const isolated = await mkdtemp(path.join(tmpdir(), 'botd-skill-isolated-'));
  t.after(() => rm(isolated, { recursive: true, force: true }));
  assert.equal((await listSkills(isolated)).length, 0);
  assert(!getSkillSearchDirs(isolated).some(dir => dir.startsWith(home)));

  // BOTD_SKILLS_DIRS appends extra roots.
  const extra = path.join(home, 'extra-skills');
  await mkdir(path.join(extra, 'env-skill'), { recursive: true });
  await writeFile(path.join(extra, 'env-skill', 'SKILL.md'), 'ENV_DIR_SKILL_BODY');
  const previousEnv = process.env.BOTD_SKILLS_DIRS;
  process.env.BOTD_SKILLS_DIRS = [extra, ''].join(path.delimiter);
  t.after(() => {
    if (previousEnv === undefined) delete process.env.BOTD_SKILLS_DIRS;
    else process.env.BOTD_SKILLS_DIRS = previousEnv;
  });
  assert((await listSkills(isolated)).includes('env-skill'));
  assert.equal(await readSkill(isolated, 'env-skill'), 'ENV_DIR_SKILL_BODY');

  // Deleting removes the discovered copy under the standard dirs too.
  await deleteResource(dataDir, { kind: 'skill', id: 'shared-skill' });
  const afterDelete = await listSkills(dataDir);
  assert(!afterDelete.includes('shared-skill'), `primary + standard copies must both be gone, got: ${afterDelete.join(', ')}`);
});

test('seedStorageIfEmpty seeds cli-helper into the primary dir even when .agents/skills already has skills', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'botd-skill-seed-'));
  const dataDir = path.join(home, '.botd');
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(path.join(home, '.agents', 'skills', 'preexisting'), { recursive: true });
  await writeFile(path.join(home, '.agents', 'skills', 'preexisting', 'SKILL.md'), 'PREEXISTING_SKILL');

  await seedStorageIfEmpty(dataDir, 'node_seed');

  assert.equal(await readFile(path.join(dataDir, 'skills', 'cli-helper', 'SKILL.md'), 'utf-8').then(s => s.includes('CLI Helper'), () => false), true,
    'cli-helper must be seeded into <dataDir>/skills');
  const skills = await listSkills(dataDir);
  assert(skills.includes('cli-helper'));
  assert(skills.includes('preexisting'));
});

test('installResourceToNode installs local skill dirs and nested git skill layouts', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-skill-install-'));
  const source = await mkdtemp(path.join(tmpdir(), 'botd-skill-src-'));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });

  // Local directory with SKILL.md at its root -> skill.
  const localSkill = path.join(source, 'local-skill');
  await mkdir(path.join(localSkill, 'reference'), { recursive: true });
  await writeFile(path.join(localSkill, 'SKILL.md'), '# Local Skill\nInstalled from a directory.');
  await writeFile(path.join(localSkill, 'reference', 'notes.md'), 'reference content');
  await mkdir(path.join(localSkill, '.git'), { recursive: true });
  await writeFile(path.join(localSkill, '.git', 'HEAD'), 'ref: refs/heads/main');

  const local = await installResourceToNode(dataDir, { source: localSkill, kind: 'auto' });
  assert.deepEqual(local, { kind: 'skill', id: 'local-skill' });
  assert.equal(await readFile(path.join(dataDir, 'skills', 'local-skill', 'SKILL.md'), 'utf-8'), '# Local Skill\nInstalled from a directory.');
  assert.equal(await readFile(path.join(dataDir, 'skills', 'local-skill', 'reference', 'notes.md'), 'utf-8'), 'reference content');
  assert(!(await readFile(path.join(dataDir, 'skills', 'local-skill', '.git', 'HEAD'), 'utf-8').then(() => true, () => false)), '.git must be excluded');

  // GitHub shorthand parsing: owner/repo and owner/repo@skillName.
  assert.deepEqual(parseGitSource('owner/repo'), {
    repoUrl: 'https://github.com/owner/repo.git',
    skillName: undefined,
    inferredName: 'repo',
  });
  assert.deepEqual(parseGitSource('owner/repo@my-skill'), {
    repoUrl: 'https://github.com/owner/repo.git',
    skillName: 'my-skill',
    inferredName: 'my-skill',
  });

  // Nested skills/<name>/SKILL.md layout in a local git repository: the
  // single-skill auto-selection must pick skills/packaged-skill.
  const repo = path.join(source, 'nested-repo');
  await mkdir(path.join(repo, 'skills', 'packaged-skill'), { recursive: true });
  await writeFile(path.join(repo, 'skills', 'packaged-skill', 'SKILL.md'), '# Nested Skill\nFrom skills/ layout.');
  await writeFile(path.join(repo, 'README.md'), '# repo');
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

  const nested = await installResourceToNode(dataDir, { source: `file://${repo}`, kind: 'auto' });
  assert.deepEqual(nested, { kind: 'skill', id: 'packaged-skill' });
  assert.match(await readFile(path.join(dataDir, 'skills', 'packaged-skill', 'SKILL.md'), 'utf-8'), /Nested Skill/);
});
