import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUILTIN_SKILL_ID, BUILTIN_SKILL_MD, BUILTIN_SKILL_VERSION, ensureBuiltinSkill } from '../apps/node/src/builtin-skill.js';
import { readSkill } from '../apps/node/src/storage.js';

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
