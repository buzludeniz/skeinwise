// Everything that changes the app: loading the record, moving between views, saving settings, lighting points,
// toasts and undo.

import { api, ApiError, onLocked, onUnauthorised } from './api.ts';
import type { ColourGrouping } from './groups.ts';
import type { Layout } from './layout.ts';
import { getState, type NavSection, type Organiser, type Panel, setState, type Target, type Toast } from './store.ts';
import { engineLabel } from '../../src/format.ts';
import { modelName } from './format.ts';
import { plural } from './format.ts';
import type { BrainData, Config, OrganiseJob, Run, Status } from './types.ts';

type Patch<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Patch<T[K]>) : T[K] };

function merge<T>(base: T, patch: Patch<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? merge(cur, v as Patch<typeof cur>) : v;
  }
  return out as T;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Loading.

export async function boot(): Promise<void> {
  onLocked(() => setState({ locked: true }));
  onUnauthorised(() =>
    setState({ fatal: 'This page needs the address Skeinwise printed when it started. Run skeinwise serve and open that address.' }),
  );
  try {
    const [status, config] = await Promise.all([api.get<Status>('status'), api.get<Config>('settings')]);
    setState({
      status,
      config,
      locked: status.locked,
      grouping: config.brain.grouping,
      layout: config.brain.layout,
      firstRun: !config.firstRunDone,
    });
    if (!status.locked) await loadRecord();
    setState({ ready: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 423) {
      setState({ ready: true, locked: true });
      return;
    }
    if (!getState().fatal) setState({ fatal: `Skeinwise isn't answering. Is skeinwise serve still running? (${message(error)})` });
  }
  setInterval(() => void refreshStatus(), 30_000);
}

export async function loadRecord(): Promise<void> {
  const [brain, status, organiser] = await Promise.all([
    api.get<BrainData>('brain'),
    api.get<Status>('status'),
    api.get<Organiser>('organiser'),
  ]);
  setState((s) => ({ brain, status, organiser, revision: s.revision + 1 }));
}

export async function refreshStatus(): Promise<void> {
  if (getState().fatal) return;
  try {
    const status = await api.get<Status>('status');
    setState({ status, locked: status.locked });
  } catch {
    // The next round tries again.
  }
}

// Moving around.

export function go(target: Target): void {
  const s = getState();
  if (target === 'guide') {
    setState({ panel: s.panel?.kind === 'guide' ? null : { kind: 'guide' }, view: 'brain', editor: null });
    return;
  }
  if (target === 'add') {
    setState({ panel: s.panel?.kind === 'add' ? null : { kind: 'add' }, editor: null });
    return;
  }
  const keep = s.panel && (s.panel.kind === 'entry' || s.panel.kind === 'thread') ? s.panel : null;
  setState({ view: target, panel: keep, editor: null, menuOpen: false });
}

export function openPanel(panel: Panel): void {
  setState({ panel, menuOpen: false, command: { ...getState().command, open: false } });
}

export function closePanel(): void {
  setState({ panel: null });
}

export function openEntry(id: number): void {
  openPanel({ kind: 'entry', id });
}

export function openThread(id: number, focus?: number): void {
  openPanel({ kind: 'thread', id, focus });
}

export function openNav(nav: NavSection): void {
  setState({ view: 'threads', nav, editor: null });
}

export function openEditor(id: number | null, title = ''): void {
  setState({ editor: { id, title }, menuOpen: false, command: { open: false, text: '' } });
}

export function closeEditor(): void {
  setState({ editor: null });
}

export function openCommand(text = ''): void {
  setState({ command: { open: true, text }, menuOpen: false });
}

export function closeCommand(): void {
  setState({ command: { open: false, text: '' } });
}

// Settings.

export async function saveConfig(patch: Patch<Config>, quiet = false): Promise<boolean> {
  const before = getState().config;
  if (!before) return false;
  setState({ config: merge(before, patch) });
  try {
    const saved = await api.put<Config>('settings', patch);
    setState({ config: saved });
    return true;
  } catch (error) {
    setState({ config: before });
    if (!quiet) toast(`Not saved: ${message(error)}`, { tone: 'error' });
    return false;
  }
}

export function setGrouping(grouping: ColourGrouping): void {
  setState({ grouping, isolate: null });
  void saveConfig({ brain: { grouping } }, true);
}

export function setLayout(layout: Layout): void {
  setState({ layout, isolate: null, view: 'brain' });
  void saveConfig({ brain: { layout } }, true);
}

export function setTheme(theme: Config['appearance']['theme']): void {
  const old = getState().config?.appearance.theme;
  void saveConfig({ appearance: { theme } });
  if (old && old !== theme) pushUndo(`Theme back to ${old}`, () => void saveConfig({ appearance: { theme: old } }));
}

// Lighting points in the brain.

export function light(ids: Iterable<number>, label: string): void {
  setState({ lit: { ids: new Set(ids), label } });
}

export function clearLight(): void {
  setState({ lit: null });
}

// Toasts and undo.

let toastId = 0;

export function toast(text: string, options: { undo?: Toast['undo']; action?: Toast['action']; tone?: Toast['tone'] } = {}): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, ...options }] }));
  setTimeout(() => dismissToast(id), options.undo || options.action ? 9000 : 5000);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

interface UndoStep {
  label: string;
  run: () => void | Promise<void>;
}

const undoStack: UndoStep[] = [];

/** Remembers how to take back a change, for ⌘Z and the command bar's undo. */
export function pushUndo(label: string, run: UndoStep['run']): void {
  undoStack.push({ label, run });
  if (undoStack.length > 30) undoStack.shift();
}

export function canUndo(): string | null {
  return undoStack.at(-1)?.label ?? null;
}

export async function undo(): Promise<void> {
  const step = undoStack.pop();
  if (!step) {
    toast('Nothing to undo');
    return;
  }
  try {
    await step.run();
    toast(`Undone: ${step.label.charAt(0).toLowerCase()}${step.label.slice(1)}`);
  } catch (error) {
    toast(`Couldn't undo: ${message(error)}`, { tone: 'error' });
  }
}

/** A change with an Undo button on its toast, also kept for ⌘Z. */
export function changed(text: string, undoLabel: string, run: UndoStep['run']): void {
  pushUndo(undoLabel, run);
  toast(text, {
    undo: async () => {
      const i = undoStack.findIndex((u) => u.run === run);
      if (i >= 0) undoStack.splice(i, 1);
      await run();
    },
  });
}

// The organiser.

export interface OrganiseRequest {
  task?: Run['task'] | 'all';
  engine?: string;
  scope?: string;
  yes?: boolean;
}

/** "No-AI", "local model qwen3-4b", "by you". */
export function engineName(engine: string, model: string | null): string {
  return engineLabel(engine, model && modelName(model));
}

/** Takes back runs newest first, so no run is undone before the ones built on it. */
async function undoRuns(runs: Run[]): Promise<void> {
  for (const r of [...runs].reverse()) await api.post(`runs/${r.id}/undo`);
  await loadRecord();
}

/** "Undo run": removes all a run made. */
export async function undoRun(run: Run): Promise<void> {
  await api.post(`runs/${run.id}/undo`);
  await loadRecord();
  toast(`Run ${run.id} undone.`);
}

/**
 * Starts an organising run and follows it to the end: a small run answers at once, a model run reports its progress
 * on the page until it finishes. Then the record reloads, and the toast offers Undo for every run it made.
 */
export async function organise(body: OrganiseRequest = {}): Promise<void> {
  if (getState().job && !getState().job!.finished) {
    toast('A run is already going. Wait for it to finish.');
    return;
  }
  const { job } = await api.post<{ job: OrganiseJob }>('organise', body);
  setState({ job });
  await follow(job, body);
}

async function follow(start: OrganiseJob, body: OrganiseRequest): Promise<void> {
  let job = start;
  while (!job.finished) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      job = (await api.get<{ job: OrganiseJob | null }>('organise')).job ?? { ...job, finished: true, error: 'The run was lost.' };
      setState({ job });
    } catch {
      // A missed poll is tried again.
    }
  }
  if (job.runs.length) await loadRecord();
  if (job.needsYes) {
    toast(job.error ?? 'This run needs your yes.', { action: { label: 'Go ahead', run: () => organise({ ...body, yes: true }) } });
  } else if (job.error) {
    toast(job.runs.length ? `${plural(job.runs.length, 'run')} done, then it stopped: ${job.error}` : `Couldn't organise: ${job.error}`, { tone: 'error' });
  } else if (job.runs.length) {
    const runs = job.runs;
    changed(`Organised: ${plural(runs.length, 'run')}, ${engineName(job.engine, runs.at(-1)!.model)}.`, `Undo ${plural(runs.length, 'organising run')}`, () => undoRuns(runs));
  }
  setState({ job: null });
}

// Lock and quit.

export async function lock(): Promise<void> {
  await api.post('lock');
  setState({ locked: true, menuOpen: false, panel: null, editor: null, command: { open: false, text: '' }, settingsOpen: false });
}

export async function unlock(): Promise<void> {
  await api.post('unlock');
  setState({ locked: false });
  await loadRecord();
}

export async function quit(): Promise<void> {
  try {
    await api.post('quit');
  } finally {
    setState({ fatal: 'Skeinwise has stopped. Run skeinwise serve to start it again.', menuOpen: false });
  }
}
