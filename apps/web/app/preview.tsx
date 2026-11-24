import { useMemo, useState } from 'react';
import { ArrowRight, BarChart3, CalendarDays, ChevronRight, ClipboardCheck, Copy, FileText, History, Radio, Search, Send, X } from 'lucide-react';
import { platformLabel, platforms, roleLabel, type Platform, type Role, type TaskStatus } from './api';
import { Empty, PageHeader, PlatformIcon, TaskBadge } from './ui';
import { roleView, Workbench, type Section } from './workbench';

const samples = [
  {
    id: 'market', title: '周末市集逛摊指南',
    body: '周六上午去河边逛市集，先从南门的手作摊开始。下午可以到长椅区歇一会儿，再向东走去看陶器展。',
    version: 1, approved: false, platform: 'xiaohongshu',
  },
  {
    id: 'walk', title: '下班后一小时的河边散步路线',
    body: '从桥下的木栈道出发，沿河步行到旧码头。傍晚从观景台往回看，刚好赶上桥灯亮起。',
    version: 2, approved: true, platform: 'xiaohongshu',
  },
  {
    id: 'bakery', title: '社区面包店的周日菜单',
    body: '周日早上十点出炉第一批面包。喜欢咸口的可以试试橄榄佛卡夏，想带回家慢慢吃的可以选核桃酸种。',
    version: 1, approved: true, platform: 'bilibili',
  },
] satisfies { id: string; title: string; body: string; version: number; approved: boolean; platform: Platform }[];
const accountNames: Record<Platform, string> = { xiaohongshu: '城南生活志', bilibili: '城南观察' };
const tasks: { manuscript: (typeof samples)[number]; status: TaskStatus; schedule: string }[] = [
  { manuscript: samples[1]!, status: 'handed_off', schedule: '周五 18:30' },
  { manuscript: samples[2]!, status: 'published', schedule: '上周日 10:00' },
];
const people: { name: string; role: Role }[] = [
  { name: '林舟', role: 'owner' }, { name: '陈雨', role: 'editor' }, { name: '许棠', role: 'reviewer' },
  { name: '周禾', role: 'operator' }, { name: '孟川', role: 'viewer' },
];

function PreviewContent({ role, section }: { role: Role; section: Section }) {
  const [selection, setSelection] = useState('');
  const [keyword, setKeyword] = useState('');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [copied, setCopied] = useState(false);
  const description = roleView[role].description;
  if (section === 'topics') return <>
    <PageHeader title="选题台" description="按平台和博主分析对标作品，收藏适合自己的选题。" />
    <section className="card form-card">
      <h2>导入 CreatorHub 报告</h2>
      <p className="muted">登录后可导入采集报告并保存到工作室。</p>
    </section>
  </>;
  if (section === 'notifications') return <>
    <PageHeader title="飞书提醒" description="连接工作室的飞书群，接收任务交接和未回填提醒。" />
    <section className="card form-card form-stack">
      <h2>连接群机器人</h2>
      <p className="muted">登录后，工作室负责人可以保存机器人地址并发送测试消息。</p>
    </section>
  </>;
  if (section === 'members') return <>
    <PageHeader title="团队成员" description="负责人可以添加已注册的成员，并为每个人分配工作室角色。" />
    <section className="card" aria-label="示例团队成员">
      {people.map((person) => <div className="account-row" key={person.role}>
        <span className="avatar" aria-hidden="true">{person.name[0]}</span>
        <div><strong>{person.name}</strong><small>{roleView[person.role].description}</small></div>
        <span className="badge gray">{roleLabel[person.role]}</span>
      </div>)}
    </section>
  </>;
  if (section === 'accounts') return <>
    <PageHeader title="发布账号" description="通过平台授权核验真实账号。账号身份和发布权限分别显示。" />
    <section className="card">
      <div className="card-heading"><h2>账号列表</h2></div>
      {platforms.map((platform) => <div className="account-row" key={platform}>
        <PlatformIcon platform={platform} />
        <div><strong>{accountNames[platform]}</strong><small>{platformLabel[platform]} · 周禾</small></div>
        <span className="badge gray">人工交接</span>
      </div>)}
    </section>
  </>;

  const manuscripts = section === 'manuscripts';
  const status = roleView[role].taskStatus;
  const rawItems = manuscripts
    ? samples.filter((sample) => role !== 'reviewer' || !sample.approved).map((manuscript) => ({ manuscript, task: undefined }))
    : tasks.filter((task) => !status || task.status === status).map((task) => ({ manuscript: task.manuscript, task }));

  const items = useMemo(() => {
    return rawItems.filter(({ manuscript }) => {
      if (platformFilter !== 'all' && manuscript.platform !== platformFilter) return false;
      if (keyword.trim()) {
        const query = keyword.trim().toLowerCase();
        const titleMatch = manuscript.title.toLowerCase().includes(query);
        const bodyMatch = manuscript.body.toLowerCase().includes(query);
        return titleMatch || bodyMatch;
      }
      return true;
    });
  }, [rawItems, keyword, platformFilter]);

  const active = items.find(({ manuscript }) => manuscript.id === selection) ?? items[0];
  const Icon = manuscripts ? FileText : CalendarDays;
  const title = manuscripts ? (role === 'reviewer' ? '待审核原稿' : '原稿与审核')
    : status === 'handed_off' ? '待回填任务' : status === 'published' ? '已发布任务' : '发布任务';
  if (!active) {
    return <>
      <PageHeader title={title} description={section === roleView[role].sections[0] ? description :
        manuscripts ? '查阅原稿和对应的平台版本。' : '查看各平台交接进度和发布回执。'} />
      <div className="split-panel">
        <section className="card item-list">
          <div className="card-heading">
            <h2>{manuscripts ? '原稿列表' : '任务列表'}</h2>
            <span className="count">0</span>
          </div>
          <div className="list-toolbar">
            <div className="search-box">
              <Search size={14} className="search-icon" aria-hidden="true" />
              <input
                type="text"
                placeholder={manuscripts ? '搜索原稿标题或内容…' : '搜索任务标题…'}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                aria-label="搜索"
              />
              {keyword && (
                <button
                  type="button"
                  className="clear-button"
                  onClick={() => setKeyword('')}
                  aria-label="清除搜索"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <Empty icon={Icon} title={keyword || platformFilter !== 'all' ? '未找到符合条件的内容' : manuscripts ? '暂无示例原稿' : '暂无示例任务'} />
        </section>
        <section className="card detail-pane empty-detail">
          <Empty icon={Icon} title="请选择列表项查看详情" />
        </section>
      </div>
    </>;
  }

  function handleCopy() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(active?.manuscript.body ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return <>
    <PageHeader title={title} description={section === roleView[role].sections[0] ? description :
      manuscripts ? '查阅原稿和对应的平台版本。' : '查看各平台交接进度和发布回执。'} />
    <div className="split-panel">
      <section className="card item-list">
        <div className="card-heading">
          <h2>{manuscripts ? '原稿列表' : '任务列表'}</h2>
          <span className="count">{items.length}</span>
        </div>
        <div className="list-toolbar">
          <div className="search-box">
            <Search size={14} className="search-icon" aria-hidden="true" />
            <input
              type="text"
              placeholder={manuscripts ? '搜索原稿标题或内容…' : '搜索任务标题…'}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              aria-label="搜索"
            />
            {keyword && (
              <button
                type="button"
                className="clear-button"
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
            <option value="xiaohongshu">小红书</option>
            <option value="bilibili">哔哩哔哩</option>
          </select>
        </div>
        {items.map(({ manuscript, task }) => <button type="button" key={manuscript.id}
          className={`list-item ${active.manuscript.id === manuscript.id ? 'selected' : ''}`}
          aria-pressed={active.manuscript.id === manuscript.id} onClick={() => setSelection(manuscript.id)}>
          <span className="list-icon"><Icon size={18} aria-hidden="true" /></span>
          <span className="list-copy">
            <strong>{manuscript.title || '未命名任务'}</strong>
            <small>{platformLabel[manuscript.platform]} · {task ? task.schedule : `V${manuscript.version}`}</small>
          </span>
          {task ? <TaskBadge status={task.status} /> : <span className={`badge ${manuscript.approved ? 'green' : 'amber'}`}>
            {manuscript.approved ? '已审核' : '待审核'}
          </span>}<ChevronRight className="row-chevron" size={15} aria-hidden="true" />
        </button>)}
      </section>
      <section className="card detail-pane task-detail">
        <div className="detail-heading">
          <div className="detail-icon"><Icon size={22} aria-hidden="true" /></div>
          <div>
            <h2>{active.manuscript.title || '未命名任务'}</h2>
            <p>{platformLabel[active.manuscript.platform]}{active.task && ` · ${accountNames[active.manuscript.platform] ?? '未指定账号'}`} · V{active.manuscript.version}</p>
          </div>
          {active.task && <TaskBadge status={active.task.status} />}
        </div>
        <div className="detail-content">
          {active.task && <dl className="task-meta">
            <div><dt>计划时间</dt><dd>{active.task.schedule}</dd></div>
            <div><dt>实际交接</dt><dd>{active.task.status === 'published' ? '上周日 09:45' : '周五 18:00'}</dd></div>
            <div><dt>发布账号</dt><dd>{accountNames[active.manuscript.platform] ?? '未指定账号'}</dd></div>
            <div><dt>版本规格</dt><dd>V{active.manuscript.version} · {platformLabel[active.manuscript.platform]}</dd></div>
          </dl>}
          <div className="task-section">
            <div className="section-line">
              <h3><Send size={17} aria-hidden="true" />{active.task ? '已审交接包' : '平台版本'}</h3>
              <span className="version">V{active.manuscript.version}</span>
            </div>
            <div className="variant-preview">
              <div className="preview-top">
                <span className="version">V{active.manuscript.version} · 正文文案</span>
                <button
                  type="button"
                  className="button primary compact"
                  onClick={handleCopy}
                  title="一键复制交接文案"
                >
                  <Copy size={13} aria-hidden="true" />
                  {copied ? '已复制！' : '复制文案'}
                </button>
              </div>
              <p className="content-text">{active.manuscript.body}</p>
            </div>
          </div>
          {active.task && <div className="task-section">
            <div className="section-line">
              <h3><ClipboardCheck size={17} aria-hidden="true" />发布回执</h3>
              <TaskBadge status={active.task.status} />
            </div>
            <p className="muted small">{active.task.status === 'published' ? '周禾已回填作品链接及发布截图。' : '交接已完成，等待运营发布并回填结果。'}</p>
          </div>}
          {active.task && <div className="task-section">
            <h3><History size={17} aria-hidden="true" />操作记录</h3>
            <ol className="timeline">
              <li>
                <span className={`timeline-dot ${active.task.status === 'published' ? 'green' : 'violet'}`} />
                <div className="timeline-content">
                  <div className="timeline-header">
                    <strong>{active.task.status === 'published' ? '发布回执已确认' : '已生成交接包'}</strong>
                    <time className="muted small">{active.task.status === 'published' ? '上周日 10:15' : '周五 18:00'}</time>
                  </div>
                  <div className="timeline-actor">周禾 · 运营人员</div>
                  {active.task.status === 'published' && <p className="timeline-reason">已在小红书完成图文发布，并回填核验原链接与手机端截图。</p>}
                </div>
              </li>
              <li>
                <span className="timeline-dot violet" />
                <div className="timeline-content">
                  <div className="timeline-header">
                    <strong>终审通过并排期</strong>
                    <time className="muted small">上周五 15:30</time>
                  </div>
                  <div className="timeline-actor">许棠 · 审校人</div>
                  <p className="timeline-reason">文案与标签核查完毕，符合发布规范。</p>
                </div>
              </li>
            </ol>
          </div>}
        </div>
      </section>
    </div>
  </>;
}

export function Preview({ onLogin }: { onLogin: () => void }) {
  const [role, setRole] = useState<Role>('owner');
  const [activeSection, setSection] = useState<Section>();
  const { sections } = roleView[role];
  const section = activeSection ?? sections[0];
  return <Workbench sections={sections} section={section} onSection={setSection}
    workspacePicker={<label className="workspace-picker">
      <span className="workspace-icon"><Radio size={19} aria-hidden="true" /></span>
      <span><small>以角色预览</small><select value={role} onChange={(event) => {
        setRole(event.target.value as Role); setSection(undefined);
      }}>{Object.entries(roleLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></span>
    </label>}
    topbar={<div className="preview-actions"><span className="badge gray">示例数据 · 只读</span>
      <button type="button" className="button primary compact" aria-haspopup="dialog" onClick={onLogin}>登录工作台<ArrowRight size={15} aria-hidden="true" /></button>
    </div>}>
    {section === 'performance'
      ? <section className="card"><Empty icon={BarChart3} title="登录后查看作品成效" description="按平台、账号和内容类型查看真实作品的数据。" /></section>
      : <PreviewContent key={`${role}:${section}`} role={role} section={section} />}
  </Workbench>;
}
