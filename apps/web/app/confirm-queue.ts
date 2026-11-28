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

export type QueuedConfirm = {
  id: number;
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
  settled: boolean;
};

type Listener = (queue: QueuedConfirm[]) => void;

let nextConfirmId = 1;
let queue: QueuedConfirm[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(queue);
}

/** Subscribe to queue changes. The listener is called once with the current queue. */
export function subscribeConfirms(listener: Listener) {
  listeners.add(listener);
  listener(queue);
  return () => {
    listeners.delete(listener);
  };
}

export function pendingConfirms() {
  return queue;
}

/**
 * Queue a modal confirmation and resolve once the user answers or dismisses it.
 * Answers are matched by id, so a late event from a closed dialog can never settle the next one.
 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { id: nextConfirmId++, options, resolve, settled: false }];
    emit();
  });
}

/** Resolve the item once. A repeat or an id that is no longer queued is ignored. */
export function resolveConfirm(id: number, confirmed: boolean) {
  const item = queue.find((entry) => entry.id === id);
  if (!item || item.settled) return;
  item.settled = true;
  item.resolve(confirmed);
}

/** Drop a finished item from the queue. An id that is already gone is ignored. */
export function removeConfirm(id: number) {
  if (!queue.some((entry) => entry.id === id)) return;
  queue = queue.filter((entry) => entry.id !== id);
  emit();
}
