import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { initViewportAdjustment } from './utils/viewport';
import './index.css';

// 启动移动端软键盘与视口自动适配（锁定 --app-height 与消除空白）
initViewportAdjustment();

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <ErrorBoundary>
      <React.StrictMode>
        <App />
      </React.StrictMode>
    </ErrorBoundary>
  );
}
