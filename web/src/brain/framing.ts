// The brain layout's three framings (UX audit item 21, phase 2): the whole body, the head round the cortex, and the
// cord with its month rings. Each is a box in world units for the scene's camera to fit; pure, so the tests can check
// that a framing holds what it promises.

import { CAPSULES, type Capsule, type Path, type V3 } from './anatomy.ts';
import { HEAD_SCALE, toWorld } from './body.ts';
import { RING_RADIUS } from './bodyGeometry.ts';

export type Framing = 'body' | 'head' | 'cord';

export interface Box {
  min: V3;
  max: V3;
}

/** The box round some capsules, in world units. */
function around(capsules: readonly Capsule[]): Box {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const { a, b, r } of capsules) {
    for (const p of [a, b]) {
      const lo = toWorld([p[0] - r, p[1] - r, p[2] - r]);
      const hi = toWorld([p[0] + r, p[1] + r, p[2] + r]);
      for (let d = 0; d < 3; d++) {
        min[d] = Math.min(min[d]!, lo[d]!);
        max[d] = Math.max(max[d]!, hi[d]!);
      }
    }
  }
  return { min, max };
}

/**
 * The box a framing fits: the body's capsules, the head's, or the cord (a path in world units, as BodyLayout carries
 * it) widened by its rings.
 */
export function framingBox(framing: Framing, cord: Path): Box {
  if (framing === 'body') return around(CAPSULES);
  if (framing === 'head') return around(CAPSULES.filter((c) => c.part === 'head'));
  const pad = RING_RADIUS * HEAD_SCALE;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < cord.points.length; i += 3) {
    for (let d = 0; d < 3; d++) {
      min[d] = Math.min(min[d]!, cord.points[i + d]! - pad);
      max[d] = Math.max(max[d]!, cord.points[i + d]! + pad);
    }
  }
  return { min, max };
}

/**
 * The band of the canvas the view's controls leave clear, from the bands they cover along its top and bottom (CSS
 * pixels). `clear` is its share of the height, never under a third; `shift` is how far its middle sits below the canvas's
 * middle (above it when negative), in half-heights, held so a brain fitted to the band stays on the canvas. Bands that cover
 * the whole canvas (a canvas not yet measured) leave it all clear.
 */
export function clearBand(top: number, bottom: number, height: number): { clear: number; shift: number } {
  if (!(height > 0) || top + bottom >= height) return { clear: 1, shift: 0 };
  const clear = Math.max(1 / 3, 1 - (top + bottom) / height);
  const shift = (top - bottom) / height;
  return { clear, shift: Math.max(clear - 1, Math.min(1 - clear, shift)) };
}
