// The window: rail, the current view, the right-hand panel, the editor, and everything that floats over them.

import { useEffect, useRef } from 'preact/hooks';
import { Lock as LockIcon, Undo2, X } from 'lucide-preact';
import { closePanel, dismissToast, go, message, openCommand, toast, undo, unlock } from './actions.ts';
import { pickFiles } from './files.ts';
import { AssistantView, ReminderBar } from './pa/index.ts';
import { setState, getState, useApp } from './store.ts';
import { mix, theme, themeVars } from './themes.ts';
import { AppMenu } from './ui/AppMenu.tsx';
import { CommandBar } from './ui/CommandBar.tsx';
import { Button, Logo } from './ui/common.tsx';
import { CompactTabs } from './ui/Compact.tsx';
import { RAIL, Rail } from './ui/Rail.tsx';
import { Settings } from './ui/Settings.tsx';
import { AddPanel } from './views/Add.tsx';
import { BrainView } from './views/BrainView.tsx';
import { Editor } from './views/Editor.tsx';
import { FirstRun } from './views/FirstRun.tsx';
import { GuidePanel } from './views/Guide.tsx';
import { HubPanel } from './views/Hub.tsx';
import { ProfileView } from './views/Profile.tsx';
import { ReaderPanel } from './views/Reader.tsx';
import { StatsView } from './views/Stats.tsx';
import { Threads } from './views/Threads.tsx';
import { TimelineView } from './views/Timeline.tsx';
import { Workbench } from './views/Workbench.tsx';

function useThemeVars() {
  const key = useApp((s) => s.config?.appearance.theme ?? 'dusk');
  useEffect(() => {
    const t = theme(key);
    const root = document.documentElement;
    for (const [k, v] of Object.entries(themeVars(t))) root.style.setProperty(k, v);
    root.style.setProperty('--ground-soft', mix(t.ground, t.panel, 0.5));
    root.style.colorScheme = t.light ? 'light' : 'dark';
    root.dataset.theme = t.light ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.ground);
  }, [key]);
}

function typing(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      if (s.locked || s.fatal || !s.ready) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (s.command.open && !e.altKey) setState({ command: { open: false, text: '' } });
        else openCommand();
        return;
      }
      if (mod && e.key === ',') {
        e.preventDefault();
        setState({ settingsOpen: true, menuOpen: false });
        return;
      }
      if (s.firstRun || s.command.open || s.settingsOpen) return;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing(e.target)) {
        e.preventDefault();
        void undo();
        return;
      }
      if (!mod && !e.altKey && /^[1-9]$/.test(e.key) && !typing(e.target) && !s.editor) {
        e.preventDefault();
        go(RAIL[Number(e.key) - 1]!.target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function MainView() {
  const view = useApp((s) => s.view);
  switch (view) {
    case 'threads':
      return <Threads />;
    case 'stats':
      return <StatsView />;
    case 'timeline':
      return <TimelineView />;
    case 'profile':
      return <ProfileView />;
    case 'workbench':
      return <Workbench />;
    case 'assistant':
      return <AssistantView />;
    default:
      return <BrainView />;
  }
}

function PanelHost() {
  const panel = useApp((s) => s.panel);
  const view = useApp((s) => s.view);
  if (!panel) return null;
  switch (panel.kind) {
    case 'guide':
      return <GuidePanel />;
    case 'add':
      return <AddPanel guide={panel.guide} />;
    case 'hub':
      return <HubPanel id={panel.id} />;
    default:
      // The Threads view shows the reader in its own third column.
      return view === 'threads' ? null : <ReaderPanel panel={panel} onClose={closePanel} />;
  }
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast${t.tone ? ` toast-${t.tone}` : ''}`}>
          <span>{t.text}</span>
          {t.undo && (
            <Button
              icon={Undo2}
              kind="quiet"
              small
              onClick={() => {
                dismissToast(t.id);
                void Promise.resolve(t.undo!()).catch((error: unknown) => toast(`Couldn't undo: ${message(error)}`, { tone: 'error' }));
              }}
            >
              Undo
            </Button>
          )}
          {t.action && (
            <Button
              kind="quiet"
              small
              onClick={() => {
                dismissToast(t.id);
                void Promise.resolve(t.action!.run()).catch((error: unknown) => toast(message(error), { tone: 'error' }));
              }}
            >
              {t.action.label}
            </Button>
          )}
          <Button icon={X} kind="quiet" small aria-label="Dismiss" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}

function LockScreen() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div class="cover lock" role="dialog" aria-modal="true" aria-label="Skeinwise is locked">
      <div class="lock-card">
        <Logo size={44} />
        <h1>Skeinwise is locked</h1>
        <p>Your record is closed, and agents can't read it until you unlock.</p>
        <button
          ref={ref}
          type="button"
          class="btn btn-primary"
          onClick={() => void unlock().catch((error: unknown) => toast(`Couldn't unlock: ${message(error)}`, { tone: 'error' }))}
        >
          <LockIcon size={16} aria-hidden="true" />
          <span>Unlock</span>
        </button>
      </div>
    </div>
  );
}

function Fatal({ text }: { text: string }) {
  return (
    <div class="cover fatal" role="alert">
      <div class="lock-card">
        <Logo size={44} />
        <h1>Can't open the record</h1>
        <p>{text}</p>
      </div>
    </div>
  );
}

export function App() {
  useThemeVars();
  useShortcuts();
  const ready = useApp((s) => s.ready);
  const fatal = useApp((s) => s.fatal);
  const locked = useApp((s) => s.locked);
  const compact = useApp((s) => s.compact);
  const editor = useApp((s) => s.editor);
  const firstRun = useApp((s) => s.firstRun);
  const panelOpen = useApp((s) => s.panel !== null);
  const clip = useApp((s) => s.clip);

  if (fatal) return <Fatal text={fatal} />;
  if (!ready)
    return (
      <div class="cover loading" aria-busy="true">
        <Logo size={40} title="Skeinwise" />
        <p>Opening your record…</p>
      </div>
    );
  if (locked) return <LockScreen />;

  return (
    <div class={`app${compact ? ' compact' : ''}${panelOpen ? ' panel-open' : ''}${clip ? ' clip' : ''}`}>
      {!compact && <Rail />}
      <main class="main" id="main">
        <MainView />
        {editor && <Editor id={editor.id} title={editor.title} />}
      </main>
      <PanelHost />
      {compact && <CompactTabs />}
      <AppMenu onAddFiles={() => pickFiles()} />
      <CommandBar />
      <Settings />
      {firstRun && <FirstRun />}
      <ReminderBar />
      <Toasts />
    </div>
  );
}
