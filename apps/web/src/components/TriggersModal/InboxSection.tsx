import React, { useCallback, useEffect, useState } from 'react';
import {
  Inbox,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import type { AutomationEventRecord } from '@botd/protocol';
import { api } from '../../api';
import type { AddToastFn } from './shared';

export interface InboxSectionProps {
  sessionId: string;
  onAddToast: AddToastFn;
}

/** 事件收件箱：Webhook 最近收到的自动化事件（可折叠，展开时加载） */
export const InboxSection: React.FC<InboxSectionProps> = ({ sessionId, onAddToast }) => {
  const [showInbox, setShowInbox] = useState(false);
  const [inboxEvents, setInboxEvents] = useState<AutomationEventRecord[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);

  const fetchInboxEvents = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setInboxLoading(true);
      try {
        const list = await api.listAutomationEvents(sessionId);
        setInboxEvents(list);
      } catch (err: any) {
        if (!opts?.silent) onAddToast('error', err?.message || '获取事件收件箱失败');
      } finally {
        setInboxLoading(false);
      }
    },
    [sessionId, onAddToast]
  );

  useEffect(() => {
    // 收起时清空，重新展开再拉取（与弹窗重开行为一致）
    if (!showInbox) setInboxEvents([]);
  }, [showInbox]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
      <button
        type="button"
        onClick={() => {
          const next = !showInbox;
          setShowInbox(next);
          if (next) fetchInboxEvents();
        }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50 rounded-lg transition-colors"
        aria-expanded={showInbox}
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {showInbox ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
          )}
          <Inbox className="w-3.5 h-3.5 text-zinc-400" />
          事件收件箱 (Event Inbox)
          {inboxEvents.length > 0 && (
            <span className="text-[11px] font-normal text-zinc-400 dark:text-zinc-500">
              · {inboxEvents.length} 条
            </span>
          )}
        </span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Webhook 最近收到的事件</span>
      </button>

      {showInbox && (
        <div className="px-3 pb-3 space-y-2 border-t border-zinc-100 dark:border-zinc-800/60 pt-2.5">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => fetchInboxEvents()}
              disabled={inboxLoading}
              className="h-7 px-2 text-[11px] font-medium rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${inboxLoading ? 'animate-spin-fast' : ''}`} />
              <span>刷新</span>
            </button>
          </div>

          {inboxLoading && inboxEvents.length === 0 ? (
            <div className="py-6 flex items-center justify-center gap-2 text-xs text-zinc-400">
              <Loader2 className="w-4 h-4 animate-spin-fast" />
              加载事件中...
            </div>
          ) : inboxEvents.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
              暂无收到的事件，Webhook 被调用后将在这里展示
            </p>
          ) : (
            <ul className="space-y-1.5">
              {inboxEvents.map((ev) => (
                <li
                  key={ev.id}
                  className="p-2 rounded-lg border border-zinc-100 dark:border-zinc-800/80 bg-zinc-50/60 dark:bg-zinc-900/60"
                >
                  <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                    <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900/60">
                      {ev.source}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                      {ev.eventType}
                    </span>
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 ml-auto shrink-0">
                      {new Date(ev.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {ev.summary && (
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 break-all mb-0.5">
                      {ev.summary}
                    </p>
                  )}
                  {ev.childSessionId && (
                    <a
                      href={`#?s=${ev.childSessionId}`}
                      className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                      title="跳转到派生的子会话"
                    >
                      <ExternalLink className="w-3 h-3" />
                      查看子会话
                    </a>
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
