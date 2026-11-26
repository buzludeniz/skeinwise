import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Config, loadConfig, saveConfig } from '../../src/config.ts';
import { UsageError } from '../../src/errors.ts';
import { currentMark, listRuns, startRun } from '../../src/organiser/runs.ts';
import { openDb } from '../../src/store/db.ts';
import { Store } from '../../src/store/store.ts';
import { builtin } from '../../src/viewspec/builtins.ts';
import { drawState, drawView, NO_AI_NOTE, REMOTE_NOTE, REQUEST_LIMIT } from '../../src/viewspec/draw.ts';

const NOW = '2026-05-10T12:00:00.000Z';
// A port of the tests' own: the fake fetch below answers it, and nothing goes on the network.
const LOCAL = 'http://127.0.0.1:47391/v1';

interface Call {
  url: string;
  body: { messages: { role: string; content: string }[]; max_tokens?: number } | null;
}

/** A fake local model server: `answer` gets the request's user text and returns the reply content. */
function fakeModel(answer: (user: string) => string, opts: { down?: boolean; status?: number } = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (opts.down) throw new TypeError('fetch failed');
    if (url.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'fake-view-model' }] });
    if (opts.status) return new Response('busy', { status: opts.status, statusText: 'Service Unavailable' });
    const user = calls.at(-1)!.body!.messages.find((m) => m.role === 'user')!.content;
    return Response.json({ choices: [{ message: { role: 'assistant', content: answer(user) }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, chats: () => calls.filter((c) => c.body) };
}

let dir: string;
let home: string;
let store: Store;

function engine(over: Partial<Config>) {
  saveConfig(home, { ...loadConfig(home), ...over });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-draw-'));
  home = join(dir, 'home');
  mkdirSync(home, { mode: 0o700 });
  engine({ engine: 'local', localUrl: LOCAL });
  store = new Store(openDb(':memory:'), () => NOW);
  store.ingest({
    source: { kind: 'notes', label: 'Garden notes', location: '/invented/garden' },
    threads: [],
    entries: [
      { externalId: 'beds.md', kind: 'note', speaker: 'you', title: 'Tomato beds', createdAt: '2025-03-02T08:00:00.000Z', body: 'Raised beds by the fence.' },
      { externalId: 'rye.md', kind: 'note', speaker: 'you', title: 'Rye ratios', createdAt: '2025-04-11T08:00:00.000Z', body: 'Seventy percent water.' },
    ],
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spec = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, title: 'Garden notes by month', show: 'chart', form: 'bars', x: 'time', ...over });

describe('drawState', () => {
  it('draws only with the local engine, and says why not otherwise', () => {
    expect(drawState(home)).toEqual({ draws: true, engine: 'local', note: null });
    engine({ engine: 'none' });
    expect(drawState(home)).toEqual({ draws: false, engine: 'none', note: NO_AI_NOTE });
    engine({ engine: 'remote' });
    expect(drawState(home)).toEqual({ draws: false, engine: 'remote', note: REMOTE_NOTE });
  });
});

describe('drawView', () => {
  it("asks the local model, matches its filter to the record's spelling, and records an ask run", async () => {
    const model = fakeModel(() => spec({ where: [{ prop: 'source', is: 'garden NOTES' }] }));
    const drawn = await drawView(store, home, 'my garden notes, month by month', { fetch: model.fetch, env: {} });
    expect(drawn).toMatchObject({ drawn: true, builtin: null, why: [], model: 'fake-view-model' });
    expect(drawn.spec).toEqual({ v: 1, title: 'Garden notes by month', show: 'chart', form: 'bars', x: 'time', where: [{ prop: 'source', is: 'Garden notes' }] });
    expect(model.calls.every((c) => c.url.startsWith(LOCAL))).toBe(true);
    const user = model.chats()[0]!.body!.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('My request: my garden notes, month by month');
    expect(user).toContain('- source: "Garden notes"');
    expect(user).toContain('- time: months from 2025-03 to 2025-04');
    expect(model.chats()[0]!.body!.max_tokens).toBe(300);
    const [run] = listRuns(store.db);
    expect(run).toMatchObject({ id: drawn.runId, task: 'ask', engine: 'local', status: 'done', detail: { view: true }, tokensIn: 120, tokensOut: 30 });
  });

  it('gives the closest built-in view and the reasons when the spec does not pass', async () => {
    const model = fakeModel(() => spec({ show: 'list', form: 'pie', onclick: 'steal()', sort: 'newest' }));
    const drawn = await drawView(store, home, 'what did I write recently', { fetch: model.fetch, env: {} });
    expect(drawn).toMatchObject({ drawn: false, builtin: 'newest', spec: builtin('newest')!.spec });
    expect(drawn.why[0]).toBe("The model's view didn't pass the check:");
    expect(drawn.why.join(' ')).toMatch(/no field "onclick"/);
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed', tokensIn: 120, tokensOut: 30, detail: { view: true } });
  });

  it("falls back when the model filters on a value the record doesn't have", async () => {
    const model = fakeModel(() => spec({ title: 'Pottery projects', form: 'heatmap', y: 'project', where: [{ prop: 'tag', is: 'Pottery' }] }));
    const drawn = await drawView(store, home, 'pottery', { fetch: model.fetch, env: {} });
    expect(drawn).toMatchObject({ drawn: false, builtin: 'projects-over-time' });
    expect(drawn.why).toEqual(["The model's view filters on something your record doesn't have:", 'Your record has no tag called "Pottery".']);
  });

  it('falls back when the answer is not JSON or the server answers with an error', async () => {
    const prose = fakeModel(() => 'Sure! Here is a chart of your notes.');
    const a = await drawView(store, home, 'my notes', { fetch: prose.fetch, env: {} });
    expect(a).toMatchObject({ drawn: false, builtin: 'notes' });
    expect(a.why[0]).toMatch(/^The model's answer couldn't be used/);
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed' });
    const busy = fakeModel(() => spec(), { status: 503 });
    const b = await drawView(store, home, 'my notes', { fetch: busy.fetch, env: {} });
    expect(b).toMatchObject({ drawn: false, builtin: 'notes' });
    expect(b.why[0]).toMatch(/answered 503/);
  });

  it('falls back without a run when the local model is not running', async () => {
    const model = fakeModel(() => spec(), { down: true });
    const drawn = await drawView(store, home, 'tags', { fetch: model.fetch, env: {} });
    expect(drawn).toMatchObject({ drawn: false, builtin: 'tags-by-month', runId: null });
    expect(drawn.why[0]).toMatch(/^The local model didn't answer/);
    expect(listRuns(store.db)).toEqual([]);
  });

  it('never calls a model under No-AI or the remote engine, and says so', async () => {
    const model = fakeModel(() => spec());
    engine({ engine: 'none' });
    expect(await drawView(store, home, 'my notes', { fetch: model.fetch, env: {} })).toMatchObject({ drawn: false, builtin: 'notes', why: [NO_AI_NOTE] });
    engine({ engine: 'remote', remoteUrl: 'https://models.invalid/v1' });
    expect(await drawView(store, home, 'my notes', { fetch: model.fetch, env: {} })).toMatchObject({ drawn: false, why: [REMOTE_NOTE] });
    expect(model.calls).toEqual([]);
    expect(listRuns(store.db)).toEqual([]);
  });

  it('refuses a local URL that is not on this computer, before any request', async () => {
    const model = fakeModel(() => spec());
    engine({ localUrl: 'http://192.168.1.20:47391/v1' });
    const drawn = await drawView(store, home, 'my notes', { fetch: model.fetch, env: {} });
    expect(drawn.why[0]).toMatch(/not on this computer/);
    expect(model.calls).toEqual([]);
  });

  it('waits for no one: another run going means the closest built-in, unasked', async () => {
    startRun(store.db, { task: 'tag', engine: 'local', model: 'x', scope: 'all', mark: currentMark(store.db), now: NOW });
    const model = fakeModel(() => spec());
    const drawn = await drawView(store, home, 'my notes', { fetch: model.fetch, env: {} });
    expect(drawn).toMatchObject({ drawn: false, builtin: 'notes' });
    expect(drawn.why[0]).toMatch(/^Another run is going/);
    expect(model.chats()).toEqual([]);
  });

  it('takes a plain request of 1 to 300 characters', async () => {
    const model = fakeModel(() => spec());
    const deps = { fetch: model.fetch, env: {} };
    for (const bad of [undefined, 42, '', '   ', '‮\u0007']) await expect(drawView(store, home, bad, deps)).rejects.toThrow(UsageError);
    await expect(drawView(store, home, 'x'.repeat(REQUEST_LIMIT + 1), deps)).rejects.toThrow(/300 characters/);
    expect(model.calls).toEqual([]);
    const drawn = await drawView(store, home, `  ${'x'.repeat(REQUEST_LIMIT)}\u0007  `, deps);
    expect(drawn.drawn).toBe(true);
  });
});
