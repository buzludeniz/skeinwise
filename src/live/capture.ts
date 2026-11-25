// Live capture: watches agent histories, chosen note folders and Downloads, and imports what changes within seconds,
// through the same importers as a manual import (so dedupe and versions behave the same).

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeSync,
  type FSWatcher,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import { readFilesUnder, readImports } from '../importers/detect.ts';
import type { ImportBatch, ImportResult, Store } from '../store/store.ts';

/**
 * A place to watch. `tree`: a folder imported as a whole (agent histories, a notes folder or vault); a changed file is
 * imported under the folder's source. `downloads`: only chat export files (ChatGPT, Claude, Gemini) are taken.
 */
export interface Target {
  kind: 'tree' | 'downloads';
  path: string;
  owner?: string;
}

export interface Caught {
  label: string;
  kind: string;
  threads: number;
  added: number;
  versioned: number;
}

export interface LiveStatus {
  /** When something new or changed was last saved. */
  lastSavedAt: string | null;
  /** When the last pass finished, even if it found nothing. */
  lastPassAt: string | null;
  /** What the last pass that saved anything brought in, per source. */
  caught: Caught[];
  /** Files that failed to import on the last pass, with the reason. */
  errors: { path: string; error: string }[];
  /** What the last background organising pass did, when one has run. */
  organised?: Organised;
}

/** What the last background organising pass did (see `organise.ts`). */
export interface Organised {
  at: string;
  /** The most entries any one step organised. */
  entries: number;
  runs: number[];
  /** Why the pass stopped early: the model server didn't answer, a run failed, the budget is spent. */
  error?: string;
  /** Why the pass didn't run: the computer is busy, the battery is low, or the engine isn't allowed in the background. */
  waiting?: string;
  /** Tasks that have never run over the whole record, which a background pass leaves alone. */
  notStarted?: string[];
}

const EXPORT_KINDS = new Set(['chatgpt', 'claude', 'gemini']);
const DOWNLOAD_EXT = new Set(['.zip', '.json']);
const TREE_EXT = new Set(['.jsonl', '.md', '.markdown', '.txt']);

/**
 * The places watched: Claude Code and Codex history and the chosen folders, where they exist. Downloads only when
 * asked for (`downloads`): anyone who can land a file there could otherwise rewrite the record (H1).
 */
export function defaultTargets(
  folders: { path: string; owner?: string }[] = [],
  home = homedir(),
  options: { downloads?: boolean } = {},
): Target[] {
  const targets: Target[] = [
    { kind: 'tree', path: join(home, '.claude', 'projects') },
    { kind: 'tree', path: join(home, '.codex', 'sessions') },
    ...(options.downloads ? [{ kind: 'downloads' as const, path: join(home, 'Downloads') }] : []),
    ...folders.map((f) => ({ kind: 'tree' as const, path: resolve(f.path), owner: f.owner })),
  ];
  return targets.filter((t) => existsSync(t.path));
}

function emptyStatus(): LiveStatus {
  return { lastSavedAt: null, lastPassAt: null, caught: [], errors: [] };
}

/** Reads live.json; throws when it holds anything but a status object. */
export function readStatus(file: string): LiveStatus {
  if (!existsSync(file)) return emptyStatus();
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('it holds no status');
  return { ...emptyStatus(), ...(parsed as Partial<LiveStatus>) };
}

/**
 * Reads live.json for live itself, which must keep going (L5). A file that can't be read is moved aside to
 * `live.json.bad-<time>` with one warning, and live starts from an empty status: its next catch-up reads every watched
 * file again, which saves nothing twice.
 */
export function loadStatus(file: string, warn: (line: string) => void, now = new Date()): LiveStatus {
  try {
    return readStatus(file);
  } catch (error) {
    const aside = `${file}.bad-${now.toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, aside);
    warn(`${basename(file)} couldn't be read (${(error as Error).message}), so it was moved to ${basename(aside)} and live starts afresh.`);
    return emptyStatus();
  }
}

/** Writes live.json whole or not at all: a temporary file, flushed to disk, renamed over it (L5). */
export function writeStatus(file: string, status: LiveStatus): void {
  const temp = `${file}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, JSON.stringify(status, null, 1));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/** SQLite's "database is busy" or "locked": another process holds the record's write lock (M8). */
export function isBusy(error: unknown): boolean {
  const e = error as { code?: unknown; errcode?: unknown } | null;
  if (e?.code !== 'ERR_SQLITE_ERROR' || typeof e.errcode !== 'number') return false;
  const primary = e.errcode & 0xff;
  return primary === 5 || primary === 6;
}

/** The first sentence of a message, for a status line. */
function firstSentence(text: string): string {
  const m = /^.*?[.:](?=\s|$)/.exec(text);
  const s = (m ? m[0] : text).replace(/[.:]$/, '');
  return s.length > 90 ? `${s.slice(0, 87)}...` : s;
}

/** The organising part of the second status line, or null when there is nothing to say. */
export function organisedText(o: Organised | undefined): string | null {
  if (!o) return null;
  if (o.waiting) return `organising waits: ${o.waiting}`;
  if (o.error) return `organising stopped: ${firstSentence(o.error)}`;
  if (o.entries > 0) return `organised ${o.entries} new ${o.entries === 1 ? 'entry' : 'entries'}`;
  if (o.notStarted?.length && !o.runs.length) return 'not organised yet: run "skeinwise run all" once to start';
  return null;
}

function ago(fromIso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The two status lines under Record live, e.g. "saved 2 minutes ago" and "caught up 3 chats from Claude Code ·
 * organised 41 new entries".
 */
export function statusLines(status: LiveStatus, now = new Date()): [string, string] {
  const saved = status.lastSavedAt ? `saved ${ago(status.lastSavedAt, now)}` : 'nothing saved yet';
  const parts = status.caught
    .filter((c) => c.added + c.versioned > 0)
    .map((c) => {
      const n = c.kind === 'notes' ? c.added + c.versioned : c.threads;
      const what = c.kind === 'notes' ? (n === 1 ? 'note' : 'notes') : n === 1 ? 'chat' : 'chats';
      return `${n} ${what} from ${c.label}`;
    });
  const second = [parts.length ? `caught up ${parts.join(', ')}` : 'up to date'];
  if (status.errors.length) second.push(`${status.errors.length} file(s) failed`);
  const organised = organisedText(status.organised);
  if (organised) second.push(organised);
  return [saved, second.join(' · ')];
}

function listChanged(dir: string, sinceMs: number, exts: Set<string>, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listChanged(full, sinceMs, exts, out);
    else if (entry.isFile() && exts.has(extname(entry.name).toLowerCase()) && statSync(full).mtimeMs > sinceMs) out.push(full);
  }
}

export interface CaptureOptions {
  /** Where the status file is written (`<home>/live.json`). */
  statusFile: string;
  /** How long to wait after the last change before importing. */
  debounceMs?: number;
  now?: () => Date;
  /** Called after every pass that saved something: the hook background organising hangs on. */
  onSaved?: (status: LiveStatus) => void;
  /** How long to wait before trying again when another process holds the record (default 5 s). */
  busyRetryMs?: number;
  /** Something live carries on past: an unreadable live.json, a pass that failed. */
  onWarning?: (line: string) => void;
}

export class LiveCapture {
  private watchers: FSWatcher[] = [];
  private pending = new Map<Target, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;
  private readonly debounceMs: number;
  private readonly busyRetryMs: number;
  private readonly now: () => Date;
  private readonly warn: (line: string) => void;

  private readonly store: Store;
  private readonly targets: Target[];
  private readonly options: CaptureOptions;

  constructor(store: Store, targets: Target[], options: CaptureOptions) {
    this.store = store;
    this.targets = targets;
    this.options = options;
    this.debounceMs = options.debounceMs ?? 1500;
    this.busyRetryMs = options.busyRetryMs ?? 5000;
    this.now = options.now ?? (() => new Date());
    this.warn = options.onWarning ?? (() => {});
  }

  status(): LiveStatus {
    return loadStatus(this.options.statusFile, this.warn, this.now());
  }

  /** Imports every file under the targets changed after `since` (default: the last pass). */
  scan(since?: Date): LiveStatus {
    const last = this.status().lastPassAt;
    const sinceMs = since ? since.getTime() : last ? Date.parse(last) : 0;
    const changes = new Map<Target, Set<string>>();
    for (const t of this.targets) {
      const files: string[] = [];
      listChanged(t.path, sinceMs, t.kind === 'downloads' ? DOWNLOAD_EXT : TREE_EXT, files);
      if (files.length) changes.set(t, new Set(files));
    }
    return this.importChanges(changes);
  }

  /** Starts watching. Changes are gathered and imported together once things go quiet for `debounceMs`. */
  start(): void {
    this.watching = true;
    for (const t of this.targets) {
      const w = watch(t.path, { recursive: t.kind === 'tree' }, (_event, name) => {
        if (!name) return;
        const full = join(t.path, name.toString());
        const exts = t.kind === 'downloads' ? DOWNLOAD_EXT : TREE_EXT;
        if (!exts.has(extname(full).toLowerCase())) return;
        this.queue(t, [full]);
        this.schedule(this.debounceMs);
      });
      this.watchers.push(w);
    }
    // A catch-up the busy record cut short left its files queued.
    if (this.pending.size) this.schedule(this.busyRetryMs);
  }

  stop(): void {
    this.watching = false;
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  /**
   * Imports whatever the watchers gathered so far. Never throws, because the watch timer calls it: a pass that fails is
   * reported through `onWarning` and in the status, and live keeps watching (M8).
   */
  flush(): LiveStatus {
    const changes = this.pending;
    this.pending = new Map();
    try {
      return this.importChanges(changes);
    } catch (error) {
      const message = (error as Error).message;
      this.warn(`a capture pass failed: ${message}. Live keeps watching.`);
      return { ...emptyStatus(), errors: [{ path: 'live', error: message }] };
    }
  }

  private queue(target: Target, files: Iterable<string>): void {
    let set = this.pending.get(target);
    if (!set) this.pending.set(target, (set = new Set()));
    for (const f of files) set.add(f);
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), ms);
  }

  private batchesFor(target: Target, files: Set<string>, errors: LiveStatus['errors']): ImportBatch[] {
    if (target.kind === 'tree') {
      const rel = [...files].map((f) => relative(target.path, f));
      try {
        return readFilesUnder(target.path, rel, { owner: target.owner });
      } catch (error) {
        errors.push({ path: target.path, error: (error as Error).message });
        return [];
      }
    }
    const batches: ImportBatch[] = [];
    for (const file of files) {
      if (!existsSync(file)) continue;
      try {
        // Downloads holds everything; only chat exports are taken, never loose notes inside some other zip.
        batches.push(...readImports(file).filter((b) => EXPORT_KINDS.has(b.source.kind)));
      } catch (error) {
        const message = (error as Error).message;
        if (!message.startsWith('Nothing to import')) errors.push({ path: file, error: message });
      }
    }
    return batches;
  }

  private importChanges(changes: Map<Target, Set<string>>): LiveStatus {
    const errors: LiveStatus['errors'] = [];
    const caught = new Map<string, Caught>();
    let busy = false;
    try {
      const excluded = new Set(
        this.store
          .sources()
          .filter((s) => s.status === 'out')
          .map((s) => `${s.kind}\u0000${s.location}`),
      );
      for (const [target, files] of changes) {
        for (const batch of this.batchesFor(target, files, errors)) {
          if (excluded.has(`${batch.source.kind}\u0000${batch.source.location ?? ''}`)) continue;
          const key = `${batch.source.kind}\u0000${batch.source.label}`;
          const c = caught.get(key) ?? { label: batch.source.label, kind: batch.source.kind, threads: 0, added: 0, versioned: 0 };
          caught.set(key, c);
          const count = (r: ImportResult) => {
            c.added += r.added;
            c.versioned += r.versioned;
            return r.added + r.versioned > 0;
          };
          // One thread at a time, so "caught up N chats" counts only the chats that gained or changed entries (a
          // re-downloaded export holds hundreds that didn't).
          for (const thread of batch.threads) if (count(this.store.ingest({ source: batch.source, threads: [thread] }))) c.threads += 1;
          if (batch.entries?.length) count(this.store.ingest({ source: batch.source, threads: [], entries: batch.entries }));
        }
      }
    } catch (error) {
      // Another process holds the record (an import, an organiser run, the web app): stop here and keep every file of
      // this pass for the next one. What was saved stays saved, and saving it again changes nothing (M8).
      if (!isBusy(error)) throw error;
      busy = true;
      for (const [target, files] of changes) this.queue(target, files);
    }
    const now = this.now().toISOString();
    const prev = this.status();
    const list = [...caught.values()].filter((c) => c.added + c.versioned > 0);
    if (busy) {
      const next = this.watching ? `trying again in ${Math.max(1, Math.round(this.busyRetryMs / 1000))} s` : 'run live again once it is free';
      errors.push({ path: 'the record', error: `another skeinwise command is writing to it; ${next}` });
    }
    const status: LiveStatus = {
      ...prev,
      lastSavedAt: list.length ? now : prev.lastSavedAt,
      // A pass cut short isn't a finished pass: the next catch-up looks at its files again.
      lastPassAt: busy ? prev.lastPassAt : now,
      caught: list.length ? list : prev.caught,
      errors,
    };
    writeStatus(this.options.statusFile, status);
    if (busy && this.watching) this.schedule(this.busyRetryMs);
    if (list.length) this.options.onSaved?.(status);
    return status;
  }
}
