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
      onRunWatchdog: async () => ({ healthy: true, summary: 'System healthy: 1 live task.' }),
      ...extraProps,
    })
  );
}

test('WorkersDrawer SSR（列表）: 有 Worker 时渲染任务行与巡检按钮，手动派发入口已移除', { timeout: 60_000 }, () => {
  const html = renderWorkersDrawer();

  // worker 行本尊
  assert.match(html, /修复鉴权模块/, 'worker 行标题应渲染');
  assert.match(html, /后台子任务/, '抽屉标题应渲染');

  // 列表顶栏常驻巡检入口（任务由对话中自然语言派发，抽屉只做检视与干预）
  assert.match(html, /title="运行 Watchdog 巡检"/, '列表顶栏应有巡检按钮');

  // 手动派发按钮与表单不再渲染
  assert.doesNotMatch(html, /派发后台 Worker/, '不应再渲染手动派发按钮');
  assert.doesNotMatch(html, /立即派发/, '不应再渲染手动派发表单提交');
}, { timeout: 60_000 });

test('WorkersDrawer SSR（列表）: 零 Worker 时空态引导自然语言派发，仍可巡检', { timeout: 60_000 }, () => {
  const html = renderWorkersDrawer({ workers: [] });
  assert.match(html, /title="运行 Watchdog 巡检"/);
  assert.match(html, /暂无后台任务/, '空态应提示暂无后台任务');
  assert.match(html, /自然语言/, '空态应引导在对话中用自然语言派发');
  assert.doesNotMatch(html, /派发后台 Worker/, '不应再渲染手动派发按钮');
}, { timeout: 60_000 });

test('WorkersDrawer SSR（列表）: 未传入回调时不渲染巡检入口', { timeout: 60_000 }, () => {
  const html = renderWorkersDrawer({ onRunWatchdog: undefined });
  assert.doesNotMatch(html, /运行 Watchdog 巡检/, '未提供 onRunWatchdog 时不应渲染巡检按钮');
}, { timeout: 60_000 });

test('WorkersDrawer 源码: 手动派发表单与 onSpawnWorker 已彻底移除', { timeout: 60_000 }, () => {
  // SSR 无法点击；直接验证源码结构（派发表单、状态与提交行为全部清理干净）
  const source = readFileSync(path.join(webSrc, 'components/WorkersDrawer.tsx'), 'utf-8');

  assert.ok(!source.includes('onSpawnWorker'), 'WorkersDrawerProps 不应再保留 onSpawnWorker');
  assert.ok(!source.includes('showSpawnForm'), '不应再保留 showSpawnForm 状态');
  assert.ok(!source.includes('handleSpawn'), '不应再保留 handleSpawn 提交逻辑');
  assert.ok(!source.includes('立即派发'), '不应再保留「立即派发」提交按钮');
  assert.ok(!source.includes('任务标题（如：修复鉴权模块）'), '不应再保留标题输入框');
  assert.ok(!source.includes('直通线程键'), '不应再保留 threadKey 输入框');
  // Watchdog 巡检与详情干预保持完整
  assert.match(source, /title="运行 Watchdog 巡检"/, '巡检按钮应保留');
  assert.match(source, /人工干预记录/, '详情视图 Steer/Follow-up 时间线应保留');
}, { timeout: 60_000 });

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
}, { timeout: 60_000 });

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
}, { timeout: 60_000 });

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
}, { timeout: 60_000 });

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
}, { timeout: 60_000 });

test('ChatView.tsx: 巡检回调与外部 Worker 检视已接线到后台子任务抽屉', { timeout: 60_000 }, () => {
  const source = readFileSync(path.join(webSrc, 'components/ChatView.tsx'), 'utf-8');
  assert.ok(!source.includes('onSpawnWorker'), '手动派发 onSpawnWorker 接线应移除');
  assert.ok(!source.includes('spawnBackgroundWorker'), '不应再解构 spawnBackgroundWorker');
  assert.match(source, /api\.getWatchdogHealth\(true\)/, '巡检回调应调用 api.getWatchdogHealth(true)（runPass）');
  assert.match(source, /onRunWatchdog=\{runWatchdog\}/, 'WorkersDrawer 应接线 onRunWatchdog');
  assert.match(source, /<WorkersDrawer/, 'ChatView 应挂载 WorkersDrawer');
  // 外部（如侧边栏）点击 Worker 可直接打开抽屉定位详情
  assert.match(
    source,
    /inspectWorkerRequest\?: \{ workerId: string \| null; seq: number \} \| null;/,
    'ChatViewProps 应声明 inspectWorkerRequest'
  );
  assert.match(
    source,
    /openWorkersDrawer\(inspectWorkerRequest\.workerId\)/,
    'inspectWorkerRequest 变化时应打开抽屉并定位到目标 Worker'
  );
  assert.doesNotMatch(source, /ActiveWorkersBar/, 'ActiveWorkersBar 横栏应彻底移除');
  assert.doesNotMatch(source, /showWorkerToolsBar/, 'showWorkerToolsBar 状态应彻底清理');
}, { timeout: 60_000 });

test('ChatView.tsx: 顶栏 ⚡ 子任务角标已接线，回执卡不再提供死链入口', { timeout: 60_000 }, () => {
  const source = readFileSync(path.join(webSrc, 'components/ChatView.tsx'), 'utf-8');
  // 顶栏 Zap 角标：零任务完全隐藏
  assert.match(source, /superAgent\.workers\.length > 0 && \(/, '零 worker 时 Zap 按钮应完全隐藏');
  assert.match(source, /aria-label=\{workersTitle\}/, 'Zap 按钮应带动态 aria-label');
  // 单 worker 直达详情水合
  assert.match(source, /superAgent\.setSelectedWorkerId\(workerId\);/, '单 worker 点击应水合 recall');
  // Worker 轨迹存在内存，历史会话不可回看：回执卡不提供「查看详情」死链
  assert.doesNotMatch(source, /onOpenWorker/, '回执卡 onOpenWorker 接线应移除');
}, { timeout: 60_000 });

test('MessageItem.tsx: Worker 完成回执卡是纯凭条（无链接、无截断摘要折叠）', { timeout: 60_000 }, () => {
  const source = readFileSync(path.join(webSrc, 'components/MessageItem.tsx'), 'utf-8');
  assert.doesNotMatch(source, /onOpenWorker/, 'MessageItem 不应再有 onOpenWorker prop');
  assert.match(source, /const isWorkerReceipt = title === '后台任务完成';/, 'Worker 回执凭条判定');
  assert.match(source, /!isWorkerReceipt && childSessionId/, 'Worker 回执不渲染子会话链接');
  assert.match(source, /detailBody !== null && !isWorkerReceipt/, 'Worker 回执省略 200 字截断摘要折叠区');
}, { timeout: 60_000 });

// ============================================================
// 4. /clear 内置斜杠命令：原地清空会话消息与上下文（保留 Worker）
// ============================================================

test('slash.ts: BUILTIN_SESSION_COMMANDS 含 /clear（清空会话消息与上下文）', () => {
  const source = readFileSync(path.join(webSrc, 'components/ChatInput/slash.ts'), 'utf-8');
  assert.match(source, /name: 'clear',/, '/clear 命令应注册');
  assert.match(source, /清空当前会话消息与上下文/, '/clear 描述应说明原地清空语义');
  assert.match(source, /保留当前会话与后台任务/, '/clear 描述应说明保留会话与后台任务');
}, { timeout: 60_000 });

test('useSessionMessages.ts: /clear 走 handleClearMessages(sid, { keepWorkers: true })', () => {
  const source = readFileSync(path.join(webSrc, 'hooks/useSessionMessages.ts'), 'utf-8');
  // 命令分支：紧跟 /new 之后，原地清空不换会话
  assert.match(
    source,
    /content\.trim\(\) === '\/clear'/,
    'handleSendMessage 应识别 /clear 命令'
  );
  assert.match(
    source,
    /handleClearMessages\(sid, \{ keepWorkers: true \}\)/,
    '/clear 应以 keepWorkers: true 原地清空（保留后台 Worker）'
  );
  // API 层：DELETE 携带 keepWorkers=1 查询参数
  const apiSource = readFileSync(path.join(webSrc, 'api.ts'), 'utf-8');
  assert.match(
    apiSource,
    /options\?\.keepWorkers \? '\?keepWorkers=1' : ''/,
    'clearSessionMessages 应拼装 keepWorkers=1 查询参数'
  );
}, { timeout: 60_000 });
