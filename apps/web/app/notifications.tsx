import { useState, type FormEvent } from 'react';
import { api, post, useAction, useResource } from './api';
import { Feedback, Loading, PageHeader } from './ui';

type FeishuSetting = { enabled: boolean; riskAlertEnabled?: boolean; webhookConfigured: boolean; signatureConfigured: boolean };

export function FeishuSettings({ scope }: { scope: string }) {
  const path = scope + '/notifications/feishu';
  const resource = useResource<FeishuSetting>(path);
  const action = useAction();
  const [dirty, setDirty] = useState(false);
  const setting = resource.data;
  const busy = action.busy || resource.loading;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const webhook = String(fields.get('webhook') ?? '').trim();
    const signSecret = String(fields.get('signSecret') ?? '').trim();
    void action.run(async () => {
      await api(path, { method: 'PATCH', body: {
        enabled: fields.has('enabled'),
        riskAlertEnabled: fields.has('riskAlertEnabled'),
        webhook: webhook || undefined,
        signSecret: signSecret || (fields.has('clearSignature') ? null : undefined),
      } });
      form.reset();
      setDirty(false);
      resource.refresh();
    }, '飞书提醒设置已保存。');
  }

  function sendTest() {
    void action.run(async () => {
      await post(path + '/test', {});
    }, '飞书已接收测试消息，请到群里确认。');
  }

  return <>
    <PageHeader title="飞书提醒" description="人工任务到点交接时发一次提醒，4 小时仍未回填时再提醒一次。" />
    <div className="notification-settings">
      <section className="card" aria-labelledby="feishu-settings-title">
        <div className="card-heading">
          <h2 id="feishu-settings-title">连接群机器人</h2>
          {setting && <span className={`badge ${setting.enabled ? 'green' : 'gray'}`}>
            {setting.enabled ? '提醒已开启' : setting.webhookConfigured ? '提醒已关闭' : '待连接'}
          </span>}
        </div>
        <div className="detail-content">
          {resource.loading && !setting && <Loading />}
          <Feedback error={action.error || resource.error} notice={action.notice} />
          {!setting && resource.error && <button type="button" className="button" onClick={resource.refresh}>重新加载</button>}
          {setting && <form key={JSON.stringify(setting)} className="form-stack" onSubmit={save} onChange={() => {
            setDirty(true);
            action.reset();
          }}>
            <label>机器人地址（Webhook）<small>{setting.webhookConfigured ? '已保存。留空保留原地址。' : '粘贴从飞书群复制的机器人地址。'}</small>
              <input name="webhook" type="password" autoComplete="off" maxLength={250} spellCheck={false}
                required={!setting.webhookConfigured} disabled={busy} />
            </label>
            <label>签名密钥 <small>{setting.signatureConfigured ? '已保存。留空保留原密钥。' : '飞书群机器人开启签名校验时才需要填写。'}</small>
              <input name="signSecret" type="password" autoComplete="new-password" maxLength={256} disabled={busy} />
            </label>
            {setting.signatureConfigured && <label className="checkbox-field">
              <input name="clearSignature" type="checkbox" disabled={busy} />清除已保存的签名密钥
            </label>}
            <label className="checkbox-field"><input name="enabled" type="checkbox" defaultChecked={setting.enabled}
              disabled={busy} />给本工作室发送任务提醒</label>
            <label className="checkbox-field"><input name="riskAlertEnabled" type="checkbox" defaultChecked={setting.riskAlertEnabled ?? true}
              disabled={busy} />账号异常、Cookie 失效或触发风控时自动推送飞书告警</label>
            <div className="actions">
              <button className="button primary" disabled={busy || !dirty}>保存设置</button>
              <button type="button" className="button" disabled={busy || !setting.webhookConfigured || dirty}
                onClick={sendTest}>发一条测试消息</button>
            </div>
            {(!setting.webhookConfigured || dirty) && <p className="muted small">保存设置后可以向群里发一条测试消息。</p>}
          </form>}
        </div>
      </section>
      <aside className="card form-card form-stack" aria-labelledby="feishu-guide-title">
        <h2 id="feishu-guide-title">怎么找到机器人地址</h2>
        <ol className="notification-steps">
          <li>打开要接收提醒的飞书群，进入群设置。</li>
          <li>选择「群机器人 → 添加机器人 → 自定义机器人」。</li>
          <li>复制 Webhook 地址并粘贴到这里。如果打开了签名校验，也复制签名密钥。</li>
        </ol>
        <a className="text-button" href="https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN"
          target="_blank" rel="noreferrer">查看飞书图文指南</a>
      </aside>
    </div>
  </>;
}
