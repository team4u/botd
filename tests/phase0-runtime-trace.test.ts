import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { register, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

// Register hook to handle .css imports in Node/tsx when loading web components
register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export function load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", shortCircuit: true, source: "export default {};" }; return nextLoad(url, context); }'
    )
);

const webRequire = createRequire(path.resolve('apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

import type {
  BotConfig,
  HubRpcFunctions,
  IncomingArtifactRef,
  MessageAttachment,
  MessageRecord,
  ToolCallRecord,
} from '../packages/protocol/src/index.js';
import {
  executeBotTurn,
  extractToolSummary,
  extractToolOutputPreview,
} from '../apps/node/src/runtime.js';
import { saveBot } from '../apps/node/src/storage.js';

// Dynamically import web components with dynamic path so tsc (NodeNext) doesn't crawl unowned web imports
const webComponentPath = '../apps/web/src/components/MessageItem.js';
const { MessageItem, ToolCallsTrace } = (await import(webComponentPath)) as any;

/** Helper to inject BOTD_API_KEY_<PROVIDER> credentials */
const withProviderKey = (t: TestContext, variable: string, value: string) => {
  const previous = process.env[variable];
  process.env[variable] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
};

/** Recursive helper to find elements in a React element tree */
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

/** Recursive helper to find all matching elements in a React element tree */
function findAllElements(tree: any, predicate: (node: any) => boolean): any[] {
  const results: any[] = [];
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) results.push(node);
    const children = node.props?.children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
    } else if (children && typeof children === 'object') {
      walk(children);
    }
  }
  walk(tree);
  return results;
}

test('extractToolSummary handles bash, file ops, Agent, and SubagentWorkflow', () => {
  // bash command
  assert.equal(
    extractToolSummary('bash', { command: 'git status  --short' }),
    'git status --short'
  );

  // file operations
  assert.equal(extractToolSummary('read', { path: 'src/index.ts' }), 'src/index.ts');
  assert.equal(extractToolSummary('write', { path: 'dist/bundle.js' }), 'dist/bundle.js');
  assert.equal(extractToolSummary('edit', { path: 'package.json' }), 'package.json');

  // Agent tool with subagent_type and description
  assert.equal(
    extractToolSummary('Agent', { subagent_type: 'Explore', description: 'find all test files' }),
    'Explore: find all test files'
  );
  // Agent tool default subagent_type
  assert.equal(
    extractToolSummary('Agent', { description: 'investigate regression' }),
    'agent: investigate regression'
  );

  // SubagentWorkflow tool with description
  assert.equal(
    extractToolSummary('SubagentWorkflow', { description: 'run parallel audit' }),
    'run parallel audit'
  );
  // SubagentWorkflow tool fallback to name
  assert.equal(
    extractToolSummary('SubagentWorkflow', { name: 'code-review-pipeline' }),
    'code-review-pipeline'
  );

  // Generic fallback
  assert.equal(
    extractToolSummary('customTool', { query: 'search keyword' }),
    'search keyword'
  );

  // Invalid / non-object
  assert.equal(extractToolSummary('bash', null), undefined);
  assert.equal(extractToolSummary('bash', 'string'), undefined);
});

test('extractToolOutputPreview extracts content, respects truncation limits for normal and error outputs', () => {
  // Empty / null
  assert.equal(extractToolOutputPreview(null), undefined);
  assert.equal(extractToolOutputPreview(undefined), undefined);
  assert.equal(extractToolOutputPreview('   '), undefined);

  // Short normal output
  assert.equal(extractToolOutputPreview('hello world', false), 'hello world');

  // Long normal output (over 600 chars -> kept last 600 chars)
  const longNormal = 'A'.repeat(500) + 'B'.repeat(400);
  const normalPreview = extractToolOutputPreview(longNormal, false);
  assert.equal(normalPreview?.length, 600);
  assert.equal(normalPreview, 'A'.repeat(200) + 'B'.repeat(400));

  // Short error output
  assert.equal(extractToolOutputPreview('fatal: error occurred', true), 'fatal: error occurred');

  // Long error output (over 1200 chars -> kept head + tail, total <= 1200)
  const longError = 'HEAD_'.repeat(200) + 'TAIL_'.repeat(200); // 1000 + 1000 = 2000 chars
  const errorPreview = extractToolOutputPreview(longError, true);
  assert(errorPreview !== undefined);
  assert(errorPreview.length <= 1200);
  assert(errorPreview.startsWith('HEAD_'));
  assert(errorPreview.endsWith('TAIL_'));
  assert(errorPreview.includes('\n...\n'));

  // Content array extraction (Pi / MCP standard tool result)
  const contentResult = {
    content: [
      { type: 'text', text: 'Line 1' },
      { type: 'text', text: 'Line 2' },
    ],
  };
  assert.equal(extractToolOutputPreview(contentResult), 'Line 1\nLine 2');

  // Object error
  assert.equal(extractToolOutputPreview({ error: 'Command not found' }, true), 'Command not found');
  assert.equal(extractToolOutputPreview({ errorMessage: 'Disk full' }, true), 'Disk full');
  assert.equal(extractToolOutputPreview({ message: 'Permission denied' }, true), 'Permission denied');

  // Object output
  assert.equal(extractToolOutputPreview({ output: 'Everything ok' }), 'Everything ok');

  // stdout / stderr
  assert.equal(
    extractToolOutputPreview({ stderr: 'warning: foo', stdout: 'output bar' }),
    'warning: foo\noutput bar'
  );

  // Error instance
  const err = new Error('synthetic fail');
  assert(extractToolOutputPreview(err, true)?.includes('synthetic fail'));
});

test('auto-compaction is enabled by default unless BOTD_AUTO_COMPACT === "0"', () => {
  const check = (val: string | undefined) => {
    const prev = process.env.BOTD_AUTO_COMPACT;
    try {
      if (val === undefined) delete process.env.BOTD_AUTO_COMPACT;
      else process.env.BOTD_AUTO_COMPACT = val;
      return process.env.BOTD_AUTO_COMPACT !== '0';
    } finally {
      if (prev === undefined) delete process.env.BOTD_AUTO_COMPACT;
      else process.env.BOTD_AUTO_COMPACT = prev;
    }
  };

  assert.equal(check(undefined), true, 'default should be enabled');
  assert.equal(check('1'), true, 'explicit 1 should be enabled');
  assert.equal(check('true'), true, 'any non-zero should be enabled');
  assert.equal(check('0'), false, 'explicit 0 should be disabled');
});

test('multi-step assistant text concatenation, prompt cache token aggregation, and tool preview in executeBotTurn', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-phase0-test-'));
  const requests: any[] = [];
  let callCount = 0;

  // Mock server simulating multi-step agent turn:
  // Step 1: Assistant emits text "Step 1: analyzing" and calls tool "bash" (echo "step 1 ok")
  // Step 2: Assistant receives tool result, emits text "Step 2: conclusion"
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    callCount++;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finishReason: string | null = null, usage: unknown = null) => {
      const payload: any = {
        id: `completion-${callCount}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      if (usage) payload.usage = usage;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const hasToolResult = body.messages.some((m: any) => m.role === 'tool');

    if (!hasToolResult) {
      // Step 1
      chunk({ role: 'assistant', content: 'Step 1: analyzing the system...' });
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_bash_1',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command: 'echo "bash step 1 done"' }),
            },
          },
        ],
      });
      chunk({}, 'tool_calls', {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 80 },
      });
    } else {
      // Step 2
      chunk({ role: 'assistant', content: 'Step 2: conclusion reached.' });
      chunk({}, 'stop', {
        prompt_tokens: 150,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 100 },
      });
    }

    res.end('data: [DONE]\n\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  const address = server.address();
  assert(address && typeof address !== 'string');
  await mkdir(path.join(dataDir, '.agent'), { recursive: true });
  await writeFile(
    path.join(dataDir, '.agent/models.json'),
    JSON.stringify({
      providers: {
        'phase0-test': {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          apiKey: 'test-key',
          models: [{ id: 'local', reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    })
  );
  withProviderKey(t, 'BOTD_API_KEY_PHASE0_TEST', 'local-key');

  const bot: BotConfig = {
    id: 'trace-bot',
    nodeId: 'node-trace',
    name: 'Trace Bot',
    description: '',
    modelProvider: 'phase0-test',
    modelId: 'local',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  await saveBot(dataDir, bot, 'You are a test bot');

  const streamedEvents: Parameters<HubRpcFunctions['onSessionStream']>[0][] = [];
  const onSessionStream = Object.assign(() => {}, {
    asEvent: (event: Parameters<HubRpcFunctions['onSessionStream']>[0]) => streamedEvents.push(event),
  });

  const downloadedArtifacts: string[] = [];
  const hubRpc = {
    onSessionStream,
    downloadArtifact: async (id: string) => {
      downloadedArtifacts.push(id);
      return {
        artifact: { id, filename: `${id}.txt`, mimeType: 'text/plain', sizeBytes: 12 },
        contentBase64: Buffer.from(`content of ${id}`).toString('base64'),
      };
    },
  } as unknown as Parameters<typeof executeBotTurn>[3];

  const incomingArtifacts: IncomingArtifactRef[] = [
    { id: 'art-incoming-1', filename: 'report.txt' },
    { id: 'art-incoming-2', filename: 'report.txt' }, // name collision test
  ];
  const attachments: MessageAttachment[] = [
    { id: 'att-1', filename: 'user-att.txt', mimeType: 'text/plain', sizeBytes: 10, url: '/artifacts/att-1' },
  ];

  const result = await executeBotTurn(
    dataDir,
    bot,
    {
      sessionId: 'sess-phase0',
      botId: bot.id,
      groupContextPrompt: '',
      incrementalMessages: 'Please analyze and report',
      attachments,
      incomingArtifacts,
    },
    hubRpc
  );

  // 1. Verify multi-step assistant replyText concatenation
  assert.equal(
    result.replyText,
    'Step 1: analyzing the system...\n\nStep 2: conclusion reached.',
    'replyText must concatenate non-empty text blocks from all assistant messages in the turn joined by \\n\\n'
  );

  // 2. Verify toolCalls and outputPreview
  assert(result.toolCalls && result.toolCalls.length > 0, 'Tool calls must be recorded');
  const bashCall = result.toolCalls.find((t) => t.name === 'bash');
  assert(bashCall, 'Bash tool call must be present');
  assert.equal(bashCall.status, 'done');
  assert.equal(bashCall.isError, false);
  assert(bashCall.outputPreview !== undefined, 'Bash output preview must be captured');
  assert(bashCall.outputPreview.includes('bash step 1 done'));

  // 3. Verify incomingArtifacts were downloaded to workspace/inbox/
  const botWorkspaceInbox = path.join(dataDir, 'bots', bot.id, 'workspace', 'inbox');
  assert(existsSync(path.join(botWorkspaceInbox, 'report.txt')));
  assert(existsSync(path.join(botWorkspaceInbox, 'user-att.txt')));

  // Check collision file: should have <timestamp>_report.txt
  const inboxFiles = await readFile(path.join(botWorkspaceInbox, 'report.txt'), 'utf8');
  assert.equal(inboxFiles, 'content of art-incoming-1');

  // Verify downloadedArtifacts tracked download of incoming and attachments
  assert(downloadedArtifacts.includes('att-1'));
  assert(downloadedArtifacts.includes('art-incoming-1'));
  assert(downloadedArtifacts.includes('art-incoming-2'));

  // 4. Verify streaming events had text_delta separated by \n\n between assistant messages
  const textDeltas = streamedEvents.filter((e) => e.deltaText !== undefined).map((e) => e.deltaText);
  assert(textDeltas.length >= 2);
  const fullStream = textDeltas.join('');
  assert(
    fullStream.includes('Step 1: analyzing the system...\n\nStep 2: conclusion reached.'),
    `Streaming text must separate steps with \\n\\n, got: ${JSON.stringify(fullStream)}`
  );

  // 5. Verify token usage aggregation with cache tokens
  assert(result.usage !== undefined, 'Usage must be defined');
  assert(result.usage.inputTokens > 0, 'inputTokens must be > 0');
  assert(result.usage.outputTokens > 0, 'outputTokens must be > 0');
  assert(result.usage.totalTokens > 0, 'totalTokens must be > 0');
  assert(
    result.usage.cacheReadTokens !== undefined && result.usage.cacheReadTokens > 0,
    'cacheReadTokens must be aggregated across steps when present'
  );
  assert.equal(
    result.usage.totalTokens,
    result.usage.inputTokens + result.usage.outputTokens + (result.usage.cacheReadTokens || 0) + (result.usage.cacheWriteTokens || 0),
    'totalTokens must account for input + output + cacheRead + cacheWrite'
  );
});

test('MessageItem usage badge renders prompt cache tooltip lines', () => {
  const botMap = new Map<string, BotConfig>();
  const nodeMap = new Map();

  const msgWithCache: MessageRecord = {
    id: 'msg-cache-1',
    sessionId: 'sess-1',
    role: 'assistant',
    senderBotId: 'bot-1',
    content: 'Reply with cache tokens',
    createdAt: new Date().toISOString(),
    mentions: [],
    usage: {
      inputTokens: 250,
      outputTokens: 75,
      totalTokens: 1325,
      contextWindow: 128000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
    },
  };

  const element = MessageItem({
    message: msgWithCache,
    botMap,
    nodeMap,
  });

  // Find the usage badge span with tooltip
  const usageSpan = findElement(
    element,
    (node) => typeof node?.props?.title === 'string' && node.props.title.includes('tokens')
  );
  assert(usageSpan, 'Usage badge span must be rendered');
  const tooltip: string = usageSpan.props.title;
  assert(tooltip.includes('输入 250 tokens'), `Expected input tokens in tooltip, got: ${tooltip}`);
  assert(tooltip.includes('缓存读取 1,000 tokens'), `Expected cacheRead in tooltip, got: ${tooltip}`);
  assert(!tooltip.includes('缓存写入'), 'Should not show cacheWrite when 0');
  assert(tooltip.includes('输出 75 tokens'), `Expected output tokens in tooltip, got: ${tooltip}`);
  assert(tooltip.includes('上下文窗口 128,000'), `Expected context window in tooltip, got: ${tooltip}`);

  // When cacheWriteTokens > 0 as well
  const msgWithWrite: MessageRecord = {
    ...msgWithCache,
    usage: {
      ...msgWithCache.usage!,
      cacheWriteTokens: 500,
    },
  };
  const elementWrite = MessageItem({
    message: msgWithWrite,
    botMap,
    nodeMap,
  });
  const usageSpanWrite = findElement(
    elementWrite,
    (node) => typeof node?.props?.title === 'string' && node.props.title.includes('tokens')
  );
  assert(usageSpanWrite.props.title.includes('缓存写入 500 tokens'));
});

test('ToolCallsTrace renders error states, auto-expands errors, and formats outputPreview', () => {
  const tools: ToolCallRecord[] = [
    {
      name: 'bash',
      summary: 'ls -la',
      status: 'done',
      durationMs: 120,
      outputPreview: 'total 0\n-rw-r--r-- file.txt',
    },
    {
      name: 'read',
      summary: 'missing.json',
      status: 'error',
      isError: true,
      durationMs: 45,
      outputPreview: 'ENOENT: no such file or directory',
    },
    {
      name: 'write',
      summary: 'out.txt',
      status: 'done',
      durationMs: 200,
      // no outputPreview
    },
  ];

  // Collapsed state
  const collapsedHtml = renderToStaticMarkup(React.createElement(ToolCallsTrace, { toolCalls: tools }));
  assert(collapsedHtml.includes('3 次工具调用'), 'Should show total tool count');
  assert(collapsedHtml.includes('1 失败'), 'Should show failure count');

  // Expanded state
  const expandedHtml = renderToStaticMarkup(
    React.createElement(ToolCallsTrace, { toolCalls: tools, initialExpanded: true })
  );

  // Read tool has error -> auto-expanded with rose tint and pre block
  assert(expandedHtml.includes('ENOENT: no such file or directory'), 'Error tool preview should be auto-expanded');
  assert(expandedHtml.includes('bg-rose-'), 'Error tool row or pre should have rose tint');
  assert(expandedHtml.includes('missing.json'), 'Tool summary must be shown');

  // Non-error tools
  assert(expandedHtml.includes('bash'), 'Bash tool name must be shown');
  assert(expandedHtml.includes('write'), 'Write tool name must be shown');

  // Empty tools
  const emptyHtml = renderToStaticMarkup(React.createElement(ToolCallsTrace, { toolCalls: [] }));
  assert.equal(emptyHtml, '');
});
