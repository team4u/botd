# 测试指南

[文档目录](README.md)

本篇说明如何运行 botd 的自动检查、tests/ 目录覆盖了什么、何时新增回归测试，以及哪些场景仍需人工验收。

## 运行检查

在仓库根目录依次执行：

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm build`
4. `pnpm test`

四条命令与 [CI](../.github/workflows/ci.yml) 的执行顺序一致。各命令行为：

| 命令 | 行为 |
| --- | --- |
| `pnpm typecheck` | 先执行各包的 `typecheck`，再用 `tsc -p tsconfig.tests.json` 检查测试代码 |
| `pnpm build` | 执行 `pnpm -r build`，构建全部子包 |
| `pnpm test` | 执行 `tsx --test tests/*.test.ts`，运行全部测试 |

`pnpm test` 依赖 Node.js 内置测试运行器。仓库要求 Node.js `>=24.12.0`。

调试单个功能时，运行单个文件：

```bash
pnpm exec tsx --test tests/hub.test.ts
pnpm exec tsx --test tests/provider-auth.test.ts
```

`tests/*.test.ts` 之外的文件不会被 `pnpm test` 收集。新文件必须以 `.test.ts` 结尾。

### CI 检查项

CI 定义在 `.github/workflows/ci.yml`。`push` 和 `pull_request` 都会触发。单个任务约束：

- 运行环境 `ubuntu-latest`，超时 15 分钟。
- pnpm 版本 `10.34.9`，Node.js 版本 `24.12.0`，启用 pnpm 缓存。
- 依次执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm build`、`pnpm test`。

CI 不构建 Docker 镜像，不执行部署。

### 测试隔离

测试自建环境，不触碰本机数据：

- Hub 通过 `startHub({ port: 0, ... })` 启动，由系统分配随机端口，不占用 3000/3001/3002。
- 数据库写入 `mkdtemp` 创建的临时目录，测试结束时用 `t.after` 清理。
- 节点侧依赖常用模拟：或用 `hub.connections.getNodeRpc` 注入 mock RPC，或用 birpc 连接真实 WebSocket。
- 模型与 OAuth 均使用受控端点。

不要把本机生产数据库或真实凭据放进测试配置。

## 测试清单

tests/ 目录下的全部 `*.test.ts` 都会被 `pnpm test` 运行。按验证对象归类的主要文件如下。

| 类别 | 文件 | 验证内容 |
| --- | --- | --- |
| Hub 回归 | `hub.test.ts`、`core-refactoring-regressions.test.ts`、`session-regressions.test.ts`、`persistence-parallel.test.ts`、`review-fixes-hub.test.ts`、`review-fixes-hub2.test.ts`、`review-fixes-index-msg.test.ts`、`phase2-3-hub-mesh.test.ts`、`highlights.test.ts` | HTTP 路由、认证、会话 CRUD、跨用户权限、消息持久化、多 Bot 并发调度、离线任务与多人会话 |
| 节点回归 | `node.test.ts`、`node-control-regressions.test.ts`、`sdk.test.ts`、`provider-auth.test.ts`、`builtin-skill.test.ts`、`phase0-runtime-trace.test.ts` | 节点注册与守护进程、CLI 命令、Pi 会话与技能加载、模型供应商登录凭据的存储与刷新 |
| Web 回归 | `web-command-ui.test.ts`、`web-state-regressions.test.ts`、`web-input-regressions.test.ts`、`web-form-regressions.test.ts`、`web-triggers-automation.test.ts`、`web-node-upgrade.test.ts`、`review-fixes-web.test.ts`、`phase2-ask-preview.test.ts` | 网页状态推导、命令 UI、输入与表单交互逻辑、自动化事件查询、节点升级界面 |
| 契约 | `workflow-dsl.test.ts` | 群聊编排原语：`ChainBudget` 消耗、`extractMentions`、`parseSlashCommand`、群上下文提示词构建 |
| 升级 | `node-upgrade-service.test.ts`、`hub-upgrade-drain.test.ts` | 节点侧升级检测、灰度回滚与服务管理、节点版本上报与升级 RPC 转发、Hub 升级排空流程 |
| Windows | `windows-support.test.ts` | Windows 命名管道路径、`botd` 包装脚本、shell 解析的跨平台逻辑 |
| 生成式 UI | `generative-ui.test.ts`、`node-ask-approval.test.ts` | `validateUiSpec` 对全部 17 种组件的校验、审批卡构建 |
| 渠道 | `external-channels.test.ts`、`notification-outbox.test.ts`、`event-inbox.test.ts` | 外部消息通道桥接、`tellPolicy` 静默策略、Webhook 事件提取与去重 |
| 委派子会话 | `sub-session-delegation.test.ts`、`delegation-artifact-loop.test.ts`、`subagent-run-control.test.ts`、`subagent-primary-enforcement.test.ts` | 子会话委派与父会话回报、产物零拷贝回传、子代理运行记录与主 Bot 校验 |
| 产物 | `artifact-streaming.test.ts`、`artifact-regressions.test.ts` | 产物二进制流上传下载、限额拒绝与清理 |
| 后台任务 | `bg-job-regressions.test.ts` | 后台任务 PID 校验、进程组终止、回调 |
| 取消语义 | `hub-cancel-persist.test.ts`、`turn-cancel-preserve.test.ts` | 会话取消后部分输出仍持久化、取消的回合不抛错 |
| 分享 | `share-link.test.ts` | 分享链接全生命周期、授权与 CLI 命令 |

这张表用于定位测试，不代表每种外部环境都已验证。

### 生成式 UI 契约细节

`generative-ui.test.ts` 直接引用 `packages/protocol` 导出的常量：`BOTD_UI_COMPONENT_TYPES`、`BOTD_UI_CATALOG_VERSION`、`BOTD_UI_SCHEMA_DOC`、`MAX_UI_SPEC_BYTES`、`MAX_UI_TREE_DEPTH`。前端目录与协议校验由同一份契约约束。详见[生成式 UI](generative-ui.md)。

## 新增回归测试

### 何时该加

- 修复缺陷后，先用最小场景复现缺陷，再确认修改使测试通过。
- 协议和权限改动需要同时覆盖合法请求与越权请求。
- 异步问题应覆盖迟到事件、取消、断连或乱序响应。
- 回归修复批次可以合并为 `review-fixes-*.test.ts` 或 `core-refactoring-regressions.test.ts` 这类专项文件。

### 命名

- 所有测试文件必须匹配 `tests/*.test.ts`。
- 回归套件用 `*-regressions.test.ts`，如 `session-regressions.test.ts`、`web-form-regressions.test.ts`。
- 功能域测试按主题命名，如 `share-link.test.ts`、`workflow-dsl.test.ts`。

### 断言与结构

- 从 `node:test` 导入 `test`，从 `node:assert/strict` 导入 `assert`。
- 用 `assert.equal`、`assert.deepEqual`、`assert.ok`、`assert.match` 做断言，失败信息带上路由或上下文。
- 子用例用 `t.test` 嵌套，清理逻辑放 `t.after`。
- 轮询异步状态时复用 `waitFor` 模式：读取状态、判定、短间隔重试、超时报错。
- 复用现有 fixture 模式：临时目录加 `startHub({ port: 0 })`，节点用 mock RPC 或 birpc 模拟。

## 自动测试的边界

- 模型测试使用受控端点，不验证付费供应商的实际服务状态或回答质量。
- OAuth 模拟测试不代替真实账户登录、远程回调和供应商策略验收。
- CI 在 Ubuntu 上运行，不代替 macOS、Windows 原生进程和服务验证。`windows-support.test.ts` 只验证逻辑分支。
- CI 运行类型检查、构建和测试，不包含 Docker 镜像构建及部署验收。
- Web 回归测试覆盖状态和组件逻辑，不代替完整浏览器操作。
- 本地工具测试不证明用户安装的第三方 CLI 可用。

测试文件中存在按环境或配置跳过的用例。检查测试摘要中的跳过项，不要只看退出码。

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

## 提交验证结果

提交时写明执行命令、结果和未验证环境。不要把模拟成功描述成真实供应商登录成功。
