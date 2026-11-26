// The tag task, one schema at a time. Topics come from groups of related entries; Projects are notes you link to from
// two or more entries; Moods and your own schemas tag an entry when its words match a tag's name or description. With
// a model, it names the topics and settles the entries that match a tag by one word only.

import type { DatabaseSync } from 'node:sqlite';
import { withoutNoteExt } from '../importers/note-ext.ts';
import { safeLine } from '../safe-text.ts';
import type { Entry } from '../store/store.ts';
import { type Existing, type Group, groupName, groupUnits, namingRequest } from './groups.ts';
import { invalid, isRecord, list, type ModelRequest, noRequest, type Plan, type Product, round, type TaskContext } from './plan.ts';
import { isDailyNote, linkTargets, type RecordView } from './record.ts';
import { replacedRuns } from './runs.ts';
import { cosine, stem, tokenize } from './text.ts';
import { definedTags, liveTags, type Schema } from './views.ts';

interface Tagging {
  entryId: number;
  /** The tag's name; rows are matched by name, case-insensitively. */
  name: string;
  score: number;
}

interface NewTag {
  name: string;
  description: string;
  /** Set for a tag you defined; a run makes its own row for Topics and Projects. */
  definedId?: number;
}

export function planTags(ctx: TaskContext, schema: Schema): Plan {
  if (schema.builtin && schema.name === 'Topics') return planTopics(ctx, schema);
  if (schema.builtin && schema.name === 'Projects') return planProjects(ctx, schema);
  return planDefined(ctx, schema);
}

// Topics

function planTopics(ctx: TaskContext, schema: Schema): Plan {
  const { record } = ctx;
  const live = ctx.scope.kind === 'new' ? liveTags(ctx.db, schema.id) : [];
  const existing: Existing[] = live.map((t) => ({ id: t.ids[0]!, name: t.name, entryIds: t.entryIds }));
  const { groups } = groupUnits(record, ctx.entries, existing);
  const fresh = groups.filter((g) => !g.existing);
  const request = ctx.model && fresh.length ? namingRequest(record, fresh, 'topic', 'one or two words', 'topic names') : undefined;
  const given = frontMatterTags(ctx.db, ctx.entries);
  const noModelNames = () => uniqueNames(record, fresh, live.map((t) => t.name));
  return {
    requests: request ? [request] : [],
    fallback: noModelNames,
    finish: (answers) => {
      const names = request ? (answers[0] as string[]) : noModelNames();
      const tags: NewTag[] = [];
      const taggings: Tagging[] = [];
      for (const g of groups) {
        const name = g.existing?.name ?? names[fresh.indexOf(g)]!;
        tags.push({ name, description: `Words: ${groupName(record, g, 6)}.` });
        for (const e of g.entries) taggings.push({ entryId: e.id, name, score: unitScore(record, g, e) });
      }
      // A note's own tags join the topics as written, with or without a model; one a topic already has joins that topic.
      const named = new Set(tags.map((t) => t.name.toLowerCase()));
      for (const t of given) {
        if (!named.has(t.name.toLowerCase())) tags.push({ name: t.name, description: FROM_FRONT_MATTER });
        named.add(t.name.toLowerCase());
        taggings.push(t);
      }
      return product(ctx, schema, tags, taggings);
    },
  };
}

const FROM_FRONT_MATTER = "Tagged in the notes' front matter.";
/** As long as a topic's name may be (a model's answer is held to the same). */
const TAG_MAX = 60;

/**
 * The tags each entry's newest version gives in its front matter, taken as written. Notes keep their front matter as
 * properties (b8aef58); only the tag task turns them into tags, so they show wherever tags do and go when its run is
 * undone.
 */
function frontMatterTags(db: DatabaseSync, entries: Entry[]): Tagging[] {
  if (!entries.length) return [];
  // Only the entries in scope are read: a run over a hundred new entries used to read every note's properties.
  const rows = db
    .prepare(
      `SELECT e.id, v.properties FROM entries e JOIN versions v ON v.entry_id = e.id AND v.version = e.version
       WHERE v.properties IS NOT NULL AND e.id IN (SELECT value FROM json_each(?)) ORDER BY e.id`,
    )
    .all(JSON.stringify(entries.map((e) => e.id))) as { id: number; properties: string }[];
  const out: Tagging[] = [];
  for (const r of rows) {
    for (const name of frontMatterTagNames(JSON.parse(r.properties) as Record<string, unknown>)) out.push({ entryId: r.id, name, score: 1 });
  }
  return out;
}

/**
 * The tags in a note's front matter: `tags`, else `tag` (older Obsidian vaults), whichever first names one, so a blank
 * `tags:` line doesn't hide a `tag:` key. A list is read item by item and a line split at commas and spaces, as
 * Obsidian reads them. A leading # goes, controls go (`safeLine`), and a name longer than a topic's is left out. Keys
 * match in any case; names keep their own and count once.
 */
export function frontMatterTagNames(properties: Record<string, unknown>): string[] {
  for (const want of ['tags', 'tag']) {
    for (const key of Object.keys(properties).filter((k) => k.toLowerCase() === want)) {
      const value = properties[key];
      const items: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
      const seen = new Set<string>();
      const names: string[] = [];
      for (const item of items) {
        if (typeof item !== 'string') continue;
        const name = safeLine(item).trim().replace(/^#+/, '').trim();
        if (!name || name.length > TAG_MAX || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        names.push(name);
      }
      if (names.length) return names;
    }
  }
  return [];
}

/** One word per topic, each used once: the group's best word that no other topic has taken. */
function uniqueNames(record: RecordView, groups: Group[], taken: string[]): string[] {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  return groups.map((g, i) => {
    const pick = record
      .nameTerms(g.units, 8)
      .map((t) => record.shown(t))
      .find((w) => !used.has(w.toLowerCase()));
    const name = pick ?? `topic ${i + 1}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function unitScore(record: RecordView, group: Group, e: Entry): number {
  const unit = record.unitOf(e.id);
  return unit ? round(cosine(record.unitVector(unit), group.centroid)) : 0;
}

// Projects

/** Notes linked from at least this many other entries count as projects. */
const PROJECT_LINKS = 2;
/** At most this many projects: the most linked notes, on a tie the one that came into the record first. */
export const PROJECT_MAX = 50;

function planProjects(ctx: TaskContext, schema: Schema): Plan {
  const { record } = ctx;
  const linkers = new Map<number, Set<number>>();
  for (const e of record.entries) {
    for (const target of linkTargets(e.body)) {
      const note = record.resolveLink(target);
      if (!note || note.id === e.id) continue;
      if (!linkers.has(note.id)) linkers.set(note.id, new Set());
      linkers.get(note.id)!.add(e.id);
    }
  }
  // A daily note is a log of the day, not a project, even when the days around it link to it.
  const projects = [...linkers]
    .filter(([, from]) => from.size >= PROJECT_LINKS)
    .map(([noteId, from]) => ({ note: record.byId.get(noteId)!, from }))
    .filter(({ note }) => !isDailyNote(note))
    .sort((a, b) => a.note.id - b.note.id);
  const tags: NewTag[] = [];
  const taggings: Tagging[] = [];
  const seen = new Set<string>();
  const named: { note: Entry; from: Set<number>; name: string }[] = [];
  for (const { note, from } of projects) {
    const name = projectName(note);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    named.push({ note, from, name });
  }
  // A record that links freely would otherwise make most of its notes projects (3,956 of the bench's 5,000 notes): keep
  // the most linked, then go on in note order as before.
  const kept = new Set(
    [...named]
      .sort((a, b) => b.from.size - a.from.size || a.note.id - b.note.id)
      .slice(0, PROJECT_MAX)
      .map((p) => p.note.id),
  );
  const chosen = named.filter((p) => kept.has(p.note.id));
  // Each entry is read once, for every name at a time: reading every entry again for each project took most of an hour
  // at 50,000 entries.
  const position = new Map(ctx.entries.map((e, i) => [e.id, i]));
  const uses = nameUses(record.entries, chosen.map((p) => p.name), position);
  chosen.forEach(({ note, from, name }, k) => {
    tags.push({ name, description: `The note "${name}", linked from ${from.size} entries.` });
    const linked = [note.id, ...from].flatMap((id) => (position.has(id) ? [position.get(id)!] : []));
    const matched = stands(uses[k]!, record.entries.length) ? uses[k]!.inScope : [];
    for (const i of [...new Set([...linked, ...matched])].sort((a, b) => a - b)) {
      const e = ctx.entries[i]!;
      taggings.push({ entryId: e.id, name, score: e.id === note.id || from.has(e.id) ? 1 : 0.8 });
    }
  });
  return { requests: [], fallback: noRequest, finish: () => product(ctx, schema, tags, taggings) };
}

function projectName(note: Entry): string {
  return (note.title ?? withoutNoteExt(note.externalId.split('/').pop()!)).trim();
}

// Moods and your own schemas

/** Entries sent to a model in one request when it settles one-word matches. */
const UNSURE_BATCH = 20;
const EXCERPT = 300;

interface TagWords {
  tag: NewTag & { definedId: number };
  name: string[];
  words: string[];
}

function planDefined(ctx: TaskContext, schema: Schema): Plan {
  const defined = definedTags(ctx.db, schema.id);
  const tagWords: TagWords[] = defined.map((t) => {
    const name = [...new Set(tokenize(t.name))];
    return { tag: { name: t.name, description: t.description, definedId: t.id }, name, words: [...new Set(tokenize(t.description))].filter((w) => !name.includes(w)) };
  });
  // Moods are about how you sound, so only your own words count; your own schemas look at every entry.
  const entries = schema.builtin ? ctx.entries.filter((e) => e.speaker === 'you') : ctx.entries;
  const sure: Tagging[] = [];
  const unsure: { entry: Entry; tags: string[] }[] = [];
  for (const e of entries) {
    const stems = stemSet(e);
    const maybe: string[] = [];
    for (const t of tagWords) {
      const hits = t.words.filter((w) => stems.has(w)).length;
      if ((t.name.length && hasAll(stems, t.name)) || hits >= 2) {
        sure.push({ entryId: e.id, name: t.tag.name, score: round(Math.min(1, (hits + (hasAll(stems, t.name) ? 2 : 0)) / 4)) });
      } else if (hits === 1) maybe.push(t.tag.name);
    }
    if (maybe.length) unsure.push({ entry: e, tags: maybe });
  }
  const batches: (typeof unsure)[] = [];
  if (ctx.model) for (let i = 0; i < unsure.length; i += UNSURE_BATCH) batches.push(unsure.slice(i, i + UNSURE_BATCH));
  const requests = batches.map((b, i) => unsureRequest(schema, b, `${schema.name} check ${i + 1} of ${batches.length}`));
  return {
    requests,
    // Without the model, an entry that matched a tag by one word stays untagged.
    fallback: () => [],
    finish: (answers) => {
      const taggings = [...sure];
      answers.forEach((a) => taggings.push(...(a as Tagging[])));
      const message = ctx.model
        ? undefined
        : unsure.length
          ? `${unsure.length} entries matched a tag by one word only and were left untagged; a model can settle them.`
          : undefined;
      return product(ctx, schema, tagWords.map((t) => t.tag), taggings, message);
    },
  };
}

function unsureRequest(schema: Schema, batch: { entry: Entry; tags: string[] }[], purpose: string): ModelRequest {
  const known = new Map(batch.map((b) => [`E${b.entry.id}`, b]));
  const lines = batch.map((b) => `E${b.entry.id} [could be: ${b.tags.join(', ')}]: ${b.entry.body.replace(/\s+/g, ' ').slice(0, EXCERPT)}`);
  const user = [
    `Tags from my "${schema.name}" list. ${schema.description}`,
    'For each entry, say which of the tags it could be really fit it. Pick none if none fit.',
    ...lines,
    '',
    'Answer with JSON only: {"entries": [{"id": "E1", "tags": ["..."]}]}, one item per entry.',
  ].join('\n');
  const check = (answer: unknown): Tagging[] => {
    if (!isRecord(answer)) invalid(purpose, 'expected a JSON object');
    const out: Tagging[] = [];
    const answered = new Set<string>();
    for (const it of list(purpose, answer.entries, 'entries')) {
      if (!isRecord(it)) invalid(purpose, 'each "entries" item must be an object');
      const id = String(it.id ?? '').trim().toUpperCase();
      const b = known.get(/^\d+$/.test(id) ? `E${id}` : id);
      if (!b) invalid(purpose, `answers for an entry it wasn't shown: ${JSON.stringify(it.id)}`);
      answered.add(`E${b.entry.id}`);
      for (const t of list(purpose, it.tags, 'tags')) {
        const name = b.tags.find((x) => x.toLowerCase() === String(t).trim().toLowerCase());
        if (!name) invalid(purpose, `gives E${b.entry.id} the tag ${JSON.stringify(t)}, which wasn't one of its choices`);
        out.push({ entryId: b.entry.id, name, score: 0.5 });
      }
    }
    const missing = [...known.keys()].filter((k) => !answered.has(k));
    if (missing.length) invalid(purpose, `gives no answer for ${missing.join(', ')}`);
    return out;
  };
  return { purpose, system: "You tag one person's own notes and chats. You answer with JSON only.", user, maxTokens: 30 + 25 * batch.length, check };
}

// Saving and counting

function product(ctx: TaskContext, schema: Schema, tags: NewTag[], taggings: Tagging[], message?: string): Product {
  // A Projects run can make over a million taggings at 50,000 entries, so no step keeps a string per pair: one key
  // string per tagging, twice over, took `run all` past its memory budget.
  const best = dedupe(taggings);
  const unique = ordered(best, taggings);
  const taggedIds = [...new Set(unique.map((t) => t.entryId))];
  // Only the entries this run tags can have an unchanged pair, so a scoped run reads just theirs. A run over the whole
  // record reads every pair either way, without the list of ids.
  const live = livePairs(ctx.db, schema.id, null, ctx.scope.kind === 'all' ? null : taggedIds);
  const replaced = livePairs(ctx.db, schema.id, replacedRuns(ctx.db, 'tag', schema.id, ctx.scope), null);
  const used = new Set(best.keys());
  const tagged = taggedIds.length;
  let unchanged = 0;
  for (const [name, ids] of live) {
    const byEntry = best.get(name);
    if (byEntry) for (const id of ids) if (byEntry.has(id)) unchanged++;
  }
  let removed = 0;
  for (const [name, ids] of replaced) {
    const byEntry = best.get(name);
    for (const id of ids) if (!byEntry?.has(id)) removed++;
  }
  return {
    counts: {
      entries: ctx.entries.length,
      tagged,
      coverage: ctx.entries.length ? Math.round((100 * tagged) / ctx.entries.length) : 0,
      tags: used.size,
      added: unique.length - unchanged,
      removed,
      unchanged,
    },
    ...(message ? { message } : {}),
    save: (db, runId) => {
      const ids = new Map<string, number>();
      for (const t of tags) {
        if (!used.has(t.name.toLowerCase())) continue;
        const id =
          t.definedId ??
          Number(
            db.prepare('INSERT INTO tags (schema_id, name, description, run_id) VALUES (?, ?, ?, ?)').run(schema.id, t.name, t.description, runId)
              .lastInsertRowid,
          );
        ids.set(t.name.toLowerCase(), id);
      }
      const insert = db.prepare('INSERT INTO entry_tags (entry_id, tag_id, run_id, score) VALUES (?, ?, ?, ?)');
      const lower = lowerCase();
      for (const t of unique) insert.run(t.entryId, ids.get(lower(t.name))!, runId, t.score);
    },
  };
}

/** The best-scored tagging of each entry and tag name (lowercased), the first of equals kept, by name then entry. */
function dedupe(taggings: Tagging[]): Map<string, Map<number, Tagging>> {
  const best = new Map<string, Map<number, Tagging>>();
  const lower = lowerCase();
  for (const t of taggings) {
    const name = lower(t.name);
    let byEntry = best.get(name);
    if (!byEntry) best.set(name, (byEntry = new Map()));
    const had = byEntry.get(t.entryId);
    if (!had || t.score > had.score) byEntry.set(t.entryId, t);
  }
  return best;
}

/**
 * The taggings by entry, then by name as localeCompare orders it: the order the save has always used. One comparison
 * per name rather than per pair. When two different names compare equal, the old sort's tie order (the order the pairs
 * were first seen) decides, so that case sorts the old way.
 */
function ordered(best: Map<string, Map<number, Tagging>>, taggings: Tagging[]): Tagging[] {
  const all: Tagging[] = [];
  for (const byEntry of best.values()) for (const t of byEntry.values()) all.push(t);
  const names = [...new Set(all.map((t) => t.name))].sort((a, b) => a.localeCompare(b));
  if (names.some((name, i) => i > 0 && names[i - 1]!.localeCompare(name) === 0)) {
    const seen = new Set<string>();
    const lower = lowerCase();
    const inOrder = taggings.flatMap((t) => (seen.has(pairKey(t)) ? [] : (seen.add(pairKey(t)), [best.get(lower(t.name))!.get(t.entryId)!])));
    return inOrder.sort((a, b) => a.entryId - b.entryId || a.name.localeCompare(b.name));
  }
  const rank = new Map(names.map((name, i) => [name, i]));
  return all.sort((a, b) => a.entryId - b.entryId || rank.get(a.name)! - rank.get(b.name)!);
}

/** toLowerCase, remembered per name: a run's taggings share a few thousand names. */
function lowerCase(): (name: string) => string {
  const seen = new Map<string, string>();
  return (name) => {
    let low = seen.get(name);
    if (low === undefined) seen.set(name, (low = name.toLowerCase()));
    return low;
  };
}

const pairKey = (t: { entryId: number; name: string }) => `${t.entryId}:${t.name.toLowerCase()}`;

/**
 * The entry and tag-name pairs from live runs of a schema (with runIds, from those runs only; with entryIds, of those
 * entries only), as entry ids by lowercased tag name. Rows are read one at a time and hold two numbers, and each tag's
 * name is lowercased once: the record can hold over a million pairs (12.7 million at 150,000 entries), and a row
 * object and a key string for each took organising new entries past node's heap.
 */
function livePairs(db: DatabaseSync, schemaId: number, runIds: number[] | null, entryIds: number[] | null): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  if ((runIds && !runIds.length) || (entryIds && !entryIds.length)) return out;
  const names = new Map<number, string>();
  for (const t of db.prepare('SELECT id, name FROM tags WHERE schema_id = ?').iterate(schemaId) as Iterable<{ id: number; name: string }>) {
    names.set(t.id, t.name.toLowerCase());
  }
  const runs = runIds ? `(${runIds.join(',')})` : '(SELECT id FROM live_runs)';
  const only = entryIds ? ' AND et.entry_id IN (SELECT value FROM json_each(?))' : '';
  const read = db.prepare(
    `SELECT et.entry_id AS entryId, et.tag_id AS tagId FROM entry_tags et JOIN tags t ON t.id = et.tag_id
     WHERE t.schema_id = ? AND et.run_id IN ${runs}${only}`,
  );
  const rows = (entryIds ? read.iterate(schemaId, JSON.stringify(entryIds)) : read.iterate(schemaId)) as Iterable<{ entryId: number; tagId: number }>;
  for (const { entryId, tagId } of rows) {
    const name = names.get(tagId)!;
    let ids = out.get(name);
    if (!ids) out.set(name, (ids = new Set()));
    ids.add(entryId);
  }
  return out;
}

function stemSet(e: Entry): Set<string> {
  return new Set(tokenize(`${e.title ?? ''}\n${e.body}`));
}

/**
 * An entry that names a project without linking to it gets its tag only when the name stands out in the record: rare
 * (its words, side by side, in at most this share of entries) or written as a name (below).
 */
const RARE_SHARE = 0.005;
/** Written as a name: capitalised as the note's title writes it in at least this share of its uses mid-sentence... */
const NAME_SHARE = 0.8;
/** ...and in at least this many of them. */
const NAME_USES = 3;

/** How a record uses one project's name, its words side by side and in order. */
export interface NameUses {
  /** The name holds a word that isn't a stop word: one that doesn't can't name anything. */
  content: boolean;
  /** The title capitalises at least one of its words, so a use can be capitalised as the title writes it. */
  cased: boolean;
  /**
   * Entries whose title or body holds the name outside a [[link]]. A link copies the note's title as written, and the
   * entries that link to the note get its tag anyway, so links don't count toward whether a name stands out.
   */
  entries: number;
  /** Uses outside a link that open no sentence or line, where everything is capitalised. */
  mid: number;
  /** Of those, the uses that capitalise every word the title capitalises. */
  asTitle: number;
  /** Positions in scope of the entries that hold it, in a link or not, as they were met. */
  inScope: number[];
}

/** Whether entries that only name the project, without linking to it, get its tag. */
function stands(u: NameUses, total: number): boolean {
  if (!u.content) return false;
  const rare = u.entries <= RARE_SHARE * total;
  const asName = u.cased && u.mid >= NAME_USES && u.asTitle >= NAME_SHARE * u.mid;
  return rare || asName;
}

const WORD = /[\p{L}\p{N}]+/gu;
const LINK = /\[\[[^\]\n]*\]\]/g;
const APOSTROPHES = /['’]/g;

/** A name's words as the scan reads them, and which of them the title capitalises. */
interface NameWords {
  stems: string[];
  upper: boolean[];
}

/**
 * Every run of letters and digits, apostrophes dropped and stemmed as tokenize stems, so a name's words can be found
 * side by side. Unlike tokenize, it keeps stop words, numbers and one-letter words: they are part of a name. Without
 * the number, "Hiring note 4929" was every note called "Hiring note" and some number.
 */
function readName(name: string): NameWords {
  const stems: string[] = [];
  const upper: boolean[] = [];
  for (const w of name.replace(APOSTROPHES, '').match(WORD) ?? []) {
    stems.push(stem(w.toLowerCase()));
    upper.push(capital(w));
  }
  return { stems, upper };
}

/** Its first letter is a capital. */
function capital(w: string): boolean {
  const c = w.charCodeAt(0);
  if (c < 128) return c >= 65 && c <= 90;
  return w[0] !== w[0]!.toLowerCase();
}

/** At most this many words' stems are kept: a record of agent sessions holds hashes and paths by the hundred thousand. */
const STEMS_KEPT = 50_000;

interface Trie {
  next: Map<string, Trie>;
  /** The names that end here. */
  names: number[];
}

/**
 * How the record uses each of these names. A name's uses are counted over the whole record. The entries that hold it
 * are kept only for positions in scope.
 *
 * A run over a small part of the record first finds the names its own entries hold: no other name can tag anything.
 * Then it reads the record for those names alone, and only around their key words (see keyWords), so live's pass over
 * a few new entries doesn't read every word in the record. A name that no entry in scope holds keeps counts of 0.
 */
export function nameUses(entries: Entry[], names: string[], position: Map<number, number>): NameUses[] {
  const read = names.map(readName);
  const blank = () =>
    names.map((name, k): NameUses => ({ content: tokenize(name).length > 0, cased: read[k]!.upper.some(Boolean), entries: 0, mid: 0, asTitle: 0, inScope: [] }));
  const uses = blank();
  const named = uses.flatMap((u, k) => (u.content ? [k] : []));
  if (position.size * 2 >= entries.length) {
    countUses(entries, read, named, uses, position);
    return uses;
  }
  const probe = blank();
  countUses(
    entries.filter((e) => position.has(e.id)),
    read,
    named,
    probe,
    position,
  );
  const held = named.filter((k) => probe[k]!.inScope.length > 0);
  if (held.length) countUses(entries, read, held, uses, position, keyWords(read, held));
  return uses;
}

/** Where a name may be: a text that holds none of its key words holds none of these names. */
interface Keys {
  /** Tests a text as written, apostrophes and all. */
  text: RegExp;
  /** Finds each key in a text with its apostrophes taken out, at the start of a word or inside one. */
  hits: RegExp;
}

/**
 * One key word for each name: a number if the name has one, as the rarest word it has, or else its longest word. A
 * stem is the start of each lowercased word it stems from, but for "-ies" and "-ied" words (`flies` is `fly`), so the
 * key is the stem with a final y left off: every use of the name holds its key at the start of a word, in any case.
 * Undefined when a key isn't plain ASCII or is empty: every word is read then. For ASCII, the only letters
 * toLowerCase turns into a key's letter that the i flag doesn't fold to it are İ, which lowercases to i and a dot, so
 * an i also matches İ.
 */
function keyWords(read: NameWords[], ks: number[]): Keys | undefined {
  const keys = new Set<string>();
  for (const k of ks) {
    const stems = read[k]!.stems;
    const key = stems.find((s) => /\d/.test(s)) ?? stems.reduce((a, b) => (b.length > a.length ? b : a));
    keys.add(key.endsWith('y') ? key.slice(0, -1) : key);
  }
  if ([...keys].some((k) => !/^[a-z0-9]+$/.test(k))) return undefined;
  const pattern = (between: string) => [...keys].map((k) => [...k].map((c) => (c === 'i' ? '[iİ]' : c)).join(between)).join('|');
  return { text: new RegExp(pattern("['’]*"), 'iu'), hits: new RegExp(pattern(''), 'giu') };
}

/** Takes a code point back from `at`: its start, and whether it is a letter or a digit. */
function before(t: string, at: number): [number, boolean] {
  const c = t.charCodeAt(at - 1);
  if (c < 128) return [at - 1, (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)];
  const pair = c >= 0xdc00 && c <= 0xdfff && at >= 2 && t.charCodeAt(at - 2) >= 0xd800 && t.charCodeAt(at - 2) <= 0xdbff;
  const from = pair ? at - 2 : at - 1;
  return [from, LETTER.test(t.slice(from, at))];
}
const LETTER = /^[\p{L}\p{N}]$/u;

/** Whether the word starting at `at` opens the text, a line or a sentence: \n . ! or ? since the word before it. */
function opensAt(t: string, at: number): boolean {
  for (let j = at; j > 0; ) {
    const c = t.charCodeAt(j - 1);
    if (c === 10 || c === 46 || c === 33 || c === 63) return true;
    const [from, letter] = before(t, j);
    if (letter) return false;
    j = from;
  }
  return true;
}

/** The start of the word n words back from the word starting at `at`, or of the text's first word. */
function wordsBack(t: string, at: number, n: number): number {
  let start = at;
  for (let w = 0; w < n; w++) {
    let j = start;
    let letter = false;
    while (j > 0 && !letter) [j, letter] = before(t, j);
    if (!letter) return start;
    for (let from = j; from > 0; j = from) {
      [from, letter] = before(t, j);
      if (!letter) break;
    }
    start = j;
  }
  return start;
}

/**
 * Counts the uses of names ks into uses, reading each entry's title and body word by word. No per-word objects are
 * kept: one per word, across a whole record, held hundreds of megabytes at 50,000 entries. A ring holds the last few
 * words' flags, and the names being followed are trie nodes with the word they started at.
 *
 * With keys, it reads only the words around each key word: a name's use holds its key word, so it lies within as many
 * words of it as the longest name has. Windows that overlap are read as one, so no use is counted twice.
 */
function countUses(entries: Entry[], read: NameWords[], ks: number[], uses: NameUses[], position: Map<number, number>, keys?: Keys): void {
  const root: Trie = { next: new Map(), names: [] };
  let depth = 1;
  for (const k of ks) {
    let node = root;
    for (const s of read[k]!.stems) {
      let child = node.next.get(s);
      if (!child) node.next.set(s, (child = { next: new Map(), names: [] }));
      node = child;
    }
    node.names.push(k);
    depth = Math.max(depth, read[k]!.stems.length);
  }
  const CAPITAL = 1;
  const OPENS = 2; // the text, a line or a sentence
  const LINKED = 4; // inside a [[link]], which copies the note's title as written
  const ring = new Uint8Array(depth);
  const nodes: Trie[] = [];
  const starts = new Int32Array(depth + 1);
  const last = new Int32Array(read.length).fill(-1);
  const counted = new Int32Array(read.length).fill(-1);
  // A word's stem, by the word as written: most words come back again and again.
  const stems = new Map<string, string>();
  // Regexes of this call's own: a global regex keeps where its last exec stopped, and the next call would start there.
  const word = new RegExp(WORD.source, 'gu');
  const ahead = new RegExp(WORD.source, 'gu');
  const links = new RegExp(LINK.source, 'g');
  entries.forEach((e, r) => {
    for (const text of [e.title ?? '', e.body]) {
      if (keys && !keys.text.test(text)) continue;
      const t = text.replace(APOSTROPHES, '');
      links.lastIndex = 0;
      let link = links.exec(t);
      let active = 0;
      let i = 0;
      const visit = (m: RegExpExecArray) => {
        const w = m[0];
        while (link && link.index + link[0].length <= m.index) link = links.exec(t);
        ring[i % depth] = (capital(w) ? CAPITAL : 0) | (opensAt(t, m.index) ? OPENS : 0) | (link && m.index >= link.index ? LINKED : 0);
        let s = stems.get(w);
        if (s === undefined) {
          if (stems.size >= STEMS_KEPT) stems.clear();
          stems.set(w, (s = stem(w.toLowerCase())));
        }
        let kept = 0;
        for (let a = 0; a < active; a++) {
          const next = nodes[a]!.next.get(s);
          if (next) (nodes[kept] = next), (starts[kept++] = starts[a]!);
        }
        const first = root.next.get(s);
        if (first) (nodes[kept] = first), (starts[kept++] = i);
        active = kept;
        for (let a = 0; a < active; a++) {
          const start = starts[a]!;
          for (const k of nodes[a]!.names) {
            const u = uses[k]!;
            if (last[k] !== r) {
              last[k] = r;
              const at = position.get(e.id);
              if (at !== undefined) u.inScope.push(at);
            }
            const flags = ring[start % depth]!;
            if (flags & LINKED) continue;
            if (counted[k] !== r) (counted[k] = r), u.entries++;
            if (flags & OPENS) continue;
            u.mid++;
            if (read[k]!.upper.every((up, j) => !up || ring[(start + j) % depth]! & CAPITAL)) u.asTitle++;
          }
        }
        i++;
      };
      word.lastIndex = 0;
      if (!keys) {
        for (let m = word.exec(t); m; m = word.exec(t)) visit(m);
        continue;
      }
      // The end of the last word read: a window that starts past it shares no word with what was read.
      let read_ = 0;
      keys.hits.lastIndex = 0;
      for (let h = keys.hits.exec(t); h; h = keys.hits.exec(t)) {
        if (h.index > 0 && before(t, h.index)[1]) continue; // inside a word
        ahead.lastIndex = h.index;
        let to = h.index;
        for (let n = 0, m = ahead.exec(t); m && n < depth; n++, m = n < depth ? ahead.exec(t) : null) to = m.index + m[0].length;
        if (to <= read_) continue;
        const from = wordsBack(t, h.index, depth - 1);
        if (from >= read_) active = 0;
        word.lastIndex = Math.max(from, read_);
        for (let m = word.exec(t); m && m.index < to; m = word.exec(t)) {
          visit(m);
          read_ = m.index + m[0].length;
        }
      }
    }
  });
}

function hasAll(set: Set<string>, words: string[]): boolean {
  return words.every((w) => set.has(w));
}
