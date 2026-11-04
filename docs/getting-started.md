# 快速起步指南

本指南指导用户从零启动 botd 系统，完成节点配对，并体验首次对话与派生后台 Worker。[返回文档目录](README.md)

## 前置环境要求

系统需要以下环境：

- Node.js ≥ 24.12.0。
- pnpm 10.34.9。
- Git。
- 可用的模型账户或 API Key。

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
```

项目通过源码工作区编译。用户无需全局安装 npm 包。

## 2. 首次启动 Web 与 Hub

开启第一个终端窗口，启动前后端服务：

```bash
BOTD_PORT=3002 BOTD_ADMIN_PASSWORD='my-strong-password' pnpm dev
```

该命令启动 Vite（`3001` 端口）与 Hub（`3002` 端口）。用户必须带上 `BOTD_PORT=3002`。

打开浏览器访问 `http://localhost:3001`。使用用户名 `admin` 与刚才配置的密码登录。

`pnpm dev` 仅启动管理控制台与服务端，不包含任务执行节点。

## 3. 创建节点配对码

在网页端创建配对凭据：

1. 点击左下角「节点与智能体」。
2. 点击右上角「配对节点」按钮。
3. 查看弹窗中的 6 位数字配对码。

配对码有效期为 10 分钟。配对完成后配对码自动失效。

## 4. 节点配对与启动

开启第二个终端窗口，进入项目根目录。将 `123456` 替换为网页显示的配对码：

```bash
# 节点配对
pnpm node join http://localhost:3001 --code 123456 --name my-workstation

# 启动节点守护进程
pnpm node start
```

终端输出 `Node successfully paired!` 表示配对成功。配对凭据保存在 `~/.botd/node.json`。

`pnpm node start` 在前台启动守护进程。守护进程负责执行具体的模型工具与 Shell 指令。

开启第三个终端验证节点状态：

```bash
pnpm node status
```

输出显示守护进程 PID、节点名称与 Hub 连接状态。回到网页端，刷新可确认 `my-workstation` 节点处于在线状态。

## 5. 配置模型凭据

首次启动空节点时，系统创建内置 Bot「默认助手」。

用户按以下步骤配置模型：

1. 打开 Web 控制台左下角「模型与凭据配置」。
2. 选择已连接的 `my-workstation` 节点。
3. 选择模型供应商（如 Anthropic 或 OpenAI），填入 API Key 并保存。
4. 打开「节点与智能体」页面，编辑「默认助手」。
5. 选择刚配置的模型供应商与具体模型 ID，保存配置。

凭据安全保存在节点的 `~/.botd/.agent/auth.json` 文件中。

## 6. 首次对话体验

在 Web 控制台左侧列表点击「默认助手」，进入会话界面。

向 Bot 发送第一条测试指令：

> 检查当前工作目录，并输出当前操作系统与 Node.js 版本。

Bot 会调用系统工具，并在会话中返回执行结果。

用户也可通过 CLI 发送测试消息：

```bash
# 获取默认助手所在会话并发送指令
pnpm node chat send sess_1 "你好，请汇报当前状态" --wait 60
```

CLI 订阅事件流，等待回复完成后输出内容。

## 7. 派生 Worker 体验（Super-agent）

botd 支持通过派生后台 Worker 执行多步长耗时任务。Worker 享有独立 Git Worktree 隔离与异步事件通知。

### 方式一：在对话中通过自然语言派生

在会话中向「默认助手」发送以下提示词：

> 请派生一个后台 Worker，在独立分支上重构项目 README 文档。

主控 Bot 会调用派生工具，在后台启动新 Worker。

### 方式二：通过 CLI 显式派生 Worker

用户可直接使用 `botd workers` 命令派生任务：

```bash
# 为指定会话派生带 Worktree 隔离的 Worker
pnpm node workers spawn sess_1 \
  --title "文档优化任务" \
  --task "梳理 docs 目录结构，并补齐快速起步文档" \
  --worktree
```

命令立即返回 Worker ID（例如 `wrk_a1b2c3`）。

### 检视与干预 Worker

通过 CLI 检视 Worker 执行进度：

```bash
# 查看会话下的 Worker 列表与状态
pnpm node workers list sess_1

# 向执行中的 Worker 追加指令（插话引导）
pnpm node workers steer sess_1 wrk_a1b2c3 "优先整理 API 文档" --mode steer

# 检视 Worker 的执行历史与记忆回忆链
pnpm node workers recall sess_1 wrk_a1b2c3
```

任务完成后，Worker 状态自动变为 `completed`。系统将结果摘要写入回忆链，主控 Bot 可随时检索。

## 停止与重启服务

停止服务：

- 在前台终端按 `Ctrl+C` 停止开发服务。
- 执行 `pnpm node stop` 停止后台守护进程。

再次启动服务：

```bash
# 启动 Web 与 Hub
BOTD_PORT=3002 pnpm dev

# 在另一个终端启动 Node 守护进程
pnpm node start -d
```

`-d` 选项指示守护进程在后台执行。日志默认输出至 `~/.botd/daemon.log`。

## 下一步

- [CLI 手册](cli.md)：学习全部命令行管理指令。
- [API 参考](api.md)：查阅 REST 路由与 WebSocket 契约。
- [配置指南](configuration.md)：了解环境变量与数据目录布局。
