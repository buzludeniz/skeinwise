// /api/brain past the cap (LS-16's API part): a sample, the whole record's counts, and nothing that points outside it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { openHome } from '../../src/home.ts';
import { BRAIN_POINTS, brainData, type BrainPoint, samplePoints } from '../../src/server/queries.ts';
import type { Store } from '../../src/store/store.ts';

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
