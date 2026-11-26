// The body layout (web/src/brain/body.ts): notes and hubs keep phase 1's places in the head, every other entry hangs
// on its source's nerve inside the body, time runs from root to tip on one calendar for every nerve, a quiet source
// stops short, and entries with no listed source or no date still get a place.

import { describe, expect, it } from 'vitest';
import { CAPSULES, outside, pointAlong, regionOf, type V3 } from '../../web/src/brain/anatomy.ts';
import { BEAD, bodyLayout, HEAD_SCALE, toHead, UNLISTED } from '../../web/src/brain/body.ts';
import { brainLayout, type LayoutPoint } from '../../web/src/layout.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const DAY = 86_400_000;
const sources = [
  { id: 4, kind: 'chatgpt' },
  { id: 7, kind: 'claude-code' },
  { id: 9, kind: 'notes' },
  { id: 12, kind: 'claude' },
];

/** An invented record: chats every few days for a year, coding sessions that went quiet in March, notes, files and hubs. */
function record(): LayoutPoint[] {
  const out: LayoutPoint[] = [];
  let id = 1;
  const add = (kind: 0 | 1 | 2, strand: number, time: number, cluster = 0) => out.push({ id: id++, kind, time, cluster, strand, thread: 0, group: 0 });
  for (let d = 0; d < 365; d += 3) add(0, 0, NOW - d * DAY);
  for (let d = 260; d < 420; d += 2) add(0, 1, NOW - d * DAY);
  for (let d = 0; d < 200; d += 5) add(1, 2, NOW - d * DAY, d % 3);
  for (let d = 10; d < 300; d += 20) add(2, 2, NOW - d * DAY);
  for (let d = 30; d < 90; d += 1) add(0, 3, NOW - d * DAY);
  out.push({ id: -1, kind: 1, time: NOW - DAY, cluster: 1, strand: 0, thread: 0, group: 0 });
  return out;
}

const points = record();
const layout = bodyLayout(points, sources, NOW);
const at = (i: number): V3 => [layout.positions[i * 3]!, layout.positions[i * 3 + 1]!, layout.positions[i * 3 + 2]!];
const hung = points.flatMap((p, i) => (p.kind === 1 ? [] : [i]));

describe('the head', () => {
  it("keeps every note and hub where phase 1's cortex put it, inside the head", () => {
    const head = points.flatMap((p, i) => (p.kind === 1 ? [i] : []));
    const cortex = brainLayout(head.map((i) => points[i]!));
    const skull = CAPSULES.filter((c) => c.part === 'head');
    head.forEach((i, k) => {
      expect(at(i)).toEqual([cortex[k * 3], cortex[k * 3 + 1], cortex[k * 3 + 2]]);
      expect(Number.isNaN(layout.along[i])).toBe(true);
      expect(layout.nerveOf[i]).toBe(-1);
      expect(outside(toHead(at(i)), skull)).toBe(0);
    });
  });

  it('holds a full cortex at the 20,000-point cap inside the skull', () => {
    const many = Array.from({ length: 20_000 }, (_, i): LayoutPoint => ({ id: i + 1, kind: 1, time: i, cluster: i % 37, strand: 0, thread: 0, group: 0 }));
    const { positions } = bodyLayout(many, sources, NOW);
    const skull = CAPSULES.filter((c) => c.part === 'head');
    let worst = 0;
    for (let i = 0; i < many.length; i++) worst = Math.max(worst, outside(toHead([positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]), skull));
    expect(worst).toBe(0);
  });
});

describe('the nerves', () => {
  it("hangs every other entry on its source's nerve, in its region, inside the body", () => {
    for (const i of hung) {
      const nerve = layout.nerves[layout.nerveOf[i]!]!;
      const source = sources[points[i]!.strand]!;
      expect(nerve.source).toBe(source.id);
      expect(nerve.region).toBe(regionOf(source.kind));
      const off = Math.hypot(...(at(i).map((v, d) => v - pointAlong(nerve.path, layout.along[i]!)[d]!) as V3));
      expect(off).toBeLessThanOrEqual(2 * BEAD * HEAD_SCALE + 1e-6);
      expect(outside(toHead(at(i))), `entry ${points[i]!.id}`).toBeLessThan(0.02);
    }
  });

  it('runs time from the root to the tip, on one calendar for every nerve', () => {
    for (const k of layout.nerves.keys()) {
      const mine = hung.filter((i) => layout.nerveOf[i] === k).sort((a, b) => points[a]!.time - points[b]!.time);
      for (let j = 1; j < mine.length; j++) expect(layout.along[mine[j]!]!).toBeGreaterThanOrEqual(layout.along[mine[j - 1]!]!);
    }
    const same = bodyLayout(
      [
        { id: 1, kind: 0, time: NOW - 40 * DAY, cluster: 0, strand: 0, thread: 0, group: 0 },
        { id: 2, kind: 0, time: NOW - 40 * DAY, cluster: 0, strand: 1, thread: 0, group: 0 },
        { id: 3, kind: 2, time: NOW - 40 * DAY, cluster: 0, strand: 2, thread: 0, group: 0 },
        { id: 4, kind: 0, time: NOW - 400 * DAY, cluster: 0, strand: 3, thread: 0, group: 0 },
      ],
      sources,
      NOW,
    );
    expect(same.along[1]).toBe(same.along[0]);
    expect(same.along[2]).toBe(same.along[0]);
    expect(same.along[3]).toBeGreaterThanOrEqual(0);
    expect(same.along[3]).toBeLessThan(same.along[0]!);
  });

  it('reaches the hand for a live source and stops short where a quiet one went quiet', () => {
    const [chats, coding, notes, claude] = layout.nerves.slice().sort((a, b) => a.source - b.source);
    expect(chats!.reach).toBeGreaterThan(0.95);
    expect(coding!.reach).toBeLessThan(0.6);
    expect(claude!.reach).toBeLessThan(chats!.reach);
    expect(claude!.reach).toBeGreaterThan(coding!.reach);
    expect(coding!.first).toBeLessThan(chats!.first);
    expect(notes!.count).toBe(15); // the files: the notes themselves sit in the head
    const last = Math.max(...hung.filter((i) => points[i]!.strand === 1).map((i) => layout.along[i]!));
    expect(coding!.reach).toBe(last);
  });

  it('gives a source with no entries yet a waiting nerve, and the empty record every nerve', () => {
    const empty = bodyLayout([], sources, NOW);
    expect(empty.positions).toHaveLength(0);
    expect(empty.nerves.map((nv) => [nv.source, nv.count, nv.first, nv.reach])).toEqual(sources.map((s) => [s.id, 0, 0, 0]));
    expect(empty.scale.discs).toHaveLength(1);
  });
});

describe('entries without a place of their own', () => {
  it('hangs entries whose source is not listed on one extra trunk nerve, last in line', () => {
    const odd = bodyLayout(
      [
        { id: 1, kind: 0, time: NOW - DAY, cluster: 0, strand: 0, thread: 0, group: 0 },
        { id: 2, kind: 0, time: NOW - DAY, cluster: 0, strand: 8, thread: 0, group: 0 },
        { id: 3, kind: 2, time: NOW - DAY, cluster: 0, strand: 9, thread: 0, group: 0 },
      ],
      sources,
      NOW,
    );
    expect(odd.nerves.map((nv) => nv.source)).toEqual([4, 7, 9, 12, UNLISTED]);
    expect(odd.nerves.at(-1)!.region).toBe('trunk');
    expect([odd.nerveOf[1], odd.nerveOf[2]]).toEqual([4, 4]);
    expect(bodyLayout([{ id: 1, kind: 0, time: NOW, cluster: 0, strand: 0, thread: 0, group: 0 }], sources, NOW).nerves).toHaveLength(4);
  });

  it('waits an entry with no usable date at its nerve root, and leaves it out of the reach', () => {
    const undated = bodyLayout(
      [
        { id: 1, kind: 0, time: Number.NaN, cluster: 0, strand: 1, thread: 0, group: 0 },
        { id: 2, kind: 0, time: NOW - 10 * DAY, cluster: 0, strand: 1, thread: 0, group: 0 },
      ],
      sources,
      NOW,
    );
    expect(undated.along[0]).toBe(0);
    expect(undated.nerves[1]!.first).toBe(undated.along[1]);
    expect(undated.nerves[1]!.first).toBeGreaterThan(0);
    expect(undated.scale.undated).toBe(1);
    expect(Array.from(undated.positions).every(Number.isFinite)).toBe(true);
  });
});

describe('a stable picture', () => {
  it('lays the same record out the same way every time, whatever order the sources come in', () => {
    expect(bodyLayout(points, sources, NOW).positions).toEqual(layout.positions);
    const shuffled = [sources[2]!, sources[0]!, sources[3]!, sources[1]!];
    const strandMap = [1, 3, 0, 2]; // old strand -> its index in `shuffled`
    const again = bodyLayout(
      points.map((p) => ({ ...p, strand: p.kind === 1 ? p.strand : strandMap[p.strand]! })),
      shuffled,
      NOW,
    );
    for (const i of hung) expect(Array.from(again.positions.subarray(i * 3, i * 3 + 3))).toEqual(Array.from(layout.positions.subarray(i * 3, i * 3 + 3)));
  });
});
