import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X,
  Loader2,
  History as HistoryIcon,
  ArchiveRestore,
  Trash2,
  Bot as BotIcon,
  CheckSquare,
  Square,
  ListChecks,
} from 'lucide-react';
import type { BotConfig, SessionRecord } from '@botd/protocol';
import { api } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { pickCurrentDirectSession } from './Sidebar';

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 7 天退化为本地日期 */
function formatRelativeTime(iso?: string): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(time);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

interface BotHistoryDrawerProps {
  isOpen: boolean;
  bot: BotConfig | null;
  onClose: () => void;
  /** 点击历史话题：跳回聊天视图并定位该会话 */
  onOpenSession: (sessionId: string) => void;
  onAddToast: (type: 'success' | 'error' | 'info', message: string) => void;
  /** 批量删除：由 App 统一执行并同步全局会话列表，缺省时退化为组件内逐个删除 */
  onDeleteSessions?: (ids: string[]) => Promise<void> | void;
}

/**
 * 单个智能体（主 BOT / 子代理）的专属历史话题抽屉：
 * 列出该 bot 全部单聊会话中除「当前话题」外的历史话题（含已归档），
 * 支持点击继续、恢复归档与删除。会话数据存于 Hub，节点离线也可查看。
 */
export const BotHistoryDrawer: React.FC<BotHistoryDrawerProps> = ({
  isOpen,
  bot,
  onClose,
  onOpenSession,
  onAddToast,
  onDeleteSessions,
}) => {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // 多选批量删除：勾选后顶部栏一键删除
  const [multiSelectOn, setMultiSelectOn] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);

  const reload = useCallback(async (botId: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const all = await api.listSessions();
      const mine = all.filter((s) => s.leadBotId === botId);
      setSessions(mine);
    } catch (err: any) {
      setLoadError(err?.message || '加载历史话题失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const botId = bot?.id;
  useEffect(() => {
    if (isOpen && botId) {
      setDeleteTarget(null);
      setMultiSelectOn(false);
      setSelectedIds(new Set());
      void reload(botId);
    }
  }, [isOpen, botId, reload]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // 与侧边栏「历史话题」同一口径：当前话题之外的全部单聊（含归档），按活跃时间倒序
  const current = botId ? pickCurrentDirectSession(sessions, botId) : undefined;
  const historySessions = useMemo(
    () =>
      sessions
        .filter((s) => s.id !== current?.id)
        .sort(
          (a, b) =>
            (new Date(b.lastMessageAt ?? b.updatedAt).getTime() || 0) -
            (new Date(a.lastMessageAt ?? b.updatedAt).getTime() || 0)
        ),
    [sessions, current?.id]
  );

  // 列表变化后丢弃已不可见项的选择，避免误删隐藏项
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(historySessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [historySessions]);

  const allSelected = historySessions.length > 0 && historySessions.every((s) => selectedIds.has(s.id));

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(historySessions.map((s) => s.id)));
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0 || !botId) return;
    setBatchDeleting(true);
    try {
      if (onDeleteSessions) {
        // App 统一执行删除：同步全局会话列表/未读数/当前会话切换，并弹出结果 toast
        await onDeleteSessions([...selectedIds]);
      } else {
        // 兕底：组件内逐个删除（仅同步抽屉本地列表）
        const deleted: string[] = [];
        let running = 0;
        let failed = 0;
        for (const id of selectedIds) {
          try {
            await api.deleteSession(id);
            deleted.push(id);
          } catch (err: any) {
            // 409 = 运行中跳过，其余计入失败（会话数据在 Hub，节点离线不影响删除）
            if (err?.status === 409) running += 1;
            else failed += 1;
          }
        }
        if (deleted.length > 0) {
          const deletedSet = new Set(deleted);
          setSessions((prev) => prev.filter((s) => !deletedSet.has(s.id)));
        }
        const parts = [`已删除 ${deleted.length} 个话题`];
        if (running > 0) parts.push(`${running} 个运行中已跳过`);
        if (failed > 0) parts.push(`${failed} 个删除失败`);
        onAddToast(deleted.length > 0 ? 'success' : 'error', parts.join('，'));
      }
    } finally {
      setBatchDeleting(false);
      setBatchConfirmOpen(false);
      setSelectedIds(new Set());
      // 重新拉取本地列表，反映运行中未删成等情况
      void reload(botId);
    }
  };

  const handleRestore = async (session: SessionRecord) => {
    setRestoringId(session.id);
    try {
      const updated = await api.setSessionArchived(session.id, false);
      setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, ...updated } : s)));
      onAddToast('success', '已恢复该话题');
    } catch (err: any) {
      onAddToast('error', err?.message || '恢复话题失败');
    } finally {
      setRestoringId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteSession(deleteTarget.id);
      setSessions((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      onAddToast('success', '历史话题已删除');
      setDeleteTarget(null);
    } catch (err: any) {
      onAddToast('error', err?.message || '删除话题失败');
    } finally {
      setDeleting(false);
    }
  };

  if (!isOpen || !bot) return null;

  return (
    <>
      {/* 遮罩：点击关闭 */}
      <div
        className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 右侧滑入面板 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${bot.name} 的历史话题`}
        className="fixed inset-y-0 right-0 z-40 w-[min(24rem,90vw)] bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        {/* Header：所属 bot 身份 */}
        <div className="flex items-center justify-between gap-2 px-4 h-13 sm:h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-center shrink-0">
              <BotIcon className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                历史话题
              </h2>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                {bot.name} · @{bot.id}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* 多选批量删除入口：仅在有话题时展示 */}
            {historySessions.length > 0 && !loading && !loadError && (
              <button
                type="button"
                onClick={() => {
                  setMultiSelectOn((v) => !v);
                  setSelectedIds(new Set());
                }}
                aria-pressed={multiSelectOn}
                title={multiSelectOn ? '退出多选' : '多选删除话题'}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  multiSelectOn
                    ? 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40'
                    : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                <ListChecks className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              title="关闭 (Esc)"
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 话题列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
          {/* 多选模式：全选/取消全选 + 批量删除栏 */}
          {multiSelectOn && historySessions.length > 0 && !loading && !loadError && (
            <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl bg-zinc-100/70 dark:bg-zinc-800/60 sticky top-0 z-10">
              <button
                type="button"
                onClick={toggleSelectAll}
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
              >
                {allSelected ? (
                  <CheckSquare className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                ) : (
                  <Square className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                )}
                <span>{allSelected ? '取消全选' : '全选'}</span>
              </button>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">已选 {selectedIds.size} 项</span>
                <button
                  type="button"
                  onClick={() => setBatchConfirmOpen(true)}
                  disabled={selectedIds.size === 0 || batchDeleting}
                  className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer"
                >
                  {batchDeleting ? <Loader2 className="w-3 h-3 animate-spin-fast" /> : <Trash2 className="w-3 h-3" />}
                  <span>删除</span>
                </button>
              </div>
            </div>
          )}
          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin-fast text-blue-600 dark:text-blue-400" />
              <p className="text-xs">正在加载历史话题...</p>
            </div>
          ) : loadError ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500">
              <p className="text-xs text-rose-600 dark:text-rose-400">{loadError}</p>
              <button
                type="button"
                onClick={() => void reload(bot.id)}
                className="px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                重试
              </button>
            </div>
          ) : historySessions.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500">
              <HistoryIcon className="w-8 h-8 text-zinc-300 dark:text-zinc-600" />
              <p className="text-xs">暂无历史话题</p>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 text-center leading-relaxed max-w-[16rem]">
                在聊天中「开启新话题」后，旧话题会归档到这里
              </p>
            </div>
          ) : (
            historySessions.map((session) => {
              const relativeTime = formatRelativeTime(session.lastMessageAt ?? session.updatedAt);
              const checked = selectedIds.has(session.id);

              // 多选模式：整行切换勾选，不触发进入会话
              if (multiSelectOn) {
                return (
                  <div
                    key={session.id}
                    role="button"
                    tabIndex={0}
                    title={session.title}
                    onClick={() => toggleSelectOne(session.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleSelectOne(session.id);
                      }
                    }}
                    className={`p-2.5 rounded-xl border transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 ${
                      checked
                        ? 'bg-blue-50/70 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/70'
                        : 'border-zinc-200/80 dark:border-zinc-800/80 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {checked ? (
                        <CheckSquare className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                      ) : (
                        <Square className="w-3.5 h-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                      )}
                      <span className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                        {session.title}
                      </span>
                      {relativeTime && (
                        <span className="ml-auto shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
                          {relativeTime}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 pl-5.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                      {session.lastMessagePreview ||
                        (session.messageCount != null ? `${session.messageCount} 条消息` : '暂无消息')}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  title={session.title}
                  onClick={() => onOpenSession(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenSession(session.id);
                    }
                  }}
                  className="group p-2.5 rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      {session.title}
                    </span>
                    {relativeTime && (
                      <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
                        {relativeTime}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                      {session.lastMessagePreview ||
                        (session.messageCount != null ? `${session.messageCount} 条消息` : '暂无消息')}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {session.archived && (
                        <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                          已归档
                        </span>
                      )}
                      {session.archived && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRestore(session);
                          }}
                          disabled={restoringId === session.id}
                          className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                          title="恢复话题（取消归档）"
                          aria-label={`恢复话题 ${session.title}`}
                        >
                          {restoringId === session.id ? (
                            <Loader2 className="w-3 h-3 animate-spin-fast" />
                          ) : (
                            <ArchiveRestore className="w-3 h-3" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(session);
                        }}
                        className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:text-zinc-500 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                        title="删除该话题"
                        aria-label={`删除话题 ${session.title}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 删除话题二次确认 */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="删除历史话题"
        message={
          <>
            确定要删除话题「{deleteTarget?.title}」吗？
            <br />
            该话题的全部历史消息将被永久移除，此操作不可恢复。
          </>
        }
        confirmText="删除"
        danger
        busy={deleting}
        onConfirm={handleDelete}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
      />

      {/* 批量删除话题二次确认 */}
      <ConfirmDialog
        isOpen={batchConfirmOpen}
        title="批量删除历史话题"
        message={
          <>
            确定要删除已选的 {selectedIds.size} 个话题吗？
            <br />
            这些话题的全部历史消息将被永久移除，此操作不可恢复。运行中的话题会被自动跳过。
          </>
        }
        confirmText="全部删除"
        danger
        busy={batchDeleting}
        onConfirm={handleBatchDelete}
        onClose={() => {
          if (!batchDeleting) setBatchConfirmOpen(false);
        }}
      />
    </>
  );
};
