import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './store/db.ts';
import { Store } from './store/store.ts';

/** The record folder: $SKEINWISE_HOME, or ~/.skeinwise. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SKEINWISE_HOME || join(homedir(), '.skeinwise');
}

/**
 * Creates the record folder (owner-only) if needed and opens its store, with the given clock or the real one. record.db
 * is owner-only too (0600), set before SQLite opens it: SQLite gives the -wal and -shm files it creates the database
 * file's mode. Those two are set again after the open, for a record made before this rule.
 */
export function openHome(home: string, now?: () => string): Store {
  mkdirSync(join(home, 'notes'), { recursive: true });
  chmodSync(home, 0o700);
  const db = join(home, 'record.db');
  if (!existsSync(db)) closeSync(openSync(db, 'a', 0o600));
  chmodSync(db, 0o600);
  const store = new Store(openDb(db), now);
  for (const side of [`${db}-wal`, `${db}-shm`]) if (existsSync(side)) chmodSync(side, 0o600);
  return store;
}
