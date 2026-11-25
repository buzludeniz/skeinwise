// Live capture: watches agent histories, chosen note folders and Downloads, and imports what changes within seconds,
// through the same importers as a manual import (so dedupe and versions behave the same).

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, watch, writeSync, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import { openSafe, readRange, readSafe, UnsafeFileError } from '../fsafe.ts';
import { parseClaudeCodeSession } from '../importers/chats.ts';
import { readFilesUnder, readImports, sniffSession } from '../importers/detect.ts';
import { FileReport } from '../importers/util.ts';
import type { ImportBatch, ImportResult, Store } from '../store/store.ts';
import { type FileExtra, type FileRow, FileTable } from './files.ts';
import { type ReadAt, readTail, stateAfterWholeRead } from './session.ts';

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

/** Whether a path under a watched folder is one the importers read: no part hidden or `node_modules` (as `readFilesUnder`). */
function watched(root: string, file: string, exts: Set<string>): boolean {
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || rel.split(/[\\/]/).some((part) => part.startsWith('.') || part === 'node_modules')) return false;
  return exts.has(extname(file).toLowerCase());
}

function listFiles(root: string, dir: string, exts: Set<string>, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) listFiles(root, full, exts, out);
    else if (entry.isFile() && watched(root, full, exts)) out.push(full);
  }
}

const extsOf = (t: Target) => (t.kind === 'downloads' ? DOWNLOAD_EXT : TREE_EXT);

/**
 * Whether a file needs reading: never read, changed since it was last looked at, or failed and due for another try. A
 * file that failed is tried again on a schedule (1 min, 5 min, 30 min, then hourly), or at once when it changes.
 */
function due(row: FileRow | undefined, st: { size: number; mtimeMs: number }, nowMs: number): boolean {
  if (!row || row.size !== st.size || row.mtimeMs !== st.mtimeMs) return true;
  return row.lastError !== null && (row.nextTryAt === null || Date.parse(row.nextTryAt) <= nowMs);
}

/** What reading one file gave: the batches to save and what to keep for the next read, or why it was refused. */
interface FileRead {
  batches: ImportBatch[];
  offset: number;
  extra: FileExtra;
  sha256: string | null;
  /** The safe reader refused the file (a link, not a regular file, outside the folder, too big): skipped, not failed. */
  refused?: string;
}

const NOTHING = { offset: 0, extra: {}, sha256: null };

export class LiveCapture {
  private watchers: FSWatcher[] = [];
  private pending = new Map<Target, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;
  private readonly files: FileTable;
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
    this.files = new FileTable(store.db);
    this.debounceMs = options.debounceMs ?? 1500;
    this.busyRetryMs = options.busyRetryMs ?? 5000;
    this.now = options.now ?? (() => new Date());
    this.warn = options.onWarning ?? (() => {});
  }

  status(): LiveStatus {
    return loadStatus(this.options.statusFile, this.warn, this.now());
  }

  /**
   * Reads every file under the targets that needs it (see {@link due}), and forgets files that are gone or no longer
   * watched. With `since`, every file changed after it is read again too.
   */
  scan(since?: Date): LiveStatus {
    const forget = (paths: string[]) => {
      try {
        this.files.removeTargetsExcept(this.targets.map((t) => t.path));
        for (const path of paths) this.files.remove(path);
      } catch (error) {
        if (!isBusy(error)) throw error; // the next catch-up forgets them
      }
    };
    const rows = new Map(this.files.under(this.targets.map((t) => t.path)).map((r) => [r.path, r]));
    const nowMs = this.now().getTime();
    const changes = new Map<Target, Set<string>>();
    const seen = new Set<string>();
    for (const t of this.targets) {
      const files: string[] = [];
      listFiles(t.path, t.path, extsOf(t), files);
      const set = new Set<string>();
      for (const file of files.sort()) {
        seen.add(file);
        let st: { size: number; mtimeMs: number };
        try {
          st = statSync(file);
        } catch {
          continue; // gone since the listing
        }
        if (due(rows.get(file), st, nowMs) || (since && st.mtimeMs > since.getTime())) set.add(file);
      }
      if (set.size) changes.set(t, set);
    }
    forget([...rows.keys()].filter((path) => !seen.has(path)));
    return this.importChanges(changes, since !== undefined);
  }

  /** Starts watching. Changes are gathered and imported together once things go quiet for `debounceMs`. */
  start(): void {
    this.watching = true;
    for (const t of this.targets) {
      const w = watch(t.path, { recursive: t.kind === 'tree' }, (_event, name) => {
        if (!name) return;
        const full = join(t.path, name.toString());
        if (!watched(t.path, full, extsOf(t))) return;
        this.queue(t, [full]);
        this.schedule(this.debounceMs);
      });
      this.watchers.push(w);
    }
    // A catch-up the busy record cut short left its files queued.
    if (this.pending.size) this.schedule(this.busyRetryMs);
    this.scheduleRetries();
  }

  stop(): void {
    this.watching = false;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
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
      return this.importChanges(changes, false);
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

  /** While watching, wakes for the next failed file due another try. */
  private scheduleRetries(): void {
    clearTimeout(this.retryTimer);
    if (!this.watching) return;
    const failed = this.files.under(this.targets.map((t) => t.path)).filter((r) => r.lastError !== null && r.nextTryAt !== null);
    if (!failed.length) return;
    const next = Math.min(...failed.map((r) => Date.parse(r.nextTryAt!)));
    this.retryTimer = setTimeout(
      () => {
        const nowMs = this.now().getTime();
        for (const row of this.files.under(this.targets.map((t) => t.path))) {
          const target = this.targets.find((t) => t.path === row.target);
          if (target && row.lastError !== null && row.nextTryAt !== null && Date.parse(row.nextTryAt) <= nowMs) this.queue(target, [row.path]);
        }
        this.flush();
      },
      Math.max(0, next - this.now().getTime()),
    );
  }

  /**
   * Reads one file through the safe reader (LS-01). A file it refuses is skipped with a warning; any other error is the
   * file's failure, kept and tried again on the schedule (H2).
   */
  private readFile(target: Target, file: string, row: FileRow | undefined): FileRead {
    if (target.kind === 'downloads') {
      let batches: ImportBatch[] = [];
      try {
        // Downloads holds everything; only chat exports are taken, never loose notes inside some other zip.
        batches = readImports(file).filter((b) => EXPORT_KINDS.has(b.source.kind));
      } catch (error) {
        if (!(error as Error).message.startsWith('Nothing to import')) throw error;
      }
      return { batches, ...NOTHING };
    }
    if (extname(file).toLowerCase() === '.jsonl') {
      const read = this.readSession(target, file, row);
      if (read) return read;
    }
    const warnings: string[] = [];
    const batches = readFilesUnder(target.path, [relative(target.path, file)], { owner: target.owner, onWarning: (m) => warnings.push(m) });
    const entries = batches.reduce((n, b) => n + (b.entries?.length ?? 0) + b.threads.reduce((m, t) => m + t.entries.length, 0), 0);
    if (warnings.length && !entries) {
      // Nothing came of it, with a warning: the importer skipped the file because it couldn't or mustn't read it, or it
      // failed as a whole. Which was it?
      readSafe(file, { root: target.path }); // throws the refusal or the read error
      throw new Error(warnings[0]); // readable now: a passing failure, tried again soon
    }
    // Entries it skipped or kept without their time: the rest is saved, and the warnings name them.
    for (const w of warnings) this.warn(w);
    return { batches, ...NOTHING };
  }

  /**
   * A Claude Code session: from where the last read stopped when the file only grew (L6), else whole, as the importer
   * reads it. Null for any other JSONL (Codex), which the importer reads.
   */
  private readSession(target: Target, file: string, row: FileRow | undefined): FileRead | null {
    const { fd, stat } = openSafe(file, { root: target.path });
    try {
      const read: ReadAt = (start, length) => readRange(fd, length, start);
      const id = basename(file).replace(/\.jsonl$/i, '');
      const source = { kind: 'claude-code', label: 'Claude Code', location: resolve(target.path) };
      const { head, tail, session } = row?.extra ?? {};
      if (row && head && tail && session && row.offset > 0) {
        const t = readTail(read, stat.size, { offset: row.offset, head, tail, session }, id);
        if (t.kind === 'same') return { batches: [], offset: row.offset, extra: row.extra, sha256: row.sha256 };
        if (t.kind === 'tail') {
          const { offset, ...extra } = t.state;
          return { batches: [{ source, threads: [t.thread] }], offset, extra, sha256: null };
        }
      }
      const bytes = read(0, stat.size);
      const text = bytes.toString('utf8');
      if (sniffSession(text) !== 'claude-code') return null;
      // Named as the importer names them: relative to the watched folder.
      const report = new FileReport(relative(target.path, file), this.warn);
      const thread = parseClaudeCodeSession(text, id, report);
      report.done();
      const { offset = 0, ...extra } = stateAfterWholeRead(bytes, thread) ?? {};
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // A whole read names its file, as the importer does. A tail read can't: the file's hash would mean reading it all.
      return { batches: [{ source, threads: [{ ...thread, origin: { path: file, sha256 } }] }], offset, extra, sha256 };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Reads one file and saves what it holds. A failure is that file's alone: it is kept in the file's row, with the next
   * try, and the pass goes on (H2). A busy record is not the file's failure: it stops the pass (M8).
   */
  private importFile(target: Target, file: string, force: boolean, excluded: Set<string>, caught: Map<string, Caught>, now: Date): void {
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.files.remove(file); // deleted: the record keeps what it had, and the file's error goes
      return;
    }
    const row = this.files.get(file);
    if (!force && !due(row, st, now.getTime())) return;
    let read: FileRead;
    try {
      read = this.readFile(target, file, row);
    } catch (error) {
      if (!(error instanceof UnsafeFileError)) {
        if (isBusy(error)) throw error;
        this.files.fail(file, target.path, st, (error as Error).message, now);
        return;
      }
      read = { batches: [], ...NOTHING, refused: error.message };
    }
    // Warned once per version of the file: the row keeps the version, so it isn't read again until it changes.
    if (read.refused) this.warn(read.refused);
    try {
      let saved = false;
      for (const batch of read.batches) {
        if (excluded.has(`${batch.source.kind}\u0000${batch.source.location ?? ''}`)) {
          // Left out of the record: keep no place in the file, so it is read whole once the source is back in.
          read.offset = 0;
          read.extra = {};
          continue;
        }
        const key = `${batch.source.kind}\u0000${batch.source.label}`;
        const c = caught.get(key) ?? { label: batch.source.label, kind: batch.source.kind, threads: 0, added: 0, versioned: 0 };
        caught.set(key, c);
        const count = (r: ImportResult) => {
          c.added += r.added;
          c.versioned += r.versioned;
          if (r.added + r.versioned > 0) saved = true;
          return r.added + r.versioned > 0;
        };
        // One thread at a time, so "caught up N chats" counts only the chats that gained or changed entries (a
        // re-downloaded export holds hundreds that didn't).
        // The batch is spread so its origin and account go with each thread.
        for (const thread of batch.threads) if (count(this.store.ingest({ ...batch, threads: [thread], entries: [] }))) c.threads += 1;
        if (batch.entries?.length) count(this.store.ingest({ ...batch, threads: [] }));
      }
      // The version is the one stat'ed before the read: a file that changed meanwhile is read again next time.
      this.files.ok(file, target.path, { size: st.size, mtimeMs: st.mtimeMs, sha256: read.sha256, offset: read.offset, extra: read.extra, saved }, now.toISOString());
    } catch (error) {
      if (isBusy(error)) throw error;
      this.files.fail(file, target.path, st, (error as Error).message, now);
    }
  }

  private importChanges(changes: Map<Target, Set<string>>, force: boolean): LiveStatus {
    const caught = new Map<string, Caught>();
    const now = this.now();
    const work = [...changes].flatMap(([target, files]) => [...files].sort().map((file) => ({ target, file })));
    let busy = false;
    let i = 0;
    try {
      const excluded = new Set(
        this.store
          .sources()
          .filter((s) => s.status === 'out')
          .map((s) => `${s.kind}\u0000${s.location}`),
      );
      for (; i < work.length; i++) this.importFile(work[i]!.target, work[i]!.file, force, excluded, caught, now);
    } catch (error) {
      // Another process holds the record (an import, an organiser run, the web app): stop here and keep this pass's
      // remaining files for the next one. What was saved stays saved, and saving it again changes nothing (M8).
      if (!isBusy(error)) throw error;
      busy = true;
      for (const { target, file } of work.slice(i)) this.queue(target, [file]);
    }
    const at = now.toISOString();
    const prev = this.status();
    const list = [...caught.values()].filter((c) => c.added + c.versioned > 0);
    const errors: LiveStatus['errors'] = this.files
      .under(this.targets.map((t) => t.path))
      .filter((r) => r.lastError !== null)
      .map((r) => ({ path: r.path, error: r.lastError! }));
    if (busy) {
      const next = this.watching ? `trying again in ${Math.max(1, Math.round(this.busyRetryMs / 1000))} s` : 'run live again once it is free';
      errors.push({ path: 'the record', error: `another skeinwise command is writing to it; ${next}` });
    }
    const status: LiveStatus = {
      ...prev,
      lastSavedAt: list.length ? at : (prev.lastSavedAt ?? this.files.lastSavedAt(this.targets.map((t) => t.path))),
      // A pass cut short isn't a finished pass.
      lastPassAt: busy ? prev.lastPassAt : at,
      caught: list.length ? list : prev.caught,
      errors,
    };
    writeStatus(this.options.statusFile, status);
    if (busy && this.watching) this.schedule(this.busyRetryMs);
    this.scheduleRetries();
    if (list.length) this.options.onSaved?.(status);
    return status;
  }
}
