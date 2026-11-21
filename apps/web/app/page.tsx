'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CircleUserRound, LogOut, Radio, ScanLine, UsersRound, X } from 'lucide-react';
import qrcode from 'qrcode-generator';
import {
  api, ApiError, canEdit, formatTime, messageOf, platformLabel, post, roleLabel, scopeFor, useAction, useResource,
  type Account, type Session, type Workspace,
} from './api';
import { Manuscripts, type ManuscriptDrafts } from './manuscripts';
import { Members } from './members';
import { Preview } from './preview';
import { Tasks } from './tasks';
import { Brand, Empty, Feedback, Loading, PageHeader, PlatformIcon } from './ui';
import { roleView, Workbench, type Section } from './workbench';

function SignIn({ onSession, onClose, initialError }: {
  onSession: (session: Session) => void; onClose: () => void; initialError: string;
}) {
  const [registering, setRegistering] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const action = useAction();
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    dialog.current?.querySelector('input')?.focus();
  }, [registering]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (registering && !String(fields.workspaceName ?? '').trim()) delete fields.workspaceName;
    void action.run(async () => {
      const session = await post<Session>(registering ? '/auth/register' : '/auth/login', fields);
      dialog.current?.close();
      onSession(session);
    });
  }
  function toggle() {
    action.reset();
    setRegistering(!registering);
  }
  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="auth-title" onClose={onClose}
    onClick={(event) => { if (event.target === dialog.current && !action.busy) dialog.current.close(); }}
    onCancel={(event) => { if (action.busy) event.preventDefault(); }}>
    <div className="auth-heading">
      <h2 id="auth-title">{registering ? '创建工作室账号' : '登录工作台'}</h2>
      <button type="button" className="icon-button" aria-label="关闭登录弹窗" disabled={action.busy}
        onClick={() => dialog.current?.close()}><X size={19} aria-hidden="true" /></button>
    </div>
    <form className="form-stack" onSubmit={submit} key={String(registering)} aria-busy={action.busy}>
      <fieldset className="auth-fields" disabled={action.busy}>
          {registering && <label>姓名<input name="name" required maxLength={40} autoComplete="name" placeholder="输入你的姓名" /></label>}
          {registering && <label>工作室名称 <small>选填</small><input name="workspaceName" maxLength={60} placeholder="例如 内容运营工作室" /></label>}
          <label>邮箱<input name="email" type="email" required autoComplete="email" placeholder="name@example.com" /></label>
          <label>密码<input name="password" type="password" required minLength={registering ? 8 : undefined}
            maxLength={registering ? 72 : undefined} autoComplete={registering ? 'new-password' : 'current-password'}
            placeholder={registering ? '至少 8 位' : '输入密码'} /></label>
      </fieldset>
      <Feedback error={action.error || (!registering ? initialError : undefined)} />
      <button className="button primary auth-submit" disabled={action.busy}>
        {action.busy ? '正在提交…' : registering ? '注册并登录' : '登录'}<ArrowRight aria-hidden="true" size={18} />
      </button>
    </form>
    <div className="auth-switch">
      {registering ? '已有账号？' : '还没有账号？'}
      <button type="button" className="text-button" onClick={toggle} disabled={action.busy}>
        {registering ? '返回登录' : '创建账号'}
      </button>
    </div>
  </dialog>;
}

function Accounts({ scope, resource }: {
  scope: string; resource: ReturnType<typeof useResource<Account[]>>;
}) {
  const [authorization, setAuthorization] = useState<{ id: string; userCode: string; image: string }>();
  const [status, setStatus] = useState('');
  const action = useAction();
  const accounts = resource.data ?? [];
  const path = scope + '/accounts/xiaohongshu/authorize';
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
      if (result.status === 'expired') throw new Error('二维码已过期，请重新连接小红书账号。');
      if (result.status === 'denied') throw new Error('授权未通过。需要连接时可重新扫码。');
      resource.refresh();
      setStatus('小红书账号身份已核验。');
    });
  }
  return <>
    <PageHeader title="发布账号" description="通过平台授权核验真实账号。账号身份和发布权限分别显示。">
      <button className="button primary" onClick={connect} disabled={action.busy || Boolean(authorization)}>
        <ScanLine size={17} aria-hidden="true" />连接小红书账号
      </button>
    </PageHeader>
    <Feedback error={action.error || resource.error} notice={authorization ? undefined : status} />
    {authorization && <section className="card form-card form-stack" aria-labelledby="xiaohongshu-auth-title">
      <h2 id="xiaohongshu-auth-title">用小红书 App 扫码授权</h2>
      <img src={authorization.image} width={192} height={192} alt={`小红书账号授权二维码，授权码 ${authorization.userCode}`} />
      <p className="muted" role="status">{status || '在手机上确认授权后，检查授权结果。'}</p>
      <div className="actions">
        <button type="button" className="button primary" onClick={poll} disabled={action.busy}>检查授权结果</button>
        <button type="button" className="button" disabled={action.busy} onClick={() => {
          setAuthorization(undefined); setStatus(''); action.reset();
        }}>关闭</button>
      </div>
    </section>}
    <section className="card">
      <div className="card-heading"><h2>账号列表</h2></div>
      {resource.loading ? <Loading /> : accounts.length ? accounts.map((account) => <div className="account-row" key={account.id}>
        <PlatformIcon platform={account.platform} />
        <div><strong>{account.displayName}</strong><small>{platformLabel[account.platform]}{account.identityCheckedAt
          ? ` · 核验于 ${formatTime(account.identityCheckedAt)}` : ''}</small></div>
        <span className={`badge ${account.identityVerified ? 'green' : 'gray'}`}>{account.identityVerified
          ? account.availableForHandoff ? '身份已核验 · 人工交接' : '身份已核验 · 未开通发布'
          : '历史账号 · 未核验'}</span>
      </div>) : !resource.error && <Empty icon={UsersRound} title="还没有发布账号"
        description="先连接小红书，授权成功后会显示平台返回的账号。B 站账号暂待开放平台授权。" />}
    </section>
  </>;
}

function WorkspaceBody({ workspace, section, taskId, drafts, openTasks, openAccounts }: {
  workspace: Workspace; section: Section; taskId: string; openTasks: (id: string) => void; openAccounts: () => void;
  drafts: ManuscriptDrafts;
}) {
  const scope = scopeFor(workspace.id);
  const accounts = useResource<Account[]>(canEdit(workspace.role) && section !== 'members' ? scope + '/accounts' : null);
  if (section === 'manuscripts') return <Manuscripts scope={scope} role={workspace.role} accounts={accounts} drafts={drafts}
    openTasks={openTasks} openAccounts={openAccounts} />;
  if (section === 'tasks') return <Tasks scope={scope} role={workspace.role} initialId={taskId} />;
  if (section === 'members') return <Members scope={scope} />;
  return <Accounts scope={scope} resource={accounts} />;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>();
  const [showSignIn, setShowSignIn] = useState(false);
  const [startupError, setStartupError] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [activeSection, setSection] = useState<Section>();
  const [taskId, setTaskId] = useState('');
  const [drafts] = useState<ManuscriptDrafts>(() => new Map());
  const logout = useAction();

  useEffect(() => {
    const controller = new AbortController();
    const expired = () => { drafts.clear(); setStartupError('登录已过期，请重新登录。'); setShowSignIn(true); setSession(null); };
    window.addEventListener('matrixark-session-expired', expired);
    void api<Session>('/auth/me', { signal: controller.signal }).then((current) => {
      if (!controller.signal.aborted) setSession((active) => active ?? current);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (!(error instanceof ApiError && error.status === 401)) setStartupError(messageOf(error));
      setSession((active) => active ?? null);
    });
    return () => { controller.abort(); window.removeEventListener('matrixark-session-expired', expired); };
  }, [drafts]);

  if (session === undefined) return <main className="boot"><Brand /><Loading /></main>;
  if (!session) return <>
    <Preview onLogin={() => { setStartupError(''); setShowSignIn(true); }} />
    {showSignIn && <SignIn initialError={startupError} onClose={() => { setShowSignIn(false); setStartupError(''); }} onSession={(next) => {
      setSession(next); setShowSignIn(false); setStartupError(''); setSection(undefined); setWorkspaceId(''); setTaskId('');
    }} />}
  </>;
  const workspace = session.workspaces.find(({ id }) => id === workspaceId)
    ?? session.workspaces.find(({ role }) => role !== 'owner') ?? session.workspaces[0];
  const sections: readonly Section[] = workspace ? roleView[workspace.role].sections : [];
  const section = activeSection && sections.includes(activeSection) ? activeSection : sections[0];
  return <Workbench sections={sections} section={section} onSection={(next) => { setSection(next); setTaskId(''); }}
    workspacePicker={<label className="workspace-picker">
        <span className="workspace-icon"><Radio size={19} aria-hidden="true" /></span>
        <span><small>当前工作室</small>
          <select aria-label="切换工作室" value={workspace?.id ?? ''} onChange={(event) => {
            setWorkspaceId(event.target.value); setSection(undefined); setTaskId('');
          }}>
            {session.workspaces.length ? session.workspaces.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)
              : <option value="">暂无工作室</option>}
          </select>
        </span>
    </label>}
    profile={<><div className="sidebar-profile">
        <span className="avatar" aria-hidden="true">{Array.from(session.user.name)[0] || 'M'}</span>
        <span className="profile-name"><strong>{session.user.name}</strong><small>{workspace ? roleLabel[workspace.role] : session.user.email}</small></span>
        <button className="icon-button" aria-label="退出登录" title="退出登录" disabled={logout.busy} onClick={() => void logout.run(async () => {
          try { await post('/auth/logout', {}); }
          catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
          drafts.clear();
          setStartupError('');
          setShowSignIn(false);
          setSession(null);
        })}><LogOut size={17} aria-hidden="true" /></button>
      </div>
      <Feedback error={logout.error} /></>}
    topbar={workspace && <span className="workspace-role"><CircleUserRound size={15} aria-hidden="true" />{roleLabel[workspace.role]}</span>}>
    {workspace && section ? <WorkspaceBody key={workspace.id} workspace={workspace} section={section} taskId={taskId} drafts={drafts}
      openTasks={(id) => { setTaskId(id); setSection('tasks'); }} openAccounts={() => setSection('accounts')} />
      : <section className="card"><Empty icon={Check} title="暂无可访问的工作室" description="加入工作室后可查看稿件和任务。" /></section>}
  </Workbench>;
}
