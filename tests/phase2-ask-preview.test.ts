import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { register } from 'node:module';
import type { SessionRecord, BotConfig } from '../packages/protocol/src/index.js';
import { isBotConfig } from '../packages/protocol/src/index.js';

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
test('pickCurrentDirectSession 排除带 parentSessionId 的子会话，防止篡位主单聊入口', { timeout: 60_000 }, async () => {
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

test('pickCurrentDirectSession 无子会话时仍正常取最新主单聊', { timeout: 60_000 }, async () => {
  const { pickCurrentDirectSession } = await loadSidebarModule();
  const a = { id: 'sess_a', archived: false, leadBotId: 'bot_1', updatedAt: new Date(Date.now() - 60_000).toISOString() } as any;
  const b = { id: 'sess_b', archived: false, leadBotId: 'bot_1', updatedAt: new Date().toISOString() } as any;
  assert.equal(pickCurrentDirectSession([a, b], 'bot_1')?.id, 'sess_b');
});

// ---------------------------------------------------------------------------
// Sidebar global pending-approvals inbox has been removed (session-view AskCard is the sole entry)
// ---------------------------------------------------------------------------
test('Sidebar 不再包含全局待确认收件箱（含 10s 轮询）', { timeout: 60_000 }, async () => {
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
test('团队共享 Bot 携带 visibility/isTeamShared 标识', { timeout: 60_000 }, () => {
  const base = {
    id: 'bot_team', nodeId: 'node_1', name: 'Shared Bot', description: '',
    modelProvider: 'anthropic', modelId: 'claude-sonnet-4-5', enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  // 协议层校验：团队共享 Bot（visibility: 'team' + isTeamShared: true）必须能通过 isBotConfig
  const teamBot = { ...base, visibility: 'team', isTeamShared: true } as BotConfig;
  assert.equal(isBotConfig(teamBot), true, '团队共享 Bot 必须是合法 BotConfig');
  // 私有 Bot（默认不带标识）同样合法；visibility 白名单外的取值必须被拒绝
  assert.equal(isBotConfig({ ...base }), true);
  assert.equal(isBotConfig({ ...base, visibility: 'org' }), false, 'visibility 只允许 private/team');
  assert.equal(isBotConfig({ ...base, visibility: 'private', isTeamShared: false }), true);
});
