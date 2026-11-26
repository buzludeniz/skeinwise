import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { UsageError } from '../errors.ts';
import { inTransaction } from './db.ts';

export type EntryKind = 'message' | 'note' | 'file';

/** The file a batch, thread or entry was read from: its path and the SHA-256 of its bytes. */
export interface Origin {
  path: string;
  sha256: string;
}

export interface EntryInput {
  externalId: string;
  kind: EntryKind;
  /** 'you', 'assistant', or a named person. */
  speaker: string;
  title?: string | null;
  /** The time the file claims, or '' when it has none (never an invented 1970). */
  createdAt: string;
  body: string;
  seq?: number;
  /** The file this entry came from, when the batch is a folder of files. */
  origin?: Origin | null;
  /** An agent session's working folder and git branch. */
  project?: string | null;
  gitBranch?: string | null;
  /** A note's front-matter properties, kept with the version. */
  properties?: Record<string, unknown> | null;
}

export interface ThreadInput {
  externalId: string;
  title: string;
  startedAt?: string;
  entries: EntryInput[];
  /** The file this thread came from (one session file), when the batch is a folder. */
  origin?: Origin | null;
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
  /** The file the whole batch came from (an export or a zip); null for a folder, whose threads and entries carry it. */
  origin?: Origin | null;
  /** The account fingerprint the export claims (a hash of its user id or email), or null where the format has none. */
  account?: string | null;
}

export interface IngestOptions {
  /** Who wrote the versions: 'import' (default), 'you', or an agent's name. */
  editor?: string;
  /** The organiser or agent run that made these versions. */
  runId?: number | null;
  /**
   * false for a batch the person didn't start (a Downloads capture): anything it would add or change goes to one
   * pending proposal, and the record is untouched. Default true.
   */
  trusted?: boolean;
  /** Overrides batch.origin. */
  origin?: Origin | null;
  /** Overrides batch.account. */
  account?: string | null;
}

export interface EditOptions {
  editor?: string;
  runId?: number | null;
}

export interface ImportResult {
  added: number;
  versioned: number;
  unchanged: number;
  skipped: number;
  threads: number;
}

/** An ingest that went to pending says how many entries it proposed and which pending item holds them. */
export interface IngestResult extends ImportResult {
  /** Entries (and retitled threads) the batch would have added or changed; present only when it went to pending. */
  proposed?: number;
  /** The new pending item, or null when nothing would change or the same file was proposed before. */
  pendingId?: number | null;
}

export type PendingReason = 'unconfirmed' | 'account';
export type PendingStatus = 'pending' | 'accepted' | 'rejected';

export interface PendingItem {
  id: number;
  status: PendingStatus;
  reason: PendingReason;
  sourceKind: string;
  sourceLabel: string;
  origin: Origin | null;
  originHash: string | null;
  account: string | null;
  /** Threads and entries the batch would add or change. */
  threads: number;
  entries: number;
  /** Size of the proposed batch as stored, in bytes. */
  bytes: number;
  observedAt: string;
  decidedAt: string | null;
}

/** Why an entry's own time isn't trusted: none, more than a day ahead of when it was seen, or before 1990. */
export type TimeFlag = 'missing' | 'future' | 'early';

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
  /** The time it sorts by: the time it claims, or when Skeinwise saw it if that claim is flagged. */
  createdAt: string;
  /** The time the file claimed, or null when it had none. (Optional only so hand-built entries stay short.) */
  claimedAt?: string | null;
  /** When Skeinwise first saw it. */
  observedAt?: string | null;
  timeFlag?: TimeFlag | null;
  project?: string | null;
  gitBranch?: string | null;
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
  /** When Skeinwise saw or made this version. */
  observedAt: string;
  /** The time the file claimed for it, for an imported version. */
  claimedAt: string | null;
  title: string | null;
  properties: Record<string, unknown> | null;
  origin: Origin | null;
  account: string | null;
  runId: number | null;
}

export interface TitleVersion {
  version: number;
  title: string;
  editor: string;
  observedAt: string;
  origin: Origin | null;
  account: string | null;
  runId: number | null;
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
  /**
   * Only agent-session entries run in this project. A folder name ("plotline") matches that name anywhere in the
   * working folder's path, so its subfolders too; a full path matches that folder and what is under it.
   */
  project?: string;
}

export interface ProjectFilter {
  sql: string;
  param: string;
}

/**
 * The condition that keeps a search to agent sessions run in one project folder. Whole folder names only, compared as
 * text: "plot" doesn't match "plotline", and % or _ mean nothing here. \ and / both separate folders, on both sides, so
 * a Windows folder (C:\Users\…) matches by name or in full. On Windows the match ignores case, as its folders do: A to Z
 * only, since SQLite's lower() folds no other letters, and both sides must fold alike.
 */
export function projectFilter(project: string, platform: NodeJS.Platform = process.platform): ProjectFilter {
  const fold = platform === 'win32';
  let name = project.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (!name) throw new UsageError('Give a project: a folder name or a path.');
  if (fold) name = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const slashed = "replace(e.project, char(92), '/')";
  const folder = fold ? `lower(${slashed})` : slashed;
  if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) return { sql: `instr(${folder} || '/', ?) = 1`, param: `${name}/` };
  return { sql: `instr('/' || ${folder} || '/', ?) > 0`, param: `/${name}/` };
}

export interface TimelineOptions {
  /** Earliest created_at to include (ISO). */
  from?: string;
  /** Latest created_at to include (ISO). */
  to?: string;
  speaker?: string;
  sourceKind?: string;
  limit?: number;
  offset?: number;
  /** Newest first instead of oldest first. */
  newest?: boolean;
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

const DAY_MS = 24 * 60 * 60 * 1000;
const EARLIEST = Date.parse('1990-01-01T00:00:00Z');

/** Flags a claimed time Skeinwise shouldn't sort by: missing, more than a day after it was seen, or before 1990. */
export function timeFlag(claimed: string | null | undefined, observed: string): TimeFlag | null {
  const t = claimed ? Date.parse(claimed) : NaN;
  if (Number.isNaN(t)) return 'missing';
  if (t > Date.parse(observed) + DAY_MS) return 'future';
  if (t < EARLIEST) return 'early';
  return null;
}

/**
 * The time an entry is stored, sorted and filtered by (entries.created_at): the time it claims, unless that is
 * flagged, then when Skeinwise saw it. The claim itself stays in entries.claimed_at and on version 1.
 */
export function sortTime(claimed: string | null | undefined, observed: string): string {
  return timeFlag(claimed, observed) ? observed : claimed!;
}

/** Every table that hangs a row on an entry, and its column: purgeEntry clears them all. */
export const PURGE_REFERENCES: [table: string, column: string][] = [
  ['entry_tags', 'entry_id'],
  ['entry_folders', 'entry_id'],
  ['links', 'from_entry'],
  ['links', 'to_entry'],
  ['hub_entries', 'entry_id'],
  ['layers', 'entry_id'],
  ['review_items', 'note_entry'],
  ['pa_loops', 'entry_id'],
  ['pa_found', 'entry_id'],
];

/**
 * Rows that name an entry but are yours, not the entry's (a task the assistant made from it): purgeEntry keeps them and
 * drops the reference.
 */
export const PURGE_UNLINKS: [table: string, column: string][] = [['pa_tasks', 'entry_id']];

interface WriteContext {
  editor: string;
  runId: number | null;
  origin: Origin | null;
  account: string | null;
}

const VERSION_COLUMNS = `version, body, content_hash AS contentHash, editor, edited_at AS editedAt, observed_at AS observedAt,
  claimed_at AS claimedAt, title, properties, origin_path AS originPath, origin_sha256 AS originHash, account, run_id AS runId`;

type VersionRow = Omit<Version, 'origin' | 'properties'> & { originPath: string | null; originHash: string | null; properties: string | null };

function toVersion({ originPath, originHash, properties, ...row }: VersionRow): Version {
  return {
    ...row,
    properties: properties ? (JSON.parse(properties) as Record<string, unknown>) : null,
    origin: originPath !== null && originHash !== null ? { path: originPath, sha256: originHash } : null,
  };
}

const PENDING_COLUMNS = `id, status, reason, source_kind AS sourceKind, source_label AS sourceLabel, origin_path AS originPath,
  origin_sha256 AS originHash, account, threads, entries, bytes, observed_at AS observedAt, decided_at AS decidedAt`;

function toPending({ originPath, ...row }: Omit<PendingItem, 'origin'> & { originPath: string | null }): PendingItem {
  return { ...row, origin: originPath !== null && row.originHash !== null ? { path: originPath, sha256: row.originHash } : null };
}

const ENTRY_SELECT = `
  SELECT e.id, e.source_id AS sourceId, s.kind AS sourceKind, s.label AS sourceLabel,
         e.thread_id AS threadId, t.title AS threadTitle, e.external_id AS externalId, e.kind,
         e.speaker, e.title, e.created_at AS createdAt, e.claimed_at AS claimedAt, e.observed_at AS observedAt,
         e.time_flag AS timeFlag, e.project, e.git_branch AS gitBranch, e.seq, e.version, v.body
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

  private readonly statements = new Map<string, StatementSync>();

  /**
   * The import path's statements, prepared once per store. Each prepare holds a compiled statement in native memory
   * that V8 doesn't count, and frees it only when the object is collected, so a fresh prepare per entry piled up
   * about 100 MB on a 30,000-message import before a scavenge ran.
   */
  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  upsertSource(source: SourceInput, account: string | null = null): number {
    const location = source.location ?? '';
    const row = this.stmt('SELECT id, account FROM sources WHERE kind = ? AND location = ?').get(source.kind, location) as
      | { id: number; account: string | null }
      | undefined;
    if (row) {
      // The first import that names an account claims the source for it.
      if (row.account === null && account !== null) this.stmt('UPDATE sources SET account = ? WHERE id = ?').run(account, row.id);
      return row.id;
    }
    const res = this
      .stmt('INSERT INTO sources (kind, label, location, owner, added_at, account) VALUES (?, ?, ?, ?, ?, ?)')
      .run(source.kind, source.label, location, source.owner ?? 'you', this.now(), account);
    return Number(res.lastInsertRowid);
  }

  /**
   * Imports a batch. Re-importing the same data changes nothing; changed text and titles become new versions, and an
   * older export never rolls them back. A batch that isn't trusted (a capture the person didn't start), or whose
   * account differs from the one the source was first imported from, changes nothing: it becomes one pending proposal.
   */
  ingest(batch: ImportBatch, options: string | IngestOptions = {}): IngestResult {
    const opts = typeof options === 'string' ? { editor: options } : options;
    const origin = opts.origin !== undefined ? opts.origin : (batch.origin ?? null);
    const account = opts.account !== undefined ? opts.account : (batch.account ?? null);
    const context: WriteContext = { editor: opts.editor ?? 'import', runId: opts.runId ?? null, origin, account };
    return inTransaction(this.db, () => {
      const known = this.knownAccount(batch.source);
      const reason: PendingReason | null =
        known !== null && account !== null && known !== account ? 'account' : opts.trusted === false ? 'unconfirmed' : null;
      if (!reason) return this.apply(batch, context);
      const plan = this.plan(batch);
      const pendingId = plan.proposed ? this.insertPending(plan.batch, plan, { reason, origin, account }) : null;
      return { ...plan.result, proposed: plan.proposed, pendingId };
    });
  }

  private knownAccount(source: SourceInput): string | null {
    const row = this.stmt('SELECT account FROM sources WHERE kind = ? AND location = ?').get(source.kind, source.location ?? '') as
      | { account: string | null }
      | undefined;
    return row?.account ?? null;
  }

  private apply(batch: ImportBatch, context: WriteContext): ImportResult {
    const sourceId = this.upsertSource(batch.source, context.account);
    const owner = batch.source.owner ?? 'you';
    const observed = this.now();
    const result: ImportResult = { added: 0, versioned: 0, unchanged: 0, skipped: 0, threads: 0 };
    for (const thread of batch.threads) {
      const usable = thread.entries.filter((e) => normalizeText(e.body).length > 0);
      result.skipped += thread.entries.length - usable.length;
      const threadContext = thread.origin ? { ...context, origin: thread.origin } : context;
      if (!usable.length) {
        // A proposal keeps only what changes, so a thread that was only renamed arrives with no entries.
        const existing = this.threadId(sourceId, thread.externalId);
        if (existing !== null) this.retitle(existing, thread.title, threadContext);
        continue;
      }
      const times = usable.map((e) => sortTime(e.createdAt, observed));
      const startedAt = thread.startedAt && !timeFlag(thread.startedAt, observed) ? thread.startedAt : times.sort()[0]!;
      const threadId = this.upsertThread(sourceId, thread.externalId, thread.title, startedAt, threadContext);
      result.threads++;
      usable.forEach((e, i) => this.ingestEntry(sourceId, threadId, { ...e, seq: e.seq ?? i }, owner, threadContext, observed, result));
    }
    for (const e of batch.entries ?? []) {
      if (!normalizeText(e.body)) {
        result.skipped++;
        continue;
      }
      this.ingestEntry(sourceId, null, e, owner, context, observed, result);
    }
    return result;
  }

  private threadId(sourceId: number, externalId: string): number | null {
    const row = this.stmt('SELECT id FROM threads WHERE source_id = ? AND external_id = ?').get(sourceId, externalId) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  private upsertThread(sourceId: number, externalId: string, title: string, startedAt: string, context: WriteContext): number {
    const existing = this.threadId(sourceId, externalId);
    if (existing !== null) {
      this.retitle(existing, title, context);
      return existing;
    }
    const res = this
      .stmt('INSERT INTO threads (source_id, external_id, title, started_at) VALUES (?, ?, ?, ?)')
      .run(sourceId, externalId, title, startedAt);
    const id = Number(res.lastInsertRowid);
    this.writeTitle(id, 1, title, context);
    return id;
  }

  /** A changed title becomes a new title version; a title any version already had (an older export) changes nothing. */
  private retitle(threadId: number, title: string, context: WriteContext): boolean {
    if (this.stmt('SELECT 1 FROM thread_titles WHERE thread_id = ? AND title = ?').get(threadId, title)) return false;
    const { latest } = this.stmt('SELECT COALESCE(MAX(version), 0) AS latest FROM thread_titles WHERE thread_id = ?').get(threadId) as {
      latest: number;
    };
    this.writeTitle(threadId, latest + 1, title, context);
    this.stmt('UPDATE threads SET title = ? WHERE id = ?').run(title, threadId);
    return true;
  }

  private writeTitle(threadId: number, version: number, title: string, context: WriteContext): void {
    this
      .stmt(
        `INSERT INTO thread_titles (thread_id, version, title, editor, observed_at, origin_path, origin_sha256, account, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, version, title, context.editor, this.now(), context.origin?.path ?? null, context.origin?.sha256 ?? null, context.account, context.runId);
  }

  private ingestEntry(
    sourceId: number,
    threadId: number | null,
    input: EntryInput,
    owner: string,
    batchContext: WriteContext,
    observed: string,
    result: ImportResult,
  ): void {
    const context = input.origin ? { ...batchContext, origin: input.origin } : batchContext;
    const body = normalizeText(input.body);
    const hash = hashText(body);
    const speaker = input.speaker === 'you' && owner !== 'you' ? owner : input.speaker;
    const existing = this
      .stmt('SELECT id FROM entries WHERE source_id = ? AND external_id = ?')
      .get(sourceId, input.externalId) as { id: number } | undefined;
    if (!existing) {
      const flag = timeFlag(input.createdAt, observed);
      const createdAt = flag ? observed : input.createdAt!;
      const res = this
        .stmt(
          `INSERT INTO entries (source_id, thread_id, external_id, kind, speaker, title, created_at, seq, version,
                                observed_at, claimed_at, time_flag, project, git_branch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          sourceId,
          threadId,
          input.externalId,
          input.kind,
          speaker,
          input.title ?? null,
          createdAt,
          input.seq ?? 0,
          observed,
          input.createdAt || null,
          flag,
          input.project ?? null,
          input.gitBranch ?? null,
        );
      this.writeVersion(Number(res.lastInsertRowid), body, context, {
        observedAt: observed,
        editedAt: createdAt,
        claimedAt: input.createdAt || null,
        properties: input.properties ?? null,
      });
      result.added++;
      return;
    }
    // Any version already holding this text means it is an older or identical export: the newest version stands.
    const known = this
      .stmt('SELECT 1 FROM versions WHERE entry_id = ? AND content_hash = ?')
      .get(existing.id, hash);
    if (known) {
      // An entry imported before sessions kept their folder and branch gains them here; one already set stays.
      if (input.project || input.gitBranch) {
        this
          .stmt('UPDATE entries SET project = COALESCE(project, ?), git_branch = COALESCE(git_branch, ?) WHERE id = ? AND (project IS NULL OR git_branch IS NULL)')
          .run(input.project ?? null, input.gitBranch ?? null, existing.id);
      }
      if (input.properties !== undefined && this.frontMatterEdit(existing.id, body, hash, input, context, observed)) result.versioned++;
      else result.unchanged++;
      return;
    }
    this.writeVersion(existing.id, body, context, {
      observedAt: observed,
      claimedAt: input.createdAt || null,
      title: input.title ?? undefined,
      properties: input.properties ?? null,
    });
    if (input.project || input.gitBranch) {
      this
        .stmt('UPDATE entries SET project = COALESCE(?, project), git_branch = COALESCE(?, git_branch) WHERE id = ?')
        .run(input.project ?? null, input.gitBranch ?? null, existing.id);
    }
    result.versioned++;
  }

  /**
   * A note whose text is its newest version's but whose front matter changed. A version's hash covers only the text, so
   * this edit used to be lost: the note kept its old properties. It becomes a new version with the same text and the
   * new properties (and title), so history keeps it and a run over new versions sees it. Not when the newest version
   * has no properties at all: a record from before notes kept their front matter holds null in every version, and a
   * new version for each note would come at its next capture, so those are filled in place. Text that an older
   * version holds is an older export and changes nothing. Returns true when it wrote a version.
   */
  private frontMatterEdit(entryId: number, body: string, hash: string, input: EntryInput, context: WriteContext, observed: string): boolean {
    const latest = this
      .stmt(
        `SELECT v.id, v.content_hash AS hash, v.properties FROM entries e
         JOIN versions v ON v.entry_id = e.id AND v.version = e.version WHERE e.id = ?`,
      )
      .get(entryId) as { id: number; hash: string; properties: string | null } | undefined;
    if (!latest || latest.hash !== hash) return false;
    const properties = input.properties ? JSON.stringify(input.properties) : null;
    if (properties === latest.properties) return false;
    if (latest.properties === null) {
      this.stmt('UPDATE versions SET properties = ? WHERE id = ?').run(properties, latest.id);
      return false;
    }
    this.writeVersion(entryId, body, context, {
      observedAt: observed,
      claimedAt: input.createdAt || null,
      title: input.title ?? undefined,
      properties: input.properties ?? null,
    });
    return true;
  }

  /** Saves an edit as a new version. The original stays in history. */
  editEntry(entryId: number, body: string, options: string | EditOptions = {}): Version {
    const opts = typeof options === 'string' ? { editor: options } : options;
    return inTransaction(this.db, () =>
      this.writeVersion(entryId, normalizeText(body), { editor: opts.editor ?? 'you', runId: opts.runId ?? null, origin: null, account: null }),
    );
  }

  /**
   * Brings back version `n` of an entry as a new version (its text, title and properties), so the restore is itself in
   * history and can be undone. Restoring the version that is already current changes nothing and returns it.
   */
  restoreVersion(entryId: number, n: number, options: string | EditOptions = {}): Version {
    const opts = typeof options === 'string' ? { editor: options } : options;
    return inTransaction(this.db, () => {
      const versions = this.history(entryId);
      if (!versions.length) throw new Error(`No entry ${entryId}`);
      const target = versions.find((v) => v.version === n);
      if (!target) throw new Error(`Entry ${entryId} has no version ${n} (it has 1 to ${versions.at(-1)!.version})`);
      const current = versions.at(-1)!;
      const title = this.db.prepare('SELECT title FROM entries WHERE id = ?').get(entryId) as { title: string | null };
      if (target.contentHash === current.contentHash && (target.title ?? title.title) === title.title) return current;
      return this.writeVersion(entryId, target.body, { editor: opts.editor ?? 'you', runId: opts.runId ?? null, origin: null, account: null }, {
        title: target.title ?? undefined,
        properties: target.properties,
      });
    });
  }

  /**
   * Removes an entry for good: every version, its search row and everything the organiser hung on it (tags, folders,
   * links either way, hub membership, layers, review items, and its quotes in hub sections and review reasons), and the
   * assistant's open loops and readings of it; a task of yours made from it stays, without the link. All with
   * SQLite's secure_delete on so the freed pages are zeroed. A thread left empty goes too. Text a model wrote from it
   * elsewhere (an `ask` run's answer) is not traced. Old text can still sit in the write-ahead log and in free pages until
   * `scrub()` runs; the caller runs it after a purge it was asked to make thorough.
   */
  purgeEntry(entryId: number): { entry: number; versions: number; threadRemoved: boolean } {
    const secure = (this.db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete;
    this.db.exec('PRAGMA secure_delete = ON');
    try {
      return inTransaction(this.db, () => {
        const row = this.db.prepare('SELECT thread_id AS threadId FROM entries WHERE id = ?').get(entryId) as
          | { threadId: number | null }
          | undefined;
        if (!row) throw new Error(`No entry ${entryId}`);
        this.db.exec("INSERT INTO entry_search (entry_search, rank) VALUES ('secure-delete', 1)");
        this.db.prepare('DELETE FROM entry_search WHERE rowid = ?').run(entryId);
        for (const [table, column] of PURGE_REFERENCES) this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(entryId);
        for (const [table, column] of PURGE_UNLINKS) this.db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ?`).run(entryId);
        this.dropQuotes(entryId);
        const versions = Number(this.db.prepare('DELETE FROM versions WHERE entry_id = ?').run(entryId).changes);
        this.db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
        let threadRemoved = false;
        if (row.threadId !== null && !this.db.prepare('SELECT 1 FROM entries WHERE thread_id = ?').get(row.threadId)) {
          this.db.prepare('DELETE FROM thread_titles WHERE thread_id = ?').run(row.threadId);
          this.db.prepare('DELETE FROM threads WHERE id = ?').run(row.threadId);
          threadRemoved = true;
        }
        return { entry: entryId, versions, threadRemoved };
      });
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${secure ? 'ON' : 'OFF'}`);
    }
  }

  /** Hub sections and review reasons quote entries by id ({entryId, text|quote}); a purged entry's quotes go. */
  private dropQuotes(entryId: number): void {
    const quotes = (item: unknown) => (item as { entryId?: unknown } | null)?.entryId === entryId;
    const like = `%"entryId":${entryId}%`;
    for (const hub of this.db.prepare('SELECT id, sections FROM hubs WHERE sections LIKE ?').all(like) as { id: number; sections: string }[]) {
      const sections = JSON.parse(hub.sections) as Record<string, unknown>;
      for (const [name, items] of Object.entries(sections)) if (Array.isArray(items)) sections[name] = items.filter((i) => !quotes(i));
      this.db.prepare('UPDATE hubs SET sections = ? WHERE id = ?').run(JSON.stringify(sections), hub.id);
    }
    for (const item of this.db.prepare('SELECT id, reasons FROM review_items WHERE reasons LIKE ?').all(like) as { id: number; reasons: string }[]) {
      const reasons = (JSON.parse(item.reasons) as unknown[]).filter((r) => !quotes(r));
      if (reasons.length) this.db.prepare('UPDATE review_items SET reasons = ? WHERE id = ?').run(JSON.stringify(reasons), item.id);
      else this.db.prepare('DELETE FROM review_items WHERE id = ?').run(item.id);
    }
  }

  /**
   * Rewrites the search index, the database file and the write-ahead log so deleted text leaves no trace on disk.
   * Slow on a big record. `checkpointed` is false when another connection (a running `live`) kept the log in use.
   */
  scrub(): { checkpointed: boolean } {
    this.db.exec("INSERT INTO entry_search (entry_search) VALUES ('optimize')");
    this.db.exec('VACUUM');
    const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number } | undefined;
    return { checkpointed: !result || result.busy === 0 };
  }

  private writeVersion(
    entryId: number,
    body: string,
    context: WriteContext,
    extra: {
      observedAt?: string;
      editedAt?: string;
      claimedAt?: string | null;
      title?: string | null;
      properties?: Record<string, unknown> | null;
    } = {},
  ): Version {
    const row = this.stmt('SELECT version, title FROM entries WHERE id = ?').get(entryId) as
      | { version: number; title: string | null }
      | undefined;
    if (!row) throw new Error(`No entry ${entryId}`);
    const version = row.version + 1;
    const observedAt = extra.observedAt ?? this.now();
    const editedAt = extra.editedAt ?? observedAt;
    const title = extra.title !== undefined ? extra.title : row.title;
    const properties = extra.properties ?? null;
    const contentHash = hashText(body);
    this
      .stmt(
        `INSERT INTO versions (entry_id, version, body, content_hash, editor, edited_at, observed_at, claimed_at, title,
                               properties, origin_path, origin_sha256, account, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryId,
        version,
        body,
        contentHash,
        context.editor,
        editedAt,
        observedAt,
        extra.claimedAt ?? null,
        title,
        properties ? JSON.stringify(properties) : null,
        context.origin?.path ?? null,
        context.origin?.sha256 ?? null,
        context.account,
        context.runId,
      );
    this.stmt('UPDATE entries SET version = ?, title = ? WHERE id = ?').run(version, title, entryId);
    this.index(entryId, title, body);
    return {
      version,
      body,
      contentHash,
      editor: context.editor,
      editedAt,
      observedAt,
      claimedAt: extra.claimedAt ?? null,
      title,
      properties,
      origin: context.origin,
      account: context.account,
      runId: context.runId,
    };
  }

  private index(entryId: number, title: string | null, body: string): void {
    this.stmt('DELETE FROM entry_search WHERE rowid = ?').run(entryId);
    this.stmt('INSERT INTO entry_search (rowid, title, body) VALUES (?, ?, ?)').run(entryId, title ?? '', body);
  }

  // ---------- pending proposals ----------

  /**
   * Stores a batch as one pending proposal without touching the record. Returns its id, or null when the batch would
   * change nothing or the same file (by SHA-256) was proposed before, whatever was decided about it.
   */
  propose(batch: ImportBatch, options: { reason: PendingReason; origin?: Origin | null; account?: string | null }): number | null {
    const origin = options.origin !== undefined ? options.origin : (batch.origin ?? null);
    const account = options.account !== undefined ? options.account : (batch.account ?? null);
    return inTransaction(this.db, () => {
      const plan = this.plan(batch);
      return plan.proposed ? this.insertPending(plan.batch, plan, { reason: options.reason, origin, account }) : null;
    });
  }

  /** What a batch would add or change, and the batch cut down to just that. Writes nothing. */
  private plan(batch: ImportBatch): { batch: ImportBatch; result: ImportResult; proposed: number; threads: number; entries: number } {
    const source = this.stmt('SELECT id FROM sources WHERE kind = ? AND location = ?').get(batch.source.kind, batch.source.location ?? '') as
      | { id: number }
      | undefined;
    const result: ImportResult = { added: 0, versioned: 0, unchanged: 0, skipped: 0, threads: 0 };
    const changes = (entries: EntryInput[]): EntryInput[] =>
      entries.filter((e) => {
        const body = normalizeText(e.body);
        if (!body) {
          result.skipped++;
          return false;
        }
        const existing = source
          ? (this.stmt('SELECT id FROM entries WHERE source_id = ? AND external_id = ?').get(source.id, e.externalId) as { id: number } | undefined)
          : undefined;
        if (existing && this.stmt('SELECT 1 FROM versions WHERE entry_id = ? AND content_hash = ?').get(existing.id, hashText(body))) {
          result.unchanged++;
          return false;
        }
        return true;
      });
    const threads: ThreadInput[] = [];
    let entries = 0;
    for (const thread of batch.threads) {
      const changed = changes(thread.entries);
      const threadId = source ? this.threadId(source.id, thread.externalId) : null;
      const retitled =
        threadId !== null && !this.stmt('SELECT 1 FROM thread_titles WHERE thread_id = ? AND title = ?').get(threadId, thread.title);
      if (!changed.length && !retitled) continue;
      threads.push({ ...thread, entries: changed });
      entries += changed.length;
    }
    const loose = changes(batch.entries ?? []);
    entries += loose.length;
    const retitledOnly = threads.filter((t) => !t.entries.length).length;
    return {
      batch: { ...batch, threads, entries: loose },
      result,
      proposed: entries + retitledOnly,
      threads: threads.length,
      entries,
    };
  }

  private insertPending(
    batch: ImportBatch,
    counts: { threads: number; entries: number },
    options: { reason: PendingReason; origin: Origin | null; account: string | null },
  ): number | null {
    const { origin } = options;
    if (origin && this.pendingByHash(origin.sha256, batch.source.kind)) return null;
    const json = JSON.stringify({ ...batch, origin, account: options.account });
    const res = this
      .stmt(
        `INSERT INTO pending (reason, source_kind, source_label, origin_path, origin_sha256, account, threads, entries, bytes, batch, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.reason,
        batch.source.kind,
        batch.source.label,
        origin?.path ?? null,
        origin?.sha256 ?? null,
        options.account,
        counts.threads,
        counts.entries,
        Buffer.byteLength(json),
        json,
        this.now(),
      );
    return Number(res.lastInsertRowid);
  }

  /** Pending proposals, oldest first; with `all`, accepted and rejected ones too. */
  pendingItems(options: { all?: boolean } = {}): PendingItem[] {
    const where = options.all ? '' : "WHERE status = 'pending'";
    return (this.db.prepare(`SELECT ${PENDING_COLUMNS} FROM pending ${where} ORDER BY id`).all() as unknown as Parameters<typeof toPending>[0][]).map(
      toPending,
    );
  }

  pendingItem(id: number): PendingItem | undefined {
    const row = this.db.prepare(`SELECT ${PENDING_COLUMNS} FROM pending WHERE id = ?`).get(id) as Parameters<typeof toPending>[0] | undefined;
    return row && toPending(row);
  }

  /** The proposal made from a file with this SHA-256, in any state (for one source kind when given). */
  pendingByHash(sha256: string, sourceKind?: string): PendingItem | undefined {
    const row = (
      sourceKind === undefined
        ? this.db.prepare(`SELECT ${PENDING_COLUMNS} FROM pending WHERE origin_sha256 = ? ORDER BY id LIMIT 1`).get(sha256)
        : this.db.prepare(`SELECT ${PENDING_COLUMNS} FROM pending WHERE origin_sha256 = ? AND source_kind = ?`).get(sha256, sourceKind)
    ) as Parameters<typeof toPending>[0] | undefined;
    return row && toPending(row);
  }

  /** Imports a pending proposal as the person accepted it, with its origin and account on every version. */
  acceptPending(id: number, options: EditOptions = {}): ImportResult {
    return inTransaction(this.db, () => {
      const batch = this.undecided(id);
      const result = this.apply(batch, {
        editor: options.editor ?? 'import',
        runId: options.runId ?? null,
        origin: batch.origin ?? null,
        account: batch.account ?? null,
      });
      this.decide(id, 'accepted');
      return result;
    });
  }

  /** Turns a proposal down. The row and its file hash stay, so the same file is never proposed again; the batch goes. */
  rejectPending(id: number): void {
    inTransaction(this.db, () => {
      this.undecided(id);
      this.decide(id, 'rejected');
    });
  }

  private undecided(id: number): ImportBatch {
    const row = this.db.prepare('SELECT status, batch FROM pending WHERE id = ?').get(id) as { status: PendingStatus; batch: string | null } | undefined;
    if (!row) throw new Error(`No pending item ${id}`);
    if (row.status !== 'pending' || row.batch === null) throw new Error(`Pending item ${id} was already ${row.status}`);
    return JSON.parse(row.batch) as ImportBatch;
  }

  private decide(id: number, status: 'accepted' | 'rejected'): void {
    this.db.prepare('UPDATE pending SET status = ?, batch = NULL, decided_at = ? WHERE id = ?').run(status, this.now(), id);
  }

  getEntry(id: number): Entry | undefined {
    return this.db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as Entry | undefined;
  }

  history(entryId: number): Version[] {
    return (
      this.db.prepare(`SELECT ${VERSION_COLUMNS} FROM versions WHERE entry_id = ? ORDER BY version`).all(entryId) as unknown as VersionRow[]
    ).map(toVersion);
  }

  /** A thread's titles, oldest first. */
  titleHistory(threadId: number): TitleVersion[] {
    return (
      this.db
        .prepare(
          `SELECT version, title, editor, observed_at AS observedAt, origin_path AS originPath, origin_sha256 AS originHash,
                  account, run_id AS runId
           FROM thread_titles WHERE thread_id = ? ORDER BY version`,
        )
        .all(threadId) as unknown as (Omit<TitleVersion, 'origin'> & { originPath: string | null; originHash: string | null })[]
    ).map(({ originPath, originHash, ...row }) => ({
      ...row,
      origin: originPath !== null && originHash !== null ? { path: originPath, sha256: originHash } : null,
    }));
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

  /** One entry, or undefined when there is none or it is hidden (an excluded source, or a thread marked not mine). */
  visibleEntry(id: number): Entry | undefined {
    return this.db.prepare(`${ENTRY_SELECT} WHERE e.id = ? AND ${VISIBLE}`).get(id) as Entry | undefined;
  }

  /** A thread, or undefined when there is none or it is hidden. */
  visibleThread(id: number): Thread | undefined {
    const row = this.db.prepare(`SELECT t.id FROM threads t JOIN sources s ON s.id = t.source_id WHERE t.id = ? AND ${VISIBLE}`).get(id);
    return row ? this.getThread(id) : undefined;
  }

  /** Visible entries in date order, oldest first unless `newest`, a page at a time. */
  timeline(options: TimelineOptions = {}): Entry[] {
    const where = [VISIBLE];
    const params: (string | number)[] = [];
    const add = (sql: string, value: string | undefined) => {
      if (value === undefined) return;
      where.push(sql);
      params.push(value);
    };
    add('e.created_at >= ?', options.from);
    add('e.created_at <= ?', options.to);
    add('e.speaker = ?', options.speaker);
    add('s.kind = ?', options.sourceKind);
    const order = options.newest ? 'DESC' : 'ASC';
    params.push(options.limit ?? 50, options.offset ?? 0);
    return this.db
      .prepare(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.created_at ${order}, e.id ${order} LIMIT ? OFFSET ?`)
      .all(...params) as unknown as Entry[];
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    // A blank project is refused even when the words would find nothing.
    const project = options.project === undefined ? null : projectFilter(options.project);
    const strict = toMatchQuery(query, 'all');
    if (!strict) return [];
    // Entries holding every word come first; entries holding some of them fill the rest of the page.
    const limit = options.limit ?? 20;
    const hits = this.runSearch(strict, { ...options, limit }, project);
    const loose = toMatchQuery(query, 'any');
    if (options.strict || hits.length >= limit || !loose || loose === strict) return hits;
    const seen = new Set(hits.map((h) => h.id));
    for (const hit of this.runSearch(loose, { ...options, limit: limit + hits.length }, project)) {
      if (hits.length >= limit) break;
      if (!seen.has(hit.id)) hits.push(hit);
    }
    return hits;
  }

  private runSearch(match: string, options: SearchOptions, project: ProjectFilter | null): SearchHit[] {
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
    if (project) {
      where.push(project.sql);
      params.push(project.param);
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
