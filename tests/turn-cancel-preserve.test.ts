import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Register hook to handle .css imports in Node/tsx when loading web components
register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export function load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", shortCircuit: true, source: "export default {};" }; return nextLoad(url, context); }'
    )
);

import type { BotConfig, HubRpcFunctions } from '../packages/protocol/src/index.js';
import { saveBot } from '../apps/node/src/storage.js';
import { executeBotTurn, cancelBotTurn } from '../apps/node/src/runtime.js';

const withProviderKey = (t: { after: (fn: () => void) => void }, variable: string, value: string) => {
  const previous = process.env[variable];
  process.env[variable] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
};

test('cancelled turn preserves partial blocks and returns aborted instead of throwing', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botd-cancel-test-'));

  // Mock server: streams one text chunk slowly, then hangs until client aborts.
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(
      `data: ${JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [{ index: 0, delta: { role: 'assistant', content: '部分输出' }, finish_reason: null }],
      })}\n\n`
    );
    // Never end: holds the stream open until the aborted request tears it down.
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
        'cancel-test': {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          apiKey: 'test-key',
          models: [{ id: 'local', reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    })
  );
  withProviderKey(t, 'BOTD_API_KEY_CANCEL_TEST', 'local-key');

  const bot: BotConfig = {
    id: 'cancel-bot',
    nodeId: 'node-cancel',
    name: 'Cancel Bot',
    description: '',
    modelProvider: 'cancel-test',
    modelId: 'local',
    enabledSkills: [],
    updatedAt: new Date().toISOString(),
  };
  await saveBot(dataDir, bot, 'You are a test bot');

  const streamedEvents: Parameters<HubRpcFunctions['onSessionStream']>[0][] = [];
  const onSessionStream = Object.assign(() => {}, {
    asEvent: (event: Parameters<HubRpcFunctions['onSessionStream']>[0]) => {
      streamedEvents.push(event);
      // 首个文本 delta 到达后立即模拟用户点击停止
      if (event.deltaText) {
        void cancelBotTurn('sess-cancel', bot.id);
      }
    },
  });

  const hubRpc = {
    onSessionStream,
    downloadArtifact: async () => {
      throw new Error('not expected');
    },
  } as unknown as Parameters<typeof executeBotTurn>[3];

  const result = await executeBotTurn(dataDir, bot, {
    sessionId: 'sess-cancel',
    botId: bot.id,
    groupContextPrompt: '',
    incrementalMessages: 'Please stream something',
  }, hubRpc);

  // 取消不再抛错丢弃数据：正常返回并带 aborted 标记
  assert.equal(result.aborted, true, 'cancelled turn must return aborted: true instead of throwing');

  // 已流出的部分文本必须保留在 blocks 里（Pi TUI 行为：中止保留部分输出）
  assert(result.blocks && result.blocks.length > 0, 'partial blocks must be preserved after cancel');
  const textBlocks = result.blocks!.filter((b) => b.type === 'text');
  assert(textBlocks.length > 0, 'at least the streamed text block should survive cancellation');
  assert((textBlocks[0] as any).text.includes('部分输出'), 'streamed partial text must be preserved');

  // 运行中的工具被标记为 cancelled 而非 running
  for (const b of result.blocks!) {
    if (b.type === 'tool') {
      assert.notEqual(b.status, 'running', 'no tool block may stay running after cancellation');
    }
  }
  for (const tc of result.toolCalls || []) {
    assert.notEqual(tc.status, 'running', 'no tool call may stay running after cancellation');
  }
});
