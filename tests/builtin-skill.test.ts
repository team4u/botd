import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUILTIN_SKILL_ID, BUILTIN_SKILL_MD, BUILTIN_SKILL_VERSION, ensureBuiltinSkill } from '../apps/node/src/builtin-skill.js';
import { readSkill } from '../apps/node/src/storage.js';
import { cleanupEphemeralAgents } from '../apps/node/src/runtime/bot-context.js';

const skillFile = (dir: string) => path.join(dir, 'skills', BUILTIN_SKILL_ID, 'SKILL.md');

test('ensureBuiltinSkill seeds the builtin CLI skill and stays idempotent', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-builtin-skill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. Fresh data dir: skill is created with the version marker
  await ensureBuiltinSkill(dir);
  assert.equal(await readSkill(dir, BUILTIN_SKILL_ID), BUILTIN_SKILL_MD);

  // 2. User edits at the same version are preserved (no rewrite)
  const edited = BUILTIN_SKILL_MD.replace('## Rules', '## Rules (customized)');
  await writeFile(skillFile(dir), edited, 'utf8');
  await ensureBuiltinSkill(dir);
  assert.equal(await readFile(skillFile(dir), 'utf8'), edited);

  // 3. Older-version content (marker mismatch) is upgraded to the shipped one
  await writeFile(skillFile(dir), `<!-- botd-skill: ${BUILTIN_SKILL_ID} v${BUILTIN_SKILL_VERSION - 1} -->\nold`, 'utf8');
  await ensureBuiltinSkill(dir);
  assert.equal(await readFile(skillFile(dir), 'utf8'), BUILTIN_SKILL_MD);
});

test('builtin skill documents ephemeral tmp-* subagents at version 12', () => {
  assert.equal(BUILTIN_SKILL_VERSION, 12);
  assert.match(BUILTIN_SKILL_MD, /tmp-<role>\.md/);
  assert.match(BUILTIN_SKILL_MD, /tmp-skeptic/);
  assert.match(BUILTIN_SKILL_MD, /Ephemeral subagents/);
  assert.match(BUILTIN_SKILL_MD, /Persistent subagents/);
  // 临时子代理在回合结束时自动清理的说明
  assert.match(BUILTIN_SKILL_MD, /自动删除所有 .tmp-\*\.md./);
});

test('cleanupEphemeralAgents removes tmp-*.md but keeps persistent agent files', async t => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'botd-ephemeral-agents-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const agentsDir = path.join(agentDir, 'agents');
  await mkdir(agentsDir, { recursive: true });

  const persistent = '# reviewer\n你是一名严谨的代码审查专家。';
  await writeFile(path.join(agentsDir, 'tmp-skeptic.md'), '---\nname: tmp-skeptic\n---\n红队', 'utf8');
  await writeFile(path.join(agentsDir, 'tmp-architect_1.md'), '---\nname: tmp-architect_1\n---\n架构', 'utf8');
  await writeFile(path.join(agentsDir, 'reviewer.md'), persistent, 'utf8');

  await cleanupEphemeralAgents(agentDir);

  await assert.rejects(access(path.join(agentsDir, 'tmp-skeptic.md')));
  await assert.rejects(access(path.join(agentsDir, 'tmp-architect_1.md')));
  assert.equal(await readFile(path.join(agentsDir, 'reviewer.md'), 'utf8'), persistent);
});

test('cleanupEphemeralAgents tolerates a missing agents dir', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'botd-no-agents-'));
  await rm(agentDir, { recursive: true, force: true });
  await cleanupEphemeralAgents(agentDir); // must not throw
});
