import { describe, expect, it } from 'vitest';
import {
  boundingSphere,
  brainLayout,
  brainOutline,
  clustersLayout,
  type LayoutPoint,
  ringsLayout,
  rng,
  stemCentre,
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

describe('the brain layout', () => {
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
