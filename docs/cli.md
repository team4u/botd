# CLI 参考

[文档目录](README.md)

CLI 可以管理节点、Bot 和会话，也可以在工具脚本中请求确认、上传产物或回报任务。

## 选择命令入口

在源码仓库根目录使用：

```bash
pnpm node --help
pnpm node sessions --help
pnpm node chat send --help
```

Bot 的工具环境和容器提供 `botd` 入口。它们可以直接运行 `botd wake` 等命令。

脚本需要捕获纯 JSON 或答案时，使用构建后的入口。这样不会混入 pnpm 的运行提示：

```bash
node apps/node/dist/cli.js --json sessions list
```

下文 `text` 代码块是参数语法。尖括号代表需要提供的值。

## 全局选项

| 选项 | 用途 |
| --- | --- |
| `--json` | 机器可读输出 |
| `--data-dir <dir>` | 数据目录，优先于 `BOTD_DATA_DIR`，默认 `~/.botd` |
| `--hub <url>` | 覆盖目标 Hub URL |
| `--password <password>` | Hub 登录密码，后备为 `BOTD_ADMIN_PASSWORD` |
| `--timeout <seconds>` | HTTP 请求超时，默认 30 秒 |
| `-V, --version` | 程序版本 |
| `-h, --help` | 当前命令帮助 |

业务错误写入 stderr，退出码为 `1`。JSON 模式的业务错误为 `{ "error": "原因" }`。参数解析错误仍由 Commander 处理。

各命令的 `--timeout` 可能有专门含义。例如 `ask` 用它控制等待用户答案的时间。

## 登录与身份

```bash
pnpm node login http://localhost:3002 --username admin --password 'replace-with-your-password'
pnpm node --hub http://localhost:3002 health
```

`login` 默认用户名为 `admin`，可通过 `--username` 或 `BOTD_USERNAME` 指定。

登录状态写入 `<数据目录>/cli.json`。只有加上 `--save-credentials` 才会保存明文密码。

命令遇到 `401` 时，若有可用密码，会重新登录一次。Hub 使用数据库中保存的签名密钥，正常重启不使有效令牌失效。

没有用户令牌和密码时，管理客户端可以回退到已配对的 `node.json`。此时以配对账户身份访问 Hub，仍受该账户权限限制。

`--hub` 指向其他 Hub 时，不会复用不匹配的已保存凭据。

```text
login <hubUrl> [--username <name>] [--save-credentials]
logout
health
```

## 本机节点

| 命令 | 用途与主要参数 |
| --- | --- |
| `join <hubUrl> --code <code> --name <name>` | 用网页配对码注册本机 |
| `start [-d] [--log-file <path>]` | 前台启动，`-d` 后台运行 |
| `stop` | 停止本机守护进程 |
| `restart [-d] [--log-file <path>]` | 停止后重新启动 |
| `status` | 查询 PID、运行时间和连接状态，未运行时非零退出 |
| `reload` | 重新向 Hub 注册技能、扩展和 Bot 清单 |
| `service <install\|uninstall\|status> [--dry-run]` | 管理系统启动配置 |
| `upgrade [--check] [--version <ver>] [--registry <url>] [--force]` | 检查或执行节点升级 |
| `install <source> [--kind auto\|skill\|extension] [--id <id>]` | 在本机安装资源 |

系统启动配置分别使用 Linux systemd 用户服务、macOS LaunchAgent、Windows 登录任务。它们的环境和启动时机受操作系统控制。

升级命令依赖 registry 中存在目标包。源码与容器升级按[部署指南](deployment.md)操作。

## 工具脚本与本地任务

这些命令需要本机守护进程运行。涉及会话的命令还需要 Hub 连接与资源权限。

| 命令 | 用途 |
| --- | --- |
| `wake` | 向会话写入回调，可触发 Bot 回答 |
| `ask <prompt>` | 发出确认卡片，等待答案 |
| `bg run <command...>` | 在 Bot 工作区运行后台任务 |
| `bg list` | 列出本机受管任务 |
| `bg logs <jobId>` | 查看任务日志 |
| `bg kill <jobId>` | 终止任务进程树 |
| `artifact put <filePath>` | 上传文件到会话 |
| `artifact pull <artifactId> [-o <path>]` | 下载产物 |
| `artifact list` | 列出会话产物，别名组名为 `artifacts` |

常用参数语法：

```text
wake --message <text> [--session <id>] [--bot <id>]
     [--reply-to <botId>] [--no-turn] [--delay <duration>]
ask <prompt> [--options <items>] [--timeout <seconds>]
    [--file <path>] [--diff] [--stdin] [--session <id>] [--bot <id>]
    [--risk <low|medium|high>] [--reason <text>] [--resource <target>]
    [--ui] [--ui-schema]
bg run [--session <id>] [--bot <id>] [--reply-to <botId>]
       [--no-turn] -- <command...>
bg list [--session <id>]
bg logs <jobId> [--lines <n>]
artifact put <filePath> [--session <id>] [--bot <id>] [--message <text>]
artifact list [--session <id>]
```

在 Bot 工具环境中，`BOTD_SESSION_ID`、`BOTD_BOT_ID` 和 `BOTD_DATA_DIR` 自动提供目标信息。外部终端需要显式提供缺失参数。

`ask` 默认等待 300 秒，`0` 表示无限等待。成功时输出答案，超时或失败时非零退出。`--risk` 与 `--reason` / `--resource` 组合会自动渲染结构化风险审批卡（含差异预览与批准/拒绝按钮），详见[自动化指南](automation.md)。

完整示例与任务生命周期见[自动化指南](automation.md)。

## Hub 管理命令

### 节点

```text
nodes list
nodes pair
nodes install <nodeId> <source> [--kind auto|skill|extension] [--id <id>]
nodes upgrade <nodeId> [--check] [--version <ver>]
```

远程资源安装和升级要求拥有节点且节点在线。`nodes list` 也可能包含对当前用户可见的共享资源。

### Bot

```text
bots list [--node <nodeId>] [--parent <parentBotId>]
bots create <botId> --node <nodeId> --name <name>
            [--model <provider/modelId>] [--desc <text>] [--thinking <level>]
            [--skill <ids...>] [--extension <ids...>] [--system-file <path>]
            [--parent <parentBotId>] [--inherit-model|--no-inherit-model]
            [--inherit-skills|--no-inherit-skills]
            [--tool-scope <all|readonly|custom>] [--custom-tools <tools...>]
bots update <botId> [对应的配置选项]
bots delete <botId>
bots system get <botId>
bots system put <botId> [--file <path>]
bots memory get <botId>
bots memory put <botId> [--file <path>]
bots env list <botId>
bots env set <botId> <KEY=value...> [--replace]
bots env unset <botId> <keys...>
```

`system put` 和 `memory put` 默认读取 stdin。`--file -` 也表示 stdin。

带 `--parent <parentBotId>` 时创建子代理：默认继承主控 Bot 的模型与技能，共享同一工作区目录，可被主控 Bot 的 `Agent` 工具立即并发调用。`--tool-scope` 限制子代理工具权限（`readonly` 为只读分析，`custom` 配合 `--custom-tools` 指定白名单）。

Bot 环境变量供工具使用，不负责选择模型供应商凭据。共享 Bot 的使用权不包含编辑权。

### 会话与聊天

```text
sessions list
sessions create --title <title> --lead <botId>
sessions update <sessionId> [--title <title>] [--lead <botId>]
                 [--archive <boolean>]
sessions messages <sessionId>
sessions search <query...> [--session <sessionId>] [--limit <n>]
sessions cancel <sessionId>
sessions delete <sessionId>
sessions clear <sessionId>
sessions edit <sessionId> <messageId> [words...]
sessions fork <sessionId> --anchor <messageId>
sessions share <sessionId> [--revoke] [--regenerate]
sessions delegate <parentSessionId> --bot <botId> --prompt <text>
                  [--title <title>]
sessions subsessions <parentSessionId>
chat send <sessionId> <message...> [--wait [seconds]]
chat watch <sessionId> [--duration <seconds>]
```

会话为单聊模式（`direct`），`--lead` 指定主控 Bot。多角色协同由主控 Bot 的子代理调度完成，不需要多成员会话。

`chat send` 默认只发送。带 `--wait` 时先订阅事件，再发送消息，等待会话回到空闲。省略等待秒数时为 300 秒。

JSON 模式的等待结果是本轮收集的消息数组。等待超时不等于任务已经取消，需要取消时另调用 `sessions cancel`。

### 触发器

```text
triggers list <sessionId>
triggers create <sessionId> --name <name> --bot <botId> --prompt <text>
                [--kind webhook|cron|once] [--cron <expr>]
                [--delay <duration>] [--at <timestamp>]
                [--dispatch append|subsession] [--skill <skillId>]
                [--event-types <csv>]
triggers delete <triggerId>
```

Cron 使用 Hub 服务器本地时间，表达式为 5 字段。一次性触发器使用 `--delay` 或 `--at`。Webhook 触发器支持 `--dispatch subsession` 派生独立子会话、`--skill` 调用技能和 `--event-types` 事件过滤，详见[自动化指南](automation.md)。

### 技能与扩展

```text
skills get <nodeId> <skillId>
skills put <nodeId> <skillId> [--file <path>]
skills delete <nodeId> <skillId>
extensions get <nodeId> <extensionId>
extensions put <nodeId> <extensionId> [--file <path>]
extensions delete <nodeId> <extensionId>
```

写入默认读取 stdin。操作要求拥有目标节点，且节点在线。

### 模型与供应商

```text
models catalog [--node <nodeId>]
providers login <nodeId> <providerId>
providers status <nodeId> <loginId>
providers respond <nodeId> <loginId> --prompt <promptId> [--value <value>]
providers cancel <nodeId> <loginId>
providers logout <nodeId> <providerId>
```

登录方式参数以 `providers login --help` 为准。`respond` 未给 `--value` 时读取 stdin。

这些命令操作节点凭据，要求拥有节点且节点在线。登录过程可能包含多次交互。详细说明见[模型指南](models.md)。

## 与 API 的关系

CLI 没有为所有 HTTP 接口提供对应命令。用户管理、部分团队权限和通知通道等操作可通过 Web 或 [HTTP API](api.md)完成。

查找新增选项时，以当前版本的 `--help` 为准。上文提供命令目录和主要参数，不复制全部帮助文本。
