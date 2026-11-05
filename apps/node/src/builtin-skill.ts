import path from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { readSkill, writeSkill, ensureDir } from './storage.js';

/**
 * The framework's self-description, taught to every BOT as an always-on skill.
 * Managed by botd: re-written when the version marker below changes; user edits
 * survive until the framework ships a newer version.
 *
 * Progressive disclosure: SKILL.md carries only the high-frequency discipline;
 * deep-dive material (worker recipes, the 17 UI components, extension
 * authoring) lives in references/*.md that the model reads on demand.
 */
export const BUILTIN_SKILL_ID = 'botd-cli';
export const BUILTIN_SKILL_VERSION = 16;
const VERSION_MARKER = `<!-- botd-skill: ${BUILTIN_SKILL_ID} v${BUILTIN_SKILL_VERSION} -->`;

export const BUILTIN_SKILL_MD = `${VERSION_MARKER}
# botd — Multi-Persona Super-agent 控制平面

你运行在 botd 上（Brain in Hub, Hands on Node）：每个 BOT 是 Hub 持久运行时里的一个 Router 分身；工具执行落在各节点的真实工作目录。\`botd\` 命令是这一切的一等公民 CLI（Web UI 与 CLI 同权）。

## Rules

- 解析输出时 ALWAYS 加 \`--json\`：成功 → stdout JSON；失败 → stderr \`error: <message>\` + 非零退出码。
- 用 \`botd <command> --help\`（任意层级）查询确切选项名，不要猜。
- Hub 命令需要一次性 \`botd login <hubUrl> --username <user> --password <pwd>\`（用户默认 admin；密码也可用 \`BOTD_ADMIN_PASSWORD\`）。例外：本机节点已配对（\`~/.botd/node.json\` 存在）时，Hub 管理命令用节点凭据自动认证。节点命令从不需要登录。

## Super-agent 工具（Router 内置）

你是 Router：前台直接干活 + 重活派后台 Worker，绝不让用户等。

- **当场完成（不派 Worker）**：快速问答、看单个/少量文件、跑一行轻量命令、技能查询（记账/查账/状态查看）。你手里就有 \`read\` / \`bash\` 等工具，1 轮能干完的事绝不 spawn_worker。
- \`spawn_worker({ title, task, subagent?, resume?, forkContext?, worktree?, threadKey? })\` — 派后台 Worker（多步编码/shell/调研），立刻返回 workerId，跑完自动汇报。\`subagent: "<id>"\` 用麾下子代理分身（它的模型/人设/toolScope，共享本工作区）；\`resume: "w-1-2"\` 续跑旧 Worker（保留完整会话与 worktree）；\`worktree: true\` 给独立 git worktree（多 Worker 并发改同一仓库时用）。
- \`delegate_to_bot({ targetBotId, title, task })\` — 把任务委派给另一个 BOT 分身（它的模型与人设），后台运行。
- Worker 运行期间继续对话：\`steer_worker({ workerId, message, mode: "steer" | "followUp" })\` 插话改向或唤醒已结束/已停止的 Worker 续跑（保留完整上下文）；\`stop_worker({ workerId })\` 中止；\`recall({ id })\`（Chain of Recall）随时取回任意节点（worker/trigger/artifact/thread）的完整内容与关联摘要。
- \`ask_human({ prompt, options })\` — 问用户一个问题；再次调用同一 prompt 轮询答案。
- **\`SubagentWorkflow({ script })\`** — 确定性多步流水线：脚本里用 \`agent()\` / \`pipeline()\` / \`parallel()\` / \`phase()\` / \`log()\`；每步产出写入 crash-safe \`api.memo\` 检查点，进程崩溃重开后已完成步骤 0ms 重放、不再调模型。\`agent(prompt, { agentType: "<subagentId>" })\` 可让某一步跑在麾下子代理分身上（真实模型/人设/toolScope）。完整写法（含 schema 校验与 gate 门禁）见 \`read\` 同目录下 \`references/subagents-and-workflows.md\`。

## botd CLI（一等公民）

Super-agent 操作（workers / events / watchdog / asks）与 Web UI 完全同权：

\`\`\`bash
botd workers list <sessionId> --json                    # 会话的后台 Worker（含状态/摘要/threadKeys）；省略 <sessionId> 则跨会话列出全部 Worker
botd workers spawn <sessionId> --title "重构" --task "..." [--bot <botId>] [--worktree] [--thread-key <key>]
botd workers steer <sessionId> <workerId> "改用方案 B" [--mode followUp]
botd workers stop <sessionId> <workerId>
botd workers recall <sessionId> <workerId> --json       # Chain of Recall 节点 + transcript

botd events ingest --source github --type check_suite.completed --file payload.json \
  [--repo owner/repo] [--pr 42] [--session <sid>] [--bot <botId>]   # 外部事件 → EventRouter

botd watchdog health [--run-pass] --json                # 系统健康诊断
botd asks list <sessionId> --json                       # 待确认的人工请求
botd asks respond <sessionId> <askId> 批准
\`\`\`

其余常用命令（全部支持 \`--json\`）：

- \`botd sessions list|create|messages <id>|search <q>|cancel <id>|share <id>\` — 会话与消息；\`botd sessions clear <id> --keep-workers\` 清空历史并重置记忆但保留运行中的后台 Worker。
- \`botd chat send <sessionId> "<msg>" --wait 120\` — 向会话发消息并等回复（bot-to-bot）。
- \`botd bots create <botId> --name <n> --model <provider/modelId> [--workspace <dir>]\` — 新建 BOT 分身（\`--node\` 默认 \`BOTD_NODE_ID\` 或 \`local\`）；\`botd bots env set <botId> KEY=VALUE\` 注入密钥。
- \`botd artifact put <filePath>\` / \`artifact pull <id>\` / \`artifact list\` — 文件在节点、会话与 BOT 间共享。
- \`botd triggers list|create|delete\` — webhook/cron/once 触发器。
- \`botd nodes list\`、\`botd skills/extensions/providers/models ...\` — 节点、资源与模型管理面。

### Node 命令（本机，无需登录）

- \`botd status\` — daemon pid / uptime / Hub 连接状态。
- \`botd wake --session "$BOTD_SESSION_ID" --bot "$BOTD_BOT_ID" --message "<result>"\` — 之后回投结果；\`--delay 30s|15m|2h|1d\` 持久化延迟唤醒；\`--no-turn\` 静默投递不消耗推理回合。

### Restart warning

\`botd restart\` / \`botd stop\` 会杀掉 daemon 与所有进行中的回合（包括你自己的）。绝不在回合中运行；确需重启，先完成回复再分离执行：\`(sleep 5 && botd restart -d & disown; exit 0)\`。

## Generative UI (botd.v1)

1. 会话内展示：发一个 \`\`\`ui（或 \`\`\`json-render）围栏，内含合法 JSON Spec，Web 聊天原生渲染。
2. Spec 顶层 \`{ root, elements, state }\`；表单值经 \`{ "$state": "/key" }\` 绑定 store；提交动作 \`{ action: 'submit', params }\`。
3. 17 个组件：Stack, Card, Tabs, Accordion, MetricGrid, MetricCard, BarList, KeyValueList, Table, Callout, Steps, TextInput, Select, Switch, CheckboxGroup, ActionBar, Button。
   各组件完整 Props 契约、槽位写法与表单状态绑定请用 \`read\` 查阅同目录下的 \`references/generative-ui.md\`。

## Self-Evolution: Skill Creator（AI 自举）

需要沉淀可复用流程时自己动手写 Skill（纯提示词知识，零代码）：写 \`~/.botd/skills/<skill-id>/SKILL.md\`（frontmatter \`name\` + \`description\`；正文 When to use / Steps / Gotchas，~80 行内，深挖内容放 \`references/\`），然后 \`botd reload\` 注册进 Hub。全栈 Extension（TypeScript 代码：hooks / 工具 / 命令 / Web UI 桥接）完整模板见 \`read\` 同目录下 \`references/extension-and-skill-dev.md\`。
`;

/** Reference docs shipped beside SKILL.md; loaded on demand by the model. */
export const BUILTIN_SKILL_REFERENCES: Record<string, string> = {
  'subagents-and-workflows.md': `${VERSION_MARKER}
# Workers & SubagentWorkflow — 完整参考

主文件: ../SKILL.md (## Super-agent 工具)。本文件收录 Router 决策纪律、Worker 生命周期与 SubagentWorkflow 流水线完整写法。

## 1. Router 决策纪律（何时派 Worker）

- **当场完成**：短问题/短答案、看单个或少量文件、跑一行轻量命令、技能查询（记账/查账/状态查看）——Router 手里有 \`read\` / \`bash\`，**绝不**为这些 spawn worker。
- 多步编码、重构、长耗时命令、调研、需要并行或 worktree 隔离的任务：\`spawn_worker\` 并立刻告知用户 workerId。
- 替别的 BOT 干活：\`delegate_to_bot\`（以目标 BOT 的模型+人设后台运行）。
- 麾下子代理分身（同工作区，各自模型/人设/toolScope）：\`spawn_worker({ subagent: "<id>", title, task })\`；或 \`agent(prompt, { agentType: "<id>" })\` 在流水线中调度。
- Worker 运行期间保持可聊：\`steer_worker\` 改向或唤醒已结束/已停止的 Worker（保留完整上下文）、\`stop_worker\` 中止、\`recall({ id })\` 取结果。
- Worker 完成会自动汇报；为用户总结其报告即可。

\`spawn_worker\` 参数：\`{ title, task, subagent?, resume?, forkContext? (default false), threadKey?, cwd?, worktree? }\`。新建 Worker 默认是干净的独立会话——靠自包含的 \`task\` 传递上下文，不复制主会话历史；仅当确需继承主会话上下文时才显式 \`forkContext: true\`。\`worktree: true\` 时 Worker 在 \`<cwd>/.botd-worktrees/<workerId>\` 的独立 git worktree 里改代码（多 Worker 并发改同一仓库时必开）。\`resume: "w-1-2"\` 复用旧 Worker 的会话与 worktree 续跑。\`threadKey\` 让 Worker 直接接收该线程上的后续事件（EventRouter 直通）。

## 2. Worker 生命周期与状态

- Worker 状态：\`running | completed | failed | aborted\`；完成后 registry 带 \`summary\`。
- \`botd workers list <sessionId> --json\` 随时查状态/摘要/worktree 路径/threadKeys；省略 \`<sessionId>\` 则跨会话列出全部 Worker。
- \`steer_worker\` 的 \`mode\`：\`"steer"\`（运行中插话改向，默认）/ \`"followUp"\`（排在当前 run 之后继续）。
- \`recall\`（Chain of Recall）：\`recall({ id })\` 返回节点完整内容 + relatedIds 的一行摘要（多跳追溯）。

## 3. SubagentWorkflow（确定性多步流水线，crash-safe）

\`SubagentWorkflow({ script })\`：脚本文本 \`export const meta = { name, description, phases }\` + 直接使用解构钩子的异步体。每步产出提交为 pi-durable task **memo** 检查点 —— 进程崩溃重开后同一脚本重跑，已完成步骤直接从 memo 命中（0ms、不再调模型），失败步骤续跑。

钩子：

- \`agent(prompt, opts?)\` — 一步子代理。opts：\`{ label?, phase?, schema? (JSON Schema，校验失败判步失败), model?, effort?, agentType?, gate? (shell 门禁，非零退出判步失败) }\`。
- \`phase(title)\` — 分组阶段（UI 时间线展示）。
- \`log(message)\` — 追加日志行。
- \`pipeline(items, ...stages)\` — 条目独立流过所有阶段，**阶段间无 barrier**（先到的条目先进下一阶段）。
- \`parallel(thunks, concurrency = 4)\` — 并发上限执行；失败 thunk 解析为 null。
- \`args\` — 工具入参透传给脚本。

\`\`\`js
export const meta = { name: "release-pipeline", description: "Build once, test on two platforms" }
phase("Build")
const build = await agent("produce the release", {
  schema: { type: "object", properties: { version: { type: "string" } }, required: ["version"] },
})
const reports = await parallel([
  () => agent(\`test version \${build.version} on linux\`, { phase: "Test" }),
  () => agent(\`test version \${build.version} on mac\`, { phase: "Test" }),
])
return { version: build.version, reports: reports.filter(Boolean) }
\`\`\`

要点：run doc（SQLite 事务）记录 phases/logs/step journal，UI 经 details 实时观看进度；返回值必须是 JSON 可序列化的。
`,

  'generative-ui.md': `${VERSION_MARKER}
# Generative UI 组件完整参考 (botd.v1)

主文件: ../SKILL.md (## Generative UI)。Spec 顶层结构: \`{ root: string, elements: Record<string, BotdUiElement>, state?: Record<string, unknown> }\`。限制: 64KB / 64 elements / 树深 6。

## Component catalog (17 components)

### Layout & Display

- \`Stack\`: \`{ direction?: 'vertical' | 'horizontal', gap?: 'sm' | 'md' }\`
- \`Card\`: \`{ title: string, subtitle?: string, badge?: string, icon?: string }\`
- \`Tabs\`: \`{ tabs: Array<{ id: string, label: string, icon?: string }>, defaultTab?: string }\` (children mapped 1:1 or via slots: { [id]: [childKey] })
- \`Accordion\`: \`{ items: Array<{ title: string, content?: string, defaultOpen?: boolean, icon?: string, badge?: string, mono?: boolean }> }\`
  (item content renders as text; to nest arbitrary components inside an item, put child ids in \`slots: { [itemTitle]: [childKey] }\`)

### Metrics & Comparison

- \`MetricGrid\`: \`{ columns?: 2 | 3 | 4 }\`
- \`MetricCard\`: \`{ label: string, value: string, hint?: string, status?: 'ok' | 'warn' | 'error', trend?: 'up' | 'down' | 'flat', icon?: string }\`
- \`BarList\`: \`{ items: Array<{ label: string, value: number, max?: number, displayValue?: string, color?: 'blue'|'emerald'|'amber'|'rose'|'purple' }>, title?: string }\`
- \`KeyValueList\`: \`{ items: Array<{ key: string, value: string, mono?: boolean, badge?: string }> }\`
- \`Table\`: \`{ columns: string[], rows: string[][], monoColumns?: number[], title?: string }\` (rows[i].length must equal columns.length)

### Explanation & Flows

- \`Callout\`: \`{ title?: string, content: string, variant?: 'info' | 'tip' | 'warn' | 'error', icon?: string, mono?: boolean }\`
- \`Steps\`: \`{ items: Array<{ title: string, description?: string, status?: 'done' | 'current' | 'pending', icon?: string, badge?: string }> }\`

### Form Inputs & Actions

- \`TextInput\`: \`{ label: string, value?: string | { "$state": "/key" }, placeholder?: string, hint?: string, multiline?: boolean, rows?: 2..12 }\` (multiline renders a textarea)
- \`Select\`: \`{ label: string, value?: string | { "$state": "/key" }, options: Array<{ value: string, label: string }> }\`
- \`Switch\`: \`{ label: string, checked?: boolean | { "$state": "/key" }, hint?: string }\`
- \`CheckboxGroup\`: \`{ label: string, options: Array<{ value: string, label: string, description?: string }>, value?: string[] | { "$state": "/key" }, hint?: string }\` (state binding holds the selected value array)
- \`ActionBar\`: \`{ align?: 'left' | 'right' | 'between' }\`
- \`Button\`: \`{ label: string, variant?: 'primary' | 'secondary' | 'danger' }, on.press: { action: 'submit', params?: { decision?: string } }\`

## State binding

Bind form values to store keys via \`{ "$state": "/key" }\` (string for TextInput/Select, boolean for Switch, string[] for CheckboxGroup). On submit, form state and button params return as single-line JSON.

## Semantic icons

lightbulb, info, alert-triangle, alert-circle, check-circle, cpu, database, server, hard-drive, activity, layers, terminal, code, git-branch, workflow, shield, lock, key, globe, zap, clock, sparkles, book-open, file-text, box, help-circle, trending-up, trending-down, bar-chart, refresh.

## Complete JSON example

\`\`\`json
{
  "root": "page",
  "state": { "reason": "" },
  "elements": {
    "page": { "type": "Card", "props": { "title": "部署审批", "badge": "risk: high", "icon": "shield" },
      "children": ["metrics", "diff", "form"] },
    "metrics": { "type": "MetricGrid", "props": { "columns": 3 }, "children": ["m1", "m2", "m3"] },
    "m1": { "type": "MetricCard", "props": { "label": "影响服务", "value": "3", "status": "warn", "icon": "server" } },
    "m2": { "type": "MetricCard", "props": { "label": "回滚窗口", "value": "15m", "icon": "clock" } },
    "m3": { "type": "MetricCard", "props": { "label": "审批人", "value": "@ops", "icon": "check-circle" } },
    "diff": { "type": "Accordion", "props": { "items": [
      { "title": "deploy.yaml", "defaultOpen": true, "mono": true,
        "content": "replicas: 2 -> 4\\nimage: v1.8.2 -> v1.9.0" }
    ] } },
    "form": { "type": "Stack", "props": { "direction": "vertical" }, "children": ["reason-input", "actions"] },
    "reason-input": { "type": "TextInput", "props": { "label": "审批理由", "multiline": true, "rows": 3,
      "placeholder": "为何批准/拒绝", "value": { "$state": "/reason" } } },
    "actions": { "type": "ActionBar", "props": { "align": "right" }, "children": ["cancel", "ok"] },
    "cancel": { "type": "Button", "props": { "label": "拒绝", "variant": "danger" },
      "on": { "press": { "action": "submit", "params": { "decision": "拒绝" } } } },
    "ok": { "type": "Button", "props": { "label": "批准", "variant": "primary" },
      "on": { "press": { "action": "submit", "params": { "decision": "批准" } } } }
  }
}
\`\`\`
`,

  'extension-and-skill-dev.md': `${VERSION_MARKER}
# Skill & Full-Stack Extension Creator 完整指南 (AI 自举开发)

主文件: ../SKILL.md (## Self-Evolution)。两种自举路径：**Skill** = 纯提示词知识（流程、约定、检查单），无代码；**Full-Stack Extension** = TypeScript 代码：拦截钩子、注册工具/命令、驱动 Web UI。

## Part 1: Skill Creator

1. Write \`~/.botd/skills/<skill-id>/SKILL.md\` (from your workspace: \`../../../skills/<skill-id>/SKILL.md\`). Choose a short lowercase id (a-z0-9-).
2. Format:
   - YAML frontmatter: \`name: <skill-id>\` and \`description: <one line — when to use this>\`.
   - Body sections: **When to use** / **Steps** (exact commands, copy-pasteable) / **Gotchas**.
   - Keep it under ~80 lines; put deep-dive material in \`references/*.md\` next to SKILL.md (渐进式披露：正文只留摘要 + \`read references/xxx.md\` 指引).
   - Distill from what you actually did this session — real commands that worked, real paths, real failure modes. No placeholders, no invented flags.
3. Run \`botd reload\` so the daemon re-registers resources and the skill appears in the Web UI.
4. Enable per bot: the Web bot editor, or \`botd bots update <botId> --skill <skillId>\`.

## Part 2: Full-Stack Extension Creator

Extension = \`~/.botd/extensions/<id>/index.ts\`, exporting a default factory:

\`\`\`typescript
import type { ExtensionAPI } from 'pi'; // 宿主注入的扩展 API 类型

export default function (pi: ExtensionAPI) {
  // ... register capabilities
}
\`\`\`

核心 API：

- \`pi.on('<event>', handler)\` — intercept hooks: \`session_start\`, \`before_agent_start\`, \`turn_start\`, \`turn_end\`, \`tool_call\` (return \`{ block: true, reason }\` to veto), \`tool_result\`, \`session_shutdown\`.
- \`pi.registerTool({ name, label, description, parameters (JSON Schema), execute })\` — model-callable tool. \`execute(toolCallId, params, signal, onUpdate, ctx)\` returns \`{ content: [{ type: 'text', text }], isError?, details? }\`.
- \`pi.registerCommand(name, { description, handler(args, ctx) })\` — \`/\` command.

### ctx.ui — Web 端完整桥接（三个插槽）

**1. 对话框插槽 (\`dialog.ask\` / \`dialog.custom\`)** — 阻塞式人机交互，经 Web 弹窗闭环：

- \`await ctx.ui.confirm(title, msg, { timeout, signal }): Promise<boolean>\`
- \`await ctx.ui.select(title, options: string[], opts?): Promise<string | undefined>\`
- \`await ctx.ui.input(title, placeholder?, opts?): Promise<string | undefined>\`
- \`await ctx.ui.editor(title, prefill?): Promise<string | undefined>\`
- \`await ctx.ui.custom({ title, prompt, ui: BotdUiSpec })\` — 自定义 Generative UI 弹窗（也可传裸 BotdUiSpec）；提交后返回表单结果

**2. 实时流与挂件插槽 (\`composer.widget\` / \`shell.notify\`)** — 非阻塞，即时推流到 Web 会话：

- \`ctx.ui.notify(msg, 'info' | 'warning' | 'error')\`
- \`ctx.ui.setStatus(key, text)\`
- \`ctx.ui.setWorkingMessage(msg)\`
- \`ctx.ui.setWidget(key, linesOrUiSpec, { placement: 'aboveEditor' | 'belowEditor' })\` — 输入框上方/下方挂件；\`string[]\` 渲染为纯文本行，\`BotdUiSpec\` 渲染为完整组件树，\`undefined\` 清除
- \`ctx.ui.setEditorText(text)\` / \`ctx.ui.pasteToEditor(text)\`

**3. 自定义工具视图插槽 (\`tool.view\`)** — 工具结果的常驻富视图：

在 \`pi.registerTool\` 的 \`execute()\` 返回值中附上 \`details.ui\`（Web 前端校验通过后渲染在工具调用块下方，组件契约见 \`generative-ui.md\`）：

\`\`\`typescript
return {
  content: [{ type: 'text', text: JSON.stringify(summary) }],
  details: {
    ui: {
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: '扫描结果' }, children: ['bars'] },
        bars: { type: 'BarList', props: { items: [{ label: 'errors', value: 3, color: 'rose' }] } },
      },
    },
  },
};
\`\`\`

### 纯终端 TUI 方法（Web 端不可用）

以下方法依赖终端画布/键盘流，在 botd Web 端调用会显式报错 \`此命令需要终端界面，当前网页不支持\`：\`ctx.ui.custom(fn)\` 传组件工厂函数、\`setFooter\`、\`setHeader\`、\`setEditorComponent\`、\`getEditorComponent\`、\`addAutocompleteProvider\`、\`setTheme\` / \`getTheme\` / \`getAllThemes\`。改用声明式 \`BotdUiSpec\`（\`custom({ ui: spec })\`、\`setWidget(key, spec)\`、\`details.ui\`）。

### 完整扩展示例（可直接复制运行）

保存为 \`~/.botd/extensions/deploy-guard/index.ts\`：

\`\`\`typescript
import type { ExtensionAPI } from 'pi'; // 宿主注入的扩展 API 类型

export default function (pi: ExtensionAPI) {
  // 1. 拦截高危 bash 命令，弹出结构化审批卡片
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const cmd = String((event.input as { command?: string })?.command || '');
    if (!/rm\\s+-rf|git\\s+push.*--force/.test(cmd)) return;
    const ok = await ctx.ui.confirm('高危命令审批', cmd, { timeout: 300_000 });
    if (!ok) return { block: true, reason: '用户拒绝了该高危命令' };
  });

  // 2. 模型可调用的工具 + details.ui 富视图 + setWidget 实时挂件
  pi.registerTool({
    name: 'deploy_status',
    label: 'Deploy Status',
    description: '查询当前部署状态并渲染指标卡片',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', description: '服务名' } },
      required: ['service'],
    } as any,
    execute: async (_id, params: { service: string }, _signal, _onUpdate, ctx) => {
      const stats = { replicas: 4, ready: 3, version: 'v1.9.0' };
      ctx.ui.setWidget('deploy', ['部署监控: ' + params.service], { placement: 'aboveEditor' });
      ctx.ui.notify('状态已刷新: ' + params.service, 'info');
      return {
        content: [{ type: 'text', text: JSON.stringify(stats) }],
        details: {
          ui: {
            root: 'grid',
            elements: {
              grid: { type: 'MetricGrid', props: { columns: 3 }, children: ['a', 'b', 'c'] },
              a: { type: 'MetricCard', props: { label: 'Replicas', value: String(stats.replicas), icon: 'server' } },
              b: { type: 'MetricCard', props: { label: 'Ready', value: String(stats.ready), status: stats.ready < stats.replicas ? 'warn' : 'ok' } },
              c: { type: 'MetricCard', props: { label: 'Version', value: stats.version, icon: 'git-branch' } },
            },
          },
        },
      } as any;
    },
  });

  // 3. / 命令 + custom(uiSpec) 弹窗表单
  pi.registerCommand('deploy-ask', {
    description: '弹出部署参数表单',
    handler: async (_args, ctx) => {
      const answer = await ctx.ui.custom({
        title: '部署参数',
        prompt: '请填写部署参数',
        ui: {
          root: 'form',
          state: { env: 'staging' },
          elements: {
            form: { type: 'Stack', props: { direction: 'vertical' }, children: ['env', 'go'] },
            env: { type: 'Select', props: { label: '环境', value: { '$state': '/env' },
              options: [{ value: 'staging', label: 'Staging' }, { value: 'prod', label: 'Production' }] } },
            go: { type: 'Button', props: { label: '部署', variant: 'primary' },
              on: { press: { action: 'submit', params: { decision: 'deploy' } } } },
          },
        },
      });
      ctx.ui.notify('已提交: ' + JSON.stringify(answer), 'info');
    },
  });
}
\`\`\`

### 安装与热更新

\`\`\`bash
# 本地目录 / git / npm（兼容 Pi Package 生态：带 "pi" 字段的 package.json 原生识别）
botd nodes install <nodeId> ~/.botd/extensions/deploy-guard
botd nodes install <nodeId> npm:@example/pi-tools@1.0.0
botd nodes install <nodeId> git:github.com/owner/repo@v1.0.0

# 改完代码后热更新（daemon 重新加载资源清单并上报 Hub）
botd reload
botd bots update <botId> --extension <extId>
\`\`\`
`,
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the builtin skill and its reference docs exist at the current version. Safe to call on every start. */
export async function ensureBuiltinSkill(dataDir: string): Promise<void> {
  let current: string;
  try {
    current = await readSkill(dataDir, BUILTIN_SKILL_ID);
  } catch {
    current = '';
  }
  const skillUpToDate = current.includes(VERSION_MARKER); // up to date (or user-edited at this version)

  if (!skillUpToDate) {
    await writeSkill(dataDir, BUILTIN_SKILL_ID, BUILTIN_SKILL_MD);
  }

  // Reference files: a version bump refreshes all of them; otherwise only
  // missing ones self-heal (user-edited references at this version survive).
  const referencesDir = path.join(dataDir, 'skills', BUILTIN_SKILL_ID, 'references');
  for (const [filename, content] of Object.entries(BUILTIN_SKILL_REFERENCES)) {
    const dest = path.join(referencesDir, filename);
    if (skillUpToDate && (await fileExists(dest))) continue;
    await ensureDir(referencesDir);
    await writeFile(dest, content, 'utf8');
  }
}
