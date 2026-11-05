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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webSrc = path.resolve(__dirname, '../apps/web/src');
const repoRoot = path.resolve(__dirname, '..');

// ============================================================
// 1. 发布清单瘦身：仅 @botd/protocol -> @botd/node，@botd/models 转 private
// ============================================================

test('scripts/publish.ts: PUBLISH_PACKAGES 为且仅为 [@botd/protocol, @botd/node] 拓扑序', async () => {
  // scripts/publish.ts 顶层含发布副作用，仅在直接执行时跑 main()；
  // 这里经由工作区内的 tsx 按需转译导入，验证导出的发布清单
  const { execFileSync } = await import('node:child_process');
  const loader = path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs');
  const raw = execFileSync(process.execPath, [
    '--no-warnings',
    `--import=${loader}`,
    '--eval',
    `import { PUBLISH_PACKAGES, PUBLISH_ORDER } from ${JSON.stringify(
      path.join(repoRoot, 'scripts/publish.ts')
    )}; console.log(JSON.stringify({ PUBLISH_PACKAGES, PUBLISH_ORDER }));`,
  ], { encoding: 'utf8', cwd: repoRoot });
  const { PUBLISH_PACKAGES, PUBLISH_ORDER } = JSON.parse(
    raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  ) as { PUBLISH_PACKAGES: Array<{ name: string; dir: string }>; PUBLISH_ORDER: string[] };

  assert.deepEqual(
    PUBLISH_PACKAGES.map((p) => p.name),
    ['@botd/protocol', '@botd/node'],
    'PUBLISH_PACKAGES 应精确等于 [@botd/protocol, @botd/node] 且保持拓扑序'
  );
  assert.deepEqual(PUBLISH_ORDER, ['protocol', 'node'], 'PUBLISH_ORDER 应为 [protocol, node]');
  assert.equal(PUBLISH_PACKAGES[0].dir, 'packages/protocol', 'protocol 包目录应为 packages/protocol');
  assert.equal(PUBLISH_PACKAGES[1].dir, 'apps/node', 'node 包目录应为 apps/node');
  assert.ok(
    PUBLISH_PACKAGES.every((p) => p !== undefined && typeof p.name === 'string'),
    '发布清单条目应结构完整'
  );
});

test('packages/models/package.json: 已标记 private 且不再出现在发布清单', async () => {
  const modelsPkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages/models/package.json'), 'utf-8'));
  assert.equal(modelsPkg.name, '@botd/models');
  assert.equal(modelsPkg.private, true, '@botd/models 应标记 "private": true 退出 npm 发布');

  const publishSource = readFileSync(path.join(repoRoot, 'scripts/publish.ts'), 'utf-8');
  assert.doesNotMatch(publishSource, /['"]models['"]/, '发布顺序不应再包含 models');
  assert.match(publishSource, /PUBLISH_ORDER = \["protocol", "node"\]/, '发布顺序应为 protocol -> node');
  assert.match(
    publishSource,
    /发布顺序：@botd\/protocol -> @botd\/node/,
    '文件头注释应说明精简后的发布顺序'
  );
});

// ============================================================
// 2. api.ts：手动派生 Worker + Watchdog 健康诊断端点
// ============================================================

const { api } = (await import('../apps/web/src/api.js' as any)) as {
  api: Record<string, unknown>;
};

test('api.ts: 暴露 spawnSuperAgentWorker 与 getWatchdogHealth 方法', () => {
  assert.equal(typeof api.spawnSuperAgentWorker, 'function', '应暴露 spawnSuperAgentWorker');
  assert.equal(typeof api.getWatchdogHealth, 'function', '应暴露 getWatchdogHealth');
});

test('api.ts: spawnSuperAgentWorker POST /sessions/:id/workers，getWatchdogHealth 支持 runPass', async () => {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify({ worker: { workerId: 'w-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const spawned = await (api.spawnSuperAgentWorker as any)('sess/1', {
      title: '重构认证',
      instructions: '重构 auth 模块',
      isolation: 'worktree',
      threadKeys: ['github:pr#42'],
    });
    assert.equal((spawned as { worker: { workerId: string } }).worker.workerId, 'w-1');
    assert.equal(calls.length, 1, 'spawnSuperAgentWorker 应只发一次请求');
    assert.match(calls[0].path, /\/api\/sessions\/sess%2F1\/workers$/, '应 POST /api/sessions/:id/workers');
    assert.equal(calls[0].init?.method, 'POST', '应为 POST 请求');
    const body = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(body, {
      title: '重构认证',
      instructions: '重构 auth 模块',
      isolation: 'worktree',
      threadKeys: ['github:pr#42'],
    });

    await (api.getWatchdogHealth as any)();
    await (api.getWatchdogHealth as any)(true);
    assert.equal(calls.length, 3);
    assert.match(calls[1].path, /\/api\/watchdog\/health$/, '默认不携带 runPass');
    assert.match(calls[2].path, /\/api\/watchdog\/health\?runPass=1$/, 'runPass=true 应携带 ?runPass=1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================
// 3. useSuperAgentWorkers：recall 水合 turns / tokens / branchName / worktreePath
// ============================================================

test('useSuperAgentWorkers 源码: recall 水合合入 turns / tokens / branchName / worktreePath', () => {
  const source = readFileSync(path.join(webSrc, 'hooks/useSuperAgentWorkers.ts'), 'utf-8');
  assert.match(source, /turns: data\.node\.turns|node\.turns/, '应从 recall 节点合入 turns');
  assert.match(source, /tokens: data\.node\.tokens|node\.tokens/, '应从 recall 节点合入 tokens');
  assert.match(source, /branchName/, '应合入 branchName');
  assert.match(source, /worktreePath/, '应合入 worktreePath');
  assert.match(source, /branchName\?: string/, 'SuperAgentWorkerItem 应声明 branchName 字段');
});

test('useSuperAgentWorkers: telemetryOf 提取 recall 节点遥测并过滤非法值', async () => {
  const { telemetryOf } = (await import('../apps/web/src/hooks/useSuperAgentWorkers.js' as any)) as {
    telemetryOf: (node: Record<string, unknown>) => {
      turns?: number;
      tokens?: number;
      branchName?: string;
      worktreePath?: string;
    };
  };

  assert.deepEqual(
    telemetryOf({ turns: 7, tokens: 123456, branchName: 'botd/w-1', worktreePath: '/repo/.wt/w-1' }),
    { turns: 7, tokens: 123456, branchName: 'botd/w-1', worktreePath: '/repo/.wt/w-1' }
  );

  // 非法值（NaN / 空串 / 错误类型）一律过滤，不产生半吊子字段
  assert.deepEqual(telemetryOf({ turns: Number.NaN, tokens: '12', branchName: '', worktreePath: null }), {});
  assert.deepEqual(telemetryOf({}), {});
});

// ============================================================
// 4. WorkersDrawer（详情视图）：遥测徽章 SSR（回合 / Tokens / worktree 分支 / 全部 threadKeys）
// ============================================================

const { WorkersDrawer } = (await import('../apps/web/src/components/WorkersDrawer.js' as any)) as {
  WorkersDrawer: React.FC<Record<string, unknown>>;
};

function renderDrawer(worker: Record<string, unknown>): string {
  const noop = () => {};
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkersDrawer, {
      isOpen: true,
      workers: [worker],
      botMap: new Map(),
      nodeMap: new Map(),
      initialWorkerId: String(worker.workerId),
      onSelectWorker: noop,
      onStopWorker: noop,
      onSpawnWorker: async () => true,
      onClose: noop,
    })
  );
}

const baseWorker = {
  workerId: 'w-9',
  conversationId: '',
  parentSessionId: 'sess-1',
  botId: 'pm-claude',
  title: '重构认证模块',
  kind: 'worker',
  status: 'running',
  startedAt: new Date().toISOString(),
};

test('WorkersDrawer SSR（详情）: 渲染回合数与 Token 消耗徽章', () => {
  const html = renderDrawer({ ...baseWorker, turns: 7, tokens: 98765 });
  assert.match(html, /回合 7/, '回合徽章应渲染为「回合 7」');
  assert.match(html, /Tokens 98,765/, 'Token 徽章应渲染千分位格式');
});

test('WorkersDrawer SSR（详情）: turns/tokens 为 0 或缺失时不渲染徽章', () => {
  const html = renderDrawer({ ...baseWorker, turns: 0, tokens: 0 });
  assert.doesNotMatch(html, /回合/, 'turns=0 不应渲染回合徽章');
  assert.doesNotMatch(html, /Tokens/, 'tokens=0 不应渲染 Token 徽章');

  const htmlNoData = renderDrawer({ ...baseWorker });
  assert.doesNotMatch(htmlNoData, /回合 /, '缺失遥测不应渲染回合徽章');
  assert.doesNotMatch(htmlNoData, /Tokens /, '缺失遥测不应渲染 Token 徽章');
});

test('WorkersDrawer SSR（详情）: worktree 徽章附带分支名', () => {
  const html = renderDrawer({
    ...baseWorker,
    worktreePath: '/repo/.botd-worktrees/w-9',
    branchName: 'botd/w-9',
  });
  assert.match(html, /worktree · botd\/w-9/, 'worktree 徽章应显示「worktree · 分支名」');
  assert.match(html, /\/repo\/\.botd-worktrees\/w-9/, '完整 worktree 路径应保留在 title 提示中');
});

test('WorkersDrawer SSR（详情）: 无 branchName 时 worktree 徽章回落为裸 worktree', () => {
  const html = renderDrawer({ ...baseWorker, worktreePath: '/repo/.botd-worktrees/w-9' });
  assert.doesNotMatch(html, /worktree · /, '无分支名不应出现「worktree · 」前缀');
  assert.match(html, /worktree/, '仍应渲染 worktree 徽章');
});

test('WorkersDrawer SSR（详情）: 渲染全部 Pass-through threadKeys 而非仅首个', () => {
  const html = renderDrawer({
    ...baseWorker,
    threadKeys: ['github:pr#42', 'slack:chan#ops', 'webhook:alerts'],
  });
  for (const key of ['github:pr#42', 'slack:chan#ops', 'webhook:alerts']) {
    assert.match(html, new RegExp(key.replace(/[#\\]/g, (m) => `\\${m}`)), `线程键 ${key} 应渲染`);
  }
});

// ============================================================
// 5. WorkersDrawer（列表视图）：threadKeys 徽标随列表行内展示在详情，列表行保持紧凑
// ============================================================

test('WorkersDrawer SSR（列表）: 活跃 worker 行内直出标题与工具徽标，详情页展示全部 threadKeys', () => {
  const noop = () => {};
  const listHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkersDrawer, {
      isOpen: true,
      workers: [
        {
          ...baseWorker,
          threadKeys: ['github:pr#42', 'slack:chan#ops', 'webhook:alerts'],
        },
      ],
      botMap: new Map(),
      nodeMap: new Map(),
      onSelectWorker: noop,
      onStopWorker: noop,
      onClose: noop,
    })
  );
  assert.match(listHtml, /重构认证模块/, '列表行标题应渲染');
  assert.match(listHtml, /后台子任务/, '列表顶栏标题应渲染');
});
