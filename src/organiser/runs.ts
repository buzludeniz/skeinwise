// Runs: one pass of an engine over a scope. A run starts as "running", and everything it makes is saved in one
// transaction together with its "done" status, so a failed run saves nothing. Undo deletes what a run made.

import type { DatabaseSync } from 'node:sqlite';
import { UsageError } from '../errors.ts';
import { inTransaction } from '../store/db.ts';
import type { Entry } from '../store/store.ts';
import type { RecordView } from './record.ts';

export type Task = 'tag' | 'file' | 'link' | 'hub' | 'layer' | 'review';
/** The order `run all` follows: tags, folders and links first, then hubs, layers, and the review of notes on hubs. */
export const TASKS: readonly Task[] = ['tag', 'file', 'link', 'hub', 'layer', 'review'];
export type RunTask = Task | 'ask' | 'correction';
export type RunEngine = 'none' | 'local' | 'remote' | 'you';
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
  assertNoRunning(db);
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

/** Marks a run done. Call it inside the transaction that saves the run's rows. */
export function finishRun(db: DatabaseSync, id: number, finish: Finish): void {
  const res = db
    .prepare(
      `UPDATE runs SET status = 'done', counts = ?, message = ?, tokens_in = ?, tokens_out = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(JSON.stringify(finish.counts), finish.message ?? null, finish.tokensIn, finish.tokensOut, finish.now, id);
  if (res.changes === 0) throw new Error(`Run ${id} was undone while it ran, so nothing was saved.`);
}

export function failRun(db: DatabaseSync, id: number, message: string, tokensIn: number, tokensOut: number, now: string): void {
  db.prepare(
    `UPDATE runs SET status = 'failed', message = ?, tokens_in = ?, tokens_out = ?, finished_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(message, tokensIn, tokensOut, now, id);
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
}

/** Undoes a run: deletes everything it made (or reverses a correction) and marks it undone, in one transaction. */
export function undoRun(db: DatabaseSync, id: number): UndoResult {
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
    }
    db.prepare("UPDATE runs SET status = 'undone' WHERE id = ?").run(id);
    return { run: { ...run, status: 'undone' }, removed };
  });
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

/** Tokens an outside model used in the calendar month (UTC) that `now` falls in. */
export function remoteTokensThisMonth(db: DatabaseSync, now: string): number {
  const month = `${now.slice(0, 7)}-01`;
  const row = db
    .prepare("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS n FROM runs WHERE engine = 'remote' AND started_at >= ?")
    .get(month) as { n: number };
  return Number(row.n);
}
