'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

export type ThemeMode = 'system' | 'light' | 'dark';

const themes: Record<ThemeMode, { label: string; icon: typeof Monitor }> = {
  system: { label: '跟随系统', icon: Monitor },
  light: { label: '浅色', icon: Sun },
  dark: { label: '深色', icon: Moon },
};

export function applyThemeMode(next: ThemeMode) {
  if (next === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try { localStorage.setItem('matrixark-theme', next); } catch {}
  window.dispatchEvent(new CustomEvent<ThemeMode>('matrixark-theme-change', { detail: next }));
}

export function readThemeMode(): ThemeMode {
  if (typeof document === 'undefined') return 'system';
  const value = document.documentElement.dataset.theme;
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeMode>('system');
  useEffect(() => {
    setTheme(readThemeMode());
    const onThemeChange = (event: Event) => {
      const detail = (event as CustomEvent<ThemeMode>).detail;
      setTheme(detail ?? readThemeMode());
    };
    window.addEventListener('matrixark-theme-change', onThemeChange);
    return () => window.removeEventListener('matrixark-theme-change', onThemeChange);
  }, []);
  const Icon = themes[theme].icon;
  return <label className="theme-picker">
    <Icon size={15} aria-hidden="true" />
    <select aria-label="界面主题" value={theme} onChange={(event) => {
      const next = event.target.value as ThemeMode;
      applyThemeMode(next);
      setTheme(next);
    }}>
      {Object.entries(themes).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </label>;
}
