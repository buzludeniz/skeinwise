// Turns the record's brain data into what the scene draws: a colour, size and place per point, the line pairs and the
// labels. Pure (no DOM, no WebGL), so the tests can check it.

import type { BrainData } from '../../../src/server/queries.ts';
import { type Grouped, type Grouping, groupPoints, layoutPoints, linkDegree, linkPairs, threadPairs } from '../groups.ts';
import type { LayoutPoint } from '../layout.ts';
import { hexToRgb, mix, type Palette, pointColors, type Theme } from '../themes.ts';

export interface SceneInput {
  points: LayoutPoint[];
  colors: Float32Array;
  sizes: Float32Array;
  threads: Uint32Array;
  /** Index pairs for note links: the [[links]] you wrote. */
  links: Uint32Array;
  /** Index pairs for cross links: entries in different threads that read alike. */
  cross: Uint32Array;
  /** Index pairs for hub spokes: each hub joined to every entry it holds. */
  spokes: Uint32Array;
  labels: { index: number; text: string }[];
}

/** A concept hub's point, after the entries' points. */
export interface HubPoint {
  index: number;
  id: number;
  name: string;
  count: number;
}

export interface LegendItem {
  label: string;
  count: number;
  color: string;
}

export interface BrainModel {
  grouped: Grouped;
  /** One colour per group, in legend order. */
  legend: LegendItem[];
  input: SceneInput;
  /** Entry id → point index. */
  indexOf: Map<number, number>;
  /** The concept hubs' points, which come after every entry's point. */
  hubs: HubPoint[];
}

/** World sizes (diameters) before the size setting; smaller in big records so the stem doesn't turn into a smear. */
const SIZE = { message: 0.05, file: 0.058, note: 0.085, perLink: 0.012, hub: 0.2 };

/** The value that turns up most often (the smallest on a tie), or the fallback when there are none. */
function commonest(values: number[], fallback: number): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let most = 0;
  for (const [v, c] of counts) if (c > most || (c === most && v < best)) [best, most] = [v, c];
  return best;
}

/**
 * One point per concept hub, placed among the lobes with its entries' commonest cluster and coloured by their
 * commonest group. Its id is the hub id negated, so it never meets an entry id. Hubs whose entries are all gone are
 * left out.
 */
function hubPoints(data: BrainData, points: LayoutPoint[], indexOf: Map<number, number>) {
  const out: { point: LayoutPoint; hub: BrainData['hubs'][number]; members: number[] }[] = [];
  for (const hub of data.hubs) {
    const members = hub.entries.map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined);
    if (!members.length) continue;
    const time = Math.max(...members.map((i) => points[i]!.time));
    const point: LayoutPoint = {
      id: -hub.id,
      kind: 1,
      time,
      cluster: commonest(members.map((i) => points[i]!.cluster), 0),
      strand: 0,
      group: commonest(members.map((i) => points[i]!.group), 0),
    };
    out.push({ point, hub, members });
  }
  return out;
}

/** The colour for each group: the palette in order, then a quiet shared colour for the long tail. */
export function legendColors(count: number, pal: Palette, theme: Theme): string[] {
  const colors = pointColors(pal, theme);
  const tail = mix(theme.inkSoft, theme.ground, theme.light ? 0.1 : 0.25);
  return Array.from({ length: count }, (_, i) => (i < colors.length - 1 ? colors[i]! : count === colors.length ? colors[i]! : tail));
}

export function buildModel(data: BrainData, by: Grouping, pal: Palette, theme: Theme): BrainModel {
  const grouped = groupPoints(data, by);
  const entries = layoutPoints(data, grouped.of);
  const indexOf = new Map(data.points.map((p, i) => [p[0], i]));
  const hubs = hubPoints(data, entries, indexOf);
  const points = [...entries, ...hubs.map((h) => h.point)];
  const hex = legendColors(grouped.groups.length, pal, theme);
  const rgb = hex.map((h) => hexToRgb(h).map((v) => v / 255));
  const ink = hexToRgb(theme.ink).map((v) => v / 255);
  const n = points.length;
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const degree = linkDegree(data);
  const crowd = Math.min(1, Math.max(0.42, Math.sqrt(700 / Math.max(1, entries.length))));
  for (let i = 0; i < entries.length; i++) {
    colors.set(rgb[grouped.of[i]!]!, i * 3);
    const kind = points[i]!.kind;
    const base = kind === 1 ? SIZE.note + SIZE.perLink * Math.min(6, degree[i]!) : kind === 2 ? SIZE.file : SIZE.message;
    sizes[i] = base * (kind === 1 ? Math.max(0.7, crowd) : crowd);
  }
  // Hubs: their group's colour lifted a little toward the ink, and the largest points in the lobes.
  const spokes: number[] = [];
  hubs.forEach(({ point, members }, k) => {
    const i = entries.length + k;
    const c = rgb[point.group] ?? ink;
    colors.set([0, 1, 2].map((d) => c[d]! + (ink[d]! - c[d]!) * 0.25), i * 3);
    sizes[i] = SIZE.hub * Math.max(0.8, crowd) * (1 + 0.25 * Math.min(1, members.length / 40));
    for (const m of members) spokes.push(i, m);
  });
  // Labels: hubs first, biggest first; then the most-linked notes, then the newest, so a record without links still
  // gets a few.
  const hubLabels = hubs
    .map((h, k) => ({ index: entries.length + k, text: h.hub.name.trim(), count: h.members.length }))
    .filter((l) => l.text)
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ index, text }) => ({ index, text }));
  const notes = entries.map((p, i) => i).filter((i) => entries[i]!.kind === 1 && data.points[i]![8].trim());
  notes.sort((a, b) => degree[b]! - degree[a]! || entries[b]!.time - entries[a]!.time || a - b);
  const noteLabels = notes.slice(0, Math.max(0, 16 - hubLabels.length)).map((index) => ({ index, text: data.points[index]![8].trim() }));
  return {
    grouped,
    legend: grouped.groups.map((g, i) => ({ label: g.label, count: g.count, color: hex[i]! })),
    input: {
      points,
      colors,
      sizes,
      threads: threadPairs(data),
      links: linkPairs(data, 0),
      cross: linkPairs(data, 1),
      spokes: Uint32Array.from(spokes),
      labels: [...hubLabels.slice(0, 16), ...noteLabels],
    },
    indexOf,
    hubs: hubs.map((h, k) => ({ index: entries.length + k, id: h.hub.id, name: h.hub.name, count: h.members.length })),
  };
}

/**
 * The lit value per point: 2 lit, 1 as usual, 0 dimmed. A search or span lights its matches and dims the rest, and a
 * hub lights when any entry it holds does; an isolated legend group dims everything outside it. Null when nothing is
 * lit or isolated.
 */
export function litValues(model: BrainModel, ids: Set<number> | null, isolate: number | null): Float32Array<ArrayBuffer> | null {
  if (!ids && isolate === null) return null;
  const { points, spokes } = model.input;
  const out = new Float32Array(points.length);
  const hubMatch = new Set<number>();
  if (ids) for (let k = 0; k < spokes.length; k += 2) if (ids.has(points[spokes[k + 1]!]!.id)) hubMatch.add(spokes[k]!);
  for (let i = 0; i < points.length; i++) {
    const inGroup = isolate === null || points[i]!.group === isolate;
    const match = ids ? ids.has(points[i]!.id) || hubMatch.has(i) : true;
    out[i] = !inGroup ? 0 : ids ? (match ? 2 : 0) : 1;
  }
  return out;
}
