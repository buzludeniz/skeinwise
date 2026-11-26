// The standing body (web/src/brain/anatomy.ts): a symmetric figure seven and a half heads tall, a region for each
// kind of source, one nerve per source that runs inside the body from the cord to a hand, a foot or the front of the
// trunk, places that never move when a source is added, and paths sampled by arc length.

import { describe, expect, it } from 'vitest';
import { BODY, CAPSULES, CORD, nervesFor, outside, pathThrough, pointAlong, regionOf, type V3 } from '../../web/src/brain/anatomy.ts';

const sources = [
  { id: 1, kind: 'chatgpt' },
  { id: 2, kind: 'notes' },
  { id: 3, kind: 'claude-code' },
  { id: 4, kind: 'claude' },
  { id: 5, kind: 'codex' },
  { id: 6, kind: 'gemini' },
  { id: 7, kind: 'files' },
  { id: 8, kind: 'chatgpt' },
  { id: 9, kind: 'claude-code' },
  { id: 10, kind: 'wordpress' },
  { id: 11, kind: 'notes' },
  { id: 12, kind: 'claude' },
  { id: 13, kind: 'codex' },
];
const nerves = nervesFor(sources);
const at = (path: ReturnType<typeof pathThrough>, i: number): V3 => [path.points[i * 3]!, path.points[i * 3 + 1]!, path.points[i * 3 + 2]!];
const near = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('the body', () => {
  it('stands seven and a half heads tall, from the crown to the floor', () => {
    const top = Math.max(...CAPSULES.flatMap((c) => [c.a[1] + c.r, c.b[1] + c.r]));
    const bottom = Math.min(...CAPSULES.flatMap((c) => [c.a[1] - c.r, c.b[1] - c.r]));
    expect(top).toBeCloseTo(BODY.crown);
    expect(bottom).toBeCloseTo(BODY.floor);
  });

  it('is symmetric: every capsule off the midline has its mirror', () => {
    for (const c of CAPSULES) {
      if (c.a[0] === 0 && c.b[0] === 0) continue;
      const twin = CAPSULES.find((o) => o.part === c.part && o.a[0] === -c.a[0] && o.b[0] === -c.b[0] && o.a[1] === c.a[1] && o.r === c.r);
      expect(twin, c.part).toBeDefined();
    }
  });

  it('keeps the cord inside the body, behind the middle of the trunk', () => {
    const cord = pathThrough(CORD);
    for (let i = 0; i < cord.along.length; i++) {
      const p = at(cord, i);
      expect(outside(p)).toBe(0);
      expect(p[0]).toBeCloseTo(0);
      expect(p[2]).toBeLessThan(0);
    }
  });
});

describe('the regions', () => {
  it('puts chat assistants on the arms, coding agents on the legs, and everything else on the trunk', () => {
    expect(['chatgpt', 'claude', 'gemini'].map(regionOf)).toEqual(['arms', 'arms', 'arms']);
    expect(['claude-code', 'codex'].map(regionOf)).toEqual(['legs', 'legs']);
    expect(['notes', 'files', 'wordpress', 'something-new', ''].map(regionOf)).toEqual(['trunk', 'trunk', 'trunk', 'trunk', 'trunk']);
  });
});

describe('the nerves', () => {
  it('gives each source one nerve, in its region', () => {
    expect(nerves.map((n) => n.source)).toEqual(sources.map((s) => s.id));
    for (const n of nerves) expect(n.region).toBe(regionOf(sources.find((s) => s.id === n.source)!.kind));
  });

  it('runs every nerve inside the body', () => {
    for (const n of nerves) {
      const path = pathThrough(n.control);
      for (let i = 0; i < path.along.length; i++) expect(outside(at(path, i)), `source ${n.source}, sample ${i}`).toBeLessThan(0.02);
    }
  });

  it('roots every nerve at the cord, and ends an arm nerve at a hand and a leg nerve at a foot', () => {
    const cord = pathThrough(CORD);
    const hands = CAPSULES.filter((c) => c.part === 'hand');
    const feet = CAPSULES.filter((c) => c.part === 'foot');
    for (const n of nerves) {
      const root = n.control[0]!;
      const toCord = Math.min(...Array.from({ length: cord.along.length }, (_, i) => near(root, at(cord, i))));
      expect(toCord, `source ${n.source}`).toBeLessThan(0.15);
      const tip = n.control.at(-1)!;
      if (n.region === 'arms') expect(outside(tip, hands)).toBeLessThan(0.02);
      if (n.region === 'legs') expect(outside(tip, feet)).toBeLessThan(0.02);
      if (n.region === 'trunk') expect(tip[2]).toBeGreaterThan(0.3);
    }
  });

  it('alternates sides, the first on the right, and mirrors the first pair on each limb', () => {
    const arms = nerves.filter((n) => n.region === 'arms');
    expect(arms.map((n) => n.side)).toEqual([1, -1, 1, -1, 1]);
    expect(arms[1]!.control).toEqual(arms[0]!.control.map(([x, y, z]) => [-x, y, z]));
  });

  it('fans out sources that share a limb, so no two run on the same line', () => {
    const tips = nerves.map((n) => n.control.at(-1)!.join(','));
    const roots = new Set(nerves.filter((n) => n.region !== 'trunk').map((n) => n.control[0]!.join(',')));
    expect(new Set(tips).size).toBe(tips.length);
    expect(roots.size).toBe(2 * 2); // the arms share their two roots, the legs theirs
  });

  it('never moves an older source when a new one arrives, and places sources by id, not by the order given', () => {
    const more = nervesFor([...sources, { id: 20, kind: 'claude' }, { id: 21, kind: 'notes' }, { id: 22, kind: 'codex' }]);
    expect(more.slice(0, nerves.length)).toEqual(nerves);
    expect(nervesFor([...sources].reverse())).toEqual(nerves);
  });
});

describe('a path', () => {
  it('runs from 0 at its root to 1 at its tip, never back', () => {
    const path = pathThrough(nerves[0]!.control);
    expect(path.along[0]).toBe(0);
    expect(path.along.at(-1)).toBeCloseTo(1);
    for (let i = 1; i < path.along.length; i++) expect(path.along[i]!).toBeGreaterThanOrEqual(path.along[i - 1]!);
    expect(near(pointAlong(path, 0), nerves[0]!.control[0]!)).toBeLessThan(1e-6);
    expect(near(pointAlong(path, 1), nerves[0]!.control.at(-1)!)).toBeLessThan(1e-5);
  });

  it('is sampled by length, so halfway along is half its length, however the control points are spaced', () => {
    const path = pathThrough([
      [0, 0, 0],
      [1, 0, 0],
      [3, 0, 0],
    ]);
    expect(path.length).toBeCloseTo(3, 2);
    expect(pointAlong(path, 0.5)[0]).toBeCloseTo(1.5, 1);
    expect(pointAlong(path, -1)).toEqual([0, 0, 0]);
    expect(pointAlong(path, 2)[0]).toBeCloseTo(3);
  });
});
