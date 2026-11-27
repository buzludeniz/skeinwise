// The app's state in one small store. Components read slices of it with useApp(); actions.ts changes it.

import { useEffect, useReducer, useRef } from 'preact/hooks';
import type { ColourGrouping } from './groups.ts';
import type { Layout } from './layout.ts';
import type { BrainData, Config, OrganiseJob, OrganiserState, Status } from './types.ts';

export type View = 'brain' | 'threads' | 'stats' | 'timeline' | 'profile' | 'workbench' | 'views' | 'assistant';
/** What the rail opens, and keys 1 to 9 for its first nine entries: a view, or a panel over the current one. */
export type Target = View | 'guide' | 'add';
/** The Threads view's first column. */
export type NavSection = { kind: 'inbox' | 'review' | 'runs' | 'hubs' | 'folders' } | { kind: 'folder' | 'source'; key: string };

/** What the right-hand panel shows. */
export type Panel =
  | { kind: 'entry'; id: number }
  | { kind: 'thread'; id: number; focus?: number }
  | { kind: 'guide' }
  | { kind: 'add'; guide?: 'chatgpt' | 'claude' | 'gemini' }
  | { kind: 'hub'; id: number }
  | null;

export interface Toast {
  id: number;
  text: string;
  undo?: () => void | Promise<void>;
  /** A button other than Undo, such as "Go ahead" for a run that needs a yes. */
  action?: { label: string; run: () => void | Promise<void> };
  tone?: 'ok' | 'error';
}

export interface Lit {
  ids: Set<number>;
  label: string;
}

export type Organiser = OrganiserState;

export interface AppState {
  ready: boolean;
  /** Set when the page can't reach the server, or has no token. */
  fatal: string | null;
  status: Status | null;
  config: Config | null;
  brain: BrainData | null;
  organiser: Organiser;
  /** The organising run started from this page, while it runs and just after. */
  job: OrganiseJob | null;
  view: View;
  panel: Panel;
  nav: NavSection;
  /** The Workbench's tab. */
  workbenchTab: 'table' | 'activity';
  /** The notes editor, over everything but the rail. */
  editor: { id: number | null; title: string } | null;
  command: { open: boolean; text: string };
  menuOpen: boolean;
  settingsOpen: boolean;
  firstRun: boolean;
  locked: boolean;
  toasts: Toast[];
  /** Points lit up by search, a question, a timeline span or a legend group. */
  lit: Lit | null;
  /** The legend group isolated by a click, by label. */
  isolate: string | null;
  grouping: ColourGrouping;
  layout: Layout;
  clip: boolean;
  compact: boolean;
  /** Bumped when the record changes, so views refetch. */
  revision: number;
}

export const initialState: AppState = {
  ready: false,
  fatal: null,
  status: null,
  config: null,
  brain: null,
  organiser: { ready: false, hubs: [], folders: [], runs: [], review: [], schemas: [] },
  job: null,
  view: 'brain',
  panel: null,
  nav: { kind: 'inbox' },
  workbenchTab: 'table',
  editor: null,
  command: { open: false, text: '' },
  menuOpen: false,
  settingsOpen: false,
  firstRun: false,
  locked: false,
  toasts: [],
  lit: null,
  isolate: null,
  grouping: 'source',
  layout: 'atlas',
  clip: false,
  compact: false,
  revision: 0,
};

let state: AppState = initialState;
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reads a slice of the state; the component redraws only when that slice changes (by ===). */
export function useApp<T>(select: (s: AppState) => T): T {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const selected = select(state);
  const last = useRef(selected);
  const pick = useRef(select);
  last.current = selected;
  pick.current = select;
  useEffect(() => {
    const check = () => {
      if (pick.current(state) !== last.current) redraw(0);
    };
    const stop = subscribe(check);
    // The effect runs after paint, so a change made between this render and the subscription (boot's error, when a
    // request fails at once) would otherwise wait for the next one, or for ever.
    check();
    return stop;
  }, []);
  return selected;
}
