// H2 and LS-04: capture keeps one row per watched file, so one file's failure is that file's alone, a failed file is
// tried again on a schedule, and nothing is skipped because a pass moved past it. Built from the audit's PoC 04 (five
// good sessions and one with a nanosecond timestamp) and PoC 04b (fifty notes and one with an impossible date). Since
// the importer skips or flags one bad value instead of failing (M7), neither of those fails a file any more: what fails
// one now is a file that can't be read.

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
// chmod can't make a file unreadable on Windows (it only sets the read-only bit), so these tests are POSIX-only.
const unreadableByMode = process.platform === 'win32';

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

async function liveOnce(): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(['live', '--once'], { out: (t) => (out += t), err: (t) => (err += t), env: { SKEINWISE_HOME: home, HOME: userHome } });
  return { code, out, err };
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
  it('with a time it cannot read costs nothing: all six sessions are saved, and the line is named (PoC 04)', async () => {
    for (let s = 0; s < 5; s++) writeFileSync(join(projects, `sess-${s}.jsonl`), goodSession(s));
    writeFileSync(join(projects, 'zz-bad.jsonl'), BAD);

    const first = await liveOnce();
    expect(first.code).toBe(0);
    expect(first.out).toContain('caught up 6 chats from Claude Code');
    expect(first.out).not.toContain('failed');
    expect(first.err).toContain(`-Users-me-proj/zz-bad.jsonl:1: 1700000000000000000 is not a time; kept the entry with no time`);
    expect(withStore((s) => s.allEntries())).toHaveLength(21);
  });

  it.skipIf(unreadableByMode)('that cannot be read fails alone: the other sessions are saved, and it is listed by its path (H2)', async () => {
    for (let s = 0; s < 5; s++) writeFileSync(join(projects, `sess-${s}.jsonl`), goodSession(s));
    const locked = join(projects, 'zz-locked.jsonl');
    writeFileSync(locked, goodSession(5));
    chmodSync(locked, 0o200); // unreadable, still writable

    const first = await liveOnce();
    expect(first.code).toBe(1);
    expect(first.out).toContain('caught up 5 chats from Claude Code · 1 file(s) failed');
    expect(first.out).toContain(`failed: ${locked}: EACCES`);
    expect(withStore((s) => s.allEntries())).toHaveLength(20);

    // Still failing on the next pass, until the file is fixed.
    expect((await liveOnce()).out).toContain(`failed: ${locked}`);

    chmodSync(locked, 0o644);
    appendFileSync(locked, goodSession(5, 1, 4)); // fixed, and changed: read at once
    const fixed = await liveOnce();
    expect(fixed.code).toBe(0);
    expect(fixed.out).not.toContain('failed');
    expect(withStore((s) => s.allEntries())).toHaveLength(25);
  });

  it('in a notes folder, with an impossible date in its name, is saved with the file date (PoC 04b)', async () => {
    const vault = join(userHome, 'Vault');
    mkdirSync(vault);
    for (let i = 0; i < 50; i++) writeFileSync(join(vault, `note-${i}.md`), `# Note ${i}\n\nPlot ${i} gets beans.`);
    writeFileSync(join(vault, 'Meeting 2023-14-02.md'), 'We agreed the shed rota.');
    openHome(home).db.close();
    setConfigValue(home, 'liveFolders', vault);

    const first = await liveOnce();
    expect(first.code).toBe(0);
    expect(first.out).not.toContain('failed');
    expect(withStore((s) => s.search('shed rota'))).toHaveLength(1);
    expect(withStore((s) => s.allEntries())).toHaveLength(51);
  }, 30_000); // 51 files through a live pass: past 5 s on a loaded Windows runner (Node 24, e579ecf)

  it('in a Codex session, a line with a bad time is saved and named; the file never fails', () => {
    const sessions = join(userHome, '.codex', 'sessions');
    mkdirSync(sessions, { recursive: true });
    const text =
      json({ type: 'session_meta', timestamp: '2026-11-20T10:00:00Z', payload: { id: 'cx-1' } }) +
      json({ type: 'response_item', timestamp: '2026-11-20T10:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Mulch the beds?' }] } }) +
      json({ type: 'response_item', timestamp: 1.7e18, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Yes, in October.' }] } });
    writeFileSync(join(sessions, 'cx.jsonl'), text);
    const store = openHome(home);
    try {
      const warnings: string[] = [];
      const live = new LiveCapture(store, [{ kind: 'tree', path: sessions }], { statusFile: join(home, 'live.json'), onWarning: (l) => warnings.push(l) });
      expect(live.scan().errors).toEqual([]);
      expect(warnings).toEqual(['cx.jsonl:3: 1700000000000000000 is not a time; kept the entry with no time']);
      expect(store.search('October')).toHaveLength(1);
      expect(store.allEntries()).toHaveLength(2);
      expect(new FileTable(store.db).get(join(sessions, 'cx.jsonl'))).toMatchObject({ attempts: 0, lastError: null });
    } finally {
      store.db.close();
    }
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

  it.skipIf(unreadableByMode)('tries a failed file again after 1 min, 5 min, 30 min, then hourly, and at once when it changes', () => {
    const bad = join(projects, 'zz-locked.jsonl');
    writeFileSync(bad, goodSession(9));
    chmodSync(bad, 0o200); // unreadable, still writable
    const live = capture();
    const at = (ms: number) => (clock = new Date(Date.parse('2026-11-25T12:00:00.000Z') + ms));
    const min = 60_000;
    const denied = expect.stringMatching(/^EACCES/);

    live.scan();
    expect(row(bad)).toMatchObject({ attempts: 1, nextTryAt: '2026-11-25T12:01:00.000Z', lastError: denied });
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
    appendFileSync(bad, goodSession(9, 1, 4));
    expect(live.scan().errors).toEqual([{ path: bad, error: denied }]);
    expect(row(bad)!.attempts).toBe(6);

    chmodSync(bad, 0o644);
    appendFileSync(bad, goodSession(9, 1, 5));
    const status = live.scan();
    expect(status.errors).toEqual([]);
    expect(row(bad)).toMatchObject({ attempts: 0, nextTryAt: null, lastError: null });
  });

  it.skipIf(unreadableByMode)('while watching, tries a failed file again when it is due, though it never changed', async () => {
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

  it.skipIf(unreadableByMode)('forgets a file that is gone, and its error with it', () => {
    const bad = join(projects, 'zz-locked.jsonl');
    writeFileSync(bad, goodSession(9));
    chmodSync(bad, 0o000);
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

    expect(row(file)!.sha256).toMatch(/^[0-9a-f]{64}$/); // read whole

    appendFileSync(file, goodSession(7, 2, 10));
    live.scan();
    // Read from the offset: no whole-file hash (see the byte count in session.test.ts).
    expect(row(file)).toMatchObject({ offset: statSync(file).size, sha256: null, extra: { session: { entries: 12 } } });
    const entries = store.allEntries().sort((a, b) => a.seq - b.seq);
    expect(entries.map((e) => e.seq)).toEqual([...Array(12).keys()]);
    expect(new Set(entries.map((e) => e.threadTitle))).toEqual(new Set(['important work, session 7, line 0']));

    // Rewritten from the start: read whole, nothing lost or doubled.
    writeFileSync(file, goodSession(7, 13).replace('session 7, line 0', 'session 7, line zero'));
    live.scan();
    expect(store.allEntries()).toHaveLength(13);
    expect(row(file)!.extra.session!.entries).toBe(13);
    expect(row(file)!.sha256).toMatch(/^[0-9a-f]{64}$/); // read whole again
  });

  it('names a bad line in a growing session, reading it whole once so the line number is right', () => {
    const warnings: string[] = [];
    const live = new LiveCapture(store, [{ kind: 'tree', path: join(userHome, '.claude', 'projects') }], {
      statusFile: statusFile(),
      now: () => clock,
      onWarning: (l) => warnings.push(l),
    });
    const file = join(projects, 'sess-6.jsonl');
    writeFileSync(file, goodSession(6, 10));
    live.scan();
    appendFileSync(file, json({ type: 'user', sessionId: 'sess-6', uuid: 'u-6-10', timestamp: 1.7e18, message: { role: 'user', content: 'A late line.' } }));
    live.scan();
    expect(warnings).toEqual([`-Users-me-proj/sess-6.jsonl:11: 1700000000000000000 is not a time; kept the entry with no time`]);
    expect(row(file)!.sha256).toMatch(/^[0-9a-f]{64}$/); // read whole
    expect(store.allEntries()).toHaveLength(11);

    appendFileSync(file, goodSession(6, 1, 11));
    live.scan();
    expect(warnings).toHaveLength(1); // a clean tail: read from the offset, and nothing named again
    expect(row(file)!.sha256).toBeNull();
    expect(store.allEntries()).toHaveLength(12);
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
    // And each version names the file it came from, as the importer's do.
    const origins = (st: Store) => st.allEntries().flatMap((e) => st.history(e.id).map((v) => v.origin));
    expect(origins(store)).toEqual(origins(byImporter));
    expect(origins(store)[0]).toEqual({ path: file, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
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

  it.skipIf(unreadableByMode)('an unreadable note fails on its own: listed and tried again, never taken as an empty note', () => {
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

