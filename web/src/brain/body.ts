// Where every point sits on the standing body (UX audit item 21, phase 2): notes and hubs keep their places in the
// head, phase 1's cortex, and every other entry hangs on its source's nerve, as far along it as its date is up the
// cord. Pure and seeded, like layout.ts, so the same record always gives the same picture.
//
// One calendar for the whole body: a time's place on every nerve is its height on the cord's month scale over the
// cord's height, so a month spans the same stretch of every nerve and lighting it lights one band across the body.
// Past months keep their proportions as the record grows; the scale only shrinks a little as the top month grows.
//
// Units: the anatomy is in head units; this maps it into layout.ts's world (the brain about 2.4 wide, y up, +z the
// front), with the head round the brain.

import { brainLayout, hash01, type LayoutPoint } from '../layout.ts';
import { CORD, type Nerve, nervesFor, type Path, pathThrough, pointAlong, type V3 } from './anatomy.ts';
import { buildTimeScale, discOf, monthOf, type TimeScale, yOf } from './timescale.ts';

/**
 * World units per head unit, and where the head's middle sits in the world: round phase 1's cortex, high in the skull
 * with room for the face below. Fitted so the cortex stays inside the skull from a handful of notes to the cap.
 */
export const HEAD_SCALE = 3.2;
export const HEAD_CENTRE: V3 = [0, 0.15, 0.04];

export function toWorld(v: readonly number[]): V3 {
  return [HEAD_CENTRE[0] + v[0]! * HEAD_SCALE, HEAD_CENTRE[1] + v[1]! * HEAD_SCALE, HEAD_CENTRE[2] + v[2]! * HEAD_SCALE];
}

export function toHead(v: readonly number[]): V3 {
  return [(v[0]! - HEAD_CENTRE[0]) / HEAD_SCALE, (v[1]! - HEAD_CENTRE[1]) / HEAD_SCALE, (v[2]! - HEAD_CENTRE[2]) / HEAD_SCALE];
}

/** How far, in head units, an entry may sit off its nerve: a quiet month's entries close in, a busy month's spread. */
export const BEAD = 0.035;
const BEAD_GROWTH = 0.5;
const BEAD_MAX = 2;

/** A source whose entries name no listed source: they hang on one extra trunk nerve, last in line. */
export const UNLISTED = Number.MAX_SAFE_INTEGER;

export interface BodyNerve extends Nerve {
  /** Its path in world units, root first. */
  path: Path;
  /** How far along it its oldest and newest dated entries sit, 0 to 1; both 0 for a source with none yet. */
  first: number;
  reach: number;
  /** Its entries in this layout. */
  count: number;
}

export interface BodyLayout {
  /** xyz per point, in world units. */
  positions: Float32Array;
  /** How far along its nerve each point sits, 0 to 1; NaN for a note or a hub, which sit in the head. */
  along: Float32Array;
  /** Which nerve (an index into `nerves`) each point hangs on; -1 for a note or a hub. */
  nerveOf: Int32Array;
  nerves: BodyNerve[];
  /** The cord's calendar, and the cord itself in world units. A height y on the scale is y / scale.height along the cord. */
  scale: TimeScale;
  cord: Path;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Two directions square to a path at u, for spreading entries round it and drawing rings on it. */
export function across(path: Path, u: number): [V3, V3] {
  const t = unit(sub(pointAlong(path, Math.min(1, u + 0.01)), pointAlong(path, Math.max(0, u - 0.01))));
  const a = unit(Math.abs(t[2]) < 0.9 ? cross(t, [0, 0, 1]) : cross(t, [1, 0, 0]));
  return [a, cross(t, a)];
}

/**
 * The body layout. `sources` is the record's source list, in the order `strand` indexes it (groups.ts's
 * layoutPoints); `now` sets the cord's top month.
 */
/** Whether an entry sits in the head, as notes and hubs do, rather than on its source's nerve. */
export function inHead(point: { kind: number } | undefined): boolean {
  return point?.kind === 1;
}

/**
 * The hub spokes the body draws, as index pairs: those between a hub and the entries in the head. A spoke to an entry on
 * a nerve would cross the whole body, so the body leaves it out; the other layouts draw every spoke.
 */
export function headSpokes(points: readonly { kind: number }[], spokes: Uint32Array): Uint32Array {
  const keep: number[] = [];
  for (let s = 0; s + 1 < spokes.length; s += 2) {
    if (inHead(points[spokes[s]!]) && inHead(points[spokes[s + 1]!])) keep.push(spokes[s]!, spokes[s + 1]!);
  }
  return new Uint32Array(keep);
}

/** Whether a line between two entries reaches below the neck: one of its ends hangs on a nerve, not in the head. */
export function belowNeck(points: readonly { kind: number }[], a: number, b: number): boolean {
  return !inHead(points[a]) || !inHead(points[b]);
}

export function bodyLayout(points: readonly LayoutPoint[], sources: readonly { id: number; kind: string }[], now: number): BodyLayout {
  const n = points.length;
  const positions = new Float32Array(n * 3);
  const along = new Float32Array(n).fill(Number.NaN);
  const nerveOf = new Int32Array(n).fill(-1);

  // The head: phase 1's cortex, unchanged, for every note and hub.
  const head: number[] = [];
  const hung: number[] = [];
  points.forEach((p, i) => (inHead(p) ? head : hung).push(i));
  const cortex = brainLayout(head.map((i) => points[i]!));
  head.forEach((i, k) => positions.set(cortex.subarray(k * 3, k * 3 + 3), i * 3));

  // One nerve per listed source, and one more if any entry names a source that isn't listed.
  const listed = sources.map((s) => ({ id: s.id, kind: s.kind }));
  const unlisted = hung.some((i) => !sources[points[i]!.strand]);
  const nerves = nervesFor(unlisted ? [...listed, { id: UNLISTED, kind: '' }] : listed);
  const index = new Map(nerves.map((nv, k) => [nv.source, k]));
  const body: BodyNerve[] = nerves.map((nv) => ({ ...nv, path: pathThrough(nv.control.map(toWorld)), first: 0, reach: 0, count: 0 }));

  const scale = buildTimeScale(
    hung.map((i) => points[i]!.time),
    now,
  );
  const seen = new Set<number>();
  for (const i of hung) {
    const p = points[i]!;
    const k = index.get(sources[p.strand]?.id ?? UNLISTED)!;
    const nerve = body[k]!;
    const y = yOf(scale, p.time);
    // An entry with no usable date has no month: it waits at the root. Rounded as `along` stores it, so a nerve's
    // first and reach equal its oldest and newest entries' along exactly.
    const u = y === null ? 0 : Math.fround(y / scale.height);
    nerveOf[i] = k;
    along[i] = u;
    nerve.count++;
    if (y !== null) {
      if (!seen.has(k)) {
        seen.add(k);
        nerve.first = u;
        nerve.reach = u;
      } else {
        nerve.first = Math.min(nerve.first, u);
        nerve.reach = Math.max(nerve.reach, u);
      }
    }
    const c = pointAlong(nerve.path, u);
    const [a, b] = across(nerve.path, u);
    const month = y === null ? 1 : (scale.discs[discOf(scale, monthOf(p.time))]?.count ?? 1);
    const r = BEAD * HEAD_SCALE * Math.min(BEAD_MAX, 1 + BEAD_GROWTH * Math.log10(Math.max(1, month))) * Math.sqrt(hash01(p.id, 11));
    const phi = hash01(p.id, 12) * Math.PI * 2;
    for (let d = 0; d < 3; d++) positions[i * 3 + d] = c[d]! + (a[d]! * Math.cos(phi) + b[d]! * Math.sin(phi)) * r;
  }

  return { positions, along, nerveOf, nerves: body, scale, cord: pathThrough(CORD.map(toWorld)) };
}
