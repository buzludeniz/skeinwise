// Live capture: watches agent histories, chosen note folders and Downloads, and imports what changes within seconds,
// through the same importers as a manual import (so dedupe and versions behave the same).

import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
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
}

const EXPORT_KINDS = new Set(['chatgpt', 'claude', 'gemini']);
const DOWNLOAD_EXT = new Set(['.zip', '.json']);
const TREE_EXT = new Set(['.jsonl', '.md', '.markdown', '.txt']);

/** The places watched by default: Claude Code and Codex history and Downloads, where they exist, plus chosen folders. */
export function defaultTargets(folders: { path: string; owner?: string }[] = [], home = homedir()): Target[] {
  const targets: Target[] = [
    { kind: 'tree', path: join(home, '.claude', 'projects') },
    { kind: 'tree', path: join(home, '.codex', 'sessions') },
    { kind: 'downloads', path: join(home, 'Downloads') },
    ...folders.map((f) => ({ kind: 'tree' as const, path: resolve(f.path), owner: f.owner })),
  ];
  return targets.filter((t) => existsSync(t.path));
}

function emptyStatus(): LiveStatus {
  return { lastSavedAt: null, lastPassAt: null, caught: [], errors: [] };
}

export function readStatus(file: string): LiveStatus {
  if (!existsSync(file)) return emptyStatus();
  return { ...emptyStatus(), ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<LiveStatus>) };
}

function ago(fromIso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The two status lines under Record live, e.g. "saved 2 minutes ago" and "caught up 3 chats from Claude Code". */
export function statusLines(status: LiveStatus, now = new Date()): [string, string] {
  const saved = status.lastSavedAt ? `saved ${ago(status.lastSavedAt, now)}` : 'nothing saved yet';
  const parts = status.caught
    .filter((c) => c.added + c.versioned > 0)
    .map((c) => {
      const n = c.kind === 'notes' ? c.added + c.versioned : c.threads;
      const what = c.kind === 'notes' ? (n === 1 ? 'note' : 'notes') : n === 1 ? 'chat' : 'chats';
      return `${n} ${what} from ${c.label}`;
    });
  const caught = parts.length ? `caught up ${parts.join(', ')}` : 'up to date';
  return [saved, status.errors.length ? `${caught} · ${status.errors.length} file(s) failed` : caught];
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
}

export class LiveCapture {
  private watchers: FSWatcher[] = [];
  private pending = new Map<Target, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  private readonly now: () => Date;

  private readonly store: Store;
  private readonly targets: Target[];
  private readonly options: CaptureOptions;

  constructor(store: Store, targets: Target[], options: CaptureOptions) {
    this.store = store;
    this.targets = targets;
    this.options = options;
    this.debounceMs = options.debounceMs ?? 1500;
    this.now = options.now ?? (() => new Date());
  }

  status(): LiveStatus {
    return readStatus(this.options.statusFile);
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
    for (const t of this.targets) {
      const w = watch(t.path, { recursive: t.kind === 'tree' }, (_event, name) => {
        if (!name) return;
        const full = join(t.path, name.toString());
        const exts = t.kind === 'downloads' ? DOWNLOAD_EXT : TREE_EXT;
        if (!exts.has(extname(full).toLowerCase())) return;
        let set = this.pending.get(t);
        if (!set) this.pending.set(t, (set = new Set()));
        set.add(full);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.debounceMs);
      });
      this.watchers.push(w);
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  /** Imports whatever the watchers gathered so far. */
  flush(): LiveStatus {
    const changes = this.pending;
    this.pending = new Map();
    return this.importChanges(changes);
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
        const count = (r: ImportResult) => {
          c.added += r.added;
          c.versioned += r.versioned;
          return r.added + r.versioned > 0;
        };
        // One thread at a time, so "caught up N chats" counts only the chats that gained or changed entries (a
        // re-downloaded export holds hundreds that didn't).
        for (const thread of batch.threads) if (count(this.store.ingest({ source: batch.source, threads: [thread] }))) c.threads += 1;
        if (batch.entries?.length) count(this.store.ingest({ source: batch.source, threads: [], entries: batch.entries }));
        caught.set(key, c);
      }
    }
    const now = this.now().toISOString();
    const prev = this.status();
    const list = [...caught.values()].filter((c) => c.added + c.versioned > 0);
    const status: LiveStatus = {
      lastSavedAt: list.length ? now : prev.lastSavedAt,
      lastPassAt: now,
      caught: list.length ? list : prev.caught,
      errors,
    };
    writeFileSync(this.options.statusFile, JSON.stringify(status, null, 1));
    if (list.length) this.options.onSaved?.(status);
    return status;
  }
}
