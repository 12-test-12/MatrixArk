import { useState, type FormEvent } from 'react';
import { ArrowRight, Bell, CheckCircle2, KeyRound, Send, ShieldAlert } from 'lucide-react';
import { api, post, useAction, useResource, type WorkbenchSummary } from './api';
import { Feedback, Loading, PageHeader, StatGrid, type StatCardItem } from './ui';

type FeishuSetting = { enabled: boolean; riskAlertEnabled?: boolean; webhookConfigured: boolean; signatureConfigured: boolean };

export function FeishuSettings({ scope, summary, openTasks }: {
  scope: string;
  summary?: WorkbenchSummary;
  openTasks?: (id: string) => void;
}) {
  const path = scope + '/notifications/feishu';
  const resource = useResource<FeishuSetting>(path);
  const action = useAction();
  const [dirty, setDirty] = useState(false);
  const setting = resource.data;
  const busy = action.busy || resource.loading;

  const activeRuleCount = setting
    ? Number(setting.enabled) + Number(setting.riskAlertEnabled ?? true)
    : null;
  const handoffCount = summary?.taskCounts.handed_off ?? 0;
  const unknownCount = summary?.taskCounts.unknown ?? 0;

  const stats: StatCardItem[] = [
    {
      key: 'connection',
      label: '提醒推送状态',
      value: !setting ? '—' : setting.enabled ? '已开启' : setting.webhookConfigured ? '已保存' : '待配置',
      note: !setting ? '等待读取配置' : setting.enabled ? '提醒开关已打开，实际送达以任务回执为准' : setting.webhookConfigured ? '已存 Webhook，提醒未开启' : '尚未保存群机器人地址',
      icon: Bell,
      tone: !setting ? 'neutral' : setting.enabled ? 'green' : setting.webhookConfigured ? 'amber' : 'neutral',
    },
    {
      key: 'signature',
      label: '签名安全校验',
      value: !setting ? '—' : setting.signatureConfigured ? '已开启' : '未配置',
      note: '密钥只写加密存储，不回传明文',
      icon: KeyRound,
      tone: !setting ? 'neutral' : setting.signatureConfigured ? 'violet' : 'neutral',
    },
    {
      key: 'rules',
      label: '已启用通知规则',
      value: activeRuleCount === null ? '—' : `${activeRuleCount} / 2`,
      note: '对应任务交接提醒与账号风险告警',
      icon: CheckCircle2,
      tone: activeRuleCount ? 'sky' : 'neutral',
    },
    {
      key: 'backlog',
      label: '当前待关注任务',
      value: summary ? handoffCount + unknownCount : '—',
      note: summary ? `待回填 ${handoffCount} · 待核实 ${unknownCount}` : '任务明细在发布任务页查看',
      icon: ShieldAlert,
      tone: handoffCount + unknownCount > 0 ? 'amber' : 'neutral',
    },
  ];

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
    <PageHeader title="飞书提醒" description="管理工作室群机器人连接与触发规则；Webhook 与签名密钥均严格脱敏存储。" />
    <StatGrid items={stats} columns={4} label="飞书提醒配置与待处理状态" />

    <div className="admin-split-grid">
      <section className="card" aria-labelledby="feishu-settings-title">
        <div className="card-heading">
          <div className="card-heading-title">
            <span className="card-heading-icon"><Bell size={16} aria-hidden="true" /></span>
            <div>
              <h2 id="feishu-settings-title">机器人连接与通知规则</h2>
              <p className="card-heading-sub">保存设置后可发送测试消息验证连通性</p>
            </div>
          </div>
          {setting && <span className={`badge ${setting.enabled ? 'green' : setting.webhookConfigured ? 'amber' : 'gray'}`}>
            <span className="badge-dot" aria-hidden="true" />
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
            <label>机器人地址（Webhook）<small>{setting.webhookConfigured ? '已加密保存，留空保留原地址。' : '粘贴从飞书群复制的自定义机器人 HTTPS 地址。'}</small>
              <input name="webhook" type="password" autoComplete="off" maxLength={250} spellCheck={false}
                placeholder={setting.webhookConfigured ? '已配置（如需替换请重新粘贴）' : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'}
                required={!setting.webhookConfigured} disabled={busy} />
            </label>
            <label>签名密钥 <small>{setting.signatureConfigured ? '已加密保存，留空保留原密钥。' : '飞书群机器人开启签名校验时填写。'}</small>
              <input name="signSecret" type="password" autoComplete="new-password" maxLength={256}
                placeholder={setting.signatureConfigured ? '已启用签名密钥' : '选填'} disabled={busy} />
            </label>
            {setting.signatureConfigured && <label className="checkbox-field">
              <input name="clearSignature" type="checkbox" disabled={busy} />清除已保存的签名密钥
            </label>}

            <div className="notify-rule-list" role="group" aria-label="飞书触发规则">
              <div className="notify-rule-item">
                <div>
                  <strong>人工交接与 4 小时未回填提醒</strong>
                  <small>任务到达交接点即时提醒，超过 4 小时未回填时触发二次提醒。</small>
                </div>
                <label className="checkbox-field">
                  <input name="enabled" type="checkbox" defaultChecked={setting.enabled} disabled={busy} />开启
                </label>
              </div>
              <div className="notify-rule-item">
                <div>
                  <strong>账号异常、Cookie 失效与风控告警</strong>
                  <small>巡检或上报触发预警/风控时立即推送工作室飞书群。</small>
                </div>
                <label className="checkbox-field">
                  <input name="riskAlertEnabled" type="checkbox" defaultChecked={setting.riskAlertEnabled ?? true} disabled={busy} />开启
                </label>
              </div>
              <div className="notify-rule-item">
                <div>
                  <strong>每日运营摘要 / Worker 掉线独立推送</strong>
                  <small>规划能力：当前后端尚未接入独立摘要队列，暂在「运行监控」页集中巡检。</small>
                </div>
                <span className="badge gray">规划中</span>
              </div>
            </div>

            <div className="actions">
              <button className="button primary" disabled={busy || !dirty}>{action.busy ? '正在保存…' : '保存设置'}</button>
              <button type="button" className="button" disabled={busy || !setting.webhookConfigured || dirty}
                onClick={sendTest}>
                <Send size={14} aria-hidden="true" />发一条测试消息
              </button>
            </div>
            {(!setting.webhookConfigured || dirty) && <p className="muted small">保存设置后即可向群里发送测试消息；请勿在离线或超时状态未知时重复连点。</p>}
          </form>}
        </div>
      </section>

      <div className="admin-side-stack">
        <section className="card" aria-labelledby="feishu-pipeline-title">
          <div className="card-heading">
            <h2 id="feishu-pipeline-title">通知工作流与投递溯源</h2>
            <span className="badge sky">后端真实链路</span>
          </div>
          <div className="detail-content form-stack">
            <div className="notify-pipeline" aria-label="飞书通知链路">
              <span className="notify-pipeline-node">业务事件 / 风控</span>
              <ArrowRight size={14} aria-hidden="true" />
              <span className="notify-pipeline-node">通知队列（幂等防重）</span>
              <ArrowRight size={14} aria-hidden="true" />
              <span className="notify-pipeline-node">飞书群机器人</span>
            </div>
            <p className="muted small">
              系统当前按单条发布任务及风控事件记录投递状态（待投递 / 投递中 / 已送达 / 投递失败 / 已跳过）。工作室级独立投递历史列表接口尚未新增，请在任务详情与账号风险事件中查看具体回执与失败摘要。
            </p>
            {openTasks && (
              <div className="actions">
                <button type="button" className="button compact" onClick={() => openTasks('')}>
                  前往发布任务查看投递记录 <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
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
    </div>
  </>;
}
