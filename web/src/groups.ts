// The brain's colour groups: which group each point falls in under the legend's grouping, biggest group first.
// Pure, so the tests can check it.

import type { BrainData } from '../../src/server/queries.ts';
import { speakerName } from './format.ts';
import type { LayoutPoint } from './layout.ts';

export type Grouping = 'project' | 'folder' | 'source' | 'speaker' | 'month';
/** The groupings the legend offers; month is the Year rings' own. */
export type ColourGrouping = Exclude<Grouping, 'month'>;

export const GROUPING_LABELS: Record<ColourGrouping, string> = {
  project: 'By project',
  folder: 'By folder',
  source: 'By source',
  speaker: 'By speaker',
};

export interface Group {
  label: string;
  count: number;
}

export interface Grouped {
  groups: Group[];
  /** The group index of each point, in the order of data.points. */
  of: Int32Array;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Groups the points. Months keep calendar order; every other grouping is biggest first, then by name. */
export function groupPoints(data: BrainData, by: Grouping): Grouped {
  const sourceLabel = new Map(data.sources.map((s) => [s.id, s.label]));
  const labelOf = (p: BrainData['points'][number]): string => {
    switch (by) {
      case 'project':
        return p[6] >= 0 ? (data.projects[p[6]] ?? 'No project') : 'No project';
      case 'folder':
        return data.folders[p[5]] ?? 'No folder';
      case 'speaker':
        return speakerName(data.speakers[p[2]] ?? 'unknown');
      case 'month':
        return MONTH_NAMES[new Date(p[7]).getUTCMonth()]!;
      default:
        return sourceLabel.get(p[3]) ?? 'Unknown source';
    }
  };
  const counts = new Map<string, number>();
  const labels = data.points.map((p) => {
    const l = labelOf(p);
    counts.set(l, (counts.get(l) ?? 0) + 1);
    return l;
  });
  const groups = [...counts.entries()].map(([label, count]) => ({ label, count }));
  if (by === 'month') groups.sort((a, b) => MONTH_NAMES.indexOf(a.label) - MONTH_NAMES.indexOf(b.label));
  else groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const index = new Map(groups.map((g, i) => [g.label, i]));
  return { groups, of: Int32Array.from(labels, (l) => index.get(l)!) };
}

/** The layout's view of each point: notes cluster by project, else folder; originals wind on their source's strand. */
export function layoutPoints(data: BrainData, groupOf: Int32Array): LayoutPoint[] {
  const strand = new Map(data.sources.map((s, i) => [s.id, i]));
  return data.points.map((p, i) => ({
    id: p[0],
    kind: p[1],
    time: p[7],
    cluster: p[6] >= 0 ? 1000 + p[6] : p[5],
    strand: strand.get(p[3]) ?? 0,
    group: groupOf[i]!,
  }));
}

/** How many note links touch each point: the most-linked notes get labels and a little more size. */
export function linkDegree(data: BrainData): Int32Array {
  const at = new Map(data.points.map((p, i) => [p[0], i]));
  const deg = new Int32Array(data.points.length);
  for (const [a, b] of data.links) {
    const i = at.get(a);
    const j = at.get(b);
    if (i !== undefined) deg[i]!++;
    if (j !== undefined) deg[j]!++;
  }
  return deg;
}

/** Index pairs for thread lines: each original joined to the next one in its thread, by time. */
export function threadPairs(data: BrainData): Uint32Array {
  const byThread = new Map<number, number[]>();
  data.points.forEach((p, i) => {
    if (p[1] === 1 || !p[4]) return;
    const list = byThread.get(p[4]) ?? [];
    list.push(i);
    byThread.set(p[4], list);
  });
  const pairs: number[] = [];
  for (const list of byThread.values()) {
    list.sort((a, b) => data.points[a]![7] - data.points[b]![7] || data.points[a]![0] - data.points[b]![0]);
    for (let k = 1; k < list.length; k++) pairs.push(list[k - 1]!, list[k]!);
  }
  return Uint32Array.from(pairs);
}

/** Index pairs for the lines between entries: note links (kind 0), cross links (kind 1), or both when no kind is given. */
export function linkPairs(data: BrainData, kind?: number): Uint32Array {
  const at = new Map(data.points.map((p, i) => [p[0], i]));
  const pairs: number[] = [];
  for (const [a, b, k] of data.links) {
    if (kind !== undefined && k !== kind) continue;
    const i = at.get(a);
    const j = at.get(b);
    if (i !== undefined && j !== undefined && i !== j) pairs.push(i, j);
  }
  return Uint32Array.from(pairs);
}
