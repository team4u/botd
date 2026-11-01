import React from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import type { ToastItem } from '../types';

interface ToastProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 sm:bottom-6 right-4 sm:right-6 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] sm:w-full pointer-events-none pb-safe"
      role="region"
      aria-label="系统通知"
    >
      {toasts.map((toast) => {
        let icon = <Info className="w-4 h-4 text-zinc-400 shrink-0" />;

        if (toast.type === 'success') {
          icon = <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
        } else if (toast.type === 'error') {
          icon = <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />;
        }

        return (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-center gap-3 px-3.5 py-2.5 bg-zinc-900 text-zinc-50 border border-zinc-800 rounded-xl shadow-lg text-xs font-medium transition-all duration-200 dark:bg-zinc-800 dark:text-zinc-100 dark:border-zinc-700"
          >
            {icon}
            <div className="flex-1 break-words leading-relaxed">{toast.message}</div>
            <button
              onClick={() => onDismiss(toast.id)}
              className="text-zinc-400 hover:text-zinc-100 dark:text-zinc-400 dark:hover:text-white p-0.5 rounded transition-colors shrink-0"
              aria-label="关闭通知"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
