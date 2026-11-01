export * from './cron.js';

export type PlatformType = 'darwin' | 'linux' | 'win32';
export type SessionMode = 'direct' | 'lead' | 'roundtable';
export type SessionStatus = 'idle' | 'running' | 'queued' | 'failed';
export type MessageRole = 'user' | 'assistant' | 'callback' | 'system';

export interface ToolCallRecord {
  name: string;
  summary?: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  outputPreview?: string;
  isError?: boolean;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface IncomingArtifactRef {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  fromBotName?: string;
}

export type AskPreviewType = 'diff' | 'markdown' | 'text';
export type ResourceVisibility = 'private' | 'team';

export type OutboundTaskStatus = 'queued_offline' | 'dispatched' | 'expired' | 'failed';

export interface OutboundTaskRecord {
  id: string;
  nodeId: string;
  botId: string;
  sessionId: string;
  taskType: string;
  payloadJson: string;
  status: OutboundTaskStatus;
  createdAt: string;
  expiresAt: string;
}

export interface SessionParticipantRecord {
  sessionId: string;
  userId: string;
  username?: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  senderBotId?: string;
  createdAt: string;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export interface PendingAskRecord {
  id: string;
  sessionId: string;
  botId: string;
  prompt: string;
  options: string[];
  status: 'pending' | 'answered' | 'expired';
  answer?: string;
  previewType?: AskPreviewType;
  previewContent?: string;
  sessionTitle?: string;
  createdAt: string;
  expiresAt?: string;
}

export type TriggerKind = 'webhook' | 'cron' | 'once';

export interface TriggerRecord {
  id: string;
  sessionId: string;
  botId: string;
  name: string;
  kind: TriggerKind;
  /** For webhook triggers: secret token used in POST /api/webhooks/:token */
  token?: string;
  /** Standard 5-field cron expression (server local time), required for kind='cron' */
  cronExpr?: string;
  /** ISO timestamp when a one-shot trigger (kind='once') should fire */
  runAt?: string;
  prompt: string;
  enabled: boolean;
  lastTriggeredAt?: string;
  createdAt: string;
}

export interface CreateTriggerInput {
  name: string;
  botId: string;
  kind: TriggerKind;
  cronExpr?: string;
  /** ISO timestamp or delaySeconds for kind='once' */
  runAt?: string;
  delaySeconds?: number;
  prompt: string;
  enabled?: boolean;
}

export type BgJobStatus = 'running' | 'done' | 'failed' | 'killed';

export interface BgJobRecord {
  id: string;
  sessionId: string;
  botId: string;
  command: string;
  cwd: string;
  pid?: number;
  status: BgJobStatus;
  exitCode?: number | null;
  replyToBotId?: string;
  noTurnOnComplete?: boolean;
  logPath: string;
  startedAt: string;
  finishedAt?: string;
}

export interface MessageSearchHit {
  message: MessageRecord;
  sessionTitle: string;
  sessionMode: SessionMode;
  sessionArchived: boolean;
}

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
  visibility?: ResourceVisibility;
  ownerId?: string;
  ownerName?: string;
  isTeamShared?: boolean;
  lastSeenAt: string;
  createdAt: string;
  pid?: number;
  startedAt?: string;
  version?: string;
}

export interface NodeUpgradeCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  blocked?: { version: string; reason: string; at: string };
}

export interface NodeUpgradeResult {
  ok: true;
  previousVersion: string;
  targetVersion: string;
  upgraded: boolean;
  pid?: number;
}

export interface BotConfig {
  id: string;
  nodeId: string;
  name: string;
  description: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  enabledSkills: string[];
  enabledExtensions?: string[];
  visibility?: ResourceVisibility;
  ownerId?: string;
  ownerName?: string;
  isTeamShared?: boolean;
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
  /** 圆桌并发盲评时同时处于活跃推理中的 BOT ID 列表 */
  activeBotIds?: string[];
  /** 若由父会话派生的子会话，记录父会话 ID */
  parentSessionId?: string;
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
  /** 是否置顶（会话列表顶部固定展示的纯 UI 标记） */
  pinned?: boolean;
  /** 圆桌模式下是否开启独立并发盲评（所有成员并发独立作答，最后由 Lead 总结） */
  parallelRoundtable?: boolean;
  /** 会话创建者 ID */
  ownerId?: string;
  /** 多人协同会话参与者列表 */
  participants?: SessionParticipantRecord[];
}

export interface SessionShareRecord {
  id: string;
  sessionId: string;
  token: string;
  createdAt: string;
  expiresAt?: string;
}

export interface SharedBotSummary {
  id: string;
  name: string;
  description: string;
  modelProvider: string;
  modelId: string;
}

export interface SharedSessionSnapshot {
  share: SessionShareRecord;
  session: Pick<
    SessionRecord,
    'id' | 'title' | 'mode' | 'leadBotId' | 'memberBotIds' | 'parallelRoundtable' | 'createdAt' | 'updatedAt'
  >;
  bots: SharedBotSummary[];
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
}

export interface DelegateSessionInput {
  botId: string;
  title?: string;
  prompt: string;
  memberBotIds?: string[];
  mode?: SessionMode;
  artifactIds?: string[];
}

export interface DelegateSessionResult {
  parentSessionId: string;
  childSession: SessionRecord;
  initialMessage: MessageRecord;
}

export type NotificationChannelKind = 'webhook' | 'feishu' | 'slack' | 'telegram';
export type NotificationEventKind = 'assistant_reply' | 'ask_request' | 'wakeup';

export interface NotificationChannelRecord {
  id: string;
  sessionId: string;
  name: string;
  kind: NotificationChannelKind;
  targetUrl: string;
  secret?: string;
  events: NotificationEventKind[];
  enabled: boolean;
  lastTriggeredAt?: string;
  createdAt: string;
}

export interface CreateNotificationChannelInput {
  name: string;
  kind: NotificationChannelKind;
  targetUrl: string;
  secret?: string;
  events?: NotificationEventKind[];
  enabled?: boolean;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: MessageRole;
  senderBotId?: string;
  /** 多人协同会话中人类发送者的用户 ID（仅 role === 'user' 时可能出现） */
  senderUserId?: string;
  /** 多人协同会话中人类发送者的用户名（仅 role === 'user' 时可能出现） */
  senderUsername?: string;
  modelBadge?: string;
  content: string;
  mentions: string[];
  toolCalls?: ToolCallRecord[];
  usage?: TurnUsage;
  attachments?: MessageAttachment[];
  createdAt: string;
}

export type SessionSseEvent =
  | { type: 'session_status'; sessionId: string; status: SessionStatus; activeBotId?: string; activeBotIds?: string[] }
  | { type: 'text_delta'; sessionId: string; botId: string; delta: string }
  | { type: 'tool_status'; sessionId: string; botId: string; toolName: string; status: 'running' | 'done'; summary?: string }
  | { type: 'message_created'; message: MessageRecord }
  /** 编辑用户消息后：锚点之后的历史已被截断、锚点内容已更新，客户端应重新拉取消息列表 */
  | { type: 'messages_truncated'; sessionId: string; anchorMessageId: string }
  /** BOT 通过 botd ask 发起的人机协同交互请求 */
  | { type: 'interaction_request'; sessionId: string; ask: PendingAskRecord }
  /** 人机协同交互已完成响应 */
  | { type: 'interaction_resolved'; sessionId: string; askId: string; answer: string }
  /** 新文件产物上传通知 */
  | { type: 'artifact_created'; sessionId: string; artifact: ArtifactRecord };

/** 节点上下线通知（按节点 owner 用户广播） */
export type NodeStatusSseEvent = { type: 'node_status'; nodeId: string; status: 'online' | 'offline' };

/** 全局 SSE（GET /api/events）事件：会话事件 + 节点状态事件 */
export type GlobalSseEvent = SessionSseEvent | NodeStatusSseEvent;

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
    version?: string;
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
    replyToBotId?: string;
    /** 若为 true，仅向公屏插入消息并广播 SSE，不触发大模型推理回合 */
    noTurn?: boolean;
    /** 若指定正整数秒数，则在 Hub 上创建一个 once 延时触发器，到点再唤醒 */
    delaySeconds?: number;
  }): Promise<{ ok: true; scheduledTriggerId?: string } | void>;
  requestHumanInput(input: {
    sessionId: string;
    botId: string;
    prompt: string;
    options?: string[];
    timeoutSeconds?: number;
    previewType?: AskPreviewType;
    previewContent?: string;
  }): Promise<{ answer: string }>;
  uploadArtifact(input: {
    sessionId: string;
    botId?: string;
    filename: string;
    mimeType?: string;
    contentBase64: string;
    message?: string;
  }): Promise<ArtifactRecord>;
  downloadArtifact(artifactId: string): Promise<{
    artifact: ArtifactRecord;
    contentBase64: string;
  }>;
  listSessionArtifacts(sessionId: string): Promise<ArtifactRecord[]>;
}

export interface NodeRpcFunctions {
  restartDaemon(): Promise<{ ok: true; pid: number }>;
  checkUpgrade?(options?: { registryUrl?: string }): Promise<NodeUpgradeCheckResult>;
  upgradeDaemon?(options?: { targetVersion?: string; registryUrl?: string }): Promise<NodeUpgradeResult>;
  getModelCatalog(): Promise<ModelCatalog>;
  getCommands(botId: string): Promise<ChatCommand[]>;
  startProviderLogin(input: { providerId: string; method: ProviderAuthType }): Promise<ProviderLoginState>;
  getProviderLogin(loginId: string): Promise<ProviderLoginState>;
  respondProviderLogin(input: { loginId: string; promptId: string; value: string }): Promise<ProviderLoginState>;
  cancelProviderLogin(loginId: string): Promise<void>;
  logoutProvider(providerId: string): Promise<void>;
  saveBot(bot: BotConfig, systemMd: string): Promise<void>;
  deleteBot(botId: string): Promise<void>;
  readFile(target: { kind: 'system' | 'memory' | 'env' | 'skill' | 'extension'; botId?: string; id: string }): Promise<string>;
  writeFile(target: { kind: 'system' | 'memory' | 'env' | 'skill' | 'extension'; botId?: string; id: string }, content: string): Promise<void>;
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
    /** Attachments sent in incremental user messages for this turn */
    attachments?: MessageAttachment[];
    /** Upstream artifacts automatically synced across nodes for this turn */
    incomingArtifacts?: IncomingArtifactRef[];
  }): Promise<{
    replyText: string;
    modelBadge: string;
    toolCalls?: ToolCallRecord[];
    usage?: TurnUsage;
  }>;
  cancelTurn(sessionId: string, botId: string): Promise<void>;
  /** 删除该 BOT 在指定会话的本地 Pi 会话文件（.jsonl），下一回合将从 Hub 历史全量重建上下文 */
  resetSession(sessionId: string, botId: string): Promise<void>;
  listBgJobs?(filter?: { sessionId?: string; botId?: string }): Promise<BgJobRecord[]>;
  getBgJobLogs?(jobId: string, tailLines?: number): Promise<{ job: BgJobRecord; logs: string }>;
  killBgJob?(jobId: string): Promise<BgJobRecord>;
}

// HTTP shapes shared by the browser and Hub. Responses contain these values directly.
export interface NodeWithBots extends NodeRecord { bots: BotConfig[] }
export interface SaveBotInput extends Omit<BotConfig, 'updatedAt'> { systemMd: string }
export interface CreateSessionInput {
  title: string;
  mode: SessionMode;
  leadBotId: string;
  memberBotIds: string[];
  parallelRoundtable?: boolean;
  parentSessionId?: string;
}
export interface NodeIdentity { nodeId: string; name: string; hubUrl: string; token: string }
export interface PairingResult { code: string; expiresAt: string }
export interface ApiError { error: string }

export type ProviderAuthType = 'api_key' | 'oauth';
export interface ModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  /** Thinking levels this model supports, derived from the SDK model schema. */
  thinkingLevels?: ThinkingLevel[];
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
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);

export const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
export const isSafeId = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_ID_REGEX.test(value);

export const BOT_ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_BOT_ENV_KEYS = new Set(['PATH', 'PWD', 'HOME', 'USER', 'SHELL']);
export const isValidBotEnvKey = (key: unknown): key is string =>
  typeof key === 'string' &&
  BOT_ENV_KEY_REGEX.test(key) &&
  !RESERVED_BOT_ENV_KEYS.has(key.toUpperCase()) &&
  !key.toUpperCase().startsWith('BOTD_');

export const isBotConfig = (value: unknown): value is BotConfig => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    isSafeId(v.id) &&
    isSafeId(v.nodeId) &&
    typeof v.name === 'string' && v.name.trim().length > 0 &&
    typeof v.description === 'string' &&
    typeof v.modelProvider === 'string' &&
    v.modelProvider.trim().length > 0 &&
    typeof v.modelId === 'string' &&
    v.modelId.trim().length > 0 &&
    (v.thinkingLevel === undefined || isThinkingLevel(v.thinkingLevel)) &&
    Array.isArray(v.enabledSkills) &&
    v.enabledSkills.every(isSafeId) &&
    (v.enabledExtensions === undefined || (Array.isArray(v.enabledExtensions) && v.enabledExtensions.every(isSafeId))) &&
    (v.visibility === undefined || v.visibility === 'private' || v.visibility === 'team')
  );
};

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
