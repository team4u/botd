import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_SKILL_ID,
  BUILTIN_SKILL_MD,
  BUILTIN_SKILL_REFERENCES,
  BUILTIN_SKILL_VERSION,
} from '../apps/hub/src/builtin-skill-seed.js';
import { parseGitSource } from '../apps/node/src/installer.js';

test('builtin skill seed exposes coherent id, version and file inventory', { timeout: 60_000 }, () => {
  assert.equal(BUILTIN_SKILL_ID, 'botd-cli');
  assert.equal(typeof BUILTIN_SKILL_VERSION, 'number');
  assert.ok(BUILTIN_SKILL_VERSION > 0);
  // 主文件与全部 references 都携带一致的版本标记
  const marker = `<!-- botd-skill: ${BUILTIN_SKILL_ID} v${BUILTIN_SKILL_VERSION} -->`;
  assert.ok(BUILTIN_SKILL_MD.startsWith(marker), 'SKILL.md must start with the version marker');
  for (const name of Object.keys(BUILTIN_SKILL_REFERENCES)) {
    assert.ok(
      (BUILTIN_SKILL_REFERENCES[name] as string).startsWith(marker),
      `references/${name} must start with the version marker`,
    );
  }
  // 三份参考文档齐备
  for (const name of ['subagents-and-workflows.md', 'generative-ui.md', 'extension-and-skill-dev.md']) {
    assert.ok(typeof BUILTIN_SKILL_REFERENCES[name] === 'string' && BUILTIN_SKILL_REFERENCES[name].length > 0, `missing reference: ${name}`);
  }
});

test('builtin skill documents the Super-agent toolset at version 16', { timeout: 60_000 }, () => {
  assert.equal(BUILTIN_SKILL_VERSION, 16);
  // Super-agent 工具面（Router 内置）
  assert.match(BUILTIN_SKILL_MD, /spawn_worker/);
  assert.match(BUILTIN_SKILL_MD, /delegate_to_bot/);
  assert.match(BUILTIN_SKILL_MD, /steer_worker/);
  assert.match(BUILTIN_SKILL_MD, /stop_worker/);
  assert.match(BUILTIN_SKILL_MD, /recall/);
  assert.match(BUILTIN_SKILL_MD, /SubagentWorkflow/);
  // worktree 隔离与 crash-safe memo 检查点
  assert.match(BUILTIN_SKILL_MD, /worktree/);
  assert.match(BUILTIN_SKILL_MD, /api\.memo/);
});

test('builtin skill documents the first-class Super-agent CLI surface', { timeout: 60_000 }, () => {
  for (const cmd of [
    'botd workers list',
    'botd workers spawn',
    'botd workers steer',
    'botd workers stop',
    'botd workers recall',
    'botd events ingest',
    'botd watchdog health',
    'botd asks list',
    'botd asks respond',
    'botd sessions list',
    'botd chat send',
    'botd bots create',
    'botd triggers list',
    'botd artifact put',
    'botd wake',
  ]) {
    assert.ok(BUILTIN_SKILL_MD.includes(cmd), `main file must document: ${cmd}`);
  }
});

test('builtin skill no longer teaches removed legacy commands', { timeout: 60_000 }, () => {
  // 旧架构（pi-subagents / bg / delegate / ask / install CLI）必须绝迹
  assert.ok(!/botd bg(?!\b)/.test(BUILTIN_SKILL_MD) && !BUILTIN_SKILL_MD.includes('botd bg '), 'must not teach botd bg');
  assert.ok(!/botd ask\b(?!s)/.test(BUILTIN_SKILL_MD), 'must not teach botd ask (asks is fine)');
  assert.ok(!BUILTIN_SKILL_MD.includes('botd install'), 'must not teach botd install');
  assert.ok(!BUILTIN_SKILL_MD.includes('sessions delegate'), 'must not teach sessions delegate');
  assert.ok(!BUILTIN_SKILL_MD.includes('subagent_type'), 'must not teach pi-subagents dispatch');
  assert.ok(!BUILTIN_SKILL_MD.includes('stop_subagent'), 'must not teach pi-subagents control');
});

test('builtin skill main file is lean and points at references (progressive disclosure)', { timeout: 60_000 }, () => {
  // 主文件控制在 ~100 行以内
  assert.ok(BUILTIN_SKILL_MD.split('\n').length <= 100, `SKILL.md too long: ${BUILTIN_SKILL_MD.split('\n').length} lines`);
  // 正文必须指引按需 read 参考文档
  assert.match(BUILTIN_SKILL_MD, /references\/subagents-and-workflows\.md/);
  assert.match(BUILTIN_SKILL_MD, /references\/generative-ui\.md/);
  assert.match(BUILTIN_SKILL_MD, /references\/extension-and-skill-dev\.md/);
  // 17 个组件名列表保留在正文摘要中
  for (const component of ['Stack', 'Card', 'Tabs', 'Accordion', 'MetricGrid', 'MetricCard', 'BarList', 'KeyValueList', 'Table', 'Callout', 'Steps', 'TextInput', 'Select', 'Switch', 'CheckboxGroup', 'ActionBar', 'Button']) {
    assert.ok(BUILTIN_SKILL_MD.includes(component), `main file missing component: ${component}`);
  }
});

test('extension reference covers Hub durable extensions and the Node ExtensionAPI boundary', { timeout: 60_000 }, () => {
  const dev = BUILTIN_SKILL_REFERENCES['extension-and-skill-dev.md'];
  // Hub 托管 durable extension 的唯一合法入口与工具定义
  assert.match(dev, /defineExtension\(/);
  assert.match(dev, /defineTool\(/);
  assert.match(dev, /export default defineExtension/);
  assert.match(dev, /parameters: \{/);
  // Node 本地 daemon 的 ExtensionAPI 体系（不互通，需明示边界）
  assert.match(dev, /ExtensionAPI/);
  assert.match(dev, /ctx\.ui\.\*/);
  assert.match(dev, /setFooter/);
  assert.match(dev, /setHeader/);
  assert.match(dev, /setEditorComponent/);
  // 安装与热更新命令面
  assert.match(dev, /botd nodes install/);
  assert.match(dev, /botd reload/);
});

test('generative-ui reference documents all 17 botd.v1 components with state binding', { timeout: 60_000 }, () => {
  const ui = BUILTIN_SKILL_REFERENCES['generative-ui.md'];
  for (const component of ['Stack', 'Card', 'Tabs', 'Accordion', 'MetricGrid', 'MetricCard', 'BarList', 'KeyValueList', 'Table', 'Callout', 'Steps', 'TextInput', 'Select', 'Switch', 'CheckboxGroup', 'ActionBar', 'Button']) {
    assert.ok(ui.includes(`\`${component}\``), `UI reference missing component: ${component}`);
  }
  assert.match(ui, /\{ "\$state": "\/key" \}/);
  assert.match(ui, /"root": "page"/);
});

test('worker reference documents spawn_worker lifecycle and the memoized workflow pipeline', { timeout: 60_000 }, () => {
  const sub = BUILTIN_SKILL_REFERENCES['subagents-and-workflows.md'];
  // Super-agent 工具契约
  assert.match(sub, /spawn_worker/);
  assert.match(sub, /delegate_to_bot/);
  assert.match(sub, /steer_worker/);
  assert.match(sub, /stop_worker/);
  assert.match(sub, /recall/);
  assert.match(sub, /worktree: true/);
  assert.match(sub, /botd workers list/);
  // SubagentWorkflow 流水线：agent/pipeline/parallel + crash-safe memo
  assert.match(sub, /api\.memo|memo/);
  assert.match(sub, /pipeline\(/);
  assert.match(sub, /parallel\(/);
  assert.match(sub, /schema: \{ type: "object"/);
  // 旧架构（pi-subagents、sessions delegate、--tool-scope、resumeFromRunId）绝迹
  assert.ok(!sub.includes('subagent_type'), 'must not teach pi-subagents dispatch');
  assert.ok(!sub.includes('sessions delegate'), 'must not teach sessions delegate');
  assert.ok(!sub.includes('--tool-scope'), 'must not teach --tool-scope');
  assert.ok(!sub.includes('resumeFromRunId'), 'must not teach journal-based resume');
});

test('parseGitSource understands Pi git: prefixes and @ref suffixes', { timeout: 60_000 }, () => {
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
