import path from 'node:path';
import type { BotConfig } from '@botd/protocol';

/**
 * BOT 配置继承解析：角色分身可跟随主 BOT 的模型与技能配置。
 * 纯函数——数据读取在调用方，这里只做合并。
 */

export type BotData = Awaited<ReturnType<typeof import('../storage.js').readBot>>;

/** 解析生效模型 / 技能（分身按 inheritModel / inheritSkills 跟随主 BOT） */
export function resolveEffectiveBot(bot: BotConfig, parentBotConfig: Partial<BotConfig> | null): BotConfig {
  return {
    ...bot,
    modelProvider: bot.inheritModel && parentBotConfig ? parentBotConfig.modelProvider! : bot.modelProvider,
    modelId: bot.inheritModel && parentBotConfig ? parentBotConfig.modelId! : bot.modelId,
    enabledSkills:
      bot.inheritSkills && parentBotConfig ? [...(parentBotConfig.enabledSkills ?? [])] : bot.enabledSkills || [],
  };
}

/** 分身的工作区/agentDir 始终挂在主 BOT 目录下（防套娃：分身目录只存会话与环境） */
export function resolveBotPaths(dataDir: string, bot: BotConfig): {
  botDir: string;
  workspaceDir: string;
  sessionDir: string;
  /** createAgentSession 的 agentDir：主回合用自身 botDir（与原实现一致） */
  agentDir: string;
  /** PI_CODING_AGENT_DIR：主 BOT 目录（分身跟随主 BOT 的 agent 配置） */
  mainAgentDir: string;
} {
  const botDir = path.join(dataDir, 'bots', bot.id);
  const mainBotId = bot.parentBotId || bot.id;
  const mainBotDir = path.join(dataDir, 'bots', mainBotId);
  return {
    botDir,
    workspaceDir: path.join(mainBotDir, 'workspace'),
    sessionDir: path.join(botDir, 'sessions'),
    agentDir: botDir,
    mainAgentDir: mainBotDir,
  };
}
