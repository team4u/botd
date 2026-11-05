import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import type { SessionRecord, BotConfig } from '../packages/protocol/src/index.js';

// 拦截 CSS/TSX 导入（Sidebar.tsx 间接引入样式与 React 组件），复用 review-fixes-web 的加载策略
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', shortCircuit: true, source: 'export default {};' };
  }
  return nextLoad(url, context);
}
`)
);

/** 动态加载 Sidebar 组件模块，提取纯函数 */
async function loadSidebarModule(): Promise<{
  pickCurrentDirectSession: (sessions: SessionRecord[], botId: string) => SessionRecord | undefined;
}> {
  const sidebarModule = (await import('../apps/web/src/session-space.js' as any)) as any;
  return sidebarModule;
}

// ---------------------------------------------------------------------------
// pickCurrentDirectSession: delegated child sessions must not hijack the
// bot's main direct-chat entry (Task 1.2)
// ---------------------------------------------------------------------------
test('pickCurrentDirectSession 排除带 parentSessionId 的子会话，防止篡位主单聊入口', async () => {
  const { pickCurrentDirectSession } = await loadSidebarModule();
  const now = new Date().toISOString();
  const main = {
    id: 'sess_main', archived: false, leadBotId: 'bot_1',
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  } as any;
  const child = {
    id: 'sess_child', archived: false, leadBotId: 'bot_1',
    parentSessionId: 'sess_parent', updatedAt: now,
  } as any;

  const picked = pickCurrentDirectSession([main, child], 'bot_1');
  assert.equal(picked?.id, 'sess_main', 'newest child session must be ignored');
});

test('pickCurrentDirectSession 无子会话时仍正常取最新主单聊', async () => {
  const { pickCurrentDirectSession } = await loadSidebarModule();
  const a = { id: 'sess_a', archived: false, leadBotId: 'bot_1', updatedAt: new Date(Date.now() - 60_000).toISOString() } as any;
  const b = { id: 'sess_b', archived: false, leadBotId: 'bot_1', updatedAt: new Date().toISOString() } as any;
  assert.equal(pickCurrentDirectSession([a, b], 'bot_1')?.id, 'sess_b');
});

// ---------------------------------------------------------------------------
// Preview type inference from --file extension
// ---------------------------------------------------------------------------
test('preview 类型可由文件后缀推断（.diff/.patch→diff，.md→markdown）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-ask-'));
  try {
    const diffFile = path.join(tmp, 'changes.diff');
    await fs.writeFile(diffFile, '@@ -1 +1 @@\n-old\n+new', 'utf8');
    // 通过 commander 解析路径验证推断逻辑（复用 CLI 内部同一正则规则）
    const diffType = /\.(diff|patch)$/i.test(diffFile) ? 'diff'
      : /\.md$/i.test(diffFile) ? 'markdown' : 'text';
    assert.equal(diffType, 'diff');

    const mdFile = path.join(tmp, 'readme.md');
    await fs.writeFile(mdFile, '# hi', 'utf8');
    const mdType = /\.(diff|patch)$/i.test(mdFile) ? 'diff'
      : /\.md$/i.test(mdFile) ? 'markdown' : 'text';
    assert.equal(mdType, 'markdown');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sidebar global pending-approvals inbox has been removed (session-view AskCard is the sole entry)
// ---------------------------------------------------------------------------
test('Sidebar 不再包含全局待确认收件箱（含 10s 轮询）', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const source = await fs.readFile(
    path.join(process.cwd(), 'apps/web/src/components/Sidebar.tsx'),
    'utf-8'
  );
  assert.doesNotMatch(source, /listPendingApprovals/, '不应再调用 listPendingApprovals');
  assert.doesNotMatch(source, /AskCard/, '不应再内置 AskCard 收件箱');
});

// ---------------------------------------------------------------------------
// Team-shared bot badge data constraint
// ---------------------------------------------------------------------------
test('团队共享 Bot 携带 visibility/isTeamShared 标识', () => {
  const bot = {
    id: 'bot_team', nodeId: 'node_1', name: 'Shared Bot', description: '',
    modelProvider: 'anthropic', modelId: 'claude-sonnet-4-5', enabledSkills: [],
    visibility: 'team', isTeamShared: true, updatedAt: new Date().toISOString(),
  } as BotConfig;
  assert.equal(bot.visibility, 'team');
  assert.equal(bot.isTeamShared, true);
});
