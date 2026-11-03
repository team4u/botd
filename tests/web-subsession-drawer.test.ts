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
    resolveRunInspectionTarget: (
      run: import('../packages/protocol/src/index.js').SubagentRunRecord | null
    ) =>
      | { kind: 'none' }
      | { kind: 'subsession'; childSessionId: string }
      | { kind: 'subagent'; run: import('../packages/protocol/src/index.js').SubagentRunRecord };
  };

  assert.equal(typeof chatViewModule.ChatView, 'function', 'ChatView 组件应可导出');
  assert.equal(typeof chatViewModule.pickPollIntervalMs, 'function');
  assert.equal(chatViewModule.pickPollIntervalMs(true), 5000);
  assert.equal(chatViewModule.pickPollIntervalMs(false), 30000);
  assert.equal(
    typeof chatViewModule.resolveRunInspectionTarget,
    'function',
    'resolveRunInspectionTarget 纯函数应可导出'
  );

  // null → 不打开任何抽屉
  assert.deepEqual(chatViewModule.resolveRunInspectionTarget(null), { kind: 'none' });

  // 带 childSessionId 的工作流步骤 → 跨BOT子会话抽屉
  const crossBotRun = {
    id: 'run_1',
    subagentId: 'bot_writer',
    task: '并行写作',
    status: 'done',
    childSessionId: 'sess_child_1',
  } as import('../packages/protocol/src/index.js').SubagentRunRecord;
  assert.deepEqual(chatViewModule.resolveRunInspectionTarget(crossBotRun), {
    kind: 'subsession',
    childSessionId: 'sess_child_1',
  });

  // 无 childSessionId 的本地子代理运行 → 子代理运行抽屉
  const localRun = {
    id: 'run_2',
    subagentId: 'bot_local',
    task: '本地检索',
    status: 'done',
  } as import('../packages/protocol/src/index.js').SubagentRunRecord;
  const localTarget = chatViewModule.resolveRunInspectionTarget(localRun);
  assert.equal(localTarget.kind, 'subagent');
  assert.equal(
    localTarget.kind === 'subagent' ? localTarget.run.id : '',
    'run_2',
    '应原样返回本地子代理运行记录'
  );
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

test('4. ChatView 消息内子会话链接拦截打开内联抽屉而非跳转', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const repoRoot = process.cwd().replace(/\\/g, '/');
  const chatViewPath = path.join(repoRoot, 'apps/web/src/components/ChatView.tsx');
  const source = await fs.readFile(chatViewPath, 'utf-8');

  // 状态与派生逻辑：基于 inspectingSubSessionId 与子代理运行记录合成兑底记录
  assert.match(source, /inspectingSubSessionId/, '应持有 inspectingSubSessionId 状态');
  assert.match(
    source,
    /findSubagentRunByChildSessionId\(/,
    '应通过 findSubagentRunByChildSessionId 构造兑底 SessionRecord'
  );
  // 已不再平铺子任务药丸与 listSubSessions 轮询
  assert.doesNotMatch(source, /listSubSessions/, '不应再调用 listSubSessions 轮询');
  assert.doesNotMatch(source, /setInspectingSubSessionId\(sub\.id\)/, '顶栏子任务药丸应已删除');
  // 消息正文内 #?s=sess_ 链接拦截
  assert.match(
    source,
    /#\\\?s=\(sess_\[a-zA-Z0-9_\-\]\+\)/,
    '应拦截 #?s=sess_... 形态的子会话链接'
  );
  // 抽屉渲染接线
  assert.match(source, /<SubSessionDrawer/, '应渲染 SubSessionDrawer 组件');
  // 跨BOT工作流步骤检视接线：带 childSessionId 的运行记录应路由到子会话抽屉
  assert.match(
    source,
    /resolveRunInspectionTarget/,
    '应导出 resolveRunInspectionTarget 纯函数供单测直接验证'
  );
  assert.match(
    source,
    /resolveRunInspectionTarget\(run\)/,
    'handleInspectRun 应调用 resolveRunInspectionTarget 分流'
  );
  assert.match(
    source,
    /onInspectSubagentRun=\{handleInspectRun\}/,
    'MessageTimeline 应接收 handleInspectRun 包装回调'
  );
});

test('5. MessageItem 子代理面板为跨BOT子会话步骤渲染专属徽标', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.resolve('../apps/web/package.json'));
  const React = req('react');
  const ReactDOMServer = req('react-dom/server');

  const messageItemModule = (await import('../apps/web/src/components/MessageItem.js' as any)) as {
    SubagentRunsPanel: React.FC<{
      runs: import('../packages/protocol/src/index.js').SubagentRunRecord[];
      onInspectSubagentRun?: (
        run: import('../packages/protocol/src/index.js').SubagentRunRecord
      ) => void;
    }>;
  };

  const baseRun = {
    id: 'run_wf_1',
    subagentId: 'bot_writer',
    subagentName: '写手',
    task: '并行写作阶段',
    phase: 'write',
    // running 使面板初始即展开（useState(hasRunning)），SSR 无副作用也能渲染步骤行
    status: 'running' as const,
    durationMs: 1200,
  };

  // 带 childSessionId（跨BOT子会话步骤）：渲染「跨BOT子会话」徽标
  const htmlWithChild = ReactDOMServer.renderToStaticMarkup(
    React.createElement(messageItemModule.SubagentRunsPanel, {
      runs: [{ ...baseRun, childSessionId: 'sess_child_1' } as any],
    })
  );
  assert.match(
    htmlWithChild,
    /跨BOT子会话/,
    'childSessionId 存在时应渲染跨BOT子会话徽标'
  );
  assert.match(htmlWithChild, /write/, 'phase 徽标应正常渲染');

  // 不带 childSessionId（本地子代理步骤）：不渲染该徽标
  const htmlLocal = ReactDOMServer.renderToStaticMarkup(
    React.createElement(messageItemModule.SubagentRunsPanel, {
      runs: [baseRun as any],
    })
  );
  assert.doesNotMatch(
    htmlLocal,
    /跨BOT子会话/,
    '无 childSessionId 时不应渲染跨BOT子会话徽标'
  );
  assert.match(htmlLocal, /write/, 'phase 徽标应正常渲染');
});
