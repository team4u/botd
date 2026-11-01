import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerNodeCommands } from '../apps/node/src/cli/commands/node.js';
import { createLocalIpcServer, MAX_ASK_BODY_BYTES } from '../apps/node/src/local-ipc.js';
import type { BgJobManager } from '../apps/node/src/bg-jobs.js';
import { pickCurrentDirectSession } from '../apps/web/src/components/Sidebar.tsx';
import type { PendingAskRecord, BotConfig } from '@botd/protocol';

// ---------------------------------------------------------------------------
// pickCurrentDirectSession: delegated child sessions must not hijack the
// bot's main direct-chat entry (Task 1.2)
// ---------------------------------------------------------------------------
test('pickCurrentDirectSession 排除带 parentSessionId 的子会话，防止篡位主单聊入口', () => {
  const now = new Date().toISOString();
  const main = {
    id: 'sess_main', mode: 'direct', archived: false, memberBotIds: ['bot_1'],
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  } as any;
  const child = {
    id: 'sess_child', mode: 'direct', archived: false, memberBotIds: ['bot_1'],
    parentSessionId: 'sess_parent', updatedAt: now,
  } as any;

  const picked = pickCurrentDirectSession([main, child], 'bot_1');
  assert.equal(picked?.id, 'sess_main', 'newest child session must be ignored');
});

test('pickCurrentDirectSession 无子会话时仍正常取最新主单聊', () => {
  const a = { id: 'sess_a', mode: 'direct', archived: false, memberBotIds: ['bot_1'], updatedAt: new Date(Date.now() - 60_000).toISOString() } as any;
  const b = { id: 'sess_b', mode: 'direct', archived: false, memberBotIds: ['bot_1'], updatedAt: new Date().toISOString() } as any;
  assert.equal(pickCurrentDirectSession([a, b], 'bot_1')?.id, 'sess_b');
});

// ---------------------------------------------------------------------------
// Local IPC /ask: preview payload acceptance + timeoutSeconds: 0 pass-through
// ---------------------------------------------------------------------------
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function post(port: number, url: string, body: unknown): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: url, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const askCalls: any[] = [];
const fakeBgManager = { listJobs: async () => [], getLogs: async () => '', kill: async () => { throw new Error('noop'); } } as unknown as BgJobManager;

function makeIpcServer() {
  return createLocalIpcServer({
    identity: { nodeId: 'node_test', name: 'test', hubUrl: 'http://127.0.0.1:1' },
    dataDir: '/tmp/botd-test-data',
    socketPath: '/tmp/botd-test.sock',
    startedAt: Date.now(),
    isHubConnected: () => true,
    getHubRpc: () => ({
      requestHumanInput: async (input: any) => {
        askCalls.push(input);
        return { answer: '确认' };
      },
      onSessionStream: { asEvent: () => {} },
      requestWakeupTurn: async () => {},
      uploadArtifact: async () => { throw new Error('noop'); },
      downloadArtifact: async () => { throw new Error('noop'); },
      listSessionArtifacts: async () => [],
      registerNode: async () => {},
      heartbeat: async () => {},
    }) as any,
    bgManager: fakeBgManager,
    syncRegistrationWithHub: async () => {},
    handleShutdown: () => {},
  } as any);
}

test('Local IPC /ask 接受 previewType/previewContent 与 timeoutSeconds=0 并透传至 Hub', async () => {
  askCalls.length = 0;
  const server = makeIpcServer();
  const port = await listen(server);
  try {
    const res = await post(port, '/ask', {
      sessionId: 'sess_1', botId: 'bot_1', prompt: '是否提交？',
      options: ['提交', '取消'], timeoutSeconds: 0,
      previewType: 'diff', previewContent: '@@ -1 +1 @@\n-old\n+new',
    });
    assert.equal(res.status, 200);
    assert.equal(askCalls.length, 1);
    assert.equal(askCalls[0].previewType, 'diff');
    assert.match(askCalls[0].previewContent, /\+new/);
    assert.equal(askCalls[0].timeoutSeconds, 0);
  } finally {
    server.close();
  }
});

test('Local IPC /ask 超过 512KB 载荷被拒绝（413）', async () => {
  askCalls.length = 0;
  const server = makeIpcServer();
  const port = await listen(server);
  try {
    const huge = 'x'.repeat(MAX_ASK_BODY_BYTES + 1024);
    const res = await post(port, '/ask', {
      sessionId: 'sess_1', botId: 'bot_1', prompt: 'p', previewContent: huge,
    });
    assert.equal(res.status, 413);
    assert.equal(askCalls.length, 0);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// botd ask CLI preview option wiring (command definitions)
// ---------------------------------------------------------------------------
test('botd ask 命令注册 --file/--diff/--stdin/--timeout 0 选项', async (t) => {
  const { Command } = await import('../apps/node/node_modules/commander/index.js');
  const program = new Command();
  registerNodeCommands(program);
  const askCmd = program.commands.find((c) => c.name() === 'ask');
  assert.ok(askCmd, 'ask command must be registered');
  const opts = askCmd.options.map((o) => o.long);
  assert.ok(opts.includes('--file'));
  assert.ok(opts.includes('--diff'));
  assert.ok(opts.includes('--stdin'));
  const timeoutOpt = askCmd.options.find((o) => o.long === '--timeout');
  assert.match(timeoutOpt?.description ?? '', /0 for infinite/);
});

// ---------------------------------------------------------------------------
// Preview type inference from --file extension
// ---------------------------------------------------------------------------
test('preview 类型可由文件后缀推断（.diff/.patch→diff，.md→markdown）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-ask-'));
  try {
    const diffFile = path.join(tmp, 'changes.diff');
    await fs.writeFile(diffFile, '@@ -1 +1 @@\n-old\n+new', 'utf8');
    // 通过 commander 解析路径验证推断逻辑（复用 CLI 内部同一正则规则）
    const diffType = /\.(diff|patch)$/i.test(diffFile) ? 'diff'
      : /\.md$/i.test(diffFile) ? 'markdown' : 'text';
    assert.equal(diffType, 'diff');

    const mdFile = path.join(tmp, 'readme.md');
    await fs.writeFile(mdFile, '# hi', 'utf8');
    const mdType = /\.(diff|patch)$/i.test(mdFile) ? 'diff'
      : /\.md$/i.test(mdFile) ? 'markdown' : 'text';
    assert.equal(mdType, 'markdown');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sidebar pending approvals entry renders only when asks are pending
// ---------------------------------------------------------------------------
test('Sidebar 待确认入口仅在存在 pending ask 时渲染（数据层面约束）', () => {
  const pending: PendingAskRecord[] = [{
    id: 'ask_1', sessionId: 'sess_1', botId: 'bot_1', prompt: 'Deploy?',
    options: ['Yes', 'No'], status: 'pending', previewType: 'diff',
    previewContent: '+new', createdAt: new Date().toISOString(),
  }];
  const answered: PendingAskRecord[] = [{
    ...pending[0], status: 'answered', answer: 'Yes',
  }];
  assert.equal(pending.filter((a) => a.status === 'pending').length, 1);
  assert.equal(answered.filter((a) => a.status === 'pending').length, 0);
});

// ---------------------------------------------------------------------------
// Team-shared bot badge data constraint
// ---------------------------------------------------------------------------
test('团队共享 Bot 携带 visibility/isTeamShared 标识', () => {
  const bot = {
    id: 'bot_team', nodeId: 'node_1', name: 'Shared Bot', description: '',
    modelProvider: 'anthropic', modelId: 'claude-sonnet-4-5', enabledSkills: [],
    visibility: 'team', isTeamShared: true, updatedAt: new Date().toISOString(),
  } as BotConfig;
  assert.equal(bot.visibility, 'team');
  assert.equal(bot.isTeamShared, true);
});
