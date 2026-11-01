import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotConfig, SessionRecord } from '../packages/protocol/src/index.js';
import {
  CheckList,
  computeCheckListSelection,
} from '../apps/web/src/components/CheckList.js';
import {
  createDefaultSessionDraft,
  resolveCreateSessionStep,
  type CreateSessionDraft,
} from '../apps/web/src/components/CreateSessionModal.js';
import {
  initGroupSettingsDraft,
  resolveGroupSettingsStep,
  type GroupSettingsDraft,
} from '../apps/web/src/components/GroupSettingsModal.js';

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
    groupTitle: '',
    groupMode: 'lead',
    groupLeadBotId: '',
    groupMemberBotIds: [],
    parallelRoundtable: false,
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
  assert.equal(step2.nextDraft.groupTitle, 'AI 协同群聊');
  assert.equal(step2.nextDraft.groupLeadBotId, 'bot-1');
  assert.deepEqual(step2.nextDraft.groupMemberBotIds, ['bot-1', 'bot-2', 'bot-3']);
});

test('CreateSessionModal: 后台 10 秒轮询新 bots 数组不能冲掉用户正在编辑的草稿', () => {
  // 用户编辑过的草稿
  const userEditingDraft: CreateSessionDraft = {
    groupTitle: '我的自定义敏捷开发讨论组',
    groupMode: 'roundtable',
    groupLeadBotId: 'bot-2',
    groupMemberBotIds: ['bot-1', 'bot-2'],
    parallelRoundtable: true,
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
  assert.equal(step.nextDraft.groupTitle, '我的自定义敏捷开发讨论组', '草稿标题未被冲掉');
  assert.equal(step.nextDraft.groupMode, 'roundtable', '草稿协作模式未被冲掉');
  assert.equal(step.nextDraft.groupLeadBotId, 'bot-2', '草稿主持人未被冲掉');
  assert.equal(step.nextDraft.parallelRoundtable, true, '并发选项未被冲掉');
  assert.deepEqual(step.nextDraft.groupMemberBotIds, ['bot-1', 'bot-2'], '草稿已选成员未被冲掉');
});

test('CreateSessionModal: 关后重开应该正确重新初始化', () => {
  const userDraft: CreateSessionDraft = {
    groupTitle: '旧草稿',
    groupMode: 'roundtable',
    groupLeadBotId: 'bot-2',
    groupMemberBotIds: ['bot-2'],
    parallelRoundtable: true,
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
  assert.equal(stepReopen.nextDraft.groupTitle, 'AI 协同群聊', '恢复默认标题');
  assert.equal(stepReopen.nextDraft.groupLeadBotId, 'bot-1', '恢复默认主持人');
  assert.equal(stepReopen.nextDraft.parallelRoundtable, false, '恢复默认非并发');
});

test('CreateSessionModal: 后台刷新时若有 BOT 被删，只合理剔除被删成员，不重设整份草稿', () => {
  const userDraft: CreateSessionDraft = {
    groupTitle: '特定项目群',
    groupMode: 'roundtable',
    groupLeadBotId: 'bot-1',
    groupMemberBotIds: ['bot-1', 'bot-deleted', 'bot-2'],
    parallelRoundtable: true,
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

  assert.equal(step.shouldUpdate, true, '检测到已删成员需要局部更新');
  assert.equal(step.nextDraft.groupTitle, '特定项目群', '标题绝不被冲掉');
  assert.equal(step.nextDraft.groupMode, 'roundtable', '协作模式绝不被冲掉');
  assert.equal(step.nextDraft.parallelRoundtable, true, '并发选项绝不被冲掉');
  assert.deepEqual(step.nextDraft.groupMemberBotIds, ['bot-1', 'bot-2'], '合理剔除 bot-deleted');
});

// ==========================================
// 3. GroupSettingsModal 初始化边界与 SSE 防冲掉
// ==========================================

const mockSession: SessionRecord = {
  id: 'session-101',
  title: '生产环境发布指挥部',
  status: 'idle',
  mode: 'lead',
  leadBotId: 'bot-1',
  memberBotIds: ['bot-1', 'bot-2'],
  parallelRoundtable: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test('GroupSettingsModal: 打开时以 session.id 为边界初始化', () => {
  const step = resolveGroupSettingsStep({
    isOpen: true,
    lastInitializedSessionId: null,
    currentSession: mockSession,
    currentDraft: {
      title: '',
      mode: 'lead',
      leadBotId: '',
      memberBotIds: [],
      parallelRoundtable: false,
      error: null,
    },
    bots: mockBots,
  });

  assert.equal(step.shouldUpdate, true);
  assert.equal(step.nextInitializedSessionId, 'session-101');
  assert.equal(step.nextDraft.title, '生产环境发布指挥部');
  assert.equal(step.nextDraft.leadBotId, 'bot-1');
  assert.deepEqual(step.nextDraft.memberBotIds, ['bot-1', 'bot-2']);
});

test('GroupSettingsModal: SSE 产生新 session 对象时绝不冲掉用户草稿', () => {
  const userEditingDraft: GroupSettingsDraft = {
    title: '用户正在修改的标题...',
    mode: 'roundtable',
    leadBotId: 'bot-2',
    memberBotIds: ['bot-1', 'bot-2', 'bot-3'],
    parallelRoundtable: true,
    error: null,
  };

  // 模拟 SSE 推送导致 App 生成新的 session 对象引用
  const sseNewSession: SessionRecord = {
    ...mockSession,
    updatedAt: new Date(Date.now() + 5000).toISOString(),
  };

  const step = resolveGroupSettingsStep({
    isOpen: true,
    lastInitializedSessionId: 'session-101',
    currentSession: sseNewSession,
    currentDraft: userEditingDraft,
    bots: mockBots,
  });

  assert.equal(step.shouldUpdate, false, '相同 session.id 的 SSE 对象更新绝不重写草稿');
  assert.equal(step.nextDraft.title, '用户正在修改的标题...');
  assert.equal(step.nextDraft.mode, 'roundtable');
  assert.equal(step.nextDraft.leadBotId, 'bot-2');
  assert.equal(step.nextDraft.parallelRoundtable, true);
});

test('GroupSettingsModal: 切换 session 必须重新初始化', () => {
  const otherSession: SessionRecord = {
    id: 'session-202',
    title: '财务审计专项群',
    status: 'idle',
    mode: 'roundtable',
    leadBotId: 'bot-3',
    memberBotIds: ['bot-2', 'bot-3'],
    parallelRoundtable: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const step = resolveGroupSettingsStep({
    isOpen: true,
    lastInitializedSessionId: 'session-101', // 原 session
    currentSession: otherSession, // 切换到新 session
    currentDraft: {
      title: '旧标题',
      mode: 'lead',
      leadBotId: 'bot-1',
      memberBotIds: ['bot-1'],
      parallelRoundtable: false,
      error: null,
    },
    bots: mockBots,
  });

  assert.equal(step.shouldUpdate, true, '切换编辑对象 ID 应当触发初始化');
  assert.equal(step.nextInitializedSessionId, 'session-202');
  assert.equal(step.nextDraft.title, '财务审计专项群');
  assert.equal(step.nextDraft.mode, 'roundtable');
  assert.equal(step.nextDraft.leadBotId, 'bot-3');
  assert.deepEqual(step.nextDraft.memberBotIds, ['bot-2', 'bot-3']);
});

test('GroupSettingsModal: 关后重开同一 session 应当重新初始化', () => {
  // 1. 关闭弹窗
  const stepClose = resolveGroupSettingsStep({
    isOpen: false,
    lastInitializedSessionId: 'session-101',
    currentSession: mockSession,
    currentDraft: {
      title: '未保存的草稿',
      mode: 'roundtable',
      leadBotId: 'bot-2',
      memberBotIds: ['bot-2'],
      parallelRoundtable: true,
      error: null,
    },
    bots: mockBots,
  });
  assert.equal(stepClose.nextInitializedSessionId, null, '关闭重置 session 边界');

  // 2. 重新打开
  const stepReopen = resolveGroupSettingsStep({
    isOpen: true,
    lastInitializedSessionId: null,
    currentSession: mockSession,
    currentDraft: {
      title: '未保存的草稿',
      mode: 'roundtable',
      leadBotId: 'bot-2',
      memberBotIds: ['bot-2'],
      parallelRoundtable: true,
      error: null,
    },
    bots: mockBots,
  });
  assert.equal(stepReopen.shouldUpdate, true, '重开应重新按 session 初始化');
  assert.equal(stepReopen.nextDraft.title, '生产环境发布指挥部', '恢复为持久化会话标题');
  assert.equal(stepReopen.nextDraft.mode, 'lead');
});
