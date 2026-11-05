/**
 * runtime 模块的对外门面（桶文件）：历史导入路径 ./runtime.js 全部继续可用，
 * 实现拆分在 ./runtime/ 下的单一职责模块中。
 */

export { ensureBotdBinWrapper, getTsxLoaderUrl, resolveCliEntry } from './runtime/bin-wrapper.js';
export { buildBotShellEnv } from './runtime/shell-env.js';
export {
  resolveEffectiveBot,
  resolveBotPaths,
  cleanupEphemeralAgents,
  type BotData,
} from './runtime/bot-context.js';
export {
  MEMORY_INDEX_MAX_LINES,
  truncateMemoryIndex,
  canBotWriteMemory,
  buildMemoryPromptSection,
  type MemoryPromptInput,
} from './runtime/memory-prompt.js';
