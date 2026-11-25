'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CircleUserRound, LogOut, Radio, X } from 'lucide-react';
import { Accounts } from './accounts';
import {
  api, ApiError, canEdit, canRecord, messageOf, post, roleLabel, scopeFor, useAction, useResource,
  type Account, type Session, type Workspace, type WorkbenchSummary,
} from './api';
import { Manuscripts, type ManuscriptDrafts } from './manuscripts';
import { Topics, type TopicView } from './topics';
import { Members } from './members';
import { FeishuSettings } from './notifications';
import { Performance } from './performance';
import { Preview } from './preview';
import { Profile } from './profile';
import { Tasks } from './tasks';
import { Brand, Empty, Feedback, Loading } from './ui';
import { roleView, Workbench, type Section } from './workbench';

type WorkspaceLocation = { section?: Section; itemId?: string; topicView?: TopicView; topicWorkId?: string };
type Navigation = { workspaceId: string; locations: Record<string, WorkspaceLocation> };
const emptyNavigation: Navigation = { workspaceId: '', locations: {} };
const navigationKey = (userId: string) => `matrixark-navigation:${userId}`;

function readNavigation(userId: string): Navigation {
  try {
    const stored = JSON.parse(localStorage.getItem(navigationKey(userId)) ?? 'null');
    if (typeof stored?.workspaceId === 'string' && stored.locations && typeof stored.locations === 'object') return stored;
  } catch {}
  return emptyNavigation;
}

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
    {...({ closedby: action.busy ? 'none' : 'any' } as any)}
    onClick={(event) => {
      if (action.busy || !dialog.current) return;
      if (event.target !== dialog.current) return;
      if (!('closedBy' in HTMLDialogElement.prototype)) {
        const rect = dialog.current.getBoundingClientRect();
        const isInside = (
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width
        );
        if (!isInside) dialog.current.close();
      }
    }}
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

function WorkspaceBody({ workspace, section, itemId, topicView, topicWorkId, onTopicView, onTopicWork, drafts, openTasks, openAccounts, openPerformance, openManuscript,
  openManuscripts, summary }: {
  workspace: Workspace; section: Section; itemId: string; openTasks: (id: string) => void; openAccounts: () => void;
  topicView: TopicView; topicWorkId: string; onTopicView: (view: TopicView) => void; onTopicWork: (id: string) => void;
  drafts: ManuscriptDrafts; openPerformance: (id: string) => void; openManuscript: (id: string) => void;
  openManuscripts: () => void; summary: ReturnType<typeof useResource<WorkbenchSummary>>;
}) {
  const scope = scopeFor(workspace.id);
  const accounts = useResource<Account[]>(section === 'accounts' || section === 'manuscripts' ? scope + '/accounts' : null);
  if (section === 'manuscripts') return <Manuscripts scope={scope} role={workspace.role} accounts={accounts} drafts={drafts} initialId={itemId}
    openTasks={openTasks} openAccounts={openAccounts} refreshSummary={summary.refresh} />;
  if (section === 'topics') return <Topics scope={scope} openManuscript={openManuscript} canConfigureAi={workspace.role === 'owner'}
    view={topicView} selected={topicWorkId} onView={onTopicView} onSelect={onTopicWork} />;
  if (section === 'tasks') return <Tasks scope={scope} role={workspace.role} initialId={itemId}
    openManuscripts={openManuscripts} counts={summary.data?.taskCounts} refreshSummary={summary.refresh} />;
  if (section === 'performance') return <Performance scope={scope} role={workspace.role} initialAccount={itemId} openTask={openTasks} />;
  if (section === 'members') return <Members scope={scope} />;
  if (section === 'notifications') return <FeishuSettings scope={scope} />;
  return <Accounts scope={scope} canManage={canEdit(workspace.role)} canConfigure={workspace.role === 'owner'} resource={accounts}
    openPerformance={openPerformance} />;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>();
  const [showSignIn, setShowSignIn] = useState(false);
  const [startupError, setStartupError] = useState('');
  const [navigation, setNavigation] = useState(emptyNavigation);
  const activeNavigation = useRef({ userId: '', value: emptyNavigation });
  const [drafts] = useState<ManuscriptDrafts>(() => new Map());
  const logout = useAction();
  const workspace = session?.workspaces.find(({ id }) => id === navigation.workspaceId) ?? session?.workspaces[0];
  const summary = useResource<WorkbenchSummary>(workspace ? scopeFor(workspace.id) + '/workbench-summary' : null, 15_000);

  const restoreNavigation = useCallback((userId: string) => {
    const value = userId ? readNavigation(userId) : emptyNavigation;
    activeNavigation.current = { userId, value };
    setNavigation(value);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const expired = () => { drafts.clear(); restoreNavigation(''); setStartupError('登录已过期，请重新登录。'); setShowSignIn(true); setSession(null); };
    window.addEventListener('matrixark-session-expired', expired);
    void api<Session>('/auth/me', { signal: controller.signal }).then((current) => {
      if (!controller.signal.aborted) {
        restoreNavigation(current.user.id);
        setSession(current);
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (!(error instanceof ApiError && error.status === 401)) setStartupError(messageOf(error));
      setSession((active) => active ?? null);
    });
    return () => { controller.abort(); window.removeEventListener('matrixark-session-expired', expired); };
  }, [drafts, restoreNavigation]);

  if (session === undefined) return <main className="boot"><Brand /><Loading /></main>;
  if (!session) return <>
    <Preview onLogin={() => { setStartupError(''); setShowSignIn(true); }} />
    {showSignIn && <SignIn initialError={startupError} onClose={() => { setShowSignIn(false); setStartupError(''); }} onSession={(next) => {
      restoreNavigation(next.user.id);
      setSession(next); setShowSignIn(false); setStartupError('');
    }} />}
  </>;
  const sections: readonly Section[] = workspace ? [...roleView[workspace.role].sections, 'profile'] : ['profile'];
  const location = workspace ? navigation.locations[workspace.id] : undefined;
  const section = location?.section && sections.includes(location.section) ? location.section
    : sections.includes('topics') ? 'topics' : sections[0];
  const itemId = section === location?.section && typeof location?.itemId === 'string' ? location.itemId : '';
  const topicView = location?.topicView === 'saved' || location?.topicView === 'collection' ? location.topicView : 'works';
  const topicWorkId = typeof location?.topicWorkId === 'string' ? location.topicWorkId : '';
  const userId = session.user.id;

  function remember(next: Navigation) {
    activeNavigation.current = { userId, value: next };
    setNavigation(next);
    try { localStorage.setItem(navigationKey(userId), JSON.stringify(next)); } catch {}
  }
  function updateLocation(change: WorkspaceLocation) {
    const { userId: activeUserId, value: latest } = activeNavigation.current;
    const activeWorkspace = session?.workspaces.find(({ id }) => id === latest.workspaceId) ?? session?.workspaces[0];
    if (!workspace || activeUserId !== userId || activeWorkspace?.id !== workspace.id) return;
    remember({ workspaceId: workspace.id, locations: { ...latest.locations, [workspace.id]: { ...latest.locations[workspace.id], ...change } } });
  }
  function openSection(next: Section, id?: string) { updateLocation({ section: next, itemId: id }); }

  const handoff = workspace && canRecord(workspace.role) ? summary.data?.taskCounts.handed_off ?? 0 : 0;
  const unknown = workspace && canEdit(workspace.role) ? summary.data?.taskCounts.unknown ?? 0 : 0;
  const review = summary.data?.pendingReview ?? 0;
  return <Workbench sections={sections} section={section} onSection={openSection}
    badges={{
      manuscripts: { count: review, label: `${review} 篇原稿待审核` },
      tasks: { count: handoff + unknown, label: [handoff && `${handoff} 项待回填`, unknown && `${unknown} 项待核实`].filter(Boolean).join(' · ') },
    }}
    workspacePicker={<label className="workspace-picker">
        <span className="workspace-icon"><Radio size={19} aria-hidden="true" /></span>
        <span><small>当前工作室</small>
          <select aria-label="切换工作室" value={workspace?.id ?? ''} onChange={(event) => {
            remember({ ...activeNavigation.current.value, workspaceId: event.target.value });
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
          restoreNavigation('');
          setStartupError('');
          setShowSignIn(false);
          setSession(null);
        })}><LogOut size={17} aria-hidden="true" /></button>
      </div>
      <Feedback error={logout.error} /></>}
    topbar={workspace && <span className="workspace-role"><CircleUserRound size={15} aria-hidden="true" />{roleLabel[workspace.role]}</span>}>
    {section === 'profile' ? <Profile user={session.user} onSave={(user) => setSession((current) => current ? { ...current, user } : current)} />
      : workspace && section ? <WorkspaceBody key={workspace.id} workspace={workspace} section={section} itemId={itemId} drafts={drafts}
      topicView={topicView} topicWorkId={topicWorkId} onTopicView={(view) => updateLocation({ topicView: view })}
      onTopicWork={(id) => updateLocation({ topicWorkId: id })}
      openPerformance={(id) => openSection('performance', id)} openManuscript={(id) => openSection('manuscripts', id)}
      openTasks={(id) => { summary.refresh(); openSection('tasks', id); }} openAccounts={() => openSection('accounts')}
      openManuscripts={() => openSection('manuscripts')} summary={summary} />
      : <section className="card"><Empty icon={Check} title="暂无可访问的工作室" description="加入工作室后可查看稿件和任务。" /></section>}
  </Workbench>;
}
