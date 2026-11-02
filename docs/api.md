# HTTP API 参考

[文档目录](README.md)

本文覆盖 Hub 的全部 HTTP 路由。字段类型以[共享协议](../packages/protocol/src/index.ts)为准。

## 快速上手

以下示例需要 Bash、curl 和 jq。前提：Hub 已启动，节点在线，Bot 已配置可用模型。

本机开发直连 `http://localhost:3002`（启动命令带 `BOTD_PORT=3002`）。浏览器仍从 `http://localhost:3001` 进入。生产部署默认端口为 3000。

### 登录并列出 Bot

```bash
export BOTD_HUB_URL='http://localhost:3002'
export BOTD_COOKIE_FILE="$(mktemp)"
chmod 600 "$BOTD_COOKIE_FILE"
read -r -s -p 'Hub 密码: ' BOTD_LOGIN_PASSWORD
printf '\n'

jq -n --arg password "$BOTD_LOGIN_PASSWORD" \
  '{username:"admin", password:$password}' |
  curl --fail-with-body -sS -c "$BOTD_COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    --data-binary @- "$BOTD_HUB_URL/api/auth/login"
unset BOTD_LOGIN_PASSWORD

curl --fail-with-body -sS -b "$BOTD_COOKIE_FILE" \
  "$BOTD_HUB_URL/api/bots" | jq .
```

把用户名换成你的账户。列表包含可使用的 Bot。列表不代表对应节点当前在线。

### 创建会话并发送消息

把 Bot ID 换成列表中的实际值：

```bash
export BOTD_TARGET_BOT='replace-with-bot-id'
export BOTD_TARGET_SESSION="$(
  jq -n --arg bot "$BOTD_TARGET_BOT" \
    '{title:"API 测试", mode:"direct", leadBotId:$bot, memberBotIds:[$bot]}' |
    curl --fail-with-body -sS -b "$BOTD_COOKIE_FILE" \
      -H 'Content-Type: application/json' --data-binary @- \
      "$BOTD_HUB_URL/api/sessions" | jq -r .id
)"

curl --fail-with-body -sS -b "$BOTD_COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  --data '{"content":"告诉我当前工作目录。"}' \
  "$BOTD_HUB_URL/api/sessions/$BOTD_TARGET_SESSION/messages"
```

发送成功返回 `202` 和用户消息记录。模型回复异步生成。稍后查询：

```bash
curl --fail-with-body -sS -b "$BOTD_COOKIE_FILE" \
  "$BOTD_HUB_URL/api/sessions/$BOTD_TARGET_SESSION/messages" | jq .
```

用完删除 Cookie 文件：

```bash
rm -f "$BOTD_COOKIE_FILE"
```

## 认证

### Cookie 会话

登录成功后，Hub 设置 `botd_token` Cookie。Cookie 属性为 `HttpOnly`、`SameSite=Strict`、`Path=/`，有效期 7 天（`604800` 秒）。签名密钥保存在 Hub 数据库。Hub 正常重启不会使登录失效。

管理员修改某用户密码后，该用户已签发的全部 Cookie 立即失效（token epoch 递增）。

退出登录只清除客户端 Cookie。Hub 不维护服务端撤销名单。

### 节点令牌

Node Agent 可用两个请求头代替 Cookie：

- `x-botd-node-id`：节点 ID。
- `x-botd-node-token`：配对时下发的节点令牌。

校验通过后，Hub 按该节点的所有者身份处理请求。节点令牌不能访问 `/api/users` 下的接口，也不能创建配对码。违反时返回 `403`。

### 免登录入口

以下入口跳过登录检查，但仍执行各自的令牌或签名校验：

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/nodes/pairing/exchange`
- `POST /api/webhooks/:token`
- `GET` 和 `POST` 方法的 `/api/public/*` 接口

公共 API 不支持 Bearer Token。当前没有 CSRF Token 或 Origin 白名单中间件。部署信任边界见[安全说明](security.md)。

### 请求体大小限制

- 常规 `/api/*` 路由：1 MiB，超出返回 `413`。
- `/api/webhooks/*`：64 KiB。
- `/api/sessions/:id/artifacts`：按产物上限放宽（见[产物](#产物)）。

### 权限简称

| 简称 | 条件 |
| --- | --- |
| 登录 | 有效用户或节点令牌身份 |
| 管理员 | 当前用户角色为 `admin` |
| 节点所有者 | 用户拥有目标节点；远程操作还要求节点在线 |
| Bot 所有者 | 用户拥有 Bot 所在节点；远程操作还要求节点在线 |
| 会话访问 | 会话所有者或已加入的参与者 |
| 会话所有者 | 创建该会话的用户 |

权限以具体接口为准。会话访问权不能推出产物访问权或委派权。

## 健康检查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 免登录。返回 `{ok:true, draining, activeTurns}` |

`draining` 表示 Hub 正在排空任务。`activeTurns` 是当前运行中的会话回合数。

## 账户管理

| 方法 | 路径 | 权限 | 输入与返回 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | 免登录 | `{username, password}`。成功设置 Cookie，返回 `{ok, user}` |
| POST | `/api/auth/logout` | 登录 | 清除 Cookie，返回 `{ok:true}` |
| GET | `/api/auth/me` | 登录 | 返回 `{authenticated:true, user}` |
| GET | `/api/users` | 管理员 | 返回用户列表 |
| POST | `/api/users` | 管理员 | `{username, password, role?}`，返回新用户 |
| DELETE | `/api/users/:id` | 管理员 | 删除用户，返回 `{ok:true}` |
| PUT | `/api/users/:id/password` | 管理员 | `{password}`，返回 `{ok:true}` |

用户名规则：2 到 32 个字符，仅限字母、数字、`_`、`-`。密码至少 4 个字符。`role` 取 `admin` 或 `member`，默认 `member`。用户名重复返回 `409`。

删除用户限制：不能删除自己（`400`）。用户仍拥有节点时返回 `409`，先删节点。删除用户会同时清理其产物文件。

改密后该用户旧 Cookie 全部失效。

## 节点与配对

### 配对

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/nodes/pairing` | 登录（节点令牌不可用） | 生成绑定当前用户的配对码 |
| POST | `/api/nodes/pairing/exchange` | 免登录 | 用配对码注册节点并领取令牌 |

创建配对码返回 `{code, expiresAt}`。配对码为 6 位数字，10 分钟内有效，只能使用一次。

兑换输入 `{code, name, platform?}`。`platform` 取 `linux`、`darwin` 或 `win32`。成功返回 `{nodeId, name, hubUrl, token}`。`hubUrl` 从请求头推导。`token` 只在本次响应中出现，请立即保存。

暴破防护：按来源 IP 失败退避，从 1 秒指数递增，上限 5 分钟。单个配对码连续失败 5 次即作废。

兑换只完成注册。实际启动 Node Agent 用 `pnpm node start`，见[快速开始](getting-started.md)。

### 节点管理

| 方法 | 路径 | 权限 | 输入与返回 |
| --- | --- | --- | --- |
| GET | `/api/nodes` | 登录 | 返回当前用户可见的节点及各节点 Bot |
| DELETE | `/api/nodes/:nodeId` | 节点所有者 | 删除节点。可加查询参数 `force=1` |
| POST | `/api/nodes/:nodeId/install` | 节点所有者且在线 | `{source, kind?, customId?}` |
| POST | `/api/nodes/:nodeId/restart` | 节点所有者且在线 | 重启节点守护进程 |
| GET | `/api/nodes/:nodeId/upgrade/check` | 节点所有者且在线 | 检查更新，可带查询参数 `registryUrl` |
| POST | `/api/nodes/:nodeId/upgrade` | 节点所有者且在线 | `{targetVersion?, registryUrl?}` |

节点仍托管 Bot 时，普通删除返回 `409`。先删 Bot，或加 `force=1` 强制移除。强制移除会尽力清理在线节点上的 Bot 目录。

`install` 从 `source`（git 仓库、npm 包或本地文件）安装资源。`kind` 取 `auto`、`skill` 或 `extension`，默认自动识别。返回 `{kind, id}`。

`restart` 返回 `{ok:true, pid}`。

`upgrade/check` 返回 `{currentVersion, latestVersion, updateAvailable, blocked?}`。`upgrade` 返回 `{ok:true, previousVersion, targetVersion, upgraded, pid?}`。节点版本过旧不支持升级时返回 `501`。

### 技能与扩展

节点上的技能和扩展由节点权威存储。Hub 提供读写透传。

| 方法 | 路径 | 权限 | 输入与返回 |
| --- | --- | --- | --- |
| GET | `/api/nodes/:nodeId/skills/:skillId` | 节点所有者且在线 | 返回 `{content}` |
| PUT | `/api/nodes/:nodeId/skills/:skillId` | 节点所有者且在线 | `{content}`。写入并登记技能 |
| DELETE | `/api/nodes/:nodeId/skills/:skillId` | 节点所有者且在线 | 删除技能 |
| GET | `/api/nodes/:nodeId/extensions/:extId` | 节点所有者且在线 | 返回 `{content}` |
| PUT | `/api/nodes/:nodeId/extensions/:extId` | 节点所有者且在线 | `{content}`。写入并登记扩展 |
| DELETE | `/api/nodes/:nodeId/extensions/:extId` | 节点所有者且在线 | 删除扩展 |
| POST | `/api/nodes/:nodeId/skills/:skillId/sync` | 节点所有者且在线 | `{targetNodeIds}`，同步技能到其他节点 |

技能同步要求源节点和全部目标节点属于当前用户且在线。返回 `{ok:true, syncedNodeIds, failedNodeIds}`。失败的目标不影响成功的目标。

### 后台任务

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/nodes/:nodeId/bg-jobs` | 节点所有者且在线 | 列出后台任务。可带查询参数 `sessionId` |
| GET | `/api/nodes/:nodeId/bg-jobs/:jobId/logs` | 节点所有者且在线 | 读取任务日志。`lines` 默认 200，上限 5000 |
| POST | `/api/nodes/:nodeId/bg-jobs/:jobId/kill` | 节点所有者且在线 | 终止任务，返回 `{job}` |

日志接口返回 `{job, logs}`。节点版本过旧不支持后台任务时返回 `503`。

### 模型供应商登录

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/nodes/:nodeId/providers/:providerId/login` | 节点所有者且在线 | `{method}`，取 `api_key` 或 `oauth` |
| GET | `/api/nodes/:nodeId/provider-logins/:loginId` | 节点所有者且在线 | 查询登录进度 |
| POST | `/api/nodes/:nodeId/provider-logins/:loginId/respond` | 节点所有者且在线 | `{promptId, value}`，应答当前提示 |
| DELETE | `/api/nodes/:nodeId/provider-logins/:loginId` | 节点所有者且在线 | 取消登录 |
| DELETE | `/api/nodes/:nodeId/providers/:providerId/auth` | 节点所有者且在线 | 清除节点上该供应商的凭据 |

登录状态返回 `ProviderLoginState`：`{id, providerId, method, status, events[], prompt?, error?}`。`status` 取 `pending`、`success`、`error`、`cancelled`。登录可能包含多轮提示。客户端需要轮询并应答，直到状态终结。操作步骤见[模型指南](models.md)。

`respond` 的 `value` 上限 65536 字符。

## Bot 管理

| 方法 | 路径 | 权限 | 输入与返回 |
| --- | --- | --- | --- |
| GET | `/api/bots` | 登录 | 返回当前用户可用的 Bot |
| POST | `/api/bots` | Bot 所有者且在线 | `SaveBotInput`，创建 Bot |
| PUT | `/api/bots/:botId` | Bot 所有者且在线 | 配置补丁加可选 `systemMd` |
| DELETE | `/api/bots/:botId` | Bot 所有者且在线 | 删除 Bot |
| GET | `/api/bots/:botId/commands` | Bot 所有者且在线 | 返回 Bot 可用的斜杠命令 |
| GET / PUT | `/api/bots/:botId/system` | Bot 所有者且在线 | 读写 `SYSTEM.md`，PUT 输入 `{content}` |
| GET / PUT | `/api/bots/:botId/memory` | Bot 所有者且在线 | 读写 `MEMORY.md`，PUT 输入 `{content}` |
| GET / PUT | `/api/bots/:botId/env` | Bot 所有者且在线 | 读写环境变量 |
| DELETE | `/api/bots/:botId/env/:key` | Bot 所有者且在线 | 删除单个环境变量 |

创建时配置字段直接放在请求根对象，另加 `systemMd` 字符串。必填字段：`id`、`nodeId`、`name`、`description`（可为空字符串）、`modelProvider`、`modelId`、`enabledSkills`。不要外包一层 `bot` 对象。

主要可选字段：`thinkingLevel`（默认 `medium`）、`enabledExtensions`、`visibility`（`private` 或 `team`）、`parentBotId`、`inheritModel`、`inheritSkills`、`color`、`toolScope`、`customTools`、`isolation`。带 `parentBotId` 的 Bot 是子代理。

更新限制：不能把 Bot 迁到其他节点（`409`）。`parentBotId` 不能指向自己（`400`）。`systemMd` 缺省时保留节点上的现有提示词。

`commands` 返回 `ChatCommand` 列表：`{name, description?, source, argumentHint?}`。

环境变量规则：

- 键名匹配 `^[A-Za-z_][A-Za-z0-9_]*$`。
- 保留键 `PATH`、`PWD`、`HOME`、`USER`、`SHELL` 不可用。
- `BOTD_` 前缀的键不可用。
- 值必须是字符串。

`GET` 返回 `{keys, env}`。`PUT` 输入 `{env, merge?}`，返回 `{ok:true, keys, env}`。`merge` 为 `true` 时合并写入，默认整体替换。

## 模型目录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/models/catalog` | 返回模型目录。可带查询参数 `nodeId` |

不带 `nodeId` 时返回内置目录，所有供应商的 `configured` 为 `false`。带 `nodeId` 时转发该节点的实时目录，要求节点所有者且在线。

目录结构：`{source:'pi', sdkVersion, providers[]}`。每个供应商含 `authMethods` 和 `models`。每个模型含 `id`、`name`、`reasoning`、`thinkingLevels`、`input`、`contextWindow`、`maxTokens`。

## 会话

### 会话管理

| 方法 | 路径 | 权限 | 输入与返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions` | 登录 | 返回可访问的会话 |
| POST | `/api/sessions` | 登录 | `{title, mode, leadBotId, memberBotIds, parentSessionId?}` |
| PATCH | `/api/sessions/:id` | 会话访问 | 更新配置或标记 |
| DELETE | `/api/sessions/:id` | 会话所有者 | 删除会话 |

`mode` 当前只支持 `direct` 单聊。主控 Bot 由 `leadBotId` 指定，成员固定为主控 Bot 自己。主控 Bot 必须存在且当前用户可用。

会话列表返回 `SessionRecord`。运行中的会话附带 `activeBotIds`。记录还含 `queuePlan`、`messageCount`、`lastMessagePreview`、`archived`、`pinned`、`parentSessionId` 等字段。

PATCH 输入：`title`、`mode`、`leadBotId`、`memberBotIds`、`archived`、`pinned`（均可选）。运行中修改标题、模式、主控 Bot 或成员返回 `409`。归档和置顶是 UI 标记，运行中可改。配置变更会使排队任务失效。移除成员时，Hub 自动停用该成员的触发器。

删除会话要求：会话所有者，且会话不在运行中（否则 `409`）。删除会清理产物并广播空闲事件。

### 消息

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/messages` | 会话访问 | 查询消息，支持分页 |
| POST | `/api/sessions/:id/messages` | 会话访问 | `{content, attachments?}`，返回 `202` |
| PUT | `/api/sessions/:id/messages/:messageId` | 会话访问 | `{content}`，编辑后从锚点重发 |
| DELETE | `/api/sessions/:id/messages` | 会话访问 | 清空消息 |

不带查询参数时返回全量消息数组。带任一分页参数时返回 `{messages, hasMore}`：

- `before=<messageId>`：取该消息之前的历史。
- `around=<messageId>`：定位上下文，窗口约为锚点前 15 条、后 45 条。`around` 优先于 `before`。
- `limit`：默认 60，上限 200。
- 锚点必须存在且属于当前会话，否则 `404`。

发送消息要求 `content` 或 `attachments` 至少一项。Hub 解析斜杠命令与 `@提及`，据此决定派发目标。多人会话中消息自动附带发送者用户名前缀。Hub 正在排空时返回 `503`。

消息记录 `MessageRecord` 含 `role`（`user` / `assistant` / `callback` / `system`）、`senderBotId`、`senderUsername`、`modelBadge`、`content`、`mentions`、`subagentRuns`、`toolCalls`、`blocks`、`usage`、`attachments`、`aborted`。

编辑消息只限用户消息。编辑会截断锚点之后的消息，重置各节点本地会话，再从锚点重新派发。会话运行中返回 `409`。成功后 Hub 广播 `messages_truncated` 事件。

清空消息要求会话不在运行中。同时重置各节点本地会话记忆。

### 回合控制

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/sessions/:id/cancel` | 会话访问 | 中止当前回合并清空队列 |
| POST | `/api/sessions/:id/queue/skip` | 会话访问 | `{stageId?}` 或 `{botId?}`，跳过排队阶段 |
| POST | `/api/sessions/:id/queue/append` | 会话访问 | `{orchestration}`，追加执行阶段 |
| POST | `/api/sessions/:id/fork` | 会话访问 | `{anchorMessageId}`，分叉出新会话 |

`cancel` 作废排队任务与待确认请求，把会话置为 `idle`。

两个队列接口都返回 `{ok:true, queuePlan}`。`queuePlan` 是阶段摘要数组：`{id, botIds, parallel?}`。

`orchestration` 支持 `@提及` 列表或单个 Bot ID。

分叉克隆锚点及其之前的消息到新会话。源会话保持不动。运行中允许分叉。成功返回 `201` 和新会话。

### 子代理

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/sessions/:id/subagents/:runId/stop` | 会话访问 | 停止单个子代理运行 |
| POST | `/api/sessions/:id/subagents/:runId/interact` | 会话访问 | 向子代理插话或追问 |

`stop` 不中断主回合和其他并发子代理。

`interact` 输入 `{message, mode?, subagentId?}`。`mode` 取 `steer`（运行中插话）或 `resume`（结束后追问），默认 `steer`。成功返回 `{ok:true, run}`。`run` 是 `SubagentRunRecord`。

### 参与者

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/participants` | 会话访问 | 列出参与者 |
| POST | `/api/sessions/:id/participants` | 会话所有者 | `{userId}` 或 `{username}`，可带 `role` |
| DELETE | `/api/sessions/:id/participants/:userId` | 会话所有者或本人 | 移除参与者 |

参与者记录：`{sessionId, userId, username, role, joinedAt}`。`role` 取 `owner` 或 `member`，默认 `member`。所有者可移除任何成员。成员只能移除自己。

### 委派与子会话

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/subsessions` | 会话访问 | 列出子会话 |
| POST | `/api/sessions/:id/delegate` | 会话访问且目标 Bot 属于调用者 | 派生子会话执行独立任务 |

委派输入 `{botId, prompt, title?, mode?, memberBotIds?, artifactIds?, autoWakeParent?}`。`botId` 和 `prompt` 必填。`artifactIds` 缺省时继承父会话全部产物（零拷贝引用）。`autoWakeParent` 默认 `true`，子会话完成后唤醒父会话主控 Bot 汇总。

成功返回 `201` 和 `{parentSessionId, childSession, initialMessage}`。子会话新产出的交付物会零拷贝回传父会话。详细行为见[自动化指南](automation.md)。

### 自动化事件

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/automation-events` | 会话访问 | 查询事件收件箱。`limit` 默认 100 |

事件记录含 `source`、`eventType`、`dedupKey`、`summary`、`childSessionId`、`payloadArtifactId`。

## 消息搜索

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/messages/search` | `q` 必填。可选 `sessionId`、`limit` |

`limit` 默认 30，上限 100。带 `sessionId` 时校验会话访问权。返回命中数组：`{message, sessionTitle, sessionMode, sessionArchived}`。

## 产物

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET / POST | `/api/sessions/:id/artifacts` | 会话所有者 | 列出或上传产物 |
| GET | `/api/artifacts/:artifactId/content` | 会话所有者 | 下载产物内容 |

上传支持两种格式。

JSON 格式：`{filename, contentBase64, mimeType?, senderBotId?, message?}`。`filename` 和 `contentBase64` 必填。

二进制格式：正文直接传原始字节。`Content-Type` 用 `application/octet-stream`，元数据放请求头：

- `x-artifact-filename`：文件名（URL 编码）。
- `x-artifact-mime-type`：MIME 类型。
- `x-artifact-bot-id`：发送者 Bot ID。
- `x-artifact-message`：附言（URL 编码）。

以上头也可用同名查询参数 `filename`、`mimeType`、`botId`、`message` 代替。

单文件上限 15 MiB，超出返回 `413`。上传成功返回 `201` 和产物记录加下载 `url`。

下载以内联方式返回原始内容，附带 `X-Artifact-Id`、`X-Artifact-Session-Id`、`X-Artifact-Size-Bytes`、`X-Artifact-Created-At` 等头。磁盘文件丢失时返回 `410`。

产物接口按会话所有者校验，参与者无权访问。

## 人机协同（ask）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/approvals/pending` | 登录 | 列出当前用户全部待确认请求 |
| GET | `/api/sessions/:id/asks` | 会话访问 | 列出该会话的待确认请求 |
| POST | `/api/sessions/:id/asks/:askId/respond` | 会话访问 | `{answer}`，提交答复 |

待确认记录 `PendingAskRecord` 含 `prompt`、`options`、`status`、`previewType`、`previewContent`、`expiresAt`。默认超时 300 秒，超时置为 `expired`。

响应成功返回 `{ok:true, ask}`。请求不存在或已处理返回 `404`。

## 分享

### 管理分享链接

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/share` | 会话所有者 | 查询当前分享。无有效分享返回 `{share:null}` |
| POST | `/api/sessions/:id/share` | 会话所有者 | 创建或复用分享 |
| DELETE | `/api/sessions/:id/share` | 会话所有者 | 撤销分享 |

创建输入 `{regenerate?, expiresInHours?}`。`expiresInHours` 取 1 到 720 的整数。缺省为永久有效。已存在有效链接且未要求 `regenerate` 时返回 `200` 和现有记录。否则生成新令牌并返回 `201`。重新生成会替换旧令牌。

分享记录：`{id, sessionId, token, createdAt, expiresAt?}`。

### 公开分享端点

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/public/shares/:token` | 分享令牌 | 返回会话快照 |
| GET | `/api/public/shares/:token/artifacts/:artifactId/content` | 分享令牌 | 下载该会话的产物 |

鉴权只依赖 URL 中的令牌。请保护完整链接地址。

快照结构：`{share, session, bots, messages, artifacts}`。消息附件的下载地址会改写为公开端点。快照读取当时的会话数据，不是冻结的导出文件。

令牌无效或过期返回 `404`。产物文件丢失返回 `410`。

## 触发器

### 会话触发器

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/triggers` | 会话访问 | 列出触发器 |
| POST | `/api/sessions/:id/triggers` | 会话访问 | 创建触发器，返回 `201` |
| PATCH | `/api/triggers/:triggerId` | 触发器所有者 | 更新配置 |
| POST | `/api/triggers/:triggerId/run` | 触发器所有者 | 手动触发一次 |
| DELETE | `/api/triggers/:triggerId` | 触发器所有者 | 删除触发器 |

创建输入：`{name, botId, kind, prompt, cronExpr?, runAt?, delaySeconds?, enabled?, dispatchMode?, skillId?, secret?, eventFilter?}`。`name`、`botId`、`kind`、`prompt` 必填。`botId` 必须是会话成员。

`kind` 取值：

- `webhook`：生成随机 `token`，供外部系统调用。
- `cron`：必须提供 5 段式 `cronExpr`，按服务器本地时间调度。
- `once`：提供 `runAt`（ISO 时间或时长描述）或 `delaySeconds`。到点触发一次后自动停用。

`dispatchMode` 取 `append`（默认，唤醒目标会话）或 `subsession`（为每次触发派生独立子会话）。`skillId` 会在 prompt 前加 `/skill:<id>` 前缀。`secret` 用于 Webhook 签名校验。`eventFilter` 见下文。

PATCH 可更新 `enabled`、`name`、`prompt`、`cronExpr`、`runAt`、`dispatchMode`、`skillId`、`secret`。更新会重置该触发器的 Webhook 限流窗口。

手动触发立即返回 `{ok:true}`。`subsession` 模式额外返回 `childSessionId`。

### Webhook 接入

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/webhooks/:token` | URL 令牌，可选 HMAC 签名 | 接收外部事件并触发任务 |

URL 令牌允许触发任务。请保护完整地址。

配置了 `secret` 的触发器必须携带签名头 `x-hub-signature-256`。签名为 HMAC-SHA256（密钥为 `secret`，正文为原始请求体）的十六进制值，前缀 `sha256=`。签名不符返回 `401`。

请求体可以是纯文本或 JSON。JSON 优先提取 `message`、`text`、`payload` 字段作为唤醒文本。否则使用整个 JSON 字符串。

GitHub 事件自动识别：`x-github-event` 头决定 `source` 为 `github`，`eventType` 拼接 `action` 字段。其他请求读取 body 的 `source` 和 `type` 字段，默认 `webhook` 和 `webhook.received`。

处理顺序与响应：

1. 签名校验。失败返回 `401`。
2. 去重。`x-botd-dedup` 或 `x-github-delivery` 头作为去重键。5 分钟内存窗口加持久化唯一索引，跨重启生效。重复请求返回 `{ok:true, deduplicated:true}`。
3. 事件过滤。`eventFilter` 的 `source`、`types`、`payloadMatch` 全部满足才触发。不匹配时记录事件并返回 `{ok:true, skipped:true, reason:'filter_mismatch', eventId}`。
4. 限流。同一令牌最小触发间隔 10 秒。窗口内重复返回 `429`。
5. 事件落库。原始载荷存为产物 `event_<id>.json`，投递到会话工作区 `inbox/`。
6. 分发。`append` 模式唤醒目标会话。`subsession` 模式派生子会话，响应额外返回 `eventId` 与 `childSessionId`。

## 通知通道

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/channels` | 会话访问 | 列出出站通知通道 |
| POST | `/api/sessions/:id/channels` | 会话访问 | 创建通道，返回 `201` |
| GET | `/api/sessions/:id/outbox` | 会话访问 | 查询出站通知队列最近 100 条 |
| PATCH | `/api/channels/:channelId` | 通道所有者 | 更新配置 |
| DELETE | `/api/channels/:channelId` | 通道所有者 | 删除通道 |
| POST | `/api/channels/:channelId/test` | 通道所有者 | 发送测试通知 |

`kind` 取 `webhook`、`feishu`、`slack`、`telegram`。创建输入：`{name, kind, targetUrl, secret?, events?, tellPolicy?, enabled?}`。`targetUrl` 必须是 `http://` 或 `https://` 地址。

`events` 取 `assistant_reply`、`ask_request`、`wakeup`，默认全选。`tellPolicy` 取 `always`（默认全量推送）、`needed`（仅审批请求、失败回调和失败回复推送）、`never`（静默）。

通知先写入 Outbox 再投递。失败按指数退避重试，超过上限置 `dead`。Outbox 记录含 `status`、`attemptCount`、`nextRetryAt`、`lastError`。子会话事件自动继承父会话通道，通知附带 `channelSessionId`。

`webhook` 通道配置 `secret` 后，出站请求携带签名头 `X-Botd-Signature: sha256=<hmac>`。

测试接口成功返回 `{ok:true, status}`。远端失败返回 `502`。

### 公开 ask 回调

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET / POST | `/api/public/asks/:askId/respond` | HMAC 签名令牌 | 外部通道一键确认 |

参数 `sessionId`、`answer`、`token` 从查询串或 JSON 请求体传入。`token` 为 HMAC-SHA256（密钥为 ask 密钥，正文为 `sessionId:askId`）的十六进制值。ask 密钥来自 `BOTD_ASK_SECRET` 环境变量，或 Hub 自动生成并持久化。

待确认请求带选项时，答案必须在选项内。GET 请求带 `Accept: text/html` 时返回确认页面。

通知推送中的 `respondUrls` 已包含签名参数，可直接使用。`BOTD_PUBLIC_URL` 或 `BOTD_BASE_URL` 环境变量控制这些链接的基地址。见[配置说明](configuration.md)。

## SSE 事件流

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/events` | 会话访问 | 订阅单个会话的事件 |
| GET | `/api/events` | 登录 | 订阅当前用户的全局事件 |

事件通过 `data: <JSON>` 下发。每 15 秒发送一次 `ping` 保活事件。

会话流的首个事件是当前 `session_status`。全局流的首个事件是 `{type:'hello'}`。全局流包含该用户所有会话的事件，外加节点上下线事件。

先建立 SSE 连接，再发送消息，避免漏掉开头事件。连接中断后查询持久化消息。Hub 不重放事件。

可用 `curl -N -b "$BOTD_COOKIE_FILE"` 连接事件 URL。需要自动等待结果时，CLI 的 `chat send --wait` 已处理订阅顺序，见[CLI 文档](cli.md)。

### 事件类型参考

会话事件（两种流都会下发）：

| 事件 | 关键字段 | 说明 |
| --- | --- | --- |
| `session_status` | `status`、`activeBotId`、`activeBotIds`、`queuePlan` | 会话状态变化。`status` 取 `idle` / `running` / `queued` / `failed` |
| `subagent_status` | `botId`、`run` | 子代理运行状态。`run` 为 `SubagentRunRecord` |
| `text_delta` | `botId`、`delta` | 回复文本增量 |
| `thinking_stream` | `botId`、`delta`、`status`、`durationMs` | 思考过程流 |
| `tool_status` | `toolCallId`、`toolName`、`status`、`summary`、`outputPreview` | 工具调用进度。`status` 取 `running` / `done` / `error` |
| `message_created` | `message` | 新消息落库（含编辑与截断后的重播） |
| `messages_truncated` | `anchorMessageId` | 编辑重发导致历史截断，客户端应重新拉取 |
| `interaction_request` | `ask` | Bot 发起人机协同请求 |
| `interaction_resolved` | `askId`、`answer` | 交互请求已获答复 |
| `artifact_created` | `artifact` | 新产物上传通知 |

全局流独有事件：

| 事件 | 关键字段 | 说明 |
| --- | --- | --- |
| `node_status` | `nodeId`、`status` | 节点上下线。`status` 取 `online` / `offline` |

## 错误码

错误响应统一为 `{error:"原因"}`。常见状态码：

| 状态码 | 含义 |
| --- | --- |
| `400` | 输入不合法 |
| `401` | 未登录、登录失效或签名不符 |
| `403` | 无权限 |
| `404` | 资源不存在 |
| `409` | 运行状态或资源依赖冲突 |
| `410` | 产物文件已丢失 |
| `413` | 请求体超过大小限制 |
| `429` | 触发限流（配对暴退或 Webhook 频率） |
| `501` | 节点不支持请求的能力（如升级） |
| `502` | 节点 RPC 或外部请求失败 |
| `503` | 节点离线，或 Hub 正在排空任务 |

不要仅凭 `202` 判断模型执行成功。有副作用的请求失败后，先查询状态再决定是否重试。

`/ws/node` 是 Node Agent 的内部 WebSocket RPC 通道。它不是本文的通用 HTTP 集成入口。
