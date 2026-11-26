import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_NOW } from '../../src/demo/demo.ts';
import { UsageError } from '../../src/errors.ts';
import { newNote, notesDir, readNotes } from '../../src/notes.ts';
import type { Store } from '../../src/store/store.ts';
import { BUNDLE_FILE, notEmpty, readHeader } from '../../src/sync/bundle.ts';
import { type KdfParams, KEYS_FILE } from '../../src/sync/keys.ts';
import { joinSync, pushSync, readState, STATE_FILE, startSync, syncStatus } from '../../src/sync/sync.ts';
import { closeRecords, count, demoRecord, dump, openRecord } from './fixture.ts';
import { expectMode } from '../modes.ts';

// Sync between record folders on one disk, standing in for two computers and a cloud folder. The passphrase is made
// up for the test; scrypt runs on light settings here (the command tests use the real ones).

const LIGHT: KdfParams = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'made-up test passphrase';

let dir: string;
let a: { home: string; store: Store };
let folder: string;
let phrase: string;
let n = 0;

/** A new, empty record folder: another computer. */
function computer(): { home: string; store: Store } {
  const home = join(dir, `computer-${++n}`);
  return { home, store: openRecord(home) };
}

/** What an empty record folder looks like, to check a refused join left it so. */
function snapshot(c: { home: string; store: Store }) {
  return { files: readdirSync(c.home).sort(), rows: dump(c.store.db) };
}

function expectUntouched(c: { home: string; store: Store }, before: ReturnType<typeof snapshot>) {
  expect(snapshot(c)).toEqual(before);
  expect(notEmpty(c.store, c.home)).toBeNull();
  expect(existsSync(join(c.home, STATE_FILE))).toBe(false);
}

/** A copy of the sync folder with one change made to it. */
function changedFolder(change: (bundle: Buffer, keys: string) => { bundle?: Buffer; keys?: string }): string {
  const copy = join(dir, `changed-${++n}`);
  cpSync(folder, copy, { recursive: true });
  const out = change(readFileSync(join(copy, BUNDLE_FILE)), readFileSync(join(copy, KEYS_FILE), 'utf8'));
  if (out.bundle) writeFileSync(join(copy, BUNDLE_FILE), out.bundle);
  if (out.keys) writeFileSync(join(copy, KEYS_FILE), out.keys);
  return copy;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-sync-'));
  a = await demoRecord(dir, 'a');
  folder = join(dir, 'cloud', 'skeinwise');
  phrase = startSync(a.store, a.home, folder, PASS, LIGHT).phrase;
});
afterAll(() => {
  closeRecords();
  rmSync(dir, { recursive: true, force: true });
});

describe('sync init', () => {
  it('writes a key file and a bundle to the folder, owner-only, with neither secret in them', () => {
    expect(readdirSync(folder).sort()).toEqual([BUNDLE_FILE, KEYS_FILE]);
    for (const f of [BUNDLE_FILE, KEYS_FILE]) expectMode(join(folder, f), 0o600);
    const keys = readFileSync(join(folder, KEYS_FILE), 'utf8');
    expect(keys).not.toContain(PASS);
    for (const w of phrase.split(' ')) expect(keys).not.toMatch(new RegExp(`\\b${w}\\b`));
    const { header } = readHeader(readFileSync(join(folder, BUNDLE_FILE)), 'b');
    expect(header).toMatchObject({ seq: 1, keyId: JSON.parse(keys).keyId, createdAt: DEMO_NOW });
    expect(readState(a.home)).toMatchObject({ folder, seq: 1 });
    expectMode(join(a.home, STATE_FILE), 0o600);
  });

  it('refuses a second start, from this record or into a folder that already holds a sync', () => {
    expect(() => startSync(a.store, a.home, join(dir, 'elsewhere'), PASS, LIGHT)).toThrow(/already syncs with/);
    const b = computer();
    expect(() => startSync(b.store, b.home, folder, PASS, LIGHT)).toThrow(/already holds a Skeinwise sync/);
    expect(() => startSync(b.store, b.home, join(dir, 'x'), 'too short', LIGHT)).toThrow(/at least 14/);
    expect(existsSync(join(dir, 'x'))).toBe(false);
    expect(() => startSync(b.store, b.home, join(b.home, 'notes', 'sync'), PASS, LIGHT)).toThrow(/inside the record folder/);
    expect(() => startSync(b.store, b.home, b.home, PASS, LIGHT)).toThrow(/inside the record folder/);
  });
});

describe('sync join', () => {
  it('makes an empty record a copy of the folder: every row, the notes, the search, the side files', () => {
    const b = computer();
    writeFileSync(join(b.home, 'app.json'), '{"theme":"mine"}\n');
    const joined = joinSync(b.store, b.home, folder, { passphrase: PASS });
    expect(joined).toMatchObject({ seq: 1, entries: count(a.store.db, 'entries'), wrote: ['config.json', 'ledger.jsonl'], kept: ['app.json'] });

    const mine = dump(a.store.db);
    const theirs = dump(b.store.db);
    for (const t of Object.keys(mine)) if (t !== 'sources') expect(theirs[t], t).toEqual(mine[t]);
    // Every table that matters had rows to carry.
    for (const t of ['entries', 'versions', 'threads', 'entry_search', 'tags', 'entry_tags', 'folders', 'hubs', 'runs']) expect(count(b.store.db, t), t).toBeGreaterThan(0);

    // The notes folder source now names this computer's notes folder, so reading the notes again adds nothing.
    const notesSource = (s: Store) => s.db.prepare(`SELECT location FROM sources WHERE kind = 'notes'`).get() as { location: string };
    expect(notesSource(a.store).location).toBe(notesDir(a.home));
    expect(notesSource(b.store).location).toBe(notesDir(b.home));
    readNotes(b.store, b.home);
    expect(dump(b.store.db).versions).toEqual(mine.versions);

    const files = (home: string) => readdirSync(notesDir(home), { recursive: true }).map(String).sort();
    expect(files(b.home)).toEqual(files(a.home));
    expect(readFileSync(join(b.home, 'ledger.jsonl'), 'utf8')).toBe(readFileSync(join(a.home, 'ledger.jsonl'), 'utf8'));
    expect(readFileSync(join(b.home, 'app.json'), 'utf8')).toBe('{"theme":"mine"}\n');
    expect(b.store.search('sourdough').length).toBe(a.store.search('sourdough').length);
    expect(b.store.search('sourdough').length).toBeGreaterThan(0);
    expect(readState(b.home)).toMatchObject({ folder, seq: 1 });
    expect(readState(b.home)!.computer).not.toBe(readState(a.home)!.computer);
  });

  it('restore opens the same folder with the recovery phrase, however it was written down', () => {
    const c = computer();
    const written = phrase
      .split(' ')
      .map((w, i) => `${i + 1}. ${w.toUpperCase()}`)
      .join('\n');
    expect(joinSync(c.store, c.home, folder, { phrase: written }).entries).toBe(count(a.store.db, 'entries'));
  });

  it('a wrong passphrase or phrase fails loudly and writes nothing', () => {
    const c = computer();
    const before = snapshot(c);
    expect(() => joinSync(c.store, c.home, folder, { passphrase: `${PASS}x` })).toThrow(UsageError);
    expect(() => joinSync(c.store, c.home, folder, { passphrase: `${PASS}x` })).toThrow(/does not open the sync.*Nothing was written.*sync restore/s);
    expectUntouched(c, before);
    const other = phrase.split(' ').reverse().join(' ');
    expect(() => joinSync(c.store, c.home, folder, { phrase: other })).toThrow(/recovery phrase does not open/);
    expect(() => joinSync(c.store, c.home, folder, { phrase: 'acorn acorn' })).toThrow(/has 24 words/);
    expectUntouched(c, before);
  });

  it('a bundle changed after it was written fails its check and writes nothing', () => {
    const c = computer();
    const before = snapshot(c);
    const middle = changedFolder((bundle) => {
      bundle[Math.floor(bundle.length / 2)]! ^= 1;
      return { bundle };
    });
    expect(() => joinSync(c.store, c.home, middle, { passphrase: PASS })).toThrow(/fails its check: it was changed or damaged.*Nothing was written/);
    // The header isn't secret, but it is checked: a push number moved by hand fails too.
    const header = changedFolder((bundle) => {
      const { headLength } = readHeader(bundle, 'b');
      const head = bundle.subarray(0, headLength).toString('latin1').replace('"seq":1,', '"seq":9,');
      return { bundle: Buffer.concat([Buffer.from(head, 'latin1'), bundle.subarray(headLength)]) };
    });
    expect(() => joinSync(c.store, c.home, header, { passphrase: PASS })).toThrow(/fails its check/);
    const cut = changedFolder((bundle) => ({ bundle: bundle.subarray(0, bundle.length - 100) }));
    expect(() => joinSync(c.store, c.home, cut, { passphrase: PASS })).toThrow(/fails its check/);
    const stub = changedFolder(() => ({ bundle: Buffer.from('not a bundle at all') }));
    expect(() => joinSync(c.store, c.home, stub, { passphrase: PASS })).toThrow(/is not a Skeinwise bundle/);
    expectUntouched(c, before);
  });

  it('a changed key file opens with nothing, and writes nothing', () => {
    const c = computer();
    const before = snapshot(c);
    const slot = changedFolder((_b, keys) => {
      const file = JSON.parse(keys);
      const sealed = Buffer.from(file.slots.passphrase.key, 'base64');
      sealed[0]! ^= 1;
      file.slots.passphrase.key = sealed.toString('base64');
      return { keys: JSON.stringify(file) };
    });
    expect(() => joinSync(c.store, c.home, slot, { passphrase: PASS })).toThrow(/does not open the sync/);
    // A key file from another sync next to this bundle: its key opens, but it is not this bundle's key.
    const foreign = changedFolder((_b, keys) => {
      const file = JSON.parse(keys);
      file.keyId = 'f'.repeat(32);
      return { keys: JSON.stringify(file) };
    });
    expect(() => joinSync(c.store, c.home, foreign, { passphrase: PASS })).toThrow(/does not open/);
    expectUntouched(c, before);
  });

  it('goes into a notes folder that holds only empty folders, and leaves nothing of its own behind', () => {
    const c = computer();
    mkdirSync(join(notesDir(c.home), 'daily', 'old'), { recursive: true });
    expect(joinSync(c.store, c.home, folder, { passphrase: PASS }).entries).toBe(count(a.store.db, 'entries'));
    expect(readdirSync(notesDir(c.home), { recursive: true }).map(String).sort()).toEqual(readdirSync(notesDir(a.home), { recursive: true }).map(String).sort());
    expect(readdirSync(c.home).filter((f) => f.startsWith('.sync-'))).toEqual([]);
  });

  it('when the copy fails after the notes are in place, takes them out again', () => {
    const c = computer();
    mkdirSync(join(notesDir(c.home), 'daily'));
    const before = snapshot(c);
    // A transaction already open makes the copy's own BEGIN fail, after the notes went in.
    c.store.db.exec('BEGIN');
    expect(() => joinSync(c.store, c.home, folder, { passphrase: PASS })).toThrow(/transaction/);
    c.store.db.exec('ROLLBACK');
    expectUntouched(c, before);
    expect(readdirSync(notesDir(c.home))).toEqual(['daily']);
  });

  it('refuses a record that is not empty, before anything is asked or written', () => {
    const c = computer();
    newNote(c.store, c.home, 'My own note', new Date(DEMO_NOW));
    const rows = dump(c.store.db);
    expect(() => joinSync(c.store, c.home, folder, { passphrase: PASS })).toThrow(/This record is not empty: it holds 1 entries.*SKEINWISE_HOME=/s);
    expect(dump(c.store.db)).toEqual(rows);
    // A record whose notes folder has a file it hasn't read yet is not empty either, nor one with a ledger.
    const d = computer();
    writeFileSync(join(notesDir(d.home), 'loose.md'), '# Loose\n');
    expect(() => joinSync(d.store, d.home, folder, { passphrase: PASS })).toThrow(/notes folder has files/);
    const e = computer();
    writeFileSync(join(e.home, 'ledger.jsonl'), '\n');
    expect(() => joinSync(e.store, e.home, folder, { passphrase: PASS })).toThrow(/ledger/);
    const g = computer();
    symlinkSync(join(dir, 'somewhere'), join(notesDir(g.home), 'link.md'));
    expect(notEmpty(g.store, g.home)).toMatch(/notes folder has files/);
    // Settings alone don't count.
    const f = computer();
    writeFileSync(join(f.home, 'config.json'), '{}\n');
    expect(notEmpty(f.store, f.home)).toBeNull();
    expect(() => joinSync(a.store, a.home, folder, { passphrase: PASS })).toThrow(/already syncs/);
    expect(() => joinSync(f.store, f.home, join(dir, 'nowhere'), { passphrase: PASS })).toThrow(/There is no folder/);
  });
});

describe('sync push', () => {
  it('writes a fresh bundle, and refuses to replace another computer’s newer one unless forced', () => {
    const b = computer();
    joinSync(b.store, b.home, folder, { passphrase: PASS });
    b.store.ingest({ source: { kind: 'test', label: 'Test', location: '' }, threads: [], entries: [{ externalId: 'x', kind: 'note', speaker: 'you', createdAt: DEMO_NOW, body: 'Made up on b' }] });
    expect(pushSync(b.store, b.home)).toMatchObject({ seq: 2, entries: count(a.store.db, 'entries') + 1, replaced: null });

    expect(syncStatus(a.home)).toMatchObject({ syncing: true, seq: 1, folderSeq: 2, behind: true });
    expect(() => pushSync(a.store, a.home)).toThrow(/Another computer pushed.*push 2.*Nothing was written.*--force/s);
    expect(readHeader(readFileSync(join(folder, BUNDLE_FILE)), 'b').header.seq).toBe(2);

    const forced = pushSync(a.store, a.home, { force: true });
    expect(forced).toMatchObject({ seq: 3, replaced: { seq: 2 } });
    expect(syncStatus(a.home)).toMatchObject({ seq: 3, folderSeq: 3, behind: false });
    expect(() => pushSync(b.store, b.home)).toThrow(/Another computer pushed/);

    // A computer joining now gets a's record, push 3.
    const c = computer();
    expect(joinSync(c.store, c.home, folder, { passphrase: PASS })).toMatchObject({ seq: 3, entries: count(a.store.db, 'entries') });
  });

  it('needs a sync to push to, and the same one it started', () => {
    const c = computer();
    expect(() => pushSync(c.store, c.home)).toThrow(/does not sync yet/);
    expect(syncStatus(c.home)).toEqual({ syncing: false });
    const other = join(dir, 'other-sync');
    const d = computer();
    startSync(d.store, d.home, other, PASS, LIGHT);
    cpSync(join(other, KEYS_FILE), join(dir, 'replaced-keys'));
    const e = computer();
    startSync(e.store, e.home, join(dir, 'third'), PASS, LIGHT);
    cpSync(join(dir, 'replaced-keys'), join(dir, 'third', KEYS_FILE));
    expect(() => pushSync(e.store, e.home)).toThrow(/now holds a different sync/);
    expect(syncStatus(e.home).problem).toMatch(/different sync/);
  });
});
