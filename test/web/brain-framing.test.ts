// The brain layout's framings (web/src/brain/framing.ts): the body framing holds the whole outline, the head framing
// the cortex at the cap and nothing below the chin, and the cord framing every month ring.

import { describe, expect, it } from 'vitest';
import { BODY, type V3 } from '../../web/src/brain/anatomy.ts';
import { bodyLayout, toWorld } from '../../web/src/brain/body.ts';
import { bodyOutline, cordRings } from '../../web/src/brain/bodyGeometry.ts';
import { type Box, clearBand, framingBox } from '../../web/src/brain/framing.ts';
import type { LayoutPoint } from '../../web/src/layout.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const DAY = 86_400_000;
const sources = [
  { id: 1, kind: 'chatgpt' },
  { id: 2, kind: 'codex' },
];
const pts: LayoutPoint[] = [
  ...Array.from({ length: 20_000 }, (_, i): LayoutPoint => ({ id: i + 1, kind: 1, time: NOW - (i % 400) * DAY, cluster: i % 37, strand: 0, thread: 0, group: 0 })),
  ...Array.from({ length: 400 }, (_, i): LayoutPoint => ({ id: 30_000 + i, kind: 0, time: NOW - i * 3 * DAY, cluster: 0, strand: i % 2, thread: 0, group: 0 })),
];
const layout = bodyLayout(pts, sources, NOW);
const EPS = 1e-4;
const holds = (box: Box, p: ArrayLike<number>, i: number) => [0, 1, 2].every((d) => p[i + d]! >= box.min[d]! - EPS && p[i + d]! <= box.max[d]! + EPS);
const size = (box: Box): V3 => [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];

describe('the framings', () => {
  it('frames the whole body, crown to floor, outline and all', () => {
    const box = framingBox('body', layout.cord);
    const outline = bodyOutline();
    for (let i = 0; i < outline.positions.length; i += 3) expect(holds(box, outline.positions, i)).toBe(true);
    expect(box.max[1]).toBeCloseTo(toWorld([0, BODY.crown, 0])[1], 5);
    expect(box.min[1]).toBeLessThanOrEqual(toWorld([0, BODY.floor, 0])[1]);
  });

  it('frames the head round a full cortex, and nothing below the chin', () => {
    const box = framingBox('head', layout.cord);
    pts.forEach((p, i) => {
      if (p.kind === 1) expect(holds(box, layout.positions, i * 3)).toBe(true);
    });
    expect(box.min[1]).toBeCloseTo(toWorld([0, BODY.chin, 0])[1], 5);
  });

  it('frames the cord with every month ring, tall and narrow', () => {
    const box = framingBox('cord', layout.cord);
    const rings = cordRings(layout);
    for (let i = 0; i < rings.positions.length; i += 3) expect(holds(box, rings.positions, i)).toBe(true);
    const [w, h] = size(box);
    expect(h).toBeGreaterThan(4 * w);
    expect(size(framingBox('body', layout.cord))[1]).toBeGreaterThan(h);
  });
});

describe('the band the controls leave clear', () => {
  it('is the whole canvas when no control covers it', () => {
    expect(clearBand(0, 0, 800)).toEqual({ clear: 1, shift: 0 });
  });

  it('spans exactly the rows between the top and bottom bars, as on a phone with the bars along the foot', () => {
    const [top, bottom, height] = [52, 160, 760];
    const { clear, shift } = clearBand(top, bottom, height);
    // In half-heights from the canvas's middle, downward positive: the band's top edge and its bottom edge.
    expect(shift - clear).toBeCloseTo((2 * top) / height - 1, 9);
    expect(shift + clear).toBeCloseTo(1 - (2 * bottom) / height, 9);
    expect(shift).toBeLessThan(0);
  });

  it('keeps at least a third of the height, and a brain fitted to it on the canvas', () => {
    for (const [top, bottom] of [
      [0, 700],
      [700, 0],
      [300, 400],
    ] as const) {
      const { clear, shift } = clearBand(top, bottom, 760);
      expect(clear).toBeCloseTo(1 / 3, 9);
      expect(Math.abs(shift) + clear).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('leaves a canvas clear when the bands cover all of it, as before the first measure', () => {
    expect(clearBand(40, 40, 1)).toEqual({ clear: 1, shift: 0 });
    expect(clearBand(10, 10, 0)).toEqual({ clear: 1, shift: 0 });
  });
});
