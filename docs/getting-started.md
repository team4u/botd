# 快速起步指南

本指南指导用户从零启动 botd 系统，配置模型凭据，连接执行节点，并体验全双工对话与派生后台 Worker。[返回文档目录](README.md)

## 前置环境要求

源码构建与 Hub 服务需要以下环境：

- Node.js ≥ 24.12.0。
- pnpm 10.34.9。
- Git。
- 可用的模型账户或 API Key。

独立分发的远程 `@botd/node` 守护进程与 `botd` CLI 支持 Node.js ≥ 20.0.0。

执行以下命令检查环境版本：

```bash
node --version
corepack enable
corepack prepare pnpm@10.34.9 --activate
pnpm --version
git --version
```

## 端口约定

本地开发环境严格遵守以下端口分配：

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| Web 前端（Vite） | `3001` | 浏览器唯一访问入口。 |
| Dev Hub 服务端 | `3002` | Hub 后端服务端口，必须通过 `BOTD_PORT=3002` 指定。 |

宿主机 `3000` 端口保留给其他用途。botd 本地开发严禁占用 `3000` 端口。

生产环境部署时，Hub 默认使用 `3000` 端口。

## 1. 下载源码与编译

克隆仓库并安装依赖：

```bash
git clone https://github.com/team4u/botd.git
cd botd
pnpm install
pnpm build

# 链接 botd 命令行工具至全局 PATH
npm link ./apps/node
```

链接完成后，用户在任意终端中均可直接执行 `botd` 命令。

## 2. 首次启动 Web 与 Hub

开启第一个终端窗口，启动前后端服务：

```bash
BOTD_PORT=3002 BOTD_ADMIN_PASSWORD='my-strong-password' pnpm dev
```

该命令启动 Vite（`3001` 端口）与 Hub（`3002` 端口）。用户必须带上 `BOTD_PORT=3002`。

打开浏览器访问 `http://localhost:3001`。使用用户名 `admin` 与刚才配置的密码登录。

指定 `BOTD_ADMIN_PASSWORD` 会在空库创建 `admin`，也会在非空库重启时覆盖 `admin` 密码。未指定该变量时，仅空库首次启动打印一次性随机密码，后续重启保持原密码。

`pnpm dev` 启动管理控制台与 Hub 服务端。Hub 作为系统大脑，执行持久化运行时与模型推理。

## 3. 配置模型凭据

Hub 集中管理全部模型供应商凭据。详细说明请参考[模型供应商指南](models.md)。用户无需连接节点，即可直接在 Hub 配置全局凭据。

### 方式一：Web 界面配置

1. 点击左侧边栏右上角齿轮图标打开全局配置面板。
2. 选择模型供应商（如 Anthropic、OpenAI、DeepSeek 或 Gemini）。
3. 填入 API Key 并保存。凭据保存在 Hub 的 `provider_credentials` 表中。

Hub 同时自动合并读取 `<dataDir>/.agent/auth.json` 与 `models-store.json` 存量配置。

### 方式二：CLI 命令行配置

开启新终端执行登录与应答命令：

```bash
botd providers login anthropic --method api_key
botd providers respond <loginId> --prompt api_key --value "sk-ant-xxx"
```

提交 API Key 后，凭据随即写入 Hub 数据库。

## 4. 节点配对与启动

Node 守护进程作为无状态远端执行环境。守护进程负责文件系统读写、Shell 执行与 Git Worktree 隔离。

在网页端创建配对凭据：

1. 点击左侧边栏右上角「节点与分身管理」图标。
2. 点击右上角「配对节点」按钮。
3. 查看弹窗中的 6 位数字配对码。配对码有效期为 10 分钟。

开启第二个终端窗口，执行配对与启动命令：

```bash
# 节点配对
botd join http://localhost:3001 --code 123456 --name my-workstation

# 启动节点守护进程
botd start
```

终端输出 `Node successfully paired!` 表示配对成功。配对凭据保存在 `~/.botd/node.json`。

`botd start` 在前台启动守护进程。守护进程连接 Hub 并提供远程执行能力。

开启第三个终端验证节点状态：

```bash
botd status
```

输出显示守护进程 PID、节点名称与 Hub 连接状态。回到网页端，刷新可确认 `my-workstation` 节点处于在线状态。

## 5. 首次对话体验

在欢迎页点击主打角色卡片，或在左侧边栏快速选择默认助手进入会话。

向 Bot 发送第一条测试指令：

> 检查当前工作目录，并输出当前操作系统与 Node.js 版本。

前台 Router 会话解析指令，调用远端节点的系统工具，返回执行结果。

用户也可通过 CLI 发送测试消息：

```bash
# 获取默认助手所在会话并发送指令
botd chat send sess_1 "你好，请汇报当前状态" --wait 60
```

CLI 订阅事件流，等待回复完成后输出内容。

## 6. 派生 Worker 体验（Super-agent）

botd 支持通过派生后台 Worker 执行多步长耗时任务。Worker 享有独立 Git Worktree 隔离与异步事件通知。前台 Router 会话永不阻塞。

### 方式一：在对话中通过自然语言派生

在会话中向「默认助手」发送以下提示词：

> 请派生一个后台 Worker，在独立分支上重构项目 README 文档。

前台 Router 调用 `spawn_worker` 在后台启动新 Worker。顶部 `ActiveWorkersBar` 自动从隐藏状态展开并显示任务胶囊。

### 方式二：通过 CLI 显式派生 Worker

用户可直接使用 `botd workers` 命令派生任务：

```bash
# 为指定会话派生带 Worktree 隔离的 Worker
botd workers spawn sess_1 \
  --title "文档优化任务" \
  --task "梳理 docs 目录结构，并补齐快速起步文档" \
  --worktree
```

命令立即返回 Worker ID（例如 `wrk_a1b2c3`）。

### 检视与干预 Worker

通过 CLI 检视 Worker 执行进度：

```bash
# 查看会话下的 Worker 列表与状态
botd workers list sess_1

# 向执行中的 Worker 追加指令（插话引导）
botd workers steer sess_1 wrk_a1b2c3 "优先整理 API 文档"

# 检视 Worker 的执行历史与记忆回忆链
botd workers recall sess_1 wrk_a1b2c3
```

任务完成后，Worker 状态自动变为 `completed`。系统将结果摘要写入回忆链，主控 Bot 可随时检索。

## 停止与重启服务

停止服务：

- 在前台终端按 `Ctrl+C` 停止开发服务。
- 执行 `botd stop` 停止后台守护进程。

再次启动服务：

```bash
# 启动 Web 与 Hub
BOTD_PORT=3002 pnpm dev

# 在另一个终端启动 Node 守护进程
botd start -d
```

`-d` 选项指示守护进程在后台执行。日志默认输出至 `~/.botd/daemon.log`。

## 下一步

- [用户协同指南](user-guide.md)：学习全双工交互、ActiveWorkersBar 与任务插话。
- [系统架构说明](architecture.md)：理解脑手分离、Pi Durable 引擎与自愈设计。
- [工作区指南](workspace.md)：深入掌握 Git Worktree 隔离机制。
- [模型配置指南](models.md)：配置更多模型供应商与思考档位。
- [CLI 命令参考](cli.md)：学习全部命令行管理指令。
- [API 参考](api.md)：查阅 REST 路由与 WebSocket 契约。
- [配置指南](configuration.md)：了解环境变量与数据目录布局。
- [生产部署指南](deployment.md)：使用 Docker Compose 部署生产环境。
