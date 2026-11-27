// The hub task: one concept hub per group, with three sections built from your own sentences: In short, What you
// found (dated quotes) and Open ends (questions you asked). A model writes In short and Open ends and picks the
// findings; the No-AI engine picks sentences by how central they are and by word cues.

import type { DatabaseSync } from 'node:sqlite';
import type { Entry } from '../store/store.ts';
import { type Part, partNames, type Place, placeHubs, placeParts, subGroups, type SubGroups } from './atlas.ts';
import { FINDING_CUES, isQuestion } from './cues.ts';
import { type Existing, type Group, groupName, groupUnits } from './groups.ts';
import { cited, day, invalid, isRecord, list, type ModelRequest, type Plan, round, type TaskContext, text } from './plan.ts';
import { isDailyNote, type RecordView, type Unit, unlink, vouched } from './record.ts';
import { centroid, cosine, pickDiverse, sentences, tokenize, type Vec } from './text.ts';
import { hubEntryIds, type HubItem, hubPlaces, type HubSections, liveHubs } from './views.ts';

export interface Sentence {
  text: string;
  entryId: number;
  date: string;
  vector: Vec;
  relevance: number;
  /** From a daily note: a log line, used only when the notes and chats say too little. */
  daily: boolean;
}

/**
 * Your sentences in these entries (four words or more, each once, not the entry's own title), scored by closeness to
 * the group's centre.
 */
export function yourSentences(record: RecordView, entries: Entry[], centre: Vec): Sentence[] {
  const seen = new Set<string>();
  const out: Sentence[] = [];
  for (const e of [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)) {
    if (e.speaker !== 'you') continue;
    const title = plainKey(e.title ?? '');
    const daily = isDailyNote(e);
    for (const s of sentences(e.body)) {
      const plain = unlink(s);
      const key = plainKey(plain);
      if (plain.split(/\s+/).length < 4 || seen.has(key) || key === title) continue;
      seen.add(key);
      const vector = record.sentenceVector(plain);
      out.push({ text: plain, entryId: e.id, date: day(e.createdAt), vector, relevance: cosine(vector, centre), daily });
    }
  }
  return out;
}

const plainKey = (s: string) => s.toLowerCase().replace(/\W+/g, ' ').trim();
const item = (s: Sentence): HubItem => ({ text: s.text, entryId: s.entryId, date: s.date });
const byDate = (a: HubItem, b: HubItem) => a.date.localeCompare(b.date) || a.entryId - b.entryId;

/**
 * The No-AI sections. What you found: sentences with a finding cue ("decided", "turns out", …), then the most central
 * statements up to three. In short: three central statements, kept apart from each other and from the findings. Open
 * ends: your latest relevant questions. Daily-note lines come last in every pick.
 */
export function extractSections(list: Sentence[], centre: Vec): HubSections {
  const statements = list.filter((s) => !isQuestion(s.text));
  const byRelevance = [...statements].sort((a, b) => Number(a.daily) - Number(b.daily) || b.relevance - a.relevance);
  const found = byRelevance.filter((s) => FINDING_CUES.test(s.text)).slice(0, 5);
  const inShort = pickFrom(statements.filter((s) => !found.includes(s)), centre, 3);
  for (const s of byRelevance) {
    if (found.length >= 3) break;
    if (!found.includes(s) && !inShort.includes(s)) found.push(s);
  }
  const questions = list
    .filter((s) => isQuestion(s.text) && s.relevance > 0.05)
    .sort((a, b) => Number(a.daily) - Number(b.daily) || b.date.localeCompare(a.date))
    .slice(0, 5);
  return {
    in_short: inShort.map(item),
    what_you_found: found.map(item).sort(byDate),
    open_ends: questions.map(item).sort(byDate),
  };
}

/** n central, varied sentences: from notes and chats first, then daily notes if those are too few. */
function pickFrom(list: Sentence[], centre: Vec, n: number): Sentence[] {
  const main = list.filter((s) => !s.daily);
  const picked = pickDiverse(main, centre, n).map((i) => main[i]!);
  if (picked.length >= n) return picked;
  const daily = list.filter((s) => s.daily);
  return [...picked, ...pickDiverse(daily, centre, n - picked.length).map((i) => daily[i]!)];
}

interface HubDraft {
  group: Group;
  entryIds: number[];
  sentences: Sentence[];
  name: string;
  /** Every unit with an entry in the hub, in record order, and their sub-groups with keyword names. */
  units: Unit[];
  sub: SubGroups;
  partNames: string[];
}

const MODEL_SENTENCES = 24;

function hubRequest(draft: HubDraft, n: number, of: number): { request: ModelRequest; shown: Sentence[] } {
  const purpose = `hub ${n} of ${of}`;
  const shown = [...draft.sentences]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MODEL_SENTENCES)
    .sort((a, b) => a.date.localeCompare(b.date) || a.entryId - b.entryId);
  const known = new Map(shown.map((s, i) => [`S${i + 1}`, i]));
  const lines = shown.map((s, i) => `S${i + 1} (${s.date}): ${s.text}`);
  const parts = draft.sub.parts.length > 1 ? draft.partNames : [];
  const user = [
    'Sentences from my notes and chats about one subject, oldest first:',
    ...lines,
    ...(parts.length ? ['', 'The subject falls into these parts, each with its key words:', ...parts.map((p, i) => `P${i + 1}: ${p}`)] : []),
    '',
    'Answer with JSON only, in this shape:',
    `{"name": "...", "in_short": [{"text": "...", "cites": ["S1"]}], "found": ["S2"], "open_ends": [{"text": "...", "cites": ["S3"]}]${parts.length ? ', "parts": [{"part": "P1", "name": "..."}]' : ''}}`,
    '- name: the subject, in 1 to 4 words.',
    '- in_short: 2 or 3 plain sentences on what the subject is and where it stands now, each citing the sentences it rests on.',
    '- found: up to 5 sentence ids that record something learned, decided or settled.',
    '- open_ends: up to 5 questions still open, each citing the sentences that raise it; [] if none.',
    ...(parts.length ? ['- parts: a name for each part, in 1 to 3 words, no two alike.'] : []),
    'Use only what the sentences say.',
  ].join('\n');
  const check = (answer: unknown) => {
    if (!isRecord(answer)) invalid(purpose, 'expected a JSON object');
    const name = text(purpose, answer.name, 'name', 80);
    const points = (field: string, min: number, max: number) => {
      const items = list(purpose, answer[field], field);
      if (items.length < min || items.length > max) invalid(purpose, `"${field}" needs ${min} to ${max} items`);
      return items.map((it) => {
        if (!isRecord(it)) invalid(purpose, `each "${field}" item must be an object`);
        const cites = cited(purpose, it.cites, `${field}.cites`, 'S', known);
        if (!cites.length) invalid(purpose, `each "${field}" item must cite a sentence`);
        return { text: text(purpose, it.text, `${field}.text`, 400), cites };
      });
    };
    const inShort = points('in_short', 1, 5);
    const openEnds = points('open_ends', 0, 8);
    const found = cited(purpose, answer.found, 'found', 'S', known);
    if (found.length > 8) invalid(purpose, '"found" lists more than 8 sentences');
    return { name, inShort, openEnds, found, parts: partAnswer(purpose, answer.parts, parts.length) };
  };
  return { request: { purpose, system: SYSTEM, user, maxTokens: 900 + 16 * parts.length, check }, shown };
}

/**
 * A model's names for a hub's parts, by part. A part it leaves out, names twice or names badly keeps its keyword name,
 * so a weak answer here never costs the hub its sections.
 */
function partAnswer(purpose: string, value: unknown, n: number): (string | undefined)[] {
  const names = new Array<string | undefined>(n);
  if (!n || !Array.isArray(value)) return names;
  const taken = new Set<string>();
  for (const it of value) {
    if (!isRecord(it)) continue;
    const m = /^P?(\d+)$/i.exec(String(it.part ?? '').trim());
    const i = m ? Number(m[1]) - 1 : -1;
    if (i < 0 || i >= n || names[i] !== undefined) continue;
    let name: string;
    try {
      name = text(purpose, it.name, 'parts.name', 60);
    } catch {
      continue;
    }
    if (!name || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    names[i] = name;
  }
  return names;
}

const SYSTEM =
  "You organise one person's own notes and chats into a second brain. You only use what their sentences say, and you answer with JSON only.";

type HubAnswer = {
  name: string;
  inShort: { text: string; cites: number[] }[];
  openEnds: { text: string; cites: number[] }[];
  found: number[];
  parts?: (string | undefined)[];
};

/** The share of a model's sentence that the sentences it cites must hold, for it to stand under their entries. */
const MIN_SUPPORT = 0.5;
/** Web and mail addresses, and bare domains ("pension-help.example"). */
const ADDRESS = /https?:\/\/[^\s)>\]]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

/**
 * Whether the sentences a model cites hold what it wrote: at least half of its words, and every address in it. A line
 * that borrows from sentences it doesn't cite would credit the cited entries with words they never held (H1).
 */
export function supported(text: string, cited: readonly string[]): boolean {
  const have = cited.join('\n').toLowerCase();
  for (const m of text.toLowerCase().matchAll(ADDRESS)) if (!have.includes(m[0])) return false;
  const words = new Set(tokenize(text));
  if (!words.size) return false;
  const known = new Set(tokenize(have));
  let held = 0;
  for (const w of words) if (known.has(w)) held++;
  return held / words.size >= MIN_SUPPORT;
}

/**
 * The model's sections, keeping only the lines its cited sentences support. If none of In short survives, the No-AI
 * picks stand in, so a hub is never left without it.
 */
function modelSections(answer: HubAnswer, shown: Sentence[], fallback: () => HubItem[]): { sections: HubSections; dropped: number } {
  let dropped = 0;
  const points = (list: { text: string; cites: number[] }[]): HubItem[] =>
    list.flatMap((p) => {
      if (!supported(p.text, p.cites.map((i) => shown[i]!.text))) {
        dropped++;
        return [];
      }
      const first = shown[p.cites[0]!]!;
      return [{ text: p.text, entryId: first.entryId, date: first.date, cites: [...new Set(p.cites.map((i) => shown[i]!.entryId))] }];
    });
  const inShort = points(answer.inShort);
  return {
    sections: {
      in_short: inShort.length ? inShort : fallback(),
      what_you_found: answer.found.map((i) => item(shown[i]!)).sort(byDate),
      open_ends: points(answer.openEnds).sort(byDate),
    },
    dropped,
  };
}

export function planHubs(ctx: TaskContext): Plan {
  const { record } = ctx;
  const existing: Existing[] =
    ctx.scope.kind === 'new' ? liveHubs(ctx.db).map((h) => ({ id: h.id, name: h.name, entryIds: hubEntryIds(ctx.db, h.id) })) : [];
  const { groups, loose } = groupUnits(record, ctx.entries, existing);
  const drafts: HubDraft[] = [];
  let skipped = 0;
  const future = new Set<number>();
  for (const group of groups) {
    const ids = new Set([...(group.existing?.entryIds ?? []), ...group.entries.map((e) => e.id)]);
    const entries = [...ids].map((id) => record.byId.get(id)).filter((e): e is Entry => !!e);
    // A dated-ahead entry stays in the hub's list of entries, but nothing in its sections quotes or cites it.
    const quotable = entries.filter((e) => {
      if (vouched(e, ctx.now)) return true;
      future.add(e.id);
      return false;
    });
    const list = yourSentences(record, quotable, group.centroid);
    if (!list.length) {
      skipped++;
      continue;
    }
    const name = group.existing?.name ?? groupName(record, group, 3);
    const units = [...new Set(entries.map((e) => record.unitOf(e.id)).filter((u): u is Unit => !!u))].sort((a, b) => a.pos - b.pos);
    const sub = subGroups(record, units);
    const partNamesOf = partNames(record, units, sub.parts.map((p) => p.units));
    drafts.push({ group, entryIds: entries.map((e) => e.id), sentences: list, name, units, sub, partNames: partNamesOf });
  }
  const places = draftPlaces(ctx, drafts);
  const partPlaces = drafts.map((d) => placeParts(d.sub.parts.map((p) => ({ centroid: p.centroid, size: p.units.length }))));

  const asks = ctx.model ? drafts.map((d, i) => hubRequest(d, i + 1, drafts.length)) : [];
  return {
    requests: asks.map((a) => a.request),
    // A hub without the model's answer gets its No-AI name and sections.
    fallback: () => null,
    finish: (answers) => {
      let unsupported = 0;
      const hubs = drafts.map((d, i) => {
        const extracted = () => extractSections(d.sentences, d.group.centroid);
        const answer = ctx.model ? (answers[i] as HubAnswer | null) : null;
        const atlas = { place: places[i]!, parts: atlasParts(d, partPlaces[i]!, answer?.parts) };
        if (!answer) return { draft: d, name: d.name, sections: extracted(), atlas };
        const made = modelSections(answer, asks[i]!.shown, () => extracted().in_short);
        unsupported += made.dropped;
        return { draft: d, name: d.group.existing ? d.name : answer.name, sections: made.sections, atlas };
      });
      const updated = hubs.filter((h) => h.draft.group.existing).length;
      const notes = [
        skipped ? `${skipped} group(s) held none of your own sentences, so they got no hub.` : '',
        future.size ? `${future.size} entr${future.size > 1 ? 'ies claim dates' : 'y claims a date'} after today, so no hub summary quotes ${future.size > 1 ? 'them' : 'it'}.` : '',
        unsupported ? `${unsupported} model line(s) said more than the sentences they cited, so they were left out.` : '',
      ].filter(Boolean);
      return {
        counts: {
          hubs: hubs.length - updated,
          updated,
          entries: hubs.reduce((n, h) => n + h.draft.entryIds.length, 0),
          loose: loose.length,
          skipped,
          ...(future.size ? { future: future.size } : {}),
          ...(unsupported ? { unsupported } : {}),
        },
        ...(notes.length ? { message: notes.join(' ') } : {}),
        save: (db, runId) => {
          for (const h of hubs) saveHub(db, runId, record, h.name, h.sections, h.draft, h.atlas);
        },
      };
    },
  };
}

/** A model's part names where it gave good ones, keyword names for the rest; and where each part sits in the hub. */
function atlasParts(draft: HubDraft, places: Place[], named: (string | undefined)[] | undefined): Part[] {
  const taken = new Set((named ?? []).filter((n): n is string => !!n).map((n) => n.toLowerCase()));
  return draft.sub.parts.map((_, p) => {
    let name = named?.[p];
    if (!name) {
      name = draft.partNames[p]!;
      // A keyword name the model gave to another part gets its number, so names stay apart.
      if (taken.has(name.toLowerCase())) name = `${name} ${p + 1}`;
    }
    return { name, x: places[p]!.x, y: places[p]!.y };
  });
}

/** Share of entries two hubs must have in common (of all in either) for a new hub to take an old one's place. */
const SAME_PLACE = 0.4;

/**
 * Where each drafted hub goes on the map. A hub a run over new entries updates keeps its place. A run over everything
 * makes every hub afresh, so each new hub takes the place of the live hub it shares most of its entries with (one
 * each, while they share at least SAME_PLACE). The rest go to the coast, beside every other placed hub; with nothing
 * placed yet, MDS places them all.
 */
function draftPlaces(ctx: TaskContext, drafts: HubDraft[]): Place[] {
  const { record } = ctx;
  const placed = hubPlaces(ctx.db);
  const kept: (Place | null)[] = drafts.map(() => null);
  const others: { centre: Vec; size: number; kept: Place }[] = [];
  if (ctx.scope.kind === 'new') {
    const drafted = new Set<number>();
    drafts.forEach((d, i) => {
      if (!d.group.existing) return;
      drafted.add(d.group.existing.id);
      kept[i] = placed.get(d.group.existing.id) ?? null;
    });
    // The live hubs this run leaves alone stay on the map, so new hubs must find room beside them.
    for (const [id, place] of placed) {
      if (drafted.has(id)) continue;
      const units = new Set(hubEntryIds(ctx.db, id).map((e) => record.unitOf(e)).filter((u): u is Unit => !!u));
      if (units.size) others.push({ centre: centroid([...units].map((u) => record.unitVector(u))), size: units.size, kept: place });
    }
  } else if (placed.size) {
    const owner = new Map<number, number>();
    const sizes = new Map<number, number>();
    for (const id of placed.keys()) {
      const ids = hubEntryIds(ctx.db, id);
      sizes.set(id, ids.length);
      for (const e of ids) owner.set(e, id);
    }
    const pairs: { d: number; hub: number; share: number }[] = [];
    drafts.forEach((d, i) => {
      const shared = new Map<number, number>();
      for (const e of d.entryIds) {
        const hub = owner.get(e);
        if (hub !== undefined) shared.set(hub, (shared.get(hub) ?? 0) + 1);
      }
      for (const [hub, n] of shared) pairs.push({ d: i, hub, share: n / (d.entryIds.length + sizes.get(hub)! - n) });
    });
    pairs.sort((a, b) => b.share - a.share || a.d - b.d || a.hub - b.hub);
    const took = new Set<number>();
    for (const p of pairs) {
      if (p.share < SAME_PLACE) break;
      if (kept[p.d] || took.has(p.hub)) continue;
      kept[p.d] = placed.get(p.hub)!;
      took.add(p.hub);
    }
  }
  const all = [...drafts.map((d, i) => ({ centre: d.group.centroid, size: d.entryIds.length, kept: kept[i]! })), ...others];
  return placeHubs(all).slice(0, drafts.length);
}

function saveHub(
  db: DatabaseSync,
  runId: number,
  record: RecordView,
  name: string,
  sections: HubSections,
  draft: HubDraft,
  atlas: { place: Place; parts: Part[] },
): void {
  const res = db
    .prepare('INSERT INTO hubs (name, sections, run_id, replaces, place_x, place_y, parts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, JSON.stringify(sections), runId, draft.group.existing?.id ?? null, atlas.place.x, atlas.place.y, JSON.stringify(atlas.parts));
  const hubId = Number(res.lastInsertRowid);
  const insert = db.prepare('INSERT INTO hub_entries (hub_id, entry_id, run_id, score, part) VALUES (?, ?, ?, ?, ?)');
  for (const id of draft.entryIds) {
    const unit = record.unitOf(id);
    insert.run(
      hubId,
      id,
      runId,
      unit ? round(cosine(record.unitVector(unit), draft.group.centroid)) : 0,
      unit ? (draft.sub.partOf.get(unit.key) ?? 0) : 0,
    );
  }
}
