import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { cleaned } from '../src/organiser/layers.ts';
import { type RunOptions, runSteps, runTask, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { withUpdates } from '../src/organiser/review.ts';
import { getRun, listRuns, undoRun } from '../src/organiser/runs.ts';
import { entryLayers, findSchema, liveFolders, liveHubs, liveLinks, liveTags, openReviewItems } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { type EntryInput, Store } from '../src/store/store.ts';

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };
const TABLES = ['tags WHERE run_id IS NOT NULL', 'entry_tags', 'folders', 'entry_folders', 'links', 'hubs', 'hub_entries', 'layers', 'review_items'];
const count = (store: Store, table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('the No-AI organiser on the demo record', () => {
  let dir: string;
  let store: Store;
  let before: ReturnType<Store['allEntries']>;
  let ms: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-org-'));
    writeDemo(dir);
    store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
    before = store.allEntries();
    const t0 = performance.now();
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    ms = performance.now() - t0;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs every task, each schema of tags apart, in a few seconds', () => {
    const runs = listRuns(store.db).reverse();
    expect(runs.map((r) => r.task)).toEqual(['tag', 'tag', 'tag', 'file', 'link', 'hub', 'layer', 'review']);
    expect(runs.every((r) => r.status === 'done' && r.engine === 'none')).toBe(true);
    expect(ms).toBeLessThan(5000);
  });

  it('makes hubs for Plotline, sourdough and the river thesis, with sections from your own words', () => {
    const hubs = liveHubs(store.db);
    const names = hubs.map((h) => h.name).join(' | ');
    expect(names).toMatch(/Plotline/);
    expect(names).toMatch(/sourdough/i);
    expect(names).toMatch(/nitrate|river|thesis|samples/i);
    const plotline = hubs.find((h) => /Plotline/.test(h.name))!;
    expect(plotline.sections.in_short.length).toBeGreaterThan(0);
    expect(plotline.sections.what_you_found.map((i) => i.text)).toContain('Decided: Plotline runs on SQLite.');
    expect(plotline.sections.open_ends.every((i) => i.text.endsWith('?'))).toBe(true);
    for (const item of Object.values(plotline.sections).flat()) expect(store.getEntry(item.entryId)!.speaker).toBe('you');
  });

  it('files every entry once and tags every entry with a topic', () => {
    const folders = liveFolders(store.db);
    expect(folders.reduce((n, f) => n + f.entryIds.length, 0)).toBe(before.length);
    const topics = liveTags(store.db, findSchema(store.db, 'Topics')!.id);
    expect(new Set(topics.map((t) => t.name.toLowerCase())).size).toBe(topics.length);
    expect(new Set(topics.flatMap((t) => t.entryIds)).size).toBe(before.length);
    const projects = liveTags(store.db, findSchema(store.db, 'Projects')!.id).map((t) => t.name);
    expect(projects).toEqual(expect.arrayContaining(['Plotline', 'Sourdough schedule', 'Wend river survey']));
  });

  it('joins [[links]] to the notes they name, and related entries across threads', () => {
    const links = liveLinks(store.db);
    const plotline = before.find((e) => e.title === 'Plotline' && e.kind === 'note')!;
    expect(links.some((l) => l.kind === 'note' && l.to === plotline.id)).toBe(true);
    const cross = links.filter((l) => l.kind === 'cross');
    expect(cross.length).toBeGreaterThan(50);
    for (const l of cross) expect(store.getEntry(l.from)!.threadId === null || store.getEntry(l.from)!.threadId !== store.getEntry(l.to)!.threadId).toBe(true);
  });

  it('flags the Plotline note after the April 2026 move to Postgres', () => {
    const plotline = before.find((e) => e.title === 'Plotline' && e.kind === 'note')!;
    const item = openReviewItems(store.db).find((i) => i.noteEntry === plotline.id)!;
    const postgres = item.reasons.find((r) => /Postgres/.test(r.quote))!;
    expect(postgres).toMatchObject({ date: '2026-04-05' });
    expect(postgres.why).toMatch(/changing my mind/);
    expect(item.proposed).toContain(plotline.body.trim());
    expect(item.proposed).toMatch(/## Updates\n\n- 2025-03-09: .*\n- 2026-04-05: Changing my mind on SQLite/);
  });

  it('writes no Expanded layer without a model, and says so', () => {
    const layer = listRuns(store.db).find((r) => r.task === 'layer')!;
    expect(layer.counts.expanded).toBe(0);
    expect(layer.message).toMatch(/no Expanded layer/);
  });

  it('undo removes everything, newest run first, and leaves the record untouched', () => {
    const runs = listRuns(store.db);
    expect(() => undoRun(store.db, runs.at(-1)!.id)).not.toThrow(); // tags build on nothing
    for (const r of runs.slice(0, -1)) undoRun(store.db, r.id);
    for (const t of TABLES) expect(count(store, t), t).toBe(0);
    expect(store.allEntries()).toEqual(before);
    expect(listRuns(store.db).every((r) => r.status === 'undone')).toBe(true);
  });
});

describe('scope new', () => {
  let store: Store;
  let clock = '2026-01-01T00:00:00.000Z';

  function add(id: string, body: string, title = id, createdAt = clock) {
    const entry: EntryInput = { externalId: id, kind: 'note', speaker: 'you', title, createdAt, body };
    store.ingest({ source: { kind: 'notes', label: 'notes', location: '/n' }, threads: [], entries: [entry] });
  }

  beforeEach(() => {
    store = new Store(openDb(':memory:'), () => clock);
    const bread = ['rye loaf', 'sourdough starter', 'rye proof', 'starter feeding', 'sourdough crumb', 'rye flour'];
    const river = ['nitrate samples', 'river samples', 'nitrate rain', 'river outflow', 'outflow nitrate', 'river rain'];
    bread.forEach((w, i) => add(`bread${i}.md`, `Notes on the ${w}. The ${w} and the oven matter for the loaf, and the dough too.`, `Bread ${i}`, `2025-01-0${i + 1}T00:00:00.000Z`));
    river.forEach((w, i) => add(`river${i}.md`, `Notes on the ${w}. The ${w} at the site after the storm, and the flow too.`, `River ${i}`, `2025-02-0${i + 1}T00:00:00.000Z`));
  });

  const run = (task: 'hub' | 'file' | 'link', scope: 'all' | 'new') => runTask(store, new RecordView(store), { ...NONE, task, scope: { kind: scope } });

  it('adds new entries to the hubs they belong to, and leaves other hubs as they were', async () => {
    await run('hub', 'all');
    const first = liveHubs(store.db);
    expect(first).toHaveLength(2);
    clock = '2026-02-01T00:00:00.000Z';
    add('bread9.md', 'Decided: the rye loaf gets a longer proof in the oven, the dough rests overnight.', 'Bread 9');
    const second = await run('hub', 'new');
    expect(second.counts).toMatchObject({ hubs: 0, updated: 1, entries: 7 });
    const now = liveHubs(store.db);
    expect(now).toHaveLength(2);
    const bread = now.find((h) => h.replaces !== null)!;
    expect(bread.entries).toBe(7);
    expect(bread.name).toBe(first.find((h) => h.id === bread.replaces)!.name);
    expect(now.map((h) => h.id)).toContain(first.find((h) => h.id !== bread.replaces)!.id);

    // A second run over new entries finds nothing to do; undoing the update brings back the old hub.
    expect((await run('hub', 'new')).counts).toMatchObject({ hubs: 0, updated: 0 });
    undoRun(store.db, second.id);
    expect(liveHubs(store.db).map((h) => h.id).sort()).toEqual(first.map((h) => h.id).sort());
  });

  it('files new entries into the folders they fit, and the rest into the Inbox', async () => {
    await run('file', 'all');
    expect(liveFolders(store.db)).toHaveLength(2);
    clock = '2026-02-01T00:00:00.000Z';
    add('bread9.md', 'The rye loaf and the sourdough starter again, with the oven and the dough.', 'Bread 9');
    add('odd.md', 'Quarterly tax forms for the accountant.', 'Tax');
    const r = await run('file', 'new');
    expect(r.counts).toMatchObject({ folders: 1, grown: 1, filed: 2, inbox: 1 });
    const folders = liveFolders(store.db);
    expect(folders.find((f) => f.name === 'Inbox')!.entryIds).toHaveLength(1);
    expect(folders.reduce((n, f) => n + f.entryIds.length, 0)).toBe(14);
  });

  it('adds only links that are not there yet', async () => {
    add('index.md', 'See [[Bread 1]] and [[River 2]] and [[Nowhere]].', 'Index');
    const first = await run('link', 'all');
    expect(first.counts).toMatchObject({ note: 2, unresolved: 1 });
    expect(first.engine).toBe('none');
    clock = '2026-02-01T00:00:00.000Z';
    add('more.md', 'Also [[Bread 1]].', 'More');
    expect((await run('link', 'new')).counts).toMatchObject({ note: 1, unresolved: 0 });
    // A run over everything replaces both, so it makes every link afresh.
    expect((await run('link', 'all')).counts).toMatchObject({ note: 3, unresolved: 1 });
  });

  it('review needs hubs first', async () => {
    await expect(runTask(store, new RecordView(store), { ...NONE, task: 'review' })).rejects.toThrow(/Run the hub task first/);
    expect(listRuns(store.db)).toHaveLength(0);
  });
});

describe('layers and review text', () => {
  it('drops spoken filler and keeps everything else as it was', () => {
    expect(cleaned('Um, so I think, you know, the rye needs longer.\n    code  stays  as is')).toBe('So I think, the rye needs longer.\n    code  stays  as is');
    expect(cleaned('Nothing to drop here.')).toBe('Nothing to drop here.');
  });

  it('adds update lines to an Updates section, or starts one', () => {
    const r = { entryId: 9, date: '2026-04-05', quote: 'We move to Postgres.', why: '' };
    expect(withUpdates('# Plotline\n\nOne database.\n', [r])).toBe('# Plotline\n\nOne database.\n\n## Updates\n\n- 2026-04-05: We move to Postgres. (entry #9)\n');
    expect(withUpdates('# P\n\n## Updates\n\n- 2025-01-01: x (entry #1)', [r])).toBe('# P\n\n## Updates\n\n- 2025-01-01: x (entry #1)\n- 2026-04-05: We move to Postgres. (entry #9)\n');
  });

  it('a layer run keeps the original entry and records who wrote each layer', async () => {
    const store = new Store(openDb(':memory:'), () => '2026-01-01T00:00:00.000Z');
    store.ingest({
      source: { kind: 'notes', label: 'notes', location: '/n' },
      threads: [],
      entries: [{ externalId: 'a.md', kind: 'note', speaker: 'you', title: 'a', createdAt: '2025-01-01T00:00:00.000Z', body: 'Um, the idea is to try rye. Maybe we could bake twice a week.' }],
    });
    const run = await runTask(store, new RecordView(store), { ...NONE, task: 'layer' });
    expect(getRun(store.db, run.id)!.counts).toMatchObject({ cleaned: 1, ideas: 1, expanded: 0 });
    expect(entryLayers(store.db, 1).map((l) => [l.layer, l.engine])).toEqual([
      ['cleaned', 'none'],
      ['ideas', 'none'],
    ]);
    expect(store.getEntry(1)!.body).toMatch(/^Um, the idea/);
  });
});
