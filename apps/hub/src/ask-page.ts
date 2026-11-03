function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderResponseHtml(answer: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>botd 交互确认</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 24px;
      background: #f4f4f5;
      color: #18181b;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
    }
    @media (prefers-color-scheme: dark) {
      body {
        background: #09090b;
        color: #f4f4f5;
      }
    }
    .card {
      background: #ffffff;
      padding: 36px 32px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
      max-width: 440px;
      width: 100%;
      text-align: center;
    }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #18181b;
        border: 1px solid #27272a;
      }
    }
    .icon {
      font-size: 48px;
      margin-bottom: 16px;
      line-height: 1;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 12px;
      font-weight: 600;
    }
    .answer-box {
      background: #f4f4f5;
      border-radius: 10px;
      padding: 12px 16px;
      margin: 18px 0;
      font-weight: 600;
      font-size: 15px;
      color: #2563eb;
      word-break: break-all;
    }
    @media (prefers-color-scheme: dark) {
      .answer-box {
        background: #27272a;
        color: #60a5fa;
      }
    }
    .hint {
      font-size: 13px;
      color: #71717a;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>已确认提交</h1>
    <div class="answer-box">${escapeHtml(answer)}</div>
    <div class="hint">回调已成功投递到 botd 会话，您可以关闭此页面。</div>
  </div>
</body>
</html>`;
}

export function renderErrorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>botd 交互确认失败</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 24px;
      background: #f4f4f5;
      color: #18181b;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
    }
    @media (prefers-color-scheme: dark) {
      body {
        background: #09090b;
        color: #f4f4f5;
      }
    }
    .card {
      background: #ffffff;
      padding: 36px 32px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
      max-width: 440px;
      width: 100%;
      text-align: center;
    }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #18181b;
        border: 1px solid #27272a;
      }
    }
    .icon {
      font-size: 48px;
      margin-bottom: 16px;
      line-height: 1;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 12px;
      font-weight: 600;
      color: #e11d48;
    }
    .desc {
      font-size: 14px;
      color: #52525b;
      margin: 12px 0;
    }
    @media (prefers-color-scheme: dark) {
      .desc { color: #a1a1aa; }
    }
    .hint {
      font-size: 13px;
      color: #71717a;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="desc">${escapeHtml(message)}</div>
    <div class="hint">您可以关闭此页面。</div>
  </div>
</body>
</html>`;
}
