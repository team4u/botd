import React from 'react';
import { Terminal, RefreshCw, ArrowLeft, Menu } from 'lucide-react';

interface ViewHeaderProps {
  onlineCount: number;
  totalCount: number;
  loading: boolean;
  onRefresh: () => void;
  onBackToChat: () => void;
  onToggleSidebar?: () => void;
  onOpenPairing: () => void;
}

/** 页面顶栏：返回会话、标题与在线计数、刷新与配对入口。 */
export const ViewHeader: React.FC<ViewHeaderProps> = ({
  onlineCount,
  totalCount,
  loading,
  onRefresh,
  onBackToChat,
  onToggleSidebar,
  onOpenPairing,
}) => (
  <header className="h-14 sm:h-16 px-3 sm:px-6 lg:px-8 bg-white dark:bg-zinc-950 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between shrink-0 z-10">
    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
      {onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          className="p-1.5 -ml-1 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg lg:hidden transition-colors"
          aria-label="打开侧边导航"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      <button
        onClick={onBackToChat}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors border border-zinc-200 dark:border-zinc-800 shrink-0"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">返回会话</span>
      </button>

      <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800 hidden sm:block shrink-0" />

      {/* Page Title: visible on both mobile and desktop */}
      <div className="min-w-0 flex items-center gap-2">
        <h1 className="font-semibold text-sm sm:text-base text-zinc-900 dark:text-zinc-100 truncate">
          计算节点
        </h1>
        <span className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full font-mono border border-zinc-200 dark:border-zinc-700 shrink-0">
          {onlineCount}/{totalCount} 在线
        </span>
      </div>
    </div>

    {/* Header Right Actions */}
    <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
      <button
        onClick={onRefresh}
        disabled={loading}
        className="p-2 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 transition-colors"
        title="刷新状态"
        aria-label="刷新状态"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin-fast' : ''}`} />
      </button>

      <button
        onClick={onOpenPairing}
        className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 transition-colors"
      >
        <Terminal className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-400" />
        <span className="hidden sm:inline">配对节点</span>
        <span className="sm:hidden">配对</span>
      </button>
    </div>
  </header>
);
