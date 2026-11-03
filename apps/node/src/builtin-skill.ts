import { readSkill, writeSkill } from './storage.js';

/**
 * The framework's self-description, taught to every BOT as an always-on skill.
 * Managed by botd: re-written when the version marker below changes; user edits
 * survive until the framework ships a newer version.
 */
export const BUILTIN_SKILL_ID = 'botd-cli';
export const BUILTIN_SKILL_VERSION = 10;
const VERSION_MARKER = `<!-- botd-skill: ${BUILTIN_SKILL_ID} v${BUILTIN_SKILL_VERSION} -->`;

export const BUILTIN_SKILL_MD = `${VERSION_MARKER}
# botd CLI — this framework's control plane

You are running inside botd (a multi-node BOT platform). The \`botd\` command controls
everything: this machine's daemon and, after login, the Hub (nodes/bots/sessions/chat).

## Rules

- ALWAYS pass \`--json\` when you plan to parse output; success → JSON on stdout,
  failure → \`error: <message>\` on stderr with a non-zero exit code.
- Discover exact flags with \`botd <command> --help\` (works at every level, e.g.
  \`botd sessions create --help\`). Do not guess option names.
- Hub commands need a one-time \`botd login <hubUrl> --username <user> --password <pwd>\` on this machine
  (username defaults to admin; password also via \`BOTD_ADMIN_PASSWORD\` in the environment).
  Exception: once this machine's node is paired (\`~/.botd/node.json\` exists), Hub admin commands
  automatically authenticate with the node credentials — no manual \`botd login\` needed.
  Node commands never need login.

## Node commands (this machine, no login)

- \`botd status\` — daemon pid, uptime, Hub connection state.
- \`botd wake --session "$BOTD_SESSION_ID" --bot "$BOTD_BOT_ID" --message "<result>" [--reply-to <botId>]\`
  — deliver a result into the session later, from a detached background job.
  - \`--delay <30s|15m|2h|1d>\` — persistent one-shot delayed wake: the Hub stores a once-trigger
    and fires the message later (survives daemon restarts).
  - \`--no-turn\` — silent progress report: the message appears on the session screen without
    consuming an LLM inference turn.
- \`botd ask "<prompt>" [--options "确认,取消"] [--timeout 300] [--ui] [--file <path> | --stdin]\` — human-in-the-loop interactive card in Web chat; prints the user's selected option, text answer, or Generative UI form result JSON to stdout.
  - \`botd ask "<prompt>" --risk low|medium|high [--reason "<why>"] [--resource "<target>"] [--file <path>] [--options "批准,拒绝"]\`
    — one-shot structured risk approval card: auto-builds a Generative UI card (risk callout,
    target resource list, optional diff/content preview accordion, approve/reject buttons).
    Without \`--json\` the chosen decision (e.g. \`批准\`) prints as plain text, so
    \`choice=$(botd ask ... --risk high ...)\` works directly in shell scripts. Custom
    \`--options "A,B,C"\` replace the default 批准/拒绝 buttons; a hand-written spec via
    \`--ui\` takes precedence over the auto-generated card.
- \`botd artifact put <filePath> [--message "<description>"]\` — upload a local file from this node to the session as a shared artifact (visible in Web UI and downloadable by bots on other nodes).
- \`botd artifact pull <artifactId> [-o <outputPath>]\` — pull a shared artifact from the session into this node's workspace.
- \`botd artifact list\` — list shared artifacts in the current session.
- \`botd install <source>\` — install a skill/extension; live daemon hot-reloads it.

### Async pattern (long tasks)

Prefer \`botd bg run\` — the daemon-managed way (auto log capture + auto wake-up on exit):

\`\`\`bash
botd bg run --bot "$BOTD_BOT_ID" -- make test  # logs to <workspace>/.bg/<jobId>.log
botd bg list                                   # job id / status / exit code
botd bg logs bg_ab12cd34 --lines 50            # tail a job log
botd bg kill bg_ab12cd34                       # stop a running job
\`\`\`

When the command exits, the daemon automatically reports the result (exit code + last ~20 log
lines) back into the session. Use \`--no-turn\` for silent log-only delivery.

The raw detached-shell alternative (no management, no auto report):

\`\`\`bash
(sleep 30 && botd wake --session "$BOTD_SESSION_ID" --bot "$BOTD_BOT_ID" --message "build done: 42 tests passed") &
\`\`\`

### Restart warning

\`botd restart\` / \`botd stop\` kill the daemon AND every in-flight turn — including
yours. Never run them mid-turn. If a restart is genuinely required, finish your reply
and schedule it detached: \`(sleep 5 && botd restart -d & disown; exit 0)\`.

## Subagents (子代理：创建、管理与并发调度)

Each node can host one or more primary BOTs (each with an isolated workspace, memory, and env, such as \`$BOTD_BOT_ID\` on node \`$BOTD_NODE_ID\`), and each primary BOT can have multiple **role subagents (子代理)**.
Subagents share your workspace by default, appear under you in the Web sidebar, and can be dispatched in parallel via your built-in \`Agent\` and \`SubagentWorkflow\` tools.

### 1. Create & manage subagents via CLI

When the user asks you to create subagents/personas or you need specialized roles (e.g. coder, reviewer, researcher, writer), create them directly with \`botd bots\`:

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

### 2. Dispatch subagents (ALWAYS use \`Agent\` / \`SubagentWorkflow\` tools, NOT \`@\`)

- **Single subagent task**: Call the \`Agent\` tool with \`subagent_type: "<subId>"\`, \`description: "<short title>"\`, \`prompt: "<detailed task>"\`, \`run_in_background: false\`.
- **Parallel subagents (并发执行)**: Emit multiple \`Agent\` tool calls **in the same assistant turn** (with \`run_in_background: false\`). They run concurrently and return all results to you in the same turn so you can synthesize the final answer.
- **Multi-stage pipeline / adversarial review loop**: Call the \`SubagentWorkflow\` tool with a workflow script using \`pipeline()\` or \`parallel()\`.
- **Workspace & \`worktree\` isolation**: By default, omit \`isolation\` so subagents work directly in your shared workspace. ONLY pass \`isolation: "worktree"\` when multiple subagents concurrently edit files in the same Git repo or when the user explicitly asks for an isolated branch/worktree.
- **Do NOT use \`@subId\` or \`-> (@sub1 @sub2)\` in your text reply to call your own subagents** — \`@\` / \`->\` is only for handing off the conversation turn in group chat. Use the \`Agent\` tool for subagent concurrency.

### 3. Control running / finished subagents (stop · steer · resume)

While a subagent runs (or after it finishes), the user may interrupt you mid-turn — e.g. "把 reviewer 停下", "告诉 coder 改用方案 B", "让 researcher 再查一下 X". Act on it immediately:

- **Stop one subagent** (without aborting your turn or other subagents): call \`stop_subagent\` with \`agent_id: "<id>"\` (the Agent tool returned it; the handle/type also works).
- **Mid-run redirect (steer)**: call \`steer_subagent\` with \`agent_id\` + \`message\`. The message is injected into the running subagent's conversation after its current tool execution.
- **Continue a finished subagent (resume)**: call \`Agent\` again with \`resume: "<agent_id>"\` and the follow-up \`prompt\` — it reuses the SAME subagent context (no re-explaining needed).
- When the user sends a new message while you are waiting on a foreground \`Agent\` call, the blocked wait is released automatically and the subagent keeps running in the background — read the user's new message and use the tools above as needed.

## Cross-Bot Orchestration (跨主 BOT 协同编排)

Two delegation levels, pick by target:
- **Same workspace subagents** (your own role subagents): use the \`Agent\` / \`SubagentWorkflow\` tools — they share your workspace and memory.
- **Other primary BOTs** (across nodes, or isolated workspace/env/memory): use the \`delegate_bot\` tool — the task runs in an isolated sub-session with zero-copy artifact sharing; delegate to \`@<botId>\` of any primary BOT that is not your own subagent.

### Using \`delegate_bot\`

- **Inline wait (default)**: omit \`run_in_background\` (or set \`false\`) and pass \`bot_id\`, \`prompt\`, optional \`title\` / \`artifact_ids\` / \`timeout_seconds\`. The call waits for the sub-session to finish and returns its reply plus any returned artifacts. Emit multiple \`delegate_bot\` calls in the same assistant turn to run several BOTs in parallel.
- **Background (long tasks)**: set \`run_in_background: true\`. The sub-session runs autonomously; the parent session is woken up automatically once all active sub-sessions finish (all-settled barrier).
- If the user sends a new message while you wait inline, the wait is released and the sub-session keeps running in the background — same handoff semantics as the \`Agent\` tool.

### Using the CLI

\`\`\`bash
botd sessions delegate "$BOTD_SESSION_ID" --bot <botId> --prompt "<task>" [--wait 300] [--artifacts art_1,art_2]
\`\`\`

\`--wait <seconds>\` blocks until the sub-session finishes and prints its reply (plus returned artifacts); without it the command returns immediately after creating the sub-session. \`--artifacts\` restricts which session artifacts are shared (default: all).

### Cross-bot pipelines via \`SubagentWorkflow\` (跨 BOT 多阶段流水线与断点续跑)

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

## Generative UI (Dynamic Cards, Interactive Forms & Concept Deep-Dives)

botd supports dynamic UI components rendered natively via json-render:

1. In-chat display UI: Output a \`\`\`ui (or \`\`\`json-render) code fence containing a valid JSON Spec.
2. Interactive forms / approvals: \`botd ask "<prompt>" --ui --stdin << 'EOF' ... EOF\` (outputs \`{ decision, state }\` JSON to stdout) or inspect catalog via \`botd ask --ui-schema\`.
3. Spec top-level: \`{ root: string, elements: Record<string, BotdUiElement>, state?: Record<string, unknown> }\`.
4. Component catalog (15 components):
   - Layout & Display:
     - \`Stack\`: \`{ direction?: 'vertical' | 'horizontal', gap?: 'sm' | 'md' }\`
     - \`Card\`: \`{ title: string, subtitle?: string, badge?: string, icon?: string }\`
     - \`Tabs\`: \`{ tabs: Array<{ id: string, label: string, icon?: string }>, defaultTab?: string }\` (children mapped 1:1 or via slots: { [id]: [childKey] })
     - \`Accordion\`: \`{ items: Array<{ title: string, content?: string, defaultOpen?: boolean, icon?: string, badge?: string }> }\`
   - Metrics & Comparison:
     - \`MetricGrid\`: \`{ columns?: 2 | 3 | 4 }\`
     - \`MetricCard\`: \`{ label: string, value: string, hint?: string, status?: 'ok' | 'warn' | 'error', trend?: 'up' | 'down' | 'flat', icon?: string }\`
     - \`BarList\`: \`{ items: Array<{ label: string, value: number, max?: number, displayValue?: string, color?: 'blue'|'emerald'|'amber'|'rose'|'purple' }>, title?: string }\`
     - \`KeyValueList\`: \`{ items: Array<{ key: string, value: string, mono?: boolean, badge?: string }> }\`
   - Explanation & Flows:
     - \`Callout\`: \`{ title?: string, content: string, variant?: 'info' | 'tip' | 'warn' | 'error', icon?: string }\`
     - \`Steps\`: \`{ items: Array<{ title: string, description?: string, status?: 'done' | 'current' | 'pending', icon?: string, badge?: string }> }\`
   - Form Inputs & Actions:
     - \`TextInput\`: \`{ label: string, value?: string | { "$state": "/key" }, placeholder?: string, hint?: string }\`
     - \`Select\`: \`{ label: string, value?: string | { "$state": "/key" }, options: Array<{ value: string, label: string }> }\`
     - \`Switch\`: \`{ label: string, checked?: boolean | { "$state": "/key" }, hint?: string }\`
     - \`ActionBar\`: \`{ align?: 'left' | 'right' | 'between' }\`
     - \`Button\`: \`{ label: string, variant?: 'primary' | 'secondary' | 'danger' }, on.press: { action: 'submit', params?: { decision?: string } }\`
   - State binding: Bind form values to store keys via \`{ "$state": "/key" }\`. On submit, form state and button params return as single-line JSON.
   - Semantic icons: lightbulb, info, alert-triangle, check-circle, cpu, database, server, hard-drive, activity, layers, terminal, code, git-branch, workflow, shield, lock, globe, zap, clock, sparkles, book-open, file-text, box, help-circle, etc.

## Skill creator

When the user asks to save a workflow/method as a skill ("沉淀为技能", "记住这个流程"),
or you have just mastered a reusable procedure on this machine, distill it yourself:

1. Write \`~/.botd/skills/<skill-id>/SKILL.md\` (from your workspace:
   \`../../../skills/<skill-id>/SKILL.md\`). Choose a short lowercase id (a-z0-9-).
2. Format:
   - YAML frontmatter: \`name: <skill-id>\` and \`description: <one line — when to use this>\`.
   - Body sections: **When to use** / **Steps** (exact commands, copy-pasteable) / **Gotchas**.
   - Keep it under ~80 lines; include only what a fresh session needs to succeed.
3. Run \`botd reload\` so the daemon re-registers resources and the skill appears in the Web UI.
4. The skill still needs enabling per bot (Web bot editor or \`botd bots update --help\`).

Distill from what you actually did this session — real commands that worked, real paths,
real failure modes. No placeholders, no invented flags.

## Hub commands (admin, require login)

- \`botd nodes list --json\` — all nodes with their bots/status/pid.
- \`botd sessions list --json\` / \`botd sessions messages <id> --json\` /
  \`botd sessions search <query> --json\` — search message history across all sessions.
- \`botd sessions delegate <parentSessionId> --bot <botId> --prompt "<task>"\` — delegate a sub-task to a child session executed by the specified bot.
- \`botd chat send <sessionId> "<message>" --wait 120 --json\` — post a message to
  another session and wait for its BOTs to answer (bot-to-bot communication).
- \`botd bots env list <botId>\` / \`botd bots env set <botId> <KEY> <value>\` /
  \`botd bots env unset <botId> <KEY>\` — per-bot environment variables, injected into the
  bot's turns and background jobs on its node.
- \`botd bots/skills/extensions/providers/models <subcommand>\` — full
  management surface, same capabilities as the Web UI. Use \`--help\` to explore.
`;

/** Ensure the builtin skill exists at the current version. Safe to call on every start. */
export async function ensureBuiltinSkill(dataDir: string): Promise<void> {
  let current: string;
  try {
    current = await readSkill(dataDir, BUILTIN_SKILL_ID);
  } catch {
    current = '';
  }
  if (current.includes(VERSION_MARKER)) return; // up to date (or user-edited at this version)
  await writeSkill(dataDir, BUILTIN_SKILL_ID, BUILTIN_SKILL_MD);
}
