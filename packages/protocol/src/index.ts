export * from './cron.js';
export * from './env-rpc.js';
export * from './ui-catalog.js';

import type { BotdUiSpec } from './ui-catalog.js';
import type { HubEnvStreamFunctions, NodeEnvRpcFunctions } from './env-rpc.js';

export type PlatformType = 'darwin' | 'linux' | 'win32';
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
  /** 工具返回的声明式 UI 规格（如扩展工具在 details.ui 中返回的合法 BotdUiSpec），供前端 tool.view 插槽直接渲染 */
  uiSpec?: BotdUiSpec;
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
      /** 工具返回的声明式 UI 规格（tool.view 插槽），与 ToolCallRecord.uiSpec 同源 */
      uiSpec?: BotdUiSpec;
    };

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type AskPreviewType = 'diff' | 'markdown' | 'text' | 'ui';
export type ResourceVisibility = 'private' | 'team';

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
  createdAt: string;
  expiresAt?: string;
}

export type TriggerKind = 'webhook' | 'cron' | 'once';

/** 触发器分发模式：append 追加唤醒到目标会话；subsession 自动派生独立子会话执行 */
export type TriggerDispatchMode = 'append' | 'subsession';

/** Webhook 事件过滤条件：三项均指定时需全部匹配才触发 */
export interface TriggerEventFilter {
  /** 事件来源，如 'github'、'webhook' */
  source?: string;
  /** 允许的事件类型列表（如 ['pull_request.opened', 'push']） */
  types?: string[];
  /** JSON body 顶层键值精确匹配 */
  payloadMatch?: Record<string, string | number | boolean>;
}

export interface TriggerRecord {
  id: string;
  sessionId: string;
  botId: string;
  name: string;
  kind: TriggerKind;
  /** For webhook triggers: secret token used in POST /api/webhooks/:token */
  token?: string;
  /** For webhook triggers: optional HMAC-SHA256 secret; when set, requests must carry a matching x-hub-signature-256 / x-botd-signature header */
  secret?: string;
  /** Standard 5-field cron expression (server local time), required for kind='cron' */
  cronExpr?: string;
  /** ISO timestamp when a one-shot trigger (kind='once') should fire */
  runAt?: string;
  prompt: string;
  enabled: boolean;
  /** 分发模式：默认 'append'（唤醒目标会话），'subsession' 时自动派生子会话执行 */
  dispatchMode?: TriggerDispatchMode;
  /** 可选 skill id：触发时在 prompt 前加 `/skill:<skillId> ` 前缀 */
  skillId?: string;
  /** Webhook 事件过滤条件（仅 kind='webhook' 生效） */
  eventFilter?: TriggerEventFilter;
  lastTriggeredAt?: string;
  createdAt: string;
}

export interface CreateTriggerInput {
  name: string;
  botId: string;
  kind: TriggerKind;
  /** HMAC secret for webhook signature verification (kind='webhook') */
  secret?: string;
  cronExpr?: string;
  /** ISO timestamp or delaySeconds for kind='once' */
  runAt?: string;
  delaySeconds?: number;
  prompt: string;
  enabled?: boolean;
  dispatchMode?: TriggerDispatchMode;
  skillId?: string;
  eventFilter?: TriggerEventFilter;
}

/** 自动化事件记录：Webhook 收到的每次触发（Event Inbox，持久化去重与载荷文件化） */
export interface AutomationEventRecord {
  id: string;
  triggerId: string;
  sessionId: string;
  /** 派生出的子会话 id（dispatchMode='subsession' 时存在） */
  childSessionId?: string;
  /** 事件来源：'github' / body.source / 默认 'webhook' */
  source: string;
  /** 事件类型：github 拼接 action（如 pull_request.opened）/ body.type / 默认 'webhook.received' */
  eventType: string;
  /** 去重键：x-botd-dedup 或 x-github-delivery 头 */
  dedupKey?: string;
  /** 摘要：payload message/text 或事件类型描述 */
  summary: string;
  /** 事件载荷落盘的 Artifact id（event_<id>.json） */
  payloadArtifactId?: string;
  createdAt: string;
}

/** 工作区代码变更文件状态：M 修改 / A 新增 / D 删除 / R 重命名 / U 冲突 */
export type WorkspaceDiffStatus = 'M' | 'A' | 'D' | 'R' | 'U';

/** 工作区单个文件的变更摘要（含 unified diff 文本，可能截断） */
export interface WorkspaceDiffFile {
  path: string;
  status: WorkspaceDiffStatus;
  additions: number;
  deletions: number;
  diff: string;
  truncated?: boolean;
}

/** 工作区代码变更查询结果：非 Git 工作区时 files 为空数组 */
export interface WorkspaceDiffResult {
  isGitRepo: boolean;
  repoRoot: string;
  branch?: string;
  files: WorkspaceDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  truncated?: boolean;
}

export interface MessageSearchHit {
  message: MessageRecord;
  sessionTitle: string;
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
  /** 若该执行步骤对应跨 BOT 派生的独立子会话，记录其子会话 ID（供前端点击直接打开子会话抽屉） */
  childSessionId?: string;
  /** 本次运行的启动时间（ISO），供检视抽屉合成消息时间戳与日期分隔线 */
  startedAt?: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  toolCount?: number;
  currentTool?: string;
  durationMs?: number;
  replyPreview?: string;
  /** 子代理完整回复或错误输出（不截断，供详情抽屉查看） */
  replyFull?: string;
  /** 子代理执行过程中的交错时间线（思考/工具/文本流，与主对话 blocks 同构） */
  blocks?: TurnBlock[];
  /** 子代理执行过程中的工具调用记录列表 */
  toolCalls?: ToolCallRecord[];
  /** 运行过程中收到的 steer / resume 追加指令历史 */
  steers?: SubagentSteerRecord[];
}

export interface QueueStageSummary {
  id: string;
  botIds: string[];
  parallel?: boolean;
}

/** 可用项目 Space（真实项目目录）：供会话/Bot 绑定工作区时选择 */
export interface WorkspaceSpaceInfo {
  path: string;
  name: string;
  branch?: string;
  isGitRepo: boolean;
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
  /** 若为子代理（Subagent），指向所属主 BOT ID；为空则表示节点主 BOT */
  parentBotId?: string;
  /** 子代理是否跟随主 BOT 模型 */
  inheritModel?: boolean;
  /** 子代理是否继承主 BOT 全部技能 */
  inheritSkills?: boolean;
  /** 子代理徽标颜色 */
  color?: SubagentColor;
  /** 子代理工具权限范围：all（全量读写）| readonly（只读分析）| custom（自定义工具） */
  toolScope?: SubagentToolScope;
  /** 当 toolScope === 'custom' 时允许调用的工具名列表 */
  customTools?: string[];
  /** 子代理工作区隔离模式：off（共享主工作区）| worktree（独立 Git 分支） */
  isolation?: SubagentIsolation;
  /** 绑定的真实项目目录（Space）：设置后回合以该目录为 cwd 运行 */
  workspaceDir?: string;
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
  leadBotId: string;
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
  /** 会话创建者 ID */
  ownerId?: string;
  /** 绑定的真实项目目录（Space）：回合以该目录为 cwd 运行 */
  workspaceDir?: string;
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
    'id' | 'title' | 'leadBotId' | 'createdAt' | 'updatedAt'
  >;
  bots: SharedBotSummary[];
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
}

export type NotificationChannelKind = 'webhook' | 'feishu' | 'slack' | 'telegram';
export type NotificationEventKind = 'assistant_reply' | 'ask_request' | 'wakeup';
/** 按需通知策略：always 全量推送；needed 仅异常与人工审批推送；never 静默不推送 */
export type NotificationTellPolicy = 'always' | 'needed' | 'never';

export interface NotificationChannelRecord {
  id: string;
  sessionId: string;
  name: string;
  kind: NotificationChannelKind;
  targetUrl: string;
  secret?: string;
  events: NotificationEventKind[];
  tellPolicy?: NotificationTellPolicy;
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
  tellPolicy?: NotificationTellPolicy;
  enabled?: boolean;
}

/** 通知出站队列记录：持久化发送队列，失败后按指数退避重试，超过上限标记 dead */
export interface NotificationOutboxRecord {
  id: string;
  channelId: string;
  sessionId: string;
  eventKind: NotificationEventKind;
  status: 'pending' | 'sent' | 'dead';
  attemptCount: number;
  nextRetryAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
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
  /** 主 BOT 调用子代理协同的执行轨迹列表（用于渲染子代理协同折叠面板） */
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
      /** 工具自定义视图插槽（tool.view）：扩展工具返回的合法 BotdUiSpec */
      uiSpec?: BotdUiSpec;
    }
  | { type: 'message_created'; message: MessageRecord }
  /** 编辑用户消息后：锚点之后的历史已被截断、锚点内容已更新，客户端应重新拉取消息列表 */
  | { type: 'messages_truncated'; sessionId: string; anchorMessageId: string }
  /** BOT 通过 botd ask 发起的人机协同交互请求 */
  | { type: 'interaction_request'; sessionId: string; ask: PendingAskRecord }
  /** 人机协同交互已完成响应 */
  | { type: 'interaction_resolved'; sessionId: string; askId: string; answer: string }
  /** 新文件产物上传通知 */
  | { type: 'artifact_created'; sessionId: string; artifact: ArtifactRecord }
  /** 扩展 UI 实时事件（notify / status / working_message / widget / editor_text） */
  | {
      type: 'extension_ui';
      sessionId: string;
      botId: string;
      event: ExtensionUiStreamPayload;
    };

/** 节点上下线通知（按节点 owner 用户广播） */
export type NodeStatusSseEvent = { type: 'node_status'; nodeId: string; status: 'online' | 'offline' };

/** 全局 SSE（GET /api/events）事件：会话事件 + 节点状态事件 */
export type GlobalSseEvent = SessionSseEvent | NodeStatusSseEvent;

/** 扩展挂件插槽位置：输入框上方 / 下方 */
export type ExtensionWidgetPlacement = 'aboveEditor' | 'belowEditor';

/** 扩展 UI 实时事件（ctx.ui 桥接到 Web 端的流式载荷） */
export type ExtensionUiStreamPayload =
  | {
      kind: 'notify';
      message: string;
      notifyType?: 'info' | 'warning' | 'error';
    }
  | {
      kind: 'status';
      statusKey: string;
      statusText?: string;
    }
  | {
      kind: 'working_message';
      message?: string;
    }
  | {
      kind: 'widget';
      widgetKey: string;
      /** undefined 表示清除该挂件 */
      lines?: string[];
      uiSpec?: BotdUiSpec;
      placement?: ExtensionWidgetPlacement;
    }
  | {
      kind: 'editor_text';
      text: string;
      mode?: 'set' | 'paste';
    };

/** 资源包内单个文件：文本以 utf8 存内容，二进制以 base64 存载荷（保真传输）。 */
export interface ResourcePackageFile {
  /** 包内 POSIX 相对路径（不得逃逸包根） */
  path: string;
  /** 文件内容（utf8 文本） */
  content?: string;
  /** 二进制内容（base64；与 content 二选一） */
  contentBase64?: string;
  /** 是否可执行位 */
  executable?: boolean;
}

/** 资源包：Skill / Extension 的完整多文件目录快照（安装产物与远端传输的统一形态）。 */
export interface ResourcePackage {
  kind: 'skill' | 'extension';
  id: string;
  /** 包内全部文件（排除 .git；扩展包可含自有 node_modules 依赖） */
  files: ResourcePackageFile[];
  /** 包根 package.json 的 name（依赖安装与入口解析用；可缺省） */
  packageName?: string;
  /** 入口文件相对路径（Skill 为 SKILL.md，Extension 为入口 ts/js） */
  entry?: string;
}

/** 解码后的包文件（Hub 侧落盘用）。 */
export interface DecodedPackageFile {
  path: string;
  data: Buffer;
  executable: boolean;
}

/** 判断包文件是否按二进制传输：非文本扩展名或显式标记二进制的内容走 base64。 */
const BINARY_PATH_PATTERN = /\.(png|jpe?g|gif|webp|bmp|ico|svgz|pdf|zip|gz|tgz|tar|bz2|7z|rar|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|wav|ogg|wasm|node|exe|dll|so|dylib|class|jar|sqlite3?|db)$/i;
const TEXTUAL_PATH_PATTERN = /\.(md|markdown|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|env|ts|tsx|mts|cts|js|mjs|cjs|jsx|css|scss|less|html?|xml|svg|csv|tsv|sh|bash|zsh|fish|ps1?|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sql|graphql|gql|proto|lock|gitignore|npmignore|editorconfig|prettieri(?:gn)?rc|babelrc|eslintrc?)$/i;

export function isBinaryPackageFilePath(filePath: string): boolean {
  if (BINARY_PATH_PATTERN.test(filePath)) return true;
  if (TEXTUAL_PATH_PATTERN.test(filePath)) return false;
  // 无扩展名或未知扩展名（LICENSE / CHANGELOG / Makefile 等）按文本处理
  return false;
}

/** 把包文件编码为传输形态：文本保内容，二进制保 base64（载荷损坏时抛错，不静默吞错）。 */
export function encodePackageFile(path: string, data: Buffer, executable = false): ResourcePackageFile {
  if (isBinaryPackageFilePath(path)) {
    return { path, contentBase64: data.toString('base64'), ...(executable ? { executable: true } : {}) };
  }
  const text = data.toString('utf8');
  // utf8 往返校验：含非法序列的“文本”必须走 base64，否则落盘即损坏
  if (Buffer.byteLength(text, 'utf8') !== data.length || Buffer.from(text, 'utf8').equals(data) === false) {
    return { path, contentBase64: data.toString('base64'), ...(executable ? { executable: true } : {}) };
  }
  return { path, content: text, ...(executable ? { executable: true } : {}) };
}

/** 解码包文件为原始字节；既无 content 又无 contentBase64 视为损坏载荷并抛错。 */
export function decodePackageFile(file: ResourcePackageFile): DecodedPackageFile {
  const data = file.content !== undefined
    ? Buffer.from(file.content, 'utf8')
    : file.contentBase64 !== undefined
      ? Buffer.from(file.contentBase64, 'base64')
      : undefined;
  if (data === undefined) {
    throw new Error(`Resource package file "${file.path}" has neither content nor contentBase64`);
  }
  return { path: file.path, data, executable: file.executable === true };
}

export interface HubSessionRpcFunctions {
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
}

/** Hub 侧 RPC：Node 连接管理函数 + Node 侧流式输出回调（envExec 分块回传）。 */
export interface HubRpcFunctions extends HubSessionRpcFunctions, Partial<HubEnvStreamFunctions> {}

export interface NodeSessionRpcFunctions {
  restartDaemon(): Promise<{ ok: true; pid: number }>;
  checkUpgrade?(options?: { registryUrl?: string }): Promise<NodeUpgradeCheckResult>;
  upgradeDaemon?(options?: { targetVersion?: string; registryUrl?: string }): Promise<NodeUpgradeResult>;
  deleteBot(botId: string): Promise<void>;
  installResource(input: {
    source: string;
    kind?: 'auto' | 'skill' | 'extension';
    customId?: string;
  }): Promise<{
    kind: 'skill' | 'extension';
    id: string;
  }>;
  /** 读取节点本地资源包完整目录（多文件 + 二进制保真），供 Hub 落盘为权威存储。 */
  readResourcePackage(target: {
    kind: 'skill' | 'extension';
    id: string;
  }): Promise<ResourcePackage>;
}

/** Node 侧 RPC：既有回合/资源函数 + 远端执行环境函数（birpc 双向通道的 Node 端；env 方法可选以兼容旧连接/测试 mock）。 */
export interface NodeRpcFunctions extends NodeSessionRpcFunctions, Partial<NodeEnvRpcFunctions> {}

// HTTP shapes shared by the browser and Hub. Responses contain these values directly.
export interface NodeWithBots extends NodeRecord { bots: BotConfig[] }
export interface SaveBotInput extends Omit<BotConfig, 'updatedAt'> { systemMd: string }
export interface CreateSessionInput {
  title: string;
  leadBotId: string;
  parentSessionId?: string;
  workspaceDir?: string;
}
export interface NodeIdentity { nodeId: string; name: string; hubUrl: string; token: string }
export interface PairingResult { code: string; expiresAt: string }

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

/** 会话级模型覆盖：只作用于单个会话，不改动全局 Bot 配置，兄弟会话不受影响 */
export interface SessionModelOverride {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

/** 会话当前生效的模型：存在覆盖时即覆盖值，否则为 Bot 默认配置 */
export interface SessionModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

/** GET/PUT /api/sessions/:id/model 响应：覆盖、生效配置与是否恢复了失败回合 */
export interface SessionModelConfig {
  override: SessionModelOverride | null;
  effective: SessionModelSelection;
  resumed?: boolean;
}

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
    // 模型允许为空字符串：未选型/注销供应商联动满空的 Bot 是合法的「待配置」态，
    // 界面引导选型即可；非空时仍必须是字符串。
    typeof v.modelProvider === 'string' &&
    typeof v.modelId === 'string' &&
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
    (v.isolation === undefined || v.isolation === 'off' || v.isolation === 'worktree') &&
    (v.workspaceDir === undefined || typeof v.workspaceDir === 'string')
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
