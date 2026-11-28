import { api, formatTime, post, useAction, useResource } from './api';
import { Feedback } from './ui';

type PendingGrant = {
  id: string; accountId: string | null; openid: string; name: string; scopes: string[];
  expiresAt: string; confirmBefore: string; existingAccountId: string | null; requiresSeparate: boolean; archived: boolean;
};

export function BilibiliOAuthPending({ accountsPath, onChanged }: { accountsPath: string; onChanged: () => void }) {
  const path = `${accountsPath}/bilibili/pending`;
  const pending = useResource<PendingGrant[]>(path, 5000);
  const action = useAction();
  if (!pending.error && !pending.data?.length) return null;
  function act(work: () => Promise<unknown>) {
    void action.run(async () => { try { await work(); onChanged(); } finally { pending.refresh(); } });
  }
  return <section className="card form-stack" aria-label="待确认的B站官方授权">
    <h2>确认 B 站官方授权</h2>
    <p className="muted small">确认后才保存官方投稿身份。openid 是应用内身份，不能直接当作网页登录 UID。</p>
    {pending.error && <div role="alert"><p>{pending.error}</p>
      <button type="button" className="button compact" onClick={pending.refresh}>重新加载授权</button></div>}
    {pending.data?.map((grant) => <div className="card form-stack" key={grant.id}>
      <strong>{grant.name}</strong>
      <p className="muted small">openid：{grant.openid}</p>
      <p className="small">已授权权限：{grant.scopes.join('、')}</p>
      <p className="muted small">Token 有效至 {formatTime(grant.expiresAt)} · 请在 {formatTime(grant.confirmBefore)} 前确认</p>
      {grant.requiresSeparate && <p role="status">本次官方身份与所选账号的关系尚未核实。可以单独保存官方身份，原账号及历史任务会保留。</p>}
      {grant.archived && <p role="status">此官方身份已有归档账号，请先恢复原账号，再确认更新授权。</p>}
      <div className="actions">
        <button type="button" className="button primary compact" disabled={action.busy || grant.archived || Boolean(pending.error)}
          onClick={() => act(() => post(`${path}/${grant.id}/confirm`, { saveSeparately: grant.requiresSeparate }))}>
          {action.busy ? '处理中…' : grant.requiresSeparate ? '单独保存官方身份' : grant.existingAccountId ? '更新原官方授权' : '确认保存官方身份'}
        </button>
        <button type="button" className="button compact" disabled={action.busy}
          onClick={() => act(() => api(`${path}/${grant.id}`, { method: 'DELETE' }))}>取消并丢弃授权</button>
      </div>
    </div>)}
    <Feedback error={action.error} />
  </section>;
}
