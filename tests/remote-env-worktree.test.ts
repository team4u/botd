/**
 * RemoteExecutionEnv + createNodeEnvRpcServer 集成测试。
 *
 * 覆盖：
 * 1. 文件/目录/二进制区间读/流式 exec 的 RPC 桥接（Node 侧真机执行）；
 * 2. 真实 Harness（MemoryStorage）中运行 CodingTools（read/write/edit/bash），
 *    env 选项返回接通 RPC server 的 RemoteExecutionEnv；
 * 3. Git Worktree 并发隔离：两个 worker 在各自 worktree 并发改同一文件互不干扰；
 * 4. BYOM 离线韧性：节点离线 100ms 后重连，等待中的操作无缝续跑；
 * 5. 镜像 RPC 类型与 packages/protocol 协议定义的结构一致性。
 *
 * 运行：npx tsx --test tests/remote-env-worktree.test.ts
 * 说明：@earendil-works/pi-durable 与 chord 只在 apps 的依赖里，经 hub 的
 * node_modules 路径引用（root 未安装它们）。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createNodeEnvRpcServer } from '../apps/node/src/env-rpc-server.js';
import { ExecOutputHub, RemoteExecutionEnv, type NodeRpcResolver } from '../apps/hub/src/harness/remote-env.js';
import type { ActiveWorkerSummary, ChainOfRecallRef, ThreadSubscriptionRecord } from '../packages/protocol/src/env-rpc.js';
import type { Context } from '../apps/hub/node_modules/@earendil-works/chord/dist/context/index.d.ts';

const run = promisify(execFile);
const CTX: Context = (
  await import('../apps/hub/node_modules/@earendil-works/chord/dist/context/index.js')
).BACKGROUND_CONTEXT as Context;

interface TestSetup {
  rpc: ReturnType<typeof createNodeEnvRpcServer>;
  env: RemoteExecutionEnv;
  outputHub: ExecOutputHub;
  resolver: NodeRpcResolver & { setOffline: (offline: boolean) => void };
  root: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<TestSetup> {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-remote-env-'));
  const outputHub = new ExecOutputHub();
  const rpc = createNodeEnvRpcServer({
    defaultCwd: root,
    onExecOutput: (event) => outputHub.onEnvExecOutput(event),
  });
  let offline = false;
  const resolver: TestSetup['resolver'] = {
    getNodeEnvRpc: () => (offline ? undefined : rpc),
    waitForNodeOnline: async (_nodeId: string, context: Context) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        context.abortSignal?.throwIfAborted();
        if (!offline) return rpc;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('node did not come online');
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
  };
  const env = new RemoteExecutionEnv(resolver, { nodeId: 'node-1', cwd: root }, outputHub);
  return {
    rpc,
    env,
    outputHub,
    resolver,
    root,
    cleanup: async () => {
      await rpc.envCleanup();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. RPC 桥接：文件操作 / 二进制 / exec 流
// ---------------------------------------------------------------------------

test('remote file operations bridge to node env', async () => {
  const s = await setup();
  try {
    const write = await s.env.writeFile('hello.txt', 'line1\nline2\n', CTX);
    assert.ok(write.ok, JSON.stringify(write));
    const text = await s.env.readTextFile('hello.txt', CTX);
    assert.ok(text.ok);
    assert.equal(text.value, 'line1\nline2\n');

    const lines = await s.env.readTextLines('hello.txt', { maxLines: 1 }, CTX);
    assert.ok(lines.ok);
    assert.deepEqual(lines.value, ['line1']);

    await s.env.appendFile('hello.txt', 'line3\n', CTX);
    const appended = await s.env.readTextFile('hello.txt', CTX);
    assert.ok(appended.ok && appended.value === 'line1\nline2\nline3\n');

    const abs = await s.env.absolutePath('hello.txt', CTX);
    assert.ok(abs.ok);
    assert.equal(path.basename(abs.value), 'hello.txt');

    await s.env.createDir('sub/deep', { recursive: true }, CTX);
    await s.env.writeFile('sub/deep/x.txt', 'x', CTX);
    const dir = await s.env.listDir('sub', CTX);
    assert.ok(dir.ok);
    assert.equal(dir.value.length, 1);
    assert.equal(dir.value[0].name, 'deep');

    const openDir = await s.env.openDirReader('sub', CTX);
    assert.ok(openDir.ok);
    const page = await openDir.value.next(10, CTX);
    assert.ok(page.ok);
    assert.equal(page.value.entries.length, 1);
    assert.equal(page.value.entries[0].name, 'deep');
    await openDir.value.close(CTX);

    await s.env.renameFile('hello.txt', 'renamed.txt', CTX);
    const gone = await s.env.exists('hello.txt', CTX);
    assert.ok(gone.ok && gone.value === false);
    const here = await s.env.exists('renamed.txt', CTX);
    assert.ok(here.ok && here.value === true);
    await s.env.remove('renamed.txt', { force: true }, CTX);

    const info = await s.env.fileInfo('sub/deep/x.txt', CTX);
    assert.ok(info.ok);
    assert.equal(info.value.kind, 'file');
    assert.equal(info.value.size, 1);

    const canonical = await s.env.canonicalPath('sub/deep/x.txt', CTX);
    assert.ok(canonical.ok);
    const joined = await s.env.joinPath(['a', 'b'], CTX);
    assert.ok(joined.ok && joined.value.includes('a'));
    const tempDir = await s.env.createTempDir(undefined, CTX);
    assert.ok(tempDir.ok);
    const tempFile = await s.env.createTempFile({ suffix: '.txt' }, CTX);
    assert.ok(tempFile.ok);

    await s.env.writeFile('t.txt', 'abcdef', CTX);
    const trunc = await s.env.truncateFile('t.txt', 3, CTX);
    assert.ok(trunc.ok);
    const truncated = await s.env.readTextFile('t.txt', CTX);
    assert.ok(truncated.ok && truncated.value === 'abc');
  } finally {
    await s.cleanup();
  }
});

test('binary range reads via openBinaryReader', async () => {
  const s = await setup();
  try {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    await s.env.writeFile('bin.dat', bytes, CTX);

    const reader = await s.env.openBinaryReader('bin.dat', undefined, CTX);
    assert.ok(reader.ok);
    const slice = await reader.value.read(100, 10, CTX);
    assert.ok(slice.ok);
    assert.deepEqual(Array.from(slice.value), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    const info = await reader.value.info(CTX);
    assert.ok(info.ok && info.value.size === 256);

    await s.env.writeFile('lines.txt', 'a\nbb\nccc', CTX);
    const linesReader = await s.env.openBinaryReader('lines.txt', undefined, CTX);
    assert.ok(linesReader.ok);
    const scan = await linesReader.value.scanLines({ startLine: 1, endLine: 2 }, CTX);
    assert.ok(scan.ok);
    assert.equal(scan.value.newlines, 2);
    assert.equal(scan.value.selectedBytes, 2); // "bb"
    await linesReader.value.close(CTX);

    const whole = await s.env.readBinaryFile('bin.dat', CTX);
    assert.ok(whole.ok);
    assert.equal(whole.value.byteLength, 256);
    assert.equal(whole.value[255], 255);
    await reader.value.close(CTX);
  } finally {
    await s.cleanup();
  }
});

test('text line reader streams lines', async () => {
  const s = await setup();
  try {
    await s.env.writeFile('poem.txt', 'roses\nare\nred\n', CTX);
    const reader = await s.env.openTextLineReader('poem.txt', CTX);
    assert.ok(reader.ok);
    const lines: string[] = [];
    for (;;) {
      const line = await reader.value.readLine(CTX);
      assert.ok(line.ok, JSON.stringify(line));
      if (line.value === undefined) break;
      lines.push(line.value.text);
    }
    assert.deepEqual(lines, ['roses', 'are', 'red']);
    await reader.value.close(CTX);
  } finally {
    await s.cleanup();
  }
});

test('exec streams output and reports exit code', async () => {
  const s = await setup();
  try {
    const chunks: { text: string; stream: string }[] = [];
    const result = await s.env.exec('printf one; printf two >&2; echo three', {
      onOutput: (text: string, _context: Context, info: { stream: 'stdout' | 'stderr' }) =>
        chunks.push({ text, stream: info.stream }),
    }, CTX);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.exitCode, 0);
    const all = chunks.map((c) => c.text).join('');
    assert.ok(all.includes('one') && all.includes('two') && all.includes('three'), all);
    assert.ok(chunks.some((c) => c.stream === 'stderr'));

    const fail = await s.env.exec('exit 7', undefined, CTX);
    assert.ok(fail.ok && fail.value.exitCode === 7);

    const argv = await s.env.exec([process.execPath, '-e', 'console.log("argv-ok")'], undefined, CTX);
    assert.ok(argv.ok && argv.value.exitCode === 0);

    const slow = await s.env.exec('sleep 5', { timeout: 0.3 }, CTX);
    assert.ok(!slow.ok);
    assert.equal(slow.error.code, 'timeout');

    await s.env.cleanup(CTX);
  } finally {
    await s.cleanup();
  }
});

test('envAbortExec cancels a running command', async () => {
  const s = await setup();
  try {
    const execPromise = s.rpc.envExec({ execId: 'abort-me', command: 'sleep 10 && echo done', timeout: 30 });
    await new Promise((r) => setTimeout(r, 150));
    await s.rpc.envAbortExec('abort-me');
    const result = await execPromise;
    assert.ok(!result.ok, JSON.stringify(result));
    assert.equal(result.error.code, 'aborted');
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Harness + CodingTools over RemoteExecutionEnv
// ---------------------------------------------------------------------------

test('coding tools run inside a real harness over remote env', async () => {
  const durable = await import('../apps/hub/node_modules/@earendil-works/pi-durable/dist/index.js');
  const durableTools = await import('../apps/hub/node_modules/@earendil-works/pi-durable/dist/tools/index.js');
  const piAi = await import('../apps/hub/node_modules/@earendil-works/pi-ai/dist/index.js');
  type AssistantMessage = import('../apps/hub/node_modules/@earendil-works/pi-ai/dist/types.d.ts').AssistantMessage;

  const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
    role: 'assistant',
    content,
    api: 'pi-messages',
    provider: 'botd-test',
    model: 'scripted',
    usage: emptyUsage,
    stopReason,
    timestamp: Date.now(),
  });

  const script: AssistantMessage[] = [
    assistant([{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'notes.md', content: '# Title\nhello world\n' } }], 'toolUse'),
    assistant([{ type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'notes.md' } }], 'toolUse'),
    assistant([{ type: 'toolCall', id: 'call-3', name: 'edit', arguments: { path: 'notes.md', edits: [{ oldText: 'hello world', newText: 'hello botd' }] } }], 'toolUse'),
    assistant([{ type: 'toolCall', id: 'call-4', name: 'bash', arguments: { command: 'cat notes.md' } }], 'toolUse'),
    assistant([{ type: 'text', text: 'all tools exercised' }], 'stop'),
  ];

  const s = await setup();
  try {
    let call = 0;
    const makeStream = () => {
      const stream = piAi.createAssistantMessageEventStream();
      const message = script[Math.min(call++, script.length - 1)];
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
        stream.end(message);
      });
      return stream;
    };
    const provider = piAi.createProvider({
      id: 'botd-test',
      name: 'botd scripted',
      auth: {
        apiKey: {
          name: 'test key',
          resolve: async () => ({ auth: { apiKey: 'test-key' }, source: 'test' }),
        },
      },
      models: [
        {
          id: 'scripted',
          name: 'scripted',
          api: 'pi-messages',
          provider: 'botd-test',
          baseUrl: 'http://localhost:0',
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
      api: {
        stream: () => makeStream(),
        streamSimple: () => makeStream(),
      },
    });
    const models = piAi.createModels();
    models.setProvider(provider);

    const registry = durable.createRegistry();
    registry.install(durableTools.CodingTools);

    const storage = new durable.MemoryStorage();
    const harness = await durable.Harness.open(
      storage,
      {
        models,
        registry,
        env: () => s.env,
        onReport: (report: unknown) => {
          const r = report as { kind: string; error?: Error };
          console.error('[harness report]', r.kind, r.error?.message);
        },
      },
      CTX,
    );
    try {
      const conversation = await harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: {
            model: { provider: 'botd-test', modelId: 'scripted' },
            extensions: [durableTools.CodingTools],
            cwd: s.root,
          },
        },
        CTX,
      );
      const submission = await conversation.submit({ type: 'input', content: 'use the tools' }, CTX);
      const settled = await submission.wait(CTX);
      assert.ok(['done', 'unanswered'].includes(settled.status), `unexpected status: ${settled.status}`);

      const written = await s.env.readTextFile('notes.md', CTX);
      assert.ok(written.ok);
      assert.equal(written.value, '# Title\nhello botd\n');
    } finally {
      await harness.close(CTX);
    }
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Git Worktree 并发隔离
// ---------------------------------------------------------------------------

test('two workers modify the same file concurrently in separate worktrees', async () => {
  const s = await setup();
  const repoDir = await mkdtemp(path.join(tmpdir(), 'botd-repo-'));
  try {
    await run('git', ['init', '-q'], { cwd: repoDir });
    await run('git', ['config', 'user.email', 'a@b.c'], { cwd: repoDir });
    await run('git', ['config', 'user.name', 'test'], { cwd: repoDir });
    await writeFile(path.join(repoDir, 'shared.txt'), 'base\n');
    await run('git', ['add', '.'], { cwd: repoDir });
    await run('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });

    const [a, b] = await Promise.all([
      s.rpc.envAcquireWorktree({ repoDir, workerId: 'worker-a' }),
      s.rpc.envAcquireWorktree({ repoDir, workerId: 'worker-b' }),
    ]);
    assert.ok(a.isGitRepo, 'worker-a worktree should be a git worktree');
    assert.ok(b.isGitRepo, 'worker-b worktree should be a git worktree');
    assert.notEqual(a.worktreePath, b.worktreePath);
    assert.equal(a.branchName, 'botd/worker-a');
    assert.equal(b.branchName, 'botd/worker-b');
    assert.ok(a.worktreePath.startsWith(path.join(repoDir, '.botd-worktrees')));
    assert.ok(b.worktreePath.startsWith(path.join(repoDir, '.botd-worktrees')));

    await writeFile(path.join(a.worktreePath, 'shared.txt'), 'from-a\n');
    await writeFile(path.join(b.worktreePath, 'shared.txt'), 'from-b\n');
    await writeFile(path.join(a.worktreePath, 'only-a.txt'), 'a\n');

    const aText = await readFile(path.join(a.worktreePath, 'shared.txt'), 'utf8');
    const bText = await readFile(path.join(b.worktreePath, 'shared.txt'), 'utf8');
    assert.equal(aText, 'from-a\n');
    assert.equal(bText, 'from-b\n');

    const bStatus = await run('git', ['status', '--porcelain'], { cwd: b.worktreePath });
    assert.ok(!bStatus.stdout.includes('only-a.txt'), `only-a leaked into worker-b: ${bStatus.stdout}`);

    const mainText = await readFile(path.join(repoDir, 'shared.txt'), 'utf8');
    assert.equal(mainText, 'base\n', 'main worktree must stay untouched');

    await run('git', ['add', '.'], { cwd: a.worktreePath });
    await run('git', ['commit', '-q', '-m', 'a change'], { cwd: a.worktreePath });
    await run('git', ['add', '.'], { cwd: b.worktreePath });
    await run('git', ['commit', '-q', '-m', 'b change'], { cwd: b.worktreePath });
    const aBranch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: a.worktreePath });
    const bBranch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: b.worktreePath });
    assert.equal(aBranch.stdout.trim(), 'botd/worker-a');
    assert.equal(bBranch.stdout.trim(), 'botd/worker-b');

    const releaseA = await s.rpc.envReleaseWorktree({ repoDir, worktreePath: a.worktreePath });
    const releaseB = await s.rpc.envReleaseWorktree({
      repoDir,
      worktreePath: b.worktreePath,
      branchName: b.branchName,
      deleteBranch: true,
    });
    assert.ok(releaseA.ok && releaseB.ok);
    const worktrees = await run('git', ['worktree', 'list'], { cwd: repoDir });
    assert.ok(!worktrees.stdout.includes('worker-a') && !worktrees.stdout.includes('worker-b'), worktrees.stdout);
    const branches = await run('git', ['branch', '--list', 'botd/*'], { cwd: repoDir });
    assert.ok(!branches.stdout.includes('botd/worker-b'), `deleted branch still present: ${branches.stdout}`);
    assert.ok(branches.stdout.includes('botd/worker-a'), 'worker-a branch should be kept');
  } finally {
    await rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
    await s.cleanup();
  }
});

test('envAcquireWorktree on a non-git directory degrades gracefully', async () => {
  const s = await setup();
  const plain = await mkdtemp(path.join(tmpdir(), 'botd-plain-'));
  try {
    const result = await s.rpc.envAcquireWorktree({ repoDir: plain, workerId: 'w1' });
    assert.deepEqual(result, { worktreePath: plain, branchName: '', isGitRepo: false });
    const release = await s.rpc.envReleaseWorktree({ repoDir: plain, worktreePath: plain });
    assert.ok(release.ok);
  } finally {
    await rm(plain, { recursive: true, force: true }).catch(() => undefined);
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. BYOM 离线韧性
// ---------------------------------------------------------------------------

test('offline node waits and resumes when back online', async () => {
  const s = await setup();
  try {
    s.resolver.setOffline(true);
    const started = Date.now();
    setTimeout(() => s.resolver.setOffline(false), 100);
    const result = await s.env.exec('echo back-online', undefined, CTX);
    const elapsed = Date.now() - started;
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(elapsed >= 90, `should have waited for reconnect, elapsed=${elapsed}ms`);
    assert.equal(result.value.exitCode, 0);

    s.resolver.setOffline(true);
    setTimeout(() => s.resolver.setOffline(false), 50);
    const write = await s.env.writeFile('after-reconnect.txt', 'ok', CTX);
    assert.ok(write.ok);
    const read = await s.env.readTextFile('after-reconnect.txt', CTX);
    assert.ok(read.ok && read.value === 'ok');
  } finally {
    await s.cleanup();
  }
});

test('offline without waitForNodeOnline fails fast', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'botd-offline-'));
  const env = new RemoteExecutionEnv({ getNodeEnvRpc: () => undefined }, { nodeId: 'ghost', cwd: root });
  await assert.rejects(() => env.exec('echo x', undefined, CTX), /offline/);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// 5. 协议结构一致性（镜像类型 vs packages/protocol 定义）
// ---------------------------------------------------------------------------

test('mirror rpc types match packages/protocol definitions', async () => {
  // createNodeEnvRpcServer 的返回值必须可赋值给协议的 NodeEnvRpcFunctions（编译期已保证，运行期冒烟）。
  const server = createNodeEnvRpcServer({ defaultCwd: process.cwd() });
  const protocolTypeCheck: import('../packages/protocol/src/env-rpc.js').NodeEnvRpcFunctions = server;
  assert.equal(typeof protocolTypeCheck.envExec, 'function');
  assert.equal(typeof protocolTypeCheck.envAcquireWorktree, 'function');

  const worker: ActiveWorkerSummary = {
    workerId: 'w1',
    conversationId: 'c1',
    parentSessionId: 'p1',
    botId: 'b1',
    title: 't',
    status: 'running',
    nodeId: 'n1',
    cwd: '/tmp',
    threadKeys: ['k1'],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentTool: 'bash',
    summary: 's',
  };
  assert.equal(worker.status, 'running');
  const sub: ThreadSubscriptionRecord = {
    threadKey: 'k',
    workerConversationId: 'c',
    parentSessionId: 'p',
    botId: 'b',
    createdAt: new Date().toISOString(),
  };
  assert.equal(sub.threadKey, 'k');
  const ref: ChainOfRecallRef = {
    id: 'r1',
    kind: 'worker',
    summary: 's',
    relatedIds: [worker.workerId],
    createdAt: new Date().toISOString(),
  };
  assert.equal(ref.kind, 'worker');
});

test('remote env cwd is respected for relative exec commands', async () => {
  const s = await setup();
  try {
    await s.env.createDir('workdir', { recursive: true }, CTX);
    await s.env.writeFile('workdir/marker.txt', 'here', CTX);
    const localEnv = new RemoteExecutionEnv(s.resolver, { nodeId: 'node-1', cwd: path.join(s.root, 'workdir') }, s.outputHub);
    const result = await localEnv.exec('cat marker.txt', undefined, CTX);
    assert.ok(result.ok && result.value.exitCode === 0);
  } finally {
    await s.cleanup();
  }
});
