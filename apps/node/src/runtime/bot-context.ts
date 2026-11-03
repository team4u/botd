import fs from 'node:fs/promises';
import path from 'node:path';
import type { BotConfig } from '@botd/protocol';

/**
 * BOT 配置继承解析：子代理可跟随主 BOT 的模型与技能配置。
 * 纯函数——数据读取在调用方，这里只做合并。
 */

export type BotData = Awaited<ReturnType<typeof import('../storage.js').readBot>>;

/** 解析生效模型 / 技能（子代理按 inheritModel / inheritSkills 跟随主 BOT） */
export function resolveEffectiveBot(bot: BotConfig, parentBotConfig: Partial<BotConfig> | null): BotConfig {
  return {
    ...bot,
    modelProvider: bot.inheritModel && parentBotConfig ? parentBotConfig.modelProvider! : bot.modelProvider,
    modelId: bot.inheritModel && parentBotConfig ? parentBotConfig.modelId! : bot.modelId,
    enabledSkills:
      bot.inheritSkills && parentBotConfig ? [...(parentBotConfig.enabledSkills || [])] : bot.enabledSkills || [],
  };
}

/** 子代理的工作区/agentDir 始终挂在主 BOT 目录下（防套娃：子代理目录只存会话与环境） */
export function resolveBotPaths(dataDir: string, bot: BotConfig): {
  botDir: string;
  workspaceDir: string;
  sessionDir: string;
  /** createAgentSession 的 agentDir：主回合用自身 botDir（与原实现一致） */
  agentDir: string;
  /** PI_CODING_AGENT_DIR：主 BOT 目录（子代理跟随主 BOT 的 agent 配置） */
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

/**
 * 清理回合内临时创建的子代理定义文件（<agentDir>/agents/tmp-*.md），
 * 保留通过 saveBot 持久化的正式子代理定义文件。
 */
export async function cleanupEphemeralAgents(agentDir: string): Promise<void> {
  const agentsDir = path.join(agentDir, 'agents');
  try {
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && /^tmp-[a-zA-Z0-9_-]+\.md$/.test(e.name))
        .map((e) => fs.rm(path.join(agentsDir, e.name), { force: true }).catch(() => {})),
    );
  } catch {
    // Directory may not exist yet; ignore
  }
}
