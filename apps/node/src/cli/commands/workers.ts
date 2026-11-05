import type { Command } from 'commander';
import { Option } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

/** GET /api/sessions/:id/workers 列表项（与 Web 端 SuperAgentWorkerItem 对齐）。 */
interface WorkerListItem {
  workerId: string;
  conversationId: string;
  parentSessionId: string;
  botId: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  nodeId?: string;
  cwd?: string;
  worktreePath?: string;
  sessionTitle?: string;
  workspaceDir?: string;
  threadKeys: string[];
  startedAt: string;
  updatedAt?: string;
  summary?: string;
}

interface WorkersListResult {
  workers: WorkerListItem[];
}

/**
 * Super-agent 后台工作单元（Workers）生命周期命令，1:1 映射 Hub 路由：
 * list / spawn / steer / stop / recall。
 */
export function registerWorkersCommands(program: Command): void {
  const workers = program.command('workers').description('Super-agent background workers (list/spawn/steer/stop/recall)');

  workers
    .command('list [sessionId]')
    .description('List background workers (of a session, or globally across all sessions when sessionId is omitted)')
    .action(cliAction(async (sessionId: string | undefined, _options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);
      const path =
        typeof sessionId === 'string' && sessionId.trim()
          ? `/api/sessions/${encodeURIComponent(sessionId.trim())}/workers`
          : '/api/workers';
      const result = await client.get<WorkersListResult>(path);
      printResult(result.workers, g.json);
    }));

  workers
    .command('spawn <sessionId>')
    .description('Spawn a background worker for multi-step work (returns immediately)')
    .requiredOption('--title <title>', 'Short task title shown in the worker list')
    .requiredOption('--task <prompt>', 'Full task instructions for the worker')
    .option('--bot <botId>', 'Bot persona the worker runs as (default: session lead bot)')
    .option('--worktree', 'Give the worker an isolated git worktree')
    .option('--thread-key <keys...>', 'Channel thread key(s) the worker feeds')
    .action(cliAction(async (sessionId: string, options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);
      const threadKeys = (options.threadKey as string[] | undefined) ?? [];
      const result = await client.post<{ ok: true; worker: WorkerListItem }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/workers`,
        {
          title: String(options.title).trim(),
          task: String(options.task).trim(),
          ...(typeof options.bot === 'string' && options.bot ? { botId: options.bot } : {}),
          worktree: options.worktree === true,
          ...(threadKeys.length > 0 ? { threadKey: threadKeys[0], threadKeys } : {}),
        },
      );
      printResult(result.worker, g.json);
    }));

  workers
    .command('steer <sessionId> <workerId> <message...>')
    .description('Send a message to a worker: steer mid-run, or queue a follow-up')
    .addOption(
      new Option('--mode <mode>', 'steer (interrupt mid-run) or followUp (queue after current run)')
        .choices(['steer', 'followUp'])
        .default('steer'),
    )
    .action(cliAction(async (sessionId: string, workerId: string, message: string[], options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const text = message.join(' ').trim();
      if (!text) throw new Error('Provide the steer message as trailing arguments');
      const client = await HubClient.connect(g);
      const result = await client.post<{ ok: true }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/workers/${encodeURIComponent(workerId)}/steer`,
        { message: text, mode: options.mode === 'followUp' ? 'followUp' : 'steer' },
      );
      printResult(result, g.json);
    }));

  workers
    .command('stop <sessionId> <workerId>')
    .description('Abort a running worker (other workers and the session are unaffected)')
    .action(cliAction(async (sessionId: string, workerId: string, _options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);
      const result = await client.post<{ ok: true }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/workers/${encodeURIComponent(workerId)}/stop`,
      );
      printResult(result, g.json);
    }));

  workers
    .command('recall <sessionId> <workerId>')
    .description('Recall a worker: its Chain-of-Recall node and recent transcript')
    .action(cliAction(async (sessionId: string, workerId: string, _options: Record<string, unknown>, command: Command) => {
      const g = readGlobals(command);
      const client = await HubClient.connect(g);
      const result = await client.get<{ node: unknown; transcript: unknown }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/workers/${encodeURIComponent(workerId)}/recall`,
      );
      printResult(result, g.json);
    }));
}
