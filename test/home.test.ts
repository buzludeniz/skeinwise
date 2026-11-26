import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { openHome, ownerOnlyModes } from '../src/home.ts';
import { appendDailyNote } from '../src/notes.ts';

// PoC 14 (L4): under the usual umask 022, record.db, its WAL and shm, live.json and notes/ came out readable by every
// account on the computer, while config.json and the notes were 0600. Now everything in the record folder is
// owner-only, whatever the umask: files 0600, folders 0700.

let dir: string;
let saved: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-home-'));
  saved = process.umask(0o022); // the shell's usual umask, as PoC 14 ran it
});
afterEach(() => {
  process.umask(saved);
  rmSync(dir, { recursive: true, force: true });
});

/** Every file and folder under `root`, with its mode, links left out. */
function modes(root: string, prefix = ''): [string, number][] {
  const found: [string, number][] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    found.push([`${prefix}${name}${st.isDirectory() ? '/' : ''}`, st.mode & 0o777]);
    if (st.isDirectory()) found.push(...modes(path, `${prefix}${name}/`));
  }
  return found;
}

const loose = (found: [string, number][]) => found.filter(([name, mode]) => mode !== (name.endsWith('/') ? 0o700 : 0o600));

describe('the record folder is owner-only (PoC 14)', () => {
  it('makes record.db, its WAL and shm, notes and every folder owner-only under umask 022', async () => {
    const home = join(dir, 'record');
    const io = { out: () => {}, err: () => {}, env: { SKEINWISE_HOME: home, HOME: dir } };
    const chats = join(dir, 'export');
    mkdirSync(chats);
    writeFileSync(
      join(chats, 'conversations.json'),
      JSON.stringify([
        {
          id: 'poc-14',
          title: 'A made-up chat',
          create_time: 1_700_000_000,
          current_node: 'm0',
          mapping: { m0: { id: 'm0', parent: null, message: { id: 'm0', author: { role: 'user' }, create_time: 1_700_000_000, content: { content_type: 'text', parts: ['made-up words'] } } } },
        },
      ]),
    );
    expect(await main(['import', chats], io)).toBe(0);
    expect(await main(['note', 'Fed the starter'], io)).toBe(0);
    expect(await main(['new-note', 'Private plan'], io)).toBe(0);
    expect(await main(['config', 'localModel', 'made-up-model'], io)).toBe(0);
    // With the record open, the WAL and shm are on disk, as they are while `live` runs.
    const store = openHome(home);
    appendDailyNote(store, home, 'Shaped the loaf', new Date(2026, 10, 25));
    mkdirSync(join(home, 'models')); // as `model fetch` makes it, after the record is open
    writeFileSync(join(home, 'models', 'made-up.gguf'), '');
    writeFileSync(join(home, 'live.json'), '{}');
    const found = modes(home);
    store.db.close();
    expect(found.map(([name]) => name)).toEqual(expect.arrayContaining(['record.db', 'record.db-wal', 'record.db-shm', 'notes/', 'notes/daily/', 'models/', 'live.json']));
    expect(loose(found)).toEqual([]);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('closes a record folder an older version left open, and leaves links and what they point at alone', () => {
    // What an older version left under umask 022: folders 0755, files 0644 (an empty record.db opens as a new one).
    const home = join(dir, 'old');
    mkdirSync(join(home, 'notes', 'daily'), { recursive: true });
    mkdirSync(join(home, 'models'));
    for (const file of ['record.db', 'live.json', 'config.json']) writeFileSync(join(home, file), '');
    const shared = join(dir, 'shared.txt');
    writeFileSync(shared, 'not the record');
    symlinkSync(shared, join(home, 'link.txt'));
    chmodSync(home, 0o755);
    expect(loose(modes(home)).length).toBeGreaterThan(5);

    openHome(home).db.close();

    // What sits directly in the folder is closed; notes/daily stays 0755, unreachable inside notes/ at 0700.

    const top = modes(home).filter(([name]) => !name.slice(0, -1).includes('/'));
    expect(loose(top)).toEqual([]);
    expect(statSync(shared).mode & 0o777).toBe(0o644);
    expect(ownerOnlyModes(home)).toEqual([]); // a second pass has nothing left to change
  });
});

// Main's own check (91be4f0): record.db is 0600 before SQLite opens it, so the -wal and -shm it makes are too.
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
