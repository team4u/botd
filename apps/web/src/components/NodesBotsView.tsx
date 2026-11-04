import React, { useState, useEffect, useRef } from 'react';
import {
  Server,
  Terminal,
  Trash2,
  Loader2,
  Clock,
  RotateCw,
  PowerOff,
  ArrowUpCircle,
  Bot,
} from 'lucide-react';
import type { NodeWithBots, BotConfig, NodeUpgradeCheckResult } from '@botd/protocol';

import { PairingModal } from './PairingModal';
import { ConfirmDialog } from './ConfirmDialog';
import { api } from '../api';
import { formatUptime, formatRelativeTime } from './NodesBotsView/helpers';
import { BotListSection } from './NodesBotsView/BotListSection';
import { SkillsPoolSection, ExtensionsPoolSection } from './NodesBotsView/ResourcePools';
import { DeleteBotDialog, RemoveNodeDialog, RestartNodeDialog } from './NodesBotsView/NodeDialogs';
import { EditorModals } from './NodesBotsView/EditorModals';
import { ViewHeader } from './NodesBotsView/ViewHeader';

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
  const [selectedParentBot, setSelectedParentBot] = useState<BotConfig | null>(null);
  const [initialBotTab, setInitialBotTab] = useState<'basic' | 'system' | 'memory'>('basic');

  // Deleting bot ID tracking
  const [deletingBotId, setDeletingBotId] = useState<string | null>(null);

  // Bot pending deletion (confirm dialog)
  const [botToDelete, setBotToDelete] = useState<BotConfig | null>(null);

  // Node removal (confirm dialog): null | 'regular' | 'force'
  const [nodeToRemove, setNodeToRemove] = useState<NodeWithBots | null>(null);
  const [forceRemoveMode, setForceRemoveMode] = useState(false);
  const [deletingNodeId, setDeletingNodeId] = useState<string | null>(null);

  // Node restart state & confirm dialog
  const [nodeToRestart, setNodeToRestart] = useState<NodeWithBots | null>(null);
  const [restartingNodeIds, setRestartingNodeIds] = useState<Set<string>>(new Set());

  // Node upgrade state & confirm dialog
  const [nodeToUpgrade, setNodeToUpgrade] = useState<NodeWithBots | null>(null);
  const [upgradeCheckInfo, setUpgradeCheckInfo] = useState<NodeUpgradeCheckResult | null>(null);
  const [checkingUpgradeNodeId, setCheckingUpgradeNodeId] = useState<string | null>(null);
  const [upgradingNodeIds, setUpgradingNodeIds] = useState<Set<string>>(new Set());
  // 升级检查的节点守卫 ref：慢响应迟到时校验捕获的节点仍是当前弹窗目标，防止 A 的结果覆盖 B 的弹窗
  const nodeToUpgradeIdRef = useRef<string | null>(null);
  const openUpgradeModalFor = (node: NodeWithBots) => {
    nodeToUpgradeIdRef.current = node.id;
    setNodeToUpgrade(node);
  };
  const closeUpgradeModal = () => {
    nodeToUpgradeIdRef.current = null;
    setNodeToUpgrade(null);
    setUpgradeCheckInfo(null);
  };

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
    setSelectedParentBot(null);
    setInitialBotTab('basic');
    setBotEditorOpen(true);
  };

  const handleOpenCreateSubagent = (node: NodeWithBots, parentBot: BotConfig) => {
    setSelectedNodeForBot(node);
    setSelectedBot(null);
    setSelectedParentBot(parentBot);
    setInitialBotTab('basic');
    setBotEditorOpen(true);
  };

  const handleOpenEditBot = (
    node: NodeWithBots,
    bot: BotConfig,
    tab: 'basic' | 'system' | 'memory' = 'basic'
  ) => {
    setSelectedNodeForBot(node);
    setSelectedBot(bot);
    const parent = bot.parentBotId
      ? (node.bots || []).find((b) => b.id === bot.parentBotId) || null
      : null;
    setSelectedParentBot(parent);
    setInitialBotTab(tab);
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
    nodeNameOrPrevPid?: string | number,
    prevPidOrStartedAt?: number | string,
    prevStartedAtParam?: string
  ) => {
    let prevPid: number | undefined;
    let prevStartedAt: string | undefined;

    if (typeof nodeNameOrPrevPid === 'string') {
      prevPid = typeof prevPidOrStartedAt === 'number' ? prevPidOrStartedAt : undefined;
      prevStartedAt = prevStartedAtParam;
    } else {
      prevPid = typeof nodeNameOrPrevPid === 'number' ? nodeNameOrPrevPid : undefined;
      prevStartedAt = typeof prevPidOrStartedAt === 'string' ? prevPidOrStartedAt : undefined;
    }

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
        setUpgradingNodeIds((prev) => {
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
            setUpgradingNodeIds((prev) => {
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

  const handleOpenUpgradeModal = (node: NodeWithBots) => {
    openUpgradeModalFor(node);
    setUpgradeCheckInfo(null);
    setCheckingUpgradeNodeId(node.id);
    api.checkNodeUpgrade(node.id)
      .then((info) => {
        // 节点守卫：慢响应迟到时弹窗可能已切换到其他节点（或已关闭），
        // 旧节点的检查结果不能覆盖新弹窗，否则确认后会把 B 节点升到 A 的目标版本
        if (nodeToUpgradeIdRef.current !== node.id) return;
        setUpgradeCheckInfo(info);
      })
      .catch((err: any) => {
        console.warn('[NodesBotsView] Check upgrade failed:', err);
      })
      .finally(() => {
        setCheckingUpgradeNodeId((current) => (current === node.id ? null : current));
      });
  };

  const handleConfirmUpgrade = async () => {
    if (!nodeToUpgrade) return;

    const node = nodeToUpgrade;
    const nodeId = node.id;
    const nodeName = node.name;
    const prevPid = node.pid;
    const prevStartedAt = node.startedAt;
    const targetVersion = upgradeCheckInfo?.latestVersion;

    closeUpgradeModal();
    setUpgradingNodeIds((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });

    try {
      const result = await api.upgradeNode(nodeId, targetVersion);
      if (!result.upgraded) {
        setUpgradingNodeIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        onAddToast('info', `节点已是最新版本 v${result.targetVersion}`);
        return;
      }

      startRestartPolling(nodeId, nodeName, prevPid, prevStartedAt);
    } catch (err: any) {
      setUpgradingNodeIds((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
      onAddToast('error', err?.message || '升级节点失败');
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

  const onlineCount = nodes.filter((n) => n.status === 'online').length;

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-50/60 dark:bg-zinc-900/60 overflow-hidden text-zinc-900 dark:text-zinc-100">
      {/* Top Header */}
      <ViewHeader
        onlineCount={onlineCount}
        totalCount={nodes.length}
        loading={loading}
        onRefresh={() => onRefresh()}
        onBackToChat={onBackToChat}
        onToggleSidebar={onToggleSidebar}
        onOpenPairing={() => setPairingOpen(true)}
      />

      {/* Main Body: one node = one card, bots live inside their owning node */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-6 lg:p-8 space-y-4 max-w-5xl w-full mx-auto">
        {nodes.length === 0 ? (
          <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700 p-8 text-center">
            <Server className="w-9 h-9 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-1">暂无已连接的计算节点</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4 max-w-md mx-auto">
              可配对计算节点接入，也可以直接在 Hub 本地新建智能体：智能体、技能与扩展均由 Hub SQLite
              权威存储，节点接入后自动同步。
            </p>
            <button
              onClick={() => setPairingOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white rounded-lg text-xs font-medium shadow-xs transition-colors"
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>配对新节点</span>
            </button>
            <button
              onClick={() =>
                handleOpenCreateBot({
                  id: 'local',
                  name: 'Local Hub',
                  platform: 'linux',
                  status: 'online',
                  lastSeenAt: new Date().toISOString(),
                  createdAt: new Date().toISOString(),
                  bots: [],
                  skills: [],
                  extensions: [],
                })
              }
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 ml-2 bg-white hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs font-medium shadow-xs transition-colors cursor-pointer"
              title="在 Hub 本地直接新建智能体（配置存于 Hub SQLite，节点接入后即可调度）"
            >
              <Bot className="w-3.5 h-3.5" />
              <span>直接新建智能体 (Hub 本地)</span>
            </button>
          </div>
        ) : (
          nodes.map((node) => {
            const isOnline = node.status === 'online';
            const isRestarting = restartingNodeIds.has(node.id);
            const isUpgrading = upgradingNodeIds.has(node.id);
            const absoluteLastSeen = new Date(node.lastSeenAt).toLocaleString();
            const isRemovingNode = deletingNodeId === node.id;
            const uptimeText = node.startedAt ? formatUptime(node.startedAt) : '';
            const nodeBots = node.bots || [];

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
                        {node.version && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded font-mono text-zinc-600 dark:text-zinc-400 shrink-0">
                            v{node.version}
                          </span>
                        )}
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

                  {/* Status Indicator, Upgrade, Restart & Remove */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isUpgrading ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                        <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-amber-500" />
                        <span>升级中</span>
                      </span>
                    ) : isRestarting ? (
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
                      onClick={() => handleOpenUpgradeModal(node)}
                      disabled={!isOnline || isRestarting || isUpgrading}
                      className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      title={!isOnline ? '节点已离线，无法升级' : '升级计算节点'}
                      aria-label={`升级节点 ${node.name}`}
                    >
                      {isUpgrading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-amber-500" />
                      ) : (
                        <ArrowUpCircle className="w-3.5 h-3.5" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setNodeToRestart(node)}
                      disabled={!isOnline || isRestarting || isUpgrading}
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

                {/* Offline banner: bots on this node can't chat but stay editable in Hub */}
                {!isOnline && nodeBots.length > 0 && (
                  <div className="mx-4 mb-3 p-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-2">
                    <PowerOff className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      节点离线：以下 {nodeBots.length} 个智能体暂不可对话（配置存于 Hub SQLite，仍可正常编辑，节点恢复后自动生效）。
                    </span>
                  </div>
                )}

                {/* 2. Bots section: bots belong to this node */}
                <BotListSection
                  node={node}
                  isOnline={isOnline}
                  deletingBotId={deletingBotId}
                  onOpenCreateBot={handleOpenCreateBot}
                  onOpenCreateSubagent={handleOpenCreateSubagent}
                  onOpenEditBot={handleOpenEditBot}
                  onDeleteBot={setBotToDelete}
                />

                {/* 3. Skills pool */}
                <SkillsPoolSection
                  node={node}
                  expandedPools={expandedPools}
                  onTogglePool={togglePool}
                  onOpenNewSkill={handleOpenNewSkill}
                  onOpenEditSkill={handleOpenEditSkill}
                />

                {/* 4. Extensions pool */}
                <ExtensionsPoolSection
                  node={node}
                  expandedPools={expandedPools}
                  onTogglePool={togglePool}
                  onOpenNewExtension={handleOpenNewExtension}
                  onOpenEditExtension={handleOpenEditExtension}
                />
              </section>
            );
          })
        )}
      </div>

      {/* Submodals */}
      <PairingModal isOpen={pairingOpen} onClose={() => setPairingOpen(false)} />

      <DeleteBotDialog
        botToDelete={botToDelete}
        deletingBotId={deletingBotId}
        onConfirm={handleDeleteBot}
        onClose={() => {
          if (deletingBotId === null) setBotToDelete(null);
        }}
      />

      <RemoveNodeDialog
        nodeToRemove={nodeToRemove}
        forceRemoveMode={forceRemoveMode}
        deletingNodeId={deletingNodeId}
        setForceRemoveMode={setForceRemoveMode}
        onConfirm={handleRemoveNode}
        onClose={() => {
          if (deletingNodeId === null) setNodeToRemove(null);
        }}
      />

      <RestartNodeDialog
        nodeToRestart={nodeToRestart}
        onConfirm={handleConfirmRestart}
        onClose={() => setNodeToRestart(null)}
      />

      <ConfirmDialog
        isOpen={nodeToUpgrade !== null}
        title="升级计算节点"
        confirmText="确认升级"
        confirmDisabled={nodeToUpgrade ? upgradingNodeIds.has(nodeToUpgrade.id) : false}
        busy={nodeToUpgrade ? upgradingNodeIds.has(nodeToUpgrade.id) : false}
        onConfirm={handleConfirmUpgrade}
        onClose={() => {
          if (!nodeToUpgrade || !upgradingNodeIds.has(nodeToUpgrade.id)) {
            closeUpgradeModal();
          }
        }}
        message={
          nodeToUpgrade ? (
            <div className="space-y-3">
              <div>
                确定要升级计算节点「<strong>{nodeToUpgrade.name}</strong>」吗？
              </div>
              <div className="text-xs space-y-1.5 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80">
                <div className="text-zinc-700 dark:text-zinc-300">
                  当前版本：<span className="font-mono">{nodeToUpgrade.version || '未知'}</span>
                </div>
                {checkingUpgradeNodeId === nodeToUpgrade.id ? (
                  <div className="flex items-center gap-1.5 text-zinc-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-zinc-400" />
                    <span>正在检查最新版本...</span>
                  </div>
                ) : upgradeCheckInfo ? (
                  <>
                    {upgradeCheckInfo.updateAvailable ? (
                      <div className="text-emerald-600 dark:text-emerald-400 font-medium">
                        发现新版本 v{upgradeCheckInfo.latestVersion}
                      </div>
                    ) : (
                      <div className="text-zinc-500 dark:text-zinc-400">
                        当前已是最新版本 (v{upgradeCheckInfo.currentVersion})
                      </div>
                    )}
                    {upgradeCheckInfo.blocked && (
                      <div className="p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg text-amber-800 dark:text-amber-300 text-[11px]">
                        上次升级至 v{upgradeCheckInfo.blocked.version} 失败回滚原因：{upgradeCheckInfo.blocked.reason}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
              <p className="text-zinc-500 dark:text-zinc-400 text-[11px] leading-relaxed">
                升级期间节点会先等待在途任务完成、自动校验新版本，若新版本启动异常会自动回滚至当前版本。
              </p>
            </div>
          ) : null
        }
      />

      <EditorModals
        skill={{ open: skillEditorOpen, node: selectedNodeForSkill, skillId: selectedSkillId, setOpen: setSkillEditorOpen }}
        extension={{
          open: extensionEditorOpen,
          node: selectedNodeForExtension,
          extId: selectedExtId,
          setOpen: setExtensionEditorOpen,
          bots: nodes.find((n) => n.id === selectedNodeForExtension?.id)?.bots,
        }}
        bot={{
          open: botEditorOpen,
          node: selectedNodeForBot,
          selected: selectedBot,
          parentBot: selectedParentBot,
          initialTab: initialBotTab,
          setOpen: setBotEditorOpen,
          clearParent: () => setSelectedParentBot(null),
        }}
        onSaved={async (toast) => {
          onAddToast('success', toast);
          await onRefresh();
        }}
      />
    </div>
  );
};
