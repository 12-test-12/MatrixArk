import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CalendarPlus, ChevronRight, CircleCheck, FileText, ImagePlus, Images, PencilLine, Plus,
  ShieldCheck, Sparkles,
} from 'lucide-react';
import {
  api, canEdit, canReview, fileBody, formatTime, imageUrl, platforms, post, publishPlatformLabel, useAction, useResource,
  type Account, type Manuscript, type ManuscriptSummary, type ManuscriptVariant, type Platform, type Role, type Variant,
} from './api';
import { Empty, Feedback, Loading, PageHeader, PlatformIcon, ReviewPicture } from './ui';

type ReviewFilter = 'all' | 'pending' | 'returned';

function variantLabel(variant?: Pick<Variant, 'status' | 'returned'>) {
  if (!variant) return '未生成';
  if (variant.returned) return '已退回';
  return variant.status === 'approved' ? '已审核' : '待审核';
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
    category: String(fields.get('category') ?? ''),
    summary: String(fields.get('summary') ?? ''),
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

function DraftPreview({ fields, name, cover, video }: {
  fields?: ReturnType<typeof rawFields>; name?: string; cover?: string; video?: string;
}) {
  const draft = fields && textFields(fields);
  return <aside className="draft-preview" aria-label="实时预览">
    <h3>实时预览{name ? ` · ${name}` : ''}</h3>
    <div className="draft-preview-content">
      {video ? <video controls preload="metadata" poster={cover} src={video} aria-label="当前视频预览" />
        : cover ? <img src={cover} alt="当前封面" /> : null}
      <h4 className={draft?.title ? '' : 'muted'}>{draft?.title || '稿件标题'}</h4>
      <p className={`content-text${draft?.body ? '' : ' muted'}`}>{draft?.body || '输入正文后会显示在这里。'}</p>
      {!!draft?.tags.length && <div className="tag-row">
        {draft.tags.map((tag, index) => <span key={index}>#{tag}</span>)}
      </div>}
    </div>
  </aside>;
}

function TextFields({ values, disabled }: { values?: Pick<ReturnType<typeof rawFields>, 'title' | 'body' | 'tags'>; disabled: boolean }) {
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
  const [live, setLive] = useState(initial);
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
  return <section className="card form-card detail-pane draft-compose">
    <div className="draft-compose-grid"><form className="form-stack" onSubmit={submit} onInput={(event) => {
    const fields = rawFields(event.currentTarget);
    setLive(fields);
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
  </form><DraftPreview fields={live} /></div></section>;
}

function EditVersion({ scope, variant, assets, drafts, draftKey, onSave, onCancel }: {
  scope: string; variant: Variant; assets: Manuscript['assets']; drafts: ManuscriptDrafts; draftKey: string;
  onSave: () => void; onCancel: () => void;
}) {
  const action = useAction();
  const form = useRef<HTMLFormElement>(null);
  const [initial] = useState(() => drafts.get(draftKey));
  const [live, setLive] = useState(() => initial?.fields ?? {
    title: variant.title, body: variant.body, tags: variant.tags.join('，'), category: '', summary: '',
  });
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
    const fields = rawFields(event.currentTarget);
    const body = textFields(fields);
    const platformFields = variant.platform === 'bilibili' && !variant.videoAsset ? { ...variant.platformFields } : undefined;
    if (platformFields) {
      const target: Record<string, unknown> = platformFields;
      for (const key of ['category', 'summary'] as const) {
        const value = fields[key].trim();
        if (value) target[key] = value;
        else delete target[key];
      }
    }
    const submitted = drafts.get(draftKey);
    void action.run(async () => {
      await api(scope + '/variants/' + variant.id, {
        method: 'PATCH', body: { ...body, assetIds, coverAssetId: firstImageIsCover ? undefined : coverAssetId,
          platformFields },
      });
      if (drafts.get(draftKey) === submitted) drafts.delete(draftKey);
      onSave();
    });
  }
  const available = assets.filter((asset) => !assetIds.includes(asset.id));
  const previewCover = firstImageIsCover ? assetIds[0] : coverAssetId;
  return <div className="draft-compose"><div className="draft-compose-grid">
    <form ref={form} className="form-stack" onSubmit={submit} onInput={(event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      setLive(rawFields(event.currentTarget));
      keepDraft(assetIds, coverAssetId);
    }
  }}>
    <TextFields values={initial?.fields ?? { ...variant, tags: variant.tags.join('，') }} disabled={action.busy} />
    {variant.platform === 'bilibili' && !variant.videoAsset && <div className="field-group">
      <h3>B 站官方投稿</h3>
      <label>专栏子分类 ID<input name="category" inputMode="numeric" pattern="[0-9]+" maxLength={20}
        disabled={action.busy} defaultValue={initial?.fields.category ?? String(variant.platformFields?.category ?? '')} /></label>
      <label>专栏摘要 <small>官方投稿至少 200 字</small><textarea name="summary" rows={4} disabled={action.busy}
        defaultValue={initial?.fields.summary ?? String(variant.platformFields?.summary ?? '')} /></label>
    </div>}
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
  </form>
    <DraftPreview fields={live} name={publishPlatformLabel(variant.platform, Boolean(variant.videoAsset))}
      cover={previewCover ? imageUrl(scope, previewCover) + '/thumbnail' : undefined}
      video={variant.videoAsset ? imageUrl(scope, variant.videoAsset.id) + '/video' : undefined} />
  </div></div>;
}

function localDateTime() {
  const now = new Date(Date.now() + 5 * 60_000);
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Schedule({ scope, variants, accounts, onSchedule, openAccounts }: {
  scope: string; variants: Variant[]; accounts: Account[]; onSchedule: (id: string) => void; openAccounts: () => void;
}) {
  const action = useAction();
  const targets = accounts.filter((account) => (account.availableForHandoff || account.availableForOfficial)
    && variants.some(({ platform, videoAsset }) => platform === account.platform && (!videoAsset || account.channelKind !== 'official')));
  const [selection, setSelection] = useState<string[]>([]);
  const selected = targets.length === 1 ? targets : targets.filter(({ id }) => selection.includes(id));
  function selectAccounts(ids: string[], checked: boolean) {
    setSelection((current) => checked ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id)));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void action.run(async () => {
      const date = new Date(String(fields.get('scheduledAt')));
      if (!Number.isFinite(date.getTime())) throw new Error('请选择有效的排期时间。');
      const response = await post<{ items: { id: string }[] }>(scope + '/tasks', {
        variantIds: variants.filter(({ platform }) => selected.some((account) => account.platform === platform)).map(({ id }) => id),
        accountIds: selected.map(({ id }) => id),
        scheduledAt: date.toISOString(),
      });
      if (!response.items[0]) throw new Error('未收到任务编号。');
      onSchedule(response.items[0].id);
    });
  }
  return <div className="schedule">
    <h3><CalendarPlus size={17} aria-hidden="true" />安排发布</h3>
    {targets.length ? <form className="form-stack" onSubmit={submit}>
      {variants.map((variant) => {
        const group = targets.filter(({ platform }) => platform === variant.platform);
        if (!group.length) return null;
        const groupIds = group.map(({ id }) => id);
        const allSelected = group.every(({ id }) => selection.includes(id));
        return <fieldset className="schedule-accounts" key={variant.id} disabled={action.busy}>
          <legend>{publishPlatformLabel(variant.platform, Boolean(variant.videoAsset))} · V{variant.version}</legend>
          {group.length > 1 && <button type="button" className="text-button"
            onClick={() => selectAccounts(groupIds, !allSelected)}>
            {allSelected ? '取消全选' : '全选'}{publishPlatformLabel(variant.platform, Boolean(variant.videoAsset))}账号
          </button>}
          {group.map((account) => <label key={account.id}>
            <input type="checkbox" checked={selected.some(({ id }) => id === account.id)} disabled={targets.length === 1}
              onChange={(event) => selectAccounts([account.id], event.currentTarget.checked)} />
            <span>{account.displayName} · {account.channelKind === 'sandbox' ? '沙箱模拟' : account.availableForOfficial ? '自动投稿' : '人工交接'}</span>
          </label>)}
        </fieldset>;
      })}
      <label>排期时间 <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
        <input name="scheduledAt" type="datetime-local" required disabled={action.busy} defaultValue={localDateTime()} />
      </label>
      <Feedback error={action.error} />
      <button className="button primary" disabled={action.busy || selected.length === 0}>
        {selected.length ? `为 ${selected.length} 个账号排期` : '选择账号后排期'}<ChevronRight size={15} aria-hidden="true" />
      </button>
    </form> : <p className="muted">已审版本暂无可用账号。<button type="button" className="text-button" onClick={openAccounts}>
      查看账号与授权状态</button>。</p>}
  </div>;
}

function ManuscriptDetail({ scope, role, id, accounts, drafts, reviewFilter, changed, onReview, onSchedule, openAccounts }: {
  scope: string; role: Role; id: string; accounts: ReturnType<typeof useResource<Account[]>>;
  drafts: ManuscriptDrafts; reviewFilter: ReviewFilter;
  changed: () => void; onReview?: (message: string) => void; onSchedule: (id: string) => void; openAccounts: () => void;
}) {
  const detail = useResource<Manuscript>(scope + '/manuscripts/' + id);
  const action = useAction();
  const videoAction = useAction();
  const [pickedVideo, setPickedVideo] = useState<File>();
  const [pickedVideoUrl, setPickedVideoUrl] = useState('');
  useEffect(() => {
    if (!pickedVideo) return;
    const url = URL.createObjectURL(pickedVideo);
    setPickedVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pickedVideo]);
  const [editing, setEditing] = useState<boolean | null>(null);
  const [selectedPlatform, setPlatform] = useState<Platform>();
  const [rejecting, setRejecting] = useState(false);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const rejectFormId = useId();
  const manuscript = detail.data;
  const currentVariants = manuscript?.variants.filter(({ status }) => status !== 'superseded') ?? [];
  const relevant = reviewFilter === 'all' ? undefined : currentVariants.find(({ status, returned }) =>
    status === 'draft' && Boolean(returned) === (reviewFilter === 'returned'));
  const platform = selectedPlatform ?? relevant?.platform
    ?? platforms.find((candidate) => currentVariants.some((variant) => variant.platform === candidate)) ?? platforms[0];
  const variant = currentVariants.find((item) => item.platform === platform);
  const snapshot = variant && hasSnapshot(variant) ? variant : undefined;
  const draftKey = scope + '/variants/' + variant?.id;
  const check = useResource<{ issues: { code: string; message: string }[] }>(snapshot ? scope + '/variants/' + snapshot.id + '/check' : null);
  const issues = Array.isArray(check.data?.issues) ? check.data.issues : undefined;
  const editable = canEdit(role) && !manuscript?.archivedAt;
  const approvedVersions = currentVariants.filter(hasSnapshot).filter((item) =>
    item.status === 'approved' && Boolean(item.approval?.snapshotHash) && item.snapshotVersion === 1);
  const approved = approvedVersions.some((item) => item.id === snapshot?.id);
  const reviewable = snapshot?.status === 'draft' && !snapshot.returned && !manuscript?.archivedAt && canReview(role);
  const pastRejections = manuscript?.variants.filter(({ status, rejections }) => status === 'superseded' && rejections?.length) ?? [];
  const editingVersion = snapshot && editable && (editing ?? drafts.has(draftKey));
  function refresh() { detail.refresh(); changed(); }
  function archive() {
    if (!manuscript) return;
    const restoring = Boolean(manuscript.archivedAt);
    if (!restoring && !window.confirm(`归档「${manuscript.title}」？待发任务会暂停，历史任务和稿件资料仍可查看。`)) return;
    void action.run(async () => {
      const path = scope + '/manuscripts/' + id;
      await api(restoring ? path + '/restore' : path, { method: restoring ? 'PATCH' : 'DELETE' });
      refresh();
    }, restoring ? '稿件已恢复。' : '稿件已归档。');
  }
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
      onReview?.(`「${manuscript.title}」的${publishPlatformLabel(snapshot.platform, Boolean(snapshot.videoAsset))}版本已确认。`);
    });
  }
  function reject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !manuscript || !reviewable) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    setPlatform(snapshot.platform);
    void action.run(async () => {
      if (!reason) throw new Error('请填写退回原因。');
      await post(scope + '/variants/' + snapshot.id + '/reject', { reason });
      setRejecting(false);
      refresh();
      onReview?.(`「${manuscript.title}」的${publishPlatformLabel(snapshot.platform, Boolean(snapshot.videoAsset))}版本已退回。`);
    });
  }
  function upload(files: File[]) {
    if (!files.length) return;
    void action.run(async () => {
      try {
        for (const file of files) await post(scope + '/manuscripts/' + id + '/assets', fileBody(file));
      } finally { refresh(); }
    }, '原稿配图已上传。');
  }
  function uploadVideo(file?: File) {
    if (!file) return;
    setPickedVideo(file);
    void videoAction.run(async () => {
      if (file.size > 100 * 1024 * 1024) throw new Error('视频不能超过 100 MiB。');
      await api(scope + '/manuscripts/' + id + '/video?filename=' + encodeURIComponent(file.name), { method: 'PUT', body: file });
      setPickedVideo(undefined);
      refresh();
    }, '视频已保存，可以查看和审核平台版本。');
  }
  if (!manuscript) return <section className="card detail-pane">{detail.loading ? <Loading /> : <Feedback error={detail.error} />}</section>;
  return <section className="card detail-pane manuscript-detail">
    <div className="detail-heading">
      <div className="detail-icon"><FileText size={22} aria-hidden="true" /></div>
      <div><h2>{manuscript.title}</h2><p>{manuscript.assets.length} 张原稿图片
        {manuscript.archivedAt && ` · 归档于 ${formatTime(manuscript.archivedAt)}`}</p></div>
      {canEdit(role) && <button type="button" className="button compact" disabled={action.busy} onClick={archive}>
        {manuscript.archivedAt ? '恢复稿件' : '归档稿件'}
      </button>}
    </div>
    <div className="detail-content">
      <Feedback error={(!rejecting ? action.error : '') || detail.error} notice={action.notice} />
      <details className="source">
        <summary>查看原稿正文</summary>
        <p className="content-text">{manuscript.body}</p>
      </details>
      <div className="section-line">
        <h3>视频素材</h3>
        {editable && <label className="button compact upload-button">
          {videoAction.busy ? '正在上传…' : manuscript.videoAsset ? '替换视频' : '上传视频'}
          <input type="file" accept=".mp4,video/mp4" disabled={action.busy || videoAction.busy}
            aria-label={manuscript.videoAsset ? '替换原稿视频' : '上传原稿视频'} onChange={(event) => {
              uploadVideo(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }} />
        </label>}
      </div>
      <Feedback error={videoAction.error} notice={videoAction.notice} />
      {pickedVideo ? <div className="video-asset">
        {pickedVideoUrl && <video controls preload="metadata" aria-label="本地视频预览" src={pickedVideoUrl} />}
        <p className="muted small">{pickedVideo.name} · {videoAction.busy ? '正在上传' : '本地预览'}</p>
        {videoAction.error && <div className="actions">
          <button type="button" className="button compact" onClick={() => uploadVideo(pickedVideo)}>重试上传</button>
          <button type="button" className="button compact" onClick={() => { setPickedVideo(undefined); videoAction.reset(); }}>取消</button>
        </div>}
      </div> : manuscript.videoAsset ? <div className="video-asset">
        <video controls preload="metadata" aria-label="原稿视频" src={imageUrl(scope, manuscript.videoAsset.id) + '/video'} />
        <p className="muted small">{manuscript.videoAsset.filename}</p>
      </div> : editable && <p className="muted small">发视频时上传一份 MP4，最多 100 MiB。</p>}
      <div className="section-line">
        <h3><Images size={17} aria-hidden="true" />{manuscript.videoAsset ? '视频封面与配图' : '原稿配图'}</h3>
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
        <h3><PlatformIcon platform={platform} />{publishPlatformLabel(platform, Boolean(manuscript.videoAsset))}版本</h3>
        {variant && <span className={`badge ${approved ? 'green' : 'amber'}`}>{variantLabel(variant)}</span>}
      </div>
      <div className="filters platform-options" role="group" aria-label="按平台查看版本">
        {platforms.map((candidate) => {
          const current = currentVariants.find((version) => version.platform === candidate);
          return <button type="button" key={candidate} className={platform === candidate ? 'active' : ''}
            aria-pressed={platform === candidate} disabled={action.busy} onClick={() => {
              if (platform === candidate) return;
              action.reset(); setPlatform(candidate); setEditing(null); setRejecting(false);
            }}>{publishPlatformLabel(candidate, Boolean(manuscript.videoAsset))} <small>{variantLabel(current)}</small></button>;
        })}
      </div>
      {!variant ? <div className="sub-empty">
        <p>生成平台版本后，可检查文案、图片顺序和封面。</p>
        {editable && <div className="actions">
          <button type="button" className="button primary" disabled={action.busy} onClick={() => generate([platform])}>
            <Sparkles size={16} aria-hidden="true" />生成{publishPlatformLabel(platform, Boolean(manuscript.videoAsset))}版本
          </button>
          {!currentVariants.length && <button type="button" className="button" disabled={action.busy}
            onClick={() => generate(platforms)}>一次生成两个平台版本</button>}
        </div>}
      </div> : snapshot && editingVersion ? <EditVersion key={snapshot.id} scope={scope} variant={snapshot}
        assets={manuscript.assets} drafts={drafts} draftKey={draftKey}
        onSave={() => {
          setPlatform(snapshot.platform); setEditing(false); refresh();
          if (snapshot.returned) onReview?.(`「${manuscript.title}」已保存新版本，重新进入待审核。`);
        }} onCancel={() => setEditing(false)} />
        : <>
          <div className="variant-preview">
            <div className="section-line"><h3>{variant.title}</h3><span className="version">V{variant.version}</span></div>
            <p className="content-text">{variant.body}</p>
            {variant.videoAsset && <div className="video-asset">
              <video controls preload="none" aria-label="待审核版本视频" src={imageUrl(scope, variant.videoAsset.id) + '/video'} />
              <p className="muted small">{variant.videoAsset.filename}</p>
            </div>}
            {variant.platform === 'bilibili' && !variant.videoAsset && typeof variant.platformFields?.summary === 'string' && variant.platformFields.summary &&
              <div className="field-group">
                <h4>专栏摘要 · 分类 {String(variant.platformFields.category ?? '')}</h4>
                <p className="content-text">{variant.platformFields.summary}</p>
              </div>}
            {variant.tags.length > 0 && <div className="tag-row">{variant.tags.map((tag, index) => <span key={index}>#{tag}</span>)}</div>}
            {snapshot && snapshot.assets.length > 0 && <div className="picture-grid">
              {snapshot.assets.map((asset) => <div className="picture" key={asset.assetId}>
                <ReviewPicture src={imageUrl(scope, asset.assetId)} label={asset.isCover ? '版本封面' : `版本图片 ${asset.position + 1}`} />
                {asset.isCover && <span className="picture-label">封面</span>}
              </div>)}
            </div>}
          </div>
          {variant.returned && variant.rejections?.length ? <div className="check-list">
            <strong>退回意见</strong>
            {variant.rejections.map((item) => <div key={item.id}>
              <p className="muted small">{item.reviewer?.name ?? '审核人'} · {formatTime(item.createdAt)}</p>
              <p className="content-text">{item.reason}</p>
            </div>)}
            {editable && <p>按意见编辑并保存新版本后，稿件会重新进入待审核。</p>}
          </div> : null}
          <Feedback error={snapshot ? check.error : 'API 未返回版本图片快照。当前可查看文案，使用与工作台同版本的 API 后可继续编辑、审核和排期。'} />
          {issues?.length ? <div className="check-list" role="status">
            <strong>发布前检查</strong><ul>{issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>
            {editable && issues.some(({ code }) => code === 'images_missing') &&
              <p>上传原稿配图后，在「编辑版本」中将图片加入当前平台版本。</p>}
          </div> : null}
          <div className="actions">
            {snapshot && editable && !rejecting && <button type="button" className="button" disabled={action.busy} onClick={() => setEditing(true)}>
              <PencilLine size={16} aria-hidden="true" />编辑版本
            </button>}
            {reviewable && !rejecting && <button type="button" className="button primary"
              disabled={action.busy || !issues || issues.length !== 0} onClick={approve}>
              <ShieldCheck size={17} aria-hidden="true" />确认审核
            </button>}
            {reviewable && <button ref={rejectButton} type="button" className="button" disabled={action.busy}
              aria-expanded={rejecting} aria-controls={rejecting ? rejectFormId : undefined}
              onClick={() => { action.reset(); setRejecting(!rejecting); }}>退回修改</button>}
            {approved && snapshot?.approval && <span className="approved-note"><CircleCheck size={16} aria-hidden="true" />
              {formatTime(snapshot.approval.approvedAt)} 确认
            </span>}
          </div>
          {reviewable && rejecting && <form id={rejectFormId} className="form-stack" onSubmit={reject}>
            <label>退回原因<textarea name="reason" required maxLength={500} rows={3} autoFocus
              aria-invalid={Boolean(action.error)} aria-describedby={action.error ? rejectFormId + '-error' : undefined}
              disabled={action.busy} onChange={action.reset} /></label>
            {action.error && <div id={rejectFormId + '-error'}><Feedback error={action.error} /></div>}
            <div className="actions">
              <button type="submit" className="button primary" disabled={action.busy}>{action.busy ? '正在退回…' : '提交退回'}</button>
              <button type="button" className="button" disabled={action.busy} onClick={() => {
                setRejecting(false); action.reset(); rejectButton.current?.focus();
              }}>取消</button>
            </div>
          </form>}
        </>}
      {pastRejections.length > 0 && <details className="source">
        <summary>查看历史退回意见</summary>
        {pastRejections.map((item) => <div key={item.id}>
          <h4>{publishPlatformLabel(item.platform, Boolean(item.videoAsset))} V{item.version}</h4>
          {item.rejections?.map((rejection) => <div key={rejection.id}>
            <p className="muted small">{rejection.reviewer?.name ?? '审核人'} · {formatTime(rejection.createdAt)}</p>
            <p className="content-text">{rejection.reason}</p>
          </div>)}
        </div>)}
      </details>}
      {editable && !editingVersion && approvedVersions.length > 0 && (accounts.loading ? <Loading />
        : accounts.error ? <Feedback error={accounts.error} /> : <Schedule scope={scope} variants={approvedVersions}
          accounts={accounts.data ?? []} onSchedule={onSchedule} openAccounts={openAccounts} />)}
    </div>
  </section>;
}

export function Manuscripts({ scope, role, accounts, drafts, openTasks, openAccounts }: {
  scope: string; role: Role; accounts: ReturnType<typeof useResource<Account[]>>;
  drafts: ManuscriptDrafts;
  openTasks: (id: string) => void; openAccounts: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [selection, setSelection] = useState('');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>(role === 'reviewer' ? 'pending' : 'all');
  const [pages, setPages] = useState<string[]>([]);
  const [reviewNotice, setReviewNotice] = useState('');
  const draftKey = scope + '/manuscripts/new';
  const [creating, setCreating] = useState(() => canEdit(role) && drafts.has(draftKey));
  const cursor = pages.at(-1);
  const search = new URLSearchParams({ limit: '20' });
  if (showArchived) search.set('archived', 'true');
  if (reviewFilter !== 'all') search.set('review', reviewFilter);
  if (cursor) search.set('cursor', cursor);
  const list = useResource<{ items: ManuscriptSummary[]; nextCursor: string | null }>(scope + '/manuscripts?' + search);
  const listError = list.error || (list.data && !Array.isArray(list.data.items)
    ? '当前 API 不支持稿件分页，请使用与工作台同版本的 API。' : undefined);
  const items = Array.isArray(list.data?.items) ? list.data.items : [];
  const selected = items.some(({ id }) => id === selection) ? selection : '';
  const active = selected || items[0]?.id || '';
  const start = () => setCreating(true);
  const emptyTitle = showArchived ? '暂无已归档稿件' : reviewFilter === 'pending' ? '暂无待审核原稿'
    : reviewFilter === 'returned' ? '暂无需要你修改的稿件' : '暂无原稿';
  function changePage(next: string[]) {
    setPages(next); setSelection(''); setCreating(false); setReviewNotice('');
  }
  return <>
    <PageHeader title={reviewFilter === 'pending' ? '待审核原稿' : '原稿与审核'}
      description={role === 'reviewer' ? '按平台审核文案、配图和封面。' : canEdit(role)
        ? '从一篇原稿生成各平台版本，分别审核并排期。' : '查阅原稿和各平台版本。'}>
      {canEdit(role) && <>
        <button type="button" className="button" aria-pressed={showArchived} onClick={() => {
          setShowArchived(!showArchived); setReviewFilter('all'); changePage([]);
        }}>{showArchived ? '查看在用稿件' : '查看已归档'}</button>
        {!showArchived && <button className="button primary" onClick={start}><Plus size={18} aria-hidden="true" />新建原稿</button>}
      </>}
    </PageHeader>
    {!showArchived && canReview(role) && <div className="filters" role="group" aria-label="按审核状态筛选">
      {([
        ['all', '全部原稿'], ['pending', '待审核'], ...(canEdit(role) ? [['returned', '退回给我']] as const : []),
      ] as const).map(([filter, label]) => <button key={filter} type="button" className={reviewFilter === filter ? 'active' : ''}
        aria-pressed={reviewFilter === filter} onClick={() => { setReviewFilter(filter); changePage([]); }}>{label}</button>)}
    </div>}
    <Feedback error={listError} notice={reviewNotice} />
    {list.error && <button type="button" className="button compact" onClick={list.refresh}>重试加载原稿</button>}
    <div className="split-panel">
      <section className="card item-list">
        <div className="card-heading"><h2>{showArchived ? '已归档原稿' : '原稿列表'}</h2><span className="count">{items.length}</span></div>
        {list.loading ? <Loading /> : items.length > 0 ? items.map((item) => {
          const variants = item.variants.filter(({ status }) => status !== 'superseded');
          const pending = variants.filter(({ status, returned }) => status === 'draft' && !returned).length;
          const returned = variants.filter((variant) => variant.returned).length;
          const review = [
            pending ? `${pending} 个待审核` : '', returned ? `${returned} 个已退回` : '',
          ].filter(Boolean).join(' · ');
          return <button key={item.id} className={`list-item ${active === item.id && !creating ? 'selected' : ''}`}
            aria-pressed={active === item.id && !creating} onClick={() => { setSelection(item.id); setCreating(false); setReviewNotice(''); }}>
            <span className="list-icon"><FileText size={18} aria-hidden="true" /></span>
            <span className="list-copy"><strong>{item.title}</strong><small>{item.videoAssetId ? '视频 · ' : ''}{item.assetCount} 张图片 · {variants.length
              ? `${variants.length} 个版本 · ${review || '已审核'}` : '未生成版本'}</small></span>
            <ChevronRight className="row-chevron" size={15} aria-hidden="true" />
          </button>;
        }) : !listError && <Empty icon={FileText} title={emptyTitle} />}
        {(cursor || list.data?.nextCursor) && <div className="pagination" aria-label="稿件分页">
          <button type="button" className="icon-button" aria-label="上一页" disabled={!cursor}
            onClick={() => changePage(pages.slice(0, -1))}><ArrowLeft size={17} aria-hidden="true" /></button>
          <span>第 {pages.length + 1} 页</span>
          <button type="button" className="icon-button" aria-label="下一页" disabled={!list.data?.nextCursor}
            onClick={() => { if (list.data?.nextCursor) changePage([...pages, list.data.nextCursor]); }}><ArrowRight size={17} aria-hidden="true" /></button>
        </div>}
      </section>
      {creating ? <NewManuscript scope={scope} drafts={drafts} draftKey={draftKey} onCancel={() => setCreating(false)} onSave={(id) => {
        changePage([]); setReviewFilter('all'); setSelection(id); list.refresh();
      }} /> : active ? <ManuscriptDetail key={active} scope={scope} role={role} id={active} accounts={accounts} drafts={drafts}
        reviewFilter={reviewFilter} changed={list.refresh} onReview={setReviewNotice}
        onSchedule={openTasks} openAccounts={openAccounts} />
        : <section className="card detail-pane empty-detail">
          {list.loading ? <Loading /> : <Empty icon={FileText} title={listError ? '暂时无法查看稿件' : emptyTitle}
            description={reviewFilter === 'all' && !showArchived && !listError && canEdit(role)
              ? '新建原稿后，可以生成各平台版本。' : undefined} />}
        </section>}
    </div>
  </>;
}
