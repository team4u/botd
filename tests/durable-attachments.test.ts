/**
 * 消息附件全链路测试：SQLite 零内联字节 + 磁盘产物可达 Durable 模型。
 *
 * 覆盖三个缺陷的修复：
 *  1. WebUI 图片上传（附件只带产物指针，不带 dataUrl）→ Durable 模型收到
 *     从磁盘读出的多模态 ImageContent（此前被 extractImageAttachments 完全忽略）；
 *  2. 非图片附件（如 csv 账单）→ 消息文本带 `[Attached Files]` 块（文件名/类型/
 *     大小/磁盘路径），纯附件空文本消息也不会提交空字符串；
 *  3. 内联 dataUrl → 自动落盘为 `<artifactsDir>/art_...`，SQLite
 *     `messages.attachments_json` 只存轻量指针（不含 dataUrl/base64）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { startHub } from '../apps/hub/src/index.js';
import { HubDurableRuntime } from '../apps/hub/src/harness/hub-harness.js';
import { ensureRouterConversationId } from '../apps/hub/src/routes/workers.js';

const PASSWORD = 'durable-attachments-password';

/** 1x1 灰度 PNG（67 字节）。 */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==';
const PNG_1X1_BYTES = Buffer.from(PNG_1X1_BASE64, 'base64');

const CSV_CONTENT = 'date,amount,merchant\n2025-01-01,-128.00,supermarket\n2025-01-02,-59.90,bookstore\n';

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

/** Router 会话里最后一条 user 消息（多模态时返回内容块数组）。 */
const lastUserEntryContent = (entries: readonly { id: unknown; model?: readonly unknown[] }[]) => {
  for (const entry of [...entries].reverse()) {
    const first = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
    if (first?.role === 'user') return first.content;
  }
  return undefined;
};

interface Fixture {
  base: string;
  cookie: string;
  artifactsDir: string;
  dbPath: string;
  hub: Awaited<ReturnType<typeof startHub>>;
  faux: ReturnType<typeof fauxProvider>;
  runtime: HubDurableRuntime;
  json: <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
  uploadArtifact: (filename: string, mimeType: string, content: Buffer) => Promise<any>;
}

/** 全链路 fixture：真实 HTTP Hub + 注入式 HubDurableRuntime（faux provider）。 */
async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botd-durable-att-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const dbPath = path.join(dir, 'hub.sqlite');
  const artifactsDir = path.join(dir, 'artifacts');

  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await HubDurableRuntime.open({ storage: new MemoryStorage(), models });

  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dbPath,
    artifactsDir,
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

  // 种子：节点 + Bot + 会话，随后同步分身。
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
    description: 'You design systems.',
    modelProvider: 'faux',
    modelId: 'main',
    thinkingLevel: 'medium',
    enabledSkills: [],
    updatedAt: now,
  });
  db.createSession({
    id: 'sess_att',
    title: 'Attachments',
    leadBotId: 'architect',
    ownerId: 'user_admin',
  });
  await hub.ensureDurableRuntime();
  assert.ok(runtime.getPersona('architect'), 'persona must be synced from Hub SQLite');

  const uploadArtifact = async (filename: string, mimeType: string, content: Buffer) =>
    json<any>('/api/sessions/sess_att/artifacts', 'POST', {
      filename,
      mimeType,
      contentBase64: content.toString('base64'),
    });

  return { base, cookie, artifactsDir, dbPath, hub, faux, runtime, json, uploadArtifact };
}

/** 读取 Router 会话的全部 Entry（等待至少一条 user 消息后返回）。 */
async function routerEntries(f: Fixture): Promise<readonly { id: unknown; model?: readonly unknown[] }[]> {
  const routerId = await ensureRouterConversationId(f.runtime, 'sess_att', 'architect');
  const conv = await f.runtime.conversation(routerId, BACKGROUND_CONTEXT);
  assert.ok(conv, 'router conversation must exist');
  const page = await conv.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
  return page.items as unknown as { id: unknown; model?: readonly unknown[] }[];
}

/** 直连 SQLite 读指定消息的 attachments_json 原文（验证零 base64 膨胀）。 */
function readRawAttachmentsJson(dbPath: string, sessionId: string, messageId: string): string | null {
  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = sqlite
      .prepare('SELECT attachments_json FROM messages WHERE session_id = ? AND id = ?')
      .get(sessionId, messageId) as { attachments_json: string | null } | undefined;
    return row?.attachments_json ?? null;
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------

test('1. disk-backed WebUI image upload reaches the durable model as ImageContent', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  f.faux.setResponses([...Array(32)].map(() => fauxAssistantMessage('Image received.')));

  // WebUI 上传链路：先传产物拿指针（响应不含 dataUrl）
  const uploaded = await f.uploadArtifact('shot.png', 'image/png', PNG_1X1_BYTES);
  assert.equal(uploaded.id.startsWith('art_'), true);
  assert.equal(uploaded.url, `/api/artifacts/${uploaded.id}/content`);
  assert.equal(uploaded.dataUrl, undefined, 'upload response must not carry inline dataUrl');

  // 再随消息发送指针附件（与 useUploads.ts 的实际形态一致）
  const posted = await f.json<{ id: string; attachments: any[] }>(
    '/api/sessions/sess_att/messages',
    'POST',
    {
      content: 'What is in this screenshot?',
      attachments: [
        { id: uploaded.id, filename: uploaded.filename, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes, url: uploaded.url },
      ],
    },
  );
  assert.equal(posted.attachments.length, 1);
  assert.equal(posted.attachments[0].dataUrl, undefined, 'persisted attachment must not carry dataUrl');

  // Durable 侧：多模态 user Entry（text + image 内容块，图片字节来自磁盘）
  await waitFor(
    async () => {
      const entries = await routerEntries(f);
      const content = lastUserEntryContent(entries);
      return (
        Array.isArray(content) &&
        content.some((block) => (block as any).type === 'image')
      );
    },
    (found) => found === true,
    'the durable user entry to carry an image content block',
  );
  const entries = await routerEntries(f);
  const blocks = lastUserEntryContent(entries) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  const imageBlock = blocks.find((b) => b.type === 'image');
  assert.ok(imageBlock, 'image block must exist');
  assert.equal(imageBlock!.mimeType, 'image/png');
  assert.equal(imageBlock!.data, PNG_1X1_BASE64, 'image data must be the exact bytes read from disk');
  const textBlock = blocks.find((b) => b.type === 'text');
  assert.ok(textBlock?.text?.includes('What is in this screenshot?'));
  // 图片附件同样进入 [Attached Files] 块（模型可拿路径跑 CLI 工具）
  assert.match(textBlock!.text!, /\[Attached Files\]:\n- shot\.png \(image\/png, 67 bytes\) -> path: .+/);
});

test('2. non-image attachment (csv bill) is visible to the durable model with its disk path', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  const seenPaths: string[] = [];
  f.faux.setResponses(
    [...Array(32)].map(
      () =>
        ((context: { messages: readonly { role: string; content?: unknown }[] }) => {
          const lastUser = [...context.messages].reverse().find((m) => m.role === 'user');
          const text =
            typeof lastUser?.content === 'string'
              ? lastUser.content
              : Array.isArray(lastUser?.content)
                ? String((lastUser.content[0] as { text?: string }).text ?? '')
                : '';
          const match = /-> path: (\S+)/.exec(text);
          if (match) seenPaths.push(match[1]);
          return fauxAssistantMessage('Bill parsed.');
        }) as never,
    ),
  );

  const uploaded = await f.uploadArtifact('statement.csv', 'text/csv', Buffer.from(CSV_CONTENT, 'utf8'));

  // 纯附件空文本消息：也必须提交成功且内容非空
  const posted = await f.json<{ id: string }>('/api/sessions/sess_att/messages', 'POST', {
    content: '',
    attachments: [
      { id: uploaded.id, filename: uploaded.filename, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes, url: uploaded.url },
    ],
  });
  assert.ok(posted.id);

  // Durable 侧：user Entry 文本带 [Attached Files] 块与磁盘路径
  await waitFor(
    async () => {
      const entries = await routerEntries(f);
      const content = lastUserEntryContent(entries);
      return typeof content === 'string' && content.includes('[Attached Files]:');
    },
    (found) => found === true,
    'the durable user message to carry the [Attached Files] block',
  );
  const entries = await routerEntries(f);
  const text = lastUserEntryContent(entries) as string;
  const sizeBytes = Buffer.byteLength(CSV_CONTENT, 'utf8');
  assert.match(text, new RegExp(`^\\[Attached Files\\]:\\n- statement\\.csv \\(text/csv, ${sizeBytes} bytes\\) -> path: (\\S+)$`));
  const pathMatch = /-> path: (\S+)/.exec(text);
  assert.ok(pathMatch, 'disk path must be present');

  // 模型可从该路径读到文件原文（faux 回调里截获的路径同样成立）
  const disk = fs.readFileSync(pathMatch![1], 'utf8');
  assert.equal(disk, CSV_CONTENT);
  await waitFor(
    () => seenPaths,
    (paths) => paths.some((p) => fs.readFileSync(p, 'utf8') === CSV_CONTENT),
    'the model-side callback to read the exact file from the announced path',
  );
});

test('3. inline dataUrl is sanitized: persisted to disk, SQLite stores only the pointer', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);

  f.faux.setResponses([...Array(32)].map(() => fauxAssistantMessage('Sanitized image received.')));

  const posted = await f.json<{ id: string; attachments: any[] }>(
    '/api/sessions/sess_att/messages',
    'POST',
    {
      content: 'Check this inline chart',
      attachments: [
        {
          id: '',
          filename: 'chart.png',
          mimeType: 'image/png',
          sizeBytes: PNG_1X1_BYTES.length,
          url: '',
          dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
        } as any,
      ],
    },
  );

  // 响应附件已是磁盘产物指针（dataUrl 剥离，id 替换为 art_...）
  assert.equal(posted.attachments.length, 1);
  const att = posted.attachments[0];
  assert.equal(typeof att.id === 'string' && att.id.startsWith('art_'), true, `attachment id must be an art_ id, got: ${att.id}`);
  assert.equal(att.dataUrl, undefined);
  assert.equal(att.filename, 'chart.png');
  assert.equal(att.url, `/api/artifacts/${att.id}/content`);

  // 字节物理落盘于 <artifactsDir>/art_...
  const diskPath = path.join(f.artifactsDir, att.id);
  assert.ok(fs.existsSync(diskPath), 'inline bytes must be persisted on disk');
  assert.deepEqual(fs.readFileSync(diskPath), PNG_1X1_BYTES);

  // SQLite 原文零 base64 膨胀：attachments_json 只存轻量指针
  const raw = readRawAttachmentsJson(f.dbPath, 'sess_att', posted.id);
  assert.ok(raw, 'attachments_json must be present');
  assert.equal(raw.includes('dataUrl'), false, 'attachments_json must not contain the dataUrl key');
  assert.equal(raw.includes(PNG_1X1_BASE64), false, 'attachments_json must not contain the base64 payload');

  // Durable 模型依然收到图片（从磁盘读出）
  await waitFor(
    async () => {
      const entries = await routerEntries(f);
      const content = lastUserEntryContent(entries);
      return (
        Array.isArray(content) &&
        content.some((block) => (block as any).type === 'image' && (block as any).data === PNG_1X1_BASE64)
      );
    },
    (found) => found === true,
    'the durable model to receive the image read back from disk',
  );
});
