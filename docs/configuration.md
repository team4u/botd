# 配置参考

[文档目录](README.md)

先确定配置由哪个进程读取。Hub、Node Agent 和 CLI 可以运行在不同机器上。

源码命令不会自动加载仓库根目录的 `.env`。请在启动进程的终端中设置环境变量。

Docker Compose 的 `--env-file .env` 提供变量替换值。只有 Compose `environment` 或 `env_file` 引用的值才会进入容器。

## Hub

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BOTD_HOST` | `0.0.0.0` | HTTP 和 WebSocket 监听地址 |
| `BOTD_PORT` | `PORT`，否则 `3000` | 服务端口，本机开发指定 `3002` |
| `BOTD_HUB_DATA_DIR` | `~/.botd` | 默认数据库目录和产物根目录 |
| `BOTD_DB_PATH` | `<Hub 数据目录>/hub.sqlite` | 指定 SQLite 文件，优先于默认目录 |
| `BOTD_WEB_DIR` | 相对于 Hub 模块定位的 `apps/web/dist` | 构建后的前端目录 |
| `BOTD_ADMIN_PASSWORD` | `admin` | 首次初始化管理员的密码 |
| `BOTD_TRIGGER_POLL_MS` | `2000` | Cron 检查间隔，单位毫秒，最低 `200` |
| `BOTD_PUBLIC_URL` | 见下文 | 外部通道通知中的会话链接前缀 |
| `BOTD_BASE_URL` | 无 | `BOTD_PUBLIC_URL` 未设置时的后备地址 |
| `BOTD_ASK_SECRET` | `botd-ask-secret-default-key` | 外部通道确认回调的签名密钥 |

`BOTD_PUBLIC_URL` 和 `BOTD_BASE_URL` 均未设置时，通知链接使用 `http://localhost:<BOTD_PORT 或 3000>`。公开部署时请填写用户可访问的 HTTPS 地址。

管理员初始化仅在 `users` 表为空时生效。后续更改 `BOTD_ADMIN_PASSWORD` 不会修改已有密码。

数据库路径与产物目录分别计算。例如：

```bash
BOTD_PORT=3002 \
BOTD_HUB_DATA_DIR="$HOME/.local/share/botd-hub" \
BOTD_DB_PATH="$HOME/.local/share/botd-hub/hub.sqlite" \
pnpm dev:hub
```

产物写入 `$BOTD_HUB_DATA_DIR/artifacts/`。单独设置 `BOTD_DB_PATH` 不会移动产物。

Web 开发服务固定监听 `3001`，代理到 Hub 的 `3002`。它不读取 `BOTD_PORT` 来调整代理目标。

## Node Agent

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BOTD_DATA_DIR` | `~/.botd` | 节点数据目录，CLI 的 `--data-dir` 优先 |
| `BOTD_API_KEY_<PROVIDER>` | 无 | 指定供应商的 API Key，优先于节点保存的凭据 |
| `BOTD_AUTO_COMPACT` | 启用 | 仅设为 `0` 时关闭自动上下文压缩 |
| `BOTD_DAEMON_LOG` | `<数据目录>/daemon.log` | 后台进程日志，启动时可用 `--log-file` 指定 |
| `BOTD_BASH_PATH` | 自动查找 | Windows 上的 Bash 路径 |
| `BOTD_MINGIT_URL` | 代码中的下载地址 | Windows 托管 MinGit 的下载地址 |
| `BOTD_SHELL_PATH` | 平台默认 shell | 非 Windows 后台任务使用的 shell |

供应商标识转成大写后，非字母数字字符替换为下划线。例如 `zai-coding-cn` 对应 `BOTD_API_KEY_ZAI_CODING_CN`。

环境变量必须设置在 Node Agent 的进程环境中。仅设置在 Hub 上不会为远程节点提供模型凭据。

```bash
export BOTD_API_KEY_ANTHROPIC='replace-with-your-api-key'
pnpm node start
```

已经运行的 Node Agent 不会读取另一个终端后来设置的值。需要在带有新配置的环境中重新启动。Web 登录保存的凭据无需通过此方式配置。

Windows 优先使用 `BOTD_BASH_PATH`。随后查找托管 MinGit、Git for Windows 和 `PATH`。找不到 Bash 时，节点会尝试下载托管 MinGit。

以下变量供连接与进程接替调优，通常不需要设置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BOTD_DAEMON_BIND_RETRY_MS` | `0` | 本地 IPC 地址绑定冲突的重试窗口 |
| `BOTD_WS_MIN_RECONNECT_DELAY_MS` | `200` | WebSocket 最小重连间隔，单位毫秒 |
| `BOTD_NPM_REGISTRY` | npm 官方 registry | 节点升级查询和下载使用的 registry |
| `BOTD_NPM_PACKAGE` | `botd` | 节点升级查询使用的包名 |

升级变量不代表仓库已发布对应 npm 包。源码和容器升级见[部署指南](deployment.md)。

## CLI

| 选项或变量 | 规则 |
| --- | --- |
| `--data-dir` | 优先于 `BOTD_DATA_DIR`，决定身份和 CLI 配置所在目录 |
| `--hub` | 覆盖管理请求使用的 Hub URL |
| `--password` | 优先于 `BOTD_ADMIN_PASSWORD` |
| `BOTD_USERNAME` | `login` 未指定 `--username` 时使用，默认 `admin` |
| `--timeout` | HTTP 超时秒数，默认 `30` |
| `--json` | 输出机器可读结果 |

`login` 将会话配置保存在 `<数据目录>/cli.json`。只有显式使用 `--save-credentials` 才保存明文密码。

Hub 初始化密码与 CLI 登录密码恰好使用同一个环境变量名。两者的作用取决于读取它的进程。

完整命令与认证恢复规则见 [CLI 参考](cli.md)。

## 节点文件布局

```text
~/.botd/
├── node.json                 # 节点身份与配对令牌
├── cli.json                  # CLI 的 Hub 登录配置
├── daemon.pid
├── daemon.log
├── agent.sock                # macOS / Linux 本地控制通道
├── .agent/
│   ├── auth.json             # 模型供应商凭据
│   └── models.json           # 自定义模型目录
├── bin/                      # Bot 使用的 botd 命令入口
├── skills/<id>/SKILL.md
├── extensions/
└── bots/<botId>/
    ├── bot.json
    ├── SYSTEM.md
    ├── MEMORY.md
    ├── env.json
    ├── prompts/
    ├── workspace/
    │   └── inbox/
    └── sessions/             # Pi 模型会话 JSONL 文件
```

Windows 使用基于数据目录生成的命名管道，不创建 Unix socket。

`node.json`、`cli.json` 和 Bot 的 `env.json` 包含敏感信息。程序写入时使用受限文件权限。Windows 的访问限制还取决于文件系统 ACL。

模型凭据保存在 `.agent/auth.json`。文件内容不加密。Hub 会转发 Web 登录过程中的凭据输入，不将其保存为模型凭据库。

## Bot 环境变量

在 Bot 编辑器或 `bots env` 命令中配置私有变量。Node Agent 将它们保存在该 Bot 的 `env.json`。

这些变量提供给工具子进程。它们不是 Node Agent 的模型鉴权配置。

框架保留部分变量名称，拒绝通过 Bot 配置覆盖。完整规则见 [isValidBotEnvKey](../packages/protocol/src/index.ts)。

## 工具运行时注入的变量

| 变量 | 内容 |
| --- | --- |
| `BOTD_SESSION_ID` | 当前会话 ID |
| `BOTD_BOT_ID` | 当前 Bot ID |
| `BOTD_DATA_DIR` | 当前节点数据目录 |
| `PATH` | 加入节点 `bin` 目录的命令搜索路径 |

`botd wake`、`botd ask` 和后台任务使用这些变量定位会话。Node Agent 为工具子进程构造环境，不依靠修改全局 `process.env` 切换会话。

更多内容：[模型指南](models.md) · [部署指南](deployment.md) · [安全边界](security.md)。
