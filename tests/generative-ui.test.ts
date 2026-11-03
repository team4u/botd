import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  BOTD_UI_CATALOG_VERSION,
  BOTD_UI_COMPONENT_TYPES,
  BOTD_UI_SCHEMA_DOC,
  MAX_UI_SPEC_BYTES,
  MAX_UI_TREE_DEPTH,
  validateUiSpec,
  type BotdUiSpec,
} from '../packages/protocol/src/index.js';
import { createLocalIpcServer } from '../apps/node/src/local-ipc.js';
import { registerNodeCommands } from '../apps/node/src/cli/commands/node.js';
import { BUILTIN_SKILL_MD, BUILTIN_SKILL_VERSION } from '../apps/node/src/builtin-skill.js';
import { GroupRouter } from '../apps/hub/src/group-router.js';
import { HubDatabase } from '../apps/hub/src/db.js';
import { AuthManager } from '../apps/hub/src/auth.js';
import { NodeConnectionManager } from '../apps/hub/src/ws-hub.js';
import { SseHub } from '../apps/hub/src/sse.js';
import type { BgJobManager } from '../apps/node/src/bg-jobs.js';

// ---------------------------------------------------------------------------
// 1. validateUiSpec: Valid Spec with all 15 components, $state, submit action
// ---------------------------------------------------------------------------

test('validateUiSpec: 合法 Spec（包含 15 种组件、$state 绑定与 submit action）通过校验', () => {
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

test('validateUiSpec 拦截非法情况：未知组件类型（验证报错信息包含 Allowed types）', () => {
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

test('validateUiSpec 拦截非法情况：树存在环（Cycle）', () => {
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

test('validateUiSpec 拦截非法情况：超过最大深度', () => {
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

test('validateUiSpec 拦截非法情况：缺少 root 或孤儿 children 引用', () => {
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

test('validateUiSpec 拦截非法情况：非法 action 名称', () => {
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

test('validateUiSpec 拦截非法情况：超长字节限制', () => {
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

test('validateUiSpec 接受新组件与属性：CheckboxGroup(string[] 绑定)、Table、TextInput.multiline、Callout/Accordion mono、Accordion 槽位', () => {
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

test('validateUiSpec 拦截新组件的非法用法：Table 列数不匹配 / monoColumns 越界 / CheckboxGroup 非 string[] / rows 越界', () => {
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
// 3. Local IPC /ask: previewType: 'ui' support and validation
// ---------------------------------------------------------------------------

function listenPort0(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    // Port 0 automatically selects an available port, avoiding 3000
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function postJson(port: number, url: string, body: unknown): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: url,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          out += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const mockAskCalls: any[] = [];
const mockBgManager = {
  listJobs: async () => [],
  getLogs: async () => '',
  kill: async () => {
    throw new Error('noop');
  },
} as unknown as BgJobManager;

function makeTestIpcServer() {
  return createLocalIpcServer({
    identity: { nodeId: 'node_test', name: 'test', hubUrl: 'http://127.0.0.1:1' },
    dataDir: '/tmp/botd-test-data',
    socketPath: '/tmp/botd-test.sock',
    startedAt: Date.now(),
    isHubConnected: () => true,
    getHubRpc: () =>
      ({
        requestHumanInput: async (input: any) => {
          mockAskCalls.push(input);
          return { answer: '{"decision":"approve"}' };
        },
        onSessionStream: { asEvent: () => {} },
        requestWakeupTurn: async () => {},
        uploadArtifact: async () => {
          throw new Error('noop');
        },
        downloadArtifact: async () => {
          throw new Error('noop');
        },
        listSessionArtifacts: async () => [],
        registerNode: async () => {},
        heartbeat: async () => {},
      }) as any,
    bgManager: mockBgManager,
    syncRegistrationWithHub: async () => {},
    handleShutdown: () => {},
  } as any);
}

test('Local IPC /ask 支持 previewType: "ui" 且合法 Spec 正常转发 Hub (200)', async () => {
  mockAskCalls.length = 0;
  const server = makeTestIpcServer();
  const port = await listenPort0(server);
  try {
    const validSpec = {
      root: 'card_root',
      elements: {
        card_root: {
          type: 'Card',
          props: { title: 'Approval Card' },
          children: ['btn_approve'],
        },
        btn_approve: {
          type: 'Button',
          props: { label: 'Approve', variant: 'primary' },
          on: { press: { action: 'submit', params: { decision: 'approve' } } },
        },
      },
    };

    const res = await postJson(port, '/ask', {
      sessionId: 'sess_ui_1',
      botId: 'bot_ui_1',
      prompt: 'Please review and approve',
      previewType: 'ui',
      previewContent: JSON.stringify(validSpec),
    });

    assert.equal(res.status, 200);
    assert.equal(mockAskCalls.length, 1);
    assert.equal(mockAskCalls[0].previewType, 'ui');
    assert.equal(typeof mockAskCalls[0].previewContent, 'string');
    assert.match(mockAskCalls[0].previewContent, /Approval Card/);
  } finally {
    server.close();
  }
});

test('Local IPC /ask 拒绝非法 UI Spec 或缺失 previewContent (400)', async () => {
  mockAskCalls.length = 0;
  const server = makeTestIpcServer();
  const port = await listenPort0(server);
  try {
    // 1. Missing previewContent with previewType: 'ui'
    const res1 = await postJson(port, '/ask', {
      sessionId: 'sess_ui_1',
      botId: 'bot_ui_1',
      prompt: 'Please review',
      previewType: 'ui',
    });
    assert.equal(res1.status, 400);
    assert.match(res1.body, /Missing or empty previewContent/);

    // 2. Invalid UI Spec (unknown component type)
    const invalidSpec = {
      root: 'bad_root',
      elements: {
        bad_root: {
          type: 'UnknownWidget',
          props: {},
        },
      },
    };
    const res2 = await postJson(port, '/ask', {
      sessionId: 'sess_ui_1',
      botId: 'bot_ui_1',
      prompt: 'Please review',
      previewType: 'ui',
      previewContent: JSON.stringify(invalidSpec),
    });
    assert.equal(res2.status, 400);
    const bodyObj = JSON.parse(res2.body);
    assert.match(bodyObj.error, /Invalid UI spec/);
    assert.match(bodyObj.error, /Unknown component type "UnknownWidget"/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Hub GroupRouter.requestHumanInput: previewType: 'ui' validation
// ---------------------------------------------------------------------------

test('Hub GroupRouter.requestHumanInput 校验 UI Spec：拒绝非法 Spec，放行合法 Spec', async () => {
  const db = new HubDatabase({ dbPath: ':memory:' });
  const auth = new AuthManager();
  const sse = new SseHub();
  const connections = new NodeConnectionManager(db, auth, sse);
  const router = new GroupRouter(db, connections, sse);

  // Seed a user and a session
  db.createUser({ id: 'user_1', username: 'admin', passwordHash: 'hash', role: 'admin' });
  db.createSession({
    id: 'sess_hub_ui',
    title: 'UI Test Session',
    mode: 'direct',
    leadBotId: 'bot_1',
    memberBotIds: ['bot_1'],
    ownerId: 'user_1',
  });

  // 1. Rejects when previewType: 'ui' but previewContent is missing
  await assert.rejects(
    () =>
      router.requestHumanInput({
        sessionId: 'sess_hub_ui',
        botId: 'bot_1',
        prompt: 'Confirm action',
        previewType: 'ui',
      }),
    /Invalid UI spec: Missing UI previewContent/,
  );

  // 2. Rejects when previewType: 'ui' with invalid UI Spec
  await assert.rejects(
    () =>
      router.requestHumanInput({
        sessionId: 'sess_hub_ui',
        botId: 'bot_1',
        prompt: 'Confirm action',
        previewType: 'ui',
        previewContent: JSON.stringify({ root: 'r', elements: { r: { type: 'InvalidWidget' } } }),
      }),
    /Invalid UI spec: Unknown component type "InvalidWidget"/,
  );

  // 3. Resolves and normalizes valid UI Spec
  const validSpec = {
    root: 'card',
    elements: {
      card: {
        type: 'Card',
        props: { title: 'Hub Validated Card' },
      },
    },
  };

  const askPromise = router.requestHumanInput({
    sessionId: 'sess_hub_ui',
    botId: 'bot_1',
    prompt: 'Confirm action',
    previewType: 'ui',
    previewContent: JSON.stringify(validSpec),
    timeoutSeconds: 10,
  });

  // Verify pending ask was recorded in DB with normalized JSON
  const pending = db.getPendingAsksForSession('sess_hub_ui');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].previewType, 'ui');
  assert.match(pending[0].previewContent!, /Hub Validated Card/);

  // Resolve the ask
  const answered = router.respondToAsk('sess_hub_ui', pending[0].id, JSON.stringify({ decision: 'ok' }));
  assert.ok(answered);

  const res = await askPromise;
  assert.equal(res.answer, JSON.stringify({ decision: 'ok' }));
});

// ---------------------------------------------------------------------------
// 5. botd ask CLI: Options registration and --ui-schema documentation
// ---------------------------------------------------------------------------

test('botd ask CLI: 验证 --ui 与 --ui-schema 选项已注册，--ui-schema 包含完整文档', async () => {
  const requireFromNodeApp = createRequire(path.join(process.cwd(), 'apps/node', 'package.json'));
  const commander = requireFromNodeApp('commander') as { Command: any };
  const program = new commander.Command();
  registerNodeCommands(program);

  const askCmd = program.commands.find((c: { name: () => string }) => c.name() === 'ask');
  assert.ok(askCmd, 'ask command must be registered');

  const options: string[] = askCmd.options.map((o: { long: string }) => o.long);
  assert.ok(options.includes('--ui'), 'must register --ui');
  assert.ok(options.includes('--ui-schema'), 'must register --ui-schema');

  // Verify schema doc content
  assert.ok(BOTD_UI_SCHEMA_DOC.includes(BOTD_UI_CATALOG_VERSION));
  for (const compType of BOTD_UI_COMPONENT_TYPES) {
    assert.ok(BOTD_UI_SCHEMA_DOC.includes(compType), `Schema doc must include component ${compType}`);
  }
  assert.ok(BOTD_UI_SCHEMA_DOC.includes('$state'), 'Schema doc must describe state binding');
});

// ---------------------------------------------------------------------------
// 6. BUILTIN_SKILL_MD: Documentation and version bump
// ---------------------------------------------------------------------------

test('BUILTIN_SKILL_MD: 版本升级为 7，包含 Generative UI 与 15 个组件说明', () => {
  assert.ok(BUILTIN_SKILL_VERSION >= 7, 'BUILTIN_SKILL_VERSION must be at least 7');
  assert.ok(BUILTIN_SKILL_MD.includes('Generative UI'), 'BUILTIN_SKILL_MD must include Generative UI section');
  assert.ok(BUILTIN_SKILL_MD.includes('--ui'), 'BUILTIN_SKILL_MD must mention botd ask --ui');
  assert.ok(BUILTIN_SKILL_MD.includes('botd ask --ui-schema'), 'BUILTIN_SKILL_MD must mention --ui-schema');

  for (const compType of BOTD_UI_COMPONENT_TYPES) {
    assert.ok(
      BUILTIN_SKILL_MD.includes(compType),
      `BUILTIN_SKILL_MD must document component ${compType}`,
    );
  }
});
