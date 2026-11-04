# 外部渠道

把会话事件推送到 Telegram、Slack、飞书和自定义 Webhook，并在渠道里点链接完成 Bot 确认。[文档目录](README.md)

## 通道模型与数据流

通道只把会话事件推向外渠，不接收渠道里的普通消息。渠道内唯一回流 Hub 的请求是 ask 确认回调。

| 项 | 取值 |
| --- | --- |
| 通道类型 `kind` | `telegram`、`slack`、`feishu`、`webhook` |
| 事件 `events` | `assistant_reply`、`ask_request`、`wakeup`，默认全选 |
| 打扰策略 `tellPolicy` | `always`（服务端默认）、`needed`、`never` |

事件来源：

| 事件 | 触发条件 |
| --- | --- |
| `assistant_reply` | 会话产生 Bot 回复（SSE `message_created`，role 为 `assistant`） |
| `ask_request` | Bot 调用 ask 请求人工确认（SSE `interaction_request`） |
| `wakeup` | 会话收到回调消息（SSE `message_created`，role 为 `callback`） |

`tellPolicy` 在 `events` 勾选之上二次过滤：

| 策略 | 行为 |
| --- | --- |
| `always` | 勾选的事件全部推送 |
| `needed` | 仅推 `ask_request`、失败回调、failed 会话的回复 |
| `never` | 全部拦截，含 `ask_request` |

失败回调的判定：消息内容含 `❌`、`失败`、`failed` 或 `error`，忽略大小写。failed 会话指会话状态为 `failed`。

另有一条与策略无关的静默规则：助手回复以 `[PASS]` 或 `[IGNORE]` 开头时（多 Bot 接力的路过原语），不向任何通道推送，避免噪音通知。

### 绑定关系

创建通道的请求发到 `POST /api/sessions/:id/channels`。Hub 把会话 ID 存入通道记录的 `sessionId` 字段。之后该会话的事件自动推送到此通道，无需其他绑定操作。

子会话事件向上继承：子会话的事件同时命中父会话的启用通道。同一通道按 id 去重，只推一次。继承通知在 webhook 载荷里附带 `channelSessionId` 字段；文本渠道在末尾追加 `（子会话 <id>）`。

所有推送统一为 `POST` JSON 请求，超时 10 秒，`User-Agent` 为 `botd-notifier/0.1.0`。远端返回非 2xx 视为失败。

## 网页配置路径与字段

1. 打开会话页面。
2. 点右上「更多」菜单。
3. 点「定时与触发器」。弹窗标题为「自动化与消息桥接」。
4. 切换到「通知通道」标签页。
5. 点「新建出站通道」，填表后点「创建通道」。

表单字段：

| 字段 | 含义 | 网页默认 |
| --- | --- | --- |
| 通道类型 | 飞书机器人 / Slack / Telegram / 通用 Webhook 四选一 | 飞书机器人 |
| 通道名称 | 自定义显示名，必填 | 空 |
| 目标 Webhook URL | 推送地址，必须以 `http://` 或 `https://` 开头 | 空 |
| 签名密钥 Secret | 仅 `webhook` 类型显示，选填 | 空 |
| 触发事件 | 三个事件多选，至少勾一个 | 全选 |
| 通知打扰策略 | 按需打扰（推荐）/ 全部推送 / 静默 | 按需打扰 |

直接调 API 创建且不传 `tellPolicy` 时，服务端存 `always`。

通道卡片提供这些操作：启用/停用开关；点策略徽标循环切换（按需 → 全部 → 静默）；「测试推送」按钮；删除按钮。卡片还显示目标 URL（可复制）、勾选的事件和「上次推送」时间。停用（`enabled` 为 false）后不再推送。

## Telegram

### 前置条件

- 从 @BotFather 创建 Bot，拿到 bot token。
- 拿到目标 chat id（个人、群组或频道）。
- Hub 所在机器能访问 `api.telegram.org`。

### 目标 URL 与推送格式

```
https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>
```

botd 向该 URL POST JSON，即 Telegram Bot API 的 `sendMessage`：

```json
{ "text": "[botd] @bot-1: 任务已完成", "parse_mode": "Markdown" }
```

- Bot 回复前缀为 `[botd]`，回调唤醒前缀为 `[botd 唤醒]`。
- 回复带发送者时，文本含 `@<botId>: `。
- 继承子会话事件时，文本末尾追加 `（子会话 <id>）`。

### 确认交互

`ask_request` 推送标题为 `*【botd 交互确认】*`。每个选项渲染成 Markdown 链接 `• [选项](链接)`。在手机上点链接即可免登录提交答案。

### 测试发送

测试载荷同为 `{ "text": ..., "parse_mode": "Markdown" }`，内容为 `[botd] 这是一条来自 botd 的通知推送测试消息 🚀`。

## Slack

### 前置条件

- 在 Slack 工作区创建 Incoming Webhook，得到以 `https://hooks.slack.com/services/` 开头的 URL。
- 投递目标频道在创建 Webhook 时选定。

### 目标 URL 与推送格式

targetUrl 填 Incoming Webhook 地址。推送载荷：

```json
{ "text": "[botd] @bot-1: 任务已完成" }
```

前缀、发送者标注与子会话后缀规则同 Telegram。

### 确认交互

`ask_request` 推送文本以 `[botd 交互确认]` 开头。选项用 Slack 链接语法 `• <链接|选项>` 渲染。点链接在浏览器中提交确认。

### 测试发送

测试载荷为 `{ "text": <测试消息> }`，内容同上。

## 飞书

### 前置条件

- 在飞书群里添加「自定义机器人」，得到 `https://open.feishu.cn/open-apis/bot/v2/hook/xxx` 形式的地址。
- 机器人安全设置不能开启「签名校验」。botd 不发送飞书签名字段。

### 目标 URL 与推送格式

targetUrl 填自定义机器人地址。推送载荷：

```json
{ "msg_type": "text", "content": { "text": "[botd] @bot-1: 任务已完成" } }
```

前缀、发送者标注与子会话后缀规则同 Telegram。

### 确认交互

`ask_request` 推送文本以 `[botd 交互确认]` 开头。每个选项单独一行，格式为 `👉 选项：链接`。点链接在浏览器中提交确认。

### 测试发送

测试载荷为 `{ "msg_type": "text", "content": { "text": <测试消息> } }`。

## 通用 Webhook

### 前置条件

- 准备一个能接收 `POST` JSON 的 HTTP 端点。
- 需要验签时，与接收端约定一个共享密钥，填入 `secret` 字段。

### 目标 URL 与签名

targetUrl 填接收端地址（如 `https://your-domain.com/api/botd-webhook`）。填写 `secret` 后，每个请求带签名头：

```
X-Botd-Signature: sha256=<HMAC-SHA256(请求体原始字节, secret) 的 hex>
```

接收端用同一密钥对原始请求体计算 HMAC 并比对。只有 `webhook` 类型会带此头，其余类型填 `secret` 不产生任何效果。

### 推送格式

回复与唤醒事件：

```json
{
  "event": "assistant_reply",
  "sessionId": "sess_xxx",
  "channelSessionId": "sess_parent",
  "sessionTitle": "会话标题",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "message": { "role": "assistant", "content": "..." }
}
```

`channelSessionId` 仅在继承子会话事件时出现，表示通道归属的父会话；`sessionId` 始终是事件源会话。`wakeup` 事件时 `event` 为 `wakeup`。

### 确认交互

`ask_request` 载荷额外包含 `ask` 对象（`id`、`botId`、`prompt`、`options`、`expiresAt`）和 `respondUrls` 映射。`respondUrls` 以选项文本为键，值为免登录确认链接。消费方把链接转发给用户或渲染成按钮。

### 测试发送

测试载荷模拟一条 `assistant_reply` 事件：`sessionTitle` 为 `测试通道推送`，`message.id` 形如 `msg_test_<时间戳>`，`message.content` 为测试消息。

## 确认交互与签名回调

四个渠道的确认流程一致：Hub 生成带签名的链接，推送到渠道；用户点链接，浏览器直接请求 Hub 完成确认。

### UI ask 的降级摘要

ask 的预览为生成式 UI（`previewType: 'ui'` 的 `BotdUiSpec`）时，Hub 在推送前从 Spec 提取文本渠道可消费的降级内容：

- Callout 提取为 `[标题] 正文`，KeyValueList 提取为 `key: value`，表单控件（TextInput / Select / Switch / CheckboxGroup）提取为 `[表单项] 标签`；摘要行拼在 prompt 下方，最多保留前 6 行。
- ask 未提供 options 但 Spec 含 `Button` 且无表单项时（纯按钮审批卡），用按钮文案（去重）补齐选项，每个选项生成免登录一键确认链接。
- Spec 含表单项时，免登录链接无法携带表单 state，改为附上网页填写入口（`{baseUrl}/#?s={sessionId}`），引导到网页完成交互。
- 非法 Spec 静默降级：不提取摘要，按原有 options 渲染。

### 链接与签名

确认链接形态：

```
{baseUrl}/api/public/asks/{askId}/respond?sessionId=...&answer=...&token=...
```

- `token` 为 `HMAC-SHA256("{sessionId}:{askId}", askSecret)` 的 hex 值。
- 签名密钥按 `askSecret` 解析：先取环境变量 `BOTD_ASK_SECRET`。未设置时取 settings 表的 `ask_secret`。两者都没有时生成 64 位 hex 随机密钥并落库。落库保证重启后历史链接仍有效。
- 更换 `BOTD_ASK_SECRET` 会让旧密钥签出的未确认链接失效。
- 继承子会话事件时，链接中的 `sessionId` 指向 ask 所在的子会话，签名也用该会话计算。

`baseUrl` 的取值顺序：`BOTD_PUBLIC_URL`、`BOTD_BASE_URL`、`http://localhost:${BOTD_PORT 或 3000}`。手机必须能访问该地址，公网部署请设置 `BOTD_PUBLIC_URL`。本机开发时 Hub 在 `3002`（启动带 `BOTD_PORT=3002`），生产默认 `3000`。

### 回调端点

`GET` 和 `POST` 均可访问 `/api/public/asks/:askId/respond`。参数 `sessionId`、`answer`、`token` 可放查询串；`POST` 也可放 JSON 体。

| 情况 | 返回 |
| --- | --- |
| 缺少任一必要参数 | `400` |
| `token` 校验失败 | `403` |
| 答案不在待确认 ask 的选项内 | `400` |
| ask 不存在、已超时或已被处理 | `404` |
| 确认成功 | `200`，JSON 返回 `{ok:true, ask}` |

选项非空的待确认 ask 强制答案在选项内，防止伪造 token 提交任意文本。请求头 `Accept` 含 `text/html` 时返回结果页：成功显示「已确认提交」和所选答案，失败显示对应错误。确认成功后，等待中的 ask 立即获得答案，Bot 继续执行。

安全要求见[安全边界](security.md)。

## 测试渠道发送

测试推送用于验证凭据和网络连通。

- 接口：`POST /api/channels/:channelId/test`，仅通道所有者可调用。
- 成功返回 `200` 和 `{ok:true, status}`，并更新通道的 `lastTriggeredAt`（网页显示为「上次推送」）。
- 远端返回非 2xx 或请求超时，接口返回 `502` 和 `{error}`。
- 测试推送不经过 Outbox，直接同步发送。

网页端在通道卡片上点「测试推送」按钮。

## 通知外发模型（Outbox）

事件推送先落库再投递，失败自动重试。

### 投递流程

1. 事件命中通道后，Hub 写入 `notification_outbox` 表一条 `pending` 记录。
2. 写入后立即发起首次投递。
3. 投递成功：状态置 `sent`，清空 `nextRetryAt` 与 `lastError`，更新通道 `lastTriggeredAt`。
4. 投递失败：`attemptCount` 加 1。达到上限则置 `dead` 并记录 `lastError`，否则按退避安排 `nextRetryAt`。
5. 后台轮询每 `BOTD_OUTBOX_POLL_MS` 毫秒扫描到期的 `pending` 记录，每轮最多取 20 条，按到期时间升序重试。

重试延迟为 `BOTD_OUTBOX_RETRY_MS × 2^(attemptCount-1)`，上限 300000 毫秒（硬编码）。Outbox 持久化在数据库中，Hub 重启后到期的 `pending` 记录会继续重试。

除超限外，两种情况也直接置 `dead`：通道已删除（`lastError` 为 `Channel deleted`）、载荷 JSON 损坏。

### 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `BOTD_OUTBOX_MAX_ATTEMPTS` | `5` | 单条通知最大尝试次数，下限 1 |
| `BOTD_OUTBOX_RETRY_MS` | `5000` | 基础退避间隔，单位毫秒，下限 100 |
| `BOTD_OUTBOX_POLL_MS` | `2000` | 后台轮询间隔，单位毫秒，下限 100 |

### 查询投递记录

- 接口：`GET /api/sessions/:id/outbox`，需要会话访问权。
- 返回该会话及其通道触发的近期记录，按创建时间倒序，最多 100 条。
- 记录字段：`id`（`outbox_` 前缀）、`channelId`、`sessionId`、`eventKind`、`status`、`attemptCount`、`nextRetryAt`、`lastError`、`createdAt`、`updatedAt`。
- 父会话查询能看到子会话事件触发的记录。

网页端在「通知通道」标签页底部展开「最近通知投递记录 (Outbox)」。状态显示为：已送达（`sent`）、重试中（`pending`）、投递失败（`dead`），可手动刷新。

## HTTP 接口一览

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET / POST | `/api/sessions/:id/channels` | 会话访问，列出（按创建时间升序）或创建通道 |
| PATCH | `/api/channels/:channelId` | 通道所有者，更新 `name`、`targetUrl`、`secret`、`events`、`tellPolicy`、`enabled` |
| DELETE | `/api/channels/:channelId` | 通道所有者 |
| POST | `/api/channels/:channelId/test` | 通道所有者，发送测试通知 |
| GET | `/api/sessions/:id/outbox` | 会话访问，查询投递记录 |
| GET / POST | `/api/public/asks/:askId/respond` | 签名链接，免登录确认 |

创建输入为 `name`、`kind`、`targetUrl`，可选 `secret`、`events`、`tellPolicy`、`enabled`。创建与更新都校验 URL 必须为 `http://` 或 `https://`。完整字段见 [HTTP API](api.md)。

## 渠道凭据字段总参考

| 渠道 `kind` | 需要的凭据 | 填写位置 | `secret` 字段效果 |
| --- | --- | --- | --- |
| `telegram` | bot token + chat id | 拼入 `targetUrl`（`sendMessage` 完整地址） | 无效果，不签名 |
| `slack` | Incoming Webhook 地址 | `targetUrl` | 无效果，不签名 |
| `feishu` | 自定义机器人 hook 地址 | `targetUrl` | 无效果，不签名 |
| `webhook` | 接收端 URL；可选共享密钥 | URL 填 `targetUrl`，密钥填 `secret` | 生成 `X-Botd-Signature` 签名头 |

所有渠道共用两个 Hub 级变量：`BOTD_ASK_SECRET` 用于确认链接签名（见上文解析顺序）；`BOTD_PUBLIC_URL` 决定确认链接前缀。更多变量见[配置参考](configuration.md)。触发器与事件收件箱见[自动化指南](automation.md)。
