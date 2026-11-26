// The organiser's read of the record: visible entries, the units it groups (a thread, or a loose note), and term
// vectors for both. Built once per command and shared by the tasks of a run.

import type { Entry, Store } from '../store/store.ts';
import { buildIndex, type TermIndex, tokenize, type Vec, vectorize } from './text.ts';

/** A thread, or an entry outside any thread (a note). Grouping works on units, so a thread stays together. */
export interface Unit {
  key: string;
  title: string;
  entries: Entry[];
  /** Position in RecordView.units and in the unit index. */
  pos: number;
}

/** [[Target|alias]] and [[Target#heading]] become "Target", so links count as words. */
export function unlink(text: string): string {
  return text.replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, '$1');
}

/** The [[link]] targets in a text. */
export function linkTargets(text: string): string[] {
  return [...new Set([...text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1]!.trim()))];
}

/** The fields a note is linked by. */
export interface NoteName {
  id: number;
  kind: string;
  title: string | null;
  externalId: string;
}

/** A path as [[links]] write it: `/` between folders, no extension, lowercase. A table's `[[Note\|alias]]` leaves a `\`. */
function linkPath(text: string): string {
  return text
    .trim()
    .replace(/\\+$/, '')
    .replaceAll('\\', '/')
    .replace(/^\.?\//, '')
    .replace(/\.(md|markdown|txt)$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Which note a [[link]] names, read the way Obsidian writes links (LS-19). The alias and heading are gone already
 * (`linkTargets`). In order: the note at that path in the vault (`[[Garden/Plan]]`, and `[[Plan]]` for one at the
 * root); a note whose path ends in it, by whole folders (`[[Plotline/Plan]]` for Projects/Plotline/Plan.md); then a
 * note by file name or title. Where two share a name, the first in the record wins. A path that names no note names
 * none, even when its file name matches one: Obsidian would make a new note there.
 */
export class NoteNames<T extends NoteName> {
  private readonly byPath = new Map<string, T>();
  private readonly byBase = new Map<string, T[]>();
  private readonly byName = new Map<string, T>();

  constructor(entries: Iterable<T>) {
    for (const e of entries) {
      if (e.kind !== 'note') continue;
      const path = linkPath(e.externalId);
      const base = path.split('/').pop()!;
      if (!this.byPath.has(path)) this.byPath.set(path, e);
      this.byBase.set(base, [...(this.byBase.get(base) ?? []), e]);
      for (const name of [base, (e.title ?? '').trim().toLowerCase()]) if (name && !this.byName.has(name)) this.byName.set(name, e);
    }
  }

  resolve(target: string): T | undefined {
    const path = linkPath(target);
    if (!path) return undefined;
    const exact = this.byPath.get(path);
    if (exact) return exact;
    if (!path.includes('/')) return this.byName.get(path);
    const base = path.split('/').pop()!;
    return this.byBase.get(base)?.find((e) => linkPath(e.externalId).endsWith(`/${path}`)) ?? this.byName.get(path);
  }
}

export function entryText(e: Entry): string {
  return unlink(`${e.title ?? ''}\n${e.body}`);
}

/** How far past the run an entry's date may be (clock skew, time zones) before the organiser stops building on it. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Whether hub summaries may quote and cite an entry, and review may weigh it against a note (H1). A planted export
 * dates its text in the future so that it reads as your latest thinking, so an entry that claims a date more than a
 * day after the run is left out, and so is one whose date doesn't parse (importers write ISO dates, so only a made-up
 * one fails). The store flags a claimed date more than a day ahead, before 1990 or missing (`timeFlag`), and dates
 * such an entry by when it was seen, which would read as recent: so a flagged entry is left out too.
 */
export function vouched(e: Entry, now: string): boolean {
  return !e.timeFlag && Date.parse(e.createdAt) <= Date.parse(now) + FUTURE_SLACK_MS;
}

/** A daily note: under daily/ or named by its date. Daily notes are logs, not notes that can go out of date. */
export function isDailyNote(e: Entry): boolean {
  return e.kind === 'note' && (/(^|\/)daily\//.test(e.externalId) || /^\d{4}-\d{2}-\d{2}$/.test(e.title ?? ''));
}

export class RecordView {
  readonly store: Store;
  readonly entries: Entry[];
  readonly byId: Map<number, Entry>;
  private unitList?: Unit[];
  private unitOfEntry?: Map<number, Unit>;
  private uIndex?: TermIndex;
  private eIndex?: TermIndex;
  private eVectors?: Map<number, Vec>;
  private uDf?: Float64Array;
  private noteNames?: NoteNames<Entry>;

  constructor(store: Store) {
    this.store = store;
    this.entries = store.allEntries();
    this.byId = new Map(this.entries.map((e) => [e.id, e]));
  }

  get units(): Unit[] {
    if (!this.unitList) {
      const byKey = new Map<string, Unit>();
      for (const e of this.entries) {
        const key = e.threadId ? `t${e.threadId}` : `e${e.id}`;
        let unit = byKey.get(key);
        if (!unit) {
          unit = { key, title: e.threadTitle ?? e.title ?? '', entries: [], pos: byKey.size };
          byKey.set(key, unit);
        }
        unit.entries.push(e);
      }
      this.unitList = [...byKey.values()];
      this.unitOfEntry = new Map(this.unitList.flatMap((u) => u.entries.map((e) => [e.id, u] as const)));
    }
    return this.unitList;
  }

  unitOf(entryId: number): Unit | undefined {
    void this.units;
    return this.unitOfEntry!.get(entryId);
  }

  /** Term vectors over units (thread title plus every entry). Grouping and naming use these. */
  get unitIndex(): TermIndex {
    this.uIndex ??= buildIndex(this.units.map((u) => `${u.title}\n${u.entries.map(entryText).join('\n')}`));
    return this.uIndex;
  }

  unitVector(unit: Unit): Vec {
    return this.unitIndex.vectors[unit.pos]!;
  }

  /** In how many units each term appears. */
  get unitDf(): Float64Array {
    if (!this.uDf) {
      const df = new Float64Array(this.unitIndex.terms.length);
      for (const v of this.unitIndex.vectors) for (const i of v.keys()) df[i] = df[i]! + 1;
      this.uDf = df;
    }
    return this.uDf;
  }

  /** Term vectors over single entries. Links, similar entries and layers use these. */
  get entryIndex(): TermIndex {
    this.eIndex ??= buildIndex(this.entries.map(entryText));
    return this.eIndex;
  }

  entryVector(entryId: number): Vec {
    if (!this.eVectors) {
      const index = this.entryIndex;
      this.eVectors = new Map(this.entries.map((e, i) => [e.id, index.vectors[i]!]));
    }
    const v = this.eVectors.get(entryId);
    if (!v) throw new Error(`Entry ${entryId} is not in the visible record.`);
    return v;
  }

  /** A sentence's vector in the unit space, to compare it with a group's centre. */
  sentenceVector(text: string): Vec {
    return vectorize(this.unitIndex, unlink(text));
  }

  /**
   * Names for a group of units, best first: terms most units in the group share, weighted by how rare they are in
   * the record, with a bonus for words in thread titles. Returns term indexes into the unit index.
   */
  nameTerms(units: Unit[], n: number): number[] {
    const index = this.unitIndex;
    const df = this.unitDf;
    const total = this.units.length;
    const cover = new Map<number, number>();
    for (const u of units) {
      for (const i of index.vectors[u.pos]!.keys()) cover.set(i, (cover.get(i) ?? 0) + 1);
      for (const t of new Set(tokenize(u.title))) {
        const i = index.termId.get(t);
        if (i !== undefined) cover.set(i, (cover.get(i) ?? 0) + 1);
      }
    }
    return [...cover]
      .map(([i, c]) => [i, (c / Math.max(1, units.length)) * Math.log(total / Math.max(1, df[i]!))] as const)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, n)
      .map(([i]) => i);
  }

  /** The note a [[link]] points at (`NoteNames`). */
  resolveLink(target: string): Entry | undefined {
    this.noteNames ??= new NoteNames(this.entries);
    return this.noteNames.resolve(target);
  }

  shown(term: number): string {
    return this.unitIndex.shown[term]!;
  }
}
