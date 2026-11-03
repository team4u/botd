import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ArtifactRecord,
  AskPreviewType,
  AutomationEventRecord,
  BotConfig,
  MessageAttachment,
  MessageRecord,
  MessageRole,
  MessageSearchHit,
  NodeRecord,
  NodeWithBots,
  OutboundTaskRecord,
  OutboundTaskStatus,
  PendingAskRecord,
  PlatformType,
  ResourceVisibility,
  SessionMode,
  SessionParticipantRecord,
  SessionRecord,
  SessionStatus,
  SubagentColor,
  SubagentIsolation,
  SubagentRunRecord,
  SubagentToolScope,
  ThinkingLevel,
  ToolCallRecord,
  TurnBlock,
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

export const HUB_SCHEMA_VERSION = 4;

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
  sender_user_id: string | null;
  sender_username: string | null;
  model_badge: string | null;
  content: string;
  mentions_json: string;
  subagent_runs_json?: string | null;
  tool_calls_json: string | null;
  blocks_json?: string | null;
  usage_json: string | null;
  attachments_json: string | null;
  aborted?: number | null;
  created_at: string;
};

const mapMessageRow = (row: MessageRow): MessageRecord => {
  const toolCalls = parseOptionalJson<ToolCallRecord[]>(row.tool_calls_json);
  const blocks = parseOptionalJson<TurnBlock[]>(row.blocks_json);
  const usage = parseOptionalJson<TurnUsage>(row.usage_json);
  const attachments = parseOptionalJson<MessageAttachment[]>(row.attachments_json);
  const subagentRuns = parseOptionalJson<SubagentRunRecord[]>(row.subagent_runs_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    senderBotId: row.sender_bot_id ?? undefined,
    ...(row.sender_user_id ? { senderUserId: row.sender_user_id } : {}),
    ...(row.sender_username ? { senderUsername: row.sender_username } : {}),
    modelBadge: row.model_badge ?? undefined,
    content: row.content,
    mentions: parseOptionalJson<string[]>(row.mentions_json) ?? [],
    ...(subagentRuns && subagentRuns.length > 0 ? { subagentRuns } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(blocks && blocks.length > 0 ? { blocks } : {}),
    ...(usage ? { usage } : {}),
    ...(attachments ? { attachments } : {}),
    ...(row.aborted ? { aborted: true } : {}),
    createdAt: row.created_at,
  };
};

const MESSAGE_SELECT_COLUMNS =
  'id, session_id, role, sender_bot_id, sender_user_id, sender_username, model_badge, content, mentions_json, subagent_runs_json, tool_calls_json, blocks_json, usage_json, attachments_json, aborted, created_at';

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
  'id, session_id, bot_id, owner_id, name, kind, token, secret, cron_expr, run_at, prompt, enabled, dispatch_mode, skill_id, event_filter_json, last_triggered_at, created_at';

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
  visibility?: string | null;
};

const mapNodeRow = (row: NodeRow): NodeRecord => ({
  id: row.id,
  name: row.name,
  platform: row.platform as PlatformType,
  skills: parseOptionalJson<string[]>(row.skills_json) ?? [],
  extensions: parseOptionalJson<string[]>(row.extensions_json) ?? [],
  status: row.status as 'online' | 'offline',
  visibility: (row.visibility === 'team' ? 'team' : 'private') as ResourceVisibility,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  ...(typeof row.pid === 'number' ? { pid: row.pid } : {}),
  ...(typeof row.started_at === 'string' && row.started_at.length > 0 ? { startedAt: row.started_at } : {}),
  ...(row.version != null ? { version: row.version } : {}),
});

type NodeRowWithOwner = NodeRow & { owner_id: string | null; owner_name: string | null };

const NODE_WITH_OWNER_COLUMNS =
  'n.id, n.name, n.platform, n.skills_json, n.extensions_json, n.status, n.visibility, n.last_seen_at, n.created_at, n.pid, n.started_at, n.version, n.owner_id, u.username AS owner_name';

function mapNodeRowWithOwner(row: NodeRowWithOwner, currentUserId?: string): NodeRecord {
  return {
    ...mapNodeRow(row),
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.owner_name ? { ownerName: row.owner_name } : {}),
    ...(currentUserId !== undefined && row.owner_id !== currentUserId ? { isTeamShared: true } : {}),
  };
}

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
  visibility?: string | null;
  updated_at: string;
  parent_bot_id?: string | null;
  inherit_model?: number | null;
  inherit_skills?: number | null;
  color?: string | null;
  tool_scope?: string | null;
  custom_tools_json?: string | null;
  isolation?: string | null;
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
  visibility: (row.visibility === 'team' ? 'team' : 'private') as ResourceVisibility,
  updatedAt: row.updated_at,
  ...(row.parent_bot_id ? { parentBotId: row.parent_bot_id } : {}),
  ...(row.inherit_model !== undefined && row.inherit_model !== null ? { inheritModel: Boolean(row.inherit_model) } : {}),
  ...(row.inherit_skills !== undefined && row.inherit_skills !== null ? { inheritSkills: Boolean(row.inherit_skills) } : {}),
  ...(row.color ? { color: row.color as SubagentColor } : {}),
  ...(row.tool_scope ? { toolScope: row.tool_scope as SubagentToolScope } : {}),
  ...(row.custom_tools_json ? { customTools: parseOptionalJson<string[]>(row.custom_tools_json) } : {}),
  ...(row.isolation ? { isolation: row.isolation as SubagentIsolation } : {}),
});

type BotRowWithOwner = BotRow & { owner_id: string | null; owner_name: string | null };

const BOT_WITH_OWNER_COLUMNS =
  'b.id, b.node_id, b.name, b.description, b.model_provider, b.model_id, b.thinking_level, b.enabled_skills_json, b.enabled_extensions_json, b.visibility, b.updated_at, b.parent_bot_id, b.inherit_model, b.inherit_skills, b.color, b.tool_scope, b.custom_tools_json, b.isolation, n.owner_id, u.username AS owner_name';

function mapBotRowWithOwner(row: BotRowWithOwner, currentUserId?: string): BotConfig {
  return {
    ...mapBotRow(row),
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.owner_name ? { ownerName: row.owner_name } : {}),
    ...(currentUserId !== undefined ? { isTeamShared: row.owner_id !== currentUserId } : {}),
  };
}

type TriggerRow = {
  id: string;
  session_id: string;
  bot_id: string;
  owner_id: string;
  name: string;
  kind: string;
  token: string | null;
  secret: string | null;
  cron_expr: string | null;
  run_at: string | null;
  prompt: string;
  enabled: number;
  dispatch_mode: string | null;
  skill_id: string | null;
  event_filter_json: string | null;
  last_triggered_at: string | null;
  created_at: string;
};

const mapTriggerRow = (row: TriggerRow): TriggerRecord => {
  const eventFilter = parseOptionalJson<NonNullable<TriggerRecord['eventFilter']>>(row.event_filter_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    botId: row.bot_id,
    name: row.name,
    kind: row.kind as TriggerKind,
    ...(row.token ? { token: row.token } : {}),
    ...(row.secret ? { secret: row.secret } : {}),
    ...(row.cron_expr ? { cronExpr: row.cron_expr } : {}),
    ...(row.run_at ? { runAt: row.run_at } : {}),
    prompt: row.prompt,
    enabled: Boolean(row.enabled),
    ...(row.dispatch_mode && row.dispatch_mode !== 'append' ? { dispatchMode: row.dispatch_mode as TriggerRecord['dispatchMode'] } : {}),
    ...(row.skill_id ? { skillId: row.skill_id } : {}),
    ...(eventFilter ? { eventFilter } : {}),
    ...(row.last_triggered_at ? { lastTriggeredAt: row.last_triggered_at } : {}),
    createdAt: row.created_at,
  };
};

const AUTOMATION_EVENT_COLUMNS =
  'id, trigger_id, session_id, child_session_id, source, event_type, dedup_key, summary, payload_artifact_id, created_at';

type AutomationEventRow = {
  id: string;
  trigger_id: string;
  session_id: string;
  child_session_id: string | null;
  source: string;
  event_type: string;
  dedup_key: string | null;
  summary: string;
  payload_artifact_id: string | null;
  created_at: string;
};

const mapAutomationEventRow = (row: AutomationEventRow): AutomationEventRecord => ({
  id: row.id,
  triggerId: row.trigger_id,
  sessionId: row.session_id,
  ...(row.child_session_id ? { childSessionId: row.child_session_id } : {}),
  source: row.source,
  eventType: row.event_type,
  ...(row.dedup_key ? { dedupKey: row.dedup_key } : {}),
  summary: row.summary,
  ...(row.payload_artifact_id ? { payloadArtifactId: row.payload_artifact_id } : {}),
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
        token_epoch INTEGER NOT NULL DEFAULT 0,
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
        visibility TEXT NOT NULL DEFAULT 'private',
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
        visibility TEXT NOT NULL DEFAULT 'private',
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
        parent_session_id TEXT,
        parent_notified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        sender_bot_id TEXT,
        sender_user_id TEXT,
        sender_username TEXT,
        model_badge TEXT,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT,
        blocks_json TEXT,
        usage_json TEXT,
        attachments_json TEXT,
        aborted INTEGER NOT NULL DEFAULT 0,
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
        secret TEXT,
        cron_expr TEXT,
        run_at TEXT,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_triggered_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_triggers_session ON triggers(session_id);

      CREATE TABLE IF NOT EXISTS automation_events (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        child_session_id TEXT,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        dedup_key TEXT,
        summary TEXT NOT NULL,
        payload_artifact_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_events_session ON automation_events(session_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_events_dedup ON automation_events(trigger_id, dedup_key) WHERE dedup_key IS NOT NULL;

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

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_asks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        answer TEXT,
        preview_type TEXT,
        preview_content TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_asks_session ON pending_asks(session_id, status);

      CREATE TABLE IF NOT EXISTS outbound_task_queue (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued_offline',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_task_queue_node ON outbound_task_queue(node_id, status);

      CREATE TABLE IF NOT EXISTS session_participants (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at TEXT NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_participants_user ON session_participants(user_id);
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
      `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE messages ADD COLUMN tool_calls_json TEXT`,
      `ALTER TABLE messages ADD COLUMN usage_json TEXT`,
      `ALTER TABLE messages ADD COLUMN attachments_json TEXT`,
      `ALTER TABLE triggers ADD COLUMN run_at TEXT`,
      `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`,
      `ALTER TABLE nodes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`,
      `ALTER TABLE bots ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`,
      `ALTER TABLE pending_asks ADD COLUMN preview_type TEXT`,
      `ALTER TABLE pending_asks ADD COLUMN preview_content TEXT`,
      `ALTER TABLE messages ADD COLUMN sender_user_id TEXT`,
      `ALTER TABLE messages ADD COLUMN sender_username TEXT`,
      `ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE bots ADD COLUMN parent_bot_id TEXT`,
      `ALTER TABLE bots ADD COLUMN inherit_model INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE bots ADD COLUMN inherit_skills INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE bots ADD COLUMN color TEXT`,
      `ALTER TABLE bots ADD COLUMN tool_scope TEXT`,
      `ALTER TABLE bots ADD COLUMN custom_tools_json TEXT`,
      `ALTER TABLE bots ADD COLUMN isolation TEXT`,
      `ALTER TABLE sessions ADD COLUMN member_roles_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE sessions ADD COLUMN blackboard TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE messages ADD COLUMN whisper_target_bot_ids_json TEXT`,
      `ALTER TABLE messages ADD COLUMN orchestration_plan TEXT`,
      `ALTER TABLE messages ADD COLUMN subagent_runs_json TEXT`,
      `ALTER TABLE messages ADD COLUMN blocks_json TEXT`,
      `ALTER TABLE messages ADD COLUMN aborted INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE triggers ADD COLUMN dispatch_mode TEXT NOT NULL DEFAULT 'append'`,
      `ALTER TABLE triggers ADD COLUMN skill_id TEXT`,
      `ALTER TABLE triggers ADD COLUMN event_filter_json TEXT`,
      `ALTER TABLE triggers ADD COLUMN secret TEXT`,
      `ALTER TABLE sessions ADD COLUMN parent_notified INTEGER NOT NULL DEFAULT 0`,
    ];

    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch (err: any) {
        // 仅忽略幂等迁移的正常冲突（列已存在）；其余错误必须终止启动，防止带隐患运行
        if (!String(err?.message || '').includes('duplicate column name')) {
          throw err;
        }
      }
    }

    // 自举管理员固定 id 为 user_admin：存量 nodes/sessions 归属回填
    this.db.exec(`UPDATE nodes SET owner_id = 'user_admin' WHERE owner_id IS NULL`);
    this.db.exec(`UPDATE sessions SET owner_id = 'user_admin' WHERE owner_id IS NULL`);

    // 全部建表/迁移/回填成功后才提升 schema 版本号
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

  // --- Settings ---
  getSetting<T = unknown>(key: string): T | undefined {
    const stmt = this.db.prepare('SELECT value_json FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    return parseOptionalJson<T>(row.value_json);
  }

  setSetting(key: string, value: unknown): void {
    const now = new Date().toISOString();
    const valueJson = JSON.stringify(value);
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    stmt.run(key, valueJson, now);
  }

  // --- Pending Asks ---
  savePendingAsk(ask: PendingAskRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO pending_asks (id, session_id, bot_id, prompt, options_json, status, answer, preview_type, preview_content, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        bot_id = excluded.bot_id,
        prompt = excluded.prompt,
        options_json = excluded.options_json,
        status = excluded.status,
        answer = excluded.answer,
        preview_type = excluded.preview_type,
        preview_content = excluded.preview_content,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `);
    stmt.run(
      ask.id,
      ask.sessionId,
      ask.botId,
      ask.prompt,
      JSON.stringify(ask.options ?? []),
      ask.status,
      ask.answer ?? null,
      ask.previewType ?? null,
      ask.previewContent ?? null,
      ask.createdAt,
      ask.expiresAt ?? null
    );
  }

  updatePendingAskStatus(askId: string, status: 'pending' | 'answered' | 'expired', answer?: string): void {
    if (answer !== undefined) {
      const stmt = this.db.prepare('UPDATE pending_asks SET status = ?, answer = ? WHERE id = ?');
      stmt.run(status, answer, askId);
    } else {
      const stmt = this.db.prepare('UPDATE pending_asks SET status = ? WHERE id = ?');
      stmt.run(status, askId);
    }
  }

  getPendingAsksForSession(sessionId: string): PendingAskRecord[] {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE pending_asks
      SET status = 'expired'
      WHERE session_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(sessionId, now);

    const stmt = this.db.prepare(`
      SELECT id, session_id, bot_id, prompt, options_json, status, answer, preview_type, preview_content, created_at, expires_at
      FROM pending_asks
      WHERE session_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(sessionId) as {
      id: string;
      session_id: string;
      bot_id: string;
      prompt: string;
      options_json: string;
      status: string;
      answer: string | null;
      preview_type: string | null;
      preview_content: string | null;
      created_at: string;
      expires_at: string | null;
    }[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      botId: row.bot_id,
      prompt: row.prompt,
      options: parseOptionalJson<string[]>(row.options_json) ?? [],
      status: row.status as 'pending' | 'answered' | 'expired',
      ...(row.answer !== null && row.answer !== undefined ? { answer: row.answer } : {}),
      ...(row.preview_type ? { previewType: row.preview_type as AskPreviewType } : {}),
      ...(row.preview_content ? { previewContent: row.preview_content } : {}),
      createdAt: row.created_at,
      ...(row.expires_at !== null && row.expires_at !== undefined ? { expiresAt: row.expires_at } : {}),
    }));
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

  /** 用户当前 token epoch：用于改密后让旧 token 失效；用户不存在返回 undefined */
  getUserTokenEpoch(id: string): number | undefined {
    const row = this.db.prepare('SELECT token_epoch FROM users WHERE id = ?').get(id) as
      | { token_epoch: number | bigint }
      | undefined;
    return row === undefined ? undefined : Number(row.token_epoch);
  }

  getUserByUsername(username: string): UserRecord | undefined {
    const stmt = this.db.prepare('SELECT id, username, role, created_at FROM users WHERE username = ?');
    const row = stmt.get(username) as {
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
    // 改密后旧 token 必须全部失效：同事务内更新哈希并递增 token epoch
    this.inTransaction(() => {
      const stmt = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
      stmt.run(passwordHash, id);
      this.db.prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?').run(id);
    });
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
        this.db.prepare(`DELETE FROM automation_events WHERE session_id IN (${placeholders})`).run(...sessionIds);
        this.db.prepare(`DELETE FROM artifacts WHERE session_id IN (${placeholders})`).run(...sessionIds);
        this.db.prepare(`DELETE FROM pending_asks WHERE session_id IN (${placeholders})`).run(...sessionIds);
        this.db.prepare(`DELETE FROM session_participants WHERE session_id IN (${placeholders})`).run(...sessionIds);
        this.db.prepare(`DELETE FROM outbound_task_queue WHERE session_id IN (${placeholders})`).run(...sessionIds);
      }
      this.db.prepare('DELETE FROM session_participants WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE owner_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
  }

  // --- Nodes ---
  createNode(data: {
    id: string;
    name: string;
    platform: PlatformType;
    tokenHash: string;
    ownerId: string;
    pid?: number;
    startedAt?: string;
    visibility?: ResourceVisibility;
  }): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, platform, token_hash, skills_json, extensions_json, status, visibility, last_seen_at, created_at, pid, started_at, owner_id)
      VALUES (?, ?, ?, ?, '[]', '[]', 'offline', ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(data.id, data.name, data.platform, data.tokenHash, data.visibility ?? 'private', now, now, data.pid ?? null, data.startedAt ?? null, data.ownerId);
  }

  /** 返回节点归属用户 id；节点不存在返回 undefined */
  getNodeOwner(nodeId: string): string | undefined {
    const stmt = this.db.prepare('SELECT owner_id FROM nodes WHERE id = ?');
    const row = stmt.get(nodeId) as { owner_id: string | null } | undefined;
    return row?.owner_id ?? undefined;
  }

  getNode(id: string): NodeRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT ${NODE_WITH_OWNER_COLUMNS}
      FROM nodes n
      LEFT JOIN users u ON u.id = n.owner_id
      WHERE n.id = ?
    `);
    const row = stmt.get(id) as NodeRowWithOwner | undefined;
    if (!row) return undefined;
    return mapNodeRowWithOwner(row);
  }

  getNodeWithSecret(id: string): (NodeRecord & { tokenHash: string }) | undefined {
    const stmt = this.db.prepare(`
      SELECT n.token_hash, ${NODE_WITH_OWNER_COLUMNS}
      FROM nodes n
      LEFT JOIN users u ON u.id = n.owner_id
      WHERE n.id = ?
    `);
    const row = stmt.get(id) as (NodeRowWithOwner & { token_hash: string }) | undefined;
    if (!row) return undefined;
    return {
      ...mapNodeRowWithOwner(row),
      tokenHash: row.token_hash,
    };
  }

  getAllNodesWithBots(ownerId: string): NodeWithBots[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT ${NODE_WITH_OWNER_COLUMNS}
      FROM nodes n
      LEFT JOIN users u ON u.id = n.owner_id
      LEFT JOIN bots b ON b.node_id = n.id
      WHERE n.owner_id = ? OR n.visibility = 'team' OR b.visibility = 'team'
      ORDER BY n.created_at ASC
    `);
    const rows = stmt.all(ownerId) as NodeRowWithOwner[];
    return rows.map((row) => {
      const isTeamShared = row.owner_id !== ownerId;
      const allBots = this.getBotsForNode(row.id);
      const bots = isTeamShared
        ? allBots.filter((b) => b.visibility === 'team' || row.visibility === 'team').map((b) => ({
            ...b,
            isTeamShared: true,
            ownerId: row.owner_id ?? undefined,
            ownerName: row.owner_name ?? undefined,
          }))
        : allBots;
      return {
        ...mapNodeRowWithOwner(row, ownerId),
        bots,
      };
    });
  }

  /** 仅按归属查节点（不含团队可见）：用于删除用户前的归属校验，避免团队共享资源阻断删除 */
  countNodesOwnedBy(ownerId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE owner_id = ?');
    const row = stmt.get(ownerId) as { count: number | bigint };
    return Number(row.count);
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
    const stmt = this.db.prepare(`
      SELECT ${BOT_WITH_OWNER_COLUMNS}
      FROM bots b
      LEFT JOIN nodes n ON n.id = b.node_id
      LEFT JOIN users u ON u.id = n.owner_id
      WHERE b.id = ?
    `);
    const row = stmt.get(id) as BotRowWithOwner | undefined;
    if (!row) return undefined;
    return mapBotRowWithOwner(row);
  }

  getBotsForNode(nodeId: string): BotConfig[] {
    const stmt = this.db.prepare(`
      SELECT ${BOT_WITH_OWNER_COLUMNS}
      FROM bots b
      LEFT JOIN nodes n ON n.id = b.node_id
      LEFT JOIN users u ON u.id = n.owner_id
      WHERE b.node_id = ?
      ORDER BY b.id ASC
    `);
    const rows = stmt.all(nodeId) as BotRowWithOwner[];
    return rows.map((row) => mapBotRowWithOwner(row));
  }

  getAllBots(ownerId?: string): BotConfig[] {
    if (ownerId) {
      const stmt = this.db.prepare(`
        SELECT ${BOT_WITH_OWNER_COLUMNS}
        FROM bots b
        JOIN nodes n ON n.id = b.node_id
        LEFT JOIN users u ON u.id = n.owner_id
        WHERE n.owner_id = ?
        ORDER BY b.id ASC
      `);
      const rows = stmt.all(ownerId) as BotRowWithOwner[];
      return rows.map((row) => mapBotRowWithOwner(row));
    }
    const stmt = this.db.prepare(`
      SELECT ${BOT_WITH_OWNER_COLUMNS}
      FROM bots b
      LEFT JOIN nodes n ON n.id = b.node_id
      LEFT JOIN users u ON u.id = n.owner_id
      ORDER BY b.id ASC
    `);
    const rows = stmt.all() as BotRowWithOwner[];
    return rows.map((row) => mapBotRowWithOwner(row));
  }

  getAccessibleBots(userId: string): BotConfig[] {
    const stmt = this.db.prepare(`
      SELECT ${BOT_WITH_OWNER_COLUMNS}
      FROM bots b
      JOIN nodes n ON n.id = b.node_id
      LEFT JOIN users u ON u.id = n.owner_id
      WHERE n.owner_id = ? OR b.visibility = 'team' OR n.visibility = 'team'
      ORDER BY b.id ASC
    `);
    const rows = stmt.all(userId) as BotRowWithOwner[];
    return rows.map((row) => mapBotRowWithOwner(row, userId));
  }

  canUserUseBot(botId: string, userId: string): boolean {
    const bot = this.getBot(botId);
    if (!bot) return false;
    const node = this.getNode(bot.nodeId);
    if (!node) return false;
    const nodeOwner = this.getNodeOwner(bot.nodeId);
    if (nodeOwner === userId) return true;
    if (bot.visibility === 'team') return true;
    if (node.visibility === 'team') return true;
    return false;
  }

  saveBot(bot: BotConfig): void {
    const stmt = this.db.prepare(`
      INSERT INTO bots (id, node_id, name, description, model_provider, model_id, thinking_level, enabled_skills_json, enabled_extensions_json, visibility, updated_at, parent_bot_id, inherit_model, inherit_skills, color, tool_scope, custom_tools_json, isolation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        node_id = excluded.node_id,
        name = excluded.name,
        description = excluded.description,
        model_provider = excluded.model_provider,
        model_id = excluded.model_id,
        thinking_level = excluded.thinking_level,
        enabled_skills_json = excluded.enabled_skills_json,
        enabled_extensions_json = excluded.enabled_extensions_json,
        visibility = excluded.visibility,
        updated_at = excluded.updated_at,
        parent_bot_id = excluded.parent_bot_id,
        inherit_model = excluded.inherit_model,
        inherit_skills = excluded.inherit_skills,
        color = excluded.color,
        tool_scope = excluded.tool_scope,
        custom_tools_json = excluded.custom_tools_json,
        isolation = excluded.isolation
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
      bot.visibility === 'team' ? 'team' : 'private',
      bot.updatedAt || new Date().toISOString(),
      bot.parentBotId ?? null,
      bot.inheritModel ? 1 : 0,
      bot.inheritSkills ? 1 : 0,
      bot.color ?? null,
      bot.toolScope ?? null,
      bot.customTools ? JSON.stringify(bot.customTools) : null,
      bot.isolation ?? null
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
    parentSessionId?: string;
  }): SessionRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, created_at, updated_at, owner_id, parent_session_id)
      VALUES (?, ?, ?, ?, ?, '{}', 'idle', NULL, ?, ?, ?, ?)
    `);
    const leadBotId = input.leadBotId;
    stmt.run(
      input.id,
      input.title,
      'direct',
      leadBotId,
      JSON.stringify([leadBotId]),
      now,
      now,
      input.ownerId,
      input.parentSessionId ?? null
    );
    return {
      id: input.id,
      title: input.title,
      mode: 'direct',
      leadBotId,
      memberBotIds: [leadBotId],
      status: 'idle',
      activeBotId: undefined,
      createdAt: now,
      updatedAt: now,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    };
  }

  getSession(id: string): (SessionRecord & { cursorMap: Record<string, number> }) | undefined {
    const stmt = this.db.prepare('SELECT id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, archived, pinned, parent_session_id, owner_id, created_at, updated_at FROM sessions WHERE id = ?');
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
      parent_session_id: string | null;
      owner_id: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      mode: 'direct',
      leadBotId: row.lead_bot_id,
      memberBotIds: JSON.parse(row.member_bot_ids_json || '[]'),
      cursorMap: JSON.parse(row.cursor_map_json || '{}'),
      status: row.status as SessionStatus,
      activeBotId: row.active_bot_id ?? undefined,
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
      parentSessionId: row.parent_session_id ?? undefined,
      ...(row.owner_id ? { ownerId: row.owner_id } : {}),
      participants: this.listSessionParticipants(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAllSessions(ownerId: string): SessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT s.id, s.title, s.mode, s.lead_bot_id, s.member_bot_ids_json, s.status, s.active_bot_id, s.archived, s.pinned, s.parent_session_id, s.owner_id, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
        (SELECT m.content FROM messages m WHERE m.session_id = s.id ORDER BY m.rowid DESC LIMIT 1) AS last_message_content,
        (SELECT m.created_at FROM messages m WHERE m.session_id = s.id ORDER BY m.rowid DESC LIMIT 1) AS last_message_at
      FROM sessions s
      LEFT JOIN session_participants sp ON sp.session_id = s.id
      WHERE s.owner_id = ? OR sp.user_id = ?
      ORDER BY s.updated_at DESC
    `);
    const rows = stmt.all(ownerId, ownerId) as {
      id: string;
      title: string;
      mode: string;
      lead_bot_id: string;
      member_bot_ids_json: string;
      status: string;
      active_bot_id: string | null;
      archived: number;
      pinned: number;
      parent_session_id: string | null;
      owner_id: string | null;
      created_at: string;
      updated_at: string;
      message_count: number | bigint;
      last_message_content: string | null;
      last_message_at: string | null;
    }[];
    return rows.map((row) => {
      return {
        id: row.id,
        title: row.title,
        mode: 'direct',
        leadBotId: row.lead_bot_id,
        memberBotIds: JSON.parse(row.member_bot_ids_json || '[]'),
        status: row.status as SessionStatus,
        activeBotId: row.active_bot_id ?? undefined,
        archived: Boolean(row.archived),
        pinned: Boolean(row.pinned),
        parentSessionId: row.parent_session_id ?? undefined,
        ...(row.owner_id ? { ownerId: row.owner_id } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: Number(row.message_count),
        lastMessagePreview: buildPreview(row.last_message_content ?? ''),
        lastMessageAt: row.last_message_at ?? undefined,
      };
    });
  }

  listSubSessions(parentSessionId: string): SessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT s.id, s.title, s.mode, s.lead_bot_id, s.member_bot_ids_json, s.status, s.active_bot_id, s.archived, s.pinned, s.parent_session_id, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
        (SELECT m.content FROM messages m WHERE m.session_id = s.id ORDER BY m.rowid DESC LIMIT 1) AS last_message_content,
        (SELECT m.created_at FROM messages m WHERE m.session_id = s.id ORDER BY m.rowid DESC LIMIT 1) AS last_message_at
      FROM sessions s
      WHERE s.parent_session_id = ?
      ORDER BY s.created_at ASC
    `);
    const rows = stmt.all(parentSessionId) as {
      id: string;
      title: string;
      mode: string;
      lead_bot_id: string;
      member_bot_ids_json: string;
      status: string;
      active_bot_id: string | null;
      archived: number;
      pinned: number;
      parent_session_id: string | null;
      created_at: string;
      updated_at: string;
      message_count: number | bigint;
      last_message_content: string | null;
      last_message_at: string | null;
    }[];
    return rows.map((row) => {
      return {
        id: row.id,
        title: row.title,
        mode: 'direct',
        leadBotId: row.lead_bot_id,
        memberBotIds: JSON.parse(row.member_bot_ids_json || '[]'),
        status: row.status as SessionStatus,
        activeBotId: row.active_bot_id ?? undefined,
        archived: Boolean(row.archived),
        pinned: Boolean(row.pinned),
        parentSessionId: row.parent_session_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: Number(row.message_count),
        lastMessagePreview: buildPreview(row.last_message_content ?? ''),
        lastMessageAt: row.last_message_at ?? undefined,
      };
    });
  }

  /** 返回会话归属用户 id；会话不存在返回 undefined */
  getSessionOwner(sessionId: string): string | undefined {
    const stmt = this.db.prepare('SELECT owner_id FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId) as { owner_id: string | null } | undefined;
    return row?.owner_id ?? undefined;
  }

  /** 模块自建表（如 session_shares / notification_channels）存在才返回 true */
  private hasTable(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
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
      const deleteAutomationEvents = this.db.prepare('DELETE FROM automation_events WHERE session_id = ?');
      deleteAutomationEvents.run(id);
      const deleteArtifacts = this.db.prepare('DELETE FROM artifacts WHERE session_id = ?');
      deleteArtifacts.run(id);
      const deletePendingAsks = this.db.prepare('DELETE FROM pending_asks WHERE session_id = ?');
      deletePendingAsks.run(id);
      this.db.prepare('DELETE FROM session_participants WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM outbound_task_queue WHERE session_id = ?').run(id);
      // session_shares / notification_channels 由 share.ts / channels.ts 路由注册时自建，
      // 未注册过这些路由的部署（如纯 DB 使用方）里表不存在，跳过即可
      if (this.hasTable('session_shares')) {
        this.db.prepare('DELETE FROM session_shares WHERE session_id = ?').run(id);
      }
      if (this.hasTable('notification_channels')) {
        this.db.prepare('DELETE FROM notification_channels WHERE session_id = ?').run(id);
      }
      const deleteSessionStmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      deleteSessionStmt.run(id);
      return true;
    });
  }

  // --- Session Participants ---
  listSessionParticipants(sessionId: string): SessionParticipantRecord[] {
    const stmt = this.db.prepare(`
      SELECT sp.session_id, sp.user_id, sp.role, sp.joined_at, u.username
      FROM session_participants sp
      LEFT JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = ?
      ORDER BY sp.joined_at ASC
    `);
    const rows = stmt.all(sessionId) as {
      session_id: string;
      user_id: string;
      role: 'owner' | 'member';
      joined_at: string;
      username: string | null;
    }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      role: r.role,
      joinedAt: r.joined_at,
      ...(r.username ? { username: r.username } : {}),
    }));
  }

  addSessionParticipant(sessionId: string, userId: string, role: 'owner' | 'member' = 'member'): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO session_participants (session_id, user_id, role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, user_id) DO UPDATE SET role = excluded.role
    `);
    stmt.run(sessionId, userId, role, now);
  }

  removeSessionParticipant(sessionId: string, userId: string): void {
    const stmt = this.db.prepare('DELETE FROM session_participants WHERE session_id = ? AND user_id = ?');
    stmt.run(sessionId, userId);
  }

  isSessionParticipant(sessionId: string, userId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM session_participants WHERE session_id = ? AND user_id = ? LIMIT 1');
    return stmt.get(sessionId, userId) !== undefined;
  }

  canUserAccessSession(sessionId: string, userId: string): boolean {
    const ownerId = this.getSessionOwner(sessionId);
    if (ownerId === userId) return true;
    return this.isSessionParticipant(sessionId, userId);
  }

  /**
   * 节点能否以其凭据在指定会话上执行操作（委派/读写消息/产物/取消）。
   *
   * 授权依据是"调度事实"而非节点归属：只要会话（或其父会话链上的任一会话）的
   * 成员 Bot 运行在该节点上，且会话所有者有权使用该 Bot（如团队共享 Bot），
   * 该节点即可代表会话所有者行动。这覆盖了共享 Bot 在他人会话中 delegate_bot /
   * 跨 Bot Workflow / 产物读写的身份传递；与节点、会话均无关的请求仍会被拒绝。
   */
  canNodeActOnSession(nodeId: string, sessionId: string): boolean {
    const session = this.getSession(sessionId);
    const sessionOwner = this.getSessionOwner(sessionId);
    if (!session || !sessionOwner) return false;

    // 节点归会话所有者本人所有：最常见情形，直接放行
    if (this.getNodeOwner(nodeId) === sessionOwner) return true;

    // 沿父会话链向上追溯（最多 8 层，防御环路）：子会话由父会话派生，
    // 只要链上任一会话调度过该节点上的 Bot，节点即可继续操作派生出的子会话
    let current: SessionRecord | undefined = session;
    for (let depth = 0; current && depth < 8; depth++) {
      const memberBotIds = [current.leadBotId, ...current.memberBotIds];
      for (const botId of memberBotIds) {
        const bot = this.getBot(botId);
        if (!bot) continue;
        // bot 本体或其父 Bot（子代理随主 Bot 所在节点执行）位于该节点
        const botOnNode =
          bot.nodeId === nodeId ||
          Boolean(bot.parentBotId && this.getBot(bot.parentBotId)?.nodeId === nodeId);
        if (!botOnNode) continue;
        // 会话所有者必须有权使用该 Bot（私有 Bot 不得借节点凭据越权进入他人会话）
        if (this.canUserUseBot(botId, sessionOwner)) return true;
      }
      current = current.parentSessionId ? this.getSession(current.parentSessionId) : undefined;
    }
    return false;
  }

  // --- Outbound Task Queue (Offline Store-and-Forward) ---
  enqueueOutboundTask(input: {
    id?: string;
    nodeId: string;
    botId: string;
    sessionId: string;
    taskType: string;
    payload?: unknown;
    ttlHours?: number;
  }): OutboundTaskRecord {
    const id = input.id ?? `task_${randomUUID()}`;
    const now = new Date();
    const ttl = input.ttlHours ?? 72;
    const expiresAt = new Date(now.getTime() + ttl * 3600 * 1000).toISOString();
    const payloadJson = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload ?? {});

    const existing = this.db.prepare(`
      SELECT id FROM outbound_task_queue
      WHERE session_id = ? AND bot_id = ? AND status = 'queued_offline'
      LIMIT 1
    `).get(input.sessionId, input.botId) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE outbound_task_queue
        SET payload_json = ?, expires_at = ?
        WHERE id = ?
      `).run(payloadJson, expiresAt, existing.id);
      return this.getOutboundTask(existing.id)!;
    }

    const stmt = this.db.prepare(`
      INSERT INTO outbound_task_queue (id, node_id, bot_id, session_id, task_type, payload_json, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued_offline', ?, ?)
    `);
    const createdAt = now.toISOString();
    stmt.run(id, input.nodeId, input.botId, input.sessionId, input.taskType, payloadJson, createdAt, expiresAt);
    return {
      id,
      nodeId: input.nodeId,
      botId: input.botId,
      sessionId: input.sessionId,
      taskType: input.taskType,
      payloadJson,
      status: 'queued_offline',
      createdAt,
      expiresAt,
    };
  }

  getOutboundTask(id: string): OutboundTaskRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT id, node_id, bot_id, session_id, task_type, payload_json, status, created_at, expires_at
      FROM outbound_task_queue
      WHERE id = ?
    `);
    const row = stmt.get(id) as {
      id: string;
      node_id: string;
      bot_id: string;
      session_id: string;
      task_type: string;
      payload_json: string;
      status: string;
      created_at: string;
      expires_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      nodeId: row.node_id,
      botId: row.bot_id,
      sessionId: row.session_id,
      taskType: row.task_type,
      payloadJson: row.payload_json,
      status: row.status as OutboundTaskStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  listPendingOutboundTasks(nodeId: string): OutboundTaskRecord[] {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE outbound_task_queue
      SET status = 'expired'
      WHERE status = 'queued_offline' AND expires_at <= ?
    `).run(now);

    const stmt = this.db.prepare(`
      SELECT id, node_id, bot_id, session_id, task_type, payload_json, status, created_at, expires_at
      FROM outbound_task_queue
      WHERE node_id = ? AND status = 'queued_offline' AND expires_at > ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(nodeId, now) as {
      id: string;
      node_id: string;
      bot_id: string;
      session_id: string;
      task_type: string;
      payload_json: string;
      status: string;
      created_at: string;
      expires_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      botId: r.bot_id,
      sessionId: r.session_id,
      taskType: r.task_type,
      payloadJson: r.payload_json,
      status: r.status as OutboundTaskStatus,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  markOutboundTaskDispatched(id: string): void {
    this.db.prepare(`
      UPDATE outbound_task_queue
      SET status = 'dispatched'
      WHERE id = ?
    `).run(id);
  }

  /** Cancel all still-queued store-and-forward tasks of a session (clear/edit/cancel paths). */
  invalidateOutboundTasksForSession(sessionId: string): void {
    this.db.prepare(`
      UPDATE outbound_task_queue
      SET status = 'failed'
      WHERE session_id = ? AND status = 'queued_offline'
    `).run(sessionId);
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
      INSERT INTO sessions (id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, created_at, updated_at, owner_id, parent_session_id)
      VALUES (?, ?, ?, ?, ?, '{}', 'idle', NULL, ?, ?, ?, ?)
    `);

    const rows = this.db.prepare(`
      SELECT role, sender_bot_id, sender_user_id, sender_username, model_badge, content, mentions_json, subagent_runs_json, tool_calls_json, blocks_json, usage_json, attachments_json, created_at
      FROM messages
      WHERE session_id = ? AND rowid <= ?
      ORDER BY rowid ASC
    `).all(sourceSessionId, anchorRowid) as {
      role: string;
      sender_bot_id: string | null;
      sender_user_id: string | null;
      sender_username: string | null;
      model_badge: string | null;
      content: string;
      mentions_json: string;
      subagent_runs_json?: string | null;
      tool_calls_json: string | null;
      blocks_json?: string | null;
      usage_json: string | null;
      attachments_json: string | null;
      created_at: string;
    }[];
    // 逐行 INSERT（新 msg id、新 session_id），created_at 保留原值以保真时间线
    const insertMessage = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, sender_bot_id, sender_user_id, sender_username, model_badge, content, mentions_json, subagent_runs_json, tool_calls_json, blocks_json, usage_json, attachments_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        'direct',
        source.leadBotId,
        JSON.stringify([source.leadBotId]),
        now,
        now,
        ownerId,
        source.parentSessionId ?? null
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
          row.sender_user_id,
          row.sender_username,
          row.model_badge,
          row.content,
          row.mentions_json,
          row.subagent_runs_json ?? null,
          row.tool_calls_json,
          row.blocks_json ?? null,
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
      parentSessionId?: string;
    }
  ): SessionRecord | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;
    const now = new Date().toISOString();
    const title = patch.title ?? session.title;
    const mode = 'direct';
    const leadBotId = patch.leadBotId ?? session.leadBotId;
    const memberBotIds = [leadBotId];
    const status = patch.status ?? session.status;
    const activeBotId = patch.activeBotId !== undefined ? patch.activeBotId : session.activeBotId;
    const archived = patch.archived ?? session.archived ?? false;
    const pinned = patch.pinned ?? session.pinned ?? false;
    const parentSessionId = patch.parentSessionId !== undefined ? patch.parentSessionId : session.parentSessionId;

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET title = ?, mode = ?, lead_bot_id = ?, member_bot_ids_json = ?, status = ?, active_bot_id = ?, archived = ?, pinned = ?, parent_session_id = ?, updated_at = ?
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
      parentSessionId ?? null,
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
      parentSessionId: parentSessionId ?? undefined,
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

  /**
   * 原子标记子会话已向父会话发送完成/失败回调（幂等防重）。
   * 仅当 parent_notified 仍为 0 时置 1 并返回 true；重复调用返回 false，
   * 确保同一子会话绝不重复向父会话插入 ✅/❌ callback 消息，Hub 重启后依然生效。
   */
  markSessionParentNotified(sessionId: string): boolean {
    const stmt = this.db.prepare(
      'UPDATE sessions SET parent_notified = 1 WHERE id = ? AND parent_notified = 0'
    );
    const result = stmt.run(sessionId);
    return Number(result.changes) > 0;
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
    senderUserId?: string;
    senderUsername?: string;
    modelBadge?: string;
    content: string;
    mentions?: string[];
    subagentRuns?: SubagentRunRecord[];
    toolCalls?: ToolCallRecord[];
    blocks?: TurnBlock[];
    usage?: TurnUsage;
    attachments?: MessageAttachment[];
    aborted?: boolean;
    createdAt?: string;
  }): IncrementalMessageResult {
    const now = msg.createdAt ?? new Date().toISOString();
    const toolCallsJson = msg.toolCalls ? JSON.stringify(msg.toolCalls) : null;
    const blocksJson = msg.blocks && msg.blocks.length > 0 ? JSON.stringify(msg.blocks) : null;
    const usageJson = msg.usage ? JSON.stringify(msg.usage) : null;
    const attachmentsJson = msg.attachments ? JSON.stringify(msg.attachments) : null;
    const subagentRunsJson = msg.subagentRuns && msg.subagentRuns.length > 0 ? JSON.stringify(msg.subagentRuns) : null;
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, sender_bot_id, sender_user_id, sender_username, model_badge, content, mentions_json, subagent_runs_json, tool_calls_json, blocks_json, usage_json, attachments_json, aborted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      msg.id,
      msg.sessionId,
      msg.role,
      msg.senderBotId ?? null,
      msg.senderUserId ?? null,
      msg.senderUsername ?? null,
      msg.modelBadge ?? null,
      msg.content,
      JSON.stringify(msg.mentions || []),
      subagentRunsJson,
      toolCallsJson,
      blocksJson,
      usageJson,
      attachmentsJson,
      msg.aborted ? 1 : 0,
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
        ...(msg.subagentRuns && msg.subagentRuns.length > 0 ? { subagentRuns: msg.subagentRuns } : {}),
        ...(msg.senderUserId ? { senderUserId: msg.senderUserId } : {}),
        ...(msg.senderUsername ? { senderUsername: msg.senderUsername } : {}),
        ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
        ...(msg.blocks && msg.blocks.length > 0 ? { blocks: msg.blocks } : {}),
        ...(msg.usage ? { usage: msg.usage } : {}),
        ...(msg.aborted ? { aborted: true } : {}),
        ...(msg.attachments ? { attachments: msg.attachments } : {}),
        createdAt: now,
      },
    };
  }

  updateMessageSubagentRuns(messageId: string, subagentRuns: SubagentRunRecord[]): void {
    const stmt = this.db.prepare('UPDATE messages SET subagent_runs_json = ? WHERE id = ?');
    stmt.run(JSON.stringify(subagentRuns), messageId);
  }

  getMessages(sessionId: string): MessageRecord[] {
    const stmt = this.db.prepare(`
      SELECT ${MESSAGE_SELECT_COLUMNS}
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
    const columns = `rowid, ${MESSAGE_SELECT_COLUMNS}`;

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
      SELECT rowid, ${MESSAGE_SELECT_COLUMNS}
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
      SELECT rowid, ${MESSAGE_SELECT_COLUMNS}
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
    const selectCols = MESSAGE_SELECT_COLUMNS.split(', ').map(c => `m.${c}`).join(', ');
    let sql = `
      SELECT ${selectCols},
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
    secret?: string;
    cronExpr?: string;
    runAt?: string;
    prompt: string;
    enabled?: boolean;
    dispatchMode?: TriggerRecord['dispatchMode'];
    skillId?: string;
    eventFilter?: TriggerRecord['eventFilter'];
  }): TriggerRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO triggers (id, session_id, bot_id, owner_id, name, kind, token, secret, cron_expr, run_at, prompt, enabled, dispatch_mode, skill_id, event_filter_json, last_triggered_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
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
      input.secret ?? null,
      input.cronExpr ?? null,
      input.runAt ?? null,
      input.prompt,
      enabled ? 1 : 0,
      input.dispatchMode ?? 'append',
      input.skillId ?? null,
      input.eventFilter ? JSON.stringify(input.eventFilter) : null,
      now
    );
    return {
      id: input.id,
      sessionId: input.sessionId,
      botId: input.botId,
      name: input.name,
      kind: input.kind,
      ...(input.token ? { token: input.token } : {}),
      ...(input.secret ? { secret: input.secret } : {}),
      ...(input.cronExpr !== undefined ? { cronExpr: input.cronExpr } : {}),
      ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
      prompt: input.prompt,
      enabled,
      ...(input.dispatchMode ? { dispatchMode: input.dispatchMode } : {}),
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.eventFilter ? { eventFilter: input.eventFilter } : {}),
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
      dispatchMode?: TriggerRecord['dispatchMode'];
      /** 传 null 显式清除 */
      skillId?: string | null;
      /** 传 null 显式清除 */
      secret?: string | null;
      eventFilter?: TriggerRecord['eventFilter'];
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
      ...(patch.dispatchMode !== undefined ? { dispatchMode: patch.dispatchMode } : {}),
      ...(patch.skillId !== undefined ? { skillId: patch.skillId ?? undefined } : {}),
      ...(patch.secret !== undefined ? { secret: patch.secret ?? undefined } : {}),
      ...(patch.eventFilter !== undefined ? { eventFilter: patch.eventFilter } : {}),
    };
    const stmt = this.db.prepare(`
      UPDATE triggers
      SET enabled = ?, name = ?, prompt = ?, cron_expr = ?, run_at = ?, dispatch_mode = ?, skill_id = ?, secret = ?, event_filter_json = ?
      WHERE id = ?
    `);
    stmt.run(
      next.enabled ? 1 : 0,
      next.name,
      next.prompt,
      next.cronExpr ?? null,
      next.runAt ?? null,
      next.dispatchMode ?? 'append',
      next.skillId ?? null,
      next.secret ?? null,
      next.eventFilter ? JSON.stringify(next.eventFilter) : null,
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
    return this.inTransaction(() => {
      this.db.prepare('DELETE FROM automation_events WHERE trigger_id = ?').run(id);
      const stmt = this.db.prepare('DELETE FROM triggers WHERE id = ?');
      const result = stmt.run(id);
      return Number(result.changes) > 0;
    });
  }

  // --- Automation Events (Event Inbox) ---
  /** 插入自动化事件；命中 (trigger_id, dedup_key) 唯一索引时返回 undefined（已去重） */
  createAutomationEvent(input: {
    id: string;
    triggerId: string;
    sessionId: string;
    childSessionId?: string;
    source: string;
    eventType: string;
    dedupKey?: string;
    summary: string;
    payloadArtifactId?: string;
    createdAt?: string;
  }): AutomationEventRecord | undefined {
    const now = input.createdAt ?? new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO automation_events (${AUTOMATION_EVENT_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      stmt.run(
        input.id,
        input.triggerId,
        input.sessionId,
        input.childSessionId ?? null,
        input.source,
        input.eventType,
        input.dedupKey ?? null,
        input.summary,
        input.payloadArtifactId ?? null,
        now
      );
    } catch (err: any) {
      // 唯一索引冲突 = 重复事件，交给调用方去重处理
      if (String(err?.message || '').includes('UNIQUE constraint failed')) return undefined;
      throw err;
    }
    return {
      id: input.id,
      triggerId: input.triggerId,
      sessionId: input.sessionId,
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      source: input.source,
      eventType: input.eventType,
      ...(input.dedupKey ? { dedupKey: input.dedupKey } : {}),
      summary: input.summary,
      ...(input.payloadArtifactId ? { payloadArtifactId: input.payloadArtifactId } : {}),
      createdAt: now,
    };
  }

  getAutomationEvent(id: string): AutomationEventRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT ${AUTOMATION_EVENT_COLUMNS}
      FROM automation_events
      WHERE id = ?
    `);
    const row = stmt.get(id) as AutomationEventRow | undefined;
    return row ? mapAutomationEventRow(row) : undefined;
  }

  /** 检查 (trigger_id, dedup_key) 是否已存在（跨重启持久化去重） */
  hasAutomationEventWithDedupKey(triggerId: string, dedupKey: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM automation_events WHERE trigger_id = ? AND dedup_key = ? LIMIT 1
    `);
    return stmt.get(triggerId, dedupKey) !== undefined;
  }

  /** 回填事件的子会话 id 与载荷 Artifact id（创建时可能尚未生成） */
  updateAutomationEvent(id: string, patch: { childSessionId?: string; payloadArtifactId?: string }): void {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (patch.childSessionId !== undefined) {
      sets.push('child_session_id = ?');
      params.push(patch.childSessionId);
    }
    if (patch.payloadArtifactId !== undefined) {
      sets.push('payload_artifact_id = ?');
      params.push(patch.payloadArtifactId);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE automation_events SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  /** 会话关联事件列表（按 created_at 倒序，默认 100 条）：含该会话派生子会话的事件 */
  listSessionAutomationEvents(sessionId: string, limit = 100): AutomationEventRecord[] {
    const capped = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
    const stmt = this.db.prepare(`
      SELECT ${AUTOMATION_EVENT_COLUMNS}
      FROM automation_events
      WHERE session_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `);
    const rows = stmt.all(sessionId, capped) as AutomationEventRow[];
    return rows.map(mapAutomationEventRow);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore if already closed
    }
  }
}
