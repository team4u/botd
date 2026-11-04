import type { Command } from 'commander';
import { registerLifecycleCommands } from './node/lifecycle.js';
import { registerJoinCommands } from './node/join.js';

// Shared daemon-IPC helpers stay importable from this module
// (used by artifacts.ts and the test suite).
export { requestOverSocket, postJsonOverSocket } from './node/shared.js';

export function registerNodeCommands(program: Command): void {
  registerLifecycleCommands(program);
  registerJoinCommands(program);
}
