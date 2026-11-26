import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

/** How long a write waits for another process (live capture, serve, the CLI) to finish its own, in ms. */
export const BUSY_TIMEOUT_MS = 5000;

/** Opens (or creates) a record database and brings its schema up to date. */
export function openDb(file: string, { busyTimeoutMs = BUSY_TIMEOUT_MS }: { busyTimeoutMs?: number } = {}): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // Before anything else touches the file: several processes share one record, and without a timeout a write that
  // meets another fails at once with "database is locked".
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function migrate(db: DatabaseSync): void {
  if (schemaVersion(db) >= MIGRATIONS.length) return;
  // A migration may rebuild a table that others point at, which SQLite allows only with foreign keys off (and the
  // pragma is ignored inside a transaction). The check before each commit still refuses a dangling reference.
  const enforced = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
  if (enforced) db.exec('PRAGMA foreign_keys = OFF');
  try {
    // Each step takes the write lock first (BEGIN IMMEDIATE, waiting out the busy timeout) and reads the version again
    // inside it. Two processes that open an old record together queue on the lock, and the second sees the first's
    // commit instead of running the same migration again.
    while (inTransaction(db, () => migrateOnce(db))) {
      // Next version.
    }
  } finally {
    if (enforced) db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Runs the record's next migration inside the caller's transaction; false when the record is already up to date. */
function migrateOnce(db: DatabaseSync): boolean {
  const v = schemaVersion(db);
  if (v >= MIGRATIONS.length) return false;
  db.exec(MIGRATIONS[v]!);
  const broken = db.prepare('PRAGMA foreign_key_check').all() as { table: string; parent: string }[];
  if (broken.length) {
    const where = [...new Set(broken.map((b) => `${b.table} → ${b.parent}`))].join(', ');
    throw new Error(`Migration ${v + 1} would leave ${broken.length} broken reference(s) (${where}). Nothing was changed.`);
  }
  db.exec(`PRAGMA user_version = ${v + 1}`);
  return true;
}

/** SQLITE_BUSY, or one of its extended codes: another connection holds the write lock past the busy timeout. */
export function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === 'number' && (code & 0xff) === 5;
}

/**
 * Runs fn inside one write transaction; rolls back and rethrows on error. BEGIN IMMEDIATE takes the write lock up
 * front, so a busy record fails at the start (after the busy timeout), before fn has done anything. When another
 * process still holds the lock, the whole transaction runs once more; a second busy is thrown, never swallowed.
 * fn may run twice, so it must touch nothing outside this database.
 *
 * Called inside a transaction that inTransaction itself opened, fn joins it, so a caller can make several writes one
 * change. The outer commit or rollback covers both, and an inner throw rolls the whole transaction back even if the
 * outer fn catches it. A transaction opened any other way (a raw BEGIN) is not joined: BEGIN IMMEDIATE refuses it.
 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const open = opened.get(db);
  if (open && db.isTransaction) return joinTransaction(open, fn);
  try {
    return runTransaction(db, fn);
  } catch (error) {
    if (!isBusy(error)) throw error;
    return runTransaction(db, fn);
  }
}

/** The transaction inTransaction opened on a connection: how many calls deep it is, and an inner call's failure. */
interface OpenTransaction {
  depth: number;
  failed?: unknown;
}

const opened = new WeakMap<DatabaseSync, OpenTransaction>();

function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  const open: OpenTransaction = { depth: 1 };
  opened.set(db, open);
  try {
    const result = fn();
    // An inner call failed and the outer fn went on: its half-done writes must not be committed.
    if (open.failed !== undefined) throw open.failed;
    db.exec('COMMIT');
    return result;
  } catch (err) {
    // A failed COMMIT may already have ended the transaction.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  } finally {
    opened.delete(db);
  }
}

function joinTransaction<T>(open: OpenTransaction, fn: () => T): T {
  open.depth++;
  try {
    return fn();
  } catch (err) {
    open.failed ??= err;
    throw err;
  } finally {
    open.depth--;
  }
}
