import type { MessageRecord, SessionMode, SessionRecord } from '@botd/protocol';
import { Command, Option } from 'commander';
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
    .option('--member <ids...>', 'Member bot IDs')
    .addOption(
      new Option('--mode <mode>', 'Session mode')
        .choices(['direct', 'lead', 'roundtable'])
        .default('direct'),
    )
    .action(
      cliAction(async (options, command) => {
        const g = readGlobals(command);
        const client = await HubClient.connect(g);

        const title = String(options.title).trim();
        const leadBotId = String(options.lead).trim();
        const mode = String(options.mode) as SessionMode;

        const rawMembers = Array.isArray(options.member)
          ? (options.member as string[]).map((id) => String(id).trim())
          : undefined;
        const members = rawMembers ? [...rawMembers] : [leadBotId];
        if (!members.includes(leadBotId)) {
          members.push(leadBotId);
        }
        const memberBotIds = [...new Set(members)];

        const session = await client.post<SessionRecord>('/api/sessions', {
          title,
          mode,
          leadBotId,
          memberBotIds,
        });
        printResult(session, g.json);
      }),
    );

  sessions
    .command('update <sessionId>')
    .description('Update a chat session')
    .option('--title <title>', 'Session title')
    .option('--lead <botId>', 'Lead bot ID')
    .option('--member <ids...>', 'Member bot IDs')
    .option('--archive <boolean>', 'Archive (true) or restore (false) the session', (v: string) => v !== 'false')
    .addOption(
      new Option('--mode <mode>', 'Session mode').choices(['direct', 'lead', 'roundtable']),
    )
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
        }
        if (typeof options.mode === 'string') {
          body.mode = options.mode as SessionMode;
        }
        if (typeof options.archive === 'boolean') {
          body.archived = options.archive;
        }
        if (Array.isArray(options.member)) {
          const members = (options.member as string[]).map((id) => String(id).trim());
          const lead =
            typeof body.leadBotId === 'string'
              ? (body.leadBotId as string)
              : typeof options.lead === 'string'
                ? options.lead.trim()
                : undefined;
          if (lead && !members.includes(lead)) {
            members.push(lead);
          }
          body.memberBotIds = [...new Set(members)];
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
}
