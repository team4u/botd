import type { GlobalSseEvent } from '@botd/protocol';

/**
 * 模块级轻量事件总线：App 订阅全局 SSE（/api/events）后 emit，
 * 任意组件通过 onGlobalEvent 消费，避免层层透传回调。
 */
const listeners = new Set<(event: GlobalSseEvent) => void>();

export function emitGlobalEvent(event: GlobalSseEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // 单个监听器异常不应影响其他订阅者
    }
  }
}

export function onGlobalEvent(fn: (event: GlobalSseEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
