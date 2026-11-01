import type { SessionSseEvent } from '@botd/protocol';

export type SseListener = (event: SessionSseEvent) => void;

export class SseHub {
  private listeners = new Map<string, Set<SseListener>>();

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

  broadcast(sessionId: string, event: SessionSseEvent): void {
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
  }

  close(): void {
    this.listeners.clear();
  }
}
