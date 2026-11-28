import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Bot, BookmarkCheck, ImageOff, Layers3, Sparkles, Telescope } from 'lucide-react';
import { api, formatTime, messageOf, post, useAction, useResource } from './api';
import { readCreatorHubReport, topicMediaTypes, topicPlatforms, type ImportedWork, type TopicWork } from './creatorhub-report';
import { TopicAiGoal, TopicAiPanel, TopicAiSettings, useTopicAiAnalysis, type TopicAiStatus } from './topic-ai';
import { pushToast } from './toast';
import { useTopicNotes } from './topic-notes';
import { TopicSources } from './topic-sources';
import { TopicChanges, TopicInsights } from './topic-insights';
import { Empty, Feedback, Loading, PageHeader, StatGrid, type StatCardItem } from './ui';

function titleOf(item: TopicWork) {
  return item.description.split('\n', 1)[0]?.trim() || '无作品描述';
}

function coverOf(item: TopicWork) {
  if (item.coverUrl) return item.coverUrl;
  if (item.platform !== 'youtube' || !item.sourceUrl || !URL.canParse(item.sourceUrl)) return null;
  const url = new URL(item.sourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['youtube.com', 'www.youtube.com'].includes(url.hostname) || url.pathname !== '/watch') return null;
  const id = url.searchParams.get('v');
  return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

const platformBadges: Record<string, { letter: string; color: string; bg: string }> = {
  bilibili: { letter: 'B', color: '#00aeec', bg: 'rgba(0, 174, 236, 0.15)' },
  xiaohongshu: { letter: '红', color: '#ff2442', bg: 'rgba(255, 36, 66, 0.15)' },
  douyin: { letter: '抖', color: '#25f4ee', bg: 'rgba(37, 244, 238, 0.15)' },
  kuaishou: { letter: '快', color: '#ff5000', bg: 'rgba(255, 80, 0, 0.15)' },
  shipinhao: { letter: '视', color: '#fa9d3b', bg: 'rgba(250, 157, 59, 0.15)' },
  rednote: { letter: '红', color: '#ff2442', bg: 'rgba(255, 36, 66, 0.15)' },
  youtube: { letter: 'YT', color: '#ff0000', bg: 'rgba(255, 0, 0, 0.15)' },
  tiktok: { letter: 'TT', color: '#fe2c55', bg: 'rgba(254, 44, 85, 0.15)' },
  instagram: { letter: 'IG', color: '#e1306c', bg: 'rgba(225, 48, 108, 0.15)' },
  twitter: { letter: 'X', color: '#1d9bf0', bg: 'rgba(29, 155, 240, 0.15)' },
  mastodon: { letter: 'M', color: '#6364ff', bg: 'rgba(99, 100, 255, 0.15)' },
  'google-trends': { letter: 'G', color: '#4285f4', bg: 'rgba(66, 133, 244, 0.15)' },
  rss: { letter: 'RSS', color: '#f26522', bg: 'rgba(242, 101, 34, 0.15)' },
};

function TopicCover({ url, platform, preview = false }: {
  url: string | null; platform?: keyof typeof topicPlatforms; preview?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const badge = platform ? platformBadges[platform] : undefined;

  return <span className={preview ? 'topic-cover topic-cover-preview' : 'topic-cover topic-cover-thumb'}>
    {url && !failed ? <img src={url} alt={preview ? '作品封面' : ''} referrerPolicy="no-referrer"
      loading={preview ? 'eager' : 'lazy'} decoding="async" onError={() => setFailed(true)} />
      : preview
        ? <span className="topic-cover-empty"><ImageOff size={22} aria-hidden="true" /><span>{failed ? '封面暂时加载失败' : '来源未提供封面'}</span></span>
        : badge
          ? <span className="platform-badge-thumb" style={{ color: badge.color, backgroundColor: badge.bg }}>{badge.letter}</span>
          : <ImageOff size={16} aria-hidden="true" />}
  </span>;
}

function angleFor(item: TopicWork) {
  const keyword = item.matches?.find(({ source }) => source.keyword)?.source.keyword;
  const scope = keyword ? `围绕「${keyword}」，` : '';
  const title = titleOf(item);
  if (/[?？]/.test(title)) return scope + '选一个你的读者经常问的具体问题，用自己的案例给出答案和步骤。';
  if (/\d/.test(title)) return scope + '尝试用清单组织内容。选几条你验证过的做法，每条配一个自己的例子。';
  if (item.mediaType === 'video') return scope + '选一个能拍出来的场景。先展示你的结果，再演示过程，并注明适用的人和条件。';
  return scope + '结合你的受众选一个不同的场景，用实测、案例或图解把它讲清楚。';
}

function TopicAnalysis({ items }: { items: TopicWork[] }) {
  const tags = new Map<string, number>();
  const days = new Set<string>();
  let questions = 0;
  let withNumbers = 0;
  for (const item of items) {
    if (item.publishedOn) days.add(item.publishedOn.slice(0, 10));
    const title = titleOf(item);
    if (/[?？]/.test(title)) questions++;
    if (/\d/.test(title)) withNumbers++;
    const uniqueTags = new Set(Array.from(item.description.matchAll(/#([\p{L}\p{N}_-]{1,24})/gu), (match) => match[1]!));
    for (const tag of uniqueTags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const mostUsed = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const orderedDays = [...days].sort();
  const latest = orderedDays.at(-1);
  const previousWeek = latest ? new Date(new Date(latest).getTime() - 6 * 86_400_000).toISOString().slice(0, 10) : '';
  const first = items[0];
  const comparable = first && first.mediaType !== 'other'
    && items.every(({ platform, mediaType }) => platform === first.platform && mediaType === first.mediaType);
  const metric = first?.platform === 'youtube' ? 'views' : 'likes';
  const metricLabel = metric === 'views' ? (first?.mediaType === 'video' ? '播放' : '阅读') : '点赞';
  const ranked = comparable ? items.flatMap((item) => {
    const value = item[metric];
    return value != null && item.publishedOn && item.publishedOn.slice(0, 10) >= previousWeek ? [{ item, value }] : [];
  }) : [];
  const top = ranked.sort((a, b) => b.value - a.value).slice(0, 3);
  return <details className="source topic-analysis">
    <summary>样本分析<span className="count">{items.length} 条作品</span></summary>
    <div className="form-stack">
    {latest && <p className="muted">发布范围 {orderedDays[0]} 至 {latest} · {days.size} 天有更新</p>}
    <p>描述首行含问句 {questions} 条 · 含数字 {withNumbers} 条</p>
    {mostUsed.length > 0 && <div className="tag-row" aria-label="常见话题">
      {mostUsed.map(([tag, count]) => <span key={tag}>#{tag} · {count}</span>)}
    </div>}
    {items.length > 0 && (!comparable ? <p className="muted small">筛选同一平台和作品类型，可以比较相近发布日期的作品。</p>
      : ranked.length >= 2 ? <div className="field-group">
        <h3>同发布周{metricLabel}较多的作品</h3>
        <p className="muted small">{previousWeek} 至 {latest} · {ranked.length} 条有{metricLabel}数据 · 按公开累计值排序</p>
        <ol>{top.map(({ item, value }) => <li key={item.id}>
          {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{titleOf(item)}</a> : titleOf(item)}
          {' · '}{value.toLocaleString('zh-CN')} {metricLabel}
        </li>)}</ol>
      </div> : <p className="muted small">至少有两条相近日期的作品提供{metricLabel}数据时，才展示比较结果。</p>)}
    </div>
  </details>;
}

function TopicDetail({ item, path, refresh, openManuscript, analysis, activeGoal, notes }: {
  item: TopicWork; path: string; refresh: () => void; openManuscript: (id: string) => void;
  analysis: ReturnType<typeof useTopicAiAnalysis>; activeGoal: string; notes: ReturnType<typeof useTopicNotes>;
}) {
  const action = useAction();
  const [angleError, setAngleError] = useState('');
  const draftNote = notes.drafts[item.id];
  const note = draftNote?.value ?? item.note ?? '';
  const noteField = useRef<HTMLTextAreaElement>(null);
  const angle = angleFor(item);
  const cover = coverOf(item);
  function addAngle(value: string) {
    if (note.includes(value)) return;
    const next = [note.trim(), value].filter(Boolean).join('\n');
    if (next.length > 1000) {
      setAngleError('备注已接近 1000 字。腾出一些空间后再加入这个角度。');
      noteField.current?.focus();
    } else {
      setAngleError('');
      notes.change(item.id, next, true);
      pushToast('已加入「我的创作角度」备注。', 'success');
    }
  }
  function toggleSaved() {
    const saved = !item.savedAt;
    void action.run(async () => {
      await api(path, { method: 'PATCH', body: { saved } });
      refresh();
    }, saved ? '已收藏到选题池。' : '已移出选题池。');
  }
  const draft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void action.run(async () => {
      const { id } = await post<{ id: string }>(path + '/manuscript', { title: fields.get('title'), body: fields.get('body') });
      openManuscript(id);
    });
  };
  const metrics = [
    item.views != null && `${item.mediaType === 'video' ? '播放' : '阅读'} ${item.views.toLocaleString('zh-CN')}`,
    item.likes != null && `点赞 ${item.likes.toLocaleString('zh-CN')}`,
    item.comments != null && `评论 ${item.comments.toLocaleString('zh-CN')}`,
  ].filter(Boolean).join(' · ');
  return <section className="card detail-pane">
    <div className="detail-heading topic-detail-heading"><div><h2>{titleOf(item)}</h2>
      <p>{topicPlatforms[item.platform]} · {item.creator ?? '作者未记录'} · {topicMediaTypes[item.mediaType]}</p></div>
      <button type="button" className={`button compact${item.savedAt ? '' : ' primary'}`} disabled={action.busy} onClick={toggleSaved}>
        {item.savedAt ? '移出选题池' : '收藏到选题池'}
      </button>
    </div>
    <div className="detail-content">
      <Feedback error={action.error} notice={action.notice} />
      {(cover || item.mediaType === 'video') && <TopicCover key={cover} url={cover} platform={item.platform} preview />}
      {item.sourceUrl ? <div className="actions">
        <a className="button compact" href={item.sourceUrl} target="_blank" rel="noreferrer">查看原作品</a>
      </div> : <p className="muted small">来源未提供原作品链接。</p>}
      <p className="muted small">发布 {item.publishedOn?.slice(0, 10) ?? '日期未记录'} · 数据更新 {formatTime(item.importedAt)}</p>
      {metrics && <p>{metrics}</p>}
      <TopicInsights path={path} />
      <TopicAiPanel {...analysis} activeGoal={activeGoal} note={note} addAngle={addAngle} />
      <TopicChanges path={path} eager />
      <section className="topic-evidence field-group">
        <h3>为什么收录</h3>
        {item.matches?.length ? <ul>
          {item.matches.map(({ field, excerpt, seenAt, source }) => <li key={source.id}>
            <strong>{topicPlatforms[source.provider] ?? source.provider} · {source.target}</strong>
            <p>{field === 'source' ? '来自你指定的订阅范围'
              : `${field === 'title' ? '标题' : '摘要'}命中关键词「${source.keyword}」`} · {formatTime(seenAt)}</p>
            {excerpt && <blockquote>{excerpt}</blockquote>}
          </li>)}
        </ul> : <p className="muted small">{item.origin === 'report'
          ? '由你所在的工作室从 CreatorHub 报表导入。'
          : '历史记录未保存命中依据。该作品再次被采集时会记录依据。'}</p>}
      </section>
      <details className="source">
        <summary>查看来源描述</summary>
        <p className="content-text">{item.description || '来源未提供作品描述。'}</p>
      </details>
      {angle && <section className="field-group">
        <h3>可以怎么用</h3>
        <p>{angle}</p>
        <p className="muted small">建议依据标题和采集条件生成。</p>
        <div className="actions"><button type="button" className="button compact" disabled={note.includes(angle)}
          onClick={() => addAngle(angle)}>{note.includes(angle) ? '已加入备注' : '加入创作角度'}</button></div>
      </section>}
      <section className="form-stack">
        <label>我的创作角度<textarea ref={noteField} name="note" value={note} onChange={(event) => {
          notes.change(item.id, event.target.value);
          setAngleError('');
        }} maxLength={1000} rows={3} /></label>
        <Feedback error={angleError || (draftNote?.error ? `备注未保存。${draftNote.error}` : '')} />
        <div className="actions"><p className="muted small" role="status">
          {draftNote?.pending ? '正在保存备注…' : draftNote?.error ? '' : draftNote ? '备注已保存' : '修改后自动保存'}
        </p>
          {draftNote?.error && <button type="button" className="button compact" onClick={() => notes.change(item.id, note, true)}>
            重试保存备注
          </button>}
        </div>
      </section>
      <details className="source">
        <summary>从作品创建原稿</summary>
        <form className="form-stack" onSubmit={draft}>
          <label>原稿标题<input name="title" maxLength={200} required disabled={action.busy} /></label>
          <label>原稿正文<textarea name="body" maxLength={50_000} rows={4} required disabled={action.busy} /></label>
          <button type="submit" className="button" disabled={action.busy}>创建原稿</button>
        </form>
      </details>
    </div>
  </section>;
}

const emptyFilters = { platform: '', mediaType: '', creator: '', from: '', to: '' };
export type TopicView = 'works' | 'saved' | 'collection';

export function Topics({ scope, openManuscript, canConfigureAi, view, selected, onView, onSelect }: {
  scope: string; openManuscript: (id: string) => void; canConfigureAi: boolean;
  view: TopicView; selected: string; onView: (view: TopicView) => void; onSelect: (id: string) => void;
}) {
  const saved = view === 'saved';
  const showCollection = view === 'collection';
  const [filters, setFilters] = useState(emptyFilters);
  const [creatorText, setCreatorText] = useState('');
  const [composing, setComposing] = useState(false);
  const [goal, setGoal] = useState('');
  const [activeGoal, setActiveGoal] = useState('');
  const [notice, setNotice] = useState('');
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [reportIssues, setReportIssues] = useState<string[]>([]);
  const importAction = useAction();
  const fileHintId = useId();
  const dateErrorId = useId();
  const path = scope + '/topics/works';
  const aiPath = scope + '/topics/ai';
  const ai = useResource<TopicAiStatus>(aiPath);
  const notes = useTopicNotes(path);
  const invalidDates = Boolean(filters.from && filters.to && filters.from > filters.to);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
  if (saved) search.set('saved', 'true');
  const list = useResource<{ items: TopicWork[]; total: number }>(invalidDates ? null : path + '?' + search, 10_000);
  const items = list.data?.items ?? [];
  const selectedItem = items.find(({ id }) => id === selected) ?? items[0];
  const savedInView = items.filter((item) => Boolean(item.savedAt)).length;
  const topicStats: StatCardItem[] = [
    {
      key: 'total',
      label: saved ? '选题池匹配总数' : '对标作品总数',
      value: list.data ? list.data.total.toLocaleString('zh-CN') : '—',
      note: list.data && list.data.total > items.length ? `接口当前最多返回最近 ${items.length} 条` : '基于当前筛选条件实时统计',
      icon: Layers3,
      tone: 'neutral',
    },
    {
      key: 'loaded',
      label: '当前可分析样本',
      value: list.data ? items.length.toLocaleString('zh-CN') : '—',
      note: '支持即时样本统计与 AI 拆解',
      icon: Telescope,
      tone: 'sky',
    },
    {
      key: 'saved',
      label: '已收藏到选题池',
      value: list.data ? savedInView.toLocaleString('zh-CN') : '—',
      note: '当前列表内已收藏条目',
      icon: BookmarkCheck,
      tone: savedInView > 0 ? 'green' : 'neutral',
    },
    {
      key: 'ai',
      label: 'AI 拆解模型',
      value: ai.data?.provider ? (activeGoal ? '分析中' : '已就绪') : '待配置',
      note: ai.data?.model ? `当前模型：${ai.data.model}` : '未配置模型时不生成虚假分析',
      icon: Sparkles,
      tone: ai.data?.provider ? 'violet' : 'amber',
    },
  ];
  const workPath = !showCollection && selectedItem ? path + '/' + selectedItem.id : null;
  const analysis = useTopicAiAnalysis(workPath, selectedItem?.id === selected ? activeGoal : '', ai.data?.model ?? null);

  useEffect(() => {
    if (composing || creatorText.trim() === filters.creator) return;
    const timer = window.setTimeout(() => setFilters((current) => ({ ...current, creator: creatorText.trim() })), 300);
    return () => window.clearTimeout(timer);
  }, [creatorText, filters.creator, composing]);

  function filter(key: 'platform' | 'mediaType' | 'from' | 'to', value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function clearFilters() {
    setCreatorText(''); setComposing(false); setFilters(emptyFilters);
  }

  function importReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setNotice('');
    void importAction.run(async () => {
      if (!files.length || files.length > 10) throw new Error('一次请选择 1 至 10 份采集报表。');
      const works = new Map<string, ImportedWork>();
      const issues: string[] = [];
      let skipped = 0;
      let missingDates = 0;
      let duplicates = 0;
      for (const file of files) {
        try {
          if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('请选择 .xlsx 文件。');
          if (file.size > 8 * 1024 * 1024) throw new Error('单份报告不能超过 8 MiB。');
          const report = await readCreatorHubReport(file);
          if (!report.works.length) throw new Error('报表里没有可导入的作品。');
          skipped += report.skipped;
          missingDates += report.missingDates;
          for (const work of report.works) {
            const key = JSON.stringify([work.platform, work.externalId]);
            const previous = works.get(key);
            if (previous) duplicates++;
            works.set(key, { ...work, sourceUrl: work.sourceUrl ?? previous?.sourceUrl ?? null,
              views: work.views ?? previous?.views ?? null });
          }
        } catch (error) { issues.push(`${file.name}：${messageOf(error)}`); }
      }
      setReportIssues(issues);
      if (!works.size) throw new Error('所选报表中没有可导入的作品。');
      const encoder = new TextEncoder();
      let imported = 0;
      let batch: ImportedWork[] = [];
      let size = 16;
      const flush = async () => {
        if (!batch.length) return;
        const result = await post<{ imported: number }>(path + '/import', { works: batch });
        imported += result.imported;
        batch = [];
        size = 16;
      };
      try {
        for (const item of works.values()) {
          const bytes = encoder.encode(JSON.stringify(item)).length + 1;
          if (batch.length === 50 || size + bytes > 80_000) await flush();
          batch.push(item);
          size += bytes;
        }
        await flush();
      } catch (error) {
        throw new Error(imported ? `已导入 ${imported} 条，继续导入时失败。可以重试整份报告。` : messageOf(error));
      } finally { list.refresh(); }
      form.reset(); setFiles([]);
      const noticeParts = [`已导入或更新 ${imported} 条作品。`];
      if (skipped) noticeParts.push(`跳过 ${skipped} 条平台、作品 ID 或已有链接无效的记录。`);
      if (missingDates) noticeParts.push(`有 ${missingDates} 条缺少发布日期。`);
      if (duplicates) noticeParts.push(`合并了 ${duplicates} 条跨文件重复记录。`);
      if (issues.length) noticeParts.push(`${issues.length} 份报表未导入，见下方原因。`);
      const summary = noticeParts.join(' ');
      setNotice(summary);
      pushToast(summary, 'success');
    });
  }

  return <>
    <PageHeader title="选题台" description="筛选对标作品、比较创作角度，把想继续跟进的作品收藏到选题池。">
      {canConfigureAi && <button type="button" className={`button ${showAiSettings ? 'active' : ''}`}
        onClick={() => setShowAiSettings(!showAiSettings)} aria-expanded={showAiSettings}>
        <Bot size={16} aria-hidden="true" />{showAiSettings ? '收起 AI 设置' : '配置 AI 模型'}
      </button>}
    </PageHeader>
    {canConfigureAi && showAiSettings && <TopicAiSettings key={ai.data?.provider ?? 'loading'}
      path={aiPath} settings={ai.data} refresh={ai.refresh} error={ai.error} />}
    <div className="filters" role="group" aria-label="选题台视图">
      <button type="button" className={!showCollection && !saved ? 'active' : ''} aria-pressed={!showCollection && !saved}
        onClick={() => onView('works')}>对标作品</button>
      <button type="button" className={!showCollection && saved ? 'active' : ''} aria-pressed={!showCollection && saved}
        onClick={() => onView('saved')}>选题池</button>
      <button type="button" className={showCollection ? 'active' : ''} aria-pressed={showCollection}
        onClick={() => onView('collection')}>采集与导入</button>
    </div>
    {!showCollection && <StatGrid items={topicStats} columns={4} label="选题台数据概览" />}
    <div className="topic-view" hidden={showCollection}>
    <section className="card form-card form-stack">
      <div className="form-stack" role="group" aria-label="作品筛选">
        <div className="topic-filter-fields">
          <label>博主姓名或 ID<input name="creator" maxLength={120} value={creatorText} onChange={(event) => setCreatorText(event.target.value)}
            onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setCreatorText(event.currentTarget.value); setComposing(false); }} /></label>
          <label>平台<select name="platform" value={filters.platform} onChange={(event) => filter('platform', event.target.value)}><option value="">全部平台</option>
            {Object.entries(topicPlatforms).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <label>作品类型<select name="mediaType" value={filters.mediaType} onChange={(event) => filter('mediaType', event.target.value)}><option value="">全部类型</option>
            {Object.entries(topicMediaTypes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
        </div>
        <details className="topic-date-filter">
          <summary>{filters.from || filters.to ? `发布日期 · ${filters.from || '不限'} 至 ${filters.to || '不限'}` : '按发布日期筛选'}</summary>
          <div className="form-row">
            <label>发布起始日<input type="date" name="from" value={filters.from} onChange={(event) => filter('from', event.target.value)}
              aria-invalid={invalidDates} aria-describedby={invalidDates ? dateErrorId : undefined} /></label>
            <label>发布结束日<input type="date" name="to" value={filters.to} onChange={(event) => filter('to', event.target.value)}
              aria-invalid={invalidDates} aria-describedby={invalidDates ? dateErrorId : undefined} /></label>
          </div>
        </details>
        {invalidDates && <div id={dateErrorId}><Feedback error="发布结束日不能早于起始日。" /></div>}
        <div className="actions">
          <button type="button" className="button compact" disabled={!creatorText && !Object.values(filters).some(Boolean)} onClick={clearFilters}>清除筛选</button>
          {!invalidDates && <span className="muted small" role="status">
            {list.loading || (!composing && creatorText.trim() !== filters.creator) ? '正在筛选作品…'
              : list.data ? `符合条件 ${list.data.total} 条` : ''}
          </span>}
        </div>
      </div>
    </section>
    {(ai.data?.provider || canConfigureAi) && <details className="source topic-analysis">
      <summary>AI 随选分析<span className="count">{!ai.data?.provider ? '待配置' : activeGoal ? '已开启' : '未开启'}</span></summary>
      <div className="form-stack">
      <TopicAiGoal settings={ai.data} goal={goal} activeGoal={activeGoal} setGoal={setGoal}
        canConfigure={canConfigureAi} onConfigure={() => setShowAiSettings(true)}
        start={() => {
          setActiveGoal(goal.trim());
          if (selectedItem) onSelect(selectedItem.id);
        }} pause={() => setActiveGoal('')} />
      </div>
    </details>}
    <Feedback error={list.error} />
    {list.loading ? <Loading /> : items.length > 0 ? <>
      {list.data && list.data.total > items.length && <p className="muted">当前展示并分析最近 {items.length} 条，可缩小筛选范围。</p>}
      <TopicAnalysis items={items} />
      <div className="split-panel">
        <section className="card item-list">
          <div className="card-heading"><h2>{saved ? '收藏选题' : '对标作品'}</h2><span className="count">{items.length}</span></div>
          <div className="list-well scroll-shadow-y">
          {items.map((item) => <button key={item.id} type="button"
            className={`list-item${selectedItem?.id === item.id ? ' selected' : ''}`}
            aria-pressed={selectedItem?.id === item.id} onClick={() => onSelect(item.id)}>
            <TopicCover key={coverOf(item)} url={coverOf(item)} platform={item.platform} />
            <span className="list-copy"><strong title={titleOf(item)}>{titleOf(item)}</strong>
              <small>{topicPlatforms[item.platform]} · {item.creator ?? '作者未记录'}{item.savedAt ? ' · 已收藏' : ''}</small>
              <small>{[item.publishedOn?.slice(0, 10), item.views != null ? `${item.views.toLocaleString('zh-CN')} ${item.mediaType === 'video' ? '次播放' : '次阅读'}`
                : item.likes != null ? `${item.likes.toLocaleString('zh-CN')} 次点赞` : null,
              item.matches?.some(({ field }) => field !== 'source') ? '关键词命中' : null,
              ].filter(Boolean).join(' · ')}</small>
            </span>
          </button>)}
          </div>
        </section>
        {selectedItem && <TopicDetail key={selectedItem.id} item={selectedItem} path={path + '/' + selectedItem.id}
          refresh={list.refresh} openManuscript={openManuscript} analysis={analysis} activeGoal={activeGoal} notes={notes} />}
      </div>
    </> : !list.error && !invalidDates && <section className="card"><Empty icon={Telescope}
      title={saved ? '暂无符合条件的收藏选题' : '暂无符合条件的作品'}>
      {Object.values(filters).some(Boolean) ? <button type="button" className="button" onClick={clearFilters}>查看全部作品</button>
        : saved ? <button type="button" className="button" onClick={() => onView('works')}>浏览对标作品</button>
          : <button type="button" className="button primary" onClick={() => onView('collection')}>前往采集与导入</button>}
    </Empty></section>}
    </div>
    <div className="topic-view" hidden={!showCollection}>
    <TopicSources scope={scope} refreshWorks={list.refresh} />
    <section className="card form-card">
      <form className="form-stack" onSubmit={importReport}>
        <label>CreatorHub 采集报告<input type="file" accept=".xlsx" multiple required aria-describedby={fileHintId}
          disabled={importAction.busy} onChange={(event) => {
            setFiles(Array.from(event.currentTarget.files ?? [])); importAction.reset(); setNotice(''); setReportIssues([]);
          }} /></label>
        <p className="muted small" id={fileHintId}>一次最多 10 份 .xlsx，每份最多 8 MiB、1000 行。支持「作品」与「作品数据」表。</p>
        <Feedback error={importAction.error} notice={notice} />
        {reportIssues.length > 0 && <ul className="content-text" aria-label="未导入的报表">
          {reportIssues.map((issue, index) => <li key={index}>{issue}</li>)}
        </ul>}
        <div className="actions"><button type="submit" className="button primary" disabled={importAction.busy}>
          {importAction.busy ? '正在导入…' : '导入作品'}
        </button></div>
      </form>
    </section>
    </div>
  </>;
}
