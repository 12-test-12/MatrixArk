import { useState } from 'react';
import { formatTime, useResource } from './api';
import { topicPlatforms } from './creatorhub-report';
import { Feedback } from './ui';

type Insights = {
  heat: { signal: 'high' | 'typical' | 'insufficient'; metric: 'views' | 'likes'; value: number | null;
    median: number | null; peers: number; ratio: number | null; creatorScoped: boolean };
  matches: { id: string; title: string; platform: keyof typeof topicPlatforms; creator: string | null;
    sourceUrl: string | null; publishedOn: string }[];
};
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

export function TopicInsights({ path }: { path: string }) {
  const resource = useResource<Insights>(path + '/insights', 30_000);
  const data = resource.data;
  return <section className="field-group">
    <h3>表现与跨平台匹配</h3>
    <Feedback error={resource.error} />
    {resource.loading && <p className="muted small" role="status">正在比较作品…</p>}
    {data && <>
      <strong>{data.heat.signal === 'high' ? '高表现信号' : data.heat.signal === 'typical' ? '未达到高表现阈值' : '表现数据不足'}</strong>
      {data.heat.value !== null && <p>
        {data.heat.metric === 'views' ? '播放' : '点赞'} {format.format(data.heat.value)}
        {data.heat.median !== null && ` · 对照中位数 ${format.format(data.heat.median)}`}
        {data.heat.ratio !== null && ` · ${format.format(data.heat.ratio)} 倍`}
      </p>}
      <p className="muted small">{data.heat.peers} 条对照 · 同平台、同类型、发布日期相差 3 天内
        {data.heat.creatorScoped && ' · 同作者'}。高表现需达到中位数 2 倍，且超过至少四分之三的对照。
        {data.heat.signal === 'insufficient' && ' 至少需要 3 条可比较作品，且对照中位数大于零。'}
      </p>
      <h4>跨平台疑似同稿</h4>
      {data.matches.length ? <>
        <p className="muted small">标题一致、类型相同、发布日期相差 7 天内。可打开原作品核对。</p>
        <ul>{data.matches.map((match) => <li key={match.id}>
          {match.sourceUrl ? <a href={match.sourceUrl} target="_blank" rel="noreferrer">{match.title}</a> : match.title}
          {' · '}{topicPlatforms[match.platform]} · {match.creator ?? '作者未记录'} · {match.publishedOn.slice(0, 10)}
        </li>)}</ul>
      </> : <p className="muted small">近期样本里暂未找到可核对的跨平台同稿。</p>}
    </>}
  </section>;
}

type Change = {
  id: string; action: string; actorName: string | null; actorEmail: string | null; createdAt: string;
  details?: { saved?: { before: boolean; after: boolean }; note?: { before: string | null; after: string | null }; count?: number; reason?: string };
};
const actions: Record<string, string> = {
  report_imported: '导入或更新作品', work_edited: '修改选题', draft_created: '创建原稿',
  source_created: '添加采集任务', source_paused: '暂停采集', source_resumed: '恢复采集',
  source_deleted: '删除采集任务', source_restored: '重新添加采集任务',
  source_collected: '采集完成', source_failed: '采集失败',
};
const actorOf = (change: Change) => change.actorEmail ? `${change.actorName}（${change.actorEmail}）` : change.actorName ?? '系统';

export function TopicChanges({ path, eager = false }: { path: string; eager?: boolean }) {
  const [open, setOpen] = useState(false);
  const history = useResource<Change[]>(open || eager ? path + '/changes' : null, 5_000);
  const recent = history.data?.[0];
  return <details className="source topic-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>操作记录{recent && ` · ${actorOf(recent)} · ${actions[recent.action] ?? recent.action} · ${formatTime(recent.createdAt)}`}</summary>
    <Feedback error={history.error} />
    {history.loading && <p className="muted small">正在读取操作记录…</p>}
    {history.data?.length === 0 && <p className="muted small">暂无可追溯操作，历史数据可能早于记录功能。</p>}
    {history.data && history.data.length > 0 && <ol className="timeline" aria-label="最近 30 条操作">
      {history.data.map((change) => <li key={change.id}>
        <span className="timeline-dot" aria-hidden="true" />
        <div className="timeline-content">
          <strong>{actions[change.action] ?? change.action}</strong>
          <p className="muted small">{actorOf(change)} · {formatTime(change.createdAt)}</p>
          {change.details?.saved && <p>{change.details.saved.after ? '加入选题池' : '移出选题池'}</p>}
          {change.details?.note && <>
            <p className="content-text">原备注 {change.details.note.before ?? '空'}</p>
            <p className="content-text">新备注 {change.details.note.after ?? '空'}</p>
          </>}
          {change.details?.count !== undefined && <p>匹配 {change.details.count} 条作品</p>}
          {change.details?.reason && <p>{change.details.reason}</p>}
        </div>
      </li>)}
    </ol>}
  </details>;
}
