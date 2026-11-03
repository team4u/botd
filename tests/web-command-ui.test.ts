import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { BotConfig, ExtensionUiStreamPayload } from '../packages/protocol/src/index.js';
import { validateUiSpec } from '../packages/protocol/src/index.js';
import { executeBotTurn, getActiveSessionCount, getBotCommands } from '../apps/node/src/runtime.js';
import { saveBot, writeExtension } from '../apps/node/src/storage.js';

/** Inject a provider API key via the BOTD_API_KEY_<PROVIDER> environment override (highest credential priority). */
const withProviderKey = (t: TestContext, variable: string, value: string) => {
  const previous = process.env[variable];
  process.env[variable] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
};

const SIMPLE_UI_SPEC = {
  root: 'card',
  elements: {
    card: {
      type: 'Card',
      props: { title: '部署状态', badge: 'LIVE', icon: 'server' },
      children: ['metric'],
    },
    metric: { type: 'MetricCard', props: { label: '延迟', value: '42ms', status: 'ok' } },
  },
};

interface StreamEventRecord {
  sessionId: string;
  botId: string;
  extensionUiEvent?: ExtensionUiStreamPayload;
  toolUiSpec?: unknown;
  toolName?: string;
  [key: string]: unknown;
}

/** 收集 onSessionStream 事件的 hubRpc mock：可附带 requestHumanInput 交互闭环 */
function makeHubRpc(
  streamEvents: StreamEventRecord[],
  requestHumanInput?: (input: any) => Promise<{ answer: string }>,
) {
  const onSessionStream = Object.assign(
    (event: any) => {
      streamEvents.push(event);
    },
    { asEvent: (event: any) => streamEvents.push(event) },
  );
  const hubRpc: any = { onSessionStream };
  if (requestHumanInput) hubRpc.requestHumanInput = requestHumanInput;
  return hubRpc as unknown as Parameters<typeof executeBotTurn>[3];
}

/** 每个测试独立的 fail-fast 模型服务器：任何模型调用都会让断言失败（命令路径不应触发推理） */
async function startFixture(t: TestContext): Promise<{ dataDir: string }> {
  let modelRequests = 0;
  const server = http.createServer((req, res) => {
    modelRequests++;
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'This test must never call a model' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');

  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-command-ui-'));
  await mkdir(path.join(dataDir, '.agent'), { recursive: true });
  await writeFile(path.join(dataDir, '.agent/models.json'), JSON.stringify({
    providers: {
      'botd-ui-test': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions',
        models: [{ id: 'local', reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }));
  withProviderKey(t, 'BOTD_API_KEY_BOTD_UI_TEST', 'local-key');

  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
    assert.equal(modelRequests, 0, 'extension commands must never reach the model');
    assert.equal(getActiveSessionCount(), 0);
  });
  return { dataDir };
}

const makeBot = (id: string): BotConfig => ({
  id, nodeId: 'node_test', name: id, description: '',
  modelProvider: 'botd-ui-test', modelId: 'local', enabledSkills: [], enabledExtensions: ['ui-commands'],
  updatedAt: new Date().toISOString(),
});

const runCommand = (dataDir: string, bot: BotConfig, hubRpc: unknown, commandText: string, sessionId: string) =>
  executeBotTurn(dataDir, bot, {
    sessionId, botId: bot.id, groupContextPrompt: '', incrementalMessages: '', commandText,
  }, hubRpc as Parameters<typeof executeBotTurn>[3]);

// ---------------------------------------------------------------------------
// 测试 1：纯 TUI 专属方法在网页模式下显式拒绝，try/catch 吞错不会导致假成功
// ---------------------------------------------------------------------------

test('web extension UI: 纯 TUI 方法被安全拦截且吞错不会假成功', { timeout: 60_000 }, async t => {
  const { dataDir } = await startFixture(t);

  const factoryFile = path.join(dataDir, 'factory.txt');
  await writeExtension(dataDir, 'ui-commands', `import fs from 'node:fs';
export default function (pi) {
  const cases = {
    setFooter: (ctx) => ctx.ui.setFooter(() => ({ render: () => [] })),
    setHeader: (ctx) => ctx.ui.setHeader(undefined),
    setEditorComponent: (ctx) => ctx.ui.setEditorComponent(undefined),
    setWidgetFactory: (ctx) => ctx.ui.setWidget('k', () => ({ render: () => [] })),
    setTheme: (ctx) => ctx.ui.setTheme('dark'),
    getTheme: (ctx) => ctx.ui.getTheme('dark'),
    getAllThemes: (ctx) => ctx.ui.getAllThemes(),
    addAutocompleteProvider: (ctx) => ctx.ui.addAutocompleteProvider(() => undefined),
  };
  for (const [name, fn] of Object.entries(cases)) {
    pi.registerCommand('tui_' + name, { handler: async (_args, ctx) => { fn(ctx); } });
  }
  pi.registerCommand('tui_custom', { handler: async (_args, ctx) => {
    await ctx.ui.custom(() => { fs.writeFileSync(${JSON.stringify(factoryFile)}, 'RAN'); return { render: () => [] }; });
  } });
  pi.registerCommand('caught_tui', { handler: async (_args, ctx) => {
    try { await ctx.ui.custom(() => ({ render: () => [] })); } catch {}
    try { ctx.ui.setTheme('dark'); } catch {}
    try { ctx.ui.setFooter(() => ({ render: () => [] })); } catch {}
  } });
}`);
  const bot = makeBot('tui-bot');
  await saveBot(dataDir, bot, 'UI test');
  const hubRpc = makeHubRpc([]);

  for (const name of ['setFooter', 'setHeader', 'setEditorComponent', 'setWidgetFactory', 'setTheme', 'getTheme', 'getAllThemes', 'addAutocompleteProvider', 'custom']) {
    await assert.rejects(
      runCommand(dataDir, bot, hubRpc, `/tui_${name}`, 'sess_tui_guard'),
      /此命令需要终端界面，当前网页不支持/,
      `ui.${name} must be rejected in web mode`,
    );
  }
  await assert.rejects(
    runCommand(dataDir, bot, hubRpc, '/caught_tui', 'sess_tui_guard'),
    /此命令需要终端界面，当前网页不支持/,
    'Catching the UI error inside a handler must not turn it into reported success',
  );
  await assert.rejects(
    import('node:fs/promises').then(fs => fs.readFile(factoryFile)),
    { code: 'ENOENT' },
    'TUI component factory body must never execute',
  );
});

// ---------------------------------------------------------------------------
// 测试 2：流式扩展 UI 方法经 onSessionStream 发出对应的 extensionUiEvent
// ---------------------------------------------------------------------------

test('web extension UI: 流式方法（notify/setStatus/setWidget/setEditorText）推送 extensionUiEvent', { timeout: 60_000 }, async t => {
  const { dataDir } = await startFixture(t);

  await writeExtension(dataDir, 'ui-commands', `export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.setStatus('lifecycle', 'running');
  });
  pi.registerCommand('stream_ui', { handler: async (_args, ctx) => {
    ctx.ui.notify('部署完成', 'info');
    ctx.ui.setStatus('deploy', 'healthy');
    ctx.ui.setWorkingMessage('compiling');
    ctx.ui.setWidget('tips', ['提示一', '提示二'], { placement: 'belowEditor' });
    ctx.ui.setWidget('card', ${JSON.stringify(SIMPLE_UI_SPEC)});
    ctx.ui.setEditorText('draft text');
    ctx.ui.pasteToEditor(' + more');
    if (ctx.ui.getEditorText() !== 'draft text + more') throw new Error('getEditorText mismatch');
    ctx.ui.setWorkingMessage();
    ctx.ui.setWidget('tips', undefined);
  } });
}`);
  const bot = makeBot('stream-bot');
  await saveBot(dataDir, bot, 'UI test');
  const events: StreamEventRecord[] = [];
  const hubRpc = makeHubRpc(events);

  const result = await runCommand(dataDir, bot, hubRpc, '/stream_ui', 'sess_stream_ui');
  assert.match(result.replyText, /已完成执行/);

  const uiEvents = events
    .filter(e => e.extensionUiEvent)
    .map(e => e.extensionUiEvent as ExtensionUiStreamPayload);

  // 生命周期钩子里的 setStatus（session_start 触发）+ 命令 handler 的全部流式调用
  assert.ok(uiEvents.some(e => e.kind === 'status' && e.statusKey === 'lifecycle' && e.statusText === 'running'),
    'session_start ctx.ui.setStatus must stream a status event');
  assert.ok(uiEvents.some(e => e.kind === 'notify' && e.message === '部署完成' && e.notifyType === 'info'));
  assert.ok(uiEvents.some(e => e.kind === 'status' && e.statusKey === 'deploy' && e.statusText === 'healthy'));
  assert.ok(uiEvents.some(e => e.kind === 'working_message' && e.message === 'compiling'));
  assert.ok(uiEvents.some(e => e.kind === 'working_message' && e.message === undefined),
    'setWorkingMessage() 无参调用应发出清理事件');
  const belowWidget = uiEvents.find(e => e.kind === 'widget' && e.widgetKey === 'tips');
  assert.ok(belowWidget && belowWidget.kind === 'widget');
  if (belowWidget.kind === 'widget') {
    assert.deepEqual(belowWidget.lines, ['提示一', '提示二']);
    assert.equal(belowWidget.placement, 'belowEditor');
  }
  assert.ok(uiEvents.some(e => e.kind === 'widget' && e.widgetKey === 'tips' && e.lines === undefined),
    'setWidget(key, undefined) must clear the widget');
  const cardWidget = uiEvents.find(e => e.kind === 'widget' && e.widgetKey === 'card');
  assert.ok(cardWidget && cardWidget.kind === 'widget' && cardWidget.uiSpec,
    'setWidget with BotdUiSpec must carry the validated spec');
  if (cardWidget && cardWidget.kind === 'widget' && cardWidget.uiSpec) {
    assert.equal(validateUiSpec(cardWidget.uiSpec).ok, true);
  }
  assert.ok(uiEvents.some(e => e.kind === 'editor_text' && e.text === 'draft text' && e.mode === 'set'));
  assert.ok(uiEvents.some(e => e.kind === 'editor_text' && e.text === ' + more' && e.mode === 'paste'));
});

// ---------------------------------------------------------------------------
// 测试 3：交互式对话框方法经 requestHumanInput 闭环（含 timeout / AbortSignal / 无通道拒绝）
// ---------------------------------------------------------------------------

test('web extension UI: 交互式方法经 requestHumanInput 完成闭环问答', { timeout: 60_000 }, async t => {
  const { dataDir } = await startFixture(t);

  const interactions: any[] = [];
  const answerFor = (prompt: string): { answer: string } | Promise<{ answer: string }> => {
    // 超时 / abort 场景：挂起不答，让本地守卫先到
    if (prompt.endsWith('x') || prompt.endsWith('挂起')) {
      return new Promise(() => {});
    }
    if (prompt.includes('确认发布')) return { answer: '确认' };
    if (prompt.includes('选择环境')) return { answer: 'production' };
    if (prompt.includes('输入名称')) return { answer: JSON.stringify({ decision: '提交', state: { value: 'botd-prod' } }) };
    if (prompt.includes('编辑文案')) return { answer: JSON.stringify({ decision: '提交', state: { value: 'hello\nworld' } }) };
    if (prompt.includes('自定义面板')) return { answer: JSON.stringify({ decision: 'approve', state: { note: 'ok' } }) };
    return { answer: '确认' };
  };

  await writeExtension(dataDir, 'ui-commands', `export default function (pi) {
  pi.registerCommand('dialog_ok', { handler: async (_args, ctx) => {
    const confirmed = await ctx.ui.confirm('确认发布', '即将发布到生产环境');
    const env = await ctx.ui.select('选择环境', ['staging', 'production']);
    const name = await ctx.ui.input('输入名称', '请输入...');
    const copy = await ctx.ui.editor('编辑文案', 'prefill');
    const custom = await ctx.ui.custom({ prompt: '自定义面板', ui: ${JSON.stringify(SIMPLE_UI_SPEC)} });
    if (!confirmed) throw new Error('confirm should be true');
    if (env !== 'production') throw new Error('select mismatch: ' + env);
    if (name !== 'botd-prod') throw new Error('input mismatch: ' + name);
    if (copy !== 'hello\\nworld') throw new Error('editor mismatch: ' + copy);
    if (!custom || custom.decision !== 'approve') throw new Error('custom mismatch: ' + JSON.stringify(custom));
  } });
  pi.registerCommand('dialog_timeout', { handler: async (_args, ctx) => {
    const confirmed = await ctx.ui.confirm('确认发布x', 'x', { timeout: 80 });
    const picked = await ctx.ui.select('选择环境x', ['staging', 'production'], { timeout: 80 });
    if (confirmed !== false) throw new Error('confirm timeout must resolve false');
    if (picked !== undefined) throw new Error('select timeout must resolve undefined');
  } });
  pi.registerCommand('dialog_abort', { handler: async (_args, ctx) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const picked = await ctx.ui.select('选择环境-挂起', ['staging', 'production'], { signal: controller.signal });
    if (picked !== undefined) throw new Error('aborted select must resolve undefined');
  } });
  pi.registerCommand('dialog_noop', { handler: async (_args, ctx) => {
    try { await ctx.ui.confirm('X', 'y'); } catch {}
  } });
}`);
  const bot = makeBot('dialog-bot');
  await saveBot(dataDir, bot, 'UI test');
  const hubRpc = makeHubRpc([], undefined as never);
  // 注入交互通道
  (hubRpc as any).requestHumanInput = async (input: any) => {
    interactions.push(input);
    return answerFor(input.prompt);
  };

  // 3a. 完整闭环：确认 / 选择 / 表单状态提取 / 自定义 spec JSON 提取
  await runCommand(dataDir, bot, hubRpc, '/dialog_ok', 'sess_dialog');
  assert.ok(
    interactions.some(i => i.prompt === '确认发布\n即将发布到生产环境' && Array.isArray(i.options) && i.options.includes('确认') && i.options.includes('取消')),
    'confirm must send 确认/取消 options with title\\nmessage prompt',
  );
  assert.ok(interactions.some(i => i.prompt === '选择环境' && JSON.stringify(i.options) === JSON.stringify(['staging', 'production'])),
    'select must forward options');
  const inputAsk = interactions.find(i => i.prompt === '输入名称');
  assert.ok(inputAsk, 'input must go through requestHumanInput');
  assert.equal(inputAsk.previewType, 'ui');
  const inputSpec = validateUiSpec(inputAsk.previewContent);
  assert.equal(inputSpec.ok, true, inputSpec.ok ? '' : inputSpec.errors.join('; '));
  assert.match(inputAsk.previewContent!, /请输入\.\.\./);
  const editorAsk = interactions.find(i => i.prompt === '编辑文案');
  assert.ok(editorAsk, 'editor must go through requestHumanInput');
  assert.equal(editorAsk.previewType, 'ui');
  assert.match(editorAsk.previewContent!, /multiline/);
  assert.equal((JSON.parse(editorAsk.previewContent!).state as any).value, 'prefill');
  const customAsk = interactions.find(i => i.prompt === '自定义面板');
  assert.ok(customAsk, 'custom(BotdUiSpec) must go through requestHumanInput');
  assert.equal(customAsk.previewType, 'ui');
  assert.match(customAsk.previewContent!, /部署状态/);

  // 3b. timeout：本地守卫先到，resolve 默认值（confirm=false / select=undefined）
  await runCommand(dataDir, bot, hubRpc, '/dialog_timeout', 'sess_dialog_to');
  const timeoutAsks = interactions.filter(i => i.timeoutSeconds !== undefined && i.timeoutSeconds !== null);
  assert.ok(timeoutAsks.length > 0, 'timeout must be converted to timeoutSeconds');
  assert.ok(timeoutAsks.every(i => i.timeoutSeconds >= 1), 'timeoutSeconds must be at least 1');

  // 3c. AbortSignal：abort 后 resolve undefined
  await runCommand(dataDir, bot, hubRpc, '/dialog_abort', 'sess_dialog_ab');

  // 3d. 无 requestHumanInput 通道：交互方法拒绝且吞错不假成功
  const noAskHubRpc = makeHubRpc([]);
  await assert.rejects(
    runCommand(dataDir, bot, noAskHubRpc, '/dialog_noop', 'sess_dialog_noop'),
    /此命令需要终端界面，当前网页不支持/,
    'interactive methods without requestHumanInput must reject and survive error swallowing',
  );
});

// ---------------------------------------------------------------------------
// 测试 4：工具返回的 details.ui BotdUiSpec 提取到 toolCalls / blocks / 流式 toolUiSpec
// （tool_execution_end 事件即扩展工具 execute() 结果的真实投递形态：result.details.ui）
// ---------------------------------------------------------------------------

test('web extension UI: 工具 details.ui 中的 BotdUiSpec 透传到 tool.view 插槽', async () => {
  const { TurnEventRecorder } = await import('../apps/node/src/runtime/turn-events.js');
  const { toolBlockFromRecord } = await import('../apps/node/src/runtime/tool-preview.js');
  const { createHubStreamSink } = await import('../apps/node/src/runtime/hub-stream.js');

  const toolCalls: import('../packages/protocol/src/index.js').ToolCallRecord[] = [];
  const blocks: import('../packages/protocol/src/index.js').TurnBlock[] = [];
  const streamed: any[] = [];
  const sink = createHubStreamSink({
    onSessionStream: Object.assign(() => {}, { asEvent: (e: any) => streamed.push(e) }) as any,
  } as any);

  const recorder = new TurnEventRecorder({ blocks, toolCalls }, {
    onTool: ({ toolCall, outputPreview, durationMs }) =>
      sink.tool('sess_tool_ui', 'tool-bot', {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolStatus: 'done',
        toolSummary: toolCall.summary,
        toolArgs: toolCall.args,
        toolOutput: outputPreview,
        toolDurationMs: durationMs,
        toolIsError: toolCall.isError,
        ...(toolCall.uiSpec ? { toolUiSpec: toolCall.uiSpec } : {}),
      }),
  });

  recorder.handle({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'deploy_status', args: {} });
  recorder.handle({
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'deploy_status',
    isError: false,
    // 扩展工具 execute() 返回的真实形态：content + details.ui
    result: { content: [{ type: 'text', text: 'deploy ok' }], details: { ui: SIMPLE_UI_SPEC } },
  });

  // toolCalls[].uiSpec：归一化后的 BotdUiSpec
  const call = toolCalls.find(c => c.name === 'deploy_status');
  assert.ok(call, 'tool call record must exist');
  assert.ok(call!.uiSpec, 'toolCalls[].uiSpec must carry the normalized spec');
  assert.equal(validateUiSpec(call!.uiSpec).ok, true);
  assert.equal((call!.uiSpec!.elements.card.props as any).title, '部署状态');

  // blocks 中的 tool block
  const block = blocks.find(b => b.type === 'tool' && b.name === 'deploy_status') as any;
  assert.ok(block?.uiSpec, 'tool block must carry the normalized spec');

  // 兜底重建路径（toolBlockFromRecord）也透传 uiSpec
  const rebuilt = toolBlockFromRecord(call!, 0);
  assert.ok((rebuilt as any).uiSpec, 'toolBlockFromRecord must preserve uiSpec');

  // 流式 onSessionStream 的 toolUiSpec
  const streamCall = streamed.find(e => e.toolName === 'deploy_status' && e.toolUiSpec);
  assert.ok(streamCall, 'onSessionStream must carry toolUiSpec');
  assert.equal(validateUiSpec(streamCall.toolUiSpec).ok, true);

  // 非法 spec / 缺失 ui 时安全降级为 undefined（不影响工具记录本身）
  const badCalls: any[] = [];
  const badRecorder = new TurnEventRecorder(
    { blocks: [], toolCalls: badCalls },
    {},
  );
  badRecorder.handle({ type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'broken_tool', args: {} });
  badRecorder.handle({
    type: 'tool_execution_end',
    toolCallId: 'call_2',
    toolName: 'broken_tool',
    isError: false,
    result: { content: [{ type: 'text', text: 'x' }], details: { ui: { root: 'nope', elements: { nope: { type: 'DatePicker' } } } } },
  });
  assert.equal(badCalls[0].uiSpec, undefined, 'invalid spec must degrade to undefined');
  assert.equal(badCalls[0].outputPreview, 'x');
});
