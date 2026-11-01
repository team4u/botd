export type ThemeMode = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'botd-theme';

export function getThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved;
  } catch {
    /* noop */
  }
  return 'auto';
}

function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'light' || mode === 'dark') return mode === 'dark';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function applyTheme(): void {
  const dark = resolveDark(getThemeMode());
  document.documentElement.classList.toggle('dark', dark);
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* noop */
  }
  applyTheme();
}

export function cycleTheme(): ThemeMode {
  const order: ThemeMode[] = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(getThemeMode()) + 1) % order.length];
  setThemeMode(next);
  return next;
}

// 模块加载时注册一次性系统主题监听：仅在当前为 auto 时重新应用
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getThemeMode() === 'auto') applyTheme();
  };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
  } else if (typeof mq.addListener === 'function') {
    mq.addListener(onChange);
  }
}
