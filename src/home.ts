import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { openDb } from './store/db.ts';
import { Store } from './store/store.ts';

/** The record folder: $SKEINWISE_HOME, or ~/.skeinwise. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SKEINWISE_HOME || join(homedir(), '.skeinwise');
}

/**
 * From here on, every file this process makes is 0600 and every folder 0700, whatever the shell's umask (L4): the
 * record, its WAL, live.json, notes, models/ and the model file. Node allows a umask on the main thread only.
 */
export function ownerOnlyFiles(): void {
  if (isMainThread) process.umask(0o077);
}

/**
 * Makes what sits directly in the record folder owner-only: files 0600, folders 0700, so whatever is nested inside
 * them is closed too. Links are left alone, so a planted one can't change a file elsewhere. Returns what it changed.
 */
export function ownerOnlyModes(home: string): string[] {
  const changed: string[] = [];
  for (const name of readdirSync(home)) {
    const path = join(home, name);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) continue;
    const mode = st.isDirectory() ? 0o700 : 0o600;
    if ((st.mode & 0o777) === mode) continue;
    chmodSync(path, mode);
    changed.push(name);
  }
  return changed;
}

/**
 * Creates the record folder (owner-only) if needed and opens its store, with the given clock or the real one. A
 * folder made by an older version, under a looser umask, is made owner-only on the way. record.db is owner-only too
 * (0600), set before SQLite opens it: SQLite gives the -wal and -shm files it creates the database file's mode. Those
 * two are set again after the open, for a record made before this rule.
 */
export function openHome(home: string, now?: () => string): Store {
  ownerOnlyFiles();
  mkdirSync(join(home, 'notes'), { recursive: true });
  chmodSync(home, 0o700);
  ownerOnlyModes(home);
  const db = join(home, 'record.db');
  if (!existsSync(db)) closeSync(openSync(db, 'a', 0o600));
  chmodSync(db, 0o600);
  const store = new Store(openDb(db), now);
  for (const side of [`${db}-wal`, `${db}-shm`]) if (existsSync(side)) chmodSync(side, 0o600);
  return store;
}
