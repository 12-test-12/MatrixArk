import { useState } from 'react';
import { ArrowRight, CalendarDays, ChevronRight, ClipboardCheck, FileText, Radio, Send } from 'lucide-react';
import { roleLabel, type Role, type TaskStatus } from './api';
import { PageHeader, TaskBadge } from './ui';
import { roleView, Workbench, type Section } from './workbench';

const samples = [
  {
    id: 'market', title: '周末市集逛摊指南',
    body: '周六上午去河边逛市集，先从南门的手作摊开始。下午可以到长椅区歇一会儿，再向东走去看陶器展。',
    version: 1, approved: false,
  },
  {
    id: 'walk', title: '下班后一小时的河边散步路线',
    body: '从桥下的木栈道出发，沿河步行到旧码头。傍晚从观景台往回看，刚好赶上桥灯亮起。',
    version: 2, approved: true,
  },
  {
    id: 'bakery', title: '社区面包店的周日菜单',
    body: '周日早上十点出炉第一批面包。喜欢咸口的可以试试橄榄佛卡夏，想带回家慢慢吃的可以选核桃酸种。',
    version: 1, approved: true,
  },
];
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
  const description = roleView[role].description;
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
    <PageHeader title="发布账号" description="管理接收小红书人工交接任务的账号。" />
    <section className="card">
      <div className="card-heading"><h2>账号列表</h2></div>
      <div className="account-row"><span className="platform-icon" aria-hidden="true">红</span>
        <div><strong>城南生活志</strong><small>运营人 · 周禾</small></div><span className="badge gray">人工交接</span>
      </div>
    </section>
  </>;

  const manuscripts = section === 'manuscripts';
  const status = roleView[role].taskStatus;
  const items = manuscripts
    ? samples.filter((sample) => role !== 'reviewer' || !sample.approved).map((manuscript) => ({ manuscript, task: undefined }))
    : tasks.filter((task) => !status || task.status === status).map((task) => ({ manuscript: task.manuscript, task }));
  const active = items.find(({ manuscript }) => manuscript.id === selection) ?? items[0]!;
  const Icon = manuscripts ? FileText : CalendarDays;
  const title = manuscripts ? (role === 'reviewer' ? '待审核原稿' : '原稿与审核')
    : status === 'handed_off' ? '待回填任务' : status === 'published' ? '已发布任务' : '发布任务';
  return <>
    <PageHeader title={title} description={section === roleView[role].sections[0] ? description :
      manuscripts ? '查阅原稿和对应的小红书版本。' : '查看交接进度和发布回执。'} />
    <div className="split-panel">
      <section className="card item-list">
        <div className="card-heading"><h2>{manuscripts ? '原稿列表' : '任务列表'}</h2><span className="count">{items.length}</span></div>
        {items.map(({ manuscript, task }) => <button type="button" key={manuscript.id}
          className={`list-item ${active.manuscript.id === manuscript.id ? 'selected' : ''}`}
          aria-pressed={active.manuscript.id === manuscript.id} onClick={() => setSelection(manuscript.id)}>
          <span className="list-icon"><Icon size={18} aria-hidden="true" /></span>
          <span className="list-copy"><strong>{manuscript.title}</strong><small>{task ? `城南生活志 · ${task.schedule}` : `小红书 · V${manuscript.version}`}</small></span>
          {task ? <TaskBadge status={task.status} /> : <span className={`badge ${manuscript.approved ? 'green' : 'amber'}`}>
            {manuscript.approved ? '已审核' : '待审核'}
          </span>}<ChevronRight className="row-chevron" size={15} aria-hidden="true" />
        </button>)}
      </section>
      <section className="card detail-pane task-detail">
        <div className="detail-heading"><h2>{active.manuscript.title}</h2></div>
        <div className="detail-content">
          <div className="task-section">
            <div className="section-line"><h3><Send size={17} aria-hidden="true" />{active.task ? '已审交接包' : '小红书版本'}</h3>
              <span className="version">V{active.manuscript.version}</span></div>
            <p className="content-text">{active.manuscript.body}</p>
          </div>
          {active.task && <div className="task-section">
            <div className="section-line"><h3><ClipboardCheck size={17} aria-hidden="true" />发布回执</h3><TaskBadge status={active.task.status} /></div>
            <p className="muted small">{active.task.status === 'published' ? '周禾已回填作品链接及发布截图。' : '交接已完成，等待运营发布并回填结果。'}</p>
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
      <button type="button" className="button primary compact" onClick={onLogin}>登录工作台<ArrowRight size={15} aria-hidden="true" /></button>
    </div>}>
    <PreviewContent key={`${role}:${section}`} role={role} section={section} />
  </Workbench>;
}
