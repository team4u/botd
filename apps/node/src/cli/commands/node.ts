import type { Command } from 'commander';
import { registerLifecycleCommands } from './node/lifecycle.js';
import { registerJoinCommands } from './node/join.js';
import { registerBgCommands } from './node/bg.js';
import { registerAskCommands } from './node/ask.js';
import { registerInstallCommands } from './node/install.js';

// Shared daemon-IPC helpers and approval-card builders stay importable from
// this module (used by artifacts.ts and the test suite).
export { requestOverSocket, postJsonOverSocket } from './node/shared.js';
export { buildApprovalCardSpec, extractApprovalDecision } from './node/approval-card.js';
export type { ApprovalCardInput, AskRiskLevel } from './node/approval-card.js';

export function registerNodeCommands(program: Command): void {
  registerLifecycleCommands(program);
  registerJoinCommands(program);
  registerBgCommands(program);
  registerAskCommands(program);
  registerInstallCommands(program);
}
