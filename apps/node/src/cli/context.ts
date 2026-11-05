import type { Command } from 'commander';
import { getDataDir } from '../storage.js';
import { describeError } from './errors.js';

export interface Globals {
  json: boolean;
  dataDir: string;
  /** --hub override, trailing slashes stripped. */
  hubUrl?: string;
  /** --password flag or BOTD_ADMIN_PASSWORD. */
  password?: string;
  timeoutMs: number;
}

/** Resolve program-level options (available to every subcommand) into a typed context. */
export function readGlobals(command: Command): Globals {
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const hubUrl = typeof opts.hub === 'string' && opts.hub.trim() ? opts.hub.trim().replace(/\/+$/, '') : undefined;
  const password =
    typeof opts.password === 'string' && opts.password ? opts.password : process.env.BOTD_ADMIN_PASSWORD || undefined;
  const timeoutSeconds = Number(opts.timeout);
  return {
    json: opts.json === true,
    dataDir: getDataDir(typeof opts.dataDir === 'string' ? opts.dataDir : undefined),
    hubUrl,
    password,
    timeoutMs: (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30) * 1000,
  };
}

/**
 * Wrap a commander action: guarantees `error: <message>` on stderr (JSON form under --json)
 * and exit code 1, so AI callers get deterministic failure semantics.
 *
 * The action receives Commander's trailing arguments verbatim: positional args
 * first, then `options`, then the `Command` instance — e.g. a command declared
 * as `<a> [b...]` gets `(a, b, options, command)`. Commands without positional
 * args therefore get the familiar `(options, command)` shape.
 */
export function cliAction(action: (...args: any[]) => Promise<void>) {
  return async (...cliArgs: any[]): Promise<void> => {
    try {
      await action(...cliArgs);
    } catch (error) {
      const { message } = describeError(error);
      let json = false;
      try {
        json = readGlobals(cliArgs[cliArgs.length - 1]).json;
      } catch {
        // fall through to plain error output
      }
      if (json) console.error(JSON.stringify({ error: message }));
      else console.error(`error: ${message}`);
      process.exitCode = 1;
    }
  };
}
