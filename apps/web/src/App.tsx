import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type {
  SessionRecord,
  MessageRecord,
  NodeWithBots,
  BotConfig,
  NodeRecord,
  CreateSessionInput,
  SessionSseEvent,
} from '@botd/protocol';
import { api, AuthRequiredError, subscribeSessionEvents } from './api';
import type { StreamingAssistantState, ToastItem, MainViewTab, UserInfo } from './types';
import { LoginView } from './components/LoginView';
import { Sidebar, pickCurrentDirectSession } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { CreateSessionModal } from './components/CreateSessionModal';
import { GroupSettingsModal } from './components/GroupSettingsModal';
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
  const [currentUser, setCurrentUser] = useState<UserInfo | null>(null);

  // View state
  const [currentView, setCurrentView] = useState<MainViewTab>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Modals state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);

  // Data state
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [nodes, setNodes] = useState<NodeWithBots[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);

  // Streaming assistant state for active session
  const [streamingState, setStreamingState] = useState<StreamingAssistantState | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Toast notifications
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Epoch counter for session changes to protect against race conditions
  const sessionEpochRef = useRef<number>(0);
  const isMountedRef = useRef(true);

  // 单聊静默创建并发防抖：创建进行中忽略重复点击
  const creatingBotChatRef = useRef(false);

  // 会话分叉并发防抖：分叉请求进行中忽略重复点击
  const forkingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Synchronize refs
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  const addToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

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

  // Active session object
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );

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
      setActiveSessionId((prev) => {
        if (prev && fetchedSessions.some((s) => s.id === prev)) {
          return prev;
        }
        return fetchedSessions[0]?.id || null;
      });
    } catch (err: any) {
      if (!isMountedRef.current) return;
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
      } else {
        addToast('error', err?.message || '初始化数据加载失败');
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingNodes(false);
      }
    }
  }, [addToast]);

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
            setAuthenticated(false);
            authenticatedRef.current = false;
          }
        });
    }, 10000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [authenticated]);

  // Load messages with epoch guards and merge fetched snapshot with live incoming SSE messages
  const loadMessagesForSession = useCallback(async (sessionId: string, epoch: number) => {
    setLoadingMessages(true);
    setLoadError(null);

    try {
      const fetched = await api.getSessionMessages(sessionId);

      // Guard: only commit if still on this session and epoch
      if (!isMountedRef.current || sessionEpochRef.current !== epoch || activeSessionIdRef.current !== sessionId) {
        return;
      }

      setMessages((currentLive) => {
        // Merge history snapshot with newer live messages arrived via SSE
        const fetchedIds = new Set(fetched.map((m) => m.id));
        const newerLive = currentLive.filter((m) => !fetchedIds.has(m.id));
        return [...fetched, ...newerLive];
      });
    } catch (err: any) {
      if (!isMountedRef.current || sessionEpochRef.current !== epoch || activeSessionIdRef.current !== sessionId) {
        return;
      }
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
      } else {
        setLoadError(err?.message || '读取历史消息记录失败');
      }
    } finally {
      if (isMountedRef.current && sessionEpochRef.current === epoch && activeSessionIdRef.current === sessionId) {
        setLoadingMessages(false);
      }
    }
  }, []);

  // Subscribe to SSE with session switch clearing, failed status handling, and per-bot isolation
  useEffect(() => {
    if (!authenticated || !activeSessionId) {
      setStreamingState(null);
      setMessages([]);
      return;
    }

    const currentEpoch = ++sessionEpochRef.current;
    const targetSessionId = activeSessionId;
    activeSessionIdRef.current = targetSessionId;

    // Immediately clear messages and stream on session switch to prevent ghosting
    setMessages([]);
    setStreamingState(null);

    // Load initial message history
    loadMessagesForSession(targetSessionId, currentEpoch);

    const handleSseEvent = (event: SessionSseEvent) => {
      // Guard against stale session or epoch
      if (sessionEpochRef.current !== currentEpoch || activeSessionIdRef.current !== targetSessionId) {
        return;
      }
      if ('sessionId' in event && event.sessionId !== targetSessionId) {
        return;
      }

      switch (event.type) {
        case 'text_delta': {
          setStreamingState((prev) => {
            if (!prev || prev.botId !== event.botId) {
              return {
                botId: event.botId,
                delta: event.delta,
                tools: [],
              };
            }
            return {
              ...prev,
              delta: prev.delta + event.delta,
            };
          });
          break;
        }

        case 'tool_status': {
          setStreamingState((prev) => {
            const toolItem = {
              toolName: event.toolName,
              status: event.status,
              summary: event.summary,
              updatedAt: Date.now(),
            };

            if (!prev || prev.botId !== event.botId) {
              return {
                botId: event.botId,
                delta: '',
                tools: [toolItem],
              };
            }

            const currentTools = prev.tools || [];
            const existingIdx = currentTools.findIndex((t) => t.toolName === event.toolName);
            let nextTools = [...currentTools];
            if (existingIdx >= 0) {
              nextTools[existingIdx] = toolItem;
            } else {
              nextTools.push(toolItem);
            }

            return {
              ...prev,
              tools: nextTools,
            };
          });
          break;
        }

        case 'message_created': {
          if (event.message.sessionId === targetSessionId) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === event.message.id)) {
                return prev;
              }
              return [...prev, event.message];
            });

            // If message was created by the streaming assistant, clear streaming state
            setStreamingState((prev) => {
              if (prev && prev.botId === event.message.senderBotId) {
                return null;
              }
              return prev;
            });
          }
          break;
        }

        case 'messages_truncated': {
          // 编辑用户消息后：锚点之后历史已截断，重新拉取该会话消息
          loadMessagesForSession(targetSessionId, currentEpoch);
          break;
        }

        case 'session_status': {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === event.sessionId
                ? { ...s, status: event.status, activeBotId: event.activeBotId }
                : s
            )
          );

          if (event.status === 'idle' || event.status === 'failed') {
            setStreamingState(null);
            setCancelling(false);
          } else if (event.status === 'running' && event.activeBotId) {
            setStreamingState((prev) => {
              if (prev && prev.botId !== event.activeBotId) {
                return null;
              }
              return prev;
            });
          }
          break;
        }
      }
    };

    const unsubscribe = subscribeSessionEvents(targetSessionId, {
      onEvent: handleSseEvent,
      onOpen: () => {
        if (sessionEpochRef.current === currentEpoch && activeSessionIdRef.current === targetSessionId) {
          loadMessagesForSession(targetSessionId, currentEpoch);
        }
      },
      onError: (err) => {
        console.warn('[SSE] EventSource connection error:', err);
      },
    });

    return () => {
      unsubscribe();
    };
  }, [authenticated, activeSessionId, loadMessagesForSession]);

  // Handlers
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
    addToast('success', '验证成功，欢迎使用 botd 控制台');
  };

  const handleLogout = async () => {
    sessionEpochRef.current++;
    authenticatedRef.current = false;
    activeSessionIdRef.current = null;

    try {
      await api.logout();
    } catch {
      // ignore
    }
    setAuthenticated(false);
    setCurrentUser(null);
    setSessions([]);
    setActiveSessionId(null);
    setMessages([]);
    setNodes([]);
    setStreamingState(null);
    addToast('info', '已成功退出登录');
  };

  const handleSendMessage = async (content: string) => {
    // /new 命令：一键开启新话题（归档当前会话并创建新会话）
    if (content.trim() === '/new') {
      const sid = activeSessionIdRef.current;
      if (sid) await handleNewTopic(sid);
      return;
    }

    const targetSessionId = activeSessionIdRef.current;
    if (!targetSessionId) return;

    const currentEpoch = sessionEpochRef.current;

    try {
      const userMsg = await api.sendMessage(targetSessionId, content);

      // Guard: only append if user is still on this same session & epoch
      if (!isMountedRef.current || activeSessionIdRef.current !== targetSessionId || sessionEpochRef.current !== currentEpoch) {
        return;
      }

      setMessages((prev) => {
        if (prev.some((m) => m.id === userMsg.id)) {
          return prev;
        }
        return [...prev, userMsg];
      });
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
      }
      addToast('error', err?.message || '发送消息失败');
      throw err;
    }
  };

  // 编辑已发送的用户消息：服务端更新该消息、截断其后回复并自动重新派发 bot 生成新回复
  const handleEditMessage = async (sessionId: string, messageId: string, content: string) => {
    try {
      await api.editUserMessage(sessionId, messageId, content);
      // 本地立即截断锚点之后的消息：防止 loadMessagesForSession 的快照合并逻辑
      // 把服务端已删除的旧回复当作“较新的实时消息”重新保留（幽灵消息）
      setMessages((prev) => {
        if (activeSessionIdRef.current !== sessionId) return prev;
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx < 0) return prev;
        return prev.slice(0, idx + 1);
      });
      // 成功后重拉消息（SSE messages_truncated 也会触发重拉，双重拉取天然去重，无害）
      await loadMessagesForSession(sessionId, sessionEpochRef.current);
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      if (err?.status === 409) {
        addToast('error', '会话运行中，请先停止再编辑');
      } else {
        addToast('error', err?.message || '编辑消息失败');
      }
      throw err;
    }
  };

  const handleCancelSession = async () => {
    if (!activeSessionId) return;
    setCancelling(true);
    try {
      await api.cancelSession(activeSessionId);
      addToast('info', '已发送中止请求，正在停止当前轮次...');
    } catch (err: any) {
      addToast('error', err?.message || '中止执行失败');
      setCancelling(false);
    }
  };

  // 点击通讯录中的智能体：进入其当前单聊，不存在则静默创建
  const handleOpenBotChat = async (bot: BotConfig) => {
    const existing = pickCurrentDirectSession(sessions, bot.id);
    if (existing) {
      setActiveSessionId(existing.id);
      setCurrentView('chat');
      return;
    }

    if (creatingBotChatRef.current) return; // 创建进行中，忽略重复点击
    creatingBotChatRef.current = true;
    try {
      const created = await api.createSession({
        title: bot.name || bot.id,
        mode: 'direct',
        leadBotId: bot.id,
        memberBotIds: [bot.id],
      });
      setSessions((prev) => [created, ...prev]);
      setActiveSessionId(created.id);
      setCurrentView('chat');
      // 静默创建：不弹成功 toast
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || '创建单聊会话失败');
    } finally {
      creatingBotChatRef.current = false;
    }
  };

  // 开启新话题：基于当前会话创建同成员新会话，并归档旧会话（running 中也允许）
  const handleNewTopic = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

    try {
      const input: CreateSessionInput =
        session.mode === 'direct'
          ? {
              title: botMap.get(session.leadBotId)?.name || session.title,
              mode: 'direct',
              leadBotId: session.leadBotId,
              memberBotIds: session.memberBotIds,
            }
          : {
              title: session.title,
              mode: session.mode,
              leadBotId: session.leadBotId,
              memberBotIds: session.memberBotIds,
            };

      const created = await api.createSession(input);
      setSessions((prev) => [created, ...prev]);
      setActiveSessionId(created.id);
      setCurrentView('chat');

      // 归档旧会话：后端允许 running 中归档（纯 UI 分类标记），失败则如实提示
      try {
        const updated = await api.setSessionArchived(sessionId, true);
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
        );
      } catch (archiveErr: any) {
        addToast('error', archiveErr?.message || '旧话题归档失败，仍可在历史话题中查看');
      }

      addToast('success', '已开启新话题');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || '开启新话题失败');
    }
  };

  // 从指定消息（含）分叉出新会话并自动切换：原会话不动，运行中也允许（只读源 + 新建）
  const handleForkMessage = async (sessionId: string, messageId: string) => {
    if (forkingRef.current) return; // 分叉进行中，忽略重复点击
    forkingRef.current = true;
    try {
      const forked = await api.forkSession(sessionId, messageId);
      setSessions((prev) => [forked, ...prev]);
      setActiveSessionId(forked.id);
      setCurrentView('chat');
      addToast('success', '已分叉到新会话');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      addToast('error', err?.message || '分叉会话失败');
    } finally {
      forkingRef.current = false;
    }
  };

  const handleCreateSession = async (input: CreateSessionInput) => {
    try {
      const newSession = await api.createSession(input);
      setSessions((prev) => [newSession, ...prev]);
      setActiveSessionId(newSession.id);
      setCurrentView('chat');
      addToast('success', `会话 "${newSession.title}" 创建成功`);
    } catch (err: any) {
      addToast('error', err?.message || '创建会话失败');
      throw err;
    }
  };

  const handleUpdateSession = async (
    sessionId: string,
    input: Partial<CreateSessionInput>
  ) => {
    try {
      const updated = await api.updateSession(sessionId, input);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
      );
      addToast('success', '群聊配置已成功更新');
    } catch (err: any) {
      addToast('error', err?.message || '更新群配置失败');
      throw err;
    }
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const updated = await api.updateSession(sessionId, { title: trimmed });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
      );
      addToast('success', '会话名称已更新');
    } catch (err: any) {
      addToast('error', err?.message || '重命名会话失败');
      throw err;
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await api.deleteSession(sessionId);
      const idx = sessions.findIndex((s) => s.id === sessionId);
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      if (sessionId === activeSessionIdRef.current) {
        // 删除的是当前会话：优先选同位置的后一个，删的是末尾则选前一个，无则 null
        const fallback = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
        setActiveSessionId(fallback?.id ?? null);
      }
      addToast('success', '会话已删除');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      if (err?.status === 409) {
        addToast('error', '会话正在运行，请先停止后再删除');
      } else {
        addToast('error', err?.message || '删除会话失败');
      }
    }
  };

  const handleClearMessages = async (sessionId: string) => {
    try {
      await api.clearSessionMessages(sessionId);
      if (sessionId === activeSessionIdRef.current) {
        setMessages([]);
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, messageCount: 0, lastMessagePreview: undefined, lastMessageAt: undefined }
            : s
        )
      );
      addToast('success', '会话消息已清空');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        setAuthenticated(false);
        authenticatedRef.current = false;
        return;
      }
      if (err?.status === 409) {
        addToast('error', '会话正在运行，请先停止后再清空消息');
      } else {
        addToast('error', err?.message || '清空消息失败');
      }
    }
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
        setAuthenticated(false);
        authenticatedRef.current = false;
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
    <div className="flex h-screen h-[100dvh] w-screen overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      {/* Responsive Sidebar */}
      <Sidebar
        sessions={sessions}
        bots={allBots}
        nodeMap={nodeMap}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => {
          setActiveSessionId(id);
          setCurrentView('chat');
        }}
        onOpenBotChat={handleOpenBotChat}
        onCreateGroup={() => setCreateModalOpen(true)}
        onOpenNodesView={() => setCurrentView('nodes')}
        onOpenSettings={() => setSettingsModalOpen(true)}
        onLogout={handleLogout}
        onDeleteSession={handleDeleteSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        currentUser={currentUser || undefined}
        onOpenUsers={() => setUsersModalOpen(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative bg-white dark:bg-zinc-950">
        {currentView === 'nodes' ? (
          <NodesBotsView
            nodes={nodes}
            loading={loadingNodes}
            onRefresh={handleRefreshNodes}
            onBackToChat={() => setCurrentView('chat')}
            onToggleSidebar={() => setSidebarOpen(true)}
            onAddToast={addToast}
          />
        ) : activeSession ? (
          <ChatView
            session={activeSession}
            messages={messages}
            loadingMessages={loadingMessages}
            loadError={loadError}
            onRetryLoad={() => activeSessionId && loadMessagesForSession(activeSessionId, sessionEpochRef.current)}
            botMap={botMap}
            nodeMap={nodeMap}
            streamingState={streamingState}
            onSendMessage={handleSendMessage}
            onEditMessage={handleEditMessage}
            onCancelSession={handleCancelSession}
            onOpenGroupSettings={() => setGroupSettingsOpen(true)}
            onToggleSidebar={() => setSidebarOpen(true)}
            onRenameSession={handleRenameSession}
            onClearMessages={handleClearMessages}
            onDeleteSession={handleDeleteSession}
            onNewTopic={handleNewTopic}
            onForkMessage={handleForkMessage}
            cancelling={cancelling}
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
              <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100 mb-1.5">欢迎使用 botd</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-6 max-w-sm leading-relaxed">
                从左侧智能体列表选择一个智能体即可开始单聊，或点击下方按钮发起多智能体协同群聊。
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setCreateModalOpen(true)}
                  className="px-4 py-2 bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200/90 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs font-medium shadow-xs transition-colors cursor-pointer"
                >
                  新建群聊
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      <CreateSessionModal
        isOpen={createModalOpen}
        bots={allBots}
        nodeMap={nodeMap}
        onClose={() => setCreateModalOpen(false)}
        onCreateSession={handleCreateSession}
      />

      {activeSession && (
        <GroupSettingsModal
          isOpen={groupSettingsOpen}
          session={activeSession}
          bots={allBots}
          nodeMap={nodeMap}
          onClose={() => setGroupSettingsOpen(false)}
          onUpdateSession={handleUpdateSession}
        />
      )}

      <SettingsModal
        isOpen={settingsModalOpen}
        nodes={nodes}
        onClose={() => setSettingsModalOpen(false)}
      />

      {currentUser?.role === 'admin' && (
        <UsersModal
          isOpen={usersModalOpen}
          currentUser={currentUser}
          onClose={() => setUsersModalOpen(false)}
        />
      )}

      {/* Global Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
