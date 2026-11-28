'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, ShieldAlert, Trash2, X } from 'lucide-react';

export type ConfirmTone = 'warning' | 'danger' | 'primary';

export type ConfirmOptions = {
  title: string;
  description: string;
  target?: string;
  impacts?: readonly string[];
  badge?: string;
  tone?: ConfirmTone;
  confirmLabel?: string;
  cancelLabel?: string;
  lightDismiss?: boolean;
};

type QueuedConfirm = {
  id: number;
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
};

type Listener = (queue: QueuedConfirm[]) => void;

let nextConfirmId = 1;
let queue: QueuedConfirm[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(queue);
}

/**
 * Open a top-layer modal confirmation dialog and resolve once the user confirms or dismisses.
 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { id: nextConfirmId++, options, resolve }];
    emit();
  });
}

let cachedSupportsDisplayTransition: boolean | undefined;

function canTransitionDisplay() {
  if (cachedSupportsDisplayTransition !== undefined) return cachedSupportsDisplayTransition;
  if (typeof window === 'undefined' || !window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  // Intentional transition shorthand so browsers without allow-discrete drop it and apply display:none immediately.
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  cachedSupportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return cachedSupportsDisplayTransition;
}

function supportsTopLayerExit() {
  return typeof window !== 'undefined' && Boolean(window.CSS?.supports?.('overlay', 'auto')) && canTransitionDisplay();
}

function pointerOutsideDialog(event: PointerEvent, dialog: HTMLDialogElement) {
  const rect = dialog.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}

async function waitAnimations(element: HTMLElement) {
  const animations = element.getAnimations?.({ subtree: true }) ?? [];
  if (animations.length === 0) return;
  await Promise.race([
    Promise.allSettled(animations.map((animation) => animation.finished)),
    new Promise<void>((resolve) => window.setTimeout(resolve, 450)),
  ]);
}

export function ConfirmViewport() {
  const [items, setItems] = useState<QueuedConfirm[]>(() => queue);
  const current = items[0];
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);
  const resolvedRef = useRef(false);
  const removedRef = useRef(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    listeners.add(setItems);
    setItems(queue);
    return () => {
      listeners.delete(setItems);
    };
  }, []);

  const resolveOnce = useCallback((confirmed: boolean) => {
    if (resolvedRef.current || !current) return;
    resolvedRef.current = true;
    current.resolve(confirmed);
  }, [current]);

  const removeFromQueue = useCallback((id: number) => {
    if (removedRef.current) return;
    removedRef.current = true;
    closingRef.current = false;
    queue = queue.filter((item) => item.id !== id);
    emit();
  }, []);

  const closeAnimated = useCallback(async (confirmed: boolean) => {
    const dialog = dialogRef.current;
    if (!dialog || !current || closingRef.current) return;
    closingRef.current = true;
    const itemId = current.id;
    resolveOnce(confirmed);

    if (!supportsTopLayerExit()) {
      dialog.setAttribute('data-closing', '');
      await waitAnimations(dialog);
      if (dialog.hasAttribute('data-closing')) dialog.removeAttribute('data-closing');
      dialog.returnValue = confirmed ? 'confirm' : 'cancel';
      if (dialog.open) dialog.close(dialog.returnValue);
      removeFromQueue(itemId);
      return;
    }

    dialog.returnValue = confirmed ? 'confirm' : 'cancel';
    if (dialog.open) dialog.close(dialog.returnValue);
    await waitAnimations(dialog);
    removeFromQueue(itemId);
  }, [current, removeFromQueue, resolveOnce]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!current || !dialog) return;
    resolvedRef.current = false;
    removedRef.current = false;
    closingRef.current = false;
    dialog.removeAttribute('data-closing');
    if (!dialog.open) {
      dialog.showModal();
      cancelBtnRef.current?.focus();
    }
  }, [current]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!current || !dialog) return;
    const itemId = current.id;
    const lightDismiss = current.options.lightDismiss ?? true;
    let pressedOutside = false;

    const onCancel = (event: Event) => {
      event.preventDefault();
      if (!lightDismiss) return;
      void closeAnimated(false);
    };

    const onClose = () => {
      const confirmed = dialog.returnValue === 'confirm';
      dialog.returnValue = '';
      resolveOnce(confirmed);
      if (!closingRef.current) {
        closingRef.current = true;
        void waitAnimations(dialog).then(() => removeFromQueue(itemId));
      }
    };

    const supportsClosedBy = 'closedBy' in HTMLDialogElement.prototype;
    const onPointerDown = (event: PointerEvent) => {
      if (!lightDismiss || supportsClosedBy) return;
      pressedOutside = pointerOutsideDialog(event, dialog);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!lightDismiss || supportsClosedBy) return;
      if (pressedOutside && pointerOutsideDialog(event, dialog)) {
        void closeAnimated(false);
      }
      pressedOutside = false;
    };

    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, [closeAnimated, current, removeFromQueue, resolveOnce]);

  if (!current) return null;

  const {
    title,
    description,
    target,
    impacts,
    badge,
    tone = 'warning',
    confirmLabel = '确认继续',
    cancelLabel = '取消',
    lightDismiss = true,
  } = current.options;

  const Icon = tone === 'danger' ? Trash2 : tone === 'warning' ? AlertTriangle : Info;
  const BadgeIcon = tone === 'danger' ? ShieldAlert : tone === 'warning' ? AlertTriangle : CheckCircle2;

  return (
    <dialog
      ref={dialogRef}
      key={current.id}
      className={`confirm-dialog tone-${tone}`}
      aria-labelledby={titleId}
      aria-describedby={descId}
      {...({ closedby: lightDismiss ? 'any' : 'none' } as Record<string, string>)}
    >
      <div className="confirm-surface">
        <div className="confirm-head">
          <div className={`confirm-crest tone-${tone}`} aria-hidden="true">
            <span className="confirm-crest-ring" />
            <Icon size={20} strokeWidth={2.1} />
          </div>
          <div className="confirm-head-copy">
            {badge && (
              <span className={`badge ${tone === 'danger' ? 'red' : tone === 'warning' ? 'amber' : 'violet'}`}>
                <BadgeIcon size={12} aria-hidden="true" />
                {badge}
              </span>
            )}
            <h1 id={titleId} className="confirm-title">{title}</h1>
          </div>
          <button
            type="button"
            className="icon-button confirm-close"
            aria-label="关闭确认弹窗"
            onClick={() => void closeAnimated(false)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="confirm-body">
          {target && (
            <div className="confirm-target">
              <span className="confirm-target-label">操作对象</span>
              <strong title={target}>{target}</strong>
            </div>
          )}
          <p id={descId} className="confirm-desc">{description}</p>
          {impacts && impacts.length > 0 && (
            <ul className="confirm-impacts" aria-label="操作影响与说明">
              {impacts.map((line, index) => (
                <li key={index} style={{ ['--impact-idx' as string]: index }}>
                  <span className="confirm-impact-dot" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="confirm-footer">
          <span className="confirm-shortcut muted small">
            {lightDismiss ? '按 Esc 或点击遮罩取消' : '请选择操作'}
          </span>
          <div className="actions">
            <button
              ref={cancelBtnRef}
              type="button"
              className="button confirm-btn-cancel"
              autoFocus
              onClick={() => void closeAnimated(false)}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className={`button confirm-btn-accept tone-${tone}`}
              onClick={() => void closeAnimated(true)}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
