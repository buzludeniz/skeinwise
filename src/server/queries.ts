// Read-only views over the record for the app: the brain's points and lines, an entry with its neighbours, questions
// answered from search and dates, and the plain statistics behind Numbers and You.

import type { DatabaseSync } from 'node:sqlite';
import { posix } from 'node:path';
import type { Entry, SearchHit, Store, Version } from '../store/store.ts';
import { parseQuestion } from '../organiser/ask.ts';
import { findSchema, hubEntryIds, liveHubs, liveLinks, liveTags } from '../organiser/views.ts';
import type { EntryRow } from './buckets.ts';
import { grouping, progress } from './organiser.ts';
import { keyWords, names, words } from './words.ts';

/** Entries that count: from included sources and not in a thread marked "not mine" (as in the store). */
const VISIBLE = `s.status = 'in' AND COALESCE(t.not_mine, 0) = 0`;

export function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** The organiser's tables exist (a record made before 0.2.0 gets them when it is opened). */
export function organiserReady(db: DatabaseSync): boolean {
  return hasTable(db, 'runs');
}

export function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const clean = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * Where an entry sits before the organiser files it: a note in its source's name plus the folders inside it, and
 * everything else in the Inbox. Once a file run has run, the organiser's folders replace this (see entryRows).
 */
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
  const groups = grouping(db);
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
    // After a file run, what it filed nowhere waits in the Inbox.
    folder: groups.folderOf ? (groups.folderOf.get(r.id) ?? 'Inbox') : folderOf(r.kind, r.sourceKind, r.source, r.externalId),
    project: groups.projectOf.get(r.id) ?? null,
    hub: groups.hubOf.get(r.id) ?? null,
    tag: groups.tagOf.get(r.id) ?? null,
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
  /** Every entry, or past BRAIN_POINTS a sample of them (see samplePoints). Threads hold the titles of these points'. */
  points: BrainPoint[];
  // total, counts and a hub's size are always sent; they are optional so data built before them still types.
  /** How many entries the record holds; more than points.length when the brain shows a sample. */
  total?: number;
  /**
   * The whole record's counts, so a legend over a sample still counts the record: by speaker, source, folder and
   * project (each in the order of its list above; `noProject` for entries in none), and by month (0 = January, UTC).
   */
  counts?: { speaker: number[]; source: number[]; folder: number[]; project: number[]; noProject: number; month: number[] };
  /** [from, to, kind]: 0 = note link, 1 = cross link. Only between points in `points`. */
  links: [number, number, number][];
  /** The organiser's concept hubs: `size` entries in all, `entries` those of them in `points` (its spokes). */
  hubs: { id: number; name: string; size?: number; entries: number[] }[];
  organiser: boolean;
}

/**
 * The most points /api/brain sends; past it, a sample, and the page says so. The page draws at most this many anyway,
 * so a big record's first load stays small (1.5 MB gzip at 150,000 entries, plan section 7).
 */
export const BRAIN_POINTS = 20_000;

/** Picks `room` of the indices spread evenly over time, so the sample keeps the record's shape. */
function spread(points: BrainPoint[], indices: number[], room: number): number[] {
  if (indices.length <= room) return indices;
  const byTime = [...indices].sort((a, b) => points[a]![7] - points[b]![7] || a - b);
  return Array.from({ length: room }, (_, k) => byTime[Math.floor((k * byTime.length) / room)]!);
}

/**
 * The indices of the points to send, in record order, or null when they all fit. Notes and files come first, since
 * you wrote or kept them; the room left goes to messages spread evenly over time. A copy of the page's own sampler
 * (samplePoints in web/src/brain/input.ts, on v1/web), which then finds nothing to cut.
 */
export function samplePoints(points: BrainPoint[], cap = BRAIN_POINTS): number[] | null {
  if (points.length <= cap) return null;
  const kept: number[] = [];
  const messages: number[] = [];
  points.forEach((p, i) => (p[1] === 0 ? messages : kept).push(i));
  const first = spread(points, kept, cap);
  return [...first, ...spread(points, messages, cap - first.length)].sort((a, b) => a - b);
}

export function brainData(db: DatabaseSync, cap = BRAIN_POINTS): BrainData {
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
  const projects: string[] = [];
  const pr = new Map<string, number>();
  const all: BrainPoint[] = rows.map((r) => {
    if (!sources.has(r.sourceId)) sources.set(r.sourceId, { id: r.sourceId, label: r.source, kind: r.sourceKind });
    return [
      r.id,
      kindCode[r.kind],
      intern(speakers, sp, r.speaker),
      r.sourceId,
      r.threadId ?? 0,
      intern(folders, fo, r.folder),
      r.project === null ? -1 : intern(projects, pr, r.project),
      Date.parse(r.createdAt),
      r.title.length > 90 ? `${r.title.slice(0, 89)}…` : r.title,
    ];
  });
  const sourceList = [...sources.values()];
  const counts = {
    speaker: speakers.map(() => 0),
    source: sourceList.map(() => 0),
    folder: folders.map(() => 0),
    project: projects.map(() => 0),
    noProject: 0,
    month: Array.from({ length: 12 }, () => 0),
  };
  const sourceAt = new Map(sourceList.map((src, i) => [src.id, i]));
  for (const p of all) {
    counts.speaker[p[2]]!++;
    counts.source[sourceAt.get(p[3])!]!++;
    counts.folder[p[5]]!++;
    if (p[6] >= 0) counts.project[p[6]]!++;
    else counts.noProject++;
    if (Number.isFinite(p[7])) counts.month[new Date(p[7]).getUTCMonth()]!++;
  }
  const keep = samplePoints(all, cap);
  const points = keep ? keep.map((i) => all[i]!) : all;
  for (const i of keep ?? rows.keys()) {
    const r = rows[i]!;
    if (r.threadId && r.threadTitle !== null) threads[r.threadId] = r.threadTitle;
  }
  const ready = organiserReady(db);
  const visible = new Set(rows.map((r) => r.id));
  const shown = keep ? new Set(points.map((p) => p[0])) : visible;
  // Note links come from your [[links]] whatever has run; cross links from the organiser's link task.
  const links: [number, number, number][] = [];
  for (const [a, b] of noteLinks(db)) if (shown.has(a) && shown.has(b)) links.push([a, b, 0]);
  if (ready) for (const l of liveLinks(db)) if (l.kind === 'cross' && shown.has(l.from) && shown.has(l.to)) links.push([l.from, l.to, 1]);
  const hubs = ready
    ? liveHubs(db)
        .map((h) => {
          const ids = hubEntryIds(db, h.id).filter((id) => visible.has(id));
          return { id: h.id, name: h.name, size: ids.length, entries: keep ? ids.filter((id) => shown.has(id)) : ids };
        })
        .filter((h) => h.size)
    : [];
  return {
    kinds: ['message', 'note', 'file'],
    speakers,
    sources: sourceList,
    folders,
    projects,
    threads,
    points,
    total: all.length,
    counts,
    links,
    hubs,
    organiser: ready,
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

/** Is this text a question rather than words to search for? The organiser's ask reads the same patterns. */
export function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text) || (text.trim() !== '' && parseQuestion(text).kind !== 'any');
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
  /** Null until the organiser has run. */
  hubs: number | null;
  first: string | null;
  last: string | null;
  byMonth: { month: string; entries: number }[];
  bySource: { label: string; entries: number }[];
  bySpeaker: { speaker: string; entries: number }[];
  /** Shares of entries the organiser has reached; null until it has run. */
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
  const visible = new Set((db.prepare(`SELECT e.id ${from}`).all() as { id: number }[]).map((r) => r.id));
  const shares = progress(db, visible);
  return {
    entries: s.entries,
    threads: s.threads,
    notes: kind('note'),
    messages: kind('message'),
    files: kind('file'),
    sources: s.sources,
    yours: s.yours,
    assistants: s.entries - s.yours,
    hubs: shares ? liveHubs(db).length : null,
    first: s.first,
    last: s.last,
    byMonth: s.byMonth,
    bySource,
    bySpeaker,
    organiser: shares,
  };
}

export interface YouLine {
  label: string;
  count: number;
  first: string;
  last: string;
  ids: number[];
}

/** Your projects: the organiser's Projects tags over the entries you can see. Empty until it has tagged. */
function projectLines(db: DatabaseSync): YouLine[] {
  const schema = organiserReady(db) ? findSchema(db, 'Projects') : undefined;
  const tags = schema ? liveTags(db, schema.id) : [];
  if (!tags.length) return [];
  const dates = new Map(
    (
      db
        .prepare(`SELECT e.id, e.created_at AS createdAt FROM entries e JOIN sources s ON s.id = e.source_id LEFT JOIN threads t ON t.id = e.thread_id WHERE ${VISIBLE}`)
        .all() as unknown as { id: number; createdAt: string }[]
    ).map((r) => [r.id, r.createdAt]),
  );
  const lines: YouLine[] = [];
  for (const tag of tags) {
    const held = tag.entryIds.filter((id) => dates.has(id)).sort((a, b) => dates.get(a)!.localeCompare(dates.get(b)!) || a - b);
    if (!held.length) continue;
    lines.push({ label: tag.name, count: held.length, first: dates.get(held[0]!)!, last: dates.get(held.at(-1)!)!, ids: held.slice(0, 40) });
  }
  return lines.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 12);
}

/**
 * What your own words return to: the words and names in entries you wrote, with first and latest dates; and your
 * projects, once the organiser has tagged them.
 */
export function aboutYou(store: Store): { words: YouLine[]; names: YouLine[]; projects: YouLine[]; entries: number } {
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
    projects: projectLines(store.db),
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
