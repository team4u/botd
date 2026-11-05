import type { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { readInput } from '../input.js';
import { printResult } from '../render.js';

/**
 * 事件摄入（EventRouter 管线）命令：把 GitHub/CI/自定义事件投递给
 * Super-agent，由 threadKey 直通 Worker 或 Router 决定处理路径。
 */
export function registerEventsCommands(program: Command): void {
  const events = program.command('events').description('Event ingestion for the Super-agent EventRouter');

  events
    .command('ingest')
    .description('Ingest an external event (github / ci / custom ...) into the EventRouter pipeline')
    .requiredOption('--source <source>', 'Event source (e.g. github, ci, custom)')
    .requiredOption('--type <type>', 'Event type (e.g. check_suite.completed, issue_comment)')
    .option('--content <content>', 'Event content/payload text')
    .option('--file <path>', 'Read event content from a file (or - for stdin)')
    .option('--title <title>', 'Event summary title (default: truncated content)')
    .option('--sender <sender>', 'Event sender identity (default: anonymous)')
    .option('--repo <repo>', 'Repository the event belongs to (e.g. owner/repo)')
    .option('--pr <number>', 'Pull request number')
    .option('--issue <number>', 'Issue number')
    .option('--branch <branch>', 'Branch name the event belongs to')
    .option('--session <sessionId>', 'Target botd session (routes to its Router conversation)')
    .option('--bot <botId>', 'Default bot persona to route the event to')
    .action(cliAction(async (options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);

      const content = typeof options.content === 'string'
        ? options.content
        : typeof options.file === 'string' && options.file
          ? await readInput(options.file)
          : undefined;

      const parseNumber = (value: unknown): number | undefined => {
        if (value === undefined) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
      };

      const result = await client.post<Record<string, unknown>>('/api/events/ingest', {
        source: String(options.source).trim(),
        type: String(options.type).trim(),
        ...(content !== undefined ? { content } : {}),
        ...(typeof options.title === 'string' && options.title ? { title: options.title } : {}),
        ...(typeof options.sender === 'string' && options.sender ? { sender: options.sender } : {}),
        ...(typeof options.repo === 'string' && options.repo ? { repo: options.repo } : {}),
        ...(typeof options.branch === 'string' && options.branch ? { branch: options.branch } : {}),
        ...(parseNumber(options.pr) !== undefined ? { prNumber: parseNumber(options.pr) } : {}),
        ...(parseNumber(options.issue) !== undefined ? { issueNumber: parseNumber(options.issue) } : {}),
        ...(typeof options.session === 'string' && options.session ? { sessionId: options.session } : {}),
        ...(typeof options.bot === 'string' && options.bot ? { botId: options.bot } : {}),
      });
      printResult(result, g.json);
    }));
}
