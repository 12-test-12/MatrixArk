import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ImageOff, Layers3, LoaderCircle, X, type LucideIcon } from 'lucide-react';
import { taskLabel, type Platform, type TaskStatus } from './api';

export function PlatformIcon({ platform }: { platform: Platform }) {
  return <span className={`platform-icon ${platform}`} aria-hidden="true">{platform === 'xiaohongshu' ? '红' : 'B'}</span>;
}

export function Brand({ detail = false }: { detail?: boolean }) {
  return <div className="brand">
    <span className="brand-mark"><Layers3 aria-hidden="true" size={22} strokeWidth={2.1} /></span>
    <span><strong>MatrixArk</strong>{detail && <small>创作与发布工作台</small>}</span>
  </div>;
}

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="page-heading">
    <div><h1>{title}</h1><p>{description}</p></div>
    {children && <div className="actions">{children}</div>}
  </div>;
}

export function Feedback({ error, notice }: { error?: string; notice?: string }) {
  if (error) return <div role="alert" className="feedback error"><AlertCircle size={16} aria-hidden="true" />{error}</div>;
  if (notice) return <div role="status" className="feedback success"><CheckCircle2 size={16} aria-hidden="true" />{notice}</div>;
  return null;
}

export function Loading() {
  return <div className="loading" role="status"><LoaderCircle size={19} aria-hidden="true" />正在加载…</div>;
}

export function Empty({ icon: Icon, title, description, children }: {
  icon: LucideIcon; title: string; description?: string; children?: ReactNode;
}) {
  return <div className="empty">
    <span className="empty-icon"><Icon size={24} aria-hidden="true" /></span>
    <h2>{title}</h2>{description && <p>{description}</p>}{children}
  </div>;
}

export function ReviewPicture({ src, label }: { src: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [originalFailed, setOriginalFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
  }, [open]);

  return <>
    <button type="button" className="picture-button" aria-haspopup="dialog" aria-label={`查看完整图片：${label}`}
      onClick={() => { setOriginalFailed(false); setOpen(true); }}>
      {thumbnailFailed ? <span className="picture-fallback"><ImageOff size={18} aria-hidden="true" />查看原图</span>
        : <img src={src + '/thumbnail'} alt="" loading="lazy" decoding="async" onError={() => setThumbnailFailed(true)} />}
    </button>
    {open && <dialog ref={dialog} aria-labelledby={titleId} className="image-dialog" onClose={() => setOpen(false)}
      {...({ closedby: 'any' } as any)}
      onClick={(event) => {
        if (!dialog.current) return;
        if (event.target !== dialog.current) return;
        if (!('closedBy' in HTMLDialogElement.prototype)) {
          const rect = dialog.current.getBoundingClientRect();
          const isInside = (
            rect.top <= event.clientY &&
            event.clientY <= rect.top + rect.height &&
            rect.left <= event.clientX &&
            event.clientX <= rect.left + rect.width
          );
          if (!isInside) dialog.current.close();
        }
      }}>
      <div className="image-dialog-header">
        <h2 id={titleId}>{label}</h2>
        <button type="button" className="icon-button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}>
          <X size={19} aria-hidden="true" />
        </button>
      </div>
      {originalFailed ? <Feedback error="原图加载失败。关闭预览后可重试。" />
        : <img src={src} alt={label} onError={() => setOriginalFailed(true)} />}
    </dialog>}
  </>;
}

export function TaskBadge({ status }: { status: TaskStatus }) {
  const tone = status === 'published' ? 'green'
    : status === 'handed_off' || status === 'unknown' ? 'amber'
      : status === 'failed' ? 'red'
        : status === 'scheduled' || status === 'dispatching' ? 'violet' : 'gray';
  return <span className={`badge ${tone}`}>{taskLabel[status]}</span>;
}
