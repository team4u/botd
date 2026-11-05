import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotConfig, SessionRecord } from '../packages/protocol/src/index.js';
import {
  CheckList,
} from '../apps/web/src/components/CheckList.js';
import { computeCheckListSelection } from '../apps/web/src/check-list-selection.js';
import {
  createDefaultSessionDraft,
  resolveCreateSessionStep,
  type CreateSessionDraft,
} from '../apps/web/src/create-session-draft.js';
import {
  orderBotsAsTree,
} from '../apps/web/src/utils/bots.js';

// Dynamically import so tsc in tsconfig.tests.json does not traverse into
// sibling web components (it uses bundler-style extensionless imports).
const { shouldSaveBotMemory } = await import('../apps/web/src/components/BotEditorModal/shared.js' as any) as {
  shouldSaveBotMemory: (isEditing: boolean, memoryMd: string, initialMemoryMd: string | null) => boolean;
};

// 递归查找 ReactElement 树中的特定节点
function findElement(tree: any, predicate: (node: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  const children = tree.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  } else if (children && typeof children === 'object') {
    return findElement(children, predicate);
  }
  return null;
}

const mockBots: BotConfig[] = [
  {
    id: 'bot-1',
    nodeId: 'node-1',
    name: 'Bot One',
    description: '',
    modelProvider: 'provider-1',
    modelId: 'model-1',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'bot-2',
    nodeId: 'node-1',
    name: 'Bot Two',
    description: '',
    modelProvider: 'provider-1',
    modelId: 'model-2',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'bot-3',
    nodeId: 'node-1',
    name: 'Bot Three',
    description: '',
    modelProvider: 'provider-1',
    modelId: 'model-3',
    enabledSkills: [],
    enabledExtensions: [],
    updatedAt: new Date().toISOString(),
  },
];

// ==========================================
// 1. CheckList 真实组件渲染与按钮 onClick 验证
// ==========================================

test('CheckList: 反选按钮只作用于当前 options，非 options 的已有 ID 无条件保留', () => {
  let latestSelected: string[] = [];
  const options = [
    { id: 'opt-visible-1', data: { name: 'V1' } },
    { id: 'opt-visible-2', data: { name: 'V2' } },
  ];
  // opt-visible-1 已选中，opt-visible-2 未选中；同时包含两个 options 外的遗留/隐藏 ID
  const initialSelected = ['opt-visible-1', 'hidden-bot-1', 'hidden-bot-2'];

  const element = CheckList({
    label: '测试选项',
    options,
    selected: initialSelected,
    onChange: (next) => {
      latestSelected = next;
    },
    renderItem: (data) => data.name,
  });

  const invertButton = findElement(
    element,
    (node) =>
      node?.type === 'button' &&
      (node.props?.children === '反选' ||
        (Array.isArray(node.props?.children) && node.props.children.includes('反选'))),
  );
  assert(invertButton, '应当渲染「反选」按钮');

  invertButton.props.onClick();

  // 反选后：
  // opt-visible-1 由选变为不选
  // opt-visible-2 由不选变为选中
  // hidden-bot-1 和 hidden-bot-2 无条件保留
  assert.deepEqual(latestSelected, ['opt-visible-2', 'hidden-bot-1', 'hidden-bot-2']);
});

test('CheckList: 全选按钮选中所有当前 options，并无条件保留已有隐藏 ID', () => {
  let latestSelected: string[] = [];
  const options = [
    { id: 'opt-visible-1', data: { name: 'V1' } },
    { id: 'opt-visible-2', data: { name: 'V2' } },
  ];
  const initialSelected = ['hidden-bot-1'];

  const element = CheckList({
    label: '测试选项',
    options,
    selected: initialSelected,
    onChange: (next) => {
      latestSelected = next;
    },
    renderItem: (data) => data.name,
  });

  const selectAllButton = findElement(
    element,
    (node) =>
      node?.type === 'button' &&
      (node.props?.children === '全选' ||
        (Array.isArray(node.props?.children) && node.props.children.includes('全选'))),
  );
  assert(selectAllButton, '应当渲染「全选」按钮');

  selectAllButton.props.onClick();

  assert.deepEqual(latestSelected, ['opt-visible-1', 'opt-visible-2', 'hidden-bot-1']);
});

test('CheckList: 锁定项（lockedIds）反选保持选中且 toggle 不能取消', () => {
  let latestSelected: string[] = [];
  const options = [
    { id: 'lead-bot', data: { name: 'Lead' } },
    { id: 'member-bot', data: { name: 'Member' } },
  ];
  const lockedIds = ['lead-bot'];
  // lead-bot 和 member-bot 初始都已勾选
  const initialSelected = ['lead-bot', 'member-bot', 'hidden-id'];

  const element = CheckList({
    label: '群成员',
    options,
    selected: initialSelected,
    lockedIds,
    onChange: (next) => {
      latestSelected = next;
    },
    renderItem: (data) => data.name,
  });

  // 1. 点击反选：lead-bot 被锁定必须保留；member-bot 变为不选；hidden-id 无条件保留
  const invertButton = findElement(
    element,
    (node) =>
      node?.type === 'button' &&
      (node.props?.children === '反选' ||
        (Array.isArray(node.props?.children) && node.props.children.includes('反选'))),
  );
  invertButton.props.onClick();
  assert.deepEqual(latestSelected, ['lead-bot', 'hidden-id']);

  // 2. 模拟对 locked ID 点击 toggle：toggle 不能取消 locked 项
  const lockedInput = findElement(
    element,
    (node) => node?.type === 'input' && node.props?.disabled === true,
  );
  assert(lockedInput, '锁定项 checkbox 输入框应当标记 disabled');

  // 直接调用 toggle 计算函数验证锁定项不能取消
  const toggleResult = computeCheckListSelection({
    options,
    selected: ['lead-bot', 'member-bot'],
    lockedIds: ['lead-bot'],
    action: 'toggle',
    toggleId: 'lead-bot',
  });
  assert(toggleResult.includes('lead-bot'), 'toggle 不能取消锁定项');
});

test('CheckList: 去重与合理顺序维护', () => {
  const options = [
    { id: 'a', data: {} },
    { id: 'b', data: {} },
  ];
  // 包含重复与多余空格等异常输入
  const result = computeCheckListSelection({
    options,
    selected: ['b', 'b', 'hidden', 'hidden'],
    lockedIds: ['a'],
    action: 'selectAll',
  });
  assert.deepEqual(result, ['a', 'b', 'hidden'], '去重并保持 options 在前、hidden 在后');
});

// ==========================================
// 2. CreateSessionModal 初始化决策与草稿防冲掉
// ==========================================

test('CreateSessionModal: 首次打开等待异步 bots 到达时能初始化一次', () => {
  const initialDraft: CreateSessionDraft = {
    title: '',
    leadBotId: '',
    error: null,
  };

  // 1. 弹窗打开但 bots 数组最初为空（异步加载中）
  const step1 = resolveCreateSessionStep({
    isOpen: true,
    wasOpen: false,
    initialized: false,
    currentDraft: initialDraft,
    bots: [],
  });
  assert.equal(step1.shouldUpdate, false, 'bots 为空时不提前初始化');
  assert.equal(step1.nextInitialized, false, '保持等待初次加载状态');

  // 2. bots 异步到达（length > 0）
  const step2 = resolveCreateSessionStep({
    isOpen: true,
    wasOpen: true,
    initialized: false,
    currentDraft: initialDraft,
    bots: mockBots,
  });
  assert.equal(step2.shouldUpdate, true, 'bots 首次到达应触发初始化');
  assert.equal(step2.nextInitialized, true, '标记已初始化');
  assert.equal(step2.nextDraft.leadBotId, 'bot-1');
});

test('CreateSessionModal: 后台 10 秒轮询新 bots 数组不能冲掉用户正在编辑的草稿', () => {
  // 用户编辑过的草稿
  const userEditingDraft: CreateSessionDraft = {
    title: '我的自定义敏捷开发讨论',
    leadBotId: 'bot-2',
    error: null,
  };

  // 模拟 App 每 10 秒刷新生成全新的 mockBots 数组引用
  const refreshedBots = mockBots.map((b) => ({ ...b }));

  const step = resolveCreateSessionStep({
    isOpen: true,
    wasOpen: true,
    initialized: true,
    currentDraft: userEditingDraft,
    bots: refreshedBots,
  });

  assert.equal(step.shouldUpdate, false, '后台数据相同刷新不更新组件草稿');
  assert.equal(step.nextDraft.title, '我的自定义敏捷开发讨论', '草稿标题未被冲掉');
  assert.equal(step.nextDraft.leadBotId, 'bot-2', '草稿智能体未被冲掉');
});

test('CreateSessionModal: 关后重开应该正确重新初始化', () => {
  const userDraft: CreateSessionDraft = {
    title: '旧草稿',
    leadBotId: 'bot-2',
    error: null,
  };

  // 1. 关弹窗
  const stepClose = resolveCreateSessionStep({
    isOpen: false,
    wasOpen: true,
    initialized: true,
    currentDraft: userDraft,
    bots: mockBots,
  });
  assert.equal(stepClose.nextInitialized, false, '关弹窗重置初始化标记');

  // 2. 重新打开
  const stepReopen = resolveCreateSessionStep({
    isOpen: true,
    wasOpen: false,
    initialized: false,
    currentDraft: userDraft,
    bots: mockBots,
  });
  assert.equal(stepReopen.shouldUpdate, true, '重新打开应触发初始化');
  assert.equal(stepReopen.nextDraft.leadBotId, 'bot-1', '恢复默认智能体');
});

test('CreateSessionModal: 后台刷新时若有 BOT 被删，只合理剔除已删智能体，不重设整份草稿', () => {
  const userDraft: CreateSessionDraft = {
    title: '特定项目',
    leadBotId: 'bot-deleted',
    error: null,
  };

  // 后台同步后，bot-deleted 不在 mockBots 中
  const step = resolveCreateSessionStep({
    isOpen: true,
    wasOpen: true,
    initialized: true,
    currentDraft: userDraft,
    bots: mockBots,
  });

  assert.equal(step.shouldUpdate, true, '检测到已删智能体需要局部更新');
  assert.equal(step.nextDraft.title, '特定项目', '标题绝不被冲掉');
  assert.equal(step.nextDraft.leadBotId, 'bot-1', '回退到可用首选 bot');
});

// ==========================================
// 5. BotEditorModal 记忆保存 Dirty Check
// ==========================================

test('shouldSaveBotMemory: 新建 Bot 空记忆不触发保存（后端已默认建空 MEMORY.md）', () => {
  assert.equal(shouldSaveBotMemory(false, '', null), false);
  assert.equal(shouldSaveBotMemory(false, '   \n  ', null), false, '仅空白字符视为空');
});

test('shouldSaveBotMemory: 新建 Bot 非空记忆触发保存', () => {
  assert.equal(shouldSaveBotMemory(false, '## 初始记忆', null), true);
});

test('shouldSaveBotMemory: 编辑 Bot 记忆未修改不触发保存（防止旧快照冲掉后台新记忆）', () => {
  const snapshot = '## 后台刚写入的记忆';
  assert.equal(shouldSaveBotMemory(true, snapshot, snapshot), false);
  assert.equal(shouldSaveBotMemory(true, 'other', 'other'), false);
});

test('shouldSaveBotMemory: 编辑 Bot 记忆被修改后触发保存', () => {
  assert.equal(shouldSaveBotMemory(true, '## 新内容', '## 旧内容'), true);
  // 快照未加载完成（null）时不保存，避免误写
  assert.equal(shouldSaveBotMemory(true, '## 新内容', null), false);
});


// ==========================================
// 4. BOT 树序排序纯函数测试
// ==========================================

test('orderBotsAsTree: 将子代理紧跟在所属主 BOT 后，且默认草稿选主 BOT 为主持', () => {
  const unorderedBots: BotConfig[] = [
    { ...mockBots[1], id: 'sub-a', name: 'Sub A', parentBotId: 'main-1' },
    { ...mockBots[0], id: 'main-1', name: 'Main 1' },
    { ...mockBots[2], id: 'sub-b', name: 'Sub B', parentBotId: 'main-1' },
  ];
  const tree = orderBotsAsTree(unorderedBots);
  assert.deepEqual(tree.map((b) => b.id), ['main-1', 'sub-a', 'sub-b']);

  const draft = createDefaultSessionDraft(unorderedBots);
  assert.equal(draft.leadBotId, 'main-1', '默认主持人应为树序首位主 BOT');
});

