import type { ReactNode } from 'react';
import { CalendarDays, ChevronRight, FileText, UserRoundCog, UsersRound } from 'lucide-react';
import type { Role, TaskStatus } from './api';
import { Brand } from './ui';

const navigation = {
  manuscripts: { label: '原稿与审核', icon: FileText },
  tasks: { label: '发布任务', icon: CalendarDays },
  accounts: { label: '发布账号', icon: UsersRound },
  members: { label: '团队成员', icon: UserRoundCog },
};
export type Section = keyof typeof navigation;

export const roleView: Record<Role, { sections: readonly [Section, ...Section[]]; taskStatus?: TaskStatus; description: string }> = {
  owner: { sections: ['tasks', 'manuscripts', 'accounts', 'members'], description: '查看发布进度和待核实的任务，管理工作室成员。' },
  editor: { sections: ['manuscripts', 'tasks', 'accounts'], description: '整理原稿与配图，生成各平台版本，为已审稿件排期。' },
  reviewer: { sections: ['manuscripts', 'tasks'], description: '检查待审核版本的文案、配图和封面。' },
  operator: { sections: ['tasks', 'manuscripts'], taskStatus: 'handed_off', description: '取用已审交接包，发布后补填作品链接或截图。' },
  viewer: { sections: ['tasks', 'manuscripts'], taskStatus: 'published', description: '查阅原稿、发布进度和回执。' },
};

export function Workbench({ sections, section, onSection, workspacePicker, profile, topbar, children }: {
  sections: readonly Section[]; section?: Section; onSection: (section: Section) => void;
  workspacePicker: ReactNode; profile?: ReactNode; topbar?: ReactNode; children: ReactNode;
}) {
  return <div className="shell">
    <a className="skip-link" href="#workspace-content">跳到工作区</a>
    <aside className="sidebar">
      <Brand detail />
      {workspacePicker}
      <nav aria-label="工作台导航" className="nav">
        <div className="nav-label">工作台</div>
        {sections.map((id) => {
          const { label, icon: Icon } = navigation[id];
          return <button key={id} type="button" aria-current={section === id ? 'page' : undefined}
            className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => onSection(id)}>
            <Icon aria-hidden="true" size={19} /><span>{label}</span>{section === id && <span className="nav-dot" />}
          </button>;
        })}
      </nav>
      {profile}
    </aside>
    <div className="shell-body">
      <header className="topbar">
        <div className="breadcrumb"><span>工作台</span>{section && <>
          <ChevronRight size={15} aria-hidden="true" /><strong>{navigation[section].label}</strong>
        </>}</div>
        {topbar}
      </header>
      <main id="workspace-content" tabIndex={-1} className="main">{children}</main>
    </div>
  </div>;
}
