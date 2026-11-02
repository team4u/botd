import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getBotMemoryDir,
  listBotMemoryTopics,
  readNodeMemory,
  saveBot,
  writeNodeMemory,
} from '../apps/node/src/storage.js';
import {
  buildMemoryPromptSection,
  canBotWriteMemory,
  MEMORY_INDEX_MAX_LINES,
  truncateMemoryIndex,
} from '../apps/node/src/runtime/memory-prompt.js';
import type { BotConfig } from '../packages/protocol/src/index.js';

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-test',
    nodeId: 'node_test',
    name: 'Test Bot',
    description: '',
    modelProvider: 'openai',
    modelId: 'gpt-4o',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ==========================================
// 1. truncateMemoryIndex
// ==========================================

test('truncateMemoryIndex: 未超过 150 行时完整保留且不标记截断', () => {
  const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
  const result = truncateMemoryIndex(content);
  assert.equal(result.text, content);
  assert.equal(result.truncated, false);
  assert.equal(result.totalLines, 100);
});

test('truncateMemoryIndex: 恰好 150 行（边界）不截断', () => {
  const content = Array.from({ length: MEMORY_INDEX_MAX_LINES }, (_, i) => `line-${i}`).join('\n');
  const result = truncateMemoryIndex(content);
  assert.equal(result.truncated, false);
  assert.equal(result.totalLines, MEMORY_INDEX_MAX_LINES);
});

test('truncateMemoryIndex: 超过 150 行时截取前 150 行并标记', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
  const content = lines.join('\n');
  const result = truncateMemoryIndex(content);
  assert.equal(result.truncated, true);
  assert.equal(result.totalLines, 200);
  assert.equal(result.text, lines.slice(0, MEMORY_INDEX_MAX_LINES).join('\n'));
  assert.equal(result.text.endsWith(`line-${MEMORY_INDEX_MAX_LINES - 1}`), true);
});

test('truncateMemoryIndex: 支持自定义 maxLines', () => {
  const content = 'a\nb\nc\nd';
  const result = truncateMemoryIndex(content, 2);
  assert.equal(result.text, 'a\nb');
  assert.equal(result.truncated, true);
  assert.equal(result.totalLines, 4);
});

test('truncateMemoryIndex: 空内容不截断', () => {
  const result = truncateMemoryIndex('');
  assert.equal(result.text, '');
  assert.equal(result.truncated, false);
  assert.equal(result.totalLines, 0);
});

// ==========================================
// 2. canBotWriteMemory
// ==========================================

test('canBotWriteMemory: all / 未配置 toolScope 时可写', () => {
  assert.equal(canBotWriteMemory({}), true);
  assert.equal(canBotWriteMemory({ toolScope: 'all' }), true);
});

test('canBotWriteMemory: readonly 不可写', () => {
  assert.equal(canBotWriteMemory({ toolScope: 'readonly' }), false);
});

test('canBotWriteMemory: custom 须包含 edit/write/bash 之一', () => {
  assert.equal(canBotWriteMemory({ toolScope: 'custom', customTools: ['read', 'grep', 'find', 'ls'] }), false);
  assert.equal(canBotWriteMemory({ toolScope: 'custom', customTools: [] }), false);
  assert.equal(canBotWriteMemory({ toolScope: 'custom' }), false);
  assert.equal(canBotWriteMemory({ toolScope: 'custom', customTools: ['read', 'edit'] }), true);
  assert.equal(canBotWriteMemory({ toolScope: 'custom', customTools: ['write'] }), true);
  assert.equal(canBotWriteMemory({ toolScope: 'custom', customTools: ['bash'] }), true);
});

// ==========================================
// 3. buildMemoryPromptSection
// ==========================================

test('buildMemoryPromptSection: 只读模式不含 edit/write 写入引导', () => {
  const section = buildMemoryPromptSection({
    memoryMd: '记忆内容',
    canWrite: false,
  });
  assert.match(section, /\[长期记忆 \(只读\)\]/);
  assert.match(section, /记忆内容/);
  assert.equal(section.includes('edit/write 工具修改'), false, '只读模式不应出现写入引导');
  assert.equal(section.includes('可通过 ../MEMORY.md 与 ../memory'), false);
});

test('buildMemoryPromptSection: 可写模式包含维护规范与标题', () => {
  const section = buildMemoryPromptSection({
    memoryMd: '记忆内容',
    canWrite: true,
  });
  assert.match(section, /\[长期记忆 \(可通过 \.\.\/MEMORY\.md 与 \.\.\/memory\/\*\.md 更新\)\]/);
  assert.match(section, /edit\/write 工具修改/);
  assert.match(section, /memory\/<topic>\.md/);
  assert.match(section, /150 行以内/);
  assert.match(section, /skills\/<skillId>\/SKILL\.md/, '保留 Skill 学习说明');
});

test('buildMemoryPromptSection: 包含节点共享记忆段落', () => {
  const section = buildMemoryPromptSection({
    memoryMd: 'bot 记忆',
    nodeMemoryMd: '节点级共享内容',
    canWrite: true,
  });
  assert.match(section, /\[节点共享记忆 \(\.\.\/\.\.\/MEMORY\.md\)\]/);
  assert.match(section, /节点级共享内容/);
  // 节点共享记忆在最前
  assert.ok(section.indexOf('节点级共享内容') < section.indexOf('bot 记忆'));
});

test('buildMemoryPromptSection: 节点共享记忆为空时不输出该段落', () => {
  const section = buildMemoryPromptSection({
    memoryMd: 'bot 记忆',
    nodeMemoryMd: '   ',
    canWrite: true,
  });
  assert.equal(section.includes('节点共享记忆'), false);
});

test('buildMemoryPromptSection: memoryTopics 输出主题文件索引列表', () => {
  const section = buildMemoryPromptSection({
    memoryMd: '记忆',
    memoryTopics: ['coding-style.md', 'topology.md'],
    canWrite: true,
  });
  assert.match(section, /\[已归档主题记忆目录 \(按需通过 read\/grep 查阅 \.\.\/memory\/<文件名>\)\]/);
  assert.match(section, /- \.\.\/memory\/coding-style\.md/);
  assert.match(section, /- \.\.\/memory\/topology\.md/);
});

test('buildMemoryPromptSection: 子代理回退到主 Bot 的 parentMemoryMd（自身记忆为空）', () => {
  const section = buildMemoryPromptSection({
    memoryMd: '',
    parentMemoryMd: '主 Bot 的记忆',
    canWrite: true,
  });
  assert.match(section, /主 Bot 的记忆/);
});

test('buildMemoryPromptSection: 子代理合并主 Bot 记忆与自身记忆（主 Bot 在前）', () => {
  const section = buildMemoryPromptSection({
    memoryMd: '子代理专属记忆',
    parentMemoryMd: '主 Bot 的记忆',
    canWrite: true,
  });
  assert.match(section, /主 Bot 的记忆/);
  assert.match(section, /子代理专属记忆/);
  assert.ok(section.indexOf('主 Bot 的记忆') < section.indexOf('子代理专属记忆'), '主 Bot 记忆应在前');
});

test('buildMemoryPromptSection: parentMemoryMd 与自身相同内容不重复展示', () => {
  const section = buildMemoryPromptSection({
    memoryMd: '相同记忆',
    parentMemoryMd: '相同记忆',
    canWrite: true,
  });
  assert.equal(section.split('相同记忆').length - 1, 1, '相同内容只出现一次');
});

test('buildMemoryPromptSection: 超过 150 行附加截断提示', () => {
  const longMemory = Array.from({ length: 200 }, (_, i) => `mem-${i}`).join('\n');
  const section = buildMemoryPromptSection({
    memoryMd: longMemory,
    canWrite: true,
  });
  assert.match(section, /⚠️ MEMORY\.md 共 200 行/);
  assert.match(section, /仅内联展示前 150 行索引/);
  assert.match(section, /read 工具读取/);
  assert.equal(section.includes('mem-199'), false, '截断后不应包含第 200 行');
});

// ==========================================
// 4. 存储层：memory 目录 / 主题文件 / 节点记忆
// ==========================================

test('saveBot 自动创建 bots/<botId>/memory 目录', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-memory-test-'));
  try {
    const dataDir = path.join(dir, 'data');
    await saveBot(dataDir, makeBot({ id: 'bot-mem' }));
    assert.equal(existsSync(path.join(dataDir, 'bots', 'bot-mem', 'memory')), true, 'saveBot 应创建 memory 目录');
    assert.equal(existsSync(getBotMemoryDir(dataDir, 'bot-mem')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listBotMemoryTopics: 列出 .md 主题文件（字母序），忽略非 md 与子目录', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-memory-test-'));
  try {
    const dataDir = path.join(dir, 'data');
    const memoryDir = path.join(dataDir, 'bots', 'bot-topics', 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'topology.md'), '# Topology');
    await writeFile(path.join(memoryDir, 'architecture.md'), '# Architecture');
    await writeFile(path.join(memoryDir, 'notes.txt'), 'not markdown');
    await mkdir(path.join(memoryDir, 'subdir.md'), { recursive: true });

    const topics = await listBotMemoryTopics(dataDir, 'bot-topics');
    assert.deepEqual(topics, ['architecture.md', 'topology.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listBotMemoryTopics: 目录不存在时返回空数组', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-memory-test-'));
  try {
    const topics = await listBotMemoryTopics(path.join(dir, 'data'), 'no-such-bot');
    assert.deepEqual(topics, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readNodeMemory / writeNodeMemory: 正确读写节点级 MEMORY.md', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-memory-test-'));
  try {
    const dataDir = path.join(dir, 'data');
    // 未写入前返回空串
    assert.equal(await readNodeMemory(dataDir), '');
    await writeNodeMemory(dataDir, '# 节点共享记忆\n- 机房拓扑: A 栋');
    assert.equal(await readNodeMemory(dataDir), '# 节点共享记忆\n- 机房拓扑: A 栋');
    assert.equal(existsSync(path.join(dataDir, 'MEMORY.md')), true);
    // 覆写
    await writeNodeMemory(dataDir, 'updated');
    assert.equal(await readNodeMemory(dataDir), 'updated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
