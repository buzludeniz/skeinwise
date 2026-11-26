// LS-02 and L14: every version says when it was seen, what the file claimed, where it came from and which run made it;
// titles are versioned; flagged times sort by when they were seen; restoreVersion and purgeEntry.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.ts';
import { type ImportBatch, type EntryInput, Store, timeFlag } from '../src/store/store.ts';
import { currentMark, startRun } from '../src/organiser/runs.ts';

const START = Date.UTC(2026, 10, 1);

function store(file = ':memory:'): Store {
  let tick = 0;
  return new Store(openDb(file), () => new Date(START + tick++ * 1000).toISOString());
}

const message = (externalId: string, body: string, createdAt: string, over: Partial<EntryInput> = {}): EntryInput => ({
  externalId,
  kind: 'message',
  speaker: 'you',
  createdAt,
  body,
  ...over,
});

function chat(title: string, entries: EntryInput[], over: Partial<ImportBatch> = {}): ImportBatch {
  return { source: { kind: 'claude', label: 'Claude' }, threads: [{ externalId: 'conv-1', title, entries }], ...over };
}

const origin = (path: string) => ({ path, sha256: `${path.length}`.padStart(64, '0') });

describe('provenance on every version', () => {
  it('records when a version was seen, what the file claimed, the file and the account', () => {
    const s = store();
    s.ingest(chat('Bread', [message('m1', 'Starter at 24C', '2025-03-01T10:00:00.000Z')]), {
      origin: origin('/exports/one.zip'),
      account: 'acct-1',
    });
    const [v1] = s.history(1);
    expect(v1).toMatchObject({
      version: 1,
      editor: 'import',
      claimedAt: '2025-03-01T10:00:00.000Z',
      editedAt: '2025-03-01T10:00:00.000Z',
      origin: origin('/exports/one.zip'),
      account: 'acct-1',
      runId: null,
    });
    expect(Date.parse(v1!.observedAt)).toBeGreaterThanOrEqual(START);
    expect(s.getEntry(1)).toMatchObject({ claimedAt: '2025-03-01T10:00:00.000Z', timeFlag: null, observedAt: v1!.observedAt });
  });

  it('takes the origin from the thread or the entry when a folder batch carries one per file', () => {
    const s = store();
    const batch: ImportBatch = {
      source: { kind: 'notes', label: 'vault', location: '/vault' },
      threads: [{ externalId: 's1', title: 'Session', origin: origin('/vault/s1.jsonl'), entries: [message('a', 'one', '2025-01-01T00:00:00.000Z')] }],
      entries: [message('n1', 'a note', '2025-01-02T00:00:00.000Z', { kind: 'note', origin: origin('/vault/n1.md') })],
    };
    s.ingest(batch, 'you');
    expect(s.history(1)[0]!.origin).toEqual(origin('/vault/s1.jsonl'));
    expect(s.history(2)[0]).toMatchObject({ origin: origin('/vault/n1.md'), editor: 'you' });
    expect(s.titleHistory(1)[0]!.origin).toEqual(origin('/vault/s1.jsonl'));
  });

  it('records the run behind an edit, and every version row has observed_at and an editor', () => {
    const s = store();
    s.ingest(chat('Bread', [message('m1', 'Starter at 24C', '2025-03-01T10:00:00.000Z')]));
    const runId = startRun(s.db, { task: 'correction', engine: 'you', model: null, scope: 'all', mark: currentMark(s.db), now: s.now() });
    const edited = s.editEntry(1, 'Starter at 26C', { editor: 'you', runId });
    expect(edited).toMatchObject({ version: 2, editor: 'you', runId, origin: null, claimedAt: null });
    expect(s.editEntry(1, 'Starter at 27C', 'claude-code')).toMatchObject({ version: 3, editor: 'claude-code', runId: null });
    expect(s.history(1).map((v) => [v.version, v.editor, v.runId])).toEqual([
      [1, 'import', null],
      [2, 'you', runId],
      [3, 'claude-code', null],
    ]);
    const missing = s.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE observed_at IS NULL OR observed_at = '' OR editor = ''").get();
    expect(missing).toEqual({ n: 0 });
    expect(() => s.editEntry(1, 'x', { runId: 999 })).toThrow(/FOREIGN KEY/);
    expect(s.history(1)).toHaveLength(3);
  });
});

describe('thread titles are versioned (H1: no in-place rename)', () => {
  it('keeps every title, never rolls back to an older export, and names who changed it', () => {
    const s = store();
    const entries = [message('m1', 'Postgres for the ledger', '2026-03-01T10:00:00.000Z')];
    s.ingest(chat('Choosing a database', entries));
    s.ingest(chat('Choosing a database (renamed)', entries), { origin: origin('/exports/two.json') });
    expect(s.getThread(1)!.title).toBe('Choosing a database (renamed)');
    s.ingest(chat('Choosing a database', entries)); // an older export
    expect(s.getThread(1)!.title).toBe('Choosing a database (renamed)');
    expect(s.titleHistory(1).map((t) => [t.version, t.title, t.origin?.path ?? null])).toEqual([
      [1, 'Choosing a database', null],
      [2, 'Choosing a database (renamed)', '/exports/two.json'],
    ]);
    expect(s.history(1)).toHaveLength(1);
  });
});

describe('claimed times that are missing, in the future or before 1990 (L14)', () => {
  it('flags them, keeps the claim and sorts them by when they were seen', () => {
    expect(timeFlag('', '2026-11-01T00:00:00.000Z')).toBe('missing');
    expect(timeFlag('not a date', '2026-11-01T00:00:00.000Z')).toBe('missing');
    expect(timeFlag('2026-11-02T23:00:00.000Z', '2026-11-01T00:00:00.000Z')).toBe('future');
    expect(timeFlag('2026-11-01T23:00:00.000Z', '2026-11-01T00:00:00.000Z')).toBeNull();
    expect(timeFlag('1989-12-31T23:59:59.000Z', '2026-11-01T00:00:00.000Z')).toBe('early');
    expect(timeFlag('2001-09-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')).toBeNull();

    const s = store();
    s.ingest(
      chat('Times', [
        message('ok', 'an ordinary message', '2025-06-01T00:00:00.000Z'),
        message('future', 'from 2030', '2030-01-01T00:00:00.000Z'),
        message('early', 'from 1985', '1985-01-01T00:00:00.000Z'),
        message('none', 'no time at all', ''),
      ]),
    );
    const byId = Object.fromEntries(s.threadEntries(1).map((e) => [e.externalId, e]));
    expect(byId.ok).toMatchObject({ timeFlag: null, createdAt: '2025-06-01T00:00:00.000Z', claimedAt: '2025-06-01T00:00:00.000Z' });
    for (const [id, flag, claimed] of [
      ['future', 'future', '2030-01-01T00:00:00.000Z'],
      ['early', 'early', '1985-01-01T00:00:00.000Z'],
      ['none', 'missing', null],
    ] as const) {
      expect(byId[id]).toMatchObject({ timeFlag: flag, claimedAt: claimed });
      expect(byId[id]!.createdAt).toBe(byId[id]!.observedAt);
      expect(s.history(byId[id]!.id)[0]!.claimedAt).toBe(claimed);
    }
    // The newest-first timeline puts the 2030 claim with the others seen today, not at the top of 2030.
    expect(s.stats().last!.startsWith('2026-11-01')).toBe(true);
    expect(s.stats().first).toBe('2025-06-01T00:00:00.000Z');
    expect(s.getThread(1)!.startedAt).toBe('2025-06-01T00:00:00.000Z');
  });
});

describe('restoreVersion', () => {
  it('brings an old version back as a new one, which can itself be undone', () => {
    const s = store();
    s.ingest(chat('Bread', [message('m1', 'We decided on Postgres', '2026-03-01T10:00:00.000Z')]));
    s.editEntry(1, 'We decided on MongoDB');
    const restored = s.restoreVersion(1, 1);
    expect(restored).toMatchObject({ version: 3, body: 'We decided on Postgres', editor: 'you' });
    expect(s.getEntry(1)!.body).toBe('We decided on Postgres');
    expect(s.search('Postgres').map((h) => h.id)).toEqual([1]);
    expect(s.search('MongoDB')).toEqual([]);
    expect(s.restoreVersion(1, 2, { editor: 'agent' })).toMatchObject({ version: 4, body: 'We decided on MongoDB', editor: 'agent' });
  });

  it('changes nothing when the version is already current, and names a version that is not there', () => {
    const s = store();
    s.ingest(chat('Bread', [message('m1', 'one', '2026-03-01T10:00:00.000Z')]));
    expect(s.restoreVersion(1, 1)).toMatchObject({ version: 1 });
    expect(s.history(1)).toHaveLength(1);
    expect(() => s.restoreVersion(1, 5)).toThrow('Entry 1 has no version 5 (it has 1 to 1)');
    expect(() => s.restoreVersion(9, 1)).toThrow('No entry 9');
  });
});

describe('purgeEntry', () => {
  const TOKEN = 'quokkamarmalade';

  function seeded(file: string) {
    const s = store(file);
    s.ingest(
      chat('Secrets', [
        message('m1', `my pasted note ${TOKEN} oops`, '2026-03-01T10:00:00.000Z'),
        message('m2', 'an unrelated reply', '2026-03-01T10:01:00.000Z', { speaker: 'assistant' }),
      ]),
    );
    s.ingest({ source: { kind: 'notes', label: 'n' }, threads: [], entries: [message('lone', `lone ${TOKEN}`, '2026-03-02T00:00:00.000Z', { kind: 'note' })] });
    s.editEntry(1, `my pasted note ${TOKEN} oops, edited`);
    const runId = startRun(s.db, { task: 'tag', engine: 'none', model: null, scope: 'all', mark: currentMark(s.db), now: s.now() });
    const tag = Number(s.db.prepare("INSERT INTO tags (schema_id, name, run_id) VALUES (1, 'x', ?)").run(runId).lastInsertRowid);
    s.db.prepare('INSERT INTO entry_tags (entry_id, tag_id, run_id, score) VALUES (1, ?, ?, 1)').run(tag, runId);
    s.db.prepare("INSERT INTO links (from_entry, to_entry, kind, score, run_id) VALUES (2, 1, 'cross', 1, ?)").run(runId);
    s.db.prepare("INSERT INTO layers (entry_id, layer, body, engine, run_id) VALUES (1, 'cleaned', ?, 'none', ?)").run(`clean ${TOKEN}`, runId);
    const sections = { in_short: [{ text: `about ${TOKEN}`, entryId: 1, date: 'd' }, { text: 'keep', entryId: 2, date: 'd' }] };
    s.db.prepare("INSERT INTO hubs (name, sections, run_id) VALUES ('h', ?, ?)").run(JSON.stringify(sections), runId);
    s.db.prepare("INSERT INTO review_items (note_entry, reasons, proposed, run_id) VALUES (3, ?, 'p', ?)").run(
      JSON.stringify([{ entryId: 1, date: 'd', quote: TOKEN, why: 'w' }]),
      runId,
    );
    return s;
  }

  it('removes every version, the search rows and everything hung on the entry; an emptied thread goes too', () => {
    const s = seeded(':memory:');
    expect(s.purgeEntry(1)).toEqual({ entry: 1, versions: 2, threadRemoved: false });
    expect(s.getEntry(1)).toBeUndefined();
    expect(s.search(TOKEN).map((h) => h.id)).toEqual([3]);
    for (const table of ['entry_tags', 'links', 'layers', 'review_items']) {
      expect(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(JSON.parse((s.db.prepare('SELECT sections FROM hubs').get() as { sections: string }).sections)).toEqual({
      in_short: [{ text: 'keep', entryId: 2, date: 'd' }],
    });
    expect(s.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(s.purgeEntry(2)).toEqual({ entry: 2, versions: 1, threadRemoved: true });
    expect(s.getThread(1)).toBeUndefined();
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM thread_titles').get()).toEqual({ n: 0 });
    expect(() => s.purgeEntry(1)).toThrow('No entry 1');
    expect((s.db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete).toBe(0);
  });

  it('leaves no trace of the text in the database file or its log after scrub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-purge-'));
    try {
      const file = join(dir, 'record.db');
      const s = seeded(file);
      const onDisk = () => [file, `${file}-wal`].filter(existsSync).some((f) => readFileSync(f).includes(TOKEN));
      expect(onDisk()).toBe(true);
      s.purgeEntry(1);
      s.purgeEntry(3);
      expect(s.scrub()).toEqual({ checkpointed: true });
      expect(onDisk()).toBe(false);
      expect(s.getEntry(2)!.body).toBe('an unrelated reply');
      s.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
