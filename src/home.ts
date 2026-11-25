import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './store/db.ts';
import { Store } from './store/store.ts';

/** The record folder: $SKEINWISE_HOME, or ~/.skeinwise. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SKEINWISE_HOME || join(homedir(), '.skeinwise');
}

/** Creates the record folder (owner-only) if needed and opens its store, with the given clock or the real one. */
export function openHome(home: string, now?: () => string): Store {
  mkdirSync(join(home, 'notes'), { recursive: true });
  chmodSync(home, 0o700);
  return new Store(openDb(join(home, 'record.db')), now);
}
