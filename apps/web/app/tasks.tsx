import { useState, type FormEvent } from 'react';
import {
  ArrowLeft, ArrowRight, CalendarDays, ChevronRight, ClipboardCheck, Clock3, Copy, ExternalLink, History,
  Images, RefreshCw, Send,
} from 'lucide-react';
import {
  canRecord, fileBody, formatTime, publishPlatformLabel, post, taskLabel, useAction, useResource,
  type Handoff, type Role, type Task, type TaskDetail, type TaskStatus,
} from './api';
import { Empty, Feedback, Loading, PageHeader, TaskBadge } from './ui';
import { roleView } from './workbench';

const filters = [
  { value: '', label: '全部' }, { value: 'scheduled', label: '待执行' }, { value: 'handed_off', label: '待回填' },
  { value: 'under_review', label: '平台审核中' },
  { value: 'published', label: '已发布' }, { value: 'unknown', label: '待核实' },
] as const;

const eventLabels: Record<string, string> = {
  created: '创建排期', claimed: '领取任务', handed_off: '完成人工交接', result: '回填发布结果', paused: '暂停任务',
  rescheduled: '调整排期', verified: '核对结果', canceled: '取消任务', retried: '重试任务', corrected: '更正结果',
  late_receipt: '迟到的回执', reminder: '飞书投递记录',
};

const deliveryLabels = { pending: '待投递', sending: '投递中', sent: '已送达', failed: '投递失败', skipped: '已跳过' } as const;

function externalUrl(value: string | null) {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
}

function Package({ data }: { data: Handoff }) {
  const copy = useAction();
  return <div className="task-section">
    <div className="section-line">
      <h3><Send size={17} aria-hidden="true" />已审交接包</h3>
      <button type="button" className="button compact" disabled={copy.busy} onClick={() => void copy.run(async () => {
        if (!navigator.clipboard) throw new Error('浏览器暂不支持复制，可选中文案手动复制。');
        await navigator.clipboard.writeText(`${data.title}\n\n${data.body}`);
      }, '已复制标题和正文。')}><Copy size={15} aria-hidden="true" />复制文案</button>
    </div>
    <div className="variant-preview">
      <div className="section-line"><h3>{data.title}</h3><span className="version">V{data.version}</span></div>
      <p className="content-text">{data.body}</p>
      {data.video && <div className="video-asset">
        <video controls preload="none" aria-label="已审交接视频" src={data.video.url} />
        <a className="button compact" href={data.video.url} download={data.video.filename}>下载已审视频</a>
      </div>}
      {data.tags.length > 0 && <div className="tag-row">{data.tags.map((tag, index) => <span key={index}>#{tag}</span>)}</div>}
      {data.assets.length > 0 && <div className="picture-grid">
        {data.assets.map((asset) => <a href={asset.url} className="picture" download key={asset.assetId}>
          <img src={asset.url + '/thumbnail'} alt={`下载第 ${asset.position + 1} 张发布图片`} loading="lazy" decoding="async" />
          {asset.isCover && <span className="picture-label">封面</span>}
        </a>)}
      </div>}
    </div>
    <Feedback error={copy.error} notice={copy.notice} />
  </div>;
}

function RecordResult({ path, saved }: { path: string; saved: () => void }) {
  const action = useAction();
  const [state, setState] = useState<'published' | 'failed' | 'unknown'>('published');
  const [attachment, setAttachment] = useState<{ file: File; id?: string }>();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const remoteUrl = String(fields.get('remoteUrl') ?? '').trim();
    const note = String(fields.get('note') ?? '').trim();
    void action.run(async () => {
      if (remoteUrl && !externalUrl(remoteUrl)) throw new Error('请输入有效的 HTTP 或 HTTPS 作品链接。');
      if (state === 'published' && !remoteUrl && !attachment) throw new Error('请填写作品链接或上传发布截图。');
      let evidenceAssetId = attachment?.id;
      if (attachment && !evidenceAssetId) {
        const uploaded = await post<{ assetId: string }>(path + '/evidence', fileBody(attachment.file));
        evidenceAssetId = uploaded.assetId;
        setAttachment({ ...attachment, id: evidenceAssetId });
      }
      await post(path + '/result', { state, remoteUrl: remoteUrl || undefined, note: note || undefined, evidenceAssetId });
      saved();
    });
  }
  return <form className="task-section form-stack" onSubmit={submit}>
    <h3><ClipboardCheck size={17} aria-hidden="true" />回填发布结果</h3>
    <div className="form-row">
      <label>发布结果<select value={state} onChange={(event) => setState(event.target.value as typeof state)}>
        <option value="published">已发布</option><option value="failed">失败</option><option value="unknown">待核实</option>
      </select></label>
      <label>作品链接<input name="remoteUrl" type="url" placeholder="https://…" maxLength={2048} /></label>
    </div>
    <label>截图证据 <small>JPG、PNG 或 WebP，最大 20 MB</small>
      <input className="file-field" type="file" accept="image/jpeg,image/png,image/webp" disabled={action.busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          setAttachment(file ? { file } : undefined);
        }} />
    </label>
    <label>备注 <small>选填</small><textarea name="note" rows={3} maxLength={1000} placeholder="例如 发布后需要继续观察审核结果" /></label>
    <Feedback error={action.error} />
    <button className="button primary" disabled={action.busy}>{action.busy ? '正在保存…' : '保存回填结果'}</button>
  </form>;
}

function TaskDetails({ id, scope, role, onRecorded, people }: {
  id: string; scope: string; role: Role; onRecorded: (title: string) => void; people: Map<string, string>;
}) {
  const path = scope + '/tasks/' + id;
  const detail = useResource<TaskDetail>(path, 5_000);
  const task = detail.data;
  const recordable = canRecord(role);
  const handoff = useResource<Handoff>(recordable && task?.handedOffAt && task.executionChannel === 'manual' ? path + '/handoff' : null);
  if (!task) return <section className="card detail-pane">
    {detail.loading ? <Loading /> : <Feedback error={detail.error} />}
  </section>;

  const result = task.result;
  const resultUrl = externalUrl(result?.remoteUrl ?? null);
  const channel = task.executionChannel ?? (task.status === 'scheduled' ? task.account.channelKind : null);
  const automated = channel === 'official' || channel === 'sandbox';
  function actorName(actorId: string | null) {
    return actorId ? people.get(actorId) ?? '工作室成员' : '系统';
  }
  return <section className="card detail-pane task-detail">
    <div className="detail-heading">
      <div className="detail-icon"><CalendarDays size={22} aria-hidden="true" /></div>
      <div><h2>{task.variant.title}</h2><p>{publishPlatformLabel(task.variant.platform, Boolean(task.variant.videoAssetId))} · {task.account.displayName} · V{task.variant.version}</p></div>
      <TaskBadge status={task.status} />
    </div>
    <div className="detail-content">
      <Feedback error={detail.error || task.lastError || undefined} />
      {task.isSandbox && <p className="feedback">沙箱任务</p>}
      <dl className="task-meta">
        <div><dt>计划时间</dt><dd>{formatTime(task.scheduledAt)}</dd></div>
        {automated
          ? <div><dt>开始处理</dt><dd>{task.claimedAt ? formatTime(task.claimedAt) : '待执行'}</dd></div>
          : <div><dt>实际交接</dt><dd>{task.handedOffAt ? formatTime(task.handedOffAt) : '待交接'}</dd></div>}
      </dl>
      {(task.status === 'scheduled' || task.status === 'dispatching') && <div className="sub-empty">
        <Clock3 size={19} aria-hidden="true" /><p>{automated
          ? '到计划时间后，系统将提交已审版本，并查询平台回执。'
          : '到计划时间后，系统将生成已审交接包。'}</p>
      </div>}
      <Feedback error={handoff.error} />
      {handoff.loading ? <Loading /> : handoff.data && <Package data={handoff.data} />}
      {recordable && task.status === 'handed_off' && task.executionChannel === 'manual' && <RecordResult path={path} saved={() => {
        detail.refresh();
        onRecorded(task.variant.title);
      }} />}
      {result && <div className="task-section">
        <div className="section-line"><h3><ClipboardCheck size={17} aria-hidden="true" />发布回执</h3><TaskBadge status={result.state} /></div>
        <p className="muted small">{actorName(result.recordedById)} · {formatTime(result.recordedAt)}</p>
        {result.note && <p className="content-text">{result.note}</p>}
        {result.remoteId && automated && <p className="muted small">文章 ID {result.remoteId}</p>}
        {result.platformPublishedAt && <p className="muted small">发表时间 {formatTime(result.platformPublishedAt)}</p>}
        <div className="actions">
          {resultUrl && !task.isSandbox && <a href={resultUrl} target="_blank" rel="noreferrer" className="button compact"><ExternalLink size={15} aria-hidden="true" />打开作品</a>}
          {result.evidenceAssetId && <a href={'/api' + path + '/evidence'} target="_blank" rel="noreferrer" className="button compact">
            <Images size={15} aria-hidden="true" />查看截图
          </a>}
        </div>
      </div>}
      {!!task.notificationDeliveries?.length && <div className="task-section">
        <h3><Send size={17} aria-hidden="true" />飞书提醒</h3>
        <dl className="task-meta">
          {task.notificationDeliveries.map((delivery) => <div key={delivery.id}>
            <dt>{delivery.kind === 'handoff_ready' ? '交接提醒' : '4 小时未回填提醒'}</dt>
            <dd>{deliveryLabels[delivery.status]} · {delivery.status === 'sent'
              ? formatTime(delivery.sentAt ?? delivery.scheduledAt)
              : delivery.status === 'pending'
                ? `预计 ${formatTime(delivery.scheduledAt)}`
                : delivery.status === 'skipped'
                  ? `原计划 ${formatTime(delivery.scheduledAt)}`
                  : formatTime(delivery.scheduledAt)}</dd>
            {delivery.lastError && <dd className="muted small">{delivery.lastError}</dd>}
          </div>)}
        </dl>
      </div>}
      {task.events.length > 0 && <div className="task-section">
        <h3><History size={17} aria-hidden="true" />操作记录</h3>
        <ol className="timeline">
          {task.events.map((event) => <li key={event.id}>
            <span className="timeline-dot" />
            <div><strong>{automated && event.kind === 'result' && event.toStatus ? taskLabel[event.toStatus]
              : eventLabels[event.kind] ?? (event.toStatus ? taskLabel[event.toStatus] : '任务更新')}</strong>
              <div className="muted small">{actorName(event.actorId)} · {formatTime(event.createdAt)}</div>
              {event.reason && <p>{event.reason}</p>}
            </div>
          </li>)}
        </ol>
      </div>}
    </div>
  </section>;
}

export function Tasks({ scope, role, initialId }: { scope: string; role: Role; initialId: string }) {
  const [status, setStatus] = useState<'' | TaskStatus>(initialId ? '' : roleView[role].taskStatus ?? '');
  const [selected, setSelected] = useState(initialId);
  const [pages, setPages] = useState<string[]>([]);
  const [recordedTitle, setRecordedTitle] = useState('');
  const cursor = pages.at(-1);
  const search = new URLSearchParams({ limit: '20' });
  if (status) search.set('status', status);
  if (cursor) search.set('cursor', cursor);
  const list = useResource<{ items: Task[]; nextCursor: string | null }>(scope + '/tasks?' + search, 5_000);
  const members = useResource<{ user: { id: string; name: string } }[]>(scope + '/members');
  const people = new Map(members.data?.map(({ user }) => [user.id, user.name]));
  const items = list.data?.items ?? [];
  const listUnavailable = Boolean(list.error && !list.data);
  const active = selected || items[0]?.id || '';
  function changePage(next: string[]) { setPages(next); setSelected(''); setRecordedTitle(''); }

  return <>
    <PageHeader title="发布任务" description={role === 'operator' ? roleView.operator.description
      : canRecord(role) ? '查看交接进度、取得已审文案并记录发布结果。' : '查阅发布进度和回执。'}>
      <button className="button" onClick={list.refresh}><RefreshCw size={16} aria-hidden="true" />
        {listUnavailable ? '重试加载' : '刷新任务'}</button>
    </PageHeader>
    <div className="filters" aria-label="按任务状态筛选">
      {filters.map((filter) => <button className={status === filter.value ? 'active' : ''} key={filter.value} aria-pressed={status === filter.value}
        disabled={listUnavailable} onClick={() => { setStatus(filter.value); changePage([]); }}>{filter.label}</button>)}
    </div>
    <Feedback error={list.error} notice={recordedTitle ? `「${recordedTitle}」的发布结果已保存。` : undefined} />
    {!listUnavailable && <div className="split-panel">
      <section className="card item-list">
        <div className="card-heading"><h2>任务列表</h2><span className="count">{items.length}</span></div>
        {list.loading ? <Loading /> : items.length ? items.map((task) => <button key={task.id} className={`list-item ${active === task.id ? 'selected' : ''}`}
          aria-pressed={active === task.id} onClick={() => { setSelected(task.id); setRecordedTitle(''); }}>
          <span className="list-icon"><CalendarDays size={17} aria-hidden="true" /></span>
          <span className="list-copy"><strong>{task.variant.title}</strong><small>{publishPlatformLabel(task.variant.platform, Boolean(task.variant.videoAssetId))} · {task.account.displayName} · {formatTime(task.scheduledAt)}</small></span>
          <TaskBadge status={task.status} /><ChevronRight className="row-chevron" size={14} aria-hidden="true" />
        </button>) : <Empty icon={CalendarDays} title="暂无匹配的任务" />}
        {(cursor || list.data?.nextCursor) && <div className="pagination">
          <button className="icon-button" aria-label="上一页" disabled={!cursor} onClick={() => changePage(pages.slice(0, -1))}><ArrowLeft size={17} aria-hidden="true" /></button>
          <small>第 {pages.length + 1} 页</small>
          <button className="icon-button" aria-label="下一页" disabled={!list.data?.nextCursor}
            onClick={() => { if (list.data?.nextCursor) changePage([...pages, list.data.nextCursor]); }}><ArrowRight size={17} aria-hidden="true" /></button>
        </div>}
      </section>
      {active ? <TaskDetails key={active} id={active} scope={scope} role={role} people={people} onRecorded={(title) => {
        if (status === 'handed_off') setSelected((current) => current === active ? '' : current);
        setRecordedTitle(title);
        list.refresh();
      }} />
        : <section className="card detail-pane empty-detail">{list.loading ? <Loading />
          : <Empty icon={CalendarDays} title="在这里查看发布进度" description="为已审核的平台版本排期后，可以在这里查看交接与回执。" />}</section>}
    </div>}
  </>;
}
