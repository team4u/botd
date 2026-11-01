import React from 'react';
import { X, AlertTriangle, Loader2 } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/90 dark:border-zinc-800/90 max-w-md w-full flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0 overflow-hidden">
        {/* Mobile Drag Handle */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {danger && <AlertTriangle className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0" />}
            <h2 id="confirm-dialog-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
          {message}
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 flex justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl transition-colors disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white rounded-xl transition-colors shadow-xs disabled:opacity-50 ${
              danger
                ? 'bg-rose-600 hover:bg-rose-500 dark:bg-rose-600 dark:hover:bg-rose-500'
                : 'bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white'
            }`}
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
