import { useId, useState, type FormEvent } from 'react';
import { api, formatTime, post, useAction, useResource } from './api';
import { pushToast } from './toast';
import { askConfirm } from './confirm-dialog';
import { Feedback, Loading } from './ui';
import { TopicChanges } from './topic-insights';

const targets = {
  youtube: { label: 'YouTube 频道', hint: '输入以 UC 开头的公开频道 ID。', placeholder: 'UC…' },
  mastodon: { label: 'Mastodon 博主或话题', hint: '输入 mastodon.social 上的 @用户名 或 #话题。', placeholder: '@博主或 #话题' },
  'google-trends': { label: 'Google 热搜', hint: '输入两位地区代码，例如 HK、TW、US。', placeholder: 'HK' },
  rss: { label: '其他 RSS 或 Atom', hint: '输入管理员已配置的公开 HTTPS 订阅地址。', placeholder: 'https://…' },
};
type Provider = keyof typeof targets;
type Source = {
  id: string; provider: Provider; target: string; keyword: string; enabled: boolean;
  nextRunAt: string; leaseUntil: string | null; lastSuccessAt: string | null; lastError: string | null; lastCount: number;
};

export function TopicSources({ scope, refreshWorks }: { scope: string; refreshWorks: () => void }) {
  const path = scope + '/topics/sources';
  const sources = useResource<Source[]>(path, 10_000);
  const action = useAction();
  const [provider, setProvider] = useState<Provider>('youtube');
  const [notice, setNotice] = useState('');
  const hintId = useId();

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setNotice('');
    void action.run(async () => {
      await post(path, { provider, target: data.get('target'), keyword: data.get('keyword') });
      sources.refresh();
      form.reset();
      const msg = '采集任务已保存。Worker 会自动拉取，也可点击「立即采集」。';
      setNotice(msg);
      pushToast(msg, 'success');
    });
  }
  function sync(id: string) {
    setNotice('');
    void action.run(async () => {
      const result = await post<{ status: 'ok' | 'busy' | 'failed'; count?: number; reason?: string }>(path + '/' + id + '/sync', {});
      sources.refresh();
      if (result.status === 'failed') throw new Error(result.reason || '采集失败');
      if (result.status === 'busy') {
        const busyMsg = '采集正在运行，或刚执行过，请稍等再试。';
        setNotice(busyMsg);
        pushToast(busyMsg, 'info');
        return;
      }
      refreshWorks();
      const okMsg = `已采集 ${result.count ?? 0} 条匹配内容。`;
      setNotice(okMsg);
      pushToast(okMsg, 'success');
    });
  }

  async function remove(source: Source) {
    const ok = await askConfirm({
      tone: 'danger',
      badge: '停止并删除',
      title: '删除采集任务？',
      target: `${targets[source.provider]?.label ?? source.provider} · ${source.target}`,
      description: '删除后 Worker 将停止继续拉取该来源的新作品。',
      impacts: [
        '已采集入库的作品、截图与 AI 分析记录保留在选题台',
        '如有需要，后续可随时重新添加同名来源任务',
      ],
      confirmLabel: '确认删除任务',
    });
    if (!ok) return;
    setNotice('');
    void action.run(async () => {
      await api(path + '/' + source.id, { method: 'DELETE' });
      sources.refresh();
      setNotice('采集任务已删除。');
      pushToast('采集任务已删除。', 'success');
    });
  }

  return <section className="card form-card form-stack" id="topic-collection">
    <h2>采集任务</h2>
    <form className="form-stack" onSubmit={add}>
      <div className="form-row">
        <label>来源<select name="provider" value={provider} disabled={action.busy} onChange={(event) => {
          setProvider(event.target.value as Provider);
          setNotice(''); action.reset();
        }}>
          {Object.entries(targets).map(([id, source]) => <option key={id} value={id}>{source.label}</option>)}
        </select></label>
        <label>采集目标<input key={provider} name="target" required maxLength={300} aria-describedby={hintId}
          placeholder={targets[provider].placeholder} disabled={action.busy} /></label>
      </div>
      <p id={hintId} className="muted small">{targets[provider].hint}</p>
      <label>只采集含有的关键词 <small>选填</small><input name="keyword" maxLength={80} disabled={action.busy}
        placeholder="例如 城市骑行" /></label>
      <div className="actions"><button type="submit" className="button primary" disabled={action.busy}>添加采集任务</button></div>
    </form>
    <Feedback error={action.error || sources.error} notice={notice} />
    {sources.loading && <Loading />}
    {sources.data?.map((source) => {
      const collecting = Boolean(source.leaseUntil && Date.parse(source.leaseUntil) > Date.now());
      return <div className="field-group" key={source.id}>
        <strong>{targets[source.provider]?.label ?? source.provider} · {source.target}</strong>
        {source.keyword && <small>关键词「{source.keyword}」</small>}
        <p className="muted small">
          {!source.enabled ? '已暂停' : collecting ? '正在采集' : `下次 ${formatTime(source.nextRunAt)}`}
          {source.lastSuccessAt && ` · 上次成功 ${formatTime(source.lastSuccessAt)} · ${source.lastCount} 条`}
        </p>
        {source.lastError && <p className="muted small">{source.lastError}</p>}
        <div className="actions">
          {source.enabled && <button type="button" className="button compact" disabled={action.busy || collecting}
            onClick={() => sync(source.id)}>立即采集</button>}
          <button type="button" className="button compact" disabled={action.busy} onClick={() => {
            setNotice('');
            void action.run(async () => {
              await api(path + '/' + source.id, { method: 'PATCH', body: { enabled: !source.enabled } });
              sources.refresh();
            });
          }}>{source.enabled ? '暂停采集' : '恢复采集'}</button>
          <button type="button" className="button compact" disabled={action.busy}
            aria-label={`删除采集任务：${source.target}${source.keyword ? `（${source.keyword}）` : ''}`}
            onClick={() => remove(source)}>删除任务</button>
        </div>
        <TopicChanges path={path + '/' + source.id} />
      </div>;
    })}
  </section>;
}
