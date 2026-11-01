import { useState } from 'react';
import { Monitor, Sun, Moon } from 'lucide-react';
import { type ThemeMode, getThemeMode, cycleTheme } from '../utils/theme';

const THEME_META: Record<ThemeMode, { label: string; Icon: typeof Monitor }> = {
  auto: { label: '主题：跟随系统', Icon: Monitor },
  light: { label: '主题：浅色', Icon: Sun },
  dark: { label: '主题：深色', Icon: Moon },
};

export default function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => getThemeMode());

  const handleClick = () => {
    setMode(cycleTheme());
  };

  const { label, Icon } = THEME_META[mode];

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title="点击切换主题"
      className="h-8 w-8 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 flex items-center justify-center"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
