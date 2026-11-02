import type { ChatCommand, BotConfig } from '@botd/protocol';
import { loadTurnDeps } from './turn-deps.js';

/**
 * BOT 命令发现（daemon 的 getCommands RPC 用）：懒加载重依赖后转发到 commands 模块。
 */

export async function getBotCommands(dataDir: string, bot: BotConfig): Promise<ChatCommand[]> {
  const { commandsMod } = await loadTurnDeps();
  return commandsMod.getBotCommands(dataDir, bot);
}
