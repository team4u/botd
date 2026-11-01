# botd 轻量级多节点个人 BOT 平台 — 技术设计文档（AI 编程蓝图版）

> **产品名称**：`botd`\
> **文档版本**：v2.2（AI 编程可执行级完整版）\
> **日期**：2026-10-31\
> **状态**：工程实现基线（包含真实 SDK 签名、完整类型契约与核心状态机实现）\
> **写作规范**：ASD-STE100（受控技术语言：一词一义、全主动语态、短句单命题、零歧义）\
> **核心依赖**：`@earendil-works/pi-coding-agent`、ActionDock CLI（`ad`）、Herdr CLI（`herdr`）

***

## 1. 系统概述

### 1.1 系统定位

`botd` 是一个遵循 UNIX 设计哲学、以 Web/PWA 为统一入口的多节点个人 AI `BOT` 平台。

1. 用户在 `Cloud Hub` 注册多台计算设备（`Node`）。
2. 用户在指定 `Node` 上创建多个独立的 `BOT`（配置不同模型、角色与技能）。
3. 每个 `BOT` 物理上对应所属 `Node` 文件系统中的一个独立文件夹。
4. `BOT` 通过阅读 `Skill` 文档（`SKILL.md`）并调用本机 CLI（如 `ad`、`herdr`）完成任务。
5. 用户可发起单聊，或将跨 `Node`、跨模型的多个 `BOT` 拉入同一个群聊 `Session`（设 `Lead BOT`），实现多模型视角自然呈现与跨设备接力协作。

### 1.2 核心设计规则

1. **100% 自包含隔离**：`Node Agent` 将 `Pi SDK` 作为内部 npm 库调用。`Node Agent` 将所有配置、密钥、`Skill` 与会话文件存储在独立的 `~/.botd/` 目录下，不读取且不污染宿主机的 `~/.pi/` 目录。
2. **一切皆目录**：一个 `BOT` 等于所属 `Node` 上的 `~/.botd/bots/<botId>/` 目录。该目录包含 `bot.json`、`SYSTEM.md`、`MEMORY.md`、`workspace/` 与 `sessions/`。
3. **零业务 Adapter**：系统不编写 `ad-adapter` 或 `herdr-actions` 包装代码。`BOT` 直接通过 `SKILL.md` 学习命令行用法，并通过内置 `bash` 工具执行 `ad` CLI 与 `herdr` CLI。
4. **拉群协作与 `@` 传麦**：单聊与群聊共用统一的 `Session` 模型。在群聊中，人类或 `BOT` 通过在正文中输出 `@<botId>` 触发目标 `BOT` 接力发言。
5. **公屏共享结论，私域隔离草稿**：群聊中的多个 `BOT` 仅共享公屏最终发言；每个 `BOT` 执行 `bash`、读写文件的中间过程仅保存在各自 `Node` 本地的 `.jsonl` 会话文件中，互不污染上下文。
6. **非阻塞执行与 `botd wake` 唤醒**：长耗时任务（如 `herdr` 驱动的编程任务）在后台非阻塞运行。当状态变更时，外部工具通过调用本机命令 `botd wake` 向原 `Session` 注入 `Wake-up Message`，唤醒 `BOT` 在群内或单聊中汇报结果。

### 1.3 MVP 非目标（不做事项）

1. 系统不实现细粒度工具权限表（`ActionGrant`）、委托权限表（`DelegateGrant`）、人工审批弹窗状态机或 Schema 哈希冻结逻辑。
2. 系统不在 `Node` 上运行常驻的 `AD Server`（`ad serve`）进程。
3. 系统不实现 `BOT` 跨 `Node` 自动迁移、负载均衡或隐式故障转移。
4. 系统不引入重型第三方 Agent 编排平台（如 LangGraph、Dify、CrewAI、LibreChat）。
5. 系统不修改 ActionDock、Herdr 或 Pi SDK 的核心源码。

### 1.4 受控术语表（ASD-STE100 Approved Terms）

| 受控术语              | 定义                                                            |
| :---------------- | :------------------------------------------------------------ |
| `Cloud Hub`       | 运行在云服务器上的控制面服务，负责 Web API、元数据缓存与群聊路由                          |
| `Node`            | 一台运行 `Node Agent` 的物理机、虚拟机或容器环境                               |
| `Cloud Node`      | 与 `Cloud Hub` 部署在同一台云服务器上的 `Node`                             |
| `Node Agent`      | 运行在 `Node` 上的常驻守护进程（命令名为 `botd`），维持 WSS 连接并承载 `Pi SDK`        |
| `BOT`             | 归属于固定 `Node` 的智能体实例，物理上对应 `~/.botd/bots/<botId>/` 目录          |
| `Pi SDK`          | `Node Agent` 内部引用的推理与工具执行库（`@earendil-works/pi-coding-agent`） |
| `Skill`           | 存储在 `~/.botd/skills/<skillId>/SKILL.md` 的能力说明文件               |
| `Session`         | 单聊或群聊会话实例，包含 `direct`、`lead`、`roundtable` 三种模式                |
| `Lead BOT`        | 群聊 `Session` 的群负责人 `BOT`，负责默认接话、任务分发与阶段总结                     |
| `Member BOT`      | 参与群聊 `Session` 的成员 `BOT`（含 `Lead BOT`）                        |
| `Wake-up Message` | `botd wake` 触发后，系统向指定 `Session` 自动追加的回调触发消息                   |

***

## 2. 总体架构

### 2.1 部署与组件拓扑

```mermaid
flowchart TB
    U[用户浏览器 / PWA] -->|HTTPS / Hono RPC + SSE| HUB

    subgraph CLOUD[云服务器]
      HUB[Cloud Hub\nHono / node:sqlite / Group Router]
      CNA[Cloud Node Agent: botd\nPi SDK + ~/.botd]
      CAD[ad CLI / 云端 CLI 工具]
      HUB <-->|birpc over ws://127.0.0.1| CNA
      CNA -->|spawn CLI| CAD
    end

    subgraph MAC[Mac Node]
      MNA[Mac Node Agent: botd\nPi SDK + ~/.botd]
      MAD[ad CLI]
      HERDR[herdr CLI + Herdr Daemon]
      AGENTS[Claude Code / Codex / Cursor]
      MNA -->|spawn CLI| MAD
      MNA -->|spawn CLI| HERDR
      HERDR -->|Socket / Pane| AGENTS
      HERDR -.->|Event Hook: botd wake| MNA
    end

    MNA <-->|birpc over WSS (partysocket)| HUB
```

### 2.2 权威数据源划分

| 数据类别                  | 权威数据源（Source of Truth）                              | `Cloud Hub` 角色                          |
| :-------------------- | :-------------------------------------------------- | :-------------------------------------- |
| `Node` 注册信息与在线状态      | `Cloud Hub`（SQLite）                                 | 权威存储                                    |
| 模型凭证（API Key / OAuth） | 各 `Node` 本地 `~/.botd/.agent/auth.json`                | 不存储任何 Key，仅转发登录交互与状态                  |
| `BOT` 配置与 `SYSTEM.md` | `Node` 本地 `~/.botd/bots/<botId>/`                   | 缓存列表，转发 Web 读写请求                        |
| `BOT` 长期记忆            | `Node` 本地 `~/.botd/bots/<botId>/MEMORY.md`          | 不存储，按需通过 RPC 读取或修改                      |
| `Node` 可用 `Skill`     | `Node` 本地 `~/.botd/skills/<skillId>/SKILL.md`       | 缓存 `skillId` 列表，转发 Web 读写请求             |
| `Session` 公屏聊天记录      | `Cloud Hub`（SQLite `messages` 表）                    | 权威存储，按增量同步给参会 `BOT`                     |
| `BOT` 私域推理与工具日志       | `Node` 本地 `bots/<botId>/sessions/<sessionId>.jsonl` | 不存储完整工具输出，仅通过 SSE 转发实时状态                |

***

## 3. 节点文件系统与自包含隔离规范

### 3.1 独立数据根目录（`~/.botd/`）

`Node Agent` 必须将所有文件存储在 `~/.botd/`（可通过 `--data-dir` 环境变量或参数覆盖）：

```text
~/.botd/
├── node.json                        # { nodeId, name, hubUrl, token }
├── agent.sock                       # 本地 Unix Domain Socket（供 botd wake 调用）
├── .agent/                          # 独立的 SDK 凭据与模型目录配置（auth.json 凭据、models.json 自定义供应商）
├── skills/                          # 本节点公共 Skill 池
│   ├── ad-core/
│   │   └── SKILL.md                 # 由 ad export skill 导出
│   ├── herdr/
│   │   └── SKILL.md                 # Herdr 官方 skills/herdr/SKILL.md
│   └── custom-sop/
│       └── SKILL.md                 # 用户在 Web 创建或由 BOT 自生成的 Skill
└── bots/                            # 本节点所有 BOT 实例目录
    ├── pm-claude/
    │   ├── bot.json                 # BotConfig JSON 文件
    │   ├── SYSTEM.md                # 角色人设与基础指令
    │   ├── MEMORY.md                # 长期记忆文件
    │   ├── workspace/               # 默认工作目录（cwd）
    │   └── sessions/                # Pi SDK 本地会话文件 (.jsonl)
    │       └── sess_01J9X.jsonl
    └── mac-coder/
        └── ...
```

### 3.2 宿主机完全隔离规则

1. **禁用宿主机扫描**：`Node Agent` 显式自定义 `Pi SDK` 的资源与设置加载，禁止扫描宿主机的 `~/.pi/` 及工作区上级的 `.pi/` 目录。
2. **绑定独立工作区**：`Node Agent` 将 `Pi SDK` 的 `cwd` 固定设置为 `~/.botd/bots/<botId>/workspace/`。
3. **显式注入 `Skill` 文件**：`Node Agent` 读取 `bot.json` 中的 `enabledSkills` 数组，仅加载 `~/.botd/skills/<skillId>/SKILL.md`。
4. **级联模型凭证（不读 `~/.pi`）**：
   * `Node Agent` 的模型凭证保存在节点本地 `~/.botd/.agent/auth.json`（Web 节点登录流程写入的 Pi SDK 凭据）。
   * 若宿主机存在显式声明的 `BOTD_API_KEY_<PROVIDER>` 环境变量（如 `BOTD_API_KEY_ANTHROPIC`），则优先使用该环境变量。

### 3.3 `BOT` 系统提示词组装模板

`Node Agent` 在调用 `Pi SDK` 前，按以下固定模板拼接系统提示词：

```markdown
<!-- 1. 来自 bots/<botId>/SYSTEM.md -->
{SYSTEM_MD_CONTENT}

<!-- 2. 来自 bots/<botId>/MEMORY.md -->
## 长期记忆 (MEMORY.md)
{MEMORY_MD_CONTENT}
（说明：你可以使用 edit/write 工具修改 `../MEMORY.md` 来更新长期记忆；当用户要求你学习某个本机 CLI 工具并保存为 Skill 时，可执行 `<cli> --help` 并将总结写入 `../../../skills/<skillId>/SKILL.md`。）

<!-- 3. 当前会话与群成员上下文（由 Cloud Hub 传入） -->
## 当前会话环境
- 当前 Session ID: `{SESSION_ID}`
- 当前 BOT ID: `@{BOT_ID}`
- 如需通过后台脚本或 Herdr Event Hook 异步唤醒当前会话，请执行命令：
  `botd wake --session {SESSION_ID} --bot {BOT_ID} --message "状态说明"`
{GROUP_CONTEXT_PROMPT}

<!-- 4. 已启用的 Skills 内容 -->
{ENABLED_SKILLS_CONTENT}
```

***

## 4. 共享类型与协议契约（`packages/protocol/src/index.ts`）

**AI 编程指令**：请直接在 `packages/protocol/src/index.ts` 中原样实现以下全部类型定义，前后端与节点端必须共同引用此包。

```ts
// packages/protocol/src/index.ts

export type PlatformType = 'darwin' | 'linux' | 'win32';
export type SessionMode = 'direct' | 'lead' | 'roundtable';
export type SessionStatus = 'idle' | 'running' | 'failed';
export type MessageRole = 'user' | 'assistant' | 'callback' | 'system';

export interface NodeRecord {
  id: string;
  name: string;
  platform: PlatformType;
  status: 'online' | 'offline';
  skills: string[];
  lastSeenAt: string;
  createdAt: string;
}

export interface BotConfig {
  id: string;                    // 仅允许 [a-zA-Z0-9_-]，如 "pm-claude" | "mac-coder"
  nodeId: string;
  name: string;
  description: string;
  modelProvider: string;         // 如 "anthropic" | "openai" | "google" | "deepseek"
  modelId: string;               // 如 "claude-sonnet-4-20250514"
  thinkingLevel?: 'low' | 'medium' | 'high';
  enabledSkills: string[];
  updatedAt: string;
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

// SSE 推送给前端浏览器的实时事件契约
export type SessionSseEvent =
  | { type: 'session_status'; sessionId: string; status: SessionStatus; activeBotId?: string }
  | { type: 'text_delta'; sessionId: string; botId: string; delta: string }
  | { type: 'tool_status'; sessionId: string; botId: string; toolName: string; status: 'running' | 'done'; summary?: string }
  | { type: 'message_created'; message: MessageRecord };

// Cloud Hub 暴露给 Node Agent 调用的 birpc 接口
export interface HubRpcFunctions {
  registerNode(info: {
    nodeId: string;
    name: string;
    platform: PlatformType;
    bots: BotConfig[];
    skills: string[];
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

// Node Agent 暴露给 Cloud Hub 调用的 birpc 接口
export interface NodeRpcFunctions {
  saveBot(bot: BotConfig, systemMd: string): Promise<void>;
  deleteBot(botId: string): Promise<void>;

  readFile(target: { kind: 'system' | 'memory' | 'skill'; botId?: string; id: string }): Promise<string>;
  writeFile(target: { kind: 'system' | 'memory' | 'skill'; botId?: string; id: string }, content: string): Promise<void>;

  runTurn(input: {
    sessionId: string;
    botId: string;
    groupContextPrompt: string;
    incrementalMessages: string;
  }): Promise<{
    replyText: string;
    modelBadge: string;
  }>;

  cancelTurn(sessionId: string, botId: string): Promise<void>;
}
```

***

## 5. 核心实现蓝图（供 AI 编程直接参考）

### 5.1 `Node Agent` 调用 `Pi SDK` 的标准实现模板

**AI 编程指令**：`@earendil-works/pi-coding-agent` 必须使用 `createAgentSession` 工厂函数，禁止臆造 `new PiAgent()`。参考以下标准实现编写 `apps/node/src/runtime.ts`：

```ts
// apps/node/src/runtime.ts 核心参考实现
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type { BirpcReturn } from 'birpc';
import type { HubRpcFunctions, NodeRpcFunctions, BotConfig } from '@botd/protocol';

const activeSessions = new Map<string, AgentSession>(); // key: `${sessionId}:${botId}`

export async function executeBotTurn(
  dataDir: string,
  bot: BotConfig,
  input: Parameters<NodeRpcFunctions['runTurn']>[0],
  hubRpc: BirpcReturn<HubRpcFunctions, NodeRpcFunctions>
): Promise<{ replyText: string; modelBadge: string }> {
  const botDir = path.join(dataDir, 'bots', bot.id);
  const workspaceDir = path.join(botDir, 'workspace');
  const sessionFile = path.join(botDir, 'sessions', `${input.sessionId}.jsonl`);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });

  // 1. 读取 SYSTEM.md、MEMORY.md 与已启用的 SKILL.md
  const systemMd = await fs.readFile(path.join(botDir, 'SYSTEM.md'), 'utf8').catch(() => '');
  const memoryMd = await fs.readFile(path.join(botDir, 'MEMORY.md'), 'utf8').catch(() => '');
  const skillContents: string[] = [];
  for (const skillId of bot.enabledSkills) {
    const skillPath = path.join(dataDir, 'skills', skillId, 'SKILL.md');
    const content = await fs.readFile(skillPath, 'utf8').catch(() => '');
    if (content) skillContents.push(`### Skill: ${skillId}\nPath: ${skillPath}\n\n${content}`);
  }

  // 2. 注入环境变量供 bash 工具和 botd wake 使用
  process.env.BOTD_SESSION_ID = input.sessionId;
  process.env.BOTD_BOT_ID = bot.id;

  // 3. 创建或打开持久化 .jsonl 会话（与宿主机 ~/.pi 隔离）
  const { session } = await createAgentSession({
    cwd: workspaceDir,
    thinkingLevel: bot.thinkingLevel ?? 'medium',
    settingsManager: SettingsManager.inMemory({
      defaultProvider: bot.modelProvider,
      defaultModel: bot.modelId,
    }),
    sessionManager: SessionManager.open(sessionFile),
  });

  const runKey = `${input.sessionId}:${bot.id}`;
  activeSessions.set(runKey, session);

  // 4. 订阅流式事件并实时上报给 Cloud Hub
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      hubRpc.onSessionStream.asEvent({
        sessionId: input.sessionId,
        botId: bot.id,
        deltaText: event.assistantMessageEvent.delta,
      });
    } else if (event.type === 'tool_execution_start') {
      hubRpc.onSessionStream.asEvent({
        sessionId: input.sessionId,
        botId: bot.id,
        toolName: event.toolName,
        toolStatus: 'running',
      });
    } else if (event.type === 'tool_execution_end') {
      hubRpc.onSessionStream.asEvent({
        sessionId: input.sessionId,
        botId: bot.id,
        toolName: event.toolName,
        toolStatus: 'done',
      });
    }
  });

  try {
    const fullPrompt = [
      `[系统上下文提醒]\n当前 Session ID: ${input.sessionId} | 当前 BOT: @${bot.id}`,
      input.groupContextPrompt,
      systemMd ? `[角色设定]\n${systemMd}` : '',
      memoryMd ? `[长期记忆 (可通过 ../MEMORY.md 更新)]\n${memoryMd}` : '',
      skillContents.length ? `[可用 Skills]\n${skillContents.join('\n\n')}` : '',
      `[最新对话记录]\n${input.incrementalMessages}`,
    ].filter(Boolean).join('\n\n---\n\n');

    await session.prompt(fullPrompt);
    const replyText = session.getLastAssistantText() || '（已完成执行，无文本输出）';
    return { replyText, modelBadge: `${bot.modelProvider}/${bot.modelId}` };
  } finally {
    unsubscribe();
    activeSessions.delete(runKey);
    session.dispose();
  }
}

export async function cancelBotTurn(sessionId: string, botId: string): Promise<void> {
  const session = activeSessions.get(`${sessionId}:${botId}`);
  if (session) {
    await session.abort();
  }
}
```

### 5.2 `Cloud Hub` 群聊路由器与串行队列实现模板（`Group Router`）

**AI 编程指令**：每个 `Session` 必须维护独立的内存串行队列，避免人类发言、`@` 接力与 `botd wake` 回调并发冲突。参考以下逻辑实现 `apps/hub/src/group-router.ts`：

```ts
// apps/hub/src/group-router.ts 核心参考实现
const MENTION_REGEX = /(?:^|\s)@([a-zA-Z0-9_-]+)/g;
const MAX_RELAY_TURNS = 5;

interface QueueItem {
  botId: string;
  wakeupMessage?: string;
}

interface SessionRuntimeState {
  queue: QueueItem[];
  isRunning: boolean;
  relayCount: number;
}

const sessionStates = new Map<string, SessionRuntimeState>();

export function extractMentions(text: string, validBotIds: Set<string>): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(MENTION_REGEX)) {
    const id = match[1];
    if (validBotIds.has(id) && !result.includes(id)) {
      result.push(id);
    }
  }
  return result;
}
```

#### 调度规则（由 `processSessionQueue(sessionId)` 严格执行）：

1. **人类发送消息时**：
   * 将该 `Session` 的 `relayCount` 重置为 `0`。
   * 提取人类消息中的 `@<botId>`：
     * 若存在有效的 `@<botId>`：按出现顺序将这些 `botId` 推入 `state.queue`。
     * 若未包含任何 `@<botId>`：
       * 当 `session.mode === 'direct'` 或 `'lead'` 时：将 `session.leadBotId` 推入 `state.queue`。
       * 当 `session.mode === 'roundtable'` 时：将 `session.memberBotIds` 中除 `leadBotId` 外的成员依次推入 `state.queue`，最后将 `session.leadBotId` 推入队尾。
   * 调用 `processSessionQueue(sessionId)`。
2. **收到 `requestWakeupTurn(sessionId, botId, wakeupMessage)` 时**：
   * 在 `messages` 表插入一条 `role = 'callback'`、`sender_bot_id = botId`、`content = "[Wake-up] " + wakeupMessage` 的消息记录。
   * 将 `{ botId, wakeupMessage }` 推入 `state.queue`，调用 `processSessionQueue(sessionId)`。
3. **`processSessionQueue(sessionId)` 循环逻辑**：
   * 若 `state.isRunning === true`，直接返回（等待当前循环消费）。
   * 设置 `state.isRunning = true`，while (`state.queue.length > 0`)：
     1. 取出队首 `item = state.queue.shift()!`。
     2. 查询 `item.botId` 增量消息（自 `cursor_map[item.botId]` 之后的所有公屏消息）。
     3. 广播 SSE 事件：`{ type: 'session_status', sessionId, status: 'running', activeBotId: item.botId }`。
     4. 通过 `birpc` 调用目标 `Node Agent` 的 `runTurn`。
     5. 将返回的 `replyText` 存入 `messages` 表（`role = 'assistant'`, `sender_bot_id = item.botId`），更新 `cursor_map[item.botId]` 为该新消息 ID，并广播 SSE `message_created`。
     6. `state.relayCount += 1`。
     7. 若 `state.relayCount <= MAX_RELAY_TURNS`：提取 `replyText` 中的 `@<botId>`，将其追加到 `state.queue`。
   * 循环结束：设置 `state.isRunning = false`，广播 SSE `{ type: 'session_status', sessionId, status: 'idle' }`。

### 5.3 `botd` CLI 与本地 Unix Domain Socket 唤醒契约

`apps/node/src/cli.ts` 使用 Node.js 原生 `util.parseArgs` 实现以下 3 个子命令：

1. **`botd join <hubUrl> --code <pairingCode> --name <nodeName>`**：
   * 调用 `POST <hubUrl>/api/nodes/pairing/exchange` 换取 `{ nodeId, token }`，写入 `~/.botd/node.json`。
2. **`botd start`**：
   * 启动 `Node Agent` 守护进程。
   * 建立到 `ws(s)://<hubHost>/ws/node?nodeId=<nodeId>&token=<token>` 的 `partysocket` 连接并绑定 `birpc`。
   * 启动本地 Unix Domain Socket HTTP 服务监听 `~/.botd/agent.sock`：
     * 接收 `POST /wake`，请求体为 `{ sessionId: string, botId: string, message: string }`。
     * 收到后立即调用 `hubRpc.requestWakeupTurn({ sessionId, botId, wakeupMessage: message })`。
3. **`botd wake --session <sessionId> --bot <botId> --message <msg>`**：
   * 若未传 `--session` 或 `--bot`，默认回退读取环境变量 `process.env.BOTD_SESSION_ID` 与 `process.env.BOTD_BOT_ID`。
   * 使用 `node:http` 向 `socketPath: ~/.botd/agent.sock` 发送 `POST /wake` 请求并退出。

***

## 6. 数据库与 HTTP API 规范

### 6.1 `Cloud Hub` SQLite DDL（使用 Node.js 24 原生 `node:sqlite`）

**AI 编程指令**：在 `apps/hub/src/db.ts` 中使用 `import { DatabaseSync } from 'node:sqlite'` 初始化以下 6 张表（多用户：`users` 存放账号；`nodes`/`sessions` 通过 `owner_id` 归属到用户，旧行回填 `user_admin`）：

```sql
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
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  owner_id TEXT
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_id TEXT
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
```

### 6.2 `Cloud Hub` HTTP API 列表（Hono）

认证与归属模型：users 表保存账号（`role` 为 `admin` 或 `member`），首次启动自举固定 id `user_admin` 的 admin 账号。Cookie token 绑定 userId；`nodes`/`sessions` 通过 `owner_id` 归属到用户。列表接口只返回本人数据；所有 `/api/nodes/:nodeId/*`、`/api/bots/*`（经 bot 的 nodeId 判归属）与 `/api/sessions/:id/*` 接口对非 owner 返回 403（资源不存在返回 404）；创建会话要求 lead/member BOT 均归本人。

| 方法                | 路径                                   | 用途                                                                       |
| :---------------- | :----------------------------------- | :----------------------------------------------------------------------- |
| `POST`            | `/api/auth/login`                    | 用户名 + 密码登录（首个自举账号 `admin`，密码由 `BOTD_ADMIN_PASSWORD` 初始化，默认 `admin`）；签发绑定用户的 Cookie（7 天） |
| `GET`             | `/api/auth/me`                       | 返回 `{authenticated: true, user}`（当前登录用户）                                |
| `GET/POST`        | `/api/users`；`PUT /api/users/:id/password`；`DELETE /api/users/:id` | 用户管理（仅 admin）：列出/创建成员、重置密码、删除用户（删自己 400 / 名下有节点 409 / 不存在 404；member 访问 403） |
| `POST`            | `/api/nodes/pairing`                 | 生成 6 位一次性配对码（内存保存 10 分钟，绑定创建者用户）                                  |
| `POST`            | `/api/nodes/pairing/exchange`        | `botd join` 用配对码换取 `{ nodeId, token }`（节点归属到配对码创建者；此接口公开）              |
| `GET`             | `/api/nodes`                         | 返回当前用户拥有的 `NodeRecord`、每个节点下的 `BotConfig[]` 与 `skills[]`；非本人节点接口返回 403 |
| `GET/PUT`         | `/api/nodes/:nodeId/skills/:skillId` | 调用 `nodeRpc.readFile/writeFile` 读取或保存 `SKILL.md`                         |
| `POST/PUT/DELETE` | `/api/bots` / `/api/bots/:botId`     | 调用 `nodeRpc.saveBot/deleteBot` 并更新 Hub `bots` 缓存表                        |
| `GET/PUT`         | `/api/bots/:botId/memory`            | 调用 `nodeRpc.readFile/writeFile` 读取或保存 `MEMORY.md`                        |
| `GET/POST`        | `/api/sessions`                      | 查询会话列表；创建单聊（`direct`）或群聊（`lead` / `roundtable`）                          |
| `PATCH`           | `/api/sessions/:id`                  | 修改群聊标题、`mode`、`leadBotId` 或 `memberBotIds`                               |
| `GET`             | `/api/sessions/:id/messages`         | 获取指定 `Session` 的历史 `MessageRecord[]`                                     |
| `POST`            | `/api/sessions/:id/messages`         | 发送人类消息并启动 `Group Router` 队列                                              |
| `POST`            | `/api/sessions/:id/cancel`           | 清空该 `Session` 队列并调用当前活跃节点的 `cancelTurn`                                  |
| `GET`             | `/api/sessions/:id/events`           | Hono `streamSSE` 接口，实时推送 `SessionSseEvent` JSON                          |

***

## 7. Web / PWA 界面结构

```text
Web / PWA (apps/web)
├── Sidebar (左侧会话导航)
│   ├── [+ 新建单聊]  [+ 新建群聊]
│   ├── 📌 Vibe Coding 群 (mode: lead | 群主: @pm-claude)
│   ├── ☕ 咖啡群 (mode: roundtable | 成员: Claude / GPT / DeepSeek)
│   └── 💬 @daily-bot (mode: direct)
├── Main Chat View (中间主聊天区)
│   ├── Top Bar: 标题 | 模式切换下拉框 (direct/lead/roundtable) | 群成员标签 | [Stop 按钮]
│   ├── Message List:
│   │   ├── 消息气泡顶部显示: `@senderBotId` + 所属节点名 + `modelBadge` 胶囊标签
│   │   ├── 流式输出区: 实时展示当前 `activeBotId` 的 `text_delta` 与 `tool_status`
│   └── Input Box: 支持输入 `@` 弹出可选 `BOT` 列表；回车发送
├── Nodes & BOTs View (节点与 BOT/Skill 管理抽屉或标签页)
│   ├── 按 Node 展示在线状态、本机 Skill 列表（点击可弹窗编辑 SKILL.md，支持 [+ 新建 Skill]）
│   └── BOT 卡片列表（点击可配置模型、勾选 enabledSkills、编辑 SYSTEM.md 与 MEMORY.md）
└── Settings Modal
    ├── 用户管理（仅 admin：创建/删除成员、重置密码）
    └── 点击生成 `botd join` 一键配对命令
```

***

## 8. 开源框架选型与 Monorepo 依赖清单

### 8.1 各子包 `package.json` 依赖清单

| 子包路径                | 必装依赖（`dependencies`）                                                                                       | 说明                                           |
| :------------------ | :--------------------------------------------------------------------------------------------------------- | :------------------------------------------- |
| `packages/protocol` | 无运行时依赖（仅 `typescript`）                                                                                     | 导出第 4 节全部共享接口                                |
| `apps/hub`          | `hono`, `@hono/node-server`, `ws`, `birpc`, `@botd/protocol`                                               | 数据库直接使用内置 `node:sqlite`                      |
| `apps/node`         | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `birpc`, `partysocket`, `ws`, `@botd/protocol` | CLI 与 Socket 直接使用内置 `node:util`, `node:http` |
| `apps/web`          | `react`, `react-dom`, `lucide-react`, `react-markdown`, `tailwindcss`                                      | 通过 `fetch` + `EventSource` 对接 Hub API 与 SSE  |

### 8.2 Monorepo 目录结构

```text
botd/
├── package.json                # pnpm workspace 根配置 (Node >= 24.12.0)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   └── protocol/
│       ├── package.json
│       └── src/index.ts        # 第 4 节完整类型契约
├── apps/
│   ├── hub/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts        # Hono HTTP + WebSocket Upgrade 入口
│   │       ├── db.ts           # node:sqlite 5 张表封装
│   │       ├── ws-hub.ts       # birpc Node 连接池管理
│   │       └── group-router.ts # 第 5.2 节群聊状态机与增量上下文拼接
│   ├── node/
│   │   ├── package.json
│   │   └── src/
│   │       ├── cli.ts          # botd join / start / wake 命令行入口
│   │       ├── daemon.ts       # partysocket 连接 + agent.sock 监听 + 文件读写
│   │       └── runtime.ts      # 第 5.1 节 Pi SDK 隔离调用实现
│   └── web/
│       ├── package.json
│       ├── index.html
│       └── src/
│           ├── App.tsx         # 聊天主界面、群聊创建、Node/BOT/Skill 在线管理
│           └── api.ts          # API 与 EventSource (SSE) 客户端封装
└── deploy/
    └── docker-compose.yml
```

***

## 9. 分阶段实施与验收清单（供 AI 逐步开发验证）

1. **Step 1：初始化 Monorepo 与 `packages/protocol`**
   * 创建 `pnpm-workspace.yaml` 与 `packages/protocol/src/index.ts`，确保类型编译通过。
2. **Step 2：实现 `apps/hub`（数据库 + WSS 连接池 + Group Router + HTTP API）**
   * 启动 `apps/hub`，验证 `node:sqlite` 自动建表成功，`/api/nodes` 返回空数组。
3. **Step 3：实现 `apps/node`（`botd` CLI + `~/.botd` 隔离 + `Pi SDK` 对接 + `agent.sock`）**
   * 在本机运行 `botd start` 自动连入本地 Hub，验证 `~/.botd/` 生成默认 `BOT` 与示例 `Skill`，且不读取宿主机 `~/.pi/`。
4. **Step 4：实现 `apps/web`（单聊与群聊 UI + 在线 Markdown 编辑器 + SSE 流）**
   * 在网页端验证：
     1. 在线新建 `Skill`、在线修改 `SYSTEM.md` 与 `MEMORY.md`。
     2. 创建 `lead` 模式群聊（如 Vibe Coding 群）与 `roundtable` 模式群聊（如 咖啡群），验证 `@<botId>` 自动接力发言与多模型徽章展示。
     3. 在终端执行 `botd wake --session <id> --bot <botId> --message "测试唤醒"`，验证群聊窗口内目标 `BOT` 自动被唤醒并继续发言。

