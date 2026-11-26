// Finding the point under the pointer: project every point to the screen and keep the nearest within a radius. Pure
// (no DOM, no WebGL), so the tests can check it, and it allocates nothing per point, so it can run every frame while
// the pointer moves over 20,000 points.

/** What the camera shows: its projection times view matrix (column-major, as three.js keeps it) and the canvas size. */
export interface PickView {
  matrix: ArrayLike<number>;
  width: number;
  height: number;
}

/**
 * Where points are drawn: halfway through a move, each one sits between `from` and `to` at `t` (0 to 1). With `t` at
 * 1, only `to` counts.
 */
export interface PickPositions {
  from: Float32Array;
  to: Float32Array;
  t: number;
}

/**
 * The point nearest (x, y) in CSS pixels from the canvas's top left, within `radius` pixels; -1 when none. When two
 * points are about as near, the one nearer the camera wins. Points behind the camera never count, and nor do the ones
 * `skip` turns away.
 */
export function nearestPoint(view: PickView, at: PickPositions, count: number, x: number, y: number, radius: number, skip?: (i: number) => boolean): number {
  const m = view.matrix;
  const { from, to, t } = at;
  const moving = t < 1;
  let best = -1;
  let bestD = radius * radius;
  let bestZ = Infinity;
  for (let i = 0; i < count; i++) {
    if (skip?.(i)) continue;
    const k = i * 3;
    let px = to[k]!;
    let py = to[k + 1]!;
    let pz = to[k + 2]!;
    if (moving) {
      px = from[k]! + (px - from[k]!) * t;
      py = from[k + 1]! + (py - from[k + 1]!) * t;
      pz = from[k + 2]! + (pz - from[k + 2]!) * t;
    }
    const w = m[3]! * px + m[7]! * py + m[11]! * pz + m[15]!;
    if (w <= 0) continue;
    const sx = (((m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) / w + 1) / 2) * view.width;
    const sy = ((1 - (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) / w) / 2) * view.height;
    const d = (sx - x) ** 2 + (sy - y) ** 2;
    if (d < bestD - 4 || (d < bestD + 4 && w < bestZ)) {
      best = i;
      bestD = Math.min(bestD, d);
      bestZ = w;
    }
  }
  return best;
}
