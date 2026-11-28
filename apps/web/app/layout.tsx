import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ConfirmViewport } from './confirm-dialog';
import { ToastViewport } from './toast';
import './globals.css';

export const metadata: Metadata = {
  title: 'MatrixArk · 内容工作台',
  description: '管理原稿、多平台审核、发布任务和回执。',
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

const restoreTheme = `try {
  const theme = localStorage.getItem('matrixark-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: restoreTheme }} /></head>
    <body>{children}<ToastViewport /><ConfirmViewport /></body>
  </html>;
}
