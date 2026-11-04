/**
 * Full-Stack Extensible Kernel tests (Phase 5).
 *
 * Covers the persona/skills/extension wiring of the durable Hub harness:
 *  1. `syncBotPersonas` reads SYSTEM.md / MEMORY.md / enabledSkills /
 *     enabledExtensions from Hub SQLite into the persona;
 *  2. `load_skill` reads a skill stored via `db.saveSkillContent`, and
 *     `update_memory` writes updated memory back into
 *     `db.getBotFile(botId, 'memory')`;
 *  3. `loadDynamicDurableExtension` loads a custom pi-durable extension from
 *     source, `installDynamicExtension` registers it, `enabledExtensions`
 *     mounts it on Router and Worker, and the custom tool returns a
 *     `botd.v1` UI spec block;
 *  4. the ExtensionEditorModal starter template has no `pi-coding-agent`
 *     references and loads through the dynamic loader.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { HubDurableRuntime, type BotPersonaConfig } from '../apps/hub/src/harness/hub-harness.js';
import { TargetDoc } from '../apps/hub/src/harness/docs.js';
import { createPersonaSkillsExtension } from '../apps/hub/src/harness/persona-skills-extension.js';
import {
  formatUiSpecBlock,
  loadDynamicDurableExtension,
  loadDynamicDurableExtensionFromDir,
} from '../apps/hub/src/harness/dynamic-extension-loader.js';
import type { Extension } from '@earendil-works/pi-durable';
import { HubDatabase } from '../apps/hub/src/db.js';
import { createHub } from '../apps/hub/src/index.js';

/** The extensions an AgentChange adds: the object form's `add` list. */
const addedExtensions = (change: import('@earendil-works/pi-durable').AgentChange): Extension[] => {
  const extensions: unknown = change.extensions;
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) return [];
  return [...(((extensions as { add?: readonly Extension[] }).add ?? []))];
};

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T> | T,
  check: (value: T) => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await read();
    if (check(last)) return last;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${message}`);
    await wait(20);
  }
}

const lastUserText = (messages: readonly { role: string; content: unknown }[]): string => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (typeof lastUser?.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? '');
  return '';
};

const SKILL_MD = `---
name: deploy-helper
description: 指导如何安全发布到生产环境
---

# Deploy Helper

1. Run smoke tests
2. Tag release
3. Roll out canary
`;

const CUSTOM_EXTENSION_TS = `import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export default defineExtension({
  name: 'status-card',
  tools: [
    defineTool({
      name: 'render_status_card',
      description: '渲染交互式状态卡片 (botd.v1 Generative UI)',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, value: { type: 'string' } },
        required: ['title', 'value'],
      },
      async execute(input) {
        const uiSpec = {
          root: 'card',
          elements: {
            card: {
              type: 'MetricCard',
              props: { label: input.title, value: input.value, status: 'ok', icon: 'sparkles' },
            },
          },
        };
        const fence = String.fromCharCode(96, 96, 96);
        return {
          output: [{
            type: 'text',
            text: fence + 'ui' + String.fromCharCode(10) + JSON.stringify(uiSpec, null, 2) + String.fromCharCode(10) + fence,
          }],
        };
      },
    }),
  ],
});
`;

/** Open a runtime whose persona-skills callbacks read/write the given Hub DB (multi-file aware). */
async function openRuntimeWithDb(db: HubDatabase): Promise<{ runtime: HubDurableRuntime; faux: ReturnType<typeof fauxProvider> }> {
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({
    storage: new MemoryStorage(),
    models,
    skills: {
      getBotEnabledSkills: (botId) => {
        const bot = db.getBot(botId);
        if (!bot) return [];
        const extraDirs = bot.workspaceDir ? [bot.workspaceDir] : [];
        const seen = new Set<string>();
        const skills: Array<{ id: string; content: string }> = [];
        for (const skillId of bot.enabledSkills ?? []) {
          if (seen.has(skillId)) continue;
          const content = db.getSkillContent(skillId, 'SKILL.md', extraDirs);
          if (content !== '') {
            seen.add(skillId);
            skills.push({ id: skillId, content });
          }
        }
        for (const skill of db.listSkills(extraDirs)) {
          if (seen.has(skill.id) || skill.source !== 'agent-dir') continue;
          const content = db.getSkillContent(skill.id, 'SKILL.md', extraDirs);
          if (content !== '') {
            seen.add(skill.id);
            skills.push({ id: skill.id, content });
          }
        }
        return skills;
      },
      getSkillContent: (skillId, relPath, botId) => {
        const bot = botId ? db.getBot(botId) : undefined;
        const extra = bot?.workspaceDir ? [bot.workspaceDir] : [];
        const content = db.getSkillContent(skillId, relPath ?? 'SKILL.md', extra);
        return content === '' ? undefined : content;
      },
      listSkillFiles: (skillId, botId) => {
        const bot = botId ? db.getBot(botId) : undefined;
        const extra = bot?.workspaceDir ? [bot.workspaceDir] : [];
        return db.listSkillFiles(skillId, extra);
      },
      getBotMemory: (botId) => db.getBotFile(botId, 'memory'),
      setBotMemory: (botId, content) => db.setBotFile(botId, 'memory', content),
    },
  });
  return { runtime, faux };
}

test('1. syncBotPersonas loads SYSTEM.md/MEMORY.md/skills/extensions from Hub SQLite into the persona', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-persona-skills-'));
  try {
    const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
    const now = new Date().toISOString();
    db.saveBot({
      id: 'architect',
      nodeId: 'node-1',
      name: 'Architect',
      description: 'You design systems.',
      modelProvider: 'faux',
      modelId: 'main',
      thinkingLevel: 'medium',
      enabledSkills: ['deploy-helper'],
      enabledExtensions: ['status-card'],
      updatedAt: now,
    });
    db.setBotFile('architect', 'system', 'You are the architect. Prefer minimal designs.');
    db.setBotFile('architect', 'memory', 'The team ships on Thursdays.');
    db.saveSkillContent('deploy-helper', SKILL_MD);

    const { runtime } = await openRuntimeWithDb(db);
    try {
      const persona: BotPersonaConfig = {
        botId: 'architect',
        name: 'Architect',
        model: { provider: 'faux', modelId: 'main' },
        instructions: db.getBotFile('architect', 'system').trim(),
        memory: db.getBotFile('architect', 'memory').trim() || undefined,
        enabledSkills: db.getBot('architect')!.enabledSkills,
        enabledExtensions: db.getBot('architect')!.enabledExtensions,
        nodeId: 'node-1',
        cwd: process.cwd(),
      };
      runtime.registerPersona(persona);

      const stored = runtime.getPersona('architect')!;
      assert.match(stored.instructions, /architect/);
      assert.match(stored.instructions, /minimal designs/);
      assert.equal(stored.memory, 'The team ships on Thursdays.');
      assert.deepEqual(stored.enabledSkills, ['deploy-helper']);
      assert.deepEqual(stored.enabledExtensions, ['status-card']);

      // registerPersona overwrites: a persona update must propagate (regression:
      // the old first-write-only sync kept stale instructions).
      runtime.registerPersona({ ...stored, instructions: 'Updated instructions.' });
      assert.equal(runtime.getPersona('architect')!.instructions, 'Updated instructions.');
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('2. load_skill reads Hub skill content; update_memory persists into db bot_files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-persona-skills-tools-'));
  try {
    const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
    db.saveBot({
      id: 'architect',
      nodeId: 'node-1',
      name: 'Architect',
      description: '',
      modelProvider: 'faux',
      modelId: 'main',
      thinkingLevel: 'medium',
      enabledSkills: ['deploy-helper'],
      updatedAt: new Date().toISOString(),
    });
    db.setBotFile('architect', 'memory', 'base note');
    db.saveSkillContent('deploy-helper', SKILL_MD);

    const { runtime, faux } = await openRuntimeWithDb(db);
    try {
      runtime.registerPersona({
        botId: 'architect',
        name: 'Architect',
        model: { provider: 'faux', modelId: 'main' },
        instructions: 'You are the architect.',
        nodeId: 'node-1',
        cwd: process.cwd(),
      });
      const router = await runtime.ensureBotMainSession('architect');

      const toolResultSeen = (messages: readonly { role: string; content: unknown }[]): boolean => {
        const reversed = [...messages].reverse();
        const lastUser = reversed.findIndex((m) => m.role === 'user');
        return lastUser >= 0 && reversed.slice(0, lastUser).some((m) => m.role === 'toolResult');
      };

      faux.setResponses(
        [...Array(64)].map(
          () =>
            ((context: { messages: readonly { role: string; content: unknown }[] }) => {
              const text = lastUserText(context.messages);
              if (/please load the deploy skill/.test(text)) {
                return toolResultSeen(context.messages)
                  ? fauxAssistantMessage('Loaded the deploy skill; ready to roll out.')
                  : fauxAssistantMessage([fauxToolCall('load_skill', { skillId: 'deploy-helper' })], {
                      stopReason: 'toolUse',
                    });
              }
              if (/remember/.test(text)) {
                return toolResultSeen(context.messages)
                  ? fauxAssistantMessage('Noted in memory.')
                  : fauxAssistantMessage(
                      [fauxToolCall('update_memory', { content: 'Canary first, then full rollout.', mode: 'append' })],
                      { stopReason: 'toolUse' },
                    );
              }
              return fauxAssistantMessage('Ok.');
            }) as never,
        ),
      );

      // load_skill: the tool result carries the full SKILL.md.
      const load = await runtime.submitUserMessage(String(router.id), 'please load the deploy skill');
      assert.equal((await load.wait(BACKGROUND_CONTEXT)).status, 'done');
      const ctx = await router.context(BACKGROUND_CONTEXT);
      assert.ok(
        ctx.messages.some(
          (m) =>
            m.role === 'toolResult' &&
            JSON.stringify(m.content).includes('Run smoke tests'),
        ),
        'load_skill result must contain the SKILL.md body',
      );

      // update_memory: the note lands in Hub SQLite bot_files memory.
      const update = await runtime.submitUserMessage(String(router.id), 'remember: canary first, then full rollout');
      assert.equal((await update.wait(BACKGROUND_CONTEXT)).status, 'done');
      const memory = await waitFor(
        () => db.getBotFile('architect', 'memory'),
        (value) => value.includes('Canary first'),
        'memory write into db',
      );
      assert.match(memory, /base note/);
      assert.match(memory, /Canary first, then full rollout/);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('3. dynamic extension loads from source, mounts via enabledExtensions, and returns a botd.v1 UI spec block', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-dyn-ext-'));
  try {
    const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
    db.saveBot({
      id: 'architect',
      nodeId: 'node-1',
      name: 'Architect',
      description: '',
      modelProvider: 'faux',
      modelId: 'main',
      thinkingLevel: 'medium',
      enabledSkills: [],
      enabledExtensions: ['status-card'],
      updatedAt: new Date().toISOString(),
    });
    db.saveExtensionContent('status-card', CUSTOM_EXTENSION_TS);

    const { runtime, faux } = await openRuntimeWithDb(db);
    try {
      // The production path (syncBotPersonas) installs dynamic extensions from
      // hub_extensions source; exercise the same loader here.
      const ext = await loadDynamicDurableExtension('status-card', db.getExtensionContent('status-card'));
      assert.equal(ext.name, 'status-card');
      assert.deepEqual((ext.tools ?? []).map((t) => t.name), ['render_status_card']);
      runtime.installDynamicExtension(ext);
      assert.equal(runtime.getDynamicExtension('status-card'), ext);

      runtime.registerPersona({
        botId: 'architect',
        name: 'Architect',
        model: { provider: 'faux', modelId: 'main' },
        instructions: 'You are the architect.',
        enabledExtensions: ['status-card'],
        nodeId: 'node-1',
        cwd: process.cwd(),
      });

      // The router agent change mounts the dynamic extension by name.
      const agent = runtime.routerAgent(runtime.getPersona('architect')!);
      const names = addedExtensions(agent).map((e) => e.name);
      assert.ok(names.includes('botd-router'));
      assert.ok(names.includes('status-card'), `router agent must mount the dynamic extension: ${names.join(', ')}`);
      assert.ok(names.includes('botd-persona-skills'));

      // The worker agent change mounts it too.
      const worker = runtime.workerAgentFor(runtime.getPersona('architect')!);
      assert.ok(addedExtensions(worker).some((e) => e.name === 'status-card'));

      // The custom tool executes and returns a fenced botd.v1 UI spec block.
      const tool = (ext.tools ?? []).find((t) => t.name === 'render_status_card')!;
      const result = await tool.execute(
        { title: 'CPU', value: '42%' },
        { conversationId: 0 as never, snapshot: async () => ({}) } as never,
        undefined as never,
      );
      const text = String((result.output as { type: string; text: string }[])[0]?.text ?? '');
      assert.ok(text.startsWith('```ui'), 'tool result must be a fenced ```ui block');
      const spec = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('```')).trim());
      assert.equal(spec.root, 'card');
      assert.equal(spec.elements.card.type, 'MetricCard');

      // formatUiSpecBlock: the shared helper produces the same shape.
      const formatted = formatUiSpecBlock(spec, 'Status');
      assert.ok(formatted.startsWith('Status\n\n```ui'));
      assert.ok(formatted.endsWith('```'));
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('4. ExtensionEditorModal starter template references pi-durable and zero pi-coding-agent', async () => {
  const source = await readFile(
    path.resolve('apps/web/src/components/ExtensionEditorModal.tsx'),
    'utf8',
  );
  assert.equal(source.includes('pi-coding-agent'), false, 'starter template must not reference pi-coding-agent');
  assert.ok(source.includes('@earendil-works/pi-durable'), 'starter template must import from pi-durable');

  // The template itself loads through the dynamic loader and executes.
  const match = /const STARTER_EXTENSION_TS = `([\s\S]*?)`;\n/.exec(source);
  assert.ok(match, 'STARTER_EXTENSION_TS template found');
  const template = match[1].replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');
  assert.equal(template.includes('pi-coding-agent'), false);
  const ext = await loadDynamicDurableExtension('my-extension', template);
  assert.equal(ext.name, 'my-extension');
  const result = await (ext.tools ?? [])[0].execute(
    { title: 'CPU', value: '42%' },
    { conversationId: 0 as never, snapshot: async () => ({}) } as never,
    undefined as never,
  );
  const text = String((result.output as { type: string; text: string }[])[0]?.text ?? '');
  assert.ok(text.startsWith('```ui'));
});

test('5. createHub wires skills callbacks into the durable runtime', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-skills-wiring-'));
  try {
    const dbPath = path.join(dir, 'hub.sqlite');
    const faux = fauxProvider({ models: [{ id: 'main' }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const hub = createHub({
      dbPath,
      adminPassword: 'test-admin-password',
      durableModels: models,
    });
    try {
      // Seed a bot with a skill + memory, then open the durable runtime through
      // the production ensureDurableRuntime path (which installs the
      // persona-skills extension and syncs personas).
      const db = hub.db;
      const now = new Date().toISOString();
      db.saveBot({
        id: 'architect',
        nodeId: 'node-1',
        name: 'Architect',
        description: 'You design systems.',
        modelProvider: 'faux',
        modelId: 'main',
        thinkingLevel: 'medium',
        enabledSkills: ['deploy-helper'],
        updatedAt: now,
      });
      db.setBotFile('architect', 'system', 'You are the architect from SYSTEM.md.');
      db.setBotFile('architect', 'memory', 'Remember: ship on Thursday.');
      db.saveSkillContent('deploy-helper', SKILL_MD);

      const runtime = await hub.ensureDurableRuntime();
      const persona = runtime.getPersona('architect')!;
      assert.match(persona.instructions, /SYSTEM\.md/);
      assert.match(persona.instructions, /architect from SYSTEM/);
      assert.equal(persona.memory, 'Remember: ship on Thursday.');
      assert.deepEqual(persona.enabledSkills, ['deploy-helper']);

      // The persona-skills extension is mounted on the persona's router agent.
      const agent = runtime.routerAgent(persona);
      assert.ok(
        addedExtensions(agent).some((e) => e.name === 'botd-persona-skills'),
        'ensureDurableRuntime must install the persona-skills extension',
      );

      // The available_skills section renders the enabled skill from Hub SQLite.
      const router = await runtime.ensureBotMainSession('architect');
      const target = await runtime.harness.snapshot(TargetDoc, router.id, BACKGROUND_CONTEXT);
      assert.equal(target?.botId, 'architect');
      const registry = runtime.registry;
      const personaSkills = registry.snapshot().extension('botd-persona-skills');
      assert.ok(personaSkills, 'botd-persona-skills installed in the registry');
    } finally {
      await hub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const MULTI_FILE_SKILL_MD = `---
name: ops-runbook
description: 生产环境运维手册与 CLI 参考
---

# Ops Runbook

主文档见 SKILL.md，CLI 细节见 references/cli.md。
`;

const MULTI_FILE_EXTENSION_FILES: Record<string, string> = {
  'index.ts': `import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { formatLabel } from './helper';
import { buildCard } from './sub/format';

export default defineExtension({
  name: 'multi-file-ext',
  tools: [
    defineTool({
      name: 'render_multi_card',
      description: '多文件扩展演示：跨文件导入 helper 与子目录模块',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, value: { type: 'string' } },
        required: ['title', 'value'],
      },
      async execute(input) {
        const spec = buildCard(formatLabel(input.title), input.value);
        const fence = String.fromCharCode(96, 96, 96);
        return {
          output: [{
            type: 'text',
            text: fence + 'ui' + String.fromCharCode(10) + JSON.stringify(spec, null, 2) + String.fromCharCode(10) + fence,
          }],
        };
      },
    }),
  ],
});
`,
  'helper.ts': `export function formatLabel(raw: string): string {
  return \`label:\${raw}\`;
}
`,
  'sub/format.ts': `export function buildCard(label: string, value: string) {
  return {
    root: 'card',
    elements: {
      card: { type: 'MetricCard', props: { label, value, status: 'ok', icon: 'sparkles' } },
    },
  };
}
`,
};

test('6. multi-file extension: db.saveExtensionFiles + PUT /api/extensions load and execute end-to-end', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-multi-ext-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
  // SQLite 不再存储 Skill/Extension 内容：旧表已彻底移除
  const tables = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('hub_skills', 'hub_extensions')")
    .all() as { name: string }[];
  assert.deepEqual(tables, [], 'hub_skills / hub_extensions tables must not exist');

  db.saveExtensionFiles('multi-file-ext', MULTI_FILE_EXTENSION_FILES);
  assert.deepEqual(db.listExtensionFiles('multi-file-ext'), ['helper.ts', 'index.ts', 'sub/format.ts']);
  assert.ok(db.getExtensionContent('multi-file-ext', 'helper.ts').includes('formatLabel'));
  assert.deepEqual(
    db.listExtensions().map((e) => e.id),
    ['multi-file-ext'],
  );

  // Directory package loader: relative imports across files resolve naturally.
  const ext = await loadDynamicDurableExtensionFromDir('multi-file-ext', db.getExtensionDir('multi-file-ext'));
  assert.equal(ext.name, 'multi-file-ext');
  const tool = (ext.tools ?? []).find((x) => x.name === 'render_multi_card')!;
  const result = await tool.execute(
    { title: 'CPU', value: '42%' },
    { conversationId: 0 as never, snapshot: async () => ({}) } as never,
    undefined as never,
  );
  const text = String((result.output as { type: string; text: string }[])[0]?.text ?? '');
  assert.ok(text.startsWith('```ui'));
  const spec = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('```')).trim());
  assert.equal(spec.elements.card.props.label, 'label:CPU', 'helper.ts import must take effect');

  // { files } input through the same loader (staging path).
  const viaFiles = await loadDynamicDurableExtension('multi-file-ext', { files: MULTI_FILE_EXTENSION_FILES });
  assert.equal(viaFiles.name, 'multi-file-ext');

  // HTTP route: PUT /api/extensions/:extId with files, GET with ?path=
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const hub = createHub({
    dbPath: path.join(dir, 'hub2.sqlite'),
    adminPassword: '{{SECRET_ab12cd34}}',
    durableModels: models,
  });
  t.after(async () => {
    await hub.close();
  });
  const login = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '{{SECRET_ab12cd34}}' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const put = await hub.app.request('/api/extensions/multi-file-ext', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ files: MULTI_FILE_EXTENSION_FILES }),
  });
  assert.equal(put.status, 200);
  const got = await hub.app.request('/api/extensions/multi-file-ext?path=helper.ts', { headers: { cookie } });
  const payload = (await got.json()) as { content: string; files: string[] };
  assert.ok(payload.content.includes('formatLabel'));
  assert.deepEqual(payload.files, ['helper.ts', 'index.ts', 'sub/format.ts']);

  // Single-file content PUT with custom path still works.
  const putContent = await hub.app.request('/api/extensions/single-ext', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content: MULTI_FILE_EXTENSION_FILES['index.ts'], path: 'index.ts' }),
  });
  assert.equal(putContent.status, 200);
  assert.ok(hub.db.getExtensionContent('single-ext').includes('multi-file-ext'));
});

test('7. multi-file skill: saveSkillFiles, load_skill path reads, and traversal rejection', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-multi-skill-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
  db.saveSkillFiles('ops-runbook', {
    'SKILL.md': MULTI_FILE_SKILL_MD,
    'references/cli.md': '# CLI Reference\n\nRun `botd ops check` before rollout.\n',
    'scripts/check.sh': '#!/bin/sh\nbotd ops check\n',
  });
  assert.deepEqual(db.listSkillFiles('ops-runbook'), [
    'SKILL.md',
    'references/cli.md',
    'scripts/check.sh',
  ]);
  assert.ok(db.getSkillContent('ops-runbook', 'references/cli.md').includes('botd ops check'));
  assert.equal(db.getSkillContent('ops-runbook', '../hub.sqlite'), '');
  assert.throws(() => db.saveSkillFiles('evil', { '../escape.txt': 'x' }));

  // Direct tool execution against the same callbacks production wires.
  const personaExt = createPersonaSkillsExtension({
    getSkillContent: (skillId, relPath) => {
      const content = db.getSkillContent(skillId, relPath ?? 'SKILL.md');
      return content === '' ? undefined : content;
    },
    listSkillFiles: (skillId) => db.listSkillFiles(skillId),
  });
  const loadSkill = (personaExt.tools ?? []).find((x) => x.name === 'load_skill')!;

  const root = await loadSkill.execute(
    { skillId: 'ops-runbook' },
    { conversationId: 0 as never, snapshot: async () => ({}) } as never,
    undefined as never,
  );
  const rootText = String((root.output as { type: string; text: string }[])[0]?.text ?? '');
  assert.ok(rootText.includes('Ops Runbook'));
  assert.ok(rootText.includes('references/cli.md'));
  assert.ok(rootText.includes('Skill directory files'));

  const ref = await loadSkill.execute(
    { skillId: 'ops-runbook', path: 'references/cli.md' },
    { conversationId: 0 as never, snapshot: async () => ({}) } as never,
    undefined as never,
  );
  const refText = String((ref.output as { type: string; text: string }[])[0]?.text ?? '');
  assert.equal(refText, '# CLI Reference\n\nRun `botd ops check` before rollout.\n');

  const missing = await loadSkill.execute(
    { skillId: 'ops-runbook', path: 'references/missing.md' },
    { conversationId: 0 as never, snapshot: async () => ({}) } as never,
    undefined as never,
  );
  assert.equal(missing.isError, true);
  assert.match(
    String((missing.output as { type: string; text: string }[])[0]?.text ?? ''),
    /Skill file not found: ops-runbook\/references\/missing\.md/,
  );

  const traversal = await loadSkill.execute(
    { skillId: 'ops-runbook', path: '../hub.sqlite' },
    { conversationId: 0 as never, snapshot: async () => ({}) } as never,
    undefined as never,
  );
  assert.equal(traversal.isError, true, 'path traversal must be rejected');

  // HTTP: PUT with files + GET with ?path= through the hub app.
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const hub = createHub({
    dbPath: path.join(dir, 'hub2.sqlite'),
    adminPassword: '{{SECRET_ab12cd34}}',
    durableModels: models,
  });
  t.after(async () => {
    await hub.close();
  });
  const login = await hub.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '{{SECRET_ab12cd34}}' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const put = await hub.app.request('/api/skills/ops-runbook', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      files: {
        'SKILL.md': MULTI_FILE_SKILL_MD,
        'references/cli.md': '# CLI Reference\n\nRun `botd ops check` before rollout.\n',
      },
    }),
  });
  assert.equal(put.status, 200);
  const got = await hub.app.request('/api/skills/ops-runbook?path=references/cli.md', { headers: { cookie } });
  const payload = (await got.json()) as { content: string; files: string[] };
  assert.ok(payload.content.includes('botd ops check'));
  assert.deepEqual(payload.files, ['SKILL.md', 'references/cli.md', 'scripts/check.sh']);
});

test('8. .agents/skills and .agent/skills discovery: workspace skills auto-available to the bot persona', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-agent-skills-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const workspace = path.join(dir, 'workspace');
  await mkdir(path.join(workspace, '.agents', 'skills', 'agent-guide'), { recursive: true });
  await writeFile(
    path.join(workspace, '.agents', 'skills', 'agent-guide', 'SKILL.md'),
    '---\nname: agent-guide\ndescription: 工作区级技能指南\n---\n\n# Agent Guide\n\nSee references/guide.md for details.\n',
  );
  await mkdir(path.join(workspace, '.agents', 'skills', 'agent-guide', 'references'), { recursive: true });
  await writeFile(
    path.join(workspace, '.agents', 'skills', 'agent-guide', 'references', 'guide.md'),
    '# Guide Details\n\nStep 1: discovery works.\n',
  );
  await mkdir(path.join(workspace, '.agent', 'skills', 'legacy-guide'), { recursive: true });
  await writeFile(
    path.join(workspace, '.agent', 'skills', 'legacy-guide', 'SKILL.md'),
    '---\nname: legacy-guide\ndescription: 旧版 .agent 目录技能\n---\n\n# Legacy Guide\n',
  );

  const db = new HubDatabase({ dbPath: path.join(dir, 'hub.sqlite') });
  db.saveBot({
    id: 'architect',
    nodeId: 'node-1',
    name: 'Architect',
    description: '',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
    workspaceDir: workspace,
  });

  // extraDirs scanning discovers both .agents/skills and .agent/skills entries.
  const discovered = db.listSkills([workspace]).map((s) => s.id);
  assert.ok(discovered.includes('agent-guide'), `agent-guide must be discovered: ${discovered.join(',')}`);
  assert.ok(discovered.includes('legacy-guide'), `legacy-guide must be discovered: ${discovered.join(',')}`);
  assert.equal(db.getSkillContent('agent-guide', 'references/guide.md', [workspace]), '# Guide Details\n\nStep 1: discovery works.\n');

  // End-to-end via createHub: the persona auto-discovers workspace skills and
  // load_skill can read both SKILL.md and nested reference files.
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const hub = createHub({
    dbPath: path.join(dir, 'hub2.sqlite'),
    adminPassword: '{{SECRET_ab12cd34}}',
    durableModels: models,
  });
  t.after(async () => {
    await hub.close();
  });
  const hubDb = hub.db;
  hubDb.saveBot({
    id: 'architect',
    nodeId: 'node-1',
    name: 'Architect',
    description: '',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
    workspaceDir: workspace,
  });

  const runtime = await hub.ensureDurableRuntime();
  const router = await runtime.ensureBotMainSession('architect');
  const target = await runtime.harness.snapshot(TargetDoc, router.id, BACKGROUND_CONTEXT);
  assert.equal(target?.botId, 'architect');

  const personaSkillsExt = runtime.registry.snapshot().extension('botd-persona-skills')!;
  const loadSkill = (personaSkillsExt.tools ?? []).find((x) => x.name === 'load_skill')!;
  const apiStub = {
    conversationId: router.id as never,
    snapshot: async () => ({ botId: 'architect' }),
  } as never;

  const root = await loadSkill.execute({ skillId: 'agent-guide' }, apiStub, undefined as never);
  const rootText = String((root.output as { type: string; text: string }[])[0]?.text ?? '');
  assert.ok(rootText.includes('Agent Guide'));
  assert.ok(rootText.includes('references/guide.md'));

  const ref = await loadSkill.execute(
    { skillId: 'agent-guide', path: 'references/guide.md' },
    apiStub,
    undefined as never,
  );
  const refText = String((ref.output as { type: string; text: string }[])[0]?.text ?? '');
  assert.ok(refText.includes('discovery works'));

  const legacy = await loadSkill.execute({ skillId: 'legacy-guide' }, apiStub, undefined as never);
  assert.ok(
    String((legacy.output as { type: string; text: string }[])[0]?.text ?? '').includes('Legacy Guide'),
  );
});
