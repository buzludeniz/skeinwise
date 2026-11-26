// Your tasks and reminders. A task has a title, maybe a day it is due, and maybe a moment to remind you; a task with
// a reminder shows as due once that moment passes, until you dismiss or snooze it. Tasks come from you, from an open
// loop the assistant found, or from a line read by a model (made_by says which). Nothing here touches the record.

import type { DatabaseSync } from 'node:sqlite';
import { UsageError } from '../errors.ts';
import { localDay } from '../notes.ts';
import { safeBlock, safeLine } from '../safe-text.ts';
import { REMINDER_CUES, plain, taskTitle } from './cues.ts';
import { readWhen, whenAt, withoutWhen } from './when.ts';

export type TaskStatus = 'open' | 'done' | 'dropped';
export type MadeBy = 'you' | 'none' | 'local' | 'remote';

export interface PaTask {
  id: number;
  title: string;
  notes: string;
  status: TaskStatus;
  /** The local day it is due, YYYY-MM-DD. */
  dueDay: string | null;
  /** When to remind you, an ISO moment. */
  remindAt: string | null;
  /** When the reminder was dismissed; null while it waits or shows. */
  remindedAt: string | null;
  entryId: number | null;
  loopKey: string | null;
  madeBy: MadeBy;
  runId: number | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

export interface TaskInput {
  title: string;
  notes?: string;
  dueDay?: string | null;
  remindAt?: string | null;
  entryId?: number | null;
  loopKey?: string | null;
  madeBy?: MadeBy;
  runId?: number | null;
}

export const TITLE_MAX = 300;
export const NOTES_MAX = 5000;
const STATUSES: readonly TaskStatus[] = ['open', 'done', 'dropped'];

const COLUMNS = `id, title, notes, status, due_day AS dueDay, remind_at AS remindAt, reminded_at AS remindedAt,
  entry_id AS entryId, loop_key AS loopKey, made_by AS madeBy, run_id AS runId, created_at AS createdAt,
  updated_at AS updatedAt, done_at AS doneAt`;

/** Fails loudly when the assistant's tables are missing, rather than with SQLite's "no such table". */
export function assertPaReady(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pa_tasks'").get()) {
    throw new Error("This record has no assistant tables yet: the assistant's migration (src/pa/schema.ts) hasn't run.");
  }
}

function title(value: string): string {
  const t = safeLine(value).trim();
  if (!t) throw new UsageError('A task needs a title.');
  if (t.length > TITLE_MAX) throw new UsageError(`A task's title is at most ${TITLE_MAX} characters.`);
  return t;
}

function notes(value: string): string {
  const t = safeBlock(value).trim();
  if (t.length > NOTES_MAX) throw new UsageError(`A task's notes are at most ${NOTES_MAX} characters.`);
  return t;
}

/** A YYYY-MM-DD day that exists, or null. */
export function checkDay(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    throw new UsageError(`"${value}" is not a day. Write it as YYYY-MM-DD.`);
  }
  return value;
}

/** An ISO moment, normalised to UTC, or null. */
export function checkMoment(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const t = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(t)) throw new UsageError(`"${value}" is not a moment. Write it as an ISO date and time.`);
  return new Date(t).toISOString();
}

export function getTask(db: DatabaseSync, id: number): PaTask | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM pa_tasks WHERE id = ?`).get(id) as PaTask | undefined;
}

export function needTask(db: DatabaseSync, id: number): PaTask {
  const task = getTask(db, id);
  if (!task) throw new UsageError(`No task ${id}. Run "skeinwise tasks --all" for the list.`);
  return task;
}

export function addTask(db: DatabaseSync, input: TaskInput, now: string): PaTask {
  assertPaReady(db);
  if (input.loopKey) {
    const held = db.prepare('SELECT id FROM pa_tasks WHERE loop_key = ?').get(input.loopKey) as { id: number } | undefined;
    if (held) throw new UsageError(`That loop is already task ${held.id}.`);
  }
  const res = db
    .prepare(
      `INSERT INTO pa_tasks (title, notes, due_day, remind_at, entry_id, loop_key, made_by, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      title(input.title),
      notes(input.notes ?? ''),
      checkDay(input.dueDay),
      checkMoment(input.remindAt),
      input.entryId ?? null,
      input.loopKey ?? null,
      input.madeBy ?? 'you',
      input.runId ?? null,
      now,
      now,
    );
  return getTask(db, Number(res.lastInsertRowid))!;
}

export interface TaskPatch {
  title?: string;
  notes?: string;
  dueDay?: string | null;
  remindAt?: string | null;
  status?: TaskStatus;
}

/** Changes what the patch names. A new reminder moment shows again even if the old one was dismissed. */
export function updateTask(db: DatabaseSync, id: number, patch: TaskPatch, now: string): PaTask {
  const task = needTask(db, id);
  const next = { ...task };
  if (patch.title !== undefined) next.title = title(patch.title);
  if (patch.notes !== undefined) next.notes = notes(patch.notes);
  if (patch.dueDay !== undefined) next.dueDay = checkDay(patch.dueDay);
  if (patch.remindAt !== undefined) {
    next.remindAt = checkMoment(patch.remindAt);
    if (next.remindAt !== task.remindAt) next.remindedAt = null;
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new UsageError(`A task is open, done or dropped, not "${String(patch.status)}".`);
    next.status = patch.status;
    next.doneAt = patch.status === 'open' ? null : task.status === patch.status ? task.doneAt : now;
  }
  db.prepare(
    `UPDATE pa_tasks SET title = ?, notes = ?, due_day = ?, remind_at = ?, reminded_at = ?, status = ?, done_at = ?,
     updated_at = ? WHERE id = ?`,
  ).run(next.title, next.notes, next.dueDay, next.remindAt, next.remindedAt, next.status, next.doneAt, now, id);
  return getTask(db, id)!;
}

export function removeTask(db: DatabaseSync, id: number): PaTask {
  const task = needTask(db, id);
  db.prepare('DELETE FROM pa_tasks WHERE id = ?').run(id);
  return task;
}

/**
 * Tasks in the order to do them: open ones first, overdue and soonest due at the top, undated after; then the done
 * and dropped ones, latest first.
 */
export function listTasks(db: DatabaseSync, status: TaskStatus | 'all' = 'open', limit = 500): PaTask[] {
  assertPaReady(db);
  const where = status === 'all' ? '' : 'WHERE status = ?';
  const args = status === 'all' ? [limit] : [status, limit];
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM pa_tasks ${where}
       ORDER BY status = 'open' DESC, CASE WHEN status = 'open' THEN due_day IS NULL END, CASE WHEN status = 'open' THEN due_day END,
                CASE WHEN status = 'open' THEN remind_at END, COALESCE(done_at, created_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(...args) as unknown as PaTask[];
}

/** Open tasks whose reminder moment has passed and that haven't been dismissed, soonest first. */
export function dueReminders(db: DatabaseSync, now: string): PaTask[] {
  assertPaReady(db);
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM pa_tasks
       WHERE status = 'open' AND remind_at IS NOT NULL AND remind_at <= ? AND reminded_at IS NULL
       ORDER BY remind_at, id`,
    )
    .all(now) as unknown as PaTask[];
}

/** Open tasks with a reminder still to come, soonest first. */
export function upcomingReminders(db: DatabaseSync, now: string, limit = 50): PaTask[] {
  assertPaReady(db);
  return db
    .prepare(`SELECT ${COLUMNS} FROM pa_tasks WHERE status = 'open' AND remind_at > ? ORDER BY remind_at, id LIMIT ?`)
    .all(now, limit) as unknown as PaTask[];
}

export function dismissReminder(db: DatabaseSync, id: number, now: string): PaTask {
  const task = needTask(db, id);
  if (!task.remindAt) throw new UsageError(`Task ${id} has no reminder.`);
  db.prepare('UPDATE pa_tasks SET reminded_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  return getTask(db, id)!;
}

export function snoozeReminder(db: DatabaseSync, id: number, until: string, now: string): PaTask {
  const at = checkMoment(until)!;
  if (at <= now) throw new UsageError('Snooze to a moment that is still to come.');
  return updateTask(db, id, { remindAt: at }, now);
}

export interface TaskCounts {
  open: number;
  overdue: number;
  dueToday: number;
  remindersDue: number;
}

export function taskCounts(db: DatabaseSync, today: string, now: string): TaskCounts {
  assertPaReady(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS open,
              COUNT(CASE WHEN due_day < ? THEN 1 END) AS overdue,
              COUNT(CASE WHEN due_day = ? THEN 1 END) AS dueToday,
              COUNT(CASE WHEN remind_at <= ? AND reminded_at IS NULL THEN 1 END) AS remindersDue
       FROM pa_tasks WHERE status = 'open'`,
    )
    .get(today, today, now) as unknown as TaskCounts;
  return { open: row.open, overdue: row.overdue, dueToday: row.dueToday, remindersDue: row.remindersDue };
}

/** The hour a reminder with a day but no time goes off. */
export const REMIND_HOUR = 9;

/**
 * Reads a line like "remind me to call Ana tomorrow at 3" or "renew the insurance by Friday" with no model: the title
 * without the "when" words, the day it is due, and a reminder when the line asks for one, gives a time, or `reminder`
 * says so (the remind command). A reminder
 * with no day goes off at the next 09:00; one whose moment has passed already goes off in an hour.
 */
export function readTask(line: string, now: Date, reminder = false): Required<Pick<TaskInput, 'title' | 'dueDay' | 'remindAt'>> {
  const text = plain(line).trim();
  const when = readWhen(text, now);
  const remind = reminder || REMINDER_CUES.test(text) || !!when?.time;
  const t = taskTitle(withoutWhen(text, now));
  if (!t) throw new UsageError('Say what the task is, for example: "call Ana tomorrow at 3".');
  let remindAt: string | null = null;
  if (remind) {
    let at = when ? whenAt(when, REMIND_HOUR) : nextHour(now, REMIND_HOUR);
    if (at.getTime() <= now.getTime()) at = new Date(now.getTime() + 3_600_000);
    remindAt = at.toISOString();
  }
  return { title: t, dueDay: when?.day ?? (remindAt ? localDay(new Date(remindAt)) : null), remindAt };
}

function nextHour(now: Date, hour: number): Date {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0);
  return at.getTime() > now.getTime() ? at : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, 0);
}
