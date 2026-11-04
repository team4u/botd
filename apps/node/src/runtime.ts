/**
 * runtime 模块的对外门面（桶文件）：历史导入路径 ./runtime.js 全部继续可用，
 * 实现拆分在 ./runtime/ 下的单一职责模块中。
 *
 * Phase 3A 之后 Node 只保留纯环境辅助（CLI 包装器、shell 环境、自动化事件解析、
 * 工具摘要脱敏、BOT 路径与记忆提示词）；回合执行与子代理编排已随
 * "Brain in Hub, Hands on Node" 架构迁移到 Hub 的 Durable Runtime。
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
