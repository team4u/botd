# CLI 参考

botd CLI 同时承担两种角色：管理本机 Node Agent 守护进程，以及执行 Hub 管理操作。[文档目录](README.md)

## 命令入口

三种入口运行同一套命令：

| 入口 | 场景 |
| --- | --- |
| `pnpm node` | 源码仓库内开发调试。实际执行 `pnpm --filter @botd/node cli` |
| `node apps/node/dist/cli.js` | 仓库内执行 `pnpm build` 后使用。输出干净，适合脚本捕获 |
| `botd` | 通过 npm 包安装后的全局命令。`package.json` 声明 `bin` 字段指向 `dist/cli.js` |

查看帮助：

```bash
pnpm node --help
pnpm node sessions --help
pnpm node chat send --help
```

下文语法块中，尖括号 `<value>` 表示需要填入的值，方括号表示可省略。

## 全局选项

所有子命令共享以下选项：

| 选项 | 说明 |
| --- | --- |
| `--json` | 输出机器可读 JSON |
| `--data-dir <dir>` | 数据目录。优先级：该参数、环境变量 `BOTD_DATA_DIR`、默认 `~/.botd` |
| `--hub <url>` | 覆盖目标 Hub URL。默认读取 `botd login` 保存的地址或环境变量 `BOTD_HUB_URL` |
| `--password <password>` | Hub 登录密码。后备为环境变量 `BOTD_ADMIN_PASSWORD` |
| `--timeout <seconds>` | HTTP 请求超时秒数，默认 `30` |
| `-V, --version` | 打印版本号 |
| `-h, --help` | 打印当前命令帮助 |

部分子命令有同名但含义不同的选项。例如 `ask --timeout` 控制等待用户回答的秒数，不控制 HTTP 超时。

## 输出格式与错误处理

`--json` 直接输出接口返回的原始 JSON。

不加 `--json` 时按人类可读格式渲染：对象数组渲染为对齐表格，单对象渲染为 `key  value` 行，字符串原样打印。`skills get`、`bots system get` 等内容类命令直接输出文档正文，便于管道传递。

命令失败时退出码为 `1`。错误信息写入 stderr。`--json` 模式下错误为 `{"error": "原因"}`。参数解析错误由 Commander 自行处理。

## 登录与凭据

```text
login <hubUrl> [--username <name>] [--save-credentials]
logout
health
```

### login

登录 Hub 并保存会话令牌。

```bash
pnpm node login http://localhost:3002 --username admin --password 'your-password'
```

本机开发时 Hub 运行在 3002 端口（启动命令带 `BOTD_PORT=3002`）。生产部署默认端口为 3000。

| 参数或选项 | 说明 |
| --- | --- |
| `<hubUrl>` | Hub 地址，末尾斜杠会被去掉 |
| `--username <name>` | 登录用户名。后备顺序：`--username` 参数、环境变量 `BOTD_USERNAME`、默认 `admin` |
| `--save-credentials` | 将密码明文保存到 `cli.json`（权限 0600）。默认不保存密码 |

密码必须通过全局 `--password` 或环境变量 `BOTD_ADMIN_PASSWORD` 提供，否则命令报错。

登录成功后，令牌写入 `<数据目录>/cli.json`。CLI 随后调用 `GET /api/auth/me` 验证会话有效。

### logout

登出当前 Hub。CLI 尽力调用 `POST /api/auth/logout`，然后清空 `cli.json`。

### health

匿名调用 `GET /api/health`，检查 Hub 可达性。Hub 地址取自 `--hub` 或已保存配置。

### 凭据解析规则

Hub 地址的解析优先级：`--hub` 参数、环境变量 `BOTD_HUB_URL`、`cli.json` 中保存的地址。

已保存的令牌只在目标 Hub 与保存地址一致时复用。命令收到 `401` 且有可用密码时，自动重新登录并重试一次。

没有令牌和密码时，CLI 回退到本机配对身份 `node.json`。此时请求携带 `x-botd-node-id` 与 `x-botd-node-token` 头，以节点账户身份访问 Hub。

## 节点守护进程

这组命令管理本机 Node Agent。守护进程通过本地 IPC 接口通信：POSIX 系统使用 `<数据目录>/agent.sock`，Windows 使用命名管道。新版守护进程在 `<数据目录>/ipc-token` 写入令牌，CLI 每次请求自动携带。CLI 与守护进程版本不匹配时，请求返回 `401`，此时执行 `botd restart` 或升级到匹配版本。

### start

```text
start [-d | --detach] [--log-file <path>]
```

启动本机守护进程。默认前台运行，`Ctrl+C` 或 `SIGTERM` 触发优雅退出。

| 选项 | 说明 |
| --- | --- |
| `-d, --detach` | 后台运行，日志写入 `--log-file` |
| `--log-file <path>` | 后台模式日志文件。默认 `<数据目录>/daemon.log` |

```bash
pnpm node start -d
```

`--json` 输出 `{ ok, pid, logFile }`。

### stop

```text
stop
```

优雅停止守护进程。CLI 先通过 IPC 调用 `/shutdown`。IPC 不可达时，读取 `<数据目录>/daemon.pid` 并发送 `SIGTERM`。

### restart

```text
restart [-d | --detach] [--log-file <path>]
```

先执行 `stop`，再执行 `start`。选项含义与 `start` 相同。

### status

```text
status
```

查询守护进程状态。输出 PID、运行时长、版本、节点名、Hub 连接状态与 IPC 地址。守护进程未运行时退出码为 `1`。`--json` 输出完整状态对象。

### reload

```text
reload
```

让守护进程向 Hub 重新注册技能、扩展和 Bot 清单。在 Web 之外修改了资源文件后执行此命令。

### service

```text
service <install|uninstall|status> [--dry-run]
```

管理操作系统级后台服务。

| 位置参数 | 说明 |
| --- | --- |
| `install` | 安装并启用服务 |
| `uninstall` | 停止并移除服务 |
| `status` | 查询服务安装状态 |

各平台实现：Linux 使用 systemd 用户单元 `botd.service`，macOS 使用 LaunchAgent `dev.botd.agent.plist`，Windows 使用计划任务 `BotdNodeAgent`。

`--dry-run` 只生成配置文件，不改动系统。

### upgrade

```text
upgrade [--version <ver>] [--registry <url>] [--check] [--force]
```

检查或执行本机节点升级。

| 选项 | 说明 |
| --- | --- |
| `--check` | 只检查是否有可用更新，不执行升级 |
| `--version <ver>` | 指定目标版本 |
| `--registry <url>` | 指定 npm registry 地址 |
| `--force` | 版本一致时也强制升级 |

守护进程运行中时，升级请求经 IPC 转发（超时 600 秒）。守护进程未运行时，CLI 直接本地执行升级。

### join

```text
join <hubUrl> --code <code> --name <name>
```

用 Web 生成的配对码注册本机节点。CLI 调用 `POST <hubUrl>/api/nodes/pairing/exchange`，成功后将节点身份写入 `node.json`。

| 参数或选项 | 说明 |
| --- | --- |
| `<hubUrl>` | Hub 地址 |
| `--code <code>` | 必填，Web 生成的配对码 |
| `--name <name>` | 必填，节点名称 |

```bash
pnpm node join http://localhost:3002 --code 123456 --name my-laptop
```

### install

```text
install <source> [--kind auto|skill|extension] [--id <customId>] [--bot <botIds...>]
```

在本机安装技能或扩展。安装完成后，若守护进程在线，自动触发一次 `reload`。

| 参数或选项 | 说明 |
| --- | --- |
| `<source>` | 资源来源，见下表 |
| `--kind <kind>` | 资源类型：`auto`（默认）、`skill`、`extension` |
| `--id <customId>` | 自定义资源标识 |
| `--bot <botIds...>` | 安装后立即绑定到这些 Bot 并启用（可写多个）。省略时只安装不启用 |

`<source>` 支持的语法：

| 来源 | 示例 | 行为 |
| --- | --- |
| npm 包 | `npm:@scope/pkg@1.0.0` | 在扩展目录下 `npm install` 该包并重导出其默认导出。带 `pi-package` 关键字与 `pi` 清单（Pi Package manifest）的包会被完整装载 |
| Git 仓库 | `git:github.com/owner/repo@ref` | 浅克隆仓库并切到 `ref`（分支 / 标签），识别根目录 `SKILL.md`、`skills/`、`.agents/skills/` 等标准布局 |
| GitHub 简写 | `owner/repo` 或 `owner/repo@skillName` | 等价 `https://github.com/owner/repo.git`；带 `@skillName` 时只装仓库内同名技能 |
| GitHub 子路径 | `https://github.com/o/r/tree/main/skills/x` | 克隆后只装子路径，`@ref` 段作为分支 |
| 本地文件 / 目录 | `./my-skill`、`./ext.ts` | 目录含 `SKILL.md` 视为技能，否则视为扩展；`.md` 文件视为技能 |

```bash
# 从 npm 安装扩展并立即绑定给两个 Bot
botd install npm:@scope/pi-tools@1.2.0 --bot ops-bot lead-bot

# 从 GitHub 指定分支安装
botd install git:github.com/example/botd-exts@v1
```

## 会话内工具命令

以下命令面向 Bot 工具环境和外部脚本，需要本机守护进程运行。会话相关参数可用环境变量 `BOTD_SESSION_ID` 与 `BOTD_BOT_ID` 提供。

### wake

```text
wake --message <msg> [--session <id>] [--bot <id>] [--reply-to <botId>] [--no-turn] [--delay <duration>]
```

向会话投递唤醒消息。

| 选项 | 说明 |
| --- | --- |
| `--message <msg>` | 必填，唤醒时投递的消息 |
| `--session <id>` | 会话 ID，后备 `BOTD_SESSION_ID` |
| `--bot <id>` | Bot ID，后备 `BOTD_BOT_ID` |
| `--reply-to <botId>` | 唤醒后移交或提及的目标 Bot |
| `--no-turn` | 只投递消息，不触发模型回合 |
| `--delay <duration>` | 延迟投递，格式如 `30s`、`15m`、`2h`、`1d` |

`--delay` 生效时，守护进程请求 Hub 创建计划触发器。`--json` 输出包含 `scheduledTriggerId`。

```bash
botd wake --message "构建完成，请继续" --delay 30m
```

### ask

```text
ask [prompt] [--options <items>] [--timeout <seconds>] [--session <id>] [--bot <id>]
    [--file <path>] [--diff] [--stdin] [--ui] [--ui-schema]
    [--risk <level>] [--reason <text>] [--resource <target>]
```

在会话中向用户提问并阻塞等待回答。答案打印到 stdout，可直接被 shell 捕获：

```bash
choice=$(botd ask "是否继续部署" --options "继续,取消")
```

| 参数或选项 | 说明 |
| --- | --- |
| `[prompt]` | 问题正文，充当卡片标题 |
| `--options <items>` | 逗号分隔的选项，如 `"确认,取消"` |
| `--timeout <seconds>` | 等待秒数，默认 `300`。`0` 表示无限等待 |
| `--session <id>` | 会话 ID，后备 `BOTD_SESSION_ID` |
| `--bot <id>` | Bot ID，后备 `BOTD_BOT_ID` |
| `--file <path>` | 附件预览文件。按后缀自动识别类型：`.ui.json` 为 UI，`.diff`/`.patch` 为 diff，`.md` 为 markdown，其余为纯文本 |
| `--diff` | 预览类型标记为 diff。未给 `--file` 时读取 stdin |
| `--stdin` | 从 stdin 读取预览内容 |
| `--ui` | 将预览内容作为 `botd.v1` 生成式 UI 卡片渲染，写入前先校验 |
| `--ui-schema` | 打印 `botd.v1` UI 规范与组件目录后退出 |
| `--risk <level>` | 自动生成风险审批卡，取值 `low`、`medium`、`high` |
| `--reason <text>` | 需要人工审批的原因，作为审批卡提示正文 |
| `--resource <target>` | 受影响的资源、服务或路径 |

预览内容上限 256KB，超出部分截断。

任一 `--risk`、`--reason`、`--resource` 出现且未给 `--ui` 时，进入审批卡模式：CLI 自动生成包含风险标识、资源信息、预览折叠与操作按钮的 UI 卡片。此时未指定 `--options` 则默认按钮为「批准」「拒绝」。回答输出纯决定文本。

### bg

管理带自动唤醒回调的后台任务。任务在 Bot 工作区执行，结束时守护进程自动向会话回报。

#### bg run

```text
bg run [--session <id>] [--bot <id>] [--reply-to <botId>] [--no-turn] -- <command...>
```

以后台任务运行 shell 命令。命令部分写在 `--` 之后，避免与选项混淆。

| 选项 | 说明 |
| --- | --- |
| `--session <id>` | 会话 ID，后备 `BOTD_SESSION_ID` |
| `--bot <id>` | Bot ID，后备 `BOTD_BOT_ID` |
| `--reply-to <botId>` | 任务完成后移交或提及的目标 Bot |
| `--no-turn` | 完成后只投递日志摘要，不触发模型回合 |

```bash
botd bg run -- npm run build
```

`--json` 输出任务记录，包含 `id`、`pid`、`command`、`logPath`。

#### bg list

```text
bg list [--session <id>] [--bot <id>]
```

列出本机后台任务。`--session` 与 `--bot` 按会话或 Bot 过滤。

#### bg logs

```text
bg logs <jobId> [--lines <n>]
```

查看任务日志尾部。`--lines` 默认 `100`。

#### bg kill

```text
bg kill <jobId>
```

终止一个运行中的后台任务。

### artifact

在会话与节点之间传递产物文件。命令组名 `artifact`，别名 `artifacts`。

#### artifact put

```text
artifact put <filePath> [--session <id>] [--bot <id>] [--message <msg>]
```

上传本地文件为会话产物。

| 参数或选项 | 说明 |
| --- | --- |
| `<filePath>` | 本地文件路径，必须存在 |
| `--session <id>` | 会话 ID，后备 `BOTD_SESSION_ID` |
| `--bot <id>` | Bot ID，后备 `BOTD_BOT_ID` |
| `--message <msg>` | 随产物一并投递的消息 |

#### artifact pull

```text
artifact pull <artifactId> [-o | --output <path>]
```

下载产物到本机。未给 `-o` 时，保存为当前目录下产物同名文件。文件名只取最后一段路径，防止路径穿越。无有效文件名时回退为 `artifact-<artifactId>`。

#### artifact list

```text
artifact list [--session <id>]
```

列出会话产物。`--session` 后备 `BOTD_SESSION_ID`。

## Hub 管理命令

这组命令经 Hub API 操作，覆盖 Web 界面的管理能力。执行前需要完成 `login`，或具备节点配对身份。

### nodes

```text
nodes list
nodes pair
nodes install <nodeId> <source> [--kind auto|skill|extension] [--id <customId>]
nodes upgrade <nodeId> [--version <ver>] [--registry <url>] [--check]
```

#### nodes list

列出已连接节点及其托管的 Bot。

#### nodes pair

生成节点配对码。输出配对码与过期时间，并提示目标机器上执行的 `botd join` 命令。

```bash
pnpm node nodes pair
```

#### nodes install

向指定节点安装技能或扩展。要求拥有该节点且节点在线。

| 参数或选项 | 说明 |
| --- | --- |
| `<nodeId>` | 目标节点 ID |
| `<source>` | 资源来源 |
| `--kind <kind>` | 资源类型：`auto`、`skill`、`extension` |
| `--id <customId>` | 自定义资源标识 |

#### nodes upgrade

检查或触发指定节点的升级。

| 参数或选项 | 说明 |
| --- | --- |
| `<nodeId>` | 目标节点 ID |
| `--check` | 只检查可用更新，不执行 |
| `--version <ver>` | 指定目标版本 |
| `--registry <url>` | 指定 npm registry 地址 |

### bots

```text
bots list [--node <nodeId>] [--parent <parentBotId>]
bots create <botId> --node <nodeId> --name <name> [选项...]
bots update <botId> [选项...]
bots delete <botId>
bots system get <botId>
bots system put <botId> [--file <path>]
bots memory get <botId>
bots memory put <botId> [--file <path>]
bots env list <botId>
bots env set <botId> <KEY=value...> [--replace]
bots env unset <botId> <keys...>
```

#### bots list

列出全部 Bot 与子代理。`--node` 按节点过滤，`--parent` 按父 Bot 过滤。

#### bots create

创建 Bot 配置。

| 参数或选项 | 说明 |
| --- | --- |
| `<botId>` | Bot 标识 |
| `--node <nodeId>` | 必填，归属节点 ID |
| `--name <name>` | 必填，显示名称 |
| `--model <provider/modelId>` | 模型，格式如 `anthropic/claude-sonnet-4-5`。子代理可省略，默认继承父 Bot 模型 |
| `--desc <description>` | 描述 |
| `--thinking <level>` | 思考预算，取值 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，默认 `medium` |
| `--skill <ids...>` | 启用的技能 ID，可多个 |
| `--extension <ids...>` | 启用的扩展 ID，可多个 |
| `--system-file <path>` | SYSTEM.md 文件路径，`-` 表示 stdin |
| `--parent <parentBotId>` | 父 Bot ID。指定后创建子代理 |
| `--inherit-model` / `--no-inherit-model` | 是否继承父 Bot 模型 |
| `--inherit-skills` / `--no-inherit-skills` | 是否继承父 Bot 技能 |
| `--tool-scope <scope>` | 子代理工具权限：`all`、`readonly`、`custom` |
| `--custom-tools <tools...>` | `--tool-scope custom` 时的工具白名单 |

省略 `--model` 且未指定 `--parent` 时命令报错。指定 `--parent` 但找不到父 Bot 时，模型回退为 `anthropic/claude-sonnet-4-5`。

子代理共享主控 Bot 的工作区目录，可被主控 Bot 的 `Agent` 工具并发调度。详见[用户指南](user-guide.md)。

```bash
pnpm node bots create research-bot --node node-1 --name 调研 \
  --model anthropic/claude-sonnet-4-5 --thinking high
```

#### bots update

更新 Bot 配置。支持 `bots create` 中除 `--node` 与 `--parent` 外的全部选项，只修改显式给出的字段。

#### bots delete

删除 Bot 配置。

#### bots system

读写 Bot 的 SYSTEM.md。`get` 输出文档正文。`put` 从 `--file` 或 stdin 读取内容并写入，`--file -` 同样表示 stdin。

#### bots memory

读写 Bot 的 MEMORY.md。用法与 `bots system` 相同。

#### bots env

管理 Bot 的环境变量。这些变量供 Bot 工具使用，不用于模型供应商凭据。

| 子命令 | 说明 |
| --- | --- |
| `list <botId>` | 列出全部变量及键名 |
| `set <botId> <KEY=value...> [--replace]` | 设置一个或多个变量。`--replace` 替换全部存量变量，默认合并 |
| `unset <botId> <keys...>` | 按键名删除变量 |

```bash
pnpm node bots env set my-bot GITHUB_TOKEN=ghp_xxx
```

### sessions

```text
sessions list
sessions create --title <title> --lead <botId>
sessions update <sessionId> [--title <title>] [--lead <botId>] [--archive <boolean>]
sessions messages <sessionId>
sessions search <query...> [--session <sessionId>] [--limit <n>]
sessions cancel <sessionId>
sessions delete <sessionId>
sessions clear <sessionId>
sessions edit <sessionId> <messageId> [words...]
sessions fork <sessionId> --anchor <messageId>
sessions share <sessionId> [--revoke] [--regenerate]
sessions delegate <parentSessionId> --bot <botId> --prompt <prompt> [--title <title>]
sessions subsessions <parentSessionId>
```

会话为单聊模式（`direct`），`--lead` 指定主控 Bot。多角色协同由主控 Bot 调度子代理完成。

#### 子命令说明

| 子命令 | 说明 |
| --- | --- |
| `list` | 列出全部会话 |
| `create` | 创建会话。`--title` 与 `--lead` 必填 |
| `update` | 更新会话。`--archive true` 归档，`--archive false` 恢复 |
| `messages <sessionId>` | 列出会话消息历史 |
| `search <query...>` | 跨会话搜索消息。`--session` 限定范围，`--limit` 默认 `30` |
| `cancel <sessionId>` | 取消当前执行中的回合 |
| `delete <sessionId>` | 删除会话及全部消息，Bot 记忆被重置 |
| `clear <sessionId>` | 清空消息历史并重置 Bot 记忆，保留会话 |
| `edit <sessionId> <messageId> [words...]` | 编辑已发送的用户消息。后续回复被删除并重新生成 |
| `fork <sessionId> --anchor <messageId>` | 从锚点消息派生新会话。锚点消息及其之前的历史被复制 |
| `share <sessionId>` | 创建公开分享链接。`--revoke` 撤销，`--regenerate` 换新令牌 |
| `delegate <parentSessionId>` | 委派任务给子会话。`--bot` 与 `--prompt` 必填，`--title` 可选 |
| `subsessions <parentSessionId>` | 列出父会话的全部子会话 |

```bash
pnpm node sessions create --title 部署检查 --lead ops-bot
pnpm node sessions delegate sess-1 --bot research-bot --prompt "调研竞品定价" --title 竞品调研
```

### chat

#### chat send

```text
chat send <sessionId> <message...> [--wait [seconds]]
```

向会话发送消息。默认只发送后立即返回。

带 `--wait` 时，CLI 先订阅会话事件流，再发送消息，等待会话回到 `idle` 或 `failed` 状态。省略秒数时默认等待 `300` 秒。

文本模式输出本轮收集的全部 Bot 回复。`--json` 输出消息数组。会话以 `failed` 状态结束时退出码为 `1`。

等待超时只表示 CLI 停止等待，任务仍在 Hub 继续执行。需要中止时另调用 `sessions cancel`。

```bash
botd chat send sess-1 "总结昨天的部署" --wait 120
```

#### chat watch

```text
chat watch <sessionId> [--duration <seconds>]
```

订阅会话 SSE 事件流，每行输出一个 JSON 事件。`--duration` 为 `0`（默认）时持续接收直到连接断开。

```bash
botd chat watch sess-1 --duration 60
```

### triggers

```text
triggers list <sessionId>
triggers create <sessionId> --name <name> --bot <botId> --prompt <prompt> [选项...]
triggers delete <triggerId>
```

#### triggers create

创建会话触发器。

| 参数或选项 | 说明 |
| --- | --- |
| `<sessionId>` | 目标会话 |
| `--name <name>` | 必填，触发器名称 |
| `--bot <botId>` | 必填，触发时执行的 Bot |
| `--prompt <prompt>` | 必填，触发时投递的提示词 |
| `--kind <kind>` | 类型：`webhook`（默认）、`cron`、`once` |
| `--cron <expr>` | 5 字段 cron 表达式，按 Hub 服务器本地时间。仅 `cron` 类型可用 |
| `--delay <duration>` | 延迟时长，如 `30s`、`15m`、`2h`。仅 `once` 类型可用 |
| `--at <isoOrDuration>` | ISO 时间戳或时长。仅 `once` 类型可用 |
| `--dispatch <mode>` | 派发方式：`append`（默认）追加到当前会话，`subsession` 派生独立子会话 |
| `--skill <skillId>` | 触发时以 `/skill:<id>` 前缀调用的技能 |
| `--secret <secret>` | Webhook HMAC 签名验证密钥，对应 `X-Hub-Signature-256` 头。仅 `webhook` 类型可用 |
| `--event-types <csv>` | 接受的 Webhook 事件类型，逗号分隔，如 `pull_request.opened,push`。仅 `webhook` 类型可用 |

`cron` 类型必须给 `--cron`。`once` 类型必须给 `--delay` 或 `--at` 之一。`--cron`、`--delay`/`--at`、`--secret`、`--event-types` 用在不匹配的类型上时命令报错。

```bash
pnpm node triggers create sess-1 --name 每晨简报 --bot ops-bot \
  --kind cron --cron "30 9 * * *" --prompt "生成晨间简报"
```

#### 其他子命令

`triggers list <sessionId>` 列出会话触发器。`triggers delete <triggerId>` 删除触发器。Webhook 调用方式见[自动化指南](automation.md)。

### skills 与 extensions

```text
skills get <nodeId> <skillId>
skills put <nodeId> <skillId> [--file <path>]
skills delete <nodeId> <skillId>
extensions get <nodeId> <extId>
extensions put <nodeId> <extId> [--file <path>]
extensions delete <nodeId> <extId>
```

管理节点上的技能与扩展。操作要求拥有目标节点且节点在线。

`put` 从 `--file` 指定的文件读取内容。未给 `--file` 或给 `-` 时读取 stdin。`get` 在文本模式下输出资源正文。

```bash
cat SKILL.md | pnpm node skills put node-1 my-skill
```

### providers

```text
providers login <nodeId> <providerId> --method api_key|oauth [--wait [seconds]]
providers status <nodeId> <loginId>
providers respond <nodeId> <loginId> --prompt <promptId> [--value <value>]
providers cancel <nodeId> <loginId>
providers logout <nodeId> <providerId>
```

管理节点上的模型供应商认证。

| 子命令 | 说明 |
| --- | --- |
| `login` | 发起登录流程。`--method` 必填，取值 `api_key` 或 `oauth`。`--wait` 持续轮询直到完成，省略秒数时默认 `120` 秒。超时仍为 `pending` 时退出码为 `1` |
| `status` | 查询登录状态，展示事件与待答复的提示 |
| `respond` | 回答登录流程中的交互提示。`--prompt` 必填。未给 `--value` 时读取 stdin |
| `cancel` | 取消进行中的登录 |
| `logout` | 删除该供应商的认证凭据 |

登录流程可能产生多次交互。命令输出会给出下一步要执行的 `respond` 命令。详见[模型指南](models.md)。

```bash
pnpm node providers login node-1 github --method oauth --wait
```

### models

```text
models catalog [--node <nodeId>]
```

列出模型供应商及其支持的模型目录。`--node` 指定从某个节点查询。文本模式输出供应商、认证方式与模型列表。

```bash
pnpm node models catalog
```

## JSON 输出脚本示例

`--json` 输出接口原始数据，可直接交给 `jq` 处理：

```bash
# 列出未归档会话的 ID 与标题
node apps/node/dist/cli.js --json sessions list \
  | jq -r '.[] | select(.archived != true) | "\(.id)  \(.title)"'

# 发送消息并等待回复，取第一条回复正文
node apps/node/dist/cli.js --json chat send sess-1 "检查 CI 状态" --wait 300 \
  | jq -r '.[0].content'
```

脚本建议使用构建后入口，避免 pnpm 向 stdout 混入运行提示。

## 与其他文档的关系

CLI 未覆盖全部 HTTP 接口。用户管理、部分团队权限和通知通道等操作请使用 Web 或 [HTTP API](api.md)。

后台任务、唤醒与审批的完整示例见[自动化指南](automation.md)。环境变量与数据目录详见[配置参考](configuration.md)。新增选项以当前版本的 `--help` 输出为准。
