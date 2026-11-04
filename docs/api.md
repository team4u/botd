# HTTP 与 RPC API 参考

botd Hub 提供 HTTP REST 接口、SSE 实时事件流，以及 WebSocket Birpc 双向通信通道。[返回文档目录](README.md)

## 接口目录

| 模块 | 路径范围 | 核心功能 |
| :--- | :--- | :--- |
| [架构与通信协议](#架构与通信协议) | `/api/*`, `/ws/node` | 系统通信平面与端口规范。 |
| [鉴权与安全](#鉴权与安全) | 全局 | Cookie、Node 令牌与限流规则。 |
| [认证与用户管理](#认证与用户管理路由) | `/api/auth/*` | 登录、登出与用户信息。 |
| [节点管理](#节点管理路由) | `/api/nodes/*` | 节点配对、状态与模型目录。 |
| [Bot 管理](#bot-管理路由) | `/api/bots/*` | Bot 增删改查、指令与扩展绑定。 |
| [会话管理](#会话管理路由) | `/api/sessions/*` | 会话列表、详情与原语操作。 |
| [消息管理](#消息管理路由) | `/api/sessions/:id/messages` | 消息投递、撤回与多模态输入。 |
| [Super-agent 运行时](#super-agent-运行时路由) | `/api/workers/*`, `/api/asks/*` | 后台 Worker 调度、人机确认与插话。 |
| [全局与节点资产](#全局与节点资产直管路由) | `/api/skills/*`, `/api/extensions/*` | 技能包与扩展包多文件管理。 |
| [模型与供应商](#模型目录与供应商认证路由) | `/api/models/*`, `/api/providers/*` | 集中凭据托管与模型目录检视。 |
| [产物与触发器](#产物与触发器路由) | `/api/artifacts/*`, `/api/triggers/*` | 文件上传下载与自动化触发器。 |
| [出站通知通道](#出站通知通道路由) | `/api/notification-channels/*` | Webhook 与 IM 渠道配置。 |
| [SSE 实时事件流](#sse-实时事件流定义) | `/api/sessions/:id/events` | 增量消息、思考流与节点状态。 |
| [WebSocket RPC 契约](#websocket-birpc-契约定义) | `/ws/node` | 文件操作、Shell 执行与 Worktree。 |

## 架构与通信协议

系统通信分为三个平面：

| 通信平面 | 协议 | 路径 | 说明 |
| --- | --- | --- | --- |
| 客户端交互 | HTTP REST | `/api/*` | 会话管理、Bot 配置与人工协同交互。 |
| 实时事件广播 | SSE（Server-Sent Events） | `/api/sessions/:id/events`，`/api/events` | 会话流式输出、工具状态与节点在线通知。 |
| 节点远端执行 | WebSocket Birpc | `/ws/node` | Hub 与 Node 之间的双向 RPC 通道。 |

本地开发时，Hub 服务端口为 `3002`，前端 Vite 代理入口为 `3001`。生产部署默认使用 `3000` 端口。

## 鉴权与安全

### 凭据类型

Hub 支持三种身份鉴权方式：

1. Cookie 会话：浏览器或 CLI 登录 `POST /api/auth/login` 成功后，Hub 写入 `botd_token` Cookie（HttpOnly，有效期 7 天）。
2. Node 令牌：Node 守护进程在请求头中携带 `x-botd-node-id` 与 `x-botd-node-token`。
3. 签名令牌：用于外部 Webhook 与通知交互回调（HMAC-SHA256）。

### 免登录公开路由

以下路由允许匿名访问：

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/nodes/pairing/exchange`
- `POST /api/webhooks/:token`
- `GET /api/public/*`
- `POST /api/public/*`

### 请求体大小限制

中间件强制执行请求体大小限制：

- 产物上传路由（`/api/sessions/:id/artifacts`）：上限 `100MB`。
- Webhook 路由（`/api/webhooks/*`）：上限 `64KB`。
- 其余 API 路由（`/api/*`）：上限 `1MB`。

---

## 认证与用户管理路由

### POST /api/auth/login

用户登录并获取会话 Cookie。

请求体：

```json
{
  "username": "admin",
  "password": "your-password"
}
```

响应（200 OK）：

```json
{
  "ok": true,
  "user": {
    "id": "user_admin",
    "username": "admin",
    "role": "admin"
  }
}
```

### POST /api/auth/logout

登出当前会话并删除客户端 Cookie。

响应（200 OK）：

```json
{
  "ok": true
}
```

### GET /api/auth/me

获取当前登录用户的账户信息。

响应（200 OK）：

```json
{
  "authenticated": true,
  "user": {
    "id": "user_admin",
    "username": "admin",
    "role": "admin"
  }
}
```

### GET /api/users

列出全部用户账户（需要管理员角色）。

响应（200 OK）：

```json
[
  {
    "id": "user_admin",
    "username": "admin",
    "role": "admin",
    "createdAt": "2026-11-01T00:00:00.000Z"
  }
]
```

### POST /api/users

创建新用户（需要管理员角色）。

请求体：

```json
{
  "username": "alice",
  "password": "secret-password",
  "role": "member"
}
```

响应（201 Created）：

```json
{
  "id": "user_abc123",
  "username": "alice",
  "role": "member",
  "createdAt": "2026-11-04T12:00:00.000Z"
}
```

### DELETE /api/users/:id

删除指定用户（禁止删除内置自举管理员 `user_admin`）。

### PUT /api/users/:id/password

修改指定用户密码。Hub 自动递增该用户的 token epoch，迫使其旧 Cookie 失效。

请求体：

```json
{
  "password": "new-strong-password"
}
```

### POST /api/nodes/pairing

创建节点配对码。

响应（200 OK）：

```json
{
  "code": "849201",
  "expiresAt": "2026-11-04T12:10:00.000Z"
}
```

### POST /api/nodes/pairing/exchange

节点凭配对码完成密钥交换，获取节点身份与访问令牌。

请求体：

```json
{
  "code": "849201",
  "name": "developer-laptop",
  "platform": "linux"
}
```

响应（200 OK）：

```json
{
  "nodeId": "node_9f8e7d",
  "token": "tok_sec_1a2b3c4d5e"
}
```

### GET /api/health

检查 Hub 服务健康状态与数据库可用性。

响应（200 OK）：

```json
{
  "ok": true
}
```

---

## 节点管理路由

### GET /api/nodes

列出当前连接的节点及其承载的 Bot 列表。

响应（200 OK）：

```json
[
  {
    "id": "node_9f8e7d",
    "name": "developer-laptop",
    "platform": "linux",
    "status": "online",
    "skills": ["git-review"],
    "extensions": ["notify-ext"],
    "visibility": "private",
    "ownerId": "user_admin",
    "lastSeenAt": "2026-11-04T12:00:00.000Z",
    "createdAt": "2026-11-01T00:00:00.000Z",
    "pid": 12345,
    "version": "0.2.0",
    "bots": []
  }
]
```

### DELETE /api/nodes/:nodeId

删除已离线的节点元数据。节点在线时拒绝删除并返回 `409 Conflict`。

### POST /api/nodes/:nodeId/install

向指定节点安装 Skill 或 Extension 资产。

请求体：

```json
{
  "source": "github:user/skill-repo",
  "kind": "skill",
  "customId": "my-skill"
}
```

### POST /api/nodes/:nodeId/restart

远程请求节点重启守护进程。

### GET /api/nodes/:nodeId/upgrade/check

检查节点是否存在可用的程序升级版本。

### POST /api/nodes/:nodeId/upgrade

触发指定节点的自动升级流程。

---

## Bot 管理路由

### GET /api/bots

列出当前用户有权访问的全部 Bot。

### POST /api/bots

创建新 Bot。

请求体：

```json
{
  "id": "reviewer",
  "nodeId": "node_9f8e7d",
  "name": "代码评审员",
  "description": "分析代码差异并提供重构建议",
  "modelProvider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "thinkingLevel": "medium",
  "enabledSkills": ["git-review"],
  "enabledExtensions": [],
  "systemMd": "你是一个严格的代码评审助手。",
  "workspaceDir": "/home/user/project"
}
```

### PUT /api/bots/:botId

修改指定 Bot 的配置属性。

### DELETE /api/bots/:botId

删除指定 Bot。

### GET /api/bots/:botId/files/:kind

读取指定 Bot 的系统提示词（`system`）或长期记忆（`memory`）。

响应（200 OK）：

```json
{
  "content": "# 系统提示词内容\n..."
}
```

### PUT /api/bots/:botId/files/:kind

写入指定 Bot 的 `system` 或 `memory` 文件内容。

请求体：

```json
{
  "content": "新的提示词正文"
}
```

### GET /api/bots/:botId/env

读取指定 Bot 的私有环境变量列表（返回值屏蔽具体敏感密钥）。

### PUT /api/bots/:botId/env

配置 Bot 私有环境变量。

请求体：

```json
{
  "env": {
    "GITHUB_TOKEN": "ghp_xxx"
  },
  "merge": true
}
```

### DELETE /api/bots/:botId/env/:key

删除 Bot 的指定私有环境变量。

### GET /api/bots/:botId/commands

获取指定 Bot 支持的斜杠指令列表。Hub 聚合该 Bot 启用的技能（含父分身继承列表）与扩展，提取 frontmatter 描述直接返回。零节点在线时仍可正常使用。节点在线时自动追加其自定义指令并按名称去重。

响应示例：

```json
[
  {
    "name": "code-review",
    "description": "分析代码差异并提供评审建议",
    "source": "skill"
  },
  {
    "name": "github-helper",
    "description": "扩展 github-helper",
    "source": "extension"
  }
]
```

---

## 会话管理路由

### GET /api/sessions

列出当前用户的会话。

### POST /api/sessions

创建新对话会话。

请求体：

```json
{
  "title": "项目重构讨论",
  "leadBotId": "reviewer",
  "workspaceDir": "/home/user/project"
}
```

### PATCH /api/sessions/:id

修改会话标题、主导 Bot 或归档状态。

请求体：

```json
{
  "title": "已更新的会话标题",
  "archived": true
}
```

### DELETE /api/sessions/:id

彻底删除会话及其历史消息记录。

### DELETE /api/sessions/:id/messages

清空会话全部历史消息，并重置 Bot 本地会话。

### POST /api/sessions/:id/cancel

取消正在执行的会话推理回合。

### POST /api/sessions/:id/fork

从指定锚点消息派生新会话。

请求体：

```json
{
  "anchorMessageId": "msg_001"
}
```

### GET /api/sessions/:id/subsessions

获取当前父会话派生的全部独立子会话。

### GET /api/sessions/:id/share

获取会话的公开分享记录。

### POST /api/sessions/:id/share

创建或更新会话的公开分享链接。

请求体：

```json
{
  "regenerate": false
}
```

### DELETE /api/sessions/:id/share

吊销会话的公开分享凭据。

### GET /api/public/shares/:token

公开只读访问已分享的会话快照（无需登录）。

### GET /api/public/shares/:token/artifacts/:artifactId/content

公开下载分享会话中的产物文件。

---

## 消息管理路由

### GET /api/sessions/:id/messages

获取会话的完整历史消息列表。

### POST /api/sessions/:id/messages

向会话发送用户消息，触发后台推理回合。支持纯文本、斜杠指令与多模态图片附件。

请求体：

```json
{
  "content": "请结合架构图分析代码结构",
  "attachments": [
    {
      "type": "image",
      "mimeType": "image/png",
      "data": "iVBORw0KGgoAAAANSUhEUgAA..."
    }
  ]
}
```

响应（202 Accepted）：返回新创建的用户消息记录。

### PUT /api/sessions/:id/messages/:messageId

编辑已发送的用户消息。Hub 委托 pi-durable 原生原语回滚上下文至该消息前，更新文本并重新触发推理。

请求体：

```json
{
  "content": "修改后的提问文本"
}
```

### GET /api/messages/search

跨会话全文检索历史消息内容。

查询参数：
- `q`：搜索关键字（必填）。
- `sessionId`：可选限制会话 ID。
- `limit`：最大返回条数（默认 30）。

---

## Super-agent 运行时路由

### GET /api/sessions/:id/workers

获取会话当前的后台 Worker 列表及其执行状态。

响应（200 OK）：

```json
{
  "workers": [
    {
      "workerId": "wrk_123",
      "conversationId": "conv_456",
      "parentSessionId": "sess_1",
      "botId": "reviewer",
      "title": "模块解耦",
      "kind": "worker",
      "status": "running",
      "worktreePath": "/repo/.botd-worktrees/wrk_123",
      "threadKeys": ["ci-check"],
      "startedAt": "2026-11-04T12:00:00.000Z"
    }
  ]
}
```

### POST /api/sessions/:id/workers

派生新后台 Worker 执行长耗时任务。

请求体：

```json
{
  "title": "重构认证模块",
  "task": "拆分登录逻辑并补齐单元测试",
  "botId": "reviewer",
  "worktree": true,
  "threadKey": "ci-check"
}
```

响应（201 Created）：

```json
{
  "ok": true,
  "worker": {
    "workerId": "wrk_123",
    "title": "重构认证模块",
    "status": "running"
  }
}
```

### POST /api/sessions/:id/workers/:workerId/steer

向执行中的 Worker 注入追加消息。

请求体：

```json
{
  "message": "优先处理编译报错",
  "mode": "steer"
}
```

### POST /api/sessions/:id/workers/:workerId/stop

终止指定的后台 Worker。

响应（200 OK）：

```json
{
  "ok": true
}
```

### GET /api/sessions/:id/workers/:workerId/recall

提取 Worker 的回忆链（Chain-of-Recall）节点及最近 Transcript 记录。

响应（200 OK）：

```json
{
  "node": {
    "id": "wrk_123",
    "kind": "worker",
    "summary": "重构认证模块",
    "createdAt": "2026-11-04T12:00:00.000Z"
  },
  "transcript": [
    {
      "id": "ent_1",
      "kind": "message",
      "role": "assistant",
      "text": "已创建隔离分支并完成代码修改。"
    }
  ]
}
```

### GET /api/sessions/:id/asks

列出会话当前等待人工确认的 Ask 记录。

### POST /api/sessions/:id/asks

手动创建人机协同 Ask 请求并广播 SSE。

请求体：

```json
{
  "prompt": "是否确认部署到预发环境？",
  "options": ["批准", "拒绝"],
  "timeoutSeconds": 300,
  "previewType": "markdown",
  "previewContent": "本次部署涉及 3 个模块修改。"
}
```

### POST /api/sessions/:id/asks/:askId/respond

回答指定的人机协同 Ask 请求。

请求体：

```json
{
  "answer": "批准"
}
```

### GET / POST /api/public/asks/:askId/respond

免登录公开回答 Ask 请求（通过 HMAC 签名令牌鉴权）。

### POST /api/events/ingest

将外部事件摄入 EventRouter 管线。

请求体：

```json
{
  "source": "github",
  "type": "pull_request.opened",
  "title": "PR #42 opened",
  "content": "用户提交了新功能代码",
  "repo": "team4u/botd",
  "prNumber": 42
}
```

### GET /api/watchdog/health

获取 Durable Runtime 系统健康诊断报告。

查询参数：
- `runPass=1`：先触发一轮主动巡检，再输出报告。

响应（200 OK）：

```json
{
  "healthy": true,
  "summary": "全部运行时组件正常",
  "findings": [],
  "interventions": []
}
```

---

## 全局与节点资产直管路由

### Skills 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/skills` | 列出 Hub 全局托管的 Skills 列表。 |
| GET | `/api/skills/:skillId` | 获取全局 Skill 内容。支持 `?path=` 查询包内相对文件。 |
| PUT | `/api/skills/:skillId` | 写入全局 Skill 内容。支持单文件或多文件对象字典。 |
| DELETE | `/api/skills/:skillId` | 删除全局 Skill。 |
| GET | `/api/nodes/:nodeId/skills/:skillId` | 获取指定节点专属 Skill 内容。 |
| PUT | `/api/nodes/:nodeId/skills/:skillId` | 写入指定节点专属 Skill 内容。 |
| DELETE | `/api/nodes/:nodeId/skills/:skillId` | 删除指定节点专属 Skill。 |

GET 响应示例：

```json
{
  "content": "---\nname: review\ndescription: 代码评审\n---\n正文",
  "files": ["SKILL.md", "references/guide.md"]
}
```

PUT 请求体格式（单文件或多文件包）：

```json
{
  "files": {
    "SKILL.md": "---\nname: review\ndescription: 代码评审\n---\n正文",
    "references/guide.md": "# 评审指南"
  }
}
```

### Extensions 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/extensions` | 列出 Hub 全局托管的 Extensions 列表。 |
| GET | `/api/extensions/:extId` | 获取全局 Extension 代码。支持 `?path=` 查询包内相对文件。 |
| PUT | `/api/extensions/:extId` | 写入全局 Extension 代码。支持单文件或多文件对象字典。 |
| DELETE | `/api/extensions/:extId` | 删除全局 Extension。 |
| GET | `/api/nodes/:nodeId/extensions/:extId` | 获取指定节点专属 Extension 内容。 |
| PUT | `/api/nodes/:nodeId/extensions/:extId` | 写入指定节点专属 Extension 内容。 |
| DELETE | `/api/nodes/:nodeId/extensions/:extId` | 删除指定节点专属 Extension。 |

---

## 模型目录与供应商认证路由

### GET /api/models/catalog

查询可用模型供应商及其支持的模型目录。

### 全局凭据管理路由（免指定 nodeId）

- `POST /api/providers/:providerId/login`：发起供应商登录流程（请求体 `{"method": "api_key" | "oauth"}`）。
- `GET /api/provider-logins/:loginId`：查询登录流程状态。
- `POST /api/provider-logins/:loginId/respond`：提交认证交互输入（请求体 `{"promptId": "...", "value": "..."}`）。
- `DELETE /api/provider-logins/:loginId`：取消进行中的登录流程。
- `DELETE /api/providers/:providerId/auth`：删除供应商认证凭据。
- `GET /api/providers/:providerId/credentials`：查询供应商认证类型。

### 节点专属凭据路由

路由前缀为 `/api/nodes/:nodeId/providers/:providerId/*` 与 `/api/nodes/:nodeId/provider-logins/:loginId/*`，参数格式与全局路由保持完全一致。

---

## 产物与触发器路由

### 产物管理

- `POST /api/sessions/:id/artifacts`：上传产物文件（Multipart 包含 `file`，可选 `botId` 与 `message`）。
- `GET /api/sessions/:id/artifacts`：列出会话关联的产物记录列表。
- `GET /api/artifacts/:artifactId/content`：下载产物文件二进制数据。

### 触发器与自动化

- `GET /api/sessions/:id/triggers`：列出会话的触发器。
- `POST /api/sessions/:id/triggers`：创建新触发器。
- `PATCH /api/triggers/:triggerId`：修改触发器配置。
- `DELETE /api/triggers/:triggerId`：删除触发器。
- `POST /api/triggers/:triggerId/run`：手动立即触发一次任务。
- `POST /api/webhooks/:token`：接收外部 Webhook 触发。
- `GET /api/sessions/:id/automation-events`：查看会话的 Webhook 事件收件箱。

---

## 出站通知通道路由

- `GET /api/sessions/:id/channels`：列出会话配置的通知通道。
- `POST /api/sessions/:id/channels`：创建新通知通道（`webhook` / `feishu` / `slack` / `telegram`）。
- `GET /api/sessions/:id/outbox`：查询通知出站队列投递记录。
- `PATCH /api/channels/:channelId`：修改通知通道配置。
- `DELETE /api/channels/:channelId`：删除通知通道。
- `POST /api/channels/:channelId/test`：向通道发送测试通知。

---

## SSE 实时事件流定义

### GET /api/sessions/:id/events

订阅单个会话的实时事件。连接创建后立即推送当前状态快照，每 15 秒下发一次 `:ping` 保活包。

### GET /api/events

全局事件流（当前登录用户）。推送该用户全部会话的事件与节点上下线状态。

### 事件类型字典

| 事件类型 (`type`) | 关键字段 | 说明 |
| --- | --- | --- |
| `session_status` | `sessionId`, `status`, `activeBotId`, `queuePlan` | 会话状态修改（`idle` / `running` / `queued` / `failed`）。 |
| `subagent_status` | `sessionId`, `botId`, `run` | 子代理执行生命周期修改。 |
| `text_delta` | `sessionId`, `botId`, `delta` | 模型回复增量文本。 |
| `thinking_stream` | `sessionId`, `botId`, `delta`, `status`, `durationMs` | 思考模型推理流式输出。 |
| `tool_status` | `sessionId`, `botId`, `toolName`, `status`, `uiSpec` | 工具调用状态（`running` / `done` / `error`）。 |
| `message_created` | `message` | 新消息持久化落库。 |
| `messages_truncated` | `sessionId`, `anchorMessageId` | 消息历史截断通知，客户端需重新拉取。 |
| `interaction_request` | `sessionId`, `ask` | 触发人机协同确认请求。 |
| `interaction_resolved` | `sessionId`, `askId`, `answer` | 人机协同已获人工答复。 |
| `artifact_created` | `sessionId`, `artifact` | 会话产物文件上传通知。 |
| `extension_ui` | `sessionId`, `botId`, `event` | Extension 动态 UI 交互载荷。 |
| `node_status` | `nodeId`, `status` | 全局流独有：节点上线或离线状态修改。 |
| `hello` | 无 | 全局流独有：握手成功确认。 |

---

## WebSocket Birpc 契约定义

Node 与 Hub 通过 WebSocket `/ws/node` 创建 Birpc 双向调用通道。

### Node 侧提供：NodeEnvRpcFunctions

Hub 通过该接口远程调用 Node 宿主机的文件系统与命令执行环境（Brain in Hub, Hands on Node）。所有二进制内容采用 Base64 编码传输。

```typescript
export interface NodeEnvRpcFunctions {
  // 路径与文件读写
  envAbsolutePath(input: { path: string; cwd?: string }): Promise<RpcResult<string>>;
  envJoinPath(input: { parts: string[]; cwd?: string }): Promise<RpcResult<string>>;
  envReadTextFile(input: { path: string; cwd?: string }): Promise<RpcResult<string>>;
  envReadTextLines(input: { path: string; maxLines?: number; cwd?: string }): Promise<RpcResult<string[]>>;
  envReadBinaryFile(input: { path: string; cwd?: string }): Promise<RpcResult<{ base64: string }>>;
  envWriteFile(input: { path: string; content: string; encoding?: 'utf8' | 'base64'; cwd?: string }): Promise<RpcResult<null>>;
  envAppendFile(input: { path: string; content: string; encoding?: 'utf8' | 'base64'; cwd?: string }): Promise<RpcResult<null>>;
  envTruncateFile(input: { path: string; size: number; cwd?: string }): Promise<RpcResult<null>>;
  envRenameFile(input: { sourcePath: string; destinationPath: string; cwd?: string }): Promise<RpcResult<null>>;

  // 元数据与目录查询
  envFileInfo(input: { path: string; cwd?: string }): Promise<RpcResult<RpcFileInfo>>;
  envListDir(input: { path: string; cwd?: string }): Promise<RpcResult<RpcFileInfo[]>>;
  envListFiles(input: { path: string; cwd?: string }): Promise<RpcResult<{ entries: { path: string; kind: RpcFileKind }[]; truncated: boolean }>>;
  envCanonicalPath(input: { path: string; cwd?: string }): Promise<RpcResult<string>>;
  envExists(input: { path: string; cwd?: string }): Promise<RpcResult<boolean>>;

  // 目录与临时文件创建
  envCreateDir(input: { path: string; recursive?: boolean; cwd?: string }): Promise<RpcResult<null>>;
  envRemove(input: { path: string; recursive?: boolean; force?: boolean; cwd?: string }): Promise<RpcResult<null>>;
  envCreateTempDir(input: { prefix?: string; cwd?: string }): Promise<RpcResult<string>>;
  envCreateTempFile(input: { prefix?: string; suffix?: string; cwd?: string }): Promise<RpcResult<string>>;

  // 流式分块游标读取器
  envOpenTextLineReader(input: { path: string; cwd?: string }): Promise<RpcResult<RpcTextReaderHandle>>;
  envTextReaderRead(input: { readerId: string }): Promise<RpcResult<RpcTextLine | null>>;
  envTextReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;

  envOpenBinaryReader(input: { path: string; noFollow?: boolean; cwd?: string }): Promise<RpcResult<RpcBinaryReaderHandle>>;
  envBinaryReaderInfo(input: { readerId: string }): Promise<RpcResult<RpcFileInfo>>;
  envBinaryReaderRead(input: { readerId: string; offset: number; length: number }): Promise<RpcResult<{ base64: string; byteLength: number }>>;
  envBinaryReaderScanLines(input: { readerId: string; startLine: number; endLine?: number }): Promise<RpcResult<RpcLineScan>>;
  envBinaryReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;

  envOpenDirReader(input: { path: string; cwd?: string }): Promise<RpcResult<RpcDirReaderHandle>>;
  envDirReaderNext(input: { readerId: string; maxEntries: number }): Promise<RpcResult<{ entries: RpcFileInfo[]; done: boolean }>>;
  envDirReaderClose(input: { readerId: string }): Promise<RpcResult<null>>;

  // Shell 命令执行与终止
  envExec(input: EnvExecInput): Promise<RpcResult<EnvExecOk>>;
  envAbortExec(execId: string): Promise<void>;
  envCleanup(cwd?: string): Promise<void>;

  // Git Worktree 并发隔离
  envAcquireWorktree(input: EnvAcquireWorktreeInput): Promise<EnvAcquireWorktreeResult>;
  envReleaseWorktree(input: EnvReleaseWorktreeInput): Promise<EnvReleaseWorktreeResult>;
}
```

### Hub 侧提供：HubEnvStreamFunctions

Node 侧在执行 `envExec` 命令产生输出分块时，向 Hub 侧实时回调流式结果。

```typescript
export interface HubEnvStreamFunctions {
  onEnvExecOutput(event: EnvExecOutputEvent): void;
}
```

载荷结构说明：

```typescript
export interface EnvExecOutputEvent {
  execId: string;
  text: string;
  stream: 'stdout' | 'stderr';
  skipped?: {
    bytes: number;
    newlines: number;
    endsWithNewline: boolean;
  };
}
```
