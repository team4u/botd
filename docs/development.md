# 开发指南

[文档目录](README.md)

本文描述如何在源码中运行、调试和扩展 botd。先读[架构说明](architecture.md)了解组件分工。

## 本地运行

安装依赖并构建共享包：

```bash
pnpm install
pnpm build
```

日常开发同时启动 Hub 和 Web：

```bash
BOTD_PORT=3002 pnpm dev
```

浏览器只访问 `http://localhost:3001`。Vite 把 `/api` 与 `/ws` 代理到 `3002`。本机开发不占用 `3000`。生产默认端口仍为 `3000`。

只调试某一端时，在两个终端分别运行：

```bash
BOTD_PORT=3002 pnpm dev:hub
pnpm dev:web
```

`dev:web` 要求 Hub 已在 `3002` 运行。Vite 配置了 `strictPort: true`，端口被占会直接报错。

需要执行真实任务时，按[入门指南](getting-started.md)配对节点。然后另开终端启动 Node Agent：

```bash
pnpm node start
```

代码改动的生效方式：

- Hub 使用 `tsx watch` 监听模式，保存后自动重启。
- Web 由 Vite 热更新。
- 节点没有监听模式，修改节点代码后重启守护进程。

## 环境要求

- Node.js `>=24.12.0`，pnpm `10.34.9`。
- 工作区包含 `apps/*` 与 `packages/*`，在仓库根目录执行全部命令。

## 代码导览

| 目录 | 职责 | 关键入口 |
| --- | --- | --- |
| `apps/hub` | HTTP 服务、SQLite 存储、会话调度、节点连接、SSE 广播 | `src/index.ts`（`createHub`/`startHub`、路由注册） |
| `apps/node` | Node Agent 守护进程、CLI、Pi 运行时、本地存储 | `src/daemon.ts`（守护进程与 Hub 连接） |
| `apps/node/src/cli` | 全部 CLI 子命令与输出渲染 | `src/cli/program.ts`（`buildProgram` 组装命令树） |
| `apps/node/src/runtime` | 回合执行、子代理控制、shell 环境、工具摘要的拆分实现 | `src/runtime.ts`（门面桶文件，转发各子模块） |
| `apps/web` | React 界面、API 客户端、SSE 事件消费 | `src/App.tsx`、`src/api.ts`、`src/events.ts` |
| `packages/protocol` | 跨端类型、RPC 接口定义、SSE 事件、输入校验器 | `src/index.ts` |
| `packages/models` | 从 pi-ai SDK 投影公开模型元数据 | `src/index.ts`（`buildModelCatalog`） |
| `tests/` | 集成测试与回归测试 | 见[测试指南](testing.md) |
| `deploy/` | 容器构建与生产部署配置 | 见[部署指南](deployment.md) |

Hub 内部模块按领域拆分。数据库在 `db.ts`。节点 WebSocket 管理在 `ws-hub.ts`。多 Bot 调度在 `group-router.ts`。产物服务在 `artifact-service.ts`。

## 各端日志与调试

三端日志各有归属，排查时先定位问题发生在哪一端。

**Hub 日志**

Hub 直接输出到运行它的终端。启动时打印监听地址 `Cloud Hub listening on http://127.0.0.1:<port>`。

未设置 `BOTD_ADMIN_PASSWORD` 时，Hub 在 stderr 打印一次性管理员密码。检查启动输出，不要反复重启丢失该密码。

请求级错误由 `app.onError` 处理。内部错误只留终端日志，对外返回通用 500。

**节点日志**

前台运行 `pnpm node start` 时，日志直接进入当前终端。

后台运行的日志文件默认是 `<数据目录>/daemon.log`。数据目录由 `BOTD_DATA_DIR` 指定，默认 `~/.botd`。也可以用 `BOTD_DAEMON_LOG` 或 `botd start --log-file <path>` 指定日志路径。

节点通过 `/ws/node?nodeId=<id>&token=<token>` 连接 Hub。断线后自动重连，重连最小延迟由 `BOTD_WS_MIN_RECONNECT_DELAY_MS` 控制。

**Web 与代理链路**

浏览器请求先到 Vite（`3001`），再由代理转发到 Hub（`3002`）。代理规则固化在 `apps/web/vite.config.ts`：

- `/api` 转发到 `http://localhost:3002`。
- `/ws` 转发到 `ws://localhost:3002`，含 WebSocket 升级。

页面报连接错误时，按顺序检查 Vite 终端、Hub 终端、`BOTD_PORT` 是否为 `3002`。

## 常见开发任务

### 加一个 CLI 子命令

CLI 基于 commander 组装。入口链是 `apps/node/src/cli.ts` → `cli/main.ts` → `cli/program.ts`。

1. 在 `apps/node/src/cli/commands/` 新建文件，导出 `registerXxxCommands(program: Command)`。
2. 在函数内用 `program.command('xxx')` 定义子命令、描述、选项和动作。
3. 动作包装用 `cliAction`，全局选项用 `readGlobals` 读取。
4. 在 `cli/program.ts` 导入并在 `buildProgram()` 中调用注册函数。

全局选项 `--json`、`--data-dir`、`--hub`、`--password`、`--timeout` 已在 `program.ts` 定义，直接使用。

验证命令：

```bash
pnpm node xxx --help
```

### 加一个 Hub 路由

Hub 基于 Hono。路由有两种注册方式：

- 少量路由直接写在 `apps/hub/src/index.ts` 的 `createHub()` 内，使用 `app.get`/`app.post` 等。
- 独立领域抽成模块，导出 `registerXxxRoutes(app, ...)`，在 `createHub()` 末尾调用。现有例子见 `providers.ts`、`triggers.ts`、`delegation.ts`。

新路由必须经过 `/api/*` 认证中间件。公开路径白名单也在 `index.ts` 中维护，包括 `/api/health`、登录、配对交换、webhook 回调与 `/api/public/*`。

会话类路由用 `resolveOwnedSession` 校验权限。该函数内部调用 `canUserAccessSession`，参与者也能通过。需要所有者权限的操作要单独判断。

### 改 protocol 类型后的连锁构建

`packages/protocol` 的 `exports` 指向 `dist/index.js`。Hub、节点和 Web 依赖其构建产物。

修改 protocol 后按顺序执行：

```bash
pnpm build
pnpm typecheck
```

`pnpm build` 即 `pnpm -r build`，pnpm 按依赖拓扑顺序先构建 `protocol` 和 `models`，再构建三个应用。开发模式（`tsx watch` 与 Vite）同样读取 `dist` 产物，改动 protocol 后必须先重新构建，否则下游看不到新类型。

### 数据库结构在哪里看

全部表结构和迁移逻辑在 `apps/hub/src/db.ts`：

- 内置 SQLite 驱动为 `node:sqlite`。
- 表包括 `users`、`nodes`、`bots`、`sessions`、`messages`、`artifacts`、`triggers`、`automation_events`、`pending_asks`、`outbound_task_queue`、`session_participants`、`settings` 等。
- 迁移通过 `PRAGMA user_version` 版本号驱动。
- 数据库文件路径由 `BOTD_DB_PATH` 指定，默认在 `BOTD_HUB_DATA_DIR`（缺省 `~/.botd`）下的 `hub.sqlite`。

测试用例通过 `startHub({ dbPath })` 传入临时路径。不要把测试指向本机生产数据库。

### 运行测试

命令与测试分组见[测试指南](testing.md)。常用命令：

```bash
pnpm test
pnpm exec tsx --test tests/hub.test.ts
```

`pnpm test` 即 `tsx --test tests/*.test.ts`，直接跑在仓库根目录的 `tests/` 下。

CI 在 `.github/workflows/ci.yml` 中按 `install → typecheck → build → test` 顺序执行。

## 发布与文档同步

根 `package.json` 提供了发布快捷方式：`pnpm release` 等价于 `node scripts/release.ts`，参数透传（如 `pnpm release --patch --dry-run`）。发版流程与分发规范见仓库根目录的 `AGENTS.md`。

改动功能时同步更新 `docs/` 下对应文档（命令、环境变量、端口、默认值变更尤其如此），文档与源码不一致时以源码为准修文档。

## 按问题定位代码

| 问题 | 优先检查 |
| --- | --- |
| 接口返回错误、用户看见不该访问的资源 | [index.ts](../apps/hub/src/index.ts)、[http-helpers.ts](../apps/hub/src/http-helpers.ts) |
| Bot 没有接话、接力顺序不对 | [group-router.ts](../apps/hub/src/group-router.ts) |
| 节点离线、RPC 失败、重连异常 | [ws-hub.ts](../apps/hub/src/ws-hub.ts)、[daemon.ts](../apps/node/src/daemon.ts) |
| 模型凭据、提示词、工具执行异常 | [models.ts](../apps/node/src/models.ts)、[provider-auth.ts](../apps/node/src/provider-auth.ts)、[runtime.ts](../apps/node/src/runtime.ts) |
| 消息丢失、游标、恢复或数据迁移 | [db.ts](../apps/hub/src/db.ts) |
| 文件上传、继承或回收异常 | [artifact-service.ts](../apps/hub/src/artifact-service.ts) |
| 子会话或触发器问题 | [delegation.ts](../apps/hub/src/delegation.ts)、[triggers.ts](../apps/hub/src/triggers.ts) |
| CLI 参数和输出异常 | [cli/](../apps/node/src/cli/) |
| 页面状态、流式消息或旧请求覆盖 | [App.tsx](../apps/web/src/App.tsx)、[message-state.ts](../apps/web/src/utils/message-state.ts) |
| Windows shell 或本地控制问题 | [windows-shell.ts](../apps/node/src/windows-shell.ts)、[local-ipc.ts](../apps/node/src/local-ipc.ts) |

## 增加或修改接口

1. 在 `packages/protocol` 定义跨端类型。
2. 在 Hub 模块中校验输入和资源权限。
3. 修改 Web 或 CLI 调用方。
4. 检查事件消费与错误展示。
5. 补充覆盖权限与失败路径的测试。

产物服务和部分管理模块有自己的权限判断。不能由「能查看会话」推出「能调用其中所有接口」。

## 修改 RPC 或 SSE

RPC 与事件类型统一定义在 [protocol/src/index.ts](../packages/protocol/src/index.ts)。`HubRpcFunctions` 是 Hub 侧实现，`NodeRpcFunctions` 是节点侧实现。

Hub RPC 实现在 `ws-hub.ts`，节点 RPC 实现在 `daemon.ts`。新增 RPC 时，检查认证节点能否伪造别的节点、Bot 或会话。

SSE 有两条路由：

- `/api/sessions/:id/events` 推送单个会话事件。
- `/api/events` 推送该用户全部会话事件与节点状态事件。

新增 SSE 事件时，同步更新 Hub 广播与 Web 消费逻辑。事件与 HTTP 快照可能乱序到达。

## 增加本机能力

只需要使用某个 CLI 时，优先编写技能。技能给出前提、命令和失败处理，Bot 通过 Bash 调用。

需要模型可调用的新工具或命令时，再考虑 Pi 扩展。完整的扩展开发指南（钩子、工具、命令与 Web 交互界面）见[扩展开发](extensions.md)，加载方式与网页命令限制见[自动化指南](automation.md)。

新增技能后运行 `pnpm node reload`，让节点向 Hub 重新注册资源清单。Bot 工具环境中的对应命令是 `botd reload`。

## 排查连接与执行

| 现象 | 检查顺序 |
| --- | --- |
| 页面连接失败 | Web 终端、Hub 终端、Vite 代理端口 |
| 节点离线 | `pnpm node status`、节点日志、配对 URL 和 `/ws` 代理 |
| 模型不回复 | Bot 模型配置、节点供应商凭据、节点的外网连接 |
| 文件无法下载 | 产物权限、Hub 文件目录、恢复备份是否包含文件 |
| 停止后出现迟到回复 | 取消逻辑、运行版本标记、事件消费顺序 |

详细诊断步骤见[故障排查](troubleshooting.md)。设计选择与恢复限制见[架构说明](architecture.md)。环境变量清单见[配置参考](configuration.md)。

不要将包含节点令牌的 `node.json` 原文贴入 Issue。报告错误时，只保留定位所需的字段和日志。
