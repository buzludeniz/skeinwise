// The body's drawn parts (web/src/brain/bodyGeometry.ts): an outline on the body's surface that keeps phase 1's brain
// but not its old stem, a ring round the cord at every month's edge, and nerves drawn as far as their newest entry,
// or faint and whole while their source has nothing yet.

import { describe, expect, it } from 'vitest';
import { BODY, CAPSULES, CORD, type Capsule, pointAlong, type V3 } from '../../web/src/brain/anatomy.ts';
import { bodyLayout, HEAD_SCALE, toHead, toWorld } from '../../web/src/brain/body.ts';
import { bodyContours, bodyOutline, cordRings, FOLD_TONE, nerveLines, OUTLINE_TONE, RING_RADIUS, WAITING_TONE } from '../../web/src/brain/bodyGeometry.ts';
import { brainOutline, type LayoutPoint } from '../../web/src/layout.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const DAY = 86_400_000;
const sources = [
  { id: 1, kind: 'chatgpt' },
  { id: 2, kind: 'codex' },
  { id: 3, kind: 'gemini' },
];
const pt = (id: number, strand: number, daysAgo: number): LayoutPoint => ({ id, kind: 0, time: NOW - daysAgo * DAY, cluster: 0, strand, thread: 0, group: 0 });
// Chats this month and last spring, coding that stopped in the summer, and nothing yet from the third source.
const layout = bodyLayout([pt(1, 0, 2), pt(2, 0, 230), pt(3, 1, 150), pt(4, 1, 200)], sources, NOW);
const triple = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
const near = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** How far a point is from a capsule's surface: negative inside. */
function signed(p: V3, c: (typeof CAPSULES)[number]): number {
  const ab: V3 = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = len2 ? Math.min(1, Math.max(0, ((p[0] - c.a[0]) * ab[0] + (p[1] - c.a[1]) * ab[1] + (p[2] - c.a[2]) * ab[2]) / len2)) : 0;
  return Math.hypot(p[0] - c.a[0] - ab[0] * t, p[1] - c.a[1] - ab[1] * t, p[2] - c.a[2] - ab[2] * t) - c.r;
}

describe('the outline', () => {
  const outline = bodyOutline();
  const cut = toWorld(CORD.at(-1)!)[1];
  const brain = brainOutline();
  const kept = Array.from({ length: brain.shade.length }, (_, i) => i).filter((i) => brain.positions[i * 3 + 1]! >= cut);

  it("keeps phase 1's brain, without its old stem below the cord's top", () => {
    for (const [k, i] of kept.entries()) expect(triple(outline.positions, k)).toEqual(triple(brain.positions, i));
    expect(kept.length).toBeLessThan(brain.shade.length);
  });

  it("puts every other point on the body's surface, and none inside another part", () => {
    const body = outline.shade.length - kept.length;
    expect(body).toBeGreaterThan(1500);
    for (let k = kept.length; k < outline.shade.length; k++) {
      const p = toHead(triple(outline.positions, k));
      const d = CAPSULES.map((c) => signed(p, c));
      expect(Math.min(...d.map(Math.abs))).toBeLessThan(1e-4);
      expect(Math.min(...d)).toBeGreaterThan(-1e-4);
    }
  });

  it('draws in faint tones only, the same way for the same seed', () => {
    expect(Math.max(...outline.shade)).toBeLessThanOrEqual(1);
    expect(Math.min(...outline.shade)).toBeGreaterThan(0);
    expect(bodyOutline()).toEqual(outline);
    expect(bodyOutline(8).positions).not.toEqual(outline.positions);
  });
});

describe('the cord rings', () => {
  const rings = cordRings(layout);
  const per = 24;
  const count = rings.disc.length / per;

  it("rings every month's lower edge, and the top of this month", () => {
    expect(count).toBe(layout.scale.discs.length + 1);
    for (let k = 0; k < count; k++) expect(rings.disc[k * per]).toBe(Math.min(k, layout.scale.discs.length - 1));
  });

  it('centres each ring on the cord, at its edge on the month scale, oldest lowest', () => {
    let lastY = -Infinity;
    for (let k = 0; k < count; k++) {
      const pts = Array.from({ length: per }, (_, s) => triple(rings.positions, (k * per + s) * 2));
      const c = pts.reduce<V3>((m, p) => [m[0] + p[0] / per, m[1] + p[1] / per, m[2] + p[2] / per], [0, 0, 0]);
      const y = k < layout.scale.discs.length ? layout.scale.discs[k]!.y0 : layout.scale.height;
      expect(near(c, pointAlong(layout.cord, y / layout.scale.height))).toBeLessThan(1e-3);
      for (const p of pts) expect(near(p, c)).toBeCloseTo(RING_RADIUS * HEAD_SCALE, 3);
      expect(c[1]).toBeGreaterThan(lastY);
      lastY = c[1];
    }
  });

  it("draws a fold's ring fainter than a month's", () => {
    const folds = layout.scale.discs.flatMap((d, i) => (d.fold ? [i] : []));
    expect(folds.length).toBeGreaterThan(0);
    for (let k = 0; k < layout.scale.discs.length; k++) expect(rings.tone[k * per * 2]).toBe(layout.scale.discs[k]!.fold ? Math.fround(FOLD_TONE) : 1);
  });
});

describe('the nerves', () => {
  const lines = nerveLines(layout);
  const ends = layout.nerves.map((_, k) => {
    const last = lines.nerve.lastIndexOf(k);
    return { first: triple(lines.positions, lines.nerve.indexOf(k) * 2), last: triple(lines.positions, last * 2 + 1), tone: lines.tone[last * 2]! };
  });

  it('starts every nerve at its root on the cord', () => {
    layout.nerves.forEach((nv, k) => expect(near(ends[k]!.first, pointAlong(nv.path, 0))).toBeLessThan(1e-5));
  });

  it('draws a source as far as its newest entry: to the hand when live, short when quiet', () => {
    const [chats, coding] = layout.nerves;
    expect(near(ends[0]!.last, pointAlong(chats!.path, chats!.reach))).toBeLessThan(1e-4);
    expect(near(ends[1]!.last, pointAlong(coding!.path, coding!.reach))).toBeLessThan(1e-4);
    expect(chats!.reach).toBeGreaterThan(0.9);
    expect(coding!.reach).toBeLessThan(chats!.reach - 0.2);
    expect([ends[0]!.tone, ends[1]!.tone]).toEqual([1, 1]);
  });

  it('draws a source with nothing yet whole and faint, waiting', () => {
    const waiting = layout.nerves[2]!;
    expect(waiting.count).toBe(0);
    expect(near(ends[2]!.last, pointAlong(waiting.path, 1))).toBeLessThan(1e-4);
    expect(ends[2]!.tone).toBe(Math.fround(WAITING_TONE));
  });

  it('joins its segments end to end, with no gaps', () => {
    for (let j = 1; j < lines.nerve.length; j++) {
      if (lines.nerve[j] !== lines.nerve[j - 1]) continue;
      expect(near(triple(lines.positions, j * 2), triple(lines.positions, (j - 1) * 2 + 1))).toBe(0);
    }
  });
});

describe("the outline's lines", () => {
  /** How far a point lies from a capsule's surface: below 0 inside it. */
  const fromSurface = (p: V3, { a, b, r }: Capsule) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0]! + (p[1] - a[1]) * ab[1]! + (p[2] - a[2]) * ab[2]!) / (ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2 || 1)));
    return Math.hypot(p[0] - a[0] - ab[0]! * t, p[1] - a[1] - ab[1]! * t, p[2] - a[2] - ab[2]! * t) - r;
  };
  const { positions, tone } = bodyContours();
  const ends = Array.from({ length: positions.length / 3 }, (_, i) => toHead([positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]));

  it("lie on the body's surface below the head, inside no other capsule, in the outline's tone", () => {
    expect(ends.length).toBeGreaterThan(500);
    expect(ends.length % 2).toBe(0);
    for (const p of ends) {
      const gaps = CAPSULES.map((c) => fromSurface(p, c));
      expect(Math.min(...gaps.map(Math.abs))).toBeLessThan(1e-4);
      expect(Math.min(...gaps)).toBeGreaterThan(-1e-4);
    }
    // The neck's lines meet the head's round underside, above the chin's level but below the head's middle.
    const head = CAPSULES.find((c) => c.part === 'head')!;
    expect(Math.max(...ends.map((p) => p[1]))).toBeLessThan(Math.min(head.a[1], head.b[1]));
    expect([...tone].every((t) => t === Math.fround(OUTLINE_TONE))).toBe(true);
  });

  it('outline both sides alike, from the neck down to the floor', () => {
    const left = ends.filter((p) => p[0] < -1e-3).length;
    const right = ends.filter((p) => p[0] > 1e-3).length;
    expect(left).toBe(right);
    expect(Math.min(...ends.map((p) => p[1]))).toBeLessThan(BODY.floor + 0.3);
  });
});
