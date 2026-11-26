import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle, Check, Cookie, Copy, FolderPlus, KeyRound, Layers, Pencil, Plus,
  ScanLine, ShieldAlert, ShieldCheck, Star, Trash2,
} from 'lucide-react';
import qrcode from 'qrcode-generator';
import {
  api, formatTime, platforms, post, useAction, useResource,
  type Account, type AccountAccessMethod, type AccountRiskEvent, type AccountRiskStatus,
  type MatrixGroup, type MatrixGroupColor, type Platform,
} from './api';
import { copyText } from './clipboard';
import { pushToast } from './toast';
import { Feedback, Loading, PageHeader, PlatformIcon } from './ui';

const accountPlatforms = {
  xiaohongshu: { name: '小红书', description: '支持扫码核验、账号密码托管或 Cookie 接入，统一管理与人工交接。',
    guide: 'https://openaccount.xiaohongshu.com/console/apps' },
  bilibili: { name: 'B 站', description: '支持免开放平台网页扫码、Cookie 导入、账号密码托管及官方 OAuth 专栏投稿。',
    guide: 'https://open.bilibili.com/doc/' },
} satisfies Record<Platform, { name: string; description: string; guide: string }>;

const groupColors: { value: MatrixGroupColor; label: string }[] = [
  { value: 'blue', label: '海蓝' },
  { value: 'emerald', label: '翠绿' },
  { value: 'violet', label: '靛紫' },
  { value: 'amber', label: '琥珀' },
  { value: 'rose', label: '玫红' },
  { value: 'cyan', label: '青色' },
  { value: 'slate', label: '石板' },
];

const accessMethodLabels: Record<AccountAccessMethod, string> = {
  manual_uid: 'UID 登记',
  qr_login: '扫码接入',
  password: '账号密码',
  cookie: 'Cookie 接入',
  oauth: '官方 OAuth',
  sandbox: '沙箱演示',
};

type PlatformSettings = Record<Platform, boolean> & { bilibiliSandbox: boolean; bilibiliOAuthOrigin: string | null };
type ViewMode = 'platform' | 'group';
type RiskFilter = 'all' | 'normal' | 'warning' | 'risk';
type OnboardingTab = 'qr' | 'password' | 'cookie';

function makeQrDataUrl(text: string) {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  return code.createDataURL(4, 16);
}

function accountStatus(account: Account, archived: boolean) {
  if (archived) return { label: '已归档', tone: 'gray' };
  if (account.channelKind === 'sandbox') return { label: '沙箱模拟', tone: 'violet' };
  if (account.platform === 'bilibili' && account.channelKind === 'manual' && !account.availableForHandoff) {
    return { label: '待官方授权', tone: 'amber' };
  }
  if (account.availableForOfficial) return { label: '专栏自动投稿', tone: 'green' };
  if (account.availableForHandoff) return { label: '可用 · 人工交接', tone: 'green' };
  if (!account.identityVerified) return { label: '未核验', tone: 'gray' };
  return { label: '当前不可排期', tone: 'amber' };
}

function riskBadge(status?: AccountRiskStatus) {
  if (status === 'risk') return { label: '风险异常', tone: 'red' };
  if (status === 'warning') return { label: '预警提醒', tone: 'amber' };
  return { label: '健康正常', tone: 'green' };
}

function AppCredentials({ path, platform, configured, onSaved }: {
  path: string; platform: Platform; configured: boolean; onSaved: () => void;
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
      <button type="button" className="button compact" aria-expanded={editing} aria-controls={platform + '-credentials'}
        onClick={() => { setEditing(!editing); action.reset(); }} disabled={action.busy}>
        {editing ? '收起凭据设置' : configured ? '更新开放平台凭据' : '配置开放平台凭据'}
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

function BilibiliConnection({ path, hasAccounts, onConnected }: { path: string; hasAccounts: boolean; onConnected: () => void }) {
  const [editing, setEditing] = useState(false);
  const action = useAction();
  const oauth = useAction();
  function connect() {
    void oauth.run(async () => {
      const { authorizationUrl } = await post<{ authorizationUrl: string }>(path + '/authorize', {});
      window.location.assign(authorizationUrl);
    });
  }
  function bind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void action.run(async () => {
      const expiresAt = new Date(String(fields.get('expiresAt')));
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new Error('请选择尚未到期的授权截止时间。');
      await post(path + '/bind', { accessToken: fields.get('accessToken'), expiresAt: expiresAt.toISOString() });
      form.reset();
      setEditing(false);
      onConnected();
    }, 'B 站账号已核验，可排期自动投稿专栏。');
  }
  return <>
    <div className="actions">
      <button type="button" className="button compact primary" onClick={connect} disabled={oauth.busy || action.busy}>
        {oauth.busy ? '正在打开授权页…' : hasAccounts ? '开放平台 OAuth 授权' : '连接 B 站官方专栏'}
      </button>
      <button type="button" className="button compact" aria-expanded={editing} aria-controls="bilibili-grant"
        onClick={() => { setEditing(!editing); action.reset(); }} disabled={action.busy || oauth.busy}>
        {editing ? '收起令牌绑定' : '使用已有 OAuth 令牌'}
      </button>
    </div>
    <Feedback error={oauth.error} />
    <Feedback notice={action.notice} />
    <div id="bilibili-grant" hidden={!editing}>
      {editing && <form className="form-stack account-form" onSubmit={bind}>
        <p className="muted small">使用同一个开放平台应用，填写目标账号授权返回的访问令牌和有效期。</p>
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

function OnboardingPanel({
  accountsPath, settingsPath, settings, canConfigure, groups, hasOfficialBili, onDone,
}: {
  accountsPath: string; settingsPath: string; settings?: PlatformSettings; canConfigure: boolean;
  groups: MatrixGroup[]; hasOfficialBili: boolean; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<OnboardingTab>('qr');
  const [platform, setPlatform] = useState<Platform>('bilibili');
  const [groupId, setGroupId] = useState('');
  const [biliQr, setBiliQr] = useState<{ id: string; image: string }>();
  const [biliQrStatus, setBiliQrStatus] = useState('');
  const [xhsQr, setXhsQr] = useState<{ id: string; userCode: string; image: string }>();
  const [xhsQrStatus, setXhsQrStatus] = useState('');

  const qrAction = useAction();
  const pwdAction = useAction();
  const cookieAction = useAction();

  useEffect(() => {
    if (!biliQr) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await post<{ status: 'pending' | 'scanned' | 'expired' | 'connected' }>(
          `${accountsPath}/bilibili/qr/${biliQr.id}/poll`, {},
        );
        if (res.status === 'scanned') setBiliQrStatus('手机已扫码，请在 B 站 App 点击确认登录。');
        else if (res.status === 'pending') setBiliQrStatus('等待使用手机 B 站 App 扫码…');
        else if (res.status === 'expired') {
          setBiliQr(undefined);
          setBiliQrStatus('二维码已过期，请重新生成。');
        } else if (res.status === 'connected') {
          setBiliQr(undefined);
          setBiliQrStatus('');
          pushToast('B 站账号扫码接入成功。', 'success');
          onDone();
        }
      } catch {}
    }, 2000);
    return () => window.clearInterval(timer);
  }, [biliQr, accountsPath, onDone]);

  function startBiliQr() {
    setBiliQrStatus('');
    void qrAction.run(async () => {
      const ticket = await post<{ id: string; verificationUrl: string }>(
        `${accountsPath}/bilibili/qr`,
        { groupId: groupId || null },
      );
      setBiliQr({ id: ticket.id, image: makeQrDataUrl(ticket.verificationUrl) });
      setBiliQrStatus('请打开手机 B 站 App 扫描二维码。');
    });
  }

  function pollBiliOnce() {
    if (!biliQr) return;
    void qrAction.run(async () => {
      const res = await post<{ status: 'pending' | 'scanned' | 'expired' | 'connected' }>(
        `${accountsPath}/bilibili/qr/${biliQr.id}/poll`, {},
      );
      if (res.status === 'pending') setBiliQrStatus('等待使用手机 B 站 App 扫码…');
      else if (res.status === 'scanned') setBiliQrStatus('手机已扫码，请在 B 站 App 点击确认登录。');
      else if (res.status === 'expired') {
        setBiliQr(undefined);
        throw new Error('二维码已过期，请重新获取。');
      } else {
        setBiliQr(undefined);
        setBiliQrStatus('');
        pushToast('B 站账号扫码接入成功。', 'success');
        onDone();
      }
    });
  }

  function startXhsQr() {
    setXhsQrStatus('');
    void qrAction.run(async () => {
      const ticket = await post<{ id: string; verificationUrl: string; userCode: string }>(
        `${accountsPath}/xiaohongshu/authorize`, {},
      );
      setXhsQr({ id: ticket.id, userCode: ticket.userCode, image: makeQrDataUrl(ticket.verificationUrl) });
      setXhsQrStatus('请用小红书 App 扫码确认。');
    });
  }

  function pollXhs() {
    if (!xhsQr) return;
    void qrAction.run(async () => {
      const res = await post<{ status: 'pending' | 'scanned' | 'connected' | 'expired' | 'denied' }>(
        `${accountsPath}/xiaohongshu/authorize/${xhsQr.id}/poll`, {},
      );
      if (res.status === 'scanned' || res.status === 'pending') {
        setXhsQrStatus(res.status === 'scanned' ? '已扫码，请在小红书 App 确认授权。' : '等待扫码授权。');
        return;
      }
      setXhsQr(undefined);
      setXhsQrStatus('');
      if (res.status === 'expired') throw new Error('二维码已过期，请重新发起。');
      if (res.status === 'denied') throw new Error('授权未通过。');
      pushToast('小红书账号已核验接入。', 'success');
      onDone();
    });
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const rawTags = String(data.get('tags') ?? '');
    const tags = rawTags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
    void pwdAction.run(async () => {
      await post(`${accountsPath}/password`, {
        platform,
        displayName: String(data.get('displayName') ?? ''),
        loginIdentifier: String(data.get('loginIdentifier') ?? ''),
        password: String(data.get('password') ?? ''),
        profile: String(data.get('profile') ?? '').trim() || undefined,
        operator: String(data.get('operator') ?? '').trim() || undefined,
        alias: String(data.get('alias') ?? '').trim() || undefined,
        groupId: groupId || null,
        tags,
      });
      form.reset();
      pushToast('账号密码凭据已加密保存并加入发布列表。', 'success');
      onDone();
    }, '账号已通过账号密码方式安全登记。');
  }

  function submitCookie(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const rawTags = String(data.get('tags') ?? '');
    const tags = rawTags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
    void cookieAction.run(async () => {
      await post(`${accountsPath}/cookie`, {
        platform,
        cookie: String(data.get('cookie') ?? ''),
        displayName: String(data.get('displayName') ?? '').trim() || undefined,
        operator: String(data.get('operator') ?? '').trim() || undefined,
        alias: String(data.get('alias') ?? '').trim() || undefined,
        groupId: groupId || null,
        tags,
      });
      form.reset();
      pushToast('Cookie 校验通过并已加密导入。', 'success');
      onDone();
    }, 'Cookie 已核验并加密保存，账号可用于排期与定期体检。');
  }

  const biliConfigured = Boolean(settings?.bilibili);
  const xhsConfigured = Boolean(settings?.xiaohongshu);
  const biliOAuthOrigin = settings?.bilibiliOAuthOrigin ?? (typeof window !== 'undefined' ? window.location.origin : '');

  return <section className="card account-onboarding-card">
    <div className="card-heading">
      <div>
        <h2>添加发布账号（扫码 / 账号密码 / Cookie）</h2>
        <p className="muted small">开放平台未通过前，可直接用网页扫码、Cookie 导入或账号密码托管登记多个矩阵账号。</p>
      </div>
      <button type="button" className={`button ${open ? '' : 'primary'}`} aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <Plus size={16} aria-hidden="true" />{open ? '收起添加面板' : '添加账号'}
      </button>
    </div>
    {open && <div className="onboarding-body">
      <div className="onboarding-controls">
        <div className="filters" role="tablist" aria-label="接入方式">
          <button type="button" role="tab" aria-selected={tab === 'qr'} className={tab === 'qr' ? 'active' : undefined}
            onClick={() => setTab('qr')}>
            <ScanLine size={15} aria-hidden="true" /> 1. 扫码接入
          </button>
          <button type="button" role="tab" aria-selected={tab === 'password'} className={tab === 'password' ? 'active' : undefined}
            onClick={() => setTab('password')}>
            <KeyRound size={15} aria-hidden="true" /> 2. 账号密码
          </button>
          <button type="button" role="tab" aria-selected={tab === 'cookie'} className={tab === 'cookie' ? 'active' : undefined}
            onClick={() => setTab('cookie')}>
            <Cookie size={15} aria-hidden="true" /> 3. Cookie 导入
          </button>
        </div>
        <div className="onboarding-target-row">
          <label>目标平台
            <select value={platform} onChange={(e) => { setPlatform(e.target.value as Platform); setBiliQr(undefined); setXhsQr(undefined); }}>
              <option value="bilibili">B 站</option>
              <option value="xiaohongshu">小红书</option>
            </select>
          </label>
          <label>归属单一矩阵组 <small>选填</small>
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">暂不分组（未分组）</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      {tab === 'qr' && <div className="onboarding-panel">
        {platform === 'bilibili' ? <div className="form-stack">
          <p className="muted small">无需开放平台审批：直接生成 B 站官方网页登录二维码，手机扫码后自动拉取 UID、昵称并加密保存会话 Cookie。</p>
          {biliQr ? <div className="qr-box">
            <img src={biliQr.image} width={188} height={188} alt="B 站网页登录二维码" />
            <div className="form-stack">
              <p role="status">{biliQrStatus}</p>
              <div className="actions">
                <button type="button" className="button primary compact" onClick={pollBiliOnce} disabled={qrAction.busy}>检查扫码结果</button>
                <button type="button" className="button compact" onClick={() => { setBiliQr(undefined); setBiliQrStatus(''); }}>关闭二维码</button>
              </div>
            </div>
          </div> : <div className="actions">
            <button type="button" className="button primary" onClick={startBiliQr} disabled={qrAction.busy}>
              <ScanLine size={16} aria-hidden="true" />{qrAction.busy ? '正在生成二维码…' : '生成 B 站网页登录二维码'}
            </button>
          </div>}
          <Feedback error={qrAction.error} notice={biliQr ? undefined : biliQrStatus} />
          <details className="source">
            <summary>开放平台专栏自动投稿与授权设置</summary>
            <div className="form-stack">
              {canConfigure && !settings?.bilibiliSandbox && <label>B 站授权回调地址
                <input readOnly value={biliOAuthOrigin + '/api/channels/bilibili/oauth/callback'}
                  onFocus={(e) => e.currentTarget.select()} />
              </label>}
              {canConfigure && <AppCredentials path={`${settingsPath}/bilibili`} platform="bilibili" configured={biliConfigured} onSaved={onDone} />}
              {settings?.bilibiliSandbox ? <p className="muted small">当前为沙箱模式。</p>
                : biliConfigured && <BilibiliConnection path={`${accountsPath}/bilibili`} hasAccounts={hasOfficialBili} onConnected={onDone} />}
            </div>
          </details>
        </div> : <div className="form-stack">
          <p className="muted small">小红书官方扫码需要开放平台应用开通 Web 扫码与 basic_info 权限；若暂未获批，可直接切换到「账号密码」或「Cookie 导入」接入账号。</p>
          {xhsConfigured ? <>
            {xhsQr ? <div className="qr-box">
              <img src={xhsQr.image} width={188} height={188} alt={`小红书扫码二维码，授权码 ${xhsQr.userCode}`} />
              <div className="form-stack">
                <p role="status">{xhsQrStatus}</p>
                <div className="actions">
                  <button type="button" className="button primary compact" onClick={pollXhs} disabled={qrAction.busy}>检查授权结果</button>
                  <button type="button" className="button compact" onClick={() => { setXhsQr(undefined); setXhsQrStatus(''); }}>关闭二维码</button>
                </div>
              </div>
            </div> : <div className="actions">
              <button type="button" className="button primary" onClick={startXhsQr} disabled={qrAction.busy}>
                <ScanLine size={16} aria-hidden="true" />{qrAction.busy ? '正在请求二维码…' : '扫码连接小红书'}
              </button>
            </div>}
          </> : <div className="actions">
            <button type="button" className="button" onClick={() => setTab('cookie')}>改用 Cookie 导入</button>
            <button type="button" className="button" onClick={() => setTab('password')}>改用账号密码登记</button>
          </div>}
          {canConfigure && <AppCredentials path={`${settingsPath}/xiaohongshu`} platform="xiaohongshu" configured={xhsConfigured} onSaved={onDone} />}
          <Feedback error={qrAction.error} notice={xhsQr ? undefined : xhsQrStatus} />
        </div>}
      </div>}

      {tab === 'password' && <form className="form-stack onboarding-panel" onSubmit={submitPassword}>
        <p className="muted small">密码与登录账号均由服务端 AES-256-GCM 加密托管（列表只显示脱敏标识），交接时由负责人/编辑按需查看，不自动绕过平台验证码。</p>
        <div className="account-form-fields">
          <label>账号显示名称<input name="displayName" required maxLength={60} placeholder="例如 测评主号" disabled={pwdAction.busy} /></label>
          <label>登录账号（手机号 / 邮箱 / 用户名）<input name="loginIdentifier" required maxLength={120} autoComplete="off" disabled={pwdAction.busy} /></label>
          <label>登录密码<input name="password" type="password" required maxLength={256} autoComplete="new-password" disabled={pwdAction.busy} /></label>
          {platform === 'bilibili' && <label>B 站 UID 或空间链接 <small>选填</small>
            <input name="profile" maxLength={500} placeholder="例如 123456" disabled={pwdAction.busy} />
          </label>}
          <label>运营负责人 <small>选填</small><input name="operator" maxLength={40} placeholder="例如 林舟" disabled={pwdAction.busy} /></label>
          <label>内部备注名 <small>选填</small><input name="alias" maxLength={60} placeholder="如 科技测评-大号" disabled={pwdAction.busy} /></label>
        </div>
        <label>标签 <small>逗号或空格分隔，最多 12 个</small><input name="tags" maxLength={160} placeholder="主号 科技测评" disabled={pwdAction.busy} /></label>
        <Feedback error={pwdAction.error} notice={pwdAction.notice} />
        <div className="actions">
          <button type="submit" className="button primary" disabled={pwdAction.busy}>{pwdAction.busy ? '正在加密保存…' : '加密保存账号密码'}</button>
        </div>
      </form>}

      {tab === 'cookie' && <form className="form-stack onboarding-panel" onSubmit={submitCookie}>
        <p className="muted small">
          {platform === 'bilibili'
            ? '粘贴浏览器登录后包含 SESSDATA 的 Cookie（文本或 JSON 数组），服务端会自动调用 B 站接口核验有效性与昵称。'
            : '粘贴小红书网页版 / 创作平台包含 web_session 或 a1 的 Cookie（文本或 JSON 数组），服务端加密保存并纳入状态巡检。'}
        </p>
        <label>Cookie 内容<textarea name="cookie" rows={3} required maxLength={32768} spellCheck={false}
          placeholder="例如 SESSDATA=...; bili_jct=...; 或浏览器导出的 JSON Cookie 数组" disabled={cookieAction.busy} /></label>
        <div className="account-form-fields">
          <label>账号显示名称 {platform === 'bilibili' ? <small>选填，留空自动获取昵称</small> : <small>必填</small>}
            <input name="displayName" required={platform === 'xiaohongshu'} maxLength={60} placeholder="输入便于区分的账号名" disabled={cookieAction.busy} />
          </label>
          <label>运营负责人 <small>选填</small><input name="operator" maxLength={40} disabled={cookieAction.busy} /></label>
          <label>内部备注名 <small>选填</small><input name="alias" maxLength={60} disabled={cookieAction.busy} /></label>
          <label>标签 <small>选填</small><input name="tags" maxLength={160} placeholder="主号 图文" disabled={cookieAction.busy} /></label>
        </div>
        <Feedback error={cookieAction.error} notice={cookieAction.notice} />
        <div className="actions">
          <button type="submit" className="button primary" disabled={cookieAction.busy}>{cookieAction.busy ? '正在校验导入…' : '校验并导入 Cookie'}</button>
        </div>
      </form>}
    </div>}
  </section>;
}

function AccountRow({
  account, trial, showArchived, canManage, groups, accountsPath, selected, onToggleSelect,
  openPerformance, onChanged, onArchive, archiveBusy,
}: {
  account: Account; trial?: boolean; showArchived: boolean; canManage: boolean; groups: MatrixGroup[];
  accountsPath: string; selected: boolean; onToggleSelect: (id: string) => void;
  openPerformance: (id: string) => void; onChanged: () => void; onArchive: (account: Account) => void; archiveBusy: boolean;
}) {
  const [panel, setPanel] = useState<'meta' | 'risk' | 'creds' | null>(null);
  const [creds, setCreds] = useState<{ loginIdentifier: string | null; password: string | null; cookie: string | null }>();
  const action = useAction();
  const healthAction = useAction();

  const statusBadge = trial && !showArchived ? { label: '演示账号', tone: 'violet' } : accountStatus(account, showArchived);
  const rBadge = riskBadge(account.riskStatus);
  const methodLabel = account.accessMethod ? accessMethodLabels[account.accessMethod] : '手工接入';

  function togglePin() {
    void action.run(async () => {
      await api(`${accountsPath}/${account.id}`, { method: 'PATCH', body: { pinned: !account.pinned } });
      onChanged();
    });
  }

  function saveMeta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rawTags = String(data.get('tags') ?? '');
    const tags = rawTags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
    const nextGroupId = String(data.get('groupId') ?? '').trim() || null;
    void action.run(async () => {
      await api(`${accountsPath}/${account.id}`, {
        method: 'PATCH',
        body: {
          groupId: nextGroupId,
          alias: String(data.get('alias') ?? '').trim() || null,
          operator: String(data.get('operator') ?? '').trim(),
          tags,
        },
      });
      setPanel(null);
      pushToast('账号分组与备注已保存。', 'success');
      onChanged();
    });
  }

  function openCreds() {
    if (panel === 'creds') {
      setPanel(null);
      setCreds(undefined);
      return;
    }
    void action.run(async () => {
      const data = await api<{ loginIdentifier: string | null; password: string | null; cookie: string | null }>(
        `${accountsPath}/${account.id}/credentials`,
      );
      setCreds(data);
      setPanel('creds');
    });
  }

  function runHealthCheck() {
    void healthAction.run(async () => {
      const res = await post<{ status: AccountRiskStatus; reason: string; feishuStatus: string }>(
        `${accountsPath}/${account.id}/health-check`, {},
      );
      pushToast(
        res.status === 'normal'
          ? '体检正常：登录态与授权有效。'
          : `发现${res.status === 'risk' ? '风险' : '预警'}：${res.reason}${res.feishuStatus === 'sent' ? '（已发送飞书通知）' : ''}`,
        res.status === 'normal' ? 'success' : 'info',
        4500,
      );
      onChanged();
    });
  }

  function submitRisk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      const res = await post<{ feishuStatus: string }>(`${accountsPath}/${account.id}/risk`, {
        level: String(data.get('level') ?? 'risk'),
        kind: String(data.get('kind') ?? 'manual_flagged'),
        message: String(data.get('message') ?? ''),
        forceNotify: true,
      });
      setPanel(null);
      pushToast(
        res.feishuStatus === 'sent' ? '风险已记录，并已推送飞书机器人告警。' : '风险已记录（未触发飞书或当前环境未启用推送）。',
        'info',
      );
      onChanged();
    });
  }

  function resolveRisk() {
    void action.run(async () => {
      await post(`${accountsPath}/${account.id}/risk/resolve`, { note: '人工确认风险已处理', notify: true });
      setPanel(null);
      pushToast('已解除该账号的风险状态。', 'success');
      onChanged();
    });
  }

  return <li className={`account-row-shell${account.riskStatus === 'risk' ? ' has-risk' : account.riskStatus === 'warning' ? ' has-warning' : ''}`}>
    <div className="account-row account-management-row">
      {canManage && !showArchived && <label className="row-checkbox" aria-label={`勾选账号 ${account.displayName}`}>
        <input type="checkbox" checked={selected} onChange={() => onToggleSelect(account.id)} />
      </label>}
      {canManage && !showArchived && <button type="button" className={`icon-button pin-btn${account.pinned ? ' pinned' : ''}`}
        title={account.pinned ? '取消置顶' : '置顶账号'} aria-label={`${account.pinned ? '取消置顶' : '置顶'} ${account.displayName}`}
        onClick={togglePin} disabled={action.busy}>
        <Star size={15} fill={account.pinned ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>}
      <div className="account-main-info">
        <div className="account-title-line">
          <PlatformIcon platform={account.platform} />
          <strong>{account.alias ? `${account.alias}（${account.displayName}）` : account.displayName}</strong>
          <span className="badge gray">{methodLabel}</span>
          {account.group && <span className="group-pill">
            <span className={`group-dot color-${account.group.color}`} aria-hidden="true" />{account.group.name}
          </span>}
        </div>
        <small>
          {account.operator ? `负责人 ${account.operator} · ` : ''}
          {account.loginIdentifier ? `登录标识 ${account.loginIdentifier} · ` : ''}
          {account.identityCheckedAt ? `核验于 ${formatTime(account.identityCheckedAt)}` : '待核验或托管账号'}
          {(account.tags?.length ?? 0) > 0 && ` · 标签：${account.tags!.join(' / ')}`}
        </small>
        {account.riskStatus && account.riskStatus !== 'normal' && account.riskReason && (
          <p className="risk-reason-line"><AlertTriangle size={13} aria-hidden="true" />{account.riskReason}</p>
        )}
      </div>
      <div className="account-badges">
        <span className={`badge ${statusBadge.tone}`}>{statusBadge.label}</span>
        {!showArchived && <span className={`badge ${rBadge.tone}`}>{rBadge.label}</span>}
      </div>
      <div className="actions account-row-actions">
        {!showArchived && canManage && <button type="button" className="button compact"
          onClick={() => setPanel(panel === 'meta' ? null : 'meta')}>
          <Pencil size={13} aria-hidden="true" />分组/备注
        </button>}
        {!showArchived && !trial && canManage && (account.hasPassword || account.hasCookie) && (
          <button type="button" className="button compact" onClick={openCreds} disabled={action.busy}>
            <KeyRound size={13} aria-hidden="true" />{panel === 'creds' ? '隐藏凭据' : '查看凭据'}
          </button>
        )}
        {!showArchived && canManage && <button type="button" className="button compact" onClick={runHealthCheck} disabled={healthAction.busy}>
          <ShieldCheck size={13} aria-hidden="true" />{healthAction.busy ? '体检中…' : '体检'}
        </button>}
        {!showArchived && <button type="button" className="button compact"
          onClick={() => setPanel(panel === 'risk' ? null : 'risk')}>
          <ShieldAlert size={13} aria-hidden="true" />{account.riskStatus && account.riskStatus !== 'normal' ? '处理风险' : '上报风险'}
        </button>}
        {account.profileUrl && <a className="button compact" href={account.profileUrl} target="_blank" rel="noreferrer"
          aria-label={`查看 B 站主页 · ${account.displayName}`}>主页</a>}
        {account.channelKind !== 'sandbox' && <button type="button" className="button compact" onClick={() => openPerformance(account.id)}
          aria-label={`查看成效 · ${account.displayName}`}>成效</button>}
        {canManage && <button type="button" className="button compact" onClick={() => onArchive(account)}
          disabled={archiveBusy} aria-label={`${showArchived ? '恢复' : '归档'}${account.displayName}`}>
          {showArchived ? '恢复' : '归档'}
        </button>}
      </div>
    </div>

    {(action.error || healthAction.error) && <Feedback error={action.error || healthAction.error} />}

    {panel === 'meta' && <form className="account-inline-drawer form-stack" onSubmit={saveMeta}>
      <div className="account-form-fields">
        <label>所属单一矩阵组
          <select name="groupId" defaultValue={account.groupId ?? ''}>
            <option value="">未分组</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label>内部备注名<input name="alias" maxLength={60} defaultValue={account.alias ?? ''} placeholder="不修改平台原昵称" /></label>
        <label>运营负责人<input name="operator" maxLength={40} defaultValue={account.operator ?? ''} /></label>
        <label>标签（空格或逗号分隔）<input name="tags" maxLength={160} defaultValue={(account.tags ?? []).join(' ')} /></label>
      </div>
      <div className="actions">
        <button type="submit" className="button primary compact" disabled={action.busy}>保存归属与备注</button>
        <button type="button" className="button compact" onClick={() => setPanel(null)}>取消</button>
      </div>
    </form>}

    {panel === 'creds' && creds && <div className="account-inline-drawer form-stack">
      <p className="muted small">以下托管凭据仅限工作室负责人与编辑查看，用于人工交接登录。</p>
      {creds.loginIdentifier && <div className="cred-row">
        <span>登录账号：<code>{creds.loginIdentifier}</code></span>
        <button type="button" className="button compact" onClick={() => void copyText(creds.loginIdentifier!).then(() => pushToast('已复制登录账号', 'success'))}>
          <Copy size={13} aria-hidden="true" />复制账号
        </button>
      </div>}
      {creds.password && <div className="cred-row">
        <span>托管密码：<code>{creds.password}</code></span>
        <button type="button" className="button compact" onClick={() => void copyText(creds.password!).then(() => pushToast('已复制密码', 'success'))}>
          <Copy size={13} aria-hidden="true" />复制密码
        </button>
      </div>}
      {creds.cookie && <div className="cred-row">
        <span>已保存 Cookie（{creds.cookie.length} 字符）</span>
        <button type="button" className="button compact" onClick={() => void copyText(creds.cookie!).then(() => pushToast('已复制 Cookie', 'success'))}>
          <Copy size={13} aria-hidden="true" />复制 Cookie
        </button>
      </div>}
    </div>}

    {panel === 'risk' && <form className="account-inline-drawer form-stack" onSubmit={submitRisk}>
      <div className="account-form-fields">
        <label>风险级别
          <select name="level" defaultValue="risk">
            <option value="risk">风险异常（立即拦截关注）</option>
            <option value="warning">预警提醒</option>
          </select>
        </label>
        <label>异常类型
          <select name="kind" defaultValue="manual_flagged">
            <option value="manual_flagged">人工上报风控 / 异常</option>
            <option value="verification_required">触发平台安全验证 / 验证码</option>
            <option value="cookie_expired">登录态 / Cookie 失效</option>
            <option value="password_invalid">密码失效或需要换绑</option>
          </select>
        </label>
      </div>
      <label>情况说明（将同步推送给已配置的飞书群机器人）
        <input name="message" required maxLength={300} placeholder="例如 小红书发布时触发滑块/短信验证，需主号人员处理" />
      </label>
      <div className="actions">
        <button type="submit" className="button primary compact" disabled={action.busy}>上报风险并通知飞书</button>
        {account.riskStatus && account.riskStatus !== 'normal' && (
          <button type="button" className="button compact" onClick={resolveRisk} disabled={action.busy}>
            <Check size={13} aria-hidden="true" />确认已恢复正常（解除风险）
          </button>
        )}
        <button type="button" className="button compact" onClick={() => setPanel(null)}>取消</button>
      </div>
    </form>}
  </li>;
}

export function Accounts({ scope, canManage, canConfigure, trial, resource, openPerformance }: {
  scope: string; canManage: boolean; canConfigure: boolean; resource: ReturnType<typeof useResource<Account[]>>;
  trial?: boolean;
  openPerformance: (accountId: string) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('group');
  const [platformFilter, setPlatformFilter] = useState<Platform | 'all'>('all');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showRisksPanel, setShowRisksPanel] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState<MatrixGroup | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchGroupId, setBatchGroupId] = useState('');
  const [batchOperator, setBatchOperator] = useState('');

  const archiveAction = useAction();
  const demoAction = useAction();
  const groupAction = useAction();
  const batchAction = useAction();

  const accountsPath = scope + '/accounts';
  const groupsPath = accountsPath + '/groups';
  const risksPath = accountsPath + '/risks';
  const settingsPath = accountsPath + '/platform-settings';

  const groupsRes = useResource<MatrixGroup[]>(groupsPath);
  const risksRes = useResource<AccountRiskEvent[]>(showRisksPanel ? risksPath : null);
  const settings = useResource<PlatformSettings>(canManage && !showArchived && !trial ? settingsPath : null);
  const archived = useResource<Account[]>(showArchived ? accountsPath + '?archived=true' : null);
  const visible = showArchived ? archived : resource;
  const accounts = visible.data ?? [];
  const groups = groupsRes.data ?? [];

  function refreshAll() {
    resource.refresh();
    groupsRes.refresh();
    if (showRisksPanel) risksRes.refresh();
  }

  const normalCount = accounts.filter((a) => (a.riskStatus ?? 'normal') === 'normal').length;
  const warningCount = accounts.filter((a) => a.riskStatus === 'warning').length;
  const riskCount = accounts.filter((a) => a.riskStatus === 'risk').length;

  const query = search.trim().toLowerCase();
  const filteredAccounts = accounts.filter((account) => {
    if (platformFilter !== 'all' && account.platform !== platformFilter) return false;
    if (!showArchived && riskFilter !== 'all' && (account.riskStatus ?? 'normal') !== riskFilter) return false;
    if (!query) return true;
    return [account.displayName, account.alias, account.operator, account.group?.name, ...(account.tags ?? [])]
      .some((value) => value?.toLowerCase().includes(query));
  });

  function toggleSelect(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  function addDemo(platform: Platform) {
    const name = accountPlatforms[platform].name;
    void demoAction.run(async () => {
      await post(accountsPath + '/demo', { platform });
      setSearch('');
      refreshAll();
    }, `${name}演示账号已添加。`);
  }

  function archive(account: Account) {
    if (!showArchived && !window.confirm(`归档「${account.displayName}」？账号会从排期列表移除，历史任务可以继续查看。`)) return;
    void archiveAction.run(async () => {
      const accountPath = accountsPath + '/' + account.id;
      await api(showArchived ? accountPath + '/restore' : accountPath, { method: showArchived ? 'PATCH' : 'DELETE' });
      setSelectedIds((prev) => prev.filter((id) => id !== account.id));
      refreshAll();
      archived.refresh();
    }, showArchived ? '账号已恢复。' : '账号已归档。');
  }

  function saveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = {
      name: String(data.get('name') ?? ''),
      color: String(data.get('color') ?? 'blue'),
      description: String(data.get('description') ?? ''),
    };
    void groupAction.run(async () => {
      if (editingGroup) {
        await api(`${groupsPath}/${editingGroup.id}`, { method: 'PATCH', body });
        setEditingGroup(null);
      } else {
        await post(groupsPath, body);
        setCreatingGroup(false);
        form.reset();
      }
      refreshAll();
    }, editingGroup ? '矩阵组已更新。' : '矩阵组已创建。');
  }

  function deleteGroup(group: MatrixGroup) {
    if (!window.confirm(`删除矩阵组「${group.name}」？组内账号不会被删除，将转为「未分组」。`)) return;
    void groupAction.run(async () => {
      await api(`${groupsPath}/${group.id}`, { method: 'DELETE' });
      refreshAll();
    }, `矩阵组「${group.name}」已删除，组内账号已回到未分组。`);
  }

  function applyBatchGroup(targetGroupId: string | null) {
    if (!selectedIds.length) return;
    void batchAction.run(async () => {
      await post(`${accountsPath}/batch`, { accountIds: selectedIds, action: 'set_group', groupId: targetGroupId });
      setSelectedIds([]);
      refreshAll();
    }, targetGroupId ? '已将所选账号移入目标矩阵组（每个账号只保留在单一组内）。' : '已将所选账号移出分组。');
  }

  function applyBatchOperator() {
    if (!selectedIds.length) return;
    void batchAction.run(async () => {
      await post(`${accountsPath}/batch`, { accountIds: selectedIds, action: 'set_operator', operator: batchOperator });
      setSelectedIds([]);
      setBatchOperator('');
      refreshAll();
    }, '已批量更新运营负责人。');
  }

  return <>
    <PageHeader title="发布账号与矩阵组" description={trial
      ? '试用工作室支持按矩阵组整理演示账号，练习跨平台批量排期与风险记录。'
      : '支持扫码、账号密码与 Cookie 三种方式接入多平台账号；每个账号归属单一矩阵组，异常风险实时联动飞书告警。'}>
      <div className="actions">
        {!showArchived && <button type="button" className={`button${showRisksPanel ? ' active' : ''}`}
          onClick={() => setShowRisksPanel(!showRisksPanel)}>
          <ShieldAlert size={16} aria-hidden="true" />风险告警记录 {(warningCount + riskCount) > 0 && `(${warningCount + riskCount})`}
        </button>}
        {canManage && !showArchived && <button type="button" className="button"
          onClick={() => { setCreatingGroup(!creatingGroup); setEditingGroup(null); groupAction.reset(); }}>
          <FolderPlus size={16} aria-hidden="true" />{creatingGroup ? '收起建组' : '新建矩阵组'}
        </button>}
        {canManage && <button type="button" className="button" aria-pressed={showArchived}
          onClick={() => { setShowArchived(!showArchived); setSelectedIds([]); archiveAction.reset(); }} disabled={archiveAction.busy}>
          {showArchived ? '返回在用账号' : '查看已归档'}
        </button>}
      </div>
    </PageHeader>

    {!showArchived && <div className="risk-strip" role="group" aria-label="按账号健康状态筛选">
      <button type="button" className={`kpi-pill${riskFilter === 'all' ? ' active' : ''}`} onClick={() => setRiskFilter('all')}>
        <span>全部账号</span><strong>{accounts.length}</strong>
      </button>
      <button type="button" className={`kpi-pill${riskFilter === 'normal' ? ' active' : ''}`} onClick={() => setRiskFilter('normal')}>
        <span className="kpi-dot green" aria-hidden="true" /><span>健康正常</span><strong>{normalCount}</strong>
      </button>
      <button type="button" className={`kpi-pill${riskFilter === 'warning' ? ' active' : ''}`} onClick={() => setRiskFilter('warning')}>
        <span className="kpi-dot amber" aria-hidden="true" /><span>预警提醒</span><strong>{warningCount}</strong>
      </button>
      <button type="button" className={`kpi-pill${riskFilter === 'risk' ? ' active' : ''}`} onClick={() => setRiskFilter('risk')}>
        <span className="kpi-dot red" aria-hidden="true" /><span>风险异常</span><strong>{riskCount}</strong>
      </button>
    </div>}

    {showRisksPanel && !showArchived && <section className="card form-card form-stack">
      <div className="card-heading">
        <h2>最近账号风险与飞书推送流水</h2>
        <button type="button" className="button compact" onClick={risksRes.refresh}>刷新流水</button>
      </div>
      {risksRes.loading ? <Loading /> : risksRes.error ? <Feedback error={risksRes.error} /> : (risksRes.data?.length ?? 0) === 0
        ? <p className="muted small">当前工作室暂无风险记录。</p>
        : <ul className="risk-event-list">
          {risksRes.data!.map((ev) => <li key={ev.id} className="risk-event-item">
            <div>
              <strong>{ev.account ? `${ev.account.alias || ev.account.displayName}` : '账号'}</strong>
              <span className={`badge ${ev.level === 'risk' ? 'red' : ev.level === 'warning' ? 'amber' : 'green'}`}>
                {ev.level === 'risk' ? '风险告警' : ev.level === 'warning' ? '预警提醒' : '已解除'}
              </span>
              <span className="badge gray">
                {ev.feishuStatus === 'sent' ? '飞书已送达' : ev.feishuStatus === 'failed' ? '飞书失败' : '飞书未推送'}
              </span>
            </div>
            <p>{ev.message}{ev.feishuError ? ` · ${ev.feishuError}` : ''}</p>
            <small className="muted">{formatTime(ev.createdAt)}{ev.resolvedAt ? ` · 已于 ${formatTime(ev.resolvedAt)} 解除` : ''}</small>
          </li>)}
        </ul>}
    </section>}

    {(creatingGroup || editingGroup) && canManage && <section className="card form-card">
      <form className="form-stack" onSubmit={saveGroup}>
        <div className="card-heading">
          <h2>{editingGroup ? `编辑矩阵组 · ${editingGroup.name}` : '新建矩阵组（跨平台账号单一归属）'}</h2>
        </div>
        <div className="account-form-fields">
          <label>矩阵组名称<input name="name" required maxLength={40} defaultValue={editingGroup?.name ?? ''}
            placeholder="例如 科技测评主号组 / 矩阵 A 组" disabled={groupAction.busy} /></label>
          <label>分组色标
            <select name="color" defaultValue={editingGroup?.color ?? 'blue'} disabled={groupAction.busy}>
              {groupColors.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label>人设定位 / 说明 <small>选填</small>
            <input name="description" maxLength={160} defaultValue={editingGroup?.description ?? ''}
              placeholder="例如 主攻数码实测图文与视频的跨平台主号矩阵" disabled={groupAction.busy} />
          </label>
        </div>
        <Feedback error={groupAction.error} notice={groupAction.notice} />
        <div className="actions">
          <button type="submit" className="button primary" disabled={groupAction.busy}>
            {groupAction.busy ? '正在保存…' : editingGroup ? '保存修改' : '创建矩阵组'}
          </button>
          <button type="button" className="button" onClick={() => { setCreatingGroup(false); setEditingGroup(null); }}>取消</button>
        </div>
      </form>
    </section>}

    {!showArchived && canManage && !trial && (
      <OnboardingPanel
        accountsPath={accountsPath}
        settingsPath={settingsPath}
        settings={settings.data}
        canConfigure={canConfigure}
        groups={groups}
        hasOfficialBili={accounts.some((a) => a.platform === 'bilibili' && a.channelKind === 'official' && a.identityVerified)}
        onDone={() => { refreshAll(); settings.refresh(); }}
      />
    )}

    {!showArchived && trial && canManage && <section className="card form-card">
      <div className="card-heading">
        <h2>试用演示账号</h2>
        <div className="actions">
          <button type="button" className="button compact" onClick={() => addDemo('xiaohongshu')} disabled={demoAction.busy}>+ 小红书演示号</button>
          <button type="button" className="button compact" onClick={() => addDemo('bilibili')} disabled={demoAction.busy}>+ B 站沙箱演示号</button>
        </div>
      </div>
      <Feedback error={demoAction.error} notice={demoAction.notice} />
    </section>}

    <div className="account-toolbar">
      <div className="actions">
        <div className="filters" role="group" aria-label="账号分组视图">
          <button type="button" className={viewMode === 'group' ? 'active' : undefined} onClick={() => setViewMode('group')}>
            <Layers size={14} aria-hidden="true" /> 按矩阵组
          </button>
          <button type="button" className={viewMode === 'platform' ? 'active' : undefined} onClick={() => setViewMode('platform')}>
            按平台
          </button>
        </div>
        <div className="filters" role="group" aria-label="按平台筛选">
          {(['all', ...platforms] as const).map((platform) => <button type="button" key={platform}
            className={platformFilter === platform ? 'active' : undefined} aria-pressed={platformFilter === platform}
            onClick={() => setPlatformFilter(platform)}>
            {platform === 'all' ? '全部平台' : accountPlatforms[platform].name}
          </button>)}
        </div>
      </div>
      <input type="search" aria-label="搜索账号名称、备注、负责人或标签" placeholder="搜索账号名、备注、负责人或标签…"
        value={search} onChange={(event) => setSearch(event.target.value)} />
    </div>

    {selectedIds.length > 0 && canManage && !showArchived && <section className="card batch-bar" aria-label="批量矩阵操作">
      <strong>已勾选 {selectedIds.length} 个账号</strong>
      <div className="batch-bar-controls">
        <select aria-label="选择目标矩阵组" value={batchGroupId} onChange={(e) => setBatchGroupId(e.target.value)}>
          <option value="">选择目标矩阵组…</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button type="button" className="button primary compact" disabled={!batchGroupId || batchAction.busy}
          onClick={() => applyBatchGroup(batchGroupId)}>移入单一矩阵组</button>
        <button type="button" className="button compact" disabled={batchAction.busy}
          onClick={() => applyBatchGroup(null)}>移出分组</button>
        <input type="text" aria-label="批量设运营负责人" placeholder="批量设负责人" value={batchOperator}
          onChange={(e) => setBatchOperator(e.target.value)} maxLength={40} />
        <button type="button" className="button compact" disabled={batchAction.busy} onClick={applyBatchOperator}>应用负责人</button>
        <button type="button" className="text-button" onClick={() => setSelectedIds([])}>取消全选</button>
      </div>
      <Feedback error={batchAction.error} notice={batchAction.notice} />
    </section>}

    {showArchived && <p className="muted small" role="status">正在查看已归档账号</p>}
    <Feedback error={visible.error || archiveAction.error || groupAction.error} notice={archiveAction.notice || groupAction.notice} />

    {visible.loading ? <Loading /> : viewMode === 'group' && !showArchived ? (
      <div className="account-groups">
        {groups.map((group) => {
          const items = filteredAccounts.filter((a) => a.groupId === group.id);
          if (query && items.length === 0 && !group.name.toLowerCase().includes(query)) return null;
          return <section className="card" key={group.id}>
            <div className="card-heading account-group-heading">
              <div>
                <h2 className="matrix-group-title">
                  <span className={`group-dot color-${group.color}`} aria-hidden="true" />
                  {group.name}
                  <span className="count">{items.length}</span>
                </h2>
                {group.description && <p className="muted small">{group.description}</p>}
              </div>
              {canManage && <div className="actions">
                <button type="button" className="button compact" onClick={() => { setEditingGroup(group); setCreatingGroup(false); }}>编辑组</button>
                <button type="button" className="button compact" onClick={() => deleteGroup(group)} disabled={groupAction.busy}>
                  <Trash2 size={13} aria-hidden="true" />删组
                </button>
              </div>}
            </div>
            {items.length > 0 ? <ul className="account-group-list">
              {items.map((account) => <AccountRow key={account.id} account={account} trial={trial} showArchived={false}
                canManage={canManage} groups={groups} accountsPath={accountsPath}
                selected={selectedIds.includes(account.id)} onToggleSelect={toggleSelect}
                openPerformance={openPerformance} onChanged={refreshAll} onArchive={archive} archiveBusy={archiveAction.busy} />)}
            </ul> : <p className="account-group-empty muted small">该矩阵组下暂无匹配账号，可在上方列表勾选账号移入。</p>}
          </section>;
        })}
        {(() => {
          const ungrouped = filteredAccounts.filter((a) => !a.groupId);
          return <section className="card">
            <div className="card-heading account-group-heading">
              <div>
                <h2 className="matrix-group-title">
                  <span className="group-dot color-slate" aria-hidden="true" />
                  未分组账号
                  <span className="count">{ungrouped.length}</span>
                </h2>
                <p className="muted small">尚未归入矩阵组的账号；每个账号只能属于一个单一矩阵组。</p>
              </div>
            </div>
            {ungrouped.length > 0 ? <ul className="account-group-list">
              {ungrouped.map((account) => <AccountRow key={account.id} account={account} trial={trial} showArchived={false}
                canManage={canManage} groups={groups} accountsPath={accountsPath}
                selected={selectedIds.includes(account.id)} onToggleSelect={toggleSelect}
                openPerformance={openPerformance} onChanged={refreshAll} onArchive={archive} archiveBusy={archiveAction.busy} />)}
            </ul> : <p className="account-group-empty muted small">暂无未分组账号。</p>}
          </section>;
        })()}
      </div>
    ) : (
      <div className="account-groups">
        {platforms.filter((platform) => platformFilter === 'all' || platformFilter === platform).map((platform) => {
          const { name, description } = accountPlatforms[platform];
          const matches = filteredAccounts.filter((account) => account.platform === platform);
          return <section className="card" key={platform} aria-labelledby={'accounts-' + platform}>
            <div className="card-heading account-group-heading">
              <div>
                <h2 id={'accounts-' + platform}><PlatformIcon platform={platform} />{name}</h2>
                <p className="muted small">{trial ? (platform === 'xiaohongshu' ? '练习人工交接与回填' : '练习自动投稿与结果回读') : description}</p>
              </div>
              <span className="muted small">{matches.length} 个账号</span>
            </div>
            {matches.length > 0 ? <ul className="account-group-list">
              {matches.map((account) => <AccountRow key={account.id} account={account} trial={trial} showArchived={showArchived}
                canManage={canManage} groups={groups} accountsPath={accountsPath}
                selected={selectedIds.includes(account.id)} onToggleSelect={toggleSelect}
                openPerformance={openPerformance} onChanged={refreshAll} onArchive={archive} archiveBusy={archiveAction.busy} />)}
            </ul> : <p className="account-group-empty muted small">
              {query ? '没有匹配的账号。' : showArchived ? '暂时没有已归档账号。' : '该平台暂无账号，请点击上方「添加账号」。'}
            </p>}
          </section>;
        })}
      </div>
    )}
  </>;
}
