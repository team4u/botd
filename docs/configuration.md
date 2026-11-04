# 配置参考

[文档目录](README.md)

本文列出 botd 的全部环境变量、数据目录布局和配置优先级。配置按读取进程分为 Hub 侧、Node Agent 侧、CLI 与工具环境侧三份。

## 读取规则

先确定配置由哪个进程读取。Hub、Node Agent 和 CLI 可以运行在不同机器上。

源码命令不自动加载 `.env`。请在启动进程的终端中设置环境变量。

Docker Compose 的 `--env-file .env` 只提供变量替换值。只有 Compose `environment` 或 `env_file` 引用的值才进入容器。

优先级总则：命令行参数 > 环境变量 > 代码默认值。

## Hub 侧环境变量

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BOTD_HOST` | `0.0.0.0` | HTTP 与 WebSocket 监听地址 |
| `BOTD_PORT` | 回退 `PORT`，再回退 `3000` | 服务端口；本机开发设为 `3002` |
| `BOTD_HUB_DATA_DIR` | `~/.botd` | Hub 数据目录：默认数据库位置与产物根目录 |
| `BOTD_DB_PATH` | `<Hub 数据目录>/hub.sqlite` | SQLite 数据库文件路径 |
| `BOTD_WEB_DIR` | Hub 模块旁的 `apps/web/dist` | 构建后的前端静态文件目录 |
| `BOTD_ADMIN_PASSWORD` | 无（见下文） | 首次启动的自举管理员密码 |
| `BOTD_PUBLIC_URL` | 无（见回退链） | 外部通道通知中会话链接的前缀 |
| `BOTD_BASE_URL` | 无 | `BOTD_PUBLIC_URL` 未设置时的后备前缀 |
| `BOTD_ASK_SECRET` | 无（见解析顺序） | 外部通道确认回调的签名密钥 |
| `BOTD_TRIGGER_POLL_MS` | `2000`，下限 `200` | cron 与一次性触发器的巡检间隔，单位毫秒 |
| `BOTD_OUTBOX_MAX_ATTEMPTS` | `5`，下限 `1` | 单条通知的最大投递尝试次数 |
| `BOTD_OUTBOX_RETRY_MS` | `5000`，下限 `100` | 通知重试的基础退避间隔，单位毫秒 |
| `BOTD_OUTBOX_POLL_MS` | `2000`，下限 `100` | 通知出站队列的轮询间隔，单位毫秒 |

要点：

- 端口约定：生产默认 `3000`。本机开发启动 Hub 时带上 `BOTD_PORT=3002`。Vite 固定监听 `3001` 并代理到 `3002`，不读取 `BOTD_PORT`。
- 数据库路径优先级：编程参数 > `BOTD_DB_PATH` > `<BOTD_HUB_DATA_DIR>/hub.sqlite`。值 `:memory:` 表示内存库，仅供测试。
- 产物目录独立计算，固定为 `<BOTD_HUB_DATA_DIR>/artifacts/`。单独设置 `BOTD_DB_PATH` 不会移动产物。
- `BOTD_ADMIN_PASSWORD` 仅在 `users` 表为空时自举管理员（用户名 `admin`）。未设置时 Hub 生成一次性随机密码并打印到启动日志。此后修改该变量不会更改已有密码。
- 通知链接前缀回退链：`BOTD_PUBLIC_URL` > `BOTD_BASE_URL` > `http://localhost:<BOTD_PORT 或 3000>`。公开部署时填写用户可访问的 HTTPS 地址。
- `BOTD_ASK_SECRET` 解析顺序：环境变量 > 数据库 `settings` 表的 `ask_secret` > 首次生成 64 位 hex 随机密钥并落库。改设环境变量会覆盖历史密钥，历史推送链接随之失效。
- 通知重试按指数退避：`BOTD_OUTBOX_RETRY_MS × 2^(n-1)`，上限 300000 毫秒。尝试次数达到 `BOTD_OUTBOX_MAX_ATTEMPTS` 后记录置为 dead。

读取位置：`apps/hub/src/index.ts`（`BOTD_HOST`、`BOTD_PORT`、`BOTD_ADMIN_PASSWORD`）、`apps/hub/src/db.ts`（`BOTD_HUB_DATA_DIR`、`BOTD_DB_PATH`）、`apps/hub/src/static.ts`（`BOTD_WEB_DIR`）、`apps/hub/src/artifact-service.ts`（产物目录）、`apps/hub/src/triggers.ts`（`BOTD_TRIGGER_POLL_MS`）、`apps/hub/src/channels.ts`（其余）。

## Node Agent 侧环境变量

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BOTD_DATA_DIR` | `~/.botd` | 节点数据目录；CLI 的 `--data-dir` 优先 |
| `BOTD_CODE_DIR` | `~/code` | Space 项目扫描根：其下每个一级 Git 目录是一个可绑定的项目 |
| `BOTD_SKILLS_DIRS` | 无 | 在默认搜索根之外追加技能目录，多值用系统路径分隔符（POSIX `:`、Windows `;`）分隔 |
| `BOTD_API_KEY_<PROVIDER>` | 无 | 指定供应商的 API Key，优先于节点已保存的凭据 |
| `BOTD_AUTO_COMPACT` | 启用 | 仅设为 `0` 时关闭回合的自动上下文压缩 |
| `BOTD_CROSS_BOT_TIMEOUT_SECONDS` | `600` | 跨 Bot 工作流等待每个子会话的超时，单位秒 |
| `BOTD_DAEMON_LOG` | `<数据目录>/daemon.log` | 守护进程日志；`botd start -d --log-file` 优先 |
| `BOTD_SHELL_PATH` | 系统默认 shell | 非 Windows 后台任务使用的 shell 路径 |
| `BOTD_BASH_PATH` | 自动查找（见下文） | Windows 上 Bash 的显式路径 |
| `BOTD_MINGIT_URL` | Git for Windows v2.47.1 的 release 地址 | Windows 托管 MinGit 的下载地址 |
| `BOTD_WS_MIN_RECONNECT_DELAY_MS` | `200` | 连接 Hub 的 WebSocket 最小重连间隔，单位毫秒 |
| `BOTD_NPM_PACKAGE` | `@botd/node` | 节点升级查询的 npm 包名 |
| `BOTD_NPM_REGISTRY` | `https://registry.npmjs.org` | 节点升级查询与下载使用的 registry |
| `BOTD_UPGRADE_BLOCK_COOLDOWN_MS` | `1800000`（30 分钟） | 金丝雀失败版本的封禁时长，单位毫秒 |
| `BOTD_AUTO_UPGRADE` | 无（关闭） | 设为非空值（如 `1`）开启节点自动升级 |
| `BOTD_AUTO_UPGRADE_INTERVAL_MS` | `21600000`（6 小时） | 自动升级的检查间隔，单位毫秒，下限 `60000` |

要点：

- API Key 变量名规则：供应商标识转大写，非字母数字字符替换为下划线。例如 `zai-coding-cn` 对应 `BOTD_API_KEY_ZAI_CODING_CN`。
- 凭据优先级：`BOTD_API_KEY_<PROVIDER>` > Web 端供应商登录保存在 `.agent/auth.json` 的凭据。仅支持 OAuth 登录的供应商设置 API Key 会直接报错。
- 这些变量必须设置在 Node Agent 的进程环境中。已在运行的 Node Agent 不读取后续修改，需重启生效。仅设置在 Hub 上不会为远程节点提供凭据。
- Windows 的 Bash 查找顺序：`BOTD_BASH_PATH`（路径必须存在）→ 托管 MinGit → Git for Windows 常见安装位置 → `PATH` 中的 `bash.exe`（跳过旧版 WSL 空壳）。全部失败时节点自动下载托管 MinGit 到 `<数据目录>/runtime/mingit`。
- registry 白名单：Hub 经 RPC 下发的 registry 必须等于官方默认值或 `BOTD_NPM_REGISTRY`，否则被丢弃。本机 CLI 请求可显式传 `--registry`。
- `BOTD_SHELL_PATH` 只影响非 Windows 的 `botd bg run` 后台任务。未设置时交给 Node 使用系统默认 shell。回合内的 Bash 工具在 Windows 上固定使用上表的 Bash 解析结果。
- 自动升级：`BOTD_AUTO_UPGRADE` 开启后，守护进程按间隔检查 registry 并在有意版本时自动执行升级，复用手动升级的排空、金丝雀验证、失败回滚与封禁链路；升级成功后自动替换进程。检查不依赖 Hub 连接；金丝雀失败时回滚旧版本并在封禁冷却期内不再尝试。

框架内部变量（自动设置，通常无需配置）：

| 环境变量 | 值 | 用途 |
| --- | --- | --- |
| `BOTD_DAEMON_DETACHED` | `1` | 标记后台守护进程，防止 `--detach` 递归分叉 |
| `BOTD_DAEMON_BIND_RETRY_MS` | `0`；替代进程 `20000` | 本地 IPC 地址绑定冲突的重试窗口，单位毫秒 |
| `BOTD_VERSION_OVERRIDE` | 无 | 覆盖节点上报的版本号，供升级机制使用 |

读取位置：`apps/node/src/storage.ts`、`apps/node/src/workspace-diff.ts`、`apps/node/src/cross-bot/session.ts`、`apps/node/src/daemon.ts`、`apps/node/src/models.ts`、`apps/node/src/windows-shell.ts`、`apps/node/src/bg-jobs.ts`、`apps/node/src/runtime/execute-turn.ts`、`apps/node/src/upgrader.ts`、`apps/node/src/daemon-launch.ts`。

## CLI 与工具环境侧

| 项 | 规则 |
| --- | --- |
| `--data-dir` | 优先于 `BOTD_DATA_DIR`，决定节点身份与 CLI 配置所在目录 |
| `--hub` | 覆盖管理请求使用的 Hub URL；默认用 `login` 保存的地址 |
| `--password` | 优先于 `BOTD_ADMIN_PASSWORD` |
| `BOTD_USERNAME` | `login` 未指定 `--username` 时使用，再回退 `admin` |
| `--timeout` | HTTP 超时秒数，默认 `30` |
| `--json` | 输出机器可读的 JSON |
| `BOTD_SESSION_ID` / `BOTD_BOT_ID` | `wake`、`ask` 与产物命令未传 `--session` / `--bot` 时的回退 |

要点：

- `login` 把会话配置保存到 `<数据目录>/cli.json`（0600 权限）。仅显式传 `--save-credentials` 才保存明文密码。
- `BOTD_ADMIN_PASSWORD` 一名两用：Hub 用它自举管理员，CLI 用它作登录密码。作用取决于读取它的进程。
- `botd ask --ui-schema` 打印生成式 UI 目录。内容来自代码常量 `BOTD_UI_CATALOG_VERSION`（`botd.v1`）、`BOTD_UI_COMPONENT_TYPES`（17 种组件，含 `BarList`、`Table`）和 `BOTD_UI_SCHEMA_DOC`。单个 UI 规格上限 64KB、64 个元素、树深 6。它们是代码标识符，不是环境变量。

读取位置：`apps/node/src/cli/context.ts`、`apps/node/src/cli/commands/auth.ts`、`apps/node/src/cli/commands/node.ts`。

## 工具运行时注入的变量

Node Agent 为每个回合的工具子进程注入以下变量：

| 变量 | 内容 |
| --- | --- |
| `BOTD_SESSION_ID` | 当前会话 ID |
| `BOTD_BOT_ID` | 当前 Bot ID |
| `BOTD_NODE_ID` | 当前节点 ID |
| `BOTD_HUB_URL` | 节点配对时保存的 Hub 地址 |
| `BOTD_DATA_DIR` | 当前节点数据目录 |
| `BOTD_TURN_TRIGGER` | `automation` 或 `manual` |
| `BOTD_TURN_EVENT_KIND` | `cron`、`once`、`webhook`、`manual-trigger`、`delayed-wake`、`bg-job`；手动发起为 `chat` |
| `BOTD_TURN_EVENT_NAME` | 触发器或任务名称；手动发起为空字符串 |
| `BOTD_TURN_EVENT_AT` | 回合构建时刻的 ISO 时间戳 |
| `PATH` | 头部插入节点 `bin` 目录；Windows 再插入 MinGit 工具目录 |
| `PI_CODING_AGENT_DIR` | 主控 Bot 的 agent 目录 |

要点：

- `botd wake`、`botd ask` 和后台任务用这些变量定位会话。
- Node Agent 为工具子进程单独构造环境，不修改全局 `process.env`。
- Bot 专属变量在 Bot 编辑器或 `bots env` 命令中配置，保存在该 Bot 的 `env.json`。框架拒绝保留名 `PATH`、`PWD`、`HOME`、`USER`、`SHELL` 和 `BOTD_` 前缀，校验函数为 `isValidBotEnvKey`。
- 子代理回合先继承主控 Bot 的 `env.json`，同名变量以自身的值为准。

## 数据目录布局

Hub 侧（`BOTD_HUB_DATA_DIR`，默认 `~/.botd`）：

```text
~/.botd/
├── hub.sqlite              # Hub 数据库（POSIX 下 0600）
├── hub.sqlite.bak-v<n>     # schema 升级前的自动备份
└── artifacts/              # 产物存储根目录
```

节点侧（`BOTD_DATA_DIR`，默认 `~/.botd`）：

```text
~/.botd/
├── node.json               # 节点身份与配对令牌（0600）
├── cli.json                # CLI 的 Hub 登录配置（0600）
├── daemon.pid              # 守护进程 PID（0600）
├── daemon.log              # 守护进程日志
├── ipc-token               # 本地 IPC 认证令牌（0600，64 位 hex）
├── agent.sock              # macOS / Linux 本地控制通道（0600）
├── current.json            # 当前升级版本记录
├── previous.json           # 回退版本记录
├── update-blocked.json     # 金丝雀失败封禁记录
├── .agent/                 # 模型运行时目录（0700）
│   ├── auth.json           # 供应商凭据
│   ├── models.json         # 自定义模型目录
│   ├── models-store.json   # 模型目录缓存
│   └── device-id
├── bin/                    # botd 命令包装器（Windows 另有 botd.cmd）
├── skills/<id>/SKILL.md
├── extensions/<id>/
├── releases/<version>/     # 升级暂存与已发布版本
├── runtime/mingit/         # Windows 托管 MinGit
├── service/                # 系统服务配置（launchd / systemd / Windows）
└── bots/<botId>/
    ├── bot.json
    ├── SYSTEM.md
    ├── MEMORY.md
    ├── env.json            # Bot 专属变量（0600）
    ├── prompts/
    ├── agents/<childId>.md # 子代理声明，写在主控 Bot 目录下
    ├── subagents.json
    ├── sessions/<sessionId>.jsonl
    └── workspace/          # 子代理共享主控 Bot 的工作区
        ├── inbox/          # 回合附件与上游产物落盘处
        ├── .bg/<jobId>.log # 后台任务日志
        └── .workflows/     # 跨 Bot 工作流的脚本副本与断点日志
```

要点：

- Hub 与节点默认同用 `~/.botd`，文件名不冲突。Compose 内 Hub 数据库固定 `/data/hub.sqlite`，节点目录固定 `/data/node`。
- Windows 不创建 Unix socket，改用命名管道 `\\.\pipe\botd-agent-<hash>`。hash 由数据目录路径计算。
- 敏感文件以 0600 权限原子写入，内容不加密。Windows 上的实际访问限制取决于文件系统 ACL。

## 配置优先级汇总

- 数据库路径：编程参数 > `BOTD_DB_PATH` > `<BOTD_HUB_DATA_DIR>/hub.sqlite`
- 节点数据目录：`--data-dir` > `BOTD_DATA_DIR` > `~/.botd`
- Hub 端口：编程参数 > `BOTD_PORT` > `PORT` > `3000`
- CLI 密码：`--password` > `BOTD_ADMIN_PASSWORD`
- CLI 用户名：`--username` > `BOTD_USERNAME` > `admin`
- 模型凭据：`BOTD_API_KEY_<PROVIDER>` > `.agent/auth.json` 保存的登录凭据
- 通知链接前缀：`BOTD_PUBLIC_URL` > `BOTD_BASE_URL` > `http://localhost:<端口>`
- 升级 registry：请求参数 > `BOTD_NPM_REGISTRY` > `https://registry.npmjs.org`

## 渠道通知凭据

会话通道（webhook、飞书、Slack、Telegram）的签名 secret 与推送策略在 Web 会话设置中配置，不使用环境变量。见[渠道通知](channels.md)。

更多内容：[模型与供应商](models.md) · [部署指南](deployment.md) · [安全边界](security.md) · [CLI 参考](cli.md)。
