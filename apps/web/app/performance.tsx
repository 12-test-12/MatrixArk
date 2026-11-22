import { useState, type FormEvent } from 'react';
import { BarChart3 } from 'lucide-react';
import { api, ApiError, canRecord, formatTime, post, publishPlatformLabel, useAction, useResource, type Account, type Role, type Task } from './api';
import { Empty, Feedback, Loading, PageHeader } from './ui';

const fields = [
  ['views', '阅读 / 播放'], ['likes', '点赞'], ['comments', '评论'], ['favorites', '收藏'], ['shares', '分享'],
] as const;
type MetricValues = Record<(typeof fields)[number][0], number | null>;
type Metrics = MetricValues & { source: 'manual' | 'platform'; recordedAt: string };
type MetricSnapshot = Metrics & { id: string };
type Work = Task & { result: NonNullable<Task['result']> & { metrics: Metrics | null } };
type Summary = MetricValues & { content: 'article' | 'video'; published: number; tracked: number };
type WorkPage = { items: Work[]; summary: Summary[]; nextCursor: string | null };

const number = new Intl.NumberFormat('zh-CN');
const count = (value?: number | null) => value == null ? '—' : number.format(value);

function MetricTrend({ scope, work, field, label }: {
  scope: string; work: Work; field: keyof MetricValues; label: string;
}) {
  const history = useResource<MetricSnapshot[]>(scope + '/tasks/' + encodeURIComponent(work.id) + '/metrics/history');
  const samples = history.data ?? [];
  if (history.loading) return <Loading />;
  if (history.error) return <Feedback error={history.error} />;
  const values = samples.flatMap((sample) => sample[field] === null ? [] : [sample[field]]);
  if (!values.length) return <p className="muted">还没有{label}记录。录入或同步后会在这里显示采集点。</p>;

  const width = 656;
  const left = 70;
  const right = width - 16;
  const top = 14;
  const bottom = 158;
  const start = Date.parse(samples[0]!.recordedAt);
  const end = Date.parse(samples.at(-1)!.recordedAt);
  const maximum = Math.ceil(Math.max(1, ...values) / 4) * 4;
  const points = samples.map((sample) => ({
    ...sample,
    value: sample[field],
    x: end === start ? (left + right) / 2 : left + (Date.parse(sample.recordedAt) - start) / (end - start) * (right - left),
    y: bottom - (sample[field] ?? 0) / maximum * (bottom - top),
  }));
  const path = points.map((point, index) => {
    if (point.value === null) return '';
    return `${index > 0 && points[index - 1]!.value !== null ? 'L' : 'M'}${point.x},${point.y}`;
  }).join(' ');

  return <>
    <div className="performance-trend-plot">
      <svg viewBox={`0 0 ${width} 172`} role="img" aria-label={`${work.variant.title}的${label}趋势，共 ${values.length} 次有效采集`}>
        {[4, 3, 2, 1, 0].map((step) => {
          const y = bottom - step / 4 * (bottom - top);
          return <g key={step}>
            <line className="trend-gridline" x1={left} x2={right} y1={y} y2={y} />
            <text className="trend-axis-label" x={left - 10} y={y + 4} textAnchor="end">
              {new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(step / 4 * maximum)}
            </text>
          </g>;
        })}
        <path d={path} className="trend-line" />
        {points.map((point) => point.value !== null && <circle key={point.id} className="trend-point" cx={point.x} cy={point.y} r="4">
          <title>{formatTime(point.recordedAt)} · {label} {count(point.value)} · {point.source === 'platform' ? '平台同步' : '手动录入'}</title>
        </circle>)}
      </svg>
      <div className="trend-time" aria-label="采集时间范围">
        <span>{formatTime(samples[0]!.recordedAt)}</span>
        {end !== start && <span>{formatTime(samples.at(-1)!.recordedAt)}</span>}
      </div>
    </div>
    <p className="muted small">{values.length === 1 ? '目前只有一个采集点，下次采集后可比较变化。'
      : '每个点是当时采集的累计值。缺失的指标不会连线。'}</p>
    <details className="trend-data">
      <summary>查看采集明细</summary>
      <ul>{samples.map((sample) => <li key={sample.id}>
        <time dateTime={sample.recordedAt}>{formatTime(sample.recordedAt)}</time>
        <span>{sample.source === 'platform' ? '平台同步' : '手动录入'}</span>
        <span>{sample[field] === null ? '未采集' : count(sample[field])}</span>
      </li>)}</ul>
    </details>
  </>;
}

function PerformanceTrend({ scope, works }: { scope: string; works: Work[] }) {
  const [taskId, setTaskId] = useState('');
  const [field, setField] = useState<keyof MetricValues>('views');
  const work = works.find((item) => item.id === taskId) ?? works.find((item) => item.result.metrics) ?? works[0];
  if (!work) return null;
  const viewLabel = work.variant.videoAssetId ? '播放' : '阅读';
  const metrics = fields.map(([key, label]) => ({ key, label: key === 'views' ? viewLabel : label }));
  return <section className="card form-card performance-trend" aria-labelledby="performance-trend-title">
    <div className="performance-trend-heading">
      <div><h2 id="performance-trend-title">作品成效趋势</h2><p className="muted small">每件作品最近 120 次采集</p></div>
      <div className="performance-trend-controls">
        <label>作品<select value={work.id} onChange={(event) => setTaskId(event.target.value)}>
          {works.map((item) => <option value={item.id} key={item.id}>{item.variant.title} · {item.account.displayName}</option>)}
        </select></label>
        <label>指标<select value={field} onChange={(event) => setField(event.target.value as keyof MetricValues)}>
          {metrics.map(({ key, label }) => <option value={key} key={key}>{label}</option>)}
        </select></label>
      </div>
    </div>
    <MetricTrend key={work.id + ':' + (work.result.metrics?.recordedAt ?? '')} scope={scope} work={work} field={field}
      label={metrics.find(({ key }) => key === field)!.label} />
  </section>;
}

function MetricNumbers({ values, video }: { values?: MetricValues | null; video: boolean }) {
  return <dl className="work-metric-numbers">{fields.map(([field, label]) => <div key={field}>
    <dt>{field === 'views' ? video ? '播放' : '阅读' : label}</dt>
    <dd title={values?.[field] == null ? '未采集' : undefined}>{count(values?.[field])}</dd>
  </div>)}</dl>;
}

function MetricsForm({ work, scope, onSaved }: { work: Work; scope: string; onSaved: () => void }) {
  const action = useAction();
  const [error, setError] = useState('');
  const path = scope + '/tasks/' + encodeURIComponent(work.id) + '/metrics';
  const metrics = work.result.metrics;
  const isVideo = Boolean(work.variant.videoAssetId);
  const canSync = work.executionChannel === 'official' && work.variant.platform === 'bilibili'
    && !isVideo && Boolean(work.result.remoteId);
  const sync = useAction();

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(fields.map(([field]) => {
      const input = String(form.get(field) ?? '').trim();
      return [field, input ? Number(input) : null];
    }));
    if (Object.values(values).every((value) => value === null)) {
      setError('至少填写一项成效数据。');
      return;
    }
    setError('');
    sync.reset();
    void action.run(async () => {
      await api(path, { method: 'PATCH', body: values });
      onSaved();
    }, '已保存手动录入的成效。');
  }

  return <details className="work-metrics-editor">
    <summary>记录成效</summary>
    <div className="work-metrics-fields">
      <form className="form-stack" onSubmit={save} onChange={() => { setError(''); action.reset(); }}>
        <p className="muted small" id={'metrics-hint-' + work.id}>填写平台后台显示的最新累计值。空白表示未采集，实际为零请填 0。</p>
        <div className="work-metrics-inputs" key={metrics?.recordedAt} aria-describedby={'metrics-hint-' + work.id}>
          {fields.map(([field, label]) => <label key={field}>
            {field === 'views' ? isVideo ? '播放' : '阅读' : label}
            <input name={field} type="number" min="0" max="2147483647" step="1" inputMode="numeric"
              defaultValue={metrics?.[field] ?? ''} disabled={action.busy || sync.busy} />
          </label>)}
        </div>
        <Feedback error={error || action.error || sync.error} notice={action.notice || sync.notice} />
        <div className="actions">
          <button className="button primary compact" disabled={action.busy || sync.busy}>
            {action.busy ? '保存中…' : '保存手动录入'}
          </button>
          {canSync && <button type="button" className="button compact" disabled={action.busy || sync.busy}
            onClick={() => {
              setError('');
              action.reset();
              void sync.run(async () => {
                await post(path + '/sync', {}).catch((failure: unknown) => {
                  if (failure instanceof ApiError && failure.status === 502) {
                    throw new Error('B 站未返回成效数据，可以稍后重试或手动录入。');
                  }
                  throw failure;
                });
                onSaved();
              }, '已同步 B 站专栏成效。');
            }}>{sync.busy ? '同步中…' : '从 B 站同步'}</button>}
        </div>
      </form>
    </div>
  </details>;
}

export function Performance({ scope, role, initialAccount, openTask }: {
  scope: string; role: Role; initialAccount: string; openTask: (id: string) => void;
}) {
  const [platform, setPlatform] = useState('');
  const [account, setAccount] = useState(initialAccount);
  const [content, setContent] = useState('');
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages.at(-1);
  const query = new URLSearchParams({ limit: '20' });
  if (platform) query.set('platform', platform);
  if (account) query.set('accountId', account);
  if (content) query.set('content', content);
  if (cursor) query.set('cursor', cursor);
  const result = useResource<WorkPage>(scope + '/tasks/performance?' + query);
  const accounts = useResource<Account[]>(scope + '/accounts');
  const archived = useResource<Account[]>(scope + '/accounts?archived=true');
  const matches = [...(accounts.data ?? []), ...(archived.data ?? [])]
    .filter((item) => !platform || item.platform === platform);
  const accountReady = !account || matches.some((item) => item.id === account);

  return <>
    <PageHeader title="作品成效" description="查看已发布作品的阅读、播放和互动，按平台、账号或内容类型筛选。">
      <button type="button" className="button" onClick={result.refresh}>刷新列表</button>
    </PageHeader>
    <div className="performance-filters">
      <label>平台<select value={platform} onChange={(event) => {
        setPlatform(event.target.value); setAccount(''); setPages([]);
      }}>
        <option value="">全部平台</option><option value="xiaohongshu">小红书</option><option value="bilibili">B 站</option>
      </select></label>
      <label>账号<select value={account} onChange={(event) => { setAccount(event.target.value); setPages([]); }}>
        <option value="">全部账号</option>
        {!accountReady && <option value={account}>当前账号</option>}
        {matches.map((item) => <option value={item.id} key={item.id}>
          {item.platform === 'bilibili' ? 'B 站' : '小红书'} · {item.displayName}
        </option>)}
      </select></label>
      <label>内容类型<select value={content} onChange={(event) => { setContent(event.target.value); setPages([]); }}>
        <option value="">全部类型</option><option value="article">图文</option><option value="video">视频</option>
      </select></label>
    </div>
    <Feedback error={accounts.error || archived.error || result.error} />
    {result.loading && <Loading />}
    {result.data && <>
      <PerformanceTrend scope={scope} works={result.data.items} />
      <div className="performance-summary" aria-label="筛选范围汇总">
        {result.data.summary.map((item) => <section className="card form-card" key={item.content}>
          <h2>{item.content === 'video' ? '视频' : '图文'}</h2>
          <p className="muted small">{number.format(item.published)} 件已发布 · {number.format(item.tracked)} 件已采集</p>
          <MetricNumbers values={item} video={item.content === 'video'} />
        </section>)}
      </div>
      <section className="card" aria-labelledby="performance-works">
        <div className="card-heading"><h2 id="performance-works">作品明细</h2>
          <span className="muted small">汇总使用每件作品最近一次采集值。— 表示未采集。</span></div>
        {result.data.items.length ? <>
          <ul className="performance-works">{result.data.items.map((work) => {
            const metrics = work.result.metrics;
            const video = Boolean(work.variant.videoAssetId);
            return <li key={work.id} className="performance-work">
              <div className="performance-work-row">
                <div>
                  <button type="button" className="text-button" onClick={() => openTask(work.id)}>{work.variant.title}</button>
                  <p className="muted small">{publishPlatformLabel(work.variant.platform, video)} · {work.account.displayName}</p>
                </div>
                <MetricNumbers values={metrics} video={video} />
                <div className="muted small">{metrics ? <>
                  <span>{metrics.source === 'platform' ? '平台同步' : '手动录入'}</span>
                  <time dateTime={metrics.recordedAt}>{formatTime(metrics.recordedAt)}</time>
                </> : '待采集'}</div>
              </div>
              {canRecord(role) && <MetricsForm work={work} scope={scope} onSaved={result.refresh} />}
            </li>;
          })}</ul>
          {(cursor || result.data.nextCursor) && <div className="actions performance-pagination">
            <button type="button" className="button compact" disabled={!cursor} onClick={() => setPages(pages.slice(0, -1))}>上一页</button>
            <button type="button" className="button compact" disabled={!result.data.nextCursor}
              onClick={() => { if (result.data?.nextCursor) setPages([...pages, result.data.nextCursor]); }}>下一页</button>
          </div>}
        </> : <Empty icon={BarChart3} title="没有符合条件的已发布作品" description="确认发布后，作品会自动出现在这里。" />}
      </section>
    </>}
  </>;
}
