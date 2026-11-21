import type { FormEvent } from 'react';
import { UsersRound } from 'lucide-react';
import { api, post, roleLabel, useAction, useResource, type Role } from './api';
import { Empty, Feedback, Loading, PageHeader } from './ui';

type Member = { id: string; role: Role; user: { id: string; name: string; email: string } };
const assignable = ['editor', 'reviewer', 'operator', 'viewer'] as const;
const roleOptions = assignable.map((role) => <option key={role} value={role}>{roleLabel[role]}</option>);

export function Members({ scope }: { scope: string }) {
  const path = scope + '/members';
  const members = useResource<Member[]>(path);
  const action = useAction();
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    void action.run(async () => {
      await post(path, fields);
      form.reset();
      members.refresh();
    }, '成员已添加。');
  }
  function update(event: FormEvent<HTMLFormElement>, member: Member) {
    event.preventDefault();
    const role = new FormData(event.currentTarget).get('role');
    if (role === member.role) return;
    void action.run(async () => {
      await api(path + '/' + encodeURIComponent(member.id), { method: 'PATCH', body: { role } });
      members.refresh();
    }, `${member.user.name}的角色已更新。`);
  }

  return <>
    <PageHeader title="团队成员" description="按工作室分配角色。成员登录后会看到该角色的工作入口。" />
    <form className="card form-card form-stack" onSubmit={add}>
      <h2>添加已注册成员</h2>
      <div className="form-row">
        <label>成员邮箱<input name="email" type="email" required placeholder="name@example.com" disabled={action.busy} /></label>
        <label>分配角色<select name="role" defaultValue="viewer" disabled={action.busy}>{roleOptions}</select></label>
      </div>
      <button className="button primary" disabled={action.busy}>添加成员</button>
    </form>
    <Feedback error={action.error || members.error} notice={action.notice} />
    <section className="card">
      <div className="card-heading"><h2>成员列表</h2></div>
      {members.loading ? <Loading /> : members.data?.length ? members.data.map((member) => <div className="account-row member-row" key={member.id}>
        <span className="avatar" aria-hidden="true">{Array.from(member.user.name)[0] || 'M'}</span>
        <div><strong>{member.user.name}</strong><small>{member.user.email}</small></div>
        {member.role === 'owner' ? <span className="badge gray">{roleLabel.owner}</span> :
          <form className="member-role" onSubmit={(event) => update(event, member)}>
            <select key={member.role} name="role" aria-label={`${member.user.name}的角色`} defaultValue={member.role} disabled={action.busy}>
              {roleOptions}
            </select>
            <button className="button compact" disabled={action.busy} aria-label={`保存${member.user.name}的角色`}>保存角色</button>
          </form>}
      </div>) : !members.error && <Empty icon={UsersRound} title="暂无成员" />}
    </section>
  </>;
}
