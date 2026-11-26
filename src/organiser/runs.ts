// Runs: one pass of an engine over a scope. A run starts as "running", and everything it makes is saved in one
// transaction together with its "done" status, so a failed run saves nothing. Undo deletes what a run made.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { UsageError } from '../errors.ts';
import { homeNoteFile, notesDir, readNotes, removeNoteFile, rewriteNoteFile, startedNoteFile } from '../notes.ts';
import { inTransaction } from '../store/db.ts';
import { type Entry, Store } from '../store/store.ts';
import type { RecordView } from './record.ts';

export type Task = 'tag' | 'file' | 'link' | 'hub' | 'layer' | 'review';
/** The order `run all` follows: tags, folders and links first, then hubs, layers, and the review of notes on hubs. */
export const TASKS: readonly Task[] = ['tag', 'file', 'link', 'hub', 'layer', 'review'];
/** 'note' is an agent's note saved through the memory server: its versions carry the run's id, so undo takes them back. */
export type RunTask = Task | 'ask' | 'correction' | 'note';
/** 'agent' is a run an agent made through the memory server, with the agent's name as the model. */
export type RunEngine = 'none' | 'local' | 'remote' | 'you' | 'agent';
export type RunStatus = 'running' | 'done' | 'failed' | 'undone';

export type Scope =
  | { kind: 'all' }
  | { kind: 'new' }
  | { kind: 'source'; id: number }
  | { kind: 'since'; date: string };

export function parseScope(text: string | undefined): Scope {
  const s = (text ?? 'all').trim();
  if (s === 'all' || s === 'new') return { kind: s };
  const source = /^source:(\d+)$/.exec(s);
  if (source) return { kind: 'source', id: Number(source[1]) };
  const since = /^since:(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (since && !Number.isNaN(Date.parse(since[1]!))) return { kind: 'since', date: since[1]! };
  throw new UsageError(`Unknown scope "${s}". Use all, new, source:<id> or since:<YYYY-MM-DD>.`);
}

export function scopeText(scope: Scope): string {
  if (scope.kind === 'source') return `source:${scope.id}`;
  if (scope.kind === 'since') return `since:${scope.date}`;
  return scope.kind;
}

export interface Run {
  id: number;
  task: RunTask;
  engine: RunEngine;
  model: string | null;
  scope: string;
  schemaId: number | null;
  status: RunStatus;
  counts: Record<string, number>;
  message: string | null;
  detail: Record<string, unknown> | null;
  mark: number;
  tokensIn: number;
  tokensOut: number;
  startedAt: string;
  finishedAt: string | null;
}

const RUN_SELECT = `SELECT id, task, engine, model, scope, schema_id AS schemaId, status, counts, message, detail, mark,
  tokens_in AS tokensIn, tokens_out AS tokensOut, started_at AS startedAt, finished_at AS finishedAt FROM runs`;

function toRun(row: Record<string, unknown>): Run {
  return {
    ...(row as unknown as Run),
    counts: JSON.parse(row.counts as string) as Record<string, number>,
    detail: row.detail ? (JSON.parse(row.detail as string) as Record<string, unknown>) : null,
  };
}

export function getRun(db: DatabaseSync, id: number): Run | undefined {
  const row = db.prepare(`${RUN_SELECT} WHERE id = ?`).get(id);
  return row ? toRun(row) : undefined;
}

export function listRuns(db: DatabaseSync, limit = 50): Run[] {
  return db.prepare(`${RUN_SELECT} ORDER BY id DESC LIMIT ?`).all(limit).map(toRun);
}

/** The newest version id: a run's watermark for scope "new". */
export function currentMark(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM versions').get() as { m: number }).m);
}

/**
 * The watermark scope "new" starts from: the mark of the task's last done run over everything or over new entries
 * (for tags, of the same schema). Null when the task has never run, so everything is new.
 */
export function lastMark(db: DatabaseSync, task: Task, schemaId: number | null): number | null {
  const row = db
    .prepare(
      `SELECT mark FROM runs WHERE task = ? AND status = 'done' AND scope IN ('all', 'new')
       AND COALESCE(schema_id, 0) = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(task, schemaId ?? 0) as { mark: number } | undefined;
  return row ? row.mark : null;
}

/** The visible entries a run covers. */
export function scopeEntries(
  db: DatabaseSync,
  record: RecordView,
  scope: Scope,
  task: Task,
  schemaId: number | null,
): Entry[] {
  switch (scope.kind) {
    case 'all':
      return record.entries;
    case 'source': {
      if (!db.prepare('SELECT 1 FROM sources WHERE id = ?').get(scope.id))
        throw new UsageError(`No source ${scope.id}. Run "skeinwise sources" for the list.`);
      return record.entries.filter((e) => e.sourceId === scope.id);
    }
    case 'since':
      return record.entries.filter((e) => e.createdAt >= scope.date);
    case 'new': {
      const mark = lastMark(db, task, schemaId);
      if (mark === null) return record.entries;
      const changed = new Set(
        (db.prepare('SELECT DISTINCT entry_id AS id FROM versions WHERE id > ?').all(mark) as { id: number }[]).map(
          (r) => r.id,
        ),
      );
      return record.entries.filter((e) => changed.has(e.id));
    }
  }
}

export interface StartRun {
  task: RunTask;
  engine: RunEngine;
  model: string | null;
  scope: string;
  schemaId?: number | null;
  mark: number;
  detail?: Record<string, unknown>;
  now: string;
  /**
   * Starts even while another run is unfinished. Only for an agent's note: it saves versions, not anything the
   * organiser makes, so it can't replace another run's work, and live's organiser run mustn't hold back an agent.
   */
  alongside?: boolean;
}

/** Refuses to start while another run is unfinished: two runs at once could each replace the other's work. */
export function assertNoRunning(db: DatabaseSync): void {
  const running = db.prepare("SELECT id, task, started_at AS startedAt FROM runs WHERE status = 'running'").get() as
    | { id: number; task: string; startedAt: string }
    | undefined;
  if (running) {
    throw new UsageError(
      `Run ${running.id} (${running.task}) has been running since ${running.startedAt}. ` +
        `If it was cut off, mark it undone with: skeinwise undo ${running.id}`,
    );
  }
}

export function startRun(db: DatabaseSync, run: StartRun): number {
  if (!run.alongside) assertNoRunning(db);
  const res = db
    .prepare(
      `INSERT INTO runs (task, engine, model, scope, schema_id, status, detail, mark, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    )
    .run(
      run.task,
      run.engine,
      run.model,
      run.scope,
      run.schemaId ?? null,
      run.detail ? JSON.stringify(run.detail) : null,
      run.mark,
      run.now,
    );
  return Number(res.lastInsertRowid);
}

export interface Finish {
  counts: Record<string, number>;
  message?: string;
  tokensIn: number;
  tokensOut: number;
  now: string;
}

/**
 * A token count as the runs table keeps it: a whole number, never below zero. The model client already counts its own
 * estimate when a server reports 0 or less (model.ts `reported`); this keeps any other figure from lowering the
 * month's sum (LS-15, M13).
 */
function counted(tokens: number): number {
  return Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : 0;
}

/** Marks a run done. Call it inside the transaction that saves the run's rows. */
export function finishRun(db: DatabaseSync, id: number, finish: Finish): void {
  const res = db
    .prepare(
      `UPDATE runs SET status = 'done', counts = ?, message = ?, tokens_in = ?, tokens_out = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(JSON.stringify(finish.counts), finish.message ?? null, counted(finish.tokensIn), counted(finish.tokensOut), finish.now, id);
  if (res.changes === 0) throw new Error(`Run ${id} was undone while it ran, so nothing was saved.`);
}

export function failRun(db: DatabaseSync, id: number, message: string, tokensIn: number, tokensOut: number, now: string): void {
  db.prepare(
    `UPDATE runs SET status = 'failed', message = ?, tokens_in = ?, tokens_out = ?, finished_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(message, counted(tokensIn), counted(tokensOut), now, id);
}

/** The run ids whose output is current (see the live_runs view), as SQL to put after "IN". */
export const LIVE = '(SELECT id FROM live_runs)';

const MADE_BY_RUN = ['entry_tags', 'tags', 'entry_folders', 'folders', 'links', 'hub_entries', 'hubs', 'layers', 'review_items'];

/** Other unfinished-or-done runs that build on what this run made, or corrections that change it. */
function dependents(db: DatabaseSync, id: number): number[] {
  const rows = db
    .prepare(
      `SELECT r.id FROM runs r WHERE r.id <> ? AND r.status IN ('running', 'done') AND (
         EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.run_id = r.id AND t.run_id = ?)
         OR EXISTS (SELECT 1 FROM entry_folders ef JOIN folders f ON f.id = ef.folder_id WHERE ef.run_id = r.id AND f.run_id = ?)
         OR EXISTS (SELECT 1 FROM hub_entries he JOIN hubs h ON h.id = he.hub_id WHERE he.run_id = r.id AND h.run_id = ?)
         OR EXISTS (SELECT 1 FROM hubs h2 JOIN hubs h ON h.id = h2.replaces WHERE h2.run_id = r.id AND h.run_id = ?)
         OR (r.task = 'correction' AND EXISTS (
           SELECT 1 FROM json_each(r.detail, '$.targets') j
           WHERE (j.value LIKE 'hub:%' AND CAST(substr(j.value, 5) AS INTEGER) IN (SELECT id FROM hubs WHERE run_id = ?))
              OR (j.value LIKE 'folder:%' AND CAST(substr(j.value, 8) AS INTEGER) IN (SELECT id FROM folders WHERE run_id = ?))
         ))
       ) ORDER BY r.id`,
    )
    .all(id, id, id, id, id, id, id) as { id: number }[];
  return rows.map((r) => r.id);
}

/** The live runs a new run of this task, schema and scope would hide (see the live_runs view). */
export function replacedRuns(db: DatabaseSync, task: Task, schemaId: number | null, scope: Scope): number[] {
  if (scope.kind === 'new') return [];
  const rows = db
    .prepare(
      `SELECT id FROM live_runs WHERE task = ? AND COALESCE(schema_id, 0) = ?
       AND (? = 'all' OR id IN (SELECT id FROM runs WHERE scope = ?))`,
    )
    .all(task, schemaId ?? 0, scope.kind, scopeText(scope)) as { id: number }[];
  return rows.map((r) => r.id);
}

export interface UndoResult {
  run: Run;
  removed: Record<string, number>;
  /** Notes whose text came back: a review run's accepted updates, each put back as a new version. */
  restored: number[];
}

/** What undoing a run did to notes before its transaction: the text put back, and the notes the run started removed. */
interface NoteUndo {
  restored: number[];
  purged: number[];
}

/**
 * Undoes a run: puts back the text of notes it updated, then deletes everything it made (or reverses a correction) and
 * marks it undone in one transaction. `home` is the record's folder: a note kept there has its file put back too, so
 * an undone review run needs it. Each note goes back in its own transaction first (the store's restore opens one, and
 * SQLite has no nested BEGIN). If the undo stops after that, running it again finds those notes already back. A note an
 * agent's run started is removed, its file and its entry. `now` is the caller's clock, for the versions put back.
 */
export function undoRun(db: DatabaseSync, id: number, home?: string, now?: () => string): UndoResult {
  const before = getRun(db, id);
  const undoable = before?.status === 'done' && before.task !== 'correction' && before.task !== 'ask' && !dependents(db, id).length;
  const { restored, purged } = undoable ? restoreEdits(db, before, home, now) : { restored: [], purged: [] };
  return inTransaction(db, () => {
    const run = getRun(db, id);
    if (!run) throw new UsageError(`No run ${id}. Run "skeinwise runs" for the list.`);
    if (run.status === 'undone') throw new UsageError(`Run ${id} is already undone.`);
    if (run.status === 'failed') throw new UsageError(`Run ${id} failed, so it saved nothing to undo.`);
    if (run.task === 'ask') throw new UsageError(`Run ${id} answered a question; it saved nothing to undo.`);
    const removed: Record<string, number> = {};
    if (run.task === 'correction') {
      reverseCorrection(db, run);
    } else {
      const later = dependents(db, id);
      if (later.length) {
        throw new UsageError(
          `Runs ${later.join(', ')} build on what run ${id} made. Undo ${later.length > 1 ? 'them' : 'it'} first.`,
        );
      }
      for (const table of MADE_BY_RUN) {
        const res = db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(id);
        if (res.changes) removed[table] = Number(res.changes);
      }
      if (purged.length) removed.notes = purged.length;
    }
    db.prepare("UPDATE runs SET status = 'undone' WHERE id = ?").run(id);
    return { run: { ...run, status: 'undone' }, removed, restored };
  });
}

/**
 * Puts back the text each note had before the run updated it (an accepted review update, saved with the run's id), as a
 * new version, so the update stays in history, and its file when it is kept in the record folder. Everything is
 * checked before anything changes: a note changed again since is refused, unless it already reads as before. The notes
 * folder is read first, so an edit made in a file that the record hasn't seen yet counts as a change and is never
 * written over. Returns the notes put back.
 *
 * A note an agent's run started (task 'note', its first version the run's) is removed, file and entry, while it still
 * reads as the run left it. Its file goes only when it is the one the run recorded, in the notes folder, not a link,
 * and holding exactly what the run wrote (startedNoteFile); anything else is refused before anything changes.
 */
function restoreEdits(db: DatabaseSync, run: Run, home: string | undefined, now: (() => string) | undefined): NoteUndo {
  const edits = db
    .prepare('SELECT entry_id AS entryId, MIN(version) AS first, MAX(version) AS last FROM versions WHERE run_id = ? GROUP BY entry_id ORDER BY entry_id')
    .all(run.id) as { entryId: number; first: number; last: number }[];
  if (!edits.length) return { restored: [], purged: [] };
  if (home === undefined) throw new UsageError(`Run ${run.id} changed notes, so undoing it needs the record's folder to put their files back.`);
  const store = new Store(db, now);
  readNotes(store, home);
  const started = edits.filter((e) => e.first === 1 && run.task === 'note').map(({ entryId, last }) => {
    const history = store.history(entryId);
    const current = history.at(-1)!;
    if (current.contentHash !== history.find((v) => v.version === last)!.contentHash) {
      throw new UsageError(
        `Note #${entryId} changed after run ${run.id} wrote it. Undo the later change first ("skeinwise history ${entryId}" lists them), or keep the note.`,
      );
    }
    // A file that was there before the run holds text that isn't the run's, so only a file the run made may go.
    const { file, sha256, created } = (run.detail ?? {}) as { file?: unknown; sha256?: unknown; created?: unknown };
    const recorded = created === true && typeof file === 'string' && typeof sha256 === 'string' ? { file, sha256 } : null;
    const own = homeNoteFile(store, home, store.getEntry(entryId)!);
    if (!recorded || !own || own !== resolve(notesDir(home), recorded.file)) {
      throw new UsageError(`Run ${run.id} saved note #${entryId}, but not into a file it made and recorded, so nothing was removed.`);
    }
    return { entryId, file: startedNoteFile(home, recorded.file, recorded.sha256, run.id) };
  });
  const plans = edits.filter((e) => !(e.first === 1 && run.task === 'note')).map(({ entryId, first, last }) => {
    const history = store.history(entryId);
    const before = history.find((v) => v.version === first - 1);
    if (!before) throw new Error(`Entry ${entryId} has no version before run ${run.id}'s update ${first}.`);
    const current = history.at(-1)!;
    const back = current.contentHash === before.contentHash;
    if (current.version !== last && !back) {
      throw new UsageError(
        `Note #${entryId} changed after run ${run.id} updated it. Bring back the version you want with "skeinwise restore ${entryId} ${before.version}", then undo run ${run.id}.`,
      );
    }
    return { entryId, before, back };
  });
  const purged: number[] = [];
  for (const { entryId, file } of started) {
    // The file first: if the entry can't be purged after it, running the undo again finds no file and purges.
    if (file) removeNoteFile(file);
    store.purgeEntry(entryId);
    purged.push(entryId);
  }
  const restored: number[] = [];
  for (const { entryId, before, back } of plans) {
    // The file goes first, as in resolveReview: if it can't be written, this note is as the run left it, and running
    // the undo again does the whole of it. A note that already reads as before in the record (`skeinwise restore`, which
    // leaves files alone) still has its file put back: the read above found nothing in it the history lacks. A file
    // that is gone has nothing to put back.
    const file = homeNoteFile(store, home, store.getEntry(entryId)!);
    if (file && existsSync(file)) rewriteNoteFile(file, before.body);
    if (back) continue;
    store.restoreVersion(entryId, before.version, { editor: 'you' });
    restored.push(entryId);
  }
  return { restored, purged };
}

function reverseCorrection(db: DatabaseSync, run: Run): void {
  const detail = run.detail ?? {};
  const targets = (detail.targets as string[] | undefined) ?? [];
  const later = db
    .prepare(
      `SELECT DISTINCT r.id FROM runs r, json_each(r.detail, '$.targets') j
       WHERE r.task = 'correction' AND r.status = 'done' AND r.id > ? AND j.value IN (SELECT value FROM json_each(?))
       ORDER BY r.id`,
    )
    .all(run.id, JSON.stringify(targets)) as { id: number }[];
  if (later.length) {
    throw new UsageError(`Run ${later.map((r) => r.id).join(', ')} changed the same thing later. Undo that first.`);
  }
  switch (detail.op) {
    case 'merge-folders':
      db.prepare('UPDATE folders SET alias_of = ? WHERE id = ?').run(
        (detail.previousAliasOf as number | null) ?? null,
        detail.folder as number,
      );
      return;
    case 'rename-hub':
      db.prepare('UPDATE hubs SET name = ? WHERE id = ?').run(detail.before as string, detail.hub as number);
      return;
    case 'delete-hub':
      db.prepare('UPDATE hubs SET deleted_by = NULL WHERE id = ? AND deleted_by = ?').run(detail.hub as number, run.id);
      return;
    default:
      throw new Error(`Run ${run.id} is a correction of an unknown kind (${String(detail.op)}); it can't be undone.`);
  }
}

/**
 * Tokens an outside model used in the calendar month (UTC) that `now` falls in. Only what is above zero counts: a
 * row an earlier version wrote, or a synced record brought in, may hold a negative figure (LS-15).
 */
export function remoteTokensThisMonth(db: DatabaseSync, now: string): number {
  const month = `${now.slice(0, 7)}-01`;
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(MAX(tokens_in, 0) + MAX(tokens_out, 0)), 0) AS n FROM runs WHERE engine = 'remote' AND started_at >= ?",
    )
    .get(month) as { n: number };
  return Number(row.n);
}
