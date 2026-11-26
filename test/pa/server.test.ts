import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.ts';
import { openHome } from '../../src/home.ts';
import { HttpError } from '../../src/server/app.ts';
import { paRoutes } from '../../src/server/pa.ts';
import type { Store } from '../../src/store/store.ts';
import { fillRecord, NOW } from './fixture.ts';

// The assistant's routes, called the way app.ts calls a handler: the first route whose path and method match. The
// settings point the local engine at a port nobody uses, and the fetch fails the test unless a test hands it a fake.

let home: string;
let store: Store;
let clock: string;
let fetcher: typeof fetch;
const noNetwork = (async () => {
  throw new Error('This route was not meant to reach a model.');
}) as unknown as typeof fetch;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skeinwise-pa-api-'));
  clock = NOW;
  fetcher = noNetwork;
  store = fillRecord(openHome(home, () => clock));
  saveConfig(home, { ...DEFAULT_CONFIG, engine: 'none', localUrl: 'http://127.0.0.1:8799/v1' });
});
afterEach(() => {
  store.db.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
  const url = new URL(`http://127.0.0.1${path}`);
  const routes = paRoutes({ store, home, deps: () => ({ fetch: fetcher, env: {}, home }) });
  for (const [m, re, handler] of routes) {
    const match = re.exec(url.pathname);
    if (match && m === method) return handler({ url, params: match.slice(1), json: async () => body ?? {} });
  }
  throw new Error(`No route for ${method} ${path}`);
}

function fakeModel(content: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'fake-4b' }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }) as typeof fetch;
}

describe('the routes', () => {
  it('all sit under /api/pa/', () => {
    const routes = paRoutes({ store, home, deps: () => ({ fetch: noNetwork, env: {}, home }) });
    for (const [method, re] of routes) {
      expect(['GET', 'POST', 'PUT']).toContain(method);
      expect(re.source.startsWith('^\\/api\\/pa\\/') || re.source.startsWith('^/api/pa/')).toBe(true);
    }
  });
});

describe('today and the brief', () => {
  it('shows today, makes a brief and counts what came in since', async () => {
    const before = await call('GET', '/api/pa/today');
    expect(before).toMatchObject({ day: '2026-11-25', brief: null, tasks: { open: 0 }, reminders: [] });
    const { brief, message } = await call('POST', '/api/pa/brief', {});
    expect(message).toBeNull();
    expect(brief).toMatchObject({ id: 1, engine: 'none', body: { counts: { entries: 1 } } });
    clock = '2026-11-26T08:00:00.000Z';
    store.ingest({ source: { kind: 'notes', label: 'Notes', location: '/invented/notes' }, threads: [], entries: [{ externalId: 'x.md', kind: 'note', speaker: 'you', title: 'X', createdAt: clock, body: 'Decided to bake on Fridays.' }] });
    expect(await call('GET', '/api/pa/today')).toMatchObject({ day: '2026-11-26', brief: { id: 1 }, newSinceBrief: 1 });
  });

  it('writes the brief with a model when asked, and refuses an engine it does not know', async () => {
    fetcher = fakeModel({ lines: [{ text: 'You sent Ana the river report.', cites: ['E1'] }] });
    const { brief } = await call('POST', '/api/pa/brief', { engine: 'local' });
    expect(brief).toMatchObject({ engine: 'local', model: 'fake-4b', body: { lines: [{ text: 'You sent Ana the river report.' }] } });
    await expect(call('POST', '/api/pa/brief', { engine: 'cloud' })).rejects.toThrow(/Unknown engine/);
    await expect(call('POST', '/api/pa/brief', { since: 7 })).rejects.toThrow(/since must be text/);
  });
});

describe('loops', () => {
  it('lists, marks and turns a loop into a task', async () => {
    const open = await call('GET', '/api/pa/loops');
    expect(open.counts).toEqual({ open: 3, followUp: 1 });
    expect((await call('GET', '/api/pa/loops?days=all')).counts).toEqual({ open: 4, followUp: 2 });
    const vet = open.loops.find((l: { what: string }) => l.what === 'Call the vet on Monday').key;
    const landlord = open.loops.find((l: { what: string }) => l.what.includes('landlord')).key;

    expect(await call('POST', `/api/pa/loops/${vet}/task`)).toMatchObject({ id: 1, title: 'Call the vet', dueDay: '2026-11-30', loopKey: vet });
    expect(await call('POST', `/api/pa/loops/${landlord}`, { state: 'snoozed', until: '2026-11-27' })).toMatchObject({ state: 'snoozed', untilDay: '2026-11-27' });
    expect((await call('GET', '/api/pa/loops')).counts.open).toBe(2);
    expect((await call('GET', '/api/pa/loops?all=1')).loops.map((l: { state: string }) => l.state)).toContain('snoozed');
    expect(await call('POST', `/api/pa/loops/${landlord}`, { state: 'open' })).toMatchObject({ state: 'open' });

    await expect(call('POST', `/api/pa/loops/${landlord}`, { state: 'later' })).rejects.toThrow(/state is open, done/);
    await expect(call('POST', `/api/pa/loops/${landlord}`, { state: 'snoozed' })).rejects.toThrow(/until must be text/);
    await expect(call('GET', '/api/pa/loops?days=0')).rejects.toThrow(/days is a number/);
    const gone = call('POST', '/api/pa/loops/999-0123456789', { state: 'done' });
    await expect(gone).rejects.toBeInstanceOf(HttpError);
    await expect(gone).rejects.toMatchObject({ status: 404, message: 'No loop 999-0123456789: its entry is gone or hidden.' });
  });

  it('has a model read first on POST .../find, and keeps the cue reading when it fails', async () => {
    fetcher = fakeModel({ loops: 'none' });
    const res = await call('POST', '/api/pa/loops/find', { engine: 'local' });
    expect(res.message).toMatch(/from the cue lists alone/);
    expect(res.counts).toEqual({ open: 3, followUp: 1 });
    expect(await call('POST', '/api/pa/loops/find', {})).toMatchObject({ read: null, message: null });
  });
});

describe('tasks and reminders', () => {
  it('adds a task from its words, edits, finishes and deletes it', async () => {
    const t = await call('POST', '/api/pa/tasks', { text: 'renew the van insurance by Friday' });
    expect(t).toMatchObject({ id: 1, title: 'Renew the van insurance', dueDay: '2026-11-27', remindAt: null, status: 'open' });
    expect(await call('POST', '/api/pa/tasks', { text: 'order rye flour', dueDay: '2026-11-24' })).toMatchObject({ dueDay: '2026-11-24' });
    expect((await call('GET', '/api/pa/tasks')).map((x: { id: number }) => x.id)).toEqual([2, 1]);
    expect(await call('PUT', '/api/pa/tasks/1', { title: 'Renew the boat insurance', dueDay: null, notes: 'Policy in the blue folder' })).toMatchObject({ title: 'Renew the boat insurance', dueDay: null, notes: 'Policy in the blue folder' });
    expect(await call('PUT', '/api/pa/tasks/2', { status: 'done' })).toMatchObject({ status: 'done', doneAt: NOW });
    expect((await call('GET', '/api/pa/tasks')).map((x: { id: number }) => x.id)).toEqual([1]);
    expect((await call('GET', '/api/pa/tasks?all=1')).map((x: { id: number }) => x.id)).toEqual([1, 2]);
    expect(await call('POST', '/api/pa/tasks/2/delete')).toMatchObject({ id: 2 });

    await expect(call('PUT', '/api/pa/tasks/2', { status: 'done' })).rejects.toMatchObject({ status: 404, message: 'No task 2.' });
    await expect(call('PUT', '/api/pa/tasks/1', { status: 'later' })).rejects.toThrow(/open, done or dropped/);
    await expect(call('PUT', '/api/pa/tasks/1', { dueDay: 'friday' })).rejects.toThrow(/not a day/);
    await expect(call('POST', '/api/pa/tasks', {})).rejects.toThrow(/text must be text/);
    await expect(call('POST', '/api/pa/tasks', { text: 'x'.repeat(601) })).rejects.toMatchObject({ status: 413 });
  });

  it('adds a reminder, shows it due, snoozes and dismisses it', async () => {
    const r = await call('POST', '/api/pa/tasks', { text: 'call Ana', reminder: true, remindAt: '2026-11-25T18:00:00.000Z' });
    expect(r).toMatchObject({ title: 'Call Ana', remindAt: '2026-11-25T18:00:00.000Z' });
    expect(await call('GET', '/api/pa/reminders')).toMatchObject({ due: [], upcoming: [{ id: 1 }] });
    clock = '2026-11-25T18:05:00.000Z';
    expect(await call('GET', '/api/pa/reminders')).toMatchObject({ due: [{ id: 1 }], upcoming: [] });
    expect((await call('GET', '/api/pa/today')).reminders).toMatchObject([{ id: 1 }]);
    expect(await call('POST', '/api/pa/reminders/1/snooze', { until: '2026-11-25T19:00:00.000Z' })).toMatchObject({ remindAt: '2026-11-25T19:00:00.000Z' });
    await expect(call('POST', '/api/pa/reminders/1/snooze', { until: '2026-11-25T18:00:00.000Z' })).rejects.toThrow(/still to come/);
    clock = '2026-11-25T19:01:00.000Z';
    expect(await call('POST', '/api/pa/reminders/1/dismiss')).toMatchObject({ remindedAt: clock });
    expect(await call('GET', '/api/pa/reminders')).toEqual({ due: [], upcoming: [] });
    await expect(call('POST', '/api/pa/reminders/9/dismiss')).rejects.toMatchObject({ status: 404 });
  });
});
