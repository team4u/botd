import React, { useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, Loader2, Eye, EyeOff } from 'lucide-react';

/** prompt 输入框配置：传入后在正文下方渲染单行输入，回车提交 */
export interface ConfirmDialogPromptConfig {
  /** 输入框占位提示 */
  placeholder?: string;
  /** 输入类型，默认 text；password 附带显示/隐藏切换 */
  type?: 'text' | 'password';
  /** 打开弹窗时的初始值 */
  initial?: string;
  /** 输入框上方的字段标签 */
  label?: string;
}

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  /** 传入后在正文下方渲染输入框，onConfirm 将收到输入值 */
  prompt?: ConfirmDialogPromptConfig;
  /** 允许 prompt 为空时确认（默认空值禁用确认按钮） */
  allowEmptyPrompt?: boolean;
  /** 附加校验：返回 false 时禁用确认（叠加在空值校验之上） */
  validatePrompt?: (value: string) => boolean;
  /** prompt 存在时收到输入值，否则为 undefined；旧的 () => void 用法依然类型兼容 */
  onConfirm: (input?: string) => void;
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
  prompt,
  allowEmptyPrompt = false,
  validatePrompt,
  onConfirm,
  onClose,
}) => {
  const [promptValue, setPromptValue] = useState('');
  const [promptVisible, setPromptVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时重置输入；有 prompt 聚焦输入框，无 prompt 保持现状不抢焦点
  useEffect(() => {
    if (!isOpen) return;
    setPromptValue(prompt?.initial ?? '');
    setPromptVisible(false);
    if (prompt) {
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const hasPrompt = Boolean(prompt);
  const promptEmpty = hasPrompt && !allowEmptyPrompt && promptValue.trim() === '';
  const promptInvalid = hasPrompt && validatePrompt ? !validatePrompt(promptValue) : false;
  const confirmBlocked = busy || confirmDisabled || promptEmpty || promptInvalid;

  const handleSubmit = () => {
    if (confirmBlocked) return;
    onConfirm(hasPrompt ? promptValue : undefined);
  };

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
          {prompt && (
            <div className="mt-3 space-y-1.5">
              {prompt.label && (
                <label
                  htmlFor="confirm-dialog-prompt"
                  className="block text-xs font-medium text-zinc-700 dark:text-zinc-300"
                >
                  {prompt.label}
                </label>
              )}
              <div className="relative">
                <input
                  id="confirm-dialog-prompt"
                  ref={inputRef}
                  type={prompt.type === 'password' && !promptVisible ? 'password' : 'text'}
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder={prompt.placeholder}
                  autoComplete="off"
                  aria-label={prompt.label || '输入内容'}
                  className={`w-full h-8 ${prompt.type === 'password' ? 'pr-8' : ''} px-2.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 dark:placeholder:text-zinc-500`}
                />
                {prompt.type === 'password' && (
                  <button
                    type="button"
                    onClick={() => setPromptVisible((v) => !v)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded transition-colors cursor-pointer"
                    aria-label={promptVisible ? '隐藏密码' : '显示密码'}
                    title={promptVisible ? '隐藏密码' : '显示密码'}
                  >
                    {promptVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
            </div>
          )}
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
            onClick={handleSubmit}
            disabled={confirmBlocked}
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
