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

const { WorkersDrawer } = await import('../apps/web/src/components/WorkersDrawer.js' as any);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const webSrc = path.resolve(repoRoot, 'apps/web/src');

// ============================================================
// 1. WorkersDrawer SSR（列表视图）：worker 行 + 派发 / Watchdog 巡检入口
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

function renderWorkersDrawer(extraProps: Record<string, unknown> = {}): string {
  const noop = () => {};
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkersDrawer as React.FC<Record<string, unknown>>, {
      isOpen: true,
      workers: [makeWorker()],
      botMap: new Map(),
      nodeMap: new Map(),
      onSelectWorker: noop,
      onStopWorker: noop,
      onSpawnWorker: async () => true,
      onRunWatchdog: async () => ({ healthy: true, summary: 'System healthy: 1 live task.' }),
      ...extraProps,
    })
  );
}

test('WorkersDrawer SSR（列表）: 有 Worker 时渲染任务行与巡检/派发按钮', { timeout: 60_000 }, () => {
  const html = renderWorkersDrawer();

  // worker 行本尊
  assert.match(html, /修复鉴权模块/, 'worker 行标题应渲染');
  assert.match(html, /后台子任务/, '抽屉标题应渲染');

  // 列表顶栏常驻巡检与派发入口（横栏时代的挤压问题不复存在，抽屉里可以常驻）
  assert.match(html, /title="运行 Watchdog 巡检"/, '列表顶栏应有巡检按钮');
  assert.match(html, /aria-label="派发后台 Worker"/, '列表顶栏应有派发按钮');
});

test('WorkersDrawer SSR（列表）: 零 Worker 时仍可派发首个任务与巡检', { timeout: 60_000 }, () => {
  const html = renderWorkersDrawer({ workers: [] });
  assert.match(html, /aria-label="派发后台 Worker"/);
  assert.match(html, /title="运行 Watchdog 巡检"/);
  assert.match(html, /暂无后台任务/, '空态应提示暂无后台任务');
});

test('WorkersDrawer SSR（列表）: 未传入回调时不渲染动作入口', { timeout: 60_000 }, () => {
  const html = renderWorkersDrawer({ onSpawnWorker: undefined, onRunWatchdog: undefined });
  assert.doesNotMatch(html, /派发后台 Worker/, '未提供 onSpawnWorker 时不应渲染派发按钮');
  assert.doesNotMatch(html, /运行 Watchdog 巡检/, '未提供 onRunWatchdog 时不应渲染巡检按钮');
});

test('WorkersDrawer 源码: 派发表单含标题/指令/worktree/threadKey/立即派发', { timeout: 60_000 }, () => {
  // SSR 无法点击；直接验证源码结构（展开派发表单后渲染的字段与提交行为）
  const source = readFileSync(path.join(webSrc, 'components/WorkersDrawer.tsx'), 'utf-8');

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

test('WorkersDrawer SSR（列表）: 失败置顶，终态折叠为分组头', { timeout: 60_000 }, () => {
  const html = renderWorkersDrawer({
    workers: [
      makeWorker({ workerId: 'w-done', title: '已完成的任务', status: 'completed' }),
      makeWorker({ workerId: 'w-bad', title: '失败的任务', status: 'failed' }),
    ],
  });

  // 终态默认折叠为分组头「已完成 · N」，不直接铺开
  assert.match(html, /已完成 · 1/, '终态应折叠为分组头');
  assert.doesNotMatch(html, /已完成的任务/, '终态行默认不渲染（折叠）');

  // 失败任务置顶直出（含详情入口）
  const failedIdx = html.indexOf('失败的任务');
  const doneGroupIdx = html.indexOf('已完成 · 1');
  assert.ok(failedIdx >= 0, '失败任务应渲染');
  assert.ok(doneGroupIdx > failedIdx, '失败任务应排在终态分组之前');
});

// ============================================================
// 2. WorkersDrawer SSR（详情视图）：Watchdog 巡检动作 + 遥测徽标
// ============================================================

test('WorkersDrawer SSR（详情）: initialWorkerId 直达详情并渲染 Watchdog 巡检动作', { timeout: 60_000 }, () => {
  const noop = () => {};
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkersDrawer as React.FC<Record<string, unknown>>, {
      isOpen: true,
      workers: [makeWorker({ toolUses: 3, tokens: 1234 })],
      botMap: new Map(),
      nodeMap: new Map(),
      initialWorkerId: 'w-1',
      onSelectWorker: noop,
      onStopWorker: noop,
      onSpawnWorker: async () => true,
      onRunWatchdog: async () => ({ healthy: true, summary: 'System healthy.' }),
      onClose: noop,
    })
  );

  // 详情视图：返回按钮 + 标题 + Watchdog 巡检动作
  assert.match(html, /aria-label="返回任务列表"/, '详情视图应有返回列表按钮');
  assert.match(html, /修复鉴权模块/, '详情视图应渲染 worker 标题');
  assert.match(html, /Watchdog 巡检/, '详情顶栏应渲染「Watchdog 巡检」动作');
  assert.match(html, /title="运行 Watchdog 巡检"/, '巡检按钮应带 title 提示');

  // 遥测徽标仍正常渲染
  assert.match(html, /3 次工具调用/, '工具调用次数徽标应渲染');
  assert.match(html, /Tokens 1,234/, 'Token 徽标应渲染');
});

test('WorkersDrawer SSR: isOpen=false 时不渲染', { timeout: 60_000 }, () => {
  const noop = () => {};
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkersDrawer as React.FC<Record<string, unknown>>, {
      isOpen: false,
      workers: [makeWorker()],
      botMap: new Map(),
      nodeMap: new Map(),
      onSelectWorker: noop,
      onStopWorker: noop,
      onClose: noop,
    })
  );
  assert.equal(html, '');
});

// ============================================================
// 3. Node 死桩清理 + ChatView 接线
// ============================================================

test('daemon.ts: Node 侧废弃 RPC 死桩已全部移除', { timeout: 60_000 }, () => {
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

test('ChatView.tsx: 派发与巡检回调已接线到后台子任务抽屉', { timeout: 60_000 }, () => {
  const source = readFileSync(path.join(webSrc, 'components/ChatView.tsx'), 'utf-8');
  assert.match(source, /onSpawnWorker=\{spawnBackgroundWorker\}/, 'WorkersDrawer 应接线 onSpawnWorker');
  assert.match(source, /const \{ spawnBackgroundWorker \} = superAgent;/, '应从 useSuperAgentWorkers 解构 spawnBackgroundWorker');
  assert.match(source, /api\.getWatchdogHealth\(true\)/, '巡检回调应调用 api.getWatchdogHealth(true)（runPass）');
  assert.match(source, /onRunWatchdog=\{runWatchdog\}/, 'WorkersDrawer 应接线 onRunWatchdog');
  assert.match(source, /<WorkersDrawer/, 'ChatView 应挂载 WorkersDrawer');
  assert.doesNotMatch(source, /ActiveWorkersBar/, 'ActiveWorkersBar 横栏应彻底移除');
  assert.doesNotMatch(source, /showWorkerToolsBar/, 'showWorkerToolsBar 状态应彻底清理');
});

test('ChatView.tsx: 顶栏 ⚡ 子任务角标已接线，回执卡不再提供死链入口', { timeout: 60_000 }, () => {
  const source = readFileSync(path.join(webSrc, 'components/ChatView.tsx'), 'utf-8');
  // 顶栏 Zap 角标：零任务完全隐藏
  assert.match(source, /superAgent\.workers\.length > 0 && \(/, '零 worker 时 Zap 按钮应完全隐藏');
  assert.match(source, /aria-label=\{workersTitle\}/, 'Zap 按钮应带动态 aria-label');
  // 单 worker 直达详情水合
  assert.match(source, /superAgent\.setSelectedWorkerId\(workerId\);/, '单 worker 点击应水合 recall');
  // Worker 轨迹存在内存，历史会话不可回看：回执卡不提供「查看详情」死链
  assert.doesNotMatch(source, /onOpenWorker/, '回执卡 onOpenWorker 接线应移除');
});

test('MessageItem.tsx: Worker 完成回执卡是纯凭条（无链接、无截断摘要折叠）', { timeout: 60_000 }, () => {
  const source = readFileSync(path.join(webSrc, 'components/MessageItem.tsx'), 'utf-8');
  assert.doesNotMatch(source, /onOpenWorker/, 'MessageItem 不应再有 onOpenWorker prop');
  assert.match(source, /const isWorkerReceipt = title === '后台任务完成';/, 'Worker 回执凭条判定');
  assert.match(source, /!isWorkerReceipt && childSessionId/, 'Worker 回执不渲染子会话链接');
  assert.match(source, /detailBody !== null && !isWorkerReceipt/, 'Worker 回执省略 200 字截断摘要折叠区');
});
