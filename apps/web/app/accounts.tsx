import { useState, type FormEvent } from 'react';
import { ScanLine } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { api, formatTime, platforms, post, useAction, useResource, type Account, type Platform } from './api';
import { Feedback, Loading, PageHeader, PlatformIcon } from './ui';

const accountPlatforms = {
  xiaohongshu: { name: '小红书', description: '扫码核验账号身份，可用于人工交接及飞书提醒。',
    guide: 'https://openaccount.xiaohongshu.com/console/apps' },
  bilibili: { name: 'B 站', description: '通过官方授权绑定账号，可用于专栏自动投稿。',
    guide: 'https://open.bilibili.com/doc/' },
} satisfies Record<Platform, { name: string; description: string; guide: string }>;

type PlatformSettings = Record<Platform, boolean> & { bilibiliSandbox: boolean };

function accountStatus(account: Account, archived: boolean) {
  if (archived) return { label: '已归档', tone: 'gray' };
  if (!account.identityVerified) return { label: '未核验', tone: 'gray' };
  if (account.channelKind === 'sandbox') return { label: '沙箱模拟', tone: 'violet' };
  if (account.availableForOfficial) return { label: '专栏自动投稿', tone: 'green' };
  if (account.availableForHandoff) return { label: '人工交接', tone: 'green' };
  return { label: '当前不可排期', tone: 'amber' };
}

function AppCredentials({ path, platform, configured, onSaved, primary = false }: {
  path: string; platform: Platform; configured: boolean; onSaved: () => void; primary?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const action = useAction();
  const { name, guide } = accountPlatforms[platform];
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void action.run(async () => {
      await api(path, { method: 'PATCH', body: { appId: fields.get('appId'), appSecret: fields.get('appSecret') } });
      form.reset();
      setEditing(false);
      onSaved();
    }, name + '应用凭据已保存。');
  }
  return <>
    <div className="actions">
      <button type="button" className={`button ${primary && !configured ? 'primary' : ''}`} aria-expanded={editing} aria-controls={platform + '-credentials'}
        onClick={() => { setEditing(!editing); action.reset(); }} disabled={action.busy}>
        {editing ? '收起凭据设置' : configured ? '更新应用凭据' : '填写应用凭据'}
      </button>
    </div>
    <Feedback notice={action.notice} />
    <div id={platform + '-credentials'} hidden={!editing}>
      {editing && <form className="form-stack account-form" onSubmit={save}>
        <p className="muted small">{platform === 'xiaohongshu' ? '在开放平台创建应用，申请 Web 扫码授权和用户基本信息权限。'
          : '在开放平台创建应用，申请用户信息、专栏投稿及专栏数据权限。'}
          {' '}<a href={guide} target="_blank" rel="noreferrer">打开{name}开放平台</a></p>
        {configured && <p className="muted small">更新时请填写原应用 ID 和新密钥。</p>}
        <label>应用 ID<input name="appId" required maxLength={256} autoComplete="off" spellCheck={false} disabled={action.busy} /></label>
        <label>应用密钥<input name="appSecret" type="password" required maxLength={512} autoComplete="new-password" disabled={action.busy} /></label>
        <Feedback error={action.error} />
        <button className="button primary" disabled={action.busy}>{action.busy ? '正在保存…' : '保存应用凭据'}</button>
      </form>}
    </div>
  </>;
}

function BilibiliConnection({ path, onConnected }: { path: string; onConnected: () => void }) {
  const [editing, setEditing] = useState(false);
  const action = useAction();
  function bind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void action.run(async () => {
      const expiresAt = new Date(String(fields.get('expiresAt')));
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new Error('请选择尚未到期的授权截止时间。');
      await post(path, { accessToken: fields.get('accessToken'), expiresAt: expiresAt.toISOString() });
      form.reset();
      setEditing(false);
      onConnected();
    }, 'B 站账号已核验，可排期自动投稿专栏。');
  }
  return <>
    <div className="actions">
      <button type="button" className="button primary" aria-expanded={editing} aria-controls="bilibili-grant"
        onClick={() => { setEditing(!editing); action.reset(); }} disabled={action.busy}>
        {editing ? '收起账号授权' : '连接 B 站账号'}
      </button>
    </div>
    <Feedback notice={action.notice} />
    <div id="bilibili-grant" hidden={!editing}>
      {editing && <form className="form-stack account-form" onSubmit={bind}>
        <p className="muted small">请使用该应用从 B 站开放平台取得账号授权，填写返回的访问令牌和有效期。</p>
        <label>账号访问令牌<input name="accessToken" required type="password" maxLength={4096}
          autoComplete="new-password" disabled={action.busy} /></label>
        <label>授权截止时间 <small>按当前设备时区填写</small>
          <input name="expiresAt" required type="datetime-local" disabled={action.busy} /></label>
        <Feedback error={action.error} />
        <button className="button primary" disabled={action.busy}>{action.busy ? '正在核验…' : '核验并绑定账号'}</button>
      </form>}
    </div>
  </>;
}

export function Accounts({ scope, canManage, canConfigure, resource, openPerformance }: {
  scope: string; canManage: boolean; canConfigure: boolean; resource: ReturnType<typeof useResource<Account[]>>;
  openPerformance: (accountId: string) => void;
}) {
  const [platformFilter, setPlatformFilter] = useState<Platform | 'all'>('all');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [authorization, setAuthorization] = useState<{ id: string; userCode: string; image: string }>();
  const [status, setStatus] = useState('');
  const action = useAction();
  const archiveAction = useAction();
  const accountsPath = scope + '/accounts';
  const path = accountsPath + '/xiaohongshu/authorize';
  const settingsPath = accountsPath + '/platform-settings';
  const settings = useResource<PlatformSettings>(canManage && !showArchived ? settingsPath : null);
  const archived = useResource<Account[]>(showArchived ? accountsPath + '?archived=true' : null);
  const visible = showArchived ? archived : resource;
  const accounts = visible.data ?? [];
  const query = search.trim().toLowerCase();
  function archive(account: Account) {
    if (!showArchived && !window.confirm(`归档「${account.displayName}」？账号会从排期列表移除，历史任务可以继续查看。`)) return;
    void archiveAction.run(async () => {
      const accountPath = accountsPath + '/' + account.id;
      await api(showArchived ? accountPath + '/restore' : accountPath, { method: showArchived ? 'PATCH' : 'DELETE' });
      resource.refresh();
      archived.refresh();
    }, showArchived ? '账号已恢复。' : '账号已归档。');
  }
  function connect() {
    setStatus('');
    void action.run(async () => {
      const ticket = await post<{ id: string; verificationUrl: string; userCode: string }>(path, {});
      const code = qrcode(0, 'M');
      code.addData(ticket.verificationUrl);
      code.make();
      setAuthorization({ id: ticket.id, userCode: ticket.userCode, image: code.createDataURL(4, 16) });
    });
  }
  function poll() {
    if (!authorization) return;
    void action.run(async () => {
      const result = await post<{ status: 'pending' | 'scanned' | 'connected' | 'expired' | 'denied' }>(`${path}/${authorization.id}/poll`, {});
      if (result.status === 'scanned' || result.status === 'pending') {
        setStatus(result.status === 'scanned' ? '已扫码，请在小红书 App 确认授权。' : '等待扫码授权。');
        return;
      }
      setAuthorization(undefined);
      setStatus('');
      if (result.status === 'expired') throw new Error('二维码已过期，请重新连接小红书账号。');
      if (result.status === 'denied') throw new Error('授权未通过。需要连接时可重新扫码。');
      resource.refresh();
      setSearch('');
      setStatus('小红书账号已核验，可用于人工交接。');
    });
  }
  return <>
    <PageHeader title="发布账号" description="按平台管理真实账号，查看每个账号的可用发布通道。">
      {canManage && <button type="button" className="button" aria-pressed={showArchived}
        onClick={() => { setShowArchived(!showArchived); archiveAction.reset(); }} disabled={archiveAction.busy}>
        {showArchived ? '返回在用账号' : '查看已归档'}
      </button>}
    </PageHeader>
    <div className="account-toolbar">
      <div className="filters" role="group" aria-label="按平台筛选">
        {(['all', ...platforms] as const).map((platform) => <button type="button" key={platform}
          className={platformFilter === platform ? 'active' : undefined} aria-pressed={platformFilter === platform}
          onClick={() => setPlatformFilter(platform)}>
          {platform === 'all' ? '全部平台' : accountPlatforms[platform].name}
        </button>)}
      </div>
      <input type="search" aria-label="搜索账号名称或负责人" placeholder="搜索账号名称或负责人" value={search}
        onChange={(event) => setSearch(event.target.value)} />
    </div>
    {showArchived && <p className="muted small" role="status">正在查看已归档账号</p>}
    <Feedback error={visible.error || archiveAction.error} notice={archiveAction.notice} />
    {settings.error && <div className="actions">
      <Feedback error={settings.error} />
      <button type="button" className="button" onClick={settings.refresh}>重新加载平台配置</button>
    </div>}
    <div className="account-groups">
      {platforms.filter((platform) => platformFilter === 'all' || platformFilter === platform).map((platform) => {
        const { name, description } = accountPlatforms[platform];
        const group = accounts.filter((account) => account.platform === platform);
        const matches = group.filter((account) => !query || [account.displayName, account.operator]
          .some((value) => value?.toLowerCase().includes(query)));
        const configured = settings.data?.[platform];
        return <section className="card" key={platform} aria-labelledby={'accounts-' + platform}>
          <div className="card-heading account-group-heading">
            <div>
              <h2 id={'accounts-' + platform}><PlatformIcon platform={platform} />{name}</h2>
              <p className="muted small">{description}</p>
            </div>
            {!visible.loading && !visible.error && <span className="muted small">{group.length} 个账号</span>}
          </div>
          {configured !== undefined && <div className="account-connection">
            <p className="muted small">{configured
              ? (group.length === 0 ? '暂无已连接账号，点击下方按钮完成授权连接即可。' : '应用凭据已配置')
              : canConfigure
                ? (group.length === 0 ? '暂无已连接账号，保存应用凭据后即可发起授权。' : '保存开放平台凭据后即可发起账号授权。')
                : (group.length === 0 ? '暂无已连接账号，请联系工作室负责人填写开放平台应用凭据。' : '请联系工作室负责人填写开放平台应用凭据。')}</p>
            {canConfigure && <AppCredentials path={settingsPath + '/' + platform} platform={platform} configured={configured}
              primary={group.length === 0} onSaved={settings.refresh} />}
            {platform === 'xiaohongshu' && configured && <>
              {authorization ? <section className="form-stack" aria-labelledby="xiaohongshu-auth-title">
                <h3 id="xiaohongshu-auth-title">用小红书 App 扫码授权</h3>
                <img src={authorization.image} width={192} height={192} alt={`小红书账号授权二维码，授权码 ${authorization.userCode}`} />
                <p className="muted" role="status">{status || '在手机上确认授权后，检查授权结果。'}</p>
                <div className="actions">
                  <button type="button" className="button primary" onClick={poll} disabled={action.busy}>检查授权结果</button>
                  <button type="button" className="button" disabled={action.busy} onClick={() => {
                    setAuthorization(undefined); setStatus(''); action.reset();
                  }}>关闭二维码</button>
                </div>
              </section> : <div className="actions">
                <button type="button" className="button primary" onClick={connect} disabled={action.busy}>
                  <ScanLine size={17} aria-hidden="true" />{action.busy ? '正在请求二维码…' : '扫码连接小红书'}
                </button>
              </div>}
              <Feedback error={action.error} notice={authorization ? undefined : status} />
            </>}
            {platform === 'bilibili' && (settings.data?.bilibiliSandbox
              ? <p className="muted small">当前为沙箱模式。请联系部署管理员启用真实通道。</p>
              : configured && <BilibiliConnection path={accountsPath + '/bilibili/bind'} onConnected={() => {
                resource.refresh(); setSearch('');
              }} />)}
          </div>}
          {visible.loading ? <Loading /> : matches.length > 0 ? <ul className="account-group-list">
            {matches.map((account) => {
              const badge = accountStatus(account, showArchived);
              return <li className="account-row account-management-row" key={account.id}>
                <div><strong>{account.displayName}</strong>
                  <small>{account.operator ? `负责人 ${account.operator} · ` : ''}{account.identityCheckedAt
                    ? `核验于 ${formatTime(account.identityCheckedAt)}` : '尚未完成平台核验'}</small>
                </div>
                <span className={`badge ${badge.tone}`}>{badge.label}</span>
                {account.channelKind !== 'sandbox' && <button type="button" className="button compact" onClick={() => openPerformance(account.id)}
                  aria-label={`查看成效 · ${account.displayName}`}>查看成效</button>}
                {canManage && <button type="button" className="button compact" onClick={() => archive(account)}
                  disabled={archiveAction.busy} aria-label={`${showArchived ? '恢复' : '归档'}${account.displayName}`}>
                  {showArchived ? '恢复' : '归档'}
                </button>}
              </li>;
            })}
          </ul> : !visible.error && (query || showArchived) && <p className="account-group-empty muted small">
            {query ? '没有匹配的账号。' : '暂时没有已归档账号。'}
          </p>}
        </section>;
      })}
    </div>
  </>;
}
