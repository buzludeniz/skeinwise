import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.ts';
import { loadConfig, saveConfig } from '../../src/config.ts';
import { UsageError } from '../../src/errors.ts';
import { HttpError } from '../../src/server/app.ts';
import { type Running, startServer } from '../../src/server/serve.ts';
import { viewRoutes } from '../../src/server/viewspec.ts';
import { openDb } from '../../src/store/db.ts';
import { Store } from '../../src/store/store.ts';
import { NO_AI_NOTE } from '../../src/viewspec/draw.ts';
import { MAX_SAVED, viewsDir } from '../../src/viewspec/saved.ts';

const NOW = '2026-05-10T12:00:00.000Z';
const chart = { v: 1, title: 'Garden by month', show: 'chart', form: 'bars', x: 'time' };
const list = { v: 1, title: 'Garden notes', show: 'list', sort: 'oldest', limit: 10, where: [{ prop: 'source', is: 'garden notes' }] };

/** The routes as app.ts runs them: first matching path and method, HttpError's status, UsageError as 400. */
function harness(home: string, store: Store, fetch: typeof globalThis.fetch = (() => Promise.reject(new Error('no network in tests'))) as typeof globalThis.fetch) {
  const routes = viewRoutes({ home, store, deps: () => ({ fetch, env: {}, home }) });
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    for (const [m, re, handler] of routes) {
      const match = re.exec(path);
      if (!match || m !== method) continue;
      try {
        return { status: 200, body: await handler({ params: match.slice(1), json: async () => (body ?? {}) as Record<string, unknown> }) };
      } catch (error) {
        if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
        if (error instanceof UsageError) return { status: 400, body: { error: error.message } };
        throw error;
      }
    }
    return { status: 404, body: { error: 'No such API' } };
  };
}

describe('the views routes', () => {
  let dir: string;
  let home: string;
  let call: ReturnType<typeof harness>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-view-routes-'));
    home = join(dir, 'home');
    mkdirSync(home, { mode: 0o700 });
    saveConfig(home, { ...loadConfig(home), engine: 'none' });
    const store = new Store(openDb(':memory:'), () => NOW);
    store.ingest({
      source: { kind: 'notes', label: 'Garden notes', location: '/invented/garden' },
      threads: [],
      entries: [
        { externalId: 'beds.md', kind: 'note', speaker: 'you', title: 'Tomato beds', createdAt: '2025-03-02T08:00:00.000Z', body: 'Raised beds.' },
        { externalId: 'peas.md', kind: 'note', speaker: 'you', title: 'Pea trellis', createdAt: '2025-03-20T08:00:00.000Z', body: 'Netting.' },
        { externalId: 'rye.md', kind: 'note', speaker: 'you', title: 'Rye ratios', createdAt: '2025-04-11T08:00:00.000Z', body: 'Water.' },
      ],
    });
    call = harness(home, store);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the built-in views, the saved ones, and whether views can be drawn', async () => {
    const { status, body } = await call('GET', '/api/views');
    expect(status).toBe(200);
    expect(body.builtins.map((b: { id: string }) => b.id)).toContain('by-month');
    expect(body).toMatchObject({ saved: [], broken: [], problem: null, ai: { draws: false, engine: 'none', note: NO_AI_NOTE }, limits: { saved: MAX_SAVED, request: 300 } });
  });

  it('saves a checked view under an id the server makes, lists it, and deletes it', async () => {
    const saved = await call('POST', '/api/views', { spec: chart });
    expect(saved).toMatchObject({ status: 200, body: { id: 'garden-by-month', spec: chart } });
    expect((await call('GET', '/api/views')).body.saved).toEqual([saved.body]);
    expect(await call('POST', '/api/views/garden-by-month/delete')).toEqual({ status: 200, body: { deleted: 'garden-by-month' } });
    expect((await call('POST', '/api/views/garden-by-month/delete')).status).toBe(404);
    expect((await call('GET', '/api/views')).body.saved).toEqual([]);
  });

  it('refuses a view that does not pass, and takes no name or path from the page', async () => {
    for (const spec of [{ ...chart, form: 'pie' }, { ...chart, title: '<img src=x onerror=alert(1)>' }, { ...chart, id: '../../../escape' }, { ...chart, path: '/etc/passwd' }, 'not a spec', null]) {
      const r = await call('POST', '/api/views', { spec });
      expect(r.status, JSON.stringify(spec)).toBe(400);
    }
    expect(await call('POST', '/api/views', { spec: chart, id: 'mine', name: '../../x' })).toMatchObject({ body: { id: 'garden-by-month' } });
    expect(readdirSync(viewsDir(home))).toEqual(['garden-by-month.json']);
    for (const id of ['..', '%2e%2e', '.hidden', 'UPPER', 'a.json']) expect((await call('POST', `/api/views/${id}/delete`)).status, id).toBe(404);
    expect(existsSync(join(dir, 'home', 'config.json'))).toBe(true);
  });

  it("gives a chart's counts and a list's entries, checking the spec again", async () => {
    const c = await call('POST', '/api/views/data', { spec: chart });
    expect(c.body).toMatchObject({ show: 'chart', single: true, total: 3, notes: [], table: { xs: ['2025-03', '2025-04'], cells: [[2, 1]] } });
    const l = await call('POST', '/api/views/data', { spec: list });
    expect(l.body).toMatchObject({ show: 'list', total: 3, notes: [], spec: { where: [{ prop: 'source', is: 'Garden notes' }] } });
    expect(l.body.items.map((i: { title: string }) => i.title)).toEqual(['Tomato beds', 'Pea trellis', 'Rye ratios']);
    expect((await call('POST', '/api/views/data', { spec: { ...list, sort: 'random' } })).status).toBe(400);
    expect((await call('POST', '/api/views/data', {})).status).toBe(400);
  });

  it("shows a view that names a value the record lacks, empty and with the reason", async () => {
    const r = await call('POST', '/api/views/data', { spec: { ...chart, where: [{ prop: 'tag', is: 'Pottery' }] } });
    expect(r.body).toMatchObject({ show: 'chart', total: 0, notes: ['Your record has no tag called "Pottery".'] });
  });

  it("gives the entries behind one cell, and refuses a cell that isn't one", async () => {
    const r = await call('POST', '/api/views/data', { spec: chart, cell: { x: '2025-03', y: null } });
    expect(r.body.total).toBe(2);
    expect(r.body.entries.map((e: { title: string }) => e.title)).toEqual(['Pea trellis', 'Tomato beds']);
    for (const cell of [null, 'x', { x: 3 }, { x: 'a', y: 4 }, { x: 'x'.repeat(201) }]) {
      expect((await call('POST', '/api/views/data', { spec: chart, cell })).status, JSON.stringify(cell)).toBe(400);
    }
  });

  it('draws under No-AI with the closest built-in and the plain reason', async () => {
    const r = await call('POST', '/api/views/draw', { request: 'my notes' });
    expect(r.body).toMatchObject({ drawn: false, builtin: 'notes', why: [NO_AI_NOTE] });
    expect((await call('POST', '/api/views/draw', { request: '' })).status).toBe(400);
  });

  it('reports a views folder it will not use, and still lists the built-ins', async () => {
    rmSync(viewsDir(home), { recursive: true, force: true });
    mkdirSync(join(dir, 'elsewhere'));
    if (process.platform === 'win32') return;
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(dir, 'elsewhere'), viewsDir(home));
    const { body } = await call('GET', '/api/views');
    expect(body.problem).toMatch(/isn't a plain folder/);
    expect(body.builtins.length).toBeGreaterThan(0);
  });
});

// The real server's guards, through app.ts's routes.
describe('the views routes behind the real server', () => {
  let dir: string;
  let home: string;
  let app: Running;

  async function api(path: string, init: { body?: unknown; token?: string | null; origin?: string } = {}) {
    const headers: Record<string, string> = {};
    if (init.token !== null) headers['X-Skeinwise-Token'] = init.token ?? app.token;
    if (init.origin) headers.Origin = init.origin;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${app.port}/api/${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-view-server-'));
    home = join(dir, 'home');
    expect(await main(['demo'], { out: () => undefined, err: () => undefined, env: { SKEINWISE_HOME: home } })).toBe(0);
    // No-AI, so no test ever reaches a model server, even one running on this machine.
    saveConfig(home, { ...loadConfig(home), engine: 'none' });
    mkdirSync(join(dir, 'scan'));
    app = await startServer({ home, port: 0, webDir: null, scanRoot: join(dir, 'scan') });
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a cross-origin save or delete, and one without the token', async () => {
    expect((await api('views', { body: { spec: chart }, origin: 'http://evil.example' })).status).toBe(403);
    expect((await api('views', { body: { spec: chart }, token: null })).status).toBe(401);
    expect(existsSync(viewsDir(home))).toBe(false);
    const saved = await api('views', { body: { spec: chart }, origin: `http://127.0.0.1:${app.port}` });
    expect(saved).toMatchObject({ status: 200, body: { id: 'garden-by-month' } });
    expect((await api('views/garden-by-month/delete', { body: {}, origin: 'http://evil.example' })).status).toBe(403);
    expect((await api('views/garden-by-month/delete', { body: {}, token: 'f'.repeat(64) })).status).toBe(401);
    expect((await api('views/draw', { body: { request: 'my notes' }, origin: 'http://evil.example' })).status).toBe(403);
    expect((await api('views')).body.saved).toHaveLength(1);
    expect((await api('views/garden-by-month/delete', { body: {} })).status).toBe(200);
  });

  it('serves the views list and data to the page', async () => {
    expect((await api('views')).body.ai).toMatchObject({ draws: false, engine: 'none' });
    expect((await api('views/data', { body: { spec: chart } })).body).toMatchObject({ show: 'chart' });
  });
});
