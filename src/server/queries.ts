// Read-only views over the record for the app: the brain's points and lines, an entry with its neighbours, questions
// answered from search and dates, and the plain statistics behind Numbers and You.

import type { DatabaseSync } from 'node:sqlite';
import { posix } from 'node:path';
import type { Entry, SearchHit, Store, Version } from '../store/store.ts';
import type { EntryRow } from './buckets.ts';
import { keyWords, names, words } from './words.ts';

/** Entries that count: from included sources and not in a thread marked "not mine" (as in the store). */
const VISIBLE = `s.status = 'in' AND COALESCE(t.not_mine, 0) = 0`;

export function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** The organiser's tables arrive with a later schema; until then hubs, folders, runs and review are empty. */
export function organiserReady(db: DatabaseSync): boolean {
  return hasTable(db, 'runs');
}

export function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const clean = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Where a note sits: its source's name plus the folders inside it. Messages wait in the Inbox until filed. */
export function folderOf(kind: string, sourceKind: string, sourceLabel: string, externalId: string): string {
  if (kind === 'message' || sourceKind !== 'notes') return 'Inbox';
  const dir = posix.dirname(externalId.replaceAll('\\', '/'));
  return dir === '.' ? sourceLabel : `${sourceLabel}/${dir}`;
}

interface RawRow {
  id: number;
  kind: EntryRow['kind'];
  speaker: string;
  sourceId: number;
  source: string;
  sourceKind: string;
  threadId: number | null;
  threadTitle: string | null;
  externalId: string;
  title: string | null;
  createdAt: string;
  head: string;
}

/** Every visible entry with the properties the views group by, oldest first. */
export function entryRows(db: DatabaseSync): (EntryRow & { threadTitle: string | null })[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.speaker, e.source_id AS sourceId, s.label AS source, s.kind AS sourceKind,
              e.thread_id AS threadId, t.title AS threadTitle, e.external_id AS externalId, e.title,
              e.created_at AS createdAt, substr(v.body, 1, 200) AS head
       FROM entries e
       JOIN versions v ON v.entry_id = e.id AND v.version = e.version
       JOIN sources s ON s.id = e.source_id
       LEFT JOIN threads t ON t.id = e.thread_id
       WHERE ${VISIBLE}
       ORDER BY e.created_at, e.id`,
    )
    .all() as unknown as RawRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    speaker: r.speaker,
    sourceId: r.sourceId,
    source: r.source,
    sourceKind: r.sourceKind,
    threadId: r.threadId,
    threadTitle: r.threadTitle,
    folder: folderOf(r.kind, r.sourceKind, r.source, r.externalId),
    project: null,
    hub: null,
    tag: null,
    createdAt: r.createdAt,
    title: r.title?.trim() || firstLine(r.head) || '(empty)',
  }));
}

/** Note links: a [[Title]] in one visible note that names another visible note. */
export function noteLinks(db: DatabaseSync): [number, number][] {
  const notes = db
    .prepare(
      `SELECT e.id, e.title, e.external_id AS externalId, v.body
       FROM entries e
       JOIN versions v ON v.entry_id = e.id AND v.version = e.version
       JOIN sources s ON s.id = e.source_id
       LEFT JOIN threads t ON t.id = e.thread_id
       WHERE e.kind = 'note' AND ${VISIBLE}
       ORDER BY e.id`,
    )
    .all() as unknown as { id: number; title: string | null; externalId: string; body: string }[];
  const byName = new Map<string, number>();
  for (const n of notes) {
    const file = posix.basename(n.externalId.replaceAll('\\', '/')).replace(/\.(md|markdown|txt)$/i, '');
    for (const key of [n.title, file]) if (key && !byName.has(key.toLowerCase())) byName.set(key.toLowerCase(), n.id);
  }
  const links: [number, number][] = [];
  for (const n of notes) {
    const seen = new Set<number>();
    for (const m of n.body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      const to = byName.get(m[1]!.trim().toLowerCase());
      if (to !== undefined && to !== n.id && !seen.has(to)) {
        seen.add(to);
        links.push([n.id, to]);
      }
    }
  }
  return links;
}

/** Codes keep the brain's payload small: one row per point. */
export type BrainPoint = [
  id: number,
  kind: 0 | 1 | 2,
  speaker: number,
  source: number,
  thread: number,
  folder: number,
  project: number,
  time: number,
  label: string,
];

export interface BrainData {
  kinds: ['message', 'note', 'file'];
  speakers: string[];
  sources: { id: number; label: string; kind: string }[];
  folders: string[];
  projects: string[];
  threads: Record<string, string>;
  points: BrainPoint[];
  /** [from, to, kind]: 0 = note link. */
  links: [number, number, number][];
  organiser: boolean;
}

export function brainData(db: DatabaseSync): BrainData {
  const rows = entryRows(db);
  const speakers: string[] = [];
  const folders: string[] = [];
  const sp = new Map<string, number>();
  const fo = new Map<string, number>();
  const intern = (list: string[], map: Map<string, number>, v: string) => {
    let i = map.get(v);
    if (i === undefined) {
      i = list.length;
      list.push(v);
      map.set(v, i);
    }
    return i;
  };
  const sources = new Map<number, { id: number; label: string; kind: string }>();
  const threads: Record<string, string> = {};
  const kindCode = { message: 0, note: 1, file: 2 } as const;
  const points: BrainPoint[] = rows.map((r) => {
    if (!sources.has(r.sourceId)) sources.set(r.sourceId, { id: r.sourceId, label: r.source, kind: r.sourceKind });
    if (r.threadId && r.threadTitle !== null) threads[r.threadId] = r.threadTitle;
    return [
      r.id,
      kindCode[r.kind],
      intern(speakers, sp, r.speaker),
      r.sourceId,
      r.threadId ?? 0,
      intern(folders, fo, r.folder),
      -1,
      Date.parse(r.createdAt),
      r.title.length > 90 ? `${r.title.slice(0, 89)}…` : r.title,
    ];
  });
  return {
    kinds: ['message', 'note', 'file'],
    speakers,
    sources: [...sources.values()],
    folders,
    projects: [],
    threads,
    points,
    links: noteLinks(db).map(([a, b]) => [a, b, 0]),
    organiser: organiserReady(db),
  };
}

export interface EntryDetail {
  entry: Entry;
  history: Version[];
  editedByAgent: string | null;
  thread: { id: number; title: string; notMine: boolean; entries: number } | null;
  before: Brief | null;
  after: Brief | null;
  similar: Brief[];
}

export interface Brief {
  id: number;
  kind: string;
  speaker: string;
  title: string;
  createdAt: string;
  sourceLabel: string;
  threadTitle: string | null;
}

export function brief(e: Entry | SearchHit): Brief {
  return {
    id: e.id,
    kind: e.kind,
    speaker: e.speaker,
    title: e.title?.trim() || firstLine(e.body),
    createdAt: e.createdAt,
    sourceLabel: e.sourceLabel,
    threadTitle: e.threadTitle,
  };
}

const HUMAN_EDITORS = new Set(['import', 'you']);

/** One entry with its versions, its place in its thread (or in time) and the entries most like it. */
export function entryDetail(store: Store, id: number): EntryDetail | undefined {
  const entry = store.getEntry(id);
  if (!entry) return undefined;
  const history = store.history(id);
  const agent = [...history].reverse().find((v) => !HUMAN_EDITORS.has(v.editor));
  let before: Entry | undefined;
  let after: Entry | undefined;
  let thread: EntryDetail['thread'] = null;
  if (entry.threadId) {
    const t = store.getThread(entry.threadId);
    if (t) thread = { id: t.id, title: t.title, notMine: t.notMine, entries: t.entries };
    const all = store.threadEntries(entry.threadId);
    const at = all.findIndex((e) => e.id === id);
    before = all[at - 1];
    after = all[at + 1];
  } else {
    const near = (op: '<' | '>', order: 'DESC' | 'ASC') =>
      store.db
        .prepare(
          `SELECT e.id FROM entries e JOIN sources s ON s.id = e.source_id LEFT JOIN threads t ON t.id = e.thread_id
           WHERE ${VISIBLE} AND (e.created_at ${op} ? OR (e.created_at = ? AND e.id ${op} ?))
           ORDER BY e.created_at ${order}, e.id ${order} LIMIT 1`,
        )
        .get(entry.createdAt, entry.createdAt, id) as { id: number } | undefined;
    const b = near('<', 'DESC');
    const a = near('>', 'ASC');
    before = b && store.getEntry(b.id);
    after = a && store.getEntry(a.id);
  }
  return {
    entry,
    history,
    editedByAgent: agent ? agent.editor : null,
    thread,
    before: before ? brief(before) : null,
    after: after ? brief(after) : null,
    similar: similar(store, entry),
  };
}

/** Entries sharing the most telling words of this one, best first. */
export function similar(store: Store, entry: Entry, limit = 5): Brief[] {
  const terms = keyWords(`${entry.title ?? ''} ${entry.body.slice(0, 1200)}`);
  if (!terms.length) return [];
  const hits = store.search(terms.join(' '), { limit: limit + 8 });
  const skip = new Set([entry.id]);
  const out: Brief[] = [];
  for (const h of hits) {
    if (skip.has(h.id)) continue;
    // Skip the entry's own neighbours in its thread: those already show as before and after.
    if (entry.threadId && h.threadId === entry.threadId) continue;
    skip.add(h.id);
    out.push(brief(h));
    if (out.length >= limit) break;
  }
  return out;
}

export interface AskView {
  question: string;
  pattern: 'first' | 'decide' | 'changed' | 'plain';
  terms: string;
  /** Your own words first, then the rest; each group by date. */
  entries: (Brief & { snippet: string })[];
  first: string | null;
  last: string | null;
}

const PATTERNS: [AskView['pattern'], RegExp][] = [
  ['first', /^\s*when\s+did\s+i\s+(?:first\s+)?(?:mention|talk\s+about|write\s+about|bring\s+up|start\s+on|think\s+about)\s+(.+?)\??\s*$/i],
  ['decide', /^\s*what\s+did\s+(?:i|we)\s+decide\s+(?:about|on)\s+(.+?)\??\s*$/i],
  ['changed', /^\s*what\s+changed\s+in\s+my\s+thinking\s+(?:on|about)\s+(.+?)\??\s*$/i],
];

/** Is this text a question rather than words to search for? */
export function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text) || PATTERNS.some(([, re]) => re.test(text));
}

/** A question answered as a view of your own entries, built from search and dates alone (the No-AI reading). */
export function askView(store: Store, question: string): AskView {
  let pattern: AskView['pattern'] = 'plain';
  let terms = question.replace(/\?+\s*$/, '');
  for (const [p, re] of PATTERNS) {
    const m = re.exec(question);
    if (m) {
      pattern = p;
      terms = m[1]!;
      break;
    }
  }
  if (pattern === 'decide') terms = `${terms} decided`;
  let hits = store.search(terms, { limit: 60 });
  if (pattern === 'decide') {
    // "decided" only helps rank: keep the hits about the subject itself.
    const subject = new Set(words(terms.replace(/\bdecided\b/, '')));
    hits = hits.filter((h) => words(`${h.title ?? ''} ${h.body}`).some((w) => subject.has(w)));
  }
  const yours = hits.filter((h) => h.speaker !== 'assistant');
  const theirs = hits.filter((h) => h.speaker === 'assistant');
  const byDate = (a: SearchHit, b: SearchHit) => a.createdAt.localeCompare(b.createdAt);
  const ordered = pattern === 'plain' ? [...yours, ...theirs] : [...yours.sort(byDate), ...theirs.sort(byDate)];
  const dates = hits.map((h) => h.createdAt).sort();
  return {
    question,
    pattern,
    terms: terms.trim(),
    entries: ordered.slice(0, 30).map((h) => ({ ...brief(h), snippet: h.snippet })),
    first: dates[0] ?? null,
    last: dates.at(-1) ?? null,
  };
}

export interface Numbers {
  entries: number;
  threads: number;
  notes: number;
  messages: number;
  files: number;
  sources: number;
  yours: number;
  assistants: number;
  hubs: number | null;
  first: string | null;
  last: string | null;
  byMonth: { month: string; entries: number }[];
  bySource: { label: string; entries: number }[];
  bySpeaker: { speaker: string; entries: number }[];
  /** Shares of entries the organiser has reached; null until its tables exist. */
  organiser: { tagged: number; filed: number; summarised: number } | null;
}

export function numbers(store: Store): Numbers {
  const s = store.stats();
  const db = store.db;
  const from = `FROM entries e JOIN sources s ON s.id = e.source_id LEFT JOIN threads t ON t.id = e.thread_id WHERE ${VISIBLE}`;
  const kinds = db.prepare(`SELECT e.kind AS kind, COUNT(*) AS n ${from} GROUP BY e.kind`).all() as unknown as {
    kind: string;
    n: number;
  }[];
  const kind = (k: string) => kinds.find((r) => r.kind === k)?.n ?? 0;
  const bySource = db
    .prepare(`SELECT s.label AS label, COUNT(*) AS entries ${from} GROUP BY s.id ORDER BY entries DESC`)
    .all() as unknown as Numbers['bySource'];
  const bySpeaker = db
    .prepare(`SELECT e.speaker AS speaker, COUNT(*) AS entries ${from} GROUP BY e.speaker ORDER BY entries DESC`)
    .all() as unknown as Numbers['bySpeaker'];
  return {
    entries: s.entries,
    threads: s.threads,
    notes: kind('note'),
    messages: kind('message'),
    files: kind('file'),
    sources: s.sources,
    yours: s.yours,
    assistants: s.entries - s.yours,
    hubs: null,
    first: s.first,
    last: s.last,
    byMonth: s.byMonth,
    bySource,
    bySpeaker,
    organiser: null,
  };
}

export interface YouLine {
  label: string;
  count: number;
  first: string;
  last: string;
  ids: number[];
}

/** What your own words return to: the words and names in entries you wrote, with first and latest dates. */
export function aboutYou(store: Store): { words: YouLine[]; names: YouLine[]; entries: number } {
  const rows = store.db
    .prepare(
      `SELECT e.id, e.created_at AS createdAt, COALESCE(e.title, '') AS title, v.body
       FROM entries e
       JOIN versions v ON v.entry_id = e.id AND v.version = e.version
       JOIN sources s ON s.id = e.source_id
       LEFT JOIN threads t ON t.id = e.thread_id
       WHERE ${VISIBLE} AND e.speaker = 'you'
       ORDER BY e.created_at, e.id`,
    )
    .all() as unknown as { id: number; createdAt: string; title: string; body: string }[];
  const tally = (pick: (text: string) => string[]) => {
    const map = new Map<string, YouLine>();
    for (const r of rows) {
      for (const label of new Set(pick(`${r.title}\n${r.body}`))) {
        const line = map.get(label);
        if (line) {
          line.count += 1;
          line.last = r.createdAt;
          if (line.ids.length < 40) line.ids.push(r.id);
        } else map.set(label, { label, count: 1, first: r.createdAt, last: r.createdAt, ids: [r.id] });
      }
    }
    return [...map.values()].filter((l) => l.count >= 2).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const nameLines = tally(names).slice(0, 12);
  const nameWords = new Set(nameLines.map((n) => n.label.toLowerCase()));
  return {
    words: tally((t) => words(t).filter((w) => w.length >= 4)).filter((w) => !nameWords.has(w.label)).slice(0, 16),
    names: nameLines,
    entries: rows.length,
  };
}

/** The last time something reached the record: a source added, or an edit or new note saved here. */
export function lastSaved(db: DatabaseSync): string | null {
  const row = db
    .prepare(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(added_at) AS at FROM sources
         UNION ALL SELECT MAX(edited_at) FROM versions WHERE editor <> 'import')`,
    )
    .get() as { at: string | null };
  return row.at;
}
