// The standing body the nervous-system brain hangs on (UX audit item 21). The proportions are our own table in head
// units, typed in by hand, and every curve is our own Catmull-Rom spline through hand-set control points: nothing is
// traced or sampled from a picture. Abstract on purpose: capsules for the outline, lines for the cord and nerves.
//
// Units: one head (chin to crown) is 1. The origin is the middle of the head, y is up, +x is to the viewer's right
// and +z is the front. The figure stands seven and a half heads tall, so the floor is at y = -7.

export type V3 = [number, number, number];

/** A capsule: the points within r of the segment from a to b. */
export interface Capsule {
  part: string;
  a: V3;
  b: V3;
  r: number;
}

/** The body's landmarks, in head units. */
export const BODY = {
  crown: 0.5,
  chin: -0.5,
  floor: -7,
  shoulderX: 1,
  hipX: 0.45,
} as const;

/**
 * The cord, the body's time axis: from its bottom (the oldest month) to its top (this month), behind the trunk. Its
 * top meets the base of phase 1's brain stem (layout.ts), which sits at (0, -0.72, -0.5) in the world.
 */
export const CORD: V3[] = [
  [0, -3.5, -0.3],
  [0, -2.4, -0.22],
  [0, -1.2, -0.3],
  [0, -0.27, -0.17],
];

/** One side's capsules, for x ≥ 0; the left side mirrors them. */
const SIDE: Capsule[] = [
  { part: 'shoulder', a: [0, -1.25, -0.05], b: [0.95, -1.25, -0.05], r: 0.2 },
  { part: 'upper arm', a: [1, -1.25, -0.05], b: [1.25, -2.6, -0.1], r: 0.17 },
  { part: 'forearm', a: [1.25, -2.6, -0.1], b: [1.4, -3.55, 0.05], r: 0.14 },
  { part: 'hand', a: [1.4, -3.55, 0.05], b: [1.45, -4.3, 0.12], r: 0.11 },
  { part: 'thigh', a: [0.45, -3.5, 0], b: [0.5, -5.25, 0.08], r: 0.27 },
  { part: 'shin', a: [0.5, -5.25, 0.08], b: [0.48, -6.8, -0.05], r: 0.2 },
  { part: 'foot', a: [0.48, -6.85, -0.05], b: [0.55, -6.92, 0.45], r: 0.08 },
];

const mirror = (v: V3): V3 => [-v[0], v[1], v[2]];

/** The body as capsules: head, neck and trunk on the midline, then each side's limbs. */
export const CAPSULES: Capsule[] = [
  { part: 'head', a: [0, -0.1, 0], b: [0, 0.1, 0], r: 0.4 },
  { part: 'neck', a: [0, -0.45, -0.1], b: [0, -0.95, -0.1], r: 0.22 },
  { part: 'chest', a: [0, -1.3, 0], b: [0, -2.2, 0], r: 0.62 },
  { part: 'abdomen', a: [0, -2.2, 0], b: [0, -3.4, 0], r: 0.55 },
  ...SIDE,
  ...SIDE.map((c) => ({ ...c, a: mirror(c.a), b: mirror(c.b) })),
];

/** Where a source's nerve runs: arms for chat assistants, legs for coding agents, the trunk for everything else. */
export type Region = 'arms' | 'legs' | 'trunk';

const ARM_KINDS = new Set(['chatgpt', 'claude', 'gemini']);
const LEG_KINDS = new Set(['claude-code', 'codex']);

export function regionOf(kind: string): Region {
  return ARM_KINDS.has(kind) ? 'arms' : LEG_KINDS.has(kind) ? 'legs' : 'trunk';
}

// Each limb's nerve, for x ≥ 0, from its root on the cord to the fingertips or the toes.
const ARM: V3[] = [
  [0.08, -1, -0.25],
  [0.55, -1.2, -0.12],
  [1, -1.3, -0.05],
  [1.25, -2.6, -0.1],
  [1.4, -3.55, 0.05],
  [1.45, -4.3, 0.12],
];
const LEG: V3[] = [
  [0.06, -3.2, -0.25],
  [0.3, -3.45, -0.1],
  [0.45, -3.6, 0],
  [0.5, -5.25, 0.08],
  [0.48, -6.8, -0.05],
  [0.55, -6.92, 0.42],
];
/** A trunk nerve wraps from the cord round the side to the front, at height y. */
const trunkNerve = (y: number): V3[] => [
  [0.06, y, -0.25],
  [0.5, y - 0.08, -0.15],
  [0.48, y - 0.1, 0.05],
  [0.3, y - 0.2, 0.42],
  [0.08, y - 0.25, 0.5],
];
/** The highest trunk nerve, the step down to the next pair, and the lowest. */
const TRUNK_TOP = -1.7;
const TRUNK_STEP = 0.28;
const TRUNK_BOTTOM = -3.05;
/** How far apart, at the tip, sources that share a limb fan out, and the most they may. */
const FAN_STEP = 0.05;
const FAN_MAX = 0.09;

export interface Nerve {
  source: number;
  region: Region;
  /** +1 the viewer's right, -1 the left. */
  side: 1 | -1;
  /** Its control points, root first. */
  control: V3[];
}

/**
 * One nerve per source. Sources take their region's places in id order, so a new source (a higher id) never moves an
 * older one's nerve: the first arm source on the right arm, the next on the left, and so on; sources that share a
 * limb fan out towards its tip. Trunk nerves alternate sides and step down from the chest.
 */
export function nervesFor(sources: readonly { id: number; kind: string }[]): Nerve[] {
  const taken: Record<Region, number> = { arms: 0, legs: 0, trunk: 0 };
  return [...sources]
    .sort((a, b) => a.id - b.id)
    .map((s) => {
      const region = regionOf(s.kind);
      const slot = taken[region]++;
      const side: 1 | -1 = slot % 2 === 0 ? 1 : -1;
      const shared = slot >> 1; // how many sources already run in this limb, or at this trunk level
      let base: V3[];
      let fan = 0;
      if (region === 'trunk') {
        base = trunkNerve(Math.max(TRUNK_BOTTOM, TRUNK_TOP - TRUNK_STEP * shared));
      } else {
        base = region === 'arms' ? ARM : LEG;
        // 0, then +1, -1, +2, -2, … steps towards the front and back of the limb.
        fan = shared === 0 ? 0 : Math.min(FAN_MAX, FAN_STEP * ((shared + 1) >> 1)) * (shared % 2 === 1 ? 1 : -1);
      }
      const n = base.length - 1;
      const control = base.map((p, i): V3 => [side * p[0], p[1], p[2] + (fan * i) / n]);
      return { source: s.id, region, side, control };
    });
}

/** A spline sampled by arc length, so a fraction of the way along it is that fraction of its length. */
export interface Path {
  /** xyz of each sample, root first. */
  points: Float32Array;
  /** How far along each sample is, 0 at the root and 1 at the tip. */
  along: Float32Array;
  /** Its length, in head units. */
  length: number;
}

/** A uniform Catmull-Rom spline through the control points, its ends held by repeating them. */
function catmullRom(c: readonly V3[], t: number): V3 {
  const segs = c.length - 1;
  const s = Math.min(segs - 1, Math.floor(t * segs));
  const f = t * segs - s;
  const p0 = c[Math.max(0, s - 1)]!;
  const p1 = c[s]!;
  const p2 = c[s + 1]!;
  const p3 = c[Math.min(segs, s + 2)]!;
  const f2 = f * f;
  const f3 = f2 * f;
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * (2 * p1[k]! + (-p0[k]! + p2[k]!) * f + (2 * p0[k]! - 5 * p1[k]! + 4 * p2[k]! - p3[k]!) * f2 + (-p0[k]! + 3 * p1[k]! - 3 * p2[k]! + p3[k]!) * f3);
  }
  return out;
}

export function pathThrough(control: readonly V3[], samples = 64): Path {
  const points = new Float32Array(samples * 3);
  const along = new Float32Array(samples);
  let length = 0;
  for (let i = 0; i < samples; i++) {
    const p = catmullRom(control, i / (samples - 1));
    points.set(p, i * 3);
    if (i > 0) length += Math.hypot(p[0] - points[i * 3 - 3]!, p[1] - points[i * 3 - 2]!, p[2] - points[i * 3 - 1]!);
    along[i] = length;
  }
  for (let i = 0; i < samples; i++) along[i] = length ? along[i]! / length : i / (samples - 1);
  return { points, along, length };
}

/** The point a fraction u of the way along a path (clamped to its ends). */
export function pointAlong(path: Path, u: number): V3 {
  const { points, along } = path;
  const n = along.length;
  const v = Math.min(1, Math.max(0, u));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (along[mid]! <= v) lo = mid;
    else hi = mid;
  }
  const span = along[hi]! - along[lo]! || 1;
  const f = Math.min(1, Math.max(0, (v - along[lo]!) / span));
  return [0, 1, 2].map((k) => points[lo * 3 + k]! + (points[hi * 3 + k]! - points[lo * 3 + k]!) * f) as V3;
}

/** How far a point lies outside the body: 0 inside any capsule, else the distance to the nearest one's surface. */
export function outside(p: V3, capsules: readonly Capsule[] = CAPSULES): number {
  let best = Infinity;
  for (const { a, b, r } of capsules) {
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = len2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2)) : 0;
    const d = Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t) - r;
    if (d < best) best = d;
  }
  return Math.max(0, best);
}
