import type {
  DelegateSessionInput,
  DelegateSessionResult,
  MessageRecord,
  MessageSearchHit,
  SessionRecord,
  SessionShareRecord,
} from '@botd/protocol';
import { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

export function registerSessionsCommands(program: Command): void {
  const sessions = program.command('sessions').description('Session management');

  sessions
    .command('list')
    .description('List all chat sessions')
    .action(
      cliAction(async (_options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);
        const list = await client.get<SessionRecord[]>('/api/sessions');
        printResult(list, g.json);
      }),
    );

  sessions
    .command('create')
    .description('Create a new chat session')
    .requiredOption('--title <title>', 'Session title')
    .requiredOption('--lead <botId>', 'Lead bot ID')
    .action(
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);

        const title = String(options.title).trim();
        const leadBotId = String(options.lead).trim();

        const session = await client.post<SessionRecord>('/api/sessions', {
          title,
          mode: 'direct',
          leadBotId,
          memberBotIds: [leadBotId],
        });
        printResult(session, g.json);
      }),
    );

  sessions
    .command('update <sessionId>')
    .description('Update a chat session')
    .option('--title <title>', 'Session title')
    .option('--lead <botId>', 'Lead bot ID')
    .option('--archive <boolean>', 'Archive (true) or restore (false) the session', (v: string) => v !== 'false')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);

        const body: Record<string, unknown> = {};
        if (typeof options.title === 'string') {
          body.title = options.title.trim();
        }
        if (typeof options.lead === 'string') {
          body.leadBotId = options.lead.trim();
          body.memberBotIds = [options.lead.trim()];
        }
        if (typeof options.archive === 'boolean') {
          body.archived = options.archive;
        }

        const updated = await client.patch<SessionRecord>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          body,
        );
        printResult(updated, g.json);
      })(options, command),
    );

  sessions
    .command('messages <sessionId>')
    .description('List message history of a session')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const messages = await client.get<MessageRecord[]>(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        );
        printResult(messages, g.json);
      })(options, command),
    );

  sessions
    .command('search <query...>')
    .description('Search messages across all sessions (or within --session)')
    .option('--session <sessionId>', 'Filter by session ID')
    .option('--limit <n>', 'Max results (default 30)', '30')
    .action((query: string[], options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const q = query.join(' ').trim();
        if (!q) {
          throw new Error('Provide the search query as trailing arguments');
        }
        const client = await HubClient.connect(g);
        const params = new URLSearchParams({ q });
        if (typeof options.session === 'string' && options.session.trim()) {
          params.set('sessionId', options.session.trim());
        }
        const rawLimit = Number(options.limit);
        if (Number.isFinite(rawLimit) && rawLimit > 0) {
          params.set('limit', String(Math.floor(rawLimit)));
        }
        const hits = await client.get<MessageSearchHit[]>(`/api/messages/search?${params.toString()}`);
        printResult(hits, g.json);
      })(options, command),
    );

  sessions
    .command('cancel <sessionId>')
    .description('Cancel an active session turn')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const res = await client.post<{ ok: boolean }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
        );
        printResult(res, g.json);
      })(options, command),
    );

  sessions
    .command('delete <sessionId>')
    .description('Delete a session and all its messages (bot memory is reset)')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const res = await client.delete<{ ok: boolean }>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
        );
        printResult(res, g.json);
      })(options, command),
    );

  sessions
    .command('clear <sessionId>')
    .description('Clear message history of a session and reset bot memory')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const res = await client.delete<{ ok: boolean }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        );
        printResult(res, g.json);
      })(options, command),
    );

  sessions
    .command('edit <sessionId> <messageId> [words...]')
    .description('Edit a sent user message; later replies are removed and regenerated')
    .action((sessionId: string, messageId: string, words: string[], options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const content = words.join(' ').trim();
        if (!content) {
          throw new Error('Provide the new message content as trailing arguments');
        }
        const client = await HubClient.connect(g);
        const updated = await client.put<MessageRecord>(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
          { content },
        );
        printResult(updated, g.json);
      })(options, command),
    );

  sessions
    .command('fork <sessionId>')
    .description('Fork a new session from an anchor message (history up to it is copied)')
    .requiredOption('--anchor <messageId>', 'Anchor message ID to fork from')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const forked = await client.post<SessionRecord>(
          `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
          { anchorMessageId: String(options.anchor).trim() },
        );
        printResult(forked, g.json);
      })(options, command),
    );

  sessions
    .command('share <sessionId>')
    .description('Create, view or revoke a public share link for a session')
    .option('--revoke', 'Revoke the existing share link')
    .option('--regenerate', 'Regenerate a new share token')
    .action((sessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);

        if (options.revoke) {
          const res = await client.delete<{ ok: boolean }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/share`,
          );
          printResult(res, g.json);
          return;
        }

        const share = await client.post<SessionShareRecord>(
          `/api/sessions/${encodeURIComponent(sessionId)}/share`,
          { regenerate: Boolean(options.regenerate) },
        );
        const shareUrl = `${client.url}/?share=${encodeURIComponent(share.token)}`;
        printResult({ ...share, url: shareUrl }, g.json);
      })(options, command),
    );

  sessions
    .command('delegate <parentSessionId>')
    .description('Delegate a task to a sub-session executed by a bot')
    .requiredOption('--bot <botId>', 'Bot ID to execute the task')
    .requiredOption('--prompt <prompt>', 'Task prompt for the sub-session')
    .option('--title <title>', 'Sub-session title')
    .action((parentSessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const input: DelegateSessionInput = {
          botId: String(options.bot).trim(),
          prompt: String(options.prompt).trim(),
          mode: 'direct',
        };
        if (typeof options.title === 'string' && options.title.trim()) {
          input.title = options.title.trim();
        }
        const result = await client.post<DelegateSessionResult>(
          `/api/sessions/${encodeURIComponent(parentSessionId)}/delegate`,
          input,
        );
        printResult(result, g.json);
      })(options, command),
    );

  sessions
    .command('subsessions <parentSessionId>')
    .description('List sub-sessions of a parent session')
    .action((parentSessionId: string, options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const list = await client.get<SessionRecord[]>(
          `/api/sessions/${encodeURIComponent(parentSessionId)}/subsessions`,
        );
        printResult(list, g.json);
      })(options, command),
    );
}
