import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  showStack: boolean;
}

function firstStackLines(stack: string | undefined, lines = 3): string {
  if (!stack) return '';
  return stack.split('\n').slice(0, lines).join('\n');
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, showStack: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null, showStack: false });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error, showStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-full w-full flex items-center justify-center p-6 bg-zinc-50 dark:bg-zinc-950">
        <div className="w-full max-w-md rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-sm">
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">界面出现异常</h1>

          <p className="mt-2 text-xs text-zinc-500 font-mono break-all">{error.message || String(error)}</p>

          {error.stack && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => this.setState((s) => ({ showStack: !s.showStack }))}
                className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                {showStack ? '收起堆栈' : '展开堆栈'}
              </button>
              {showStack && (
                <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-zinc-100 dark:bg-zinc-800 p-2.5 text-[11px] leading-relaxed text-zinc-500 font-mono whitespace-pre-wrap break-all">
                  {firstStackLines(error.stack)}
                </pre>
              )}
            </div>
          )}

          {import.meta.env.DEV && error.stack && (
            <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-zinc-100 dark:bg-zinc-800 p-2.5 text-[11px] leading-relaxed text-zinc-500 font-mono whitespace-pre-wrap break-all">
              {error.stack}
            </pre>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleRetry}
              className="h-8 px-3 text-xs font-medium rounded-lg bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:opacity-90"
            >
              重试
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="h-8 px-3 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              刷新页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
