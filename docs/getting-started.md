# 入门指南

[文档目录](README.md)

先让一个 Bot 在你的电脑上执行命令，再把第二台机器接进来。本指南带你完成第一步。

完成后，你会看到节点在线、工具执行轨迹，以及 Bot 返回的系统信息。

## 准备环境

需要以下工具：

- Node.js ≥ 24.12.0。
- pnpm 10.34.9。
- Git。
- 一个可用的模型账号或 API Key。

以下命令适用于 macOS、Linux 或 Windows 的 Git Bash。Windows 节点的 Bash 配置见[配置参考](configuration.md)。

```bash
node --version
corepack enable
corepack prepare pnpm@10.34.9 --activate
pnpm --version
```

本次体验需要两个终端。一个运行 Web 和 Hub，另一个运行节点。

## 1. 下载和构建

```bash
git clone https://github.com/team4u/botd.git
cd botd
pnpm install
pnpm build
```

后续命令均在仓库根目录执行。项目目前从源码构建，不需要全局安装 `botd`。

## 2. 启动网页服务

在第一个终端执行：

```bash
BOTD_PORT=3002 BOTD_ADMIN_PASSWORD='replace-with-a-long-password' pnpm dev
```

先把示例密码换成自己的密码。保持此终端运行。

打开 **http://localhost:3001**，使用 `admin` 和刚才的密码登录。

管理员密码只在首次初始化数据库时生效。已有账户需要使用原密码。更改环境变量不会重置密码。

| 地址 | 用途 |
| --- | --- |
| `http://localhost:3001` | 浏览器入口，由 Vite 提供前端 |
| `http://localhost:3002` | Hub 上游，供 Vite 代理 API 和 WebSocket |

本机开发保留上述端口。`pnpm dev` 只启动 Web 和 Hub，尚未启动执行任务的节点。

## 3. 配对并启动节点

在网页左下角打开「节点与智能体」，点击「配对节点」。网页会显示一个配对码，有效期为 10 分钟。

另开一个终端，进入仓库根目录。将 `123456` 换成网页中的配对码：

```bash
pnpm node join http://localhost:3001 --code 123456 --name my-workstation
pnpm node start
```

保持第二个终端运行。回到网页，等待 `my-workstation` 显示在线。

首次启动空节点时，Node Agent 会创建「默认助手」。它默认使用 `anthropic/claude-sonnet-4-5`。接下来可以换成你有权限使用的模型。

节点凭据默认保存在 `~/.botd/node.json`。以后启动节点只需运行 `pnpm node start`。

## 4. 配置模型

1. 打开左下角的「模型与凭据设置」。
2. 选择刚上线的节点。
3. 选择模型供应商，按页面提示登录或输入 API Key。
4. 回到「节点与智能体」，编辑「默认助手」。
5. 选择该节点可用的供应商和模型，保存配置。

凭据保存在所选节点的 `.agent/auth.json`。该文件不提供文件内容加密。请保护节点账户和备份。

如果你使用其他供应商，需要修改 Bot 的模型配置。仅添加另一个供应商的凭据，不会切换默认助手的模型。

登录失败、自定义模型和环境变量配置见[模型指南](models.md)。

## 5. 交给 Bot 第一条任务

在左侧「智能体」列表点击「默认助手」。网页会打开它的单聊。

发送以下内容：

> 查看你的工作目录。运行命令，告诉我当前操作系统和 Node.js 版本。

你应该看到工具执行轨迹，随后收到系统信息。模型会自行选择命令，实际调用步骤可能不同。

到这里，你已经可以在浏览器里让本机 Bot 完成任务。接下来可以尝试上传一份文件，或创建另一个 Bot。

## 停止和再次启动

前台运行时，在各自终端按 `Ctrl+C` 停止进程。停止进程会保留磁盘数据。

再次使用时，在第一个终端执行：

```bash
BOTD_PORT=3002 pnpm dev
```

在第二个终端执行：

```bash
pnpm node start
```

需要后台运行节点时，先停止前台节点，再执行：

```bash
pnpm node start -d
pnpm node status
```

后台日志默认写入 `~/.botd/daemon.log`。使用 `pnpm node stop` 停止后台节点。

## 遇到问题

| 现象 | 检查方法 |
| --- | --- |
| 网页打不开 | 检查两个开发进程的日志，浏览器使用 `3001` |
| Vite 报端口占用 | 结束占用 `3001` 的旧开发进程，再启动 |
| 节点显示离线 | 检查第二个终端是否仍运行，确认配对 URL 能从节点访问 |
| 配对码无效 | 重新生成配对码，使用未过期且未使用的码 |
| 模型提示缺少凭据 | 检查凭据所在节点，以及 Bot 当前选择的供应商 |
| 登录密码不正确 | 检查是否使用过同一数据库，初始化变量不会覆盖已有密码 |

不要通过删除数据目录来排查普通连接问题。目录中包含凭据、记忆和会话文件。

## 下一步

- [用户指南](user-guide.md)：上传文件、切换话题、多角色盲评与子会话协同。
- [自动化指南](automation.md)：后台任务、确认卡片、定时触发与事件驱动子会话。
- [部署指南](deployment.md)：长期运行、Docker 和备份。
- [安全边界](security.md)：了解工具执行所使用的系统权限。
