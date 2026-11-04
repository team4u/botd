# 测试指南

[文档目录](README.md)

本文介绍 botd 的自动化测试体系、套件结构与核心回归测试用例。

## 测试套件结构

botd 使用 Node 24 原生测试运行器搭配 `tsx`。

```
tests/
├── remote-env-worktree.test.ts      # 远程环境、Worktree 隔离与离线恢复
├── durable-superagent-core.test.ts  # 多角色调度、崩溃恢复与召回链
├── workflow-event-watchdog.test.ts  # 工作流编排、事件过滤与 Watchdog 自愈
├── hub.test.ts                      # Hub 路由、认证与调度测试
├── node.test.ts                     # 节点注册与 CLI 命令测试
└── ...                              # 其他专项回归套件
```

## 测试命令

开发者在仓库根目录运行测试命令：

```bash
# 运行全仓类型检查
pnpm typecheck

# 运行全量测试套件
pnpm test

# 运行单个测试文件
pnpm exec tsx --test tests/remote-env-worktree.test.ts
```

### 命令行为说明

- `pnpm typecheck`：先检查各个子包的类型。命令随后检查 `tests/` 目录的类型定义。
- `pnpm test`：运行 `tests/*.test.ts` 匹配的全部测试文件。

## 测试隔离原则

测试套件具备完整的环境隔离：

1. **随机端口分配**：Hub 在测试中使用端口 `0` 启动。操作系统分配空闲端口，测试不占用 3000、3001 或 3002。
2. **临时数据目录**：测试使用临时目录保存数据库与产物。测试结束自动清理目录。
3. **真实凭据隔离**：测试使用受控 Mock 对象。测试不依赖外部付费 API 密钥。

## 核心回归测试用例（TC-01 至 TC-10）

系统通过 10 个核心回归用例验证关键能力：

### TC-01：远程环境与编码工具

- **对应文件**：`tests/remote-env-worktree.test.ts`
- **前置条件与输入**：启动 `createNodeEnvRpcServer` 与 `RemoteExecutionEnv`。环境挂载到 `Harness` 的 `CodingTools`。
- **目标路径**：工具依次调用 `write`、`read`、`edit` 与 `bash`。测试包含文件读写、二进制范围读取与流式命令输出。
- **预期结果**：文件读写成功。行号精确替换成功。`bash` 实时接收标准输出流，并且返回正确的退出码。

### TC-02：Git Worktree 并发隔离

- **对应文件**：`tests/remote-env-worktree.test.ts`
- **前置条件与输入**：初始化临时 Git 仓库。两个 Worker 同时调用 `envAcquireWorktree`。两个 Worker 并发修改同名文件 `index.ts`。
- **目标路径**：两个 Worker 在各自的工作区独立写入不同内容。Worker 随后调用 `envReleaseWorktree`。
- **预期结果**：两次写入互不覆盖，全程无锁等待。工作区释放后，系统删除临时目录与 Worktree 记录。

### TC-03：BYOM 节点离线等待与恢复

- **对应文件**：`tests/remote-env-worktree.test.ts`
- **前置条件与输入**：目标节点初始处于离线状态。Worker 发起 `readTextFile` 工具调用。测试在 100 毫秒后模拟节点上线。
- **目标路径**：`RemoteExecutionEnv` 触发 `waitForNodeOnline` 挂起调用。节点上线后，系统继续调度调用。
- **预期结果**：工具调用不返回错误。节点重新连接后，工具成功返回文件内容。

### TC-04：多角色分身隔离与全双工调度

- **对应文件**：`tests/durable-superagent-core.test.ts`
- **前置条件与输入**：创建两个不同的角色分身。向首个角色发送耗时开发任务，紧接着发送第二条消息。
- **目标路径**：前台 Router 调用 `spawn_worker`。Router 立即返回已启动状态并响应第二条消息。后台 Worker 并发运行任务。
- **预期结果**：前台响应在毫秒级完成，并且不阻塞会话。后台 Worker 运行完成后，系统向主会话投递摘要，并更新 Worker 注册表文档。

### TC-05：跨角色委派与召回链

- **对应文件**：`tests/durable-superagent-core.test.ts`
- **前置条件与输入**：主会话调用 `delegate_to_bot` 委派任务给另一分身。调用方中途使用 `steer_worker` 插话。任务完成后调用方使用 `recall` 查询。
- **目标路径**：目标 Worker 接收插话指令并调整输出。Worker 把记录写入召回索引文档。
- **预期结果**：`recall` 成功返回任务摘要、输出内容与关联标识列表。

### TC-06：Harness 崩溃恢复

- **对应文件**：`tests/durable-superagent-core.test.ts`
- **前置条件与输入**：Worker 运行中途关闭当前 `Harness` 实例以模拟崩溃。测试在同一数据底座上重新打开 `Harness` 并调用 `resume()`。
- **目标路径**：调度器扫描未完成任务。调度器从最后检查点继续运行任务。
- **预期结果**：中断的 Worker 自动运行完毕，并向主会话报告。请求标识幂等机制阻止重复报告。

### TC-07：工作流编排与断点续跑

- **对应文件**：`tests/workflow-event-watchdog.test.ts`
- **前置条件与输入**：运行包含流水线、并行分支与检查网关的工作流脚本。在阶段一完成后模拟系统中断并重新运行。
- **目标路径**：`SubagentWorkflow` 通过缓存读取已经完成的步骤，并且继续运行阶段二。
- **预期结果**：阶段一直接命中缓存，模型调用次数不增加。阶段二正常运行并通过网关检查。

### TC-08：事件过滤与直通路由

- **对应文件**：`tests/workflow-event-watchdog.test.ts`
- **前置条件与输入**：系统发送外部噪音事件、特定主题首个事件以及后续 3 条同主题事件。
- **目标路径**：快速过滤函数拦截噪音事件。后续事件通过主题订阅文档直接路由至订阅 Worker。
- **预期结果**：噪音事件消耗 0 次模型调用。同主题后续事件直达 Worker，Router 调用次数为 0。

### TC-09：Watchdog 巡检自愈

- **对应文件**：`tests/workflow-event-watchdog.test.ts`
- **前置条件与输入**：构造一个超出卡死时长无进展的卡顿 Worker 会话。运行 `runWatchdogPass` 巡检函数。
- **目标路径**：`Watchdog` 检测到超时。系统自动发送纠偏指令或终止告警。
- **预期结果**：Worker 接收到纠偏指令，或者系统终止失控任务。健康诊断函数输出准确的干预原因。

### TC-10：前端组件与类型构建

- **对应文件**：`apps/web`
- **前置条件与输入**：针对包含 Worker 状态栏与检查抽屉的前端项目，运行类型检查与构建命令。
- **目标路径**：TypeScript 编译器与 Vite 构建器检查前端代码。
- **预期结果**：代码无类型错误，生产静态资源构建成功。
