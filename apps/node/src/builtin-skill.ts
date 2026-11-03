import path from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { readSkill, writeSkill, ensureDir } from './storage.js';

/**
 * The framework's self-description, taught to every BOT as an always-on skill.
 * Managed by botd: re-written when the version marker below changes; user edits
 * survive until the framework ships a newer version.
 *
 * Progressive disclosure: SKILL.md carries only the high-frequency discipline;
 * deep-dive material (subagent recipes, the 17 UI components, extension
 * authoring) lives in references/*.md that the model reads on demand.
 */
export const BUILTIN_SKILL_ID = 'botd-cli';
export const BUILTIN_SKILL_VERSION = 14;
const VERSION_MARKER = `<!-- botd-skill: ${BUILTIN_SKILL_ID} v${BUILTIN_SKILL_VERSION} -->`;

export const BUILTIN_SKILL_MD = `${VERSION_MARKER}
# botd CLI — this framework's control plane

You are running inside botd (a multi-node BOT platform). The \`botd\` command controls this machine's daemon and, after login, the Hub (nodes/bots/sessions/chat).

## Rules

- ALWAYS pass \`--json\` when you plan to parse output; success → JSON on stdout, failure → \`error: <message>\` on stderr with a non-zero exit code.
- Discover exact flags with \`botd <command> --help\` (works at every level). Do not guess option names.
- Hub commands need a one-time \`botd login <hubUrl> --username <user> --password <pwd>\` (user defaults to admin; password also via \`BOTD_ADMIN_PASSWORD\`). Exception: once this machine's node is paired (\`~/.botd/node.json\` exists), Hub admin commands auto-authenticate with node credentials — no login needed. Node commands never need login.

## Node commands (this machine, no login)

- \`botd status\` — daemon pid, uptime, Hub connection state.
- \`botd wake --session "$BOTD_SESSION_ID" --bot "$BOTD_BOT_ID" --message "<result>"\` — deliver a result later, from a detached background job. \`--delay <30s|15m|2h|1d>\` = persistent one-shot delayed wake (Hub-stored, survives daemon restarts); \`--no-turn\` = silent progress report consuming no LLM inference turn.
- \`botd ask "<prompt>" [--options "确认,取消"] [--timeout 300] [--ui] [--file <path> | --stdin]\` — human-in-the-loop interactive card in Web chat; prints the selected option, text answer, or Generative UI form JSON to stdout. With \`--risk low|medium|high [--reason "<why>"] [--resource "<target>"] [--file <path>]\` it auto-builds a structured approval card (risk callout, resource list, diff accordion, 批准/拒绝 buttons); without \`--json\` the decision prints as plain text so \`choice=$(botd ask ... --risk high)\` works in shell scripts; custom \`--options\` or a hand-written \`--ui\` spec take precedence.
- \`botd artifact put <filePath> [--message "<desc>"]\` / \`artifact pull <artifactId> [-o <path>]\` / \`artifact list\` — share files between this node, the session Web UI, and bots on other nodes.
- \`botd install <source> [--bot "$BOTD_BOT_ID"]\` — install a skill/extension; the live daemon hot-reloads it. \`--bot\` also enables it on the given bot(s) immediately.

### Async pattern (long tasks)

Prefer \`botd bg run\` — the daemon-managed way (auto log capture + auto wake-up on exit):

\`\`\`bash
botd bg run --bot "$BOTD_BOT_ID" -- make test  # logs to <workspace>/.bg/<jobId>.log
botd bg list                                   # job id / status / exit code
botd bg logs bg_ab12cd34 --lines 50            # tail a job log
botd bg kill bg_ab12cd34                       # stop a running job
\`\`\`

On exit the daemon reports the result (exit code + last ~20 log lines) back into the session; \`--no-turn\` delivers silently. Raw alternative (no management): \`(sleep 30 && botd wake --session "$BOTD_SESSION_ID" --bot "$BOTD_BOT_ID" --message "done") &\`.

### Restart warning

\`botd restart\` / \`botd stop\` kill the daemon AND every in-flight turn — including yours. Never run them mid-turn; if genuinely required, finish your reply and schedule it detached: \`(sleep 5 && botd restart -d & disown; exit 0)\`.

## Subagents (子代理：创建、管理与并发调度)

Each primary BOT can have role subagents sharing its workspace, dispatched via the built-in \`Agent\` / \`SubagentWorkflow\` tools.

- **Ephemeral subagents (临时，默认推荐)** — one-shot roles (adversarial review, ad-hoc audits). Write \`$PI_CODING_AGENT_DIR/agents/tmp-<role>.md\` (e.g. \`tmp-skeptic\`) with YAML frontmatter (\`name\`/\`description\`/\`tools\`) + persona, then dispatch in the SAME turn via \`Agent(subagent_type: "tmp-skeptic")\` or \`SubagentWorkflow\`; the runtime 自动删除所有 \`tmp-*.md\` at turn end (even if aborted) — they never pollute the Web sidebar.
- **Persistent subagents (正式持久化)** — long-term roles the user explicitly requested: created via \`botd bots create --parent "$BOTD_BOT_ID"\`, synced to the sidebar, invocable via \`Agent\` immediately.
- **Dispatch**: ALWAYS use \`Agent\` / \`SubagentWorkflow\` (NOT \`@subId\` in text — that is group-chat turn handoff). Multiple \`Agent\` calls in one assistant turn run in parallel; omit \`isolation\` so subagents share your workspace (\`worktree\` only for concurrent same-repo edits).
- **Control**: \`stop_subagent(agent_id)\` stops one; \`steer_subagent(agent_id, message)\` redirects mid-run; \`Agent(resume: "<agent_id>")\` continues a finished one with full context.
- Cross-BOT delegation (\`Agent\` with \`subagent_type: "@<botId>"\`, \`botd sessions delegate\`) and multi-stage pipelines: 完整命令与跨节点 SubagentWorkflow 流水线写法请用 \`read\` 查阅同目录下的 \`references/subagents-and-workflows.md\`。

## Generative UI (Dynamic Cards & Interactive Forms)

1. In-chat display: emit a \`\`\`ui (or \`\`\`json-render) fence containing a valid JSON Spec — it renders natively in Web chat.
2. Interactive forms / approvals: \`botd ask "<prompt>" --ui --stdin << 'EOF' ... EOF\` (outputs \`{ decision, state }\` JSON to stdout); \`botd ask --ui-schema\` prints the catalog.
3. Spec shape: top-level \`{ root, elements, state }\`; form values bind to store keys via \`{ "$state": "/key" }\`.
4. 17 components: Stack, Card, Tabs, Accordion, MetricGrid, MetricCard, BarList, KeyValueList, Table, Callout, Steps, TextInput, Select, Switch, CheckboxGroup, ActionBar, Button.
   各组件的完整 Props 契约、槽位写法与表单状态绑定请用 \`read\` 查阅同目录下的 \`references/generative-ui.md\`。

## Self-Evolution: Skill & Extension Creator (AI 自举开发)

When the user asks to distill a workflow ("沉淀为技能") or you need new capabilities, build it yourself:

- **Skill (纯提示词知识)** — reusable procedures, zero code: write \`~/.botd/skills/<id>/SKILL.md\` (frontmatter \`name\` + \`description\`; body: When to use / Steps / Gotchas, under ~80 lines, deep-dives in \`references/\`).
- **Full-Stack Extension (代码能力)** — write \`~/.botd/extensions/<id>/index.ts\`: intercept hooks (\`pi.on\`), register model-callable tools (\`pi.registerTool\` + \`details.ui\` custom views), register \`/\` commands (\`pi.registerCommand\`), and drive the Web UI — dialogs \`ctx.ui.confirm/select/input/editor/custom(uiSpec)\`, widgets \`ctx.ui.setWidget(key, uiSpec)\`, streaming \`ctx.ui.notify/setStatus\`.
- **Enable**: \`botd install <source> --bot "$BOTD_BOT_ID"\`, or write files then run \`botd reload\` and mount with \`botd bots update "$BOTD_BOT_ID" --extension <id>\`.
- 编写 Skill 或全栈 Extension 前，请先用 \`read\` 查阅同目录下的 \`references/extension-and-skill-dev.md\` 获取完整 TypeScript 模板与 API 契约。

## Hub commands (admin, require login)

- \`botd nodes list --json\` — all nodes with their bots/status/pid.
- \`botd sessions list/messages <id>/search <query> --json\` — inspect and search message history across all sessions.
- \`botd sessions delegate <parentSessionId> --bot <botId> --prompt "<task>"\` — delegate a sub-task to a child session executed by the specified bot.
- \`botd chat send <sessionId> "<message>" --wait 120 --json\` — message another session and wait for its BOTs to answer (bot-to-bot communication).
- \`botd bots env list/set/unset <botId> ...\` — per-bot environment variables, injected into the bot's turns and background jobs on its node.
- \`botd bots/skills/extensions/providers/models <subcommand>\` — full management surface, same capabilities as the Web UI. Use \`--help\` to explore.
`;

/** Reference docs shipped beside SKILL.md; loaded on demand by the model. */
export const BUILTIN_SKILL_REFERENCES: Record<string, string> = {
  'subagents-and-workflows.md': `${VERSION_MARKER}
# Subagents & Cross-Bot Workflows — 完整参考

主文件: ../SKILL.md (## Subagents)。本文件收录完整创建命令、跨 Bot 委派与 SubagentWorkflow 流水线写法。

## 1. Ephemeral subagents (临时子代理 — 用完即焚，不进侧栏，默认推荐用于技能编排与一次性多视角任务)

当技能或任务需要临时角色人设（例如对抗审查小组、一次性专项审计）、且不应永久出现在 Web 侧栏或 Hub 数据库时，在调用 \`Agent\` 或 \`SubagentWorkflow\` 前，直接在同一回合内写入 \`$PI_CODING_AGENT_DIR/agents/tmp-<role>.md\`：

\`\`\`markdown
---
name: tmp-skeptic
description: 红队挑刺审查员（一次性临时子代理）
tools: read, grep, find, ls
---
你是一名挑剔的红队审查专家，专注于证伪方案假设、寻找并发竞态与安全边界漏洞。
\`\`\`

写完后在**同一回合**内立刻调度：\`Agent(subagent_type: "tmp-skeptic", ...)\` 或 \`SubagentWorkflow\`（\`agent("...", { agentType: "tmp-skeptic" })\`）。运行时在每次调度前重新加载 \`$PI_CODING_AGENT_DIR/agents/*.md\`，并在**回合结束时自动删除所有 \`tmp-*.md\` 文件**（即使回合被中止）。

## 2. Persistent subagents (正式子代理 — 持久化到侧栏，仅在用户明确要求创建长期角色时使用)

当用户要求创建长期角色（可跨回合、跨会话复用、出现在 Web 侧栏）时，用 \`botd bots\`：

\`\`\`bash
# List your current subagents
botd bots list --parent "$BOTD_BOT_ID" --json

# Create a subagent (inherits your model & skills by default; --tool-scope can be all | readonly | custom)
botd bots create reviewer --node "$BOTD_NODE_ID" --parent "$BOTD_BOT_ID" \\
  --name "代码审查员" --desc "负责审查代码缺陷、安全漏洞与边界条件" \\
  --tool-scope readonly --system-file - << 'EOF'
你是一名严谨的代码审查专家，专注于发现逻辑缺陷、并发竞态与安全隐患。
EOF

# Update a subagent's prompt or permissions
botd bots update reviewer --desc "只读代码审计专家" --tool-scope readonly

# Delete a subagent
botd bots delete reviewer
\`\`\`

As soon as \`botd bots create\` returns, the subagent is synced to \`~/.botd/bots/<parentBotId>/agents/<subId>.md\` and can be invoked via \`Agent\` **immediately in the same turn**.

## 3. Dispatch subagents (ALWAYS use \`Agent\` / \`SubagentWorkflow\` tools, NOT \`@\`)

- **Single subagent task**: Call the \`Agent\` tool with \`subagent_type: "<subId>"\`, \`description: "<short title>"\`, \`prompt: "<detailed task>"\`, \`run_in_background: false\`.
- **Parallel subagents (并发执行)**: Emit multiple \`Agent\` tool calls **in the same assistant turn** (with \`run_in_background: false\`). They run concurrently and return all results to you in the same turn so you can synthesize the final answer.
- **Multi-stage pipeline / adversarial review loop**: Call the \`SubagentWorkflow\` tool with a workflow script using \`pipeline()\` or \`parallel()\`.
- **Workspace & \`worktree\` isolation**: By default, omit \`isolation\` so subagents work directly in your shared workspace. ONLY pass \`isolation: "worktree"\` when multiple subagents concurrently edit files in the same Git repo or when the user explicitly asks for an isolated branch/worktree.
- **Do NOT use \`@subId\` or \`-> (@sub1 @sub2)\` in your text reply to call your own subagents** — \`@\` / \`->\` is only for handing off the conversation turn in group chat. Use the \`Agent\` tool for subagent concurrency.

## 4. Control running / finished subagents (stop · steer · resume)

While a subagent runs (or after it finishes), the user may interrupt you mid-turn — e.g. "把 reviewer 停下", "告诉 coder 改用方案 B", "让 researcher 再查一下 X". Act on it immediately:

- **Stop one subagent** (without aborting your turn or other subagents): call \`stop_subagent\` with \`agent_id: "<id>"\` (the Agent tool returned it; the handle/type also works).
- **Mid-run redirect (steer)**: call \`steer_subagent\` with \`agent_id\` + \`message\`. The message is injected into the running subagent's conversation after its current tool execution.
- **Continue a finished subagent (resume)**: call \`Agent\` again with \`resume: "<agent_id>"\` and the follow-up \`prompt\` — it reuses the SAME subagent context (no re-explaining needed).
- When the user sends a new message while you are waiting for a foreground \`Agent\` call, the blocked wait is released automatically and the subagent keeps running in the background — read the user's new message and use the tools above as needed.

## 5. Cross-Bot Orchestration (跨主 BOT 协同编排)

Two delegation levels, pick by target:
- **Same workspace subagents** (your own role subagents): use the \`Agent\` / \`SubagentWorkflow\` tools (\`subagent_type: "<subId>"\`) — they share your workspace and memory.
- **Other primary BOTs** (across nodes, or isolated workspace/env/memory): also use the \`Agent\` tool (pass \`subagent_type: "@<botId>"\`, \`"bot:<botId>"\`, or \`"<botId>"\`) — the task runs in an isolated sub-session with zero-copy artifact sharing; delegate to \`@<botId>\` of any primary BOT that is not your own subagent.

### Cross-bot delegation via \`Agent\`

- **Inline wait (default)**: omit \`run_in_background\` (or set \`false\`) and pass \`subagent_type: "@<botId>"\`, \`prompt\`, optional \`title\` / \`artifact_ids\` / \`timeout_seconds\`. The call waits for the sub-session to finish and returns its reply plus any returned artifacts. Emit multiple \`Agent\` calls in the same assistant turn to run several BOTs in parallel.
- **Background (long tasks)**: set \`run_in_background: true\`. The sub-session runs asynchronously; the parent session is woken up automatically once all active sub-sessions finish (all-settled barrier).
- If the user sends a new message while you wait inline, the wait is released and the sub-session keeps running in the background — same handoff semantics as local subagents.

### Using the CLI

\`\`\`bash
botd sessions delegate "$BOTD_SESSION_ID" --bot <botId> --prompt "<task>" [--wait 300] [--artifacts art_1,art_2]
\`\`\`

\`--wait <seconds>\` blocks until the sub-session finishes and prints its reply (plus returned artifacts); without it the command returns immediately after creating the sub-session. \`--artifacts\` restricts which session artifacts are shared (default: all).

## 6. Cross-bot pipelines via \`SubagentWorkflow\` (跨 BOT 多阶段流水线与断点续跑)

\`SubagentWorkflow\` can orchestrate multi-stage pipelines that mix local subagents AND cross-bot steps in one script:
- \`agent("...", { agentType: "<subId>" })\` dispatches your local subagent (same workspace);
- \`agent("...", { agentType: "@<botId>" })\` (or \`"bot:<botId>"\`) force-delegates that step to another primary BOT's isolated sub-session — even on another node. Use \`{ schema }\` to demand validated JSON from a bot step, and \`phase("...")\` to group stages.

\`\`\`js
export const meta = { name: "release-pipeline", description: "Build once, test on two platforms" }
phase("Build")
const build = await agent("produce the release", {
  agentType: "@bot_builder",
  schema: { type: "object", properties: { version: { type: "string" } }, required: ["version"] },
});
const reports = await parallel([
  () => agent(\`test version \${build.version} on linux\`, { agentType: "@bot_tester_linux", phase: "Test" }),
  () => agent(\`test version \${build.version} on mac\`, { agentType: "@bot_tester_mac", phase: "Test" }),
]);
return { version: build.version, reports: reports.filter(Boolean) };
\`\`\`

**Crash-safe resume**: every run persists its script copy and a \`.workflow.jsonl\` checkpoint journal under \`<workspace>/.workflows/\`. A failed run's result text includes its \`runId\` — fix the broken bot/script and resume WITHOUT re-running completed steps (they replay from the journal cache):

\`\`\`
SubagentWorkflow({ scriptPath: "<workspace>/.workflows/wf_xxx.mjs", resumeFromRunId: "wf_xxx" })
\`\`\`

Resume replays the unchanged leading steps (completed ones are never re-called) and re-runs live from the first failed/changed step onward.
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

Bind form values to store keys via \`{ "$state": "/key" }\` (string for TextInput/Select, boolean for Switch, string[] for CheckboxGroup). On submit, form state and button params return as single-line JSON (\`botd ask --ui\` prints \`{ decision, state }\` to stdout).

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
4. Enable per bot: \`botd install <path> --bot "$BOTD_BOT_ID"\`, the Web bot editor, or \`botd bots update\`.

## Part 2: Full-Stack Extension Creator

Extension = \`~/.botd/extensions/<id>/index.ts\`, exporting a default factory:

\`\`\`typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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
botd install ~/.botd/extensions/deploy-guard --bot "$BOTD_BOT_ID"
botd install npm:@example/pi-tools@1.0.0 --bot "$BOTD_BOT_ID"
botd install git:github.com/owner/repo@v1.0.0 --bot "$BOTD_BOT_ID"

# 改完代码后热更新（daemon 重新加载资源清单并上报 Hub）
botd reload
botd bots update "$BOTD_BOT_ID" --extension deploy-guard
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
