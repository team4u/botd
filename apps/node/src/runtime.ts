/**
 * runtime 模块的对外门面（桶文件）：历史导入路径 ./runtime.js 全部继续可用，
 * 实现拆分在 ./runtime/ 下的单一职责模块中。
 *
 * 拆分动机：原 1900+ 行单文件混合了 CLI 包装器、shell 环境、自动化事件解析、
 * 工具摘要脱敏、回合编排、子代理控制六种职责，且 session 事件拼装存在三份平行实现。
 */

export { ensureBotdBinWrapper, getTsxLoaderUrl, resolveCliEntry } from './runtime/bin-wrapper.js';
export { buildBotShellEnv, getDataDirSafe } from './runtime/shell-env.js';
export {
  detectAutomationEvent,
  buildAutomationEventEnv,
  type AutomationEventEnv,
} from './runtime/automation-event.js';
export {
  extractToolSummary,
  extractToolOutputPreview,
  sanitizeToolArgs,
} from './runtime/tool-preview.js';
export { executeBotTurn, type BotTurnResult } from './runtime/execute-turn.js';
export {
  turnSignature,
  runTurnWithResilience,
  clearTurnReceipt,
} from './runtime/turn-receipt.js';
export { getBotCommands } from './runtime/commands-bridge.js';
export { runRegistry, getActiveSessionCount } from './runtime/run-registry.js';
export { resetBotSession, cancelBotTurn, cancelAllBotTurns } from './runtime/turn-lifecycle.js';
export {
  setRuntimeHubRpc,
  steerBotTurn,
  stopSubagent,
  interactSubagent,
} from './runtime/subagent-control.js';
