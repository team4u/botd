import React, { useCallback, useEffect, useState } from 'react';
import {
  Send,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleX,
  CircleAlert,
} from 'lucide-react';
import type { NotificationOutboxRecord } from '@botd/protocol';
import { api } from '../../api';
import type { AddToastFn } from './shared';

export interface OutboxSectionProps {
  sessionId: string;
  onAddToast: AddToastFn;
}

/** 最近通知投递记录 (Outbox)：通道推送与自动重试的投递队列（可折叠，展开时加载） */
export const OutboxSection: React.FC<OutboxSectionProps> = ({ sessionId, onAddToast }) => {
  const [showOutbox, setShowOutbox] = useState(false);
  const [outboxRecords, setOutboxRecords] = useState<NotificationOutboxRecord[]>([]);
  const [outboxLoading, setOutboxLoading] = useState(false);

  const fetchOutbox = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setOutboxLoading(true);
      try {
        const list = await api.listNotificationOutbox(sessionId);
        setOutboxRecords(list);
      } catch (err: any) {
        if (!opts?.silent) onAddToast('error', err?.message || '获取通知投递记录失败');
      } finally {
        setOutboxLoading(false);
      }
    },
    [sessionId, onAddToast]
  );

  useEffect(() => {
    // 收起时清空，重新展开再拉取（与弹窗重开行为一致）
    if (!showOutbox) setOutboxRecords([]);
  }, [showOutbox]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
      <button
        type="button"
        onClick={() => {
          const next = !showOutbox;
          setShowOutbox(next);
          if (next) fetchOutbox();
        }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50 rounded-lg transition-colors"
        aria-expanded={showOutbox}
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {showOutbox ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
          )}
          <Send className="w-3.5 h-3.5 text-zinc-400" />
          最近通知投递记录 (Outbox)
          {outboxRecords.length > 0 && (
            <span className="text-[11px] font-normal text-zinc-400 dark:text-zinc-500">
              · {outboxRecords.length} 条
            </span>
          )}
        </span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">失败自动重试，超限标记投递失败</span>
      </button>

      {showOutbox && (
        <div className="px-3 pb-3 space-y-2 border-t border-zinc-100 dark:border-zinc-800/60 pt-2.5">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => fetchOutbox()}
              disabled={outboxLoading}
              className="h-7 px-2 text-[11px] font-medium rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${outboxLoading ? 'animate-spin-fast' : ''}`} />
              <span>刷新</span>
            </button>
          </div>

          {outboxLoading && outboxRecords.length === 0 ? (
            <div className="py-6 flex items-center justify-center gap-2 text-xs text-zinc-400">
              <Loader2 className="w-4 h-4 animate-spin-fast" />
              加载投递记录中...
            </div>
          ) : outboxRecords.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
              暂无投递记录，通道推送后将在这里展示
            </p>
          ) : (
            <ul className="space-y-1.5">
              {outboxRecords.map((rec) => (
                <li
                  key={rec.id}
                  className="p-2 rounded-lg border border-zinc-100 dark:border-zinc-800/80 bg-zinc-50/60 dark:bg-zinc-900/60"
                >
                  <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                    {rec.status === 'sent' ? (
                      <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900/60 inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        已送达
                      </span>
                    ) : rec.status === 'pending' ? (
                      <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900/60 inline-flex items-center gap-1">
                        <Loader2 className="w-3 h-3" />
                        重试中
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900/60 inline-flex items-center gap-1">
                        <CircleX className="w-3 h-3" />
                        投递失败
                      </span>
                    )}

                    <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                      {rec.eventKind === 'assistant_reply'
                        ? '智能体回复'
                        : rec.eventKind === 'ask_request'
                        ? 'botd ask 交互'
                        : '异步唤醒'}
                    </span>

                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                      重试 {rec.attemptCount} 次
                    </span>

                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 ml-auto shrink-0">
                      {new Date(rec.updatedAt).toLocaleString()}
                    </span>
                  </div>
                  {rec.lastError && (
                    <p className="text-[11px] text-rose-600 dark:text-rose-400 break-all flex items-start gap-1">
                      <CircleAlert className="w-3 h-3 shrink-0 mt-0.5" />
                      {rec.lastError}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
