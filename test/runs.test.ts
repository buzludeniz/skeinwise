import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createModel } from '../src/organiser/model.ts';
import { previewRun, type RunOptions, runTask } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import {
  currentMark,
  failRun,
  finishRun,
  getRun,
  listRuns,
  parseScope,
  remoteTokensThisMonth,
  scopeEntries,
  scopeText,
  startRun,
  undoRun,
} from '../src/organiser/runs.ts';

const NOW = '2026-05-10T12:00:00.000Z';
let store: Store;

function addNote(id: string, body: string, createdAt = '2026-01-02T09:00:00.000Z') {
  store.ingest({
    source: { kind: 'notes', label: 'notes', location: '/n' },
    threads: [],
    entries: [{ externalId: id, kind: 'note', speaker: 'you', title: id, createdAt, body }],
  });
}

function doneRun(task: 'tag' | 'file' | 'hub' | 'link', scope = 'all', schemaId: number | null = null): number {
  const id = startRun(store.db, { task, engine: 'none', model: null, scope, schemaId, mark: currentMark(store.db), now: NOW });
  finishRun(store.db, id, { counts: {}, tokensIn: 0, tokensOut: 0, now: NOW });
  return id;
}

const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  store = new Store(openDb(':memory:'), () => NOW);
  addNote('a.md', 'Plotline runs on SQLite.');
  addNote('b.md', 'Sourdough starter notes.', '2026-03-01T09:00:00.000Z');
});

describe('scopes', () => {
  it('parses and prints every kind, and refuses the rest', () => {
    for (const s of ['all', 'new', 'source:3', 'since:2026-01-31']) expect(scopeText(parseScope(s))).toBe(s);
    expect(parseScope(undefined)).toEqual({ kind: 'all' });
    expect(() => parseScope('folder:2')).toThrow(/Unknown scope/);
    expect(() => parseScope('since:yesterday')).toThrow(/Unknown scope/);
  });

  it('picks entries by source and date, and checks the source exists', () => {
    const record = new RecordView(store);
    expect(scopeEntries(store.db, record, { kind: 'source', id: 1 }, 'tag', null)).toHaveLength(2);
    expect(() => scopeEntries(store.db, record, { kind: 'source', id: 9 }, 'tag', null)).toThrow(/No source 9/);
    const since = scopeEntries(store.db, record, { kind: 'since', date: '2026-02-01' }, 'tag', null);
    expect(since.map((e) => e.title)).toEqual(['b.md']);
  });

  it('"new" means entries added or changed since the task last ran over everything or over new entries', () => {
    const record = () => new RecordView(store);
    const fresh = () => scopeEntries(store.db, record(), { kind: 'new' }, 'hub', null).map((e) => e.title);
    expect(fresh()).toEqual(['a.md', 'b.md']);

    doneRun('hub');
    expect(fresh()).toEqual([]);
    addNote('c.md', 'River nitrate readings.');
    store.editEntry(1, 'Plotline moves to Postgres.');
    expect(fresh()).toEqual(['a.md', 'c.md']);

    // Another task, a run over one source, and a failed run leave the mark where it was.
    doneRun('link');
    doneRun('hub', 'source:1');
    const failed = startRun(store.db, { task: 'hub', engine: 'none', model: null, scope: 'new', mark: currentMark(store.db), now: NOW });
    failRun(store.db, failed, 'boom', 0, 0, NOW);
    expect(fresh()).toEqual(['a.md', 'c.md']);

    const last = doneRun('hub', 'new');
    expect(fresh()).toEqual([]);
    undoRun(store.db, last);
    expect(fresh()).toEqual(['a.md', 'c.md']);
  });

  it('keeps a mark per schema for tags', () => {
    doneRun('tag', 'all', 1);
    expect(scopeEntries(store.db, new RecordView(store), { kind: 'new' }, 'tag', 1)).toHaveLength(0);
    expect(scopeEntries(store.db, new RecordView(store), { kind: 'new' }, 'tag', 2)).toHaveLength(2);
  });
});

describe('runs', () => {
  it('refuses to start while another run is unfinished, and says how to clear it', () => {
    const id = startRun(store.db, { task: 'hub', engine: 'none', model: null, scope: 'all', mark: 0, now: NOW });
    expect(() => startRun(store.db, { task: 'tag', engine: 'none', model: null, scope: 'all', mark: 0, now: NOW })).toThrow(
      `skeinwise undo ${id}`,
    );
    undoRun(store.db, id);
    expect(getRun(store.db, id)!.status).toBe('undone');
    expect(() => finishRun(store.db, id, { counts: {}, tokensIn: 0, tokensOut: 0, now: NOW })).toThrow(/undone while it ran/);
  });

  it('records counts, tokens and times', () => {
    const id = startRun(store.db, { task: 'hub', engine: 'local', model: 'm', scope: 'all', mark: 5, now: NOW });
    finishRun(store.db, id, { counts: { hubs: 3 }, message: 'ok', tokensIn: 10, tokensOut: 4, now: NOW });
    expect(getRun(store.db, id)).toMatchObject({ status: 'done', counts: { hubs: 3 }, tokensIn: 10, tokensOut: 4, mark: 5, model: 'm' });
  });

  it('adds up an outside model’s tokens for the month', () => {
    for (const [engine, at] of [
      ['remote', '2026-05-02T00:00:00.000Z'],
      ['remote', '2026-04-30T23:00:00.000Z'],
      ['local', '2026-05-03T00:00:00.000Z'],
    ] as const) {
      const id = startRun(store.db, { task: 'hub', engine, model: 'm', scope: 'all', mark: 0, now: at });
      finishRun(store.db, id, { counts: {}, tokensIn: 100, tokensOut: 50, now: at });
    }
    expect(remoteTokensThisMonth(store.db, NOW)).toBe(150);
  });
});

describe('undo', () => {
  function folderRun(name: string): { run: number; folder: number } {
    const run = doneRun('file');
    const folder = Number(store.db.prepare('INSERT INTO folders (name, run_id) VALUES (?, ?)').run(name, run).lastInsertRowid);
    store.db.prepare('INSERT INTO entry_folders (entry_id, folder_id, run_id) VALUES (1, ?, ?)').run(folder, run);
    return { run, folder };
  }

  it('deletes everything a run made and leaves the record alone', () => {
    const before = store.allEntries();
    const run = doneRun('hub');
    const hub = Number(store.db.prepare("INSERT INTO hubs (name, sections, run_id) VALUES ('x', '{}', ?)").run(run).lastInsertRowid);
    store.db.prepare('INSERT INTO hub_entries (hub_id, entry_id, run_id, score) VALUES (?, 1, ?, 1)').run(hub, run);
    store.db.prepare("INSERT INTO links (from_entry, to_entry, kind, score, run_id) VALUES (1, 2, 'cross', 0.5, ?)").run(run);
    const result = undoRun(store.db, run);
    expect(result.removed).toEqual({ hub_entries: 1, hubs: 1, links: 1 });
    expect(count('hubs') + count('hub_entries') + count('links')).toBe(0);
    expect(store.allEntries()).toEqual(before);
    expect(() => undoRun(store.db, run)).toThrow(/already undone/);
  });

  it('refuses failed runs, questions and unknown runs', () => {
    const failed = startRun(store.db, { task: 'hub', engine: 'none', model: null, scope: 'all', mark: 0, now: NOW });
    failRun(store.db, failed, 'boom', 0, 0, NOW);
    expect(() => undoRun(store.db, failed)).toThrow(/failed/);
    const ask = startRun(store.db, { task: 'ask', engine: 'local', model: 'm', scope: 'all', mark: 0, now: NOW });
    finishRun(store.db, ask, { counts: {}, tokensIn: 1, tokensOut: 1, now: NOW });
    expect(() => undoRun(store.db, ask)).toThrow(/question/);
    expect(() => undoRun(store.db, 99)).toThrow(/No run 99/);
  });

  it('refuses while a later run builds on what the run made', () => {
    const { run, folder } = folderRun('Plotline');
    const later = doneRun('file', 'new');
    store.db.prepare('INSERT INTO entry_folders (entry_id, folder_id, run_id) VALUES (2, ?, ?)').run(folder, later);
    expect(() => undoRun(store.db, run)).toThrow(`Runs ${later} build on what run ${run} made`);
    undoRun(store.db, later);
    undoRun(store.db, run);
    expect(count('folders')).toBe(0);
  });

  it('reverses a correction, and refuses while a later correction changed the same thing', () => {
    const run = doneRun('hub');
    const hub = Number(store.db.prepare("INSERT INTO hubs (name, sections, run_id) VALUES ('Plotline', '{}', ?)").run(run).lastInsertRowid);
    const rename = (from: string, to: string) => {
      store.db.prepare('UPDATE hubs SET name = ? WHERE id = ?').run(to, hub);
      const id = startRun(store.db, {
        task: 'correction',
        engine: 'you',
        model: null,
        scope: `hub:${hub}`,
        mark: 0,
        detail: { op: 'rename-hub', hub, before: from, after: to, targets: [`hub:${hub}`] },
        now: NOW,
      });
      finishRun(store.db, id, { counts: {}, tokensIn: 0, tokensOut: 0, now: NOW });
      return id;
    };
    const first = rename('Plotline', 'Allotment app');
    const second = rename('Allotment app', 'Booking app');

    expect(() => undoRun(store.db, first)).toThrow(`Run ${second} changed the same thing later`);
    expect(() => undoRun(store.db, run)).toThrow(`Runs ${first}, ${second} build on`);
    undoRun(store.db, second);
    undoRun(store.db, first);
    expect(store.db.prepare('SELECT name FROM hubs WHERE id = ?').get(hub)).toEqual({ name: 'Plotline' });
  });
});

// LS-15 (security audit M13): a server can report usage that is negative or missing, and a request can time out after
// the server did the work. The fake below is a function standing in for fetch: nothing leaves the process.
describe('the outside-model budget holds (LS-15)', () => {
  const REMOTE = { ...DEFAULT_CONFIG, remoteUrl: 'https://models.example.net/v1', remoteModel: 'big-1', apiKeyEnv: 'SKEINWISE_TEST_KEY', remoteHosts: ['models.example.net'] };
  const HUB = JSON.stringify({ name: 'Rye baking', in_short: [{ text: 'Notes on rye.', cites: ['S1'] }], found: ['S1'], open_ends: [] });

  beforeEach(() => {
    const words = ['rye loaf', 'sourdough starter', 'rye proof', 'nitrate samples', 'river samples', 'nitrate rain'];
    for (const [i, w] of words.entries()) addNote(`n${i}.md`, `Notes on the ${w}. The ${w} and the oven matter, and the dough or the flow too.`);
  });

  it('counts a negative report as no report and a timeout as its max_tokens, and stops at the budget', async () => {
    const chats: { sent: number; maxTokens: number }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'big-1' }] });
      const body = JSON.parse(String(init!.body)) as { messages: { content: string }[]; max_tokens: number };
      chats.push({ sent: Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 4), maxTokens: body.max_tokens });
      if (chats.length > 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return Response.json({ choices: [{ message: { role: 'assistant', content: HUB }, finish_reason: 'stop' }], usage: { total_tokens: -500 } });
    }) as typeof globalThis.fetch;
    const client = createModel(REMOTE, 'remote', { fetch, env: { SKEINWISE_TEST_KEY: 'k' } });
    const base: RunOptions = { task: 'hub', scope: { kind: 'all' }, engine: 'remote', client, yes: false, budget: 0, progress: () => {} };
    const preview = previewRun(store, new RecordView(store), base);
    expect(preview.requests.length).toBe(2);
    const need = preview.estimate;
    const options = { ...base, budget: 2 * need };
    const run = () => runTask(store, new RecordView(store), options);

    // The first answer reports -500 tokens: the run counts its own estimate of what it sent and, from an outside
    // model, the most the answer could be. The second request times out, and counts in full.
    await expect(run()).rejects.toThrow(/took longer than .* It counts in full against the budget/);
    const [a, b] = chats;
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed', tokensIn: a!.sent + b!.sent, tokensOut: a!.maxTokens + b!.maxTokens });
    expect(remoteTokensThisMonth(store.db, NOW)).toBe(need);

    // What is left still fits a run, and its first request times out too.
    await expect(run()).rejects.toThrow(/took longer than/);
    const c = chats[2]!;
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed', tokensIn: c.sent, tokensOut: c.maxTokens });
    const spent = need + c.sent + c.maxTokens;
    expect(remoteTokensThisMonth(store.db, NOW)).toBe(spent);

    // The next would pass the budget: refused before anything is sent.
    await expect(run()).rejects.toThrow(`hub needs about ${need} tokens, and ${2 * need - spent} of the outside model's monthly budget of ${2 * need} is left`);
    expect(chats).toHaveLength(3);
    expect(listRuns(store.db)).toHaveLength(2);
  });

  it('adds up only what runs counted: a negative figure adds nothing', () => {
    const id = startRun(store.db, { task: 'hub', engine: 'remote', model: 'big-1', scope: 'all', mark: 0, now: NOW });
    finishRun(store.db, id, { counts: {}, tokensIn: -500, tokensOut: 40, now: NOW });
    expect(getRun(store.db, id)).toMatchObject({ tokensIn: 0, tokensOut: 40 });
    const failed = startRun(store.db, { task: 'hub', engine: 'remote', model: 'big-1', scope: 'all', mark: 0, now: NOW });
    failRun(store.db, failed, 'timed out', 30, -Infinity, NOW);
    expect(getRun(store.db, failed)).toMatchObject({ tokensIn: 30, tokensOut: 0 });
    // A row an earlier version wrote, or a synced record brought in, can still hold one.
    store.db.prepare('UPDATE runs SET tokens_in = -500 WHERE id = ?').run(id);
    expect(remoteTokensThisMonth(store.db, NOW)).toBe(70);
  });
});
