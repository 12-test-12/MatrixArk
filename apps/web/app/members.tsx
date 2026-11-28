import { useMemo, useState, type FormEvent } from 'react';
import { Eye, Search, ShieldCheck, Trash2, UserCheck, UserPlus, UsersRound, X } from 'lucide-react';
import { api, post, roleLabel, useAction, useResource, type Role } from './api';
import { askConfirm } from './confirm-dialog';
import { Empty, Feedback, Loading, PageHeader, StatGrid, type StatCardItem } from './ui';

type Member = { id: string; role: Role; user: { id: string; name: string; email: string } };
const assignable = ['editor', 'reviewer', 'operator', 'viewer'] as const;
const allRoles: Role[] = ['owner', 'editor', 'reviewer', 'operator', 'viewer'];
const roleOptions = assignable.map((role) => <option key={role} value={role}>{roleLabel[role]}</option>);

const roleBadgeTone: Record<Role, string> = {
  owner: 'violet',
  editor: 'sky',
  reviewer: 'green',
  operator: 'amber',
  viewer: 'gray',
};

// Mirror apps/api/src/common/permissions.ts (read-only UI reference)
const permissionRows: { label: string; allowed: readonly Role[] }[] = [
  { label: '选题与原稿创作', allowed: ['owner', 'editor'] },
  { label: '版本审核与退回', allowed: ['owner', 'editor', 'reviewer'] },
  { label: '发布排期与任务调度', allowed: ['owner', 'editor'] },
  { label: '人工交接与回执回填', allowed: ['owner', 'editor', 'operator'] },
  { label: '账号与矩阵组配置（凭据只写）', allowed: ['owner', 'editor'] },
  { label: '后台运行监控', allowed: ['owner', 'operator'] },
  { label: '飞书提醒与 AI 模型设置', allowed: ['owner'] },
  { label: '工作室成员管理', allowed: ['owner'] },
];

const collaborationSteps = [
  { step: '1', title: '编辑创作与排期', detail: '整理选题、撰写多平台版本，审核通过后为指定账号排期。' },
  { step: '2', title: '审核员逐版核验', detail: '核对标题、正文、配图顺序与封面规则，通过锁定快照或退回修改。' },
  { step: '3', title: '运营人工交接回填', detail: '取用已审交接包并在平台侧完成发布，及时回填链接、截图与成效。' },
  { step: '4', title: '负责人统筹权限与监控', detail: '管理成员角色、模型/飞书配置与 Worker 异常告警，保障多工作室隔离。' },
] as const;

export function Members({ scope, role, currentUserId }: { scope: string; role: Role; currentUserId: string }) {
  const path = scope + '/members';
  const members = useResource<Member[]>(path);
  const action = useAction();
  const [keyword, setKeyword] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | Role>('all');
  const canManageMembers = role === 'owner';

  const items = useMemo(() => members.data ?? [], [members.data]);
  const counts = useMemo(() => {
    const map: Record<Role, number> = { owner: 0, editor: 0, reviewer: 0, operator: 0, viewer: 0 };
    for (const m of items) map[m.role] = (map[m.role] ?? 0) + 1;
    return map;
  }, [items]);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return items.filter((m) => {
      if (roleFilter !== 'all' && m.role !== roleFilter) return false;
      if (!q) return true;
      return m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q);
    });
  }, [items, keyword, roleFilter]);

  const stats: StatCardItem[] = [
    {
      key: 'all',
      label: '成员总数',
      value: members.data ? items.length : '—',
      note: '当前工作室已授权成员',
      icon: UsersRound,
      tone: 'neutral',
      active: roleFilter === 'all',
      onClick: () => setRoleFilter('all'),
    },
    {
      key: 'owner',
      label: '负责人',
      value: members.data ? counts.owner : '—',
      note: '成员与全局配置受保护',
      icon: ShieldCheck,
      tone: 'violet',
      active: roleFilter === 'owner',
      onClick: () => setRoleFilter(roleFilter === 'owner' ? 'all' : 'owner'),
    },
    {
      key: 'editor',
      label: '编辑',
      value: members.data ? counts.editor : '—',
      note: '创作、生成版本与排期',
      icon: UserPlus,
      tone: 'sky',
      active: roleFilter === 'editor',
      onClick: () => setRoleFilter(roleFilter === 'editor' ? 'all' : 'editor'),
    },
    {
      key: 'reviewer',
      label: '审核员',
      value: members.data ? counts.reviewer : '—',
      note: '审核版本快照并给出意见',
      icon: UserCheck,
      tone: 'green',
      active: roleFilter === 'reviewer',
      onClick: () => setRoleFilter(roleFilter === 'reviewer' ? 'all' : 'reviewer'),
    },
    {
      key: 'operator',
      label: '运营与只读',
      value: members.data ? counts.operator + counts.viewer : '—',
      note: `运营 ${counts.operator} · 只读 ${counts.viewer}`,
      icon: Eye,
      tone: 'amber',
      active: roleFilter === 'operator' || roleFilter === 'viewer',
      onClick: () => setRoleFilter(roleFilter === 'operator' ? 'viewer' : roleFilter === 'viewer' ? 'all' : 'operator'),
    },
  ];

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    void action.run(async () => {
      await post(path, fields);
      form.reset();
      members.refresh();
    }, '成员已添加到当前工作室。');
  }

  function update(event: FormEvent<HTMLFormElement>, member: Member) {
    event.preventDefault();
    const nextRole = new FormData(event.currentTarget).get('role');
    if (nextRole === member.role) return;
    void action.run(async () => {
      await api(path + '/' + encodeURIComponent(member.id), { method: 'PATCH', body: { role: nextRole } });
      members.refresh();
    }, `${member.user.name} 的角色已更新。`);
  }

  async function removeMember(member: Member) {
    const ok = await askConfirm({
      tone: 'danger',
      badge: '权限回收',
      title: '移出工作室成员？',
      target: `${member.user.name}（${member.user.email}）`,
      description: '移除后该成员将立即失去当前工作室的所有页面访问与协作操作权限。',
      impacts: [
        `当前持有角色：${roleLabel[member.role]}`,
        '仅移出本工作室，不影响对方在其他工作室的身份与数据',
        '历史审稿、发布回执与操作审计记录将继续保留',
      ],
      confirmLabel: '确认移出成员',
    });
    if (!ok) return;
    void action.run(async () => {
      await api(path + '/' + encodeURIComponent(member.id), { method: 'DELETE' });
      members.refresh();
    }, `已将 ${member.user.name} 移出当前工作室。`);
  }

  return <>
    <PageHeader title="团队成员" description="按工作室隔离管理成员与 RBAC 角色权限，保障负责人保底约束与操作可追溯。" />
    <StatGrid items={stats} columns={5} label="团队成员角色统计" />
    <Feedback error={action.error || members.error} notice={action.notice} />

    <div className="admin-split-grid">
      <section className="card item-list" aria-labelledby="members-list-title">
        <div className="card-heading">
          <div className="card-heading-title">
            <span className="card-heading-icon"><UsersRound size={16} aria-hidden="true" /></span>
            <div>
              <h2 id="members-list-title">成员列表</h2>
              <p className="card-heading-sub">仅展示当前工作室内有访问权限的成员账号</p>
            </div>
          </div>
          <span className="count">{filtered.length} / {items.length}</span>
        </div>

        <div className="list-toolbar">
          <label className="toolbar-field toolbar-search">
            <span className="toolbar-label">搜索成员</span>
            <span className="search-box">
              <Search size={14} className="search-icon" aria-hidden="true" />
              <input
                type="text"
                placeholder="按姓名或邮箱筛选…"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                aria-label="搜索成员姓名或邮箱"
              />
              {keyword && (
                <button type="button" className="clear-btn" onClick={() => setKeyword('')} aria-label="清除搜索">
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </span>
          </label>
          <label className="toolbar-field toolbar-platform">
            <span className="toolbar-label">角色筛选</span>
            <select
              className="platform-select"
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value as 'all' | Role)}
              aria-label="按成员角色筛选"
            >
              <option value="all">全部角色</option>
              {allRoles.map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
            </select>
          </label>
        </div>

        {members.loading && !members.data ? <Loading /> : filtered.length ? (
          <div className="table-well">
            <div className="table-scroll" role="region" aria-label="工作室成员表格" tabIndex={0}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">成员</th>
                    <th scope="col">当前角色</th>
                    <th scope="col">角色调整与管理</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((member) => {
                    const isSelf = member.user.id === currentUserId;
                    const isOwner = member.role === 'owner';
                    return (
                      <tr key={member.id}>
                        <th scope="row">
                          <div className="member-user-cell">
                            <span className="avatar" aria-hidden="true">{Array.from(member.user.name)[0] || 'M'}</span>
                            <div>
                              <strong>{member.user.name}{isSelf ? '（当前账号）' : ''}</strong>
                              <small>{member.user.email}</small>
                            </div>
                          </div>
                        </th>
                        <td>
                          <span className={`badge ${roleBadgeTone[member.role]}`}>
                            <span className="badge-dot" aria-hidden="true" />{roleLabel[member.role]}
                          </span>
                        </td>
                        <td>
                          {!canManageMembers ? (
                            <span className="muted small">仅负责人可调整</span>
                          ) : isOwner ? (
                            <span className="muted small">负责人角色受保底保护</span>
                          ) : (
                            <div className="actions">
                              <form className="member-role" onSubmit={(event) => update(event, member)}>
                                <select
                                  key={member.role}
                                  name="role"
                                  aria-label={`${member.user.name} 的角色`}
                                  defaultValue={member.role}
                                  disabled={action.busy}
                                >
                                  {roleOptions}
                                </select>
                                <button className="button compact" disabled={action.busy} aria-label={`保存 ${member.user.name} 的角色`}>
                                  保存角色
                                </button>
                              </form>
                              {!isSelf && (
                                <button type="button" className="button compact danger-outline" disabled={action.busy}
                                  aria-label={`移除成员 ${member.user.name}`}
                                  onClick={() => void removeMember(member)}>
                                  <Trash2 size={13} aria-hidden="true" />移除
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : !members.error && (
          <Empty icon={UsersRound} title={keyword || roleFilter !== 'all' ? '未找到匹配成员' : '暂无成员'}>
            {(keyword || roleFilter !== 'all') && (
              <button type="button" className="button compact" onClick={() => { setKeyword(''); setRoleFilter('all'); }}>
                重置筛选条件
              </button>
            )}
          </Empty>
        )}
      </section>

      <div className="admin-side-stack">
        <section className="card form-card" aria-labelledby="member-add-title">
          <div className="card-heading">
            <h2 id="member-add-title">添加已注册成员</h2>
            <span className="badge gray">工作室内部</span>
          </div>
          <div className="detail-content">
            <form className="form-stack" onSubmit={add}>
              <label>成员邮箱
                <input name="email" type="email" required autoComplete="off" placeholder="name@example.com" disabled={action.busy || !canManageMembers} />
              </label>
              <label>分配角色
                <select name="role" defaultValue="viewer" disabled={action.busy || !canManageMembers}>{roleOptions}</select>
              </label>
              <p className="muted small">
                {canManageMembers
                  ? '需使用对方已在工作台注册的邮箱添加；邮件邀请链路暂未接入，未注册邮箱将提示先完成注册。'
                  : '当前角色无成员管理权限，请联系负责人添加或调整成员。'}
              </p>
              <button className="button primary" disabled={action.busy || !canManageMembers}>
                {action.busy ? '正在添加…' : '添加成员'}
              </button>
            </form>
          </div>
        </section>

        <section className="card" aria-labelledby="permission-matrix-title">
          <div className="card-heading">
            <h2 id="permission-matrix-title">角色与权限矩阵</h2>
            <span className="badge violet">后端 RBAC 口径</span>
          </div>
          <div className="detail-content">
            <div className="table-scroll" role="region" aria-label="角色权限对照表" tabIndex={0}>
              <table className="permission-table">
                <thead>
                  <tr>
                    <th scope="col">能力范围</th>
                    {allRoles.map((r) => <th scope="col" key={r}>{roleLabel[r]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {permissionRows.map((perm) => (
                    <tr key={perm.label}>
                      <th scope="row">{perm.label}</th>
                      {allRoles.map((r) => {
                        const ok = perm.allowed.includes(r);
                        return (
                          <td key={r} className={ok ? 'permission-yes' : 'permission-no'} aria-label={`${roleLabel[r]}：${ok ? '有权限' : '无权限'}`}>
                            {ok ? '✓' : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              安全边界：账号凭据（密码 / Cookie / Token）在服务端采用只写隔离，不提供明文读取接口；<code>account:manage</code> 仅限负责人与编辑调整配置与排期能力。
            </p>
          </div>
        </section>
      </div>
    </div>

    <section className="collab-flow" aria-label="工作室角色协作流程">
      {collaborationSteps.map((item) => (
        <div className="collab-step" key={item.step}>
          <div className="collab-step-head">
            <span className="collab-step-index">{item.step}</span>
            <span>{item.title}</span>
          </div>
          <p>{item.detail}</p>
        </div>
      ))}
    </section>
  </>;
}
