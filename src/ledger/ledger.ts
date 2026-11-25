// The ledger: ledger.jsonl in the record folder, one line per import, edit and run, each carrying the SHA-256 of the
// line before it. Changing, adding or removing a line breaks the chain from there on. The ledger holds hashes, ids
// and counts, never your words, so stamping its latest line (see ots.ts) dates the whole record without showing it.
//
// Nothing else writes the ledger: catchUpLedger reads the record's versions and runs and appends what the ledger
// hasn't seen, so it can run after any import, run or capture, as often as you like.

import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, appendFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { hashText, type Store } from '../store/store.ts';

export const LEDGER_FILE = 'ledger.jsonl';

export function ledgerPath(home: string): string {
  return join(home, LEDGER_FILE);
}

/** The SHA-256 of a line as written, without its newline: what the next line carries as `prev`. */
export function lineHash(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

interface Base {
  /** The line's number, from 1. */
  n: number;
  /** The SHA-256 of the line before; null on line 1. */
  prev: string | null;
  /** When the ledger wrote the line. */
  at: string;
}

/** The versions one import brought in from one source: new entries and changed ones. */
export interface ImportLine extends Base {
  kind: 'import';
  source: number;
  sourceKind: string;
  /** The first and last version ids. Versions in between from other sources, or not imported, are in other lines. */
  versions: [number, number];
  count: number;
  /** SHA-256 over "<version id> <entry id> <version> <content hash>\n" for each of them, in id order. */
  digest: string;
}

/** One version written in Skeinwise rather than imported: by you, or by an agent under its name. */
export interface EditLine extends Base {
  kind: 'edit';
  entry: number;
  version: number;
  versionId: number;
  editor: string;
  /** The version's content hash: the SHA-256 of its text. */
  hash: string;
}

/** A run as it finished (done or failed), and again if it is undone later. */
export interface RunLine extends Base {
  kind: 'run';
  run: number;
  task: string;
  engine: string;
  model: string | null;
  scope: string;
  schema: number | null;
  status: 'done' | 'failed' | 'undone';
  counts: Record<string, number>;
  startedAt: string;
  finishedAt: string | null;
}

export type LedgerLine = ImportLine | EditLine | RunLine;

/** The ledger as text: its lines, and whether the last one was cut off before its newline. */
export interface LedgerText {
  lines: string[];
  cutOff: boolean;
}

export function readLedgerText(home: string): LedgerText {
  const file = ledgerPath(home);
  if (!existsSync(file)) return { lines: [], cutOff: false };
  const text = readFileSync(file, 'utf8');
  if (!text) return { lines: [], cutOff: false };
  const cutOff = !text.endsWith('\n');
  return { lines: (cutOff ? text : text.slice(0, -1)).split('\n'), cutOff };
}

function parseLine(text: string): LedgerLine | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as LedgerLine) : null;
  } catch {
    return null;
  }
}

/** What the ledger has seen: the newest version id, and each run's last recorded status. */
interface Seen {
  version: number;
  runs: Map<number, string>;
}

function seenIn(lines: LedgerLine[]): Seen {
  const seen: Seen = { version: 0, runs: new Map() };
  for (const line of lines) {
    if (line.kind === 'import') seen.version = Math.max(seen.version, line.versions[1]);
    else if (line.kind === 'edit') seen.version = Math.max(seen.version, line.versionId);
    else if (line.kind === 'run') seen.runs.set(line.run, line.status);
  }
  return seen;
}

interface VersionRow {
  id: number;
  entryId: number;
  version: number;
  contentHash: string;
  editor: string;
  sourceId: number;
  sourceKind: string;
}

interface RunRow {
  id: number;
  task: string;
  engine: string;
  model: string | null;
  scope: string;
  schemaId: number | null;
  status: 'done' | 'failed' | 'undone';
  counts: string;
  startedAt: string;
  finishedAt: string | null;
}

/** Versions an import writes carry this editor; every other version is an edit. */
const IMPORTED = 'import';

const VERSIONS = `SELECT v.id, v.entry_id AS entryId, v.version, v.content_hash AS contentHash, v.editor,
    e.source_id AS sourceId, s.kind AS sourceKind
  FROM versions v JOIN entries e ON e.id = v.entry_id JOIN sources s ON s.id = e.source_id`;

function versionDigest(rows: { id: number; entryId: number; version: number; contentHash: string }[]): string {
  const hash = createHash('sha256');
  for (const r of rows) hash.update(`${r.id} ${r.entryId} ${r.version} ${r.contentHash}\n`);
  return hash.digest('hex');
}

type Draft = Omit<ImportLine, keyof Base> | Omit<EditLine, keyof Base> | Omit<RunLine, keyof Base>;

/** What happened in the record since the ledger's last line, in order: versions by id, then runs by id. */
function newEvents(store: Store, seen: Seen): Draft[] {
  const db = store.db;
  const newest = Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM versions').get() as { m: number }).m);
  if (newest < seen.version) {
    throw new Error(
      `The ledger records versions up to #${seen.version}, but the record's newest is #${newest}: record.db was replaced or ` +
        `rolled back since. Move ${LEDGER_FILE} aside to start a new ledger, or put the old record.db back.`,
    );
  }
  const drafts: Draft[] = [];
  const imports = new Map<number, VersionRow[]>();
  const rows = db.prepare(`${VERSIONS} WHERE v.id > ? ORDER BY v.id`).all(seen.version) as unknown as VersionRow[];
  for (const row of rows) {
    if (row.editor !== IMPORTED) {
      drafts.push({ kind: 'edit', entry: row.entryId, version: row.version, versionId: row.id, editor: row.editor, hash: row.contentHash });
      continue;
    }
    const batch = imports.get(row.sourceId);
    if (batch) {
      batch.push(row);
      continue;
    }
    const first = [row];
    imports.set(row.sourceId, first);
    // A placeholder at the import's first version keeps lines in version order; it is filled in below.
    drafts.push({ kind: 'import', source: row.sourceId, sourceKind: row.sourceKind, versions: [row.id, row.id], count: 0, digest: '' });
  }
  for (const draft of drafts) {
    if (draft.kind !== 'import') continue;
    const batch = imports.get(draft.source)!;
    draft.versions = [batch[0]!.id, batch[batch.length - 1]!.id];
    draft.count = batch.length;
    draft.digest = versionDigest(batch);
  }
  const runs = db
    .prepare(
      `SELECT id, task, engine, model, scope, schema_id AS schemaId, status, counts, started_at AS startedAt,
              finished_at AS finishedAt
       FROM runs WHERE status IN ('done', 'failed', 'undone') ORDER BY id`,
    )
    .all() as unknown as RunRow[];
  for (const r of runs) {
    if (seen.runs.get(r.id) === r.status) continue;
    drafts.push({
      kind: 'run',
      run: r.id,
      task: r.task,
      engine: r.engine,
      model: r.model,
      scope: r.scope,
      schema: r.schemaId,
      status: r.status,
      counts: JSON.parse(r.counts) as Record<string, number>,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    });
  }
  return drafts;
}

export interface CatchUpOptions {
  /** How long to wait for another process that is writing the ledger, in ms (default 10 s). */
  wait?: number;
}

/**
 * Appends a line for each import, edit and run the ledger hasn't recorded yet, and returns them. Safe to call after
 * every import, run or capture, from several processes at once: one writes at a time, and nothing new adds nothing.
 */
export function catchUpLedger(store: Store, home: string, options: CatchUpOptions = {}): LedgerLine[] {
  return withLock(home, options.wait ?? 10_000, () => {
    const { lines, cutOff } = readLedgerText(home);
    if (cutOff) {
      throw new Error(
        `${LEDGER_FILE} ends in the middle of line ${lines.length}: something stopped while it was being written. ` +
          'Nothing more is added until it is looked at; see what is wrong with: skeinwise ledger verify',
      );
    }
    const parsed = lines.map((text, i) => {
      const line = parseLine(text);
      if (!line) throw new Error(`Line ${i + 1} of ${LEDGER_FILE} isn't a ledger line. See what is wrong with: skeinwise ledger verify`);
      return line;
    });
    const drafts = newEvents(store, seenIn(parsed));
    if (!drafts.length) return [];
    let prev = lines.length ? lineHash(lines[lines.length - 1]!) : null;
    let n = lines.length;
    const at = store.now();
    const added: LedgerLine[] = [];
    const texts: string[] = [];
    for (const draft of drafts) {
      const line = { n: ++n, prev, at, ...draft } as LedgerLine;
      const text = JSON.stringify(line);
      added.push(line);
      texts.push(text);
      prev = lineHash(text);
    }
    appendFileSync(ledgerPath(home), `${texts.join('\n')}\n`, { mode: 0o600 });
    return added;
  });
}

// One writer at a time: a lock file holding the writer's process id.

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock left by a process that is gone, or one that nobody has held for a minute, is taken over. */
const STALE_MS = 60_000;

function withLock<T>(home: string, wait: number, fn: () => T): T {
  const lock = join(home, 'ledger.lock');
  const deadline = Date.now() + wait;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let holder = 0;
    let age = 0;
    try {
      holder = Number(readFileSync(lock, 'utf8')) || 0;
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // it went away while we looked
    }
    if ((holder && !alive(holder)) || age > STALE_MS) {
      rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The ledger is busy: process ${holder || '(unknown)'} is writing it and holds ${lock}. ` +
          'If no Skeinwise is running, delete that file and try again.',
      );
    }
    pause(20);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

// Checking

export interface Problem {
  /** The first line that fails. */
  line: number;
  problem: string;
}

export interface LedgerCheck {
  lines: number;
  /** When the first and the last line were written. */
  first: string | null;
  last: string | null;
  /** The SHA-256 of the last line: what a stamp dates. */
  latest: string | null;
  /** The first break in the chain, or null when it holds. */
  chain: Problem | null;
  /** The first line the record no longer matches, or null. */
  record: Problem | null;
  /** Versions the ledger's lines account for, checked against the record. */
  versions: number;
  /** What the record holds that the ledger doesn't yet: it goes in at the next catch-up. */
  behind: { versions: number; runs: number };
}

const KINDS = new Set(['import', 'edit', 'run']);

/** Walks the chain and names the first line that breaks it. */
export function checkChain(text: LedgerText): Problem | null {
  const { lines, cutOff } = text;
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = parseLine(lines[i]!);
    if (!line) {
      if (cutOff && n === lines.length) return { line: n, problem: `Line ${n} is cut off: something stopped while it was being written.` };
      return { line: n, problem: `Line ${n} isn't a ledger line: it was changed, or written by something else.` };
    }
    if (line.n !== n) {
      return { line: n, problem: `Line ${n} says it is line ${String(line.n)}: a line was removed or added before it.` };
    }
    const want = i === 0 ? null : lineHash(lines[i - 1]!);
    if (line.prev !== want) {
      return {
        line: n,
        problem:
          i === 0
            ? 'Line 1 points back to a line before it: lines were removed from the start.'
            : `Line ${n} doesn't follow on from line ${n - 1}: line ${n - 1} was changed after line ${n} was written, or line ${n} was.`,
      };
    }
    if (!KINDS.has(line.kind)) return { line: n, problem: `Line ${n} is of a kind the ledger doesn't write (${String(line.kind)}).` };
    if (cutOff && n === lines.length) return { line: n, problem: `Line ${n} is cut off: it has no newline after it.` };
  }
  return null;
}

/**
 * Checks the record against the ledger: each import and edit line's versions are still in the record with the same
 * text (the text's hash is worked out again), and no version the ledger has passed over appeared later.
 */
function checkRecord(store: Store, lines: LedgerLine[]): { problem: Problem | null; versions: number } {
  const db = store.db;
  const body = db.prepare('SELECT body FROM versions WHERE id = ?');
  const textMatches = (id: number, contentHash: string) => {
    const row = body.get(id) as { body: string } | undefined;
    return !!row && hashText(row.body) === contentHash;
  };
  let versions = 0;
  for (const line of lines) {
    if (line.kind === 'import') {
      const rows = db
        .prepare(`${VERSIONS} WHERE v.id BETWEEN ? AND ? AND v.editor = ? AND e.source_id = ? ORDER BY v.id`)
        .all(line.versions[0], line.versions[1], IMPORTED, line.source) as unknown as VersionRow[];
      if (rows.length !== line.count || versionDigest(rows) !== line.digest) {
        return {
          problem: { line: line.n, problem: `Line ${line.n}: the versions imported from source ${line.source} (#${line.versions[0]} to #${line.versions[1]}) are no longer the ones it recorded.` },
          versions,
        };
      }
      const changed = rows.find((r) => !textMatches(r.id, r.contentHash));
      if (changed) {
        return { problem: { line: line.n, problem: `Line ${line.n}: the text of entry ${changed.entryId}, version ${changed.version}, was changed in record.db.` }, versions };
      }
      versions += rows.length;
    } else if (line.kind === 'edit') {
      const row = db.prepare(`${VERSIONS} WHERE v.id = ?`).get(line.versionId) as VersionRow | undefined;
      if (!row || row.entryId !== line.entry || row.version !== line.version || row.editor !== line.editor || row.contentHash !== line.hash) {
        return { problem: { line: line.n, problem: `Line ${line.n}: version ${line.version} of entry ${line.entry} is no longer the one it recorded.` }, versions };
      }
      if (!textMatches(row.id, row.contentHash)) {
        return { problem: { line: line.n, problem: `Line ${line.n}: the text of entry ${line.entry}, version ${line.version}, was changed in record.db.` }, versions };
      }
      versions += 1;
    }
  }
  const seen = seenIn(lines);
  const held = Number((db.prepare('SELECT COUNT(*) AS n FROM versions WHERE id <= ?').get(seen.version) as { n: number }).n);
  if (held !== versions) {
    const last = lines.length ? lines[lines.length - 1]!.n : 0;
    return {
      problem: { line: last, problem: `The record holds ${held} versions up to #${seen.version}, but the ledger accounts for ${versions}: versions were added or removed under old numbers.` },
      versions,
    };
  }
  return { problem: null, versions };
}

/** Checks the chain, then the record against the ledger. Writes nothing. */
export function checkLedger(store: Store, home: string): LedgerCheck {
  const text = readLedgerText(home);
  const chain = checkChain(text);
  const lines = text.lines.map(parseLine).filter((l): l is LedgerLine => !!l);
  const usable = chain ? lines.filter((l) => l.n < chain.line) : lines;
  const { problem, versions } = checkRecord(store, usable);
  let behind = { versions: 0, runs: 0 };
  if (!chain && !problem) {
    try {
      const drafts = newEvents(store, seenIn(lines));
      behind = {
        versions: drafts.reduce((sum, d) => sum + (d.kind === 'import' ? d.count : d.kind === 'edit' ? 1 : 0), 0),
        runs: drafts.filter((d) => d.kind === 'run').length,
      };
    } catch (err) {
      const last = lines.length ? lines[lines.length - 1]!.n : 0;
      return { ...summary(text, lines), chain, record: { line: last, problem: (err as Error).message }, versions, behind };
    }
  }
  return { ...summary(text, lines), chain, record: problem, versions, behind };
}

function summary(text: LedgerText, lines: LedgerLine[]): Pick<LedgerCheck, 'lines' | 'first' | 'last' | 'latest'> {
  return {
    lines: text.lines.length,
    first: lines[0]?.at ?? null,
    last: lines[lines.length - 1]?.at ?? null,
    latest: text.lines.length && !text.cutOff ? lineHash(text.lines[text.lines.length - 1]!) : null,
  };
}
