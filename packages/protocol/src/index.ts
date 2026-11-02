export * from './cron.js';
export * from './ui-catalog.js';

export type PlatformType = 'darwin' | 'linux' | 'win32';
export type SessionMode = 'direct' | 'lead';
export type SessionStatus = 'idle' | 'running' | 'queued' | 'failed';
export type MessageRole = 'user' | 'assistant' | 'callback' | 'system';

export interface ToolCallRecord {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  summary?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  durationMs?: number;
  outputPreview?: string;
  isError?: boolean;
}

export type TurnBlock =
  | {
      type: 'thinking';
      thinking: string;
      status?: 'running' | 'done';
      durationMs?: number;
    }
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'tool';
      id: string;
      name: string;
      args?: Record<string, unknown>;
      summary?: string;
      status: 'running' | 'done' | 'error' | 'cancelled';
      durationMs?: number;
      outputPreview?: string;
      isError?: boolean;
    };

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

export type AskPreviewType = 'diff' | 'markdown' | 'text' | 'ui';
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

export type SubagentColor = 'blue' | 'purple' | 'red' | 'emerald' | 'amber' | 'cyan' | 'pink' | 'indigo';
export type SubagentToolScope = 'all' | 'readonly' | 'custom';
export type SubagentIsolation = 'off' | 'worktree';

export interface SubagentSteerRecord {
  message: string;
  timestamp: string;
  mode?: 'steer' | 'resume';
}

export interface SubagentRunRecord {
  id: string;
  subagentId: string;
  subagentName?: string;
  color?: SubagentColor;
  task: string;
  phase?: string;
  status: 'running' | 'done' | 'error' | 'stopped' | 'skipped';
  toolCount?: number;
  currentTool?: string;
  durationMs?: number;
  replyPreview?: string;
  /** 分身完整回复或错误输出（不截断，供详情抽屉查看） */
  replyFull?: string;
  /** 分身执行过程中的工具调用记录列表 */
  toolCalls?: ToolCallRecord[];
  /** 运行过程中收到的 steer / resume 追加指令历史 */
  steers?: SubagentSteerRecord[];
}

export interface QueueStageSummary {
  id: string;
  botIds: string[];
  parallel?: boolean;
  loopGroupId?: string;
  whisper?: boolean;
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
  /** 若为角色分身（Subagent），指向所属主 BOT ID；为空则表示节点主 BOT */
  parentBotId?: string;
  /** 分身是否跟随主 BOT 模型 */
  inheritModel?: boolean;
  /** 分身是否继承主 BOT 全部技能 */
  inheritSkills?: boolean;
  /** 分身徽标颜色 */
  color?: SubagentColor;
  /** 分身工具权限范围：all（全量读写）| readonly（只读分析）| custom（自定义工具） */
  toolScope?: SubagentToolScope;
  /** 当 toolScope === 'custom' 时允许调用的工具名列表 */
  customTools?: string[];
  /** 分身工作区隔离模式：off（共享主工作区）| worktree（独立 Git 分支） */
  isolation?: SubagentIsolation;
}

/** Discoverable Pi commands. Names preserve Pi syntax, including the skill: prefix. */
export interface ChatCommand {
  name: string;
  description?: string;
  source: 'skill' | 'prompt' | 'extension' | 'builtin';
  argumentHint?: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  mode: SessionMode;
  leadBotId: string;
  memberBotIds: string[];
  /** 群成员在本会话中的本群头衔 / 临时角色（botId -> roleText） */
  memberRoles?: Record<string, string>;
  /** 群聊备忘录 / 共享黑板（置顶注入上下文的共识、约束与进度） */
  blackboard?: string;
  status: SessionStatus;
  activeBotId?: string;
  /** 圆桌并发盲评或并行工作流阶段同时处于活跃推理中的 BOT ID 列表 */
  activeBotIds?: string[];
  /** 当前排队中的工作流阶段摘要（实时队列可视化） */
  queuePlan?: QueueStageSummary[];
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
    'id' | 'title' | 'mode' | 'leadBotId' | 'memberBotIds' | 'memberRoles' | 'blackboard' | 'createdAt' | 'updatedAt'
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
  /** 耳语/子线程隔离目标 BOT 列表（非空时对其他旁观 BOT 隐藏增量上下文） */
  whisperTargetBotIds?: string[];
  /** 本条消息触发或声明的轻量工作流编排表达式（如 "(@a @b) -> @lead"） */
  orchestrationPlan?: string;
  /** 主 BOT 调用分身协同的执行轨迹列表（用于渲染分身协同折叠面板） */
  subagentRuns?: SubagentRunRecord[];
  toolCalls?: ToolCallRecord[];
  blocks?: TurnBlock[];
  usage?: TurnUsage;
  attachments?: MessageAttachment[];
  /** 本回合被用户手动中止时为 true：保留已产生的部分输出，不再继续路由 */
  aborted?: boolean;
  createdAt: string;
}

export type SessionSseEvent =
  | {
      type: 'session_status';
      sessionId: string;
      status: SessionStatus;
      activeBotId?: string;
      activeBotIds?: string[];
      queuePlan?: QueueStageSummary[];
    }
  | {
      type: 'session_updated';
      sessionId: string;
      blackboard?: string;
      memberRoles?: Record<string, string>;
    }
  | {
      type: 'subagent_status';
      sessionId: string;
      botId: string;
      run: SubagentRunRecord;
    }
  | { type: 'text_delta'; sessionId: string; botId: string; delta: string }
  | {
      type: 'thinking_stream';
      sessionId: string;
      botId: string;
      delta?: string;
      status: 'running' | 'done';
      durationMs?: number;
    }
  | {
      type: 'tool_status';
      sessionId: string;
      botId: string;
      toolCallId?: string;
      toolName: string;
      status: 'running' | 'done' | 'error';
      summary?: string;
      args?: Record<string, unknown>;
      outputPreview?: string;
      durationMs?: number;
      isError?: boolean;
    }
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
    thinkingDelta?: string;
    thinkingStatus?: 'running' | 'done';
    thinkingDurationMs?: number;
    toolCallId?: string;
    toolName?: string;
    toolStatus?: 'running' | 'done' | 'error';
    toolSummary?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
    toolDurationMs?: number;
    toolIsError?: boolean;
    subagentEvent?: {
      id: string;
      subagentId: string;
      task: string;
      status: 'running' | 'done' | 'error' | 'stopped';
      result?: string;
      error?: string;
      durationMs?: number;
      toolUses?: number;
      currentTool?: string;
      toolCalls?: ToolCallRecord[];
      steers?: SubagentSteerRecord[];
    };
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
    blocks?: TurnBlock[];
    usage?: TurnUsage;
    subagentRuns?: SubagentRunRecord[];
    /** 回合被用户中止时为 true：调用方应持久化已收集的部分输出而非当作失败丢弃 */
    aborted?: boolean;
  }>;
  cancelTurn(sessionId: string, botId: string): Promise<void>;
  /** 当主会话正在运行（特别是等待分身执行）时，注入用户新消息并将正在阻塞等待的分身切为后台，让主 Bot 立即接管响应 */
  steerBotTurn?(sessionId: string, botId: string, message: string): Promise<{ accepted: boolean }>;
  /** 单独停止某一个正在运行的子代理（按 runId） */
  stopSubagent?(sessionId: string, botId: string, runId: string): Promise<{ ok: boolean; error?: string }>;
  /** 直接向某个子代理发送 steer（运行中插话）或 resume（结束后继续追问） */
  interactSubagent?(input: {
    sessionId: string;
    botId: string;
    runId: string;
    subagentId?: string;
    message: string;
    mode: 'steer' | 'resume';
  }): Promise<{ ok: boolean; run?: SubagentRunRecord; error?: string }>;
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
  memberRoles?: Record<string, string>;
  blackboard?: string;
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
    (v.visibility === undefined || v.visibility === 'private' || v.visibility === 'team') &&
    (v.parentBotId === undefined || v.parentBotId === '' || isSafeId(v.parentBotId)) &&
    (v.inheritModel === undefined || typeof v.inheritModel === 'boolean') &&
    (v.inheritSkills === undefined || typeof v.inheritSkills === 'boolean') &&
    (v.color === undefined || typeof v.color === 'string') &&
    (v.toolScope === undefined || v.toolScope === 'all' || v.toolScope === 'readonly' || v.toolScope === 'custom') &&
    (v.customTools === undefined || (Array.isArray(v.customTools) && v.customTools.every((t) => typeof t === 'string'))) &&
    (v.isolation === undefined || v.isolation === 'off' || v.isolation === 'worktree')
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
