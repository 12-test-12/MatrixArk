'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CircleUserRound, LogOut, Plus, Radio, UsersRound, X } from 'lucide-react';
import {
  api, ApiError, canEdit, channelLabel, messageOf, platformLabel, platforms, post, roleLabel, scopeFor, useAction, useResource,
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

function Accounts({ scope, workspace, resource }: {
  scope: string; workspace: Workspace; resource: ReturnType<typeof useResource<Account[]>>;
}) {
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const accounts = resource.data ?? [];
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    void action.run(async () => {
      await post(scope + '/accounts', { ...fields, channelKind: 'manual' });
      resource.refresh();
      setAdding(false);
    }, '人工发布账号已添加。');
  }
  return <>
    <PageHeader title="发布账号" description="管理各平台账号。已审稿件按同平台账号排期交接。">
      {canEdit(workspace.role) && <button className="button primary" onClick={() => { action.reset(); setAdding(true); }}>
        <Plus size={17} aria-hidden="true" />添加账号
      </button>}
    </PageHeader>
    <Feedback error={action.error || resource.error} notice={action.notice} />
    {adding && <form className="card form-card form-stack" onSubmit={save}>
      <h2>添加人工发布账号</h2>
      <div className="form-row">
        <label>平台<select name="platform" required>
          {platforms.map((platform) => <option key={platform} value={platform}>{platformLabel[platform]}</option>)}
        </select></label>
        <label>账号名称<input name="displayName" required maxLength={60} placeholder="填写账号显示名称" /></label>
      </div>
      <label>运营人 <small>选填</small><input name="operator" maxLength={40} placeholder="填写负责发布的人" /></label>
      <div className="actions"><button className="button primary" disabled={action.busy}>保存账号</button>
        <button type="button" className="button" onClick={() => setAdding(false)}>取消</button></div>
    </form>}
    <section className="card">
      <div className="card-heading"><h2>账号列表</h2></div>
      {resource.loading ? <Loading /> : accounts.length ? accounts.map((account) => <div className="account-row" key={account.id}>
        <PlatformIcon platform={account.platform} />
        <div><strong>{account.displayName}</strong><small>{platformLabel[account.platform]} · {account.operator || '未填写运营人'}</small></div>
        <span className="badge gray">{channelLabel[account.channelKind]}</span>
      </div>) : !resource.error && <Empty icon={UsersRound} title="还没有发布账号"
        description="添加各平台的人工账号后，就可以为同平台的已审版本排期。" />}
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
  return <Accounts scope={scope} workspace={workspace} resource={accounts} />;
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
    <Preview onLogin={() => setShowSignIn(true)} />
    {showSignIn && <SignIn initialError={startupError} onClose={() => setShowSignIn(false)} onSession={(next) => {
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
