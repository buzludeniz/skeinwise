import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openHome } from '../src/home.ts';

const posix = process.platform !== 'win32';
const mode = (file: string) => statSync(file).mode & 0o777;

describe('openHome', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-home-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.runIf(posix)('makes a new record owner-only: the folder 0700, record.db and its -wal and -shm 0600', () => {
    const home = join(dir, 'record');
    const store = openHome(home);
    try {
      store.db.exec('CREATE TABLE IF NOT EXISTS t (x)');
      expect(mode(home)).toBe(0o700);
      // The store runs in WAL mode, so SQLite has made -wal and -shm by now, with record.db's mode.
      for (const name of ['record.db', 'record.db-wal', 'record.db-shm']) expect(mode(join(home, name)), name).toBe(0o600);
    } finally {
      store.db.close();
    }
  });

  it.runIf(posix)('tightens a record.db made before the rule', () => {
    const home = join(dir, 'old');
    openHome(home).db.close();
    chmodSync(join(home, 'record.db'), 0o644);
    writeFileSync(join(home, 'record.db-wal'), '');
    chmodSync(join(home, 'record.db-wal'), 0o644);
    const store = openHome(home);
    try {
      expect(mode(join(home, 'record.db'))).toBe(0o600);
      expect(mode(join(home, 'record.db-wal'))).toBe(0o600);
    } finally {
      store.db.close();
    }
  });
});
