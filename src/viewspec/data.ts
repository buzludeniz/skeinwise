// What a view shows, worked out from the record's entry rows: the filters and dates applied in memory (no SQL is built
// from a spec), then the Workbench's own counting for a chart, or the rows sorted and cut for a list. resolveSpec
// first matches each filter value to a value the record really has, so "garden" finds the project "Garden".

import { type EntryRow, type Table, tableCounts, tableValue, cellEntries } from '../server/buckets.ts';
import type { ViewProp, ViewSpec, Where } from './spec.ts';

const NOUNS: Record<ViewProp, string> = { time: 'month', folder: 'folder', project: 'project', hub: 'hub', source: 'source', speaker: 'speaker', tag: 'tag' };

/** The record's values for one property, by their lower-case form. */
function valuesOf(rows: readonly EntryRow[], prop: ViewProp): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const v = tableValue(r, prop);
    const key = v.toLowerCase();
    if (!out.has(key)) out.set(key, v);
  }
  return out;
}

export type Resolved = { ok: true; spec: ViewSpec } | { ok: false; reasons: string[] };

/**
 * Matches each filter to the record, ignoring case, and gives back the spec with the record's own spelling. A filter
 * on a value the record doesn't have fails with a reason. Months and kinds are left as they are: an empty month is
 * a fair answer.
 */
export function resolveSpec(spec: ViewSpec, rows: readonly EntryRow[]): Resolved {
  if (!spec.where) return { ok: true, spec };
  const reasons: string[] = [];
  const where: Where[] = spec.where.map((w) => {
    if (w.prop === 'kind' || w.prop === 'time') return w;
    const found = valuesOf(rows, w.prop).get(w.is.toLowerCase());
    if (found === undefined) {
      reasons.push(`Your record has no ${NOUNS[w.prop]} called ${JSON.stringify(w.is)}.`);
      return w;
    }
    return { prop: w.prop, is: found };
  });
  return reasons.length ? { ok: false, reasons } : { ok: true, spec: { ...spec, where } };
}

/** The rows a view's filters and dates keep. Dates compare as text, so "2025-03" keeps all of March. */
export function keptRows<R extends EntryRow>(rows: readonly R[], spec: ViewSpec): R[] {
  const where = spec.where ?? [];
  const { from, to } = spec;
  return rows.filter(
    (r) =>
      where.every((w) => (w.prop === 'kind' ? r.kind === w.is : tableValue(r, w.prop) === w.is)) &&
      (!from || r.createdAt.slice(0, from.length) >= from) &&
      (!to || r.createdAt.slice(0, to.length) <= to),
  );
}

/** An entry as a view's list shows it. */
export interface ListItem {
  id: number;
  kind: EntryRow['kind'];
  title: string;
  createdAt: string;
  speaker: string;
  source: string;
  threadId: number | null;
}

function item(r: EntryRow): ListItem {
  return { id: r.id, kind: r.kind, title: r.title, createdAt: r.createdAt, speaker: r.speaker, source: r.source, threadId: r.threadId };
}

export const ALL_ENTRIES = 'All entries';

export type ViewData =
  | { show: 'chart'; table: Table; single: boolean; total: number }
  | { show: 'list'; items: ListItem[]; total: number };

/** A chart's table (one row, "All entries", when the spec has no y), or a list's entries. */
export function viewData(rows: readonly EntryRow[], spec: ViewSpec): ViewData {
  const kept = keptRows(rows, spec);
  if (spec.show === 'list') {
    const sorted = [...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    if (spec.sort === 'newest') sorted.reverse();
    return { show: 'list', items: sorted.slice(0, spec.limit).map(item), total: kept.length };
  }
  if (spec.y) return { show: 'chart', table: tableCounts(kept, spec.x, spec.y), single: false, total: kept.length };
  // One series: count by x against itself, then add each column up into one row.
  const t = tableCounts(kept, spec.x, spec.x);
  const row = t.xs.map((_, xi) => t.cells.reduce((sum, cells) => sum + (cells[xi] ?? 0), 0));
  const table: Table = { ...t, ys: t.xs.length ? [ALL_ENTRIES] : [], cells: t.xs.length ? [row] : [], max: Math.max(0, ...row) };
  return { show: 'chart', table, single: true, total: kept.length };
}

export const CELL_LIMIT = 200;

/** The entries behind one cell of a chart, newest first, at most CELL_LIMIT of them. */
export function viewCell(rows: readonly EntryRow[], spec: ViewSpec, xv: string, yv: string | null): { total: number; entries: ListItem[] } {
  if (spec.show !== 'chart') return { total: 0, entries: [] };
  const kept = keptRows(rows, spec);
  const found = spec.y ? cellEntries(kept, spec.x, xv, spec.y, yv ?? '') : cellEntries(kept, spec.x, xv, spec.x, xv);
  return { total: found.length, entries: found.slice(0, CELL_LIMIT).map(item) };
}
