// What a point in the brain is, for its card: an entry or a concept hub, the facts the card shows, and the entries it
// leads to. Pure (no DOM, no WebGL), so the tests can check it.
//
// A point is named by its id: an entry's id, or a hub's id negated (as in input.ts), so a selection survives a regroup
// or a reload. Its index is where the scene draws it, and is -1 when the scene doesn't draw it (a sampled-out entry).

import type { BrainData, BrainPoint } from '../../../src/server/queries.ts';
import type { EntryLines } from '../types.ts';
import type { BrainModel } from './input.ts';

export const KIND_NAMES = ['Message', 'Note', 'File'] as const;

export interface EntryPart {
  kind: 'entry';
  /** The point id, which for an entry is its entry id. */
  point: number;
  id: number;
  index: number;
  title: string;
  at: number;
  source: string;
  type: (typeof KIND_NAMES)[number];
  speaker: string;
  /** The thread's title, or null when the entry is in no thread. */
  thread: string | null;
}

export interface HubPart {
  kind: 'hub';
  /** The point id, which for a hub is its hub id negated. */
  point: number;
  id: number;
  index: number;
  name: string;
  /** Its entries in the whole record, not only the ones drawn. */
  count: number;
}

export type Part = EntryPart | HubPart;

/** One row in a card's list: an entry or a hub it leads to, and why. */
export interface Row {
  point: number;
  title: string;
  why: string;
  /** The entry's date; absent for a hub. */
  at?: number;
}

const byIdCache = new WeakMap<BrainData, Map<number, BrainPoint>>();

/** Entry id → its point in the whole record (not only the drawn sample). */
export function recordIndex(record: BrainData): Map<number, BrainPoint> {
  let map = byIdCache.get(record);
  if (!map) {
    map = new Map(record.points.map((p) => [p[0], p]));
    byIdCache.set(record, map);
  }
  return map;
}

/** An entry's title as the brain shows it. */
export function titleOf(p: BrainPoint | undefined): string {
  return p?.[8].trim() || 'Untitled';
}

/** Where the scene draws the point with this id, or -1 when it doesn't. */
export function indexOfPoint(model: BrainModel, point: number): number {
  if (point >= 0) return model.indexOf.get(point) ?? -1;
  return model.hubs.find((h) => h.id === -point)?.index ?? -1;
}

/** The point the scene draws at this index, as its card describes it; null when there is none. */
export function partAt(model: BrainModel, record: BrainData, index: number): Part | null {
  const p = model.data.points[index];
  if (p) {
    return {
      kind: 'entry',
      point: p[0],
      id: p[0],
      index,
      title: titleOf(p),
      at: p[7],
      source: record.sources.find((s) => s.id === p[3])?.label ?? 'Unknown source',
      type: KIND_NAMES[p[1]] ?? 'Message',
      speaker: record.speakers[p[2]] ?? '',
      thread: p[4] ? (record.threads[String(p[4])] ?? null) : null,
    };
  }
  const hub = model.hubs.find((h) => h.index === index);
  return hub ? { kind: 'hub', point: -hub.id, id: hub.id, index, name: hub.name.trim() || 'Untitled hub', count: hub.count } : null;
}

/**
 * The rows for an entry's card, from GET /api/links/:id: the notes it links to and from, its hubs, its neighbours in
 * its thread, and the entries that read alike, most alike first. An entry turns up once, under its first reason.
 */
export function linkedRows(lines: EntryLines, record: BrainData): Row[] {
  const byId = recordIndex(record);
  const rows: Row[] = [];
  const seen = new Set<number>([lines.entry]);
  const add = (point: number, why: string) => {
    if (seen.has(point)) return;
    seen.add(point);
    if (point < 0) {
      const hub = record.hubs.find((h) => h.id === -point);
      rows.push({ point, title: hub?.name.trim() || 'Untitled hub', why });
      return;
    }
    const p = byId.get(point);
    rows.push({ point, title: titleOf(p), why, ...(p ? { at: p[7] } : {}) });
  };
  for (const l of lines.noteLink) if (l.direction === 'to') add(l.entry, 'Links to');
  for (const l of lines.noteLink) if (l.direction === 'from') add(l.entry, 'Linked from');
  for (const h of lines.hubSpoke) add(-h.hub, 'In hub');
  if (lines.threadLine.before !== null) add(lines.threadLine.before, 'Before, in its thread');
  if (lines.threadLine.after !== null) add(lines.threadLine.after, 'After, in its thread');
  for (const c of [...lines.crossLink].sort((a, b) => b.score - a.score)) add(c.entry, 'Reads alike');
  return rows;
}

/** The entries around one: itself, the notes it links to and from, the entries that read alike, and its thread neighbours. */
export function neighbourIds(lines: EntryLines): number[] {
  const ids = new Set<number>([lines.entry]);
  for (const l of lines.noteLink) ids.add(l.entry);
  for (const c of lines.crossLink) ids.add(c.entry);
  if (lines.threadLine.before !== null) ids.add(lines.threadLine.before);
  if (lines.threadLine.after !== null) ids.add(lines.threadLine.after);
  return [...ids];
}

/** A hub's entries among those the page has (all of them, or the server's sample of the record), newest first. */
export function hubMembers(record: BrainData, hubId: number): Row[] {
  const byId = recordIndex(record);
  const hub = record.hubs.find((h) => h.id === hubId);
  if (!hub) return [];
  return hub.entries
    .map((id) => byId.get(id))
    .filter((p): p is BrainPoint => p !== undefined)
    .sort((a, b) => b[7] - a[7] || a[0] - b[0])
    .map((p) => ({ point: p[0], title: titleOf(p), why: KIND_NAMES[p[1]] ?? 'Message', at: p[7] }));
}

/** A hub's entry ids that are still in the record. */
export function hubEntryIds(record: BrainData, hubId: number): number[] {
  const byId = recordIndex(record);
  return (record.hubs.find((h) => h.id === hubId)?.entries ?? []).filter((id) => byId.has(id));
}
