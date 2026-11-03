import { useCallback, useState } from 'react';
import type { NotificationTellPolicy } from '@botd/protocol';
import { copyText } from '../../utils/clipboard';

export type AddToastFn = (type: 'success' | 'error' | 'info', message: string) => void;

export const TELL_POLICY_LABELS: Record<NotificationTellPolicy, string> = {
  needed: '按需打扰',
  always: '全部推送',
  never: '静默',
};

/** 逗号分隔的事件类型列表 → 去重后的非空数组（如 'pull_request.opened, push'） */
export function parseEventTypes(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const t = part.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 校验一次性延时输入：支持相对延时（30s/15m/2h/1d）或 ISO 时间 */
export function parseOnceRunAt(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Relative delay: e.g. 30s, 15m, 2h, 1d (also combined like 1h30m)
  const relMatch = trimmed.match(/^(\d+(?:\d|h|m|s|d)?(?=[hmsd])[hmsd]*)+$/i);
  if (relMatch) {
    let seconds = 0;
    const unitMatches = trimmed.toLowerCase().match(/\d+[hmsd]/g);
    if (unitMatches && unitMatches.length > 0) {
      for (const part of unitMatches) {
        const n = parseInt(part, 10);
        if (Number.isNaN(n)) return null;
        const unit = part.slice(-1);
        if (unit === 's') seconds += n;
        else if (unit === 'm') seconds += n * 60;
        else if (unit === 'h') seconds += n * 3600;
        else if (unit === 'd') seconds += n * 86400;
      }
      if (seconds <= 0) return null;
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }

  // Absolute ISO timestamp (or plain datetime accepted by Date parser)
  const ts = new Date(trimmed).getTime();
  if (Number.isFinite(ts)) {
    return new Date(ts).toISOString();
  }
  return null;
}

/** ISO 时间 → datetime-local 输入值（本地时区，分钟粒度） */
export function isoToLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 输入值（本地时区）→ ISO 时间 */
export function localDatetimeInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ts = new Date(trimmed).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

/** 复制到剪贴板并以 toast 反馈结果 */
export async function copyWithToast(text: string, label: string, onAddToast: AddToastFn): Promise<void> {
  const ok = await copyText(text);
  if (ok) {
    onAddToast('success', `已复制 ${label}`);
  } else {
    onAddToast('error', `复制 ${label} 失败，请手动复制`);
  }
}

/** 行内复制反馈：复制成功后 1.5s 内对指定 id 显示 Check 图标 */
export function useUrlCopy(onAddToast: AddToastFn) {
  const [copiedUrlId, setCopiedUrlId] = useState<string | null>(null);

  const resetCopiedUrl = useCallback(() => setCopiedUrlId(null), []);

  const copyUrl = useCallback(
    async (id: string, url: string) => {
      const ok = await copyText(url);
      if (ok) {
        setCopiedUrlId(id);
        window.setTimeout(() => setCopiedUrlId((cur) => (cur === id ? null : cur)), 1500);
      } else {
        onAddToast('error', '复制 Webhook URL 失败，请手动复制');
      }
    },
    [onAddToast]
  );

  return { copiedUrlId, copyUrl, resetCopiedUrl };
}
