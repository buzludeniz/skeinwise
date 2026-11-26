import { describe, expect, it } from 'vitest';
import { CAPSULES, outside } from '../../web/src/brain/anatomy.ts';
import { bodyLayout, toHead } from '../../web/src/brain/body.ts';
import {
  boundingSphere,
  brainLayout,
  brainOutline,
  clustersLayout,
  type LayoutContext,
  layoutFor,
  type LayoutPoint,
  ringsLayout,
  rng,
  stemCentre,
  STRIP_LANE,
  STRIP_LENGTH,
  stripLayout,
} from '../../web/src/layout.ts';

function record(n: number, seed = 1): LayoutPoint[] {
  const r = rng(seed);
  const start = Date.UTC(2024, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    kind: (r() < 0.15 ? 1 : 0) as 0 | 1,
    time: start + Math.floor(r() * 3 * 365 * 86_400_000),
    cluster: Math.floor(r() * 6),
    strand: Math.floor(r() * 4),
    thread: 0,
    group: Math.floor(r() * 5),
  }));
}

/** The four sources record() winds its originals on, and a now after its last entry. */
const ctx: LayoutContext = {
  sources: [
    { id: 1, kind: 'chatgpt' },
    { id: 2, kind: 'claude-code' },
    { id: 3, kind: 'notes' },
    { id: 4, kind: 'claude' },
  ],
  now: Date.UTC(2027, 0, 1),
};
const brain = (pts: readonly LayoutPoint[]) => layoutFor('brain', pts, ctx);

describe("the brain layout: the standing body, under the 'brain' key", () => {
  it('is the body layout, the same every time for the same record, whatever the input order', () => {
    const pts = record(500);
    const a = brain(pts);
    expect(a).toEqual(bodyLayout(pts, ctx.sources, ctx.now).positions);
    expect(brain(pts)).toEqual(a);
    const shuffled = [...pts].reverse();
    const b = brain(shuffled);
    pts.forEach((p, i) => {
      const j = shuffled.indexOf(p);
      expect([b[j * 3], b[j * 3 + 1], b[j * 3 + 2]]).toEqual([a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]);
    });
  });

  it("puts notes in the lobes, clear of the gap between them, inside the head, and every other entry inside the body", () => {
    const pts = record(800);
    const pos = brain(pts);
    const skull = CAPSULES.filter((c) => c.part === 'head');
    pts.forEach((p, i) => {
      const v: [number, number, number] = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
      expect(Number.isFinite(v[0] + v[1] + v[2])).toBe(true);
      if (p.kind === 1) {
        expect(Math.abs(v[0])).toBeGreaterThan(0.04);
        expect(outside(toHead(v), skull)).toBe(0);
      } else {
        expect(outside(toHead(v))).toBeLessThan(0.02);
        expect(outside(toHead(v), skull)).toBeGreaterThan(0);
      }
    });
  });

  it("hangs originals oldest at their nerve's root and newest towards its tip", () => {
    const pts = record(400).map((p) => ({ ...p, kind: 0 as const }));
    const { along, nerveOf } = bodyLayout(pts, ctx.sources, ctx.now);
    for (let k = 0; k < ctx.sources.length; k++) {
      const mine = pts.map((p, i) => ({ t: p.time, u: along[i]!, k: nerveOf[i]! })).filter((e) => e.k === k).sort((a, b) => a.t - b.t);
      for (let j = 1; j < mine.length; j++) expect(mine[j]!.u).toBeGreaterThanOrEqual(mine[j - 1]!.u);
      expect(mine[0]!.u).toBeLessThan(0.1);
    }
  });

  it('handles an empty record and a single point', () => {
    expect(brain([])).toHaveLength(0);
    const one = brain([{ id: 1, kind: 0, time: 0, cluster: 0, strand: 0, thread: 0, group: 0 }]);
    expect([...one].every(Number.isFinite)).toBe(true);
    const unlisted = layoutFor('brain', [{ id: 1, kind: 0, time: 0, cluster: 0, strand: 5, thread: 0, group: 0 }], { sources: [], now: ctx.now });
    expect([...unlisted].every(Number.isFinite)).toBe(true);
  });

  it('lays 20 000 points out quickly', () => {
    const pts = record(20_000, 3);
    const t = performance.now();
    brain(pts);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('the cortex (brainLayout), which the body keeps for notes', () => {
  it('is the same every time for the same record, whatever the input order', () => {
    const pts = record(500);
    const a = brainLayout(pts);
    expect(brainLayout(pts)).toEqual(a);
    const shuffled = [...pts].reverse();
    const b = brainLayout(shuffled);
    pts.forEach((p, i) => {
      const j = shuffled.indexOf(p);
      expect([b[j * 3], b[j * 3 + 1], b[j * 3 + 2]]).toEqual([a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]);
    });
    expect(brainOutline()).toEqual(brainOutline());
  });

  it('puts notes in the lobes, clear of the gap between them, and originals on the stem', () => {
    const pts = record(800);
    const pos = brainLayout(pts);
    pts.forEach((p, i) => {
      const [x, y, z] = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
      expect(Number.isFinite(x + y + z)).toBe(true);
      if (p.kind === 1) {
        expect(Math.abs(x)).toBeGreaterThan(0.04);
        expect(y).toBeGreaterThan(-0.2);
      } else {
        expect(Math.abs(x)).toBeLessThan(0.3);
        expect(y).toBeLessThan(0.3);
        expect(y).toBeGreaterThan(-2.7);
      }
    });
  });

  it('winds originals oldest lowest', () => {
    const pts = record(400).map((p) => ({ ...p, kind: 0 as const }));
    const pos = brainLayout(pts);
    const byTime = pts.map((p, i) => ({ t: p.time, y: pos[i * 3 + 1]! })).sort((a, b) => a.t - b.t);
    expect(byTime[0]!.y).toBeLessThan(-2.4);
    expect(byTime.at(-1)!.y).toBeGreaterThan(0);
    const firstTenth = byTime.slice(0, 40).reduce((s, p) => s + p.y, 0) / 40;
    const lastTenth = byTime.slice(-40).reduce((s, p) => s + p.y, 0) / 40;
    expect(firstTenth).toBeLessThan(lastTenth);
    expect(stemCentre(0).p[1]).toBeLessThan(stemCentre(1).p[1]);
  });

  it('handles an empty record and a single point', () => {
    expect(brainLayout([])).toHaveLength(0);
    expect(ringsLayout([])).toHaveLength(0);
    expect(clustersLayout([])).toHaveLength(0);
    const one = brainLayout([{ id: 1, kind: 0, time: 0, cluster: 0, strand: 0, thread: 0, group: 0 }]);
    expect([...one].every(Number.isFinite)).toBe(true);
  });

  it('lays 20 000 points out quickly', () => {
    const pts = record(20_000, 3);
    const t = performance.now();
    brainLayout(pts);
    ringsLayout(pts);
    clustersLayout(pts);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('the activity and clusters layouts', () => {
  it('puts later years further out', () => {
    const pts = record(300);
    const pos = ringsLayout(pts);
    const radius = (i: number) => Math.hypot(pos[i * 3]!, pos[i * 3 + 2]!);
    const year = (i: number) => new Date(pts[i]!.time).getUTCFullYear();
    const avg = (y: number) => {
      const r = pts.map((_, i) => i).filter((i) => year(i) === y).map(radius);
      return r.reduce((a, b) => a + b, 0) / r.length;
    };
    expect(avg(2024)).toBeLessThan(avg(2025));
    expect(avg(2025)).toBeLessThan(avg(2026));
  });

  it('keeps each group together', () => {
    const pts = record(600);
    const pos = clustersLayout(pts);
    const centre = (g: number) => {
      const idx = pts.map((_, i) => i).filter((i) => pts[i]!.group === g);
      return [idx.reduce((s, i) => s + pos[i * 3]!, 0) / idx.length, idx.reduce((s, i) => s + pos[i * 3 + 1]!, 0) / idx.length];
    };
    pts.forEach((p, i) => {
      const [cx, cy] = centre(p.group);
      expect(Math.hypot(pos[i * 3]! - cx!, pos[i * 3 + 1]! - cy!)).toBeLessThan(0.7);
    });
    expect(boundingSphere(pos).radius).toBeGreaterThan(0.3);
  });
});

describe("the Timeline's strip", () => {
  it('runs time left to right, oldest first, along y', () => {
    const pts = record(300);
    const pos = stripLayout(pts, ctx.sources);
    const byTime = pts.map((p, i) => ({ t: p.time, y: pos[i * 3 + 1]! })).sort((a, b) => a.t - b.t);
    for (let j = 1; j < byTime.length; j++) expect(byTime[j]!.y).toBeGreaterThanOrEqual(byTime[j - 1]!.y);
    expect(byTime[0]!.y).toBeCloseTo(-STRIP_LENGTH / 2, 5);
    expect(byTime.at(-1)!.y).toBeCloseTo(STRIP_LENGTH / 2, 5);
  });

  it('gives each source its own lane, in id order from the top, hubs above, and keeps it as sources arrive', () => {
    const pts = record(300).map((p) => ({ ...p, kind: 0 as const }));
    const hub: LayoutPoint = { id: -1, kind: 1, time: pts[0]!.time, cluster: 0, strand: 0, thread: 0, group: 0 };
    const pos = stripLayout([...pts, hub], ctx.sources);
    const laneZ = (strand: number) => pts.flatMap((p, i) => (p.strand === strand ? [pos[i * 3 + 2]!] : []));
    const centres = [0, 1, 2, 3].map((s) => {
      const z = laneZ(s);
      expect(Math.max(...z) - Math.min(...z)).toBeLessThanOrEqual(STRIP_LANE * 0.6);
      return (Math.max(...z) + Math.min(...z)) / 2;
    });
    // record() strands index sources ids 1..4, so lanes run 0, 1, 2, 3 from the top.
    for (let k = 1; k < 4; k++) expect(centres[k]!).toBeLessThan(centres[k - 1]! - STRIP_LANE * 0.3);
    expect(pos[pts.length * 3 + 2]!).toBeGreaterThan(Math.max(...laneZ(0)));
    // A new source with a higher id takes a lane below; the others keep theirs.
    const more = stripLayout(pts, [...ctx.sources, { id: 9 }]);
    const shift = more[2]! - pos[2]!;
    pts.forEach((_, i) => expect(more[i * 3 + 2]! - pos[i * 3 + 2]!).toBeCloseTo(shift, 5));
  });

  it('handles an empty record, undated entries and unlisted sources', () => {
    expect(stripLayout([], ctx.sources)).toHaveLength(0);
    const odd = stripLayout(
      [
        { id: 1, kind: 0, time: Number.NaN, cluster: 0, strand: 0, thread: 0, group: 0 },
        { id: 2, kind: 0, time: 5, cluster: 0, strand: 7, thread: 0, group: 0 },
      ],
      [{ id: 1 }],
    );
    expect([...odd].every(Number.isFinite)).toBe(true);
    expect(odd[1]!).toBeLessThan(odd[4]!);
    expect(odd[5]!).toBeLessThan(odd[2]! - STRIP_LANE * 0.3);
  });
});
