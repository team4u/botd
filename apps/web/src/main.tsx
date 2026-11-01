import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { SharedSessionView } from './components/SharedSessionView';
import { initViewportAdjustment } from './utils/viewport';
import './index.css';

// 启动移动端软键盘与视口自动适配（锁定 --app-height 与消除空白）
initViewportAdjustment();

/** 解析公开分享链接 token（?share=token 或 #?share=token） */
const parseShareToken = (): string | null =>
  new URLSearchParams(window.location.search).get('share') ||
  new URLSearchParams(window.location.hash.replace(/^#[?]?/, '')).get('share');

/**
 * 分享视图与主应用互斥渲染（两个独立组件树，而非 App 内 hooks 前早退）：
 * 避免 hash 变化导致 share 分支切换时违反 Rules of Hooks 使整树崩溃。
 */
const Root: React.FC = () => {
  const [shareToken, setShareToken] = useState<string | null>(parseShareToken);

  useEffect(() => {
    const handleUrlChange = () => setShareToken(parseShareToken());
    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);
    return () => {
      window.removeEventListener('popstate', handleUrlChange);
      window.removeEventListener('hashchange', handleUrlChange);
    };
  }, []);

  if (shareToken) {
    return <SharedSessionView token={shareToken} />;
  }
  return <App />;
};

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <ErrorBoundary>
      <React.StrictMode>
        <Root />
      </React.StrictMode>
    </ErrorBoundary>
  );
}
