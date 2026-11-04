# 配置指南

本文列出 botd 的端口规范、环境变量、数据目录布局与数据库结构。[返回文档目录](README.md)

## 端口规范

本地开发与生产部署采用不同端口配置。

| 组件 | 本地开发环境 | 生产部署环境 | 说明 |
| --- | --- | --- | --- |
| Web 前端（Vite） | `3001` | 集成于 Hub | 本地开发时浏览器唯一访问入口。 |
| Hub 服务端 | `3002` | `3000` | 本机开发必须通过 `BOTD_PORT=3002` 指定。严禁占用 `3000` 端口。 |

本地宿主机 `3000` 端口保留给其他用途。本地开发时 Vite 固定监听 `3001`，并将 API 与 WebSocket 请求代理至 `3002`。

## 环境变量分类

环境变量按读取进程分为三组：

- Hub 侧环境变量：由 Hub 服务进程读取。
- Node 侧环境变量：由 Node 守护进程读取。
- CLI 侧环境变量：由命令行客户端读取。

源码执行不自动读取 `.env` 文件。用户必须在启动终端中导出环境变量。

优先级顺序：命令行选项 > 环境变量 > 默认值。

---

## Hub 侧环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BOTD_HOST` | `0.0.0.0` | HTTP 与 WebSocket 监听地址。 |
| `BOTD_PORT` | `3000` | 服务监听端口。本地开发必须指定 `3002`。 |
| `BOTD_HUB_DATA_DIR` | `~/.botd` | Hub 数据主目录。 |
| `BOTD_DB_PATH` | `<数据目录>/hub.sqlite` | SQLite 数据库文件保存路径。 |
| `BOTD_WEB_DIR` | `apps/web/dist` | 前端静态页面编译产物路径。 |
| `BOTD_ADMIN_PASSWORD` | 无 | 首次启动数据库自举管理员密码。 |
| `BOTD_PUBLIC_URL` | 无 | 出站通知中公开访问链接前缀。 |
| `BOTD_BASE_URL` | 无 | 替代 `BOTD_PUBLIC_URL` 的备用地址前缀。 |
| `BOTD_ASK_SECRET` | 无 | 人工确认公开回调的 HMAC 签名密钥。 |
| `BOTD_TRIGGER_POLL_MS` | `2000` | 定时与延时触发器巡检间隔毫秒数（下限 200）。 |
| `BOTD_OUTBOX_MAX_ATTEMPTS` | `5` | 出站通知最大重试次数（下限 1）。 |
| `BOTD_OUTBOX_RETRY_MS` | `5000` | 出站通知基础退避重试毫秒数（下限 100）。 |
| `BOTD_OUTBOX_POLL_MS` | `2000` | 通知出站队列轮询毫秒数（下限 100）。 |

### Hub 配置规则

1. 数据库路径：优先级为编程参数 > `BOTD_DB_PATH` > `<BOTD_HUB_DATA_DIR>/hub.sqlite`。`:memory:` 表示测试内存库。
2. 产物目录：产物固定保存在 `<BOTD_HUB_DATA_DIR>/artifacts/` 目录。
3. 自举密码：`BOTD_ADMIN_PASSWORD` 仅在 `users` 表为空时生效。未指定时 Hub 在控制台打印一次性随机密码。
4. 公开回调前缀解析顺序：`BOTD_PUBLIC_URL` > `BOTD_BASE_URL` > `http://localhost:<PORT>`。
5. 出站通知退避算法：每次失败后等待毫秒数为 `BOTD_OUTBOX_RETRY_MS × 2^(n-1)`，上限 300000 毫秒。超过最大尝试次数后记录标记为 `dead`。

---

## Node Agent 侧环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BOTD_DATA_DIR` | `~/.botd` | Node 本地数据主目录。 |
| `BOTD_CODE_DIR` | `~/code` | Space 本地项目扫描根目录。 |
| `BOTD_SKILLS_DIRS` | 无 | 追加本地 Skills 搜索路径（多路径用系统分隔符隔开）。 |
| `BOTD_API_KEY_<PROVIDER>` | 无 | 显式指定供应商 API Key（大写下划线命名）。 |
| `BOTD_AUTO_COMPACT` | `1` | 设为 `0` 时关闭会话上下文自动压缩。 |
| `BOTD_CROSS_BOT_TIMEOUT_SECONDS` | `600` | 跨 Bot 工作流等待单次子会话执行超时秒数。 |
| `BOTD_DAEMON_LOG` | `<数据目录>/daemon.log` | 守护进程后台执行日志文件。 |
| `BOTD_SHELL_PATH` | 系统默认 Shell | POSIX 平台执行任务所用 Shell 路径。 |
| `BOTD_BASH_PATH` | 自动探测 | Windows 平台 Bash 绝对路径。 |
| `BOTD_MINGIT_URL` | 官方 Release 地址 | Windows 平台托管 MinGit 下载源。 |
| `BOTD_WS_MIN_RECONNECT_DELAY_MS` | `200` | 连接 Hub WebSocket 最小重连延迟毫秒数。 |
| `BOTD_NPM_PACKAGE` | `@botd/node` | 节点升级拉取的 npm 包名。 |
| `BOTD_NPM_REGISTRY` | 官方 Registry | 节点升级查询与拉取的 npm 源地址。 |
| `BOTD_UPGRADE_BLOCK_COOLDOWN_MS` | `1800000` | 升级失败版本的冷却封禁毫秒数（默认 30 分钟）。 |
| `BOTD_AUTO_UPGRADE` | 无 | 设为 `1` 时开启守护进程自动检查与升级。 |
| `BOTD_AUTO_UPGRADE_INTERVAL_MS` | `21600000` | 自动升级检查间隔毫秒数（默认 6 小时，下限 60000）。 |

### Node 配置规则

1. 凭据优先级：`BOTD_API_KEY_<PROVIDER>` 优先于 `.agent/auth.json` 中的凭据。
2. 供应商命名映射：供应商 ID 转为全大写，非字母数字字符转为下划线。例如 `zai-coding-cn` 对应 `BOTD_API_KEY_ZAI_CODING_CN`。
3. Windows 平台 Bash 探测顺序：`BOTD_BASH_PATH` > 托管 MinGit > Git 安装目录 > 系统 PATH 中的 `bash.exe`。全部缺失时自动拉取托管 MinGit。
4. 自动升级保障：升级执行时先检查版本摘要。守护进程通过排空、金丝雀启动与自动回滚保证可用性。

---

## CLI 客户端配置项

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `--data-dir` | `BOTD_DATA_DIR` | 指定节点配置目录。 |
| `--hub` | `BOTD_HUB_URL` | 指定 Hub 服务端地址。 |
| `--password` | `BOTD_ADMIN_PASSWORD` | 指定 Hub 登录密码。 |
| 无 | `BOTD_USERNAME` | 指定登录用户名（默认 `admin`）。 |
| `--timeout` | 无 | HTTP 请求超时秒数（默认 30）。 |
| `--json` | 无 | 输出格式化 JSON。 |
| `--session` | `BOTD_SESSION_ID` | `wake` 与 `artifact` 命令的默认会话 ID。 |
| `--bot` | `BOTD_BOT_ID` | `wake` 与 `artifact` 命令的默认 Bot ID。 |

---

## 数据目录结构（~/.botd）

Hub 与 Node 默认共享或独立使用 `~/.botd` 目录。

```text
~/.botd/
├── hub.sqlite                 # Hub SQLite 核心数据库文件
├── artifacts/                 # Hub 统一产物文件保存目录
│   └── <artifactId>           # 原始产物二进制载荷
├── agent.sock                 # Node 守护进程 IPC 本地 Socket（Windows 下为命名管道）
├── ipc-token                  # Node 本地 IPC 通信鉴权令牌（0600）
├── node.json                  # Node 配对身份凭据文件（包含 nodeId、token、hubUrl）
├── daemon.log                 # Node 守护进程后台执行日志文件
├── MEMORY.md                  # Node 节点级共享记忆文件
├── cli.json                   # CLI 保存的 Hub 登录态会话凭据（0600）
├── bots/                      # 本地承载的 Bot 资产目录
│   └── <botId>/
│       ├── bot.json           # Bot 基础元数据配置
│       ├── SYSTEM.md          # Bot 独立系统提示词
│       ├── MEMORY.md          # Bot 长期记忆文件
│       ├── memory/            # Bot 分层渐进披露的主题记忆归档目录
│       │   └── <topic>.md
│       ├── workspace/         # Bot 默认私有工作区目录
│       └── agents/            # 所属子代理定义目录（Subagents）
├── skills/                    # 本地 Node 专属 Skills 资产目录
│   └── <skillId>/
│       └── SKILL.md
├── extensions/                # 本地 Node 专属 Extensions 资产目录
│   └── <extId>/
│       └── index.ts
└── .agent/
    └── auth.json              # Node 本地模型供应商认证凭据（0600）
```

---

## 数据库结构（hub.sqlite）

Hub 使用 SQLite 记录全部核心元数据。

| 表名 | 说明 |
| --- | --- |
| `users` | 用户账户表。保存用户 ID、用户名、密码哈希、角色与 token epoch。 |
| `nodes` | 节点注册表。保存 Node ID、节点名称、在线状态、系统平台、拥有者与进程 PID。 |
| `bots` | Bot 配置表。保存 Bot ID、所属节点、模型配置、启用技能与工作区目录。 |
| `sessions` | 会话表。保存会话 ID、标题、主导 Bot、执行状态、归档标志与拥有者。 |
| `messages` | 消息历史表。保存消息 ID、会话 ID、角色、正文、思维链、工具调用与子代理轨迹。 |
| `artifacts` | 产物记录表。保存产物 ID、会话 ID、文件名、MIME 类型、文件大小与创建时间。 |
| `triggers` | 自动化触发器表。保存触发器 ID、类型（cron/webhook/once）、调度参数与分发模式。 |
| `automation_events` | Webhook 收件箱表。保存接收到的外部事件载荷、去重键与关联产物。 |
| `pending_asks` | 人机协同待办表。保存 Ask 请求 ID、提示词、选项列表、过期时间与确认答案。 |
| `hub_skills` | Hub 全局托管 Skills 表。保存全局 Skill ID 与 Markdown 正文。 |
| `hub_extensions` | Hub 全局托管 Extensions 表。保存全局 Extension ID 与代码内容。 |
| `provider_credentials` | Hub 全局模型供应商凭据表。保存供应商 ID、认证方式、API Key 与 OAuth 信息。 |
| `session_shares` | 会话公开分享表。保存分享令牌 Token、关联会话与有效期。 |
| `notification_channels` | 出站通知通道表。保存通道类型、目标 Webhook URL、HMAC 密钥与推送事件过滤。 |
| `notification_outbox` | 出站通知队列记录表。保存待投递通知、投递状态、重试次数与错误信息。 |
| `bot_files` | Bot 提示词与记忆文件数据表。 |
| `settings` | Hub 系统配置表。持久化保存系统密钥（如 `ask_secret`）。 |
| `session_resets_pending` | 会话重置排队记录表。 |
| `artifact_cleanup_pending` | 待清理产物临时记录表。 |
| `outbound_task_queue` | 离线节点出站任务暂存队列。 |

---

## 模型凭据管理机制

botd 采用 Hub 集中凭据管理机制：

### 1. Hub 全局凭据（推荐与默认）

- 保存位置：`hub.sqlite` 中的 `provider_credentials` 表。
- 架构定位：Hub 作为系统大脑统一执行模型推理，Node 执行端不接触密钥明文。
- 鉴权支持：支持 API Key 与 OAuth 认证。
- 直管接口：CLI `botd providers login <providerId>`（免指定 nodeId）或 Web 控制台配置。
- 环境变量：支持通过 `BOTD_API_KEY_<PROVIDER>` 预置密钥。

### 2. 节点专属凭据（可选覆盖）

- 保存位置：Node 节点 `<数据目录>/.agent/auth.json`。
- 适用场景：特定节点的专属模型覆盖。
- 直管接口：CLI `botd providers login <nodeId> <providerId>`。
