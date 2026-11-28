import { useEffect, useState, type FormEvent } from 'react';
import { Building2, CircleUserRound, KeyRound, Monitor, Moon, ShieldCheck, Sun } from 'lucide-react';
import { api, roleLabel, useAction, type Session, type Workspace } from './api';
import { applyThemeMode, readThemeMode, type ThemeMode } from './theme-picker';
import { Feedback, PageHeader, StatGrid, type StatCardItem } from './ui';

export function Profile({ user, workspaces = [], activeWorkspace, onSave }: {
  user: Session['user'];
  workspaces?: Workspace[];
  activeWorkspace?: Workspace;
  onSave: (user: Session['user']) => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [theme, setTheme] = useState<ThemeMode>('system');
  const action = useAction();
  const emailChanged = email.trim().toLowerCase() !== user.email;
  const dirty = name.trim() !== user.name || emailChanged;
  const timeZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '本地时区';

  useEffect(() => {
    setTheme(readThemeMode());
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<ThemeMode>).detail;
      setTheme(detail ?? readThemeMode());
    };
    window.addEventListener('matrixark-theme-change', sync);
    return () => window.removeEventListener('matrixark-theme-change', sync);
  }, []);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const currentPassword = String(fields.get('currentPassword') ?? '');
    void action.run(async () => {
      const saved = await api<Session['user']>('/auth/me', { method: 'PATCH', body: {
        name, email, currentPassword: emailChanged ? currentPassword : undefined,
      } });
      setName(saved.name);
      setEmail(saved.email);
      onSave(saved);
    }, emailChanged ? '资料已保存。下次请使用新邮箱登录。' : '个人资料已保存。');
  }

  const stats: StatCardItem[] = [
    {
      key: 'user',
      label: '当前登录账号',
      value: user.name,
      note: '会话已验证',
      icon: CircleUserRound,
      tone: 'violet',
    },
    {
      key: 'workspace',
      label: '当前工作室',
      value: activeWorkspace?.name ?? '未选择',
      note: activeWorkspace?.trial ? '模拟演练环境' : '正式协作工作室',
      icon: Building2,
      tone: 'sky',
    },
    {
      key: 'role',
      label: '当前工作室角色',
      value: activeWorkspace ? (activeWorkspace.trial ? '模拟演练' : roleLabel[activeWorkspace.role]) : '—',
      note: '权限由工作室服务端授予',
      icon: ShieldCheck,
      tone: 'green',
    },
    {
      key: 'count',
      label: '可访问工作室',
      value: workspaces.length,
      note: '跨工作室数据严格隔离',
      icon: KeyRound,
      tone: 'neutral',
    },
  ];

  return <>
    <PageHeader title="个人资料" description="管理个人姓名、登录邮箱及本地工作台外观偏好，明确区分已支持能力与待接入安全能力。" />
    <StatGrid items={stats} columns={4} label="个人资料与工作区状态" />

    <div className="admin-split-grid">
      <div className="admin-side-stack">
        <section className="card" aria-labelledby="profile-basic-title">
          <div className="card-heading">
            <h2 id="profile-basic-title">基础信息</h2>
            {dirty && <span className="badge amber">有未保存修改</span>}
          </div>
          <div className="detail-content form-stack">
            <div className="profile-hero">
              <span className="profile-avatar-lg" aria-hidden="true">{Array.from(user.name)[0] || 'M'}</span>
              <div>
                <h3 style={{ fontSize: 18 }}>{user.name}</h3>
                <p className="muted small">{user.email}{activeWorkspace ? ` · ${activeWorkspace.name}（${roleLabel[activeWorkspace.role]}）` : ''}</p>
              </div>
            </div>

            <form className="form-stack" onSubmit={save} onChange={action.reset}>
              <div className="form-row">
                <label>姓名
                  <input name="name" autoComplete="name" required maxLength={40}
                    value={name} disabled={action.busy} onChange={(event) => setName(event.target.value)} />
                </label>
                <label>登录邮箱
                  <input name="email" autoComplete="email" type="email" required
                    value={email} disabled={action.busy} onChange={(event) => setEmail(event.target.value)} />
                </label>
              </div>
              <div className="form-row">
                <label>当前工作室（只读）
                  <input type="text" value={activeWorkspace?.name ?? '未加入工作室'} readOnly disabled />
                </label>
                <label>工作室角色（不可自行修改）
                  <input type="text" value={activeWorkspace ? roleLabel[activeWorkspace.role] : '—'} readOnly disabled />
                </label>
              </div>
              {emailChanged && <label>当前密码 <small>修改登录邮箱必须核验本人密码。</small>
                <input name="currentPassword" type="password" autoComplete="current-password" maxLength={72} required disabled={action.busy} />
              </label>}
              <Feedback error={action.error} notice={action.notice} />
              <div className="actions">
                <button className="button primary" disabled={action.busy || !dirty}>
                  {action.busy ? '正在保存…' : '保存个人资料'}
                </button>
              </div>
            </form>
          </div>
        </section>

        <section className="card" aria-labelledby="profile-security-title">
          <div className="card-heading">
            <h2 id="profile-security-title">登录安全与功能支持范围</h2>
            <span className="badge gray">诚实边界</span>
          </div>
          <div className="detail-content notify-rule-list">
            <div className="notify-rule-item">
              <div>
                <strong>当前登录会话与邮箱变更校验</strong>
                <small>修改登录邮箱需校验当前密码，退出登录会立即吊销当前会话。</small>
              </div>
              <span className="badge green">已支持</span>
            </div>
            <div className="notify-rule-item">
              <div>
                <strong>在线修改密码 / 退出其他设备 / 双因素认证</strong>
                <small>服务端暂未开放自助改密、全量设备会话列表与 2FA 接口；如需重置密码请联系管理员在服务端处理。</small>
              </div>
              <span className="badge gray">待接入</span>
            </div>
          </div>
        </section>
      </div>

      <div className="admin-side-stack">
        <section className="card" aria-labelledby="profile-pref-title">
          <div className="card-heading">
            <h2 id="profile-pref-title">使用偏好</h2>
            <span className="badge violet">即时生效</span>
          </div>
          <div className="detail-content form-stack">
            <div>
              <p className="muted small" style={{ marginBottom: 8 }}>界面主题（保存于当前浏览器，与顶部栏同步）</p>
              <div className="profile-theme-grid" role="radiogroup" aria-label="选择界面主题">
                {([
                  { value: 'system', label: '跟随系统', icon: Monitor },
                  { value: 'light', label: '浅色模式', icon: Sun },
                  { value: 'dark', label: '深色模式', icon: Moon },
                ] as const).map((opt) => {
                  const Icon = opt.icon;
                  const active = theme === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`profile-theme-btn${active ? ' active' : ''}`}
                      onClick={() => { applyThemeMode(opt.value); setTheme(opt.value); }}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <label>日期与时间显示
              <input type="text" readOnly disabled value={`自动跟随设备时区（${timeZone}）`} />
            </label>
            <div>
              <p className="muted small" style={{ marginBottom: 8 }}>所属工作室与角色</p>
              {workspaces.length ? (
                <ul className="workspace-mini-list">
                  {workspaces.map((ws) => (
                    <li key={ws.id}>
                      <span>{ws.name}{ws.id === activeWorkspace?.id ? '（当前）' : ''}</span>
                      <span className="badge gray">{ws.trial ? '模拟演练' : roleLabel[ws.role]}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted small">当前暂未加入工作室。</p>}
            </div>
          </div>
        </section>

        <aside className="card" aria-labelledby="profile-safety-title">
          <div className="card-heading">
            <h2 id="profile-safety-title">数据与权限安全说明</h2>
          </div>
          <div className="detail-content">
            <ul className="notification-steps">
              <li>角色权限按工作室独立校验，个人无法自助提升所属工作室角色。</li>
              <li>平台账号密码、Cookie 与飞书密钥由服务端加密只写存储，不在浏览器持久化。</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  </>;
}
