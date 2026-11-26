import { useCallback, useEffect, useRef, useState } from 'react';
import { pushToast } from './toast';

export type Role = 'owner' | 'editor' | 'reviewer' | 'operator' | 'viewer';
export type Workspace = { id: string; name: string; role: Role; trial?: boolean };
export type Session = { user: { id: string; name: string; email: string }; workspaces: Workspace[]; trialAvailable?: boolean };
export const platforms = ['xiaohongshu', 'bilibili'] as const;
export type Platform = (typeof platforms)[number];
export const platformLabel: Record<Platform, string> = { xiaohongshu: '小红书', bilibili: 'B 站专栏' };
export function publishPlatformLabel(platform: Platform, hasVideo: boolean) {
  return hasVideo && platform === 'bilibili' ? 'B 站视频' : platformLabel[platform];
}
const redundantPlatformPrefix = /^(?:小红书|B\s*站专栏|B\s*站视频|B\s*站)\s*[·•]\s*/u;
export function cleanAccountName(displayName?: string | null) {
  const raw = displayName?.trim();
  if (!raw) return '未指定账号';
  return raw.replace(redundantPlatformPrefix, '').trim() || raw;
}
export function formatPlatformAccount(platformText: string, displayName?: string | null) {
  return `${platformText} · ${cleanAccountName(displayName)}`;
}
export type AccountAccessMethod = 'manual_uid' | 'qr_login' | 'password' | 'cookie' | 'oauth' | 'sandbox';
export type AccountRiskStatus = 'normal' | 'warning' | 'risk';
export type MatrixGroupColor = 'blue' | 'rose' | 'emerald' | 'amber' | 'violet' | 'cyan' | 'slate';
export type MatrixGroup = {
  id: string; name: string; color: MatrixGroupColor; description: string; sortOrder: number;
  accountCount: number; availableCount: number; riskCount: number;
};
export type AccountRiskEvent = {
  id: string; accountId: string; level: AccountRiskStatus; kind: string; message: string;
  feishuStatus: 'sent' | 'failed' | 'skipped'; feishuError: string | null;
  resolvedAt: string | null; createdAt: string;
  account?: { id: string; displayName: string; alias: string | null; platform: Platform };
  actor?: { id: string; name: string } | null;
  resolvedBy?: { id: string; name: string } | null;
};
export type Account = {
  id: string; platform: Platform; channelKind: 'manual' | 'official' | 'sandbox';
  accessMethod?: AccountAccessMethod;
  displayName: string; alias?: string | null; operator?: string | null;
  tags?: string[]; pinned?: boolean;
  groupId?: string | null; group?: { id: string; name: string; color: string } | null;
  profileUrl?: string | null;
  loginIdentifier?: string | null; hasPassword?: boolean; hasCookie?: boolean; cookieUpdatedAt?: string | null;
  riskStatus?: AccountRiskStatus; riskReason?: string | null; riskDetectedAt?: string | null;
  identityVerified: boolean; identityCheckedAt: string | null; availableForHandoff: boolean; availableForOfficial: boolean;
};
export type Approval = { approvedAt: string; snapshotHash: string | null };
export type Rejection = { id: string; reviewer?: { name: string } | null; reason: string; createdAt: string };
export type Picture = { assetId: string; position: number; isCover: boolean };
export type VideoAsset = { id: string; filename: string; size: number };
export type VariantSummary = {
  id: string; platform: Platform; status: 'draft' | 'approved' | 'superseded'; version: number; returned?: boolean;
};
type VariantText = VariantSummary & { title: string; body: string; tags: string[]; platformFields?: Record<string, unknown> };
export type Variant = VariantText & {
  assets: Picture[]; snapshotVersion: number;
  approval: Approval | null;
  rejections?: Rejection[];
  videoAsset?: VideoAsset | null;
};
export type ManuscriptVariant = VariantText & Partial<Pick<Variant, 'assets' | 'snapshotVersion' | 'approval' | 'rejections' | 'videoAsset'>>;
export type ManuscriptSummary = {
  id: string; title: string; assetCount: number; updatedAt: string; variants: VariantSummary[];
  videoAssetId?: string | null;
};
export type Manuscript = {
  id: string; title: string; body: string; tags: string[]; archivedAt?: string | null;
  referenceUrl?: string | null;
  assets: { id: string; filename: string }[]; variants: ManuscriptVariant[];
  videoAsset?: VideoAsset | null;
};
export type TaskStatus = 'scheduled' | 'dispatching' | 'paused' | 'handed_off' | 'submitted'
  | 'under_review' | 'published' | 'failed' | 'unknown' | 'verified' | 'canceled';
export type WorkbenchSummary = { taskCounts: Partial<Record<TaskStatus, number>>; pendingReview: number | null; riskAccounts?: number };
export type Result = {
  state: TaskStatus; remoteUrl: string | null; remoteId: string | null; recordedById: string | null; recordedAt: string;
  platformPublishedAt: string | null;
  note: string | null; evidenceAssetId: string | null;
};
export type Task = {
  id: string; status: TaskStatus; scheduledAt: string; handedOffAt: string | null; claimedAt: string | null; lastError: string | null;
  executionChannel: string | null; isSandbox: boolean | null;
  account: Pick<Account, 'id' | 'platform' | 'displayName' | 'operator' | 'channelKind'>;
  variant: Pick<Variant, 'id' | 'title' | 'platform' | 'version'> & { videoAssetId?: string | null };
  result: Result | null;
};
export type TaskDetail = Task & {
  notificationDeliveries?: {
    id: string; kind: 'handoff_ready' | 'overdue_reminder'; status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
    attempts: number; scheduledAt: string; sentAt: string | null; lastError: string | null;
  }[];
  events: { id: string; kind: string; toStatus: TaskStatus | null; actorId: string | null;
    createdAt: string; reason: string | null;
    details?: {
      outcome?: string; verification?: string; previousScheduledAt?: string; scheduledAt?: string;
      remoteId?: string | null;
      previous?: { evidenceAssetId?: string | null; remoteUrl?: string | null };
    } }[];
};
export type Handoff = Pick<Variant, 'title' | 'body' | 'tags' | 'version'> & {
  assets: (Picture & { url: string })[];
  profileUrl?: string | null;
  video?: (VideoAsset & { url: string }) | null;
};

export const roleLabel: Record<Role, string> = {
  owner: '负责人', editor: '编辑', reviewer: '审核员', operator: '运营', viewer: '只读成员',
};
export const taskLabel: Record<TaskStatus, string> = {
  scheduled: '待执行', dispatching: '处理中', paused: '已暂停', handed_off: '待回填', submitted: '已受理',
  under_review: '平台审核中', published: '已发布', failed: '失败', unknown: '待核实', verified: '已核实', canceled: '已取消',
};
export const canEdit = (role: Role) => role === 'owner' || role === 'editor';
export const canReview = (role: Role) => canEdit(role) || role === 'reviewer';
export const canRecord = (role: Role) => canEdit(role) || role === 'operator';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function api<T>(path: string, options: {
  method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; keepalive?: boolean;
} = {}): Promise<T> {
  const form = options.body instanceof FormData;
  const blob = options.body instanceof Blob ? options.body : undefined;
  let response: Response;
  try {
    const defaultHeaders: Record<string, string> = {};
    if (blob) {
      defaultHeaders['content-type'] = blob.type || 'video/mp4';
      defaultHeaders['x-video-size'] = String(blob.size);
    } else if (options.body !== undefined && !form) {
      defaultHeaders['content-type'] = 'application/json';
    }
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers: options.headers ? { ...defaultHeaders, ...options.headers } : (Object.keys(defaultHeaders).length ? defaultHeaders : undefined),
      body: blob ?? (form ? options.body as FormData : JSON.stringify(options.body)),
      signal: options.signal,
      keepalive: options.keepalive,
      cache: 'no-store',
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(0, '无法连接服务，请确认 API 已启动后重试。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('matrixark-session-expired'));
    const issue = Array.isArray(data?.issues) ? data.issues[0]?.message : undefined;
    const message = issue || (typeof data?.message === 'string' ? data.message : null);
    const method = (options.method ?? 'GET').toUpperCase();
    if (response.status === 404 && typeof message === 'string' && message.toUpperCase().startsWith(`CANNOT ${method} /`)) {
      throw new ApiError(404, '当前 API 未提供此功能。请启动与工作台同版本的 API，再重试。');
    }
    throw new ApiError(response.status, response.status >= 500
      ? 'API 暂时不可用，请稍后重试。' : message ?? (response.status === 404 ? '当前 API 未提供此功能或服务未启动。' : '请求未能完成'));
  }
  if (data === null) throw new ApiError(response.status, 'API 返回了无法读取的数据');
  return data as T;
}

export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body });
export const fileBody = (file: File) => {
  const body = new FormData();
  body.set('file', file);
  return body;
};
export const scopeFor = (id: string) => `/workspaces/${encodeURIComponent(id)}`;
export const imageUrl = (scope: string, id: string) => `/api${scope}/assets/${encodeURIComponent(id)}`;

export function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value));
}

export function useResource<T>(path: string | null, pollMs = 0) {
  const [record, setRecord] = useState<{ path: string; data?: T; error?: string }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let inProgress = false;
    async function load() {
      if (inProgress) return;
      inProgress = true;
      try {
        const data = await api<T>(path!, { signal: controller.signal });
        if (!controller.signal.aborted) setRecord({ path: path!, data });
      } catch (error) {
        if (!controller.signal.aborted) {
          setRecord((current) => ({ path: path!, data: current?.path === path ? current.data : undefined, error: messageOf(error) }));
        }
      } finally {
        inProgress = false;
      }
    }
    void load();
    const timer = pollMs ? setInterval(load, pollMs) : undefined;
    return () => { controller.abort(); clearInterval(timer); };
  }, [path, pollMs, revision]);
  const current = record?.path === path ? record : undefined;
  return { data: current?.data, error: current?.error, loading: Boolean(path && !current), refresh };
}

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '操作未能完成';
}

export function useAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function reset() { setError(''); setNotice(''); }
  async function run(work: () => Promise<void>, success = '') {
    if (running.current) return;
    running.current = true;
    reset();
    setBusy(true);
    try { await work(); if (success) { setNotice(success); pushToast(success, 'success'); } }
    catch (failure) { setError(messageOf(failure)); }
    finally { running.current = false; setBusy(false); }
  }
  return { busy, error, notice, reset, run };
}
