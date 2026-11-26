// Open loops: what you said you'd do, who is waiting on you, and who you are waiting on, found in your own words.
// The No-AI reading picks sentences by the cue lists (src/pa/cues.ts); a model run (src/pa/model.ts) can read the
// same sentences and more, and its reading wins for every sentence it saw. A loop closes when you say so (done,
// dropped), when its task is finished, or when a later sentence of yours says it is done ("Sent Ana the report").
// One that stays open past its day, or for FOLLOW_UP_DAYS with no day, is due a follow-up.

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { UsageError } from '../errors.ts';
import { localDay } from '../notes.ts';
import { type RecordView, unlink, vouched } from '../organiser/record.ts';
import { sentences, tokenize } from '../organiser/text.ts';
import { safeLine } from '../safe-text.ts';
import type { Entry } from '../store/store.ts';
import { type LoopKind, loopKind, plain, saysDone, taskTitle, whoIn } from './cues.ts';
import { addTask, assertPaReady, checkDay, type PaTask } from './tasks.ts';
import { readWhen, withoutWhen } from './when.ts';

/** Days a loop with no day of its own stays open before it is due a follow-up. */
export const FOLLOW_UP_DAYS = 3;
/** How far back the assistant looks for loops unless told otherwise. */
export const LOOP_DAYS = 30;
/** Coding sessions: "I need to fix the test" there is an instruction to the agent, done in the session. */
const CODING_SOURCES = new Set(['claude-code', 'codex']);

export type LoopState = 'open' | 'done' | 'dropped' | 'snoozed';
export type FoundBy = 'none' | 'local' | 'remote';

export interface Loop {
  /** The entry and a hash of the sentence: stays the same while the sentence does. */
  key: string;
  kind: LoopKind;
  entryId: number;
  /** When the entry was written. */
  date: string;
  /** The thread or note it is in. */
  where: string;
  /** The sentence, as you wrote it. */
  quote: string;
  /** What it asks, as a task title. */
  what: string;
  who: string | null;
  dueDay: string | null;
  state: LoopState;
  /** The later sentence of yours that closed it. */
  closedBy: { entryId: number; date: string; quote: string } | null;
  untilDay: string | null;
  /** Whole days since it was said. */
  age: number;
  /** Open, and past its day or FOLLOW_UP_DAYS old. */
  followUp: boolean;
  taskId: number | null;
  by: FoundBy;
}

/** A sentence of yours, where it sits, and its key. */
export interface Said {
  key: string;
  entry: Entry;
  sentence: string;
}

export interface LoopOptions {
  now: string;
  /** Look back this many days from now; null for the whole record. */
  days?: number | null;
  /** Open loops only (the default), or every loop with its state. */
  include?: 'open' | 'all';
  /** Read only these entries for loops (later entries still close them). */
  only?: Entry[];
}

export function loopKey(entryId: number, sentence: string): string {
  const norm = plain(sentence).replace(/\s+/g, ' ').trim().toLowerCase();
  return `${entryId}-${createHash('sha1').update(norm).digest('hex').slice(0, 10)}`;
}

function entryOfKey(key: string): number {
  const m = /^(\d+)-[0-9a-f]{10}$/.exec(key);
  if (!m) throw new UsageError(`"${key}" is not a loop. Run "skeinwise loops" for the list.`);
  return Number(m[1]);
}

/** The sentences of a body that read as your own words: code blocks and quoted lines left out. */
export function ownSentences(body: string): string[] {
  const text = unlink(body)
    .replace(/```[\s\S]*?```/g, '\n')
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  return sentences(text);
}

/** Your sentences in an entry, with their loop keys. */
export function saidIn(e: Entry): Said[] {
  return ownSentences(e.body).map((sentence) => ({ key: loopKey(e.id, sentence), entry: e, sentence }));
}

/** The entries the assistant reads for loops: yours, vouched for, not from a coding session, inside the window. */
export function loopEntries(record: RecordView, now: string, days: number | null = LOOP_DAYS): Entry[] {
  const from = days === null ? '' : new Date(Date.parse(now) - days * 86_400_000).toISOString();
  return record.entries.filter((e) => e.speaker === 'you' && e.createdAt >= from && vouched(e, now) && !CODING_SOURCES.has(e.sourceKind));
}

interface Base {
  key: string;
  kind: LoopKind;
  entry: Entry;
  quote: string;
  what: string;
  who: string | null;
  dueDay: string | null;
  by: FoundBy;
}

function cueLoop(said: Said): Base | null {
  const kind = loopKind(said.sentence, said.entry.kind === 'message');
  if (!kind) return null;
  const when = readWhen(said.sentence, new Date(said.entry.createdAt));
  return {
    key: said.key,
    kind,
    entry: said.entry,
    quote: safeLine(said.sentence),
    what: safeLine(taskTitle(said.sentence)),
    who: whoIn(said.sentence),
    dueDay: when?.day ?? null,
    by: 'none',
  };
}

interface Verdict {
  key: string;
  entryId: number;
  isLoop: number;
  kind: LoopKind | null;
  what: string | null;
  who: string | null;
  dueDay: string | null;
  engine: 'local' | 'remote';
}

/** For each sentence a model read, the reading of the latest finished run that read it. */
function verdicts(db: DatabaseSync): Map<string, Verdict> {
  const rows = db
    .prepare(
      `SELECT f.key, f.entry_id AS entryId, f.is_loop AS isLoop, f.kind, f.what, f.who, f.due_day AS dueDay, r.engine
       FROM pa_found f JOIN runs r ON r.id = f.run_id
       WHERE r.status = 'done' AND f.run_id = (
         SELECT MAX(f2.run_id) FROM pa_found f2 JOIN runs r2 ON r2.id = f2.run_id WHERE f2.key = f.key AND r2.status = 'done'
       )`,
    )
    .all() as unknown as Verdict[];
  return new Map(rows.map((r) => [r.key, r]));
}

interface Mark {
  status: 'done' | 'dropped' | 'snoozed';
  untilDay: string | null;
}

function tokens(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** The open loops (or all of them), with what you and later entries said about each, follow-ups first. */
export function findLoops(record: RecordView, options: LoopOptions): Loop[] {
  const db = record.store.db;
  assertPaReady(db);
  const now = options.now;
  const today = localDay(new Date(now));
  const entries = options.only ?? loopEntries(record, now, options.days === undefined ? LOOP_DAYS : options.days);
  const read = verdicts(db);

  const bases: Base[] = [];
  for (const e of entries) {
    for (const said of saidIn(e)) {
      const verdict = read.get(said.key);
      if (verdict) {
        if (verdict.isLoop && verdict.kind) {
          bases.push({
            key: said.key,
            kind: verdict.kind,
            entry: e,
            quote: safeLine(said.sentence),
            what: verdict.what ?? safeLine(taskTitle(said.sentence)),
            who: verdict.who,
            dueDay: verdict.dueDay,
            by: verdict.engine,
          });
        }
        continue;
      }
      const loop = cueLoop(said);
      if (loop) bases.push(loop);
    }
  }
  if (!bases.length) return [];

  const marks = new Map(
    (db.prepare('SELECT key, status, until_day AS untilDay FROM pa_loops').all() as unknown as (Mark & { key: string })[]).map((m) => [m.key, m]),
  );
  const tasks = new Map(
    (db.prepare("SELECT id, status, loop_key AS loopKey FROM pa_tasks WHERE loop_key IS NOT NULL").all() as unknown as Pick<PaTask, 'id' | 'status' | 'loopKey'>[]).map((t) => [
      t.loopKey!,
      t,
    ]),
  );
  // Sentences of yours that say something is done, from the first loop's day on.
  const first = bases.reduce((min, b) => (b.entry.createdAt < min ? b.entry.createdAt : min), bases[0]!.entry.createdAt);
  const closers = loopEntries(record, now, null)
    .filter((e) => e.createdAt >= first)
    .flatMap((e) => saidIn(e).filter((s) => saysDone(s.sentence)))
    .map((s) => ({ entryId: s.entry.id, date: s.entry.createdAt, quote: safeLine(s.sentence), words: tokens(s.sentence) }));

  const out: Loop[] = [];
  for (const b of bases) {
    const mark = marks.get(b.key);
    const task = tasks.get(b.key);
    const want = tokens(withoutWhen(b.what, new Date(b.entry.createdAt)));
    const need = Math.min(2, want.size);
    const closedBy =
      need === 0
        ? null
        : (closers.find((c) => c.date > b.entry.createdAt && [...want].filter((w) => c.words.has(w)).length >= need) ?? null);
    let state: LoopState = 'open';
    let followUp = false;
    if (mark?.status === 'snoozed') {
      if (mark.untilDay && mark.untilDay > today) state = 'snoozed';
      else followUp = true;
    } else if (mark) state = mark.status;
    if (task && state === 'open') state = task.status === 'open' ? 'open' : task.status;
    if (!mark && !task && closedBy) state = 'done';
    const age = Math.max(0, Math.floor((Date.parse(now) - Date.parse(b.entry.createdAt)) / 86_400_000));
    if (state === 'open' && ((b.dueDay !== null && b.dueDay <= today) || (b.dueDay === null && age >= FOLLOW_UP_DAYS))) followUp = true;
    if (state !== 'open') followUp = false;
    if (options.include !== 'all' && state !== 'open') continue;
    out.push({
      key: b.key,
      kind: b.kind,
      entryId: b.entry.id,
      date: b.entry.createdAt,
      where: safeLine(b.entry.threadTitle ?? b.entry.title ?? b.entry.sourceLabel),
      quote: b.quote,
      what: b.what,
      who: b.who,
      dueDay: b.dueDay,
      state,
      closedBy: !mark && !task ? closedBy : null,
      untilDay: mark?.status === 'snoozed' ? mark.untilDay : null,
      age,
      followUp,
      taskId: task?.id ?? null,
      by: b.by,
    });
  }
  const rank = (l: Loop) => (l.state === 'open' ? (l.followUp ? 0 : 1) : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
}

/** One loop by its key, in any state and whatever its age. */
export function getLoop(record: RecordView, key: string, now: string): Loop {
  const entryId = entryOfKey(key);
  const entry = record.byId.get(entryId);
  if (!entry) throw new UsageError(`No loop ${key}: its entry is gone or hidden.`);
  const loop = findLoops(record, { now, include: 'all', only: [entry] }).find((l) => l.key === key);
  if (!loop) throw new UsageError(`No loop ${key}: the sentence has changed or isn't a loop. Run "skeinwise loops" for the list.`);
  return loop;
}

/** Marks a loop done, dropped or snoozed until a day; 'open' clears what you said. */
export function setLoopState(record: RecordView, key: string, state: LoopState, untilDay: string | null, now: string): Loop {
  const db = record.store.db;
  const loop = getLoop(record, key, now);
  if (state === 'open') {
    db.prepare('DELETE FROM pa_loops WHERE key = ?').run(key);
  } else {
    const until = state === 'snoozed' ? checkDay(untilDay) : null;
    if (state === 'snoozed' && (!until || until <= localDay(new Date(now)))) throw new UsageError('Snooze a loop to a day that is still to come.');
    db.prepare(
      `INSERT INTO pa_loops (key, entry_id, status, until_day, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET status = excluded.status, until_day = excluded.until_day, updated_at = excluded.updated_at`,
    ).run(key, loop.entryId, state, until, now);
  }
  return getLoop(record, key, now);
}

/** Makes a task from a loop: its title without the "when" words, due on the loop's day. */
export function loopToTask(record: RecordView, key: string, now: string): PaTask {
  const loop = getLoop(record, key, now);
  const title = taskTitle(withoutWhen(loop.what, new Date(loop.date))) || loop.what;
  const notes = `From ${loop.where}, ${loop.date.slice(0, 10)}: "${loop.quote}"`;
  return addTask(record.store.db, { title, notes, dueDay: loop.dueDay, entryId: loop.entryId, loopKey: loop.key, madeBy: loop.by }, now);
}

export interface LoopCounts {
  open: number;
  followUp: number;
}

export function loopCounts(loops: Loop[]): LoopCounts {
  const open = loops.filter((l) => l.state === 'open');
  return { open: open.length, followUp: open.filter((l) => l.followUp).length };
}
