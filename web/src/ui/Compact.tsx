// The compact window's tabs: Brain, Notes, Write, Add and More. Below 700 px wide they replace the rail.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import {
  Brain,
  CalendarRange,
  Ellipsis,
  FlaskConical,
  FolderTree,
  GraduationCap,
  Hash,
  ListChecks,
  NotebookText,
  PenLine,
  Plus,
  Search,
  Settings as SettingsIcon,
  Undo2,
  UserRound,
  Workflow,
} from 'lucide-preact';
import { canUndo, go, openCommand, openEditor, openNav, undo } from '../actions.ts';
import { setState, useApp } from '../store.ts';

function Tab({ icon: Icon, label, on, onClick, badge }: { icon: LucideIcon; label: string; on?: boolean; onClick: () => void; badge?: number }) {
  return (
    <button type="button" class={`tab${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} onClick={onClick}>
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
      {badge ? <span class="badge">{badge}</span> : null}
    </button>
  );
}

const MORE: [LucideIcon, string, () => void][] = [
  [ListChecks, 'Review', () => openNav({ kind: 'review' })],
  [FolderTree, 'Folders', () => openNav({ kind: 'folders' })],
  [Workflow, 'Runs', () => openNav({ kind: 'runs' })],
  [Undo2, 'Undo', () => void undo()],
  [CalendarRange, 'Timeline', () => go('timeline')],
  [FlaskConical, 'Lab', () => go('lab')],
  [UserRound, 'You', () => go('you')],
  [Hash, 'Numbers', () => go('numbers')],
  [GraduationCap, 'Learn', () => go('learn')],
  [Search, 'Search', () => openCommand()],
  [SettingsIcon, 'Settings', () => setState({ settingsOpen: true })],
];

export function CompactTabs() {
  const view = useApp((s) => s.view);
  const panel = useApp((s) => s.panel?.kind);
  const editor = useApp((s) => s.editor !== null);
  const review = useApp((s) => s.organiser.review.filter((r) => r.status === 'open').length);
  const [more, setMore] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!more) return;
    sheet.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMore(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [more]);

  const pick = (fn: () => void) => () => {
    setMore(false);
    fn();
  };

  return (
    <>
      {more && (
        <div class="overlay sheet-overlay" onPointerDown={(e) => e.target === e.currentTarget && setMore(false)}>
          <div class="sheet" role="menu" aria-label="More" ref={sheet}>
            {MORE.map(([Icon, label, fn]) => (
              <button key={label} type="button" role="menuitem" class="sheet-item" onClick={pick(fn)}>
                <Icon size={18} aria-hidden="true" />
                <span>{label === 'Undo' && canUndo() ? `Undo: ${canUndo()}` : label}</span>
                {label === 'Review' && review ? <span class="badge">{review}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
      <nav class="compact-tabs" aria-label="Views">
        <Tab icon={Brain} label="Brain" on={!editor && view === 'brain' && panel !== 'add'} onClick={() => go('brain')} />
        <Tab icon={NotebookText} label="Notes" on={!editor && view === 'navigator' && panel !== 'add'} onClick={() => go('navigator')} />
        <Tab icon={PenLine} label="Write" on={editor} onClick={() => openEditor(null)} />
        <Tab icon={Plus} label="Add" on={panel === 'add'} onClick={() => go('add')} />
        <Tab icon={Ellipsis} label="More" on={more} badge={review || undefined} onClick={() => setMore(!more)} />
      </nav>
    </>
  );
}
