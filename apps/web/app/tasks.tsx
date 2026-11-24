import { useId, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowLeft, ArrowRight, CalendarDays, ChevronRight, ClipboardCheck, Clock3, Copy, ExternalLink, History,
  Images, List, RefreshCw, Search, Send, Table2, X,
} from 'lucide-react';
import {
  api, canEdit, canRecord, fileBody, formatTime, platformLabel, platforms, publishPlatformLabel, post, taskLabel, useAction, useResource,
  type Handoff, type Platform, type Role, type Task, type TaskDetail, type TaskStatus, type WorkbenchSummary,
} from './api';
import { Empty, Feedback, Loading, PageHeader, TaskBadge } from './ui';
import { roleView } from './workbench';

const primaryFilters = [
  { value: '', label: '全部' },
  { value: 'scheduled', label: '待执行' },
  { value: 'handed_off', label: '待回填' },
  { value: 'under_review', label: '平台审核中' },
  { value: 'published', label: '已发布' },
  { value: 'unknown', label: '待核实' },
  { value: 'verified', label: '已核实' },
] as const;

const secondaryFilters = [
  { value: 'dispatching', label: '处理中' },
  { value: 'submitted', label: '已受理' },
  { value: 'paused', label: '已暂停' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
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
  return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
}

function Package({ data }: { data: Handoff }) {
  const copy = useAction();
  return <div className="task-section">
    <div className="section-line">
      <h3><Send size={17} aria-hidden="true" />已审交接包</h3>
      <button type="button" className="button primary compact" disabled={copy.busy} onClick={() => void copy.run(async () => {
        if (!navigator.clipboard) throw new Error('浏览器暂不支持复制，可选中文案手动复制。');
        await navigator.clipboard.writeText(`${data.title}\n\n${data.body}`);
      }, '已复制标题和正文。')}><Copy size={15} aria-hidden="true" />复制文案</button>
    </div>
    <div className="variant-preview">
      <div className="section-line"><h3>{data.title || '未命名文案'}</h3><span className="version">V{data.version}</span></div>
      <p className="content-text">{data.body || '无正文内容'}</p>
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

function useTaskEvidence(path: string) {
  const [attachment, setAttachment] = useState<{ file: File; id?: string }>();
  async function upload() {
    if (!attachment || attachment.id) return attachment?.id;
    const { assetId } = await post<{ assetId: string }>(path + '/evidence', fileBody(attachment.file));
    setAttachment({ ...attachment, id: assetId });
    return assetId;
  }
  return {
    hasFile: Boolean(attachment),
    choose: (file?: File) => setAttachment(file ? { file } : undefined),
    upload,
  };
}

function EvidenceFields({ choose }: { choose: (file?: File) => void }) {
  return <>
    <label>作品链接<input name="remoteUrl" type="url" placeholder="https://…" maxLength={2048} /></label>
    <label>截图证据 <small>JPG、PNG 或 WebP，最大 20 MB</small>
      <input className="file-field" type="file" accept="image/jpeg,image/png,image/webp"
        onChange={(event) => choose(event.currentTarget.files?.[0])} />
    </label>
  </>;
}

function readWorkUrl(fields: FormData) {
  const remoteUrl = String(fields.get('remoteUrl') ?? '').trim();
  if (remoteUrl && !externalUrl(remoteUrl)) throw new Error('请输入有效的 HTTP 或 HTTPS 作品链接。');
  return remoteUrl || undefined;
}

function RecordResult({ path, saved, action, correction = false }: {
  path: string; saved: () => void; action: ReturnType<typeof useAction>; correction?: boolean;
}) {
  const [state, setState] = useState<'published' | 'failed' | 'unknown'>('published');
  const evidence = useTaskEvidence(path);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const note = String(fields.get('note') ?? '').trim();
    const reason = String(fields.get('reason') ?? '').trim();
    void action.run(async () => {
      const remoteUrl = readWorkUrl(fields);
      if (state === 'published' && !remoteUrl && !evidence.hasFile) throw new Error('请填写作品链接或上传发布截图。');
      if (correction && !reason) throw new Error('请填写更正原因。');
      const evidenceAssetId = await evidence.upload();
      await post(path + '/result', { state, remoteUrl, note: note || undefined, reason: reason || undefined, evidenceAssetId });
      saved();
    });
  }
  return <form className={correction ? 'form-stack' : 'task-section form-stack'} onSubmit={submit} aria-busy={action.busy}>
    <h3><ClipboardCheck size={17} aria-hidden="true" />{correction ? '更正为已发布' : '回填发布结果'}</h3>
    <fieldset className="form-stack task-action-fields" disabled={action.busy}>
      {!correction && <label>发布结果<select value={state} onChange={(event) => setState(event.target.value as typeof state)}>
        <option value="published">已发布</option><option value="failed">失败</option><option value="unknown">待核实</option>
      </select></label>}
      <EvidenceFields choose={evidence.choose} />
      {correction ? <label>更正原因<textarea name="reason" required rows={3} maxLength={1000} /></label>
        : <label>备注 <small>选填</small><textarea name="note" rows={3} maxLength={1000} placeholder="例如 发布后需要继续观察审核结果" /></label>}
    </fieldset>
    <Feedback error={action.error} />
    <button className="button primary" disabled={action.busy}>{action.busy ? '正在保存…' : correction ? '保存更正' : '保存回填结果'}</button>
  </form>;
}

const taskActions = {
  schedule: ['调整排期', '已调整计划时间。'],
  cancel: ['取消任务', '任务已取消。'],
  verify: ['核对发布结果', '核对记录已保存。'],
  resume: ['恢复暂停任务', '任务已恢复排期。'],
  retry: ['重新排期重试', '原任务已重新排期。'],
  correct: ['更正为已发布', '已更正发布结果。'],
} as const;
type TaskOperation = keyof typeof taskActions;
type VerifyOutcome = 'unresolved' | 'accepted' | 'published' | 'not_received';

function TaskOperationForm({ mode, path, task, saved, action }: {
  mode: Exclude<TaskOperation, 'correct'>; path: string; task: TaskDetail; saved: () => void; action: ReturnType<typeof useAction>;
}) {
  const evidence = useTaskEvidence(path);
  const [outcome, setOutcome] = useState<VerifyOutcome>(task.status === 'failed' ? 'not_received' : 'unresolved');
  const needsTime = mode === 'schedule' || mode === 'resume' || mode === 'retry';
  const time = new Date(mode === 'schedule' && new Date(task.scheduledAt).getTime() > Date.now()
    ? task.scheduledAt : Date.now() + 5 * 60_000);
  const localTime = new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void action.run(async () => {
      if (needsTime) {
        const date = new Date(String(fields.get('scheduledAt') ?? ''));
        if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('请选择未来的计划时间。');
        await api(path + '/' + mode, { method: mode === 'schedule' ? 'PATCH' : 'POST', body: { scheduledAt: date.toISOString() } });
      } else {
        const reason = String(fields.get('reason') ?? '').trim();
        if (!reason) throw new Error('请填写原因或核对依据。');
        if (mode === 'cancel') {
          const verification = String(fields.get('verification') ?? '').trim();
          if (task.status === 'handed_off' && !verification) throw new Error('请填写确认尚未发布的核对依据。');
          await post(path + '/cancel', { reason, verification: verification || undefined });
        } else {
          const body: { outcome: VerifyOutcome; reason: string; remoteId?: string; remoteUrl?: string; evidenceAssetId?: string } = { outcome, reason };
          if (outcome === 'accepted') body.remoteId = String(fields.get('remoteId') ?? '').trim();
          if (outcome === 'published') {
            body.remoteUrl = readWorkUrl(fields);
            if (!body.remoteUrl && !evidence.hasFile) throw new Error('请填写作品链接或上传发布截图。');
            body.evidenceAssetId = await evidence.upload();
          }
          await post(path + '/verify', body);
        }
      }
      saved();
    });
  }
  return <form className="form-stack" onSubmit={submit} aria-busy={action.busy}>
    <fieldset className="form-stack task-action-fields" disabled={action.busy}>
      {needsTime && <label>新计划时间 <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
        <input name="scheduledAt" type="datetime-local" defaultValue={localTime} required />
      </label>}
      {mode === 'verify' && <>
        <label>核对结论<select value={outcome} onChange={(event) => {
          setOutcome(event.target.value as VerifyOutcome); evidence.choose();
        }}>
          {task.status === 'unknown' && <>
            <option value="unresolved">仍无法确认</option>
            {task.executionChannel === 'official' && <option value="accepted">平台已受理</option>}
            <option value="published">确认已发布</option>
          </>}
          <option value="not_received">{task.executionChannel === 'official' ? '确认平台未受理' : '确认未发布'}</option>
        </select></label>
        {outcome === 'accepted' && <label>B 站文章 ID
          <input name="remoteId" required inputMode="numeric" pattern="[1-9][0-9]{0,19}" defaultValue={task.result?.remoteId ?? ''} />
        </label>}
        {outcome === 'published' && <EvidenceFields choose={evidence.choose} />}
      </>}
      {!needsTime && <label>{mode === 'cancel' ? '取消原因' : outcome === 'unresolved' ? '已检查内容及下一步' : '核对依据'}
        <textarea name="reason" required rows={3} maxLength={1000} />
      </label>}
      {mode === 'cancel' && task.status === 'handed_off' && <label>确认未发布的依据
        <textarea name="verification" required rows={3} maxLength={1000} />
      </label>}
    </fieldset>
    <Feedback error={action.error} />
    <button className="button primary" disabled={action.busy}>{action.busy ? '正在保存…' : mode === 'cancel' ? '确认取消任务' : '确认' + taskActions[mode][0]}</button>
  </form>;
}

function TaskActions({ task, path, role, changed }: { task: TaskDetail; path: string; role: Role; changed: (notice: string) => void }) {
  const [mode, setMode] = useState<TaskOperation>();
  const action = useAction();
  const panelId = useId();
  const actions: TaskOperation[] = [];
  if (canEdit(role)) {
    if (task.status === 'scheduled') actions.push('schedule');
    if (task.status === 'paused') actions.push('resume');
    if (task.status === 'scheduled' || task.status === 'paused' || (task.status === 'handed_off' && role === 'owner')) actions.push('cancel');
    if (task.status === 'verified') actions.push('retry');
  }
  if (canRecord(role) && (task.status === 'unknown' || task.status === 'failed')) actions.push('verify');
  if ((canRecord(role) && task.status === 'failed') || (role === 'owner' && task.status === 'canceled')) actions.push('correct');
  if (actions.length === 0) return null;
  const active = mode && actions.includes(mode) ? mode : undefined;
  function saved() {
    if (!active) return;
    setMode(undefined);
    changed(taskActions[active][1]);
  }
  return <div className="task-section">
    <h3>任务操作</h3>
    <div className="actions">
      {actions.map((item) => <button type="button" key={item} className="button compact"
        aria-expanded={active === item} aria-controls={panelId} disabled={action.busy}
        onClick={() => { action.reset(); setMode(active === item ? undefined : item); }}>{taskActions[item][0]}</button>)}
    </div>
    <div id={panelId} hidden={!active}>
      {active === 'correct' ? <RecordResult path={path} saved={saved} action={action} correction />
        : active && <TaskOperationForm key={active} mode={active} path={path} task={task} saved={saved} action={action} />}
    </div>
  </div>;
}

function TaskDetails({ id, scope, role, onRecorded, people }: {
  id: string; scope: string; role: Role; onRecorded: (title: string) => void; people: Map<string, string>;
}) {
  const path = scope + '/tasks/' + id;
  const detail = useResource<TaskDetail>(path, 5_000);
  const recordAction = useAction();
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
  function eventDotTone(event: TaskDetail['events'][number]): string {
    if (event.toStatus === 'failed' || event.toStatus === 'canceled') return 'red';
    if (event.toStatus === 'published' || event.toStatus === 'verified' || event.kind === 'result') return 'green';
    if (event.toStatus === 'paused' || event.toStatus === 'unknown') return 'amber';
    return 'violet';
  }
  return <section className="card detail-pane task-detail">
    <div className="detail-heading">
      <div className="detail-icon"><CalendarDays size={22} aria-hidden="true" /></div>
      <div>
        <h2>{task.variant.title?.trim() || '未命名任务'}</h2>
        <p>{publishPlatformLabel(task.variant.platform, Boolean(task.variant.videoAssetId))} · {task.account.displayName?.trim() || '未指定账号'} · V{task.variant.version}</p>
      </div>
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
        <div><dt>发布账号</dt><dd title={task.account.displayName}>{task.account.displayName?.trim() || '未指定账号'}</dd></div>
        <div><dt>版本规格</dt><dd>V{task.variant.version} · {publishPlatformLabel(task.variant.platform, Boolean(task.variant.videoAssetId))}</dd></div>
      </dl>
      {(task.status === 'scheduled' || task.status === 'dispatching') && <div className="sub-empty">
        <Clock3 size={19} aria-hidden="true" /><p>{automated
          ? '到计划时间后，系统将提交已审版本，并查询平台回执。'
          : '到计划时间后，系统将生成已审交接包。'}</p>
      </div>}
      <Feedback error={handoff.error} />
      {handoff.loading ? <Loading /> : handoff.data && <Package data={handoff.data} />}
      {recordable && task.status === 'handed_off' && task.executionChannel === 'manual' && <RecordResult path={path} action={recordAction} saved={() => {
        detail.refresh();
        onRecorded(`「${task.variant.title}」的发布结果已保存。`);
      }} />}
      <TaskActions key={task.status} task={task} path={path} role={role} changed={(notice) => {
        detail.refresh();
        onRecorded(notice);
      }} />
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
            <span className={`timeline-dot ${eventDotTone(event)}`} />
            <div className="timeline-content">
              <div className="timeline-header">
                <strong>{automated && event.kind === 'result' && event.toStatus ? taskLabel[event.toStatus]
                  : eventLabels[event.kind] ?? (event.toStatus ? taskLabel[event.toStatus] : '任务更新')}</strong>
                <time className="muted small">{formatTime(event.createdAt)}</time>
              </div>
              <div className="timeline-actor">{actorName(event.actorId)}</div>
              {event.reason && <p className="timeline-reason">{event.reason}</p>}
              {event.details?.verification && <p className="muted small">核对依据 · {event.details.verification}</p>}
              {event.details?.previousScheduledAt && event.details.scheduledAt && <p className="timeline-shift">
                {formatTime(event.details.previousScheduledAt)} → {formatTime(event.details.scheduledAt)}
              </p>}
              {event.details?.remoteId && <p className="muted small">作品 ID {event.details.remoteId}</p>}
              {event.details?.previous?.evidenceAssetId && <a className="text-button"
                href={'/api' + path + '/evidence?assetId=' + encodeURIComponent(event.details.previous.evidenceAssetId)}
                target="_blank" rel="noreferrer">查看原回执截图</a>}
            </div>
          </li>)}
        </ol>
      </div>}
    </div>
  </section>;
}

export function Tasks({ scope, role, initialId, counts, refreshSummary, openManuscripts }: {
  scope: string; role: Role; initialId: string; counts?: WorkbenchSummary['taskCounts'];
  refreshSummary: () => void; openManuscripts: () => void;
}) {
  const [status, setStatus] = useState<'' | TaskStatus>(initialId ? '' : roleView[role].taskStatus ?? '');
  const [selected, setSelected] = useState(initialId);
  const [pages, setPages] = useState<string[]>([]);
  const [recordedTitle, setRecordedTitle] = useState('');
  const [keyword, setKeyword] = useState('');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [tableView, setTableView] = useState(false);
  const cursor = pages.at(-1);
  const search = new URLSearchParams({ limit: '20' });
  if (status) search.set('status', status);
  if (cursor) search.set('cursor', cursor);
  const list = useResource<{ items: Task[]; nextCursor: string | null }>(scope + '/tasks?' + search, 5_000);
  const members = useResource<{ user: { id: string; name: string } }[]>(scope + '/members');
  const people = new Map(members.data?.map(({ user }) => [user.id, user.name]));
  const items = list.data?.items ?? [];
  const listUnavailable = Boolean(list.error && !list.data);

  const total = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : undefined;

  const filteredItems = useMemo(() => {
    return items.filter((task) => {
      if (platformFilter !== 'all' && task.variant.platform !== platformFilter) return false;
      if (keyword.trim()) {
        const query = keyword.trim().toLowerCase();
        const titleMatch = (task.variant.title || '').toLowerCase().includes(query);
        const accountMatch = (task.account.displayName || '').toLowerCase().includes(query);
        return titleMatch || accountMatch;
      }
      return true;
    });
  }, [items, keyword, platformFilter]);

  const narrowing = Boolean(keyword.trim()) || platformFilter !== 'all';
  const active = (filteredItems.some(({ id }) => id === selected) || (!narrowing && selected === initialId) ? selected : '')
    || filteredItems[0]?.id || '';
  function changePage(next: string[]) { setPages(next); setSelected(''); setRecordedTitle(''); }
  function chooseTask(id: string) { setSelected(id); setRecordedTitle(''); }
  const empty = <Empty icon={CalendarDays} title={narrowing ? '本页未找到符合条件的任务' : status ? '暂无该状态的任务' : '暂无发布任务'}>
    {narrowing ? <button type="button" className="button" onClick={() => { setKeyword(''); setPlatformFilter('all'); }}>清除搜索和平台筛选</button>
      : status ? <button type="button" className="button" onClick={() => { setStatus(''); changePage([]); }}>查看全部任务</button>
        : !cursor && canEdit(role) && <button type="button" className="button primary" onClick={openManuscripts}>前往原稿与审核</button>}
  </Empty>;

  return <>
    <PageHeader title="发布任务" description={role === 'operator' ? roleView.operator.description
      : canRecord(role) ? '查看交接进度、取得已审文案并记录发布结果。' : '查阅发布进度和回执。'}>
      <button className="button" onClick={() => { list.refresh(); refreshSummary(); }}><RefreshCw size={16} aria-hidden="true" />
        {listUnavailable ? '重试加载' : '刷新任务'}</button>
    </PageHeader>
    <div className="filters" aria-label="按任务状态筛选">
      {primaryFilters.map((filter) => {
        const count = filter.value ? counts && (counts[filter.value] ?? 0) : total;
        return (
          <button
            className={status === filter.value ? 'active' : ''}
            key={filter.value}
            aria-pressed={status === filter.value}
            disabled={listUnavailable}
            onClick={() => { setStatus(filter.value); changePage([]); }}
          >
            {filter.label}
            {count !== undefined && <span className="tab-badge">{count.toLocaleString('zh-CN')}</span>}
          </button>
        );
      })}
      <div className="filters-more">
        <select
          className="filter-select"
          aria-label="更多状态筛选"
          value={secondaryFilters.some((f) => f.value === status) ? status : ''}
          onChange={(e) => {
            const val = e.target.value as TaskStatus | '';
            if (val) {
              setStatus(val);
              changePage([]);
            }
          }}
        >
          <option value="" disabled>更多状态…</option>
          {secondaryFilters.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}{counts ? `（${counts[f.value] ?? 0}）` : ''}
            </option>
          ))}
        </select>
      </div>
    </div>
    <Feedback error={list.error} notice={recordedTitle || undefined} />
    {!listUnavailable && <div className={tableView ? 'task-table-layout' : 'split-panel'}>
      <section className="card item-list">
        <div className="card-heading">
          <h2>任务列表</h2>
          <div className="actions">
            <span className="count" aria-label={`本页 ${filteredItems.length} 条`}>{filteredItems.length}</span>
            <button type="button" className="button compact" aria-pressed={tableView} onClick={() => setTableView(!tableView)}>
              {tableView ? <List size={15} aria-hidden="true" /> : <Table2 size={15} aria-hidden="true" />}
              {tableView ? '列表视图' : '表格视图'}
            </button>
          </div>
        </div>
        <div className="list-toolbar">
          <div className="search-box">
            <Search size={14} className="search-icon" aria-hidden="true" />
            <input
              type="text"
              placeholder="搜索本页任务或账号…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              aria-label="搜索任务或账号"
            />
            {keyword && (
              <button
                type="button"
                className="clear-btn"
                onClick={() => setKeyword('')}
                aria-label="清除搜索"
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          <select
            className="platform-select"
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            aria-label="按发布平台筛选"
          >
            <option value="all">全部平台</option>
            {platforms.map((platform) => <option key={platform} value={platform}>{platform === 'bilibili' ? 'B 站' : platformLabel[platform]}</option>)}
          </select>
        </div>
        {list.loading ? <Loading /> : !filteredItems.length ? empty : tableView ? <div className="table-scroll" tabIndex={0}
          role="region" aria-label="可横向滚动的任务明细">
          <table className="task-table" aria-label="发布任务明细">
            <thead><tr>{['任务', '平台', '账号', '计划时间', '状态', '异常'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>{filteredItems.map((task) => <tr key={task.id} className={active === task.id ? 'selected' : ''}>
              <th scope="row"><button type="button" className="task-table-title" aria-pressed={active === task.id}
                onClick={() => chooseTask(task.id)}>{task.variant.title?.trim() || '未命名任务'}</button></th>
              <td>{publishPlatformLabel(task.variant.platform, Boolean(task.variant.videoAssetId))}</td>
              <td>{task.account.displayName?.trim() || '未指定账号'}</td>
              <td>{formatTime(task.scheduledAt)}</td>
              <td><TaskBadge status={task.status} /></td>
              <td className="task-table-error">{task.lastError || '—'}</td>
            </tr>)}</tbody>
          </table>
        </div> : filteredItems.map((task) => <button key={task.id} type="button" className={`list-item ${active === task.id ? 'selected' : ''}`}
          aria-pressed={active === task.id} onClick={() => chooseTask(task.id)}>
          <span className="list-icon"><CalendarDays size={17} aria-hidden="true" /></span>
          <span className="list-copy"><strong>{task.variant.title?.trim() || '未命名任务'}</strong><small>{publishPlatformLabel(task.variant.platform, Boolean(task.variant.videoAssetId))} · {task.account.displayName?.trim() || '未指定账号'} · {formatTime(task.scheduledAt)}</small></span>
          <TaskBadge status={task.status} /><ChevronRight className="row-chevron" size={14} aria-hidden="true" />
        </button>)}
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
        refreshSummary();
      }} />
        : <section className="card detail-pane empty-detail">{list.loading ? <Loading />
          : <Empty icon={CalendarDays} title="在这里查看发布进度" description="为已审核的平台版本排期后，可以在这里查看交接与回执。" />}</section>}
    </div>}
  </>;
}
