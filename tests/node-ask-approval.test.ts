import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';
import { registerNodeCommands, buildApprovalCardSpec, extractApprovalDecision } from '../apps/node/src/cli/commands/node.js';
import { getDaemonSocketPath } from '../apps/node/src/storage.js';
import { validateUiSpec } from '../packages/protocol/src/index.js';
import {
  buildAutomationEventEnv,
  buildBotShellEnv,
  detectAutomationEvent,
} from '../apps/node/src/runtime.js';

// commander lives under apps/node; resolve it exactly like the other CLI tests do.
const requireFromNodeApp = createRequire(path.join(process.cwd(), 'apps/node', 'package.json'));
const { Command } = requireFromNodeApp('commander') as { Command: new () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// 1. buildApprovalCardSpec produces validateUiSpec-passing botd.v1 specs
// ---------------------------------------------------------------------------

test('buildApprovalCardSpec: --risk high --reason --resource 生成可通过 validateUiSpec 的审批卡', () => {
  const spec = buildApprovalCardSpec({
    prompt: '确认执行数据库迁移',
    risk: 'high',
    reason: '修改生产数据库',
    resource: 'prod-db',
    optionList: ['批准', '拒绝'],
  });

  const validation = validateUiSpec(spec);
  assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join('; '));
  if (!validation.ok) return;

  assert.equal(validation.spec.root, 'approval_card');
  const card = validation.spec.elements['approval_card'];
  assert.equal(card.type, 'Card');
  assert.deepEqual(card.props, {
    title: '确认执行数据库迁移',
    badge: 'HIGH',
    icon: 'shield',
  });

  // Callout: high risk -> error variant with Chinese risk title
  const callout = validation.spec.elements['approval_callout'];
  assert.equal(callout.type, 'Callout');
  assert.equal((callout.props as any).variant, 'error');
  assert.equal((callout.props as any).title, '高风险操作确认');
  assert.equal((callout.props as any).content, '修改生产数据库');

  // KeyValueList with mono target resource
  const details = validation.spec.elements['approval_details'];
  assert.equal(details.type, 'KeyValueList');
  assert.deepEqual((details.props as any).items, [
    { key: '目标资源', value: 'prod-db', mono: true },
  ]);

  // Buttons: 批准 -> primary, 拒绝 -> danger, both submit decision params
  const approve = validation.spec.elements['approval_btn_0'];
  assert.equal(approve.type, 'Button');
  assert.equal((approve.props as any).variant, 'primary');
  assert.deepEqual(approve.on, { press: { action: 'submit', params: { decision: '批准' } } });
  const reject = validation.spec.elements['approval_btn_1'];
  assert.equal((reject.props as any).variant, 'danger');
  assert.deepEqual(reject.on, { press: { action: 'submit', params: { decision: '拒绝' } } });

  // Card children wiring: callout + details + action bar
  assert.deepEqual(card.children, ['approval_callout', 'approval_details', 'approval_actions']);
  const actionBar = validation.spec.elements['approval_actions'];
  assert.equal(actionBar.type, 'ActionBar');
  assert.deepEqual(actionBar.children, ['approval_btn_0', 'approval_btn_1']);
});

test('buildApprovalCardSpec: 风险等级映射（medium->warn, low->info, 未指定->warn+APPROVAL 徽标）', () => {
  for (const [risk, variant, title] of [
    ['high', 'error', '高风险操作确认'],
    ['medium', 'warn', '中风险操作确认'],
    ['low', 'info', '低风险操作确认'],
  ] as const) {
    const spec = buildApprovalCardSpec({ prompt: 'p', risk, optionList: ['批准', '拒绝'] });
    const validation = validateUiSpec(spec);
    assert.equal(validation.ok, true);
    if (!validation.ok) continue;
    const callout = validation.spec.elements['approval_callout'];
    assert.equal((callout.props as any).variant, variant, `risk=${risk}`);
    assert.equal((callout.props as any).title, title, `risk=${risk}`);
    assert.equal((validation.spec.elements['approval_card'].props as any).badge, risk.toUpperCase());
  }

  const noRisk = buildApprovalCardSpec({ prompt: 'p', optionList: ['批准', '拒绝'] });
  const noRiskValidation = validateUiSpec(noRisk);
  assert.equal(noRiskValidation.ok, true);
  if (noRiskValidation.ok) {
    assert.equal(noRiskValidation.spec.elements['approval_card'].props?.badge, 'APPROVAL');
    assert.equal(noRiskValidation.spec.elements['approval_callout'].props?.variant, 'warn');
    assert.equal(noRiskValidation.spec.elements['approval_callout'].props?.title, '人工审批确认');
  }
});

test('buildApprovalCardSpec: --file 提供 diff 预览时折叠进默认展开的 Accordion，且关联文件入 KeyValueList', () => {
  const spec = buildApprovalCardSpec({
    prompt: '确认合并分支',
    risk: 'medium',
    filePath: 'changes.diff',
    rawPreview: '@@ -1 +1 @@\n-old\n+new',
    diffPreview: true,
    optionList: ['批准', '拒绝'],
  });

  const validation = validateUiSpec(spec);
  assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join('; '));
  if (!validation.ok) return;

  const details = validation.spec.elements['approval_details'];
  assert.deepEqual((details.props as any).items, [
    { key: '关联文件', value: 'changes.diff', mono: true },
  ]);

  const preview = validation.spec.elements['approval_preview'];
  assert.equal(preview.type, 'Accordion');
  const item = (preview.props as any).items[0];
  assert.equal(item.title, '变更差异预览 (Diff)');
  assert.equal(item.content, '@@ -1 +1 @@\n-old\n+new');
  assert.equal(item.defaultOpen, true);

  // 超长预览被截断，最终 spec 仍可通过校验
  const huge = buildApprovalCardSpec({
    prompt: 'p',
    risk: 'low',
    rawPreview: '+'.repeat(60_000),
    optionList: ['批准', '拒绝'],
  });
  const hugeValidation = validateUiSpec(huge);
  assert.equal(hugeValidation.ok, true, hugeValidation.ok ? '' : hugeValidation.errors.join('; '));
});

test('buildApprovalCardSpec: 按钮变体规则——首个正向 primary，含拒绝/取消/reject 字样 danger，其余 secondary', () => {
  const spec = buildApprovalCardSpec({
    prompt: 'p',
    risk: 'low',
    optionList: ['批准', '稍后提醒', '取消执行', 'reject all', '拒绝', '查看详情'],
  });
  const validation = validateUiSpec(spec);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const variants = (validation.spec.elements['approval_actions'].children ?? []).map(
    (id) => (validation.spec.elements[id].props as any).variant,
  );
  assert.deepEqual(variants, [
    'primary',   // 批准 (first positive)
    'secondary', // 稍后提醒
    'danger',    // 取消执行 (取消)
    'danger',    // reject all
    'danger',    // 拒绝
    'secondary', // 查看详情
  ]);
});

test('buildApprovalCardSpec: 空 prompt 回退为「需要人工审批」，空选项不生成 ActionBar', () => {
  const spec = buildApprovalCardSpec({ prompt: '', reason: '为什么', optionList: [] });
  const validation = validateUiSpec(spec);
  assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join('; '));
  if (!validation.ok) return;
  assert.equal(validation.spec.elements['approval_card'].props?.title, '需要人工审批');
  assert.equal('approval_actions' in validation.spec.elements, false);
});

// ---------------------------------------------------------------------------
// 2. extractApprovalDecision: JSON -> plain decision text
// ---------------------------------------------------------------------------

test('extractApprovalDecision: 从 { decision, state } JSON 提取纯文本，非 JSON 原样返回', () => {
  assert.equal(extractApprovalDecision('{"decision":"批准","state":{}}'), '批准');
  assert.equal(extractApprovalDecision('{"decision":"拒绝","params":{"decision":"拒绝"},"state":{"k":1}}'), '拒绝');
  assert.equal(extractApprovalDecision('批准'), '批准');
  assert.equal(extractApprovalDecision('not json at all'), 'not json at all');
  assert.equal(extractApprovalDecision('{"state":{}}'), '{"state":{}}'); // no decision -> raw
  assert.equal(extractApprovalDecision('["array"]'), '["array"]'); // arrays pass through
});

// ---------------------------------------------------------------------------
// 3. CLI wiring: options registered, invalid --risk errors, payload + output
// ---------------------------------------------------------------------------

interface CapturedAsk {
  url: string;
  body: any;
}

/** Spin up a fake daemon on the node dataDir socket and capture /ask payloads. */
async function withFakeDaemon(
  t: test.TestContext,
  answer: string,
): Promise<{ dataDir: string; asks: CapturedAsk[] }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-ask-risk-'));
  const socketPath = getDaemonSocketPath(dataDir);
  const asks: CapturedAsk[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asks.push({ url: req.url ?? '', body: body ? JSON.parse(body) : undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, asks };
}

function buildProgram(): any {
  const program = new Command();
  program.option('--data-dir <path>', 'Data dir');
  program.option('--json', 'JSON output');
  registerNodeCommands(program);
  return program;
}

test('botd ask CLI: --risk/--reason/--resource 选项已注册', () => {
  const program = buildProgram();
  const askCmd = program.commands.find((c: { name: () => string }) => c.name() === 'ask');
  assert.ok(askCmd, 'ask command must be registered');
  const opts: string[] = askCmd.options.map((o: { long: string }) => o.long);
  assert.ok(opts.includes('--risk'));
  assert.ok(opts.includes('--reason'));
  assert.ok(opts.includes('--resource'));
});

test('botd ask CLI: 非法 --risk 值报 CliError（error: 输出与非零退出码）', async (t) => {
  const { dataDir } = await withFakeDaemon(t, '批准');
  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    const program = buildProgram();
    await program.parseAsync([
      'node', 'cli', 'ask', '确认操作',
      '--data-dir', dataDir,
      '--session', 'sess-1', '--bot', 'bot-1',
      '--risk', 'extreme',
    ]);
    assert.equal(process.exitCode, 1, 'must set non-zero exit code');
    assert.ok(
      errors.some((e) => e.includes('Invalid --risk value "extreme"') && e.includes('low, medium, high')),
      `stderr should carry the CliError, got: ${errors.join('\n')}`,
    );
    process.exitCode = 0;
  } finally {
    console.error = origErr;
  }
});

test('botd ask CLI: --risk high 自动组装 UI 审批卡并发送（previewType=ui + 默认选项）', async (t) => {
  const { dataDir, asks } = await withFakeDaemon(t, '{"decision":"批准","state":{}}');

  const diffFile = path.join(dataDir, 'migration.diff');
  await writeFile(diffFile, '@@ -1 +1 @@\n-old\n+new', 'utf8');

  const origLog = console.log;
  const printed: string[] = [];
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try {
    const program = buildProgram();
    await program.parseAsync([
      'node', 'cli', 'ask', '确认执行数据库迁移',
      '--data-dir', dataDir,
      '--session', 'sess-1', '--bot', 'bot-1',
      '--risk', 'high',
      '--reason', '修改生产数据库',
      '--resource', 'prod-db',
      '--file', diffFile,
      '--timeout', '5',
    ]);

    // exactly one /ask over the socket
    assert.equal(asks.length, 1);
    const payload = asks[0].body;
    assert.equal(payload.sessionId, 'sess-1');
    assert.equal(payload.botId, 'bot-1');
    assert.equal(payload.prompt, '确认执行数据库迁移');
    assert.deepEqual(payload.options, ['批准', '拒绝']); // default options
    assert.equal(payload.previewType, 'ui');

    // the generated card passes validateUiSpec and carries all the pieces
    const validation = validateUiSpec(payload.previewContent);
    assert.equal(validation.ok, true, validation.ok ? '' : validation.errors.join('; '));
    if (validation.ok) {
      const els = validation.spec.elements;
      assert.equal(els['approval_card'].props?.badge, 'HIGH');
      assert.equal(els['approval_callout'].props?.variant, 'error');
      assert.equal(els['approval_callout'].props?.content, '修改生产数据库');
      assert.deepEqual(
        (els['approval_details'].props as any).items.map((i: any) => i.value),
        ['prod-db', diffFile],
      );
      assert.equal(els['approval_preview'].type, 'Accordion');
      assert.match((els['approval_preview'].props as any).items[0].title, /Diff/);
    }

    // decision extracted to plain text for shell scripts
    assert.deepEqual(printed, ['批准']);
  } finally {
    console.log = origLog;
  }
});

test('botd ask CLI: --json 输出完整结构化 JSON（不提取 decision）', async (t) => {
  const answerJson = '{"decision":"拒绝","state":{"note":"风险过高"}}';
  const { dataDir, asks } = await withFakeDaemon(t, answerJson);

  const origLog = console.log;
  const printed: string[] = [];
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try {
    const program = buildProgram();
    await program.parseAsync([
      'node', 'cli', 'ask', '确认操作',
      '--data-dir', dataDir, '--json',
      '--session', 'sess-1', '--bot', 'bot-1',
      '--risk', 'medium',
      '--reason', '删除数据',
      '--timeout', '5',
    ]);

    assert.equal(asks.length, 1);
    assert.equal(asks[0].body.previewType, 'ui');
    assert.equal(printed.length, 1);
    const parsed = JSON.parse(printed[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.answer, answerJson); // full structured JSON, no extraction
  } finally {
    console.log = origLog;
  }
});

test('botd ask CLI: 未传 --options 时仅 --reason 也进入审批模式；--options 覆盖默认按钮', async (t) => {
  const { dataDir, asks } = await withFakeDaemon(t, '通过');

  const origLog = console.log;
  console.log = () => {};
  try {
    const program = buildProgram();
    await program.parseAsync([
      'node', 'cli', 'ask', '升级生产集群?',
      '--data-dir', dataDir,
      '--session', 'sess-1', '--bot', 'bot-1',
      '--reason', '生产变更窗口',
      '--options', '现在升级,推迟到周末,cancel',
      '--timeout', '5',
    ]);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].body.previewType, 'ui');
    assert.deepEqual(asks[0].body.options, ['现在升级', '推迟到周末', 'cancel']);

    const validation = validateUiSpec(asks[0].body.previewContent);
    assert.equal(validation.ok, true);
    if (validation.ok) {
      const els = validation.spec.elements;
      // badge falls back to APPROVAL when no --risk given
      assert.equal(els['approval_card'].props?.badge, 'APPROVAL');
      const variants = (els['approval_actions'].children ?? []).map(
        (id) => els[id].props?.variant,
      );
      assert.deepEqual(variants, ['primary', 'secondary', 'danger']);
    }
  } finally {
    console.log = origLog;
  }
});

test('botd ask CLI: --ui 手写 spec 时 --risk 等参数不触发审批卡组装', async (t) => {
  const handWritten = {
    root: 'card_root',
    elements: {
      card_root: { type: 'Card', props: { title: 'Custom card' }, children: ['btn_1'] },
      btn_1: {
        type: 'Button',
        props: { label: 'OK', variant: 'primary' },
        on: { press: { action: 'submit', params: { decision: 'ok' } } },
      },
    },
  };
  const { dataDir, asks } = await withFakeDaemon(t, 'ok');
  const uiFile = path.join(dataDir, 'custom.ui.json');
  await writeFile(uiFile, JSON.stringify(handWritten), 'utf8');

  const origLog = console.log;
  console.log = () => {};
  try {
    const program = buildProgram();
    await program.parseAsync([
      'node', 'cli', 'ask', '自定义卡片',
      '--data-dir', dataDir,
      '--session', 'sess-1', '--bot', 'bot-1',
      '--risk', 'high', '--reason', 'x', '--resource', 'y',
      '--ui', '--file', uiFile,
      '--timeout', '5',
    ]);

    assert.equal(asks.length, 1);
    assert.equal(asks[0].body.previewType, 'ui');
    const validation = validateUiSpec(asks[0].body.previewContent);
    assert.equal(validation.ok, true);
    if (validation.ok) {
      assert.equal(validation.spec.root, 'card_root'); // user's spec, not approval_card
      assert.equal('approval_callout' in validation.spec.elements, false);
    }
    // --ui wins over approval mode: raw answer printed, no decision extraction
  } finally {
    console.log = origLog;
  }
});

// ---------------------------------------------------------------------------
// 4. runtime.ts: automation event env injection
// ---------------------------------------------------------------------------

test('detectAutomationEvent: 解析各类自动化唤醒标记', () => {
  assert.deepEqual(
    detectAutomationEvent('bot_1: [Wake-up] [定时任务: 每日巡检] 检查服务状态'),
    { kind: 'cron', name: '每日巡检' },
  );
  assert.deepEqual(
    detectAutomationEvent('User: [Wake-up] [Timer: 延时任务] xxx'),
    { kind: 'once', name: '延时任务' },
  );
  assert.deepEqual(
    detectAutomationEvent('[Wake-up] [Webhook: github-hook] deploy\nPayload: {...}'),
    { kind: 'webhook', name: 'github-hook' },
  );
  assert.deepEqual(
    detectAutomationEvent('[Wake-up] [手动触发: 手动测试] run'),
    { kind: 'manual-trigger', name: '手动测试' },
  );
  assert.deepEqual(
    detectAutomationEvent('[Wake-up] [延时唤醒 bot-1] xxx'),
    { kind: 'delayed-wake', name: 'bot-1' },
  );
  assert.deepEqual(
    detectAutomationEvent('[Wake-up] [Background Job bg_1] 命令 "make" 执行完成'),
    { kind: 'bg-job', name: 'bg_1' },
  );

  // Non-automation turns
  assert.equal(detectAutomationEvent('User: 帮我部署'), undefined);
  assert.equal(detectAutomationEvent('bot_1: [Wake-up] 普通唤醒消息'), undefined);
  assert.equal(detectAutomationEvent(''), undefined);
});

test('buildBotShellEnv: 自动化事件环境变量随 turnEnv 注入 shell（bot 专属 env 可覆盖）', () => {
  const env = buildBotShellEnv(
    { PATH: '/usr/bin' },
    {
      dataDir: '/tmp/botd-data',
      binDir: '/tmp/botd-data/bin',
      sessionId: 'sess-1',
      botId: 'bot-1',
      botEnv: {},
      turnEnv: {
        BOTD_NODE_ID: 'node-1',
        ...buildAutomationEventEnv('[Wake-up] [Webhook: deploy-hook] 上线', new Date('2025-06-01T00:00:00.000Z')),
      },
    },
  );
  assert.equal(env.BOTD_SESSION_ID, 'sess-1');
  assert.equal(env.BOTD_BOT_ID, 'bot-1');
  assert.equal(env.BOTD_TURN_TRIGGER, 'automation');
  assert.equal(env.BOTD_TURN_EVENT_KIND, 'webhook');
  assert.equal(env.BOTD_TURN_EVENT_NAME, 'deploy-hook');
  assert.equal(env.BOTD_TURN_EVENT_AT, '2025-06-01T00:00:00.000Z');
});

test('buildAutomationEventEnv: 自动化触发与手动触发的环境变量集合', () => {
  const now = new Date('2025-06-01T00:00:00.000Z');
  const auto = buildAutomationEventEnv('bot_1: [Wake-up] [定时任务: 每日巡检] 巡检', now);
  assert.deepEqual(auto, {
    BOTD_TURN_TRIGGER: 'automation',
    BOTD_TURN_EVENT_KIND: 'cron',
    BOTD_TURN_EVENT_NAME: '每日巡检',
    BOTD_TURN_EVENT_AT: '2025-06-01T00:00:00.000Z',
  });

  const manual = buildAutomationEventEnv('User: 帮我查一下日志', now);
  assert.equal(manual.BOTD_TURN_TRIGGER, 'manual');
  assert.equal(manual.BOTD_TURN_EVENT_KIND, 'chat');
  assert.equal(manual.BOTD_TURN_EVENT_NAME, '');
});
