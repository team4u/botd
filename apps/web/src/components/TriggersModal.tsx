import React, { useState } from 'react';
import { X, Zap, Radio, Share2 } from 'lucide-react';
import type { SessionRecord, BotConfig } from '@botd/protocol';
import { TriggersTab } from './TriggersModal/TriggersTab';
import { ChannelsTab } from './TriggersModal/ChannelsTab';

export interface TriggersModalProps {
  isOpen: boolean;
  session: SessionRecord;
  memberBots: BotConfig[];
  onClose: () => void;
  onAddToast: (type: 'success' | 'error' | 'info', message: string) => void;
}

type TabId = 'inbound' | 'outbound';

/**
 * 自动化与消息桥接弹窗：触发器（入站）与通知通道（出站）两个 Tab。
 * 关闭时整树卸载（重开即重置全部状态、重新拉取数据）；
 * Tab 子组件常驻挂载并以 visible 控制渲染，切换 Tab 保留各自的本地状态。
 */
export const TriggersModal: React.FC<TriggersModalProps> = ({
  isOpen,
  session,
  memberBots,
  onClose,
  onAddToast,
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('inbound');

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="triggers-modal-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/80 dark:border-zinc-800/80 w-full sm:max-w-2xl overflow-hidden flex flex-col max-h-[90dvh]">
        {/* Mobile handle */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto my-2 sm:hidden shrink-0" />

        {/* Header */}
        <div className="px-5 py-3 sm:px-6 sm:py-3.5 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-500 shrink-0" />
            <h2 id="triggers-modal-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
              自动化与消息桥接
            </h2>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
            aria-label="关闭对话框"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/40 dark:bg-zinc-900/40 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('inbound')}
            className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
              activeTab === 'inbound'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 bg-white dark:bg-zinc-950 font-semibold'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>触发器</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('outbound')}
            className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
              activeTab === 'outbound'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 bg-white dark:bg-zinc-950 font-semibold'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>通知通道</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          <TriggersTab
            visible={activeTab === 'inbound'}
            session={session}
            memberBots={memberBots}
            onAddToast={onAddToast}
          />
          <ChannelsTab visible={activeTab === 'outbound'} session={session} onAddToast={onAddToast} />
        </div>

        {/* Footer */}
        <div className="px-5 py-3 sm:px-6 sm:py-3.5 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg cursor-pointer"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
