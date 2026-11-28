import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CalendarPlus, ChevronRight, CircleCheck, Clock3, FileText, ImagePlus, Images, PencilLine, Plus,
  RotateCcw, ShieldCheck, Sparkles,
} from 'lucide-react';
import {
  api, canEdit, canReview, cleanAccountName, fileBody, formatTime, imageUrl, platforms, post, publishModeLabel, publishPlatformLabel, useAction, useResource,
  type Account, type Manuscript, type ManuscriptSummary, type ManuscriptVariant, type MatrixGroup, type Platform, type PublishMode, type PublishOption, type Role, type Variant,
} from './api';
import { pushToast } from './toast';
import { askConfirm } from './confirm-dialog';
import { Empty, Feedback, Loading, PageHeader, PlatformIcon, ReviewPicture, StatGrid, type StatCardItem } from './ui';

type ReviewFilter = 'all' | 'pending' | 'returned';

function variantLabel(variant?: Pick<Variant, 'status' | 'returned'>) {
  if (!variant) return '未生成';
  if (variant.returned) return '已退回';
  return variant.status === 'approved' ? '已审核' : '待审核';
}

function platformOfNotice(platform: Platform, hasVideo: boolean) {
  const label = publishPlatformLabel(platform, hasVideo);
  return /^[A-Za-z0-9]/.test(label) ? ` ${label}` : label;
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
    }, '原稿已创建。');
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
    }, '版本修改已保存。');
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

function localDateTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Schedule({ scope, variants, currentVariants, accounts, onSchedule, openAccounts, showPlatform, previewPlatform }: {
  scope: string; variants: Variant[]; currentVariants: ManuscriptVariant[]; accounts: Account[];
  onSchedule: (id: string) => void; openAccounts: () => void; showPlatform: (platform: Platform) => void;
  previewPlatform: (platform: Platform) => void;
}) {
  const action = useAction();
  const groups = useResource<MatrixGroup[]>(scope + '/accounts/groups');
  const options = useResource<{ items: PublishOption[] }>(variants.length
    ? scope + '/tasks/publish-options?variantIds=' + variants.map(({ id }) => id).join(',') : null, 10_000);
  const [modes, setModes] = useState<Record<string, PublishMode>>({});
  function optionFor(account: Account) { return options.data?.items.find((item) => item.accountId === account.id); }
  function modeFor(account: Account) { return modes[account.id] ?? optionFor(account)?.recommended; }
  const targets = accounts.filter((account) => optionFor(account)?.modes.some((item) => item.available));
  const [selectedPlatform, setPlatform] = useState<Platform | ''>('');
  const platform = selectedPlatform || (variants.length === 1 ? variants[0]!.platform : '');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [groupNotice, setGroupNotice] = useState('');
  const [jitterEnabled, setJitterEnabled] = useState(true);
  const [scheduledAt, setScheduledAt] = useState(() => localDateTime(new Date(Date.now() + 5 * 60_000)));
  const now = new Date();
  const tonight = new Date(now);
  tonight.setHours(20, 0, 0, 0);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9);
  const localZone = new Intl.DateTimeFormat('zh-CN', { timeZoneName: 'longGeneric' })
    .formatToParts(now).find(({ type }) => type === 'timeZoneName')?.value ?? '设备时区';
  const selected = targets.filter((account) => selection.includes(account.id)
    && optionFor(account)?.modes.some((item) => item.mode === modeFor(account) && item.available));
  const current = currentVariants.find((variant) => variant.platform === platform);
  const eligible = variants.find((variant) => variant.platform === platform);
  const group = accounts.filter((account) => account.platform === platform && optionFor(account));
  const query = search.trim().toLowerCase();
  const matching = group.filter((account) => account.displayName.toLowerCase().includes(query)
    || account.alias?.toLowerCase().includes(query)
    || account.operator?.toLowerCase().includes(query));
  const matchingIds = matching.filter((account) => targets.includes(account)).map(({ id }) => id);
  const allMatchingSelected = matchingIds.length > 0 && matchingIds.every((id) => selection.includes(id));
  const activeGroups = (groups.data ?? []).filter((item) => accounts.some((acc) => acc.groupId === item.id));
  function selectByMatrixGroup(matrixGroup: MatrixGroup) {
    const inGroup = accounts.filter((acc) => acc.groupId === matrixGroup.id);
    const compatibleIds = targets.filter((acc) => acc.groupId === matrixGroup.id).map(({ id }) => id);
    if (!compatibleIds.length) {
      setGroupNotice(`矩阵组「${matrixGroup.name}」当前没有可匹配本稿件已审版本的账号。`);
      return;
    }
    const allIn = compatibleIds.every((id) => selection.includes(id));
    selectAccounts(compatibleIds, !allIn);
    const skipped = inGroup.length - compatibleIds.length;
    setGroupNotice(allIn
      ? `已取消选择矩阵组「${matrixGroup.name}」的账号。`
      : `已选中矩阵组「${matrixGroup.name}」中 ${compatibleIds.length} 个账号${skipped > 0 ? `（另有 ${skipped} 个账号因版本未审或通道不匹配未选入）` : ''}。`);
  }
  function selectAccounts(ids: string[], checked: boolean) {
    const current = selected.map(({ id }) => id);
    if (checked) {
      const defaults = Object.fromEntries(targets.filter((account) => ids.includes(account.id))
        .map((account) => [account.id, modeFor(account)!]));
      setModes((previous) => ({ ...defaults, ...previous }));
    }
    setSelection(checked ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id)));
    if (checked && platform) previewPlatform(platform);
  }
  function schedule(date: Date, immediately = false) {
    if (selected.length === 0) return;
    void action.run(async () => {
      if (!Number.isFinite(date.getTime())) throw new Error('请选择有效的排期时间。');
      if (!immediately && date.getTime() <= Date.now()) throw new Error('请选择未来的排期时间。');
      const useJitter = !immediately && jitterEnabled && selected.length > 1;
      const response = await post<{ items: { id: string; disposition?: 'created' | 'existing' }[] }>(scope + '/tasks', {
        variantIds: variants.filter(({ platform }) => selected.some((account) => account.platform === platform)).map(({ id }) => id),
        accountIds: selected.map(({ id }) => id),
        accountModes: Object.fromEntries(selected.map((account) => [account.id, modeFor(account)])),
        scheduledAt: date.toISOString(),
        ...(useJitter ? { jitter: { enabled: true, minSeconds: 30, maxSeconds: 180 } } : {}),
      });
      if (!response.items[0]) throw new Error('未收到任务编号。');
      const createdCount = response.items.filter(({ disposition }) => disposition !== 'existing').length;
      const existingCount = response.items.length - createdCount;
      if (createdCount === 0) {
        pushToast('该版本与所选账号已有排期任务，本次未新建，已为你打开原有任务。', 'info', 4200);
      } else if (existingCount > 0) {
        pushToast(`已新建 ${createdCount} 条发布任务，另有 ${existingCount} 个账号沿用已有任务。`, 'success', 3800);
      } else {
        pushToast(`已创建 ${createdCount} 条发布任务。`, 'success');
      }
      onSchedule(response.items[0].id);
    });
  }
  const immediate = selected.length > 0 && selected.every((account) => ['manual_handoff', 'local_browser'].includes(modeFor(account)!)) ? '立即生成交接待办'
    : selected.length > 0 && selected.every((account) => modeFor(account) === 'sandbox') ? '立即模拟投稿'
      : selected.length > 0 && selected.every((account) => modeFor(account) === 'official_api') ? '立即投稿' : '立即执行';
  return <div id="publish-schedule" className="schedule" tabIndex={-1}>
    <h3><CalendarPlus size={17} aria-hidden="true" />安排发布</h3>
    <form className="form-stack" aria-busy={action.busy} onSubmit={(event) => {
      event.preventDefault();
      schedule(new Date(scheduledAt));
    }}>
      {options.loading && <Loading />}
      {options.error && <><Feedback error={options.error} /><button type="button" className="text-button" onClick={options.refresh}>重试加载发布方式</button></>}
      {activeGroups.length > 0 && <div className="field-group">
        <div className="section-line">
          <span>按矩阵组跨平台快选</span>
          <small className="muted">每个账号只属于单一矩阵组</small>
        </div>
        <div className="filters">
          {activeGroups.map((item) => {
            const groupCompatible = targets.filter((acc) => acc.groupId === item.id);
            const allIn = groupCompatible.length > 0 && groupCompatible.every((acc) => selection.includes(acc.id));
            return <button key={item.id} type="button" className={allIn ? 'active' : undefined}
              disabled={action.busy} onClick={() => selectByMatrixGroup(item)}>
              <span className={`group-dot color-${item.color}`} aria-hidden="true" />
              {item.name} ({groupCompatible.length})
            </button>;
          })}
        </div>
        {groupNotice && <p className="muted small" role="status">{groupNotice}</p>}
      </div>}
      <label className="schedule-platform">发布平台
        <select value={platform} disabled={action.busy} onChange={(event) => {
          const next = event.currentTarget.value as Platform;
          setPlatform(next);
          setSearch('');
          previewPlatform(next);
        }}>
          <option value="" disabled>请选择平台</option>
          {platforms.map((item) => <option key={item} value={item}>{publishPlatformLabel(item,
            Boolean(currentVariants.find((variant) => variant.platform === item)?.videoAsset))}</option>)}
        </select>
      </label>
      {platform && !eligible && <p className="muted small">
        {current?.status === 'approved' ? '该版本需要重新审核' : `该平台版本${variantLabel(current)}`}。
        <button type="button" className="text-button" onClick={() => showPlatform(platform)}>查看版本</button>
      </p>}
      {eligible && group.length === 0 && <p className="muted small">
        该平台暂无可用账号，请检查账号连接或授权。
        <button type="button" className="text-button" onClick={openAccounts}>查看发布账号</button>
      </p>}
      {eligible && group.length > 0 && <fieldset className="schedule-accounts" disabled={action.busy}>
        <legend>发布账号 · V{eligible.version}</legend>
        {group.length > 1 && <label>搜索当前平台账号
          <input type="search" value={search} placeholder="账号名称或负责人"
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
            }} />
        </label>}
        {matchingIds.length > 1 && <button type="button" className="text-button"
          onClick={() => selectAccounts(matchingIds, !allMatchingSelected)}>
          {allMatchingSelected ? '取消全选' : '全选'}{query ? '搜索结果' : '当前平台账号'}
        </button>}
        {matching.length === 0 ? <p className="muted small" role="status">没有匹配的账号，请试试其他关键词。</p>
          : <ul className="schedule-account-list">
            {matching.map((account) => <li key={account.id}><label>
              <input type="checkbox" checked={selection.includes(account.id)}
                disabled={!targets.includes(account)}
                onChange={(event) => selectAccounts([account.id], event.currentTarget.checked)} />
              <span>{cleanAccountName(account.displayName)}</span>
            </label>
              <label className="publish-mode-field">发布方式 · {cleanAccountName(account.displayName)}
                <select value={modeFor(account) ?? ''} disabled={!targets.includes(account)} onChange={(event) => {
                  const selectedMode = event.currentTarget.value as PublishMode;
                  setModes((previous) => ({ ...previous, [account.id]: selectedMode }));
                }}>
                  {!modeFor(account) && <option value="">暂无可用方式</option>}
                  {optionFor(account)?.modes.map((item) => <option key={item.mode} value={item.mode} disabled={!item.available}>
                    {publishModeLabel[item.mode]}{!item.available ? '（不可用）' : item.mode === optionFor(account)?.recommended ? '（推荐）' : ''}
                  </option>)}
                </select>
              </label>
              <details className="muted small"><summary>查看发布方式与不可用原因</summary>
                <ul>{optionFor(account)?.modes.map((item) => <li key={item.mode}>{publishModeLabel[item.mode]}：{item.reason ?? '可用'}</li>)}</ul>
              </details>
              {optionFor(account)?.existingTaskId && <button type="button" className="text-button"
                onClick={() => onSchedule(optionFor(account)!.existingTaskId!)}>查看已有任务</button>}
              {modes[account.id] && !optionFor(account)?.modes.some((item) => item.mode === modes[account.id] && item.available)
                && <p className="muted small" role="status">当前选择的方式不可用，请查看原因并重新选择。</p>}
              {modeFor(account) === 'local_browser' && <p className="muted small">先生成已审交接包，再从任务打开对应账号浏览器；完成投稿后手动回填结果。</p>}
            </li>)}
          </ul>}
      </fieldset>}
      {targets.length > 0 && <>
        <p className="muted small schedule-selection" role="status">
          {selected.length ? `已选 ${selected.length} 个账号 · ${platforms.map((item) => {
            const count = selected.filter((account) => account.platform === item).length;
            return count ? `${publishPlatformLabel(item, Boolean(variants.find((variant) => variant.platform === item)?.videoAsset))} ${count} 个` : '';
          }).filter(Boolean).join('、')}` : '请选择平台，再勾选要发布的账号。'}
        </p>
        <div className="schedule-timing">
          <label>排期时间 <small>{localZone}</small>
            <input name="scheduledAt" type="datetime-local" required disabled={action.busy} value={scheduledAt}
              onChange={(event) => setScheduledAt(event.currentTarget.value)} />
          </label>
          <div className="filters schedule-shortcuts" role="group" aria-label="快捷排期">
            <button type="button" disabled={action.busy} onClick={() => setScheduledAt(localDateTime(new Date(Date.now() + 600_000)))}>10 分钟后</button>
            <button type="button" disabled={action.busy || tonight <= now} onClick={() => setScheduledAt(localDateTime(tonight))}>今晚 20:00</button>
            <button type="button" disabled={action.busy} onClick={() => setScheduledAt(localDateTime(tomorrow))}>明早 09:00</button>
          </div>
          {selected.length > 1 && <label className="checkbox-line">
            <input type="checkbox" checked={jitterEnabled} disabled={action.busy}
              onChange={(event) => setJitterEnabled(event.currentTarget.checked)} />
            <span>启用风控错峰节流（每个账号在计划时间上依次再延后 30~180 秒；遇平台验证自动熔断转人工交接）</span>
          </label>}
        </div>
        <Feedback error={action.error} />
        <div className="actions">
          <button className="button primary" disabled={action.busy || selected.length === 0 || Boolean(options.error)}>
            {selected.length ? `为 ${selected.length} 个账号排期` : '选择账号后排期'}<ChevronRight size={15} aria-hidden="true" />
          </button>
          <button type="button" className="button" disabled={action.busy || selected.length === 0 || Boolean(options.error)} onClick={() => schedule(new Date(), true)}>{immediate}</button>
        </div>
      </>}
    </form>
  </div>;
}

function ManuscriptDetail({ scope, role, id, accounts, drafts, reviewFilter, changed, onReview, onSchedule, openAccounts }: {
  scope: string; role: Role; id: string; accounts: ReturnType<typeof useResource<Account[]>>;
  drafts: ManuscriptDrafts; reviewFilter: ReviewFilter;
  changed: (restoredId?: string) => void; onReview?: (message: string) => void; onSchedule: (id: string) => void; openAccounts: () => void;
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
  const platformOptions = useRef<HTMLDivElement>(null);
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
  function refresh(restoredId?: string) { detail.refresh(); changed(restoredId); }
  function showPlatform(next: Platform, focus = true) {
    action.reset(); setPlatform(next); setEditing(focus ? null : false); setRejecting(false);
    if (focus) platformOptions.current?.querySelector<HTMLButtonElement>(`[data-platform="${next}"]`)?.focus();
  }
  async function archive() {
    if (!manuscript) return;
    const restoring = Boolean(manuscript.archivedAt);
    if (!restoring) {
      const ok = await askConfirm({
        tone: 'warning',
        badge: '原稿归档',
        title: '归档当前原稿？',
        target: manuscript.title,
        description: '归档后原稿会从「在用稿件」隐藏，关联的未执行待发任务将自动暂停调度。',
        impacts: [
          '待派发排期任务自动暂停，防止误发旧内容',
          '版本快照、审核意见与历史回执完整保留',
          '随时可在「已归档原稿」恢复继续使用',
        ],
        confirmLabel: '确认归档原稿',
      });
      if (!ok) return;
    }
    void action.run(async () => {
      const path = scope + '/manuscripts/' + id;
      await api(restoring ? path + '/restore' : path, { method: restoring ? 'PATCH' : 'DELETE' });
      refresh(restoring ? id : undefined);
    }, restoring ? undefined : '稿件已归档。');
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
      onReview?.(`「${manuscript.title}」的${platformOfNotice(snapshot.platform, Boolean(snapshot.videoAsset))}版本已确认。`);
    }, '已确认审核，可继续排期发布。');
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
      onReview?.(`「${manuscript.title}」的${platformOfNotice(snapshot.platform, Boolean(snapshot.videoAsset))}版本已退回。`);
    }, '已退回给编辑修改。');
  }
  function upload(files: File[]) {
    if (!files.length) return;
    const missingPicture = snapshot?.platform === 'xiaohongshu' && snapshot.status === 'draft' && !snapshot.returned
      && !snapshot.assets.length && !editingVersion ? snapshot.id : null;
    void action.run(async () => {
      try {
        const assetIds: string[] = [];
        for (const file of files) {
          const asset = await post<{ id: string }>(scope + '/manuscripts/' + id + '/assets', fileBody(file));
          assetIds.push(asset.id);
        }
        if (missingPicture) await api(scope + '/variants/' + missingPicture, { method: 'PATCH', body: { assetIds: assetIds.slice(0, 9) } });
      } finally { refresh(); }
    }, missingPicture ? '图片已加入小红书的待审核版本。' : '原稿配图已上传。');
  }
  function attachOriginalPictures() {
    if (!snapshot || !manuscript?.assets.length) return;
    void action.run(async () => {
      await api(scope + '/variants/' + snapshot.id, { method: 'PATCH',
        body: { assetIds: manuscript.assets.slice(0, 9).map(({ id }) => id) } });
      refresh();
    }, '原稿配图已加入待审核版本。');
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
      {editable && !editingVersion && approvedVersions.length > 0 && !accounts.loading && !accounts.error &&
        <a className="button primary compact" href="#publish-schedule"><CalendarPlus size={16} aria-hidden="true" />安排发布</a>}
      {canEdit(role) && <button type="button" className="button compact" disabled={action.busy} onClick={archive}>
        {manuscript.archivedAt ? '恢复稿件' : '归档稿件'}
      </button>}
    </div>
    <div className="detail-content">
      <Feedback error={(!rejecting ? action.error : '') || detail.error} notice={action.notice} />
      {manuscript.referenceUrl && <p className="muted small">
        <a href={manuscript.referenceUrl} target="_blank" rel="noreferrer">查看选题参考作品</a>
      </p>}
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
        <h3>平台适配版本</h3>
      </div>
      <div ref={platformOptions} className="filters platform-options" role="group" aria-label="按平台查看版本">
        {platforms.map((candidate) => {
          const current = currentVariants.find((version) => version.platform === candidate);
          return <button type="button" key={candidate} data-platform={candidate} className={platform === candidate ? 'active' : ''}
            aria-pressed={platform === candidate} disabled={action.busy} onClick={() => {
              if (platform === candidate) return;
              showPlatform(candidate);
            }}><PlatformIcon platform={candidate} />{publishPlatformLabel(candidate, Boolean(manuscript.videoAsset))}
            <small>· {current?.status === 'approved' && !approvedVersions.some((item) => item.id === current.id)
              ? '待重新审核' : variantLabel(current)}</small></button>;
        })}
      </div>
      {!variant ? <div className="sub-empty">
        <p>生成平台版本后，可检查文案、图片顺序和封面。</p>
        {editable && <div className="actions">
          <button type="button" className="button primary" disabled={action.busy} onClick={() => generate([platform])}>
            <Sparkles size={16} aria-hidden="true" />生成{platformOfNotice(platform, Boolean(manuscript.videoAsset))}版本
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
            <div className="section-line variant-preview-heading">
              <h3>{variant.title}</h3>
              <div className="actions">
                <span className="version">V{variant.version}</span>
                {snapshot && editable && !rejecting && <button type="button" className="button compact" disabled={action.busy} onClick={() => setEditing(true)}>
                  <PencilLine size={16} aria-hidden="true" />编辑版本
                </button>}
              </div>
            </div>
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
            {editable && issues.some(({ code }) => code === 'images_missing') && (manuscript.assets.length && snapshot?.status === 'draft' ?
              <button type="button" className="button compact" disabled={action.busy} onClick={attachOriginalPictures}>使用原稿配图</button>
              : <p>上传原稿配图后，检查当前小红书版本的封面。</p>)}
          </div> : null}
          <div className="actions">
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
      {editable && !editingVersion && (accounts.loading ? <Loading />
        : accounts.error ? <Feedback error={accounts.error} /> : <Schedule scope={scope} variants={approvedVersions}
          currentVariants={currentVariants} accounts={accounts.data ?? []} onSchedule={onSchedule} openAccounts={openAccounts}
          showPlatform={showPlatform} previewPlatform={(next) => {
            if (!rejecting && !action.busy && next !== platform) showPlatform(next, false);
          }} />)}
    </div>
  </section>;
}

export function Manuscripts({ scope, role, accounts, drafts, openTasks, openAccounts, initialId, refreshSummary }: {
  scope: string; role: Role; accounts: ReturnType<typeof useResource<Account[]>>;
  drafts: ManuscriptDrafts;
  openTasks: (id: string) => void; openAccounts: () => void; initialId?: string;
  refreshSummary: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [selection, setSelection] = useState(initialId ?? '');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>(role === 'reviewer' ? 'pending' : 'all');
  const [pages, setPages] = useState<string[]>([]);
  const [reviewNotice, setReviewNotice] = useState('');
  const draftKey = scope + '/manuscripts/new';
  const [creating, setCreating] = useState(() => !initialId && canEdit(role) && drafts.has(draftKey));
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
  const pendingManuscripts = items.filter((item) => item.variants.some((v) => v.status === 'draft' && !v.returned)).length;
  const returnedManuscripts = items.filter((item) => item.variants.some((v) => v.status !== 'superseded' && v.returned)).length;
  const approvedManuscripts = items.filter((item) => item.variants.some((v) => v.status === 'approved')).length;
  const manuscriptStats: StatCardItem[] = [
    {
      key: 'page-total',
      label: showArchived ? '本页已归档原稿' : '本页原稿数',
      value: list.data ? items.length : '—',
      note: `第 ${pages.length + 1} 页（每页最多 20 条）`,
      icon: FileText,
      tone: 'neutral',
    },
    {
      key: 'pending',
      label: '含待审核版本',
      value: list.data ? pendingManuscripts : '—',
      note: '待审核人逐版确认快照',
      icon: Clock3,
      tone: pendingManuscripts > 0 ? 'amber' : 'neutral',
    },
    {
      key: 'returned',
      label: '含退回待修改',
      value: list.data ? returnedManuscripts : '—',
      note: '修改保存后将形成新版本',
      icon: RotateCcw,
      tone: returnedManuscripts > 0 ? 'red' : 'neutral',
    },
    {
      key: 'approved',
      label: '已有已审核版本',
      value: list.data ? approvedManuscripts : '—',
      note: '可按版本锁定规则安排排期',
      icon: CircleCheck,
      tone: approvedManuscripts > 0 ? 'green' : 'neutral',
    },
  ];
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
    <StatGrid items={manuscriptStats} columns={4} label="原稿审核状态概览" />
    <div className="split-panel">
      <section className="card item-list">
        <div className="card-heading"><h2>{showArchived ? '已归档原稿' : '原稿列表'}</h2><span className="count">{items.length}</span></div>
        {list.loading ? <Loading /> : items.length > 0 ? <div className="list-well scroll-shadow-y">{items.map((item) => {
          const variants = item.variants.filter(({ status }) => status !== 'superseded');
          const pending = variants.filter(({ status, returned }) => status === 'draft' && !returned).length;
          const returned = variants.filter((variant) => variant.returned).length;
          const review = [
            pending ? `${pending} 个待审核` : '', returned ? `${returned} 个已退回` : '',
          ].filter(Boolean).join(' · ');
          return <button key={item.id} className={`list-item ${active === item.id && !creating ? 'selected' : ''}`}
            aria-pressed={active === item.id && !creating} onClick={() => { setSelection(item.id); setCreating(false); setReviewNotice(''); }}>
            <span className="list-icon"><FileText size={18} aria-hidden="true" /></span>
            <span className="list-copy"><strong title={item.title}>{item.title}</strong><small>{item.videoAssetId ? '视频 · ' : ''}{item.assetCount} 张图片 · {variants.length
              ? `${variants.length} 个版本 · ${review || '已审核'}` : '未生成版本'}</small></span>
            <ChevronRight className="row-chevron" size={15} aria-hidden="true" />
          </button>;
        })}</div> : !listError && <Empty icon={FileText} title={emptyTitle} />}
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
        reviewFilter={reviewFilter} changed={(restoredId) => {
          if (restoredId) {
            setShowArchived(false);
            setReviewFilter('all');
            setPages([]);
            setSelection(restoredId);
            pushToast('稿件已恢复至「在用稿件」。', 'success');
          }
          list.refresh();
          refreshSummary();
        }} onReview={setReviewNotice}
        onSchedule={openTasks} openAccounts={openAccounts} />
        : <section className="card detail-pane empty-detail">
          {list.loading ? <Loading /> : <Empty icon={FileText} title={listError ? '暂时无法查看稿件' : emptyTitle}
            description={reviewFilter === 'all' && !showArchived && !listError && canEdit(role)
              ? '新建原稿后，可以生成各平台版本。' : undefined}>
            {reviewFilter === 'all' && !showArchived && !listError && canEdit(role)
              && <button type="button" className="button primary" onClick={start}>新建原稿</button>}
          </Empty>}
        </section>}
    </div>
  </>;
}
