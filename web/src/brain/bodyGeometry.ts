// What the body draws besides its entries (UX audit item 21, phase 2): the outline, the cord's month rings and the
// nerves. Pure and seeded, like layout.ts's brainOutline, so the tests can check them. Positions are in world units;
// tones run 0 to 1 and the scene turns them into the theme's colours, never the data palettes.

import { brainOutline, rng } from '../layout.ts';
import { CAPSULES, CORD, type Capsule, outside, pointAlong, type Path, type V3 } from './anatomy.ts';
import { across, type BodyLayout, HEAD_SCALE, toWorld } from './body.ts';

/** Outline points per square head unit of a capsule's surface; the head's are sparser, so the brain inside it reads. */
const OUTLINE_DENSITY = 90;
const HEAD_DENSITY = 25;
/** A ring's radius round the cord, in head units, and its segments. */
export const RING_RADIUS = 0.07;
const RING_SEGMENTS = 24;
/** The tones: a fold's ring, and a nerve still waiting for its source's first entry. */
export const FOLD_TONE = 0.45;
export const WAITING_TONE = 0.3;
/** The outline's lines: how many run along each capsule, their tone, and their step in head units. */
const MERIDIANS = 6;
export const OUTLINE_TONE = 0.4;
const CONTOUR_STEP = 0.12;
const CAP_STEPS = 6;

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A capsule's axis from a to b, its length, and two directions square to the axis and to each other. */
function frameOf(c: Capsule): { axis: V3; len: number; e1: V3; e2: V3 } {
  const d: V3 = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const axis: V3 = len ? [d[0] / len, d[1] / len, d[2] / len] : [0, 1, 0];
  const e1 = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  return { axis, len, e1, e2: cross(axis, e1) };
}

/**
 * The body's outline as lines, so it reads from as far off as the Body framing stands and on light themes, where the
 * additive dust of bodyOutline doesn't show. On every capsule below the head: a few lines from end to end over its
 * round ends, and a ring round each end of its straight part. A piece that runs inside another capsule is left out,
 * so the joints read as one surface. World units, in pairs for line segments; decoration only.
 */
export function bodyContours(): { positions: Float32Array; tone: Float32Array } {
  const pos: number[] = [];
  CAPSULES.forEach((c, k) => {
    if (c.part === 'head') return;
    const others = CAPSULES.filter((_, j) => j !== k);
    const { axis, len, e1, e2 } = frameOf(c);
    const at = (base: V3, along: number, angle: number, out: number): V3 =>
      [0, 1, 2].map((d) => base[d]! + axis[d]! * along + (e1[d]! * Math.cos(angle) + e2[d]! * Math.sin(angle)) * out) as V3;
    const draw = (path: V3[]) => {
      for (let i = 1; i < path.length; i++) {
        const [p, q] = [path[i - 1]!, path[i]!];
        if (outside(p, others) === 0 || outside(q, others) === 0) continue;
        pos.push(...toWorld(p), ...toWorld(q));
      }
    };
    const steps = Math.max(1, Math.ceil(len / CONTOUR_STEP));
    for (let m = 0; m < MERIDIANS; m++) {
      const angle = (m / MERIDIANS) * 2 * Math.PI;
      const path: V3[] = [];
      for (let s = 0; s <= CAP_STEPS; s++) {
        const phi = -Math.PI / 2 + (s / CAP_STEPS) * (Math.PI / 2);
        path.push(at(c.a, c.r * Math.sin(phi), angle, c.r * Math.cos(phi)));
      }
      for (let s = 1; s <= steps; s++) path.push(at(c.a, (s / steps) * len, angle, c.r));
      for (let s = 1; s <= CAP_STEPS; s++) {
        const phi = (s / CAP_STEPS) * (Math.PI / 2);
        path.push(at(c.b, c.r * Math.sin(phi), angle, c.r * Math.cos(phi)));
      }
      draw(path);
    }
    for (const along of [0, len]) {
      draw(Array.from({ length: RING_SEGMENTS + 1 }, (_, s) => at(c.a, along, (s / RING_SEGMENTS) * 2 * Math.PI, c.r)));
    }
  });
  return { positions: new Float32Array(pos), tone: new Float32Array(pos.length / 3).fill(OUTLINE_TONE) };
}

/** A point spread evenly over a capsule's surface: its side or one of its two round ends, by area. */
function onCapsule(c: Capsule, r: () => number): V3 {
  const d: V3 = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const axis: V3 = len ? [d[0] / len, d[1] / len, d[2] / len] : [0, 1, 0];
  const e1 = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const e2 = cross(axis, e1);
  const side = 2 * Math.PI * c.r * len;
  if (r() * (side + 4 * Math.PI * c.r * c.r) < side) {
    const t = r() * len;
    const a = r() * Math.PI * 2;
    return [0, 1, 2].map((k) => c.a[k]! + axis[k]! * t + (e1[k]! * Math.cos(a) + e2[k]! * Math.sin(a)) * c.r) as V3;
  }
  const y = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - y * y);
  const dir: V3 = [Math.cos(a) * s, y, Math.sin(a) * s];
  const end = dir[0] * axis[0] + dir[1] * axis[1] + dir[2] * axis[2] < 0 ? c.a : c.b;
  return [end[0] + dir[0] * c.r, end[1] + dir[1] * c.r, end[2] + dir[2] * c.r];
}

/**
 * The faint outline: phase 1's brain in the head, without its stem below the cord's top (the cord takes over there),
 * and sparse points on the body's capsules, leaving out any that fall inside another capsule so the joints read as
 * one line. Decoration only; none of these points is an entry.
 */
export function bodyOutline(seed = 7): { positions: Float32Array; shade: Float32Array } {
  const r = rng(seed);
  const pos: number[] = [];
  const shade: number[] = [];
  const brain = brainOutline(seed);
  const cut = toWorld(CORD.at(-1)!)[1];
  for (let i = 0; i < brain.shade.length; i++) {
    if (brain.positions[i * 3 + 1]! < cut) continue;
    pos.push(brain.positions[i * 3]!, brain.positions[i * 3 + 1]!, brain.positions[i * 3 + 2]!);
    shade.push(brain.shade[i]!);
  }
  CAPSULES.forEach((c, k) => {
    const others = CAPSULES.filter((_, j) => j !== k);
    const len = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
    const area = 2 * Math.PI * c.r * len + 4 * Math.PI * c.r * c.r;
    const count = Math.round(area * (c.part === 'head' ? HEAD_DENSITY : OUTLINE_DENSITY));
    for (let i = 0; i < count; i++) {
      const p = onCapsule(c, r);
      const tone = 0.25 + 0.2 * r();
      if (outside(p, others) === 0) continue;
      pos.push(...toWorld(p));
      shade.push(tone);
    }
  });
  return { positions: new Float32Array(pos), shade: new Float32Array(shade) };
}

/**
 * A ring round the cord at each month's lower edge, and one more on top of this month, as line-segment pairs. A
 * fold's ring is fainter. `disc` says which disc each segment's ring starts.
 */
export function cordRings(layout: BodyLayout): { positions: Float32Array; tone: Float32Array; disc: Int32Array } {
  const { scale, cord } = layout;
  const edges = [...scale.discs.map((d, i) => ({ y: d.y0, disc: i, fold: d.fold })), { y: scale.height, disc: scale.discs.length - 1, fold: false }];
  const positions = new Float32Array(edges.length * RING_SEGMENTS * 6);
  const tone = new Float32Array(edges.length * RING_SEGMENTS * 2);
  const disc = new Int32Array(edges.length * RING_SEGMENTS);
  const rad = RING_RADIUS * HEAD_SCALE;
  edges.forEach((e, k) => {
    const u = e.y / scale.height;
    const c = pointAlong(cord, u);
    const [a, b] = across(cord, u);
    const at = (s: number): V3 => {
      const t = (s / RING_SEGMENTS) * Math.PI * 2;
      return [0, 1, 2].map((d) => c[d]! + (a[d]! * Math.cos(t) + b[d]! * Math.sin(t)) * rad) as V3;
    };
    for (let s = 0; s < RING_SEGMENTS; s++) {
      const j = k * RING_SEGMENTS + s;
      positions.set(at(s), j * 6);
      positions.set(at(s + 1), j * 6 + 3);
      tone[j * 2] = tone[j * 2 + 1] = e.fold ? FOLD_TONE : 1;
      disc[j] = e.disc;
    }
  });
  return { positions, tone, disc };
}

/** A path from its root to u, as line-segment pairs. */
function segmentsTo(path: Path, u: number): number[] {
  const out: number[] = [];
  let prev: V3 = pointAlong(path, 0);
  for (let i = 1; i < path.along.length && path.along[i - 1]! < u; i++) {
    const next: V3 = path.along[i]! <= u ? [path.points[i * 3]!, path.points[i * 3 + 1]!, path.points[i * 3 + 2]!] : pointAlong(path, u);
    out.push(...prev, ...next);
    prev = next;
  }
  return out;
}

/**
 * Each nerve as line-segment pairs: from the cord to its newest entry, so a quiet source stops short, or its whole
 * length, faint, while its source has no dated entry yet. `nerve` says which nerve each segment belongs to.
 */
export function nerveLines(layout: BodyLayout): { positions: Float32Array; tone: Float32Array; nerve: Int32Array } {
  const pos: number[] = [];
  const tone: number[] = [];
  const nerve: number[] = [];
  layout.nerves.forEach((nv, k) => {
    const waiting = nv.reach <= 0;
    const segs = segmentsTo(nv.path, waiting ? 1 : nv.reach);
    pos.push(...segs);
    for (let j = 0; j < segs.length / 6; j++) {
      tone.push(waiting ? WAITING_TONE : 1, waiting ? WAITING_TONE : 1);
      nerve.push(k);
    }
  });
  return { positions: new Float32Array(pos), tone: new Float32Array(tone), nerve: Int32Array.from(nerve) };
}
