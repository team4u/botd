export type PlatformType = 'darwin' | 'linux' | 'win32';
export type SessionMode = 'direct' | 'lead' | 'roundtable';
export type SessionStatus = 'idle' | 'running' | 'failed';
export type MessageRole = 'user' | 'assistant' | 'callback' | 'system';

export type UserRole = 'admin' | 'member';

export interface UserRecord {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
}

export interface NodeRecord {
  id: string;
  name: string;
  platform: PlatformType;
  status: 'online' | 'offline';
  skills: string[];
  extensions: string[];
  lastSeenAt: string;
  createdAt: string;
  pid?: number;
  startedAt?: string;
}

export interface BotConfig {
  id: string;
  nodeId: string;
  name: string;
  description: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel?: 'low' | 'medium' | 'high';
  enabledSkills: string[];
  enabledExtensions?: string[];
  /** @deprecated Legacy metadata, ignored by command discovery and execution. */
  webCommandNames?: string[];
  updatedAt: string;
}

/** Discoverable Pi commands. Names preserve Pi syntax, including the skill: prefix. */
export interface ChatCommand {
  name: string;
  description?: string;
  source: 'skill' | 'prompt' | 'extension';
  argumentHint?: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  mode: SessionMode;
  leadBotId: string;
  memberBotIds: string[];
  status: SessionStatus;
  activeBotId?: string;
  createdAt: string;
  updatedAt: string;
  /** 会话内消息总数（用户+助手+系统），由 Hub 查询时附加，可选字段 */
  messageCount?: number;
  /** 最近一条消息的纯文本摘要（已去除 Markdown 与换行，截断至约 60 字符） */
  lastMessagePreview?: string;
  /** 最近一条消息的创建时间（ISO 字符串） */
  lastMessageAt?: string;
  /** 是否已归档（如「开启新话题」后旧会话自动归档，在历史话题区展示） */
  archived?: boolean;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: MessageRole;
  senderBotId?: string;
  modelBadge?: string;
  content: string;
  mentions: string[];
  createdAt: string;
}

export type SessionSseEvent =
  | { type: 'session_status'; sessionId: string; status: SessionStatus; activeBotId?: string }
  | { type: 'text_delta'; sessionId: string; botId: string; delta: string }
  | { type: 'tool_status'; sessionId: string; botId: string; toolName: string; status: 'running' | 'done'; summary?: string }
  | { type: 'message_created'; message: MessageRecord }
  /** 编辑用户消息后：锚点之后的历史已被截断、锚点内容已更新，客户端应重新拉取消息列表 */
  | { type: 'messages_truncated'; sessionId: string; anchorMessageId: string };

export interface HubRpcFunctions {
  registerNode(info: {
    nodeId: string;
    name: string;
    platform: PlatformType;
    bots: BotConfig[];
    skills: string[];
    extensions?: string[];
    pid?: number;
    startedAt?: string;
  }): Promise<void>;
  heartbeat(nodeId: string): Promise<void>;
  onSessionStream(event: {
    sessionId: string;
    botId: string;
    deltaText?: string;
    toolName?: string;
    toolStatus?: 'running' | 'done';
    toolSummary?: string;
  }): void;
  requestWakeupTurn(input: {
    sessionId: string;
    botId: string;
    wakeupMessage: string;
  }): Promise<void>;
}

export interface NodeRpcFunctions {
  restartDaemon(): Promise<{ ok: true; pid: number }>;
  getModelCatalog(): Promise<ModelCatalog>;
  getCommands(botId: string): Promise<ChatCommand[]>;
  startProviderLogin(input: { providerId: string; method: ProviderAuthType }): Promise<ProviderLoginState>;
  getProviderLogin(loginId: string): Promise<ProviderLoginState>;
  respondProviderLogin(input: { loginId: string; promptId: string; value: string }): Promise<ProviderLoginState>;
  cancelProviderLogin(loginId: string): Promise<void>;
  logoutProvider(providerId: string): Promise<void>;
  saveBot(bot: BotConfig, systemMd: string): Promise<void>;
  deleteBot(botId: string): Promise<void>;
  readFile(target: { kind: 'system' | 'memory' | 'skill' | 'extension'; botId?: string; id: string }): Promise<string>;
  writeFile(target: { kind: 'system' | 'memory' | 'skill' | 'extension'; botId?: string; id: string }, content: string): Promise<void>;
  installResource(input: {
    source: string;
    kind?: 'auto' | 'skill' | 'extension';
    customId?: string;
  }): Promise<{
    kind: 'skill' | 'extension';
    id: string;
  }>;
  deleteResource(target: {
    kind: 'skill' | 'extension';
    id: string;
  }): Promise<void>;
  runTurn(input: {
    sessionId: string;
    botId: string;
    groupContextPrompt: string;
    incrementalMessages: string;
    /** Current user command without sender/mention prefixes; history remains separate. */
    commandText?: string;
  }): Promise<{ replyText: string; modelBadge: string }>;
  cancelTurn(sessionId: string, botId: string): Promise<void>;
  /** 归档该 BOT 在指定会话的本地 Pi 会话文件（.jsonl 改名备份），下一回合将从 Hub 历史全量重建上下文 */
  resetSession(sessionId: string, botId: string): Promise<void>;
}

// HTTP shapes shared by the browser and Hub. Responses contain these values directly.
export interface NodeWithBots extends NodeRecord { bots: BotConfig[] }
export interface SaveBotInput extends Omit<BotConfig, 'updatedAt'> { systemMd: string }
export interface CreateSessionInput {
  title: string;
  mode: SessionMode;
  leadBotId: string;
  memberBotIds: string[];
}
export interface NodeIdentity { nodeId: string; name: string; hubUrl: string; token: string }
export interface PairingResult { code: string; expiresAt: string }
export interface ApiError { error: string }

export type ProviderAuthType = 'api_key' | 'oauth';
export interface ModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  authMethods: { type: ProviderAuthType; label: string; interactive: boolean; subscription: boolean }[];
  models: ModelCatalogEntry[];
  configured?: boolean;
  credentialType?: ProviderAuthType;
}
export interface ModelCatalog {
  source: 'pi';
  sdkVersion: string;
  providers: ProviderCatalogEntry[];
}
export interface ProviderLoginPrompt {
  id: string;
  type: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}
export type ProviderLoginEvent =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string };
export interface ProviderLoginState {
  id: string;
  providerId: string;
  method: ProviderAuthType;
  status: 'pending' | 'success' | 'error' | 'cancelled';
  events: ProviderLoginEvent[];
  prompt?: ProviderLoginPrompt;
  error?: string;
}

/** Keep Error messages across JSON-based birpc transports (Error fields are non-enumerable). */
export function serializeRpcMessage(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error ? { name: item.name, message: item.message } : item,
  );
}
