# 实现验收记录

本记录对应当前工作目录中的实现。原始设计保存在 [design.md](./design.md)。运行环境为 Linux、Node.js 24.12.0、pnpm 10.34.9、Pi SDK 1.4.0。

## 自动检查

以下命令已通过：

```bash
pnpm install --frozen-lockfile --offline --ignore-scripts
pnpm typecheck
pnpm build
pnpm test
docker compose -f deploy/docker-compose.yml config --quiet
sh -n deploy/entrypoint.sh
```

测试共 17 项，全部通过：

- 管理员认证、一次性配对、节点注册、模型配置同步与节点权威元数据覆盖。
- 跨节点 `@` 接力、公屏增量上下文、模型徽章和 SSE。
- 圆桌顺序、自循环与多目标扇出接力上限。
- 唤醒排队、取消后立即发新消息、迟到回复抑制。
- RPC 异常保留错误原因，以及失败后重新发起任务。
- 节点身份与群成员校验、跨节点 BOT ID 抢占拦截。
- 文件读写、非法请求不覆盖原文件、离线节点保留元数据。
- 会话内串行、不同会话并发、执行期间新增消息不被游标跳过。
- 真实 CLI 的 `join/start/wake`、PartySocket 断线重连、文件权限与重复守护进程拦截。
- 真实 Pi SDK 连接本机受控 OpenAI 兼容端点，执行 Bash、读取人设/记忆和启用的 Skill、保存私有 JSONL。测试同时运行两个 BOT，并验证各自环境变量互不覆盖，且不加载测试目录中的 `.pi`、`AGENTS.md` 或未启用 Skill。

最后一项 SDK 测试还验证未知模型在请求端点之前失败，以及运行时 Key 优先于 SDK 模型目录中的 Key。

供应商扩展还覆盖了 SDK 完整目录的 HTTP/RPC 转发、不泄露 Key/私有 Header 的元数据投影、原生 API Key 交互的附加配置字段、OAuth 保存和过期令牌刷新、手动回调与自动回调竞争、重复登录拦截、取消、超时和秘密字段错误脱敏。真实 Node Agent 测试实际启动 Mistral 的 SDK Key 提示并取消，不输入真实密钥。


## 手动验收

使用 agent-browser 操作生产构建界面，验证了管理员登录、创建群聊、Lead 向评审 BOT 传麦、流式输出与最终消息、`@` 成员选择、停止生成、在线保存 Skill、保存 SYSTEM.md 与 MEMORY.md，以及 390px 移动视口导航。

浏览器验收使用临时 Hub 和受控 WebSocket 节点。真实 Node Agent 与真实 Pi SDK 分别由自动化集成测试覆盖；验收没有调用付费模型服务。

供应商扩展在隔离的真实 Hub/Node 上验证了完整目录搜索、Mistral 原生密钥提示和取消、仅 OAuth 供应商不显示 API Key 输入框，以及从 SDK 目录选择 Mistral 模型后保存到节点。OAuth 状态与刷新逻辑使用本机受控供应商测试，未使用真实第三方账号完成授权。

另从 `apps/hub` 目录启动编译后的 Hub，确认健康检查、Web SPA 与 PWA manifest 正常响应，并验证 SIGTERM 正常退出。在独立工作目录运行编译后生成的 `botd` 包装脚本，确认 CLI 可以解析并执行。

## 尚未验证的外部环境

Docker Compose 配置通过校验。Docker Hub 与备用镜像源拉取 Node 24 基础镜像时均返回 EOF，因此未完成容器镜像构建与容器运行验收。

实际模型服务需要使用者配置自己的 API Key。ActionDock、Herdr CLI 的实际调用取决于目标节点已安装的工具和 Skill，本次未运行这些外部工具。内存队列和配对码不会跨 Hub 重启恢复。
