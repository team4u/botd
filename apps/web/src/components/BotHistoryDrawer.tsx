import React, { useCallback, useEffect, useState } from 'react';
import {
  X,
  Loader2,
  History as HistoryIcon,
  ArchiveRestore,
  Trash2,
  Bot as BotIcon,
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
}

/**
 * 单个智能体（主 BOT / 角色分身）的专属历史话题抽屉：
 * 列出该 bot 全部单聊会话中除「当前话题」外的历史话题（含已归档），
 * 支持点击继续、恢复归档与删除。会话数据存于 Hub，节点离线也可查看。
 */
export const BotHistoryDrawer: React.FC<BotHistoryDrawerProps> = ({
  isOpen,
  bot,
  onClose,
  onOpenSession,
  onAddToast,
}) => {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const reload = useCallback(async (botId: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const all = await api.listSessions();
      const mine = all.filter(
        (s) => s.mode === 'direct' && s.memberBotIds?.length === 1 && s.memberBotIds[0] === botId
      );
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
  const historySessions = sessions
    .filter((s) => s.id !== current?.id)
    .sort(
      (a, b) =>
        (new Date(b.lastMessageAt ?? b.updatedAt).getTime() || 0) -
        (new Date(a.lastMessageAt ?? a.updatedAt).getTime() || 0)
    );

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

        {/* 话题列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
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
    </>
  );
};
