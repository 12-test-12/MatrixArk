'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowLeft, ArrowRight, Check, ChevronRight, CircleUserRound, ClipboardCheck, FileText, LogOut,
  Plus, Radio, Send, ShieldCheck, UserRound, UsersRound,
} from 'lucide-react';
import {
  api, ApiError, canEdit, messageOf, post, roleLabel, scopeFor, useAction, useResource,
  type Account, type Session, type Workspace,
} from './api';
import { Manuscripts, type ManuscriptDrafts } from './manuscripts';
import { Members } from './members';
import { Preview } from './preview';
import { Tasks } from './tasks';
import { Brand, Empty, Feedback, Loading, PageHeader } from './ui';
import { roleView, Workbench, type Section } from './workbench';

function SignIn({ onSession, onPreview, initialError }: {
  onSession: (session: Session) => void; onPreview: () => void; initialError: string;
}) {
  const [registering, setRegistering] = useState(false);
  const action = useAction();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (registering && !String(fields.workspaceName ?? '').trim()) delete fields.workspaceName;
    void action.run(async () => onSession(await post<Session>(registering ? '/auth/register' : '/auth/login', fields)));
  }
  function toggle() {
    action.reset();
    setRegistering(!registering);
  }
  return <main className="auth">
    <section className="auth-story" aria-label="MatrixArk">
      <Brand />
      <div className="story-content">
        <h1>小红书人工<br />发布工作台<span className="story-period">。</span></h1>
        <p>从原稿到发布回执，在一个工作台完成审核、排期和交接。</p>
        <div className="story-flow" aria-label="发布流程">
          <div><FileText size={21} aria-hidden="true" /><span>原稿</span></div>
          <ChevronRight size={15} aria-hidden="true" />
          <div><ShieldCheck size={21} aria-hidden="true" /><span>审核</span></div>
          <ChevronRight size={15} aria-hidden="true" />
          <div><Send size={20} aria-hidden="true" /><span>交接</span></div>
          <ChevronRight size={15} aria-hidden="true" />
          <div><ClipboardCheck size={21} aria-hidden="true" /><span>回填</span></div>
        </div>
      </div>
    </section>
    <section className="auth-panel">
      <div className="auth-form">
        <span className="auth-icon"><UserRound size={23} aria-hidden="true" /></span>
        <h2>{registering ? '创建工作室账号' : '登录工作台'}</h2>
        <p>{registering ? '注册后可进入你的工作室，创建第一篇原稿。' : '使用你的 MatrixArk 账号继续。'}</p>
        <form className="form-stack" onSubmit={submit} key={String(registering)}>
          {registering && <label>姓名<input name="name" required maxLength={40} autoComplete="name" placeholder="输入你的姓名" /></label>}
          {registering && <label>工作室名称 <small>选填</small><input name="workspaceName" maxLength={60} placeholder="例如 内容运营工作室" /></label>}
          <label>邮箱<input name="email" type="email" required autoComplete="email" placeholder="name@example.com" /></label>
          <label>密码<input name="password" type="password" required minLength={registering ? 8 : undefined}
            maxLength={registering ? 72 : undefined} autoComplete={registering ? 'new-password' : 'current-password'}
            placeholder={registering ? '至少 8 位' : '输入密码'} /></label>
          <Feedback error={action.error || initialError} />
          <button className="button primary auth-submit" disabled={action.busy}>
            {action.busy ? '正在提交…' : registering ? '创建账号' : '登录'}<ArrowRight aria-hidden="true" size={18} />
          </button>
        </form>
        <div className="auth-switch">
          {registering ? '已有账号？' : '还没有账号？'}
          <button type="button" className="text-button" onClick={toggle} disabled={action.busy}>
            {registering ? '返回登录' : '创建账号'}
          </button>
        </div>
        <button type="button" className="button auth-preview" onClick={onPreview} disabled={action.busy}>
          <ArrowLeft size={16} aria-hidden="true" />返回示例工作台
        </button>
      </div>
    </section>
  </main>;
}

function Accounts({ scope, workspace, resource }: {
  scope: string; workspace: Workspace; resource: ReturnType<typeof useResource<Account[]>>;
}) {
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const accounts = resource.data?.filter((account) => account.platform === 'xiaohongshu' && account.channelKind === 'manual') ?? [];
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    void action.run(async () => {
      await post(scope + '/accounts', { ...fields, platform: 'xiaohongshu', channelKind: 'manual' });
      resource.refresh();
      setAdding(false);
    }, '人工发布账号已添加。');
  }
  return <>
    <PageHeader title="发布账号" description="管理接收小红书人工交接任务的账号。">
      {canEdit(workspace.role) && <button className="button primary" onClick={() => { action.reset(); setAdding(true); }}>
        <Plus size={17} aria-hidden="true" />添加账号
      </button>}
    </PageHeader>
    <Feedback error={action.error || resource.error} notice={action.notice} />
    {adding && <form className="card form-card form-stack" onSubmit={save}>
      <h2>添加小红书人工账号</h2>
      <div className="form-row">
        <label>账号名称<input name="displayName" required maxLength={60} placeholder="填写账号显示名称" /></label>
        <label>运营人 <small>选填</small><input name="operator" maxLength={40} placeholder="填写负责发布的人" /></label>
      </div>
      <div className="actions"><button className="button primary" disabled={action.busy}>保存账号</button>
        <button type="button" className="button" onClick={() => setAdding(false)}>取消</button></div>
    </form>}
    <section className="card">
      <div className="card-heading"><h2>账号列表</h2></div>
      {resource.loading ? <Loading /> : accounts.length ? accounts.map((account) => <div className="account-row" key={account.id}>
        <span className="platform-icon" aria-hidden="true">红</span>
        <div><strong>{account.displayName}</strong><small>{account.operator || '未填写运营人'}</small></div>
        <span className="badge gray">人工交接</span>
      </div>) : !resource.error && <Empty icon={UsersRound} title="还没有人工账号"
        description="添加小红书账号后，就可以为已审版本排期。" />}
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

  if (!session) return showSignIn
    ? <SignIn initialError={startupError} onPreview={() => setShowSignIn(false)} onSession={(next) => {
      setSession(next); setShowSignIn(false); setStartupError(''); setSection(undefined); setWorkspaceId(''); setTaskId('');
    }} />
    : <Preview onLogin={() => setShowSignIn(true)} />;
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
