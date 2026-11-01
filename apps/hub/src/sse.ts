import type { GlobalSseEvent, SessionSseEvent } from '@botd/protocol';

export type SseListener = (event: SessionSseEvent) => void;
export type GlobalSseListener = (event: GlobalSseEvent) => void;

export interface SseHubOptions {
  /** 解析会话归属用户；提供后 broadcast 会同时派发给该会话 owner 的全局订阅者 */
  getSessionOwnerId?: (sessionId: string) => string | undefined;
}

export class SseHub {
  private listeners = new Map<string, Set<SseListener>>();
  private userListeners = new Map<string, Set<GlobalSseListener>>();
  private internalListeners = new Set<(sessionId: string, event: SessionSseEvent) => void>();
  private getSessionOwnerId?: (sessionId: string) => string | undefined;

  constructor(options?: SseHubOptions) {
    this.getSessionOwnerId = options?.getSessionOwnerId;
  }

  /** 注册内部会话广播监听器（用于外部通知通道等内部业务处理） */
  onBroadcast(listener: (sessionId: string, event: SessionSseEvent) => void): () => void {
    this.internalListeners.add(listener);
    return () => {
      this.internalListeners.delete(listener);
    };
  }

  subscribe(sessionId: string, listener: SseListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  /** 按用户订阅全局事件（该用户所有会话的事件 + 其节点的上下线通知） */
  subscribeUser(userId: string, listener: GlobalSseListener): () => void {
    let set = this.userListeners.get(userId);
    if (!set) {
      set = new Set();
      this.userListeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.userListeners.delete(userId);
      }
    };
  }

  broadcast(sessionId: string, event: SessionSseEvent): void {
    for (const listener of this.internalListeners) {
      try {
        listener(sessionId, event);
      } catch {
        // ignore listener errors
      }
    }
    const set = this.listeners.get(sessionId);
    if (set) {
      for (const listener of set) {
        try {
          listener(event);
        } catch {
          // ignore listener errors
        }
      }
    }
    // 同步派发给该会话 owner 的全局订阅者（GET /api/events）
    if (this.getSessionOwnerId) {
      const ownerId = this.getSessionOwnerId(sessionId);
      if (ownerId) {
        this.dispatchToUser(ownerId, event);
      }
    }
  }

  /** 向指定用户的全局订阅者广播事件（节点上下线等非会话维度事件） */
  broadcastToUser(userId: string, event: GlobalSseEvent): void {
    this.dispatchToUser(userId, event);
  }

  private dispatchToUser(userId: string, event: GlobalSseEvent): void {
    const set = this.userListeners.get(userId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  close(): void {
    this.listeners.clear();
    this.userListeners.clear();
    this.internalListeners.clear();
  }
}
