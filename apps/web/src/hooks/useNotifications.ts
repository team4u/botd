import { useCallback, useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { BotConfig, MessageRecord } from '@botd/protocol';
import type { NavigateFn } from './useHashRoute';

/** 非当前会话新消息提示音：150ms 880Hz→660Hz 短促 beep（Web Audio，失败静默） */
const playNotificationBeep = () => {
  try {
    const AudioCtor: typeof AudioContext | undefined =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.linearRampToValueAtTime(660, now + 0.15);
    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {
    // Web Audio 不可用时静默降级
  }
};

export interface NotificationsApi {
  unreadCounts: Record<string, number>;
  /** 通知所属会话有新消息（非当前会话）：计未读并按页面可见性提示（声音/浏览器通知） */
  notifyBackgroundMessage: (message: MessageRecord) => void;
  /** 当前会话页面不可见时到达的 assistant/callback 消息：仅发浏览器通知（不计数） */
  notifyHiddenCompletion: (message: MessageRecord) => void;
  markSessionRead: (sessionId: string) => void;
  removeSessions: (sessionIds: string[]) => void;
  clearAll: () => void;
}

/**
 * 非当前会话消息提醒：未读计数 + document.title 角标 + 声音/浏览器 Notification。
 * botMapRef 传入最新 bot 映射的 ref（通知标题取 bot 名称），避免订阅闭包拿到陈旧映射。
 */
export const useNotifications = (
  authenticated: boolean,
  navigate: NavigateFn,
  botMapRef: MutableRefObject<Map<string, BotConfig>>
): NotificationsApi => {
  // 非当前会话未读计数（sessionId → 条数）：进入会话清零、登出清空
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  // 聚合未读数写入 document.title（登出/无未读时恢复默认标题）
  useEffect(() => {
    const total = authenticated
      ? Object.values(unreadCounts).reduce((sum, n) => sum + n, 0)
      : 0;
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) botd` : 'botd · 多节点个人智能体平台';
  }, [unreadCounts, authenticated]);

  // 后台完成通知：页面不可见时以浏览器 Web Notification 提醒用户回合结束；点击聚焦并跳回来源会话
  const notifyHiddenCompletion = useCallback((message: MessageRecord) => {
    if (typeof Notification === 'undefined') return;
    if (document.visibilityState !== 'hidden') return;
    if (Notification.permission !== 'granted') return;
    try {
      const botName = botMapRef.current.get(message.senderBotId || '')?.name || message.senderBotId || '智能体';
      const preview = (message.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const title =
        message.role === 'callback' ? `${botName} 有新的异步任务通知` : `${botName} 已完成回复`;
      const body = preview || '回合已结束，点击返回查看';
      const notification = new Notification(title, { body, tag: `botd-${message.sessionId}` });
      notification.onclick = () => {
        window.focus();
        // navigate 为稳定 useCallback，闭包内可安全引用；跳回来源会话并清除高亮
        navigate({ sessionId: message.sessionId, view: 'chat', messageId: null });
        notification.close();
      };
    } catch {
      // 通知构造失败（如部分环境限制）时静默降级
    }
  }, [botMapRef, navigate]);

  const notifyBackgroundMessage = useCallback((message: MessageRecord) => {
    setUnreadCounts((prev) => ({ ...prev, [message.sessionId]: (prev[message.sessionId] || 0) + 1 }));
    if (document.visibilityState === 'visible') {
      // 页面可见：按用户设置播提示音；不可见时交给 Notification，避免双重打扰
      if (localStorage.getItem('botd-sound') === '1') playNotificationBeep();
    } else {
      notifyHiddenCompletion(message);
    }
  }, [notifyHiddenCompletion]);

  const markSessionRead = useCallback((sessionId: string) => {
    setUnreadCounts((prev) =>
      prev[sessionId] ? { ...prev, [sessionId]: 0 } : prev
    );
  }, []);

  const removeSessions = useCallback((sessionIds: string[]) => {
    setUnreadCounts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of sessionIds) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const clearAll = useCallback(() => setUnreadCounts({}), []);

  return { unreadCounts, notifyBackgroundMessage, notifyHiddenCompletion, markSessionRead, removeSessions, clearAll };
};
