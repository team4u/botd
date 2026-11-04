/**
 * 极简 Context 取消派生（@earendil-works/chord context 的结构子集，纯 Node 实现）。
 *
 * Node 侧只需要「从 BACKGROUND 派生可独立取消的子 Context」这一种能力，
 * 因此仅保留 abortSignal 通道；消费方（vendored 执行环境）只读取 abortSignal，
 * 不再为它引入外部依赖。
 */

export interface Context {
  readonly abortSignal?: AbortSignal | undefined;
  value(key: { token: symbol }): unknown;
  toString(): string;
}

class EmptyContext implements Context {
  value(): undefined {
    return undefined;
  }
  toString(): string {
    return '[Context BACKGROUND]';
  }
}

export const BACKGROUND_CONTEXT: Context = new EmptyContext();

/** 派生一个可独立取消的子 Context；父 Context 不受影响。 */
export function withCancel(parent: Context): { context: Context; cancel: (reason?: unknown) => void } {
  const controller = new AbortController();
  return {
    context: {
      get abortSignal(): AbortSignal | undefined {
        return controller.signal;
      },
      value: (key) => parent.value(key),
      toString: () => `${parent}.withCancel()`,
    },
    cancel: (reason?: unknown) => controller.abort(reason),
  };
}
