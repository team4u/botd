import { readSkill, writeSkill } from './storage.js';

/**
 * The framework's self-description, taught to every BOT as an always-on skill.
 * Managed by botd: re-written when the version marker below changes; user edits
 * survive until the framework ships a newer version.
 */
export const BUILTIN_SKILL_ID = 'botd-cli';
export const BUILTIN_SKILL_VERSION = 2;
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
  Node commands never need login.

## Node commands (this machine, no login)

- \`botd status\` — daemon pid, uptime, Hub connection state.
- \`botd wake --session "$BOTD_SESSION_ID" --bot "$BOTD_BOT_ID" --message "<result>"\`
  — deliver a result into the session later, from a detached background job.
- \`botd install <source>\` — install a skill/extension; live daemon hot-reloads it.

### Async pattern (long tasks)

Reply to the user first ("working on it, will report back"), launch the job detached,
then call \`botd wake\` when it finishes so your BOT reports back in the session:

\`\`\`bash
(sleep 30 && botd wake --session "$BOTD_SESSION_ID" --bot "$BOTD_BOT_ID" --message "build done: 42 tests passed") &
\`\`\`

### Restart warning

\`botd restart\` / \`botd stop\` kill the daemon AND every in-flight turn — including
yours. Never run them mid-turn. If a restart is genuinely required, finish your reply
and schedule it detached: \`(sleep 5 && botd restart -d & disown; exit 0)\`.

## Hub commands (admin, require login)

- \`botd nodes list --json\` — all nodes with their bots/status/pid.
- \`botd sessions list --json\` / \`botd sessions messages <id> --json\`.
- \`botd chat send <sessionId> "<message>" --wait 120 --json\` — post a message to
  another session and wait for its BOTs to answer (bot-to-bot communication).
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
