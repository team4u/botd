# `botd` 车间开发设计文档：核心体验闭环与内网团队算力网格

## 1. 背景与开发原则 (Context & Principles)

`botd` 是基于 Node-hosted Pi Runtime 的分布式 AI BOT 工作台。当前服务于**开发者本人及内网技术团队**。
目前代码库核心骨架（`packages/protocol`、`apps/hub`、`apps/node`、`apps/web`）已具备多节点 RPC、群聊 Lead/圆桌盲评、子会话委派 `delegation`、后台任务 `bg`、产物 `artifact`、人机确认 `ask`、触发器 `triggers` 等完备基础。

本车间文档旨在指导 AI 编程助手按优先级完成两大类工作：
1. **存量核心体验立刻闭环（高 ROI 修复）**：打通子会话委派断层、修复多步工具调用文本闪退与缓存 Token 统计、默认开启常驻单聊自动压缩、补齐 Tool Trace 输出预览与 `botd bg` 内联状态条。
2. **内网生产力进阶（底座与协同强化）**：跨节点产物自动落盘（`workspace/inbox/`）、`botd ask` 富预览与全局收件箱、节点离线信箱暂存（Store-and-Forward）、以及内网团队共享 BOT 与多人协同会话。

### 明确不做的事项 (Non-Goals)
> **AI 开发约束：在执行本文档开发任务时，严禁引入以下改动：**
- ❌ **不做** OS 级安全沙箱、受限容器或工具白名单（Restricted Mode）。
- ❌ **不做** Runtime 层面的高危 Bash 命令正则拦截与强制防呆（Guardrails）。
- ❌ **不做** `SKILL.md` 与 `NODE_ENV.md` 的环境配置解耦及本机 CLI 自动探测标签。
- ❌ **不做** 公网多租户安全加固，也不引入第三方复杂的 Subagent 独立 UI 框架。

---

## 2. 模块一：Runtime 与对话流核心体验修复 (`apps/node` & `apps/web`)

### 2.1 修复多步 Tool Call 时流式文本在回合结束瞬间丢失
- **涉及文件**：`apps/node/src/runtime.ts`（约第 416 行、530-532 行）
- **现状问题**：流式阶段会将本轮所有子步骤的 `text_delta` 推送给前端拼接展示；但回合结束落库时，代码使用了：
  ```ts
  const lastAssistant = session.messages.slice(messageCountBefore).filter(message => message.role === 'assistant').at(-1);
  ```
  仅提取了**最后一条** `assistant` 消息的文本。当 Bot 先输出大段分析、再调用 `bash` 工具、最后仅输出简短结论（甚至无文本）时，前端流式展示的分析文本会在回合完成瞬间消失。
- **修改方案**：
  - 遍历 `session.messages.slice(messageCountBefore).filter(m => m.role === 'assistant')` 的**所有**消息。
  - 提取每条消息中 `part.type === 'text'` 的非空文本块，按步骤使用 `\n\n` 拼接合并为最终的 `replyText`。

### 2.2 补齐 Prompt Cache 命中时的 Token 悬停明细
- **涉及文件**：`packages/protocol/src/index.ts`、`apps/node/src/runtime.ts`（约第 538-541 行）、`apps/web/src/components/MessageItem.tsx`
- **现状问题**：`runtime.ts` 结算时仅读取了 `rawUsage?.input` 和 `rawUsage?.output`。在开启 Prompt Caching 时，`input` 仅包含未命中的增量 Token，导致气泡底部显示的总 Token 数（含缓存）与悬停显示的 `输入 / 输出` 明细完全对不上。
- **修改方案**：
  1. 在 `packages/protocol` 的消息 Usage / Token 统计结构中增加可选字段：`cacheReadTokens?: number` 与 `cacheWriteTokens?: number`。
  2. 在 `runtime.ts` 中汇总本轮所有步骤的 `rawUsage?.cacheRead` 与 `rawUsage?.cacheWrite` 并随回合结果上报。
  3. 在 `MessageItem.tsx` 悬停 Tooltip 中，当存在缓存命中时展示完整明细：`输入 X · 缓存读取 Y · 缓存写入 Z · 输出 W`。

### 2.3 常驻单聊模式下默认开启「自动上下文压缩 (Auto-Compaction)」
- **涉及文件**：`apps/node/src/runtime.ts`（约第 328 行）、`apps/web/src/components/ChatView.tsx`
- **现状问题**：`compaction: { enabled: process.env.BOTD_AUTO_COMPACT === '1' }` 默认关闭，而在「通讯录常驻单聊」模式下，长对话极易撑爆上下文导致报错卡死。
- **修改方案**：
  1. 将 `runtime.ts:328` 改为默认开启：`compaction: { enabled: process.env.BOTD_AUTO_COMPACT !== '0' }`（仅当显式设置 `BOTD_AUTO_COMPACT=0` 时关闭）。
  2. 在 Web 端 `ChatView.tsx` 显示上下文水位线（如 `xx% ctx`）处，当水位 `>= 75%` 时高亮为橙色并提供一键发送 `/compact` 的快捷按钮。

### 2.4 工具轨迹 (Tool Trace) 支持查看执行输出与报错详情
- **涉及文件**：`packages/protocol/src/index.ts`、`apps/node/src/runtime.ts`（约第 423-460 行）、`apps/web/src/components/MessageItem.tsx`（约第 148 行）
- **现状问题**：`ToolCallRecord` 仅保存 `{ name, summary, status, durationMs }`，工具执行失败（红色感叹号）或需要核对 `bash` 输出时，用户无法在前端查看报错详情。
- **修改方案**：
  1. 在 `ToolCallRecord` 接口中新增字段：`outputPreview?: string` 与 `isError?: boolean`。
  2. 在 `runtime.ts` 的 `tool_execution_end` 事件处理中，提取工具返回结果文本：
     - 若为正常输出，截取尾部最多 600 字符；
     - 若为错误输出（`isError`），优先保留完整报错关键信息（最多 1200 字符）。
  3. 在 `MessageItem.tsx` 渲染 Tool Trace 列表时，支持点击单个工具条目展开 `<pre>` 代码框查看 `outputPreview`（若 `status === 'error'` 则默认高亮或支持一键展开）。

### 2.5 `botd bg` 后台任务的聊天流内联状态感知
- **涉及文件**：`apps/web/src/components/ChatView.tsx`、`apps/web/src/components/BgJobsDrawer.tsx`、`apps/node/src/bg-jobs.ts`
- **现状问题**：已有完善的 `BgJobManager` 和右上角 `BgJobsDrawer.tsx`，但在聊天流内缺乏实时感知的视觉锚点。
- **修改方案**：
  1. 在 `ChatView.tsx` 的输入框上方（或会话顶部栏下沿），过滤出当前会话（或当前关联 Bot）下 `status === 'running'` 的 `BgJobRecord` 列表。
  2. 当存在运行中任务时，渲染一条紧凑的实时状态条：
     `⚙️ N 个后台任务运行中 · <command/name> (已运行 18s) [查看日志 / 管理]`
  3. 点击该状态条直接打开 `BgJobsDrawer.tsx` 并自动定位展开对应任务的实时输出日志。

---

## 3. 模块二：打通原生「子会话委派 (Sub-session Delegation)」与跨节点产物交接

### 3.1 修复子会话委派 (`delegation.ts`) 的 3 处断层
- **涉及文件**：`apps/hub/src/delegation.ts`、`apps/web/src/components/Sidebar.tsx`、`apps/web/src/components/ChatView.tsx`

#### 断层 1：子会话完成或失败后自动唤醒父会话 Lead Bot
- **现状**（`apps/hub/src/delegation.ts:127-155`）：子会话变为 `idle` 时仅向父会话插入 `role: 'callback'` 消息并广播 SSE，未调用 `router.handleWakeup`；子会话 `failed` 时（第 153 行）直接 `cleanup()` 无任何通知。
- **修改方案**：
  1. 当子会话状态变为 `idle` 且成功向父会话写入 `role: 'callback'` 消息后，立即调用 `router.handleWakeup(parentSessionId, ...)`（或触发父会话的主 Bot / 委派发起方 Bot 进行汇总回合），使父会话主 Bot 自动读取子任务结论并推进下一步。
  2. 当子会话状态变为 `failed` 时，向父会话插入一条包含失败原因的 `role: 'callback'` 消息并广播 SSE，同样触发父会话唤醒处理，随后再执行 `cleanup()`。

#### 断层 2：防止子会话“篡位”覆盖侧边栏的 Bot 主单聊窗口
- **现状**（`apps/web/src/components/Sidebar.tsx:62-78`）：`pickCurrentDirectSession` 只过滤了 `s.mode !== 'direct' || s.archived`，未排除带有 `parentSessionId` 的子会话。
- **修改方案**：
  - 在 `pickCurrentDirectSession` 过滤条件中显式加上 `if (s.parentSessionId) continue;`（即只从顶层主单聊会话中挑选当前活跃会话）。
  - 子会话归类展示在父会话内部的子任务面板或历史折叠区，绝不污染左侧通讯录的 Bot 主入口。

#### 断层 3：在父会话 UI 中挂接 `listSubSessions` 状态面板
- **现状**：后端 `GET /api/sessions/:id/subsessions`（`delegation.ts:19`）与前端 `api.listSubSessions`（`apps/web/src/api.ts:430`）已就绪，但前端组件未调用。
- **修改方案**：
  - 在 `ChatView.tsx` 中，当检测到当前父会话存在关联子会话（或收到子会话创建/状态更新的 SSE 事件）时，调用 `api.listSubSessions(session.id)`。
  - 在父会话头部（或对应 callback 消息卡片上）展示紧凑的「子任务委派列表（Sub-sessions）」胶囊条，显示每个子会话的目标 Bot、运行状态（`running` / `idle` / `failed`），支持点击一键跳转到子会话查看完整推理过程（配合已有的 `← 返回父会话` 横幅形成双向闭环）。

### 3.2 跨节点委派与 `@Bot` 时的产物自动落盘 (`workspace/inbox/`)
- **涉及文件**：`apps/hub/src/group-router.ts`、`apps/hub/src/delegation.ts`、`apps/node/src/runtime.ts`
- **目标**：当 Node A 的 Bot 通过 `botd artifact` 生成文件，并在群聊中 `@NodeB-Bot` 或通过 `botd sessions delegate` 委派子任务给 Node B 的 Bot 时，无需手动下载 HTTP 链接，自动将产物同步至目标 Bot 的本地 `./inbox/` 目录。
- **修改方案**：
  1. **Hub 派发载荷扩展**：在群聊跨节点调度或子会话委派派发 Prompt 时，Hub 收集上游触发消息关联的 `artifacts`（或委派时指定的产物），在 RPC 载荷中附带 `incomingArtifacts: Array<{ id, filename, url, fromBotName }>`。
  2. **Node 端前置预下载**：`apps/node/src/runtime.ts` 在执行 `session.prompt()` 前，若检测到 `incomingArtifacts` 非空，自动将其下载至 `~/.botd/bots/<botId>/workspace/inbox/<filename>`（重名时自动加时间戳前缀）。
  3. **Prompt 自动注入路径说明**：在传入 Pi Runtime 的文本末尾追加系统提示：
     `[系统提示：来自上游任务的产物文件已自动同步至本机工作区 ./inbox/<filename>，可直接读取处理]`。

---

## 4. 模块三：`botd ask` 富文本/Diff 预览与全局待办收件箱

### 4.1 `botd ask` 支持代码 Diff / 文件预览与持久化挂起
- **涉及文件**：`packages/protocol/src/index.ts`、`apps/node/src/cli.ts`、`apps/hub/src/db.ts`、`apps/web/src/components/AskCard.tsx`
- **修改方案**：
  1. **CLI 扩展**：为 `botd ask` 增加 `--file <path>`、`--diff` 以及管道 `stdin` 读取支持（如 `git diff | botd ask "是否提交？" --diff --options "提交,取消"`），限制预览载荷最大 256KB；支持 `--timeout 0`（无限期挂起直到人工确认）。
  2. **Hub SQLite 持久化**：将挂起中的 `ask` 请求落库存储（包含 `previewType: 'diff' | 'markdown' | 'text'` 与 `previewContent`），确保 Hub 重启或页面刷新后审批卡片依然有效且可点击响应。
  3. **Web 卡片渲染**：在确认卡片中支持折叠/展开查看 `previewContent`（针对 `diff` 类型提供红绿增删行着色展示）。

### 4.2 侧边栏全局「待我确认 (Pending Approvals)」收件箱
- **涉及文件**：`apps/web/src/components/Sidebar.tsx`、`apps/hub/src/index.ts`
- **修改方案**：
  - 新增 `GET /api/approvals/pending` 接口，返回当前用户所有会话中处于 `pending` 状态的 `botd ask` 请求列表。
  - 在 `Sidebar.tsx` 顶部显著位置展示 `🔔 待确认 (N)` 入口，点击可直接在列表抽屉中预览 Diff/问题并点击选项完成审批，或一键跳转至原会话窗口。

---

## 5. 模块四：断线容错底座与内网团队共享网格

### 5.1 离线节点信箱暂存与上线补发 (Store-and-Forward)
- **涉及文件**：`apps/hub/src/db.ts`、`apps/hub/src/ws-hub.ts`、`apps/hub/src/group-router.ts`
- **目标**：应对内网开发机（如 MacBook）频繁合盖休眠导致的 Node 短暂离线，以及 Hub 重启。
- **修改方案**：
  1. 在 Hub SQLite 中新增 `outbound_task_queue` 表（字段：`id`, `nodeId`, `botId`, `sessionId`, `taskType`, `payloadJson`, `status`, `createdAt`, `expiresAt`）。
  2. 当向目标 `nodeId` 派发单聊、群聊 `@mention`、子会话委派或定时触发器（`triggers`）时，若该 Node 当前离线，不直接报错丢弃，而是写入 `outbound_task_queue`（状态设为 `queued_offline`，默认 TTL 72 小时），并在会话流中提示 `⏳ 目标节点当前离线，任务已进入信箱暂存，将在节点上线后自动执行`。
  3. 当 Node 重新连接 WebSocket 并完成握手后，Hub 自动按时间顺序查询并下发该节点所有未过期的 `queued_offline` 任务。

### 5.2 内网团队共享 BOT 与多人协同会话 (Team Agent Mesh)
- **涉及文件**：`apps/hub/src/db.ts`、`apps/hub/src/auth.ts`、`apps/hub/src/index.ts`、`apps/web/src/components/Sidebar.tsx`
- **目标**：打破目前「同 Hub 用户间完全隔离（非本人一律 403）」的限制，让内网配好特殊环境（如测试服、高配编译机、Herdr 节点）的 Bot 可以被团队共用。
- **修改方案**：
  1. **数据模型扩展**：
     - 在 `bots` 表（及 `nodes` 表）新增 `visibility TEXT NOT NULL DEFAULT 'private'`（可选值：`'private' | 'team'`）。
     - 新增 `session_participants (session_id, user_id, role, joined_at)` 表，支持多人参与同一会话。
  2. **权限规则放宽**：
     - `GET /api/bots` 返回 `owner_id = currentUserId OR visibility = 'team'` 的所有 Bot（附带 `ownerName` 与 `isTeamShared` 标识）。
     - 团队任何成员均可与 `visibility = 'team'` 的 Bot 发起单聊、将其拉入群聊、委派子会话、审批其发起的 `botd ask`；但修改/删除该 Bot 的配置仍仅限 `owner_id` 本人。
  3. **多人协同群聊**：
     - 支持会话创建者将内网其他团队成员拉入同一个群聊会话，多人发言在传给 Pi Runtime 时标注发言人前缀（如 `[User: 张三]: ...`），SSE 广播同步给会话内的所有在线成员。

---

## 6. 分阶段开发实施计划 (Execution Roadmap for AI)

> **给 AI 编程助手的执行指令**：请严格按以下 4 个阶段（Phase 0 → Phase 3）推进。每个阶段修改完成后，必须执行 `pnpm typecheck` 与 `pnpm test` 验证通过后再进入下一阶段。

### Phase 0：Runtime 与存量 UI 痛点速赢修复（最高 ROI，无 Schema 变更）
- [ ] **Task 0.1**：修改 `apps/node/src/runtime.ts:530-532`，合并本轮 `slice(messageCountBefore)` 内所有非空 `assistant` 文本块（以 `\n\n` 连接），修复多步工具调用后流式文本丢失问题。
- [ ] **Task 0.2**：扩展 `packages/protocol` 与 `runtime.ts:538-541`，采集 `cacheRead` 与 `cacheWrite` Token 并在 `MessageItem.tsx` 悬停提示中展示完整缓存明细。
- [ ] **Task 0.3**：修改 `runtime.ts:328` 默认开启 `compaction: { enabled: process.env.BOTD_AUTO_COMPACT !== '0' }`，并在 `ChatView.tsx` 上下文高水位时提供快捷 `/compact` 按钮。
- [ ] **Task 0.4**：在 `ToolCallRecord` 中增加 `outputPreview` 字段，在 `runtime.ts` 的 `tool_execution_end` 截取尾部/报错摘要，并在 `MessageItem.tsx` 支持点击展开查看。
- [ ] **Task 0.5**：在 `ChatView.tsx` 增加运行中 `BgJobRecord` 的内联状态条，点击直接联动打开 `BgJobsDrawer.tsx`。

### Phase 1：子会话委派 (`delegation.ts`) 全链路闭环与跨节点产物交接
- [ ] **Task 1.1**：修改 `apps/hub/src/delegation.ts:127-155`，子会话 `idle` 或 `failed` 时均向父会话写入 `role: 'callback'` 消息并调用 `router.handleWakeup` 唤醒父会话主 Bot。
- [ ] **Task 1.2**：修改 `apps/web/src/components/Sidebar.tsx:62-78` 的 `pickCurrentDirectSession`，排除 `Boolean(s.parentSessionId)` 的子会话，防止子会话篡位主单聊入口。
- [ ] **Task 1.3**：在 `ChatView.tsx` 接入 `api.listSubSessions`，在父会话中展示关联子会话的状态胶囊列表并支持一键跳转。
- [ ] **Task 1.4**：实现跨节点群聊 `@Bot` 与子会话委派时的 `incomingArtifacts` 自动预下载逻辑，自动落盘至目标 Bot 的 `workspace/inbox/` 并注入系统路径提示。

### Phase 2：`botd ask` 富预览、全局审批收件箱与离线信箱 (Store-and-Forward)
- [ ] **Task 2.1**：扩展 `botd ask` 支持 `--file`、`--diff`、`stdin` 管道与 `--timeout 0`，将审批状态持久化至 Hub SQLite，并在前端确认卡片渲染折叠 Diff / Markdown 视图。
- [ ] **Task 2.2**：在 `Sidebar.tsx` 顶部实现全局「待我确认（Pending Approvals）」收件箱抽屉。
- [ ] **Task 2.3**：在 Hub SQLite 实现 `outbound_task_queue` 表，改造 `ws-hub.ts` 与 `group-router.ts` 实现离线节点任务的暂存（Store-and-Forward）与重连自动补发。

### Phase 3：内网团队共享网格 (Team Agent Mesh)
- [ ] **Task 3.1**：在 Hub SQLite 为 `bots` / `nodes` 增加 `visibility ('private' | 'team')` 字段，新增 `session_participants` 表。
- [ ] **Task 3.2**：改造 `apps/hub` 鉴权与查询接口，支持在通讯录展示并调用团队共享 Bot（带 `[共享]` 标识），支持邀请内网其他团队成员进入同一会话协同排障。
