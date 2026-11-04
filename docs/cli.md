# CLI 参考

botd CLI 提供命令行管理入口。用户可通过 CLI 管理本机 Node 守护进程，也可管理 Hub 资源。[返回文档目录](README.md)

## 命令入口

用户可通过三种入口执行 CLI 命令：

| 入口 | 说明 |
| --- | --- |
| `pnpm node` | 源码仓库开发命令。映射到 `pnpm --filter @botd/node cli`。 |
| `node apps/node/dist/cli.js` | 编译产物入口。输出内容纯净，适合脚本解析。 |
| `botd` | 全局安装命令。包入口指向 `dist/cli.js`。 |

查看全局帮助信息：

```bash
botd --help
botd sessions --help
botd chat send --help
```

尖括号 `<value>` 表示必填参数。方括号 `[value]` 表示选填参数。

## 全局选项

全局选项适用于全部子命令：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--json` | 无 | 输出 JSON 格式数据。 |
| `--data-dir <dir>` | `~/.botd` | 指定数据目录。优先级高于 `BOTD_DATA_DIR`。 |
| `--hub <url>` | `cli.json` 所存地址 | 指定目标 Hub 地址。优先级高于环境变量。 |
| `--password <password>` | 无 | 指定 Hub 登录密码。优先级高于 `BOTD_ADMIN_PASSWORD`。 |
| `--timeout <seconds>` | `30` | 指定 HTTP 请求超时秒数。 |
| `-V, --version` | 无 | 显示当前版本号。 |
| `-h, --help` | 无 | 显示当前命令帮助信息。 |

## 输出格式与错误处理

添加 `--json` 选项时，CLI 输出原始 JSON 数据。

省略 `--json` 选项时，CLI 采用文本格式输出：

- 对象列表渲染为表格。
- 单个对象渲染为键值对。
- 内容类命令（如 `skills get`）直接输出正文。

命令执行失败时，进程退出码为 `1`。CLI 将错误原因写入标准错误。在 `--json` 模式下，CLI 输出 `{"error": "原因"}`。

## 登录与鉴权

```text
botd login <hubUrl> [--username <name>] [--save-credentials]
botd logout
botd health
```

### login

登录 Hub 并保存会话凭据。

```bash
botd login http://localhost:3002 --username admin --password 'your-password'
```

本地开发环境 Hub 监听 `3002` 端口。生产环境 Hub 默认监听 `3000` 端口。

| 参数或选项 | 说明 |
| --- | --- |
| `<hubUrl>` | Hub 服务地址。CLI 自动裁剪末尾斜杠。 |
| `--username <name>` | 登录用户名。默认读取 `BOTD_USERNAME` 或使用 `admin`。 |
| `--save-credentials` | 将密码明文写入 `cli.json`（权限 0600）。默认不保存。 |

用户必须提供密码。用户可通过 `--password` 选项或 `BOTD_ADMIN_PASSWORD` 环境变量传入密码。

登录成功后，CLI 将令牌写入 `<数据目录>/cli.json`。CLI 随后调用 `GET /api/auth/me` 验证有效性。

### logout

登出当前 Hub。CLI 请求 `POST /api/auth/logout`，随后清空 `cli.json` 文件。

### health

检查 Hub 服务健康状态。CLI 匿名调用 `GET /api/health` 接口。

```bash
botd health
```

### 凭据解析规则

CLI 按以下顺序解析 Hub 地址：

1. 命令行选项 `--hub`。
2. 环境变量 `BOTD_HUB_URL`。
3. `cli.json` 文件中的 `hubUrl` 字段。

CLI 仅在目标地址与已存地址一致时复用令牌。收到 `401` 错误且具备密码时，CLI 自动重新登录。

无令牌且无密码时，CLI 读取本地配对凭据 `node.json`。CLI 携带节点凭据头访问 Hub。

## 节点守护进程管理

这组命令管理本机 Node 守护进程。命令通过本地 IPC 通信，无需登录 Hub。

POSIX 系统使用 Unix Domain Socket：`<数据目录>/agent.sock`。

Windows 系统使用命名管道：`\\.\pipe\botd-agent-<hash>`。

守护进程将通信令牌写入 `<数据目录>/ipc-token`（权限 0600）。CLI 自动携带该令牌。

### start

启动 Node 守护进程。

```bash
# 前台启动
botd start

# 后台启动
botd start -d --log-file ~/.botd/daemon.log
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `-d, --detach` | `false` | 转入后台执行。 |
| `--log-file <path>` | `<数据目录>/daemon.log` | 指定后台日志文件路径。 |

### restart

重启 Node 守护进程。CLI 先停止已启动的守护进程，随后在后台启动新守护进程。

```bash
botd restart
```

### reload

重载 Node 资源配置。守护进程重新扫描本地 Skills、Extensions 与 Bots，并同步至 Hub。

```bash
botd reload
```

### stop

停止本地 Node 守护进程。

```bash
botd stop
```

### status

查询本地 Node 守护进程状态。

```bash
botd status
```

守护进程执行时，输出 PID、运行时长、节点名称、Node ID 与 Hub 连接状态。未启动时退出码为 `1`。

### upgrade

检查或执行 Node 节点程序升级。

```bash
# 检查可用更新
botd upgrade --check

# 执行升级
botd upgrade

# 指定版本与 npm 源升级
botd upgrade --version 0.2.1 --registry https://registry.npmmirror.com
```

| 选项 | 说明 |
| --- | --- |
| `--check` | 仅检查可用更新，不执行升级操作。 |
| `--version <ver>` | 指定升级目标版本号。 |
| `--registry <url>` | 指定 npm registry 地址。 |
| `--force` | 强制执行升级操作。 |

### service

管理操作系统后台服务（systemd / launchd / Windows Service）。

```bash
# 安装系统服务
botd service install

# 查看系统服务状态
botd service status

# 卸载系统服务
botd service uninstall
```

| 选项 | 说明 |
| --- | --- |
| `--dry-run` | 创建服务配置文件，不应用系统修改。 |

### join

将本机节点配对连接至 Hub。

```bash
botd join http://localhost:3002 --code 123456 --name my-node
```

| 参数或选项 | 说明 |
| --- | --- |
| `<hubUrl>` | 目标 Hub 服务地址。 |
| `--code <code>` | Hub 创建的 6 位一次性配对码。 |
| `--name <name>` | 节点显示名称。 |

配对成功后，CLI 将配对凭据写入 `<数据目录>/node.json`。

### wake

向会话发送唤醒触发指令。

```bash
# 立即唤醒会话并触发推理
botd wake --session sess_1 --bot bot_1 --message "外部构建已完成"

# 仅插入消息，不触发模型推理
botd wake --session sess_1 --bot bot_1 --message "记录日志" --no-turn

# 延迟 15 分钟唤醒
botd wake --session sess_1 --bot bot_1 --message "检查长任务" --delay 15m
```

| 选项 | 说明 |
| --- | --- |
| `--session <id>` | 目标会话 ID。默认读取 `BOTD_SESSION_ID`。 |
| `--bot <id>` | 目标 Bot ID。默认读取 `BOTD_BOT_ID`。 |
| `--message <msg>` | 投递的唤醒消息文本。 |
| `--reply-to <botId>` | 唤醒后转交或提及的 Bot ID。 |
| `--no-turn` | 仅插入消息并广播 SSE，不触发模型推理。 |
| `--delay <duration>` | 延迟唤醒时长（例如 `30s`、`15m`、`2h`、`1d`）。 |

## 产物管理（Artifacts）

产物管理命令通过本地守护进程 IPC 上传或下载会话文件。

```text
botd artifact put <filePath> [--session <id>] [--bot <id>] [--message <msg>]
botd artifact pull <artifactId> [-o, --output <path>]
botd artifact list [--session <id>]
```

### artifact put

将本地文件上传为会话产物。

```bash
botd artifact put ./report.pdf --session sess_1 --bot bot_1 --message "输出测试报告"
```

| 选项 | 说明 |
| --- | --- |
| `<filePath>` | 本地文件路径。 |
| `--session <id>` | 关联会话 ID。默认读取 `BOTD_SESSION_ID`。 |
| `--bot <id>` | 发送方 Bot ID。默认读取 `BOTD_BOT_ID`。 |
| `--message <msg>` | 随产物发送的说明消息。 |

### artifact pull

从会话下载指定产物文件至本地。

```bash
botd artifact pull art_123 -o ./downloaded.pdf
```

| 参数或选项 | 说明 |
| --- | --- |
| `<artifactId>` | 产物唯一标识 ID。 |
| `-o, --output <path>` | 本地保存路径。默认使用产物原始文件名。 |

### artifact list

列出会话关联的全部产物文件。

```bash
botd artifact list --session sess_1
```

## Hub 节点管理

```text
botd nodes list
botd nodes pair
botd nodes install <nodeId> <source> [--kind <auto|skill|extension>] [--id <customId>]
botd nodes upgrade <nodeId> [--version <ver>] [--registry <url>] [--check]
```

### nodes list

列出 Hub 当前连接的全部节点及其承载的 Bot 列表。

```bash
botd nodes list
```

### nodes pair

创建新节点配对码。

```bash
botd nodes pair
```

命令输出配对码与过期时间。目标机器使用该配对码执行 `botd join`。

### nodes install

向指定在线节点安装 Skill 或 Extension 资产。

```bash
botd nodes install node_1 github:user/repo --kind skill --id my-skill
```

| 参数或选项 | 说明 |
| --- | --- |
| `<nodeId>` | 目标节点 ID。 |
| `<source>` | 资产来源路径或 Git 仓库地址。 |
| `--kind <kind>` | 资产类型：`auto`、`skill`、`extension`。 |
| `--id <customId>` | 自定义安装标识 ID。 |

### nodes upgrade

远程检查或触发指定在线节点的程序升级。

```bash
botd nodes upgrade node_1 --check
botd nodes upgrade node_1 --version 0.2.1
```

## Bot 管理

```text
botd bots list [--node <nodeId>] [--parent <parentBotId>]
botd bots create <botId> --name <name> --model <provider/modelId> [选项...]
botd bots update <botId> [选项...]
botd bots delete <botId>
botd bots system get <botId>
botd bots system put <botId> [--file <path>]
botd bots memory get <botId>
botd bots memory put <botId> [--file <path>]
botd bots env list <botId>
botd bots env set <botId> <KEY=VALUE...> [--replace]
botd bots env unset <botId> <KEY...>
```

### bots list

列出当前 Hub 全部 Bot 及子代理。

```bash
botd bots list --node node_1
```

### bots create

创建新 Bot 配置。

```bash
botd bots create code-reviewer \
  --name "代码评审员" \
  --model anthropic/claude-sonnet-4-5 \
  --desc "负责分析代码变更并提出建议" \
  --thinking medium \
  --skill git-review \
  --system-file ./prompts/reviewer.md \
  --workspace /home/user/project
```

| 参数或选项 | 说明 |
| --- | --- |
| `<botId>` | Bot 唯一标识 ID。 |
| `--name <name>` | 必填，Bot 显示名称。 |
| `--model <provider/modelId>` | 必填，模型格式为供应商/模型 ID。 |
| `--node <nodeId>` | 所属节点 ID。默认读取 `BOTD_NODE_ID` 或使用 `local`。 |
| `--desc <desc>` | Bot 功能描述文本。 |
| `--thinking <level>` | 思考预算级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。 |
| `--skill <ids...>` | 启用的 Skill ID 列表。 |
| `--extension <ids...>` | 启用的 Extension ID 列表。 |
| `--system-file <path>` | 配置 SYSTEM.md 文件路径，`-` 表示标准输入。 |
| `--workspace <dir>` | 绑定的项目工作区目录。 |

### bots update

修改已有 Bot 配置。选项与 `create` 一致。仅修改传入的字段。

### bots delete

删除指定的 Bot 配置。

```bash
botd bots delete code-reviewer
```

### bots system / memory

读取或写入 Bot 的系统提示词 `SYSTEM.md` 与长期记忆 `MEMORY.md`。

```bash
# 读取 SYSTEM.md
botd bots system get code-reviewer

# 写入 SYSTEM.md
botd bots system put code-reviewer --file ./SYSTEM.md

# 读取 MEMORY.md
botd bots memory get code-reviewer

# 写入 MEMORY.md
botd bots memory put code-reviewer --file ./MEMORY.md
```

### bots env

管理 Bot 的独立环境变量与密钥配置。

```bash
# 列出环境变量键名列表
botd bots env list code-reviewer

# 设置环境变量
botd bots env set code-reviewer GITHUB_TOKEN=ghp_xxx API_KEY=sk_xxx

# 全量替换环境变量
botd bots env set code-reviewer GITHUB_TOKEN=ghp_xxx --replace

# 删除指定环境变量
botd bots env unset code-reviewer API_KEY
```

## 会话管理（Sessions）

```text
botd sessions list
botd sessions create --title <title> --lead <botId>
botd sessions update <sessionId> [--title <title>] [--lead <botId>] [--archive <true|false>]
botd sessions messages <sessionId>
botd sessions search <query...> [--session <sessionId>] [--limit <n>]
botd sessions cancel <sessionId>
botd sessions delete <sessionId>
botd sessions clear <sessionId>
botd sessions edit <sessionId> <messageId> [words...]
botd sessions fork <sessionId> --anchor <messageId>
botd sessions share <sessionId> [--revoke] [--regenerate]
botd sessions subsessions <parentSessionId>
```

### sessions create

创建新会话。

```bash
botd sessions create --title "重构接口" --lead code-reviewer
```

### sessions update

修改会话标题、主导 Bot 或归档状态。

```bash
botd sessions update sess_1 --title "新标题" --archive true
```

### sessions messages

查看会话历史消息记录列表。

```bash
botd sessions messages sess_1
```

### sessions search

在会话消息历史中检索关键词。

```bash
botd sessions search "性能优化" --limit 20
botd sessions search "重构" --session sess_1
```

### sessions cancel

取消当前正在执行的会话推理回合。

```bash
botd sessions cancel sess_1
```

### sessions clear

清空指定会话的消息历史，并重置 Bot 本地会话上下文。

```bash
botd sessions clear sess_1
```

### sessions edit

修改已发送的用户消息。Hub 截断该消息后的历史并重新触发推理。

```bash
botd sessions edit sess_1 msg_100 "请改用 Python 实现上述逻辑"
```

### sessions fork

从指定的锚点消息分叉派生新会话。新会话复制锚点前的全部历史记录。

```bash
botd sessions fork sess_1 --anchor msg_100
```

### sessions share

创建、查看或吊销会话的公开分享链接。

```bash
# 创建或获取分享链接
botd sessions share sess_1

# 重新创建分享凭据令牌
botd sessions share sess_1 --regenerate

# 吊销公开分享链接
botd sessions share sess_1 --revoke
```

### sessions subsessions

列出指定父会话派生的全部独立子会话。

```bash
botd sessions subsessions sess_1
```

## 后台 Worker 管理（Super-agent）

Worker 命令管理会话派生的后台工作单元。Worker 支持独立 Git Worktree 隔离与异步事件投递。

```text
botd workers list <sessionId>
botd workers spawn <sessionId> --title <title> --task <prompt> [选项...]
botd workers steer <sessionId> <workerId> <message...> [--mode <steer|followUp>]
botd workers stop <sessionId> <workerId>
botd workers recall <sessionId> <workerId>
```

### workers list

列出会话下的全部后台 Worker 及其状态。

```bash
botd workers list sess_1
```

输出字段包含 `workerId`、`title`、`status`（`running`、`completed`、`failed`、`aborted`）、`worktreePath` 与 `threadKeys`。

### workers spawn

派生后台 Worker 执行长耗时任务。命令立即返回 Worker 概要信息。

```bash
botd workers spawn sess_1 \
  --title "重构用户模块" \
  --task "将用户登录逻辑迁移到独立服务，并补齐测试" \
  --bot code-reviewer \
  --worktree \
  --thread-key ci-deploy
```

| 参数或选项 | 说明 |
| --- | --- |
| `<sessionId>` | 归属的父会话 ID。 |
| `--title <title>` | 必填，Worker 任务短标题。 |
| `--task <prompt>` | 必填，Worker 任务完整指令。 |
| `--bot <botId>` | 指定身份 Bot。默认使用会话主导 Bot。 |
| `--worktree` | 在项目仓库中分配独立的 Git Worktree 隔离目录。 |
| `--thread-key <keys...>` | 订阅的事件线程键。匹配事件直通该 Worker。 |

### workers steer

向执行中的 Worker 注入追加消息。

```bash
# 中途插话引导（中断当前操作）
botd workers steer sess_1 wrk_100 "优先修复编译错误" --mode steer

# 追加跟进指令（排队至本轮结束后执行）
botd workers steer sess_1 wrk_100 "完成后输出测试覆盖率" --mode followUp
```

### workers stop

强制终止指定后台 Worker 的执行。主会话与其他 Worker 不受影响。

```bash
botd workers stop sess_1 wrk_100
```

### workers recall

检视 Worker 的记忆回忆链（Chain-of-Recall）节点与最近执行 Transcript。

```bash
botd workers recall sess_1 wrk_100
```

## 人机协同交互（Asks）

Bot 可发起 Ask 请求等待人工确认。用户通过该命令检视并代答。

```text
botd asks list <sessionId>
botd asks respond <sessionId> <askId> <answer...>
```

### asks list

列出指定会话当前处于等待状态的人机协同请求。

```bash
botd asks list sess_1
```

输出包含 `id`、`prompt`、`options`、`status` 与 `previewType`（`diff`、`markdown`、`text`、`ui`）。

### asks respond

回答指定的待确认请求。

```bash
botd asks respond sess_1 ask_100 批准执行
```

## 事件路由管线（Events）

将外部事件摄入 Super-agent EventRouter 管线。EventRouter 自动通过 `threadKey` 直通 Worker 或交付 Router 会话。

```text
botd events ingest --source <source> --type <type> [选项...]
```

```bash
# 摄入 GitHub CI 事件
botd events ingest \
  --source github \
  --type check_suite.completed \
  --repo team4u/botd \
  --branch main \
  --content "CI checks passed on commit a1b2c3d"

# 通过文件或标准输入导入事件载荷
cat payload.json | botd events ingest --source ci --type build.failed --file -
```

| 选项 | 说明 |
| --- | --- |
| `--source <source>` | 必填，事件来源（例如 `github`、`ci`、`custom`）。 |
| `--type <type>` | 必填，事件类型（例如 `push`、`pull_request.opened`）。 |
| `--content <content>` | 事件正文或载荷内容。 |
| `--file <path>` | 从指定文件或标准输入（`-`）读取正文。 |
| `--title <title>` | 事件简要标题。 |
| `--sender <sender>` | 事件发送者标识。 |
| `--repo <repo>` | 关联仓库（格式为 `owner/repo`）。 |
| `--pr <number>` | 关联 Pull Request 编号。 |
| `--issue <number>` | 关联 Issue 编号。 |
| `--branch <branch>` | 关联 Git 分支名称。 |
| `--session <sessionId>` | 显式投递的目标会话 ID。 |
| `--bot <botId>` | 目标 Bot 标识 ID。 |

## 系统健康诊断（Watchdog）

查看耐久运行时（Durable Runtime）系统健康诊断报告。

```bash
# 查看当前健康报告
botd watchdog health

# 先触发一轮主动巡检，再输出诊断
botd watchdog health --run-pass
```

输出包含系统健康状态布尔值、摘要说明、错误发现列表与干预记录。

## 触发器管理（Triggers）

管理会话自动化触发器。

```text
botd triggers list <sessionId>
botd triggers create <sessionId> --name <name> --bot <botId> --prompt <prompt> [选项...]
botd triggers delete <triggerId>
```

### triggers create

创建会话自动化触发器。

```bash
# 创建定时 Cron 触发器
botd triggers create sess_1 \
  --name "每晨构建巡检" \
  --bot code-reviewer \
  --kind cron \
  --cron "0 9 * * 1-5" \
  --prompt "检查夜间构建产物并汇总失败项"

# 创建 Webhook 触发器
botd triggers create sess_1 \
  --name "GitHub PR 提醒" \
  --bot code-reviewer \
  --kind webhook \
  --secret "my-hmac-secret" \
  --event-source github \
  --event-types "pull_request.opened,pull_request.synchronize" \
  --dispatch subsession \
  --prompt "分析新提交的 PR 变更"

# 创建一次性延时触发器
botd triggers create sess_1 \
  --name "延迟复查" \
  --bot code-reviewer \
  --kind once \
  --delay 30m \
  --prompt "复查后台部署结果"
```

| 参数或选项 | 说明 |
| --- | --- |
| `<sessionId>` | 关联会话 ID。 |
| `--name <name>` | 必填，触发器名称。 |
| `--bot <botId>` | 必填，触发时执行任务的 Bot ID。 |
| `--prompt <prompt>` | 必填，触发时投递的任务提示词。 |
| `--kind <kind>` | 触发器类型：`webhook`（默认）、`cron`、`once`。 |
| `--cron <expr>` | 5 字段 Cron 表达式（服务器本地时间）。`cron` 类型必填。 |
| `--delay <duration>` | 相对延迟时长（如 `30s`、`15m`、`2h`）。`once` 类型选填。 |
| `--at <isoOrDuration>` | 绝对 ISO 时间戳。`once` 类型选填。 |
| `--dispatch <mode>` | 派发模式：`append` 追加到原会话，`subsession` 自动派生子会话。 |
| `--skill <skillId>` | 触发时前缀调用的 Skill ID。 |
| `--secret <secret>` | Webhook HMAC-SHA256 签名密钥。 |
| `--event-source <source>` | Webhook 事件来源匹配规则（如 `github`）。 |
| `--event-types <csv>` | Webhook 允许的事件类型列表（逗号分隔）。 |
| `--match <key=val...>` | Webhook 载荷键值精确匹配规则（支持点路径，可重复）。 |

### triggers delete

删除指定的触发器。

```bash
botd triggers delete trg_100
```

## 会话对话交互（Chat）

```text
botd chat send <sessionId> <message...> [--wait [seconds]]
botd chat watch <sessionId> [--duration <seconds>]
```

### chat send

向指定会话发送消息。

```bash
# 异步发送消息立即返回
botd chat send sess_1 "总结当前的测试覆盖率"

# 发送并等待回复结束（默认等待 300 秒）
botd chat send sess_1 "编写项目文档" --wait 120
```

携带 `--wait` 选项时，CLI 优先创建会话 SSE 订阅流，随后发送消息，持续收集回复直至会话恢复 `idle` 或 `failed` 状态。

### chat watch

实时监听会话 SSE 事件流，以 JSON Lines 格式逐行输出事件。

```bash
# 持续监听事件流
botd chat watch sess_1

# 监听 60 秒后自动退出
botd chat watch sess_1 --duration 60
```

## 全局与节点 Skills 直管

CLI 支持免指定 `nodeId` 直接管理 Hub 全局托管的 Skills。节点无需在线。CLI 也支持指定 `nodeId` 操作特定节点上的专属 Skills。

```text
# 全局模式（单参数）
botd skills list
botd skills get <skillId>
botd skills put <skillId> [--file <path>]
botd skills delete <skillId>

# 节点模式（双参数）
botd skills get <nodeId> <skillId>
botd skills put <nodeId> <skillId> [--file <path>]
botd skills delete <nodeId> <skillId>
```

```bash
# 查看 Hub 全局 Skills 列表
botd skills list

# 读取全局 Skill 内容
botd skills get code-review

# 上传或修改全局 Skill（读取标准输入）
cat SKILL.md | botd skills put code-review

# 上传指定文件为全局 Skill
botd skills put code-review --file ./SKILL.md

# 删除全局 Skill
botd skills delete code-review

# 操作 node_1 节点的专属 Skill
botd skills put node_1 local-tool --file ./LOCAL_SKILL.md
```

## 全局与节点 Extensions 直管

CLI 支持免指定 `nodeId` 直接管理 Hub 全局托管的 Extensions 代码。CLI 也支持指定 `nodeId` 操作特定节点上的专属 Extensions。

```text
# 全局模式（单参数）
botd extensions list
botd extensions get <extId>
botd extensions put <extId> [--file <path>]
botd extensions delete <extId>

# 节点模式（双参数）
botd extensions get <nodeId> <extId>
botd extensions put <nodeId> <extId> [--file <path>]
botd extensions delete <nodeId> <extId>
```

```bash
# 查看 Hub 全局 Extensions 列表
botd extensions list

# 读取全局 Extension 入口代码
botd extensions get github-notifier

# 上传全局 Extension
botd extensions put github-notifier --file ./index.ts

# 删除全局 Extension
botd extensions delete github-notifier

# 操作 node_1 节点的专属 Extension
botd extensions put node_1 custom-ext --file ./index.ts
```

## 模型供应商与凭据管理（Providers）

CLI 支持免指定 `nodeId` 直接管理 Hub 全局模型供应商登录认证与凭据。CLI 也支持指定 `nodeId` 管理特定节点上的供应商凭据。

```text
# 全局模式（单参数）
botd providers login <providerId> --method <api_key|oauth> [--wait [seconds]]
botd providers status <loginId>
botd providers respond <loginId> --prompt <promptId> [--value <value>]
botd providers cancel <loginId>
botd providers logout <providerId>

# 节点模式（双参数）
botd providers login <nodeId> <providerId> --method <api_key|oauth> [--wait [seconds]]
botd providers status <nodeId> <loginId>
botd providers respond <nodeId> <loginId> --prompt <promptId> [--value <value>]
botd providers cancel <nodeId> <loginId>
botd providers logout <nodeId> <providerId>
```

```bash
# 发起 Anthropic API Key 登录流程
botd providers login anthropic --method api_key

# 回答 API Key 输入提示
botd providers respond login_100 --prompt api_key --value "sk-ant-api03-xxx"

# 发起 GitHub Copilot OAuth 登录并等待交互
botd providers login github --method oauth --wait 120

# 查看指定登录流程状态
botd providers status login_100

# 取消进行中的登录流程
botd providers cancel login_100

# 退出指定供应商登录并清除凭据
botd providers logout anthropic
```

## 模型目录检视（Models）

查询模型供应商与模型目录。

```text
botd models catalog [--node <nodeId>]
```

```bash
# 查询 Hub 模型目录
botd models catalog

# 查询指定节点上报的模型目录
botd models catalog --node node_1
```

输出包含供应商名称、认证方式支持列表（`api_key` / `oauth`）、是否已配置凭据，以及每个模型支持的思考级别。

## 自动化脚本示例

在自动化脚本中组合使用 `--json` 选项与 `jq` 工具：

```bash
# 列出未归档的会话 ID
botd --json sessions list | jq -r '.[] | select(.archived != true) | .id'

# 向会话发送任务并提取第一条文本回复
botd --json chat send sess_1 "检查构建状态" --wait 60 | jq -r '.[0].content'

# 派生后台 Worker 并提取 Worker ID
WORKER_ID=$(botd --json workers spawn sess_1 --title "测试" --task "执行回归测试" | jq -r '.workerId')
echo "已启动 Worker: $WORKER_ID"
```
