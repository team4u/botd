import React, { useState, useEffect, useRef } from 'react';
import {
  Server,
  Bot,
  Plus,
  Terminal,
  Wrench,
  Edit,
  Trash2,
  RefreshCw,
  ArrowLeft,
  Loader2,
  Clock,
  Menu,
  Blocks,
  ChevronDown,
  RotateCw,
  PowerOff,
  Share2,
} from 'lucide-react';
import type { NodeWithBots, BotConfig } from '@botd/protocol';
import { PairingModal } from './PairingModal';
import { SkillEditorModal } from './SkillEditorModal';
import { ExtensionEditorModal } from './ExtensionEditorModal';
import { BotEditorModal } from './BotEditorModal';
import { ConfirmDialog } from './ConfirmDialog';
import { api } from '../api';

declare module '@botd/protocol' {
  interface NodeRecord {
    pid?: number;
    startedAt?: string;
  }
}

/** Max chips visible in a collapsed pool before expanding. */
const POOL_PREVIEW_COUNT = 6;

/**
 * Format uptime duration from startedAt ISO timestamp.
 * <60s -> "Ns"
 * <60m -> "Nm"
 * <24h -> "Nh Mm"
 * >=24h -> "Nd Nh"
 */
function formatUptime(startedAt?: string): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (diffSec < 60) {
    return `${diffSec}s`;
  }
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return `${mins}m`;
  }
  if (diffSec < 86400) {
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  return `${days}d ${hours}h`;
}

interface NodesBotsViewProps {
  nodes: NodeWithBots[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onBackToChat: () => void;
  onToggleSidebar?: () => void;
  onAddToast: (type: 'success' | 'error' | 'info', message: string) => void;
}

export const NodesBotsView: React.FC<NodesBotsViewProps> = ({
  nodes,
  loading,
  onRefresh,
  onBackToChat,
  onToggleSidebar,
  onAddToast,
}) => {
  const [pairingOpen, setPairingOpen] = useState(false);

  // Skill editor state
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [selectedNodeForSkill, setSelectedNodeForSkill] = useState<{ id: string; name: string } | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  // Extension editor state
  const [extensionEditorOpen, setExtensionEditorOpen] = useState(false);
  const [selectedNodeForExtension, setSelectedNodeForExtension] = useState<{ id: string; name: string } | null>(null);
  const [selectedExtId, setSelectedExtId] = useState<string | null>(null);

  // Bot editor state: opened in fixed node context
  const [botEditorOpen, setBotEditorOpen] = useState(false);
  const [selectedNodeForBot, setSelectedNodeForBot] = useState<NodeWithBots | null>(null);
  const [selectedBot, setSelectedBot] = useState<BotConfig | null>(null);

  // Deleting bot ID tracking
  const [deletingBotId, setDeletingBotId] = useState<string | null>(null);

  // Syncing skill tracking (key: `${nodeId}:${skillId}`)
  const [syncingSkillKey, setSyncingSkillKey] = useState<string | null>(null);

  // Bot pending deletion (confirm dialog)
  const [botToDelete, setBotToDelete] = useState<BotConfig | null>(null);

  // Node removal (confirm dialog): null | 'regular' | 'force'
  const [nodeToRemove, setNodeToRemove] = useState<NodeWithBots | null>(null);
  const [forceRemoveMode, setForceRemoveMode] = useState(false);
  const [deletingNodeId, setDeletingNodeId] = useState<string | null>(null);

  // Node restart state & confirm dialog
  const [nodeToRestart, setNodeToRestart] = useState<NodeWithBots | null>(null);
  const [restartingNodeIds, setRestartingNodeIds] = useState<Set<string>>(new Set());

  // Refs for tracking active restart pollers and timers for cleanup
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const activePollsRef = useRef<Map<string, { stopped: boolean }>>(new Map());

  // 30s interval ticker to refresh uptime display
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % 1_000_000);
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // Cleanup all restart polling timers on unmount
  useEffect(() => {
    return () => {
      activePollsRef.current.forEach((poll) => {
        poll.stopped = true;
      });
      activePollsRef.current.clear();

      pollTimersRef.current.forEach((timerId) => {
        clearTimeout(timerId);
      });
      pollTimersRef.current.clear();
    };
  }, []);

  // Collapsed / expanded resource pools per node
  const [expandedPools, setExpandedPools] = useState<Set<string>>(new Set());

  const handleOpenNewSkill = (node: NodeWithBots) => {
    setSelectedNodeForSkill({ id: node.id, name: node.name });
    setSelectedSkillId(null);
    setSkillEditorOpen(true);
  };

  const handleOpenEditSkill = (node: NodeWithBots, skillId: string) => {
    setSelectedNodeForSkill({ id: node.id, name: node.name });
    setSelectedSkillId(skillId);
    setSkillEditorOpen(true);
  };

  const handleOpenNewExtension = (node: NodeWithBots) => {
    setSelectedNodeForExtension({ id: node.id, name: node.name });
    setSelectedExtId(null);
    setExtensionEditorOpen(true);
  };

  const handleOpenEditExtension = (node: NodeWithBots, extId: string) => {
    setSelectedNodeForExtension({ id: node.id, name: node.name });
    setSelectedExtId(extId);
    setExtensionEditorOpen(true);
  };

  const handleOpenCreateBot = (node: NodeWithBots) => {
    setSelectedNodeForBot(node);
    setSelectedBot(null);
    setBotEditorOpen(true);
  };

  const handleOpenEditBot = (node: NodeWithBots, bot: BotConfig) => {
    setSelectedNodeForBot(node);
    setSelectedBot(bot);
    setBotEditorOpen(true);
  };

  const handleDeleteBot = async () => {
    if (!botToDelete) return;

    setDeletingBotId(botToDelete.id);
    try {
      await api.deleteBot(botToDelete.id);
      onAddToast('success', `已成功删除智能体 @${botToDelete.id}`);
      await onRefresh();
    } catch (err: any) {
      onAddToast('error', err?.message || '删除智能体失败');
    } finally {
      setDeletingBotId(null);
      setBotToDelete(null);
    }
  };

  // Node removal. When the node still hosts bots and is offline (or the owner
  // explicitly chooses to discard them), fall back to a force removal that
  // drops the Hub cache and cleans the node best-effort.
  const openRemoveNodeDialog = (node: NodeWithBots, force: boolean) => {
    setNodeToRemove(node);
    setForceRemoveMode(force);
  };

  const handleRemoveNode = async () => {
    if (!nodeToRemove) return;

    setDeletingNodeId(nodeToRemove.id);
    try {
      await api.deleteNode(nodeToRemove.id, forceRemoveMode);
      onAddToast('success', `已移除计算节点 ${nodeToRemove.name}`);
      await onRefresh();
    } catch (err: any) {
      onAddToast('error', err?.message || '移除节点失败');
    } finally {
      setDeletingNodeId(null);
      setNodeToRemove(null);
    }
  };

  const startRestartPolling = (
    nodeId: string,
    prevPid: number | undefined,
    prevStartedAt: string | undefined
  ) => {
    const existingTimer = pollTimersRef.current.get(nodeId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      pollTimersRef.current.delete(nodeId);
    }
    const existingPoll = activePollsRef.current.get(nodeId);
    if (existingPoll) {
      existingPoll.stopped = true;
    }

    const pollState = { stopped: false };
    activePollsRef.current.set(nodeId, pollState);
    const startTime = Date.now();

    const check = async () => {
      if (pollState.stopped) return;

      // Timeout 90s
      if (Date.now() - startTime >= 90_000) {
        pollState.stopped = true;
        pollTimersRef.current.delete(nodeId);
        activePollsRef.current.delete(nodeId);
        setRestartingNodeIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        onAddToast('error', '节点未在 90 秒内恢复，请检查机器上的 botd 状态');
        return;
      }

      try {
        const fetchedNodes = await api.getNodes();
        if (pollState.stopped) return;

        const current = fetchedNodes.find((n) => n.id === nodeId);
        if (current && current.status === 'online') {
          const hasBaseline = prevPid != null || prevStartedAt != null;
          let isRecovered = false;

          if (!hasBaseline) {
            // 若两者都缺省则只要 online 即可
            isRecovered = true;
          } else {
            const pidChanged = prevPid != null && current.pid != null && current.pid !== prevPid;
            const startedAtChanged =
              prevStartedAt != null &&
              current.startedAt != null &&
              new Date(current.startedAt).getTime() > new Date(prevStartedAt).getTime();

            if (pidChanged || startedAtChanged) {
              isRecovered = true;
            }
          }

          if (isRecovered) {
            pollState.stopped = true;
            pollTimersRef.current.delete(nodeId);
            activePollsRef.current.delete(nodeId);
            setRestartingNodeIds((prev) => {
              const next = new Set(prev);
              next.delete(nodeId);
              return next;
            });
            onAddToast('success', '节点已恢复');
            await onRefresh();
            return;
          }
        }
      } catch (err) {
        console.warn('[NodesBotsView] Polling getNodes error:', err);
      }

      if (pollState.stopped) return;

      const timerId = setTimeout(check, 3_000);
      pollTimersRef.current.set(nodeId, timerId);
    };

    const timerId = setTimeout(check, 3_000);
    pollTimersRef.current.set(nodeId, timerId);
  };

  const handleConfirmRestart = async () => {
    if (!nodeToRestart) return;

    const node = nodeToRestart;
    const nodeId = node.id;
    const prevPid = node.pid;
    const prevStartedAt = node.startedAt;

    setNodeToRestart(null);
    setRestartingNodeIds((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });

    try {
      await api.restartNode(nodeId);
    } catch (err: any) {
      setRestartingNodeIds((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
      onAddToast('error', err?.message || '重启节点失败');
      return;
    }

    startRestartPolling(nodeId, prevPid, prevStartedAt);
  };

  const handleSyncSkill = async (nodeId: string, skillId: string) => {
    const otherOnlineNodes = nodes.filter((n) => n.id !== nodeId && n.status === 'online');
    if (otherOnlineNodes.length === 0) return;

    const key = `${nodeId}:${skillId}`;
    setSyncingSkillKey(key);
    try {
      const otherNodeIds = otherOnlineNodes.map((n) => n.id);
      const res = await api.syncSkillAcrossNodes(nodeId, skillId, otherNodeIds);
      const count = res.syncedNodeIds?.length ?? otherNodeIds.length;
      onAddToast('success', `已将技能 ${skillId} 同步到 ${count} 个在线节点`);
      await onRefresh();
    } catch (err: any) {
      onAddToast('error', err?.message || '同步技能失败');
    } finally {
      setSyncingSkillKey(null);
    }
  };

  const togglePool = (key: string) => {
    setExpandedPools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Map thinking level to Chinese
  const formatThinkingLevel = (level?: string) => {
    if (!level) return null;
    const map: Record<string, string> = {
      low: '轻度思考',
      medium: '标准思考',
      high: '深度思考',
    };
    return map[level.toLowerCase()] || level;
  };

  // Get short model name (strip prefix before /)
  const getShortModelId = (modelId: string) => {
    if (!modelId) return '';
    const parts = modelId.split('/');
    return parts[parts.length - 1];
  };

  // Relative time for heartbeats, e.g. "3 分钟前"
  const formatRelativeTime = (iso: string): string => {
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) return iso;
    const diff = Date.now() - ts;
    if (diff < 30_000) return '刚刚';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return '1 分钟前';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    return new Date(iso).toLocaleDateString([], { month: '2-digit', day: '2-digit' });
  };

  const onlineCount = nodes.filter((n) => n.status === 'online').length;

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-50/60 dark:bg-zinc-900/60 overflow-hidden text-zinc-900 dark:text-zinc-100">
      {/* Top Header */}
      <header className="h-14 sm:h-16 px-3 sm:px-6 lg:px-8 bg-white dark:bg-zinc-950 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-1.5 -ml-1 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg lg:hidden transition-colors"
              aria-label="打开侧边导航"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          <button
            onClick={onBackToChat}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200 dark:border-zinc-800 shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">返回会话</span>
          </button>

          <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800 hidden sm:block shrink-0" />

          {/* Page Title: visible on both mobile and desktop */}
          <div className="min-w-0 flex items-center gap-2">
            <h1 className="font-semibold text-sm sm:text-base text-zinc-900 dark:text-zinc-100 truncate">
              计算节点
            </h1>
            <span className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full font-mono border border-zinc-200 dark:border-zinc-700 shrink-0">
              {onlineCount}/{nodes.length} 在线
            </span>
          </div>
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            onClick={() => onRefresh()}
            disabled={loading}
            className="p-2 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 transition-colors"
            title="刷新状态"
            aria-label="刷新状态"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin-fast' : ''}`} />
          </button>

          <button
            onClick={() => setPairingOpen(true)}
            className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 transition-colors"
          >
            <Terminal className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-400" />
            <span className="hidden sm:inline">配对节点</span>
            <span className="sm:hidden">配对</span>
          </button>
        </div>
      </header>

      {/* Main Body: one node = one card, bots live inside their owning node */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-6 lg:p-8 space-y-4 max-w-5xl w-full mx-auto">
        {nodes.length === 0 ? (
          <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700 p-8 text-center">
            <Server className="w-9 h-9 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-1">暂无已连接的计算节点</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4 max-w-md mx-auto">
              请点击右上角「配对节点」，并在目标计算设备或服务器终端执行配对命令完成接入。
              智能体、技能与扩展都归属于节点，接入后即可创建。
            </p>
            <button
              onClick={() => setPairingOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white rounded-lg text-xs font-medium shadow-xs transition-colors"
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>配对新节点</span>
            </button>
          </div>
        ) : (
          nodes.map((node) => {
            const isOnline = node.status === 'online';
            const isRestarting = restartingNodeIds.has(node.id);
            const absoluteLastSeen = new Date(node.lastSeenAt).toLocaleString();
            const isRemovingNode = deletingNodeId === node.id;
            const uptimeText = node.startedAt ? formatUptime(node.startedAt) : '';
            const nodeBots = node.bots || [];
            const otherOnlineNodes = nodes.filter((n) => n.id !== node.id && n.status === 'online');
            const hasOtherOnlineNodes = isOnline && otherOnlineNodes.length > 0;

            return (
              <section
                key={node.id}
                aria-labelledby={`node-${node.id}-heading`}
                className="bg-white dark:bg-zinc-950 rounded-2xl border border-zinc-200/90 dark:border-zinc-800/90 shadow-xs overflow-hidden"
              >
                {/* 1. Node Header: identity, status, lifecycle actions */}
                <div className="p-4 flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border ${
                        isOnline
                          ? 'bg-emerald-50 text-emerald-600 border-emerald-200/60 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900/60'
                          : 'bg-zinc-50 text-zinc-400 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-500 dark:border-zinc-700'
                      }`}
                    >
                      <Server className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <h2
                        id={`node-${node.id}-heading`}
                        className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5"
                      >
                        <span className="truncate">{node.name}</span>
                        <span className="text-[11px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded font-mono text-zinc-600 dark:text-zinc-400 shrink-0">
                          {node.platform}
                        </span>
                      </h2>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                          ID: {node.id}
                        </span>
                        <span
                          className="text-[11px] text-zinc-400 dark:text-zinc-500 flex items-center gap-1 shrink-0"
                          title={absoluteLastSeen}
                        >
                          <Clock className="w-2.5 h-2.5" />
                          {formatRelativeTime(node.lastSeenAt)}
                        </span>
                        {node.pid != null && (
                          <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono shrink-0">
                            PID {node.pid}{uptimeText ? ` · ${uptimeText}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Status Indicator, Restart & Remove */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isRestarting ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                        <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-amber-500" />
                        <span>重启中</span>
                      </span>
                    ) : isOnline ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        <span>在线</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 dark:text-zinc-500">
                        <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
                        <span>离线</span>
                      </span>
                    )}

                    <button
                      type="button"
                      onClick={() => setNodeToRestart(node)}
                      disabled={!isOnline || isRestarting}
                      className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      title={!isOnline ? '节点已离线，无法重启' : '重启计算节点'}
                      aria-label={`重启节点 ${node.name}`}
                    >
                      {isRestarting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-amber-500" />
                      ) : (
                        <RotateCw className="w-3.5 h-3.5" />
                      )}
                    </button>

                    <button
                      onClick={() => openRemoveNodeDialog(node, false)}
                      className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:text-zinc-500 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                      title="移除该节点"
                      aria-label={`移除节点 ${node.name}`}
                    >
                      {isRemovingNode ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-rose-500 dark:text-rose-400" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Offline banner: bots on this node are visible but read-only */}
                {!isOnline && nodeBots.length > 0 && (
                  <div className="mx-4 mb-3 p-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-2">
                    <PowerOff className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      节点离线：以下 {nodeBots.length} 个智能体暂不可用（无法对话与编辑），配置为上次在线时的缓存。
                    </span>
                  </div>
                )}

                {/* 2. Bots section: bots belong to this node */}
                <div className="border-t border-zinc-100 dark:border-zinc-800/60">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-50/70 dark:bg-zinc-900/50">
                    <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                      <Bot className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                      <span>智能体 ({nodeBots.length})</span>
                    </span>
                    <button
                      onClick={() => handleOpenCreateBot(node)}
                      disabled={!isOnline}
                      className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200/80 dark:border-zinc-800/80 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      title={!isOnline ? '节点离线，无法创建智能体' : '在该节点上创建智能体'}
                    >
                      <Plus className="w-3 h-3" />
                      <span>新建智能体</span>
                    </button>
                  </div>

                  {nodeBots.length === 0 ? (
                    <p className="px-4 py-4 text-xs text-zinc-400 dark:text-zinc-500">
                      暂无智能体。{isOnline ? '点击右上角「新建智能体」创建。' : '节点恢复在线后可创建。'}
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-zinc-100 dark:divide-zinc-800/60 border-t border-zinc-100 dark:border-zinc-800/60">
                      {nodeBots.map((bot) => {
                        const isDeleting = deletingBotId === bot.id;
                        const shortModel = getShortModelId(bot.modelId);
                        const thinkingText = formatThinkingLevel(bot.thinkingLevel);

                        // Collect enabled skills and extensions compactly
                        const enabledItems = [
                          ...(bot.enabledSkills || []).map((s) => ({ type: 'skill' as const, name: s })),
                          ...(bot.enabledExtensions || []).map((e) => ({ type: 'ext' as const, name: e })),
                        ];

                        return (
                          <div key={bot.id} className="p-4 flex flex-col justify-between gap-3 min-w-0">
                            {/* Bot identity */}
                            <div className="flex items-start justify-between gap-2 min-w-0">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div
                                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                                    isOnline
                                      ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200/70 dark:border-zinc-700/70'
                                      : 'bg-zinc-50 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-600 border-zinc-200/70 dark:border-zinc-800/70'
                                  }`}
                                >
                                  <Bot className="w-4 h-4" />
                                </div>
                                <div className="min-w-0">
                                  <div
                                    className={`font-semibold text-sm truncate ${
                                      isOnline
                                        ? 'text-zinc-900 dark:text-zinc-100'
                                        : 'text-zinc-500 dark:text-zinc-400'
                                    }`}
                                  >
                                    {bot.name}
                                  </div>
                                  <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 block truncate">
                                    @{bot.id}
                                  </span>
                                </div>
                              </div>

                              {!isOnline && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">
                                  <PowerOff className="w-2.5 h-2.5" />
                                  <span>离线</span>
                                </span>
                              )}
                            </div>

                            {/* Description */}
                            <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-2 min-h-[32px] leading-relaxed">
                              {bot.description || '暂无角色描述'}
                            </p>

                            {/* Metadata chips */}
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className="font-mono text-[11px] text-zinc-700 bg-zinc-100 dark:text-zinc-300 dark:bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-200/60 dark:border-zinc-700/60 truncate max-w-[140px]"
                                title={bot.modelId}
                              >
                                {shortModel}
                              </span>

                              {thinkingText && (
                                <span className="text-[11px] text-zinc-600 bg-zinc-100 dark:text-zinc-400 dark:bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 font-medium">
                                  {thinkingText}
                                </span>
                              )}

                              {enabledItems.slice(0, 2).map((item) => (
                                <span
                                  key={`${item.type}-${item.name}`}
                                  className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-600 bg-zinc-50 dark:text-zinc-400 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800/80 px-1.5 py-0.5 rounded truncate max-w-[110px]"
                                  title={item.type === 'skill' ? `技能: ${item.name}` : `扩展: ${item.name}`}
                                >
                                  {item.type === 'skill' ? (
                                    <Wrench className="w-2.5 h-2.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                                  ) : (
                                    <Blocks className="w-2.5 h-2.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                                  )}
                                  <span className="truncate">{item.name}</span>
                                </span>
                              ))}
                              {enabledItems.length > 2 && (
                                <span className="text-[11px] font-mono text-zinc-400 bg-zinc-50 dark:text-zinc-500 dark:bg-zinc-900 px-1 py-0.5 rounded border border-zinc-200/60 dark:border-zinc-800/60">
                                  +{enabledItems.length - 2}
                                </span>
                              )}
                            </div>

                            {/* Actions: read-only while the owning node is offline */}
                            <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between">
                              <button
                                onClick={() => handleOpenEditBot(node, bot)}
                                disabled={!isOnline}
                                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200/80 dark:border-zinc-800/80 disabled:opacity-40 disabled:cursor-not-allowed"
                                title={!isOnline ? '节点离线，无法编辑该智能体' : '编辑智能体配置'}
                              >
                                <Edit className="w-3 h-3" />
                                <span>配置</span>
                              </button>

                              <button
                                onClick={() => setBotToDelete(bot)}
                                disabled={!isOnline || isDeleting}
                                className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:text-zinc-500 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                title={!isOnline ? '节点离线，无法删除该智能体' : '删除该智能体'}
                                aria-label="删除"
                              >
                                {isDeleting ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-rose-500 dark:text-rose-400" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 3. Skills pool */}
                <div className="border-t border-zinc-100 dark:border-zinc-800/60 p-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1">
                      <Wrench className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
                      <span>技能库 ({node.skills?.length || 0})</span>
                    </span>
                    <button
                      onClick={() => handleOpenNewSkill(node)}
                      disabled={!isOnline}
                      className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 flex items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      title={!isOnline ? '节点离线，无法新建技能' : '新建技能'}
                    >
                      <Plus className="w-3 h-3" />
                      <span>新建技能</span>
                    </button>
                  </div>

                  {node.skills && node.skills.length > 0 ? (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {(expandedPools.has(`${node.id}:skills`)
                          ? node.skills
                          : node.skills.slice(0, POOL_PREVIEW_COUNT)
                        ).map((skill) => (
                          <div
                            key={skill}
                            className="group inline-flex items-center bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600 rounded-md text-[11px] font-mono text-zinc-700 dark:text-zinc-300 transition-all shadow-2xs overflow-hidden"
                          >
                            <button
                              type="button"
                              onClick={() => handleOpenEditSkill(node, skill)}
                              disabled={!isOnline}
                              className="px-2 py-0.5 flex items-center gap-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              title={isOnline ? '点击查看并编辑说明文档' : '节点离线，无法编辑'}
                            >
                              <span>{skill}</span>
                              <Edit className="w-2.5 h-2.5 opacity-40 group-hover:opacity-100" />
                            </button>

                            {hasOtherOnlineNodes && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSyncSkill(node.id, skill);
                                }}
                                disabled={syncingSkillKey === `${node.id}:${skill}`}
                                className="px-1.5 py-0.5 border-l border-zinc-200 dark:border-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-950/50 text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer"
                                title="同步技能到其他节点"
                                aria-label={`同步技能 ${skill} 到其他节点`}
                              >
                                {syncingSkillKey === `${node.id}:${skill}` ? (
                                  <Loader2 className="w-2.5 h-2.5 animate-spin-fast text-blue-500" />
                                ) : (
                                  <Share2 className="w-2.5 h-2.5" />
                                )}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {node.skills.length > POOL_PREVIEW_COUNT && (
                        <button
                          onClick={() => togglePool(`${node.id}:skills`)}
                          className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                        >
                          <span>
                            {expandedPools.has(`${node.id}:skills`)
                              ? '收起'
                              : `展开全部 ${node.skills.length} 个`}
                          </span>
                          <ChevronDown
                            className={`w-3 h-3 transition-transform ${
                              expandedPools.has(`${node.id}:skills`) ? 'rotate-180' : ''
                            }`}
                          />
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                      暂无技能，可点击右上角新建，或由智能体通过 ad 导出生成。
                    </p>
                  )}
                </div>

                {/* 4. Extensions pool */}
                <div className="border-t border-zinc-100 dark:border-zinc-800/60 p-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1">
                      <Blocks className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
                      <span>扩展库 ({node.extensions?.length || 0})</span>
                    </span>
                    <button
                      onClick={() => handleOpenNewExtension(node)}
                      disabled={!isOnline}
                      className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 flex items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      title={!isOnline ? '节点离线，无法安装扩展' : '安装或新建扩展'}
                    >
                      <Plus className="w-3 h-3" />
                      <span>安装或新建</span>
                    </button>
                  </div>

                  {node.extensions && node.extensions.length > 0 ? (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {(expandedPools.has(`${node.id}:exts`)
                          ? node.extensions
                          : node.extensions.slice(0, POOL_PREVIEW_COUNT)
                        ).map((ext) => (
                          <button
                            key={ext}
                            onClick={() => handleOpenEditExtension(node, ext)}
                            disabled={!isOnline}
                            className="group px-2 py-0.5 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600 rounded-md text-[11px] font-mono text-zinc-700 dark:text-zinc-300 flex items-center gap-1 transition-all shadow-2xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            title={isOnline ? '点击查看并编辑扩展代码' : '节点离线，无法编辑'}
                          >
                            <span>{ext}</span>
                            <Edit className="w-2.5 h-2.5 opacity-40 group-hover:opacity-100" />
                          </button>
                        ))}
                      </div>
                      {node.extensions.length > POOL_PREVIEW_COUNT && (
                        <button
                          onClick={() => togglePool(`${node.id}:exts`)}
                          className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                        >
                          <span>
                            {expandedPools.has(`${node.id}:exts`)
                              ? '收起'
                              : `展开全部 ${node.extensions.length} 个`}
                          </span>
                          <ChevronDown
                            className={`w-3 h-3 transition-transform ${
                              expandedPools.has(`${node.id}:exts`) ? 'rotate-180' : ''
                            }`}
                          />
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                      暂无扩展插件，可点击右上角安装或新建。
                    </p>
                  )}
                </div>
              </section>
            );
          })
        )}
      </div>

      {/* Submodals */}
      <PairingModal isOpen={pairingOpen} onClose={() => setPairingOpen(false)} />

      <ConfirmDialog
        isOpen={botToDelete !== null}
        title="删除智能体"
        danger
        busy={deletingBotId !== null}
        confirmText="删除"
        confirmDisabled={deletingBotId !== null}
        onConfirm={handleDeleteBot}
        onClose={() => {
          if (deletingBotId === null) setBotToDelete(null);
        }}
        message={
          botToDelete ? (
            <>
              确定要从所属计算节点中删除智能体「{botToDelete.name}」（<span className="font-mono">@{botToDelete.id}</span>）吗？
              <br />
              该操作不可逆，删除后无法恢复。
            </>
          ) : null
        }
      />

      <ConfirmDialog
        isOpen={nodeToRemove !== null}
        title={forceRemoveMode ? '强制移除节点' : '移除计算节点'}
        danger
        busy={deletingNodeId !== null}
        confirmText={forceRemoveMode ? '强制移除' : '移除节点'}
        confirmDisabled={deletingNodeId !== null}
        onConfirm={handleRemoveNode}
        onClose={() => {
          if (deletingNodeId === null) setNodeToRemove(null);
        }}
        message={
          nodeToRemove ? (
            (nodeToRemove.bots?.length || 0) > 0 && !forceRemoveMode ? (
              <>
                节点「{nodeToRemove.name}」下仍有 <strong>{nodeToRemove.bots?.length}</strong> 个智能体，需要先删除它们才能移除节点。
                <br />
                若该节点已永久下线（机器报废、无法重启），可选择强制移除：将丢弃这些智能体在本平台的全部记录（节点上的本地数据随机器一起丢失，凭证已吊销不会重新接入）。
                <div className="mt-3 flex flex-col sm:flex-row gap-2">
                  <button
                    type="button"
                    onClick={() => setForceRemoveMode(true)}
                    disabled={deletingNodeId !== null}
                    className="px-3 py-1.5 text-xs font-medium text-rose-700 hover:text-white hover:bg-rose-600 dark:text-rose-300 dark:hover:bg-rose-600 dark:hover:text-white border border-rose-300 dark:border-rose-800 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    我已了解风险，强制移除
                  </button>
                </div>
              </>
            ) : forceRemoveMode ? (
              <>
                确定要强制移除节点「{nodeToRemove.name}」及其上 <strong>{nodeToRemove.bots?.length || 0}</strong> 个智能体的平台记录吗？
                <br />
                该操作不可逆：会立即吊销节点凭证并清除 {nodeToRemove.bots?.length || 0} 个智能体的配置缓存；若节点实际仍在线，会尽力同步删除其本地数据。
              </>
            ) : (
              <>
                确定要移除节点「{nodeToRemove.name}」吗？
                <br />
                {nodeToRemove.status === 'online'
                  ? '该节点当前在线，移除后将立即断开其连接。'
                  : '该节点当前离线。'}
                移除后如需重新接入，需重新执行配对流程。
              </>
            )
          ) : null
        }
      />

      <ConfirmDialog
        isOpen={nodeToRestart !== null}
        title="重启节点"
        confirmText="重启"
        confirmDisabled={false}
        onConfirm={handleConfirmRestart}
        onClose={() => setNodeToRestart(null)}
        message={
          nodeToRestart ? (
            <>
              确定要重启计算节点「{nodeToRestart.name}」吗？
              <br />
              重启期间节点会短暂离线，随后自动恢复连接。
            </>
          ) : null
        }
      />

      {selectedNodeForSkill && (
        <SkillEditorModal
          isOpen={skillEditorOpen}
          nodeId={selectedNodeForSkill.id}
          nodeName={selectedNodeForSkill.name}
          skillId={selectedSkillId}
          onClose={() => setSkillEditorOpen(false)}
          onSaved={async () => {
            onAddToast('success', '技能说明文档保存成功');
            await onRefresh();
          }}
        />
      )}

      {selectedNodeForExtension && (
        <ExtensionEditorModal
          isOpen={extensionEditorOpen}
          nodeId={selectedNodeForExtension.id}
          nodeName={selectedNodeForExtension.name}
          extId={selectedExtId}
          onClose={() => setExtensionEditorOpen(false)}
          onSaved={async () => {
            onAddToast('success', selectedExtId ? '扩展已更新' : '扩展已成功保存');
            await onRefresh();
          }}
        />
      )}

      <BotEditorModal
        isOpen={botEditorOpen}
        node={selectedNodeForBot}
        bot={selectedBot}
        onClose={() => setBotEditorOpen(false)}
        onSaved={async () => {
          onAddToast('success', selectedBot ? '智能体配置已成功更新' : '新智能体创建成功');
          await onRefresh();
        }}
      />
    </div>
  );
};
