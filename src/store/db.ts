import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

/** Opens (or creates) a record database and brings its schema up to date. */
export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
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
    for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
      db.exec('BEGIN');
      try {
        db.exec(MIGRATIONS[v]!);
        const broken = db.prepare('PRAGMA foreign_key_check').all() as { table: string; parent: string }[];
        if (broken.length) {
          const where = [...new Set(broken.map((b) => `${b.table} → ${b.parent}`))].join(', ');
          throw new Error(`Migration ${v + 1} would leave ${broken.length} broken reference(s) (${where}). Nothing was changed.`);
        }
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  } finally {
    if (enforced) db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Runs fn inside one transaction; rolls back and rethrows on error. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
