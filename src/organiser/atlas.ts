// The atlas: where each hub sits on the record's map, and the sub-groups inside it. Places come from a seeded
// classical MDS of the hub centres, so hubs about similar things sit near each other. A hub that already had a place
// keeps it, and a new hub goes to the coast beside the hubs it is most like, so the map you learned stays put. A hub's
// sub-groups come from a second seeded k-means over its units; a thread is one unit, so it stays in one sub-group.

import type { RecordView, Unit } from './record.ts';
import { centroid, chooseK, cosine, kmeans, type Vec } from './text.ts';

export interface Place {
  x: number;
  y: number;
}

/** A hub's sub-group as the hub row keeps it: its name, and where it sits inside the hub, in hub radii. */
export interface Part {
  name: string;
  x: number;
  y: number;
}

export interface SubGroups {
  /** Biggest first; a part's id is its index here. */
  parts: { units: Unit[]; centroid: Vec }[];
  /** Each unit's part, by unit key. */
  partOf: Map<string, number>;
}

/** The sub-groups' k-means seed and restarts: fixed, so the same hub always splits the same way. */
const SEED = 1;
const RESTARTS = 4;
/** The room left between two hubs, in the units of a hub's radius (the square root of its entries). */
const GAP = 1;
/** Golden angle, for a direction that depends only on an index. */
const TURN = Math.PI * (3 - Math.sqrt(5));

/** Splits a hub's units (in record order) into sub-groups, with chooseK as the hubs themselves use it. */
export function subGroups(record: RecordView, units: Unit[]): SubGroups {
  const vectors = units.map((u) => record.unitVector(u));
  const assign = units.length > 1 ? kmeans(vectors, chooseK(units.length), SEED, RESTARTS).assign : units.map(() => 0);
  const buckets = new Map<number, Unit[]>();
  units.forEach((u, i) => {
    // A unit with no words gets no cluster from k-means; it goes with the first.
    const a = Math.max(0, assign[i]!);
    const list = buckets.get(a);
    if (list) list.push(u);
    else buckets.set(a, [u]);
  });
  const lists = [...buckets.values()].sort((a, b) => b.length - a.length || a[0]!.pos - b[0]!.pos);
  const partOf = new Map<string, number>();
  lists.forEach((list, p) => {
    for (const u of list) partOf.set(u.key, p);
  });
  return { parts: lists.map((list) => ({ units: list, centroid: centroid(list.map((u) => record.unitVector(u))) })), partOf };
}

/**
 * Keyword names for a hub's sub-groups: each part's two best terms that aren't among the hub's own three, so the
 * provinces of "sourdough" aren't all called "sourdough". Names stay unique inside the hub.
 */
export function partNames(record: RecordView, hubUnits: Unit[], parts: Unit[][]): string[] {
  const hubTerms = new Set(record.nameTerms(hubUnits, 3));
  const used = new Set<string>();
  return parts.map((units, p) => {
    const terms = record
      .nameTerms(units, 8)
      .filter((t) => !hubTerms.has(t))
      .map((t) => record.shown(t));
    const tries = [terms.slice(0, 2), ...terms.slice(2).map((t) => [terms[0]!, t]), terms.slice(0, 1)];
    for (const words of tries) {
      const name = words.join(', ');
      if (name && !used.has(name.toLowerCase())) {
        used.add(name.toLowerCase());
        return name;
      }
    }
    const name = `${terms[0] ?? (units[0]?.title.slice(0, 40) || 'Part')} ${p + 1}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * Classical (Torgerson) MDS of unit vectors into the plane: the squared distance between two of them is 2 - 2cos, the
 * matrix is double-centred, and its two leading eigenvectors come from power iteration started from a fixed vector,
 * so the same centres always give the same map.
 */
export function mds(centres: Vec[]): [number, number][] {
  const n = centres.length;
  if (n === 0) return [];
  if (n === 1) return [[0, 0]];
  const d2 = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.max(0, 2 - 2 * cosine(centres[i]!, centres[j]!));
      d2[i * n + j] = d;
      d2[j * n + i] = d;
    }
  }
  const row = new Float64Array(n);
  let all = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += d2[i * n + j]!;
    all += sum;
    row[i] = sum / n;
  }
  all /= n * n;
  const b = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i * n + j] = -0.5 * (d2[i * n + j]! - row[i]! - row[j]! + all);
  const first = leading(b, n, 0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i * n + j] = b[i * n + j]! - first.value * first.vector[i]! * first.vector[j]!;
  const second = leading(b, n, 1);
  const sx = Math.sqrt(Math.max(0, first.value));
  const sy = Math.sqrt(Math.max(0, second.value));
  return Array.from({ length: n }, (_, i) => [first.vector[i]! * sx, second.vector[i]! * sy] as [number, number]);
}

/** The leading eigenpair of a symmetric matrix, by power iteration from a fixed start; the sign is fixed too. */
function leading(m: Float64Array, n: number, salt: number): { value: number; vector: Float64Array } {
  let v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.cos(1.3 * i + 0.7 + salt);
  let value = 0;
  for (let round = 0; round < 500; round++) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += m[i * n + j]! * v[j]!;
      w[i] = s;
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += w[i]! * w[i]!;
    norm = Math.sqrt(norm);
    if (norm < 1e-12) return { value: 0, vector: new Float64Array(n) };
    let change = 0;
    for (let i = 0; i < n; i++) {
      w[i] = w[i]! / norm;
      change += Math.abs(w[i]! - v[i]!);
    }
    v = w;
    value = norm;
    if (change < 1e-10) break;
  }
  // The Rayleigh quotient gives the eigenvalue its sign (power iteration finds the largest in size).
  let rq = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += m[i * n + j]! * v[j]!;
    rq += v[i]! * s;
  }
  value = rq;
  let skew = 0;
  for (let i = 0; i < n; i++) skew += v[i]! ** 3;
  if (skew < 0) for (let i = 0; i < n; i++) v[i] = -v[i]!;
  return { value, vector: v };
}

/**
 * MDS coordinates scaled so a typical hub just touches its nearest neighbour, then pushed apart until no two discs
 * (radius r, plus the gap) overlap, and centred on the area-weighted middle.
 */
export function spread(raw: [number, number][], radii: number[], gap = GAP): Place[] {
  const n = raw.length;
  if (n === 0) return [];
  const ratios: number[] = [];
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = Math.hypot(raw[i]![0] - raw[j]![0], raw[i]![1] - raw[j]![1]);
      if (d > 1e-9) best = Math.min(best, d / (radii[i]! + radii[j]! + gap));
    }
    if (Number.isFinite(best)) ratios.push(best);
  }
  ratios.sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)]! : 0;
  const scale = median > 0 ? 1.1 / median : 1;
  const pts = raw.map(([x, y]) => ({ x: x * scale, y: y * scale }));
  separate(pts, radii, gap, pts.map(() => false));
  let wx = 0;
  let wy = 0;
  let w = 0;
  pts.forEach((p, i) => {
    const a = radii[i]! ** 2;
    wx += p.x * a;
    wy += p.y * a;
    w += a;
  });
  return pts.map((p) => ({ x: round(p.x - wx / w), y: round(p.y - wy / w) }));
}

/** Pushes overlapping discs apart, in a fixed order; a fixed disc never moves. */
function separate(pts: Place[], radii: number[], gap: number, fixed: boolean[]): void {
  for (let pass = 0; pass < 400; pass++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (fixed[i] && fixed[j]) continue;
        const a = pts[i]!;
        const b = pts[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const want = radii[i]! + radii[j]! + gap;
        if (d >= want - 1e-9) continue;
        if (d < 1e-9) {
          dx = Math.cos(TURN * (i + j + 1));
          dy = Math.sin(TURN * (i + j + 1));
          d = 1;
        } else {
          dx /= d;
          dy /= d;
        }
        const push = want - (d < 1e-9 ? 0 : d) + 1e-6;
        const share = fixed[i] ? [0, 1] : fixed[j] ? [1, 0] : [0.5, 0.5];
        a.x -= dx * push * share[0]!;
        a.y -= dy * push * share[0]!;
        b.x += dx * push * share[1]!;
        b.y += dy * push * share[1]!;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

export interface HubToPlace {
  centre: Vec;
  /** Entries in the hub; its disc's radius is the square root. */
  size: number;
  /** The place it keeps, when it already had one. */
  kept: Place | null;
}

/**
 * A place for every hub. With none placed yet, all of them come from MDS. Otherwise the placed keep theirs and each
 * new hub, biggest first, goes to the coast: out from the map's middle through the hubs it is most like, to the first
 * spot where it overlaps nothing.
 */
export function placeHubs(hubs: HubToPlace[]): Place[] {
  const radii = hubs.map((h) => Math.sqrt(Math.max(1, h.size)));
  if (!hubs.some((h) => h.kept)) return spread(mds(hubs.map((h) => h.centre)), radii);
  const out: (Place | null)[] = hubs.map((h) => h.kept);
  const placed = hubs.flatMap((h, i) => (h.kept ? [{ place: h.kept, r: radii[i]!, centre: h.centre }] : []));
  const fresh = hubs.map((h, i) => i).filter((i) => !hubs[i]!.kept);
  fresh.sort((a, b) => hubs[b]!.size - hubs[a]!.size || a - b);
  for (const i of fresh) {
    const place = coast(placed, hubs[i]!.centre, radii[i]!, i);
    out[i] = place;
    placed.push({ place, r: radii[i]!, centre: hubs[i]!.centre });
  }
  return out as Place[];
}

function coast(placed: { place: Place; r: number; centre: Vec }[], centre: Vec, r: number, salt: number): Place {
  let ox = 0;
  let oy = 0;
  let w = 0;
  for (const p of placed) {
    ox += p.place.x * p.r ** 2;
    oy += p.place.y * p.r ** 2;
    w += p.r ** 2;
  }
  ox /= w;
  oy /= w;
  const near = placed
    .map((p) => ({ p, s: cosine(centre, p.centre) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  let ux = Math.cos(TURN * (salt + 1));
  let uy = Math.sin(TURN * (salt + 1));
  let start = 0;
  if (near.length) {
    const sum = near.reduce((s, x) => s + x.s, 0);
    const tx = near.reduce((s, x) => s + x.p.place.x * x.s, 0) / sum - ox;
    const ty = near.reduce((s, x) => s + x.p.place.y * x.s, 0) / sum - oy;
    const len = Math.hypot(tx, ty);
    if (len > 1e-6) {
      ux = tx / len;
      uy = ty / len;
      start = len;
    }
  }
  const step = Math.max(0.5, r / 4);
  for (let t = start; ; t += step) {
    const x = ox + ux * t;
    const y = oy + uy * t;
    if (placed.every((p) => Math.hypot(p.place.x - x, p.place.y - y) >= p.r + r + GAP)) return { x: round(x), y: round(y) };
  }
}

/**
 * Where a hub's sub-groups sit inside it, in hub radii: MDS of their centres, each a disc whose area is its share of
 * the hub, pushed apart and then scaled to fit the unit disc.
 */
export function placeParts(parts: { centroid: Vec; size: number }[]): Place[] {
  const total = parts.reduce((s, p) => s + p.size, 0) || 1;
  const radii = parts.map((p) => Math.sqrt(p.size / total));
  const pts = spread(mds(parts.map((p) => p.centroid)), radii, 0.02);
  let reach = 0;
  pts.forEach((p, i) => {
    reach = Math.max(reach, Math.hypot(p.x, p.y) + radii[i]!);
  });
  const fit = reach > 1 ? 1 / reach : 1;
  return pts.map((p) => ({ x: round(p.x * fit), y: round(p.y * fit) }));
}

const round = (v: number) => Math.round(v * 1000) / 1000;
