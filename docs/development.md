# 开发指南

[文档目录](README.md)

先确定问题发生在网页、Hub 还是节点。三者独立运行，日志和数据也各有归属。

## 本地运行

安装依赖后先构建共享包，再启动开发服务：

```bash
pnpm install
pnpm build
BOTD_PORT=3002 pnpm dev
```

浏览器使用 `http://localhost:3001`。Hub 使用 `3002`。本机开发不占用 `3000`，生产默认值保持不变。

只调试某一端时：

```bash
BOTD_PORT=3002 pnpm dev:hub
pnpm dev:web
```

这两条命令在不同终端运行。前端代理目标固定为 `3002`。

需要执行真实任务时，按[入门指南](getting-started.md)配对节点，再另开终端运行：

```bash
pnpm node start
```

修改节点代码后需要重新启动节点。Hub 使用监听模式，Web 由 Vite 热更新。

## 仓库结构

```text
botd/
├── apps/
│   ├── hub/            # HTTP、SQLite、调度、节点连接
│   ├── node/           # 守护进程、CLI、Pi 运行时、本地存储
│   └── web/            # React 界面、API 客户端、事件处理
├── packages/
│   ├── protocol/       # 跨端类型、RPC、事件、校验
│   └── models/         # 公开模型元数据
├── tests/              # 集成测试和回归测试
├── deploy/             # 容器构建与生产部署配置
└── docs/
```

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

1. 在共享协议中定义需要跨端使用的类型。
2. 在对应 Hub 模块中校验输入和资源权限。
3. 修改 Web 或 CLI 调用方。
4. 检查事件消费与错误展示。
5. 增加覆盖权限和失败路径的测试。

`resolveOwnedSession` 的名称不代表仅限所有者。它调用 `canUserAccessSession`，允许会话参与者访问。需要所有者权限的操作必须单独检查。

产物服务和部分管理模块有自己的权限判断。不能推断“能查看会话”就能调用其中所有接口。

## 修改 RPC 或 SSE

RPC 与事件类型统一定义在 [protocol/src/index.ts](../packages/protocol/src/index.ts)。

Hub RPC 实现在 `ws-hub.ts`，节点 RPC 实现在 `daemon.ts`。新增 RPC 时，检查认证节点能否伪造别的节点、Bot 或会话。

新增 SSE 事件时，同步更新 Hub 广播和 Web 消费逻辑。注意事件与 HTTP 快照可能乱序到达。

## 增加本机能力

只需要使用某个 CLI 时，优先编写技能。技能给出前提、命令和失败处理，Bot 通过 Bash 调用。

需要模型可调用的新工具或命令时，再考虑 Pi 扩展。加载方式和网页命令限制见[自动化指南](automation.md)。

新增技能后，运行 `pnpm node reload` 更新资源清单，再为目标 Bot 启用。运行于 Bot 工具环境中的对应命令是 `botd reload`。

## 排查连接与执行

| 现象 | 检查顺序 |
| --- | --- |
| 页面连接失败 | Web 终端、Hub 终端、Vite 代理端口 |
| 节点离线 | `pnpm node status`、节点日志、配对 URL 和 `/ws/node` 代理 |
| 模型不回复 | Bot 模型配置、节点供应商凭据、节点的外网连接 |
| 文件无法下载 | 产物权限、Hub 文件目录、恢复备份是否包含文件 |
| 停止后出现迟到回复 | 取消逻辑、运行版本标记、事件消费顺序 |

后台节点日志默认位于 `~/.botd/daemon.log`。前台节点直接向当前终端输出。

不要将包含节点令牌的 `node.json` 原文贴入 Issue。报告错误时，只保留定位所需的字段和日志。

验证命令与测试分组见[测试指南](testing.md)。设计选择与恢复限制见[架构说明](architecture.md)。
