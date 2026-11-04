import type { Command } from 'commander';
import { cliAction, readGlobals } from '../context.js';
import { HubClient } from '../hub-client.js';
import { printResult } from '../render.js';

/**
 * Watchdog 健康诊断：结构化健康报告；--run-pass 先跑一轮主动巡检。
 */
export function registerWatchdogCommands(program: Command): void {
  const watchdog = program.command('watchdog').description('System health diagnostics for the durable runtime');

  watchdog
    .command('health')
    .description('Show structured health diagnostics (healthy / summary / findings)')
    .option('--run-pass', 'Run a proactive watchdog pass before diagnosing')
    .action((options: Record<string, unknown>, command: Command) =>
      cliAction(async (_opts, cmd) => {
        const g = readGlobals(cmd);
        const client = await HubClient.connect(g);
        const query = options.runPass === true ? '?runPass=1' : '';
        const result = await client.get<{ healthy: boolean; summary: string; findings: unknown[]; interventions: unknown[] }>(
          `/api/watchdog/health${query}`,
        );
        printResult(result, g.json);
      })(options, command),
    );
}
