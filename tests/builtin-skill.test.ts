import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUILTIN_SKILL_ID, BUILTIN_SKILL_MD, BUILTIN_SKILL_REFERENCES, BUILTIN_SKILL_VERSION, ensureBuiltinSkill } from '../apps/node/src/builtin-skill.js';
import { readSkill } from '../apps/node/src/storage.js';
import { parseGitSource } from '../apps/node/src/installer.js';
import { cleanupEphemeralAgents } from '../apps/node/src/runtime/bot-context.js';

const skillFile = (dir: string) => path.join(dir, 'skills', BUILTIN_SKILL_ID, 'SKILL.md');
const referenceFile = (dir: string, name: string) =>
  path.join(dir, 'skills', BUILTIN_SKILL_ID, 'references', name);

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

test('ensureBuiltinSkill writes all three references/ files beside SKILL.md', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-builtin-references-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await ensureBuiltinSkill(dir);

  const names = ['subagents-and-workflows.md', 'generative-ui.md', 'extension-and-skill-dev.md'];
  for (const name of names) {
    assert.equal(await readFile(referenceFile(dir, name), 'utf8'), BUILTIN_SKILL_REFERENCES[name]);
  }

  // A deleted reference self-heals on the next call, without touching SKILL.md
  await rm(referenceFile(dir, 'generative-ui.md'), { force: true });
  await ensureBuiltinSkill(dir);
  assert.equal(await readFile(referenceFile(dir, 'generative-ui.md'), 'utf8'), BUILTIN_SKILL_REFERENCES['generative-ui.md']);
});

test('builtin skill documents ephemeral tmp-* subagents at version 14', () => {
  assert.equal(BUILTIN_SKILL_VERSION, 14);
  assert.match(BUILTIN_SKILL_MD, /tmp-<role>\.md/);
  assert.match(BUILTIN_SKILL_MD, /tmp-skeptic/);
  assert.match(BUILTIN_SKILL_MD, /Ephemeral subagents/);
  assert.match(BUILTIN_SKILL_MD, /Persistent subagents/);
  // 临时子代理在回合结束时自动清理的说明
  assert.match(BUILTIN_SKILL_MD, /自动删除所有 .tmp-\*\.md./);
});

test('builtin skill main file is lean and points at references (progressive disclosure)', () => {
  // 主文件控制在 80~95 行以内
  assert.ok(BUILTIN_SKILL_MD.split('\n').length <= 95, `SKILL.md too long: ${BUILTIN_SKILL_MD.split('\n').length} lines`);
  // 正文必须指引按需 read 参考文档
  assert.match(BUILTIN_SKILL_MD, /references\/subagents-and-workflows\.md/);
  assert.match(BUILTIN_SKILL_MD, /references\/generative-ui\.md/);
  assert.match(BUILTIN_SKILL_MD, /references\/extension-and-skill-dev\.md/);
  // 17 个组件名列表保留在正文摘要中
  for (const component of ['Stack', 'Card', 'Tabs', 'Accordion', 'MetricGrid', 'MetricCard', 'BarList', 'KeyValueList', 'Table', 'Callout', 'Steps', 'TextInput', 'Select', 'Switch', 'CheckboxGroup', 'ActionBar', 'Button']) {
    assert.ok(BUILTIN_SKILL_MD.includes(component), `main file missing component: ${component}`);
  }
});

test('extension reference covers full-stack ctx.ui bridging and details.ui', () => {
  const dev = BUILTIN_SKILL_REFERENCES['extension-and-skill-dev.md'];
  // ctx.ui 桥接方法（对话框 / 实时流与挂件 / 自定义工具视图三个插槽）
  for (const api of ['ctx.ui.confirm', 'ctx.ui.select', 'ctx.ui.input', 'ctx.ui.editor', 'ctx.ui.custom', 'ctx.ui.notify', 'ctx.ui.setStatus', 'ctx.ui.setWorkingMessage', 'ctx.ui.setWidget', 'ctx.ui.setEditorText', 'ctx.ui.pasteToEditor', 'details.ui']) {
    assert.ok(dev.includes(api), `reference missing API: ${api}`);
  }
  // Web 端不可用的纯 TUI 方法说明
  assert.match(dev, /setFooter/);
  assert.match(dev, /setHeader/);
  assert.match(dev, /setEditorComponent/);
  // 可直接复制运行的完整 TypeScript 扩展
  assert.match(dev, /export default function \(pi: ExtensionAPI\)/);
  assert.match(dev, /pi\.registerTool\(/);
  assert.match(dev, /pi\.registerCommand\(/);
  assert.match(dev, /pi\.on\('tool_call'/);
});

test('generative-ui reference documents all 17 botd.v1 components with state binding', () => {
  const ui = BUILTIN_SKILL_REFERENCES['generative-ui.md'];
  for (const component of ['Stack', 'Card', 'Tabs', 'Accordion', 'MetricGrid', 'MetricCard', 'BarList', 'KeyValueList', 'Table', 'Callout', 'Steps', 'TextInput', 'Select', 'Switch', 'CheckboxGroup', 'ActionBar', 'Button']) {
    assert.ok(ui.includes(`\`${component}\``), `UI reference missing component: ${component}`);
  }
  assert.match(ui, /\{ "\$state": "\/key" \}/);
  assert.match(ui, /"root": "page"/);
});

test('subagent reference keeps the full tmp-* recipe and workflow pipeline', () => {
  const sub = BUILTIN_SKILL_REFERENCES['subagents-and-workflows.md'];
  assert.match(sub, /tmp-skeptic/);
  assert.match(sub, /botd bots create reviewer --node "\$BOTD_NODE_ID" --parent "\$BOTD_BOT_ID"/);
  assert.match(sub, /botd sessions delegate/);
  assert.match(sub, /resumeFromRunId/);
  assert.match(sub, /agentType: "@bot_builder"/);
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

test('parseGitSource understands Pi git: prefixes and @ref suffixes', () => {
  // git: shorthand host + tag
  const a = parseGitSource('git:github.com/owner/repo@v1.0.0');
  assert.equal(a.repoUrl, 'https://github.com/owner/repo.git');
  assert.equal(a.branch, 'v1.0.0');
  assert.equal(a.inferredName, 'repo');

  // git: full https URL + branch
  const b = parseGitSource('git:https://github.com/owner/repo@main');
  assert.equal(b.repoUrl, 'https://github.com/owner/repo.git');
  assert.equal(b.branch, 'main');

  // plain https URL with @ref
  const c = parseGitSource('https://github.com/owner/repo@v1');
  assert.equal(c.repoUrl, 'https://github.com/owner/repo.git');
  assert.equal(c.branch, 'v1');

  // git: without a ref still normalizes
  const d = parseGitSource('git:github.com/owner/repo');
  assert.equal(d.repoUrl, 'https://github.com/owner/repo.git');
  assert.equal(d.branch, undefined);
  assert.equal(d.inferredName, 'repo');

  // classic GitHub tree URL keeps working
  const e = parseGitSource('https://github.com/owner/repo/tree/main/skills/my-skill');
  assert.equal(e.repoUrl, 'https://github.com/owner/repo.git');
  assert.equal(e.branch, 'main');
  assert.equal(e.subPath, 'skills/my-skill');
  assert.equal(e.inferredName, 'my-skill');

  // owner/repo@skillName shorthand keeps treating the suffix as a skill name
  const f = parseGitSource('owner/repo@my-skill');
  assert.equal(f.repoUrl, 'https://github.com/owner/repo.git');
  assert.equal(f.skillName, 'my-skill');
  assert.equal(f.inferredName, 'my-skill');
});
