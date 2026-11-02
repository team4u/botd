# 自动化指南

[文档目录](README.md)

让机器继续跑任务，让会话负责交代进度。botd 提供后台任务、回调、人工确认和文件交接，可以组合进现有脚本。

本页示例在 **Bot 的 Bash 工具环境**中执行。该环境提供 `botd` 命令和当前会话信息。

从外部终端调用时，需要本机 Node Agent 运行。使用源码 CLI 入口，并补齐会话、Bot 和数据目录参数，见 [CLI 参考](cli.md)。

## 先体验一次后台回报

让 Bot 运行以下命令：

```bash
botd bg run -- 'sleep 5; date'
```

命令会立即返回任务 ID。后台命令结束后，Node Agent 向原会话发送退出状态和日志摘要，再唤醒 Bot 汇报。

这个任务不需要一直占着当前模型回合。Bot 仍需结束当前发言，后续回调才能按会话队列处理。

如果只想接收结果，不需要模型总结：

```bash
botd bg run --no-turn -- 'sleep 5; date'
```

### 查看和停止任务

```bash
botd bg list
```

将下面 ID 换成刚才返回的任务 ID：

```bash
botd bg logs bg_example --lines 50
botd bg kill bg_example
```

日志保存在 Bot 工作区的 `.bg/<jobId>.log`。任务状态包括 `running`、`done`、`failed` 和 `killed`。

`bg kill` 针对后台进程树。聊天中的停止按钮针对模型回合和排队任务，不应代替后台任务管理。

Node Agent 退出时会清理受管进程。机器断电或守护进程重启后，不会自动重建原后台任务。

## 让已有脚本回报进度

如果任务由其他程序启动，可以在完成后调用：

```bash
botd wake --message '日志分析完成，报告保存在工作目录。'
```

这会向当前会话添加回调，并触发当前 Bot 继续回答。

| 参数 | 用途 |
| --- | --- |
| `--session <id>` | 目标会话，默认读 `BOTD_SESSION_ID` |
| `--bot <id>` | 目标 Bot，默认读 `BOTD_BOT_ID` |
| `--reply-to <botId>` | 后续接力目标，必须满足会话成员规则 |
| `--no-turn` | 只写回调，不触发模型回答 |
| `--delay <duration>` | 延时唤醒，例如 `30s`、`15m`、`2h` |

例如，稍后提醒 Bot 检查进度：

```bash
botd wake --delay 15m --message '检查刚才任务的进度。'
```

延时请求保存为 Hub 的一次性触发器。它不依赖终端里的 `sleep`，但执行时间仍取决于 Hub 轮询、节点连接和会话状态。

## 在脚本中等你确认

`ask` 将问题显示为网页卡片，答案写入 stdout。脚本决定收到答案后执行什么。

下面的例子先请求确认，再创建并上传报告：

```bash
if ! choice=$(botd ask '是否创建本次检查报告？' \
  --options '创建,取消' --timeout 180); then
  exit 1
fi

if [ "$choice" != '创建' ]; then
  exit 0
fi

printf '# 检查报告\n\n生成时间：%s\n' "$(date)" > check-report.md
botd artifact put ./check-report.md --message '检查报告已生成。'
```

取消是正常答案，脚本需要显式处理。超时、连接失败等情况会使命令非零退出。

默认超时为 300 秒。`--timeout 0` 表示无限等待。

### 结构化风险审批卡

涉及高风险变更时，用一行语法糖生成结构化审批卡片：

```bash
if ! choice=$(botd ask '是否将本次变更发布到生产环境？' \
  --risk high \
  --reason '生产数据库 schema 迁移，失败需回滚' \
  --resource 'prod-db/orders' \
  --file ./change.patch --diff); then
  exit 1
fi
```

`--risk <low|medium|high>` 会自动渲染一张 Generative UI 确认卡片，包含：

- 风险等级徽章与对应颜色（红 / 黄 / 蓝）的风险提示 Callout，正文为 `--reason`；
- `--resource` 指定的目标资源（以等宽字体展示）；
- `--file` / `--stdin` 附带的差异或文件预览（折叠面板，`--diff` 指定差异格式）；
- 默认「批准 / 拒绝」按钮（可用 `--options` 覆盖）。

不使用 `--json` 时，所选决策（如 `批准`）以纯文本写入 stdout，可直接用 `choice=$(botd ask ... --risk high ...)` 捕获。手写 `--ui` 规格优先于自动生成的卡片。

### 附上差异或文件预览

准备好尚未应用的补丁文件后，可以发出请求：

```bash
botd ask '是否应用这份补丁？' \
  --options '应用,取消' --diff --file ./proposed-change.patch
```

这条命令只展示补丁并收集答案。它不会自动应用补丁。实际脚本应先检查退出码，再检查答案，最后执行修改。

`--file` 可附上文件预览，`--stdin` 从管道读取预览。`--diff` 指定差异格式。

`ask` 是显式工具，不是所有危险操作的自动拦截器。需要审批的流程必须主动调用它。权限边界见[安全说明](security.md)。

## 在设备之间交接文件

Bot 在本机生成报告后上传：

```bash
botd artifact put ./check-report.md --message '请查看检查报告。'
botd artifact list
```

另一节点拿到实际产物 ID 后下载：

```bash
botd artifact pull art_example -o ./incoming-report.md
```

产物经过 Hub 存储和转发，不要求两台机器共享文件系统。单个文件上限为 **15 MiB**。

附件进入目标 Bot 时，会下载到它的 `workspace/inbox/`。用户也可以从网页上传文件或粘贴截图。

产物接口有独立的所有权限制。共享 Bot 或多人会话不代表所有参与者都能跨用户传输产物，见[团队协作](team.md)。

## 把独立任务放进子会话

当主会话只需要结论时，可以把详细调查交给子会话。

以下示例需要你已拥有目标 Bot `reviewer`：

```bash
botd sessions delegate "$BOTD_SESSION_ID" \
  --bot reviewer \
  --title '审查报告' \
  --prompt '审查继承的检查报告。列出需要补充的证据。'
```

Hub 创建独立子会话，在父会话留下入口。交付物在父子会话间自动双向零拷贝同步：

- 派生时，父会话的产物以同一存储路径的多行引用同步给子会话（附件落到子会话 Bot 的 `workspace/inbox/`）；
- 子会话完成后，新产出的交付物以零拷贝引用回传父会话，并自动向父会话回报摘要，触发主控 Bot 汇总。

查看子任务：

```bash
botd sessions subsessions "$BOTD_SESSION_ID"
```

目标 Bot 必须属于调用者。当前委派接口不能直接使用其他用户共享的 Bot。子会话事件会向上继承父会话的通知通道配置。

同机的多角色协同（并发盲评、流水线、对抗打磨）不需要子会话：主控 Bot 直接通过内置 `Agent` / `SubagentWorkflow` 工具调度角色分身，详见[用户指南](user-guide.md)。

## 定时执行与 Webhook

触发器由 Hub 保存。目标 Bot 必须是会话成员。

### 周期任务

在当前会话中创建每 15 分钟执行一次的任务：

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name '目录检查' --bot "$BOTD_BOT_ID" \
  --prompt '检查工作目录中新生成的报告，汇总变化。' \
  --kind cron --cron '*/15 * * * *'
```

Cron 使用 Hub 服务器本地时间，采用 5 字段表达式。Hub 不运行时不会按时执行。

### 一次性任务

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name '稍后检查' --bot "$BOTD_BOT_ID" \
  --prompt '检查报告是否已经生成。' --kind once --delay 15m
```

### 外部事件（Event Inbox 与子会话派发）

最简单的 Webhook 触发器只需要名称、Bot 和提示词：

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name '构建回报' --bot "$BOTD_BOT_ID" \
  --prompt '分析收到的构建结果。' --kind webhook
```

外部系统向 `POST /api/webhooks/:token` 发送文本或 JSON。完整 URL 允许触发任务，应当保密。

在此基础上，自动化触发器提供一组事件原语：

**子会话派发与事件过滤（`--dispatch subsession`）**：

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name 'PR 审查' --bot "$BOTD_BOT_ID" \
  --prompt '审查 PR 变更并给出结论。' --kind webhook \
  --dispatch subsession \
  --skill pr-review \
  --event-types "pull_request.opened"
```

- `--dispatch append`（默认）唤醒目标会话；`--dispatch subsession` 为每次事件派生一个干净的子会话执行，主会话只保留派生通知和结果回报，作为自动化运行账本。
- `--skill <skillId>` 在触发时自动以 `/skill:<id>` 前缀调用指定技能。
- `--event-types "pull_request.opened,push"` 只接受匹配的事件类型（GitHub 事件自动拼接 action，如 `pull_request.opened`）；不匹配的事件被记录后跳过。

**Event Inbox（事件收件箱）**：

- 每次触发都落库为自动化事件记录，可通过 `GET /api/sessions/:id/automation-events` 查询（含派生的子会话 ID 和载荷产物 ID）。
- Webhook 原始载荷自动保存为 `event_<id>.json` 产物，投递到目标会话的 `workspace/inbox/`。不可信载荷不直接拼入提示词，防止提示词注入。
- 去重：`X-Botd-Dedup` 或 `X-GitHub-Delivery` 头作为去重键，内存短窗口 + `automation_events` 唯一索引双重去重，跨 Hub 重启依然生效。
- 限流：同一 token 最小触发间隔 10 秒，超出返回 `429`；事件过滤不匹配不消耗限流窗口。

子会话派发模式下，Webhook 响应体额外返回 `eventId` 与 `childSessionId`。

管理触发器：

```bash
botd triggers list "$BOTD_SESSION_ID"
```

删除时使用实际触发器 ID：

```bash
botd triggers delete trg_example
```

### 通知 Outbox 与按需打扰（tellPolicy）

通知通道把会话事件发送到飞书、Slack、Telegram 或自定义 Webhook。通道支持 `tellPolicy` 字段：

| 策略 | 行为 |
| --- | --- |
| `always` | 默认，所有订阅事件都推送 |
| `needed` | 仅在请求人工确认（`ask_request`）或子任务执行失败时推送，日常成功静默 |
| `never` | 全静默 |

子会话事件自动向上继承父会话的通道配置（同一通道去重，不重复推送）；继承通知附带 `channelSessionId`，便于消费方区分事件源与通道归属。

出站通知先写入持久化 Outbox 再投递：失败按指数退避自动重试，超过上限标记 `dead`；通过 `GET /api/sessions/:id/outbox` 查询近期投递记录与重试状态。`webhook` 类型通道可配置 `secret`，Hub 会以 `X-Botd-Signature: sha256=<hmac>` 头签名请求体。

接口细节见 [API 参考](api.md)。

出站通知与入站 Webhook 是不同功能。

## 把跑通的流程保存成技能

技能是操作说明。它可以写清使用前提、真实命令和失败处理。

例如，在节点 `skills/report-check/SKILL.md` 中保存：

```markdown
---
name: report-check
description: 用户需要检查工作目录中的报告时使用。
---
# 检查报告

1. 列出工作目录中的报告文件。
2. 读取用户指定的报告。
3. 标出缺少证据的结论。
4. 将检查结果写成新文件。
5. 使用 botd artifact put 上传检查结果。
```

默认节点技能目录是 `~/.botd/skills/`。创建后执行 `botd reload`，再在 Bot 编辑器中启用。

技能不会安装它引用的 CLI。目标工具需要在执行节点上可用。网页还可以将技能同步到自己拥有的其他在线节点。

## 提示词与扩展命令

Bot 专属提示词模板放在 `bots/<botId>/prompts/`。例如 `review.md` 对应 `/review`。

已启用技能使用 `/skill:<name>`。扩展注册的命令也会出现在网页 `/` 菜单中。

Pi 负责模板参数展开与命令执行。网页每次只把命令交给一个 Bot，可使用 `@botId /命令 参数` 选择成员。

需要终端 UI 的扩展命令可能无法在网页运行。网页会报告不支持的交互，不应将命令出现在菜单中视为完整支持。

扩展是可执行代码，加载前应检查来源。安装语法见 [CLI 参考](cli.md)。
