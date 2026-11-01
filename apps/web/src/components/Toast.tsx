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
      className="fixed top-4 sm:top-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 w-[calc(100vw-2rem)] sm:max-w-md pointer-events-none"
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
            className="pointer-events-auto flex items-center gap-3 px-3.5 py-2.5 bg-zinc-900 text-zinc-50 border border-zinc-800 rounded-lg shadow-lg text-xs font-medium toast-in"
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
