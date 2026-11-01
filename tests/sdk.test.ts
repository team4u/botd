import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { executeBotTurn, getActiveSessionCount, getBotCommands } from '../apps/node/src/runtime.js';
import { saveBot, writeExtension, writeSkill } from '../apps/node/src/storage.js';

/**
 * Inject a provider API key through the BOTD_API_KEY_<PROVIDER> environment override
 * (highest credential priority) and restore the previous value when the test ends.
 */
const withProviderKey = (t: TestContext, variable: string, value: string) => {
  const previous = process.env[variable];
  process.env[variable] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
};
import type { BotConfig, ChatCommand, HubRpcFunctions } from '../packages/protocol/src/index.js';

test('real Pi SDK uses isolated resources, private logs and per-turn bash identity', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-sdk-test-'));
  const requests: any[] = [];
  const authorizations: (string | undefined)[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    authorizations.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const hasToolResult = body.messages.some((message: any) => message.role === 'tool');
    const chunk = (delta: unknown, finishReason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    if (!hasToolResult) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_identity', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf "IDENTITY=%s|%s|%s\\n" "$BOTD_SESSION_ID" "$BOTD_BOT_ID" "$BOTD_DATA_DIR"; botd --help' }) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: 'Local inference completed.' });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
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
  await writeFile(path.join(dataDir, '.agent/models.json'), JSON.stringify({ providers: { 'botd-test': { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'registry-key-must-be-overridden', models: [{ id: 'local', reasoning: false, contextWindow: 8192, maxTokens: 1024 }] } } }));
  withProviderKey(t, 'BOTD_API_KEY_BOTD_TEST', 'local-key');
  await writeSkill(dataDir, 'enabled', '---\nname: enabled\ndescription: ENABLED_SKILL_DESC loads CLI usage on demand\n---\nENABLED_SKILL_BODY_MARKER');
  await writeSkill(dataDir, 'disabled', 'DISABLED_SKILL_MUST_NOT_LOAD');
  await mkdir(path.join(dataDir, '.pi'), { recursive: true });
  await writeFile(path.join(dataDir, 'AGENTS.md'), 'ANCESTOR_CONTEXT_MUST_NOT_LOAD');
  await writeFile(path.join(dataDir, '.pi/SYSTEM.md'), 'PI_CONTEXT_MUST_NOT_LOAD');
  const events: Parameters<HubRpcFunctions['onSessionStream']>[0][] = [];
  const onSessionStream = Object.assign(() => {}, { asEvent: (event: Parameters<HubRpcFunctions['onSessionStream']>[0]) => events.push(event) });
  const hubRpc = { onSessionStream } as unknown as Parameters<typeof executeBotTurn>[3];
  const bots: BotConfig[] = ['alpha', 'beta'].map(id => ({ id, nodeId: 'node_test', name: id, description: '', modelProvider: 'botd-test', modelId: 'local', enabledSkills: ['enabled'], updatedAt: new Date().toISOString() }));
  for (const bot of bots) {
    await saveBot(dataDir, bot, `ROLE_MARKER_${bot.id}`);
    await writeFile(path.join(dataDir, 'bots', bot.id, 'MEMORY.md'), `MEMORY_MARKER_${bot.id}`);
    await writeFile(path.join(dataDir, 'bots', bot.id, 'workspace', 'AGENTS.md'), 'WORKSPACE_CONTEXT_MUST_NOT_LOAD');
  }
  const originalSessionEnv = process.env.BOTD_SESSION_ID;
  const originalBotEnv = process.env.BOTD_BOT_ID;
  const input = (bot: BotConfig) => ({ sessionId: `sess_${bot.id}`, botId: bot.id, groupContextPrompt: 'GROUP_CONTEXT_MARKER', incrementalMessages: `User: Perform local verification ${bot.id}` });
  const first = executeBotTurn(dataDir, bots[0], input(bots[0]), hubRpc);
  await assert.rejects(executeBotTurn(dataDir, bots[0], input(bots[0]), hubRpc), /already running/);
  const results = await Promise.all([first, executeBotTurn(dataDir, bots[1], input(bots[1]), hubRpc)]);
  assert.deepEqual(results.map(result => result.replyText), ['Local inference completed.', 'Local inference completed.']);
  assert.equal(requests.length, 4);
  assert(authorizations.every(value => value === 'Bearer local-key'));
  await assert.rejects(executeBotTurn(dataDir, { ...bots[0], modelId: 'missing-model' }, { ...input(bots[0]), sessionId: 'sess_missing' }, hubRpc), /Model not found/);
  assert.equal(requests.length, 4, 'Unknown models must fail before contacting an endpoint');
  const system = requests[0].messages.filter((message: any) => message.role === 'system' || message.role === 'developer').map((message: any) => JSON.stringify(message.content)).join('\n');
  assert.match(system, /ROLE_MARKER_/);
  assert.match(system, /MEMORY_MARKER_/);
  assert.match(system, /ENABLED_SKILL_DESC/, 'Pi must natively advertise the enabled skill name and description');
  assert.equal(system.includes('ENABLED_SKILL_BODY_MARKER'), false, 'Enabled skill bodies must load on demand instead of being injected every turn');
  assert.match(system, /GROUP_CONTEXT_MARKER/);
  assert.equal(system.includes('DISABLED_SKILL_MUST_NOT_LOAD'), false);
  assert.equal(system.includes('ANCESTOR_CONTEXT_MUST_NOT_LOAD'), false);
  assert.equal(system.includes('WORKSPACE_CONTEXT_MUST_NOT_LOAD'), false);
  assert.equal(system.includes('PI_CONTEXT_MUST_NOT_LOAD'), false);
  for (const bot of bots) {
    const privateLog = await readFile(path.join(dataDir, 'bots', bot.id, 'sessions', `sess_${bot.id}.jsonl`), 'utf8');
    assert(privateLog.includes(`IDENTITY=sess_${bot.id}|${bot.id}|${dataDir}`), 'Bash identity should be private and scoped to its own turn');
    assert.match(privateLog, /botd (?:join|CLI)|Usage:|用法/);
  }
  assert(events.some(event => event.deltaText === 'Local inference completed.'));
  assert(events.some(event => event.toolName === 'bash' && event.toolStatus === 'running'));
  assert(events.every(event => event.deltaText === undefined || !event.deltaText.includes('IDENTITY=')));
  assert.equal(process.env.BOTD_SESSION_ID, originalSessionEnv);
  assert.equal(process.env.BOTD_BOT_ID, originalBotEnv);
  assert.equal(getActiveSessionCount(), 0);
});

test('DefaultResourceLoader loads only enabledExtensions and intercepts bash tool calls via guard extension', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-sdk-ext-test-'));
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finishReason: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);

    const toolMessages = body.messages.filter((message: any) => message.role === 'tool');
    if (toolMessages.length === 0) {
      chunk({
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call_forbidden',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'echo FORBIDDEN_WORD' }) },
        }],
      });
      chunk({}, 'tool_calls');
    } else if (toolMessages.length === 1) {
      const toolContent = typeof toolMessages[0].content === 'string' ? toolMessages[0].content : JSON.stringify(toolMessages[0].content);
      assert(toolContent.includes('Blocked FORBIDDEN_WORD by guard extension'), 'First tool result must contain blocked reason from guard extension');
      assert(!toolContent.includes('UNMOUNTED_EXTENSION_MUST_NOT_RUN'), 'Unmounted extension must not run');
      chunk({
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call_safe',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'printf "SAFE_OK"' }) },
        }],
      });
      chunk({}, 'tool_calls');
    } else {
      const secondToolContent = typeof toolMessages[1].content === 'string' ? toolMessages[1].content : JSON.stringify(toolMessages[1].content);
      assert(secondToolContent.includes('SAFE_OK'), 'Second tool result must contain SAFE_OK');
      chunk({ role: 'assistant', content: 'Guard extension verified.' });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
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
      'botd-test': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-completions',
        apiKey: 'registry-key-must-be-overridden',
        models: [{ id: 'local', reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }));
  withProviderKey(t, 'BOTD_API_KEY_BOTD_TEST', 'local-key');

  await writeExtension(
    dataDir,
    'guard',
    `export default function (pi: any) {
  pi.on('tool_call', async (event: any) => {
    if (event.toolName === 'bash' && String(event.input?.command || '').includes('FORBIDDEN_WORD')) {
      return { block: true, reason: 'Blocked FORBIDDEN_WORD by guard extension' };
    }
  });
}
`
  );

  await writeExtension(
    dataDir,
    'unmounted',
    `export default function (pi: any) {
  pi.on('tool_call', async () => {
    return { block: true, reason: 'UNMOUNTED_EXTENSION_MUST_NOT_RUN' };
  });
}
`
  );

  const bot: BotConfig = {
    id: 'guarded-bot',
    nodeId: 'node_test',
    name: 'guarded-bot',
    description: '',
    modelProvider: 'botd-test',
    modelId: 'local',
    enabledSkills: [],
    enabledExtensions: ['guard'],
    updatedAt: new Date().toISOString(),
  };
  await saveBot(dataDir, bot, 'Guard extension test bot');

  const events: Parameters<HubRpcFunctions['onSessionStream']>[0][] = [];
  const onSessionStream = Object.assign(() => {}, { asEvent: (event: Parameters<HubRpcFunctions['onSessionStream']>[0]) => events.push(event) });
  const hubRpc = { onSessionStream } as unknown as Parameters<typeof executeBotTurn>[3];

  const result = await executeBotTurn(
    dataDir,
    bot,
    {
      sessionId: 'sess_guard',
      botId: bot.id,
      groupContextPrompt: 'GUARD_CONTEXT_MARKER',
      incrementalMessages: 'User: Execute bash commands with guard verification',
    },
    hubRpc
  );

  assert.equal(result.replyText, 'Guard extension verified.');
  assert.equal(requests.length, 3);

  const req2ToolMessages = requests[1].messages.filter((m: any) => m.role === 'tool');
  assert.equal(req2ToolMessages.length, 1);
  assert(String(req2ToolMessages[0].content).includes('Blocked FORBIDDEN_WORD by guard extension'));
  assert(!String(req2ToolMessages[0].content).includes('UNMOUNTED_EXTENSION_MUST_NOT_RUN'));

  const req3ToolMessages = requests[2].messages.filter((m: any) => m.role === 'tool');
  assert.equal(req3ToolMessages.length, 2);
  assert(String(req3ToolMessages[0].content).includes('Blocked FORBIDDEN_WORD by guard extension'));
  assert(String(req3ToolMessages[1].content).includes('SAFE_OK'));

  const privateLog = await readFile(path.join(dataDir, 'bots', bot.id, 'sessions', 'sess_guard.jsonl'), 'utf8');
  assert(privateLog.includes('Blocked FORBIDDEN_WORD by guard extension'), 'Private log must contain blocked reason');
  assert(privateLog.includes('SAFE_OK'), 'Private log must contain SAFE_OK from safe bash command');
  assert(!privateLog.includes('UNMOUNTED_EXTENSION_MUST_NOT_RUN'), 'Private log must not contain unmounted extension');
  assert.equal(getActiveSessionCount(), 0);
});

test('getBotCommands automatically lists isolated enabled resources without model or lifecycle side effects, preserving native priority and reloads', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-cmds-test-'));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const sideEffectFile = path.join(dataDir, 'session_start_side_effect.txt');

  await writeSkill(dataDir, 'test-skill', '---\ndescription: Test skill description\n---\n# Test Skill\nSkill body');
  await writeSkill(dataDir, 'disabled-skill', '---\ndescription: Disabled skill description\n---\n# Disabled Skill\nDisabled body');

  const botId = 'cmd-bot';
  const botPromptsDir = path.join(dataDir, 'bots', botId, 'prompts');
  await mkdir(botPromptsDir, { recursive: true });
  await writeFile(
    path.join(botPromptsDir, 'review.md'),
    '---\ndescription: Review code template\nargument-hint: <file>\n---\nReview $1 carefully'
  );
  await writeFile(
    path.join(botPromptsDir, 'shadowed.md'),
    '---\ndescription: Shadowed template\nargument-hint: <arg>\n---\nTemplate body'
  );

  await writeExtension(
    dataDir,
    'allowed-ext',
    `export default function (pi: any) {
  pi.registerCommand('allowed_cmd', {
    description: 'Allowed extension command',
    handler: async () => {},
  });
  pi.on('session_start', async () => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(${JSON.stringify(sideEffectFile)}, 'SIDE_EFFECT');
  });
}
`
  );

  await writeExtension(
    dataDir,
    'forbidden-ext',
    `export default function (pi: any) {
  pi.registerCommand('shadowed', {
    description: 'Shadowing extension command',
    handler: async () => {},
  });
  pi.registerCommand('forbidden_cmd', {
    description: 'Forbidden extension command',
    handler: async () => {},
  });
}
`
  );

  const bot: BotConfig = {
    id: botId,
    nodeId: 'node_test',
    name: 'cmd-bot',
    description: 'Bot without model credentials for getBotCommands testing',
    modelProvider: 'unconfigured-provider',
    modelId: 'unconfigured-model',
    enabledSkills: ['test-skill'],
    enabledExtensions: ['allowed-ext', 'forbidden-ext'],
    webCommandNames: ['allowed_cmd'],
    updatedAt: new Date().toISOString(),
  };
  await saveBot(dataDir, bot, 'Command bot system');

  const commands = await getBotCommands(dataDir, bot);

  const skillCmd = commands.find(c => c.name === 'skill:test-skill');
  assert(skillCmd, 'Enabled skill must be listed with skill: prefix');
  assert.equal(skillCmd.source, 'skill');
  assert.equal(skillCmd.description, 'Test skill description');

  assert(!commands.some(c => c.name === 'skill:disabled-skill'), 'Disabled skill must not be listed');

  const promptCmd = commands.find(c => c.name === 'review');
  assert(promptCmd, 'BOT private prompt must be listed');
  assert.equal(promptCmd.source, 'prompt');
  assert.equal(promptCmd.description, 'Review code template');
  assert.equal(promptCmd.argumentHint, '<file>');

  const extCmd = commands.find(c => c.name === 'allowed_cmd');
  assert(extCmd, 'Allowed extension command must be listed');
  assert.equal(extCmd.source, 'extension');
  assert.equal(extCmd.description, 'Allowed extension command');

  assert(commands.some(c => c.name === 'forbidden_cmd' && c.source === 'extension'), 'Every enabled extension command must appear regardless of legacy metadata');
  assert.equal(commands.filter(c => c.name === 'shadowed').length, 1);
  assert.equal(commands.find(c => c.name === 'shadowed')?.source, 'extension', 'Extension must take precedence over the same-named prompt');
  assert(!commands.some(c => c.name === 'hotkeys' || c.name === 'settings'), 'Builtin TUI commands are not part of the SDK command directory');

  const withoutLegacyMetadata = { ...bot };
  delete withoutLegacyMetadata.webCommandNames;
  assert.deepEqual(await getBotCommands(dataDir, withoutLegacyMetadata), commands);
  assert.deepEqual(await getBotCommands(dataDir, { ...bot, webCommandNames: [] }), commands);
  const disabledExtensionCommands = await getBotCommands(dataDir, { ...bot, enabledExtensions: ['allowed-ext'] });
  assert(!disabledExtensionCommands.some(c => c.name === 'forbidden_cmd'), 'BOT extension enablement still controls availability');
  assert.equal(disabledExtensionCommands.find(c => c.name === 'shadowed')?.source, 'prompt');

  const sideEffectExists = await readFile(sideEffectFile).then(() => true, () => false);
  assert.equal(sideEffectExists, false, 'getBotCommands must not trigger session_start lifecycle side effects');

  await rm(path.join(botPromptsDir, 'review.md'));
  await writeFile(
    path.join(botPromptsDir, 'deploy.md'),
    '---\ndescription: Deploy template\nargument-hint: <env>\n---\nDeploy to $1'
  );

  const updatedCommands = await getBotCommands(dataDir, bot);
  assert(!updatedCommands.some(c => c.name === 'review'), 'Removed prompt must not appear after reload');
  const deployCmd = updatedCommands.find(c => c.name === 'deploy');
  assert(deployCmd, 'Newly added prompt must appear after reload');
  assert.equal(deployCmd.argumentHint, '<env>');
});

test('executeBotTurn expands /skill: and prompt templates with $1/$@ and carries incremental history as separate context', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-turn-expand-'));
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finishReason: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    chunk({ role: 'assistant', content: 'Turn completed.' });
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
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
      'botd-test': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-completions',
        apiKey: 'local-key',
        models: [{ id: 'local', reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }));
  withProviderKey(t, 'BOTD_API_KEY_BOTD_TEST', 'local-key');

  await writeSkill(dataDir, 'format-skill', '---\ndescription: Formatter skill\n---\n# Format Rules\nUse standard formatting.');

  const botId = 'expand-bot';
  const botPromptsDir = path.join(dataDir, 'bots', botId, 'prompts');
  await mkdir(botPromptsDir, { recursive: true });
  await writeFile(
    path.join(botPromptsDir, 'greet.md'),
    '---\ndescription: Greet template\nargument-hint: <name> <role>\n---\nHello $1! Role is $2. All: $@'
  );

  const bot: BotConfig = {
    id: botId,
    nodeId: 'node_test',
    name: 'expand-bot',
    description: '',
    modelProvider: 'botd-test',
    modelId: 'local',
    enabledSkills: ['format-skill'],
    updatedAt: new Date().toISOString(),
  };
  await saveBot(dataDir, bot, 'Expand bot system');

  const onSessionStream = Object.assign(() => {}, { asEvent: () => {} });
  const hubRpc = { onSessionStream } as unknown as Parameters<typeof executeBotTurn>[3];

  await executeBotTurn(
    dataDir,
    bot,
    {
      sessionId: 'sess_expand_prompt',
      botId: bot.id,
      groupContextPrompt: 'GROUP_CTX_MARKER',
      incrementalMessages: 'User: Earlier chat message\nAssistant: Earlier reply',
      commandText: '/greet Alice Admin',
    },
    hubRpc
  );

  assert.equal(requests.length, 1);
  const promptReq = requests[0];
  const userMessages = promptReq.messages.filter((m: any) => m.role === 'user');
  assert(userMessages.length > 0);
  const promptUserText = typeof userMessages[0].content === 'string'
    ? userMessages[0].content
    : JSON.stringify(userMessages[0].content);
  assert(promptUserText.includes('Hello Alice! Role is Admin. All: Alice Admin'), 'Template placeholders $1, $2, $@ must be expanded natively by Pi');
  assert(!promptUserText.includes('Earlier chat message'), 'commandText prompt must not be prefixed with incremental history');

  const systemMessages = promptReq.messages.filter((m: any) => m.role === 'system' || m.role === 'developer');
  const systemText = systemMessages.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  assert(systemText.includes('GROUP_CTX_MARKER'), 'Group context prompt must be present in context');
  assert(systemText.includes('Earlier chat message'), 'Incremental history must be supplied as separate context');

  await executeBotTurn(
    dataDir,
    bot,
    {
      sessionId: 'sess_expand_skill',
      botId: bot.id,
      groupContextPrompt: 'GROUP_CTX_MARKER',
      incrementalMessages: '',
      commandText: '/skill:format-skill target.ts',
    },
    hubRpc
  );

  assert.equal(requests.length, 2);
  const skillReq = requests[1];
  const skillUserMessages = skillReq.messages.filter((m: any) => m.role === 'user');
  const skillUserText = typeof skillUserMessages[0].content === 'string'
    ? skillUserMessages[0].content
    : skillUserMessages[0].content.map((part: { text?: string }) => part.text ?? '').join('\n');
  assert(skillUserText.includes('<skill name="format-skill"'), 'Skill command /skill:format-skill must expand skill XML block natively');
  assert(skillUserText.includes('target.ts'), 'Skill arguments must follow the expanded skill block');
});

test('executeBotTurn automatically executes enabled extension commands without model calls, rejects unknown commands and propagates handler errors', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-ext-cmd-'));
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finishReason: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    chunk({ role: 'assistant', content: 'Assistant turn 1 output' });
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
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
      'botd-test': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-completions',
        apiKey: 'local-key',
        models: [{ id: 'local', reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }));
  withProviderKey(t, 'BOTD_API_KEY_BOTD_TEST', 'local-key');

  const pureOutputFile = path.join(dataDir, 'pure_cmd_output.txt');

  await writeExtension(
    dataDir,
    'cmd-ext',
    `export default function (pi: any) {
  pi.registerCommand('pure_cmd', {
    description: 'Pure command',
    handler: async (args: string) => {
      const fs = await import('node:fs/promises');
      await fs.writeFile(${JSON.stringify(pureOutputFile)}, 'EXECUTED:' + args);
    },
  });
  pi.registerCommand('failing_cmd', {
    description: 'Failing command',
    handler: async () => {
      throw new Error('COMMAND_EXECUTION_FAILED');
    },
  });
  pi.registerCommand('disallowed_cmd', {
    description: 'Disallowed command',
    handler: async () => {},
  });
}
`
  );

  const bot: BotConfig = {
    id: 'ext-cmd-bot',
    nodeId: 'node_test',
    name: 'ext-cmd-bot',
    description: '',
    modelProvider: 'botd-test',
    modelId: 'local',
    enabledSkills: [],
    enabledExtensions: ['cmd-ext'],
    webCommandNames: [],
    updatedAt: new Date().toISOString(),
  };
  await saveBot(dataDir, bot, 'Command test bot');

  const onSessionStream = Object.assign(() => {}, { asEvent: () => {} });
  const hubRpc = { onSessionStream } as unknown as Parameters<typeof executeBotTurn>[3];

  const firstTurn = await executeBotTurn(
    dataDir,
    bot,
    {
      sessionId: 'sess_cmd_shared',
      botId: bot.id,
      groupContextPrompt: '',
      incrementalMessages: 'User: Initiate session with assistant output',
    },
    hubRpc
  );
  assert.equal(firstTurn.replyText, 'Assistant turn 1 output');
  assert.equal(requests.length, 1);

  const cmdTurn = await executeBotTurn(
    dataDir,
    bot,
    {
      sessionId: 'sess_cmd_shared',
      botId: bot.id,
      groupContextPrompt: '',
      incrementalMessages: 'User: /pure_cmd custom_arg',
      commandText: '/pure_cmd custom_arg',
    },
    hubRpc
  );

  assert.equal(requests.length, 1, 'Pure extension command must not trigger a model inference request');
  assert.notEqual(cmdTurn.replyText, 'Assistant turn 1 output', 'Pure command must not echo the assistant reply from the previous turn');
  assert.match(cmdTurn.replyText, /完成|done|finished/i, 'Pure command should return completion notice');
  const written = await readFile(pureOutputFile, 'utf8');
  assert.equal(written, 'EXECUTED:custom_arg');

  const previouslyUnlistedCommand = await executeBotTurn(
    dataDir,
    bot,
    {
      sessionId: 'sess_cmd_shared',
      botId: bot.id,
      groupContextPrompt: '',
      incrementalMessages: '',
      commandText: '/disallowed_cmd',
    },
    hubRpc,
  );
  assert.match(previouslyUnlistedCommand.replyText, /完成|done|finished/i);
  assert.equal(requests.length, 1, 'Legacy empty command lists must not block execution or cause a model request');

  await assert.rejects(
    executeBotTurn(
      dataDir,
      bot,
      {
        sessionId: 'sess_cmd_shared',
        botId: bot.id,
        groupContextPrompt: '',
        incrementalMessages: '',
        commandText: '/unknown_xyz_command',
      },
      hubRpc
    ),
    /unknown|未知/i,
    'Unknown slash command must be rejected with clear error rather than treated as a model prompt'
  );

  await assert.rejects(
    executeBotTurn(
      dataDir,
      bot,
      {
        sessionId: 'sess_cmd_shared',
        botId: bot.id,
        groupContextPrompt: '',
        incrementalMessages: '',
        commandText: '/failing_cmd',
      },
      hubRpc
    ),
    /COMMAND_EXECUTION_FAILED/,
    'Handler errors must be propagated and not report silent success'
  );
});

test('executeBotTurn waits for model response when extension command triggers turn via pi.sendUserMessage', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-trigger-turn-'));
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finishReason: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    chunk({ role: 'assistant', content: 'Reply for triggered message.' });
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
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
      'botd-test': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-completions',
        apiKey: 'local-key',
        models: [{ id: 'local', reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }));
  withProviderKey(t, 'BOTD_API_KEY_BOTD_TEST', 'local-key');

  await writeExtension(
    dataDir,
    'sender-ext',
    `export default function (pi: any) {
  pi.registerCommand('trigger_msg', {
    description: 'Trigger message command',
    handler: async (args: string) => {
      await pi.sendUserMessage('Triggered query: ' + args);
    },
  });
}
`
  );

  const bot: BotConfig = {
    id: 'sender-bot',
    nodeId: 'node_test',
    name: 'sender-bot',
    description: '',
    modelProvider: 'botd-test',
    modelId: 'local',
    enabledSkills: [],
    enabledExtensions: ['sender-ext'],
    updatedAt: new Date().toISOString(),
  };
  await saveBot(dataDir, bot, 'Sender bot system');

  const onSessionStream = Object.assign(() => {}, { asEvent: () => {} });
  const hubRpc = { onSessionStream } as unknown as Parameters<typeof executeBotTurn>[3];

  const result = await executeBotTurn(
    dataDir,
    bot,
    {
      sessionId: 'sess_sender',
      botId: bot.id,
      groupContextPrompt: '',
      incrementalMessages: '',
      commandText: '/trigger_msg sample_query',
    },
    hubRpc
  );

  assert.equal(result.replyText, 'Reply for triggered message.');
  assert.equal(requests.length, 1);
  const userMessages = requests[0].messages.filter((m: any) => m.role === 'user');
  const userText = typeof userMessages[0].content === 'string'
    ? userMessages[0].content
    : JSON.stringify(userMessages[0].content);
  assert(userText.includes('Triggered query: sample_query'));
  assert.equal(getActiveSessionCount(), 0);
});

