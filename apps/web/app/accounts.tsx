import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Activity, AlertTriangle, BarChart3, Check, CheckCircle2, ChevronDown, ChevronRight, Clock3,
  Cookie, ExternalLink, FileText, FolderPlus, KeyRound, Layers, MoreHorizontal, Pencil, Plus,
  RefreshCw, RotateCcw, ScanLine, Search, ShieldAlert, ShieldCheck, Star, Trash2, UsersRound, X,
} from 'lucide-react';
import qrcode from 'qrcode-generator';
import {
  api, formatTime, platformLabel, platforms, post, taskLabel, useAction, useResource,
  type Account, type AccountOperationsSummary, type AccountRiskEvent, type AccountRiskStatus,
  type MatrixGroup, type MatrixGroupColor, type Platform,
} from './api';
import {
  accessMethodLabels, authStatusLabels, buildAccountStatusView, statusCategoryLabels,
  type HealthCheckDiagnostics,
} from './account-status';
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

type PlatformSettings = Record<Platform, boolean> & { bilibiliSandbox: boolean; bilibiliOAuthOrigin: string | null };
type ViewMode = 'platform' | 'group';
type KpiFilter = 'all' | 'available' | 'pending' | 'risk' | 'unchecked';
type RiskFilter = 'all' | 'normal' | 'warning' | 'risk';
type OnboardingTab = 'qr' | 'password' | 'cookie';

function makeQrDataUrl(text: string) {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  return code.createDataURL(4, 16);
}

const riskKindLabels: Record<string, string> = {
  manual_flagged: '人工上报风控 / 异常',
  verification_required: '触发安全验证 / 验证码',
  cookie_expired: '登录态 / Cookie 失效',
  cookie_expiring: 'Cookie 即将到期',
  auth_expired: '开放平台授权已过期',
  auth_expiring: '开放平台授权即将到期',
  password_invalid: '密码失效或需要换绑',
  rate_limited: '平台接口限流冷却',
  ip_collision: '同平台出口 IP 冲突',
  read_session_expired: '只读采集会话失效',
  health_check_failed: '环境体检探测失败',
  resolved: '人工确认风险已解除',
};

type DrawerTab = 'overview' | 'auth' | 'capabilities' | 'environment' | 'risks';
type DrawerState = { accountId: string; tab: DrawerTab; editingMeta?: boolean; reportingRisk?: boolean };

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

const qrPlatforms = {
  bilibili: {
    hint: '无需开放平台审批：直接生成 B 站官方网页登录二维码，手机扫码后自动拉取 UID、昵称并加密保存会话 Cookie。',
    buttonLabel: '生成 B 站网页登录二维码',
    busyLabel: '正在生成二维码…',
    alt: 'B 站网页登录二维码',
    startStatus: '请打开手机 B 站 App 扫描二维码。',
    pendingStatus: '等待使用手机 B 站 App 扫码…',
    scannedStatus: '手机已扫码，请在 B 站 App 点击确认登录。',
    connectedToast: 'B 站账号扫码接入成功。',
    startPath: '/bilibili/qr',
    pollPath: (id: string) => `/bilibili/qr/${id}/poll`,
  },
  xiaohongshu: {
    hint: '使用小红书 App 扫码确认登录与账号核验（开放平台 Web 扫码应用可在下方折叠区配置；未配置开放平台时也可使用「账号密码」或「Cookie 导入」）。',
    buttonLabel: '生成小红书扫码二维码',
    busyLabel: '正在生成二维码…',
    alt: '小红书扫码登录二维码',
    startStatus: '请打开手机小红书 App 扫描二维码。',
    pendingStatus: '等待使用手机小红书 App 扫码…',
    scannedStatus: '手机已扫码，请在小红书 App 点击确认授权。',
    connectedToast: '小红书账号扫码接入成功。',
    startPath: '/xiaohongshu/authorize',
    pollPath: (id: string) => `/xiaohongshu/authorize/${id}/poll`,
  },
} satisfies Record<Platform, {
  hint: string; buttonLabel: string; busyLabel: string; alt: string;
  startStatus: string; pendingStatus: string; scannedStatus: string; connectedToast: string;
  startPath: string; pollPath: (id: string) => string;
}>;

function OnboardingPanel({
  open, defaultGroupId, onClose, accountsPath, settingsPath, settings, canConfigure, groups, hasOfficialBili, onDone,
}: {
  open: boolean; defaultGroupId: string; onClose: () => void;
  accountsPath: string; settingsPath: string; settings?: PlatformSettings; canConfigure: boolean;
  groups: MatrixGroup[]; hasOfficialBili: boolean; onDone: () => void;
}) {
  const [tab, setTab] = useState<OnboardingTab>('qr');
  const [platform, setPlatform] = useState<Platform>('bilibili');
  const [groupId, setGroupId] = useState(defaultGroupId);
  const [qrTicket, setQrTicket] = useState<{ platform: Platform; id: string; image: string; userCode?: string }>();
  const [qrStatus, setQrStatus] = useState('');
  const [xhsSettingsOpen, setXhsSettingsOpen] = useState(false);

  const qrAction = useAction();
  const pwdAction = useAction();
  const cookieAction = useAction();

  useEffect(() => {
    if (open) setGroupId(defaultGroupId);
  }, [open, defaultGroupId]);

  useEffect(() => {
    if (!open || tab !== 'qr' || !qrTicket || qrTicket.platform !== platform) return;
    const cfg = qrPlatforms[qrTicket.platform];
    const timer = window.setInterval(async () => {
      try {
        const res = await post<{ status: 'pending' | 'scanned' | 'expired' | 'denied' | 'connected' }>(
          `${accountsPath}${cfg.pollPath(qrTicket.id)}`, {},
        );
        if (res.status === 'scanned') setQrStatus(cfg.scannedStatus);
        else if (res.status === 'pending') setQrStatus(cfg.pendingStatus);
        else if (res.status === 'expired' || res.status === 'denied') {
          setQrTicket(undefined);
          setQrStatus(res.status === 'denied' ? '授权未通过，请重新生成二维码。' : '二维码已过期，请重新生成。');
        } else if (res.status === 'connected') {
          setQrTicket(undefined);
          setQrStatus('');
          pushToast(cfg.connectedToast, 'success');
          onDone();
        }
      } catch {
        // 票据被服务端回收后轮询会 404，必须停掉轮询并提示重新生成，否则会一直空转。
        setQrTicket(undefined);
        setQrStatus('二维码已失效，请重新生成。');
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [qrTicket, accountsPath, onDone, open, tab, platform]);

  function startQr() {
    setQrStatus('');
    const target = platform;
    const cfg = qrPlatforms[target];
    void qrAction.run(async () => {
      try {
        const ticket = await post<{ id: string; verificationUrl: string; userCode?: string }>(
          `${accountsPath}${cfg.startPath}`,
          { groupId: groupId || null },
        );
        setQrTicket({ platform: target, id: ticket.id, userCode: ticket.userCode, image: makeQrDataUrl(ticket.verificationUrl) });
        setQrStatus(cfg.startStatus);
      } catch (failure) {
        if (target === 'xiaohongshu') setXhsSettingsOpen(true);
        throw failure;
      }
    });
  }

  function pollQrOnce() {
    if (!qrTicket) return;
    const cfg = qrPlatforms[qrTicket.platform];
    void qrAction.run(async () => {
      const res = await post<{ status: 'pending' | 'scanned' | 'expired' | 'denied' | 'connected' }>(
        `${accountsPath}${cfg.pollPath(qrTicket.id)}`, {},
      );
      if (res.status === 'pending') setQrStatus(cfg.pendingStatus);
      else if (res.status === 'scanned') setQrStatus(cfg.scannedStatus);
      else if (res.status === 'expired' || res.status === 'denied') {
        setQrTicket(undefined);
        throw new Error(res.status === 'denied' ? '授权未通过。' : '二维码已过期，请重新获取。');
      } else {
        setQrTicket(undefined);
        setQrStatus('');
        pushToast(cfg.connectedToast, 'success');
        onDone();
      }
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
        egressIp: String(data.get('egressIp') ?? '').trim() || undefined,
        profileLabel: String(data.get('profileLabel') ?? '').trim() || undefined,
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
        profileUrl: String(data.get('profileUrl') ?? '').trim() || undefined,
        operator: String(data.get('operator') ?? '').trim() || undefined,
        alias: String(data.get('alias') ?? '').trim() || undefined,
        groupId: groupId || null,
        tags,
        egressIp: String(data.get('egressIp') ?? '').trim() || undefined,
        profileLabel: String(data.get('profileLabel') ?? '').trim() || undefined,
      });
      form.reset();
      pushToast('Cookie 校验通过并已加密导入。', 'success');
      onDone();
    }, 'Cookie 已核验并加密保存，账号可用于排期与定期体检。');
  }

  const biliConfigured = Boolean(settings?.bilibili);
  const xhsConfigured = Boolean(settings?.xiaohongshu);
  const biliOAuthOrigin = settings?.bilibiliOAuthOrigin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const activeQr = qrPlatforms[platform];

  if (!open) return null;

  return <section className="card account-onboarding-card">
    <div className="card-heading">
      <div>
        <h2>添加发布账号（扫码 / 账号密码 / Cookie）</h2>
        <p className="muted small">统一支持扫码接入、账号密码托管或 Cookie 导入登记多个矩阵账号。</p>
      </div>
      <button type="button" className="button compact" onClick={onClose}>
        <X size={15} aria-hidden="true" />收起面板
      </button>
    </div>
    <div className="onboarding-body">
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
            <select value={platform} onChange={(e) => {
              setPlatform(e.target.value as Platform);
              setQrTicket(undefined);
              setQrStatus('');
              setXhsSettingsOpen(false);
              qrAction.reset();
            }}>
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
        <div className="form-stack">
          <p className="muted small">{activeQr.hint}</p>
          {qrTicket ? <div className="qr-box">
            <img src={qrTicket.image} width={188} height={188}
              alt={qrTicket.userCode ? `${activeQr.alt}，授权码 ${qrTicket.userCode}` : activeQr.alt} />
            <div className="form-stack">
              <p role="status">{qrStatus}</p>
              {qrTicket.userCode && <p className="muted small">授权确认码：<code>{qrTicket.userCode}</code></p>}
              <div className="actions">
                <button type="button" className="button primary compact" onClick={pollQrOnce} disabled={qrAction.busy}>检查扫码结果</button>
                <button type="button" className="button compact" onClick={() => { setQrTicket(undefined); setQrStatus(''); }}>关闭二维码</button>
              </div>
            </div>
          </div> : <div className="actions">
            <button type="button" className="button primary" onClick={startQr} disabled={qrAction.busy}>
              <ScanLine size={16} aria-hidden="true" />{qrAction.busy ? activeQr.busyLabel : activeQr.buttonLabel}
            </button>
          </div>}
          <Feedback error={qrAction.error} notice={qrTicket ? undefined : qrStatus} />
          {platform === 'bilibili' ? <details className="source">
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
          </details> : <details className="source" open={xhsSettingsOpen} onToggle={(e) => setXhsSettingsOpen(e.currentTarget.open)}>
            <summary>开放平台扫码与身份核验设置</summary>
            <div className="form-stack">
              {canConfigure
                ? <AppCredentials path={`${settingsPath}/xiaohongshu`} platform="xiaohongshu" configured={xhsConfigured} onSaved={onDone} />
                : <p className="muted small">{xhsConfigured
                    ? '当前工作室已配置小红书开放平台扫码凭据，可直接点击上方生成二维码。'
                    : '尚未配置小红书开放平台扫码凭据；需由工作室负责人配置，或改用「2. 账号密码」「3. Cookie 导入」。'}</p>}
            </div>
          </details>}
        </div>
      </div>}

      {tab === 'password' && <form className="form-stack onboarding-panel" onSubmit={submitPassword}>
        <p className="muted small">密码与登录账号均由服务端 AES-256-GCM 加密托管（列表只显示脱敏标识），不在页面中明文回显或导出，不自动绕过平台验证码。</p>
        <div className="account-form-fields">
          <label>账号显示名称<input name="displayName" required maxLength={60} placeholder="例如 测评主号" disabled={pwdAction.busy} /></label>
          <label>登录账号（手机号 / 邮箱 / 用户名）<input name="loginIdentifier" required maxLength={120} autoComplete="off" disabled={pwdAction.busy} /></label>
          <label>登录密码<input name="password" type="password" required maxLength={256} autoComplete="new-password" disabled={pwdAction.busy} /></label>
          <label>{platform === 'bilibili' ? 'B 站 UID 或空间链接' : '小红书主页链接或用户 ID'} <small>选填</small>
            <input name="profile" maxLength={1000}
              placeholder={platform === 'bilibili' ? '例如 123456' : '例如 https://www.xiaohongshu.com/user/profile/...'}
              disabled={pwdAction.busy} />
          </label>
          <label>运营负责人 <small>选填</small><input name="operator" maxLength={40} placeholder="例如 林舟" disabled={pwdAction.busy} /></label>
          <label>内部备注名 <small>选填</small><input name="alias" maxLength={60} placeholder="如 科技测评-大号" disabled={pwdAction.busy} /></label>
        </div>
        <label>标签 <small>逗号或空格分隔，最多 12 个</small><input name="tags" maxLength={160} placeholder="主号 科技测评" disabled={pwdAction.busy} /></label>
        <details className="source">
          <summary>网络与环境隔离标签（选填，用于 IP 碰撞与体检）</summary>
          <div className="account-form-fields">
            <label>出口 IP / 代理节点 <small>同平台同 IP 将触发冲突提醒</small>
              <input name="egressIp" maxLength={64} placeholder="例如 203.0.113.10 或 HK-住宅-01" disabled={pwdAction.busy} />
            </label>
            <label>浏览器 Profile / 设备槽位 <small>选填</small>
              <input name="profileLabel" maxLength={64} placeholder={platform === 'bilibili' ? '例如 Bili-Env-01' : '例如 XHS-Env-01'} disabled={pwdAction.busy} />
            </label>
          </div>
        </details>
        <Feedback error={pwdAction.error} notice={pwdAction.notice} />
        <div className="actions">
          <button type="submit" className="button primary" disabled={pwdAction.busy}>{pwdAction.busy ? '正在加密保存…' : '加密保存账号密码'}</button>
        </div>
      </form>}

      {tab === 'cookie' && <form className="form-stack onboarding-panel" onSubmit={submitCookie}>
        <p className="muted small">
          {platform === 'bilibili'
            ? '粘贴浏览器登录后包含 SESSDATA 的 Cookie（文本或 JSON 数组），服务端会自动调用 B 站接口核验有效性与昵称，并解析过期时间。'
            : '粘贴小红书网页版 / 创作平台包含 web_session 或 a1 的 Cookie（文本或 JSON 数组），服务端加密保存并纳入状态巡检。'}
        </p>
        <label>Cookie 内容<textarea name="cookie" rows={3} required maxLength={32768} spellCheck={false}
          placeholder={platform === 'bilibili'
            ? '例如 SESSDATA=...; bili_jct=...; 或浏览器导出的 JSON Cookie 数组'
            : '例如 a1=...; web_session=...; 或浏览器导出的 JSON Cookie 数组'}
          disabled={cookieAction.busy} /></label>
        <div className="account-form-fields">
          <label>账号显示名称 {platform === 'bilibili' ? <small>选填，留空自动获取昵称</small> : <small>必填</small>}
            <input name="displayName" required={platform === 'xiaohongshu'} maxLength={60} placeholder="输入便于区分的账号名" disabled={cookieAction.busy} />
          </label>
          {platform === 'xiaohongshu' && <label>小红书主页链接或用户 ID <small>选填，含创作者 ID 时自动补全</small>
            <input name="profileUrl" maxLength={1000} placeholder="https://www.xiaohongshu.com/user/profile/..." disabled={cookieAction.busy} />
          </label>}
          <label>运营负责人 <small>选填</small><input name="operator" maxLength={40} disabled={cookieAction.busy} /></label>
          <label>内部备注名 <small>选填</small><input name="alias" maxLength={60} disabled={cookieAction.busy} /></label>
          <label>标签 <small>选填</small><input name="tags" maxLength={160} placeholder="主号 图文" disabled={cookieAction.busy} /></label>
        </div>
        <details className="source">
          <summary>网络与环境隔离标签（选填，用于 IP 碰撞与体检）</summary>
          <div className="account-form-fields">
            <label>出口 IP / 代理节点 <small>同平台同 IP 将触发冲突提醒</small>
              <input name="egressIp" maxLength={64} placeholder="例如 203.0.113.10 或 SH-静态-02" disabled={cookieAction.busy} />
            </label>
            <label>浏览器 Profile / 设备槽位 <small>选填</small>
              <input name="profileLabel" maxLength={64} placeholder={platform === 'bilibili' ? '例如 Bili-Env-02' : '例如 XHS-Env-02'} disabled={cookieAction.busy} />
            </label>
          </div>
        </details>
        <Feedback error={cookieAction.error} notice={cookieAction.notice} />
        <div className="actions">
          <button type="submit" className="button primary" disabled={cookieAction.busy}>{cookieAction.busy ? '正在校验导入…' : '校验并导入 Cookie'}</button>
        </div>
      </form>}
    </div>
  </section>;
}

type MoreMenuItem =
  | { kind: 'button'; label: string; icon: typeof Pencil; onSelect: () => void; disabled?: boolean; tone?: 'danger' }
  | { kind: 'link'; label: string; icon: typeof ExternalLink; href: string };

function AccountMoreMenu({ accountName, items }: { accountName: string; items: MoreMenuItem[] }) {
  const triggerId = useId();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const enterOnOpenRef = useRef(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu || 'focusGroup' in HTMLElement.prototype) return;
    menu.setAttribute('role', 'menu');
    menu.querySelectorAll<HTMLElement>('[data-menu-item]').forEach((item) => {
      item.setAttribute('role', 'menuitem');
    });
  }, [items.length]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const onToggle = (event: Event) => {
      const nextOpen = (event as ToggleEvent).newState === 'open' || popover.matches(':popover-open');
      setOpen(nextOpen);
      if (nextOpen) {
        if (typeof CSS !== 'undefined' && !CSS.supports('position-area: block-end') && triggerRef.current) {
          const rect = triggerRef.current.getBoundingClientRect();
          const menuRect = popover.getBoundingClientRect();
          const pad = 8;
          const width = menuRect.width || 176;
          const height = menuRect.height || 180;
          const left = Math.max(pad, Math.min(rect.right - width, window.innerWidth - width - pad));
          const fitsBelow = rect.bottom + 6 + height <= window.innerHeight - pad;
          const top = fitsBelow ? rect.bottom + 6 : Math.max(pad, rect.top - height - 6);
          popover.style.left = `${left}px`;
          popover.style.top = `${top}px`;
        }
        if (enterOnOpenRef.current) {
          enterOnOpenRef.current = false;
          const first = menuRef.current?.querySelector<HTMLElement>('[data-menu-item]:not(:disabled)');
          first?.focus({ preventScroll: true });
        }
      } else {
        enterOnOpenRef.current = false;
      }
    };
    popover.addEventListener('toggle', onToggle);
    return () => popover.removeEventListener('toggle', onToggle);
  }, []);

  if (items.length === 0) return null;

  function openMenuWithKeyboard() {
    const popover = popoverRef.current as (HTMLDivElement & { showPopover?: () => void }) | null;
    if (!popover) return;
    enterOnOpenRef.current = true;
    try {
      popover.showPopover?.();
    } catch {
      // Fallback for browsers where popover is already open or unsupported.
    }
  }

  function closeMenu(restoreFocus = false) {
    const popover = popoverRef.current as (HTMLDivElement & { hidePopover?: () => void }) | null;
    try {
      popover?.hidePopover?.();
    } catch {
      // Ignore if already closed.
    }
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (open) {
        menuRef.current?.querySelector<HTMLElement>('[data-menu-item]:not(:disabled)')?.focus({ preventScroll: true });
      } else {
        openMenuWithKeyboard();
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      enterOnOpenRef.current = true;
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(false);
      return;
    }
    if ('focusGroup' in HTMLElement.prototype) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const enabled = [...(menuRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
      .filter((item) => !(item as HTMLButtonElement).disabled);
    if (!enabled.length) return;
    const current = enabled.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? enabled.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
    event.preventDefault();
    enabled[next]?.focus({ preventScroll: true });
  }

  return <>
    <button
      ref={triggerRef}
      id={triggerId}
      type="button"
      className="icon-button account-more-trigger"
      {...({ popovertarget: menuId } as any)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menuId}
      aria-label={`更多操作 · ${accountName}`}
      title="更多操作"
      onPointerDown={() => { enterOnOpenRef.current = false; }}
      onKeyDown={handleTriggerKeyDown}
    >
      <MoreHorizontal size={15} aria-hidden="true" />
    </button>
    <div ref={popoverRef} id={menuId} {...({ popover: 'auto' } as any)} className="account-more-popover">
      <div
        ref={menuRef}
        {...({ focusgroup: 'menu nomemory' } as any)}
        aria-labelledby={triggerId}
        className="account-more-list"
        onKeyDown={handleMenuKeyDown}
      >
        {items.map((item) => {
          const Icon = item.icon;
          if (item.kind === 'link') {
            return (
              <a
                key={item.label}
                data-menu-item=""
                className="account-more-item"
                href={item.href}
                target="_blank"
                rel="noreferrer"
                onClick={() => closeMenu(false)}
                onPointerMove={(e) => {
                  const under = document.elementFromPoint(e.clientX, e.clientY);
                  if (under && e.currentTarget.contains(under)) e.currentTarget.focus({ preventScroll: true });
                }}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{item.label}</span>
              </a>
            );
          }
          return (
            <button
              key={item.label}
              type="button"
              data-menu-item=""
              className={`account-more-item${item.tone === 'danger' ? ' tone-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                closeMenu(false);
                item.onSelect();
              }}
              onPointerMove={(e) => {
                const under = document.elementFromPoint(e.clientX, e.clientY);
                if (under && e.currentTarget.contains(under)) e.currentTarget.focus({ preventScroll: true });
              }}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  </>;
}

function AccountListHeader({ showSelect }: { showSelect: boolean }) {
  return (
    <div className={`account-list-header${showSelect ? '' : ' no-select'}`} aria-hidden="true">
      {showSelect && <span className="account-col-select">选 / 顶</span>}
      <span>账号信息</span>
      <span>接入方式</span>
      <span>状态 (身份 / 业务能力 / 风险 / 环境)</span>
      <span className="account-col-checked">最后体检</span>
      <span className="account-col-actions">操作</span>
    </div>
  );
}

const drawerTabs: { id: DrawerTab; label: string }[] = [
  { id: 'overview', label: '账号概览' },
  { id: 'auth', label: '授权与接入' },
  { id: 'capabilities', label: '业务能力' },
  { id: 'environment', label: '运行环境' },
  { id: 'risks', label: '风险与事件' },
];

function AccountDetailsDrawer({
  account, drawer, isMobile, onTabChange, onClose, trial, showArchived, canManage, canReportRisk,
  groups, samePlatformPeers, accountsPath, diag, healthBusy, onRunHealthCheck, onChanged, openPerformance,
}: {
  account: Account;
  drawer: DrawerState;
  isMobile: boolean;
  onTabChange: (tab: DrawerTab) => void;
  onClose: () => void;
  trial?: boolean;
  showArchived: boolean;
  canManage: boolean;
  canReportRisk: boolean;
  groups: MatrixGroup[];
  samePlatformPeers: Account[];
  accountsPath: string;
  diag?: HealthCheckDiagnostics;
  healthBusy: boolean;
  onRunHealthCheck: (accountId: string) => void;
  onChanged: () => void;
  openPerformance: (id: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pressedOutsideRef = useRef(false);
  const activeAccountIdRef = useRef(account.id);
  const titleId = useId();
  const tabPrefix = useId();

  const [editingMeta, setEditingMeta] = useState(Boolean(drawer.editingMeta));
  const [reportingRisk, setReportingRisk] = useState(Boolean(drawer.reportingRisk));
  const [readCookieInput, setReadCookieInput] = useState('');
  const metaAction = useAction();
  const profileAction = useAction();
  const riskAction = useAction();

  activeAccountIdRef.current = account.id;

  const risksRes = useResource<AccountRiskEvent[]>(
    drawer.tab === 'risks' ? `${accountsPath}/risks?accountId=${encodeURIComponent(account.id)}` : null,
  );
  const opsRes = useResource<AccountOperationsSummary>(
    drawer.tab === 'overview' ? `${accountsPath}/${encodeURIComponent(account.id)}/operations-summary` : null,
  );

  useEffect(() => {
    if (!isMobile) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
  }, [isMobile]);

  useEffect(() => {
    if (isMobile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[popover]:popover-open, dialog[open]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobile, onClose]);

  useEffect(() => {
    setReadCookieInput('');
    metaAction.reset();
    profileAction.reset();
    riskAction.reset();
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  useEffect(() => {
    if (drawer.editingMeta) setEditingMeta(true);
    if (drawer.reportingRisk) setReportingRisk(true);
  }, [drawer.editingMeta, drawer.reportingRisk]);

  useEffect(() => {
    if (!editingMeta) setReadCookieInput('');
  }, [editingMeta]);

  useEffect(() => () => {
    setReadCookieInput('');
  }, []);

  useEffect(() => {
    const tablist = tablistRef.current;
    if (!tablist || 'focusGroup' in HTMLElement.prototype) return;
    tablist.setAttribute('role', 'tablist');
    tablist.querySelectorAll<HTMLElement>('[data-drawer-tab]').forEach((tab) => {
      tab.setAttribute('role', 'tab');
    });
  }, []);

  const statusView = buildAccountStatusView(account, showArchived, diag);
  const methodLabel = account.accessMethod ? accessMethodLabels[account.accessMethod] : '手工接入';
  const accountLabel = account.alias ? `${account.alias}（${account.displayName}）` : account.displayName;
  const effectiveIpCollision = diag?.egressIpCollision ?? Boolean(account.egressIpCollision);
  const effectiveSeparated = diag?.readWriteSeparated ?? Boolean(account.readWriteSeparated);
  const lastChecked = statusView.riskEnv.checkedAt;

  function requestClose() {
    setReadCookieInput('');
    if (isMobile && dialogRef.current?.open) {
      dialogRef.current.close();
      return;
    }
    onClose();
  }

  function selectTab(nextTab: DrawerTab) {
    onTabChange(nextTab);
    const btn = tablistRef.current?.querySelector<HTMLElement>(`[data-drawer-tab="${nextTab}"]`);
    btn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ('focusGroup' in HTMLElement.prototype) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...(tablistRef.current?.querySelectorAll<HTMLElement>('[data-drawer-tab]') ?? [])];
    if (!tabs.length) return;
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    const nextIdx = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    event.preventDefault();
    const nextBtn = tabs[nextIdx];
    const nextId = nextBtn?.dataset.drawerTab as DrawerTab | undefined;
    if (nextBtn && nextId) {
      nextBtn.focus({ preventScroll: true });
      selectTab(nextId);
    }
  }

  function saveProfileUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetAccountId = account.id;
    const form = event.currentTarget;
    const data = new FormData(form);
    const profileUrl = String(data.get('profileUrl') ?? '').trim() || null;
    void profileAction.run(async () => {
      await api(`${accountsPath}/${targetAccountId}`, { method: 'PATCH', body: { profileUrl } });
      if (activeAccountIdRef.current !== targetAccountId) return;
      form.reset();
      pushToast('平台主页链接已保存。', 'success');
      onChanged();
    });
  }

  function saveMeta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetAccountId = account.id;
    const data = new FormData(event.currentTarget);
    const rawTags = String(data.get('tags') ?? '');
    const tags = rawTags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
    const nextGroupId = String(data.get('groupId') ?? '').trim() || null;
    const nextReadAccountId = String(data.get('readAccountId') ?? '').trim() || null;
    const rawReadCookie = readCookieInput.trim();
    const clearReadCookie = data.get('clearReadCookie') === 'on';
    const nextReadLabel = String(data.get('readCookieLabel') ?? '').trim();
    void metaAction.run(async () => {
      await api(`${accountsPath}/${targetAccountId}`, {
        method: 'PATCH',
        body: {
          groupId: nextGroupId,
          alias: String(data.get('alias') ?? '').trim() || null,
          operator: String(data.get('operator') ?? '').trim(),
          tags,
          egressIp: String(data.get('egressIp') ?? '').trim() || null,
          profileLabel: String(data.get('profileLabel') ?? '').trim() || null,
          profileUrl: String(data.get('profileUrl') ?? '').trim() || null,
        },
      });
      if (!trial && (nextReadAccountId !== (account.readAccountId ?? null) || rawReadCookie || clearReadCookie || nextReadLabel !== (account.readCookieLabel ?? ''))) {
        await post(`${accountsPath}/${targetAccountId}/read-session`, {
          readAccountId: nextReadAccountId,
          ...(clearReadCookie ? { readCookie: null } : rawReadCookie ? { readCookie: rawReadCookie } : {}),
          ...(nextReadLabel ? { readCookieLabel: nextReadLabel } : {}),
        });
      }
      setReadCookieInput('');
      if (activeAccountIdRef.current !== targetAccountId) return;
      setEditingMeta(false);
      pushToast('账号分组、环境与读写分离配置已保存。', 'success');
      onChanged();
    });
  }

  function submitRisk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetAccountId = account.id;
    const form = event.currentTarget;
    const data = new FormData(form);
    void riskAction.run(async () => {
      const res = await post<{ feishuStatus: string }>(`${accountsPath}/${targetAccountId}/risk`, {
        level: String(data.get('level') ?? 'risk'),
        kind: String(data.get('kind') ?? 'manual_flagged'),
        message: String(data.get('message') ?? ''),
        forceNotify: true,
      });
      if (activeAccountIdRef.current !== targetAccountId) return;
      form.reset();
      setReportingRisk(false);
      pushToast(
        res.feishuStatus === 'sent' ? '风险已记录，并已推送飞书机器人告警。' : '风险已记录（未触发飞书或当前环境未启用推送）。',
        'info',
      );
      onChanged();
      risksRes.refresh();
    });
  }

  function resolveRisk() {
    const targetAccountId = account.id;
    void riskAction.run(async () => {
      await post(`${accountsPath}/${targetAccountId}/risk/resolve`, { note: '人工确认风险已处理', notify: true });
      if (activeAccountIdRef.current !== targetAccountId) return;
      setReportingRisk(false);
      pushToast('已解除该账号的风险状态。', 'success');
      onChanged();
      risksRes.refresh();
    });
  }

  const outsideDialog = (clientX: number, clientY: number) => {
    const dialog = dialogRef.current;
    if (!dialog) return false;
    const r = dialog.getBoundingClientRect();
    return clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom;
  };

  const activeTabId = `${tabPrefix}-${drawer.tab}`;
  const activeRiskEvents = (risksRes.data ?? []).filter((ev) => !ev.resolvedAt && ev.level !== 'normal');
  const latestOps = opsRes.data;
  const totalTasksCount = latestOps?.totalTasks ?? account.taskCount ?? 0;

  const content = (
    <>
      <header className="account-drawer-header">
        <div className="account-drawer-title-group">
          <PlatformIcon platform={account.platform} />
          <div className="account-drawer-heading">
            <h2 id={titleId}>{accountLabel}</h2>
            <p className="muted small">
              {platformLabel[account.platform]}
              {account.platformUid ? ` · UID ${account.platformUid}` : ''}
              {account.operator ? ` · 负责人 ${account.operator}` : ''}
            </p>
          </div>
        </div>
        <div className="account-drawer-header-actions">
          <span className={`badge ${statusView.riskEnv.riskTone}`}>{statusView.riskEnv.riskLabel}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭账号详情"
            autoFocus={isMobile}
            onClick={requestClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div
        ref={tablistRef}
        {...({ focusgroup: 'tablist nomemory' } as any)}
        aria-label="账号详情分区"
        className="account-drawer-tabs"
        onKeyDown={handleTabKeyDown}
      >
        {drawerTabs.map((item) => {
          const selected = drawer.tab === item.id;
          return (
            <button
              key={item.id}
              id={`${tabPrefix}-${item.id}`}
              type="button"
              data-drawer-tab={item.id}
              aria-selected={selected}
              {...(selected ? { focusgroupstart: '' } : {})}
              className="account-drawer-tab"
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div ref={bodyRef} className="account-drawer-body">
        {drawer.tab === 'overview' && (
          <div role="tabpanel" aria-labelledby={activeTabId} tabIndex={0} className="account-drawer-panel form-stack">
            <div className="account-drawer-section-head">
              <strong>基础信息</strong>
              {!showArchived && canManage && (
                <button type="button" className="button compact" onClick={() => { setEditingMeta(!editingMeta); metaAction.reset(); }}>
                  <Pencil size={13} aria-hidden="true" />{editingMeta ? '收起编辑' : '编辑'}
                </button>
              )}
            </div>

            <div className="account-drawer-hero">
              <PlatformIcon platform={account.platform} />
              <div className="account-drawer-hero-copy">
                <strong>{account.displayName}</strong>
                <small className="muted">
                  {account.alias ? `内部别名：${account.alias}` : `平台昵称：${account.displayName}`}
                  {account.platformUid ? ` · UID ${account.platformUid}` : ''}
                </small>
                <div className="account-drawer-hero-pills">
                  {account.group && (
                    <span className="group-pill">
                      <span className={`group-dot color-${account.group.color}`} aria-hidden="true" />矩阵组：{account.group.name}
                    </span>
                  )}
                  <span className="badge gray">负责人：{account.operator || '未分配'}</span>
                  {(account.tags ?? []).map((tag) => <span key={tag} className="badge gray">{tag}</span>)}
                </div>
              </div>
            </div>

            <div className="account-drawer-section-head">
              <strong>状态概览</strong>
            </div>
            <div className="account-drawer-status-grid">
              <div className={`account-drawer-status-card tone-${statusView.identity.tone}`} title={statusView.identity.detail}>
                <small>身份核验</small>
                <strong>{statusView.identity.shortLabel}</strong>
              </div>
              <div className={`account-drawer-status-card tone-${statusView.session.tone}`} title={statusView.session.detail}>
                <small>授权与会话</small>
                <strong>{statusView.session.shortLabel}</strong>
              </div>
              <div className={`account-drawer-status-card tone-${statusView.capability.tone}`} title={statusView.capability.detail}>
                <small>业务能力</small>
                <strong>{statusView.capability.shortLabel}</strong>
              </div>
              <div className={`account-drawer-status-card tone-${statusView.riskEnv.tone}`} title={statusView.riskEnv.detail}>
                <small>风险与环境</small>
                <strong>{statusView.riskEnv.envLabel}</strong>
              </div>
            </div>
            <p className="account-drawer-hint" role="note">{statusView.summaryHint}</p>

            <div className="account-drawer-section-head">
              <strong>近期运营</strong>
              {opsRes.loading && <small className="muted">同步中…</small>}
            </div>
            {opsRes.error ? (
              <Feedback error={opsRes.error} />
            ) : (
              <div className="account-drawer-card form-stack">
                <div className="account-ops-grid">
                  <div className="account-ops-metric">
                    <small>关联发布任务</small>
                    <strong>{totalTasksCount}</strong>
                  </div>
                  <div className="account-ops-metric">
                    <small>待执行任务</small>
                    <strong>{latestOps ? latestOps.pendingTasks : '—'}</strong>
                  </div>
                  <div className="account-ops-metric">
                    <small>待核实任务</small>
                    <strong>{latestOps ? latestOps.unknownTasks : '—'}</strong>
                  </div>
                </div>
                <div className="account-ops-latest">
                  <small className="muted">最近一次发布结果</small>
                  {latestOps?.latestResult ? (
                    <div className="account-ops-result-row">
                      <span className={`badge ${latestOps.latestResult.state === 'published' ? 'green' : latestOps.latestResult.state === 'failed' ? 'red' : 'amber'}`}>
                        {taskLabel[latestOps.latestResult.state]}
                      </span>
                      <span className="account-ops-result-title">
                        {latestOps.latestResult.title || '发布任务'}
                      </span>
                      <small className="muted">{formatTime(latestOps.latestResult.recordedAt)}</small>
                      {latestOps.latestResult.remoteUrl && (
                        <a href={latestOps.latestResult.remoteUrl} target="_blank" rel="noreferrer" className="text-button small">
                          查看作品
                        </a>
                      )}
                    </div>
                  ) : (
                    <small className="muted">
                      {opsRes.loading ? '正在查询近期发布记录…' : totalTasksCount === 0 ? '该账号暂无关联发布任务。' : '暂无已记录的发布结果。'}
                    </small>
                  )}
                </div>
              </div>
            )}

            <div className="account-drawer-section-head">
              <strong>关键信息</strong>
            </div>
            <dl className="account-drawer-kv">
              <div><dt>账号登记</dt><dd>{statusView.registration.label}</dd></div>
              <div><dt>接入方式</dt><dd>{methodLabel}</dd></div>
              <div><dt>创建时间</dt><dd>{account.createdAt ? formatTime(account.createdAt) : '未知'}</dd></div>
              <div>
                <dt>最近体检</dt>
                <dd>
                  {lastChecked ? formatTime(lastChecked) : '尚未执行环境体检'}{' '}
                  <button type="button" className="text-button small" onClick={() => selectTab('environment')}>查看环境</button>
                </dd>
              </div>
              <div>
                <dt>Cookie 有效期</dt>
                <dd>
                  {account.cookieExpiresAt
                    ? formatTime(account.cookieExpiresAt)
                    : account.hasCookie ? '已保存（有效期未知）' : '未配置 Cookie'}
                </dd>
              </div>
              <div>
                <dt>读写分离</dt>
                <dd>
                  {account.readAccount
                    ? `已启用（读取账号：${account.readAccount.alias || account.readAccount.displayName}）`
                    : account.hasReadCookie
                      ? `已启用（独立只读 Cookie${account.readCookieLabel ? `：${account.readCookieLabel}` : ''}）`
                      : '未启用'}
                </dd>
              </div>
              <div>
                <dt>平台主页</dt>
                <dd>
                  {account.profileUrl ? (
                    <a href={account.profileUrl} target="_blank" rel="noreferrer" className="account-drawer-link">
                      {account.profileUrl}<ExternalLink size={12} aria-hidden="true" />
                    </a>
                  ) : '未配置主页链接'}
                </dd>
              </div>
            </dl>

            {!account.profileUrl && canManage && !showArchived && !editingMeta && (
              <form className="account-drawer-card form-stack" onSubmit={saveProfileUrl}>
                <strong className="small">补充平台主页链接</strong>
                <div className="account-drawer-inline-form">
                  <input
                    name="profileUrl"
                    required
                    maxLength={1000}
                    aria-label={account.platform === 'bilibili' ? 'B 站主页链接或数字 UID' : '小红书主页链接或 24 位 ID'}
                    placeholder={account.platform === 'bilibili' ? '数字 UID 或 https://space.bilibili.com/...' : '24 位 ID 或 https://www.xiaohongshu.com/user/profile/...'}
                    disabled={profileAction.busy}
                  />
                  <button type="submit" className="button primary compact" disabled={profileAction.busy}>
                    {profileAction.busy ? '保存中…' : '保存主页'}
                  </button>
                </div>
                <Feedback error={profileAction.error} notice={profileAction.notice} />
              </form>
            )}

            {editingMeta && canManage && !showArchived && (
              <form key={account.id} className="account-drawer-card form-stack" onSubmit={saveMeta}>
                <strong className="small">编辑账号配置与读写分离</strong>
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
                  <label>出口 IP / 代理节点 <small>选填，检测同平台碰撞</small>
                    <input name="egressIp" maxLength={64} defaultValue={account.egressIp ?? ''} placeholder="例如 203.0.113.10" />
                  </label>
                  <label>环境槽位 / Profile 标签 <small>选填</small>
                    <input name="profileLabel" maxLength={64} defaultValue={account.profileLabel ?? ''} placeholder="例如 XHS-Env-01" />
                  </label>
                  <label>{account.platform === 'bilibili' ? 'B 站主页链接 / UID' : '小红书主页链接 / 24 位 ID'} <small>选填</small>
                    <input name="profileUrl" maxLength={1000} defaultValue={account.profileUrl ?? ''}
                      placeholder={account.platform === 'bilibili' ? 'https://space.bilibili.com/123456' : 'https://www.xiaohongshu.com/user/profile/...'} />
                  </label>
                </div>
                {!trial && <div className="form-stack">
                  <strong className="small">读写登录分离（采集成效/查状态优先使用读取会话，降低主号风险）</strong>
                  <div className="account-form-fields">
                    <label>方式一：绑定同平台辅助采集小号
                      <select name="readAccountId" defaultValue={account.readAccountId ?? ''}>
                        <option value="">不绑定采集小号</option>
                        {samePlatformPeers.map((peer) => (
                          <option key={peer.id} value={peer.id}>{peer.alias ? `${peer.alias}（${peer.displayName}）` : peer.displayName}</option>
                        ))}
                      </select>
                    </label>
                    <label>方式二：独立只读 Cookie 标签 <small>选填</small>
                      <input name="readCookieLabel" maxLength={60} defaultValue={account.readCookieLabel ?? ''} placeholder="例如 只读采集 Cookie" />
                    </label>
                  </div>
                  <label>方式二：粘贴或更新独立只读采集 Cookie <small>{account.hasReadCookie ? '已保存，留空则保持不变' : '选填'}</small>
                    <textarea
                      name="readCookie"
                      rows={2}
                      maxLength={32768}
                      spellCheck={false}
                      autoComplete="off"
                      value={readCookieInput}
                      onChange={(e) => setReadCookieInput(e.target.value)}
                      placeholder="粘贴只读小号 Cookie，与主发布凭据隔离加密存储（关闭面板即自动清理）"
                    />
                  </label>
                  {account.hasReadCookie && <label className="checkbox-line">
                    <input type="checkbox" name="clearReadCookie" />
                    <span>清除已保存的独立只读 Cookie</span>
                  </label>}
                </div>}
                <Feedback error={metaAction.error} notice={metaAction.notice} />
                <div className="actions">
                  <button type="submit" className="button primary compact" disabled={metaAction.busy}>保存配置</button>
                  <button type="button" className="button compact" onClick={() => setEditingMeta(false)}>取消</button>
                </div>
              </form>
            )}
          </div>
        )}

        {drawer.tab === 'auth' && (
          <div role="tabpanel" aria-labelledby={activeTabId} tabIndex={0} className="account-drawer-panel form-stack">
            <div className="account-drawer-card form-stack">
              <div className="account-drawer-section-head">
                <strong>会话与授权状态</strong>
                <span className={`badge ${statusView.session.tone}`}>{statusView.session.label}</span>
              </div>
              <p className="muted small">{statusView.session.detail}</p>
            </div>
            <dl className="account-drawer-kv">
              <div><dt>账号接入方式</dt><dd><span className="badge gray">{methodLabel}</span></dd></div>
              <div>
                <dt>登录凭据保存</dt>
                <dd>
                  {account.hasPassword || account.hasCookie || account.hasCredentials || account.hasReadCookie
                    ? [
                        account.hasPassword && `账号密码${account.loginIdentifier ? `（${account.loginIdentifier}）` : ''}`,
                        account.hasCookie && '主发布 Cookie',
                        account.hasCredentials && '官方 OAuth 令牌',
                        account.hasReadCookie && '独立只读 Cookie',
                      ].filter(Boolean).join(' · ')
                    : '未保存登录凭据'}
                </dd>
              </div>
              <div>
                <dt>身份核验状态</dt>
                <dd>
                  <span className={`badge ${statusView.identity.tone}`}>{statusView.identity.label}</span>
                  <small className="muted account-drawer-sub">{statusView.identity.detail}</small>
                </dd>
              </div>
              <div>
                <dt>身份核验时间</dt>
                <dd>{account.identityCheckedAt ? formatTime(account.identityCheckedAt) : '未核验 / 未知'}</dd>
              </div>
              <div>
                <dt>官方授权状态</dt>
                <dd>{account.channelKind === 'official' ? (account.authStatus ? authStatusLabels[account.authStatus] : '未知') : '未接入官方授权通道'}</dd>
              </div>
              <div>
                <dt>授权到期时间</dt>
                <dd>{account.authExpiresAt ? formatTime(account.authExpiresAt) : '未知 / 未设置'}</dd>
              </div>
              <div>
                <dt>Cookie 更新时间</dt>
                <dd>
                  {account.cookieUpdatedAt ? formatTime(account.cookieUpdatedAt) : '未保存'}
                  {account.hasCookie && (
                    <small className="muted account-drawer-sub">
                      有效期：{account.cookieExpiresAt ? formatTime(account.cookieExpiresAt) : '未知（未标注到期日）'}
                    </small>
                  )}
                </dd>
              </div>
              <div>
                <dt>最近在线验证</dt>
                <dd>{account.authCheckedAt ? formatTime(account.authCheckedAt) : '尚未完成在线验证'}</dd>
              </div>
            </dl>
            <div className="account-drawer-card form-stack">
              <strong>凭据托管边界（只写不读）</strong>
              <p className="muted small">
                托管密码与 Cookie 仅由服务端 AES-256-GCM 加密保存，GET /accounts/:id/credentials 已下线，前端无法查看或复制明文，也不将凭据写入浏览器存储或日志。
              </p>
            </div>
          </div>
        )}

        {drawer.tab === 'capabilities' && (
          <div role="tabpanel" aria-labelledby={activeTabId} tabIndex={0} className="account-drawer-panel form-stack">
            <div className="account-drawer-card form-stack">
              <div className="account-drawer-section-head">
                <strong>当前支持通道</strong>
                <span className={`badge ${statusView.capability.tone}`}>{statusView.capability.label}</span>
              </div>
              <p className="small">{statusView.capability.channelText}</p>
              <p className="muted small">{statusView.capability.detail}</p>
            </div>

            <div className="account-drawer-card form-stack">
              <strong>功能边界（服务端判定同步）</strong>
              <dl className="account-drawer-kv">
                <div>
                  <dt>可执行功能</dt>
                  <dd>
                    {statusView.capability.canExecute.length > 0
                      ? statusView.capability.canExecute.join('、')
                      : '暂无可执行发布功能'}
                  </dd>
                </div>
                <div>
                  <dt>未配置 / 限制</dt>
                  <dd>
                    {statusView.capability.missingConfig.length > 0
                      ? statusView.capability.missingConfig.join('；')
                      : '当前平台通道能力已全部配置'}
                  </dd>
                </div>
                <div>
                  <dt>不可执行原因</dt>
                  <dd>
                    {statusView.capability.unavailableReason
                      ? `${statusView.capability.unavailableReason}（${statusCategoryLabels[statusView.capability.category]}）`
                      : account.availableForHandoff
                        ? '仅支持人工交接通道，未授权官方自动投稿能力'
                        : '当前无阻塞原因'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}

        {drawer.tab === 'environment' && (
          <div role="tabpanel" aria-labelledby={activeTabId} tabIndex={0} className="account-drawer-panel form-stack">
            <div className="account-drawer-section-head">
              <strong>发布前网络与运行环境</strong>
              {!showArchived && canManage && (
                <button type="button" className="button primary compact" onClick={() => onRunHealthCheck(account.id)} disabled={healthBusy}>
                  <ShieldCheck size={13} aria-hidden="true" />{healthBusy ? '体检中…' : '立即联网体检'}
                </button>
              )}
            </div>
            {account.riskStatus && account.riskStatus !== 'normal' && account.riskReason && (
              <p className="risk-reason-line"><AlertTriangle size={13} aria-hidden="true" />{account.riskReason}</p>
            )}
            <div className="account-drawer-card form-stack">
              <div className="account-drawer-kv">
                <div>
                  <dt>环境检查状态</dt>
                  <dd>
                    <span className={`badge ${statusView.riskEnv.envTone}`}>{statusView.riskEnv.envLabel}</span>
                    <small className="muted account-drawer-sub">{statusView.riskEnv.coverage}</small>
                  </dd>
                </div>
                <div>
                  <dt>登录态验证</dt>
                  <dd>
                    <span className={`badge ${statusView.session.tone}`}>{statusView.session.label}</span>
                    <small className="muted account-drawer-sub">{statusView.session.detail}</small>
                  </dd>
                </div>
              </div>
            </div>
            <dl className="account-drawer-kv">
              <div><dt>出口 IP / 节点</dt><dd>{account.egressIp || '未配置出口标识'}</dd></div>
              <div>
                <dt>IP 冲突提示</dt>
                <dd>
                  <span className={`badge ${effectiveIpCollision ? 'amber' : 'gray'}`}>
                    {effectiveIpCollision ? '同平台存在出口 IP 冲突' : '未发现冲突'}
                  </span>
                </dd>
              </div>
              <div><dt>环境槽位</dt><dd>{account.profileLabel || '未配置'}</dd></div>
              <div>
                <dt>读写分离</dt>
                <dd><span className={`badge ${effectiveSeparated ? 'green' : 'gray'}`}>{effectiveSeparated ? '已启用' : '未启用'}</span></dd>
              </div>
              <div><dt>辅助采集账号</dt><dd>{account.readAccount ? (account.readAccount.alias || account.readAccount.displayName) : '未绑定'}</dd></div>
              <div>
                <dt>独立只读 Cookie</dt>
                <dd>{account.hasReadCookie ? `已配置${account.readCookieLabel ? `（${account.readCookieLabel}）` : ''}` : '未配置'}</dd>
              </div>
              <div><dt>最近体检时间</dt><dd>{lastChecked ? formatTime(lastChecked) : '尚无检测结果（未体检）'}</dd></div>
            </dl>
          </div>
        )}

        {drawer.tab === 'risks' && (
          <div role="tabpanel" aria-labelledby={activeTabId} tabIndex={0} className="account-drawer-panel form-stack">
            <div className="account-drawer-section-head">
              <strong>风险状态与事件流水</strong>
              <div className="actions">
                <button type="button" className="button compact" onClick={risksRes.refresh} disabled={risksRes.loading}>
                  <RefreshCw size={13} aria-hidden="true" />刷新
                </button>
                {!showArchived && canReportRisk && (
                  <button type="button" className="button compact" onClick={() => { setReportingRisk(!reportingRisk); riskAction.reset(); }}>
                    <ShieldAlert size={13} aria-hidden="true" />{reportingRisk ? '收起表单' : account.riskStatus && account.riskStatus !== 'normal' ? '处理 / 上报' : '风险上报'}
                  </button>
                )}
              </div>
            </div>

            {(!account.riskStatus || account.riskStatus === 'normal') && activeRiskEvents.length === 0 && (
              <div className="account-drawer-card">
                <p className="muted small">当前没有待处理的风险告警。</p>
              </div>
            )}

            {reportingRisk && !showArchived && (canReportRisk || canManage) && (
              <form className="account-drawer-card form-stack" onSubmit={submitRisk}>
                {canReportRisk && <>
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
                  <label>情况说明（同步推送飞书群机器人）
                    <input name="message" required maxLength={300} placeholder="例如 小红书发布时触发滑块/短信验证，需主号人员处理" />
                  </label>
                </>}
                <Feedback error={riskAction.error} notice={riskAction.notice} />
                <div className="actions">
                  {canReportRisk && (
                    <button type="submit" className="button primary compact" disabled={riskAction.busy}>上报风险并通知飞书</button>
                  )}
                  {canManage && account.riskStatus && account.riskStatus !== 'normal' && (
                    <button type="button" className="button compact" onClick={resolveRisk} disabled={riskAction.busy}>
                      <Check size={13} aria-hidden="true" />解除当前风险
                    </button>
                  )}
                </div>
              </form>
            )}

            {risksRes.loading ? <Loading /> : risksRes.error ? <Feedback error={risksRes.error} /> : (risksRes.data?.length ?? 0) === 0 ? (
              <p className="muted small">暂无历史风险事件记录。</p>
            ) : (
              <ul className="risk-event-list">
                {risksRes.data!.map((ev) => (
                  <li key={ev.id} className="risk-event-item">
                    <div>
                      <span className={`badge ${ev.level === 'risk' ? 'red' : ev.level === 'warning' ? 'amber' : 'green'}`}>
                        {ev.level === 'risk' ? '风险异常' : ev.level === 'warning' ? '预警提醒' : '已解除'}
                      </span>
                      <span className="badge gray">{riskKindLabels[ev.kind] ?? ev.kind}</span>
                      <span className="badge gray">
                        {ev.feishuStatus === 'sent' ? '飞书已送达' : ev.feishuStatus === 'failed' ? '飞书失败' : '飞书未推送'}
                      </span>
                    </div>
                    <p>{ev.message}{ev.feishuError ? ` · ${ev.feishuError}` : ''}</p>
                    <small className="muted">
                      发生：{formatTime(ev.createdAt)}
                      {ev.actor?.name ? ` · 记录人：${ev.actor.name}` : ''}
                      {ev.resolvedAt ? ` · 已于 ${formatTime(ev.resolvedAt)} 解除` : ' · 尚未解除'}
                      {ev.resolvedBy?.name ? ` · 处理人：${ev.resolvedBy.name}` : ''}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <footer className="account-drawer-footer">
        <div className="actions">
          {!showArchived && canManage && (
            <button type="button" className="button primary compact" onClick={() => onRunHealthCheck(account.id)} disabled={healthBusy}>
              <ShieldCheck size={14} aria-hidden="true" />{healthBusy ? '体检中…' : '环境体检'}
            </button>
          )}
          {!showArchived && canManage && (
            <button type="button" className="button compact" onClick={() => { selectTab('overview'); setEditingMeta(true); }}>
              <Pencil size={14} aria-hidden="true" />编辑配置
            </button>
          )}
          {account.channelKind !== 'sandbox' && (
            <button type="button" className="button compact" onClick={() => { requestClose(); openPerformance(account.id); }}>
              <BarChart3 size={14} aria-hidden="true" />作品成效
            </button>
          )}
          {account.profileUrl && (
            <a className="button compact" href={account.profileUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} aria-hidden="true" />查看主页
            </a>
          )}
        </div>
      </footer>
    </>
  );

  if (isMobile) {
    return (
      <dialog
        ref={dialogRef}
        className="account-drawer"
        aria-labelledby={titleId}
        {...({ closedby: 'any' } as any)}
        onClose={() => {
          setReadCookieInput('');
          onClose();
        }}
        onPointerDown={(e) => {
          if ('closedBy' in HTMLDialogElement.prototype) return;
          pressedOutsideRef.current = e.target === dialogRef.current && outsideDialog(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if ('closedBy' in HTMLDialogElement.prototype) return;
          if (pressedOutsideRef.current && e.target === dialogRef.current && outsideDialog(e.clientX, e.clientY)) {
            dialogRef.current?.close();
          }
          pressedOutsideRef.current = false;
        }}
      >
        {content}
      </dialog>
    );
  }

  return (
    <aside className="account-side-drawer" aria-labelledby={titleId}>
      {content}
    </aside>
  );
}

function AccountRow({
  account, showArchived, canManage, canReportRisk, accountsPath, selected, activeDrawer,
  diag, healthBusy, onToggleSelect, onOpenDrawer, onRunHealthCheck,
  openPerformance, onChanged, onArchive, archiveBusy,
}: {
  account: Account; showArchived: boolean; canManage: boolean; canReportRisk: boolean;
  accountsPath: string; selected: boolean; activeDrawer: boolean;
  diag?: HealthCheckDiagnostics; healthBusy: boolean;
  onToggleSelect: (id: string) => void;
  onOpenDrawer: (config: DrawerState) => void;
  onRunHealthCheck: (accountId: string) => void;
  openPerformance: (id: string) => void; onChanged: () => void; onArchive: (account: Account) => void; archiveBusy: boolean;
}) {
  const action = useAction();

  const statusView = buildAccountStatusView(account, showArchived, diag);
  const methodLabel = account.accessMethod ? accessMethodLabels[account.accessMethod] : '手工接入';
  const accountLabel = account.alias ? `${account.alias}（${account.displayName}）` : account.displayName;
  const showSelect = canManage && !showArchived;

  function togglePin() {
    void action.run(async () => {
      await api(`${accountsPath}/${account.id}`, { method: 'PATCH', body: { pinned: !account.pinned } });
      onChanged();
    });
  }

  const effectiveIpCollision = diag?.egressIpCollision ?? Boolean(account.egressIpCollision);
  const effectiveSeparated = diag?.readWriteSeparated ?? Boolean(account.readWriteSeparated);
  const lastChecked = statusView.riskEnv.checkedAt;

  const moreItems: MoreMenuItem[] = [];
  if (!showArchived && canManage) {
    moreItems.push({
      kind: 'button',
      label: '编辑账号配置',
      icon: Pencil,
      onSelect: () => onOpenDrawer({ accountId: account.id, tab: 'overview', editingMeta: true }),
    });
  }
  if (!showArchived && canReportRisk) {
    moreItems.push({
      kind: 'button',
      label: account.riskStatus && account.riskStatus !== 'normal' ? '处理 / 解除风险' : '风险上报',
      icon: ShieldAlert,
      onSelect: () => onOpenDrawer({ accountId: account.id, tab: 'risks', reportingRisk: true }),
    });
  }
  if (account.profileUrl) {
    moreItems.push({
      kind: 'link',
      label: '查看平台主页',
      icon: ExternalLink,
      href: account.profileUrl,
    });
  }
  if (account.channelKind !== 'sandbox') {
    moreItems.push({
      kind: 'button',
      label: '查看作品成效',
      icon: BarChart3,
      onSelect: () => openPerformance(account.id),
    });
  }
  if (canManage) {
    moreItems.push({
      kind: 'button',
      label: showArchived ? '恢复账号' : '归档账号',
      icon: showArchived ? RotateCcw : Trash2,
      disabled: archiveBusy,
      tone: showArchived ? undefined : 'danger',
      onSelect: () => onArchive(account),
    });
  }

  return <li className={`account-row-shell${activeDrawer ? ' is-active' : ''}${account.riskStatus === 'risk' ? ' has-risk' : account.riskStatus === 'warning' ? ' has-warning' : ''}`}>
    <div className={`account-management-row${showSelect ? '' : ' no-select'}`}>
      {showSelect && <div className="account-col-select">
        <label className="row-checkbox" aria-label={`勾选账号 ${account.displayName}`}>
          <input type="checkbox" checked={selected} onChange={() => onToggleSelect(account.id)} />
        </label>
        <button type="button" className={`icon-button pin-btn${account.pinned ? ' pinned' : ''}`}
          title={account.pinned ? '取消置顶' : '置顶账号'} aria-label={`${account.pinned ? '取消置顶' : '置顶'} ${account.displayName}`}
          onClick={togglePin} disabled={action.busy}>
          <Star size={14} fill={account.pinned ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      </div>}

      <div className="account-main-info">
        <div className="account-title-line">
          <PlatformIcon platform={account.platform} />
          <button
            type="button"
            className="account-name-btn"
            aria-expanded={activeDrawer}
            title={accountLabel}
            onClick={() => onOpenDrawer({ accountId: account.id, tab: 'overview' })}
          >
            <strong>{accountLabel}</strong>
          </button>
          {account.group && <span className="group-pill">
            <span className={`group-dot color-${account.group.color}`} aria-hidden="true" />{account.group.name}
          </span>}
        </div>
        <div className="account-subline">
          {account.platformUid && <span className="account-meta-item">UID: {account.platformUid}</span>}
          <span className="account-meta-item">负责人: {account.operator || '未分配'}</span>
          <span className="account-meta-item account-meta-access-inline">{methodLabel}</span>
          {account.egressIp && <span className="account-meta-item">节点: {account.egressIp}</span>}
          {(account.tags?.length ?? 0) > 0 && (
            <span className="account-meta-item">标签: {account.tags!.join(' / ')}</span>
          )}
          <span className="account-meta-item account-meta-checked-inline">
            体检: {lastChecked ? formatTime(lastChecked) : '未体检'}
          </span>
        </div>
      </div>

      <div className="account-col-access">
        <span className="badge gray">{methodLabel}</span>
        {effectiveSeparated && <small className="account-access-note">读写分离</small>}
        {!effectiveSeparated && account.loginIdentifier && <small className="account-access-note">{account.loginIdentifier}</small>}
      </div>

      <div className="account-badges">
        <span className={`badge ${statusView.identity.tone}`} title={statusView.identity.detail}>
          <span className="badge-dot" aria-hidden="true" />{statusView.identity.shortLabel}
        </span>
        <span className={`badge ${statusView.capability.tone}`} title={statusView.capability.detail}>
          {statusView.capability.shortLabel}
        </span>
        {!showArchived && account.availableForMetrics && (
          <span className="badge sky" title="支持自动同步作品成效">成效读取</span>
        )}
        {!showArchived && (
          <button type="button" className={`badge ${statusView.riskEnv.riskTone}`} title={statusView.riskEnv.detail}
            onClick={() => onOpenDrawer({ accountId: account.id, tab: 'risks' })}>
            {statusView.riskEnv.riskLabel}
          </button>
        )}
        {!showArchived && (
          <span className={`badge ${statusView.riskEnv.envTone}`} title={statusView.riskEnv.detail}>
            {statusView.riskEnv.envLabel}
          </span>
        )}
        {!showArchived && effectiveIpCollision && <span className="badge amber" title="同平台存在相同出口 IP">IP 同网</span>}
      </div>

      <div className="account-col-checked">
        <small className={lastChecked ? undefined : 'muted'} title={lastChecked ? `最近体检时间：${formatTime(lastChecked)}` : '尚未执行环境体检'}>
          {lastChecked ? formatTime(lastChecked) : '-'}
        </small>
      </div>

      <div className="actions account-row-actions">
        <button type="button" className={`button compact${activeDrawer ? ' active' : ''}`}
          aria-expanded={activeDrawer}
          onClick={() => onOpenDrawer({ accountId: account.id, tab: 'overview' })}>
          <FileText size={13} aria-hidden="true" />详情
        </button>
        {!showArchived && canManage && <button type="button" className="button compact"
          onClick={() => onRunHealthCheck(account.id)} disabled={healthBusy}>
          <ShieldCheck size={13} aria-hidden="true" />{healthBusy ? '体检中…' : '体检'}
        </button>}
        <AccountMoreMenu accountName={account.displayName} items={moreItems} />
      </div>
    </div>

    {action.error && <Feedback error={action.error} />}
  </li>;
}

export function Accounts({ scope, canManage, canConfigure, canReportRisk, trial, resource, openPerformance }: {
  scope: string; canManage: boolean; canConfigure: boolean; canReportRisk: boolean;
  resource: ReturnType<typeof useResource<Account[]>>;
  trial?: boolean;
  openPerformance: (accountId: string) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('group');
  const [kpiFilter, setKpiFilter] = useState<KpiFilter>('all');
  const [platformFilter, setPlatformFilter] = useState<Platform | 'all'>('all');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showRisksPanel, setShowRisksPanel] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingGroupId, setOnboardingGroupId] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState<MatrixGroup | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchGroupId, setBatchGroupId] = useState('');
  const [batchOperator, setBatchOperator] = useState('');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [isMobileDrawer, setIsMobileDrawer] = useState(false);
  const [diagByAccount, setDiagByAccount] = useState<Record<string, HealthCheckDiagnostics>>({});
  const [checkingAccountId, setCheckingAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 900px)');
    const sync = () => setIsMobileDrawer(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const archiveAction = useAction();
  const demoAction = useAction();
  const groupAction = useAction();
  const batchAction = useAction();
  const healthAction = useAction();

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

  const availableCount = accounts.filter((a) => a.availableForOfficial || a.availableForHandoff).length;
  const pendingCount = accounts.filter((a) => !a.identityVerified || (!a.availableForOfficial && !a.availableForHandoff)).length;
  const warningCount = accounts.filter((a) => a.riskStatus === 'warning').length;
  const riskCount = accounts.filter((a) => a.riskStatus === 'risk').length;
  const warningOrRiskCount = warningCount + riskCount;
  const uncheckedCount = accounts.filter((a) => !a.envCheckedAt && !diagByAccount[a.id]?.checkedAt).length;
  const availablePct = accounts.length ? Math.round((availableCount / accounts.length) * 100) : 0;

  const query = search.trim().toLowerCase();
  const hasActiveFilter = kpiFilter !== 'all' || platformFilter !== 'all' || riskFilter !== 'all' || groupFilter !== 'all' || query !== '';
  const filteredAccounts = accounts.filter((account) => {
    if (platformFilter !== 'all' && account.platform !== platformFilter) return false;
    if (!showArchived && riskFilter !== 'all' && (account.riskStatus ?? 'normal') !== riskFilter) return false;
    if (!showArchived && groupFilter === 'ungrouped' && account.groupId) return false;
    if (!showArchived && groupFilter !== 'all' && groupFilter !== 'ungrouped' && account.groupId !== groupFilter) return false;
    if (!showArchived && kpiFilter === 'available' && !account.availableForOfficial && !account.availableForHandoff) return false;
    if (!showArchived && kpiFilter === 'pending' && account.identityVerified && (account.availableForOfficial || account.availableForHandoff)) return false;
    if (!showArchived && kpiFilter === 'risk' && account.riskStatus !== 'warning' && account.riskStatus !== 'risk') return false;
    if (!showArchived && kpiFilter === 'unchecked' && (account.envCheckedAt || diagByAccount[account.id]?.checkedAt)) return false;
    if (!query) return true;
    return [account.displayName, account.alias, account.operator, account.platformUid, account.loginIdentifier, account.group?.name, ...(account.tags ?? [])]
      .some((value) => value?.toLowerCase().includes(query));
  });

  function clearFilters() {
    setKpiFilter('all');
    setPlatformFilter('all');
    setRiskFilter('all');
    setGroupFilter('all');
    setSearch('');
  }

  function openOnboarding(targetGroupId = '') {
    setOnboardingGroupId(targetGroupId);
    setOnboardingOpen(true);
  }

  function toggleGroupCollapse(key: string, defaultCollapsed = false) {
    setCollapsedGroups((prev) => {
      const current = prev[key] ?? defaultCollapsed;
      return { ...prev, [key]: !current };
    });
  }

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

  function runHealthCheck(accountId: string) {
    if (checkingAccountId) return;
    setCheckingAccountId(accountId);
    void healthAction.run(async () => {
      try {
        const res = await post<{
          status: AccountRiskStatus; reason: string; feishuStatus: string; diagnostics?: HealthCheckDiagnostics;
        }>(
          `${accountsPath}/${accountId}/health-check`, {},
        );
        if (res.diagnostics) {
          setDiagByAccount((prev) => ({ ...prev, [accountId]: res.diagnostics! }));
        }
        setDrawer({ accountId, tab: 'environment' });
        pushToast(
          res.status === 'normal'
            ? '体检正常：登录态、读写分离与网络环境通过。'
            : `发现${res.status === 'risk' ? '风险' : '预警'}：${res.reason}${res.feishuStatus === 'sent' ? '（已发送飞书通知）' : ''}`,
          res.status === 'normal' ? 'success' : 'info',
          4500,
        );
        refreshAll();
      } finally {
        setCheckingAccountId(null);
      }
    });
  }

  const drawerAccount = drawer ? accounts.find((a) => a.id === drawer.accountId) ?? null : null;

  return <>
    <PageHeader title="发布账号与矩阵组" description={trial
      ? '试用工作室支持按矩阵组整理演示账号，练习跨平台批量排期与风险记录。'
      : '统一管理多平台账号的接入、授权、业务能力与运行状态，支持矩阵化分组与批量运营。'}>
      <div className="actions">
        {!showArchived && <button type="button" className={`button compact${showRisksPanel ? ' active' : ''}`}
          onClick={() => setShowRisksPanel(!showRisksPanel)}>
          <ShieldAlert size={15} aria-hidden="true" />风险告警记录 {warningOrRiskCount > 0 && `(${warningOrRiskCount})`}
        </button>}
        {canManage && !showArchived && <button type="button" className="button compact"
          onClick={() => { setCreatingGroup(!creatingGroup); setEditingGroup(null); groupAction.reset(); }}>
          <FolderPlus size={15} aria-hidden="true" />{creatingGroup ? '收起建组' : '新建矩阵组'}
        </button>}
        {canManage && <button type="button" className="button compact" aria-pressed={showArchived}
          onClick={() => { setShowArchived(!showArchived); setSelectedIds([]); setOnboardingOpen(false); archiveAction.reset(); }} disabled={archiveAction.busy}>
          {showArchived ? '返回在用账号' : '查看已归档'}
        </button>}
      </div>
    </PageHeader>

    {!showArchived && <div className="account-kpi-grid" role="group" aria-label="账号运营总览筛选">
      <button type="button" className={`account-kpi-card tone-sky${kpiFilter === 'all' ? ' active' : ''}`}
        onClick={() => setKpiFilter('all')}>
        <div className="account-kpi-head">
          <span className="account-kpi-icon" aria-hidden="true"><UsersRound size={16} /></span>
          <span>全部账号</span>
        </div>
        <strong>{accounts.length}</strong>
        <small>在用矩阵账号</small>
      </button>
      <button type="button" className={`account-kpi-card tone-green${kpiFilter === 'available' ? ' active' : ''}`}
        onClick={() => setKpiFilter(kpiFilter === 'available' ? 'all' : 'available')}>
        <div className="account-kpi-head">
          <span className="account-kpi-icon" aria-hidden="true"><CheckCircle2 size={16} /></span>
          <span>可用账号</span>
        </div>
        <strong>{availableCount}</strong>
        <small>占全部 {availablePct}%</small>
      </button>
      <button type="button" className={`account-kpi-card tone-amber${kpiFilter === 'pending' ? ' active' : ''}`}
        onClick={() => setKpiFilter(kpiFilter === 'pending' ? 'all' : 'pending')}>
        <div className="account-kpi-head">
          <span className="account-kpi-icon" aria-hidden="true"><Clock3 size={16} /></span>
          <span>待处理</span>
        </div>
        <strong>{pendingCount}</strong>
        <small>待核验 / 暂不可用</small>
      </button>
      <button type="button" className={`account-kpi-card tone-red${kpiFilter === 'risk' ? ' active' : ''}`}
        onClick={() => setKpiFilter(kpiFilter === 'risk' ? 'all' : 'risk')}>
        <div className="account-kpi-head">
          <span className="account-kpi-icon" aria-hidden="true"><ShieldAlert size={16} /></span>
          <span>风险异常</span>
        </div>
        <strong>{warningOrRiskCount}</strong>
        <small>有告警或风险记录</small>
      </button>
      <button type="button" className={`account-kpi-card tone-violet${kpiFilter === 'unchecked' ? ' active' : ''}`}
        onClick={() => setKpiFilter(kpiFilter === 'unchecked' ? 'all' : 'unchecked')}>
        <div className="account-kpi-head">
          <span className="account-kpi-icon" aria-hidden="true"><Activity size={16} /></span>
          <span>未体检</span>
        </div>
        <strong>{uncheckedCount}</strong>
        <small>尚未执行环境体检</small>
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

    <div className="account-toolbar-wrap">
      <div className="account-toolbar">
        <div className="filters" role="group" aria-label="账号分组视图">
          <button type="button" className={viewMode === 'group' ? 'active' : undefined} onClick={() => setViewMode('group')}>
            <Layers size={14} aria-hidden="true" /> 按矩阵组
          </button>
          <button type="button" className={viewMode === 'platform' ? 'active' : undefined} onClick={() => setViewMode('platform')}>
            按平台
          </button>
        </div>
        <div className="account-search-box">
          <Search size={15} className="account-search-icon" aria-hidden="true" />
          <input type="search" aria-label="搜索账号名称、UID、登录标识、标签或负责人"
            placeholder="搜索账号名称、UID、登录标识、标签或负责人…"
            value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        {!showArchived && canManage && !trial && (
          <button type="button" className="button primary account-add-btn" aria-expanded={onboardingOpen}
            onClick={() => onboardingOpen ? setOnboardingOpen(false) : openOnboarding('')}>
            <Plus size={16} aria-hidden="true" />添加账号
          </button>
        )}
      </div>

      <div className="account-filter-strip">
        <label className="account-filter-chip">
          <span>平台</span>
          <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value as Platform | 'all')}>
            <option value="all">全部</option>
            {platforms.map((p) => <option key={p} value={p}>{accountPlatforms[p].name}</option>)}
          </select>
        </label>
        {!showArchived && (
          <label className="account-filter-chip">
            <span>风险</span>
            <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value as RiskFilter)}>
              <option value="all">全部</option>
              <option value="normal">暂无风险记录</option>
              <option value="warning">预警提醒</option>
              <option value="risk">风险异常</option>
            </select>
          </label>
        )}
        {!showArchived && (
          <label className="account-filter-chip">
            <span>矩阵组</span>
            <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option value="all">全部</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              <option value="ungrouped">未分组账号</option>
            </select>
          </label>
        )}
        <span className="muted small account-filter-count">
          共 {filteredAccounts.length}{hasActiveFilter ? ` / ${accounts.length}` : ''} 个账号
        </span>
        {hasActiveFilter && (
          <button type="button" className="text-button small" onClick={clearFilters}>清空筛选</button>
        )}
      </div>
    </div>

    {!showArchived && canManage && !trial && (
      <OnboardingPanel
        open={onboardingOpen}
        defaultGroupId={onboardingGroupId}
        onClose={() => setOnboardingOpen(false)}
        accountsPath={accountsPath}
        settingsPath={settingsPath}
        settings={settings.data}
        canConfigure={canConfigure}
        groups={groups}
        hasOfficialBili={accounts.some((a) => a.platform === 'bilibili' && a.channelKind === 'official' && a.identityVerified)}
        onDone={() => { refreshAll(); settings.refresh(); }}
      />
    )}

    {selectedIds.length > 0 && canManage && !showArchived && <section className="card batch-bar" aria-label="批量矩阵操作">
      <strong>已选择 {selectedIds.length} 个账号</strong>
      <div className="batch-bar-controls">
        <select aria-label="选择目标矩阵组" value={batchGroupId} onChange={(e) => setBatchGroupId(e.target.value)}>
          <option value="">选择目标矩阵组…</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button type="button" className="button primary compact" disabled={!batchGroupId || batchAction.busy}
          onClick={() => applyBatchGroup(batchGroupId)}>移入矩阵组</button>
        <button type="button" className="button compact" disabled={batchAction.busy}
          onClick={() => applyBatchGroup(null)}>移出分组</button>
        <input type="text" aria-label="批量设运营负责人" placeholder="批量设负责人" value={batchOperator}
          onChange={(e) => setBatchOperator(e.target.value)} maxLength={40} />
        <button type="button" className="button compact" disabled={batchAction.busy} onClick={applyBatchOperator}>分配负责人</button>
        <button type="button" className="text-button" onClick={() => setSelectedIds([])}>取消选择</button>
      </div>
      <Feedback error={batchAction.error} notice={batchAction.notice} />
    </section>}

    {showArchived && <p className="muted small" role="status">正在查看已归档账号</p>}
    <Feedback error={visible.error || archiveAction.error || groupAction.error || groupsRes.error || settings.error || healthAction.error}
      notice={archiveAction.notice || groupAction.notice} />

    <div className={`account-workspace-split${drawerAccount && !isMobileDrawer ? ' has-drawer' : ''}`}>
      <div className="account-workspace-main">
        {visible.loading ? <Loading /> : viewMode === 'group' && !showArchived && !groupsRes.error ? (
          <div className="account-groups">
            {groups.map((group) => {
              if (groupFilter !== 'all' && groupFilter !== group.id) return null;
              const items = filteredAccounts.filter((a) => a.groupId === group.id);
              if (query && items.length === 0 && !group.name.toLowerCase().includes(query)) return null;
              const collapsed = Boolean(collapsedGroups[group.id]);
              const pendingInGroup = Math.max(0, group.accountCount - group.availableCount);
              return <section className="card account-group-card" key={group.id}>
                <div className="card-heading account-group-heading">
                  <div className="account-group-head-left">
                    <button
                      type="button"
                      className="account-group-toggle"
                      aria-expanded={!collapsed}
                      onClick={() => toggleGroupCollapse(group.id)}
                    >
                      {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                      <span className={`group-dot color-${group.color}`} aria-hidden="true" />
                      <h2 className="matrix-group-title">{group.name}</h2>
                      <span className="muted small">{group.accountCount} 个账号</span>
                    </button>
                    <div className="account-group-stats">
                      <span><i className="stat-dot green" aria-hidden="true" />可用 {group.availableCount}</span>
                      <span><i className="stat-dot amber" aria-hidden="true" />待处理 {pendingInGroup}</span>
                      <span><i className="stat-dot red" aria-hidden="true" />异常 {group.riskCount}</span>
                      {hasActiveFilter && <span className="badge violet">筛选中 · 匹配 {items.length} 个</span>}
                    </div>
                    {group.description && <p className="muted small account-group-desc">{group.description}</p>}
                  </div>
                  {canManage && <div className="actions">
                    {!trial && (
                      <button type="button" className="button compact" onClick={() => openOnboarding(group.id)}>
                        <Plus size={13} aria-hidden="true" />添加账号
                      </button>
                    )}
                    <button type="button" className="button compact" onClick={() => { setEditingGroup(group); setCreatingGroup(false); }}>编辑组</button>
                    <button type="button" className="button compact" onClick={() => deleteGroup(group)} disabled={groupAction.busy}>
                      <Trash2 size={13} aria-hidden="true" />删组
                    </button>
                  </div>}
                </div>
                {!collapsed && (items.length > 0 ? <div className="account-list-wrap">
                  <AccountListHeader showSelect={canManage} />
                  <ul className="account-group-list">
                    {items.map((account) => <AccountRow key={account.id} account={account} showArchived={false}
                      canManage={canManage} canReportRisk={canReportRisk}
                      accountsPath={accountsPath}
                      selected={selectedIds.includes(account.id)} activeDrawer={drawer?.accountId === account.id}
                      diag={diagByAccount[account.id]} healthBusy={checkingAccountId === account.id}
                      onToggleSelect={toggleSelect} onOpenDrawer={setDrawer} onRunHealthCheck={runHealthCheck}
                      openPerformance={openPerformance} onChanged={refreshAll} onArchive={archive} archiveBusy={archiveAction.busy} />)}
                  </ul>
                </div> : <p className="account-group-empty muted small">该矩阵组下暂无匹配账号，可在上方列表勾选账号移入。</p>)}
              </section>;
            })}
            {groupFilter === 'all' || groupFilter === 'ungrouped' ? (() => {
              const ungrouped = filteredAccounts.filter((a) => !a.groupId);
              const ungroupedAll = accounts.filter((a) => !a.groupId).length;
              const defaultCollapsed = ungroupedAll === 0 && ungrouped.length === 0;
              const collapsed = collapsedGroups.__ungrouped ?? defaultCollapsed;
              return <section className="card account-group-card">
                <div className="card-heading account-group-heading">
                  <div className="account-group-head-left">
                    <button
                      type="button"
                      className="account-group-toggle"
                      aria-expanded={!collapsed}
                      onClick={() => toggleGroupCollapse('__ungrouped', defaultCollapsed)}
                    >
                      {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                      <span className="group-dot color-slate" aria-hidden="true" />
                      <h2 className="matrix-group-title">未分组账号</h2>
                      <span className="muted small">({ungroupedAll})</span>
                      {hasActiveFilter && ungrouped.length !== ungroupedAll && (
                        <span className="badge violet">匹配 {ungrouped.length} 个</span>
                      )}
                    </button>
                  </div>
                  {canManage && !trial && (
                    <div className="actions">
                      <button type="button" className="button compact" onClick={() => openOnboarding('')}>
                        <Plus size={13} aria-hidden="true" />添加账号
                      </button>
                    </div>
                  )}
                </div>
                {!collapsed && (ungrouped.length > 0 ? <div className="account-list-wrap">
                  <AccountListHeader showSelect={canManage} />
                  <ul className="account-group-list">
                    {ungrouped.map((account) => <AccountRow key={account.id} account={account} showArchived={false}
                      canManage={canManage} canReportRisk={canReportRisk}
                      accountsPath={accountsPath}
                      selected={selectedIds.includes(account.id)} activeDrawer={drawer?.accountId === account.id}
                      diag={diagByAccount[account.id]} healthBusy={checkingAccountId === account.id}
                      onToggleSelect={toggleSelect} onOpenDrawer={setDrawer} onRunHealthCheck={runHealthCheck}
                      openPerformance={openPerformance} onChanged={refreshAll} onArchive={archive} archiveBusy={archiveAction.busy} />)}
                  </ul>
                </div> : <p className="account-group-empty muted small">暂无未分组账号。</p>)}
              </section>;
            })() : null}
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
                {matches.length > 0 ? <div className="account-list-wrap">
                  <AccountListHeader showSelect={canManage && !showArchived} />
                  <ul className="account-group-list">
                    {matches.map((account) => <AccountRow key={account.id} account={account} showArchived={showArchived}
                      canManage={canManage} canReportRisk={canReportRisk}
                      accountsPath={accountsPath}
                      selected={selectedIds.includes(account.id)} activeDrawer={drawer?.accountId === account.id}
                      diag={diagByAccount[account.id]} healthBusy={checkingAccountId === account.id}
                      onToggleSelect={toggleSelect} onOpenDrawer={setDrawer} onRunHealthCheck={runHealthCheck}
                      openPerformance={openPerformance} onChanged={refreshAll} onArchive={archive} archiveBusy={archiveAction.busy} />)}
                  </ul>
                </div> : <p className="account-group-empty muted small">
                  {query ? '没有匹配的账号。' : showArchived ? '暂时没有已归档账号。' : '该平台暂无账号，请点击上方「添加账号」。'}
                </p>}
              </section>;
            })}
          </div>
        )}
      </div>

      {drawer && drawerAccount && (
        <AccountDetailsDrawer
          account={drawerAccount}
          drawer={drawer}
          isMobile={isMobileDrawer}
          onTabChange={(tab) => setDrawer((prev) => (prev ? { ...prev, tab, editingMeta: false, reportingRisk: false } : null))}
          onClose={() => setDrawer(null)}
          trial={trial}
          showArchived={showArchived}
          canManage={canManage}
          canReportRisk={canReportRisk}
          groups={groups}
          samePlatformPeers={accounts.filter((peer) => peer.platform === drawerAccount.platform && peer.id !== drawerAccount.id)}
          accountsPath={accountsPath}
          diag={diagByAccount[drawerAccount.id]}
          healthBusy={checkingAccountId === drawerAccount.id}
          onRunHealthCheck={runHealthCheck}
          onChanged={refreshAll}
          openPerformance={openPerformance}
        />
      )}
    </div>
  </>;
}
