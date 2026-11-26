// Where every point sits, in three layouts: the brain (the standing body of brain/body.ts: notes in the head's two
// lobes, laid out here by brainLayout, and every other entry on its source's nerve), activity (one ring per year, seen
// from above), and flat clusters. Pure and seeded: the same record always gives the same picture.
// Units: the brain is about 2.4 wide; y is up, +z is the front.

// body.ts imports brainLayout back from here. The cycle is safe: neither module uses the other's exports while loading.
import { bodyLayout } from './brain/body.ts';

export interface LayoutPoint {
  id: number;
  /** 0 message, 1 note, 2 file. */
  kind: 0 | 1 | 2;
  /** Milliseconds since 1970. */
  time: number;
  /** Which lobe cluster a note belongs to (its project, else its folder). */
  cluster: number;
  /** Which strand of the braid an original winds on (its source). */
  strand: number;
  /** The thread it belongs to, 0 for none, as the server sends it (queries.ts). The body's twigs branch on it. */
  thread: number;
  /** The colour group under the current grouping; the clusters layout uses it. */
  group: number;
}

export type Layout = 'brain' | 'rings' | 'clusters';
type V3 = [number, number, number];

/** A small fast seeded generator (mulberry32), 0 ≤ n < 1. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 0 ≤ n < 1 for a number and a salt. */
export function hash01(n: number, salt = 0): number {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Seeded 3D gradient noise, roughly -1 to 1. */
export function noise3(seed: number): (x: number, y: number, z: number) => number {
  const r = rng(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  const G = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
    [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  ] as const;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number, z: number) => {
    const g = G[h % 12]!;
    return g[0] * x + g[1] * y + g[2] * z;
  };
  return (x, y, z) => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = perm[X]! + Y;
    const AA = perm[A]! + Z;
    const AB = perm[A + 1]! + Z;
    const B = perm[X + 1]! + Y;
    const BA = perm[B]! + Z;
    const BB = perm[B + 1]! + Z;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    return lerp(
      lerp(
        lerp(grad(perm[AA]!, x, y, z), grad(perm[BA]!, x - 1, y, z), u),
        lerp(grad(perm[AB]!, x, y - 1, z), grad(perm[BB]!, x - 1, y - 1, z), u),
        v,
      ),
      lerp(
        lerp(grad(perm[AA + 1]!, x, y, z - 1), grad(perm[BA + 1]!, x - 1, y, z - 1), u),
        lerp(grad(perm[AB + 1]!, x, y - 1, z - 1), grad(perm[BB + 1]!, x - 1, y - 1, z - 1), u),
        v,
      ),
      w,
    );
  };
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// The brain's parts.
const LOBE = { cx: 0.56, cy: 0.52, cz: 0.04, rx: 0.6, ry: 0.74, rz: 1.12 };
const TEMPORAL = { cx: 0.7, cy: 0.06, cz: 0.24, rx: 0.36, ry: 0.32, rz: 0.6 };
const CEREBELLUM = { cx: 0.3, cy: -0.08, cz: -0.86, rx: 0.42, ry: 0.32, rz: 0.4 };
/** Half the gap between the hemispheres. */
const FISSURE = 0.045;
const STEM_BOTTOM = -2.6;
const STEM_SPLIT = 0.7;

/** A point on (rf = 1) or inside (rf < 1) one hemisphere, along a direction from its centre. side: +1 right, -1 left. */
export function lobePoint(side: 1 | -1, dir: V3, rf: number): V3 {
  const d = norm(dir);
  let x = d[0] * LOBE.rx * rf;
  let y = d[1] * LOBE.ry * rf;
  const z = d[2] * LOBE.rz * rf;
  if (y < 0) y *= 0.72; // a flatter underside
  y *= 1 - 0.12 * Math.max(0, z / LOBE.rz); // the forehead slopes down
  y += 0.06 * Math.max(0, -z / LOBE.rz) * Math.max(0, d[1]); // a fuller crown at the back
  x = side * LOBE.cx + side * x;
  // Flatten the inner face, leaving the gap between the hemispheres.
  if (side * x < FISSURE) x = side * (FISSURE + (FISSURE - side * x) * 0.06);
  return [x, LOBE.cy + y, LOBE.cz + z];
}

function ellipsoidPoint(c: typeof TEMPORAL, side: 1 | -1, d: V3, rf: number): V3 {
  return [side * c.cx + d[0] * c.rx * rf, c.cy + d[1] * c.ry * rf, c.cz + d[2] * c.rz * rf];
}

/** The centre line of the stem at u (0 its bottom, 1 its top, where it meets the brain), and its radius. */
export function stemCentre(u: number): { p: V3; r: number } {
  if (u < STEM_SPLIT) {
    const t = u / STEM_SPLIT;
    return {
      p: [0, STEM_BOTTOM + t * (-0.72 - STEM_BOTTOM), -0.56 + 0.06 * t + 0.08 * Math.sin(t * Math.PI * 1.6)],
      r: 0.08 + 0.025 * t,
    };
  }
  const t = (u - STEM_SPLIT) / (1 - STEM_SPLIT);
  return { p: [0, -0.72 + t * 0.86, -0.5 + 0.2 * t], r: 0.105 + 0.085 * t };
}

/** Directions on the outer, upper part of a hemisphere, spread evenly, for note clusters. */
function anchorDirections(): V3[] {
  const n = 160;
  const all: V3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const a = i * 2.399963229728653;
    const d: V3 = [Math.cos(a) * r, y, Math.sin(a) * r];
    if (d[1] > -0.2 && d[0] > -0.1) all.push(d);
  }
  // Farthest-point order from the top of the outer side, so the first clusters spread over the whole lobe.
  const out: V3[] = [];
  let last: V3 = norm([0.55, 0.8, 0.15]);
  const left = [...all];
  const dist = left.map(() => Infinity);
  while (left.length) {
    let best = 0;
    for (let i = 0; i < left.length; i++) {
      const d = left[i]!;
      const dd = (d[0] - last[0]) ** 2 + (d[1] - last[1]) ** 2 + (d[2] - last[2]) ** 2;
      dist[i] = Math.min(dist[i]!, dd);
      if (dist[i]! > dist[best]!) best = i;
    }
    last = left[best]!;
    out.push(last);
    left.splice(best, 1);
    dist.splice(best, 1);
  }
  return out;
}

let anchors: V3[] | null = null;

function tangentBasis(a: V3): [V3, V3] {
  const up: V3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t1 = norm([a[1] * up[2] - a[2] * up[1], a[2] * up[0] - a[0] * up[2], a[0] * up[1] - a[1] * up[0]]);
  const t2: V3 = [a[1] * t1[2] - a[2] * t1[1], a[2] * t1[0] - a[0] * t1[2], a[0] * t1[1] - a[1] * t1[0]];
  return [t1, t2];
}

/** Orders originals by time (then id) and notes by cluster, deterministically. */
function byTime(points: readonly LayoutPoint[], idx: number[]): number[] {
  return idx.sort((a, b) => points[a]!.time - points[b]!.time || points[a]!.id - points[b]!.id);
}

/** The brain layout: xyz per point. */
export function brainLayout(points: readonly LayoutPoint[]): Float32Array {
  const out = new Float32Array(points.length * 3);
  const originals: number[] = [];
  const clusters = new Map<number, number[]>();
  points.forEach((p, i) => {
    if (p.kind === 1) {
      const list = clusters.get(p.cluster) ?? [];
      list.push(i);
      clusters.set(p.cluster, list);
    } else originals.push(i);
  });

  // Originals: a braid of three strands, oldest at the bottom of the stem.
  byTime(points, originals);
  const n = originals.length;
  const turns = 10 + 4 * Math.log10(Math.max(10, n));
  originals.forEach((i, rank) => {
    const p = points[i]!;
    const u = n === 1 ? 0.5 : rank / (n - 1);
    const { p: c, r } = stemCentre(u);
    const strand = p.strand % 3;
    const a = u * turns * Math.PI * 2 + (strand * Math.PI * 2) / 3 + (hash01(p.id, 1) - 0.5) * 0.35;
    const rr = r * (0.78 + 0.4 * hash01(p.id, 2)) * (n > 4000 ? 1 + 0.5 * hash01(p.id, 7) : 1);
    out[i * 3] = c[0] + Math.cos(a) * rr;
    out[i * 3 + 1] = c[1] + (hash01(p.id, 3) - 0.5) * 0.02;
    out[i * 3 + 2] = c[2] + Math.sin(a) * rr;
  });

  // Notes: clusters on the lobes, biggest first, alternating right and left.
  anchors ??= anchorDirections();
  const order = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  order.forEach(([, members], k) => {
    const side: 1 | -1 = k % 2 === 0 ? 1 : -1;
    const slot = Math.floor(k / 2);
    const base = anchors![slot % anchors!.length]!;
    // Past the last slot, nudge the anchor so reused slots don't sit exactly on top of each other.
    const lap = Math.floor(slot / anchors!.length);
    const anchor = norm([base[0] * side, base[1] - lap * 0.07, base[2] + lap * 0.09]);
    const [t1, t2] = tangentBasis(anchor);
    const s = members.length;
    const spread = Math.min(0.8, 0.12 + 0.04 * Math.sqrt(s));
    const depth = 0.1 + 0.32 * Math.min(1, s / 1500);
    byTime(points, members).forEach((i, j) => {
      const p = points[i]!;
      const rad = spread * Math.sqrt((j + 0.5) / s);
      const phi = j * 2.399963229728653 + hash01(p.id, 4) * 0.6;
      const dir = norm([
        anchor[0] + (t1[0] * Math.cos(phi) + t2[0] * Math.sin(phi)) * rad,
        anchor[1] + (t1[1] * Math.cos(phi) + t2[1] * Math.sin(phi)) * rad,
        anchor[2] + (t1[2] * Math.cos(phi) + t2[2] * Math.sin(phi)) * rad,
      ]);
      const v = lobePoint(side, [dir[0] * side, dir[1], dir[2]], 0.97 - depth * hash01(p.id, 5));
      out[i * 3] = v[0];
      out[i * 3 + 1] = v[1];
      out[i * 3 + 2] = v[2];
    });
  });
  return out;
}

/** The activity layout, seen from above (the y axis): time runs outward, one ring per year, months as slices. */
export function ringsLayout(points: readonly LayoutPoint[]): Float32Array {
  const out = new Float32Array(points.length * 3);
  if (!points.length) return out;
  let first = Infinity;
  let last = -Infinity;
  for (const p of points) {
    first = Math.min(first, p.time);
    last = Math.max(last, p.time);
  }
  const y0 = new Date(first).getUTCFullYear();
  const years = new Date(last).getUTCFullYear() - y0 + 1;
  const inner = 0.35;
  const width = 1.9 / years;
  points.forEach((p, i) => {
    const d = new Date(p.time);
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const frac = (p.time - start) / (Date.UTC(d.getUTCFullYear() + 1, 0, 1) - start);
    const r = inner + (d.getUTCFullYear() - y0 + 0.12 + 0.76 * hash01(p.id, 6)) * width;
    const a = frac * Math.PI * 2 - Math.PI / 2;
    out[i * 3] = Math.cos(a) * r;
    out[i * 3 + 1] = (p.kind === 1 ? 0.05 : 0) + (hash01(p.id, 3) - 0.5) * 0.04;
    out[i * 3 + 2] = Math.sin(a) * r;
  });
  return out;
}

/** The ring radii for each year, for drawing guides: [year, inner radius, outer radius]. */
export function ringGuides(points: readonly LayoutPoint[]): [number, number, number][] {
  if (!points.length) return [];
  let first = Infinity;
  let last = -Infinity;
  for (const p of points) {
    first = Math.min(first, p.time);
    last = Math.max(last, p.time);
  }
  const y0 = new Date(first).getUTCFullYear();
  const years = new Date(last).getUTCFullYear() - y0 + 1;
  const width = 1.9 / years;
  return Array.from({ length: years }, (_, k) => [y0 + k, 0.35 + k * width, 0.35 + (k + 1) * width]);
}

/** Flat clusters, one disc per colour group, biggest in the middle, laid out on the x–y plane. */
export function clustersLayout(points: readonly LayoutPoint[]): Float32Array {
  const out = new Float32Array(points.length * 3);
  const groups = new Map<number, number[]>();
  points.forEach((p, i) => {
    const list = groups.get(p.group) ?? [];
    list.push(i);
    groups.set(p.group, list);
  });
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const total = points.length || 1;
  const scale = 1.25 / Math.sqrt(total);
  let used = 0;
  order.forEach(([, members], k) => {
    const radius = scale * Math.sqrt(members.length) + 0.04;
    // Place discs on a spiral whose reach grows with the area already used.
    const reach = k === 0 ? 0 : Math.sqrt(used) * scale * 1.25 + radius;
    const a = k * 2.399963229728653;
    const cx = Math.cos(a) * reach;
    const cy = Math.sin(a) * reach;
    used += members.length + 6;
    byTime(points, members).forEach((i, j) => {
      const r = radius * Math.sqrt((j + 0.5) / members.length);
      const t = j * 2.399963229728653;
      out[i * 3] = cx + Math.cos(t) * r;
      out[i * 3 + 1] = cy + Math.sin(t) * r;
      out[i * 3 + 2] = (hash01(points[i]!.id, 8) - 0.5) * 0.04;
    });
  });
  return out;
}

/** What the body needs beyond the points: the record's sources, in the order a point's `strand` indexes them, and now. */
export interface LayoutContext {
  sources: readonly { id: number; kind: string }[];
  now: number;
}

/** Required, so a 'brain' call can never quietly fall back to the cortex alone. */
export function layoutFor(kind: Layout, points: readonly LayoutPoint[], ctx: LayoutContext): Float32Array {
  if (kind === 'rings') return ringsLayout(points);
  if (kind === 'clusters') return clustersLayout(points);
  return bodyLayout(points, ctx.sources, ctx.now).positions;
}

/**
 * The faint outline that shows the brain's shape: folds on the lobes, bands on the cerebellum, and the stem with its
 * rings. Decoration only; none of these points is an entry.
 */
export function brainOutline(seed = 7): { positions: Float32Array; shade: Float32Array } {
  const r = rng(seed);
  const n = noise3(seed);
  const pos: number[] = [];
  const shade: number[] = [];
  const randomDir = (): V3 => {
    const y = r() * 2 - 1;
    const a = r() * Math.PI * 2;
    const s = Math.sqrt(1 - y * y);
    return [Math.cos(a) * s, y, Math.sin(a) * s];
  };
  const fold = (v: V3) => n(v[0] * 3.4, v[1] * 3.4, v[2] * 3.4) + 0.45 * n(v[0] * 7.1 + 11, v[1] * 7.1, v[2] * 7.1);

  // The cortex: points on the surface, with the folds (sulci) left dark.
  for (const side of [1, -1] as const) {
    for (let i = 0; i < 3400; i++) {
      const d = randomDir();
      const v = lobePoint(side, d, 1);
      const f = fold(v);
      if (Math.abs(f) < 0.07) continue;
      const depth = 1 + 0.04 * (Math.min(Math.abs(f), 0.45) / 0.45 - 0.5);
      const w = lobePoint(side, d, depth);
      pos.push(...w);
      shade.push(0.35 + 0.65 * Math.min(1, Math.abs(f) * 2.2));
    }
    for (let i = 0; i < 700; i++) {
      const d = randomDir();
      if (d[1] > 0.35 || d[0] * side < -0.2) continue;
      const v = ellipsoidPoint(TEMPORAL, side, d, 1);
      const f = fold(v);
      if (Math.abs(f) < 0.07) continue;
      pos.push(...v);
      shade.push(0.3 + 0.6 * Math.min(1, Math.abs(f) * 2.2));
    }
    // The cerebellum: fine horizontal bands.
    for (let i = 0; i < 900; i++) {
      const d = randomDir();
      const v = ellipsoidPoint(CEREBELLUM, side, d, 1);
      if (side * v[0] < 0.03) continue;
      const band = Math.sin(v[1] * 64 + 1.6 * n(v[0] * 4, v[1] * 4, v[2] * 4));
      if (band < -0.35) continue;
      pos.push(...v);
      shade.push(0.3 + 0.5 * (band + 0.35) / 1.35);
    }
  }
  // The stem: a faint tube; its lower part is brighter at each ring.
  for (let i = 0; i < 1600; i++) {
    const u = r();
    const { p, r: rad } = stemCentre(u);
    const a = r() * Math.PI * 2;
    const lower = u < STEM_SPLIT;
    const ring = lower && ((p[1] - STEM_BOTTOM) / 0.17) % 1 < 0.28;
    if (lower && !ring && r() < 0.55) continue;
    const rr = rad * (lower ? (ring ? 1.75 : 1.35) : 1.3);
    pos.push(p[0] + Math.cos(a) * rr, p[1], p[2] + Math.sin(a) * rr);
    shade.push(ring ? 0.75 : 0.35);
  }
  return { positions: new Float32Array(pos), shade: new Float32Array(shade) };
}

/** The centre and radius of a sphere holding all the given points (a quick bounding box fit). */
export function boundingSphere(...sets: Float32Array[]): { center: V3; radius: number } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of sets) {
    for (let i = 0; i < s.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = s[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    }
  }
  if (min[0] === Infinity) return { center: [0, 0, 0], radius: 1 };
  const center: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { center, radius: Math.max(0.5, Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2])) };
}
