import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { createModel, ModelTimeoutError } from '../src/organiser/model.ts';
import { type ModelClient } from '../src/organiser/plan.ts';
import { type RunOptions, runSteps, runTask, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { listRuns } from '../src/organiser/runs.ts';
import { entryLayers } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

// A request whose answer is still unusable after one repair is done without the model; the rest of the run goes on.

const NOW = '2026-05-10T12:00:00.000Z';
const TOPICS = ['river samples', 'rye starter', 'garden beds'];

/** A note of about 2,100 characters: long enough that each one is a layer batch of its own, with a Digest and an idea. */
function note(topic: string): string {
  const sentences = [`Notes on the ${topic}.`, `The next step for the ${topic} is to measure it again.`];
  for (let n = 1; sentences.join(' ').length < 2100; n++) sentences.push(`Day ${n} of the ${topic} went as planned, and the readings held steady.`);
  return sentences.join(' ');
}

function seeded(): Store {
  const store = new Store(openDb(':memory:'), () => NOW);
  store.ingest({
    source: { kind: 'notes', label: 'notes', location: '/n' },
    threads: [],
    entries: TOPICS.map((t, i) => ({ externalId: `${i + 1}.md`, kind: 'note' as const, speaker: 'you' as const, title: t, createdAt: `2025-01-0${i + 1}T00:00:00.000Z`, body: note(t) })),
  });
  return store;
}

/**
 * A stand-in local model server, never the network. Entry n's batch costs n * 101 tokens in and n * 11 out per call,
 * so the run's total shows which calls were counted. The batch for entry `bad` gets prose, which isn't JSON, every time.
 */
function standIn(bad: number | null, broken: number | null = null) {
  const chats: number[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'stand-in' }] });
    const user = (JSON.parse(String(init!.body)) as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === 'user')!.content;
    const id = Number(/^E(\d+):$/m.exec(user)![1]);
    chats.push(id);
    if (id === broken) throw new TypeError('fetch failed');
    const content =
      id === bad
        ? 'Sure! Here are the layers you asked for.'
        : JSON.stringify({ entries: [{ id: `E${id}`, expanded: `Expanded ${id}.`, digest: `Digest ${id}.`, ideas: [`Idea ${id}.`] }] });
    return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: id * 101, completion_tokens: id * 11 } });
  }) as typeof globalThis.fetch;
  return { client: createModel(DEFAULT_CONFIG, 'local', { fetch, env: {} }), chats };
}

const options = (client: ModelClient | undefined): RunOptions => ({
  task: 'layer',
  scope: { kind: 'all' },
  engine: client ? 'local' : 'none',
  ...(client ? { client } : {}),
  yes: false,
  budget: 0,
  progress: () => {},
});

const rows = (store: Store, id: number) => entryLayers(store.db, id).map((l) => ({ layer: l.layer, body: l.body, engine: l.engine, model: l.model }));
const layerCount = (store: Store) => (store.db.prepare('SELECT COUNT(*) AS n FROM layers').get() as { n: number }).n;

describe('a model answer still bad after one repair', () => {
  let store: Store;
  beforeEach(() => {
    store = seeded();
  });

  it('does that batch without the model, finishes the run, and counts every token', async () => {
    const { client, chats } = standIn(2);
    const progress: string[] = [];
    const run = await runTask(store, new RecordView(store), { ...options(client), progress: (l) => progress.push(l) });

    // Three batches; the bad one was asked twice (the repair), the others once.
    expect(chats).toEqual([1, 2, 2, 3]);
    expect(run).toMatchObject({ status: 'done', engine: 'local', model: 'stand-in', tokensIn: 101 + 2 * 202 + 303, tokensOut: 11 + 2 * 22 + 33 });
    expect(run.counts).toMatchObject({ entries: 3, expanded: 2, byModel: 2, unanswered: 1 });
    expect(run.message).toBe("The model's answer for layers 2 of 3 was still unusable after one repair, so that part was done without the model.");
    expect(progress).toContain(
      "layer: layers 2 of 3 is done without the model, as its answer was still unusable after one repair: The model's answer for layers 2 of 3 is not JSON: Sure! Here are the layers you asked for.",
    );

    // The bad batch's entry holds exactly what the No-AI engine writes for it; the others hold the model's layers.
    const noAI = seeded();
    await runTask(noAI, new RecordView(noAI), options(undefined));
    expect(rows(noAI, 2).length).toBeGreaterThan(0);
    expect(rows(store, 2)).toEqual(rows(noAI, 2));
    expect(rows(store, 2).every((l) => l.engine === 'none' && l.model === null)).toBe(true);
    for (const id of [1, 3]) {
      expect(rows(store, id)).toEqual([
        { layer: 'expanded', body: `Expanded ${id}.`, engine: 'local', model: 'stand-in' },
        { layer: 'digest', body: `Digest ${id}.`, engine: 'local', model: 'stand-in' },
        { layer: 'ideas', body: `- Idea ${id}.`, engine: 'local', model: 'stand-in' },
      ]);
    }
  });

  it('says nothing extra when every answer is good', async () => {
    const run = await runTask(store, new RecordView(store), options(standIn(null).client));
    expect(run).toMatchObject({ status: 'done', tokensIn: 101 + 202 + 303, tokensOut: 11 + 22 + 33 });
    expect(run.counts.unanswered).toBeUndefined();
    expect(run.message).toBeNull();
  });

  it('still fails the run, saving nothing, on any other error', async () => {
    // The server goes away during the second batch.
    await expect(runTask(store, new RecordView(store), options(standIn(null, 2).client))).rejects.toThrow();
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed', tokensIn: 101, tokensOut: 11 });
    expect(layerCount(store)).toBe(0);

    // A timeout is an answer error too, but not a bad answer: its tokens count and the run fails.
    const base = standIn(null).client;
    const timing: ModelClient = {
      ...base,
      send: async (request) => {
        if (request.purpose !== 'layers 2 of 3') return base.send(request);
        const err = new ModelTimeoutError('The model took too long.');
        err.tokensIn = 7;
        throw err;
      },
    };
    await expect(runTask(store, new RecordView(store), options(timing))).rejects.toThrow('The model took too long.');
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed', tokensIn: 101 + 7, tokensOut: 11 });
    expect(layerCount(store)).toBe(0);
  });
});

describe('every task does an unanswered request the way the No-AI engine does', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-fallback-'));
    writeDemo(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const demo = () => {
    const store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
    return store;
  };
  const TABLES = ['tags', 'entry_tags', 'folders', 'entry_folders', 'links', 'hubs', 'hub_entries', 'layers', 'review_items'];
  // Each table's rows, without row ids and in a fixed order: a fallback's rows may be written in another order.
  const dump = (store: Store) =>
    Object.fromEntries(
      TABLES.map((t) => [
        t,
        store.db
          .prepare(`SELECT * FROM ${t}`)
          .all()
          .map((row) => JSON.stringify({ ...row, id: undefined }))
          .sort(),
      ]),
    );

  it('tags, files, hubs, layers and review, on the demo record', async () => {
    // A stand-in model that never gives a usable answer.
    const fetch = (async (input: string | URL | Request) =>
      String(input).endsWith('/models')
        ? Response.json({ data: [{ id: 'stand-in' }] })
        : Response.json({ choices: [{ message: { role: 'assistant', content: 'Sure!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })) as typeof globalThis.fetch;
    const client = createModel(DEFAULT_CONFIG, 'local', { fetch, env: {} });
    const model = demo();
    const none = demo();
    const ran = await runSteps(model, new RecordView(model), steps(model, 'all'), { ...options(client), yes: true });
    await runSteps(none, new RecordView(none), steps(none, 'all'), options(undefined));

    expect(ran.every((r) => r.status === 'done')).toBe(true);
    // Every task that asks the model asked, and did each unanswered request without it.
    expect(new Set(ran.filter((r) => r.counts.unanswered).map((r) => r.task))).toEqual(new Set(['tag', 'file', 'hub', 'layer', 'review']));
    for (const r of ran) expect(r.tokensIn).toBe(r.counts.unanswered ? 2 * 10 * r.counts.unanswered : 0);
    expect(dump(model)).toEqual(dump(none));
  });
});
