// The daily brief: what came into your record since the last brief. The No-AI brief counts what is new, names the
// threads and notes you worked on, and quotes what you decided, the loops you opened and the questions you left in
// your notes, each pointing at its entry. A model brief (src/pa/model.ts) adds a few written lines on top, each
// citing the entries it rests on. Briefs are kept, so the next one starts where this one ended.

import type { DatabaseSync } from 'node:sqlite';
import { UsageError } from '../errors.ts';
import { localDay } from '../notes.ts';
import { DECISION_CUES, isQuestion } from '../organiser/cues.ts';
import type { RecordView } from '../organiser/record.ts';
import { currentMark } from '../organiser/runs.ts';
import { safeLine } from '../safe-text.ts';
import type { Entry } from '../store/store.ts';
import { plain } from './cues.ts';
import { findLoops, loopCounts, loopKey, ownSentences, saidIn } from './loops.ts';
import { assertPaReady, type TaskCounts, taskCounts } from './tasks.ts';

const DAY_MS = 86_400_000;
/** An entry imported now but written more than this before the last brief counts as older, not new. */
const LATE_SLACK_MS = DAY_MS;
const MAX_THREADS = 6;
const MAX_DECIDED = 5;
const MAX_LOOPS = 5;
const MAX_QUESTIONS = 3;

export type BriefEngine = 'none' | 'local' | 'remote';

export interface BriefQuote {
  entryId: number;
  quote: string;
  where: string;
}

export interface BriefBody {
  /** The window: entries written or changed from `since` on. */
  since: string;
  until: string;
  counts: {
    entries: number;
    yours: number;
    threads: number;
    notes: number;
    /** Entries that were there before and changed. */
    edited: number;
    /** Entries brought in by an import or sync but written long before the window. */
    older: number;
  };
  older: { source: string; entries: number }[];
  threads: { entryId: number; title: string; source: string; entries: number }[];
  decided: BriefQuote[];
  loops: (BriefQuote & { key: string; kind: string; what: string })[];
  questions: BriefQuote[];
  /** Open loops of the last 30 days due a follow-up, and your tasks, as of the brief. */
  followUps: number;
  tasks: TaskCounts;
  /** A model's written lines, each citing entry ids. Empty in a No-AI brief. */
  lines: { text: string; cites: number[] }[];
}

export interface Brief {
  id: number;
  day: string;
  fromMark: number;
  toMark: number;
  engine: BriefEngine;
  model: string | null;
  runId: number | null;
  createdAt: string;
  body: BriefBody;
}

export interface BriefOptions {
  now: string;
  /** Cover from this moment instead of from the last brief. */
  since?: string;
}

/** What a brief covers: the new versions, and from when. */
export interface BriefWindow {
  fromMark: number;
  toMark: number;
  since: string;
  /** Version 1s written before this are older entries brought in late. */
  cutoff: string;
}

interface BriefRow {
  id: number;
  day: string;
  fromMark: number;
  toMark: number;
  engine: BriefEngine;
  model: string | null;
  runId: number | null;
  createdAt: string;
  body: string;
}

const BRIEF_COLUMNS = 'id, day, from_mark AS fromMark, to_mark AS toMark, engine, model, run_id AS runId, created_at AS createdAt, body';

function toBrief(row: BriefRow): Brief {
  return { ...row, body: JSON.parse(row.body) as BriefBody };
}

export function latestBrief(db: DatabaseSync): Brief | null {
  assertPaReady(db);
  const row = db.prepare(`SELECT ${BRIEF_COLUMNS} FROM pa_briefs ORDER BY id DESC LIMIT 1`).get() as BriefRow | undefined;
  return row ? toBrief(row) : null;
}

export function listBriefs(db: DatabaseSync, limit = 30): Brief[] {
  assertPaReady(db);
  return (db.prepare(`SELECT ${BRIEF_COLUMNS} FROM pa_briefs ORDER BY id DESC LIMIT ?`).all(limit) as unknown as BriefRow[]).map(toBrief);
}

/** Entries with a version newer than the last brief (or every entry, before the first). */
export function newSinceBrief(db: DatabaseSync): number {
  const last = latestBrief(db);
  return Number((db.prepare('SELECT COUNT(DISTINCT entry_id) AS n FROM versions WHERE id > ?').get(last?.toMark ?? 0) as { n: number }).n);
}

export function briefWindow(db: DatabaseSync, options: BriefOptions): BriefWindow {
  const toMark = currentMark(db);
  if (options.since !== undefined) {
    const t = Date.parse(options.since);
    if (!/^\d{4}-\d{2}-\d{2}/.test(options.since) || Number.isNaN(t)) throw new UsageError(`"${options.since}" is not a moment. Write it as YYYY-MM-DD or an ISO date and time.`);
    if (t > Date.parse(options.now)) throw new UsageError('A brief covers the past: give a moment before now.');
    const since = new Date(t).toISOString();
    return { fromMark: 0, toMark, since, cutoff: since };
  }
  const last = latestBrief(db);
  if (!last) {
    const since = new Date(Date.parse(options.now) - DAY_MS).toISOString();
    return { fromMark: 0, toMark, since, cutoff: since };
  }
  return { fromMark: last.toMark, toMark, since: last.createdAt, cutoff: new Date(Date.parse(last.createdAt) - LATE_SLACK_MS).toISOString() };
}

interface Changed {
  entry: Entry;
  /** The sentences that weren't in the entry before the window. */
  fresh: string[];
  edited: boolean;
}

function where(e: Entry): string {
  return safeLine(e.threadTitle ?? e.title ?? e.sourceLabel);
}

const norm = (s: string) => plain(s).replace(/\s+/g, ' ').trim().toLowerCase();

/** The entries a brief covers, with the sentences each gained, and the older entries counted by source. */
export function briefChanges(record: RecordView, win: BriefWindow, now: string): { changed: Changed[]; older: Map<string, number> } {
  const db = record.store.db;
  const rows = db
    .prepare(
      `SELECT entry_id AS entryId, MIN(id) AS firstId, MIN(version) AS firstVersion, MAX(edited_at) AS editedAt
       FROM versions WHERE id > ? AND id <= ? ${win.fromMark === 0 ? 'AND edited_at >= ?' : ''}
       GROUP BY entry_id`,
    )
    .all(...(win.fromMark === 0 ? [win.fromMark, win.toMark, win.since] : [win.fromMark, win.toMark])) as unknown as {
    entryId: number;
    firstId: number;
    firstVersion: number;
    editedAt: string;
  }[];
  const before = db.prepare('SELECT body FROM versions WHERE entry_id = ? AND id < ? ORDER BY id DESC LIMIT 1');
  const changed: Changed[] = [];
  const older = new Map<string, number>();
  const until = Date.parse(now);
  for (const row of rows) {
    const entry = record.byId.get(row.entryId);
    if (!entry || Date.parse(entry.createdAt) > until + DAY_MS) continue;
    if (row.firstVersion === 1 && row.editedAt < win.cutoff) {
      older.set(entry.sourceLabel, (older.get(entry.sourceLabel) ?? 0) + 1);
      continue;
    }
    const prev = before.get(row.entryId, row.firstId) as { body: string } | undefined;
    const had = new Set(prev ? ownSentences(prev.body).map(norm) : []);
    changed.push({ entry, fresh: saidIn(entry).map((s) => s.sentence).filter((s) => !had.has(norm(s))), edited: !!prev });
  }
  changed.sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.entry.id - b.entry.id);
  return { changed, older };
}

/** The No-AI brief's body for a window. */
export function briefBody(record: RecordView, win: BriefWindow, now: string): BriefBody {
  const db = record.store.db;
  const { changed, older } = briefChanges(record, win, now);
  const yours = changed.filter((c) => c.entry.speaker === 'you');

  const units = new Map<string, { entryId: number; title: string; source: string; entries: number; last: string }>();
  for (const c of changed) {
    const key = c.entry.threadId ? `t${c.entry.threadId}` : `e${c.entry.id}`;
    const u = units.get(key) ?? { entryId: c.entry.id, title: where(c.entry), source: safeLine(c.entry.sourceLabel), entries: 0, last: '' };
    u.entries++;
    if (c.entry.createdAt >= u.last) {
      u.last = c.entry.createdAt;
      u.entryId = c.entry.id;
    }
    units.set(key, u);
  }
  const threads = [...units.values()]
    .sort((a, b) => b.entries - a.entries || b.last.localeCompare(a.last))
    .slice(0, MAX_THREADS)
    .map(({ entryId, title, source, entries }) => ({ entryId, title, source, entries }));

  const decided: BriefQuote[] = [];
  const questions: BriefQuote[] = [];
  for (const c of [...yours].reverse()) {
    for (const s of c.fresh) {
      if (decided.length < MAX_DECIDED && DECISION_CUES.test(s) && !isQuestion(s)) decided.push({ entryId: c.entry.id, quote: safeLine(s), where: where(c.entry) });
      else if (questions.length < MAX_QUESTIONS && c.entry.kind === 'note' && isQuestion(s)) questions.push({ entryId: c.entry.id, quote: safeLine(s), where: where(c.entry) });
    }
  }

  const freshKeys = new Set(yours.flatMap((c) => c.fresh.map((s) => loopKey(c.entry.id, s))));
  const loops = findLoops(record, { now, only: yours.map((c) => c.entry) })
    .filter((l) => freshKeys.has(l.key))
    .slice(0, MAX_LOOPS)
    .map((l) => ({ entryId: l.entryId, quote: l.quote, where: l.where, key: l.key, kind: l.kind, what: l.what }));

  return {
    since: win.since,
    until: now,
    counts: {
      entries: changed.length,
      yours: yours.length,
      threads: new Set(changed.filter((c) => c.entry.threadId).map((c) => c.entry.threadId)).size,
      notes: changed.filter((c) => c.entry.kind === 'note').length,
      edited: changed.filter((c) => c.edited).length,
      older: [...older.values()].reduce((a, b) => a + b, 0),
    },
    older: [...older].map(([source, entries]) => ({ source: safeLine(source), entries })).sort((a, b) => b.entries - a.entries),
    threads,
    decided,
    loops,
    questions,
    followUps: loopCounts(findLoops(record, { now })).followUp,
    tasks: taskCounts(db, localDay(new Date(now)), now),
    lines: [],
  };
}

export interface SaveBrief {
  win: BriefWindow;
  body: BriefBody;
  engine: BriefEngine;
  model?: string | null;
  runId?: number | null;
  now: string;
}

export function saveBrief(db: DatabaseSync, b: SaveBrief): Brief {
  const res = db
    .prepare('INSERT INTO pa_briefs (day, from_mark, to_mark, engine, model, run_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(localDay(new Date(b.now)), b.win.fromMark, b.win.toMark, b.engine, b.model ?? null, b.runId ?? null, JSON.stringify(b.body), b.now);
  return toBrief(db.prepare(`SELECT ${BRIEF_COLUMNS} FROM pa_briefs WHERE id = ?`).get(Number(res.lastInsertRowid)) as unknown as BriefRow);
}

/** Makes and keeps a No-AI brief of what came in since the last one (or since `options.since`). */
export function makeBrief(record: RecordView, options: BriefOptions): Brief {
  assertPaReady(record.store.db);
  const win = briefWindow(record.store.db, options);
  return saveBrief(record.store.db, { win, body: briefBody(record, win, options.now), engine: 'none', now: options.now });
}

/** A brief as plain text, for the command line. Entry ids in brackets open with "skeinwise show". */
export function briefText(brief: Brief): string {
  const b = brief.body;
  const c = b.counts;
  const out: string[] = [];
  const at = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  out.push(`Brief ${brief.id}, ${brief.day}: since ${at(b.since)} UTC${brief.engine === 'none' ? ' (No-AI)' : ` (${brief.engine}${brief.model ? `, ${brief.model}` : ''})`}`);
  if (!c.entries && !c.older) out.push('Nothing new since the last brief.');
  else {
    out.push(
      `${c.entries} new or changed ${c.entries === 1 ? 'entry' : 'entries'} (${c.yours} yours, ${c.notes} ${c.notes === 1 ? 'note' : 'notes'}, ${c.threads} ${c.threads === 1 ? 'thread' : 'threads'}, ${c.edited} edited).`,
    );
    if (c.older) out.push(`Also brought in: ${b.older.map((o) => `${o.entries} older from ${o.source}`).join(', ')}.`);
  }
  for (const l of b.lines) out.push(`  ${l.text}${l.cites.length ? ` [${l.cites.join(', ')}]` : ''}`);
  const section = (title: string, rows: string[]) => {
    if (rows.length) out.push('', title, ...rows.map((r) => `  ${r}`));
  };
  section('Worked on', b.threads.map((t) => `${t.title} (${t.source}, ${t.entries}) [${t.entryId}]`));
  section('Decided', b.decided.map((d) => `"${d.quote}" [${d.entryId}]`));
  section('New loops', b.loops.map((l) => `${l.what} (${l.kind}) [${l.entryId}]`));
  section('Questions you left', b.questions.map((q) => `"${q.quote}" [${q.entryId}]`));
  const t = b.tasks;
  out.push(
    '',
    `Open: ${t.open} ${t.open === 1 ? 'task' : 'tasks'}${t.overdue ? `, ${t.overdue} overdue` : ''}${t.dueToday ? `, ${t.dueToday} due today` : ''}${t.remindersDue ? `, ${t.remindersDue} ${t.remindersDue === 1 ? 'reminder' : 'reminders'} due` : ''}; ${b.followUps} ${b.followUps === 1 ? 'loop' : 'loops'} to follow up.`,
  );
  return out.join('\n');
}
