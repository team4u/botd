# 测试指南

[文档目录](README.md)

自动检查验证代码契约和回归场景。真实模型、浏览器、容器和操作系统仍需要对应环境验收。

## 运行检查

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

这与 [CI](../.github/workflows/ci.yml) 的检查顺序一致。测试使用 `tsx` 和 Node.js 测试运行器。

调试单个功能时，运行相关文件：

```bash
pnpm exec tsx --test tests/hub.test.ts
pnpm exec tsx --test tests/provider-auth.test.ts
```

测试使用临时数据和受控依赖。不要把本机生产数据库或真实凭据放进测试配置。

## 测试入口

| 场景 | 代表性测试 |
| --- | --- |
| HTTP、认证、节点注册和会话 | [hub.test.ts](../tests/hub.test.ts) |
| 节点存储、守护进程和 CLI | [node.test.ts](../tests/node.test.ts) |
| Pi 会话、技能加载和工具环境 | [sdk.test.ts](../tests/sdk.test.ts) |
| 模型供应商认证流程 | [provider-auth.test.ts](../tests/provider-auth.test.ts) |
| 多 Bot 调度和持久化 | [persistence-parallel.test.ts](../tests/persistence-parallel.test.ts) |
| 离线任务、共享资源和多人会话 | [phase2-3-hub-mesh.test.ts](../tests/phase2-3-hub-mesh.test.ts) |
| 子会话委派与父会话回报 | [sub-session-delegation.test.ts](../tests/sub-session-delegation.test.ts) |
| 产物上传、下载与清理 | [artifact-streaming.test.ts](../tests/artifact-streaming.test.ts)、[artifact-regressions.test.ts](../tests/artifact-regressions.test.ts) |
| 后台任务和回调 | [bg-job-regressions.test.ts](../tests/bg-job-regressions.test.ts) |
| 分享链接 | [share-link.test.ts](../tests/share-link.test.ts) |
| 外部通知通道 | [external-channels.test.ts](../tests/external-channels.test.ts) |
| 网页命令和异步状态 | [web-command-ui.test.ts](../tests/web-command-ui.test.ts)、[web-state-regressions.test.ts](../tests/web-state-regressions.test.ts) |
| 节点升级与系统服务 | [node-upgrade-service.test.ts](../tests/node-upgrade-service.test.ts) |
| Hub 升级排空 | [hub-upgrade-drain.test.ts](../tests/hub-upgrade-drain.test.ts) |
| Windows 兼容逻辑 | [windows-support.test.ts](../tests/windows-support.test.ts) |

这张表用于定位测试，不代表每种外部环境都已验证。

## 自动测试的边界

- 模型测试使用受控端点，不验证付费供应商的实际服务状态或回答质量。
- OAuth 模拟测试不代替真实账户登录、远程回调和供应商策略验收。
- CI 在 Ubuntu 上运行，不代替 macOS、Windows 原生进程和服务验证。
- CI 运行类型检查、构建和测试，不包含 Docker 镜像构建及部署验收。
- Web 回归测试覆盖状态和组件逻辑，不代替完整浏览器操作。
- 本地工具测试不证明用户安装的第三方 CLI 可用。

测试文件中存在按环境或配置跳过的用例。检查测试摘要中的跳过项，不要仅看退出码。

## 人工验收

先完成[入门指南](getting-started.md)，使用独立测试数据。浏览器入口为 `http://localhost:3001`。

| 操作 | 预期结果 |
| --- | --- |
| 登录，生成配对码，配对节点 | 节点在线，默认助手可见 |
| 配置凭据，为 Bot 选择模型 | Bot 能返回真实模型回复 |
| 请求运行一个只读命令 | 显示工具轨迹、状态和输出预览 |
| 发送截图和文本文件 | 目标 Bot 可以处理附件，网页能预览或下载 |
| 编辑历史用户消息 | 后续历史截断，Bot 从修改后的内容重新回答 |
| 从一条消息分叉 | 新会话保留到该消息的历史，原会话不变 |
| 让主控 Bot 并发调度两个子代理盲评 | 子代理并发独立作答，主控 Bot 汇总分歧 |
| 用 SubagentWorkflow 编排流水线 | 各阶段依次执行，对抗打磨后给出结论 |
| 委派一个子会话任务 | 父会话出现派生通知，子会话完成后回报摘要与交付物 |
| 在 Bot 工具环境发起 `ask` | 网页出现卡片，选择后命令收到答案 |
| 发起 `ask --risk high` 审批卡 | 网页出现风险审批卡，含目标资源与差异预览 |
| 创建 `--dispatch subsession` 的 Webhook 触发器 | 每次事件派生独立子会话，事件可在 `automation-events` 查询 |
| 为通道配置 `tellPolicy: needed` | 日常成功静默，仅确认请求与失败时推送 |
| 启动一个短后台任务 | 获得任务 ID，完成后出现回调 |
| 停止并重连节点 | 在线状态更新，符合条件的离线任务恢复派发 |
| 创建并撤销分享链接 | 未登录窗口可查看，撤销后旧链接失效 |

后台任务、产物和确认卡片的可复制示例见[自动化指南](automation.md)。共享和跨用户访问应使用两个独立账户验收，见[团队协作](team.md)。

## 新增回归测试

先用最小场景复现缺陷，再检查修改能否使测试通过。协议和权限改动需要同时检查合法请求与越权请求。

异步问题应覆盖迟到事件、取消、断连或乱序响应。优先使用现有测试中的临时 Hub、节点和受控模型模式。

提交验证结果时，写明执行命令、结果和未验证环境。不要把模拟成功描述成真实供应商登录成功。
