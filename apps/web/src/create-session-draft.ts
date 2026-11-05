/**
 * 新建会话弹窗草稿状态机（纯函数）：
 * 从 CreateSessionModal 组件中拆出以保持 Fast Refresh 兼容（组件文件只导出组件）。
 */
import type { BotConfig } from '@botd/protocol';
import { orderBotsAsTree } from './utils/bots.js';

export interface CreateSessionDraft {
  title: string;
  leadBotId: string;
  error: string | null;
}

export function createDefaultSessionDraft(bots: BotConfig[]): CreateSessionDraft {
  const ordered = orderBotsAsTree(bots);
  const firstBot = ordered[0];
  return {
    title: firstBot ? (firstBot.name || firstBot.id) : '',
    leadBotId: firstBot ? firstBot.id : '',
    error: null,
  };
}

export interface ResolveCreateSessionStepParams {
  isOpen: boolean;
  wasOpen: boolean;
  initialized: boolean;
  currentDraft: CreateSessionDraft;
  bots: BotConfig[];
}

export interface ResolveCreateSessionStepResult {
  shouldUpdate: boolean;
  nextInitialized: boolean;
  nextDraft: CreateSessionDraft;
}

export function resolveCreateSessionStep({
  isOpen,
  wasOpen,
  initialized,
  currentDraft,
  bots,
}: ResolveCreateSessionStepParams): ResolveCreateSessionStepResult {
  if (!isOpen) {
    return {
      shouldUpdate: false,
      nextInitialized: false,
      nextDraft: currentDraft,
    };
  }

  // 1. 初次打开或首次从异步加载中拿到可用 bots 时初始化一次
  if (!wasOpen || !initialized) {
    if (bots.length > 0) {
      return {
        shouldUpdate: true,
        nextInitialized: true,
        nextDraft: createDefaultSessionDraft(bots),
      };
    }
    return {
      shouldUpdate: false,
      nextInitialized: false,
      nextDraft: currentDraft,
    };
  }

  // 2. 弹窗已处于打开中：后台轮询新数组引用或在线状态刷新，绝对不能重设整份草稿
  if (bots.length > 0) {
    const validIds = new Set(bots.map((b) => b.id));
    let leadBotId = currentDraft.leadBotId;
    let leadChanged = false;
    if (leadBotId && !validIds.has(leadBotId)) {
      leadBotId = bots[0]?.id || '';
      leadChanged = true;
    }

    if (leadChanged) {
      return {
        shouldUpdate: true,
        nextInitialized: true,
        nextDraft: {
          ...currentDraft,
          leadBotId,
        },
      };
    }
  }

  return {
    shouldUpdate: false,
    nextInitialized: true,
    nextDraft: currentDraft,
  };
}


/**
 * 节点本地 Git 仓库扫描结果（GET /api/nodes/:nodeId/spaces）。
 * 接口由并行分支落地，此处仅声明前端消费的形状，静默容错。
 */
export interface NodeSpaceEntry {
  path: string;
  name: string;
  branch?: string;
  isGitRepo: boolean;
}

/** 轻量 spaces 拉取：失败静默返回空列表（仅保留手动输入） */
export async function fetchNodeSpaces(nodeId: string): Promise<NodeSpaceEntry[]> {
  try {
    const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/spaces`, {
      credentials: 'include',
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (item): item is NodeSpaceEntry =>
          item && typeof item.path === 'string' && typeof item.name === 'string'
      )
      .map((item) => ({
        path: item.path,
        name: item.name,
        branch: typeof item.branch === 'string' ? item.branch : undefined,
        isGitRepo: Boolean(item.isGitRepo),
      }));
  } catch {
    return [];
  }
}
