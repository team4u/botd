import { useCallback, useState } from 'react';
import type { ToastItem } from '../types';

export type AddToastFn = (type: ToastItem['type'], message: string) => void;

/** Toast 通知：追加后 4.5s 自动移除 */
export const useToasts = (): { toasts: ToastItem[]; addToast: AddToastFn; dismissToast: (id: string) => void } => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback<AddToastFn>((type, message) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
};
