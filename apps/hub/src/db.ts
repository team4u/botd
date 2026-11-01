import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  BotConfig,
  MessageRecord,
  MessageRole,
  NodeRecord,
  NodeWithBots,
  PlatformType,
  SessionMode,
  SessionRecord,
  SessionStatus,
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

export const isValidCommandName = (name: unknown): name is string => {
  return typeof name === 'string' && name.length > 0 && !name.includes('/') && !/\s/.test(name);
};

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

export class HubDatabase {
  public db: DatabaseSync;

  constructor(options?: HubDatabaseOptions) {
    const defaultDir = process.env.BOTD_HUB_DATA_DIR || path.join(os.homedir(), '.botd');
    const dbPath = options?.dbPath ?? process.env.BOTD_DB_PATH ?? path.join(defaultDir, 'hub.sqlite');
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:' && process.platform !== 'win32') fs.chmodSync(dbPath, 0o600);
    this.initSchema();
    this.resetStaleMetadata();
  }

  public resetStaleMetadata(): void {
    this.db.exec(`
      UPDATE nodes SET status = 'offline' WHERE status = 'online';
      UPDATE sessions SET status = 'idle', active_bot_id = NULL WHERE status = 'running';
    `);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

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
        started_at TEXT
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
        web_command_names_json TEXT NOT NULL DEFAULT '[]',
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
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    `);

    const migrations = [
      `ALTER TABLE nodes ADD COLUMN extensions_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE bots ADD COLUMN enabled_extensions_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE bots ADD COLUMN web_command_names_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE nodes ADD COLUMN pid INTEGER`,
      `ALTER TABLE nodes ADD COLUMN started_at TEXT`,
      `ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE nodes ADD COLUMN owner_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN owner_id TEXT`,
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
  }

  // --- Settings ---
  getSetting<T = any>(key: string): T | undefined {
    const stmt = this.db.prepare('SELECT value_json FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  setSetting(key: string, value: any): void {
    const now = new Date().toISOString();
    const json = JSON.stringify(value);
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(key, json, now);
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
    const sessionIds = (this.db.prepare('SELECT id FROM sessions WHERE owner_id = ?').all(id) as { id: string }[]).map(
      (row) => row.id
    );
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => '?').join(', ');
      this.db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...sessionIds);
    }
    this.db.prepare('DELETE FROM sessions WHERE owner_id = ?').run(id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
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
    const stmt = this.db.prepare('SELECT id, name, platform, skills_json, extensions_json, status, last_seen_at, created_at, pid, started_at FROM nodes WHERE id = ?');
    const row = stmt.get(id) as {
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
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      platform: row.platform as PlatformType,
      skills: JSON.parse(row.skills_json || '[]'),
      extensions: JSON.parse(row.extensions_json || '[]'),
      status: row.status as 'online' | 'offline',
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      ...(typeof row.pid === 'number' ? { pid: row.pid } : {}),
      ...(typeof row.started_at === 'string' && row.started_at.length > 0 ? { startedAt: row.started_at } : {}),
    };
  }

  getNodeWithSecret(id: string): (NodeRecord & { tokenHash: string }) | undefined {
    const stmt = this.db.prepare('SELECT id, name, platform, token_hash, skills_json, extensions_json, status, last_seen_at, created_at, pid, started_at FROM nodes WHERE id = ?');
    const row = stmt.get(id) as {
      id: string;
      name: string;
      platform: string;
      token_hash: string;
      skills_json: string;
      extensions_json: string;
      status: string;
      last_seen_at: string;
      created_at: string;
      pid: number | null;
      started_at: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      platform: row.platform as PlatformType,
      tokenHash: row.token_hash,
      skills: JSON.parse(row.skills_json || '[]'),
      extensions: JSON.parse(row.extensions_json || '[]'),
      status: row.status as 'online' | 'offline',
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      ...(typeof row.pid === 'number' ? { pid: row.pid } : {}),
      ...(typeof row.started_at === 'string' && row.started_at.length > 0 ? { startedAt: row.started_at } : {}),
    };
  }

  getAllNodes(): NodeRecord[] {
    const stmt = this.db.prepare('SELECT id, name, platform, skills_json, extensions_json, status, last_seen_at, created_at, pid, started_at FROM nodes ORDER BY created_at ASC');
    const rows = stmt.all() as {
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
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform as PlatformType,
      skills: JSON.parse(row.skills_json || '[]'),
      extensions: JSON.parse(row.extensions_json || '[]'),
      status: row.status as 'online' | 'offline',
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      ...(typeof row.pid === 'number' ? { pid: row.pid } : {}),
      ...(typeof row.started_at === 'string' && row.started_at.length > 0 ? { startedAt: row.started_at } : {}),
    }));
  }

  getAllNodesWithBots(ownerId: string): NodeWithBots[] {
    const stmt = this.db.prepare('SELECT id, name, platform, skills_json, extensions_json, status, last_seen_at, created_at, pid, started_at FROM nodes WHERE owner_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(ownerId) as {
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
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform as PlatformType,
      skills: JSON.parse(row.skills_json || '[]'),
      extensions: JSON.parse(row.extensions_json || '[]'),
      status: row.status as 'online' | 'offline',
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      ...(typeof row.pid === 'number' ? { pid: row.pid } : {}),
      ...(typeof row.started_at === 'string' && row.started_at.length > 0 ? { startedAt: row.started_at } : {}),
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
    startedAt?: string
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET name = ?, platform = ?, skills_json = ?, extensions_json = ?, pid = ?, started_at = ?, status = 'online', last_seen_at = ?
      WHERE id = ?
    `);
    stmt.run(name, platform, JSON.stringify(skills), JSON.stringify(extensions), pid ?? null, startedAt ?? null, now, id);
  }

  deleteNode(id: string): void {
    const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    stmt.run(id);
  }

  addNodeSkill(nodeId: string, skillId: string): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    if (!node.skills.includes(skillId)) {
      node.skills.push(skillId);
      const stmt = this.db.prepare('UPDATE nodes SET skills_json = ? WHERE id = ?');
      stmt.run(JSON.stringify(node.skills), nodeId);
    }
  }

  removeNodeSkill(nodeId: string, skillId: string): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    if (node.skills.includes(skillId)) {
      const nextSkills = node.skills.filter((s) => s !== skillId);
      const stmt = this.db.prepare('UPDATE nodes SET skills_json = ? WHERE id = ?');
      stmt.run(JSON.stringify(nextSkills), nodeId);
    }
  }

  addNodeExtension(nodeId: string, extId: string): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    if (!node.extensions.includes(extId)) {
      node.extensions.push(extId);
      const stmt = this.db.prepare('UPDATE nodes SET extensions_json = ? WHERE id = ?');
      stmt.run(JSON.stringify(node.extensions), nodeId);
    }
  }

  removeNodeExtension(nodeId: string, extId: string): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    if (node.extensions.includes(extId)) {
      const nextExtensions = node.extensions.filter((e) => e !== extId);
      const stmt = this.db.prepare('UPDATE nodes SET extensions_json = ? WHERE id = ?');
      stmt.run(JSON.stringify(nextExtensions), nodeId);
    }
  }

  // --- Bots ---
  getBot(id: string): BotConfig | undefined {
    const stmt = this.db.prepare('SELECT id, node_id, name, description, model_provider, model_id, thinking_level, enabled_skills_json, enabled_extensions_json, web_command_names_json, updated_at FROM bots WHERE id = ?');
    const row = stmt.get(id) as {
      id: string;
      node_id: string;
      name: string;
      description: string;
      model_provider: string;
      model_id: string;
      thinking_level: string | null;
      enabled_skills_json: string;
      enabled_extensions_json: string;
      web_command_names_json: string | null;
      updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      nodeId: row.node_id,
      name: row.name,
      description: row.description,
      modelProvider: row.model_provider,
      modelId: row.model_id,
      thinkingLevel: (row.thinking_level as 'low' | 'medium' | 'high') ?? 'medium',
      enabledSkills: JSON.parse(row.enabled_skills_json || '[]'),
      enabledExtensions: JSON.parse(row.enabled_extensions_json || '[]'),
      webCommandNames: JSON.parse(row.web_command_names_json || '[]'),
      updatedAt: row.updated_at,
    };
  }

  getBotsForNode(nodeId: string): BotConfig[] {
    const stmt = this.db.prepare('SELECT id, node_id, name, description, model_provider, model_id, thinking_level, enabled_skills_json, enabled_extensions_json, web_command_names_json, updated_at FROM bots WHERE node_id = ? ORDER BY id ASC');
    const rows = stmt.all(nodeId) as {
      id: string;
      node_id: string;
      name: string;
      description: string;
      model_provider: string;
      model_id: string;
      thinking_level: string | null;
      enabled_skills_json: string;
      enabled_extensions_json: string;
      web_command_names_json: string | null;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      name: row.name,
      description: row.description,
      modelProvider: row.model_provider,
      modelId: row.model_id,
      thinkingLevel: (row.thinking_level as 'low' | 'medium' | 'high') ?? 'medium',
      enabledSkills: JSON.parse(row.enabled_skills_json || '[]'),
      enabledExtensions: JSON.parse(row.enabled_extensions_json || '[]'),
      webCommandNames: JSON.parse(row.web_command_names_json || '[]'),
      updatedAt: row.updated_at,
    }));
  }

  saveBot(bot: BotConfig): void {
    const stmt = this.db.prepare(`
      INSERT INTO bots (id, node_id, name, description, model_provider, model_id, thinking_level, enabled_skills_json, enabled_extensions_json, web_command_names_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        node_id = excluded.node_id,
        name = excluded.name,
        description = excluded.description,
        model_provider = excluded.model_provider,
        model_id = excluded.model_id,
        thinking_level = excluded.thinking_level,
        enabled_skills_json = excluded.enabled_skills_json,
        enabled_extensions_json = excluded.enabled_extensions_json,
        web_command_names_json = excluded.web_command_names_json,
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
      JSON.stringify(bot.webCommandNames ? Array.from(new Set(bot.webCommandNames)) : []),
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
  }): SessionRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, created_at, updated_at, owner_id)
      VALUES (?, ?, ?, ?, ?, '{}', 'idle', NULL, ?, ?, ?)
    `);
    stmt.run(
      input.id,
      input.title,
      input.mode,
      input.leadBotId,
      JSON.stringify(input.memberBotIds),
      now,
      now,
      input.ownerId
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
    };
  }

  getSession(id: string): (SessionRecord & { cursorMap: Record<string, number> }) | undefined {
    const stmt = this.db.prepare('SELECT id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, archived, created_at, updated_at FROM sessions WHERE id = ?');
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAllSessions(ownerId: string): SessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT s.id, s.title, s.mode, s.lead_bot_id, s.member_bot_ids_json, s.status, s.active_bot_id, s.archived, s.created_at, s.updated_at,
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: Number(row.message_count),
      lastMessagePreview: buildPreview(row.last_message_content ?? ''),
      lastMessageAt: row.last_message_at ?? undefined,
    }));
  }

  deleteSession(id: string): boolean {
    const session = this.getSession(id);
    if (!session) return false;
    const deleteMessages = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    deleteMessages.run(id);
    const deleteSessionStmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    deleteSessionStmt.run(id);
    return true;
  }

  clearSessionMessages(id: string): boolean {
    const session = this.getSession(id);
    if (!session) return false;
    const deleteMessages = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    deleteMessages.run(id);
    this.resetCursorMap(id);
    return true;
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
      INSERT INTO sessions (id, title, mode, lead_bot_id, member_bot_ids_json, cursor_map_json, status, active_bot_id, created_at, updated_at, owner_id)
      VALUES (?, ?, ?, ?, ?, '{}', 'idle', NULL, ?, ?, ?)
    `);
    insertSession.run(
      newSessionId,
      `${source.title}（分叉）`,
      source.mode,
      source.leadBotId,
      JSON.stringify(source.memberBotIds),
      now,
      now,
      ownerId
    );

    const rows = this.db.prepare(`
      SELECT role, sender_bot_id, model_badge, content, mentions_json, created_at
      FROM messages
      WHERE session_id = ? AND rowid <= ?
      ORDER BY rowid ASC
    `).all(sourceSessionId, anchorRowid) as {
      role: string;
      sender_bot_id: string | null;
      model_badge: string | null;
      content: string;
      mentions_json: string;
      created_at: string;
    }[];
    // 逐行 INSERT（新 msg id、新 session_id），created_at 保留原值以保真时间线
    const insertMessage = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, sender_bot_id, model_badge, content, mentions_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insertMessage.run(
        `msg_${randomUUID()}`,
        newSessionId,
        row.role,
        row.sender_bot_id,
        row.model_badge,
        row.content,
        row.mentions_json,
        row.created_at
      );
    }

    return this.getAllSessions(ownerId).find((s) => s.id === newSessionId);
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

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET title = ?, mode = ?, lead_bot_id = ?, member_bot_ids_json = ?, status = ?, active_bot_id = ?, archived = ?, updated_at = ?
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
    createdAt?: string;
  }): IncrementalMessageResult {
    const now = msg.createdAt ?? new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, sender_bot_id, model_badge, content, mentions_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      msg.id,
      msg.sessionId,
      msg.role,
      msg.senderBotId ?? null,
      msg.modelBadge ?? null,
      msg.content,
      JSON.stringify(msg.mentions || []),
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
        createdAt: now,
      },
    };
  }

  getMessages(sessionId: string): MessageRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, session_id, role, sender_bot_id, model_badge, content, mentions_json, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY rowid ASC
    `);
    const rows = stmt.all(sessionId) as {
      id: string;
      session_id: string;
      role: string;
      sender_bot_id: string | null;
      model_badge: string | null;
      content: string;
      mentions_json: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role as MessageRole,
      senderBotId: row.sender_bot_id ?? undefined,
      modelBadge: row.model_badge ?? undefined,
      content: row.content,
      mentions: JSON.parse(row.mentions_json || '[]'),
      createdAt: row.created_at,
    }));
  }

  getIncrementalMessages(sessionId: string, afterRowid: number): IncrementalMessageResult[] {
    const stmt = this.db.prepare(`
      SELECT rowid, id, session_id, role, sender_bot_id, model_badge, content, mentions_json, created_at
      FROM messages
      WHERE session_id = ? AND rowid > ?
      ORDER BY rowid ASC
    `);
    const rows = stmt.all(sessionId, afterRowid) as {
      rowid: number | bigint;
      id: string;
      session_id: string;
      role: string;
      sender_bot_id: string | null;
      model_badge: string | null;
      content: string;
      mentions_json: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      rowid: Number(row.rowid),
      message: {
        id: row.id,
        sessionId: row.session_id,
        role: row.role as MessageRole,
        senderBotId: row.sender_bot_id ?? undefined,
        modelBadge: row.model_badge ?? undefined,
        content: row.content,
        mentions: JSON.parse(row.mentions_json || '[]'),
        createdAt: row.created_at,
      },
    }));
  }

  getMaxMessageRowid(sessionId: string): number {
    const stmt = this.db.prepare('SELECT MAX(rowid) as max_rowid FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as { max_rowid: number | bigint | null } | undefined;
    return row && row.max_rowid ? Number(row.max_rowid) : 0;
  }

  /** 更新消息内容与 mentions；消息不存在时返回 undefined */
  updateMessageContent(messageId: string, content: string, mentions: string[]): MessageRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT id, session_id, role, sender_bot_id, model_badge, mentions_json, created_at
      FROM messages
      WHERE id = ?
    `);
    const row = stmt.get(messageId) as {
      id: string;
      session_id: string;
      role: string;
      sender_bot_id: string | null;
      model_badge: string | null;
      mentions_json: string;
      created_at: string;
    } | undefined;
    if (!row) return undefined;
    const update = this.db.prepare('UPDATE messages SET content = ?, mentions_json = ? WHERE id = ?');
    update.run(content, JSON.stringify(mentions), messageId);
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role as MessageRole,
      senderBotId: row.sender_bot_id ?? undefined,
      modelBadge: row.model_badge ?? undefined,
      content,
      mentions,
      createdAt: row.created_at,
    };
  }

  /** 删除会话内 rowid 大于给定值（不含等于）的消息，返回删除条数 */
  deleteMessagesAfter(sessionId: string, rowid: number): number {
    const stmt = this.db.prepare('DELETE FROM messages WHERE session_id = ? AND rowid > ?');
    const result = stmt.run(sessionId, rowid);
    return Number(result.changes);
  }

  getMessageRowid(messageId: string): number | undefined {
    const stmt = this.db.prepare('SELECT rowid FROM messages WHERE id = ?');
    const row = stmt.get(messageId) as { rowid: number | bigint } | undefined;
    return row ? Number(row.rowid) : undefined;
  }

  getMessageById(messageId: string): { rowid: number; message: MessageRecord } | undefined {
    const stmt = this.db.prepare(`
      SELECT rowid, id, session_id, role, sender_bot_id, model_badge, content, mentions_json, created_at
      FROM messages
      WHERE id = ?
    `);
    const row = stmt.get(messageId) as {
      rowid: number | bigint;
      id: string;
      session_id: string;
      role: string;
      sender_bot_id: string | null;
      model_badge: string | null;
      content: string;
      mentions_json: string;
      created_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      rowid: Number(row.rowid),
      message: {
        id: row.id,
        sessionId: row.session_id,
        role: row.role as MessageRole,
        senderBotId: row.sender_bot_id ?? undefined,
        modelBadge: row.model_badge ?? undefined,
        content: row.content,
        mentions: JSON.parse(row.mentions_json || '[]'),
        createdAt: row.created_at,
      },
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore if already closed
    }
  }
}
