import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BotConfig } from '@botd/protocol';
import { buildBotShellEnv } from './shell-env.js';
import { headlessTool } from './attachments.js';
import { isWindows, resolveWindowsBash } from '../windows-shell.js';

/**
 * 回合内 shell 工具构建：bash（Windows 下固定 Git Bash/MinGit 路径）与 PowerShell，
 * 通过 spawnHook 注入回合环境（不改全局 process.env）。
 * 只读 BOT（toolScope === 'readonly'）不暴露任何 shell 工具。
 */

export interface ShellToolDeps {
  createBashToolDefinition: typeof import('@earendil-works/pi-coding-agent').createBashToolDefinition;
  createPowerShellToolDefinition?: typeof import('@earendil-works/pi-coding-agent').createPowerShellToolDefinition;
}

export interface ShellToolContext {
  dataDir: string;
  binDir: string;
  sessionId: string;
  botId: string;
  botEnv: Record<string, string>;
  turnEnv: Record<string, string | undefined>;
}

export function buildShellTools(
  deps: ShellToolDeps,
  workspaceDir: string,
  ctx: ShellToolContext,
): ToolDefinition[] {
  const isWin = isWindows;
  const shellPath = isWin ? resolveWindowsBash(ctx.dataDir) : undefined;
  const spawnHook = (processCtx: any) => ({
    ...processCtx,
    env: buildBotShellEnv(processCtx.env, {
      dataDir: ctx.dataDir,
      binDir: ctx.binDir,
      sessionId: ctx.sessionId,
      botId: ctx.botId,
      botEnv: ctx.botEnv,
      turnEnv: ctx.turnEnv,
    }),
  });

  const customTools: ToolDefinition[] = [];
  const rawBashDef = deps.createBashToolDefinition(workspaceDir, {
    ...(shellPath ? { shellPath } : {}),
    spawnHook,
  });
  customTools.push(headlessTool(rawBashDef));

  // Windows: also expose the native PowerShell tool so the model can drive
  // Windows-native workflows (registry, services, cmdlets) without bash.
  if (isWin && deps.createPowerShellToolDefinition) {
    try {
      const rawPsDef = deps.createPowerShellToolDefinition(workspaceDir, { spawnHook });
      customTools.push(headlessTool(rawPsDef));
    } catch {
      // PowerShell discovery failed (headless Windows core?) — bash remains.
    }
  }
  return customTools;
}

/** 只读 / 自定义工具集解析（readonly → 检索类工具白名单；custom → BOT 配置清单） */
export function resolveSessionTools(bot: BotConfig): string[] | undefined {
  if (bot.toolScope === 'readonly') {
    return ['read', 'grep', 'find', 'ls'];
  }
  if (bot.toolScope === 'custom' && bot.customTools?.length) {
    return bot.customTools;
  }
  return undefined;
}

/** 会话销毁：先向扩展广播 session_shutdown（pi-subagents 需要 abortAll + 释放注册表），再 dispose */
export async function disposeSession(session: AgentSession): Promise<void> {
  try {
    const runner = (session as any).extensionRunner;
    if (runner?.hasHandlers?.('session_shutdown')) {
      await runner.emit({ type: 'session_shutdown', reason: 'quit' });
    } else {
      const { getGlobalSubagentManager } = await import('../commands.js');
      getGlobalSubagentManager()?.abortAll?.();
    }
  } catch {
    // shutdown 事件失败不阻塞会话销毁
  }
  session.dispose();
}
