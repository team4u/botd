import fs from 'node:fs/promises';
import { CliError } from './errors.js';

/**
 * Read command content: from a file, or from stdin (`--file -` or omitted).
 * Fails fast with an actionable message when stdin is a terminal.
 */
export async function readInput(file?: string): Promise<string> {
  if (!file || file === '-') {
    if (process.stdin.isTTY) {
      throw new CliError('No input provided. Pass --file <path> or pipe content through stdin.');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    throw new CliError(`Cannot read file ${file}: ${(err as Error).message}`);
  }
}
