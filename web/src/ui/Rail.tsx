// The rail: the mark (opening the app menu), the views with keys 1 to 9 on the first nine, and the "Woven from N
// entries" footer.

import type { LucideIcon } from 'lucide-preact';
import { Brain, CalendarRange, Compass, FlaskConical, GraduationCap, Hash, LayoutDashboard, ListTodo, Plus, Search, UserRound } from 'lucide-preact';
import { go, openCommand } from '../actions.ts';
import { fmtNum } from '../format.ts';
import { setState, type Target, useApp } from '../store.ts';
import { Logo, MOD } from './common.tsx';

export const RAIL: { target: Target; label: string; icon: LucideIcon; hint: string }[] = [
  { target: 'brain', label: 'Brain', icon: Brain, hint: 'The 3D view of the record' },
  { target: 'threads', label: 'Threads', icon: Compass, hint: 'Folders, hubs, threads and notes' },
  { target: 'stats', label: 'Stats', icon: Hash, hint: 'Plain figures about the record' },
  { target: 'timeline', label: 'Timeline', icon: CalendarRange, hint: 'Activity over time' },
  { target: 'profile', label: 'Profile', icon: UserRound, hint: 'What the record says about you' },
  { target: 'workbench', label: 'Workbench', icon: FlaskConical, hint: 'The table builder and Activity' },
  { target: 'views', label: 'Views', icon: LayoutDashboard, hint: 'Charts and lists you pick or describe' },
  { target: 'assistant', label: 'Assistant', icon: ListTodo, hint: 'Your brief, open loops and tasks' },
  { target: 'guide', label: 'Guide', icon: GraduationCap, hint: 'How to read the brain' },
  { target: 'add', label: 'Add', icon: Plus, hint: 'Add files, a note or a source' },
];

export function isActive(target: Target, view: string, panel: string | undefined): boolean {
  if (target === 'guide' || target === 'add') return panel === target;
  return view === target && panel !== 'guide';
}

export function Rail() {
  const view = useApp((s) => s.view);
  const panel = useApp((s) => s.panel?.kind);
  const entries = useApp((s) => s.status?.entries ?? 0);
  const review = useApp((s) => s.organiser.review.filter((r) => r.status === 'open').length);
  const menuOpen = useApp((s) => s.menuOpen);
  return (
    <nav class="rail" aria-label="Views">
      <button
        type="button"
        class="rail-mark"
        aria-label="Skeinwise menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setState({ menuOpen: !menuOpen })}
      >
        <Logo size={30} />
      </button>
      <button type="button" class="rail-item" onClick={() => openCommand()} title={`Search (${MOD}K)`}>
        <Search size={20} aria-hidden="true" />
        <span>Search</span>
        <span class="rail-key" aria-hidden="true">
          {MOD}K
        </span>
      </button>
      <div class="rail-sep" />
      {RAIL.map(({ target, label, icon: Icon, hint }, i) => {
        const on = isActive(target, view, panel);
        // Keys 1 to 9 open the first nine entries (App.tsx); the ones after them have no key.
        const key = i < 9 ? String(i + 1) : null;
        return (
          <button
            key={target}
            type="button"
            class={`rail-item${on ? ' on' : ''}${target === 'add' ? ' rail-add' : ''}`}
            aria-current={on ? 'page' : undefined}
            title={key ? `${hint} (${key})` : hint}
            onClick={() => go(target)}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{target === 'add' ? '+ Add' : label}</span>
            {key && (
              <span class="rail-key" aria-hidden="true">
                {key}
              </span>
            )}
            {target === 'threads' && review > 0 && (
              <span class="badge" aria-label={`${review} notes to review`}>
                {review}
              </span>
            )}
          </button>
        );
      })}
      <button type="button" class="rail-foot" onClick={() => go('stats')} title="Open Stats">
        Woven from <strong>{fmtNum(entries)}</strong> {entries === 1 ? 'entry' : 'entries'}
      </button>
    </nav>
  );
}
