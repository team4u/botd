import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { SessionRecord, NodeWithBots, BotConfig, NodeRecord, UserRecord } from '@botd/protocol';
import { api, AuthRequiredError } from './api';
import { useHashRoute } from './hooks/useHashRoute';
import { useToasts } from './hooks/useToasts';
import { useNotifications } from './hooks/useNotifications';
import { useSessionMessages } from './hooks/useSessionMessages';
import { useEventStream } from './hooks/useEventStream';
import { useSessionActions } from './hooks/useSessionActions';
import { LoginView } from './components/LoginView';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { CreateSessionModal } from './components/CreateSessionModal';
import { NodesBotsView } from './components/NodesBotsView';
import { SettingsModal } from './components/SettingsModal';
import { UsersModal } from './components/UsersModal';
import { ToastContainer } from './components/Toast';
import { Loader2, Menu, Bot } from 'lucide-react';

export const App: React.FC = () => {
  // Auth state
  const [authChecking, setAuthChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const authenticatedRef = useRef(false);
  const [currentUser, setCurrentUser] = useState<UserRecord | null>(null);

  // View state（视图/当前会话/弹窗统一进 hash 路由）
  const { route, navigate } = useHashRoute();
  const { view: currentView, sessionId: activeSessionId, modal: openModal } = route;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Data state
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  // 全局 SSE 分流时同步读取最新列表（避免闭包拿到陈旧数据）
  const sessionsRef = useRef<SessionRecord[]>([]);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef<string | null>(null);

  // Synchronize refs（与原实现一致：effect 时机同步，避免 render 中途读到提前切换的值）
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const [nodes, setNodes] = useState<NodeWithBots[]>([]);
  // node_status 事件分流时同步读取最新节点列表
  const nodesRef = useRef<NodeWithBots[]>([]);
  nodesRef.current = nodes;
  const [loadingNodes, setLoadingNodes] = useState(false);

  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  // 统一的登录失效处理（各 hook 通过 ref 消费，避免闭包陈旧）
  const onAuthLost = useCallback(() => {
    setAuthenticated(false);
    authenticatedRef.current = false;
  }, []);
  const onAuthLostRef = useRef(onAuthLost);
  onAuthLostRef.current = onAuthLost;

  const { toasts, addToast, dismissToast } = useToasts();

  // Bot & Node maps for fast lookups
  const { botMap, allBots, nodeMap } = useMemo(() => {
    const bMap = new Map<string, BotConfig>();
    const nMap = new Map<string, NodeRecord>();
    const botsList: BotConfig[] = [];

    nodes.forEach((node) => {
      nMap.set(node.id, node);
      (node.bots || []).forEach((bot) => {
        bMap.set(bot.id, bot);
        botsList.push(bot);
      });
    });

    return { botMap: bMap, allBots: botsList, nodeMap: nMap };
  }, [nodes]);

  // 全局 SSE 回调里读取最新 botMap（订阅不随会话/节点重建，避免闭包拿到陈旧映射）
  const botMapRef = useRef(botMap);
  botMapRef.current = botMap;

  // Active session object
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );

  // Notifications（未读计数 + 标题角标 + 后台通知/提示音）
  const notifications = useNotifications(authenticated, navigate, botMapRef);

  // 会话 CRUD 动作组（依赖 sessions/botMap，内部含创建/删除防抖）
  const sessionActions = useSessionActions({
    sessions,
    setSessions,
    botMap,
    activeSessionIdRef,
    onAuthLostRef,
    addToast,
    navigate,
    onSessionsRemoved: notifications.removeSessions,
  });

  // 当前会话消息状态机（SSE 实时流式/分页/截断/人机协同）
  const chat = useSessionMessages({
    authenticated,
    activeSessionId,
    activeSessionIdRef,
    onAuthLostRef,
    addToast,
    navigate,
    setSessions,
    onSessionActivated: notifications.markSessionRead,
    notifyHiddenCompletion: notifications.notifyHiddenCompletion,
    onNewTopic: sessionActions.handleNewTopic,
  });

  // 全局 SSE 订阅与事件分流（不随会话切换重建）
  useEventStream({
    authenticated,
    authenticatedRef,
    sessionsRef,
    nodesRef,
    setSessions,
    setNodes,
    activeSessionIdRef,
    applyLiveSessionEvent: chat.applyLiveSessionEvent,
    onForeignSessionMessage: (_sessionId, message) => {
      notifications.notifyBackgroundMessage(message);
    },
    onForeignSessionIdle: () => chat.resetCancelling(),
    recoverAfterReconnect: chat.recoverAfterReconnect,
  });

  // 补拉会话列表的防重入标记（记录已尝试补拉过的 activeSessionId）
  const sessionFetchAttemptedRef = useRef<string | null>(null);

  // 修复子会话路由空白：activeSessionId 非空但 sessions 里找不到（例如刚创建的子会话通过
  // #?s=sess_xxx 访问、列表快照未包含它）且已登录时，补拉一次会话列表，
  // 避免 activeSession 为 null 掉进空白欢迎页；拉不到（无权限/已删除）时清空路由回到默认会话
  useEffect(() => {
    if (!authenticated || !activeSessionId) return;
    if (sessions.some((s) => s.id === activeSessionId)) return;
    // 防重入：同一会话 ID 只补拉一次（拉不到说明无权限/已删除，避免 SSE 高频重渲染反复触发）
    if (sessionFetchAttemptedRef.current === activeSessionId) return;
    sessionFetchAttemptedRef.current = activeSessionId;
    let cancelled = false;
    api
      .getSessions()
      .then((fetched) => {
        if (cancelled || !isMountedRef.current) return;
        setSessions((prev) => {
          const knownIds = new Set(prev.map((s) => s.id));
          const additions = fetched.filter((s) => !knownIds.has(s.id));
          return additions.length > 0 ? [...additions, ...prev] : prev;
        });
      })
      .catch(() => {
        // 静默失败：保留现状，不打断当前视图
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated, activeSessionId, sessions]);

  // Check auth on mount，成功后再取当前用户信息（未拿到则回登录页）
  useEffect(() => {
    let mounted = true;
    api.checkAuth()
      .then(async (isAuth) => {
        if (!isAuth) {
          if (!mounted) return;
          setAuthenticated(false);
          authenticatedRef.current = false;
          setAuthChecking(false);
          return;
        }
        try {
          const me = await api.me();
          if (!mounted) return;
          setCurrentUser(me.user || null);
          setAuthenticated(true);
          authenticatedRef.current = true;
        } catch {
          if (!mounted) return;
          setCurrentUser(null);
          setAuthenticated(false);
          authenticatedRef.current = false;
        } finally {
          if (mounted) setAuthChecking(false);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setAuthenticated(false);
        authenticatedRef.current = false;
        setAuthChecking(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Surface real network/auth errors, do NOT individually catch with empty arrays
  const loadInitialData = useCallback(async () => {
    try {
      setLoadingNodes(true);
      const [fetchedNodes, fetchedSessions] = await Promise.all([
        api.getNodes(),
        api.getSessions(),
      ]);

      if (!isMountedRef.current) return;

      setNodes(fetchedNodes);
      setSessions(fetchedSessions);

      // Preserve valid active session or select first
      navigate((prev) => {
        if (prev.sessionId && fetchedSessions.some((s) => s.id === prev.sessionId)) {
          return {};
        }
        return { sessionId: fetchedSessions[0]?.id || null };
      });
    } catch (err: any) {
      if (!isMountedRef.current) return;
      if (err instanceof AuthRequiredError || err?.status === 401) {
        onAuthLostRef.current();
      } else {
        addToast('error', err?.message || '初始化数据加载失败');
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingNodes(false);
      }
    }
  }, [addToast, navigate]);

  useEffect(() => {
    if (authenticated) {
      loadInitialData();
    }
  }, [authenticated, loadInitialData]);

  // Modest polling every 10s for nodes when authenticated & window focused
  useEffect(() => {
    if (!authenticated) return;

    const pollInterval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!authenticatedRef.current || !isMountedRef.current) return;

      api.getNodes()
        .then((fetchedNodes) => {
          if (!authenticatedRef.current || !isMountedRef.current) return;
          setNodes(fetchedNodes);
        })
        .catch((err: any) => {
          if (!authenticatedRef.current || !isMountedRef.current) return;
          if (err instanceof AuthRequiredError || err?.status === 401) {
            onAuthLostRef.current();
          }
        });
    }, 10000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [authenticated]);

  const handleLoginSuccess = () => {
    // 登录成功后立即拉取当前用户信息供侧边栏展示
    api
      .me()
      .then((me) => {
        setCurrentUser(me.user || null);
      })
      .catch(() => {
        setCurrentUser(null);
      });
    setAuthenticated(true);
    authenticatedRef.current = true;
  };

  const handleLogout = async () => {
    chat.invalidateForLogout();
    authenticatedRef.current = false;

    try {
      await api.logout();
    } catch {
      // ignore
    }
    setAuthenticated(false);
    setCurrentUser(null);
    setSessions([]);
    notifications.clearAll();
    navigate({ sessionId: null, modal: null, view: 'chat', messageId: null });
    chat.resetForLogout();
    setNodes([]);
  };

  const handleRefreshNodes = async () => {
    try {
      setLoadingNodes(true);
      const fetchedNodes = await api.getNodes();
      if (isMountedRef.current) {
        setNodes(fetchedNodes);
      }
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        onAuthLostRef.current();
      } else {
        addToast('error', err?.message || '刷新节点列表失败');
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingNodes(false);
      }
    }
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-900 flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400 gap-3">
        <Loader2 className="w-6 h-6 animate-spin-fast text-zinc-900 dark:text-zinc-100" />
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">正在连接服务并校验登录状态...</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <>
        <LoginView onLoginSuccess={handleLoginSuccess} />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      {/* Responsive Sidebar */}
      <Sidebar
        sessions={sessions}
        bots={allBots}
        nodeMap={nodeMap}
        activeSessionId={activeSessionId}
        onSelectSession={(id, messageId) => {
          // 进入会话即清零未读并清除陈旧高亮（搜索跳转可携带 messageId）
          navigate({ sessionId: id, view: 'chat', messageId: messageId ?? null });
        }}
        onOpenBotChat={sessionActions.handleOpenBotChat}
        unreadCounts={notifications.unreadCounts}
        onSetArchived={sessionActions.handleSetArchived}
        onOpenNodesView={() => navigate({ view: 'nodes' })}
        onOpenSettings={() => navigate({ modal: 'settings' })}
        onLogout={handleLogout}
        onDeleteSession={sessionActions.handleDeleteSession}
        onDeleteSessions={sessionActions.handleDeleteSessions}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        currentUser={currentUser || undefined}
        onOpenUsers={() => navigate({ modal: 'users' })}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative bg-white dark:bg-zinc-950">
        {currentView === 'nodes' ? (
          <NodesBotsView
            nodes={nodes}
            loading={loadingNodes}
            onRefresh={handleRefreshNodes}
            onBackToChat={() => navigate({ view: 'chat' })}
            onToggleSidebar={() => setSidebarOpen(true)}
            onAddToast={addToast}
          />
        ) : activeSession ? (
          <ChatView
            session={activeSession}
            messages={chat.messages}
            loadingMessages={chat.loadingMessages}
            loadError={chat.loadError}
            onRetryLoad={() => activeSessionId && chat.loadMessagesForSession(activeSessionId, chat.sessionEpochRef.current)}
            botMap={botMap}
            nodeMap={nodeMap}
            nodes={nodes}
            onRefreshNodes={handleRefreshNodes}
            streamingStates={Object.values(chat.streamingStatesMap)}
            activeSubagentRuns={chat.subagentRunsMap}
            onSendMessage={chat.handleSendMessage}
            onEditMessage={chat.handleEditMessage}
            onCancelSession={chat.handleCancelSession}
            onToggleSidebar={() => setSidebarOpen(true)}
            onRenameSession={sessionActions.handleRenameSession}
            onClearMessages={chat.handleClearMessages}
            onDeleteSession={sessionActions.handleDeleteSession}
            onDeleteSessions={sessionActions.handleDeleteSessions}
            onNewTopic={sessionActions.handleNewTopic}
            onForkMessage={sessionActions.handleForkMessage}
            cancelling={chat.cancelling}
            pendingAsks={chat.pendingAsks}
            hasEarlierMessages={chat.hasEarlierMessages}
            loadingEarlier={chat.loadingEarlier}
            onLoadEarlier={chat.handleLoadEarlier}
            highlightMessageId={route.messageId}
            onRespondToAsk={chat.handleRespondToAsk}
            onAddToast={addToast}
            onInspectSubagentRun={(run) => chat.setInspectingRunId(run ? run.id : null)}
            inspectingRunId={chat.inspectingRunId}
          />
        ) : (
          /* Mobile startup header with accessible menu when no active session */
          <div className="flex-1 flex flex-col h-full bg-white dark:bg-zinc-950 overflow-hidden">
            <header className="h-14 px-4 bg-white/90 dark:bg-zinc-950/90 backdrop-blur-md border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between lg:hidden shrink-0">
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-2 -ml-2 text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl flex items-center gap-2"
                aria-label="打开侧边会话导航"
              >
                <Menu className="w-5 h-5 text-zinc-700 dark:text-zinc-300" />
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">会话列表</span>
              </button>
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">botd</span>
              </div>
            </header>

            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-14 h-14 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-center text-zinc-800 dark:text-zinc-200 mb-4 shadow-xs">
                <Bot className="w-7 h-7" />
              </div>
              <h2 className="text-sm sm:text-base font-bold text-zinc-900 dark:text-zinc-100 mb-1.5">欢迎使用 botd</h2>
              <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 max-w-sm leading-relaxed">
                从左侧智能体列表选择一个智能体即可开始对话。
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      <CreateSessionModal
        isOpen={openModal === 'create'}
        bots={allBots}
        nodeMap={nodeMap}
        onClose={() => navigate({ modal: null })}
        onCreateSession={sessionActions.handleCreateSession}
      />

      <SettingsModal
        isOpen={openModal === 'settings'}
        nodes={nodes}
        onClose={() => navigate({ modal: null })}
      />

      {currentUser?.role === 'admin' && (
        <UsersModal
          isOpen={openModal === 'users'}
          currentUser={currentUser}
          onClose={() => navigate({ modal: null })}
        />
      )}

      {/* Global Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
