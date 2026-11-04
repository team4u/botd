# botd 文档索引

欢迎查阅 botd 技术文档。本文档库提供系统架构、操作指南与接口规范。[返回项目首页](../README.md)

初次使用请先阅读[快速入门指南](getting-started.md)。架构设计请阅读[系统架构说明](architecture.md)。

## 角色导航

### 新用户与日常使用

| 文档 | 说明 |
| :--- | :--- |
| [快速入门指南](getting-started.md) | 安装依赖、启动服务与配对第一个节点。 |
| [用户协同指南](user-guide.md) | 使用全双工会话、派发后台任务、实时插话与查看执行进度。 |
| [工作区指南](workspace.md) | Git Worktree 隔离机制与远端执行环境。 |
| [模型与供应商](models.md) | 配置模型服务商与 API 密钥。 |

### 系统管理员与运维

| 文档 | 说明 |
| :--- | :--- |
| [部署指南](deployment.md) | 使用 Docker Compose 或系统服务部署生产环境。 |
| [配置参考](configuration.md) | 查阅环境变量、端口约定与存储路径。 |
| [安全边界](security.md) | 查阅权限隔离、网络访问控制与凭据管理。 |
| [团队协作](team.md) | 查阅多用户团队共享、多角色分身协同与全局知识召回。 |
| [故障排查](troubleshooting.md) | 诊断节点离线、任务挂起与模型报错。 |

### 自动化与事件流

| 文档 | 说明 |
| :--- | :--- |
| [自动化工作流](automation.md) | 编写 SubagentWorkflow 脚本与 Watchdog 自愈巡检。 |
| [触发器与网关](triggers.md) | 配置 Webhook、定时 Cron 与一次性计划任务。 |
| [外部渠道集成](channels.md) | 接入飞书、钉钉、Slack、Telegram 与企业微信。 |

### 核心开发者与扩展

| 文档 | 说明 |
| :--- | :--- |
| [系统架构说明](architecture.md) | 查阅三层拓扑、Pi Durable 引擎、事务型文档与自愈循环。 |
| [开发指南](development.md) | 配置本地开发环境与调试流程。 |
| [HTTP API 参考](api.md) | 查阅 Hub REST 接口与 SSE 事件规范。 |
| [CLI 命令参考](cli.md) | 使用命令行工具管理节点、会话与任务。 |
| [扩展与工作流](extensions.md) | 编写自定义扩展、工具与多文件技能包。 |
| [生成式 UI](generative-ui.md) | 查阅组件规范、图表公式与 SecretStash 机密零泄漏。 |
| [测试指南](testing.md) | 执行端到端测试与单元验证。 |
| [重构设计文档](20261104%20botd基于pi-durable的多角色Super-agent重构设计文档.md) | 查阅基于 Pi Durable 架构重构的设计基准与决策记录。 |

## 核心概念与术语

系统使用以下标准化技术术语：

| 术语 | 英文 | 说明 |
| :--- | :--- | :--- |
| **Hub** | Hub | 中心大脑与持久状态服务。Hub 管理 SQLite 存储并执行任务调度。 |
| **Node** | Node | 远程执行节点。Node 通过 RPC 接收文件与命令执行请求。 |
| **Router** | Router | 角色分身的前台会话。Router 负责用户交互与任务分发。 |
| **Worker** | Worker | 后台执行会话。Worker 拥有独立执行环境与代码工具。 |
| **Worktree** | Worktree | Git 独立工作树。Node 为每个 Worker 创建独立代码目录。 |
| **Harness** | Harness | Pi Durable 调度引擎。Harness 管理会话与任务生命周期。 |
| **Transcript** | Transcript | 持久化对话记录。Transcript 记录所有消息、思考与工具调用。 |
| **Turn** | Turn | 模型与工具交互回合。一次交互由输入、推理与输出构成。 |
| **Recall** | Recall | 上下文召回机制。系统通过 ID 检索外溢内容与关联数据。 |
| **Ask** | Ask | 人机确认请求。任务需要人工授权时创建确认卡片。 |
| **EventRouter** | EventRouter | 外部事件流水线。EventRouter 负责事件过滤与直通路由。 |
| **Watchdog** | Watchdog | 外部巡检任务。Watchdog 定期检查超时任务并执行纠偏。 |

## 核心代码入口

| 模块 | 文件路径 | 职责说明 |
| :--- | :--- | :--- |
| Hub 运行时底座 | [hub-harness.ts](../apps/hub/src/harness/hub-harness.ts) | 组装 Pi Durable Harness 实例并注册核心扩展。 |
| 事务型文档定义 | [docs.ts](../apps/hub/src/harness/docs.ts) | 定义 TargetDoc、WorkerRegistryDoc 与 RecallIndexDoc。 |
| 前台 Router 扩展 | [router-extension.ts](../apps/hub/src/harness/router-extension.ts) | 提供 spawn_worker、delegate_to_bot 与 ask_human 工具。 |
| 后台 Worker 扩展 | [worker-extension.ts](../apps/hub/src/harness/worker-extension.ts) | 提供任务级 subagent 并挂载 afterRun 自动汇报钩子。 |
| 远端环境适配器 | [remote-env.ts](../apps/hub/src/harness/remote-env.ts) | 实现 ExecutionEnv 接口并转发 RPC 请求至目标节点。 |
| 外部事件流水线 | [event-router.ts](../apps/hub/src/harness/event-router.ts) | 执行快路径过滤、线程直通与超长外溢。 |
| 巡检与自愈任务 | [watchdog.ts](../apps/hub/src/harness/watchdog.ts) | 执行卡死检测、模型报错重试与系统诊断。 |
| 工作流编排工具 | [workflow-extension.ts](../apps/hub/src/harness/workflow-extension.ts) | 执行 SubagentWorkflow 脚本并提供断点重放。 |
| 节点环境服务 | [env-rpc-server.ts](../apps/node/src/env-rpc-server.ts) | 处理文件系统操作、Shell 执行与 Worktree 创建。 |
| 远程执行协议 | [env-rpc.ts](../packages/protocol/src/env-rpc.ts) | 定义 NodeEnvRpcFunctions 与流式推送数据结构。 |
