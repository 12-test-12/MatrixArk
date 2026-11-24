import { useId, useState, type FormEvent } from 'react';
import { Telescope } from 'lucide-react';
import { api, formatTime, messageOf, post, useAction, useResource } from './api';
import { parseCreatorHubWorks, topicMediaTypes, topicPlatforms, type ImportedWork, type TopicWork } from './creatorhub-report';
import { Empty, Feedback, Loading, PageHeader } from './ui';

function titleOf(item: TopicWork) {
  return item.description.split('\n', 1)[0]?.trim() || '无作品描述';
}

function TopicAnalysis({ items, compareLikes }: { items: TopicWork[]; compareLikes: boolean }) {
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
  const liked = compareLikes ? items.filter((item) => item.likes !== null && item.publishedOn
    && item.publishedOn.slice(0, 10) >= previousWeek) : [];
  const top = [...liked].sort((a, b) => b.likes! - a.likes!).slice(0, 3);
  return <section className="card form-card form-stack">
    <div className="section-line"><h2>样本分析</h2><span className="badge gray">{items.length} 条作品</span></div>
    {latest && <p className="muted">发布范围 {orderedDays[0]} 至 {latest} · {days.size} 天有更新</p>}
    <p>描述首行含问句 {questions} 条 · 含数字 {withNumbers} 条</p>
    {mostUsed.length > 0 && <div className="tag-row" aria-label="常见话题">
      {mostUsed.map(([tag, count]) => <span key={tag}>#{tag} · {count}</span>)}
    </div>}
    {!compareLikes ? <p className="muted small">选定同一平台和作品类型后，可比较同一发布周内的作品点赞。</p>
      : top.length ? <div className="field-group">
        <h3>发布周高赞样本</h3>
        <p className="muted small">{previousWeek} 至 {latest} · {liked.length} 条有点赞数据</p>
        <ol>{top.map((item) => <li key={item.id}>
          <a href={item.sourceUrl} target="_blank" rel="noreferrer">{titleOf(item)}</a> · {item.likes!.toLocaleString('zh-CN')} 赞
        </li>)}</ol>
      </div> : <p className="muted small">当前样本缺少可比较的发布时间或点赞数据。</p>}
  </section>;
}

function TopicDetail({ item, path, refresh, openManuscript }: {
  item: TopicWork; path: string; refresh: () => void; openManuscript: (id: string) => void;
}) {
  const action = useAction();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void action.run(async () => {
      await api(path, { method: 'PATCH', body: { saved: true, note: fields.get('note') } });
      refresh();
    }, '已保存到选题池。');
  };
  const draft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void action.run(async () => {
      const { id } = await post<{ id: string }>(path + '/manuscript', { title: fields.get('title'), body: fields.get('body') });
      openManuscript(id);
    });
  };
  return <section className="card detail-pane">
    <div className="detail-heading"><div><h2>{titleOf(item)}</h2>
      <p>{topicPlatforms[item.platform]} · {item.creator ?? '作者未记录'} · {topicMediaTypes[item.mediaType]}</p></div></div>
    <div className="detail-content">
      <p className="content-text">{item.description || '报告未提供作品描述。'}</p>
      <div className="actions"><a className="button compact" href={item.sourceUrl} target="_blank" rel="noreferrer">查看原作品</a></div>
      <p className="muted small">发布 {item.publishedOn?.slice(0, 10) ?? '日期未记录'} · 导入 {formatTime(item.importedAt)}</p>
      <p>点赞 {item.likes ?? '未记录'} · 评论 {item.comments ?? '未记录'}</p>
      <Feedback error={action.error} notice={action.notice} />
      <form className="form-stack" onSubmit={submit}>
        <label>我的创作角度<textarea name="note" defaultValue={item.note ?? ''} maxLength={1000} rows={3} disabled={action.busy} /></label>
        <div className="actions">
          <button type="submit" className="button primary" disabled={action.busy}>{item.savedAt ? '保存选题备注' : '收藏到选题池'}</button>
          {item.savedAt && <button type="button" className="button" disabled={action.busy} onClick={() => void action.run(async () => {
            await api(path, { method: 'PATCH', body: { saved: false } });
            refresh();
          }, '已移出选题池。')}>移出选题池</button>}
        </div>
      </form>
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

export function Topics({ scope, openManuscript }: { scope: string; openManuscript: (id: string) => void }) {
  const [saved, setSaved] = useState(false);
  const [filters, setFilters] = useState('');
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const [file, setFile] = useState<File>();
  const importAction = useAction();
  const fileHintId = useId();
  const path = scope + '/topics/works';
  const search = new URLSearchParams(filters);
  if (saved) search.set('saved', 'true');
  const list = useResource<{ items: TopicWork[]; total: number }>(path + '?' + search);
  const items = list.data?.items ?? [];
  const selectedItem = items.find(({ id }) => id === selected) ?? items[0];

  function importReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setNotice('');
    void importAction.run(async () => {
      if (!file?.name.toLowerCase().endsWith('.xlsx')) throw new Error('请上传 CreatorHub 导出的 .xlsx 采集报告。');
      if (file.size > 8 * 1024 * 1024) throw new Error('报告不能超过 8 MiB，请缩小 CreatorHub 导出范围。');
      const { readSheet } = await import('read-excel-file/browser');
      const rows = await readSheet(file, '作品').catch(() => {
        throw new Error('无法读取「作品」工作表。请从 CreatorHub 的采集任务导出 Excel 报告。');
      });
      if (rows.length > 1001) throw new Error('单次最多导入 1000 行，请分批导出。');
      const { works, skipped } = parseCreatorHubWorks(rows);
      if (!works.length) throw new Error('报告里没有可导入的作品，请检查平台、作品 ID 和链接。');
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
        for (const item of works) {
          const bytes = encoder.encode(JSON.stringify(item)).length + 1;
          if (batch.length === 50 || size + bytes > 80_000) await flush();
          batch.push(item);
          size += bytes;
        }
        await flush();
      } catch (error) {
        throw new Error(imported ? `已导入 ${imported} 条，继续导入时失败。可以重试整份报告。` : messageOf(error));
      } finally { list.refresh(); }
      form.reset(); setFile(undefined); setSaved(false);
      setNotice(`已导入或更新 ${imported} 条作品。${skipped ? `跳过 ${skipped} 条缺少有效平台、作品 ID 或链接的记录。` : ''}`);
    });
  }

  return <>
    <PageHeader title="选题台" description="导入 CreatorHub 采集作品，比较选题表现并积累自己的创作角度。" />
    <section className="card form-card">
      <form className="form-stack" onSubmit={importReport}>
        <label>CreatorHub 采集报告<input type="file" accept=".xlsx" required aria-describedby={fileHintId}
          disabled={importAction.busy} onChange={(event) => { setFile(event.currentTarget.files?.[0]); importAction.reset(); setNotice(''); }} /></label>
        <p className="muted small" id={fileHintId}>在 CreatorHub 采集任务中导出 Excel，上传含「作品」工作表的报告。</p>
        <Feedback error={importAction.error} notice={notice} />
        <div className="actions"><button type="submit" className="button primary" disabled={importAction.busy}>
          {importAction.busy ? '正在导入…' : '导入作品'}
        </button></div>
      </form>
    </section>
    <section className="card form-card">
      <div className="filters" role="group" aria-label="作品范围">
        <button type="button" className={saved ? '' : 'active'} aria-pressed={!saved} onClick={() => setSaved(false)}>对标作品</button>
        <button type="button" className={saved ? 'active' : ''} aria-pressed={saved} onClick={() => setSaved(true)}>选题池</button>
      </div>
      <form className="form-stack" onSubmit={(event) => {
        event.preventDefault();
        const next = new URLSearchParams();
        for (const [key, value] of new FormData(event.currentTarget)) if (typeof value === 'string' && value.trim()) next.set(key, value.trim());
        setSelected(''); setFilters(next.toString());
      }}>
        <div className="form-row">
          <label>平台<select name="platform"><option value="">全部平台</option>
            {Object.entries(topicPlatforms).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <label>作品类型<select name="mediaType"><option value="">全部类型</option>
            {Object.entries(topicMediaTypes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
        </div>
        <div className="form-row">
          <label>博主姓名或 ID<input name="creator" maxLength={120} /></label>
          <label>发布起始日<input type="date" name="from" /></label>
          <label>发布结束日<input type="date" name="to" /></label>
        </div>
        <div className="actions"><button type="submit" className="button">应用筛选</button>
          <button type="reset" className="button" onClick={() => { setFilters(''); setSelected(''); }}>清除筛选</button></div>
      </form>
    </section>
    <Feedback error={list.error} />
    {list.loading ? <Loading /> : items.length > 0 ? <>
      {list.data && list.data.total > items.length && <p className="muted">符合条件 {list.data.total} 条。当前分析最近 {items.length} 条，可缩小筛选范围。</p>}
      <TopicAnalysis items={items} compareLikes={search.has('platform') && search.has('mediaType')} />
      <div className="split-panel">
        <section className="card item-list">
          <div className="card-heading"><h2>{saved ? '收藏选题' : '对标作品'}</h2><span className="count">{items.length}</span></div>
          {items.map((item) => <button key={item.id} type="button"
            className={`list-item${selectedItem?.id === item.id ? ' selected' : ''}`}
            aria-pressed={selectedItem?.id === item.id} onClick={() => setSelected(item.id)}>
            <span className="list-copy"><strong>{titleOf(item)}</strong>
              <small>{topicPlatforms[item.platform]} · {item.creator ?? '作者未记录'}{item.savedAt ? ' · 已收藏' : ''}</small>
            </span>
          </button>)}
        </section>
        {selectedItem && <TopicDetail key={selectedItem.id} item={selectedItem} path={path + '/' + selectedItem.id}
          refresh={list.refresh} openManuscript={openManuscript} />}
      </div>
    </> : !list.error && <section className="card"><Empty icon={Telescope} title={saved ? '暂无收藏选题' : '暂无符合条件的作品'} /></section>}
  </>;
}
