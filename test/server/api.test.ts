import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { loadConfig, saveConfig } from '../../src/config.ts';
import { type Running, startServer } from '../../src/server/serve.ts';
import { fileRequest } from '../../src/mcp/requests.ts';

let dir: string;
let home: string;
let app: Running;

async function api(path: string, init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== null) headers['X-Skeinwise-Token'] = init.token ?? app.token;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${app.port}/api/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** A raw request, so the Host header can be set to anything. */
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: app.port, path, headers: { Host: host, 'X-Skeinwise-Token': app.token } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-api-'));
  home = join(dir, 'home');
  let err = '';
  expect(await main(['demo'], { out: () => undefined, err: (t) => (err += t), env: { SKEINWISE_HOME: home } })).toBe(0);
  expect(err).toBe('');
  // No-AI, so no test ever reaches a model server, even one running on this machine.
  saveConfig(home, { ...loadConfig(home), engine: 'none' });
  // A pretend home directory for "Bring in", so the test never looks at the real one.
  const scan = join(dir, 'scan');
  mkdirSync(join(scan, '.claude', 'projects', 'p'), { recursive: true });
  writeFileSync(join(scan, '.claude', 'projects', 'p', 'a.jsonl'), '');
  mkdirSync(join(scan, 'Documents', 'Notes'), { recursive: true });
  writeFileSync(join(scan, 'Documents', 'Notes', 'one.md'), '# One\n\nA note.');
  app = await startServer({ home, port: 0, webDir: null, scanRoot: scan });
});

afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the app's confirm step for agent requests (src/mcp/requests.ts)", () => {
  const now = () => new Date().toISOString();

  it('lists the waiting requests, confirms one as the person and refuses another', async () => {
    expect((await api('threads/1')).body.thread.notMine).toBe(false);
    expect((await api('threads/2')).body.thread.notMine).toBe(false);
    const leave = fileRequest(home, { agent: 'claude-code', tool: 'not_mine', target: 1, what: 'Leave out thread 1' }, now());
    const other = fileRequest(home, { agent: 'cursor', tool: 'not_mine', target: 2, what: 'Leave out thread 2' }, now());
    expect((await api('requests')).body).toEqual([
      expect.objectContaining({ id: leave.id, agent: 'claude-code', tool: 'not_mine', target: 1, what: 'Leave out thread 1' }),
      expect.objectContaining({ id: other.id, agent: 'cursor', target: 2 }),
    ]);

    const confirmed = await api(`requests/${leave.id}/confirm`, { body: {} });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({ request: expect.objectContaining({ id: leave.id }), result: { thread_id: 1, not_mine: true } });
    expect((await api('threads/1')).body.thread.notMine).toBe(true);

    const refused = await api(`requests/${other.id}/refuse`, { body: {} });
    expect(refused.body).toEqual({ refused: expect.objectContaining({ id: other.id }) });
    expect((await api('threads/2')).body.thread.notMine).toBe(false);
    expect((await api('requests')).body).toEqual([]);

    // Back as it was, for the tests after this one.
    await api('threads/1/not-mine', { body: { notMine: false } });
  });

  it('gives 404 for a request that is not waiting, and 409 with the reason for one that can no longer be made', async () => {
    expect((await api('requests/999/confirm', { body: {} })).status).toBe(404);
    expect((await api('requests/999/refuse', { body: {} })).body).toEqual({ error: 'No agent request 999 is waiting' });
    const undo = fileRequest(home, { agent: 'claude-code', tool: 'undo_run', target: 9999, what: 'Undo run 9999' }, now());
    const res = await api(`requests/${undo.id}/confirm`, { body: {} });
    expect(res).toEqual({ status: 409, body: { error: 'There is no run 9999.' } });
    // Dropped either way, as with `skeinwise mcp confirm`.
    expect((await api('requests')).body).toEqual([]);
  });
});

describe('the API guards', () => {
  it('needs the token', async () => {
    expect((await api('status', { token: null })).status).toBe(401);
    expect((await api('status', { token: 'f'.repeat(64) })).status).toBe(401);
    expect((await api('status')).status).toBe(200);
  });

  it('answers only to its own host and origin', async () => {
    expect(await rawGet('/api/status', `127.0.0.1:${app.port}`)).toBe(200);
    expect(await rawGet('/api/status', `localhost:${app.port}`)).toBe(200);
    expect(await rawGet('/api/status', `evil.example:${app.port}`)).toBe(421);
    expect(await rawGet('/', 'evil.example')).toBe(421);
    expect((await api('lock', { body: {}, headers: { Origin: 'http://evil.example' } })).status).toBe(403);
  });

  it('refuses unknown routes, wrong methods and non-JSON bodies', async () => {
    expect((await api('nope')).status).toBe(404);
    expect((await api('stats', { method: 'DELETE' })).status).toBe(405);
    const res = await fetch(`http://127.0.0.1:${app.port}/api/notes`, {
      method: 'POST',
      headers: { 'X-Skeinwise-Token': app.token, 'Content-Type': 'text/plain' },
      body: 'title',
    });
    expect(res.status).toBe(415);
  });

  it('locks everything but status and unlock', async () => {
    expect((await api('lock', { body: {} })).body).toEqual({ locked: true });
    expect((await api('stats')).status).toBe(423);
    expect((await api('status')).body.locked).toBe(true);
    expect((await api('unlock', { body: {} })).body).toEqual({ locked: false });
    expect((await api('stats')).status).toBe(200);
  });

  it('serves a plain page with a strict policy when the app is not built', async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await res.text()).toContain('pnpm build');
  });
});

describe('reading the record', () => {
  it('gives status and numbers', async () => {
    const status = (await api('status')).body;
    expect(status).toMatchObject({ locked: false, organiser: true });
    expect(status.entries).toBeGreaterThan(300);
    const stats = (await api('stats')).body;
    expect(stats.entries).toBe(status.entries);
    expect(stats.notes).toBeGreaterThan(0);
    expect(stats.hubs).toBeNull();
  });

  it('gives one point per visible entry for the brain', async () => {
    const b = (await api('brain')).body;
    expect(b.points).toHaveLength((await api('status')).body.entries);
    expect(b.organiser).toBe(true);
    expect(b.sources.length).toBe(4);
    const [first] = b.points;
    expect(first).toHaveLength(9);
    expect(b.links.length).toBeGreaterThan(0);
  });

  it('opens an entry with its history and neighbours', async () => {
    const hit = (await api('search?q=sqlite')).body.hits[0];
    expect(hit.snippet).toContain('[');
    const detail = (await api(`entries/${hit.id}`)).body;
    expect(detail.entry.id).toBe(hit.id);
    expect(detail.history).toHaveLength(1);
    expect(detail.thread).toBeTruthy();
    expect(detail.ownFile).toBe(false);
    expect((await api('entries/999999')).status).toBe(404);
    expect((await api('entries/abc')).status).toBe(404);
  });

  it('answers a question through the organiser, No-AI', async () => {
    const ask = (await api(`ask?q=${encodeURIComponent('what did I decide about sqlite')}`)).body;
    expect(ask).toMatchObject({ kind: 'decided', topic: 'sqlite', engine: 'none' });
    expect(ask.hits.length).toBeGreaterThan(0);
    expect(ask.hits[0]).toHaveProperty('quote');
    expect((await api('search?q=what%20did%20I%20decide%20about%20sqlite')).body.question).toBe(true);
    expect((await api('search?q=sqlite')).body.question).toBe(false);
    expect((await api('ask?q=x&engine=psychic')).status).toBe(400);
  });

  it('counts weeks, tables and tides that add up to the record', async () => {
    const total = (await api('status')).body.entries;
    const t = (await api('timeline?by=source')).body;
    const sum = t.series.reduce((n: number, s: { total: number }) => n + s.total, 0);
    expect(sum).toBe(total);
    const table = (await api('table?x=time&y=speaker')).body;
    expect(table.total).toBe(total);
    expect((await api('table?x=nope')).status).toBe(400);
    const cell = (await api(`table/cell?x=time&xv=${table.xs[table.xs.length - 1]}&y=speaker&yv=you`)).body;
    expect(cell.total).toBeGreaterThanOrEqual(0);
    expect((await api('tides?by=speaker')).body.lines.length).toBe(2);
  });

  it('reports the organiser ready and empty before any run', async () => {
    const o = (await api('organiser')).body;
    expect(o).toMatchObject({ ready: true, hubs: [], folders: [], runs: [], review: [] });
    expect(o.schemas.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['Topics', 'Projects']));
    expect((await api('stats')).body.organiser).toBeNull();
  });

  it('finds sources only under the scan root', async () => {
    const found = (await api('found')).body as { kind: string; path: string }[];
    expect(found.map((f) => f.kind).sort()).toEqual(['claude-code', 'notes']);
    expect(found.every((f) => f.path.startsWith(join(dir, 'scan')))).toBe(true);
    const notes = found.find((f) => f.kind === 'notes')!;
    expect((await api('found/preview', { body: { path: notes.path } })).body).toMatchObject({ entries: 1 });
  });
});

describe('writing', () => {
  it('creates a note, edits it as a new version and rewrites its file', async () => {
    const made = await api('notes', { body: { title: 'Garden plan', body: 'Beans by the fence. See [[Job search]].' } });
    expect(made.status).toBe(200);
    const file = join(home, 'notes', 'garden-plan.md');
    expect(readFileSync(file, 'utf8')).toContain('title: Garden plan');
    const detail = (await api(`entries/${made.body.id}`)).body;
    expect(detail.entry.title).toBe('Garden plan');
    expect(detail.ownFile).toBe(true);

    const saved = await api(`entries/${made.body.id}`, { method: 'PUT', body: { body: 'Beans by the fence, peas by the shed.' } });
    expect(saved.body).toMatchObject({ wroteFile: true, version: { version: 2, editor: 'you' } });
    expect(readFileSync(file, 'utf8')).toMatch(/^---\ntitle: Garden plan\n[\s\S]*peas by the shed\.\n$/);
    expect((await api(`entries/${made.body.id}`)).body.history).toHaveLength(2);

    expect((await api('notes', { body: { title: '  ' } })).status).toBe(400);
    expect((await api(`entries/${made.body.id}`, { method: 'PUT', body: { body: ' ' } })).status).toBe(400);
  });

  it('adds lines to the daily note', async () => {
    const a = (await api('daily', { body: { text: 'Watered the beans.' } })).body.id;
    const b = (await api('daily', { body: { text: 'Picked the first peas.' } })).body.id;
    expect(b).toBe(a);
    const entry = (await api(`entries/${a}`)).body.entry;
    expect(entry.body).toContain('Watered the beans.');
    expect(entry.body).toContain('Picked the first peas.');
  });

  it('saves settings and refuses bad ones', async () => {
    expect((await api('settings', { method: 'PUT', body: { appearance: { theme: 'moss' } } })).body.appearance.theme).toBe('moss');
    expect((await api('settings')).body.appearance.theme).toBe('moss');
    expect((await api('settings', { method: 'PUT', body: { appearance: { theme: 'neon' } } })).status).toBe(400);
  });

  it("tests the local model with this record's key, and says so when the server wants one", async () => {
    // A stand-in for llama-server locked with --api-key-file: it lists its model only for the right key.
    const seen: (string | undefined)[] = [];
    const model = createServer((req, res) => {
      seen.push(req.headers.authorization);
      const ok = req.url === '/v1/models' && req.headers.authorization === 'Bearer test-key-123';
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { data: [{ id: 'Qwen3-4B-Q4_K_M' }] } : { error: 'Invalid API Key' }));
    });
    await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
    const port = (model.address() as { port: number }).port;
    const before = (await api('settings')).body.ai.local.address;
    const keyFile = join(home, 'models', '.key');
    try {
      expect((await api('settings', { method: 'PUT', body: { ai: { local: { address: `http://127.0.0.1:${port}/v1` } } } })).status).toBe(200);

      const keyless = (await api('model/test')).body;
      expect(keyless.ok).toBe(false);
      expect(keyless.message).toContain('skeinwise model serve --run');

      mkdirSync(join(home, 'models'), { recursive: true });
      writeFileSync(keyFile, 'wrong-key\n');
      const wrong = (await api('model/test')).body;
      expect(wrong.ok).toBe(false);
      expect(wrong.message).toContain("refused this record's key");

      writeFileSync(keyFile, 'test-key-123\n');
      expect((await api('model/test')).body).toEqual({ ok: true, message: 'Running: Qwen3-4B-Q4_K_M' });
      expect(seen).toEqual([undefined, 'Bearer wrong-key', 'Bearer test-key-123']);
    } finally {
      rmSync(keyFile, { force: true });
      await api('settings', { method: 'PUT', body: { ai: { local: { address: before } } } });
      await new Promise((done) => model.close(done));
    }
  });

  it('leaves a source out and brings it back', async () => {
    const before = (await api('status')).body.entries;
    const sources = (await api('sources')).body as { id: number; entries: number; kind: string }[];
    const chatgpt = sources.find((s) => s.kind === 'chatgpt')!;
    await api(`sources/${chatgpt.id}`, { body: { status: 'out' } });
    expect((await api('brain')).body.points.length).toBe(before - chatgpt.entries);
    await api(`sources/${chatgpt.id}`, { body: { status: 'in' } });
    expect((await api('status')).body.entries).toBe(before);
    expect((await api(`sources/${chatgpt.id}`, { body: { status: 'gone' } })).status).toBe(400);
  });

  it('takes uploaded files and imports each top folder as its own source', async () => {
    const put = (batch: string, path: string, text: string) =>
      fetch(`http://127.0.0.1:${app.port}/api/upload?batch=${batch}&path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'X-Skeinwise-Token': app.token, 'Content-Type': 'application/octet-stream' },
        body: text,
      });
    expect((await put('upload01', 'Garden notes/beans.md', '# Beans\n\nSow after the frost.')).status).toBe(200);
    expect((await put('upload01', 'Garden notes/peas.md', '# Peas\n\nNet them early.')).status).toBe(200);
    expect((await put('upload01', '../../escape.md', 'x')).status).toBe(200);
    expect(existsSync(join(home, 'imports', 'upload01', 'escape.md'))).toBe(true);
    expect(existsSync(join(home, 'escape.md'))).toBe(false);
    expect((await put('Bad!', 'a.md', 'x')).status).toBe(400);
    expect((await put('upload01', '', 'x')).status).toBe(400);

    const done = await api('upload/finish', { body: { batch: 'upload01', owner: 'you' } });
    expect(done.status).toBe(200);
    expect(done.body).toEqual([{ source: 'Garden notes', kind: 'notes', added: 2, versioned: 0, unchanged: 0, threads: 0 }]);
    expect((await api('upload/finish', { body: { batch: 'nothing00' } })).status).toBe(404);
  });

  it('writes a backup zip', async () => {
    const b = (await api('backup', { body: {} })).body;
    expect(existsSync(b.file)).toBe(true);
    expect(b.bytes).toBeGreaterThan(1000);
  });
});

describe('the organiser', () => {
  /** Starts a run from the page and waits for it, as the page does. */
  async function organise(body: Record<string, unknown>) {
    let job = (await api('organise', { body })).body.job;
    for (let i = 0; i < 200 && !job.finished; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await api('organise')).body.job;
    }
    return job;
  }
  const state = async () => (await api('organiser')).body;

  it('runs every task No-AI and shows what it made', async () => {
    const job = await organise({ engine: 'none' });
    expect(job).toMatchObject({ finished: true, error: null, task: 'all', engine: 'none' });
    expect(job.runs.map((r: { task: string }) => r.task)).toEqual(['tag', 'tag', 'tag', 'tag', 'file', 'link', 'hub', 'layer', 'review']);
    const o = await state();
    expect(o.hubs.length).toBeGreaterThan(0);
    expect(o.folders.length).toBeGreaterThan(0);
    expect(o.runs).toHaveLength(9);
    expect(o.review.length).toBeGreaterThan(0);

    const stats = (await api('stats')).body;
    expect(stats.hubs).toBe(o.hubs.length);
    expect(stats.organiser.tagged).toBeGreaterThan(0.5);
    expect(stats.organiser.filed).toBe(1);

    const brain = (await api('brain')).body;
    expect(brain.hubs.length).toBe(o.hubs.length);
    expect(brain.links.some((l: number[]) => l[2] === 1)).toBe(true);
    expect(brain.projects.length).toBeGreaterThan(0);
    expect((await api('you')).body.projects.length).toBeGreaterThan(0);
    expect((await api('organise', { body: { task: 'dance' } })).status).toBe(400);
  });

  it('previews a run without saving anything', async () => {
    const before = (await state()).runs.length;
    const p = (await api('organise/preview', { body: { task: 'hub', engine: 'none' } })).body;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ task: 'hub', engine: 'none' });
    expect((await state()).runs.length).toBe(before);
  });

  it('reads a hub, renames it, and deleting it is a run you can undo', async () => {
    const hub = (await state()).hubs[0];
    const read = (await api(`hubs/${hub.id}`)).body;
    expect(read.hub.sections.in_short.length).toBeGreaterThan(0);
    expect(read.entries.length).toBe(Math.min(read.total, 300));
    expect(read.run.engine).toBe('none');
    expect((await api('hubs/999999')).status).toBe(404);

    await api(`hubs/${hub.id}/rename`, { body: { name: 'Bread' } });
    expect((await state()).hubs.find((h: { id: number }) => h.id === hub.id).name).toBe('Bread');
    expect((await api(`hubs/${hub.id}/rename`, { body: { name: ' ' } })).status).toBe(400);

    const gone = (await api(`hubs/${hub.id}/delete`, { body: {} })).body;
    expect((await state()).hubs.some((h: { id: number }) => h.id === hub.id)).toBe(false);
    expect((await api(`runs/${gone.runId}/undo`, { body: {} })).status).toBe(200);
    expect((await state()).hubs.some((h: { id: number }) => h.id === hub.id)).toBe(true);
  });

  it('merges one folder into another and undoes it', async () => {
    const [a, b] = (await state()).folders;
    const merged = (await api('folders/merge', { body: { from: a.id, into: b.name } })).body;
    const after = (await state()).folders;
    expect(after.some((f: { id: number }) => f.id === a.id)).toBe(false);
    expect(after.find((f: { id: number }) => f.id === b.id).entryIds.length).toBe(a.entryIds.length + b.entryIds.length);
    await api(`runs/${merged.runId}/undo`, { body: {} });
    expect((await state()).folders.some((f: { id: number }) => f.id === a.id)).toBe(true);
    expect((await api('folders/merge', { body: { from: 'No such folder', into: b.id } })).status).toBe(400);
  });

  it('answers a review item and drops it from the queue', async () => {
    const queue = (await state()).review;
    const item = queue[0];
    expect(item.reasons.length).toBeGreaterThan(0);
    expect((await api(`review/${item.id}`, { body: { action: 'maybe' } })).status).toBe(400);
    const done = (await api(`review/${item.id}`, { body: { action: 'skip' } })).body;
    expect(done.item.status).toBe('skipped');
    expect((await state()).review).toHaveLength(queue.length - 1);
  });

  it('shows an entry with its layers, hubs and lines', async () => {
    const hub = (await state()).hubs[0];
    const entry = (await api(`hubs/${hub.id}`)).body.entries[0];
    const detail = (await api(`entries/${entry.id}`)).body;
    expect(detail.hubs.map((h: { id: number }) => h.id)).toContain(hub.id);
    expect(Array.isArray(detail.layers)).toBe(true);
    const counts = (await api('links')).body;
    expect(counts.crossLink).toBeGreaterThan(0);
    expect(counts.hubSpoke).toBeGreaterThan(0);
    expect((await api(`links/${entry.id}`)).status).toBe(200);
    expect((await api('links/999999')).status).toBe(400);
  });

  it('undoes a run, but not one a later correction builds on', async () => {
    const runs = (await state()).runs as { id: number; task: string; status: string }[];
    // The hub was renamed above, so the hub run has a correction on top of it.
    const hubRun = runs.find((r) => r.task === 'hub')!;
    expect((await api(`runs/${hubRun.id}/undo`, { body: {} })).status).toBe(400);
    const layer = runs.find((r) => r.task === 'layer')!;
    expect((await api(`runs/${layer.id}/undo`, { body: {} })).body.run.status).toBe('undone');
    expect((await api(`runs/${layer.id}/undo`, { body: {} })).status).toBe(400);
  });
});

describe("the assistant's routes, through the app (src/server/pa.ts)", () => {
  it('adds a task and shows it in today and the list, behind the token and the lock', async () => {
    const added = await api('pa/tasks', { body: { text: 'renew the van insurance', dueDay: '2030-01-02' } });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ title: 'Renew the van insurance', dueDay: '2030-01-02', status: 'open' });
    expect((await api('pa/tasks')).body.map((t: { id: number }) => t.id)).toContain(added.body.id);
    expect((await api('pa/today')).body).toMatchObject({ tasks: { open: 1 }, reminders: [] });
    expect((await api('pa/today', { token: null })).status).toBe(401);
    expect((await api('lock', { body: {} })).body).toEqual({ locked: true });
    expect((await api('pa/reminders')).status).toBe(423);
    expect((await api('unlock', { body: {} })).body).toEqual({ locked: false });
  });
});
