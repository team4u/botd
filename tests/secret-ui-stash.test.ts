/**
 * 机密零泄漏（Secret UI Stash）集成测试。
 *
 * 覆盖：
 *  1. 协议层：TextInput `secret: true` 校验 + `extractSecretStatePaths`
 *     提取 `$bindState` / `$state` 机密路径；
 *  2. SecretStash 单元：stash/peek/consume/getEnvRecord 与 TTL 过期；
 *  3. redactSecretAskAnswer：明文替换为 [REDACTED:$BOTD_SECRET_...]，非 UI /
 *     无机密路径的答案原样透传；
 *  4. 全链路（真实 HTTP Hub + Durable Runtime + faux provider）：
 *     Router 调 ask_human(previewType:"ui", previewContent:spec) →
 *     GET /asks 透出 previewType/previewContent → respond 提交含机密的表单 →
 *     AskDoc / SSE / LLM 上下文均不含明文，只含 REDACTED 占位符；
 *  5. SecretInjectingEnv：注入的 BOTD_SECRET_* 环境变量可被 shell 子进程
 *     通过 process.env 跨平台读取（node -e 直读）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { validateUiSpec, extractSecretStatePaths } from '../packages/protocol/src/index.js';
import {
  SecretStash,
  redactSecretAskAnswer,
  withSecretEnv,
} from '../apps/hub/src/harness/secret-stash.js';
import { SecretInjectingEnv } from '../apps/hub/src/harness/hub-harness.js';
import { AskDoc } from '../apps/hub/src/harness/docs.js';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { ensureRouterConversationId } from '../apps/hub/src/routes/workers.js';

const PASSWORD = 'secret-ui-stash-password';

const waitFor = async <T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  message: string,
  timeout = 10_000,
): Promise<T> => {
  const end = Date.now() + timeout;
  let last: T;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const lastUserText = (messages: readonly { role: string; content?: unknown }[]): string => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (typeof lastUser?.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser?.content)) return String((lastUser.content[0] as { text?: string }).text ?? '');
  return '';
};

const toolResultSeen = (messages: readonly { role: string; content?: unknown }[]): boolean => {
  const reversed = [...messages].reverse();
  const lastUser = reversed.findIndex((m) => m.role === 'user');
  return lastUser >= 0 && reversed.slice(0, lastUser).some((m) => m.role === 'toolResult');
};

/** 机密表单 spec：密码 TextInput 绑定 /credentials/password。 */
const secretUiSpec = {
  root: 'card',
  elements: {
    card: {
      type: 'Card',
      props: { title: '配置部署凭据' },
      children: ['user_input', 'pass_input', 'token_input', 'submit_btn'],
    },
    user_input: {
      type: 'TextInput',
      props: { label: '用户名', value: { $bindState: '/credentials/username' }, placeholder: 'deploy' },
    },
    pass_input: {
      type: 'TextInput',
      props: {
        label: '密码',
        secret: true,
        value: { $bindState: '/credentials/password' },
        hint: '不会以明文存储',
      },
    },
    token_input: {
      type: 'TextInput',
      props: { label: 'API Token（机密）', secret: true, value: { $state: '/config/token' } },
    },
    submit_btn: { type: 'Button', props: { label: '提交', variant: 'primary' } },
  },
  state: { credentials: { username: '', password: '' }, config: { token: '' } },
};

// ---------------------------------------------------------------------------
// 1. Protocol: TextInput secret validation + extractSecretStatePaths
// ---------------------------------------------------------------------------

test('validateUiSpec 接受 TextInput secret:true，并拒绝非布尔 secret', { timeout: 60_000 }, () => {
  const ok = validateUiSpec(JSON.stringify(secretUiSpec));
  assert.equal(ok.ok, true, ok.ok ? '' : ok.errors.join('; '));

  const bad = validateUiSpec(
    JSON.stringify({
      root: 'i',
      elements: {
        i: { type: 'TextInput', props: { label: 'x', secret: 'yes' } },
      },
    }),
  );
  assert.equal(bad.ok, false);
  assert.match((bad as { errors: string[] }).errors.join('; '), /props\.secret must be a boolean/);
});

test('extractSecretStatePaths 提取 secret TextInput 的 $bindState/$state 路径（JSON 字符串或对象）', { timeout: 60_000 }, () => {
  const paths = extractSecretStatePaths(JSON.stringify(secretUiSpec));
  assert.deepEqual([...paths].sort(), ['/config/token', '/credentials/password']);
  assert.deepEqual(
    [...extractSecretStatePaths(secretUiSpec)].sort(),
    ['/config/token', '/credentials/password'],
  );
  // 非 secret 的 TextInput 不出现；无效 JSON / 无 elements 返回空。
  assert.deepEqual(
    extractSecretStatePaths('{"root":"i","elements":{"i":{"type":"TextInput","props":{"label":"x","value":{"$state":"/plain"}}}}}'),
    [],
  );
  assert.deepEqual(extractSecretStatePaths('not json'), []);
  assert.deepEqual(extractSecretStatePaths({} as never), []);
});

// ---------------------------------------------------------------------------
// 2. SecretStash unit behavior
// ---------------------------------------------------------------------------

test('SecretStash：stash 生成 BOTD_SECRET_* 键，getEnvRecord 按会话注入，peek/consume 与 TTL 过期', { timeout: 60_000 }, async () => {
  const stash = new SecretStash();
  const key = stash.stash('hunter2', 'sess_1');
  assert.match(key, /^BOTD_SECRET_[0-9A-F]{8}$/);
  assert.equal(stash.peek(key, 'sess_1'), 'hunter2');
  assert.equal(stash.peek(key, 'sess_2'), undefined, 'another session cannot peek');
  assert.deepEqual(stash.getEnvRecord('sess_1'), { [key]: 'hunter2' });
  assert.equal(stash.consume(key, 'sess_1'), 'hunter2');
  assert.equal(stash.consume(key, 'sess_1'), undefined, 'consume is one-shot');

  const short = stash.stash('ephemeral', 'sess_1', 5);
  assert.equal(stash.peek(short, 'sess_1'), 'ephemeral');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stash.peek(short, 'sess_1'), undefined, 'expired entry is pruned');
  assert.deepEqual(stash.getEnvRecord('sess_1'), {}, 'expired entries disappear from env record');
});

test('withSecretEnv：机密按可信作用域并入 env，显式 env 优先；无作用域/无机密时原样返回', { timeout: 60_000 }, () => {
  const stash = new SecretStash();
  const key = stash.stash('s3cret', 'sess_1');
  assert.deepEqual(withSecretEnv(undefined, 'sess_1', stash), { [key]: 's3cret' });
  assert.deepEqual(withSecretEnv({ [key]: 'override', OTHER: '1' }, 'sess_1', stash), { [key]: 'override', OTHER: '1' });
  // 无信任作用域不注入，也不从 env 推断会话。
  assert.equal(withSecretEnv(undefined, undefined, stash), undefined);
  assert.deepEqual(withSecretEnv({ BOTD_SESSION_ID: 'sess_1' }, undefined, stash), { BOTD_SESSION_ID: 'sess_1' });
  // 作用域不匹配：拿到自己的机密，拿不到别人的。
  const other = stash.stash('other', 'sess_2');
  assert.deepEqual(withSecretEnv({ A: '1' }, 'sess_1', stash), { A: '1', [key]: 's3cret' });
  assert.deepEqual(withSecretEnv({ A: '1' }, 'sess_2', stash), { A: '1', [other]: 'other' });
  const empty = new SecretStash();
  assert.equal(withSecretEnv(undefined, 'sess_1', empty), undefined);
  assert.deepEqual(withSecretEnv({ A: '1' }, 'sess_1', empty), { A: '1' });
});

// ---------------------------------------------------------------------------
// 3. redactSecretAskAnswer
// ---------------------------------------------------------------------------

test('redactSecretAskAnswer：UI 机密字段替换为 REDACTED 占位符，明文进 stash', { timeout: 60_000 }, () => {
  const stash = new SecretStash();
  const specJson = JSON.stringify(secretUiSpec);
  const answer = JSON.stringify({
    decision: '提交',
    state: { credentials: { username: 'deploy', password: 'super-secret-password-123' }, config: { token: 'tok-abc' } },
  });
  const { redactedAnswer, stashedEnvKeys } = redactSecretAskAnswer(answer, 'sess_1', 'ui', specJson, stash);
  assert.ok(!redactedAnswer.includes('super-secret-password-123'), 'plaintext password must not survive');
  assert.ok(!redactedAnswer.includes('tok-abc'), 'plaintext token must not survive');
  assert.ok(redactedAnswer.includes('deploy'), 'non-secret fields survive');
  assert.match(redactedAnswer, /\[REDACTED:\$BOTD_SECRET_[0-9A-F]{8}\]/);

  const passKey = stashedEnvKeys['/credentials/password'];
  const tokenKey = stashedEnvKeys['/config/token'];
  assert.ok(passKey && tokenKey);
  assert.equal(stash.peek(passKey, 'sess_1'), 'super-secret-password-123');
  assert.equal(stash.peek(tokenKey, 'sess_1'), 'tok-abc');
  assert.equal(stash.peek(passKey, 'sess_2'), undefined, 'another session cannot peek the stashed secret');
});

test('redactSecretAskAnswer：非 UI / 无机密路径 / 非 JSON / 空 state 原样透传', { timeout: 60_000 }, () => {
  const stash = new SecretStash();
  assert.deepEqual(
    redactSecretAskAnswer('{"state":{"a":"b"}}', 'sess_1', 'text', 'plain', stash),
    { redactedAnswer: '{"state":{"a":"b"}}', stashedEnvKeys: {} },
  );
  const noSecretSpec = JSON.stringify({
    root: 'i',
    elements: { i: { type: 'TextInput', props: { label: 'x', value: { $state: '/plain' } } } },
  });
  assert.deepEqual(
    redactSecretAskAnswer('{"state":{"plain":"keep"}}', 'sess_1', 'ui', noSecretSpec, stash),
    { redactedAnswer: '{"state":{"plain":"keep"}}', stashedEnvKeys: {} },
  );
  assert.deepEqual(redactSecretAskAnswer('not json', 'sess_1', 'ui', JSON.stringify(secretUiSpec), stash).stashedEnvKeys, {});
  assert.deepEqual(
    redactSecretAskAnswer('{"decision":"cancel"}', 'sess_1', 'ui', JSON.stringify(secretUiSpec), stash).stashedEnvKeys,
    {},
  );
  // 空字符串机密值不 stash、不替换
  const r = redactSecretAskAnswer(
    JSON.stringify({ state: { credentials: { username: 'u', password: '' }, config: { token: '' } } }),
    'sess_1',
    'ui',
    JSON.stringify(secretUiSpec),
    stash,
  );
  assert.deepEqual(r.stashedEnvKeys, {});
});

// ---------------------------------------------------------------------------
// 4. SecretInjectingEnv：注入的 BOTD_SECRET_* 可被子进程读取（跨平台 node -e）
// ---------------------------------------------------------------------------

test('SecretInjectingEnv：shell 子进程经 process.env 读到机密，命令行不含明文', { timeout: 60_000 }, async () => {
  // SecretInjectingEnv 默认从 globalSecretStash 注入（hub 生产路径同源），
  // 作用域来自构造时信任的会话 shellEnv。
  const { globalSecretStash } = await import('../apps/hub/src/harness/secret-stash.js');
  const envKey = globalSecretStash.stash('super-secret-password-123', 'sess_secret_inject');

  const env = new SecretInjectingEnv({ cwd: process.cwd(), shellEnv: { BOTD_SESSION_ID: 'sess_secret_inject' } });
  // 命令行只引用环境变量名，明文永不出现在命令里。
  const command = `node -e "process.stdout.write(process.env.${envKey} || '')"`;
  const chunks: string[] = [];
  const result = await env.exec(
    command,
    {
      onOutput: (text) => chunks.push(text),
    },
    BACKGROUND_CONTEXT,
  );
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value.exitCode, 0);
  assert.equal(chunks.join(''), 'super-secret-password-123', 'child process reads the stashed secret via env');
  assert.ok(!command.includes('{{SECRET'), 'plaintext must not appear in the command line');
  globalSecretStash.consume(envKey, 'sess_secret_inject');
});

// ---------------------------------------------------------------------------
// 5. Full loop over the real Hub HTTP + durable runtime
// ---------------------------------------------------------------------------

interface Fixture {
  hub: Awaited<ReturnType<typeof startHub>>;
  faux: ReturnType<typeof fauxProvider>;
  runtime: HubDurableRuntime;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
  events: Array<{ sessionId: string; event: any }>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-secret-stash-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.sqlite'),
    adminPassword: PASSWORD,
    durableRuntime: runtime,
    durableModels: models,
  });
  t.after(async () => {
    (hub.server as any).closeAllConnections?.();
    await hub.close();
  });

  const address = hub.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  const json = async <T = any>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };

  const events: Array<{ sessionId: string; event: any }> = [];
  hub.sseHub.onBroadcast((sessionId, event) => {
    events.push({ sessionId, event });
  });

  const db = hub.db;
  db.createNode({
    id: 'node-1',
    name: 'Test node',
    platform: 'linux',
    tokenHash: 'x'.repeat(64),
    ownerId: 'user_admin',
  });
  const now = new Date().toISOString();
  db.saveBot({
    id: 'architect',
    nodeId: 'node-1',
    name: 'Architect',
    description: 'You deploy things.',
    modelProvider: 'faux',
    modelId: 'main',
    enabledSkills: [],
    updatedAt: now,
  });
  db.setBotFile('architect', 'system', 'You are the architect bot.');
  db.createSession({
    id: 'sess_secret',
    title: 'Secret stash',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });
  await hub.ensureDurableRuntime();
  assert.ok(runtime.getPersona('architect'));

  return { hub, faux, runtime, json, events };
}

test('全链路：ask_human UI 机密表单零泄漏（AskDoc/SSE/LLM 上下文只有 REDACTED，env 可读明文）', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sid = 'sess_secret';
  const SECRET_PLAINTEXT = 'super-secret-password-123';
  const specJson = JSON.stringify(secretUiSpec);

  // Router：请求部署凭据 → ask_human(previewType ui) → 等待用户响应。
  f.faux.setResponses(
    [...Array(64)].map(
      () =>
        ((context: { messages: readonly { role: string; content?: unknown }[] }) => {
          const text = lastUserText(context.messages);
          if (/please provide deploy credentials/.test(text) && !toolResultSeen(context.messages)) {
            return fauxAssistantMessage(
              [
                fauxToolCall('ask_human', {
                  prompt: 'Fill in the deploy credentials',
                  previewType: 'ui',
                  previewContent: specJson,
                }),
              ],
              { stopReason: 'toolUse' },
            );
          }
          return fauxAssistantMessage('Credentials received, deploying.');
        }) as never,
    ),
  );

  await f.json<{ role: string }>('/api/sessions/sess_secret/messages', 'POST', {
    content: 'please provide deploy credentials',
  });

  // pending ask 透出，且带 previewType/previewContent（AskCard 渲染机密表单）。
  const asks = await waitFor(
    async () => await f.json<Array<{ id: string; prompt: string; status: string; previewType?: string; previewContent?: string }>>(`/api/sessions/${sid}/asks`),
    (list) => list.some((a) => /deploy credentials/i.test(a.prompt) && a.status === 'pending'),
    'durable secret ask to surface',
  );
  const ask = asks.find((a) => /deploy credentials/i.test(a.prompt))!;
  assert.equal(ask.previewType, 'ui');
  assert.equal(ask.previewContent, specJson);

  // respond：提交含机密明文的表单（模拟前端 AskCard payload）。
  const responded = await f.json<{ ok: boolean; ask: { status: string; answer: string } }>(
    `/api/sessions/${sid}/asks/${encodeURIComponent(ask.id)}/respond`,
    'POST',
    {
      answer: JSON.stringify({
        decision: '提交',
        state: { credentials: { username: 'deploy', password: SECRET_PLAINTEXT }, config: { token: 'tok-live' } },
      }),
    },
  );
  assert.equal(responded.ok, true);
  assert.equal(responded.ask.status, 'answered');
  assert.ok(!responded.ask.answer.includes(SECRET_PLAINTEXT), 'API response must not echo the secret');
  assert.ok(!responded.ask.answer.includes('tok-live'));
  assert.match(responded.ask.answer, /\[REDACTED:\$BOTD_SECRET_[0-9A-F]{8}\]/);

  // SSE：interaction_resolved 广播的是 redacted 答案。
  const resolved = await waitFor(
    () => f.events,
    (events) => events.some(({ sessionId, event }) => sessionId === sid && event.type === 'interaction_resolved' && event.askId === ask.id),
    'interaction_resolved broadcast',
  );
  const resolvedAnswer = resolved.find(
    ({ sessionId, event }) => sessionId === sid && event.type === 'interaction_resolved' && event.askId === ask.id,
  )!.event.answer as string;
  assert.ok(!resolvedAnswer.includes(SECRET_PLAINTEXT), 'SSE must not carry the plaintext secret');
  assert.ok(!resolvedAnswer.includes('tok-live'));
  assert.match(resolvedAnswer, /\[REDACTED:\$BOTD_SECRET_[0-9A-F]{8}\]/);

  // AskDoc（SQLite 之外的 durable 文档状态）：answer 只有占位符。
  const routerConversationId = await ensureRouterConversationId(f.runtime, sid, 'architect');
  const conversationIdNum = Number(routerConversationId);
  const doc = await f.runtime.harness.snapshot(
    AskDoc,
    conversationIdNum as import('@earendil-works/pi-durable').ConversationId,
    BACKGROUND_CONTEXT,
  );
  const storedAnswer = (doc?.asks as Record<string, { answer?: string }> | undefined)?.[ask.id]?.answer ?? '';
  assert.ok(!storedAnswer.includes(SECRET_PLAINTEXT), 'AskDoc.answer must not contain the plaintext');
  assert.match(storedAnswer, /\[REDACTED:\$BOTD_SECRET_[0-9A-F]{8}\]/);

  // LLM 上下文：steer 回会话的用户消息（含 Secret Stash 说明）也不含明文，
  // 且指引 Bot 用 process.env.BOTD_SECRET_* 消费机密。
  const conversation = await f.runtime.conversation(routerConversationId, BACKGROUND_CONTEXT);
  assert.ok(conversation);
  await waitFor(
    async () => {
      const page = await conversation!.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT);
      return page.items.some((entry) => {
        const first = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
        if (first?.role !== 'user') return false;
        const text =
          typeof first.content === 'string'
            ? first.content
            : Array.isArray(first.content)
              ? JSON.stringify(first.content)
              : '';
        return text.includes('[Secret Stash]') && text.includes('BOTD_SECRET_');
      });
    },
    (found) => found,
    'secret stash note steered back into the conversation',
  );
  const page = await conversation!.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT);
  for (const entry of page.items) {
    const serialized = JSON.stringify(entry.model ?? []);
    assert.ok(
      !serialized.includes(SECRET_PLAINTEXT) && !serialized.includes('tok-live'),
      `conversation entry leaked a secret: ${serialized.slice(0, 200)}`,
    );
  }

  // 执行环境：占位符里的 env 键真实存在于 stash，且 node -e 能读出明文。
  const envKeyMatch = storedAnswer.match(/BOTD_SECRET_[0-9A-F]{8}/);
  assert.ok(envKeyMatch, 'stored answer names the stashed env key');
  const envKey = envKeyMatch[0];
  const { globalSecretStash } = await import('../apps/hub/src/harness/secret-stash.js');
  assert.ok(globalSecretStash.peek(envKey, sid), 'env key resolves in the global stash for this session');
  const envRecord = globalSecretStash.getEnvRecord(sid);
  assert.equal(envRecord[envKey], SECRET_PLAINTEXT);

  const env = new SecretInjectingEnv({ cwd: process.cwd(), shellEnv: { BOTD_SESSION_ID: sid } });
  const chunks: string[] = [];
  const exec = await env.exec(
    `node -e "process.stdout.write(process.env.${envKey} || '')"`,
    { onOutput: (text) => chunks.push(text) },
    BACKGROUND_CONTEXT,
  );
  assert.ok(exec.ok, exec.ok ? '' : exec.error.message);
  assert.equal(chunks.join(''), SECRET_PLAINTEXT, 'shell child reads the exact secret cross-platform');
});
