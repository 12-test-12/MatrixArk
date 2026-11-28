import { useEffect } from 'react';
import { ExternalLink, RefreshCw, Trash2, X } from 'lucide-react';
import { api, formatTime, post, useAction, useResource } from './api';
import { askConfirm } from './confirm-dialog';
import { Feedback, Loading } from './ui';

type BrowserSession = {
  id: string; accountId: string | null; expectedUid: string | null; verifiedUid: string | null;
  opened: boolean; status: 'unverified' | 'verified' | 'expired' | 'mismatch'; lastCheckedAt: string | null;
  error?: string;
};
type BrowserList = { enabled: boolean; sessions: BrowserSession[] };
const statusLabels: Record<BrowserSession['status'], string> = {
  unverified: '等待登录与核验', verified: '上次核验通过', expired: '尚未登录或登录已失效', mismatch: '登录账号不一致',
};

export function BilibiliBrowserPanel({ accountsPath, accountId, onChanged }: {
  accountsPath: string; accountId?: string; onChanged: () => void;
}) {
  const path = `${accountsPath}/bilibili/browser`;
  const resource = useResource<BrowserList>(path, 5000);
  const action = useAction();
  useEffect(() => { action.reset(); }, [accountsPath, accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sessions = resource.data?.sessions.filter((session) => !accountId || session.accountId === accountId) ?? [];
  const opened = resource.data?.sessions.some((session) => session.opened);

  function run(work: () => Promise<unknown>) {
    void action.run(async () => {
      try { await work(); onChanged(); } finally { resource.refresh(); }
    });
  }

  async function remove(session: BrowserSession) {
    if (!await askConfirm({ title: '删除本地浏览器会话？',
      description: '将删除这个账号在本机的浏览器登录环境。账号档案、OAuth 授权和历史任务会保留。',
      confirmLabel: '删除本地会话', tone: 'danger' })) return;
    run(() => api(`${path}/${session.id}`, { method: 'DELETE' }));
  }

  return <section className="account-drawer-card form-stack" aria-label="B站本地浏览器">
    <div className="account-drawer-section-head">
      <strong>独立浏览器会话</strong>
      <span className="badge gray">仅登录与会话管理</span>
    </div>
    <p className="muted small">浏览器在运行 MatrixArk 的电脑上打开。每个账号使用独立环境，一次打开一个；关闭后保留登录状态。</p>
    {resource.loading && <Loading />}
    {resource.error && <div role="alert" className="form-stack">
      <p>{resource.error}</p>
      <button type="button" className="button compact" onClick={resource.refresh}>重试加载会话</button>
    </div>}
    {resource.data && !resource.data.enabled && <p role="status" className="muted small">本地浏览器尚未启用，请在运行 MatrixArk 的电脑上开启本地模式。</p>}
    {resource.data?.enabled && <>
      {sessions.length === 0 && <p className="muted small">{accountId ? '此账号尚未建立本机浏览器会话。' : '尚无本机浏览器会话。打开浏览器后，请自行扫码并完成安全验证。'}</p>}
      {(!accountId || !sessions.length) && <button type="button" className="button compact primary"
        disabled={action.busy || opened || Boolean(resource.error)}
        onClick={() => run(() => post(`${path}/open`, accountId ? { accountId } : {}))}>
        <ExternalLink size={15} aria-hidden="true" />{action.busy ? '正在打开…' : accountId ? '为此账号打开浏览器' : '添加浏览器账号'}
      </button>}
      {opened && <p className="muted small" role="status">请在打开的浏览器中完成登录，然后点击「检查登录」。打开其他账号前，请先关闭当前浏览器。</p>}
      {sessions.map((session) => <div key={session.id} className="card form-stack">
        <div className="account-drawer-section-head">
          <strong>{session.expectedUid ? `UID ${session.expectedUid}` : '新会话：等待绑定账号'}</strong>
          <span className={`badge ${session.opened ? 'green' : 'gray'}`}>{session.opened ? '浏览器已打开' : '浏览器已关闭'}</span>
        </div>
        <p className="small" role="status">{session.error ?? statusLabels[session.status]}{session.lastCheckedAt ? ` · ${formatTime(session.lastCheckedAt)}` : ''}</p>
        <div className="actions">
          {!session.opened && <button type="button" className="button compact" disabled={action.busy || opened || Boolean(resource.error) || Boolean(session.error)}
            onClick={() => run(() => post(`${path}/open`, { sessionId: session.id }))}>
            <ExternalLink size={14} aria-hidden="true" />恢复浏览器
          </button>}
          {session.opened && <>
            <button type="button" className="button primary compact" disabled={action.busy || Boolean(resource.error)}
              onClick={() => run(() => post(`${path}/${session.id}/check`, {}))}>
              <RefreshCw size={14} aria-hidden="true" />{action.busy ? '处理中…' : '检查登录'}
            </button>
            <button type="button" className="button compact" disabled={action.busy}
              onClick={() => run(() => post(`${path}/${session.id}/close`, {}))}>
              <X size={14} aria-hidden="true" />关闭浏览器
            </button>
          </>}
          <button type="button" className="button compact" disabled={action.busy || opened || Boolean(resource.error)} onClick={() => void remove(session)}>
            <Trash2 size={14} aria-hidden="true" />删除本地会话
          </button>
        </div>
      </div>)}
    </>}
    <Feedback error={action.error} notice={action.notice} />
  </section>;
}
