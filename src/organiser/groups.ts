// Grouping units (threads and loose notes) by what they are about, for Topics, folders and hubs. A run over
// everything clusters from scratch; a run over new entries first adds each unit to the group it continues or sits
// closest to, and clusters only what is left.

import type { Entry } from '../store/store.ts';
import { isDailyNote, linkTargets, type RecordView, type Unit } from './record.ts';
import { invalid, isRecord, list, type ModelRequest, text } from './plan.ts';
import { centroid, chooseK, cosine, kmeans, type Vec } from './text.ts';

/** A group a live run already made (a hub, folder or topic tag), and the entries in it. */
export interface Existing {
  id: number;
  name: string;
  entryIds: number[];
}

export interface Group {
  units: Unit[];
  /** The entries in scope that this run puts in the group. */
  entries: Entry[];
  centroid: Vec;
  existing?: Existing;
}

export interface Grouping {
  groups: Group[];
  /** Units that fit no group: they go to the Inbox folder and to no hub. */
  loose: Unit[];
}

/** k-means restarts and seed: fixed, so the same record always groups the same way. */
const RESTARTS = 16;
const SEED = 1;
/** How close a new unit must be to an existing group's centre to join it. */
const JOIN = 0.15;
/** New units that fit nowhere are clustered only when there are at least this many. */
const MIN_NEW = 6;

/** The units holding at least one entry in scope. */
export function scopedUnits(record: RecordView, entries: Entry[]): Unit[] {
  const seen = new Set<Unit>();
  for (const e of entries) {
    const u = record.unitOf(e.id);
    if (u) seen.add(u);
  }
  return [...seen].sort((a, b) => a.pos - b.pos);
}

export function groupUnits(record: RecordView, entries: Entry[], existing: Existing[] = []): Grouping {
  const inScope = new Set(entries.map((e) => e.id));
  const units = scopedUnits(record, entries);
  const make = (members: Unit[], ex?: Existing): Group => ({
    units: members,
    entries: members.flatMap((u) => u.entries.filter((e) => inScope.has(e.id))),
    centroid: centroid(members.map((u) => record.unitVector(u))),
    ...(ex ? { existing: ex } : {}),
  });
  const daily = units.filter((u) => u.entries.every(isDailyNote));
  const rest = units.filter((u) => !daily.includes(u));
  let groups: { members: Unit[]; existing?: Existing }[];
  let loose: Unit[];
  if (!existing.length) {
    // k comes from every unit in scope, daily notes too: they add to how much there is to sort, if not to what.
    const result = cluster(record, rest, chooseK(units.length));
    groups = result.groups.map((members) => ({ members }));
    loose = result.loose;
  } else {
    const placed = new Map<Existing, Unit[]>(existing.map((ex) => [ex, []]));
    const left: Unit[] = [];
    const centres = existing.map((ex) => centroid(unitsOf(record, ex.entryIds).map((u) => record.unitVector(u))));
    for (const unit of rest) {
      const target = continued(unit, existing) ?? nearest(record.unitVector(unit), existing, centres);
      if (target) placed.get(target)!.push(unit);
      else left.push(unit);
    }
    const fresh = left.length >= MIN_NEW ? cluster(record, left, chooseK(left.length)) : { groups: [], loose: left };
    groups = [...[...placed].map(([ex, members]) => ({ members, existing: ex })), ...fresh.groups.map((members) => ({ members }))];
    loose = fresh.loose;
  }
  // A daily note is a log of the day: it goes with the note it links to, not with other daily notes.
  for (const unit of daily) {
    const home = linkedGroup(record, unit, groups) ?? nearestGroup(record, unit, groups);
    if (home) home.members.push(unit);
    else loose.push(unit);
  }
  return {
    groups: groups.filter((g) => g.members.length).map((g) => make(g.members, g.existing)),
    loose: loose.sort((a, b) => a.pos - b.pos),
  };
}

type Draft = { members: Unit[]; existing?: Existing };

/** The group holding a note this unit links to. */
function linkedGroup(record: RecordView, unit: Unit, groups: Draft[]): Draft | undefined {
  for (const e of unit.entries) {
    for (const target of linkTargets(e.body)) {
      const note = record.resolveLink(target);
      const home = note && record.unitOf(note.id);
      const group = home && groups.find((g) => g.members.includes(home) || g.existing?.entryIds.includes(note.id));
      if (group) return group;
    }
  }
  return undefined;
}

function nearestGroup(record: RecordView, unit: Unit, groups: Draft[]): Draft | undefined {
  const centres = groups.map((g) => centroid(g.members.map((u) => record.unitVector(u))));
  const best = nearest(record.unitVector(unit), groups.map((_, i) => ({ id: i, name: '', entryIds: [] })), centres);
  return best ? groups[best.id] : undefined;
}

function unitsOf(record: RecordView, entryIds: number[]): Unit[] {
  const out = new Set<Unit>();
  for (const id of entryIds) {
    const u = record.unitOf(id);
    if (u) out.add(u);
  }
  return [...out];
}

/** The existing group already holding most of this unit's entries: a thread stays where it started. */
function continued(unit: Unit, existing: Existing[]): Existing | undefined {
  let best: Existing | undefined;
  let most = 0;
  for (const ex of existing) {
    const ids = new Set(ex.entryIds);
    const n = unit.entries.filter((e) => ids.has(e.id)).length;
    if (n > most) {
      most = n;
      best = ex;
    }
  }
  return best;
}

function nearest(v: Vec, existing: Existing[], centres: Vec[]): Existing | undefined {
  let best = -1;
  let bestSim = JOIN;
  centres.forEach((c, i) => {
    const s = cosine(v, c);
    if (s >= bestSim) {
      bestSim = s;
      best = i;
    }
  });
  return best >= 0 ? existing[best] : undefined;
}

/** Clusters units with k-means; a cluster of one unit, or a unit with no words, is loose. */
function cluster(record: RecordView, units: Unit[], k: number): { groups: Unit[][]; loose: Unit[] } {
  const vectors = units.map((u) => record.unitVector(u));
  const { assign } = kmeans(vectors, Math.min(k, units.length), SEED, RESTARTS);
  const byGroup = new Map<number, Unit[]>();
  const loose: Unit[] = [];
  units.forEach((u, i) => {
    const g = assign[i]!;
    if (g < 0) loose.push(u);
    else byGroup.set(g, [...(byGroup.get(g) ?? []), u]);
  });
  const groups: Unit[][] = [];
  for (const members of byGroup.values()) {
    if (members.length >= 2) groups.push(members);
    else loose.push(...members);
  }
  // Largest first, then by first unit, so numbering is stable.
  groups.sort((a, b) => b.length - a.length || a[0]!.pos - b[0]!.pos);
  return { groups, loose: loose.sort((a, b) => a.pos - b.pos) };
}

/** A name from the words most units in the group share: n terms, joined with commas. */
export function groupName(record: RecordView, group: Group, n: number): string {
  return record
    .nameTerms(group.units, n)
    .map((t) => record.shown(t))
    .join(', ');
}

/** A short description of a group for a model to name: its key words and a few titles. */
export function groupBrief(record: RecordView, group: Group): string {
  const words = record.nameTerms(group.units, 8).map((t) => record.shown(t));
  const titles = [...new Set(group.units.map((u) => u.title).filter(Boolean))].slice(0, 4);
  return `words: ${words.join(', ')}; titles: ${titles.map((t) => `"${t}"`).join(', ')}`;
}

/**
 * Asks a model to name groups: each gets a short name, every group exactly once, no two alike. The answer is a list of
 * names in the order of the groups.
 */
export function namingRequest(record: RecordView, groups: Group[], what: string, words: string, purpose: string): ModelRequest {
  const lines = groups.map((g, i) => `G${i + 1}: ${groupBrief(record, g)}`);
  const user = [
    `Groups of my notes and chats, each with its key words and a few titles. Name each group as a ${what}, in ${words}.`,
    ...lines,
    '',
    'Answer with JSON only: {"names": [{"group": "G1", "name": "..."}]}, one item per group, no two names alike.',
  ].join('\n');
  const check = (answer: unknown): string[] => {
    if (!isRecord(answer)) invalid(purpose, 'expected a JSON object');
    const names = new Array<string | undefined>(groups.length);
    for (const it of list(purpose, answer.names, 'names')) {
      if (!isRecord(it)) invalid(purpose, 'each "names" item must be an object');
      const m = /^G?(\d+)$/i.exec(String(it.group ?? '').trim());
      const i = m ? Number(m[1]) - 1 : -1;
      if (i < 0 || i >= groups.length) invalid(purpose, `names a group it wasn't shown: ${JSON.stringify(it.group)}`);
      if (names[i] !== undefined) invalid(purpose, `names G${i + 1} twice`);
      names[i] = text(purpose, it.name, 'name', 60);
    }
    const missing = names.findIndex((n) => n === undefined);
    if (missing >= 0) invalid(purpose, `gives no name for G${missing + 1}`);
    const lower = names.map((n) => n!.toLowerCase());
    if (new Set(lower).size !== lower.length) invalid(purpose, 'gives two groups the same name');
    return names as string[];
  };
  return {
    purpose,
    system: "You organise one person's own notes and chats. You answer with JSON only.",
    user,
    maxTokens: 40 + 20 * groups.length,
    check,
  };
}
