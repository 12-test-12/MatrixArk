import { useState, type FormEvent } from 'react';
import { api, useAction, type Session } from './api';
import { Feedback, PageHeader } from './ui';

export function Profile({ user, onSave }: { user: Session['user']; onSave: (user: Session['user']) => void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const action = useAction();
  const emailChanged = email.trim().toLowerCase() !== user.email;

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

  return <>
    <PageHeader title="个人资料" description="修改工作台显示的姓名和登录邮箱。" />
    <section className="card form-card profile-settings" aria-label="修改个人资料">
      <form className="form-stack" onSubmit={save} onChange={action.reset}>
        <label>姓名<input name="name" autoComplete="name" required maxLength={40}
          value={name} disabled={action.busy} onChange={(event) => setName(event.currentTarget.value)} /></label>
        <label>登录邮箱<input name="email" autoComplete="email" type="email" required
          value={email} disabled={action.busy} onChange={(event) => setEmail(event.currentTarget.value)} /></label>
        {emailChanged && <label>当前密码<small>用于确认是你本人在修改登录邮箱。</small>
          <input name="currentPassword" type="password" autoComplete="current-password" maxLength={72} required disabled={action.busy} />
        </label>}
        <Feedback error={action.error} notice={action.notice} />
        <button className="button primary" disabled={action.busy || (name.trim() === user.name && !emailChanged)}>
          {action.busy ? '正在保存…' : '保存个人资料'}
        </button>
      </form>
    </section>
  </>;
}
