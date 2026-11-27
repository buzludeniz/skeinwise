// Pure counting for the timeline and the Workbench: entries per week, and the table builder's cells.

import { TABLE_PROPS } from './config.ts';

export type TableProp = (typeof TABLE_PROPS)[number];

/** One visible entry with the properties the views group by. */
export interface EntryRow {
  id: number;
  kind: 'message' | 'note' | 'file';
  speaker: string;
  sourceId: number;
  source: string;
  sourceKind: string;
  threadId: number | null;
  folder: string;
  project: string | null;
  hub: string | null;
  tag: string | null;
  createdAt: string;
  title: string;
}

const DAY = 86_400_000;

/** The Monday (UTC) that starts the week holding this moment, as YYYY-MM-DD. */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${iso}`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday)).toISOString().slice(0, 10);
}

/** Every week start from the week holding `first` to the week holding `last`, inclusive. */
export function weeksBetween(first: string, last: string): string[] {
  const weeks: string[] = [];
  const end = Date.parse(`${weekStart(last)}T00:00:00Z`);
  for (let t = Date.parse(`${weekStart(first)}T00:00:00Z`); t <= end; t += 7 * DAY) {
    weeks.push(new Date(t).toISOString().slice(0, 10));
  }
  return weeks;
}

/** Every month from `first` to `last` (YYYY-MM), inclusive. */
export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.slice(0, 7).split('-').map(Number) as [number, number];
  const [ly, lm] = last.slice(0, 7).split('-').map(Number) as [number, number];
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export interface Series {
  key: string;
  counts: number[];
  total: number;
}

export interface Timeline {
  weeks: string[];
  series: Series[];
}

/** Entries per week, one series per source or speaker, biggest first. Weeks with nothing in them are kept. */
export function timelineBuckets(rows: readonly EntryRow[], by: 'source' | 'speaker'): Timeline {
  if (!rows.length) return { weeks: [], series: [] };
  let first = rows[0]!.createdAt;
  let last = first;
  for (const r of rows) {
    if (r.createdAt < first) first = r.createdAt;
    if (r.createdAt > last) last = r.createdAt;
  }
  const weeks = weeksBetween(first, last);
  const index = new Map(weeks.map((w, i) => [w, i]));
  const series = new Map<string, Series>();
  for (const r of rows) {
    const key = by === 'source' ? r.source : r.speaker;
    let s = series.get(key);
    if (!s) {
      s = { key, counts: new Array<number>(weeks.length).fill(0), total: 0 };
      series.set(key, s);
    }
    s.counts[index.get(weekStart(r.createdAt))!]! += 1;
    s.total += 1;
  }
  return { weeks, series: [...series.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key)) };
}

/** Labels for entries the organiser hasn't reached: honest names, not invented groups. */
export const UNSET: Record<'project' | 'hub' | 'tag', string> = {
  project: 'No project yet',
  hub: 'No hub yet',
  tag: 'Untagged',
};

export function tableValue(row: EntryRow, prop: TableProp): string {
  switch (prop) {
    case 'time':
      return row.createdAt.slice(0, 7);
    case 'folder':
      return row.folder;
    case 'project':
      return row.project ?? UNSET.project;
    case 'hub':
      return row.hub ?? UNSET.hub;
    case 'source':
      return row.source;
    case 'speaker':
      return row.speaker;
    case 'tag':
      return row.tag ?? UNSET.tag;
  }
}

export interface Filter {
  prop: TableProp;
  value: string;
}

/** "speaker:you" → { prop: 'speaker', value: 'you' }. Empty or unknown → null. */
export function parseFilter(text: string | null | undefined): Filter | null {
  if (!text) return null;
  const at = text.indexOf(':');
  if (at < 1) return null;
  const prop = text.slice(0, at) as TableProp;
  if (!(TABLE_PROPS as readonly string[]).includes(prop)) return null;
  return { prop, value: text.slice(at + 1) };
}

export interface Table {
  x: TableProp;
  y: TableProp;
  xs: string[];
  ys: string[];
  /** cells[yi][xi] */
  cells: number[][];
  total: number;
  max: number;
}

export const OTHER = 'Other';
const MAX_CATEGORIES = 24;

function axisValues(rows: readonly EntryRow[], prop: TableProp): { values: string[]; fold: (v: string) => string } {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = tableValue(r, prop);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (prop === 'time') {
    const keys = [...counts.keys()].sort();
    return { values: keys.length ? monthsBetween(keys[0]!, keys.at(-1)!) : [], fold: (v) => v };
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  if (sorted.length <= MAX_CATEGORIES) return { values: sorted, fold: (v) => v };
  const kept = new Set(sorted.slice(0, MAX_CATEGORIES - 1));
  return { values: [...kept, OTHER], fold: (v) => (kept.has(v) ? v : OTHER) };
}

function matches(row: EntryRow, filter: Filter | null): boolean {
  return !filter || tableValue(row, filter.prop) === filter.value;
}

/** Counts entries by two properties. Time runs month by month with gaps kept; other axes run biggest first. */
export function tableCounts(rows: readonly EntryRow[], x: TableProp, y: TableProp, filter: Filter | null = null): Table {
  const kept = rows.filter((r) => matches(r, filter));
  const ax = axisValues(kept, x);
  const ay = axisValues(kept, y);
  const xi = new Map(ax.values.map((v, i) => [v, i]));
  const yi = new Map(ay.values.map((v, i) => [v, i]));
  const cells = ay.values.map(() => new Array<number>(ax.values.length).fill(0));
  let max = 0;
  for (const r of kept) {
    const row = cells[yi.get(ay.fold(tableValue(r, y)))!]!;
    const i = xi.get(ax.fold(tableValue(r, x)))!;
    row[i]! += 1;
    if (row[i]! > max) max = row[i]!;
  }
  return { x, y, xs: ax.values, ys: ay.values, cells, total: kept.length, max };
}

/** The entries behind one cell of the table, newest first. */
export function cellEntries(
  rows: readonly EntryRow[],
  x: TableProp,
  xv: string,
  y: TableProp,
  yv: string,
  filter: Filter | null = null,
): EntryRow[] {
  const kept = rows.filter((r) => matches(r, filter));
  const ax = axisValues(kept, x);
  const ay = axisValues(kept, y);
  return kept
    .filter((r) => ax.fold(tableValue(r, x)) === xv && ay.fold(tableValue(r, y)) === yv)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Monthly lines per key, for the Workbench's activity lines. */
export function tides(rows: readonly EntryRow[], by: 'source' | 'speaker' | 'folder'): { months: string[]; lines: Series[] } {
  if (!rows.length) return { months: [], lines: [] };
  const table = tableCounts(rows, 'time', by);
  return {
    months: table.xs,
    lines: table.ys.map((key, i) => ({ key, counts: table.cells[i]!, total: table.cells[i]!.reduce((a, b) => a + b, 0) })),
  };
}
