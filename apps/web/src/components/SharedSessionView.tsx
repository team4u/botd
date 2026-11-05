import React, { useState, useEffect, useMemo } from 'react';
import {
  Bot,
  MessageSquare,
  Eye,
  Loader2,
  AlertCircle,
  Hash,
  Coins,
  ArrowLeft,
} from 'lucide-react';
import type {
  SharedSessionSnapshot,
  BotConfig,
  NodeRecord,
} from '@botd/protocol';
import { api } from '../api';
import { MessageItem } from './MessageItem';
import { formatShortModel, formatChatDayLabel, isSameCalendarDay } from '../message-format';
import ThemeToggle from './ThemeToggle';

interface SharedSessionViewProps {
  token: string;
}

const sameDay = isSameCalendarDay;

export const SharedSessionView: React.FC<SharedSessionViewProps> = ({ token }) => {
  const [snapshot, setSnapshot] = useState<SharedSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    api
      .getPublicShare(token)
      .then((data) => {
        if (active) {
          setSnapshot(data);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(
            err instanceof Error ? err.message : '分享链接不存在或已过期失效'
          );
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  const botMap = useMemo(() => {
    const map = new Map<string, BotConfig>();
    if (!snapshot) return map;
    for (const b of snapshot.bots) {
      map.set(b.id, {
        id: b.id,
        name: b.name,
        description: b.description,
        modelProvider: b.modelProvider,
        modelId: b.modelId,
        nodeId: '',
        prompt: '',
        enabledSkills: [],
        createdAt: '',
        updatedAt: '',
      } as unknown as BotConfig);
    }
    return map;
  }, [snapshot]);

  const emptyNodeMap = useMemo(() => new Map<string, NodeRecord>(), []);

  const totalTokens = useMemo(() => {
    if (!snapshot) return 0;
    return snapshot.messages.reduce(
      (acc, m) => acc + (m.usage?.totalTokens || 0),
      0
    );
  }, [snapshot]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-zinc-950 flex flex-col items-center justify-center p-4">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400 mb-3" />
        <p className="text-xs text-zinc-500">加载分享内容…</p>
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="min-h-screen bg-white dark:bg-zinc-950 flex flex-col items-center justify-center p-4 text-center">
        <div className="w-12 h-12 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center text-zinc-400 mb-4">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-1.5">
          分享链接不存在或已失效
        </h1>
        <p className="text-xs text-zinc-500 max-w-sm mb-6">
          {error || '该分享可能已被发起者撤销，或已过期。'}
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.href = '/';
          }}
          className="h-8 px-3 rounded-lg text-xs font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:opacity-90 transition-opacity cursor-pointer inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>返回首页</span>
        </button>
      </div>
    );
  }

  const { session, bots, messages } = snapshot;

  return (
    <div className="h-dvh bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col overflow-hidden">
      {/* 顶部展示栏 */}
      <header className="shrink-0 z-20 border-b border-zinc-200/80 dark:border-zinc-800/80 bg-white/95 dark:bg-zinc-950/95 px-3 sm:px-6 py-2.5">
        <div className="max-w-4xl mx-auto flex flex-col gap-2">
          {/* 第一行：标题 + 只读回放标识 + ThemeToggle */}
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-400 shrink-0">
                <MessageSquare className="w-4 h-4" />
              </div>
              <h1 className="text-sm sm:text-base font-semibold truncate text-zinc-900 dark:text-zinc-100">
                {session.title || '会话回放'}
              </h1>

              {/* 只读分享回放标识 */}
              <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 text-amber-700 dark:text-amber-300">
                <Eye className="w-3 h-3" />
                <span>只读回放</span>
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  window.location.href = '/';
                }}
                title="打开 botd 首页"
                className="h-8 px-2.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <span>进入 botd</span>
              </button>
              <ThemeToggle />
            </div>
          </div>

          {/* 第二行：参会 BOT 列表 + 统计指标 */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs text-zinc-500 dark:text-zinc-400 pt-0.5">
            {/* BOT 列表 */}
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">参会 BOT:</span>
              {bots.map((bot) => (
                <span
                  key={bot.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/70 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 text-[11px]"
                  title={`${bot.name} (${bot.modelProvider}/${bot.modelId})`}
                >
                  <Bot className="w-3 h-3 text-blue-500 dark:text-blue-400 shrink-0" />
                  <span className="font-medium truncate max-w-[120px]">{bot.name}</span>
                  <span className="font-mono text-zinc-400 dark:text-zinc-500">
                    {formatShortModel(bot.modelId)}
                  </span>
                </span>
              ))}
            </div>

            {/* 消息与 Token 指标 */}
            <div className="flex items-center gap-3 shrink-0 text-[11px] font-mono">
              <span className="inline-flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
                <Hash className="w-3 h-3 text-zinc-400" />
                <span>{messages.length} 条消息</span>
              </span>
              {totalTokens > 0 && (
                <span className="inline-flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
                  <Coins className="w-3 h-3 text-zinc-400" />
                  <span>{totalTokens.toLocaleString()} tokens</span>
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* 主体对话回放画布：页面级滚动容器（body 被 overflow:hidden 锁定，滚动由这里承载） */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-4xl w-full mx-auto py-4">
          {messages.length === 0 ? (
            <div className="text-center py-16 text-zinc-400 text-xs">
              暂无消息记录
            </div>
          ) : (
            messages.map((msg, idx) => (
              <React.Fragment key={msg.id}>
                {/* 日期分隔线：相邻消息跨自然日时插入 */}
                {(idx === 0 || !sameDay(messages[idx - 1].createdAt, msg.createdAt)) && (
                  <div className="sticky top-1 z-[5] mx-auto my-2 w-fit px-2.5 py-0.5 rounded-full bg-zinc-100/90 dark:bg-zinc-800/90 text-[11px] text-zinc-500 backdrop-blur-sm">
                    {formatChatDayLabel(msg.createdAt)}
                  </div>
                )}
                <MessageItem
                  message={msg}
                  botMap={botMap}
                  nodeMap={emptyNodeMap}
                  canEdit={false}
                />
              </React.Fragment>
            ))
          )}
        </div>
      </main>

      {/* 底部极简归属标记 */}
      <footer className="shrink-0 border-t border-zinc-100 dark:border-zinc-900 py-4 text-center text-[11px] text-zinc-400 dark:text-zinc-600">
        由 botd 强力驱动 · 只读分享回放
      </footer>
    </div>
  );
};
