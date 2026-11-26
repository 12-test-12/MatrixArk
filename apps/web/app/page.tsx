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
import { Brand, Empty, Feedback, Loading, PageHeader } from './ui';
import { roleView, Workbench, type Section } from './workbench';

type WorkspaceLocation = { section?: Section; itemId?: string; topicView?: TopicView; topicWorkId?: string };
type Navigation = { workspaceId: string; locations: Record<string, WorkspaceLocation> };
const emptyNavigation: Navigation = { workspaceId: '', locations: {} };
const navigationKey = (userId: string) => `matrixark-navigation:${userId}`;
const bilibiliMessages: Record<string, string> = {
  connected: 'B 站账号已连接，可以为已审核的专栏版本安排发布。',
  denied: '未收到 B 站授权，请重新连接并在授权页确认。',
  expired: 'B 站授权请求已失效，请回到发布账号页重新发起。',
  failed: 'B 站账号核验失败，请检查应用凭据，并确认授权页已勾选用户信息、专栏投稿和专栏数据权限。',
};

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
  const [forgotOpen, setForgotOpen] = useState(false);
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
    setForgotOpen(false);
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
            placeholder={registering ? '至少 8 位' : '输入密码'} />
            {registering && <small className="auth-field-hint">密码须为 8–72 位，建议包含字母与数字</small>}
          </label>
      </fieldset>
      <Feedback error={action.error || (!registering ? initialError : undefined)} />
      <button className="button primary auth-submit" disabled={action.busy}>
        {action.busy ? '正在提交…' : registering ? '注册并登录' : '登录'}<ArrowRight aria-hidden="true" size={18} />
      </button>
    </form>
    {!registering && forgotOpen && (
      <div className="auth-help" role="note">
        当前工作台未启用自动找回邮件。如需重置密码，请联系工作室管理员在数据库/部署端更新凭据，或使用新邮箱重新注册加入工作室。
      </div>
    )}
    <div className="auth-switch">
      {registering ? '已有账号？' : '还没有账号？'}
      <button type="button" className="text-button" onClick={toggle} disabled={action.busy}>
        {registering ? '返回登录' : '创建账号'}
      </button>
      {!registering && <>
        <span aria-hidden="true">·</span>
        <button type="button" className="text-button" onClick={() => setForgotOpen(!forgotOpen)} disabled={action.busy}>
          忘记密码？
        </button>
      </>}
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
  if (section === 'tasks') return <Tasks scope={scope} role={workspace.role} initialId={itemId} trial={workspace.trial}
    openManuscripts={openManuscripts} counts={summary.data?.taskCounts} refreshSummary={summary.refresh} />;
  if (section === 'performance') return <Performance scope={scope} role={workspace.role} initialAccount={itemId} openTask={openTasks} />;
  if (section === 'members') return <Members scope={scope} />;
  if (section === 'notifications') return workspace.trial ? <>
    <PageHeader title="飞书提醒演练" description="交接提醒和 2 分钟未回填提醒会在任务详情里生成模拟投递记录。" />
    <p className="muted">要在飞书群里收到消息，请切回正式工作室，保存群机器人地址后点击「发一条测试消息」。</p>
    <div className="actions"><button type="button" className="button" onClick={() => openTasks('')}>查看发布任务</button></div>
  </> : <FeishuSettings scope={scope} />;
  return <Accounts scope={scope} canManage={canEdit(workspace.role)} canConfigure={workspace.role === 'owner'}
    canReportRisk={canRecord(workspace.role)} trial={workspace.trial} resource={accounts} openPerformance={openPerformance} />;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>();
  const [showSignIn, setShowSignIn] = useState(false);
  const [startupError, setStartupError] = useState('');
  const [authorizationFeedback, setAuthorizationFeedback] = useState<{ workspaceId: string | null; status: string; message: string }>();
  const [navigation, setNavigation] = useState(emptyNavigation);
  const activeNavigation = useRef({ userId: '', value: emptyNavigation });
  const [drafts] = useState<ManuscriptDrafts>(() => new Map());
  const logout = useAction();
  const trialAction = useAction();
  const workspace = session?.workspaces.find(({ id }) => id === navigation.workspaceId) ?? session?.workspaces[0];
  const summary = useResource<WorkbenchSummary>(workspace ? scopeFor(workspace.id) + '/workbench-summary' : null, 15_000);

  const restoreNavigation = useCallback((userId: string, workspaces: Workspace[] = []) => {
    let value = userId ? readNavigation(userId) : emptyNavigation;
    if (userId) {
      const url = new URL(window.location.href);
      const status = url.searchParams.get('bilibiliAuthorization');
      const workspaceId = url.searchParams.get('workspace');
      if (status && Object.hasOwn(bilibiliMessages, status)) {
        if (workspaceId && workspaces.some((team) => team.id === workspaceId && !team.trial && canEdit(team.role))) {
          value = { workspaceId, locations: { ...value.locations, [workspaceId]: { ...value.locations[workspaceId], section: 'accounts' } } };
          try { localStorage.setItem(navigationKey(userId), JSON.stringify(value)); } catch {}
          setAuthorizationFeedback({ status, workspaceId, message: bilibiliMessages[status]! });
        } else if (status === 'expired') {
          setAuthorizationFeedback({ status, workspaceId: null, message: bilibiliMessages[status]! });
        }
        url.searchParams.delete('bilibiliAuthorization');
        url.searchParams.delete('workspace');
        window.history.replaceState(window.history.state, '', url);
      }
    } else {
      setAuthorizationFeedback(undefined);
    }
    activeNavigation.current = { userId, value };
    setNavigation(value);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const expired = () => { drafts.clear(); restoreNavigation(''); setStartupError('登录已过期，请重新登录。'); setShowSignIn(true); setSession(null); };
    window.addEventListener('matrixark-session-expired', expired);
    void api<Session>('/auth/me', { signal: controller.signal }).then((current) => {
      if (!controller.signal.aborted) {
        restoreNavigation(current.user.id, current.workspaces);
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
      restoreNavigation(next.user.id, next.workspaces);
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
  function enterTrial() {
    void trialAction.run(async () => {
      const { manuscriptId, ...trial } = await post<Workspace & { manuscriptId: string | null }>('/workspaces/trial', {});
      if (activeNavigation.current.userId !== userId) return;
      setSession((current) => current?.user.id === userId && !current.workspaces.some(({ id }) => id === trial.id)
        ? { ...current, workspaces: [...current.workspaces, trial] } : current);
      const latest = activeNavigation.current.value;
      remember({ workspaceId: trial.id, locations: { ...latest.locations,
        [trial.id]: latest.locations[trial.id] ?? { section: 'manuscripts', itemId: manuscriptId ?? undefined } } });
    });
  }

  const handoff = workspace && canRecord(workspace.role) ? summary.data?.taskCounts.handed_off ?? 0 : 0;
  const unknown = workspace && canEdit(workspace.role) ? summary.data?.taskCounts.unknown ?? 0 : 0;
  const review = summary.data?.pendingReview ?? 0;
  const riskAccounts = summary.data?.riskAccounts ?? 0;
  return <Workbench sections={sections} section={section} onSection={openSection}
    badges={{
      manuscripts: { count: review, label: `${review} 篇原稿待审核` },
      tasks: { count: handoff + unknown, label: [handoff && `${handoff} 项待回填`, unknown && `${unknown} 项待核实`].filter(Boolean).join(' · ') },
      accounts: { count: riskAccounts, label: `${riskAccounts} 个账号存在风险或预警` },
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
    topbar={<>
      {session.trialAvailable && !workspace?.trial && <button type="button" className="button compact" onClick={enterTrial} disabled={trialAction.busy}>
        {trialAction.busy ? '正在准备…' : '进入试用工作室'}
      </button>}
      {workspace && <span className="workspace-role"><CircleUserRound size={15} aria-hidden="true" />{workspace.trial ? '模拟演练' : roleLabel[workspace.role]}</span>}
    </>}>
    <Feedback error={trialAction.error} />
    {authorizationFeedback && (authorizationFeedback.workspaceId === null
      || (authorizationFeedback.workspaceId === workspace?.id && section === 'accounts')) && <Feedback
        error={authorizationFeedback.status === 'connected' ? undefined : authorizationFeedback.message}
        notice={authorizationFeedback.status === 'connected' ? authorizationFeedback.message : undefined} />}
    {workspace?.trial && <div className="feedback">
      <span>试用工作室 · 小红书练习审核与人工回填，B 站演示模拟投稿，飞书提醒记录在任务详情。</span>
      {section !== 'tasks' && <button type="button" className="button compact" onClick={() => openSection('tasks')}>查看示例任务</button>}
    </div>}
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
