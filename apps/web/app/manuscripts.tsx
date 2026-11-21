import { useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown, ArrowUp, CalendarPlus, ChevronRight, CircleCheck, FileText, ImagePlus, Images, PencilLine, Plus,
  ShieldCheck, Sparkles,
} from 'lucide-react';
import {
  api, canEdit, canReview, fileBody, formatTime, imageUrl, platformLabel, platforms, post, useAction, useResource,
  type Account, type Manuscript, type ManuscriptSummary, type ManuscriptVariant, type Platform, type Role, type Variant,
} from './api';
import { Empty, Feedback, Loading, PageHeader, PlatformIcon, ReviewPicture } from './ui';

function variantLabel(variant?: Pick<Variant, 'status'>) {
  return variant?.status === 'approved' ? '已审核' : variant ? '待审核' : '未生成';
}

function hasSnapshot(variant: ManuscriptVariant): variant is Variant {
  return Array.isArray(variant.assets) && typeof variant.snapshotVersion === 'number'
    && (variant.approval === null || typeof variant.approval?.snapshotHash === 'string' || variant.approval?.snapshotHash === null);
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

export type ManuscriptDrafts = Map<string, { fields: ReturnType<typeof rawFields>; assetIds?: string[]; coverAssetId?: string | null }>;

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
  const firstImageIsCover = variant.platform === 'xiaohongshu';
  const [coverAssetId, setCoverAssetId] = useState(() => initial?.coverAssetId === undefined
    ? variant.assets.find(({ isCover }) => isCover)?.assetId ?? null : initial.coverAssetId);
  function keepDraft(next: string[], cover: string | null) {
    if (form.current) drafts.set(draftKey, { fields: rawFields(form.current), assetIds: next, coverAssetId: cover });
  }
  function updatePictures(next: string[]) {
    const nextCover = coverAssetId && next.includes(coverAssetId) ? coverAssetId : null;
    setAssetIds(next);
    setCoverAssetId(nextCover);
    keepDraft(next, nextCover);
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
      await api(scope + '/variants/' + variant.id, {
        method: 'PATCH', body: { ...body, assetIds, coverAssetId: firstImageIsCover ? undefined : coverAssetId },
      });
      if (drafts.get(draftKey) === submitted) drafts.delete(draftKey);
      onSave();
    });
  }
  const available = assets.filter((asset) => !assetIds.includes(asset.id));
  return <form ref={form} className="form-stack" onSubmit={submit} onInput={(event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      keepDraft(assetIds, coverAssetId);
    }
  }}>
    <TextFields values={initial?.fields ?? { ...variant, tags: variant.tags.join('，') }} disabled={action.busy} />
    <div className="field-group">
      <h3>发布图片</h3>
      <p className="muted">{firstImageIsCover ? '首图为封面。' : ''}调整图片会生成待审核的新版本。</p>
      <div className="picture-grid editing">
        {assetIds.map((id, index) => <div className="picture" key={id}>
          <ReviewPicture src={imageUrl(scope, id)} label={`发布图片 ${index + 1}`} />
          {(firstImageIsCover ? index === 0 : id === coverAssetId) && <span className="picture-label">封面</span>}
          <div className="picture-tools">
            <button className="icon-button" type="button" aria-label={`上移第 ${index + 1} 张图片`} disabled={action.busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
            <button className="icon-button" type="button" aria-label={`下移第 ${index + 1} 张图片`} disabled={action.busy || index === assetIds.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
            <button className="text-button" type="button" disabled={action.busy} onClick={() => updatePictures(assetIds.filter((current) => current !== id))}>移除</button>
          </div>
        </div>)}
      </div>
      {!firstImageIsCover && assetIds.length > 0 && <label>封面
        <select value={coverAssetId ?? ''} disabled={action.busy} onChange={(event) => {
          const cover = event.target.value || null;
          setCoverAssetId(cover);
          keepDraft(assetIds, cover);
        }}>
          <option value="">不指定封面</option>
          {assetIds.map((id, index) => <option key={id} value={id}>第 {index + 1} 张图</option>)}
        </select>
      </label>}
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
        variantIds: [variant.id], accountIds: [String(fields.get('accountId') ?? '')], scheduledAt: date.toISOString(),
      });
      if (!response.items[0]) throw new Error('未收到任务编号。');
      onSchedule(response.items[0].id);
    });
  }
  return <div className="schedule">
    <h3><CalendarPlus size={17} aria-hidden="true" />排期交接</h3>
    {accounts.length ? <form className="form-stack" onSubmit={submit}>
      <div className="form-row">
        <label>{platformLabel[variant.platform]}账号<select name="accountId" required defaultValue={accounts.length === 1 ? accounts[0]!.id : ''}>
          <option value="" disabled>选择人工账号</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
        </select></label>
        <label>交接时间 <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
          <input name="scheduledAt" type="datetime-local" required defaultValue={localDateTime()} />
        </label>
      </div>
      <Feedback error={action.error} />
      <button className="button primary" disabled={action.busy}>确认排期<ChevronRight size={15} aria-hidden="true" /></button>
    </form> : <p className="muted">排期前需要 <button type="button" className="text-button" onClick={openAccounts}>
      添加{platformLabel[variant.platform]}人工账号</button>。</p>}
  </div>;
}

function ManuscriptDetail({ scope, role, id, accounts, drafts, changed, onApproved, onSchedule, openAccounts }: {
  scope: string; role: Role; id: string; accounts: ReturnType<typeof useResource<Account[]>>;
  drafts: ManuscriptDrafts;
  changed: () => void; onApproved?: (title: string) => void; onSchedule: (id: string) => void; openAccounts: () => void;
}) {
  const detail = useResource<Manuscript>(scope + '/manuscripts/' + id);
  const action = useAction();
  const [editing, setEditing] = useState<boolean | null>(null);
  const [selectedPlatform, setPlatform] = useState<Platform>();
  const manuscript = detail.data;
  const currentVariants = manuscript?.variants.filter(({ status }) => status !== 'superseded') ?? [];
  const pending = role === 'reviewer' ? currentVariants.find(({ status }) => status === 'draft') : undefined;
  const platform = selectedPlatform ?? pending?.platform
    ?? platforms.find((candidate) => currentVariants.some((variant) => variant.platform === candidate)) ?? platforms[0];
  const variant = currentVariants.find((item) => item.platform === platform);
  const snapshot = variant && hasSnapshot(variant) ? variant : undefined;
  const draftKey = scope + '/variants/' + variant?.id;
  const check = useResource<{ issues: { code: string; message: string }[] }>(snapshot ? scope + '/variants/' + snapshot.id + '/check' : null);
  const issues = Array.isArray(check.data?.issues) ? check.data.issues : undefined;
  const editable = canEdit(role);
  const approved = snapshot?.status === 'approved' && Boolean(snapshot.approval?.snapshotHash) && snapshot.snapshotVersion === 1;
  function refresh() { detail.refresh(); changed(); }
  function generate(targets: readonly Platform[]) {
    const targetPlatform = targets.length === 1 ? targets[0]! : platform;
    setPlatform(targetPlatform);
    void action.run(async () => {
      await post(scope + '/manuscripts/' + id + '/generate', { platforms: targets });
      refresh();
    }, '已生成平台版本。');
  }
  function approve() {
    if (!snapshot || !manuscript || !issues || issues.length !== 0) return;
    setPlatform(snapshot.platform);
    void action.run(async () => {
      await post(scope + '/variants/' + snapshot.id + '/confirm', {});
      check.refresh();
      refresh();
      onApproved?.(manuscript.title);
    }, onApproved ? '' : '已确认当前版本。');
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
      </div> : <p className="muted small">暂无配图。小红书图文至少需要 1 张。</p>}
      <div className="section-line variant-heading">
        <h3><PlatformIcon platform={platform} />{platformLabel[platform]}版本</h3>
        {snapshot && <span className={`badge ${approved ? 'green' : 'amber'}`}>{approved ? '已审核' : '待审核'}</span>}
      </div>
      <div className="filters platform-options" role="group" aria-label="按平台查看版本">
        {platforms.map((candidate) => {
          const current = currentVariants.find((version) => version.platform === candidate);
          return <button type="button" key={candidate} className={platform === candidate ? 'active' : ''}
            aria-pressed={platform === candidate} disabled={action.busy} onClick={() => {
              if (platform === candidate) return;
              action.reset(); setPlatform(candidate); setEditing(null);
            }}>{platformLabel[candidate]} <small>{variantLabel(current)}</small></button>;
        })}
      </div>
      {!variant ? <div className="sub-empty">
        <p>生成平台版本后，可检查文案、图片顺序和封面。</p>
        {editable && <div className="actions">
          <button type="button" className="button primary" disabled={action.busy} onClick={() => generate([platform])}>
            <Sparkles size={16} aria-hidden="true" />生成{platformLabel[platform]}版本
          </button>
          {!currentVariants.length && <button type="button" className="button" disabled={action.busy}
            onClick={() => generate(platforms)}>一次生成两个平台版本</button>}
        </div>}
      </div> : snapshot && editable && (editing ?? drafts.has(draftKey)) ? <EditVersion key={snapshot.id} scope={scope} variant={snapshot}
        assets={manuscript.assets} drafts={drafts} draftKey={draftKey}
        onSave={() => { setPlatform(snapshot.platform); setEditing(false); refresh(); }} onCancel={() => setEditing(false)} />
        : <>
          <div className="variant-preview">
            <div className="section-line"><h3>{variant.title}</h3><span className="version">V{variant.version}</span></div>
            <p className="content-text">{variant.body}</p>
            {variant.tags.length > 0 && <div className="tag-row">{variant.tags.map((tag, index) => <span key={index}>#{tag}</span>)}</div>}
            {snapshot && snapshot.assets.length > 0 && <div className="picture-grid">
              {snapshot.assets.map((asset) => <div className="picture" key={asset.assetId}>
                <ReviewPicture src={imageUrl(scope, asset.assetId)} label={asset.isCover ? '版本封面' : `版本图片 ${asset.position + 1}`} />
                {asset.isCover && <span className="picture-label">封面</span>}
              </div>)}
            </div>}
          </div>
          <Feedback error={snapshot ? check.error : 'API 未返回版本图片快照。当前可查看文案，使用与工作台同版本的 API 后可继续编辑、审核和排期。'} />
          {issues?.length ? <div className="check-list" role="status">
            <strong>发布前检查</strong><ul>{issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>
            {editable && issues.some(({ code }) => code === 'images_missing') &&
              <p>上传原稿配图后，在「编辑版本」中将图片加入当前平台版本。</p>}
          </div> : null}
          <div className="actions">
            {snapshot && editable && <button type="button" className="button" disabled={action.busy} onClick={() => setEditing(true)}>
              <PencilLine size={16} aria-hidden="true" />编辑版本
            </button>}
            {snapshot && canReview(role) && !approved && <button type="button" className="button primary"
              disabled={action.busy || !issues || issues.length !== 0} onClick={approve}>
              <ShieldCheck size={17} aria-hidden="true" />确认审核
            </button>}
            {approved && snapshot?.approval && <span className="approved-note"><CircleCheck size={16} aria-hidden="true" />
              {formatTime(snapshot.approval.approvedAt)} 确认
            </span>}
          </div>
          {snapshot && approved && editable && <>{accounts.loading ? <Loading /> : accounts.error ? <Feedback error={accounts.error} />
            : <Schedule key={snapshot.id} scope={scope} variant={snapshot} onSchedule={onSchedule} openAccounts={openAccounts}
              accounts={accounts.data?.filter((account) => account.platform === platform && account.channelKind === 'manual') ?? []} />}</>}
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
  const [pendingOnly, setPendingOnly] = useState(role === 'reviewer');
  const [reviewNotice, setReviewNotice] = useState('');
  const draftKey = scope + '/manuscripts/new';
  const [creating, setCreating] = useState(() => canEdit(role) && drafts.has(draftKey));
  const allItems = list.data ?? [];
  const items = pendingOnly ? allItems.filter(({ variants }) =>
    variants.some(({ status }) => status === 'draft')) : allItems;
  const selected = !pendingOnly || items.some(({ id }) => id === selection) ? selection : '';
  const active = selected || items[0]?.id || '';
  const start = () => setCreating(true);
  return <>
    <PageHeader title={pendingOnly ? '待审核原稿' : '原稿与审核'}
      description={role === 'reviewer' ? '按平台审核文案、配图和封面。' : canEdit(role)
        ? '从一篇原稿生成各平台版本，分别审核并排期。' : '查阅原稿和各平台版本。'}>
      {canEdit(role) && items.length > 0 && <button className="button primary" onClick={start}><Plus size={18} aria-hidden="true" />新建原稿</button>}
    </PageHeader>
    {role === 'reviewer' && <div className="filters" aria-label="按审核状态筛选">
      <button type="button" className={pendingOnly ? 'active' : ''} aria-pressed={pendingOnly}
        onClick={() => { setPendingOnly(true); setSelection(''); setReviewNotice(''); }}>待审核</button>
      <button type="button" className={!pendingOnly ? 'active' : ''} aria-pressed={!pendingOnly}
        onClick={() => { setPendingOnly(false); setSelection(''); setReviewNotice(''); }}>全部原稿</button>
    </div>}
    <Feedback error={list.error} notice={pendingOnly ? reviewNotice : undefined} />
    <div className="split-panel">
      <section className="card item-list">
        <div className="card-heading"><h2>原稿列表</h2><span className="count">{items.length}</span></div>
        {list.loading ? <Loading /> : items.length > 0 ? items.map((item) => {
          const variants = item.variants.filter(({ status }) => status !== 'superseded');
          const pending = variants.filter(({ status }) => status === 'draft').length;
          return <button key={item.id} className={`list-item ${active === item.id && !creating ? 'selected' : ''}`}
            aria-pressed={active === item.id && !creating} onClick={() => { setSelection(item.id); setCreating(false); setReviewNotice(''); }}>
            <span className="list-icon"><FileText size={18} aria-hidden="true" /></span>
            <span className="list-copy"><strong>{item.title}</strong><small>{item.assetCount} 张图片 · {variants.length
              ? `${variants.length} 个版本 · ${pending ? `${pending} 个待审核` : '已审核'}` : '未生成版本'}</small></span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>;
        }) : <Empty icon={FileText} title={pendingOnly ? '暂无待审核原稿' : '暂无原稿'} />}
      </section>
      {creating ? <NewManuscript scope={scope} drafts={drafts} draftKey={draftKey} onCancel={() => setCreating(false)} onSave={(id) => {
        setSelection(id); setCreating(false); list.refresh();
      }} /> : active ? <ManuscriptDetail key={active} scope={scope} role={role} id={active} accounts={accounts} drafts={drafts}
        changed={list.refresh} onApproved={pendingOnly ? (title) => setReviewNotice(`「${title}」已确认审核。`) : undefined}
        onSchedule={openTasks} openAccounts={openAccounts} />
        : <section className="card detail-pane empty-detail">
          {list.loading ? <Loading /> : <Empty icon={FileText} title={canEdit(role) ? '开始你的第一篇原稿' : '暂无原稿可查看'}
            description={pendingOnly ? '编辑生成平台版本后会出现在这里。' : canEdit(role)
              ? '添加标题、正文和图片，然后生成各平台版本。' : '工作室有原稿后，可在这里查看。'}>
            {canEdit(role) && <button className="button primary" onClick={start}><Plus size={17} aria-hidden="true" />新建原稿</button>}
          </Empty>}
        </section>}
    </div>
  </>;
}
