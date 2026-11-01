import { readSkill, writeSkill } from './storage.js';

/**
 * The framework's self-description, taught to every BOT as an always-on skill.
 * Managed by botd: re-written when the version marker below changes; user edits
 * survive until the framework ships a newer version.
 */
export const BUILTIN_SKILL_ID = 'botd-cli';
export const BUILTIN_SKILL_VERSION = 5;
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
- \`botd ask "<prompt>" [--options "确认,取消"] [--timeout 300]\` — human-in-the-loop interactive card in Web chat; prints the user's selected option or text answer to stdout.
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
