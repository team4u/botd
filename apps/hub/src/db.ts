import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ArtifactRecord,
  BotConfig,
  MessageAttachment,
  MessageRecord,
  MessageRole,
  MessageSearchHit,
  NodeRecord,
  NodeWithBots,
  PlatformType,
  SessionMode,
  SessionRecord,
  SessionStatus,
  ThinkingLevel,
  ToolCallRecord,
  TriggerKind,
  TriggerRecord,
  TurnUsage,
  UserRecord,
  UserRole,
} from '@botd/protocol';

export interface HubDatabaseOptions {
  dbPath?: string;
}

export interface IncrementalMessageResult {
  message: MessageRecord;
  rowid: number;
}

export const HUB_SCHEMA_VERSION = 2;

export { isValidCommandName } from '@botd/protocol';
const PREVIEW_MAX_LENGTH = 60;

const buildPreview = (content: string): string | undefined => {
  const text = content
    // Code fences (including language tags) collapse to a single space
    .replace(/```[\s\S]*?```/g, ' ')
    // Inline code keeps its inner text
    .replace(/`([^`]*)`/g, '$1')
    // Links keep only their label text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Heading markers at line starts
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // Emphasis, strikethrough, blockquote and other marker characters
    .replace(/[*_~>]+/g, ' ')
    // Collapse all whitespace (including newlines) into a single space
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH)}...` : text;
};

/** 解析可空 JSON 列：NULL / 空串 / 非法 JSON 一律返回 undefined */
const parseOptionalJson = <T>(raw: string | null | undefined): T | undefined => {
  if (raw === null || raw === undefined || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  sender_bot_id: string | null;
  model_badge: string | null;
  content: string;
  mentions_json: string;
  tool_calls_json: string | null;
  usage_json: string | null;
  attachments_json: string | null;
  created_at: string;
};

const mapMessageRow = (row: MessageRow): MessageRecord => {
  const toolCalls = parseOptionalJson<ToolCallRecord[]>(row.tool_calls_json);
  const usage = parseOptionalJson<TurnUsage>(row.usage_json);
  const attachments = parseOptionalJson<MessageAttachment[]>(row.attachments_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    senderBotId: row.sender_bot_id ?? undefined,
    modelBadge: row.model_badge ?? undefined,
    content: row.content,
    mentions: parseOptionalJson<string[]>(row.mentions_json) ?? [],
    ...(toolCalls ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
    ...(attachments ? { attachments } : {}),
    createdAt: row.created_at,
  };
};

const ARTIFACT_COLUMNS = 'id, session_id, filename, mime_type, size_bytes, sender_bot_id, created_at';

type ArtifactRow = {
  id: string;
  session_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | bigint;
  sender_bot_id: string | null;
  created_at: string;
};

const mapArtifactRow = (row: ArtifactRow): ArtifactRecord => ({
  id: row.id,
  sessionId: row.session_id,
  filename: row.filename,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  ...(row.sender_bot_id ? { senderBotId: row.sender_bot_id } : {}),
  createdAt: row.created_at,
});

const TRIGGER_COLUMNS =
  'id, session_id, bot_id, owner_id, name, kind, token, cron_expr, run_at, prompt, enabled, last_triggered_at, created_at';

type NodeRow = {
  id: string;
  name: string;
  platform: string;
  skills_json: string;
  extensions_json: string;
  status: string;
  last_seen_at: string;
  created_at: string;
  pid: number | null;
  started_at: string | null;
  version: string | null;
};

const mapNodeRow = (row: NodeRow): NodeRecord => ({
  id: row.id,
  name: row.name,
  platform: row.platform as PlatformType,
  skills: parseOptionalJson<string[]>(row.skills_json) ?? [],
  extensions: parseOptionalJson<string[]>(row.extensions_json) ?? [],
  status: row.status as 'online' | 'offline',
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  ...(typeof row.pid === 'number' ? { pid: row.pid } : {}),
  ...(typeof row.started_at === 'string' && row.started_at.length > 0 ? { startedAt: row.started_at } : {}),
  ...(row.version != null ? { version: row.version } : {}),
});

type BotRow = {
  id: string;
  node_id: string;
  name: string;
  description: string;
  model_provider: string;
  model_id: string;
  thinking_level: string | null;
  enabled_skills_json: string;
  enabled_extensions_json: string;
  updated_at: string;
};

const mapBotRow = (row: BotRow): BotConfig => ({
  id: row.id,
  nodeId: row.node_id,
  name: row.name,
  description: row.description,
  modelProvider: row.model_provider,
  modelId: row.model_id,
  thinkingLevel: (row.thinking_level as ThinkingLevel) ?? 'medium',
  enabledSkills: parseOptionalJson<string[]>(row.enabled_skills_json) ?? [],
  enabledExtensions: parseOptionalJson<string[]>(row.enabled_extensions_json) ?? [],
  updatedAt: row.updated_at,
});

type TriggerRow = {
  id: string;
  session_id: string;
  bot_id: string;
  owner_id: string;
  name: string;
  kind: string;
  token: string | null;
  cron_expr: string | null;
  run_at: string | null;
  prompt: string;
  enabled: number;
  last_triggered_at: string | null;
  created_at: string;
};

const mapTriggerRow = (row: TriggerRow): TriggerRecord => ({
  id: row.id,
  sessionId: row.session_id,
  botId: row.bot_id,
  name: row.name,
  kind: row.kind as TriggerKind,
  ...(row.token ? { token: row.token } : {}),
  ...(row.cron_expr ? { cronExpr: row.cron_expr } : {}),
  ...(row.run_at ? { runAt: row.run_at } : {}),
  prompt: row.prompt,
  enabled: Boolean(row.enabled),
  ...(row.last_triggered_at ? { lastTriggeredAt: row.last_triggered_at } : {}),
  createdAt: row.created_at,
});

export class HubDatabase {
  public db: DatabaseSync;
  public readonly dbPath: string;

  constructor(options?: HubDatabaseOptions) {
    const defaultDir = process.env.BOTD_HUB_DATA_DIR || path.join(os.homedir(), '.botd');
    const dbPath = options?.dbPath ?? process.env.BOTD_DB_PATH ?? path.join(defaultDir, 'hub.sqlite');
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:' && process.platform !== 'win32') fs.chmodSync(dbPath, 0o600);
    this.initSchema();
    this.resetStaleMetadata();
  }

  public getSchemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  public backupDatabase(destPath?: string): string {
    if (this.dbPath === ':memory:') {
      return '';
    }
    const resolvedDest = destPath ?? `${this.dbPath}.bak-v${this.getSchemaVersion()}`;
    fs.mkdirSync(path.dirname(path.resolve(resolvedDest)), { recursive: true });
    if (fs.existsSync(resolvedDest)) {
      fs.rmSync(resolvedDest, { force: true });
    }
    this.db.exec(`VACUUM INTO ${JSON.stringify(resolvedDest).replaceAll('"', "'")}`);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(resolvedDest, 0o600);
      } catch {}
    }
    return resolvedDest;
  }

  public resetStaleMetadata(): void {
    this.db.exec(`
      UPDATE nodes SET status = 'offline' WHERE status = 'online';
      UPDATE sessions SET status = 'idle', active_bot_id = NULL WHERE status IN ('running', 'queued');
    `);
  }

  public inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private initSchema(): void {
    if (this.dbPath !== ':memory:') {
      const hasNodesTable = Boolean(
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get()
      );
      const currentUserVersion = this.getSchemaVersion();
      if (hasNodesTable && currentUserVersion < HUB_SCHEMA_VERSION) {
        this.backupDatabase(`${path.resolve(this.dbPath)}.bak-v${currentUserVersion}`);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        skills_json TEXT NOT NULL DEFAULT '[]',
        extensions_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT,
        version TEXT
      );

      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        model_provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        thinking_level TEXT DEFAULT 'medium',
        enabled_skills_json TEXT NOT NULL DEFAULT '[]',
        enabled_extensions_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'direct',
        lead_bot_id TEXT NOT NULL,
        member_bot_ids_json TEXT NOT NULL DEFAULT '[]',
        cursor_map_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'idle',
        active_bot_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        parallel_roundtable INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        sender_bot_id TEXT,
        model_badge TEXT,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT,
        usage_json TEXT,
        attachments_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sender_bot_id TEXT,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);

      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        token TEXT UNIQUE,
        cron_expr TEXT,
        run_at TEXT,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_triggered_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_triggers_session ON triggers(session_id);

      CREATE TABLE IF NOT EXISTS session_resets_pending (
        session_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, bot_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_resets_pending_session ON session_resets_pending(session_id);

      CREATE TABLE IF NOT EXISTS artifact_cleanup_pending (
        storage_path TEXT PRIMARY KEY,
        error TEXT NOT NULL,
        failed_at TEXT NOT NULL
      );
    `);

    const migrations = [
      `ALTER TABLE nodes ADD COLUMN extensions_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE bots ADD COLUMN enabled_extensions_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE nodes ADD COLUMN pid INTEGER`,
      `ALTER TABLE nodes ADD COLUMN started_at TEXT`,
      `ALTER TABLE nodes ADD COLUMN version TEXT`,
      `ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE nodes ADD COLUMN owner_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN owner_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN parallel_roundtable INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE messages ADD COLUMN tool_calls_json TEXT`,
      `ALTER TABLE messages ADD COLUMN usage_json TEXT`,
      `ALTER TABLE messages ADD COLUMN attachments_json TEXT`,
      `ALTER TABLE triggers ADD COLUMN run_at TEXT`,
    ];

    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch {
        // Ignore if column already exists
      }
    }

    // 自举管理员固定 id 为 user_admin：存量 nodes/sessions 归属回填
    this.db.exec(`UPDATE nodes SET owner_id = 'user_admin' WHERE owner_id IS NULL`);
    this.db.exec(`UPDATE sessions SET owner_id = 'user_admin' WHERE owner_id IS NULL`);

    this.db.exec(`PRAGMA user_version = ${HUB_SCHEMA_VERSION}`);
  }

  // --- Session Resets Pending ---
  markSessionResetPending(sessionId: string, botId: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO session_resets_pending (session_id, bot_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, bot_id) DO UPDATE SET created_at = excluded.created_at
    `);
    stmt.run(sessionId, botId, now);
  }

  hasPendingSessionReset(sessionId: string, botId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM session_resets_pending WHERE session_id = ? AND bot_id = ? LIMIT 1');
    return stmt.get(sessionId, botId) !== undefined;
  }

  clearSessionResetPending(sessionId: string, botId: string): void {
    const stmt = this.db.prepare('DELETE FROM session_resets_pending WHERE session_id = ? AND bot_id = ?');
    stmt.run(sessionId, botId);
  }

  // --- Artifact Cleanup Pending ---
  recordArtifactCleanupPending(storagePath: string, error: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO artifact_cleanup_pending (storage_path, error, failed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(storage_path) DO UPDATE SET
        error = excluded.error,
        failed_at = excluded.failed_at
    `);
    stmt.run(storagePath, error, now);
  }

  listArtifactCleanupPending(): { storagePath: string; error: string; failedAt: string }[] {
    const stmt = this.db.prepare('SELECT storage_path, error, failed_at FROM artifact_cleanup_pending ORDER BY failed_at ASC');
    const rows = stmt.all() as { storage_path: string; error: string; failed_at: string }[];
    return rows.map((r) => ({
      storagePath: r.storage_path,
      error: r.error,
      failedAt: r.failed_at,
    }));
  }

  removeArtifactCleanupPending(storagePath: string): void {
    const stmt = this.db.prepare('DELETE FROM artifact_cleanup_pending WHERE storage_path = ?');
    stmt.run(storagePath);
  }

  // --- Users ---
  /** 若 users 表为空，插入自举管理员（固定 id: user_admin / username: admin / role: admin） */
  ensureBootstrapAdmin(passwordHash: string): void {
    if (this.countUsers() > 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at)
      VALUES ('user_admin', 'admin', ?, 'admin', ?)
    `);
    stmt.run(passwordHash, now);
  }

  countUsers(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) AS count FROM users');
    const row = stmt.get() as { count: number | bigint };
    return Number(row.count);
  }

  createUser(data: { id: string; username: string; passwordHash: string; role: UserRole }): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(data.id, data.username, data.passwordHash, data.role, now);
  }

  /** 内部行（含密码哈希），仅登录校验用 */
  getUserWithHash(username: string): { id: string; username: string; role: UserRole; passwordHash: string; createdAt: string } | undefined {
    const stmt = this.db.prepare('SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?');
    const row = stmt.get(username) as {
      id: string;
      username: string;
      password_hash: string;
      role: string;
      created_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      role: row.role as UserRole,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
  }

  getUser(id: string): UserRecord | undefined {
    const stmt = this.db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?');
    const row = stmt.get(id) as {
      id: string;
      username: string;
      role: string;
      created_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      role: row.role as UserRole,
      createdAt: row.created_at,
    };
  }

  listUsers(): UserRecord[] {
    const stmt = this.db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC');
    const rows = stmt.all() as {
      id: string;
      username: string;
      role: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role as UserRole,
      createdAt: row.created_at,
    }));
  }

  updateUserPassword(id: string, passwordHash: string): void {
    const stmt = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    stmt.run(passwordHash, id);
  }

  /** 删除用户，并级联删除其全部 sessions 及这些 sessions 的 messages */
  deleteUser(id: string): void {
    return this.inTransaction(() => {
      const sessionIds = (this.db.prepare('SELECT id FROM sessions WHERE owner_id = ?').all(id) as { id: string }[]).map(
        (row) => row.id
      );
      if (sessionIds.length > 0) {
        const placeholders = sessionIds.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM session_resets_pending WHERE session_id IN (${placeholders})`).run(...sessionIds);
        this.db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...sessionIds);
        this.db.prepare(`DELETE FROM triggers WHERE session_id IN (${placeholders})`).run(...sessionIds);
        this.db.prepare(`DELETE FROM artifacts WHERE session_id IN (${placeholders})`).run(...sessionIds);
      }
      this.db.prepare('DELETE FROM sessions WHERE owner_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
  }

  // --- Nodes ---
  createNode(data: { id: string; name: string; platform: PlatformType; tokenHash: string; ownerId: string; pid?: number; startedAt?: string }): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, platform, token_hash, skills_json, extensions_json, status, last_seen_at, created_at, pid, started_at, owner_id)
      VALUES (?, ?, ?, ?, '[]', '[]', 'offline', ?, ?, ?, ?, ?)
    `);
    stmt.run(data.id, data.name, data.platform, data.tokenHash, now, now, data.pid ?? null, data.startedAt ?? null, data.ownerId);
  }

  /** 返回节点归属用户 id；节点不存在返回 undefined */
  getNodeOwner(nodeId: string): string | undefined {
    const stmt = this.db.prepare('SELECT owner_id FROM nodes WHERE id = ?');
    const row = stmt.get(nodeId) as { owner_id: string | null } | undefined;
    return row?.owner_id ?? undefined;
  }

  getNode(id: string): NodeRecord | undefined {
    const stmt = this.db.prepare('SELECT id, name, platform, skills_json, extensions_json, status, last_seen_at, created_at, pid, started_at, version FROM nodes WHERE id = ?');
    const row = stmt.get(id) as NodeRow | undefined;
    if (!row) return undefined;
    return mapNodeRow(row);
  }

  getNodeWithSecret(id: string): (NodeRecord & { tokenHash: string }) | undefined {
    const stmt = this.db.prepare('SELECT id, name, platform, token_hash, skills_json, extensions_json, status, last_seen_at, created_at, pid, started_at, version FROM nodes WHERE id = ?');
    const row = stmt.get(id) as (NodeRow & { token_hash: string }) | undefined;
    if (!row) return undefined;
    return {
      ...mapNodeRow(row),
      tokenHash: row.token_hash,
    };
  }

  getAllNodesWithBots(ownerId: string): NodeWithBots[] {
    const stmt = this.db.prepare('SELECT id, name, platform, skills_json, extensions_json, status, last_seen_at, created_at, pid, started_at, version FROM nodes WHERE owner_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(ownerId) as NodeRow[];
    return rows.map((row) => ({
      ...mapNodeRow(row),
      bots: this.getBotsForNode(row.id),
    }));
  }

  updateNodeStatus(id: string, status: 'online' | 'offline', lastSeenAt?: string): void {
    const seen = lastSeenAt ?? new Date().toISOString();
    const stmt = this.db.prepare('UPDATE nodes SET status = ?, last_seen_at = ? WHERE id = ?');
    stmt.run(status, seen, id);
  }

  updateNodeMetadata(
    id: string,
    name: string,
    platform: PlatformType,
    skills: string[],
    extensions: string[] = [],
    pid?: number,
    startedAt?: string,
    version?: string
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET name = ?, platform = ?, skills_json = ?, extensions_json = ?, pid = ?, started_at = ?, version = ?, status = 'online', last_seen_at = ?
      WHERE id = ?
    `);
    stmt.run(name, platform, JSON.stringify(skills), JSON.stringify(extensions), pid ?? null, startedAt ?? null, version ?? null, now, id);
  }

  deleteNode(id: string): void {
    return this.inTransaction(() => {
      const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
      stmt.run(id);
    });
  }

  /** Remove every cached BOT record belonging to a node (force node removal). */
  deleteBotsForNode(nodeId: string): void {
    const stmt = this.db.prepare('DELETE FROM bots WHERE node_id = ?');
    stmt.run(nodeId);
  }

  private updateNodeStringSet(
    nodeId: string,
    column: 'skills_json' | 'extensions_json',
    mutate: (list: string[]) => string[]
  ): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    const current = column === 'skills_json' ? node.skills : node.extensions;
    const next = mutate([...current]);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      const stmt = this.db.prepare(`UPDATE nodes SET ${column} = ? WHERE id = ?`);
      stmt.run(JSON.stringify(next), nodeId);
    }
  }

  addNodeSkill(nodeId: string, skillId: string): void {
    this.updateNodeStringSet(nodeId, 'skills_json', (list) =>
      list.includes(skillId) ? list : [...list, skillId]
    );
  }

  removeNodeSkill(nodeId: string, skillId: string): void {
    this.updateNodeStringSet(nodeId, 'skills_json', (list) =>
      list.filter((s) => s !== skillId)
    );
  }

  addNodeExtension(nodeId: string, extId: string): void {
    this.updateNodeStringSet(nodeId, 'extensions_json', (list) =>
      list.includes(extId) ? list : [...list, extId]
    );
  }

  removeNodeExtension(nodeId: string, extId: string): void {
    this.updateNodeStringSet(nodeId, 'extensions_json', (list) =>
      list.filter((e) => e !== extId)
    );
  }

  // --- Bots ---
  getBot(id: string): BotConfig | undefined {
    const stmt = this.db.prepare('SELECT id, node_id, name, description, model_provider, model_id, thinking_level, enabled_skills_json, enabled_extensions_json, updated_at FROM bots WHERE id = ?');
    const row = stmt.get(id) as BotRow | undefined;
    return row ? mapBotRow(row) : undefined;
  }

  getBotsForNode(nodeId: string): BotConfig[] {
    const stmt = this.db.prepare('SELECT id, node_id, name, description, model_provider, model_id, thinking_level, enabled_skills_json, enabled_extensions_json, updated_at FROM bots WHERE node_id = ? ORDER BY id ASC');
    const rows = stmt.all(nodeId) as BotRow[];
    return rows.map(mapBotRow);
  }

  saveBot(bot: BotConfig): void {
    const stmt = this.db.prepare(`
      INSERT INTO bots (id, node_id, name, description, model_provider, model_id, thinking_level, enabled_skills_json, enabled_extensions_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        node_id = excluded.node_id,
        name = excluded.name,
        description = excluded.description,
        model_provider = excluded.model_provider,
        model_id = excluded.model_id,
        thinking_level = excluded.thinking_level,
        enabled_skills_json = excluded.enabled_skills_json,
        enabled_extensions_json = excluded.enabled_extensions_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      bot.id,
      bot.nodeId,
      bot.name,
      bot.description || '',
      bot.modelProvider,
      bot.modelId,
      bot.thinkingLevel ?? 'medium',
      JSON.stringify(bot.enabledSkills || []),
      JSON.stringify(bot.enabledExtensions || []),
      bot.updatedAt || new Date().toISOString()
    );
  }

  deleteBot(id: string): void {
    const stmt = this.db.prepare('DELETE FROM bots WHERE id = ?');
    stmt.run(id);
  }

  // --- Sessions ---
  createSession(input: {
    id: string;
    title: string;
    mode: SessionMode;
    leadBotId: string;
    memberBotIds: string[];
    ownerId: string;
    parallelRoundtable?: boolean;
  }): SessionRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, created_at, updated_at, owner_id, parallel_roundtable)
      VALUES (?, ?, ?, ?, ?, '{}', 'idle', NULL, ?, ?, ?, ?)
    `);
    const parallelRoundtable = input.parallelRoundtable ?? false;
    stmt.run(
      input.id,
      input.title,
      input.mode,
      input.leadBotId,
      JSON.stringify(input.memberBotIds),
      now,
      now,
      input.ownerId,
      parallelRoundtable ? 1 : 0
    );
    return {
      id: input.id,
      title: input.title,
      mode: input.mode,
      leadBotId: input.leadBotId,
      memberBotIds: input.memberBotIds,
      status: 'idle',
      activeBotId: undefined,
      createdAt: now,
      updatedAt: now,
      ...(parallelRoundtable ? { parallelRoundtable } : {}),
    };
  }

  getSession(id: string): (SessionRecord & { cursorMap: Record<string, number> }) | undefined {
    const stmt = this.db.prepare('SELECT id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, archived, pinned, parallel_roundtable, created_at, updated_at FROM sessions WHERE id = ?');
    const row = stmt.get(id) as {
      id: string;
      title: string;
      mode: string;
      lead_bot_id: string;
      member_bot_ids_json: string;
      cursor_map_json: string;
      status: string;
      active_bot_id: string | null;
      archived: number;
      pinned: number;
      parallel_roundtable: number;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      mode: row.mode as SessionMode,
      leadBotId: row.lead_bot_id,
      memberBotIds: JSON.parse(row.member_bot_ids_json || '[]'),
      cursorMap: JSON.parse(row.cursor_map_json || '{}'),
      status: row.status as SessionStatus,
      activeBotId: row.active_bot_id ?? undefined,
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
      parallelRoundtable: Boolean(row.parallel_roundtable),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAllSessions(ownerId: string): SessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT s.id, s.title, s.mode, s.lead_bot_id, s.member_bot_ids_json, s.status, s.active_bot_id, s.archived, s.pinned, s.parallel_roundtable, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
        (SELECT m.content FROM messages m WHERE m.session_id = s.id ORDER BY m.rowid DESC LIMIT 1) AS last_message_content,
        (SELECT m.created_at FROM messages m WHERE m.session_id = s.id ORDER BY m.rowid DESC LIMIT 1) AS last_message_at
      FROM sessions s
      WHERE s.owner_id = ?
      ORDER BY s.updated_at DESC
    `);
    const rows = stmt.all(ownerId) as {
      id: string;
      title: string;
      mode: string;
      lead_bot_id: string;
      member_bot_ids_json: string;
      status: string;
      active_bot_id: string | null;
      archived: number;
      pinned: number;
      parallel_roundtable: number;
      created_at: string;
      updated_at: string;
      message_count: number | bigint;
      last_message_content: string | null;
      last_message_at: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      mode: row.mode as SessionMode,
      leadBotId: row.lead_bot_id,
      memberBotIds: JSON.parse(row.member_bot_ids_json || '[]'),
      status: row.status as SessionStatus,
      activeBotId: row.active_bot_id ?? undefined,
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
      parallelRoundtable: Boolean(row.parallel_roundtable),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: Number(row.message_count),
      lastMessagePreview: buildPreview(row.last_message_content ?? ''),
      lastMessageAt: row.last_message_at ?? undefined,
    }));
  }

  /** 返回会话归属用户 id；会话不存在返回 undefined */
  getSessionOwner(sessionId: string): string | undefined {
    const stmt = this.db.prepare('SELECT owner_id FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId) as { owner_id: string | null } | undefined;
    return row?.owner_id ?? undefined;
  }

  deleteSession(id: string): boolean {
    return this.inTransaction(() => {
      const session = this.getSession(id);
      if (!session) return false;
      const deletePending = this.db.prepare('DELETE FROM session_resets_pending WHERE session_id = ?');
      deletePending.run(id);
      const deleteMessages = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
      deleteMessages.run(id);
      const deleteTriggers = this.db.prepare('DELETE FROM triggers WHERE session_id = ?');
      deleteTriggers.run(id);
      const deleteArtifacts = this.db.prepare('DELETE FROM artifacts WHERE session_id = ?');
      deleteArtifacts.run(id);
      const deleteSessionStmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      deleteSessionStmt.run(id);
      return true;
    });
  }

  clearSessionMessages(id: string): boolean {
    return this.inTransaction(() => {
      const session = this.getSession(id);
      if (!session) return false;
      const deleteMessages = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
      deleteMessages.run(id);
      this.resetCursorMap(id);
      return true;
    });
  }

  /** 将会话的 cursor_map_json 重置为 '{}'（各 bot 的增量游标全部归零） */
  resetSessionCursors(sessionId: string): void {
    this.resetCursorMap(sessionId);
  }

  private resetCursorMap(sessionId: string): void {
    const stmt = this.db.prepare("UPDATE sessions SET cursor_map_json = '{}' WHERE id = ?");
    stmt.run(sessionId);
  }

  /**
   * 会话分叉：以锚点消息为界复制出新会话（含锚点及其之前的全部消息）。
   * 只读源会话、只写新会话；新会话 cursor_map 为空，各 bot 首回合将全量重建上下文。
   * 源会话或锚点消息不存在（锚点必须属于源会话）时返回 undefined。
   */
  forkSession(sourceSessionId: string, anchorMessageId: string): SessionRecord | undefined {
    const source = this.getSession(sourceSessionId);
    if (!source) return undefined;
    const anchor = this.getMessages(sourceSessionId).find((m) => m.id === anchorMessageId);
    if (!anchor) return undefined;
    const anchorRowid = this.getMessageRowid(anchorMessageId);
    if (anchorRowid === undefined) return undefined;

    const ownerRow = this.db.prepare('SELECT owner_id FROM sessions WHERE id = ?').get(sourceSessionId) as
      | { owner_id: string | null }
      | undefined;
    // 分叉会话继承源会话归属（回填后 owner_id 恒非空，兜底 user_admin）
    const ownerId = ownerRow?.owner_id ?? 'user_admin';

    const now = new Date().toISOString();
    const newSessionId = `sess_${randomUUID()}`;
    const insertSession = this.db.prepare(`
      INSERT INTO sessions (id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, created_at, updated_at, owner_id, parallel_roundtable)
      VALUES (?, ?, ?, ?, ?, '{}', 'idle', NULL, ?, ?, ?, ?)
    `);

    const rows = this.db.prepare(`
      SELECT role, sender_bot_id, model_badge, content, mentions_json, tool_calls_json, usage_json, attachments_json, created_at
      FROM messages
      WHERE session_id = ? AND rowid <= ?
      ORDER BY rowid ASC
    `).all(sourceSessionId, anchorRowid) as {
      role: string;
      sender_bot_id: string | null;
      model_badge: string | null;
      content: string;
      mentions_json: string;
      tool_calls_json: string | null;
      usage_json: string | null;
      attachments_json: string | null;
      created_at: string;
    }[];
    // 逐行 INSERT（新 msg id、新 session_id），created_at 保留原值以保真时间线
    const insertMessage = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, sender_bot_id, model_badge, content, mentions_json, tool_calls_json, usage_json, attachments_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertArtifact = this.db.prepare(`
      INSERT INTO artifacts (id, session_id, filename, mime_type, size_bytes, sender_bot_id, storage_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const idMap = new Map<string, string>();

    return this.inTransaction(() => {
      insertSession.run(
        newSessionId,
        `${source.title}（分叉）`,
        source.mode,
        source.leadBotId,
        JSON.stringify(source.memberBotIds),
        now,
        now,
        ownerId,
        source.parallelRoundtable ? 1 : 0
      );

      for (const row of rows) {
        let attachmentsJson = row.attachments_json;
        const attachments = parseOptionalJson<MessageAttachment[]>(row.attachments_json);
        if (attachments && attachments.length > 0) {
          const rewrittenAttachments: MessageAttachment[] = [];
          for (const att of attachments) {
            let newArtId = idMap.get(att.id);
            if (!newArtId) {
              const oldArt = this.getArtifactWithStoragePath(att.id);
              if (oldArt) {
                const artSessionOwner = this.getSessionOwner(oldArt.sessionId);
                // 仅当产物所属会话 owner 与源会话 owner 一致时允许复制，防止跨用户克隆提权
                if (artSessionOwner && artSessionOwner === ownerId) {
                  newArtId = `art_${randomUUID()}`;
                  idMap.set(att.id, newArtId);
                  insertArtifact.run(
                    newArtId,
                    newSessionId,
                    oldArt.filename,
                    oldArt.mimeType,
                    oldArt.sizeBytes,
                    oldArt.senderBotId ?? null,
                    oldArt.storagePath,
                    oldArt.createdAt
                  );
                }
              }
            }
            if (newArtId) {
              rewrittenAttachments.push({
                ...att,
                id: newArtId,
                url: `/api/artifacts/${newArtId}/content`,
              });
            } else {
              rewrittenAttachments.push(att);
            }
          }
          attachmentsJson = JSON.stringify(rewrittenAttachments);
        }

        insertMessage.run(
          `msg_${randomUUID()}`,
          newSessionId,
          row.role,
          row.sender_bot_id,
          row.model_badge,
          row.content,
          row.mentions_json,
          row.tool_calls_json,
          row.usage_json,
          attachmentsJson,
          row.created_at
        );
      }

      return this.getAllSessions(ownerId).find((s) => s.id === newSessionId);
    });
  }

  updateSession(
    id: string,
    patch: {
      title?: string;
      mode?: SessionMode;
      leadBotId?: string;
      memberBotIds?: string[];
      status?: SessionStatus;
      activeBotId?: string;
      archived?: boolean;
      pinned?: boolean;
      parallelRoundtable?: boolean;
    }
  ): SessionRecord | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;
    const now = new Date().toISOString();
    const title = patch.title ?? session.title;
    const mode = patch.mode ?? session.mode;
    const leadBotId = patch.leadBotId ?? session.leadBotId;
    const memberBotIds = patch.memberBotIds ?? session.memberBotIds;
    const status = patch.status ?? session.status;
    const activeBotId = patch.activeBotId !== undefined ? patch.activeBotId : session.activeBotId;
    const archived = patch.archived ?? session.archived ?? false;
    const pinned = patch.pinned ?? session.pinned ?? false;
    const parallelRoundtable = patch.parallelRoundtable ?? session.parallelRoundtable ?? false;

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET title = ?, mode = ?, lead_bot_id = ?, member_bot_ids_json = ?, status = ?, active_bot_id = ?, archived = ?, pinned = ?, parallel_roundtable = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      title,
      mode,
      leadBotId,
      JSON.stringify(memberBotIds),
      status,
      activeBotId ?? null,
      archived ? 1 : 0,
      pinned ? 1 : 0,
      parallelRoundtable ? 1 : 0,
      now,
      id
    );

    return {
      id,
      title,
      mode,
      leadBotId,
      memberBotIds,
      status,
      activeBotId: activeBotId ?? undefined,
      archived,
      pinned,
      parallelRoundtable,
      createdAt: session.createdAt,
      updatedAt: now,
    };
  }

  updateSessionStatus(id: string, status: SessionStatus, activeBotId?: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET status = ?, active_bot_id = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, activeBotId ?? null, now, id);
  }

  updateSessionCursor(sessionId: string, botId: string, rowid: number): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    const cursorMap = { ...session.cursorMap, [botId]: rowid };
    const stmt = this.db.prepare('UPDATE sessions SET cursor_map_json = ? WHERE id = ?');
    stmt.run(JSON.stringify(cursorMap), sessionId);
  }

  // --- Messages ---
  createMessage(msg: {
    id: string;
    sessionId: string;
    role: MessageRole;
    senderBotId?: string;
    modelBadge?: string;
    content: string;
    mentions?: string[];
    toolCalls?: ToolCallRecord[];
    usage?: TurnUsage;
    attachments?: MessageAttachment[];
    createdAt?: string;
  }): IncrementalMessageResult {
    const now = msg.createdAt ?? new Date().toISOString();
    const toolCallsJson = msg.toolCalls ? JSON.stringify(msg.toolCalls) : null;
    const usageJson = msg.usage ? JSON.stringify(msg.usage) : null;
    const attachmentsJson = msg.attachments ? JSON.stringify(msg.attachments) : null;
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, sender_bot_id, model_badge, content, mentions_json, tool_calls_json, usage_json, attachments_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      msg.id,
      msg.sessionId,
      msg.role,
      msg.senderBotId ?? null,
      msg.modelBadge ?? null,
      msg.content,
      JSON.stringify(msg.mentions || []),
      toolCallsJson,
      usageJson,
      attachmentsJson,
      now
    );
    const rowid = Number(result.lastInsertRowid);
    const touchSession = this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    touchSession.run(now, msg.sessionId);
    return {
      rowid,
      message: {
        id: msg.id,
        sessionId: msg.sessionId,
        role: msg.role,
        senderBotId: msg.senderBotId ?? undefined,
        modelBadge: msg.modelBadge ?? undefined,
        content: msg.content,
        mentions: msg.mentions || [],
        ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
        ...(msg.usage ? { usage: msg.usage } : {}),
        ...(msg.attachments ? { attachments: msg.attachments } : {}),
        createdAt: now,
      },
    };
  }

  getMessages(sessionId: string): MessageRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, session_id, role, sender_bot_id, model_badge, content, mentions_json, tool_calls_json, usage_json, attachments_json, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY rowid ASC
    `);
    const rows = stmt.all(sessionId) as MessageRow[];
    return rows.map(mapMessageRow);
  }

  /**
   * 分页读取会话消息：
   * - beforeRowid：取 rowid 严格小于该值的最新 limit 条（升序返回），hasMore 表示是否还有更早消息
   * - aroundRowid：窗口 [rowid-15, rowid+45]（升序返回），hasMore 表示窗口外是否还有更早消息；优先于 beforeRowid
   * - limit 默认 60，上限 200
   */
  getMessagesPage(
    sessionId: string,
    opts: { beforeRowid?: number; aroundRowid?: number; limit?: number }
  ): { messages: MessageRecord[]; hasMore: boolean } {
    const limit = opts.limit && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 200) : 60;
    const columns = 'rowid, id, session_id, role, sender_bot_id, model_badge, content, mentions_json, tool_calls_json, usage_json, attachments_json, created_at';

    if (opts.aroundRowid !== undefined) {
      const around = Math.floor(opts.aroundRowid);
      const lower = around - 15;
      const upper = around + 45;
      const rows = this.db.prepare(`
        SELECT ${columns}
        FROM messages
        WHERE session_id = ? AND rowid >= ? AND rowid <= ?
        ORDER BY rowid ASC
      `).all(sessionId, lower, upper) as (MessageRow & { rowid: number | bigint })[];
      const hasMore = this.db
        .prepare('SELECT 1 FROM messages WHERE session_id = ? AND rowid < ? LIMIT 1')
        .get(sessionId, lower) !== undefined;
      return { messages: rows.map(row => mapMessageRow(row)), hasMore };
    }

    if (opts.beforeRowid !== undefined) {
      const before = Math.floor(opts.beforeRowid);
      const rows = this.db.prepare(`
        SELECT ${columns}
        FROM messages
        WHERE session_id = ? AND rowid < ?
        ORDER BY rowid DESC
        LIMIT ?
      `).all(sessionId, before, limit) as (MessageRow & { rowid: number | bigint })[];
      const oldestRowid = rows.length > 0 ? Number(rows[rows.length - 1].rowid) : undefined;
      const hasMore = oldestRowid !== undefined
        ? this.db.prepare('SELECT 1 FROM messages WHERE session_id = ? AND rowid < ? LIMIT 1').get(sessionId, oldestRowid) !== undefined
        : false;
      return { messages: rows.reverse().map(row => mapMessageRow(row)), hasMore };
    }

    const rows = this.db.prepare(`
      SELECT ${columns}
      FROM messages
      WHERE session_id = ?
      ORDER BY rowid DESC
      LIMIT ?
    `).all(sessionId, limit) as (MessageRow & { rowid: number | bigint })[];
    const oldestRowid = rows.length > 0 ? Number(rows[rows.length - 1].rowid) : undefined;
    const hasMore = oldestRowid !== undefined
      ? this.db.prepare('SELECT 1 FROM messages WHERE session_id = ? AND rowid < ? LIMIT 1').get(sessionId, oldestRowid) !== undefined
      : false;
    return { messages: rows.reverse().map(row => mapMessageRow(row)), hasMore };
  }

  getIncrementalMessages(sessionId: string, afterRowid: number): IncrementalMessageResult[] {
    const stmt = this.db.prepare(`
      SELECT rowid, id, session_id, role, sender_bot_id, model_badge, content, mentions_json, tool_calls_json, usage_json, attachments_json, created_at
      FROM messages
      WHERE session_id = ? AND rowid > ?
      ORDER BY rowid ASC
    `);
    const rows = stmt.all(sessionId, afterRowid) as (MessageRow & { rowid: number | bigint })[];
    return rows.map((row) => ({
      rowid: Number(row.rowid),
      message: mapMessageRow(row),
    }));
  }

  getMaxMessageRowid(sessionId: string): number {
    const stmt = this.db.prepare('SELECT MAX(rowid) as max_rowid FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as { max_rowid: number | bigint | null } | undefined;
    return row && row.max_rowid ? Number(row.max_rowid) : 0;
  }

  /** 更新消息内容与 mentions；消息不存在时返回 undefined */
  updateMessageContent(messageId: string, content: string, mentions: string[]): MessageRecord | undefined {
    const row = this.getMessageById(messageId);
    if (!row) return undefined;
    const update = this.db.prepare('UPDATE messages SET content = ?, mentions_json = ? WHERE id = ?');
    update.run(content, JSON.stringify(mentions), messageId);
    return { ...row.message, content, mentions };
  }

  /** 删除会话内 rowid 大于给定值（不含等于）的消息，返回删除条数 */
  deleteMessagesAfter(sessionId: string, rowid: number): number {
    return this.inTransaction(() => {
      const stmt = this.db.prepare('DELETE FROM messages WHERE session_id = ? AND rowid > ?');
      const result = stmt.run(sessionId, rowid);
      return Number(result.changes);
    });
  }

  getMessageRowid(messageId: string): number | undefined {
    const stmt = this.db.prepare('SELECT rowid FROM messages WHERE id = ?');
    const row = stmt.get(messageId) as { rowid: number | bigint } | undefined;
    return row ? Number(row.rowid) : undefined;
  }

  getMessageById(messageId: string): { rowid: number; message: MessageRecord } | undefined {
    const stmt = this.db.prepare(`
      SELECT rowid, id, session_id, role, sender_bot_id, model_badge, content, mentions_json, tool_calls_json, usage_json, attachments_json, created_at
      FROM messages
      WHERE id = ?
    `);
    const row = stmt.get(messageId) as (MessageRow & { rowid: number | bigint }) | undefined;
    if (!row) return undefined;
    return {
      rowid: Number(row.rowid),
      message: mapMessageRow(row),
    };
  }

  /** 跨会话消息全文检索（大小写不敏感的 LIKE 匹配，按 rowid 倒序返回最新优先） */
  searchMessages(
    ownerId: string,
    query: string,
    options?: { sessionId?: string; limit?: number }
  ): MessageSearchHit[] {
    if (!query || !query.trim()) return [];
    const limit = options?.limit && options.limit > 0 ? Math.min(Math.floor(options.limit), 100) : 30;
    const escaped = query.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const params: (string | number)[] = [ownerId];
    let sql = `
      SELECT m.id, m.session_id, m.role, m.sender_bot_id, m.model_badge, m.content, m.mentions_json, m.tool_calls_json, m.usage_json, m.attachments_json, m.created_at,
        s.title AS session_title, s.mode AS session_mode, s.archived AS session_archived
      FROM messages m JOIN sessions s ON m.session_id = s.id
      WHERE s.owner_id = ?
    `;
    if (options?.sessionId) {
      sql += ' AND m.session_id = ?';
      params.push(options.sessionId);
    }
    sql += ` AND LOWER(m.content) LIKE LOWER(?) ESCAPE '\\' ORDER BY m.rowid DESC LIMIT ?`;
    params.push(pattern, limit);
    const rows = this.db.prepare(sql).all(...params) as (MessageRow & {
      session_title: string;
      session_mode: string;
      session_archived: number;
    })[];
    return rows.map((row) => ({
      message: mapMessageRow(row),
      sessionTitle: row.session_title,
      sessionMode: row.session_mode as SessionMode,
      sessionArchived: Boolean(row.session_archived),
    }));
  }

  // --- Artifacts ---
  listArtifactStoragePaths(target: { sessionId: string } | { ownerId: string }): string[] {
    const rows = 'sessionId' in target
      ? this.db.prepare('SELECT DISTINCT storage_path FROM artifacts WHERE session_id = ?')
        .all(target.sessionId)
      : this.db.prepare(`
          SELECT DISTINCT a.storage_path FROM artifacts a
          JOIN sessions s ON s.id = a.session_id WHERE s.owner_id = ?
        `).all(target.ownerId);
    return (rows as { storage_path: string }[]).map((row) => row.storage_path);
  }

  isArtifactStoragePathReferenced(storagePath: string): boolean {
    return this.db.prepare('SELECT 1 FROM artifacts WHERE storage_path = ? LIMIT 1').get(storagePath) !== undefined;
  }

  createArtifact(input: {
    id: string;
    sessionId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    senderBotId?: string;
    storagePath: string;
  }): ArtifactRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO artifacts (id, session_id, filename, mime_type, size_bytes, sender_bot_id, storage_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      input.id,
      input.sessionId,
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.senderBotId ?? null,
      input.storagePath,
      now
    );
    const record: ArtifactRecord = {
      id: input.id,
      sessionId: input.sessionId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      ...(input.senderBotId ? { senderBotId: input.senderBotId } : {}),
      createdAt: now,
    };
    return record;
  }

  getArtifactWithStoragePath(id: string): (ArtifactRecord & { storagePath: string }) | undefined {
    const stmt = this.db.prepare(`
      SELECT ${ARTIFACT_COLUMNS}, storage_path
      FROM artifacts
      WHERE id = ?
    `);
    const row = stmt.get(id) as (ArtifactRow & { storage_path: string }) | undefined;
    if (!row) return undefined;
    return { ...mapArtifactRow(row), storagePath: row.storage_path };
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT ${ARTIFACT_COLUMNS}
      FROM artifacts
      WHERE id = ?
    `);
    const row = stmt.get(id) as ArtifactRow | undefined;
    return row ? mapArtifactRow(row) : undefined;
  }

  listSessionArtifacts(sessionId: string): ArtifactRecord[] {
    const stmt = this.db.prepare(`
      SELECT ${ARTIFACT_COLUMNS}
      FROM artifacts
      WHERE session_id = ?
      ORDER BY created_at ASC, rowid ASC
    `);
    const rows = stmt.all(sessionId) as ArtifactRow[];
    return rows.map(mapArtifactRow);
  }

  // --- Triggers ---
  createTrigger(input: {
    id: string;
    sessionId: string;
    botId: string;
    ownerId: string;
    name: string;
    kind: TriggerKind;
    token?: string;
    cronExpr?: string;
    runAt?: string;
    prompt: string;
    enabled?: boolean;
  }): TriggerRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO triggers (id, session_id, bot_id, owner_id, name, kind, token, cron_expr, run_at, prompt, enabled, last_triggered_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    const enabled = input.enabled ?? true;
    stmt.run(
      input.id,
      input.sessionId,
      input.botId,
      input.ownerId,
      input.name,
      input.kind,
      input.token ?? null,
      input.cronExpr ?? null,
      input.runAt ?? null,
      input.prompt,
      enabled ? 1 : 0,
      now
    );
    return {
      id: input.id,
      sessionId: input.sessionId,
      botId: input.botId,
      name: input.name,
      kind: input.kind,
      ...(input.token ? { token: input.token } : {}),
      ...(input.cronExpr !== undefined ? { cronExpr: input.cronExpr } : {}),
      ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
      prompt: input.prompt,
      enabled,
      createdAt: now,
    };
  }

  getTrigger(id: string): (TriggerRecord & { ownerId: string }) | undefined {
    const stmt = this.db.prepare(`
      SELECT ${TRIGGER_COLUMNS}
      FROM triggers
      WHERE id = ?
    `);
    const row = stmt.get(id) as TriggerRow | undefined;
    return row ? { ...mapTriggerRow(row), ownerId: row.owner_id } : undefined;
  }

  getTriggerByToken(token: string): (TriggerRecord & { ownerId: string }) | undefined {
    const stmt = this.db.prepare(`
      SELECT ${TRIGGER_COLUMNS}
      FROM triggers
      WHERE token = ?
    `);
    const row = stmt.get(token) as TriggerRow | undefined;
    return row ? { ...mapTriggerRow(row), ownerId: row.owner_id } : undefined;
  }

  listSessionTriggers(sessionId: string): TriggerRecord[] {
    const stmt = this.db.prepare(`
      SELECT ${TRIGGER_COLUMNS}
      FROM triggers
      WHERE session_id = ?
      ORDER BY created_at ASC, rowid ASC
    `);
    const rows = stmt.all(sessionId) as TriggerRow[];
    return rows.map(mapTriggerRow);
  }

  listAllEnabledScheduledTriggers(): (TriggerRecord & { ownerId: string })[] {
    const stmt = this.db.prepare(`
      SELECT ${TRIGGER_COLUMNS}
      FROM triggers
      WHERE enabled = 1 AND kind IN ('cron', 'once')
    `);
    const rows = stmt.all() as TriggerRow[];
    return rows.map((row) => ({ ...mapTriggerRow(row), ownerId: row.owner_id }));
  }

  updateTrigger(
    id: string,
    patch: {
      enabled?: boolean;
      name?: string;
      prompt?: string;
      cronExpr?: string;
      runAt?: string;
    }
  ): TriggerRecord | undefined {
    const existing = this.getTrigger(id);
    if (!existing) return undefined;
    const next: TriggerRecord & { ownerId: string } = {
      ...existing,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.cronExpr !== undefined ? { cronExpr: patch.cronExpr } : {}),
      ...(patch.runAt !== undefined ? { runAt: patch.runAt } : {}),
    };
    const stmt = this.db.prepare(`
      UPDATE triggers
      SET enabled = ?, name = ?, prompt = ?, cron_expr = ?, run_at = ?
      WHERE id = ?
    `);
    stmt.run(
      next.enabled ? 1 : 0,
      next.name,
      next.prompt,
      next.cronExpr ?? null,
      next.runAt ?? null,
      id
    );
    return next;
  }

  markTriggerFired(id: string, firedAt?: string): void {
    const fired = firedAt ?? new Date().toISOString();
    const stmt = this.db.prepare('UPDATE triggers SET last_triggered_at = ? WHERE id = ?');
    stmt.run(fired, id);
  }

  deleteTrigger(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM triggers WHERE id = ?');
    const result = stmt.run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore if already closed
    }
  }
}
