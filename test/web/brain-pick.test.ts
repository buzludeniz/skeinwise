// Picking the point under the pointer (web/src/brain/pick.ts): the nearest within the radius, nearer the camera on a
// tie, never one behind the camera or turned away, mid-move where it is drawn, and quick at the 20,000-point cap.

import { describe, expect, it } from 'vitest';
import { MAX_POINTS } from '../../web/src/brain/input.ts';
import { nearestPoint, type PickView } from '../../web/src/brain/pick.ts';

// Column-major, as three.js keeps it. Flat: x and y map straight to the screen, and w is 1 everywhere.
const FLAT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Looking down -z: w is the distance in front of the camera, and x/w, y/w land on the screen.
const DEPTH = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0];

const view = (matrix: number[]): PickView => ({ matrix, width: 200, height: 100 });
const still = (xyz: number[]) => {
  const to = new Float32Array(xyz);
  return { from: to, to, t: 1 };
};

describe('picking a point', () => {
  it('finds the nearest point within the radius, in CSS pixels from the top left', () => {
    // (0, 0) is the middle of a 200 × 100 canvas; (0.5, 0.5) is at (150, 25).
    const at = still([0, 0, 0, 0.5, 0.5, 0]);
    expect(nearestPoint(view(FLAT), at, 2, 100, 50, 12)).toBe(0);
    expect(nearestPoint(view(FLAT), at, 2, 147, 28, 12)).toBe(1);
    expect(nearestPoint(view(FLAT), at, 2, 60, 80, 12)).toBe(-1);
  });

  it('prefers the point nearer the camera when two are about as near', () => {
    // Both land in the middle of the screen; the one at z -1 is nearer than the one at z -3, in either order.
    expect(nearestPoint(view(DEPTH), still([0, 0, -3, 0, 0, -1]), 2, 100, 50, 12)).toBe(1);
    expect(nearestPoint(view(DEPTH), still([0, 0, -1, 0, 0, -3]), 2, 100, 50, 12)).toBe(0);
  });

  it('never picks a point behind the camera', () => {
    expect(nearestPoint(view(DEPTH), still([0, 0, 2]), 1, 100, 50, 50)).toBe(-1);
  });

  it('skips the points it is told to', () => {
    const at = still([0, 0, 0, 0.02, 0, 0]);
    expect(nearestPoint(view(FLAT), at, 2, 100, 50, 12)).toBe(0);
    expect(nearestPoint(view(FLAT), at, 2, 100, 50, 12, (i) => i === 0)).toBe(1);
  });

  it('mid-move, looks where the point is drawn, between where it was and where it goes', () => {
    const at = { from: new Float32Array([-0.5, 0, 0]), to: new Float32Array([0.5, 0, 0]), t: 0.5 };
    expect(nearestPoint(view(FLAT), at, 1, 100, 50, 6)).toBe(0);
    expect(nearestPoint(view(FLAT), at, 1, 150, 50, 6)).toBe(-1);
  });

  it(`stays well inside a frame at the ${MAX_POINTS.toLocaleString('en')}-point cap`, () => {
    const n = MAX_POINTS;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = Math.sin(i * 12.9898) * 1.5;
    for (let i = 0; i < n; i++) pos[i * 3 + 2] = pos[i * 3 + 2]! - 5;
    const moving = { from: pos.map((v) => v * 0.5), to: pos, t: 0.4 };
    const lit = new Float32Array(n).fill(1);
    const times: number[] = [];
    for (let run = 0; run < 15; run++) {
      const start = performance.now();
      nearestPoint(view(DEPTH), moving, n, 80 + run, 40, 12, (i) => lit[i]! < 0.5);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    // The pointer picks at most once a frame; 60 frames a second leaves 16.7 ms for everything.
    expect(times[7]!).toBeLessThan(8);
  });
});
