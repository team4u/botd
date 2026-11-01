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
  Search,
  X,
  ChevronDown,
  RotateCw,
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

/** Max chips visible in a node's skill / extension pool before collapsing. */
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
  const [activeTab, setActiveTab] = useState<'bots' | 'nodes'>('nodes');
  const [pairingOpen, setPairingOpen] = useState(false);

  // Skill editor state
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [selectedNodeForSkill, setSelectedNodeForSkill] = useState<{ id: string; name: string } | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  // Extension editor state
  const [extensionEditorOpen, setExtensionEditorOpen] = useState(false);
  const [selectedNodeForExtension, setSelectedNodeForExtension] = useState<{ id: string; name: string } | null>(null);
  const [selectedExtId, setSelectedExtId] = useState<string | null>(null);

  // Bot editor state
  const [botEditorOpen, setBotEditorOpen] = useState(false);
  const [selectedBot, setSelectedBot] = useState<BotConfig | null>(null);

  // Deleting bot ID tracking
  const [deletingBotId, setDeletingBotId] = useState<string | null>(null);

  // Bot pending deletion (confirm dialog)
  const [botToDelete, setBotToDelete] = useState<BotConfig | null>(null);

  // Node removal (confirm dialog)
  const [nodeToRemove, setNodeToRemove] = useState<NodeWithBots | null>(null);
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

  // Bot list filtering
  const [botSearch, setBotSearch] = useState('');
  const [botFilterNode, setBotFilterNode] = useState<string>('all');

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

  const handleOpenCreateBot = () => {
    setSelectedBot(null);
    setBotEditorOpen(true);
  };

  const handleOpenEditBot = (bot: BotConfig) => {
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

  const handleRemoveNode = async () => {
    if (!nodeToRemove) return;

    setDeletingNodeId(nodeToRemove.id);
    try {
      await api.deleteNode(nodeToRemove.id);
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
    nodeName: string,
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
    const nodeName = node.name;
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

    startRestartPolling(nodeId, nodeName, prevPid, prevStartedAt);
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

  // Flatten all bots for summary
  const allBots: { bot: BotConfig; node: NodeWithBots }[] = [];
  nodes.forEach((n) => {
    (n.bots || []).forEach((b) => {
      allBots.push({ bot: b, node: n });
    });
  });

  // Apply search + node filter to the bot list
  const keyword = botSearch.trim().toLowerCase();
  const filteredBots = allBots.filter(({ bot }) => {
    if (botFilterNode !== 'all' && bot.nodeId !== botFilterNode) return false;
    if (!keyword) return true;
    return (
      bot.name.toLowerCase().includes(keyword) ||
      bot.id.toLowerCase().includes(keyword) ||
      (bot.description || '').toLowerCase().includes(keyword)
    );
  });

  const hasActiveBotFilter = Boolean(keyword) || botFilterNode !== 'all';

  const resetBotFilter = () => {
    setBotSearch('');
    setBotFilterNode('all');
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
              节点与智能体
            </h1>
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

          <button
            onClick={handleOpenCreateBot}
            disabled={nodes.length === 0}
            className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:bg-zinc-300 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500 rounded-lg text-xs font-medium transition-colors shadow-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">新建智能体</span>
            <span className="sm:hidden">新建</span>
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-6 lg:p-8 space-y-6 max-w-6xl w-full mx-auto">
        {/* Mobile Segmented Tabs */}
        <div className="md:hidden flex p-1 bg-zinc-200/70 dark:bg-zinc-800/70 rounded-xl border border-zinc-200 dark:border-zinc-700">
          <button
            type="button"
            onClick={() => setActiveTab('nodes')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${
              activeTab === 'nodes'
                ? 'bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 shadow-xs'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            计算节点 ({nodes.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('bots')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${
              activeTab === 'bots'
                ? 'bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 shadow-xs'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            智能体 ({allBots.length})
          </button>
        </div>

        {/* Section: Compute Nodes */}
        <section
          aria-labelledby="nodes-heading"
          className={activeTab === 'nodes' ? 'block' : 'hidden md:block'}
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 id="nodes-heading" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  计算节点
                </h2>
                <span className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full font-mono border border-zinc-200 dark:border-zinc-700">
                  {nodes.length} 台
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Node Agent 维持长连接，提供本地隔离的运行环境与工具链
              </p>
            </div>
          </div>

          {nodes.length === 0 ? (
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700 p-8 text-center">
              <Server className="w-9 h-9 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-1">暂无已连接的计算节点</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4 max-w-md mx-auto">
                请点击右上角「配对节点」，并在目标计算设备或服务器终端执行配对命令完成接入。
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {nodes.map((node) => {
                const isOnline = node.status === 'online';
                const isRestarting = restartingNodeIds.has(node.id);
                const absoluteLastSeen = new Date(node.lastSeenAt).toLocaleString();
                const isRemovingNode = deletingNodeId === node.id;
                const uptimeText = node.startedAt ? formatUptime(node.startedAt) : '';

                return (
                  <div
                    key={node.id}
                    className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200/90 dark:border-zinc-800/90 p-4 shadow-xs flex flex-col justify-between gap-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all"
                  >
                    <div>
                      {/* Node Header */}
                      <div className="flex items-start justify-between gap-2 mb-2">
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
                            <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5 truncate">
                              <span className="truncate">{node.name}</span>
                              <span className="text-[10px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded font-mono text-zinc-600 dark:text-zinc-400 shrink-0">
                                {node.platform}
                              </span>
                            </div>
                            <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 block truncate">
                              ID: {node.id}
                            </span>
                          </div>
                        </div>

                        {/* Status Indicator, Restart & Remove */}
                        <div className="flex flex-col items-end shrink-0 pt-0.5">
                          <div className="flex items-center gap-1.5">
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
                              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200/80 dark:border-zinc-800/80 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                              title={!isOnline ? '节点已离线，无法重启' : '重启计算节点'}
                            >
                              {isRestarting ? (
                                <Loader2 className="w-3 h-3 animate-spin-fast text-amber-500" />
                              ) : (
                                <RotateCw className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
                              )}
                              <span>{isRestarting ? '重启中…' : '重启'}</span>
                            </button>

                            <button
                              onClick={() => setNodeToRemove(node)}
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

                          {node.pid != null && (
                            <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono mt-0.5">
                              PID {node.pid}{uptimeText ? ` · 运行 ${uptimeText}` : ''}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400 mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800/60">
                        <span className="flex items-center gap-1">
                          <Bot className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                          <span>承载 <strong>{node.bots?.length || 0}</strong> 个智能体</span>
                        </span>
                        <span className="flex items-center gap-1" title={absoluteLastSeen}>
                          <Clock className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                          <span>最后心跳: {formatRelativeTime(node.lastSeenAt)}</span>
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      {/* Node Skills Pool */}
                      <div className="bg-zinc-50/70 dark:bg-zinc-900/70 rounded-lg p-2.5 border border-zinc-100 dark:border-zinc-800/60">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1">
                            <Wrench className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
                            <span>技能库 ({node.skills?.length || 0})</span>
                          </span>
                          <button
                            onClick={() => handleOpenNewSkill(node)}
                            className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 flex items-center gap-0.5 cursor-pointer"
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
                                <button
                                  key={skill}
                                  onClick={() => handleOpenEditSkill(node, skill)}
                                  className="group px-2 py-0.5 bg-white hover:bg-zinc-100 dark:bg-zinc-950 dark:hover:bg-zinc-800 border border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600 rounded-md text-[11px] font-mono text-zinc-700 dark:text-zinc-300 flex items-center gap-1 transition-all shadow-2xs cursor-pointer"
                                  title="点击查看并编辑说明文档"
                                >
                                  <span>{skill}</span>
                                  <Edit className="w-2.5 h-2.5 opacity-40 group-hover:opacity-100" />
                                </button>
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

                      {/* Node Extensions Pool */}
                      <div className="bg-zinc-50/70 dark:bg-zinc-900/70 rounded-lg p-2.5 border border-zinc-100 dark:border-zinc-800/60">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1">
                            <Blocks className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
                            <span>扩展库 ({node.extensions?.length || 0})</span>
                          </span>
                          <button
                            onClick={() => handleOpenNewExtension(node)}
                            className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 flex items-center gap-0.5 cursor-pointer"
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
                                  className="group px-2 py-0.5 bg-white hover:bg-zinc-100 dark:bg-zinc-950 dark:hover:bg-zinc-800 border border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600 rounded-md text-[11px] font-mono text-zinc-700 dark:text-zinc-300 flex items-center gap-1 transition-all shadow-2xs cursor-pointer"
                                  title="点击查看并编辑扩展代码"
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
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Section: Agents (BOTs) */}
        <section
          aria-labelledby="bots-heading"
          className={activeTab === 'bots' ? 'block' : 'hidden md:block'}
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 id="bots-heading" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  智能体
                </h2>
                <span className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full font-mono border border-zinc-200 dark:border-zinc-700">
                  {hasActiveBotFilter ? `${filteredBots.length} / ${allBots.length}` : allBots.length} 个
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                独立的人设、记忆与运行配置，运行于绑定的计算节点
              </p>
            </div>
            {nodes.length > 0 && (
              <button
                onClick={handleOpenCreateBot}
                className="text-xs font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 hidden sm:flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新建智能体</span>
              </button>
            )}
          </div>

          {/* Filter Bar: keyword search + node filter */}
          {(allBots.length > 0 || hasActiveBotFilter) && (
            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  value={botSearch}
                  onChange={(e) => setBotSearch(e.target.value)}
                  placeholder="搜索名称 / ID / 描述…"
                  className="w-full pl-8 pr-7 py-1.5 text-xs bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-500 transition-colors"
                />
                {botSearch && (
                  <button
                    onClick={() => setBotSearch('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300 rounded transition-colors cursor-pointer"
                    aria-label="清除搜索"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              {nodes.length > 1 && (
                <select
                  value={botFilterNode}
                  onChange={(e) => setBotFilterNode(e.target.value)}
                  className="px-2.5 py-1.5 text-xs bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-500 transition-colors cursor-pointer"
                  aria-label="按节点筛选智能体"
                >
                  <option value="all">全部节点</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {allBots.length === 0 && !hasActiveBotFilter ? (
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700 p-8 text-center">
              <Bot className="w-9 h-9 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-1">暂无智能体</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4 max-w-md mx-auto">
                创建智能体并赋予独立的人设、记忆与技能配置。
              </p>
              {nodes.length > 0 ? (
                <button
                  onClick={handleOpenCreateBot}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white rounded-lg text-xs font-medium shadow-xs transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>新建智能体</span>
                </button>
              ) : (
                <p className="text-xs text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40 p-2.5 rounded-lg border border-amber-200 dark:border-amber-900/60 inline-block">
                  请先接入至少一个计算节点后再创建智能体
                </p>
              )}
            </div>
          ) : filteredBots.length === 0 ? (
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700 p-8 text-center">
              <Search className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-1">没有符合条件的智能体</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">尝试调整搜索关键词或节点筛选条件。</p>
              <button
                onClick={resetBotFilter}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>清除筛选条件</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredBots.map(({ bot, node }) => {
                const isDeleting = deletingBotId === bot.id;
                const shortModel = getShortModelId(bot.modelId);
                const thinkingText = formatThinkingLevel(bot.thinkingLevel);

                // Collect enabled skills and extensions compactly
                const enabledItems = [
                  ...(bot.enabledSkills || []).map((s) => ({ type: 'skill' as const, name: s })),
                  ...(bot.enabledExtensions || []).map((e) => ({ type: 'ext' as const, name: e })),
                ];

                return (
                  <div
                    key={bot.id}
                    className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200/90 dark:border-zinc-800/90 p-4 shadow-xs flex flex-col justify-between hover:border-zinc-300 dark:hover:border-zinc-700 transition-all group"
                  >
                    <div>
                      {/* 1. Card Header */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200/70 dark:border-zinc-700/70 flex items-center justify-center shrink-0">
                            <Bot className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 truncate">
                              {bot.name}
                            </div>
                            <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 block truncate">
                              @{bot.id}
                            </span>
                          </div>
                        </div>

                        {/* Node Tag */}
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md text-[10px] text-zinc-600 dark:text-zinc-400 font-medium shrink-0 max-w-[120px] truncate">
                          <Server className="w-2.5 h-2.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                          <span className="truncate">{node.name}</span>
                        </span>
                      </div>

                      {/* 2. Card Middle: Description */}
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-3 line-clamp-2 min-h-[36px] leading-relaxed">
                        {bot.description || '暂无角色描述'}
                      </p>
                    </div>

                    {/* 3. Card Bottom: Metadata and Actions */}
                    <div>
                      <div className="pt-2.5 border-t border-zinc-100 dark:border-zinc-800/60 flex flex-wrap items-center gap-1.5 mb-3">
                        {/* Short Model Name */}
                        <span
                          className="font-mono text-[11px] text-zinc-700 bg-zinc-100 dark:text-zinc-300 dark:bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-200/60 dark:border-zinc-700/60 truncate max-w-[140px]"
                          title={bot.modelId}
                        >
                          {shortModel}
                        </span>

                        {/* Thinking Level */}
                        {thinkingText && (
                          <span className="text-[10px] text-zinc-600 bg-zinc-100 dark:text-zinc-400 dark:bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 font-medium">
                            {thinkingText}
                          </span>
                        )}

                        {/* Compact Skills & Extensions tags with type icons */}
                        {enabledItems.length > 0 ? (
                          <>
                            {enabledItems.slice(0, 2).map((item) => (
                              <span
                                key={`${item.type}-${item.name}`}
                                className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-600 bg-zinc-50 dark:text-zinc-400 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800/80 px-1.5 py-0.5 rounded truncate max-w-[110px]"
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
                              <span className="text-[10px] font-mono text-zinc-400 bg-zinc-50 dark:text-zinc-500 dark:bg-zinc-900 px-1 py-0.5 rounded border border-zinc-200/60 dark:border-zinc-800/60">
                                +{enabledItems.length - 2}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">无附加组件</span>
                        )}
                      </div>

                      {/* Card Actions */}
                      <div className="pt-2.5 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between">
                        <button
                          onClick={() => handleOpenEditBot(bot)}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200/80 dark:border-zinc-800/80"
                        >
                          <Edit className="w-3 h-3" />
                          <span>配置</span>
                        </button>

                        <button
                          onClick={() => setBotToDelete(bot)}
                          disabled={isDeleting}
                          className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:text-zinc-500 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                          title="删除该智能体"
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
                  </div>
                );
              })}
            </div>
          )}
        </section>
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
        title="移除计算节点"
        danger
        busy={deletingNodeId !== null}
        confirmText={nodeToRemove && (nodeToRemove.bots?.length || 0) > 0 ? '无法移除' : '移除节点'}
        confirmDisabled={nodeToRemove !== null && (nodeToRemove.bots?.length || 0) > 0}
        onConfirm={handleRemoveNode}
        onClose={() => {
          if (deletingNodeId === null) setNodeToRemove(null);
        }}
        message={
          nodeToRemove ? (
            (nodeToRemove.bots?.length || 0) > 0 ? (
              <>
                节点「{nodeToRemove.name}」下仍有 <strong>{nodeToRemove.bots?.length}</strong> 个智能体。
                <br />
                请先删除该节点下的全部智能体，再进行移除。
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
        nodes={nodes}
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

