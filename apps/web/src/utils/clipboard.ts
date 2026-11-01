/**
 * 统一剪贴板复制工具：优先使用异步 Clipboard API（需安全上下文），
 * 不可用或被拒绝时降级为隐藏 textarea + execCommand 同步复制，
 * 保证 HTTP 局域网访问等非安全上下文下复制按钮仍然可用。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒或写入失败，继续走降级路径
    }
  }

  // 降级：隐藏 textarea + execCommand('copy')（非安全上下文 / 权限拒绝时）
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // 移出可视区但保持可聚焦，避免页面滚动跳动
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    previouslyFocused?.focus?.();
    return ok;
  } catch {
    return false;
  }
}
