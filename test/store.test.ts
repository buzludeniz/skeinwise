import { describe, expect, it } from 'vitest';
import { openDb } from '../src/store/db.ts';
import { type ImportBatch, Store, toMatchQuery } from '../src/store/store.ts';

function store(): Store {
  let tick = 0;
  return new Store(openDb(':memory:'), () => `2026-11-01T00:00:${String(tick++).padStart(2, '0')}.000Z`);
}

function chat(bodies: [string, string][], opts: { thread?: string; kind?: string; owner?: string } = {}): ImportBatch {
  return {
    source: { kind: opts.kind ?? 'claude', label: 'Claude', owner: opts.owner },
    threads: [
      {
        externalId: opts.thread ?? 't1',
        title: 'Sourdough',
        entries: bodies.map(([speaker, body], i) => ({
          externalId: `${opts.thread ?? 't1'}:${i}`,
          kind: 'message' as const,
          speaker,
          createdAt: `2025-01-0${i + 1}T10:00:00.000Z`,
          body,
        })),
      },
    ],
  };
}

describe('ingest', () => {
  it('adds entries once; re-importing the same export changes nothing', () => {
    const s = store();
    const batch = chat([
      ['you', 'My starter is sluggish'],
      ['assistant', 'Keep it warmer'],
    ]);
    expect(s.ingest(batch)).toEqual({ added: 2, versioned: 0, unchanged: 0, skipped: 0, threads: 1 });
    expect(s.ingest(batch)).toEqual({ added: 0, versioned: 0, unchanged: 2, skipped: 0, threads: 1 });
    expect(s.stats().entries).toBe(2);
  });

  it('versions changed text and never rolls back to an older export', () => {
    const s = store();
    s.ingest(chat([['you', 'first draft']]));
    expect(s.ingest(chat([['you', 'second draft']])).versioned).toBe(1);
    expect(s.ingest(chat([['you', 'first draft\r\n']])).unchanged).toBe(1);
    const entry = s.allEntries()[0]!;
    expect(entry.version).toBe(2);
    expect(entry.body).toBe('second draft');
    expect(s.history(entry.id).map((v) => [v.version, v.body, v.editor])).toEqual([
      [1, 'first draft', 'import'],
      [2, 'second draft', 'import'],
    ]);
    expect(s.search('first').length).toBe(0);
    expect(s.search('second').length).toBe(1);
  });

  it('skips empty bodies and names the owner of someone else’s words', () => {
    const s = store();
    const r = s.ingest(chat([['you', '  '], ['you', 'Mara wrote this']], { owner: 'Mara' }));
    expect(r).toMatchObject({ added: 1, skipped: 1 });
    expect(s.allEntries()[0]!.speaker).toBe('Mara');
  });

  it('keeps loose entries without a thread', () => {
    const s = store();
    s.ingest({
      source: { kind: 'notes', label: 'notes', location: '/n' },
      threads: [],
      entries: [{ externalId: 'a.md', kind: 'note', speaker: 'you', title: 'A', createdAt: '2025-01-01T00:00:00.000Z', body: 'note body' }],
    });
    const [e] = s.allEntries();
    expect(e).toMatchObject({ threadId: null, title: 'A', kind: 'note', sourceKind: 'notes' });
  });
});

describe('editEntry', () => {
  it('adds a version under the editor’s name and reindexes', () => {
    const s = store();
    s.ingest(chat([['you', 'rye loaf']]));
    const id = s.allEntries()[0]!.id;
    const v = s.editEntry(id, 'spelt loaf', 'you');
    expect(v).toMatchObject({ version: 2, editor: 'you' });
    expect(s.getEntry(id)!.body).toBe('spelt loaf');
    expect(s.search('spelt')).toHaveLength(1);
    expect(s.search('rye')).toHaveLength(0);
    expect(() => s.editEntry(999, 'x')).toThrow(/No entry 999/);
  });
});

describe('search', () => {
  function seeded(): Store {
    const s = store();
    s.ingest(
      chat([
        ['assistant', 'Decided that the starter needs warmth'],
        ['you', 'I decided the starter lives in the oven'],
        ['you', 'The oven light keeps it warm'],
      ]),
    );
    s.ingest(chat([['you', 'Plotline uses SQLite']], { thread: 't2', kind: 'chatgpt' }));
    return s;
  }

  it('ranks your own words above an assistant’s and stems words', () => {
    const hits = seeded().search('decide starter');
    expect(hits.map((h) => h.speaker)).toEqual(['you', 'assistant']);
    expect(hits[0]!.snippet).toContain('[decided]');
  });

  it('fills the page with partial matches after full ones', () => {
    const hits = seeded().search('oven sqlite');
    expect(hits.map((h) => h.body)).toEqual(
      expect.arrayContaining(['Plotline uses SQLite', 'I decided the starter lives in the oven', 'The oven light keeps it warm']),
    );
    expect(seeded().search('?! …')).toEqual([]);
  });

  it('filters by speaker, source and date', () => {
    const s = seeded();
    expect(s.search('starter', { speaker: 'assistant' })).toHaveLength(1);
    expect(s.search('sqlite', { sourceKind: 'claude' })).toHaveLength(0);
    expect(s.search('oven', { from: '2025-01-03' }).map((h) => h.body)).toEqual(['The oven light keeps it warm']);
    expect(s.search('oven', { to: '2025-01-02T23:59' }).map((h) => h.body)).toEqual(['I decided the starter lives in the oven']);
    expect(s.search('oven', { limit: 1 })).toHaveLength(1);
  });

  it('hides excluded sources and threads marked not mine, and brings them back', () => {
    const s = seeded();
    const chatgpt = s.sources().find((x) => x.kind === 'chatgpt')!;
    s.setSourceStatus(chatgpt.id, 'out');
    expect(s.search('sqlite')).toHaveLength(0);
    s.setSourceStatus(chatgpt.id, 'in');
    expect(s.search('sqlite')).toHaveLength(1);

    const thread = s.allEntries()[0]!.threadId!;
    s.setNotMine(thread, true);
    expect(s.getThread(thread)!.notMine).toBe(true);
    expect(s.search('oven')).toHaveLength(0);
    expect(s.stats().entries).toBe(1);
    s.setNotMine(thread, false);
    expect(s.search('oven')).toHaveLength(2);
    expect(() => s.setNotMine(999, true)).toThrow();
    expect(() => s.setSourceStatus(999, 'out')).toThrow();
  });

  it('builds safe match queries', () => {
    expect(toMatchQuery('what did I decide about "sqlite"')).toBe('decide AND (sqlite OR sqlite*)');
    expect(toMatchQuery('oven sqlite', 'any')).toBe('oven OR (sqlite OR sqlite*)');
    expect(toMatchQuery('the')).toBe('(the OR the*)');
    expect(toMatchQuery('?! …')).toBeNull();
  });
});

describe('stats', () => {
  it('counts entries, your words, sources and months', () => {
    const s = store();
    s.ingest(chat([['you', 'a'], ['assistant', 'b'], ['you', 'c']]));
    expect(s.stats()).toEqual({
      entries: 3,
      threads: 1,
      sources: 1,
      yours: 2,
      first: '2025-01-01T10:00:00.000Z',
      last: '2025-01-03T10:00:00.000Z',
      byMonth: [{ month: '2025-01', entries: 3 }],
    });
  });
});
