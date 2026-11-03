import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { SessionRecord, BotConfig, CreateSessionInput } from '@botd/protocol';
import { api, AuthRequiredError } from '../api';
import { pickCurrentDirectSession } from '../components/Sidebar';
import type { AddToastFn } from './useToasts';
import type { NavigateFn } from './useHashRoute';

export interface SessionActionsParams {
  sessions: SessionRecord[];
  setSessions: Dispatch<SetStateAction<SessionRecord[]>>;
  botMap: Map<string, BotConfig>;
  activeSessionIdRef: MutableRefObject<string | null>;
  onAuthLostRef: MutableRefObject<() => void>;
  addToast: AddToastFn;
  navigate: NavigateFn;
  /** 会话删除后同步移除未读计数 */
  onSessionsRemoved: (sessionIds: string[]) => void;
}

/**
 * 会话 CRUD 动作组：创建/重命名/删除（单个+批量）/归档/分叉/新话题/单聊静默创建。
 * 所有动作显式收 addToast / navigate / onAuthLost，不隐式依赖其它状态源。
 */
export const useSessionActions = (params: SessionActionsParams) => {
  const {
    sessions,
    setSessions,
    botMap,
    activeSessionIdRef,
    onAuthLostRef,
    addToast,
    navigate,
    onSessionsRemoved,
  } = params;

  // 单聊静默创建并发防抖：创建进行中忽略重复点击
  const creatingBotChatRef = useRef(false);
  // 会话分叉并发防抖：分叉请求进行中忽略重复点击
  const forkingRef = useRef(false);

  // 点击通讯录中的智能体：进入其当前单聊，不存在则静默创建
  const handleOpenBotChat = useCallback(async (bot: BotConfig) => {
    const existing = pickCurrentDirectSession(sessions, bot.id);
    if (existing) {
      navigate({ sessionId: existing.id, view: 'chat' });
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
      navigate({ sessionId: created.id, view: 'chat' });
      // 静默创建：不弹成功 toast
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        onAuthLostRef.current();
        return;
      }
      addToast('error', err?.message || '创建单聊会话失败');
    } finally {
      creatingBotChatRef.current = false;
    }
  }, [sessions, setSessions, navigate, addToast, onAuthLostRef]);

  // 开启新话题：基于当前会话创建同成员新会话，并归档旧会话（running 中也允许）
  const handleNewTopic = useCallback(async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

    try {
      const input: CreateSessionInput = {
        title: botMap.get(session.leadBotId)?.name || session.title,
        mode: 'direct',
        leadBotId: session.leadBotId,
        memberBotIds: [session.leadBotId],
      };

      const created = await api.createSession(input);
      setSessions((prev) => [created, ...prev]);
      navigate({ sessionId: created.id, view: 'chat', modal: null });

      // 归档旧会话：后端允许 running 中归档（纯 UI 分类标记），失败则如实提示
      try {
        const updated = await api.setSessionArchived(sessionId, true);
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
        );
      } catch (archiveErr: any) {
        addToast('error', archiveErr?.message || '旧话题归档失败，仍可在历史话题中查看');
      }
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        onAuthLostRef.current();
        return;
      }
      addToast('error', err?.message || '开启新话题失败');
    }
  }, [sessions, setSessions, botMap, navigate, addToast, onAuthLostRef]);

  // 从指定消息（含）分叉出新会话并自动切换：原会话不动，运行中也允许（只读源 + 新建）
  const handleForkMessage = useCallback(async (sessionId: string, messageId: string) => {
    if (forkingRef.current) return; // 分叉进行中，忽略重复点击
    forkingRef.current = true;
    try {
      const forked = await api.forkSession(sessionId, messageId);
      setSessions((prev) => [forked, ...prev]);
      navigate({ sessionId: forked.id, view: 'chat' });
      addToast('success', '已分叉到新会话');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        onAuthLostRef.current();
        return;
      }
      addToast('error', err?.message || '分叉会话失败');
    } finally {
      forkingRef.current = false;
    }
  }, [setSessions, navigate, addToast, onAuthLostRef]);

  const handleCreateSession = useCallback(async (input: CreateSessionInput) => {
    try {
      const newSession = await api.createSession(input);
      setSessions((prev) => [newSession, ...prev]);
      navigate({ sessionId: newSession.id, view: 'chat', modal: null });
      // 创建成功后直接导航进新会话，界面反馈已足够，不再弹 toast
    } catch (err: any) {
      addToast('error', err?.message || '创建会话失败');
      throw err;
    }
  }, [setSessions, navigate, addToast]);

  const handleRenameSession = useCallback(async (sessionId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const updated = await api.updateSession(sessionId, { title: trimmed });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s))
      );
    } catch (err: any) {
      addToast('error', err?.message || '重命名会话失败');
      throw err;
    }
  }, [setSessions, addToast]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await api.deleteSession(sessionId);
      const idx = sessions.findIndex((s) => s.id === sessionId);
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      // 同步移除被删会话的未读计数，避免 document.title 角标永久虚高
      onSessionsRemoved([sessionId]);
      if (sessionId === activeSessionIdRef.current) {
        // 删除的是当前会话：优先选同位置的后一个，删的是末尾则选前一个，无则 null
        const fallback = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
        navigate({ sessionId: fallback?.id ?? null });
      }
      addToast('success', '会话已删除');
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        onAuthLostRef.current();
        return;
      }
      if (err?.status === 409) {
        addToast('error', '会话正在运行，请先停止后再删除');
      } else {
        addToast('error', err?.message || '删除会话失败');
      }
    }
  }, [sessions, setSessions, activeSessionIdRef, navigate, addToast, onAuthLostRef, onSessionsRemoved]);

  // 批量删除会话（历史话题全选删除）：逐个调用删除 API，运行中(409)跳过、其余失败计数，最后统一更新列表与提示
  const handleDeleteSessions = useCallback(async (sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    const deletedIds: string[] = [];
    let running = 0;
    let failed = 0;
    for (const id of sessionIds) {
      try {
        await api.deleteSession(id);
        deletedIds.push(id);
      } catch (err: any) {
        if (err instanceof AuthRequiredError || err?.status === 401) {
          onAuthLostRef.current();
          return;
        }
        if (err?.status === 409) running += 1;
        else failed += 1;
      }
    }
    if (deletedIds.length > 0) {
      const deletedSet = new Set(deletedIds);
      const firstIdx = sessions.findIndex((s) => deletedSet.has(s.id));
      const remaining = sessions.filter((s) => !deletedSet.has(s.id));
      setSessions(remaining);
      // 同步移除被删会话的未读计数
      onSessionsRemoved(deletedIds);
      // 当前会话被删时切换到相邻会话（与单个删除同一策略）
      const activeId = activeSessionIdRef.current;
      if (activeId && deletedSet.has(activeId)) {
        const fallback = remaining[Math.min(Math.max(firstIdx, 0), remaining.length - 1)];
        navigate({ sessionId: fallback?.id ?? null });
      }
    }
    const parts = [`已删除 ${deletedIds.length} 个会话`];
    if (running > 0) parts.push(`${running} 个正在运行已跳过`);
    if (failed > 0) parts.push(`${failed} 个删除失败`);
    addToast(deletedIds.length > 0 ? 'success' : 'error', parts.join('，'));
  }, [sessions, setSessions, activeSessionIdRef, navigate, addToast, onAuthLostRef, onSessionsRemoved]);

  // 归档/恢复：归档当前会话时不跳转（保留查看），仅切换列表分类
  const handleSetArchived = useCallback(async (sessionId: string, archived: boolean) => {
    try {
      const updated = await api.setSessionArchived(sessionId, archived);
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...updated } : s)));
    } catch (err: any) {
      if (err instanceof AuthRequiredError || err?.status === 401) {
        onAuthLostRef.current();
        return;
      }
      addToast('error', err?.message || (archived ? '归档会话失败' : '恢复会话失败'));
    }
  }, [setSessions, addToast, onAuthLostRef]);

  return {
    handleOpenBotChat,
    handleNewTopic,
    handleForkMessage,
    handleCreateSession,
    handleRenameSession,
    handleDeleteSession,
    handleDeleteSessions,
    handleSetArchived,
  };
};
