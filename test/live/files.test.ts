// H2 and LS-04: capture keeps one row per watched file, so one file's failure is that file's alone, a failed file is
// tried again on a schedule, and nothing is skipped because a pass moved past it. Built from the audit's PoC 04 (five
// good sessions and one with a nanosecond timestamp) and PoC 04b (fifty notes and one with an impossible date).

import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.ts';
import { setConfigValue } from '../../src/config.ts';
import { openHome } from '../../src/home.ts';
import { LiveCapture, writeStatus } from '../../src/live/capture.ts';
import { FileTable } from '../../src/live/files.ts';
import { readFilesUnder } from '../../src/importers/detect.ts';
import { openDb } from '../../src/store/db.ts';
import { Store as RecordStore, type Store } from '../../src/store/store.ts';

const json = (o: object) => JSON.stringify(o) + '\n';

function goodSession(s: number, lines = 4, from = 0): string {
  let t = '';
  for (let i = from; i < from + lines; i++) {
    t += json({
      type: i % 2 ? 'assistant' : 'user',
      sessionId: `sess-${s}`,
      uuid: `u-${s}-${i}`,
      timestamp: `2026-11-20T10:${String(i).padStart(2, '0')}:00Z`,
      message: { role: i % 2 ? 'assistant' : 'user', content: `important work, session ${s}, line ${i}` },
    });
  }
  return t;
}

const BAD = json({ type: 'user', sessionId: 'bad', uuid: 'b1', timestamp: 1.7e18, message: { role: 'user', content: 'x' } });

let dir: string;
let home: string;
let userHome: string;
let projects: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-files-'));
  home = join(dir, 'home');
  userHome = join(dir, 'me');
  projects = join(userHome, '.claude', 'projects', '-Users-me-proj');
  mkdirSync(projects, { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function liveOnce(): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await main(['live', '--once'], { out: (t) => (out += t), err: () => {}, env: { SKEINWISE_HOME: home, HOME: userHome } });
  return { code, out };
}

function withStore<T>(fn: (store: Store) => T): T {
  const store = openHome(home);
  try {
    return fn(store);
  } finally {
    store.db.close();
  }
}

describe('one bad file', () => {
  it('fails alone: the other sessions are saved, and the bad one is listed by its path (PoC 04)', async () => {
    for (let s = 0; s < 5; s++) writeFileSync(join(projects, `sess-${s}.jsonl`), goodSession(s));
    writeFileSync(join(projects, 'zz-bad.jsonl'), BAD);

    const first = await liveOnce();
    expect(first.code).toBe(1);
    expect(first.out).toContain('caught up 5 chats from Claude Code · 1 file(s) failed');
    expect(first.out).toContain(`failed: ${join(projects, 'zz-bad.jsonl')}: Invalid time value`);
    expect(withStore((s) => s.allEntries())).toHaveLength(20);

    // Still failing on the next pass, until the file is fixed.
    expect((await liveOnce()).out).toContain(`failed: ${join(projects, 'zz-bad.jsonl')}`);

    writeFileSync(join(projects, 'zz-bad.jsonl'), BAD.replace('1700000000000000000', '"2026-11-20T11:00:00Z"'));
    const fixed = await liveOnce();
    expect(fixed.code).toBe(0);
    expect(fixed.out).not.toContain('failed');
    expect(withStore((s) => s.allEntries())).toHaveLength(21);
  });

  it('in a notes folder fails alone, and renaming it saves it (PoC 04b)', async () => {
    const vault = join(userHome, 'Vault');
    mkdirSync(vault);
    for (let i = 0; i < 50; i++) writeFileSync(join(vault, `note-${i}.md`), `# Note ${i}\n\nPlot ${i} gets beans.`);
    writeFileSync(join(vault, 'Meeting 2023-14-02.md'), 'We agreed the shed rota.');
    openHome(home).db.close();
    setConfigValue(home, 'liveFolders', vault);

    const first = await liveOnce();
    expect(first.code).toBe(1);
    expect(first.out).toContain(`failed: ${join(vault, 'Meeting 2023-14-02.md')}: Invalid time value`);
    expect(withStore((s) => s.allEntries())).toHaveLength(50);

    renameSync(join(vault, 'Meeting 2023-14-02.md'), join(vault, 'Meeting 2023-02-14.md'));
    const renamed = await liveOnce();
    expect(renamed.code).toBe(0);
    expect(withStore((s) => s.search('shed rota'))).toHaveLength(1);
    expect(withStore((s) => s.allEntries())).toHaveLength(51);
  });
});

describe('the per-file record', () => {
  let store: Store;
  let clock: Date;
  const statusFile = () => join(home, 'live.json');
  const capture = () => new LiveCapture(store, [{ kind: 'tree', path: join(userHome, '.claude', 'projects') }], { statusFile: statusFile(), now: () => clock });
  const row = (file: string) => new FileTable(store.db).get(file);

  beforeEach(() => {
    store = openHome(home);
    clock = new Date('2026-11-25T12:00:00.000Z');
  });
  afterEach(() => store.db.close());

  it('tries a failed file again after 1 min, 5 min, 30 min, then hourly, and at once when it changes', () => {
    const bad = join(projects, 'zz-bad.jsonl');
    writeFileSync(bad, BAD);
    const live = capture();
    const at = (ms: number) => (clock = new Date(Date.parse('2026-11-25T12:00:00.000Z') + ms));
    const min = 60_000;

    live.scan();
    expect(row(bad)).toMatchObject({ attempts: 1, nextTryAt: '2026-11-25T12:01:00.000Z', lastError: 'Invalid time value' });
    at(30_000);
    live.scan();
    expect(row(bad)!.attempts).toBe(1); // not due yet
    at(1 * min);
    live.scan();
    expect(row(bad)).toMatchObject({ attempts: 2, nextTryAt: '2026-11-25T12:06:00.000Z' });
    at(6 * min);
    live.scan();
    expect(row(bad)).toMatchObject({ attempts: 3, nextTryAt: '2026-11-25T12:36:00.000Z' });
    at(36 * min);
    live.scan();
    expect(row(bad)).toMatchObject({ attempts: 4, nextTryAt: '2026-11-25T13:36:00.000Z' });
    at(96 * min);
    live.scan();
    expect(row(bad)).toMatchObject({ attempts: 5, nextTryAt: '2026-11-25T14:36:00.000Z' });

    // Changed, though not due: read at once.
    at(100 * min);
    appendFileSync(bad, BAD);
    expect(live.scan().errors).toEqual([{ path: bad, error: 'Invalid time value' }]);
    expect(row(bad)!.attempts).toBe(6);

    writeFileSync(bad, goodSession(9));
    const status = live.scan();
    expect(status.errors).toEqual([]);
    expect(row(bad)).toMatchObject({ attempts: 0, nextTryAt: null, lastError: null });
  });

  it('while watching, tries a failed file again when it is due, though it never changed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const file = join(projects, 'sess-1.jsonl');
    writeFileSync(file, goodSession(1));
    chmodSync(file, 0o000); // unreadable for now: a failure that clears without the file changing
    const live = capture();
    live.scan();
    expect(row(file)!.lastError).toMatch(/EACCES|permission denied/);
    live.start();
    try {
      chmodSync(file, 0o644); // the mode is not the size or the mtime: to capture, the file is unchanged
      clock = new Date(clock.getTime() + 60_000);
      vi.advanceTimersByTime(60_000);
      expect(row(file)!.lastError).toBeNull();
      expect(store.allEntries()).toHaveLength(4);
    } finally {
      live.stop();
    }
  });

  it('forgets a file that is gone, and its error with it', () => {
    const bad = join(projects, 'zz-bad.jsonl');
    writeFileSync(bad, BAD);
    const live = capture();
    expect(live.scan().errors).toHaveLength(1);
    rmSync(bad);
    expect(live.scan().errors).toEqual([]);
    expect(row(bad)).toBeUndefined();
  });

  it('on its first pass reads every watched file whole, so files an earlier version skipped are saved', () => {
    // An earlier version's state: its last pass is later than every file, so it would never look at them again.
    const lost = join(projects, 'sess-3.jsonl');
    writeFileSync(lost, goodSession(3));
    writeStatus(statusFile(), { lastSavedAt: null, lastPassAt: '2030-01-01T00:00:00.000Z', caught: [], errors: [] });
    capture().scan();
    expect(store.allEntries()).toHaveLength(4);
  });

  it('reads a growing session from where it stopped, and a rewritten one whole', () => {
    const file = join(projects, 'sess-7.jsonl');
    writeFileSync(file, goodSession(7, 10));
    const live = capture();
    live.scan();
    expect(row(file)).toMatchObject({ offset: statSync(file).size, extra: { session: { thread: 'sess-7', entries: 10 } } });

    appendFileSync(file, goodSession(7, 2, 10));
    live.scan();
    expect(row(file)).toMatchObject({ offset: statSync(file).size, extra: { session: { entries: 12 } } });
    const entries = store.allEntries().sort((a, b) => a.seq - b.seq);
    expect(entries.map((e) => e.seq)).toEqual([...Array(12).keys()]);
    expect(new Set(entries.map((e) => e.threadTitle))).toEqual(new Set(['important work, session 7, line 0']));

    // Rewritten from the start: read whole, nothing lost or doubled.
    writeFileSync(file, goodSession(7, 13).replace('session 7, line 0', 'session 7, line zero'));
    live.scan();
    expect(store.allEntries()).toHaveLength(13);
    expect(row(file)!.extra.session!.entries).toBe(13);
  });

  it('saves from a session exactly what the importer saves from it', () => {
    const file = join(projects, 'sess-5.jsonl');
    const summary = json({ type: 'summary', summary: 'Shed planning' });
    const side = json({ type: 'user', isSidechain: true, sessionId: 'sess-5', uuid: 'side-1', message: { role: 'user', content: 'aside' } });
    const meta = json({ type: 'user', isMeta: true, sessionId: 'sess-5', uuid: 'meta-1', message: { role: 'user', content: 'meta' } });
    writeFileSync(file, summary + goodSession(5, 3) + side + meta + goodSession(5, 2, 3));
    capture().scan();
    const byImporter = new RecordStore(openDb(':memory:'));
    for (const batch of readFilesUnder(join(userHome, '.claude', 'projects'), ['-Users-me-proj/sess-5.jsonl'])) byImporter.ingest(batch);
    const shape = (st: Store) =>
      st
        .allEntries()
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ id: e.externalId, seq: e.seq, body: e.body, thread: e.threadTitle, at: e.createdAt, speaker: e.speaker }));
    expect(shape(store)).toEqual(shape(byImporter));
    expect(store.sources().map((x) => [x.kind, x.label, x.location])).toEqual(byImporter.sources().map((x) => [x.kind, x.label, x.location]));
  });

  it('keeps no place in a session whose source is left out, so it is read whole once back in', () => {
    const file = join(projects, 'sess-8.jsonl');
    writeFileSync(file, goodSession(8, 2));
    const live = capture();
    live.scan();
    const source = store.sources()[0]!;
    store.setSourceStatus(source.id, 'out');
    appendFileSync(file, goodSession(8, 2, 2));
    live.scan();
    expect(row(file)).toMatchObject({ offset: 0, extra: {} });
    store.setSourceStatus(source.id, 'in');
    appendFileSync(file, goodSession(8, 1, 4));
    live.scan();
    expect(store.allEntries()).toHaveLength(5);
  });
});

describe('through the safe reader', () => {
  let store: Store;
  let vault: string;
  beforeEach(() => {
    store = openHome(home);
    vault = join(userHome, 'Vault');
    mkdirSync(vault);
  });
  afterEach(() => store.db.close());

  it('an unreadable note fails on its own: listed and tried again, never taken as an empty note', () => {
    const note = join(vault, 'locked.md');
    writeFileSync(note, 'The water butt needs a lid.');
    writeFileSync(join(vault, 'open.md'), 'Rhubarb by the gate.');
    chmodSync(note, 0o000);
    let clock = new Date('2026-11-25T12:00:00.000Z');
    const live = new LiveCapture(store, [{ kind: 'tree', path: vault }], { statusFile: join(home, 'live.json'), now: () => clock });
    const first = live.scan();
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]!.path).toBe(note);
    expect(first.errors[0]!.error).toMatch(/EACCES|permission denied/);
    expect(new FileTable(store.db).get(note)).toMatchObject({ attempts: 1 });
    expect(store.search('Rhubarb')).toHaveLength(1);

    chmodSync(note, 0o644);
    clock = new Date(clock.getTime() + 60_000);
    expect(live.scan().errors).toEqual([]);
    expect(store.search('water butt')).toHaveLength(1);
  });

  it('a link it refuses is skipped with one warning, and nothing it points at is saved', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'private.md'), 'Not for the record.');
    writeFileSync(join(outside, 'private.jsonl'), goodSession(4));
    const warnings: string[] = [];
    const live = new LiveCapture(store, [{ kind: 'tree', path: vault }], {
      statusFile: join(home, 'live.json'),
      debounceMs: 30,
      onWarning: (l) => warnings.push(l),
    });
    live.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      symlinkSync(join(outside, 'private.md'), join(vault, 'link.md'));
      symlinkSync(join(outside, 'private.jsonl'), join(vault, 'link.jsonl'));
      writeFileSync(join(vault, 'real.md'), 'Leeks in row three.');
      await until(() => store.search('Leeks').length > 0 && warnings.length >= 2);
    } finally {
      live.stop();
    }
    expect(warnings.sort()).toEqual([`${join(vault, 'link.jsonl')}: skipped, it is a symbolic link`, `${join(vault, 'link.md')}: skipped, it is a symbolic link`]);
    expect(store.search('Not for the record')).toEqual([]);
    expect(store.allEntries()).toHaveLength(1);
    expect(live.status().errors).toEqual([]);
  });
});

