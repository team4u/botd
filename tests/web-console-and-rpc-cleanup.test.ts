import test from 'node:test';
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 拦截 CSS 导入（组件链路 -> Markdown -> katex.min.css），避免 Node.js 原生 ESM 报 ERR_UNKNOWN_FILE_EXTENSION
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

const req = createRequire(import.meta.resolve('../apps/web/package.json'));
const React = req('react');
const ReactDOMServer = req('react-dom/server');

const { ActiveWorkersBar } = await import('../apps/web/src/components/ActiveWorkersBar.js' as any);
const { WorkerInspectDrawer } = await import('../apps/web/src/components/WorkerInspectDrawer.js' as any);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const webSrc = path.resolve(repoRoot, 'apps/web/src');

// ============================================================
// 1. ActiveWorkersBar SSR：派发任务 + Watchdog 巡检入口
// ============================================================

function makeWorker(overrides: Record<string, unknown> = {}) {
  return {
    workerId: 'w-1',
    conversationId: '',
    parentSessionId: 's-1',
    botId: 'pm-claude',
    botName: 'PM Claude',
    title: '修复鉴权模块',
    kind: 'worker',
    status: 'running',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderWorkersBar(extraProps: Record<string, unknown> = {}): string {
  const noop = () => {};
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(ActiveWorkersBar as React.FC<Record<string, unknown>>, {
      workers: [makeWorker()],
      onSelectWorker: noop,
      onStopWorker: noop,
      onSpawnWorker: async () => true,
      onRunWatchdog: async () => ({ healthy: true, summary: 'System healthy: 1 live task.' }),
      ...extraProps,
    })
  );
}

test('ActiveWorkersBar SSR: 派发任务与巡检按钮随胶囊一起渲染', () => {
  const html = renderWorkersBar();

  // Worker 胶囊本尊
  assert.match(html, /修复鉴权模块/, 'worker 胶囊标题应渲染');

  // 巡检按钮（title 提示 + 文案）
  assert.match(html, /title="运行 Watchdog 巡检"/, '巡检按钮应带 title="运行 Watchdog 巡检"');
  assert.match(html, /巡检/, '「巡检」按钮文案应渲染');

  // 派发任务按钮（aria-label + 文案）
  assert.match(html, /aria-label="派发后台 Worker"/, '派发按钮应带 aria-label="派发后台 Worker"');
  assert.match(html, /派发任务/, '「+ 派发任务」按钮文案应渲染');
});

test('ActiveWorkersBar SSR: 零 Worker 时仍可派发首个任务与巡检', () => {
  const html = renderWorkersBar({ workers: [] });
  assert.match(html, /aria-label="派发后台 Worker"/);
  assert.match(html, /title="运行 Watchdog 巡检"/);
  assert.doesNotMatch(html, /0 个后台任务已完成/);
  assert.equal(renderWorkersBar({ workers: [], onSpawnWorker: undefined, onRunWatchdog: undefined }), '');
});

test('ActiveWorkersBar SSR: 未传入回调时不渲染动作入口（保持既有外观）', () => {
  const html = renderWorkersBar({ onSpawnWorker: undefined, onRunWatchdog: undefined });
  assert.doesNotMatch(html, /派发后台 Worker/, '未提供 onSpawnWorker 时不应渲染派发按钮');
  assert.doesNotMatch(html, /运行 Watchdog 巡检/, '未提供 onRunWatchdog 时不应渲染巡检按钮');
});

test('ActiveWorkersBar SSR: 派发表单打开时渲染标题/指令/worktree/threadKey/立即派发', () => {
  // SSR 无法点击；直接验证源码结构（打开 showSpawnForm 后渲染的表单字段与提交行为）
  const source = readFileSync(path.join(webSrc, 'components/ActiveWorkersBar.tsx'), 'utf-8');

  assert.match(source, /任务标题（如：修复鉴权模块）/, '标题输入框 placeholder 应存在');
  assert.match(source, /后台任务指令\.\.\./, '任务指令 placeholder 应存在');
  assert.match(source, /Git Worktree 隔离/, 'worktree 隔离复选框应存在');
  assert.match(source, /直通线程键（可选，如 github:pr#42）/, 'threadKey 输入框 placeholder 应存在');
  assert.match(source, /立即派发/, '「立即派发」提交按钮应存在');
  assert.match(
    source,
    /onSpawnWorker\(\{\s*title,\s*task,\s*worktree: spawnWorktree,/s,
    '提交应组装 title/task/worktree（threadKey 非空才携带）'
  );
});

// ============================================================
// 2. WorkerInspectDrawer SSR：Watchdog 巡检动作
// ============================================================

test('WorkerInspectDrawer SSR: 提供回调时渲染 Watchdog 巡检动作', () => {
  const noop = () => {};
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkerInspectDrawer as React.FC<Record<string, unknown>>, {
      isOpen: true,
      worker: makeWorker({ toolUses: 3, tokens: 1234 }),
      onClose: noop,
      onSteer: async () => true,
      onStop: noop,
      onRunWatchdog: async () => ({ healthy: true, summary: 'System healthy.' }),
    })
  );

  // Watchdog 巡检动作（抽屉头部按钮）
  assert.match(html, /Watchdog 巡检/, '抽屉头部应渲染「Watchdog 巡检」动作');
  assert.match(html, /title="运行 Watchdog 巡检"/, '巡检按钮应带 title 提示');

  // 遥测徽标仍正常渲染
  assert.match(html, /3 次工具调用/, '工具调用次数徽标应渲染');
  assert.match(html, /Tokens 1,234/, 'Token 徽标应渲染');
});

// ============================================================
// 3. Node 死桩清理 + ChatView 接线
// ============================================================

test('daemon.ts: Node 侧废弃 RPC 死桩已全部移除', () => {
  const source = readFileSync(path.join(repoRoot, 'apps/node/src/daemon.ts'), 'utf-8');
  for (const name of [
    'startProviderLogin',
    'getProviderLogin',
    'respondProviderLogin',
    'cancelProviderLogin',
    'logoutProvider',
    'stopSubagent',
    'interactSubagent',
    'steerBotTurn',
  ]) {
    assert.ok(!source.includes(name), `daemon.ts 不应再包含死桩 ${name}`);
  }
});

test('ChatView.tsx: 派发与巡检回调已接线到胶囊条与检视抽屉', () => {
  const source = readFileSync(path.join(webSrc, 'components/ChatView.tsx'), 'utf-8');
  assert.match(source, /onSpawnWorker=\{spawnBackgroundWorker\}/, 'ActiveWorkersBar 应接线 onSpawnWorker');
  assert.match(source, /const \{ spawnBackgroundWorker \} = superAgent;/, '应从 useSuperAgentWorkers 解构 spawnBackgroundWorker');
  assert.match(source, /api\.getWatchdogHealth\(true\)/, '巡检回调应调用 api.getWatchdogHealth(true)（runPass）');
  assert.match(source, /onRunWatchdog=\{runWatchdog\}/, '胶囊条与检视抽屉均应接线 onRunWatchdog');
});
