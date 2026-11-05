# 团队协作与多角色分身协同

botd 支持多用户团队共享、多角色分身协同与全局知识召回。[返回文档目录](README.md)

## 全双工协同心智

传统单 Agent 架构在执行耗时任务时会阻塞会话。
用户在任务执行期间无法提问，也无法调整执行方向。

botd 采用双层全双工架构：

1. **前台 Router 会话**：系统为每个分身维护前台会话。Router 移除编码工具，仅保留路由与工作流编排工具。前台对话永不阻塞。
2. **群聊 `@分身` 热切换**：用户在同一会话输入 `@分身名`（或 `@分身名 /技能名`）时，Hub 动态热切换本轮应答分身的人设、模型与执行节点。
3. **后台 Worker 会话**：Router 调用 `spawn_worker` 或 `delegate_to_bot` 启动后台 Worker。Worker 拥有完整编码工具并在完成后自动向 Router 汇报。
4. **协同插话**：Worker 执行期间，用户可随时向 Router 提问，也可调用 `steer_worker` 调整方向或调用 `stop_worker` 中止任务。

```mermaid
flowchart TD
    User["用户"] <-->|"实时双向交互 (永不阻塞)"| R["前台 Router 会话<br/>(主控分身: architect)"]
    
    subgraph Background["后台并行 Worker 集群"]
        W1["后台 Worker 1<br/>(本分身代码编写)"]
        W2["后台 Worker 2<br/>(跨分身委派: tester)"]
    end

    R -->|"spawn_worker()"| W1
    R -->|"delegate_to_bot(target: tester)"| W2
    R -.->|"steer_worker(插话纠偏)"| W1
    
    W1 -->|"afterRun 自动摘要汇报"| R
    W2 -->|"afterRun 自动摘要汇报"| R

    W1 -.->|"写入执行索引"| RID[("RecallIndexDoc<br/>全局召回链索引")]
    W2 -.->|"写入关联图谱"| RID
    R <-->|"recall({ id }) 多跳追溯"| RID
```

## 角色分身（Bot Personas）机制

每个角色分身代表一个特定职能的数字员工。

### 分身独立配置与持久状态

每个分身具备完全独立的状态上下文与边界：

- `SYSTEM.md` 与 `MEMORY.md`：定义分身角色行为准则与长期业务记忆。
- **专属模型配置**：每个分身可独立配置提供商、模型规格与思考档位。
- **默认节点与工作区**：每个分身绑定默认 Node 节点与 `workspaceDir`。会话也可单独绑定目录覆盖默认值，自动归入对应项目 Space。
- **工具范围与热同步**：支持配置 `toolScope`（`all`、`readonly`、`custom`）与 `inheritSkills` 技能继承。修改配置后存量会话自动热同步生效。

### 团队共享与权限

Hub 内置多用户协作支持：

1. **用户角色**：
   - `admin`：系统管理员。管理用户账户、修改全局技能与扩展包，以及触发主动 Watchdog 巡检。
   - `member`：团队普通成员。创建私有会话并使用自有或团队授权的 Bot。
2. **节点归属**：
   - 节点所有者在本地执行 `botd nodes pair` 创建 6 位配对码。
   - 目标主机执行 `botd join` 连接 Hub。节点归属配对者私有。
3. **Bot 团队共享**：
   - 节点所有者配置 Bot 的 `visibility` 为 `team`。
   - 团队所有成员均可使用该 Bot 开启会话。
   - 共享不转移底层宿主节点的管理控制权。

## 跨分身委派（delegate_to_bot）

当任务超出当前分身的专业范围时，分身可跨角色委派任务。

### 委派参数与接口

Router 通过 `delegate_to_bot` 工具发起委派：

```typescript
export interface DelegateToBotArgs {
  targetBotId: string;              // 目标角色分身 ID (例如 "tester")
  title: string;                    // 任务标题
  task: string;                     // 完整任务说明
  threadKey?: string;               // 关联的渠道线程标识
  worktree?: boolean;               // 是否创建独立 Git Worktree
  isolation?: 'off' | 'worktree';   // 工作区隔离模式
}
```

### 委派生命周期

委派执行流程如下：

1. **参数解析**：Hub 检索目标分身的人设配置，包含其专属指令、模型、节点与工作目录。
2. **创建 Worker**：Hub 创建全新的独立 Worker 会话。系统挂载目标分身的指令与模型。
3. **登记状态**：Hub 在主控会话的 `WorkerRegistryDoc` 登记该 Worker，状态标记为 `running`。
4. **异步启动**：Hub 提交任务指令到 Worker 会话。工具调用向 Router 立即返回 Worker ID。
5. **自动汇报**：Worker 执行结束后触发 `afterRun` 钩子。系统向主控 Router 会话投递完成通知。投递包含确定性 `requestId`，杜绝重复汇报。

## 全局召回链（Chain of Recall）

系统使用会话级持久文档 `RecallIndexDoc` 统一维护全局知识索引。
所有分身与 Worker 共享此召回图谱。

### 召回节点结构（RecallNode）

```typescript
export interface RecallNode {
  id: string;                      // 节点唯一标识 (如 workerId 或 spillId)
  kind: RecallKind;                // 节点类型: worker | trigger | entry | artifact | thread
  title: string;                   // 节点标题
  summary: string;                 // 1 到 3 行紧凑摘要 (内联展示层)
  contentPreview: string;          // 正文内容预览 (初始 240 字符，完成汇报最高 480 字符)
  conversationId?: string;         // 保存完整 Transcript 的会话 ID
  relatedIds: string[];            // 关联的下一跳节点 ID 列表
  data?: Record<string, unknown>;  // 附加元数据 (如工作树路径与分支名)
  createdAt: number;               // 创建时间戳
}
```

### 多跳关联追溯

超长文本载荷或历史会话不会直接全部装载到模型上下文。
系统采用多跳追溯策略控制上下文消耗：

1. **内联索引**：Router 会话平时仅保留最近任务的单行摘要。
2. **单跳召回**：Agent 调用 `recall({ id: "w-1-102" })`。系统返回该节点的正文预览与所有 `relatedIds` 紧凑摘要。
3. **多跳追溯**：Agent 根据 `relatedIds` 中的关联 ID，继续调用 `recall({ id: "spill_xxx" })`。Agent 顺藤摸瓜定位跨分身、跨线程的深层关联细节。

```text
# w-1-102 — 自动化集成测试
kind: worker  created: 2026-11-04T12:00:00.000Z
summary: 完成用户注册模块测试，发现 1 处并发竞争漏洞
content: Running jest test suites... 14 passed, 1 failed in auth.test.ts
related (next hops):
- spill_9f2a (entry): 详细错误堆栈与复现日志摘要
- art_881b (artifact): 导出的 HTML 覆盖率报告
```

## Router 常用协同工具

Router 会话内置以下协同管理工具：

| 工具名 | 参数 | 功能说明 |
| :--- | :--- | :--- |
| `spawn_worker` | `title`, `task`, `subagent?`, `resume?`, `forkContext?`, `threadKey?`, `cwd?`, `worktree?`, `isolation?` | 启动当前分身名下的后台 Worker；`subagent` 用麾下子代理分身身份运行（共享本工作区），`resume` 续跑旧 Worker（保留会话与 worktree），默认不 fork 主会话上下文。 |
| `delegate_to_bot` | `targetBotId`, `title`, `task`, `threadKey?`, `worktree?`, `isolation?` | 跨角色委派后台任务给其他分身。 |
| `steer_worker` | `workerId`, `message`, `mode?` | 向执行中的 Worker 发送插话指令；对已结束/已停止的 Worker 会唤醒续跑（保留完整上下文）。 |
| `stop_worker` | `workerId` | 强制中止正在执行的 Worker。 |
| `recall` | `id` | 按 ID 查询召回链节点与下一跳关联。 |
| `ask_human` | `prompt`, `options?` | 向人类发起决策询问并挂起等待回复。 |
| `SubagentWorkflow` | `script`, `args?`, `name?` | 执行带检查点缓存的多步骤持久工作流脚本。 |
