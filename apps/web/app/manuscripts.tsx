import { useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown, ArrowUp, CalendarPlus, ChevronRight, CircleCheck, FileText, ImagePlus, Images, PencilLine, Plus,
  ShieldCheck, Sparkles,
} from 'lucide-react';
import {
  api, canEdit, canReview, fileBody, formatTime, imageUrl, post, useAction, useResource,
  type Account, type Manuscript, type ManuscriptSummary, type Role, type Variant,
} from './api';
import { Empty, Feedback, Loading, PageHeader, ReviewPicture } from './ui';

function variantLabel(variant?: Pick<Variant, 'status'>) {
  return variant?.status === 'approved' ? '已审核' : variant ? '待审核' : '未生成';
}

function rawFields(form: HTMLFormElement) {
  const fields = new FormData(form);
  return {
    title: String(fields.get('title') ?? ''),
    body: String(fields.get('body') ?? ''),
    tags: String(fields.get('tags') ?? ''),
  };
}

function textFields({ title, body, tags }: ReturnType<typeof rawFields>) {
  return {
    title: title.trim(),
    body: body.trim(),
    tags: tags.split(/[,，、\n]/).map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean),
  };
}

export type ManuscriptDrafts = Map<string, { fields: ReturnType<typeof rawFields>; assetIds?: string[] }>;

function TextFields({ values, disabled }: { values?: ReturnType<typeof rawFields>; disabled: boolean }) {
  return <>
    <label>标题<input name="title" autoFocus required disabled={disabled} maxLength={200} defaultValue={values?.title} placeholder="输入稿件标题" /></label>
    <label>正文<textarea name="body" required disabled={disabled} maxLength={50000} rows={7} defaultValue={values?.body} placeholder="粘贴或撰写图文正文" /></label>
    <label>话题 <small>选填</small><input name="tags" disabled={disabled} defaultValue={values?.tags} placeholder="多个话题用逗号分隔" /></label>
  </>;
}

function NewManuscript({ scope, drafts, draftKey, onSave, onCancel }: {
  scope: string; drafts: ManuscriptDrafts; draftKey: string; onSave: (id: string) => void; onCancel: () => void;
}) {
  const action = useAction();
  const [initial] = useState(() => drafts.get(draftKey)?.fields);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = textFields(rawFields(event.currentTarget));
    const submitted = drafts.get(draftKey);
    void action.run(async () => {
      const { id } = await post<{ id: string }>(scope + '/manuscripts', body);
      if (drafts.get(draftKey) === submitted) drafts.delete(draftKey);
      onSave(id);
    });
  }
  return <form className="card form-card form-stack detail-pane" onSubmit={submit} onInput={(event) => {
    const fields = rawFields(event.currentTarget);
    if (Object.values(fields).some(Boolean)) drafts.set(draftKey, { fields });
    else drafts.delete(draftKey);
  }}>
    <h2>新建原稿</h2>
    <TextFields values={initial} disabled={action.busy} />
    <Feedback error={action.error} />
    <div className="actions">
      <button className="button primary" disabled={action.busy}>{action.busy ? '正在创建…' : '创建原稿'}</button>
      <button type="button" className="button" disabled={action.busy} onClick={() => {
        drafts.delete(draftKey);
        onCancel();
      }}>取消</button>
    </div>
  </form>;
}

function EditVersion({ scope, variant, assets, drafts, draftKey, onSave, onCancel }: {
  scope: string; variant: Variant; assets: Manuscript['assets']; drafts: ManuscriptDrafts; draftKey: string;
  onSave: () => void; onCancel: () => void;
}) {
  const action = useAction();
  const form = useRef<HTMLFormElement>(null);
  const [initial] = useState(() => drafts.get(draftKey));
  const [assetIds, setAssetIds] = useState(() => initial?.assetIds ?? variant.assets.map((asset) => asset.assetId));
  function updatePictures(next: string[]) {
    setAssetIds(next);
    if (form.current) drafts.set(draftKey, { fields: rawFields(form.current), assetIds: next });
  }
  function move(index: number, offset: number) {
    const next = [...assetIds];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    updatePictures(next);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = textFields(rawFields(event.currentTarget));
    const submitted = drafts.get(draftKey);
    void action.run(async () => {
      await api(scope + '/variants/' + variant.id, { method: 'PATCH', body: { ...body, assetIds } });
      if (drafts.get(draftKey) === submitted) drafts.delete(draftKey);
      onSave();
    });
  }
  const available = assets.filter((asset) => !assetIds.includes(asset.id));
  return <form ref={form} className="form-stack" onSubmit={submit} onInput={(event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      drafts.set(draftKey, { fields: rawFields(event.currentTarget), assetIds });
    }
  }}>
    <TextFields values={initial?.fields ?? { ...variant, tags: variant.tags.join('，') }} disabled={action.busy} />
    <div className="field-group">
      <h3>发布图片</h3>
      <p className="muted">首图是小红书封面。调整图片会生成待审核的新版本。</p>
      <div className="picture-grid editing">
        {assetIds.map((id, index) => <div className="picture" key={id}>
          <ReviewPicture src={imageUrl(scope, id)} label={`发布图片 ${index + 1}`} />
          {index === 0 && <span className="picture-label">封面</span>}
          <div className="picture-tools">
            <button className="icon-button" type="button" aria-label={`上移第 ${index + 1} 张图片`} disabled={action.busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
            <button className="icon-button" type="button" aria-label={`下移第 ${index + 1} 张图片`} disabled={action.busy || index === assetIds.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
            <button className="text-button" type="button" disabled={action.busy} onClick={() => updatePictures(assetIds.filter((current) => current !== id))}>移除</button>
          </div>
        </div>)}
      </div>
      {available.length > 0 && <label>从原稿添加图片
        <select value="" disabled={action.busy} onChange={(event) => updatePictures([...assetIds, event.target.value])}>
          <option value="" disabled>选择原稿图片</option>
          {available.map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}
        </select>
      </label>}
    </div>
    <Feedback error={action.error} />
    <p className="muted small">保存后，旧版本的待发任务会暂停，新版本需要重新审核。</p>
    <div className="actions">
      <button className="button primary" disabled={action.busy}>保存为新版本</button>
      <button type="button" className="button" disabled={action.busy} onClick={() => {
        drafts.delete(draftKey);
        onCancel();
      }}>取消</button>
    </div>
  </form>;
}

function localDateTime() {
  const now = new Date(Date.now() + 5 * 60_000);
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Schedule({ scope, variant, accounts, onSchedule, openAccounts }: {
  scope: string; variant: Variant; accounts: Account[]; onSchedule: (id: string) => void; openAccounts: () => void;
}) {
  const action = useAction();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void action.run(async () => {
      const date = new Date(String(fields.get('scheduledAt')));
      if (!Number.isFinite(date.getTime())) throw new Error('请选择有效的交接时间。');
      const response = await post<{ items: { id: string }[] }>(scope + '/tasks', {
        variantIds: [variant.id], accountIds: [fields.get('accountId')], scheduledAt: date.toISOString(),
      });
      if (!response.items[0]) throw new Error('未收到任务编号。');
      onSchedule(response.items[0].id);
    });
  }
  return <div className="schedule">
    <h3><CalendarPlus size={17} aria-hidden="true" />排期交接</h3>
    {accounts.length ? <form className="form-stack" onSubmit={submit}>
      <div className="form-row">
        <label>小红书账号<select name="accountId" required defaultValue={accounts.length === 1 ? accounts[0]!.id : ''}>
          <option value="" disabled>选择人工账号</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
        </select></label>
        <label>交接时间 <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
          <input name="scheduledAt" type="datetime-local" required defaultValue={localDateTime()} />
        </label>
      </div>
      <Feedback error={action.error} />
      <button className="button primary" disabled={action.busy}>确认排期<ChevronRight size={15} aria-hidden="true" /></button>
    </form> : <p className="muted">排期前需要 <button type="button" className="text-button" onClick={openAccounts}>添加人工账号</button>。</p>}
  </div>;
}

function ManuscriptDetail({ scope, role, id, accounts, drafts, changed, onSchedule, openAccounts }: {
  scope: string; role: Role; id: string; accounts: ReturnType<typeof useResource<Account[]>>;
  drafts: ManuscriptDrafts;
  changed: () => void; onSchedule: (id: string) => void; openAccounts: () => void;
}) {
  const detail = useResource<Manuscript>(scope + '/manuscripts/' + id);
  const action = useAction();
  const [editing, setEditing] = useState<boolean | null>(null);
  const manuscript = detail.data;
  const variant = manuscript?.variants.find((item) => item.platform === 'xiaohongshu' && item.status !== 'superseded');
  const draftKey = scope + '/variants/' + variant?.id;
  const check = useResource<{ issues: { code: string; message: string }[] }>(variant ? scope + '/variants/' + variant.id + '/check' : null);
  const editable = canEdit(role);
  const approved = variant?.status === 'approved' && Boolean(variant.approval?.snapshotHash) && variant.snapshotVersion === 1;
  function refresh() { detail.refresh(); changed(); }
  function generate() {
    void action.run(async () => { await post(scope + '/manuscripts/' + id + '/generate', { platforms: ['xiaohongshu'] }); refresh(); }, '已生成平台版本。');
  }
  function approve() {
    if (!variant) return;
    void action.run(async () => {
      await post(scope + '/variants/' + variant.id + '/confirm', {});
      check.refresh();
      refresh();
    }, '已确认当前版本。');
  }
  function upload(files: File[]) {
    if (!files.length) return;
    void action.run(async () => {
      try {
        for (const file of files) await post(scope + '/manuscripts/' + id + '/assets', fileBody(file));
      } finally { refresh(); }
    }, '原稿配图已上传。');
  }
  if (!manuscript) return <section className="card detail-pane">{detail.loading ? <Loading /> : <Feedback error={detail.error} />}</section>;
  return <section className="card detail-pane manuscript-detail">
    <div className="detail-heading">
      <div className="detail-icon"><FileText size={22} aria-hidden="true" /></div>
      <div><h2>{manuscript.title}</h2><p>{manuscript.assets.length} 张原稿图片</p></div>
    </div>
    <div className="detail-content">
      <Feedback error={action.error || detail.error} notice={action.notice} />
      <details className="source">
        <summary>查看原稿正文</summary>
        <p className="content-text">{manuscript.body}</p>
      </details>
      <div className="section-line">
        <h3><Images size={17} aria-hidden="true" />原稿配图</h3>
        {editable && <label className="button compact upload-button">
          <ImagePlus size={16} aria-hidden="true" />上传图片
          <input type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="上传原稿配图" disabled={action.busy}
            onChange={(event) => {
              upload(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }} />
        </label>}
      </div>
      {manuscript.assets.length > 0 ? <div className="picture-grid source-pictures">
        {manuscript.assets.map((asset) => <div className="picture" key={asset.id}>
          <ReviewPicture src={imageUrl(scope, asset.id)} label={asset.filename} />
        </div>)}
      </div> : <p className="muted small">小红书图文至少需要 1 张配图。</p>}
      <div className="section-line variant-heading">
        <h3><span className="platform-icon" aria-hidden="true">红</span>小红书版本</h3>
        {variant && <span className={`badge ${approved ? 'green' : 'amber'}`}>{approved ? '已审核' : '待审核'}</span>}
      </div>
      {!variant ? <div className="sub-empty">
        <p>生成平台版本后，可检查文案、图片顺序和封面。</p>
        {editable && <button type="button" className="button primary" disabled={action.busy} onClick={generate}>
          <Sparkles size={16} aria-hidden="true" />生成小红书版本
        </button>}
      </div> : editable && (editing ?? drafts.has(draftKey)) ? <EditVersion key={variant.id} scope={scope} variant={variant}
        assets={manuscript.assets} drafts={drafts} draftKey={draftKey}
        onSave={() => { setEditing(false); refresh(); }} onCancel={() => setEditing(false)} />
        : <>
          <div className="variant-preview">
            <div className="section-line"><h3>{variant.title}</h3><span className="version">V{variant.version}</span></div>
            <p className="content-text">{variant.body}</p>
            {variant.tags.length > 0 && <div className="tag-row">{variant.tags.map((tag, index) => <span key={index}>#{tag}</span>)}</div>}
            {variant.assets.length > 0 && <div className="picture-grid">
              {variant.assets.map((asset) => <div className="picture" key={asset.assetId}>
                <ReviewPicture src={imageUrl(scope, asset.assetId)} label={asset.isCover ? '版本封面' : `版本图片 ${asset.position + 1}`} />
                {asset.isCover && <span className="picture-label">封面</span>}
              </div>)}
            </div>}
          </div>
          <Feedback error={check.error} />
          {check.data?.issues.length ? <div className="check-list" role="status">
            <strong>发布前检查</strong><ul>{check.data.issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>
          </div> : null}
          <div className="actions">
            {editable && <button type="button" className="button" disabled={action.busy} onClick={() => setEditing(true)}>
              <PencilLine size={16} aria-hidden="true" />编辑版本
            </button>}
            {canReview(role) && !approved && <button type="button" className="button primary"
              disabled={action.busy || !check.data || check.data.issues.length !== 0} onClick={approve}>
              <ShieldCheck size={17} aria-hidden="true" />确认审核
            </button>}
            {approved && variant.approval && <span className="approved-note"><CircleCheck size={16} aria-hidden="true" />
              {formatTime(variant.approval.approvedAt)} 确认
            </span>}
          </div>
          {approved && editable && <>{accounts.loading ? <Loading /> : accounts.error ? <Feedback error={accounts.error} />
            : <Schedule key={variant.id} scope={scope} variant={variant} onSchedule={onSchedule} openAccounts={openAccounts}
              accounts={accounts.data?.filter((account) => account.platform === 'xiaohongshu' && account.channelKind === 'manual') ?? []} />}</>}
        </>}
    </div>
  </section>;
}

export function Manuscripts({ scope, role, accounts, drafts, openTasks, openAccounts }: {
  scope: string; role: Role; accounts: ReturnType<typeof useResource<Account[]>>;
  drafts: ManuscriptDrafts;
  openTasks: (id: string) => void; openAccounts: () => void;
}) {
  const list = useResource<ManuscriptSummary[]>(scope + '/manuscripts');
  const [selection, setSelection] = useState('');
  const draftKey = scope + '/manuscripts/new';
  const [creating, setCreating] = useState(() => canEdit(role) && drafts.has(draftKey));
  const items = list.data ?? [];
  const active = selection || items[0]?.id || '';
  const start = () => setCreating(true);
  return <>
    <PageHeader title="原稿与审核" description="整理原稿与配图，确认可以交接的小红书版本。">
      {canEdit(role) && items.length > 0 && <button className="button primary" onClick={start}><Plus size={18} aria-hidden="true" />新建原稿</button>}
    </PageHeader>
    <Feedback error={list.error} />
    <div className="split-panel">
      <section className="card item-list">
        <div className="card-heading"><h2>原稿列表</h2><span className="count">{items.length}</span></div>
        {list.loading ? <Loading /> : items.length > 0 ? items.map((item) => {
          const variant = item.variants.find((candidate) => candidate.platform === 'xiaohongshu');
          return <button key={item.id} className={`list-item ${active === item.id && !creating ? 'selected' : ''}`}
            aria-pressed={active === item.id && !creating} onClick={() => { setSelection(item.id); setCreating(false); }}>
            <span className="list-icon"><FileText size={18} aria-hidden="true" /></span>
            <span className="list-copy"><strong>{item.title}</strong><small>{item.assetCount} 张图片 · {variantLabel(variant)}</small></span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>;
        }) : <Empty icon={FileText} title="暂无原稿" />}
      </section>
      {creating ? <NewManuscript scope={scope} drafts={drafts} draftKey={draftKey} onCancel={() => setCreating(false)} onSave={(id) => {
        setSelection(id); setCreating(false); list.refresh();
      }} /> : active ? <ManuscriptDetail key={active} scope={scope} role={role} id={active} accounts={accounts} drafts={drafts}
        changed={list.refresh} onSchedule={openTasks} openAccounts={openAccounts} />
        : <section className="card detail-pane empty-detail">
          {list.loading ? <Loading /> : <Empty icon={FileText} title="开始你的第一篇原稿" description="添加标题、正文和图片，然后生成可以送审的小红书图文。">
            {canEdit(role) && <button className="button primary" onClick={start}><Plus size={17} aria-hidden="true" />新建原稿</button>}
          </Empty>}
        </section>}
    </div>
  </>;
}
