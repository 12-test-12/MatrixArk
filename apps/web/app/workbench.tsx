import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { BarChart3, Bell, CalendarDays, ChevronRight, CircleUserRound, FileText, Telescope, UserRoundCog, UsersRound } from 'lucide-react';
import type { Role, TaskStatus } from './api';
import { ThemePicker } from './theme-picker';
import { Brand } from './ui';

const navigation = {
  manuscripts: { label: '原稿与审核', icon: FileText },
  tasks: { label: '发布任务', icon: CalendarDays },
  performance: { label: '作品成效', icon: BarChart3 },
  accounts: { label: '发布账号', icon: UsersRound },
  notifications: { label: '飞书提醒', icon: Bell },
  members: { label: '团队成员', icon: UserRoundCog },
  topics: { label: '选题台', icon: Telescope },
  profile: { label: '个人资料', icon: CircleUserRound },
};
export type Section = keyof typeof navigation;

const navGroups = [
  { label: '内容创作', items: ['topics', 'manuscripts'] },
  { label: '发布与成效', items: ['tasks', 'accounts', 'performance'] },
  { label: '工作室管理', items: ['notifications', 'members', 'profile'] },
] as const;

export const roleView: Record<Role, { sections: readonly [Section, ...Section[]]; taskStatus?: TaskStatus; description: string }> = {
  owner: { sections: ['tasks', 'manuscripts', 'accounts', 'performance', 'notifications', 'members', 'topics'], description: '查看发布进度和待核实的任务，管理工作室成员。' },
  editor: { sections: ['manuscripts', 'tasks', 'accounts', 'performance', 'topics'], description: '整理原稿与配图，生成各平台版本，为已审稿件排期。' },
  reviewer: { sections: ['manuscripts', 'tasks', 'performance'], description: '检查待审核版本的文案、配图和封面。' },
  operator: { sections: ['tasks', 'manuscripts', 'performance'], taskStatus: 'handed_off', description: '取用已审交接包，发布后补填作品链接或截图。' },
  viewer: { sections: ['tasks', 'manuscripts', 'performance'], taskStatus: 'published', description: '查阅原稿、发布进度和回执。' },
};

export function Workbench({ sections, section, onSection, workspacePicker, profile, topbar, badges, children }: {
  sections: readonly Section[]; section?: Section; onSection: (section: Section) => void;
  workspacePicker: ReactNode; profile?: ReactNode; topbar?: ReactNode; children: ReactNode;
  badges?: Partial<Record<Section, { count: number; label: string }>>;
}) {
  function handleSelectSection(id: Section) {
    if (id === section) return;
    if (typeof window !== 'undefined') {
      const doc = document as unknown as {
        startViewTransition?: (cb: () => void) => {
          ready?: Promise<void>;
          updateCallbackDone?: Promise<void>;
          finished?: Promise<void>;
        };
        getElementById: (id: string) => HTMLElement | null;
      };
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!reduceMotion && typeof doc.startViewTransition === 'function') {
        try {
          const transition = doc.startViewTransition(() => {
            flushSync(() => {
              onSection(id);
            });
          });
          transition?.ready?.catch(() => {});
          transition?.updateCallbackDone?.catch(() => {});
          transition?.finished?.catch(() => {}).finally(() => {
            doc.getElementById('workspace-content')?.focus();
          });
          return;
        } catch {
          // Fall back cleanly if the browser aborts view transitions (e.g. viewport resize)
        }
      }
      onSection(id);
      requestAnimationFrame(() => {
        doc.getElementById('workspace-content')?.focus();
      });
      return;
    }
    onSection(id);
  }

  return <div className="shell">
    <a className="skip-link" href="#workspace-content">跳到工作区</a>
    <aside className="sidebar">
      <Brand detail />
      {workspacePicker}
      <nav aria-label="工作台导航" className="nav">
        {navGroups.map(({ label, items }) => {
          const allowed = items.filter((id) => sections.includes(id));
          if (!allowed.length) return null;
          return <div className="nav-group" key={label} role="group" aria-label={label}>
            <div className="nav-label">{label}</div>
            {allowed.map((id) => {
              const { label, icon: Icon } = navigation[id];
              const badge = badges?.[id];
              return <button key={id} type="button" aria-current={section === id ? 'page' : undefined}
                aria-label={badge && badge.count > 0 ? `${label}，${badge.label}` : undefined}
                className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => handleSelectSection(id)}>
                <Icon aria-hidden="true" size={19} /><span>{label}</span>
                {badge && badge.count > 0 ? <span className="count nav-badge" aria-hidden="true" title={badge.label}>{badge.count}</span>
                  : section === id && <span className="nav-dot" />}
              </button>;
            })}
          </div>;
        })}
      </nav>
      {profile}
    </aside>
    <div className="shell-body">
      <div className="topbar-sticky">
        <header className="topbar">
          <div className="breadcrumb"><span>工作台</span>{section && <>
            <ChevronRight size={15} aria-hidden="true" /><strong>{navigation[section].label}</strong>
          </>}</div>
          <div className="topbar-actions"><ThemePicker />{topbar}</div>
        </header>
      </div>
      <main id="workspace-content" tabIndex={-1} className="main">{children}</main>
    </div>
  </div>;
}
