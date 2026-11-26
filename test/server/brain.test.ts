// /api/brain past the cap (LS-16's API part): a sample, the whole record's counts, and nothing that points outside it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeCorpus } from '../../bench/corpus.ts';
import { main } from '../../src/cli.ts';
import { openHome } from '../../src/home.ts';
import { BRAIN_POINTS, type BrainData, brainData, type BrainPoint, packBrain, pointLabel, samplePoints } from '../../src/server/queries.ts';
import type { Store } from '../../src/store/store.ts';
import { unpackBrain } from '../../web/src/brain/unpack.ts';

let dir: string;
let store: Store;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-brain-'));
  const home = join(dir, 'home');
  expect(await main(['demo'], { out: () => undefined, err: () => undefined, env: { SKEINWISE_HOME: home } })).toBe(0);
  store = openHome(home);
});

afterAll(() => {
  store?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const point = (id: number, kind: 0 | 1 | 2, time: number): BrainPoint => [id, kind, 0, 1, 0, 0, -1, time, `p${id}`];

describe('samplePoints', () => {
  it('keeps everything up to the cap', () => {
    expect(samplePoints([point(1, 0, 1), point(2, 1, 2)], 2)).toBeNull();
    expect(BRAIN_POINTS).toBe(20_000);
  });

  it('keeps notes and files first, then messages spread evenly over time, in record order', () => {
    // Record order is not time order here, to show the spread follows time.
    const points: BrainPoint[] = [];
    for (let i = 0; i < 100; i++) points.push(point(i, 0, (i * 37) % 100));
    points.push(point(100, 1, 5), point(101, 2, 6));
    const keep = samplePoints(points, 12)!;
    expect(keep).toHaveLength(12);
    expect(keep).toEqual([...keep].sort((a, b) => a - b));
    expect(keep).toContain(100);
    expect(keep).toContain(101);
    const times = keep.filter((i) => i < 100).map((i) => points[i]![7]).sort((a, b) => a - b);
    expect(times).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });
});

describe('pointLabel', () => {
  it("keeps a note's or file's title to 90 characters and a message's preview to 56", () => {
    const long = 'word '.repeat(40);
    expect(pointLabel(long, 'note')).toBe(`${long.slice(0, 89)}…`);
    expect(pointLabel(long, 'file')).toHaveLength(90);
    expect(pointLabel(long, 'message')).toBe(`${long.slice(0, 55)}…`);
    expect(pointLabel('Short', 'message')).toBe('Short');
  });

  it('labels every point in the brain that way', () => {
    for (const p of brainData(store.db).points) expect(p[8].length).toBeLessThanOrEqual(p[1] === 0 ? 56 : 90);
  });
});

describe('brainData past the cap', () => {
  it('sends a sample with the whole record counted, and links, threads and hubs only inside it', () => {
    const whole = brainData(store.db);
    expect(whole.total).toBe(whole.points.length);
    const cap = Math.floor(whole.points.length / 3);
    const b = brainData(store.db, cap);
    expect(b.points).toHaveLength(cap);
    expect(b.total).toBe(whole.points.length);
    expect(b.counts).toEqual(whole.counts);
    const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
    for (const by of ['speaker', 'source', 'folder', 'month'] as const) expect(sum(b.counts![by])).toBe(b.total);
    expect(sum(b.counts!.project) + b.counts!.noProject).toBe(b.total);
    // The lookup tables are the whole record's, so the indices mean the same in every answer.
    expect(b.speakers).toEqual(whole.speakers);
    expect(b.sources).toEqual(whole.sources);
    expect(b.folders).toEqual(whole.folders);
    const shown = new Set(b.points.map((p) => p[0]));
    for (const [from, to] of b.links) expect(shown.has(from) && shown.has(to)).toBe(true);
    const threads = new Set(b.points.map((p) => String(p[4])).filter((t) => t !== '0'));
    for (const t of Object.keys(b.threads)) expect(threads.has(t)).toBe(true);
    for (const h of b.hubs) {
      expect(h.entries.every((id) => shown.has(id))).toBe(true);
      expect(h.size).toBe(whole.hubs.find((w) => w.id === h.id)!.entries.length);
    }
  });
});

/** What the page is handed: a value through JSON, as fetch gives it. */
const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const brain = (points: BrainPoint[], links: BrainData['links'], hubs: BrainData['hubs']): BrainData => ({
  kinds: ['message', 'note', 'file'],
  speakers: ['you'],
  sources: [{ id: 1, label: 'Notes', kind: 'notes' }],
  folders: ['Inbox'],
  projects: [],
  threads: {},
  points,
  total: points.length,
  links,
  hubs,
  organiser: true,
});

describe('packBrain and unpackBrain', () => {
  it('give the page back exactly the BrainData that JSON carried, whole and past the cap', () => {
    for (const cap of [BRAIN_POINTS, 200]) {
      const d = brainData(store.db, cap);
      expect(unpackBrain(viaJson(packBrain(d)))).toEqual(viaJson(d));
    }
  });

  it('keep a point without a time, ids out of order, links in any order and every hub entry', () => {
    const d = brain(
      [point(30, 1, 5_000), point(7, 0, Number.NaN), point(12, 2, 4_000), point(40, 0, 9_000)],
      [
        [40, 30, 1],
        [30, 12, 0],
        [7, 40, 1],
      ],
      [{ id: 3, name: 'Sourdough', size: 3, entries: [7, 12, 40] }],
    );
    const back = unpackBrain(viaJson(packBrain(d)));
    expect(back).toEqual(viaJson(d));
    expect(back.points[1]![7]).toBeNull(); // as JSON has always sent the NaN
    expect(unpackBrain(viaJson(packBrain(brain([], [], []))))).toEqual(viaJson(brain([], [], [])));
  });

  it('refuse a link to an entry that is not a point, and a reply packed some other way', () => {
    expect(() => packBrain(brain([point(1, 1, 0)], [[1, 2, 0]], []))).toThrow(/the link 1 → 2 names an entry that isn't a point/);
    const unknown = { ...packBrain(brain([], [], [])), packed: 2 } as unknown as ReturnType<typeof packBrain>;
    expect(() => unpackBrain(unknown)).toThrow(/packed: 2/);
  });
});

describe("/api/brain's size on an organised record", () => {
  // The bench's own corpus at 1,500 entries, organised as the bench organises its 50k (run all --engine none), so it
  // has both kinds of link and hubs, as the 50k first load does.
  let fixtureDir: string;
  let fixture: Store;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'skeinwise-brain-size-'));
    const env = { SKEINWISE_HOME: join(fixtureDir, 'home'), HOME: join(fixtureDir, 'user') };
    const io = { out: () => undefined, err: () => undefined, env };
    const corpus = writeCorpus(join(fixtureDir, 'corpus'), 1_500);
    expect(await main(['import', ...corpus.paths], io)).toBe(0);
    expect(await main(['run', 'all', '--engine', 'none'], io)).toBe(0);
    fixture = openHome(env.SKEINWISE_HOME);
  });

  afterAll(() => {
    fixture?.db.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('packs to at most 41 kB gzip, under three quarters of the plain BrainData', () => {
    // On the bench's organised 50k record (20,000 points, 38,977 links, 40 hubs) packing took the first load from
    // 740 kB to 471 kB gzip, under plan section 7's 600 kB. Here it is 39.7 kB. If this grows past the pin, measure
    // the 50k again (bench/README.md) before raising it.
    const d = brainData(fixture.db);
    expect(d.links.some((l) => l[2] === 0) && d.links.some((l) => l[2] === 1) && d.hubs.length > 0).toBe(true);
    const gzip = (value: unknown) => gzipSync(JSON.stringify(value)).length;
    const packed = gzip(packBrain(d));
    expect(packed).toBeLessThanOrEqual(41_000);
    expect(packed / gzip(d)).toBeLessThan(0.75);
  });

  it('sorts the links by kind, then by where from and then to sit in the points', () => {
    const d = brainData(fixture.db);
    const at = new Map(d.points.map((p, i) => [p[0], i]));
    const keys = d.links.map(([a, b, kind]) => [kind, at.get(a)!, at.get(b)!]);
    const sorted = [...keys].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!);
    expect(keys).toEqual(sorted);
  });
});
