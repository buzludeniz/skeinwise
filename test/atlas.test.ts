import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { mds, placeHubs, placeParts, spread } from '../src/organiser/atlas.ts';
import { createModel } from '../src/organiser/model.ts';
import { type RunOptions, runSteps, runTask, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { undoRun } from '../src/organiser/runs.ts';
import { hubAtlas, hubEntryParts, hubPlaces, liveHubs } from '../src/organiser/views.ts';
import { brainData, packBrain } from '../src/server/queries.ts';
import { openDb } from '../src/store/db.ts';
import { type EntryInput, Store } from '../src/store/store.ts';

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };
const vec = (pairs: [number, number][]) => {
  const norm = Math.hypot(...pairs.map(([, w]) => w));
  return new Map(pairs.map(([t, w]) => [t, w / norm]));
};
const overlaps = (places: { x: number; y: number }[], radii: number[]) => {
  const bad: string[] = [];
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      const d = Math.hypot(places[i]!.x - places[j]!.x, places[i]!.y - places[j]!.y);
      if (d < radii[i]! + radii[j]! - 1e-6) bad.push(`${i}-${j}`);
    }
  }
  return bad;
};

describe('atlas geometry', () => {
  const centres = [
    vec([[1, 1], [2, 0.2]]),
    vec([[1, 1], [2, 0.3]]),
    vec([[3, 1], [4, 0.2]]),
    vec([[3, 1], [4, 0.4]]),
    vec([[5, 1]]),
  ];

  it('puts like centres near each other and unlike ones apart, the same way every time', () => {
    const raw = mds(centres);
    expect(mds(centres)).toEqual(raw);
    const d = (i: number, j: number) => Math.hypot(raw[i]![0] - raw[j]![0], raw[i]![1] - raw[j]![1]);
    expect(d(0, 1)).toBeLessThan(d(0, 2));
    expect(d(2, 3)).toBeLessThan(d(2, 4));
  });

  it('spreads hubs so no two discs overlap', () => {
    const radii = [10, 3, 7, 1, 5];
    expect(overlaps(spread(mds(centres), radii), radii)).toEqual([]);
    expect(spread([[0, 0], [0, 0], [0, 0]], [2, 2, 2])).toHaveLength(3);
    expect(overlaps(spread([[0, 0], [0, 0], [0, 0]], [2, 2, 2]), [2, 2, 2])).toEqual([]);
  });

  it('keeps every placed hub where it was and puts a new one on the coast beside its likes', () => {
    const first = placeHubs(centres.slice(0, 4).map((centre, i) => ({ centre, size: [100, 9, 49, 1][i]!, kept: null })));
    const again = placeHubs([
      ...centres.slice(0, 4).map((centre, i) => ({ centre, size: [100, 9, 49, 1][i]!, kept: first[i]! })),
      { centre: vec([[3, 1], [4, 0.3], [6, 0.1]]), size: 25, kept: null },
    ]);
    expect(again.slice(0, 4)).toEqual(first);
    const radii = [10, 3, 7, 1, 5];
    expect(overlaps(again, radii)).toEqual([]);
    const from = (i: number) => Math.hypot(again[4]!.x - again[i]!.x, again[4]!.y - again[i]!.y);
    // It is about what hub 2 is about, so it lands nearer hub 2 than hub 0.
    expect(from(2)).toBeLessThan(from(0));
  });

  it('fits a hub’s sub-groups inside the hub', () => {
    const parts = placeParts(centres.map((centroid, i) => ({ centroid, size: [40, 20, 10, 5, 1][i]! })));
    for (const p of parts) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(1);
    expect(placeParts([{ centroid: centres[0]!, size: 3 }])).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('the atlas on the demo record', () => {
  let dir: string;
  let store: Store;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-atlas-'));
    writeDemo(dir);
    store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('places every hub and splits it into named sub-groups', () => {
    const hubs = liveHubs(store.db);
    expect(hubs.length).toBeGreaterThan(1);
    for (const h of hubs) {
      const { place, parts } = hubAtlas(store.db, h.id);
      expect(place).not.toBeNull();
      expect(parts.length).toBeGreaterThan(0);
      expect(new Set(parts.map((p) => p.name.toLowerCase())).size).toBe(parts.length);
      for (const p of parts) expect(p.name).not.toBe('');
      for (const r of hubEntryParts(store.db, h.id)) expect(r.part).toBeLessThan(parts.length);
    }
    const sizes = hubs.map((h) => Math.sqrt(h.entries));
    expect(overlaps(hubs.map((h) => hubAtlas(store.db, h.id).place!), sizes)).toEqual([]);
  });

  it('keeps a thread in one sub-group', () => {
    let threads = 0;
    for (const h of liveHubs(store.db)) {
      const partsOf = new Map<number, Set<number | null>>();
      for (const r of hubEntryParts(store.db, h.id)) {
        const thread = store.getEntry(r.id)!.threadId;
        if (!thread) continue;
        if (!partsOf.has(thread)) partsOf.set(thread, new Set());
        partsOf.get(thread)!.add(r.part);
      }
      for (const parts of partsOf.values()) expect(parts.size).toBe(1);
      threads += partsOf.size;
    }
    expect(threads).toBeGreaterThan(0);
  });

  it('keeps every place across a rerun over everything, and undo brings the old hubs back where they were', async () => {
    const before = new Map(liveHubs(store.db).map((h) => [h.name, hubAtlas(store.db, h.id).place]));
    const rerun = await runTask(store, new RecordView(store), { ...NONE, task: 'hub' });
    const after = new Map(liveHubs(store.db).map((h) => [h.name, hubAtlas(store.db, h.id).place]));
    expect(liveHubs(store.db).every((h) => h.runId === rerun.id)).toBe(true);
    expect(after).toEqual(before);
    undoRun(store.db, rerun.id);
    expect(new Map(liveHubs(store.db).map((h) => [h.name, hubAtlas(store.db, h.id).place]))).toEqual(before);
  });

  it('sends places, sub-groups and each spoke’s sub-group in /api/brain', () => {
    const data = brainData(store.db);
    expect(data.hubs.length).toBeGreaterThan(0);
    for (const h of data.hubs) {
      expect(h.place).toHaveLength(2);
      expect(h.part).toHaveLength(h.entries.length);
      for (const p of h.part!) expect(p).toBeLessThan(h.parts!.length);
    }
    const wire = packBrain(data);
    expect(wire.hubs[0]!.parts).toEqual(data.hubs[0]!.parts);
  });
});

describe('the atlas over new entries', () => {
  let store: Store;
  let clock = '2026-01-15T00:00:00.000Z';
  const add = (id: string, body: string, title: string, createdAt = clock) => {
    const entry: EntryInput = { externalId: id, kind: 'note', speaker: 'you', title, createdAt, body };
    store.ingest({ source: { kind: 'notes', label: 'notes', location: '/n' }, threads: [], entries: [entry] });
  };
  const run = (scope: 'all' | 'new') => runTask(store, new RecordView(store), { ...NONE, task: 'hub', scope: { kind: scope } });

  beforeEach(() => {
    clock = '2026-01-15T00:00:00.000Z';
    store = new Store(openDb(':memory:'), () => clock);
    const bread = ['rye loaf', 'sourdough starter', 'rye proof', 'starter feeding', 'sourdough crumb', 'rye flour'];
    const river = ['nitrate samples', 'river samples', 'nitrate rain', 'river outflow', 'outflow nitrate', 'river rain'];
    bread.forEach((w, i) => add(`bread${i}.md`, `Notes on the ${w}. The ${w} and the oven matter for the loaf, and the dough too.`, `Bread ${i}`, `2025-01-0${i + 1}T00:00:00.000Z`));
    river.forEach((w, i) => add(`river${i}.md`, `Notes on the ${w}. The ${w} at the site after the storm, and the flow too.`, `River ${i}`, `2025-02-0${i + 1}T00:00:00.000Z`));
  });

  it('keeps the place of a hub it grows, and puts a new hub on the coast', async () => {
    await run('all');
    const first = hubPlaces(store.db);
    expect(first.size).toBe(2);
    clock = '2026-02-01T00:00:00.000Z';
    add('bread9.md', 'Decided: the rye loaf gets a longer proof in the oven, the dough rests overnight.', 'Bread 9');
    const bikes = ['chain grease', 'gear cable', 'brake pads', 'chain wear', 'gear shifter', 'brake cable'];
    bikes.forEach((w, i) => add(`bike${i}.md`, `Fixed the bike ${w} today. The bike ${w} needed a wrench and new parts again.`, `Bike ${i}`));
    const second = await run('new');
    expect(second.counts).toMatchObject({ updated: 1 });
    expect(second.counts.hubs).toBeGreaterThan(0);
    const now = liveHubs(store.db);
    expect(now).toHaveLength(2 + second.counts.hubs!);
    const grown = now.find((h) => h.replaces !== null)!;
    expect(hubAtlas(store.db, grown.id).place).toEqual(first.get(grown.replaces!));
    const kept = now.find((h) => first.has(h.id))!;
    expect(hubAtlas(store.db, kept.id).place).toEqual(first.get(kept.id));
    const places = now.map((h) => hubAtlas(store.db, h.id).place!);
    expect(overlaps(places, now.map((h) => Math.sqrt(h.entries)))).toEqual([]);
  });

  it('names sub-groups from a model when one is on, and keeps keyword names where its answer is no good', async () => {
    const asked: string[] = [];
    const standIn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'stand-in' }] });
      const user = (JSON.parse(String(init!.body)) as { messages: { content: string }[] }).messages[1]!.content;
      asked.push(user);
      const reply = { name: 'Subject', in_short: [{ text: 'Notes on the loaf and the samples.', cites: ['S1'] }], found: ['S1'], open_ends: [], parts: [{ part: 'P1', name: 'First part' }, { part: 'P9', name: 'Nowhere' }] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    }) as typeof globalThis.fetch;
    await runTask(store, new RecordView(store), { ...NONE, task: 'hub', engine: 'local', client: createModel(DEFAULT_CONFIG, 'local', { fetch: standIn, env: {} }) });
    expect(asked.some((u) => /^P2: /m.test(u) && /"parts"/.test(u))).toBe(true);
    for (const h of liveHubs(store.db)) {
      const { parts } = hubAtlas(store.db, h.id);
      expect(parts.length).toBe(2);
      expect(parts[0]!.name).toBe('First part');
      expect(parts[1]!.name).not.toBe('Nowhere');
      expect(parts[1]!.name).not.toBe('');
    }
  });
});
