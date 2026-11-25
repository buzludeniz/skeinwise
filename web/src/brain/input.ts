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
  links: Uint32Array;
  labels: { index: number; text: string }[];
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
}

/** World sizes (diameters) before the size setting; smaller in big records so the stem doesn't turn into a smear. */
const SIZE = { message: 0.05, file: 0.058, note: 0.085, perLink: 0.012 };

/** The colour for each group: the palette in order, then a quiet shared colour for the long tail. */
export function legendColors(count: number, pal: Palette, theme: Theme): string[] {
  const colors = pointColors(pal, theme);
  const tail = mix(theme.inkSoft, theme.ground, theme.light ? 0.1 : 0.25);
  return Array.from({ length: count }, (_, i) => (i < colors.length - 1 ? colors[i]! : count === colors.length ? colors[i]! : tail));
}

export function buildModel(data: BrainData, by: Grouping, pal: Palette, theme: Theme): BrainModel {
  const grouped = groupPoints(data, by);
  const points = layoutPoints(data, grouped.of);
  const hex = legendColors(grouped.groups.length, pal, theme);
  const rgb = hex.map((h) => hexToRgb(h).map((v) => v / 255));
  const n = points.length;
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const degree = linkDegree(data);
  const crowd = Math.min(1, Math.max(0.42, Math.sqrt(700 / Math.max(1, n))));
  for (let i = 0; i < n; i++) {
    colors.set(rgb[grouped.of[i]!]!, i * 3);
    const kind = points[i]!.kind;
    const base = kind === 1 ? SIZE.note + SIZE.perLink * Math.min(6, degree[i]!) : kind === 2 ? SIZE.file : SIZE.message;
    sizes[i] = base * (kind === 1 ? Math.max(0.7, crowd) : crowd);
  }
  // Labels: the most-linked notes first, then the newest, so a record without links still gets a few.
  const notes = points.map((p, i) => i).filter((i) => points[i]!.kind === 1 && data.points[i]![8].trim());
  notes.sort((a, b) => degree[b]! - degree[a]! || points[b]!.time - points[a]!.time || a - b);
  const labels = notes.slice(0, 16).map((index) => ({ index, text: data.points[index]![8].trim() }));
  return {
    grouped,
    legend: grouped.groups.map((g, i) => ({ label: g.label, count: g.count, color: hex[i]! })),
    input: { points, colors, sizes, threads: threadPairs(data), links: linkPairs(data), labels },
    indexOf: new Map(data.points.map((p, i) => [p[0], i])),
  };
}

/**
 * The lit value per point: 2 lit, 1 as usual, 0 dimmed. A search or span lights its matches and dims the rest; an
 * isolated legend group dims everything outside it. Null when nothing is lit or isolated.
 */
export function litValues(model: BrainModel, ids: Set<number> | null, isolate: number | null): Float32Array<ArrayBuffer> | null {
  if (!ids && isolate === null) return null;
  const n = model.input.points.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const inGroup = isolate === null || model.grouped.of[i] === isolate;
    const match = ids ? ids.has(model.input.points[i]!.id) : true;
    out[i] = !inGroup ? 0 : ids ? (match ? 2 : 0) : 1;
  }
  return out;
}
