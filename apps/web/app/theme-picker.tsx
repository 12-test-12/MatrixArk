'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

const themes = {
  system: { label: '跟随系统', icon: Monitor },
  light: { label: '浅色', icon: Sun },
  dark: { label: '深色', icon: Moon },
};
type Theme = keyof typeof themes;

export function ThemePicker() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const value = document.documentElement.dataset.theme;
    if (value === 'light' || value === 'dark') setTheme(value);
  }, []);
  const Icon = themes[theme].icon;
  return <label className="theme-picker">
    <Icon size={15} aria-hidden="true" />
    <select aria-label="界面主题" value={theme} onChange={(event) => {
      const next = event.target.value as Theme;
      if (next === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = next;
      setTheme(next);
      try { localStorage.setItem('matrixark-theme', next); } catch {}
    }}>
      {Object.entries(themes).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </label>;
}
