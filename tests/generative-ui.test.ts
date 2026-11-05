import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOTD_UI_COMPONENT_TYPES,
  MAX_UI_SPEC_BYTES,
  MAX_UI_TREE_DEPTH,
  validateUiSpec,
  type BotdUiSpec,
} from '../packages/protocol/src/index.js';
import { BUILTIN_SKILL_MD, BUILTIN_SKILL_VERSION } from '../apps/node/src/builtin-skill.js';

// ---------------------------------------------------------------------------
// 1. validateUiSpec: Valid Spec with all 15 components, $state, submit action
// ---------------------------------------------------------------------------

test('validateUiSpec: 合法 Spec（包含 15 种组件、$state 绑定与 submit action）通过校验', { timeout: 60_000 }, () => {
  const validFullSpec: BotdUiSpec = {
    root: 'stack_root',
    elements: {
      stack_root: {
        type: 'Stack',
        props: { direction: 'vertical', gap: 'md' },
        children: ['card_1', 'grid_1', 'list_1', 'form_card', 'explain_callout', 'tabs_section', 'steps_flow', 'faq_accordion', 'bar_comparison'],
      },
      card_1: {
        type: 'Card',
        props: { title: 'Overview', subtitle: 'System Metrics', badge: 'PROD', icon: 'server' },
        children: [],
      },
      grid_1: {
        type: 'MetricGrid',
        props: { columns: 3 },
        children: ['metric_cpu', 'metric_mem', 'metric_err'],
      },
      metric_cpu: {
        type: 'MetricCard',
        props: { label: 'CPU Usage', value: '42%', status: 'ok', trend: 'up', icon: 'cpu' },
      },
      metric_mem: {
        type: 'MetricCard',
        props: { label: 'Memory', value: '68%', status: 'warn', trend: 'flat', icon: 'hard-drive' },
      },
      metric_err: {
        type: 'MetricCard',
        props: { label: 'Error Rate', value: '0.01%', status: 'ok', trend: 'down', icon: 'activity' },
      },
      list_1: {
        type: 'KeyValueList',
        props: {
          items: [
            { key: 'Host', value: 'srv-01.botd.io', mono: true, badge: 'active' },
            { key: 'Region', value: 'us-west-2' },
          ],
        },
      },
      explain_callout: {
        type: 'Callout',
        props: {
          title: '核心原理',
          content: '零拷贝通过避免上下文切换与 CPU 内存拷贝，大幅提高网络 I/O 效率。',
          variant: 'tip',
          icon: 'lightbulb',
        },
      },
      tabs_section: {
        type: 'Tabs',
        props: {
          tabs: [
            { id: 'tab_concept', label: '通俗类比', icon: 'book-open' },
            { id: 'tab_arch', label: '系统架构', icon: 'layers' },
          ],
          defaultTab: 'tab_concept',
        },
        children: ['tab_content_1', 'tab_content_2'],
      },
      tab_content_1: {
        type: 'Card',
        props: { title: '类比解释' },
      },
      tab_content_2: {
        type: 'Card',
        props: { title: '架构细节' },
      },
      steps_flow: {
        type: 'Steps',
        props: {
          items: [
            { title: '发起调用', description: '客户端组装参数并序列化', status: 'done', icon: 'send' },
            { title: '路由派发', description: 'Hub 查找目标节点与在线连接', status: 'current', icon: 'workflow' },
            { title: '节点执行', description: 'Node daemon 启动 Pi 会话', status: 'pending', icon: 'terminal' },
          ],
        },
      },
      faq_accordion: {
        type: 'Accordion',
        props: {
          items: [
            { title: '什么是 DMA 拷贝？', content: 'DMA 允许硬件直接与内存交互，无需 CPU 参与。', defaultOpen: true, icon: 'help-circle' },
            { title: 'mmap 与 sendfile 区别？', content: 'sendfile 专为网络文件传输优化，适合高并发静态服务。' },
          ],
        },
      },
      bar_comparison: {
        type: 'BarList',
        props: {
          title: '性能损耗对比 (越低越好)',
          items: [
            { label: '传统 I/O', value: 4, max: 4, displayValue: '4 次拷贝', color: 'rose' },
            { label: 'mmap', value: 3, max: 4, displayValue: '3 次拷贝', color: 'amber' },
            { label: 'sendfile (零拷贝)', value: 2, max: 4, displayValue: '2 次拷贝', color: 'emerald' },
          ],
        },
      },
      form_card: {
        type: 'Card',
        props: { title: 'Configuration' },
        children: ['input_name', 'select_env', 'switch_notif', 'action_bar'],
      },
      input_name: {
        type: 'TextInput',
        props: {
          label: 'Cluster Name',
          value: { $state: '/cluster/name' },
          placeholder: 'e.g. prod-main',
          hint: 'Unique cluster identifier',
        },
      },
      select_env: {
        type: 'Select',
        props: {
          label: 'Environment',
          value: { $state: '/cluster/env' },
          options: [
            { value: 'staging', label: 'Staging' },
            { value: 'production', label: 'Production' },
          ],
        },
      },
      switch_notif: {
        type: 'Switch',
        props: {
          label: 'Enable Alerts',
          checked: { $state: '/cluster/alerts' },
          hint: 'Send notifications on failure',
        },
      },
      action_bar: {
        type: 'ActionBar',
        props: { align: 'right' },
        children: ['btn_cancel', 'btn_submit'],
      },
      btn_cancel: {
        type: 'Button',
        props: { label: 'Cancel', variant: 'secondary' },
        on: { press: { action: 'submit', params: { decision: 'cancel' } } },
      },
      btn_submit: {
        type: 'Button',
        props: { label: 'Apply Changes', variant: 'primary' },
        on: { press: { action: 'submit', params: { decision: 'apply' } } },
      },
    },
    state: {
      cluster: {
        name: 'prod-main',
        env: 'production',
        alerts: true,
      },
    },
  };

  const result = validateUiSpec(validFullSpec);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.spec.root, 'stack_root');
    assert.equal(typeof result.normalizedJson, 'string');
    const parsed = JSON.parse(result.normalizedJson);
    assert.equal(parsed.root, 'stack_root');
    assert.equal(Object.keys(parsed.elements).length, 21);
  }

  // Also verify parsing from JSON string
  const strResult = validateUiSpec(JSON.stringify(validFullSpec));
  assert.equal(strResult.ok, true);
});

// ---------------------------------------------------------------------------
// 2. validateUiSpec: Rejection of invalid cases
// ---------------------------------------------------------------------------

test('validateUiSpec 拦截非法情况：未知组件类型（验证报错信息包含 Allowed types）', { timeout: 60_000 }, () => {
  const invalidSpec = {
    root: 'unsupported',
    elements: {
      unsupported: {
        type: 'DatePicker',
        props: { label: 'Select date' },
      },
    },
  };

  const res = validateUiSpec(invalidSpec);
  assert.equal(res.ok, false);
  if (!res.ok) {
    const errorStr = res.errors.join(' ');
    assert.match(errorStr, /Unknown component type "DatePicker"/);
    assert.ok(
      errorStr.includes(`Allowed types: ${BOTD_UI_COMPONENT_TYPES.join(', ')}`),
      'Error message must list all allowed component types',
    );
  }
});

test('validateUiSpec 拦截非法情况：树存在环（Cycle）', { timeout: 60_000 }, () => {
  const cyclicSpec = {
    root: 'node_a',
    elements: {
      node_a: {
        type: 'Stack',
        children: ['node_b'],
      },
      node_b: {
        type: 'Stack',
        children: ['node_a'],
      },
    },
  };

  const res = validateUiSpec(cyclicSpec);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(
      res.errors.some((err) => err.includes('Cycle detected')),
      `Expected cycle detection error, got: ${res.errors.join('; ')}`,
    );
  }
});

test('validateUiSpec 拦截非法情况：超过最大深度', { timeout: 60_000 }, () => {
  // Build a linear chain deeper than MAX_UI_TREE_DEPTH (depth 7)
  const elements: Record<string, any> = {};
  for (let i = 1; i <= MAX_UI_TREE_DEPTH + 1; i++) {
    elements[`node_${i}`] = {
      type: 'Stack',
      children: i <= MAX_UI_TREE_DEPTH ? [`node_${i + 1}`] : [],
    };
  }
  const deepSpec = {
    root: 'node_1',
    elements,
  };

  const res = validateUiSpec(deepSpec);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(
      res.errors.some((err) => err.includes(`exceeds maximum depth of ${MAX_UI_TREE_DEPTH}`)),
      `Expected max depth error, got: ${res.errors.join('; ')}`,
    );
  }
});

test('validateUiSpec 拦截非法情况：缺少 root 或孤儿 children 引用', { timeout: 60_000 }, () => {
  // Missing root in elements
  const missingRootSpec = {
    root: 'missing_root',
    elements: {
      card_1: {
        type: 'Card',
        props: { title: 'Card 1' },
      },
    },
  };
  const res1 = validateUiSpec(missingRootSpec);
  assert.equal(res1.ok, false);
  if (!res1.ok) {
    assert.ok(res1.errors.some((err) => err.includes('Root element "missing_root" not found in elements')));
  }

  // Orphan children reference
  const orphanChildSpec = {
    root: 'stack_1',
    elements: {
      stack_1: {
        type: 'Stack',
        children: ['ghost_element'],
      },
    },
  };
  const res2 = validateUiSpec(orphanChildSpec);
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.ok(res2.errors.some((err) => err.includes('Child "ghost_element" referenced by "stack_1" does not exist')));
  }
});

test('validateUiSpec 拦截非法情况：非法 action 名称', { timeout: 60_000 }, () => {
  const illegalActionSpec = {
    root: 'btn_1',
    elements: {
      btn_1: {
        type: 'Button',
        props: { label: 'Danger Button' },
        on: { press: { action: 'deleteDatabase', params: { force: true } } },
      },
    },
  };

  const res = validateUiSpec(illegalActionSpec);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((err) => err.includes('Unknown action "deleteDatabase"')));
  }
});

test('validateUiSpec 拦截非法情况：超长字节限制', { timeout: 60_000 }, () => {
  // Spec larger than MAX_UI_SPEC_BYTES (64KB)
  const hugePayload = 'A'.repeat(MAX_UI_SPEC_BYTES + 500);
  const oversizedSpec = {
    root: 'card_1',
    elements: {
      card_1: {
        type: 'Card',
        props: { title: hugePayload },
      },
    },
  };

  const res = validateUiSpec(JSON.stringify(oversizedSpec));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((err) => err.includes('exceeds maximum size of 65536 bytes')));
  }
});

// ---------------------------------------------------------------------------
// 2b. botd.v1 扩展能力：CheckboxGroup / Table / multiline / mono / Accordion 槽位
// ---------------------------------------------------------------------------

test('validateUiSpec 接受新组件与属性：CheckboxGroup(string[] 绑定)、Table、TextInput.multiline、Callout/Accordion mono、Accordion 槽位', { timeout: 60_000 }, () => {
  const spec = {
    root: 'form_card',
    elements: {
      form_card: {
        type: 'Card',
        props: { title: '清理分支' },
        children: ['branches_check', 'reason_input', 'mono_callout', 'detail_accordion', 'nodes_table', 'btn_ok'],
      },
      branches_check: {
        type: 'CheckboxGroup',
        props: {
          label: '选择要删除的分支',
          value: { $state: '/cleanup/branches' },
          options: [
            { value: 'feat/a', label: 'feat/a', description: '已合并，30 天未动' },
            { value: 'feat/b', label: 'feat/b' },
          ],
          hint: '至少选一个',
        },
      },
      reason_input: {
        type: 'TextInput',
        props: { label: '补充说明', multiline: true, rows: 4, value: { $state: '/cleanup/note' } },
      },
      mono_callout: {
        type: 'Callout',
        props: { content: 'git branch -D feat/a', mono: true, variant: 'tip' },
      },
      detail_accordion: {
        type: 'Accordion',
        props: {
          items: [
            { title: '高级选项', defaultOpen: false },
            { title: '命令预览', content: 'rm -rf node_modules', mono: true },
          ],
        },
        slots: { 高级选项: ['advanced_switch'] },
      },
      advanced_switch: {
        type: 'Switch',
        props: { label: '同时清理工作区', checked: { $state: '/cleanup/workspace' } },
      },
      nodes_table: {
        type: 'Table',
        props: {
          title: '节点状态',
          columns: ['节点', '状态', 'CPU'],
          rows: [
            ['node-1', 'online', '12%'],
            ['node-2', 'offline', '—'],
          ],
          monoColumns: [0],
        },
      },
      btn_ok: {
        type: 'Button',
        props: { label: '执行', variant: 'primary' },
        on: { press: { action: 'submit', params: { decision: 'apply' } } },
      },
    },
    state: { cleanup: { branches: ['feat/a'], note: '', workspace: false } },
  };

  const res = validateUiSpec(spec);
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join('; '));
  if (res.ok) {
    // 槽位子元素参与深度计算（Accordion 槽内 Switch：Card→Accordion→Switch 共 3 层，未超限）
    assert.equal(res.spec.root, 'form_card');
  }
});

test('validateUiSpec 拦截新组件的非法用法：Table 列数不匹配 / monoColumns 越界 / CheckboxGroup 非 string[] / rows 越界', { timeout: 60_000 }, () => {
  // Table row length mismatch
  const badTable = validateUiSpec({
    root: 't',
    elements: { t: { type: 'Table', props: { columns: ['a', 'b'], rows: [['only-one']] } } },
  });
  assert.equal(badTable.ok, false);
  if (!badTable.ok) {
    assert.ok(badTable.errors.some((e) => e.includes('(Table) row at index 0 must be a string array of length 2')));
  }

  // monoColumns out of range
  const badMonoCol = validateUiSpec({
    root: 't',
    elements: { t: { type: 'Table', props: { columns: ['a'], rows: [['x']], monoColumns: [3] } } },
  });
  assert.equal(badMonoCol.ok, false);
  if (!badMonoCol.ok) {
    assert.ok(badMonoCol.errors.some((e) => e.includes('monoColumns index 3 is out of range')));
  }

  // CheckboxGroup value must be string[] or binding
  const badCheck = validateUiSpec({
    root: 'c',
    elements: {
      c: {
        type: 'CheckboxGroup',
        props: { label: '选', options: [{ value: 'a', label: 'A' }], value: 42 },
      },
    },
  });
  assert.equal(badCheck.ok, false);
  if (!badCheck.ok) {
    assert.ok(badCheck.errors.some((e) => e.includes('(CheckboxGroup) props.value must be a string array')));
  }

  // TextInput rows out of range
  const badRows = validateUiSpec({
    root: 'i',
    elements: { i: { type: 'TextInput', props: { label: 'L', multiline: true, rows: 99 } } },
  });
  assert.equal(badRows.ok, false);
  if (!badRows.ok) {
    assert.ok(badRows.errors.some((e) => e.includes('(TextInput) props.rows must be an integer between 2 and 12')));
  }

  // Callout mono must be boolean
  const badMono = validateUiSpec({
    root: 'k',
    elements: { k: { type: 'Callout', props: { content: 'x', mono: 'yes' } } },
  });
  assert.equal(badMono.ok, false);
  if (!badMono.ok) {
    assert.ok(badMono.errors.some((e) => e.includes('(Callout) props.mono must be a boolean')));
  }
});

// ---------------------------------------------------------------------------
// 5. BUILTIN_SKILL_MD: Documentation and version bump
// ---------------------------------------------------------------------------

test('BUILTIN_SKILL_MD: v16 手册包含 Generative UI 与全部组件说明', { timeout: 60_000 }, () => {
  assert.ok(BUILTIN_SKILL_VERSION >= 16, 'BUILTIN_SKILL_VERSION must be at least 16');
  assert.ok(BUILTIN_SKILL_MD.includes('Generative UI'), 'BUILTIN_SKILL_MD must include Generative UI section');
  assert.ok(BUILTIN_SKILL_MD.includes('```ui'), 'BUILTIN_SKILL_MD must mention the ```ui fence');

  for (const compType of BOTD_UI_COMPONENT_TYPES) {
    assert.ok(
      BUILTIN_SKILL_MD.includes(compType),
      `BUILTIN_SKILL_MD must document component ${compType}`,
    );
  }
});
