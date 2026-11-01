import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.resolve('../apps/web/package.json'));
const React = req('react');
const ReactDOMServer = req('react-dom/server');

import { api, ApiError } from '../apps/web/src/api.js';
import { ConfirmDialog } from '../apps/web/src/components/ConfirmDialog.js';
import type { NodeUpgradeCheckResult, NodeUpgradeResult, NodeWithBots } from '../packages/protocol/src/index.js';

// Dynamically import NodesBotsView so tsc in tsconfig.tests.json does not traverse into sibling web components
const { NodesBotsView } = await import('../apps/web/src/components/NodesBotsView.js' as any);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 1. api.ts: checkNodeUpgrade and upgradeNode Regression Tests
// ============================================================

test('api.checkNodeUpgrade: issues GET request to /api/nodes/:nodeId/upgrade/check with proper encoding', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;

  const mockResult: NodeUpgradeCheckResult = {
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
  };

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return new Response(JSON.stringify(mockResult), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const res = await api.checkNodeUpgrade('node-test-123');
    assert.equal(requestedUrl, '/api/nodes/node-test-123/upgrade/check');
    assert.equal(requestedOptions?.credentials, 'include');
    assert.deepEqual(res, mockResult);

    // Verify URI encoding
    await api.checkNodeUpgrade('node/with:special@id');
    assert.equal(requestedUrl, '/api/nodes/node%2Fwith%3Aspecial%40id/upgrade/check');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.checkNodeUpgrade: throws ApiError on non-200 responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Node is unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      async () => {
        await api.checkNodeUpgrade('offline-node');
      },
      (err: any) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 502);
        assert.equal(err.message, 'Node is unreachable');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.upgradeNode: issues POST request without targetVersion sends empty body', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;

  const mockResult: NodeUpgradeResult = {
    ok: true,
    previousVersion: '0.1.0',
    targetVersion: '0.2.0',
    upgraded: true,
    pid: 9999,
  };

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return new Response(JSON.stringify(mockResult), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const res = await api.upgradeNode('worker-node-1');
    assert.equal(requestedUrl, '/api/nodes/worker-node-1/upgrade');
    assert.equal(requestedOptions?.method, 'POST');
    assert.equal(requestedOptions?.body, '{}');
    const headers = new Headers(requestedOptions?.headers);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.deepEqual(res, mockResult);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.upgradeNode: issues POST request with targetVersion included in body', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;

  const mockResult: NodeUpgradeResult = {
    ok: true,
    previousVersion: '0.1.0',
    targetVersion: '0.3.0',
    upgraded: true,
  };

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return new Response(JSON.stringify(mockResult), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const res = await api.upgradeNode('worker-node-1', '0.3.0');
    assert.equal(requestedUrl, '/api/nodes/worker-node-1/upgrade');
    assert.equal(requestedOptions?.method, 'POST');
    assert.equal(requestedOptions?.body, JSON.stringify({ targetVersion: '0.3.0' }));
    assert.deepEqual(res, mockResult);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.upgradeNode: throws ApiError on failure (e.g. Canary rollback failure)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ error: 'Canary healthcheck failed after upgrade, rolled back to v0.1.0' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      async () => {
        await api.upgradeNode('worker-node-1');
      },
      (err: any) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 500);
        assert.match(err.message, /Canary healthcheck failed/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================
// 2. NodesBotsView.tsx: Version Badge and Upgrade Button UI Rendering
// ============================================================

test('NodesBotsView: renders node version badge when node.version is present', () => {
  const nodeWithVersion: NodeWithBots = {
    id: 'node-alpha',
    name: 'Alpha Node',
    status: 'online',
    platform: 'linux',
    version: '1.4.2',
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    skills: [],
    extensions: [],
    bots: [],
  };

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(NodesBotsView, {
      nodes: [nodeWithVersion],
      loading: false,
      onRefresh: async () => {},
      onBackToChat: () => {},
      onAddToast: () => {},
    })
  );

  // Check version badge text and CSS class text-[10px]
  assert(html.includes('>v1.4.2<'), 'Should render >v1.4.2< badge in node header');
  assert(html.includes('text-[10px]'), 'Should use text-[10px] styling class for version pill');
  assert(html.includes('linux'), 'Platform badge is also rendered');
});

test('NodesBotsView: omits version badge when node.version is undefined', () => {
  const nodeWithoutVersion: NodeWithBots = {
    id: 'node-beta',
    name: 'Beta Node',
    status: 'online',
    platform: 'darwin',
    version: undefined,
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    skills: [],
    extensions: [],
    bots: [],
  };

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(NodesBotsView, {
      nodes: [nodeWithoutVersion],
      loading: false,
      onRefresh: async () => {},
      onBackToChat: () => {},
      onAddToast: () => {},
    })
  );

  assert(!html.includes('text-[10px]'), 'Should not render text-[10px] badge when version is absent');
  assert(html.includes('darwin'), 'Platform badge is still rendered');
});

test('NodesBotsView: renders upgrade button with correct action labels and disabled state when offline', () => {
  const onlineNode: NodeWithBots = {
    id: 'node-online',
    name: 'Online Node',
    status: 'online',
    platform: 'linux',
    version: '1.0.0',
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    skills: [],
    extensions: [],
    bots: [],
  };

  const offlineNode: NodeWithBots = {
    id: 'node-offline',
    name: 'Offline Node',
    status: 'offline',
    platform: 'win32',
    version: '1.0.0',
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    skills: [],
    extensions: [],
    bots: [],
  };

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(NodesBotsView, {
      nodes: [onlineNode, offlineNode],
      loading: false,
      onRefresh: async () => {},
      onBackToChat: () => {},
      onAddToast: () => {},
    })
  );

  // Online node upgrade button
  assert(
    html.includes('aria-label="升级节点 Online Node"'),
    'Online node should have upgrade button with correct aria-label'
  );
  assert(
    html.includes('title="升级计算节点"'),
    'Online node should have upgrade button with title "升级计算节点"'
  );

  // Offline node upgrade button
  assert(
    html.includes('aria-label="升级节点 Offline Node"'),
    'Offline node should have upgrade button with correct aria-label'
  );
  assert(
    html.includes('title="节点已离线，无法升级"'),
    'Offline node upgrade button should display title indicating node is offline'
  );
});

// ============================================================
// 3. NodesBotsView.tsx: Source Code & Interaction Logic Validation
// ============================================================

test('NodesBotsView: source contains required imports, states, modal, and polling integration', () => {
  const componentPath = path.resolve(__dirname, '../apps/web/src/components/NodesBotsView.tsx');
  const source = readFileSync(componentPath, 'utf8');

  // 1. Imports
  assert(
    source.includes('ArrowUpCircle'),
    'NodesBotsView.tsx must import ArrowUpCircle from lucide-react'
  );
  assert(
    source.includes('NodeUpgradeCheckResult'),
    'NodesBotsView.tsx must import NodeUpgradeCheckResult from @botd/protocol'
  );

  // 2. States
  assert(
    /nodeToUpgrade,\s*setNodeToUpgrade\]\s*=\s*useState<NodeWithBots\s*\|\s*null>\(null\)/.test(source),
    'Must define nodeToUpgrade state'
  );
  assert(
    /upgradeCheckInfo,\s*setUpgradeCheckInfo\]\s*=\s*useState<NodeUpgradeCheckResult\s*\|\s*null>\(null\)/.test(source),
    'Must define upgradeCheckInfo state'
  );
  assert(
    /checkingUpgradeNodeId,\s*setCheckingUpgradeNodeId\]\s*=\s*useState<string\s*\|\s*null>\(null\)/.test(source),
    'Must define checkingUpgradeNodeId state'
  );
  assert(
    /upgradingNodeIds,\s*setUpgradingNodeIds\]\s*=\s*useState<Set<string>>\(new Set\(\)\)/.test(source),
    'Must define upgradingNodeIds state'
  );

  // 3. Modal open & check logic
  assert(
    source.includes('handleOpenUpgradeModal'),
    'Must define handleOpenUpgradeModal'
  );
  assert(
    source.includes('api.checkNodeUpgrade'),
    'handleOpenUpgradeModal must call api.checkNodeUpgrade'
  );

  // 4. Confirm upgrade logic
  assert(
    source.includes('handleConfirmUpgrade'),
    'Must define handleConfirmUpgrade'
  );
  assert(
    source.includes('api.upgradeNode'),
    'handleConfirmUpgrade must call api.upgradeNode'
  );
  assert(
    source.includes('startRestartPolling(nodeId, nodeName, prevPid, prevStartedAt)'),
    'handleConfirmUpgrade must reuse startRestartPolling on successful upgrade'
  );
  assert(
    source.includes('节点已是最新版本 v'),
    'Must inform user when node is already latest version'
  );
  assert(
    source.includes('升级节点失败'),
    'Must show error toast on upgrade failure'
  );

  // 5. Upgrade modal dialog content
  assert(
    source.includes('title="升级计算节点"'),
    'Upgrade dialog must have title "升级计算节点"'
  );
  assert(
    source.includes('confirmText="确认升级"'),
    'Upgrade dialog must have confirmText "确认升级"'
  );
  assert(
    source.includes("nodeToUpgrade.version || '未知'"),
    'Upgrade dialog must show current version fallback'
  );
  assert(
    source.includes('正在检查最新版本...'),
    'Upgrade dialog must show checking state when checking'
  );
  assert(
    source.includes('发现新版本 v{upgradeCheckInfo.latestVersion}'),
    'Upgrade dialog must display discovered new version'
  );
  assert(
    source.includes('当前已是最新版本 (v{upgradeCheckInfo.currentVersion})'),
    'Upgrade dialog must display up-to-date message when no new version'
  );
  assert(
    source.includes('上次升级至 v{upgradeCheckInfo.blocked.version} 失败回滚原因：{upgradeCheckInfo.blocked.reason}'),
    'Upgrade dialog must handle blocked rollback warning'
  );
  assert(
    source.includes('升级期间节点会先等待在途任务完成、自动校验新版本，若新版本启动异常会自动回滚至当前版本。'),
    'Upgrade dialog must show rollback safety explanation'
  );
});

// ============================================================
// 4. Modal Dialog Visual States & Content Rendering
// ============================================================

test('Upgrade Confirmation Dialog: renders all information states correctly', () => {
  // Case 1: Checking in progress
  const checkingMessage = React.createElement(
    'div',
    { className: 'space-y-3' },
    React.createElement('div', null, '确定要升级计算节点「', React.createElement('strong', null, 'Node-Alpha'), '」吗？'),
    React.createElement(
      'div',
      { className: 'text-xs space-y-1.5 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80' },
      React.createElement('div', null, '当前版本：', React.createElement('span', { className: 'font-mono' }, 'v0.1.0')),
      React.createElement('div', { className: 'flex items-center gap-1.5 text-zinc-500' }, '正在检查最新版本...')
    ),
    React.createElement(
      'p',
      { className: 'text-zinc-500 dark:text-zinc-400 text-[11px] leading-relaxed' },
      '升级期间节点会先等待在途任务完成、自动校验新版本，若新版本启动异常会自动回滚至当前版本。'
    )
  );

  const htmlChecking = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ConfirmDialog, {
      isOpen: true,
      title: '升级计算节点',
      confirmText: '确认升级',
      onConfirm: () => {},
      onClose: () => {},
      message: checkingMessage,
    })
  );

  assert(htmlChecking.includes('升级计算节点'));
  assert(htmlChecking.includes('确认升级'));
  assert(htmlChecking.includes('Node-Alpha'));
  assert(htmlChecking.includes('当前版本：'));
  assert(htmlChecking.includes('正在检查最新版本...'));
  assert(htmlChecking.includes('自动回滚至当前版本'));

  // Case 2: Update available & blocked warning
  const blockedInfo: NodeUpgradeCheckResult = {
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    blocked: {
      version: '0.2.0',
      reason: 'Canary timeout after 15s',
      at: new Date().toISOString(),
    },
  };

  const updateMessage = React.createElement(
    'div',
    { className: 'space-y-3' },
    React.createElement('div', null, '确定要升级计算节点「', React.createElement('strong', null, 'Node-Beta'), '」吗？'),
    React.createElement(
      'div',
      { className: 'text-xs space-y-1.5 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80' },
      React.createElement('div', null, '当前版本：', React.createElement('span', { className: 'font-mono' }, 'v0.1.0')),
      React.createElement('div', { className: 'text-emerald-600 font-medium' }, `发现新版本 v${blockedInfo.latestVersion}`),
      React.createElement(
        'div',
        { className: 'p-2 bg-amber-50' },
        `上次升级至 v${blockedInfo.blocked?.version} 失败回滚原因：${blockedInfo.blocked?.reason}`
      )
    ),
    React.createElement(
      'p',
      { className: 'text-zinc-500' },
      '升级期间节点会先等待在途任务完成、自动校验新版本，若新版本启动异常会自动回滚至当前版本。'
    )
  );

  const htmlUpdate = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ConfirmDialog, {
      isOpen: true,
      title: '升级计算节点',
      confirmText: '确认升级',
      onConfirm: () => {},
      onClose: () => {},
      message: updateMessage,
    })
  );

  assert(htmlUpdate.includes('发现新版本 v0.2.0'));
  assert(htmlUpdate.includes('上次升级至 v0.2.0 失败回滚原因：Canary timeout after 15s'));

  // Case 3: Already latest version
  const upToDateInfo: NodeUpgradeCheckResult = {
    currentVersion: '0.2.0',
    latestVersion: '0.2.0',
    updateAvailable: false,
  };

  const upToDateMessage = React.createElement(
    'div',
    { className: 'space-y-3' },
    React.createElement('div', null, '确定要升级计算节点「', React.createElement('strong', null, 'Node-Gamma'), '」吗？'),
    React.createElement(
      'div',
      { className: 'text-xs space-y-1.5 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80' },
      React.createElement('div', null, '当前版本：', React.createElement('span', { className: 'font-mono' }, '未知')),
      React.createElement('div', { className: 'text-zinc-500' }, `当前已是最新版本 (v${upToDateInfo.currentVersion})`)
    )
  );

  const htmlUpToDate = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ConfirmDialog, {
      isOpen: true,
      title: '升级计算节点',
      confirmText: '确认升级',
      onConfirm: () => {},
      onClose: () => {},
      message: upToDateMessage,
    })
  );

  assert(htmlUpToDate.includes('当前版本：<span class="font-mono">未知</span>'));
  assert(htmlUpToDate.includes('当前已是最新版本 (v0.2.0)'));
});
