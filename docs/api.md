# HTTP API 参考

[文档目录](README.md)

用 API 可以让现有脚本向 Bot 派发任务，再读取回复和产物。终端自动化也可以先用 [CLI](cli.md)，减少认证和事件处理代码。

本文记录当前接口。完整字段类型见[共享协议](../packages/protocol/src/index.ts)。

## 先完成一次请求

以下示例需要 Bash、curl 和 jq。Hub 已启动，节点在线，Bot 已配置可用模型。

本地 API 测试直连 `http://localhost:3002`。浏览器仍从 `http://localhost:3001` 进入。

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

将用户名换成你的账户。列表包含可使用的 Bot，不代表对应节点当前在线。

### 创建会话并发送消息

将下方 Bot ID 换成列表中的实际值（当前会话模式为 `direct` 单聊，主控 Bot 即成员）：

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

发送成功返回 `202` 和用户消息记录。模型回复异步生成，可以稍后查询：

```bash
curl --fail-with-body -sS -b "$BOTD_COOKIE_FILE" \
  "$BOTD_HUB_URL/api/sessions/$BOTD_TARGET_SESSION/messages" | jq .
```

完成后删除 Cookie 文件：

```bash
rm -f "$BOTD_COOKIE_FILE"
```

## 认证与权限

登录 Cookie 有效期为 7 天，带有 `HttpOnly` 和 `SameSite=Strict`。签名密钥保存在 Hub 数据库中，正常重启不会使登录失效。

节点代理请求可以使用 `x-botd-node-id` 与 `x-botd-node-token` 两个头。Hub 将其作为节点所有者身份处理。节点令牌应按该权限级别保护。

公共 API 不支持通用 Bearer Token 认证。以下入口免登录，但仍执行各自的令牌或输入检查：

- `GET /api/health`。
- `POST /api/auth/login`。
- `POST /api/nodes/pairing/exchange`。
- `POST /api/webhooks/:token`。
- 下文列出的 `/api/public/` 接口。

当前实现没有独立 CSRF Token 或 Origin 白名单中间件。部署信任边界见[安全说明](security.md)。

接口表使用以下权限简称：

| 简称 | 条件 |
| --- | --- |
| 登录 | 有效用户或节点代理身份 |
| 管理员 | 当前用户角色为 `admin` |
| 节点所有者 | 用户拥有目标节点，节点远程操作通常还要求在线 |
| Bot 所有者 | 用户拥有 Bot 所属节点 |
| 会话访问 | 会话所有者或已加入的参与者 |
| 会话所有者 | 创建该会话的用户 |

权限以具体接口为准。尤其不能从会话访问权推断产物访问权或子任务委派权。

## 账户与健康状态

| 方法 | 路径 | 输入与返回 |
| --- | --- | --- |
| GET | `/api/health` | 免登录，返回 `ok`、`draining`、`activeTurns` |
| POST | `/api/auth/login` | `{username,password}`，设置 Cookie，返回用户 |
| POST | `/api/auth/logout` | 清除客户端 Cookie |
| GET | `/api/auth/me` | 返回认证状态和用户 |
| GET | `/api/users` | 管理员，返回用户列表 |
| POST | `/api/users` | 管理员，输入 `{username,password,role?}` |
| PUT | `/api/users/:id/password` | 管理员，输入 `{password}` |
| DELETE | `/api/users/:id` | 管理员，不能删除自己或仍拥有节点的用户 |

退出登录清除 Cookie，不建立已签发令牌的服务端撤销名单。

## 节点与资源

| 方法 | 路径 | 输入与权限 |
| --- | --- | --- |
| POST | `/api/nodes/pairing` | 登录，生成绑定当前用户的配对码 |
| POST | `/api/nodes/pairing/exchange` | `{code,name,platform}`，返回 `nodeId` 和 `token` |
| GET | `/api/nodes` | 登录，返回拥有或可见的节点及 Bot |
| DELETE | `/api/nodes/:nodeId` | 节点所有者，可用 `force=1` 强制移除 |
| POST | `/api/nodes/:nodeId/install` | 节点所有者且在线，输入 `{source,kind?,id?}` |
| POST | `/api/nodes/:nodeId/restart` | 节点所有者且在线 |
| GET | `/api/nodes/:nodeId/upgrade/check` | 节点所有者且在线 |
| POST | `/api/nodes/:nodeId/upgrade` | 节点所有者且在线，目标版本等字段见源码 |
| GET / PUT / DELETE | `/api/nodes/:nodeId/skills/:skillId` | 节点所有者且在线，PUT 输入 `{content}` |
| GET / PUT / DELETE | `/api/nodes/:nodeId/extensions/:extId` | 节点所有者且在线，PUT 输入 `{content}` |
| POST | `/api/nodes/:nodeId/skills/:skillId/sync` | `{targetNodeIds}`，源和目标均需拥有且在线 |
| GET | `/api/nodes/:nodeId/bg-jobs` | 节点所有者且在线，可按 `sessionId` 筛选 |
| GET | `/api/nodes/:nodeId/bg-jobs/:jobId/logs` | 节点所有者且在线，`lines` 指定日志行数 |
| POST | `/api/nodes/:nodeId/bg-jobs/:jobId/kill` | 节点所有者且在线 |

配对码有效期 10 分钟，只能使用一次。兑换接口只完成节点注册，实际启动应使用 `pnpm node start`。

`skills` 和 `extensions` 的 GET 返回文本内容的 JSON 封装。技能同步返回成功和失败的目标列表，不代表全部目标都成功。

## Bot

| 方法 | 路径 | 输入与权限 |
| --- | --- | --- |
| GET | `/api/bots` | 登录，列出可用 Bot |
| POST | `/api/bots` | 在线节点所有者，输入 `SaveBotInput` |
| PUT | `/api/bots/:botId` | Bot 所有者且在线，输入 Bot 配置字段的补丁及可选 `systemMd` |
| DELETE | `/api/bots/:botId` | Bot 所有者且在线 |
| GET | `/api/bots/:botId/commands` | Bot 所有者且在线，返回可用命令 |
| GET / PUT | `/api/bots/:botId/system` | Bot 所有者且在线，PUT 输入 `{content}` |
| GET / PUT | `/api/bots/:botId/memory` | Bot 所有者且在线，PUT 输入 `{content}` |
| GET / PUT | `/api/bots/:botId/env` | Bot 所有者且在线，PUT 输入 `{env:{KEY:"value"}}` |
| DELETE | `/api/bots/:botId/env/:key` | Bot 所有者且在线，删除一个变量 |

创建 Bot 时，配置字段直接放在请求根对象中，另需提供 `systemMd` 字符串。主要字段为 `id`、`nodeId`、`name`、`modelProvider`、`modelId`、`enabledSkills`。不要再包一层 `bot` 对象。

`visibility` 可为 `private` 或 `team`。使用共享 Bot 的权限与编辑 Bot 配置的权限不同。

## 模型与供应商

| 方法 | 路径 | 输入与用途 |
| --- | --- | --- |
| GET | `/api/models/catalog` | 无 `nodeId` 时返回内置目录，配置状态均为 false |
| POST | `/api/nodes/:nodeId/providers/:providerId/login` | `{method:"api_key"或"oauth"}`，开始登录 |
| GET | `/api/nodes/:nodeId/provider-logins/:loginId` | 查询交互状态 |
| POST | `/api/nodes/:nodeId/provider-logins/:loginId/respond` | `{promptId,value}`，提交当前提示的答案 |
| DELETE | `/api/nodes/:nodeId/provider-logins/:loginId` | 取消登录 |
| DELETE | `/api/nodes/:nodeId/providers/:providerId/auth` | 清除节点保存的供应商凭据 |

这些节点接口要求节点所有者和在线连接。目录请求带 `nodeId` 时，也适用此要求。

登录可能包含多个提示，需要持续查询和应答。字段和操作步骤见[模型指南](models.md)。

## 会话和消息

| 方法 | 路径 | 输入与权限 |
| --- | --- | --- |
| GET | `/api/sessions` | 登录，返回可访问会话 |
| POST | `/api/sessions` | `{title,mode?,leadBotId,memberBotIds?}` |
| PATCH | `/api/sessions/:id` | 会话访问，更新标题、成员、模式、归档、置顶等 |
| DELETE | `/api/sessions/:id` | 会话所有者，运行中先停止 |
| GET | `/api/sessions/:id/messages` | 会话访问，返回消息或分页结果 |
| POST | `/api/sessions/:id/messages` | 会话访问，`{content,attachments?}`，成功返回 `202` |
| PUT | `/api/sessions/:id/messages/:messageId` | 会话访问，`{content}`，编辑并重新生成后续回复 |
| DELETE | `/api/sessions/:id/messages` | 会话访问，清空消息，运行中先停止 |
| POST | `/api/sessions/:id/cancel` | 会话访问，中止当前执行和排队任务 |
| POST | `/api/sessions/:id/fork` | 会话访问，`{anchorMessageId}`，返回新会话 |
| GET | `/api/messages/search` | `q` 必填，可带 `sessionId`、`limit` |
| GET | `/api/sessions/:id/participants` | 会话访问，列出参与者 |
| POST | `/api/sessions/:id/participants` | 会话所有者，`{userId或username,role?}` |
| DELETE | `/api/sessions/:id/participants/:userId` | 会话所有者移除成员，或成员退出自己 |
| GET | `/api/sessions/:id/subsessions` | 会话访问，列出子会话 |
| POST | `/api/sessions/:id/delegate` | 会话访问，目标 Bot 还必须属于调用者 |
| GET | `/api/sessions/:id/automation-events` | 会话访问，查询自动化事件收件箱，可带 `limit`（默认 100） |
| GET | `/api/sessions/:id/outbox` | 会话访问，查询出站通知队列近期记录 |

修改调度配置时，运行中的会话返回 `409`。归档和置顶有独立规则，不能一概视为停止执行。

消息查询不带参数时返回数组。带 `limit`、`before` 或 `around` 时返回分页对象。`around` 优先于 `before`，锚点必须属于当前会话。

委派输入包括 `{botId,prompt,title?,mode?,memberBotIds?,artifactIds?}`。父会话产物以零拷贝引用同步给子会话，子会话完成后新产出交付物回传父会话并回报摘要。详细行为见[自动化指南](automation.md)。

自动化事件记录（`automation-events` 返回）包含 `source`、`eventType`、`dedupKey`、`summary`，以及子会话派发模式下的 `childSessionId` 和载荷产物 `payloadArtifactId`。Outbox 记录包含 `status`（`pending` / `sent` / `dead`）、`attemptCount`、`nextRetryAt` 与 `lastError`。

## SSE

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/sessions/:id/events` | 会话访问，订阅一个会话 |
| GET | `/api/events` | 登录，订阅当前用户的全局事件 |

数据通过 `data: <JSON>` 传输。另有每 15 秒一次的 `ping` 保活事件。

会话连接先返回 `session_status`。全局连接先返回 `hello`。后续事件类型定义在 `SessionSseEvent` 和 `GlobalSseEvent` 中。

| 常见事件 | 关键内容 |
| --- | --- |
| `text_delta` | 会话、Bot 和文本增量 |
| `tool_status` | 工具名称、状态和摘要 |
| `message_created` | 持久化后的消息记录 |
| `session_status` | `idle`、`running`、`queued` 或 `failed` |
| `messages_truncated` | 编辑重发后的历史截断 |
| `interaction_request` / `interaction_resolved` | 确认请求与处理结果 |
| `node_status` | 节点在线状态，全局流使用 |

流式监听应先建立 SSE 连接，再发送消息，避免漏掉开头的事件。连接中断后重新查询持久化消息，不要假设服务会重放事件。

可用 `curl -N -b "$BOTD_COOKIE_FILE"` 连接事件 URL。需要自动等待本轮结果时，CLI 的 `chat send --wait` 已处理订阅顺序。

## 产物、确认与分享

| 方法 | 路径 | 输入与权限 |
| --- | --- | --- |
| GET / POST | `/api/sessions/:id/artifacts` | 当前产物服务要求会话所有者 |
| GET | `/api/artifacts/:artifactId/content` | 按产物所属会话校验访问 |
| GET | `/api/approvals/pending` | 登录，查询当前用户待确认记录 |
| GET | `/api/sessions/:id/asks` | 会话访问，查询待确认请求 |
| POST | `/api/sessions/:id/asks/:askId/respond` | 会话访问，`{answer}` |
| GET / POST / DELETE | `/api/sessions/:id/share` | 会话所有者，查询、创建或撤销分享 |
| GET | `/api/public/shares/:token` | 分享令牌，返回会话快照 |
| GET | `/api/public/shares/:token/artifacts/:artifactId/content` | 分享令牌，下载该会话产物 |
| GET / POST | `/api/public/asks/:askId/respond` | 签名确认链接，参数见外部通道实现 |

产物 POST 支持 JSON `{filename,contentBase64,mimeType?,senderBotId?,message?}`。

也支持二进制正文，使用 `x-artifact-filename` 等头传入元数据。详细字段见 [artifacts.ts](../apps/hub/src/artifacts.ts)。单文件限制为 15 MiB。

分享 POST 输入 `{regenerate?:boolean}`。已有有效链接默认复用，重新生成会替换旧令牌。

公开分享读取当时的会话数据。不要将其当作创建时冻结的导出文件。

## 触发器与外部通知

| 方法 | 路径 | 输入与权限 |
| --- | --- | --- |
| GET / POST | `/api/sessions/:id/triggers` | 会话访问，查询或创建触发器 |
| PATCH | `/api/triggers/:triggerId` | 触发器所有者，更新配置 |
| POST | `/api/triggers/:triggerId/run` | 触发器所有者，手动触发 |
| DELETE | `/api/triggers/:triggerId` | 触发器所有者，删除 |
| POST | `/api/webhooks/:token` | Webhook 令牌，触发配置的任务 |
| GET / POST | `/api/sessions/:id/channels` | 会话访问，查询或创建出站通知通道 |
| PATCH / DELETE | `/api/channels/:channelId` | 通道所有者，更新或删除 |
| POST | `/api/channels/:channelId/test` | 通道所有者，发送测试通知 |

触发器输入包含 `{name,botId,kind,prompt}`。`cron` 使用 `cronExpr`，`once` 使用 `runAt` 或 `delaySeconds`。

Webhook 触发器还支持：

- `dispatchMode`：`append`（默认，唤醒目标会话）或 `subsession`（为每次事件派生独立子会话，主会话作为自动化运行账本）；
- `skillId`：触发时在 prompt 前加 `/skill:<id>` 前缀；
- `eventFilter`：`{source?,types?,payloadMatch?}`，全部条件需同时满足；不匹配的事件被记录后跳过。

Webhook 正文可以是文本或 JSON。JSON 优先提取 `message`、`text`、`payload`。URL 令牌本身允许触发任务，请保护完整地址。

Webhook 请求处理顺序：去重（`X-Botd-Dedup` / `X-GitHub-Delivery` 头，内存短窗口 + 持久化唯一索引，跨重启生效）→ 事件过滤（不匹配记录后跳过）→ 限流（同 token 最小间隔 10 秒，超出返回 `429`）→ 事件落库与载荷文件化（`event_<id>.json` 产物投递至 `workspace/inbox/`）→ 分发。子会话派发模式下，响应体额外返回 `eventId` 与 `childSessionId`。

通知通道支持 `webhook`、`feishu`、`slack`、`telegram`。创建输入包含 `name`、`kind`、`targetUrl`、可选事件、密钥配置及 `tellPolicy`（`always` | `needed` | `never`，默认 `always`；`needed` 仅在 `ask_request` 或失败回调时推送）。出站通知先写 Outbox 再投递，失败按指数退避重试、超限置 `dead`；子会话事件自动继承父会话通道（通知附带 `channelSessionId`）。`webhook` 通道配置 `secret` 后，请求携带 `X-Botd-Signature: sha256=<hmac>` 签名。详细字段见 [channels.ts](../apps/hub/src/channels.ts)。

## 错误与接口边界

错误通常返回 `{error:"原因"}`。常见状态为：

| 状态码 | 含义 |
| --- | --- |
| `400` | 输入不合法 |
| `401` | 未登录或登录失效 |
| `403` | 资源或操作无权限 |
| `404` | 资源不存在 |
| `409` | 运行状态或资源依赖冲突 |
| `410` | 产物内容已丢失 |
| `413` | 产物超过大小限制 |
| `501` | 节点不支持请求的升级能力 |
| `502` | 节点 RPC 或外部请求失败 |
| `503` | 节点离线，或 Hub 正在排空任务 |

具体状态以路由实现为准。不要仅凭 `202` 判断模型执行成功，也不要无条件重试有副作用的请求。

`/ws/node` 是 Node Agent 的内部 RPC 连接。本地 socket 也是节点内部控制接口，两者都不是本文的通用 HTTP 集成入口。
