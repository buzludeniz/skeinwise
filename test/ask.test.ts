import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { ask, parseQuestion, similarEntries } from '../src/organiser/ask.ts';
import { createModel } from '../src/organiser/model.ts';
import { RecordView } from '../src/organiser/record.ts';
import { listRuns } from '../src/organiser/runs.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

describe('parseQuestion', () => {
  it('knows the three kinds of question and searches for their subject', () => {
    expect(parseQuestion('When did I first mention sourdough?')).toEqual({ kind: 'first', topic: 'sourdough' });
    expect(parseQuestion('when did I first talk about the river thesis')).toEqual({ kind: 'first', topic: 'the river thesis' });
    expect(parseQuestion('What did I decide about SQLite?')).toEqual({ kind: 'decided', topic: 'SQLite' });
    expect(parseQuestion('what have I decided on the market stall')).toEqual({ kind: 'decided', topic: 'the market stall' });
    expect(parseQuestion('What changed in my thinking on Plotline?')).toEqual({ kind: 'changed', topic: 'Plotline' });
    expect(parseQuestion('how has my view on rye changed')).toEqual({ kind: 'changed', topic: 'rye' });
    expect(parseQuestion('nitrate samples after storms')).toEqual({ kind: 'any', topic: 'nitrate samples after storms' });
    expect(() => parseQuestion('  ?  ')).toThrow(/Ask a question/);
  });
});

describe('asking the demo record', () => {
  let dir: string;
  let store: Store;
  let record: RecordView;
  const NONE = { engine: 'none' as const, budget: 0, limit: 5 };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-ask-'));
    writeDemo(dir);
    store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
    record = new RecordView(store);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('"what did I decide about sqlite" finds both Plotline decisions, oldest first', async () => {
    const r = await ask(store, record, 'what did I decide about sqlite', NONE);
    expect(r).toMatchObject({ kind: 'decided', topic: 'sqlite', answer: null, runId: null, message: null });
    expect(r.hits.map((h) => [h.date, h.why, h.quote])).toEqual([
      ['2025-03-09', 'decision', 'Decided: Plotline runs on SQLite.'],
      ['2026-04-05', 'decision', expect.stringMatching(/^Changing my mind on SQLite: .* so we move to Postgres\.$/)],
    ]);
    expect(r.hits.every((h) => h.speaker === 'you')).toBe(true);
    expect(listRuns(store.db)).toEqual([]);
  });

  it('"what changed" starts at the first mention and names the change of course', async () => {
    const r = await ask(store, record, 'What changed in my thinking on SQLite?', NONE);
    expect(r.hits.map((h) => [h.date, h.why])).toEqual([
      ['2025-03-09', 'first mention'],
      ['2026-04-05', 'change'],
    ]);
  });

  it('"when did I first" lists the earliest entries, and says so when nothing matches', async () => {
    const r = await ask(store, record, 'when did I first mention sourdough', NONE);
    const dates = r.hits.map((h) => h.date);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe('2024-03-18');
    expect(r.hits.every((h) => h.why === 'first mention')).toBe(true);
    const none = await ask(store, record, 'what did I decide about zeppelins', NONE);
    expect(none.hits).toEqual([]);
    expect(none.message).toBe('Nothing in your record matches "zeppelins".');
  });

  it('a model adds a short answer that cites entries, recorded as an ask run', async () => {
    const sent: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'models/fake-4b.gguf' }] });
      const body = JSON.parse(String(init!.body)) as { messages: { role: string; content: string }[] };
      sent.push(body.messages[1]!.content);
      const content = JSON.stringify({ answer: 'SQLite in March 2025, then Postgres in April 2026.', cites: ['E1', 'E2'] });
      return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 25 } });
    }) as typeof globalThis.fetch;
    const client = createModel(DEFAULT_CONFIG, 'local', { fetch, env: {} });
    const r = await ask(store, record, 'what did I decide about sqlite', { engine: 'local', client, budget: 0, limit: 5 });
    expect(sent[0]).toMatch(/E1 \(2025-03-09, me, "Plotline runs on SQLite"\): .*Decided: Plotline runs on SQLite\./);
    expect(r).toMatchObject({ answer: 'SQLite in March 2025, then Postgres in April 2026.', cites: [385, 345], engine: 'local', model: 'models/fake-4b.gguf' });
    const run = listRuns(store.db).find((x) => x.id === r.runId)!;
    expect(run).toMatchObject({ task: 'ask', status: 'done', engine: 'local', tokensIn: 300, tokensOut: 25 });
  });

  it('a model answer that cites an entry it was not shown fails the run', async () => {
    const fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'm' }] });
      const content = JSON.stringify({ answer: 'Postgres.', cites: ['E9'] });
      return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    }) as typeof globalThis.fetch;
    const client = createModel(DEFAULT_CONFIG, 'local', { fetch, env: {} });
    await expect(ask(store, record, 'what did I decide about sqlite', { engine: 'local', client, budget: 0, limit: 5 })).rejects.toThrow(/E9/);
    expect(listRuns(store.db)[0]).toMatchObject({ task: 'ask', status: 'failed' });
  });

  it('similar finds the entries most like one, from other threads, best first', () => {
    const hits = similarEntries(record, 385, 3);
    expect(hits[0]).toMatchObject({ entryId: 345, date: '2026-04-05' });
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
    expect(hits.every((h) => h.entryId !== 385)).toBe(true);
    expect(() => similarEntries(record, 99_999, 3)).toThrow(/No entry 99999/);
  });
});
