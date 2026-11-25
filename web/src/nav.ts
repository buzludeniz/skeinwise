// The Navigator's middle column, built from the brain data the page already holds: one row per thread, note or file.
// Pure, so the tests can check it.

import type { BrainData } from '../../src/server/queries.ts';

export interface NavItem {
  kind: 'thread' | 'note' | 'file' | 'message';
  /** The thread id for a thread, otherwise the entry id. */
  id: number;
  title: string;
  /** First and last time (ms), for a thread its span. */
  first: number;
  last: number;
  count: number;
  source: number;
  folder: number;
  speakers: Set<number>;
}

export interface NavFilter {
  folder?: number;
  source?: number;
  speaker?: number;
  /** Only items with something newer than this (ms). */
  since?: number;
}

export type NavSort = 'date' | 'name';

/** Threads and loose entries, filtered and sorted. A thread passes when any of its entries does. */
export function navItems(data: BrainData, filter: NavFilter = {}, sort: NavSort = 'date'): NavItem[] {
  const threads = new Map<number, NavItem>();
  const items: NavItem[] = [];
  for (const [id, kind, speaker, source, thread, folder, , time, label] of data.points) {
    if (filter.folder !== undefined && folder !== filter.folder) continue;
    if (filter.source !== undefined && source !== filter.source) continue;
    if (filter.speaker !== undefined && speaker !== filter.speaker) continue;
    if (filter.since !== undefined && time < filter.since) continue;
    if (thread > 0) {
      let t = threads.get(thread);
      if (!t) {
        t = { kind: 'thread', id: thread, title: data.threads[thread] ?? '', first: time, last: time, count: 0, source, folder, speakers: new Set() };
        threads.set(thread, t);
        items.push(t);
      }
      t.count++;
      t.first = Math.min(t.first, time);
      t.last = Math.max(t.last, time);
      t.speakers.add(speaker);
    } else {
      const k = kind === 1 ? 'note' : kind === 2 ? 'file' : 'message';
      items.push({ kind: k, id, title: label, first: time, last: time, count: 1, source, folder, speakers: new Set([speaker]) });
    }
  }
  const name = (i: NavItem) => i.title.trim().toLowerCase() || '￿';
  items.sort(sort === 'name' ? (a, b) => name(a).localeCompare(name(b)) || b.last - a.last : (a, b) => b.last - a.last || a.id - b.id);
  return items;
}

/** How many entries sit in each folder index. */
export function folderCounts(data: BrainData): number[] {
  const counts = new Array<number>(data.folders.length).fill(0);
  for (const p of data.points) counts[p[5]] = (counts[p[5]] ?? 0) + 1;
  return counts;
}

/** How many entries each source holds, by source id. */
export function sourceCounts(data: BrainData): Map<number, number> {
  const counts = new Map<number, number>();
  for (const p of data.points) counts.set(p[3], (counts.get(p[3]) ?? 0) + 1);
  return counts;
}
