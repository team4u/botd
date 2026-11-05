import test from 'node:test';
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotConfig, NodeWithBots } from '../packages/protocol/src/index.js';

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

// 动态导入避免 tsc 遍历兄弟组件
const { BotListSection } = await import('../apps/web/src/components/NodesBotsView/BotListSection.js' as any);
const { SkillsPoolSection, ExtensionsPoolSection } = await import(
  '../apps/web/src/components/NodesBotsView/ResourcePools.js' as any
);
const { NodesBotsView } = await import('../apps/web/src/components/NodesBotsView.js' as any);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webSrc = path.resolve(__dirname, '../apps/web/src');

// ============================================================
// 1. transcriptToTurnBlocks：Durable recall transcript → TurnBlock[]
// ============================================================

test('transcriptToTurnBlocks: 把 Durable worker recall transcript 精确转换为 TurnBlock[]', { timeout: 60_000 }, async () => {
  const { transcriptToTurnBlocks } = (await import('../apps/web/src/hooks/useSuperAgentWorkers.js' as any)) as {
    transcriptToTurnBlocks: (transcript: Array<{ id: string; kind: string; role?: string; text: string }>) => unknown[];
  };

  const transcript = [
    { id: 'e1', kind: 'pi.user', role: 'user', text: '帮我重构 auth 模块' },
    { id: 'e2', kind: 'pi.assistant', role: 'assistant', text: '我先读一下现有实现。' },
    { id: 'e3', kind: 'pi.tool-result', role: 'tool', text: 'read apps/hub/src/auth.ts OK (200 lines)' },
    { id: 'e4', kind: 'pi.assistant', role: 'assistant', text: '重构完成，共改动 3 个文件。' },
  ];

  const blocks = transcriptToTurnBlocks(transcript);

  assert.equal(blocks.length, 4, '四条非空 transcript 条目应全部转换');

  // user / assistant 文本 → text 块
  assert.deepEqual(blocks[0], { type: 'text', text: '帮我重构 auth 模块' });
  assert.deepEqual(blocks[1], { type: 'text', text: '我先读一下现有实现。' });

  // pi.tool-result → tool 块（status done，text 作为输出预览）
  const toolBlock = blocks[2] as { type: string; id: string; name: string; status: string; outputPreview: string };
  assert.equal(toolBlock.type, 'tool');
  assert.equal(toolBlock.id, 'e3');
  assert.equal(toolBlock.name, 'tool-result');
  assert.equal(toolBlock.status, 'done');
  assert.equal(toolBlock.outputPreview, 'read apps/hub/src/auth.ts OK (200 lines)');

  assert.deepEqual(blocks[3], { type: 'text', text: '重构完成，共改动 3 个文件。' });
});

test('transcriptToTurnBlocks: 过滤空文本与未知 kind（system/reset/compaction 不进时间线）', { timeout: 60_000 }, async () => {
  const { transcriptToTurnBlocks } = (await import('../apps/web/src/hooks/useSuperAgentWorkers.js' as any)) as {
    transcriptToTurnBlocks: (transcript: Array<{ id: string; kind: string; role?: string; text: string }>) => unknown[];
  };

  const transcript = [
    { id: 'e1', kind: 'pi.system', text: '' },
    { id: 'e2', kind: 'pi.assistant', text: '' },
    { id: 'e3', kind: 'pi.reset', text: 'handoff text' },
    { id: 'e4', kind: 'pi.compaction', text: 'summary of earlier turns' },
    { id: 'e5', kind: 'pi.assistant', text: '有效回复' },
    { id: 'e6', kind: 'pi.tool-result', text: 'bash ls -la OK' },
  ];

  const blocks = transcriptToTurnBlocks(transcript);

  assert.equal(blocks.length, 2, '空文本与 system/reset/compaction 条目应被过滤');
  assert.deepEqual(blocks[0], { type: 'text', text: '有效回复' });
  const toolBlock = blocks[1] as { type: string; name: string; status: string };
  assert.equal(toolBlock.type, 'tool');
  assert.equal(toolBlock.status, 'done');

  // 空数组入参
  assert.deepEqual(transcriptToTurnBlocks([]), []);
});

test('useSuperAgentWorkers 源码: 选中 worker 时请求 /recall 端点水合检视抽屉', { timeout: 60_000 }, () => {
  const source = readFileSync(path.join(webSrc, 'hooks/useSuperAgentWorkers.ts'), 'utf-8');
  assert.match(source, /workers\/\$\{encodeURIComponent\(selectedWorkerId\)\}\/recall/, '应请求 /workers/:workerId/recall');
  assert.match(source, /transcriptToTurnBlocks\(transcript\)/, 'recall transcript 应转换为 blocks');
  assert.doesNotMatch(source, /subagents\/\$\{encodeURIComponent\(sid\)\}'\)/, '不应再回退 /subagents 列表端点');
  assert.doesNotMatch(source, /interactSubagent/, '不应再调用 api.interactSubagent');
  assert.doesNotMatch(source, /stopSubagent/, '不应再调用 api.stopSubagent');
});

// ============================================================
// 2. BotListSection / ResourcePools：离线节点 CRUD 解锁 SSR 验证
// ============================================================

const offlineNode: NodeWithBots = {
  id: 'node-offline',
  name: 'Offline Node',
  status: 'offline',
  platform: 'linux',
  lastSeenAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  skills: ['demo-skill', 'another-skill'],
  extensions: ['demo-ext'],
  bots: [],
};

const primaryBot: BotConfig = {
  id: 'pm-claude',
  nodeId: 'node-offline',
  name: 'PM Claude',
  description: '项目经理',
  modelProvider: 'openai',
  modelId: 'gpt-4o',
  enabledSkills: [],
  enabledExtensions: [],
  updatedAt: new Date().toISOString(),
};

const subagentBot: BotConfig = {
  ...primaryBot,
  id: 'pm-helper',
  name: 'PM Helper',
  parentBotId: 'pm-claude',
};

function renderOfflineSection(): string {
  const noop = () => {};
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(BotListSection as React.FC<Record<string, unknown>>, {
      node: { ...offlineNode, bots: [primaryBot, subagentBot] },
      isOnline: false,
      deletingBotId: null,
      onOpenCreateBot: noop,
      onOpenCreateSubagent: noop,
      onOpenEditBot: noop,
      onDeleteBot: noop,
    })
  );
}

test('BotListSection SSR: 节点离线时新建/设置/删除智能体按钮全部可用', () => {
  const html = renderOfflineSection();

  // 新建主 BOT / 新建子代理 / 设置 / 删除 按钮均在离线时渲染为可点击
  assert.match(html, /新建主 BOT/, '「新建主 BOT」按钮应渲染');
  assert.match(html, /新建子代理/, '「新建子代理」按钮应渲染');
  assert.match(html, /设置/g, '「设置」按钮应渲染');

  // 按钮级 disabled 属性：离线禁用已解除，deletingBotId=null 时不应渲染任何 disabled="" 属性
  // （class 中的 disabled:opacity-40 是样式工具类，不算 disabled 属性）
  const disabledButtons = html.match(/<button[^>]*disabled(?:=|)[^>]*>/g) ?? [];
  assert.equal(
    disabledButtons.filter((tag) => !/disabled[:-]/.test(tag.replace(/disabled(?::[^"']*)/g, ''))).length,
    0,
    '离线节点不应有任何带 disabled 属性的按钮'
  );

  // title 不再出现「节点离线，无法编辑配置」类文案
  assert.doesNotMatch(html, /节点离线，无法编辑配置/, '不应再有「节点离线，无法编辑配置」提示');
  assert.doesNotMatch(html, /节点离线，无法删除/, '不应再有「节点离线，无法删除」提示');
});

test('ResourcePools SSR: 节点离线时技能/扩展新建与编辑入口可用', { timeout: 60_000 }, () => {
  const noop = () => {};

  const skillsHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(SkillsPoolSection as React.FC<Record<string, unknown>>, {
      node: offlineNode,
      expandedPools: new Set<string>(),
      onTogglePool: noop,
      onOpenNewSkill: noop,
      onOpenEditSkill: noop,
    })
  );
  assert.match(skillsHtml, /新建技能/, '「新建技能」按钮应渲染');
  assert.match(skillsHtml, /demo-skill/, '技能芯片应渲染');
  const skillDisabled = skillsHtml.match(/<button[^>]*disabled[^>]*>/g) ?? [];
  assert.equal(skillDisabled.length, 0, '技能区块离线时不应有 disabled 按钮');

  const extsHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ExtensionsPoolSection as React.FC<Record<string, unknown>>, {
      node: offlineNode,
      expandedPools: new Set<string>(),
      onTogglePool: noop,
      onOpenNewExtension: noop,
      onOpenEditExtension: noop,
    })
  );
  assert.match(extsHtml, /安装或新建/, '「安装或新建」扩展按钮应渲染');
  assert.match(extsHtml, /demo-ext/, '扩展芯片应渲染');
  const extDisabled = extsHtml.match(/<button[^>]*disabled[^>]*>/g) ?? [];
  assert.equal(extDisabled.length, 0, '扩展区块离线时不应有 disabled 按钮');
});

// ============================================================
// 3. 跨节点技能同步彻底移除 + 零节点 Hub 直建入口
// ============================================================

test('syncSkillAcrossNodes 彻底移除: api/视图/资源池三处均无残留', { timeout: 60_000 }, () => {
  const apiSource = readFileSync(path.join(webSrc, 'api.ts'), 'utf-8');
  assert.doesNotMatch(apiSource, /syncSkillAcrossNodes/, 'api.ts 不应再有 syncSkillAcrossNodes');
  assert.doesNotMatch(apiSource, /\/sync/, 'api.ts 不应再有 /skills/:skillId/sync 调用');

  const viewSource = readFileSync(path.join(webSrc, 'components/NodesBotsView.tsx'), 'utf-8');
  assert.doesNotMatch(viewSource, /handleSyncSkill/, 'NodesBotsView 不应再有 handleSyncSkill');
  assert.doesNotMatch(viewSource, /syncingSkillKey/, 'NodesBotsView 不应再有 syncingSkillKey');
  assert.doesNotMatch(viewSource, /hasOtherOnlineNodes/, 'NodesBotsView 不应再有 hasOtherOnlineNodes');
  assert.doesNotMatch(viewSource, /onSyncSkill/, '不应再向 SkillsPoolSection 透传 onSyncSkill');

  const poolsSource = readFileSync(path.join(webSrc, 'components/NodesBotsView/ResourcePools.tsx'), 'utf-8');
  assert.doesNotMatch(poolsSource, /Share2/, '技能芯片不应再有跨节点同步图标按钮');
  assert.doesNotMatch(poolsSource, /onSyncSkill/, 'SkillsPoolSection 不应再有 onSyncSkill prop');
  assert.doesNotMatch(poolsSource, /同步技能到其他节点/, '不应再有「同步技能到其他节点」文案');
});

test('NodesBotsView SSR: 零节点时提供「直接新建智能体 (Hub 本地)」入口', { timeout: 60_000 }, () => {
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(NodesBotsView as React.FC<Record<string, unknown>>, {
      nodes: [],
      loading: false,
      onRefresh: async () => {},
      onBackToChat: () => {},
      onAddToast: () => {},
    })
  );

  assert.match(html, /配对新节点/, '「配对新节点」按钮应保留');
  assert.match(html, /直接新建智能体/, '应提供「直接新建智能体 (Hub 本地)」按钮');
  assert.match(html, /Hub 本地/, '按钮文案应标注 Hub 本地');
  // 入口始终可点：直接新建按钮不带 disabled 属性
  const localBtnIdx = html.indexOf('直接新建智能体');
  const btnStart = html.lastIndexOf('<button', localBtnIdx);
  const btnOpen = html.indexOf('>', btnStart);
  assert.ok(btnStart >= 0, '应渲染 Hub 本地新建按钮');
  assert.ok(!html.slice(btnStart, btnOpen).includes('disabled'), 'Hub 本地新建按钮不应 disabled');
});

test('api.ts: interactSubagent / stopSubagent 已随旧回退路径一并移除', { timeout: 60_000 }, () => {
  const apiSource = readFileSync(path.join(webSrc, 'api.ts'), 'utf-8');
  assert.doesNotMatch(apiSource, /interactSubagent/, 'api.ts 不应再有 interactSubagent');
  assert.doesNotMatch(apiSource, /stopSubagent/, 'api.ts 不应再有 stopSubagent');
});
