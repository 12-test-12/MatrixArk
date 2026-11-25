'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastTone = 'success' | 'info' | 'error';

export type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
  closing?: boolean;
};

type Listener = (items: ToastItem[]) => void;

const listeners = new Set<Listener>();
let items: ToastItem[] = [];
let nextId = 1;

function emit() {
  const snapshot = [...items];
  for (const listener of listeners) listener(snapshot);
}

export function pushToast(message: string, tone: ToastTone = 'success', duration = tone === 'error' ? 4800 : 3600) {
  const text = message.trim();
  if (!text) return;
  const existing = items.find((item) => !item.closing && item.message === text && item.tone === tone);
  if (existing) {
    items = items.filter((item) => item.id !== existing.id);
  }
  const toast: ToastItem = { id: nextId++, message: text, tone, duration };
  items = [toast, ...items].slice(0, 4);
  emit();
}

export function dismissToast(id: number) {
  const target = items.find((item) => item.id === id);
  if (!target || target.closing) return;
  items = items.map((item) => (item.id === id ? { ...item, closing: true } : item));
  emit();
  window.setTimeout(() => {
    items = items.filter((item) => item.id !== id);
    emit();
  }, 180);
}

function ToastCard({ item }: { item: ToastItem }) {
  const remainingRef = useRef(item.duration);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (item.closing || paused) return;
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => {
      dismissToast(item.id);
    }, Math.max(200, remainingRef.current));
    return () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        remainingRef.current = Math.max(200, remainingRef.current - (Date.now() - startedAtRef.current));
      }
    };
  }, [item.id, item.closing, paused]);

  const Icon = item.tone === 'error' ? AlertCircle : item.tone === 'info' ? Info : CheckCircle2;

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      className={`toast-card tone-${item.tone}${item.closing ? ' closing' : ''}${paused ? ' paused' : ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-icon" aria-hidden="true"><Icon size={17} /></span>
      <span className="toast-message">{item.message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭通知"
        onClick={() => dismissToast(item.id)}
      >
        <X size={14} aria-hidden="true" />
      </button>
      <span
        className="toast-progress"
        aria-hidden="true"
        style={{ animationDuration: `${item.duration}ms` }}
      />
    </div>
  );
}

export function ToastViewport() {
  const [list, setList] = useState<ToastItem[]>(() => items);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);

  useEffect(() => {
    const el = viewportRef.current as (HTMLDivElement & {
      showPopover?: () => void;
      hidePopover?: () => void;
    }) | null;
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      if (list.length > 0 && !el.matches(':popover-open')) el.showPopover();
      else if (list.length === 0 && el.matches(':popover-open')) el.hidePopover();
    } catch {
      // Ignore popover state transitions when browser hides layer.
    }
  }, [list.length]);

  return (
    <div
      ref={viewportRef}
      {...({ popover: 'manual' } as any)}
      className="toast-viewport"
      aria-live="polite"
      aria-label="操作提醒"
    >
      {list.map((item) => <ToastCard key={item.id} item={item} />)}
    </div>
  );
}
