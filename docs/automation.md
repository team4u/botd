# 自动化指南

[文档目录](README.md)

让任务在后台跑，让会话负责交代进度。botd 提供后台任务、唤醒、人工确认、产物和触发器，可以组合进现有脚本。

本页示例在 **Bot 的 Bash 工具环境**中执行。该环境提供 `botd` 命令和当前会话信息。

从外部终端调用时，需要本机 Node Agent 运行。使用源码 CLI 入口，并补齐会话、Bot 和数据目录参数。详见 [CLI 参考](cli.md)。

## 先体验一次后台回报

让 Bot 运行以下命令：

```bash
botd bg run -- 'sleep 5; date'
```

命令立即返回任务 ID、PID 和日志路径。后台命令结束后，Node Agent 向原会话发送唤醒消息。消息包含退出状态和最后 20 行日志摘要，随后触发 Bot 汇报。

这个任务不占用当前模型回合。Bot 仍需结束当前发言，回调才能进入会话队列处理。

如果只需要投递结果，不需要模型总结：

```bash
botd bg run --no-turn -- 'sleep 5; date'
```

### 任务生命周期

后台任务由 Node Agent 管理。它经历以下状态：

| 状态 | 含义 |
| --- | --- |
| `running` | 命令仍在执行 |
| `done` | 命令退出码为 0 |
| `failed` | 退出码非 0，或进程启动失败 |
| `killed` | 被手动终止 |

查看和停止任务：

```bash
botd bg list
```

`bg list` 按启动时间倒序。用 `--session <id>` 或 `--bot <id>` 过滤。

将下面 ID 换成 `bg run` 返回的任务 ID：

```bash
botd bg logs bg_example --lines 50
botd bg kill bg_example
```

行为细节：

- 日志保存在 Bot 工作区的 `.bg/<jobId>.log`。`bg logs` 从文件尾部读取，默认 100 行。
- `bg kill` 终止整个进程树。进程忽略 SIGTERM 时，自动升级为 SIGKILL。
- 终止无法确认时，任务保持 `running`。连续 3 次确认失败后，任务标记为 `failed`。
- 手动终止不触发唤醒回调。
- 对已结束的任务调用 `bg kill`，不改变原状态。
- 任务只存在于 Node Agent 内存中。Node Agent 退出时清理全部受管进程，重启后不恢复任务。

`bg kill` 针对后台进程树。聊天中的停止按钮针对模型回合和排队任务。两者不能互相替代。

## 让已有脚本回报进度

任务由其他程序启动时，完成后调用：

```bash
botd wake --message '日志分析完成，报告保存在工作目录。'
```

`wake` 向当前会话写入一条回调消息，并触发 Bot 重新回答。使用时机：

- 外部脚本、定时脚本或 CI 任务完成后，需要 Bot 接手总结。
- `bg run` 不适用的场景，例如命令已在别处启动。

| 参数 | 用途 |
| --- | --- |
| `--session <id>` | 目标会话，默认读 `BOTD_SESSION_ID` |
| `--bot <id>` | 目标 Bot，默认读 `BOTD_BOT_ID` |
| `--message <msg>` | 回调消息内容，必填 |
| `--reply-to <botId>` | 后续接力目标，必须满足会话成员规则 |
| `--no-turn` | 只写回调，不触发模型回答 |
| `--delay <duration>` | 延时唤醒，例如 `30s`、`15m`、`2h`、`1d` |

稍后提醒 Bot 检查进度：

```bash
botd wake --delay 15m --message '检查刚才任务的进度。'
```

延时请求保存为 Hub 的一次性触发器，命令输出 `scheduledTriggerId`。它不依赖终端里的 `sleep`。实际触发时间仍取决于 Hub 轮询、节点连接和会话状态。

## 在脚本中等你确认

`ask` 把问题显示为确认卡片，答案写入 stdout。脚本根据答案决定后续动作。

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

取消是正常答案，脚本需要显式处理。超时或连接失败会使命令非零退出。

默认超时为 300 秒。`--timeout 0` 表示无限等待。

### 两条响应路径

`ask` 发出后，用户可以从两个入口作答：

1. **网页卡片**。Hub 向会话广播 `interaction_request` 事件，网页渲染交互卡片。用户提交后，命令立即收到答案。
2. **外部通知通道**。会话配置了订阅 `ask_request` 的通知通道时，Hub 推送确认请求。消息为每个选项附一条免登录回调链接，指向 `/api/public/asks/:askId/respond`。点击链接等同作答。

两条路径回答同一个待确认请求。先到先生效。

### 结构化风险审批卡

涉及高风险变更时，用一行语法生成结构化审批卡片：

```bash
if ! choice=$(botd ask '是否将本次变更发布到生产环境？' \
  --risk high \
  --reason '生产数据库 schema 迁移，失败需回滚' \
  --resource 'prod-db/orders' \
  --file ./change.patch --diff); then
  exit 1
fi
```

`--risk <low|medium|high>` 自动渲染一张 Generative UI 审批卡，包含：

- 风险等级徽章与提示 Callout。`high` 为红色、`medium` 黄色、`low` 蓝色，正文为 `--reason`。
- `--resource` 指定的目标资源，`--file` 的文件路径，均以等宽字体展示。
- `--file` / `--stdin` 附带的差异或文件预览，折叠面板展示。`--diff` 指定差异格式。
- 默认「批准 / 拒绝」按钮。用 `--options` 可覆盖。匹配「拒绝、取消、中止、reject、cancel、deny」的按钮渲染为危险样式。

不带 `--json` 时，所选决策以纯文本写入 stdout。可以直接用 `choice=$(botd ask ...)` 捕获。手写 `--ui` 规格优先于自动生成的卡片。

### 附上差异或文件预览

准备好尚未应用的补丁后，发出请求：

```bash
botd ask '是否应用这份补丁？' \
  --options '应用,取消' --diff --file ./proposed-change.patch
```

这条命令只展示补丁并收集答案，不会自动应用补丁。实际脚本应先检查退出码，再检查答案，最后执行修改。

预览内容上限为 256 KiB。`--file` 按扩展名识别类型：`.md` 为 markdown，`.diff` 和 `.patch` 为差异，`.ui.json` 为 UI 规格。`--stdin` 从管道读取预览。

`--ui` 渲染交互式 UI 卡，`--ui-schema` 打印 botd.v1 UI 规格文档。详见[生成式 UI](generative-ui.md)。

`ask` 是显式工具，不是危险操作的自动拦截器。需要审批的流程必须主动调用它。权限边界见[安全边界](security.md)。

## 在设备之间交接文件

Bot 在本机生成报告后上传：

```bash
botd artifact put ./check-report.md --message '请查看检查报告。'
botd artifact list
```

另一节点拿到产物 ID 后下载：

```bash
botd artifact pull art_example -o ./incoming-report.md
```

`artifact pull` 不带 `-o` 时，保存为当前目录下的原始文件名。命令组别名为 `artifacts`。

产物经过 Hub 存储和转发，不要求两台机器共享文件系统。单个文件上限为 **15 MiB**。

附件进入目标 Bot 时，下载到它工作区的 `inbox/` 目录。用户也可以从网页上传文件或粘贴截图。

产物接口有独立的所有权限制。共享 Bot 或多人会话不代表所有参与者都能跨用户传输产物。详见[团队协作](team.md)。

## 事件收件箱

Webhook 触发器每次收到请求，Hub 都记录一条自动化事件。事件构成会话的自动化运行账本。

- 查询接口为 `GET /api/sessions/:id/automation-events`，按时间倒序，默认返回 100 条，可用 `limit` 参数调整。
- 事件记录包含来源（`source`）、事件类型（`eventType`）、去重键（`dedupKey`）、摘要（`summary`）。
- 子会话派发模式下，记录还包含子会话 ID（`childSessionId`）和载荷产物 ID（`payloadArtifactId`）。
- Webhook 原始载荷保存为 `event_<id>.json` 产物，投递到目标会话的 `workspace/inbox/`。子会话的初始消息只引用该文件，不拼接不可信载荷，防止提示词注入。空请求体不落盘。

### 区分自动化回合与手动回合

Bot 的工具环境注入以下变量，脚本和扩展可据此判断本轮触发来源：

| 变量 | 含义 |
| --- | --- |
| `BOTD_TURN_TRIGGER` | `automation` 或 `manual` |
| `BOTD_TURN_EVENT_KIND` | 事件类型，见下表 |
| `BOTD_TURN_EVENT_NAME` | 触发器或任务名称 |
| `BOTD_TURN_EVENT_AT` | 本轮开始时间，ISO 格式 |

`BOTD_TURN_EVENT_KIND` 的取值：

| 值 | 来源 |
| --- | --- |
| `cron` | 周期触发器 |
| `once` | 一次性触发器 |
| `webhook` | Webhook 触发器 |
| `manual-trigger` | 网页手动触发 |
| `delayed-wake` | 延时唤醒 |
| `bg-job` | 后台任务完成 |
| `chat` | 用户手动发起（此时 `BOTD_TURN_TRIGGER` 为 `manual`） |

例如，脚本可以按触发来源决定详细程度：

```bash
if [ "$BOTD_TURN_TRIGGER" = "automation" ]; then
  echo "由 $BOTD_TURN_EVENT_KIND 触发：$BOTD_TURN_EVENT_NAME"
fi
```

## 把独立任务放进子会话

主会话只需要结论时，把详细调查交给子会话。

以下示例需要你已拥有目标 Bot `reviewer`：

```bash
botd sessions delegate "$BOTD_SESSION_ID" \
  --bot reviewer \
  --title '审查报告' \
  --prompt '审查继承的检查报告。列出需要补充的证据。'
```

Hub 创建独立子会话，在父会话留下入口。交付物在父子会话间双向零拷贝同步：

- 派生时，父会话的产物以同一存储路径的引用同步给子会话。附件落到子会话 Bot 的 `workspace/inbox/`。
- 子会话完成后，新产出的交付物以零拷贝引用回传父会话。Hub 向父会话回报摘要，触发主控 Bot 汇总。

查看子任务：

```bash
botd sessions subsessions "$BOTD_SESSION_ID"
```

目标 Bot 必须属于调用者。委派接口不能直接使用其他用户共享的 Bot。子会话事件向上继承父会话的通知通道配置，同一通道去重，不重复推送。

同机的多角色协同（并发盲评、流水线、对抗打磨）不需要子会话。主控 Bot 直接通过内置 `Agent` / `SubagentWorkflow` 工具调度子代理。详见[用户指南](user-guide.md)。

## 定时执行与 Webhook

触发器由 Hub 保存和调度。目标 Bot 必须是会话成员。触发器分三类：

| 类型 | `--kind` | 关键参数 |
| --- | --- | --- |
| 周期任务 | `cron` | `--cron`，5 字段表达式，Hub 本地时间 |
| 一次性任务 | `once` | `--delay <duration>` 或 `--at <时间>` |
| 外部事件 | `webhook` | 生成 `POST /api/webhooks/:token` 入口 |

创建每 15 分钟执行一次的检查：

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name '目录检查' --bot "$BOTD_BOT_ID" \
  --prompt '检查工作目录中新生成的报告，汇总变化。' \
  --kind cron --cron '*/15 * * * *'
```

一次性定时任务：

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name '稍后检查' --bot "$BOTD_BOT_ID" \
  --prompt '检查报告是否已经生成。' --kind once --delay 15m
```

最简单的 Webhook 触发器：

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name '构建回报' --bot "$BOTD_BOT_ID" \
  --prompt '分析收到的构建结果。' --kind webhook
```

外部系统向 `POST /api/webhooks/:token` 发送文本或 JSON。完整 URL 可以触发任务，应当保密。

### 子会话派发与事件过滤

每次事件派生独立子会话执行，主会话只保留账本：

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name 'PR 审查' --bot "$BOTD_BOT_ID" \
  --prompt '审查 PR 变更并给出结论。' --kind webhook \
  --dispatch subsession \
  --skill pr-review \
  --event-types "pull_request.opened"
```

- `--dispatch append` 是默认值，唤醒目标会话。`--dispatch subsession` 为每次事件派生子会话，标题为 `[自动任务] <名称>`。Webhook 响应附带 `eventId` 与 `childSessionId`。
- `--skill <skillId>` 在触发时以 `/skill:<id>` 前缀调用技能。
- `--event-types` 只接受匹配的事件类型。GitHub 事件自动拼接 action，如 `pull_request.opened`。不匹配的事件记录后跳过。
- `--secret` 要求请求携带 `x-hub-signature-256` 签名头，即 `sha256=<hmac>`。签名不符返回 `401`。

Webhook 请求还有两条保护：

- 去重：`X-Botd-Dedup` 或 `X-GitHub-Delivery` 头作为去重键。内存短窗口加 `automation_events` 唯一索引双重去重，跨 Hub 重启仍生效。
- 限流：同一 token 最小触发间隔 10 秒，超出返回 `429`。事件过滤不匹配不消耗限流窗口。

管理触发器：

```bash
botd triggers list "$BOTD_SESSION_ID"
botd triggers delete trg_example
```

删除时使用实际触发器 ID。完整参数与 API 细节见 [CLI 参考](cli.md)、[HTTP API](api.md) 和[触发器指南](triggers.md)。

### 通知 Outbox 与按需打扰

通知通道把会话事件发送到飞书、Slack、Telegram 或自定义 Webhook。通道支持 `tellPolicy` 字段：

| 策略 | 行为 |
| --- | --- |
| `always` | 默认，所有订阅事件都推送 |
| `needed` | 仅在请求人工确认或任务失败时推送，日常成功静默 |
| `never` | 全静默 |

出站通知先写入持久化 Outbox 再投递。失败按指数退避自动重试，超过上限标记 `dead`。通过 `GET /api/sessions/:id/outbox` 查询投递记录。`webhook` 类型通道可配置 `secret`，Hub 以 `X-Botd-Signature: sha256=<hmac>` 头签名请求体。

出站通知与入站 Webhook 是不同功能。前者是 Hub 推出事件，后者是外部系统触发任务。

## 把跑通的流程保存成技能

技能是操作说明。它可以写清使用前提、真实命令和失败处理。

在节点技能目录保存 `~/.botd/skills/report-check/SKILL.md`：

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

创建后执行 `botd reload`，再在 Bot 编辑器中启用。

技能不会安装它引用的 CLI。目标工具需要在执行节点上可用。网页还可以将技能同步到自己拥有的其他在线节点。

## 提示词与扩展命令

Bot 专属提示词模板放在 `bots/<botId>/prompts/`。例如 `review.md` 对应 `/review`。

已启用技能使用 `/skill:<name>`。扩展注册的命令也会出现在网页 `/` 菜单中。

Pi 负责模板参数展开与命令执行。网页每次只把命令交给一个 Bot。可用 `@botId /命令 参数` 选择成员。

需要终端 UI 的扩展命令可能无法在网页运行。网页会报告不支持的交互。命令出现在菜单中不等于完整支持。

扩展是可执行代码，加载前应检查来源。安装语法见 [CLI 参考](cli.md)。
