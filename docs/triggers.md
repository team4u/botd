# 触发器

触发器让会话按计划时间或外部事件自动开始运行。[文档目录](README.md)

## 触发器是什么

触发器保存在 Hub。每个触发器绑定一个会话和一个 Bot。满足条件时，Hub 把预设的提示词交给该 Bot 执行。目标 Bot 必须是会话成员，否则 Hub 拒绝创建。

触发器分三类：

| 类型 | `kind` 值 | 触发时机 |
| --- | --- | --- |
| Webhook | `webhook` | 外部系统向专属 URL 发送 HTTP POST |
| Cron 定时 | `cron` | Cron 表达式匹配时，按分钟粒度 |
| 一次性延时 | `once` | 到达指定时间点，只触发一次 |

## 配置字段

`TriggerRecord` 的全部字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 触发器 ID，格式 `trg_<uuid>` |
| `sessionId` | string | 绑定的会话 |
| `botId` | string | 触发时执行提示词的 Bot，创建后不可改 |
| `name` | string | 名称 |
| `kind` | string | `webhook`、`cron` 或 `once`，创建后不可改 |
| `token` | string | 仅 `webhook`。36 位十六进制随机串，创建时自动生成 |
| `secret` | string | 仅 `webhook`。可选 HMAC 验签密钥 |
| `cronExpr` | string | 仅 `cron`。5 段式 Cron 表达式 |
| `runAt` | string | 仅 `once`。ISO 时间点 |
| `prompt` | string | 触发时交给 Bot 的提示词 |
| `enabled` | boolean | 是否启用，默认 `true` |
| `dispatchMode` | string | `append` 或 `subsession`，默认 `append` |
| `skillId` | string | 可选。触发时自动以 `/skill:<id>` 启动技能 |
| `eventFilter` | object | 仅 `webhook`。事件过滤条件 |
| `lastTriggeredAt` | string | 上次触发时间 |
| `createdAt` | string | 创建时间 |

`eventFilter` 包含三个可选字段，同时指定时必须全部满足：

- `source`：事件来源字符串。
- `types`：允许的事件类型数组。
- `payloadMatch`：载荷顶层字段的精确匹配表，值为字符串、数字或布尔。

Hub 收到 Webhook 后按以下规则识别来源与类型：

1. 请求带 `x-github-event` 头时，来源为 `github`。类型为 `<事件名>.<action>`，如 `pull_request.opened`。载荷无 `action` 时类型就是事件名。
2. 其他 JSON 载荷取 `source` 和 `type` 字段。缺省时来源为 `webhook`，类型为 `webhook.received`。

## 触发后发生什么

`dispatchMode` 决定执行方式。

### append：唤醒当前会话

Hub 向目标会话注入一条回调消息，并排队一个模型回合。消息格式：

```text
[Wake-up] [Webhook: <名称>] <提示词>
Payload: <载荷文本>
```

定时触发的前缀为 `[定时任务: <名称>]`。一次性触发为 `[Timer: <名称>]`。手动运行为 `[手动触发: <名称>]`。

Webhook 载荷文本的提取顺序：JSON 的 `message` 字段、`text` 字段、`JSON.stringify(payload)`、整体 JSON 序列化。纯文本载荷原样使用。

### subsession：派生独立子会话

每次触发创建一个新的子会话：

1. 子会话标题为 `[自动任务] <触发器名称>`，主控 Bot 就是触发器绑定的 Bot。
2. 父会话收到一条派生通知。
3. Webhook 原始载荷先存入子会话产物 `event_<eventId>.json`。子会话首轮即可从 `./inbox/` 下载。
4. 初始消息不拼接原始载荷，只含事件元数据和触发器提示词。提示词要求 Bot 把载荷当作外部不可信数据读取，防止提示词注入。
5. 子会话完成后，父会话收到结果回调，包含子会话最后一条回复的摘要。
6. 子会话执行期间新产出的产物以引用方式回传父会话，回调消息附带产物列表。
7. 子会话失败时，父会话收到失败回调。

`append` 模式下载荷文件存入目标会话本身。

### 技能前缀

`subsession` 模式下，配置了 `skillId` 且提示词不以 `/` 开头时，Hub 在子会话初始消息前加 `/skill:<skillId> ` 前缀。`append` 模式不加工提示词。

## Cron 语法

botd 使用标准 5 段式表达式，实现见 [cron.ts](../packages/protocol/src/cron.ts)：

```text
分 时 日 月 周
```

| 字段 | 位置 | 取值范围 |
| --- | --- | --- |
| 分 | 1 | 0-59 |
| 时 | 2 | 0-23 |
| 日 | 3 | 1-31 |
| 月 | 4 | 1-12 |
| 周 | 5 | 0-7，`0` 和 `7` 都表示周日 |

每个字段支持：

- `*`：任意值
- 单个数字，如 `30`
- 区间，如 `1-5`
- 步进，如 `*/15` 或 `10-50/5`
- 逗号列表，如 `1,15,30`
- 以上形式的组合

不支持：`JAN`、`MON` 等名称，秒字段，第六段，`?`、`L`、`W`、`#`。

求值规则：

- 时间按 Hub 服务器本地时区，分钟粒度。
- 日与周同时受限时，命中任一即匹配。例如 `0 9 1 * 1` 在每月 1 日和每个周一的 09:00 都触发。
- 仅其一时，按该字段匹配。

示例：

```text
*/15 * * * *    每 15 分钟
0 * * * *       每小时整点
30 9 * * *      每天 09:30
0 9 * * 1-5     每个周一至周五 09:00
```

常见模式在网页与列表中显示中文短标签，如「每 15 分钟」「每天 09:30」。

Hub 停机期间错过的时间点不会补跑。同一自然分钟内重复巡检只触发一次。

## 一次性触发器

创建时二选一：

- `delaySeconds`：正整数秒数。Hub 换算为「当前时间 + 延时」。
- `runAt`：相对时长或绝对时间。相对时长支持纯数字（秒）和 `s`、`m`、`h`、`d` 后缀，如 `30s`、`15m`、`2h`、`1d`。绝对时间用 ISO 格式。

到达时间点后，Hub 先标记触发器已触发并停用，再执行分发。这保证一次性触发器只触发一次。即使 Hub 晚于预定时间启动，触发器仍会在下一次巡检时执行。

## Webhook 触发器

### URL 与鉴权

创建 `webhook` 触发器时，Hub 自动生成 36 位十六进制 token。调用地址：

```text
POST /api/webhooks/<token>
```

该路由不要求登录。token 就是凭证，完整 URL 等同于密码，应当保密。请求体上限 64KB。

响应状态码：

| 状态码 | 含义 |
| --- | --- |
| 200 | 已触发、已去重或已跳过 |
| 401 | 配置了 `secret` 但签名不匹配 |
| 403 | 触发器已停用，或目标 Bot 已不在会话中 |
| 404 | token 不存在 |
| 413 | 请求体超过 64KB |
| 429 | 超出频率限制 |

### HMAC 签名

配置 `secret` 后，请求必须携带签名头：`x-hub-signature-256` 或 `x-hub-signature`。

签名算法：`sha256=` 前缀加请求原始字节的 HMAC-SHA256 十六进制摘要。Hub 用常数时间比较校验。生成示例：

```bash
echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET"
# 输出形如 "SHA2-256(stdin)= <摘要>"，取摘要部分并加上 "sha256=" 前缀填入签名头
```

`secret` 在 CLI 创建时经 `--secret` 传入；`PATCH /api/triggers/:id` 可设置或清除。网页表单不提供该项。

### 频率限制与去重

- 同一 token 的最小触发间隔为 10 秒。窗口内的重复请求返回 429。所有者更新触发器后，限流窗口重置。
- 请求可携带 `X-Botd-Dedup` 或 `X-GitHub-Delivery` 头作为去重键。`X-Botd-Dedup` 额外享受 5 分钟内存窗口；两种键都受数据库唯一索引保护，Hub 重启后依然生效。重复请求返回 `deduplicated: true`，不执行触发。

### 事件过滤

配置 `eventFilter` 后，不匹配的事件被记录并跳过，返回 `skipped: true` 和 `reason: "filter_mismatch"`。被跳过的事件不消耗限流窗口。

CLI 用 `--event-types` 传逗号分隔的类型列表。网页表单的「事件类型过滤」输入框同样只填类型列表。

### 事件收件箱

每次 Webhook 调用（含被过滤的，命中去重的除外）都落库为自动化事件。查询接口：

```text
GET /api/sessions/<sessionId>/automation-events?limit=100
```

事件记录包含 `source`、`eventType`、`summary`（载荷前 200 字符）、`dedupKey`、派生的 `childSessionId` 和载荷产物 `payloadArtifactId`。该接口需要会话所有者登录。

子会话模式的响应体额外返回 `eventId` 与 `childSessionId`，方便调用方追踪。

## 手动运行

立即执行一次触发器，不影响原计划，也不消耗一次性触发次数：

```text
POST /api/triggers/<triggerId>/run
```

仅触发器所有者可调用。接口立即返回，分发在后台执行。`subsession` 模式的响应包含新子会话 ID。

## 管理接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/:id/triggers` | 列出会话的全部触发器 |
| `POST /api/sessions/:id/triggers` | 创建触发器 |
| `PATCH /api/triggers/:triggerId` | 更新触发器 |
| `POST /api/triggers/:triggerId/run` | 手动运行一次 |
| `DELETE /api/triggers/:triggerId` | 删除触发器 |

创建校验规则：

1. `name`、`botId`、`kind`、`prompt` 必填。
2. `botId` 必须是会话成员。
3. `cron` 类型必须带合法 `cronExpr`。`cronExpr` 不允许用于其他类型。
4. `once` 类型必须带 `delaySeconds` 或可解析的 `runAt`。
5. `dispatchMode` 只接受 `append` 或 `subsession`。

`PATCH` 可更新 `enabled`、`name`、`prompt`、`cronExpr`、`runAt`、`dispatchMode`、`skillId`、`secret`。`skillId` 和 `secret` 传 `null` 清除。`kind`、`botId`、`token` 不可改。

会话移除某个 Bot 成员时，Hub 自动停用绑定该 Bot 的全部触发器。

## CLI 命令

`botd triggers` 提供三个子命令。

列出会话触发器：

```bash
botd triggers list <sessionId>
```

创建触发器：

```bash
botd triggers create <sessionId> \
  --name '目录检查' --bot <botId> \
  --prompt '检查工作目录中新生成的报告，汇总变化。' \
  --kind cron --cron '*/15 * * * *'
```

全部选项：

| 选项 | 说明 |
| --- | --- |
| `--name <name>` | 必填。名称 |
| `--bot <botId>` | 必填。执行的 Bot |
| `--prompt <prompt>` | 必填。触发时交付的提示词 |
| `--kind <kind>` | `webhook`、`cron`、`once`，默认 `webhook` |
| `--cron <expr>` | Cron 表达式，仅 `--kind cron` |
| `--delay <duration>` | 延时，如 `30s`、`15m`、`2h`，仅 `--kind once` |
| `--at <isoOrDuration>` | ISO 时间或时长，仅 `--kind once` |
| `--dispatch <mode>` | `append` 或 `subsession`，默认 `append` |
| `--skill <skillId>` | 触发时以 `/skill:<id>` 前缀调用技能 |
| `--secret <secret>` | HMAC 验签密钥，仅 `--kind webhook` |
| `--event-types <csv>` | 逗号分隔的事件类型，仅 `--kind webhook` |

删除触发器：

```bash
botd triggers delete <triggerId>
```

子会话派发的完整示例：

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name 'PR 审查' --bot "$BOTD_BOT_ID" \
  --prompt '审查 PR 变更并给出结论。' --kind webhook \
  --dispatch subsession \
  --skill pr-review \
  --event-types "pull_request.opened"
```

## 网页配置步骤

入口：会话页顶部「更多操作」菜单，点击「定时与触发器」。弹窗标题为「自动化与消息桥接」，含「触发器」和「通知通道」两个标签页。通知通道属于出站通知，见[自动化指南](automation.md)。

新建触发器：

1. 点击「新建触发器」。
2. 选择类型：Webhook、Cron 定时或一次性延时。
3. 填写触发器名称。
4. 在「响应智能体」下拉框选择会话中的 Bot。创建后不可更换。
5. 选择执行方式：派生独立子会话（默认，隔离每次运行）或追加到当前会话。
6. 可选填写「绑定技能」。触发时自动以 `/skill:<id>` 启动。
7. 按类型填写：
   - Cron：输入表达式，可用下方预设快填，输入框下方实时显示校验与中文描述。
   - 一次性：输入相对延时（如 `15m`）或 ISO 时间，可用预设快填。
   - Webhook：可选填写事件类型过滤，逗号分隔。留空接收全部事件。
8. 填写触发指令或提示词。
9. 点击「保存触发器」。

管理已有触发器：

- 点击「已启用/已停用」切换状态。
- 点击闪电图标立即触发一次，需在确认框中确认。
- 点击铅笔图标编辑。类型和 Bot 不可改，其余字段可改。
- 点击垃圾桶图标删除。

Webhook 触发器卡片额外展示专属 URL 和现成的 curl 命令，均可一键复制。URL 以当前浏览器地址拼接，本机开发时网页在 3001 端口，Hub 在 3002 端口，生产默认 3000。

「事件收件箱」折叠区列出 Webhook 最近收到的事件，含来源、类型、摘要和时间。子会话模式的事件附带「查看子会话」链接。

## 轮询间隔

Hub 用定时巡检检查 `cron` 与 `once` 触发器。间隔由环境变量控制：

```text
BOTD_TRIGGER_POLL_MS
```

默认 `2000` 毫秒，下限 `200` 毫秒。调小间隔让触发更准时，但增加数据库查询频率。Webhook 触发器不依赖巡检，不受此变量影响。
