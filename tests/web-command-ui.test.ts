import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { BotConfig } from '../packages/protocol/src/index.js';
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

test('native extension commands reject unsupported UI without false success and preserve headless fallbacks', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-command-ui-'));
  let modelRequests = 0;
  const server = http.createServer((req, res) => {
    modelRequests++;
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'This test must never call a model' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
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
  const afterUiFile = path.join(dataDir, 'after-ui.txt');
  const factoryFile = path.join(dataDir, 'factory.txt');
  const fallbackFile = path.join(dataDir, 'fallback.txt');
  const cases: Record<string, string> = {
    select: "await ctx.ui.select('Choose', ['yes'])",
    confirm: "await ctx.ui.confirm('Confirm', 'Continue?')",
    input: "await ctx.ui.input('Name')",
    editor: "await ctx.ui.editor('Edit', 'prefill')",
    custom: `await ctx.ui.custom(() => { fs.writeFileSync(${JSON.stringify(factoryFile)}, 'RAN'); return { render: () => [] }; })`,
    onTerminalInput: 'ctx.ui.onTerminalInput(() => {})',
    setEditorText: "ctx.ui.setEditorText('text')",
    notify: "ctx.ui.notify('Completed', 'info')",
    setStatus: "ctx.ui.setStatus('test', 'running')",
    getEditorText: 'ctx.ui.getEditorText()',
    theme: 'void ctx.ui.theme',
    unawaited: "ctx.ui.input('Not awaited')",
  };
  const registrations = Object.entries(cases).map(([name, operation]) => `
  pi.registerCommand('ui_${name}', { handler: async (_args, ctx) => {
    ${operation};
    fs.appendFileSync(${JSON.stringify(afterUiFile)}, '${name} completed\\n');
  } });`).join('\n');
  await writeExtension(dataDir, 'ui-commands', `import fs from 'node:fs';
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => { ctx.ui.setStatus('lifecycle', 'optional'); });
  ${registrations}
  pi.registerCommand('caught_ui', { handler: async (_args, ctx) => {
    try { await ctx.ui.select('Choose', ['yes']); } catch {}
  } });
  pi.registerCommand('fallback', { handler: async (_args, ctx) => {
    if (ctx.hasUI || ctx.mode !== 'print') throw new Error('Invalid headless context');
    if (ctx.hasUI) await ctx.ui.confirm('Optional', 'Continue?');
    fs.appendFileSync(${JSON.stringify(fallbackFile)}, ctx.cwd + '\\n');
  } });
}`);
  const first: BotConfig = {
    id: 'ui-bot', nodeId: 'node_test', name: 'UI command test', description: '',
    modelProvider: 'botd-ui-test', modelId: 'local', enabledSkills: [], enabledExtensions: ['ui-commands'],
    updatedAt: new Date().toISOString(),
  };
  const second: BotConfig = { ...first, id: 'other-ui-bot' };
  await saveBot(dataDir, first, 'UI test');
  await saveBot(dataDir, second, 'UI test');
  const onSessionStream = Object.assign(() => {}, { asEvent: () => {} });
  const hubRpc = { onSessionStream } as unknown as Parameters<typeof executeBotTurn>[3];
  const run = (bot: BotConfig, commandText: string, sessionId = 'sess_ui_guard') => executeBotTurn(dataDir, bot, {
    sessionId, botId: bot.id, groupContextPrompt: '', incrementalMessages: '', commandText,
  }, hubRpc);

  const commands = await getBotCommands(dataDir, first);
  assert(commands.some(command => command.name === 'ui_custom'), 'TUI dependencies cannot be inferred from command metadata');
  assert(commands.some(command => command.name === 'fallback'), 'No per-command allowlist is required');
  for (const name of Object.keys(cases)) {
    await t.test(name, async () => {
      await assert.rejects(run(first, `/ui_${name}`), /此命令需要终端界面，当前网页不支持/);
      assert.equal(modelRequests, 0);
      assert.equal(getActiveSessionCount(), 0);
    });
  }
  await assert.rejects(run(first, '/caught_ui'), /此命令需要终端界面，当前网页不支持/,
    'Catching the UI error inside a handler must not turn it into reported success');
  await assert.rejects(readFile(afterUiFile), { code: 'ENOENT' });
  await assert.rejects(readFile(factoryFile), { code: 'ENOENT' });

  assert.match((await run(second, '/fallback', 'sess_other_ui')).replyText, /已完成执行/);
  assert.match((await run(first, '/fallback')).replyText, /已完成执行/);
  const fallbacks = (await readFile(fallbackFile, 'utf8')).trim().split('\n');
  assert.equal(fallbacks.length, 2, 'Guard state and the shared SDK no-op context must not leak between sessions or BOTs');
  assert.equal(modelRequests, 0);
  assert.equal(getActiveSessionCount(), 0);
});
