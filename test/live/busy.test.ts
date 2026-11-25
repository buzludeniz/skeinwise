// M8, live side: another process holding the record's write lock made live's timer-driven flush throw, and the throw
// ended `skeinwise live` without a word. Built from the audit's PoC 17: a lock holder runs BEGIN IMMEDIATE while a note
// changes; live must keep running and save the note once the lock is released.
//
// The record's connection gets busy_timeout 0 here, so the lock fails at once instead of after the store's own wait.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBusy, LiveCapture, readStatus } from '../../src/live/capture.ts';
import { openHome } from '../../src/home.ts';
import type { Store } from '../../src/store/store.ts';

let dir: string;
let home: string;
let vault: string;
let store: Store;
let holder: DatabaseSync | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-busy-'));
  home = join(dir, 'home');
  vault = join(dir, 'Vault');
  mkdirSync(vault);
  store = openHome(home);
  store.db.exec('PRAGMA busy_timeout = 0');
});
afterEach(() => {
  holder?.close();
  holder = undefined;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Holds the record's write lock from a second connection, as `17_hold_lock.mjs` does. */
function holdLock(): () => void {
  holder = new DatabaseSync(join(home, 'record.db'));
  holder.exec('BEGIN IMMEDIATE');
  holder.exec("INSERT INTO sources (kind, label, location, added_at) VALUES ('notes', 'lock-holder', '/lock-holder', '2026-11-25')");
  return () => holder!.exec('ROLLBACK');
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a busy record', () => {
  it('is what SQLite reports while another connection holds the write lock', () => {
    const release = holdLock();
    let thrown: unknown;
    try {
      store.upsertSource({ kind: 'notes', label: 'Vault', location: vault });
    } catch (error) {
      thrown = error;
    }
    release();
    expect(isBusy(thrown)).toBe(true);
    expect(isBusy(new Error('database is locked'))).toBe(false);
    expect(isBusy(Object.assign(new Error('constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 19 }))).toBe(false);
  });

  it('never stops watching: the note waits and is saved once the lock is released (PoC 17)', async () => {
    const warnings: string[] = [];
    let saved = 0;
    const statusFile = join(home, 'live.json');
    const live = new LiveCapture(store, [{ kind: 'tree', path: vault }], {
      statusFile,
      debounceMs: 30,
      busyRetryMs: 60,
      onSaved: () => (saved += 1),
      onWarning: (l) => warnings.push(l),
    });
    live.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      const release = holdLock();
      writeFileSync(join(vault, 'two.md'), '# two\n\nThe shed key is under the blue pot.');
      await until(() => readStatus(statusFile).errors.some((e) => e.path === 'the record'));
      expect(readStatus(statusFile).errors[0]!.error).toBe('another skeinwise command is writing to it; trying again in 1 s');
      expect(saved).toBe(0);
      await new Promise((r) => setTimeout(r, 200)); // several retries, all busy, none of them fatal
      release();
      await until(() => saved > 0);
    } finally {
      live.stop();
    }
    expect(store.search('blue pot')).toHaveLength(1);
    const status = readStatus(statusFile);
    expect(status.errors).toEqual([]);
    expect(status.caught).toEqual([{ label: 'Vault', kind: 'notes', threads: 0, added: 1, versioned: 0 }]);
    expect(warnings).toEqual([]);
  });

  it('cuts a catch-up short without moving the last pass, so the next one finds the file', () => {
    const statusFile = join(home, 'live.json');
    const live = new LiveCapture(store, [{ kind: 'tree', path: vault }], { statusFile });
    expect(live.scan().lastPassAt).not.toBeNull();
    const before = readStatus(statusFile).lastPassAt;
    writeFileSync(join(vault, 'three.md'), 'Seed potatoes go in on Saturday.');

    const release = holdLock();
    const busy = live.scan();
    release();
    expect(busy.lastPassAt).toBe(before);
    expect(busy.errors).toEqual([{ path: 'the record', error: 'another skeinwise command is writing to it; run live again once it is free' }]);
    expect(store.search('Seed potatoes')).toEqual([]);

    const after = live.scan();
    expect(after.errors).toEqual([]);
    expect(store.search('Seed potatoes')).toHaveLength(1);
  });

  it('a watched pass that fails as a whole is reported, and live keeps watching', async () => {
    const warnings: string[] = [];
    const live = new LiveCapture(store, [{ kind: 'tree', path: vault }], {
      statusFile: join(home, 'live.json'),
      debounceMs: 30,
      onWarning: (l) => warnings.push(l),
    });
    const sources = store.sources.bind(store);
    let failures = 1;
    store.sources = () => {
      if (failures-- > 0) throw new Error('disk I/O error');
      return sources();
    };
    live.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(join(vault, 'four.md'), 'Compost turns monthly.');
      await until(() => warnings.length > 0);
      expect(warnings).toEqual(['a capture pass failed: disk I/O error. Live keeps watching.']);
      writeFileSync(join(vault, 'four.md'), 'Compost turns monthly, and the bins rotate in spring.');
      await until(() => store.search('bins rotate').length > 0);
    } finally {
      live.stop();
    }
  });
});
