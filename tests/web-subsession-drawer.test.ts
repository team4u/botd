import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// 拦截 CSS 导入（ChatView -> Markdown -> katex.min.css），避免 Node.js 原生 ESM 报 ERR_UNKNOWN_FILE_EXTENSION
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

test('1. SubSessionDrawer 模块导出完整：组件 + Props + 状态辅助函数', async () => {
  const drawerModule = (await import('../apps/web/src/components/SubSessionDrawer.js' as any)) as {
    SubSessionDrawer: unknown;
    SubSessionDrawerProps?: unknown;
    subSessionStatusLabel?: (status: 'idle' | 'running' | 'queued' | 'failed') => string;
    subSessionStatusBadgeClass?: (status: 'idle' | 'running' | 'queued' | 'failed') => string;
  };

  assert.equal(typeof drawerModule.SubSessionDrawer, 'function', 'SubSessionDrawer 组件应可导出');
  assert.equal(
    typeof drawerModule.subSessionStatusLabel,
    'function',
    'subSessionStatusLabel 辅助函数应可导出'
  );
  assert.equal(
    typeof drawerModule.subSessionStatusBadgeClass,
    'function',
    'subSessionStatusBadgeClass 辅助函数应可导出'
  );

  // 四种会话状态均有明确文案（completed 走 idle 分支）
  assert.equal(drawerModule.subSessionStatusLabel!('running'), '运行中');
  assert.equal(drawerModule.subSessionStatusLabel!('queued'), '排队中');
  assert.equal(drawerModule.subSessionStatusLabel!('failed'), '失败');
  assert.equal(drawerModule.subSessionStatusLabel!('idle'), '已完成');
});

test('2. ChatView 正常导出且内联检视接线不破坏既有导出', async () => {
  const chatViewModule = (await import('../apps/web/src/components/ChatView.js' as any)) as {
    ChatView: unknown;
    pickPollIntervalMs: (hasActiveWork: boolean) => number;
  };

  assert.equal(typeof chatViewModule.ChatView, 'function', 'ChatView 组件应可导出');
  assert.equal(typeof chatViewModule.pickPollIntervalMs, 'function');
  assert.equal(chatViewModule.pickPollIntervalMs(true), 5000);
  assert.equal(chatViewModule.pickPollIntervalMs(false), 30000);
});

test('3. 子会话内联检视遵循字号与控件尺寸约定（AGENTS.md）', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const repoRoot = process.cwd().replace(/\\/g, '/');
  const drawerPath = path.join(repoRoot, 'apps/web/src/components/SubSessionDrawer.tsx');
  const source = await fs.readFile(drawerPath, 'utf-8');

  // 标题字号：抽屉标题 text-sm font-semibold
  assert.match(source, /text-sm font-semibold/, '抽屉标题应为 text-sm font-semibold');
  // 输入控件：h-8 px-2.5 text-xs rounded-lg
  assert.match(
    source,
    /h-8 px-2\.5 text-xs rounded-lg/,
    '输入框应满足 h-8 px-2.5 text-xs rounded-lg'
  );
  // 发送按钮：h-8 w-8 rounded-lg
  assert.match(source, /h-8 w-8 rounded-lg/, '发送按钮应为 h-8 w-8 rounded-lg');
  // 停止按钮配色
  assert.match(source, /bg-rose-600 hover:bg-rose-500/, '停止按钮应为 rose 配色');
  // 次级小字 / mono ID
  assert.match(source, /font-mono text-\[11px\]/, '会话 ID 应为 font-mono text-[11px]');
  // 禁止控件上使用 rounded-xl
  assert.doesNotMatch(source, /rounded-xl/, '控件不得使用 rounded-xl');
});

test('4. ChatView 子任务药丸点击打开内联抽屉而非跳转', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const repoRoot = process.cwd().replace(/\\/g, '/');
  const chatViewPath = path.join(repoRoot, 'apps/web/src/components/ChatView.tsx');
  const source = await fs.readFile(chatViewPath, 'utf-8');

  // 状态与派生逻辑
  assert.match(source, /inspectingSubSessionId/, '应持有 inspectingSubSessionId 状态');
  assert.match(
    source,
    /subSessions\.find\(\(s\) => s\.id === inspectingSubSessionId\)/,
    '应从 subSessions 派生 inspectingSubSession'
  );
  // 药丸按钮：就地打开抽屉，不再 window.location.hash 跳转
  assert.match(
    source,
    /setInspectingSubSessionId\(sub\.id\)/,
    '子任务药丸点击应调用 setInspectingSubSessionId'
  );
  // 消息正文内 #?s=sess_ 链接拦截
  assert.match(
    source,
    /#\\\?s=\(sess_\[a-zA-Z0-9_\-\]\+\)/,
    '应拦截 #?s=sess_... 形态的子会话链接'
  );
  // 抽屉渲染接线
  assert.match(source, /<SubSessionDrawer/, '应渲染 SubSessionDrawer 组件');
});
