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

Hub 创建独立子会话，继承父会话的产物引用，在父会话留下入口。子任务完成或失败后，会回报父会话并触发后续处理。

查看子任务：

```bash
botd sessions subsessions "$BOTD_SESSION_ID"
```

目标 Bot 必须属于调用者。当前委派接口不能直接使用其他用户共享的 Bot。

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

### 外部事件

```bash
botd triggers create "$BOTD_SESSION_ID" \
  --name '构建回报' --bot "$BOTD_BOT_ID" \
  --prompt '分析收到的构建结果。' --kind webhook
```

外部系统向 `POST /api/webhooks/:token` 发送文本或 JSON。令牌来自触发器记录。完整 URL 允许触发任务，应当保密。

管理触发器：

```bash
botd triggers list "$BOTD_SESSION_ID"
```

删除时使用实际触发器 ID：

```bash
botd triggers delete trg_example
```

出站通知与入站 Webhook 是不同功能。通知通道把会话事件发送到飞书、Slack、Telegram 或自定义 Webhook，接口见 [API 参考](api.md)。

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
