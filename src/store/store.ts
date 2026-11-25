import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { inTransaction } from './db.ts';

export type EntryKind = 'message' | 'note' | 'file';

export interface EntryInput {
  externalId: string;
  kind: EntryKind;
  /** 'you', 'assistant', or a named person. */
  speaker: string;
  title?: string | null;
  createdAt: string;
  body: string;
  seq?: number;
}

export interface ThreadInput {
  externalId: string;
  title: string;
  startedAt?: string;
  entries: EntryInput[];
}

export interface SourceInput {
  kind: string;
  label: string;
  /** Path for folders; '' for account exports, so every export of one account is one source. */
  location?: string;
  /** Whose words the source's 'you' entries are: 'you' or another person's name. */
  owner?: string;
}

export interface ImportBatch {
  source: SourceInput;
  threads: ThreadInput[];
  entries?: EntryInput[];
}

export interface ImportResult {
  added: number;
  versioned: number;
  unchanged: number;
  skipped: number;
  threads: number;
}

export interface Entry {
  id: number;
  sourceId: number;
  sourceKind: string;
  sourceLabel: string;
  threadId: number | null;
  threadTitle: string | null;
  externalId: string;
  kind: EntryKind;
  speaker: string;
  title: string | null;
  createdAt: string;
  seq: number;
  version: number;
  body: string;
}

export interface Version {
  version: number;
  body: string;
  contentHash: string;
  editor: string;
  editedAt: string;
}

export interface SearchHit extends Entry {
  snippet: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  speaker?: string;
  sourceKind?: string;
  from?: string;
  to?: string;
  /** Only entries holding every word; no fill-up with entries holding some of them. */
  strict?: boolean;
}

export interface Source {
  id: number;
  kind: string;
  label: string;
  location: string;
  owner: string;
  status: 'in' | 'out' | 'later';
  addedAt: string;
  entries: number;
}

export interface Thread {
  id: number;
  sourceId: number;
  title: string;
  startedAt: string;
  notMine: boolean;
  entries: number;
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

export function hashText(text: string): string {
  return createHash('sha256').update(normalizeText(text)).digest('hex');
}

const ENTRY_SELECT = `
  SELECT e.id, e.source_id AS sourceId, s.kind AS sourceKind, s.label AS sourceLabel,
         e.thread_id AS threadId, t.title AS threadTitle, e.external_id AS externalId, e.kind,
         e.speaker, e.title, e.created_at AS createdAt, e.seq, e.version, v.body
  FROM entries e
  JOIN versions v ON v.entry_id = e.id AND v.version = e.version
  JOIN sources s ON s.id = e.source_id
  LEFT JOIN threads t ON t.id = e.thread_id`;

/** Entries that count: from included sources and not in a thread marked "not mine". */
const VISIBLE = `s.status = 'in' AND COALESCE(t.not_mine, 0) = 0`;

const STOP_WORDS = new Set(
  'a an and are as at be but by did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with you your about'.split(
    ' ',
  ),
);

/** Turns free text into an FTS5 query. Returns null when nothing searchable is left. */
export function toMatchQuery(query: string, mode: 'all' | 'any' = 'all'): string | null {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const kept = words.filter((w) => !STOP_WORDS.has(w));
  const terms = kept.length ? kept : words;
  if (!terms.length) return null;
  const parts = terms.map((w, i) => (i === terms.length - 1 ? `(${w} OR ${w}*)` : w));
  return parts.join(mode === 'all' ? ' AND ' : ' OR ');
}

export class Store {
  readonly db: DatabaseSync;
  /** The clock, so tests and runs agree on what "now" is. */
  readonly now: () => string;

  constructor(db: DatabaseSync, now: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.now = now;
  }

  upsertSource(source: SourceInput): number {
    const location = source.location ?? '';
    const row = this.db.prepare('SELECT id FROM sources WHERE kind = ? AND location = ?').get(source.kind, location) as
      | { id: number }
      | undefined;
    if (row) return row.id;
    const res = this.db
      .prepare('INSERT INTO sources (kind, label, location, owner, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(source.kind, source.label, location, source.owner ?? 'you', this.now());
    return Number(res.lastInsertRowid);
  }

  /** Imports a batch. Re-importing the same data changes nothing; changed text becomes a new version. */
  ingest(batch: ImportBatch, editor = 'import'): ImportResult {
    return inTransaction(this.db, () => {
      const sourceId = this.upsertSource(batch.source);
      const owner = batch.source.owner ?? 'you';
      const result: ImportResult = { added: 0, versioned: 0, unchanged: 0, skipped: 0, threads: 0 };
      for (const thread of batch.threads) {
        const usable = thread.entries.filter((e) => normalizeText(e.body).length > 0);
        result.skipped += thread.entries.length - usable.length;
        if (!usable.length) continue;
        const startedAt = thread.startedAt ?? usable.map((e) => e.createdAt).sort()[0]!;
        const threadId = this.upsertThread(sourceId, thread.externalId, thread.title, startedAt);
        result.threads++;
        usable.forEach((e, i) => this.ingestEntry(sourceId, threadId, { ...e, seq: e.seq ?? i }, owner, editor, result));
      }
      for (const e of batch.entries ?? []) {
        if (!normalizeText(e.body)) {
          result.skipped++;
          continue;
        }
        this.ingestEntry(sourceId, null, e, owner, editor, result);
      }
      return result;
    });
  }

  private upsertThread(sourceId: number, externalId: string, title: string, startedAt: string): number {
    const row = this.db
      .prepare('SELECT id FROM threads WHERE source_id = ? AND external_id = ?')
      .get(sourceId, externalId) as { id: number } | undefined;
    if (row) {
      this.db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, row.id);
      return row.id;
    }
    const res = this.db
      .prepare('INSERT INTO threads (source_id, external_id, title, started_at) VALUES (?, ?, ?, ?)')
      .run(sourceId, externalId, title, startedAt);
    return Number(res.lastInsertRowid);
  }

  private ingestEntry(
    sourceId: number,
    threadId: number | null,
    input: EntryInput,
    owner: string,
    editor: string,
    result: ImportResult,
  ): void {
    const body = normalizeText(input.body);
    const hash = hashText(body);
    const speaker = input.speaker === 'you' && owner !== 'you' ? owner : input.speaker;
    const existing = this.db
      .prepare('SELECT id FROM entries WHERE source_id = ? AND external_id = ?')
      .get(sourceId, input.externalId) as { id: number } | undefined;
    if (!existing) {
      const res = this.db
        .prepare(
          `INSERT INTO entries (source_id, thread_id, external_id, kind, speaker, title, created_at, seq, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(sourceId, threadId, input.externalId, input.kind, speaker, input.title ?? null, input.createdAt, input.seq ?? 0);
      const entryId = Number(res.lastInsertRowid);
      this.db
        .prepare('INSERT INTO versions (entry_id, version, body, content_hash, editor, edited_at) VALUES (?, 1, ?, ?, ?, ?)')
        .run(entryId, body, hash, editor, input.createdAt);
      this.index(entryId, input.title ?? null, body);
      result.added++;
      return;
    }
    // Any version already holding this text means it is an older or identical export: the newest version stands.
    const known = this.db
      .prepare('SELECT 1 FROM versions WHERE entry_id = ? AND content_hash = ?')
      .get(existing.id, hash);
    if (known) {
      result.unchanged++;
      return;
    }
    this.writeVersion(existing.id, body, editor);
    result.versioned++;
  }

  /** Saves an edit as a new version. The original stays in history. */
  editEntry(entryId: number, body: string, editor = 'you'): Version {
    return inTransaction(this.db, () => this.writeVersion(entryId, normalizeText(body), editor));
  }

  private writeVersion(entryId: number, body: string, editor: string): Version {
    const row = this.db.prepare('SELECT version, title FROM entries WHERE id = ?').get(entryId) as
      | { version: number; title: string | null }
      | undefined;
    if (!row) throw new Error(`No entry ${entryId}`);
    const version = row.version + 1;
    const editedAt = this.now();
    const contentHash = hashText(body);
    this.db
      .prepare('INSERT INTO versions (entry_id, version, body, content_hash, editor, edited_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entryId, version, body, contentHash, editor, editedAt);
    this.db.prepare('UPDATE entries SET version = ? WHERE id = ?').run(version, entryId);
    this.index(entryId, row.title, body);
    return { version, body, contentHash, editor, editedAt };
  }

  private index(entryId: number, title: string | null, body: string): void {
    this.db.prepare('DELETE FROM entry_search WHERE rowid = ?').run(entryId);
    this.db.prepare('INSERT INTO entry_search (rowid, title, body) VALUES (?, ?, ?)').run(entryId, title ?? '', body);
  }

  getEntry(id: number): Entry | undefined {
    return this.db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as Entry | undefined;
  }

  history(entryId: number): Version[] {
    return this.db
      .prepare(
        `SELECT version, body, content_hash AS contentHash, editor, edited_at AS editedAt
         FROM versions WHERE entry_id = ? ORDER BY version`,
      )
      .all(entryId) as unknown as Version[];
  }

  threadEntries(threadId: number): Entry[] {
    return this.db
      .prepare(`${ENTRY_SELECT} WHERE e.thread_id = ? ORDER BY e.seq, e.created_at, e.id`)
      .all(threadId) as unknown as Entry[];
  }

  getThread(id: number): Thread | undefined {
    const row = this.db
      .prepare(
        `SELECT t.id, t.source_id AS sourceId, t.title, t.started_at AS startedAt, t.not_mine AS notMine,
                (SELECT COUNT(*) FROM entries WHERE thread_id = t.id) AS entries
         FROM threads t WHERE t.id = ?`,
      )
      .get(id) as (Omit<Thread, 'notMine'> & { notMine: number }) | undefined;
    return row && { ...row, notMine: row.notMine === 1 };
  }

  /** All visible entries, oldest first. */
  allEntries(): Entry[] {
    return this.db
      .prepare(`${ENTRY_SELECT} WHERE ${VISIBLE} ORDER BY e.created_at, e.id`)
      .all() as unknown as Entry[];
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const strict = toMatchQuery(query, 'all');
    if (!strict) return [];
    // Entries holding every word come first; entries holding some of them fill the rest of the page.
    const limit = options.limit ?? 20;
    const hits = this.runSearch(strict, { ...options, limit });
    const loose = toMatchQuery(query, 'any');
    if (options.strict || hits.length >= limit || !loose || loose === strict) return hits;
    const seen = new Set(hits.map((h) => h.id));
    for (const hit of this.runSearch(loose, { ...options, limit: limit + hits.length })) {
      if (hits.length >= limit) break;
      if (!seen.has(hit.id)) hits.push(hit);
    }
    return hits;
  }

  private runSearch(match: string, options: SearchOptions): SearchHit[] {
    const where = ['entry_search MATCH ?', VISIBLE];
    const params: (string | number)[] = [match];
    if (options.speaker) {
      where.push('e.speaker = ?');
      params.push(options.speaker);
    }
    if (options.sourceKind) {
      where.push('s.kind = ?');
      params.push(options.sourceKind);
    }
    if (options.from) {
      where.push('e.created_at >= ?');
      params.push(options.from);
    }
    if (options.to) {
      where.push('e.created_at <= ?');
      params.push(options.to);
    }
    params.push(options.limit ?? 20);
    // bm25 is negative (lower is better); scaling it up for your own words ranks them first.
    const sql = `
      SELECT x.*, snippet(entry_search, 1, '[', ']', '…', 14) AS snippet,
             bm25(entry_search) * (CASE WHEN x.speaker = 'assistant' THEN 1.0 ELSE 1.3 END) AS score
      FROM entry_search
      JOIN (${ENTRY_SELECT}) x ON x.id = entry_search.rowid
      JOIN entries e ON e.id = x.id
      JOIN sources s ON s.id = e.source_id
      LEFT JOIN threads t ON t.id = e.thread_id
      WHERE ${where.join(' AND ')}
      ORDER BY score
      LIMIT ?`;
    return this.db.prepare(sql).all(...params) as unknown as SearchHit[];
  }

  sources(): Source[] {
    return this.db
      .prepare(
        `SELECT s.id, s.kind, s.label, s.location, s.owner, s.status, s.added_at AS addedAt,
                (SELECT COUNT(*) FROM entries WHERE source_id = s.id) AS entries
         FROM sources s ORDER BY s.id`,
      )
      .all() as unknown as Source[];
  }

  setSourceStatus(sourceId: number, status: 'in' | 'out' | 'later'): void {
    const res = this.db.prepare('UPDATE sources SET status = ? WHERE id = ?').run(status, sourceId);
    if (res.changes === 0) throw new Error(`No source ${sourceId}`);
  }

  setNotMine(threadId: number, notMine: boolean): void {
    const res = this.db.prepare('UPDATE threads SET not_mine = ? WHERE id = ?').run(notMine ? 1 : 0, threadId);
    if (res.changes === 0) throw new Error(`No thread ${threadId}`);
  }

  stats(): {
    entries: number;
    threads: number;
    sources: number;
    yours: number;
    first: string | null;
    last: string | null;
    byMonth: { month: string; entries: number }[];
  } {
    const one = (sql: string) => this.db.prepare(sql).get() as Record<string, number | string | null>;
    const visible = `FROM entries e JOIN sources s ON s.id = e.source_id LEFT JOIN threads t ON t.id = e.thread_id WHERE ${VISIBLE}`;
    const totals = one(
      `SELECT COUNT(*) AS entries, COUNT(DISTINCT e.thread_id) AS threads,
              SUM(CASE WHEN e.speaker = 'assistant' THEN 0 ELSE 1 END) AS yours,
              MIN(e.created_at) AS first, MAX(e.created_at) AS last ${visible}`,
    );
    const byMonth = this.db
      .prepare(`SELECT substr(e.created_at, 1, 7) AS month, COUNT(*) AS entries ${visible} GROUP BY month ORDER BY month`)
      .all() as unknown as { month: string; entries: number }[];
    return {
      entries: Number(totals.entries ?? 0),
      threads: Number(totals.threads ?? 0),
      sources: Number(one('SELECT COUNT(*) AS n FROM sources').n),
      yours: Number(totals.yours ?? 0),
      first: (totals.first as string | null) ?? null,
      last: (totals.last as string | null) ?? null,
      byMonth,
    };
  }
}
