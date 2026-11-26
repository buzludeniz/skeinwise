// The tag task, one schema at a time. Topics come from groups of related entries; Projects are notes you link to from
// two or more entries; Moods and your own schemas tag an entry when its words match a tag's name or description. With
// a model, it names the topics and settles the entries that match a tag by one word only.

import type { DatabaseSync } from 'node:sqlite';
import { withoutNoteExt } from '../importers/note-ext.ts';
import { safeLine } from '../safe-text.ts';
import type { Entry } from '../store/store.ts';
import { type Existing, type Group, groupName, groupUnits, namingRequest } from './groups.ts';
import { invalid, isRecord, list, type ModelRequest, noRequest, type Plan, type Product, round, type TaskContext } from './plan.ts';
import { linkTargets, type RecordView } from './record.ts';
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
  const projects = [...linkers]
    .filter(([, from]) => from.size >= PROJECT_LINKS)
    .map(([noteId, from]) => ({ note: record.byId.get(noteId)!, from }))
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
  // Each entry is read once, for every name at a time: reading every entry again for each project took most of an hour
  // at 50,000 entries.
  const position = new Map(ctx.entries.map((e, i) => [e.id, i]));
  const uses = nameUses(record.entries, named.map((p) => p.name), position);
  named.forEach(({ note, from, name }, k) => {
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

interface Word {
  stem: string;
  /** Its first letter is a capital. */
  upper: boolean;
  /** It opens the text, a line or a sentence. */
  opens: boolean;
  /** It is inside a [[link]], which copies the note's title as written. */
  linked: boolean;
}

/**
 * Every run of letters and digits in a text, apostrophes dropped and stemmed as tokenize stems, so a name's words can
 * be found side by side. Unlike tokenize, it keeps stop words, numbers and one-letter words: they are part of a name.
 * Without the number, "Hiring note 4929" was every note called "Hiring note" and some number.
 */
function scanWords(text: string): Word[] {
  const t = text.replace(/['’]/g, '');
  const links: [number, number][] = [];
  for (const m of t.matchAll(/\[\[[^\]\n]*\]\]/g)) links.push([m.index, m.index + m[0].length]);
  const out: Word[] = [];
  let end = -1;
  for (const m of t.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    let opens = end < 0;
    for (let j = Math.max(end, 0); !opens && j < m.index; j++) {
      const c = t.charCodeAt(j);
      opens = c === 10 || c === 46 || c === 33 || c === 63; // \n . ! ?
    }
    end = m.index + w.length;
    const first = w[0]!;
    out.push({
      stem: stem(w.toLowerCase()),
      upper: first !== first.toLowerCase(),
      opens,
      linked: links.some(([a, b]) => m.index >= a && m.index < b),
    });
  }
  return out;
}

interface Trie {
  next: Map<string, Trie>;
  /** The names that end here. */
  names: number[];
}

/**
 * How the record uses each of these names, read in one pass over every entry's title and body. A name's uses are
 * counted over the whole record, and the entries that hold it are kept only for positions in scope.
 */
export function nameUses(entries: Entry[], names: string[], position: Map<number, number>): NameUses[] {
  const nameWords = names.map(scanWords);
  const uses: NameUses[] = names.map((name, k) => ({
    content: tokenize(name).length > 0,
    cased: nameWords[k]!.some((w) => w.upper),
    entries: 0,
    mid: 0,
    asTitle: 0,
    inScope: [],
  }));
  const root: Trie = { next: new Map(), names: [] };
  nameWords.forEach((words, k) => {
    if (!uses[k]!.content) return;
    let node = root;
    for (const w of words) {
      let child = node.next.get(w.stem);
      if (!child) node.next.set(w.stem, (child = { next: new Map(), names: [] }));
      node = child;
    }
    node.names.push(k);
  });
  const last = new Int32Array(names.length).fill(-1);
  const counted = new Int32Array(names.length).fill(-1);
  entries.forEach((e, r) => {
    for (const text of [e.title ?? '', e.body]) {
      const words = scanWords(text);
      for (let i = 0; i < words.length; i++) {
        let node = root.next.get(words[i]!.stem);
        for (let n = 1; node; n++) {
          for (const k of node.names) {
            const u = uses[k]!;
            if (last[k] !== r) {
              last[k] = r;
              const at = position.get(e.id);
              if (at !== undefined) u.inScope.push(at);
            }
            if (words[i]!.linked) continue;
            if (counted[k] !== r) (counted[k] = r), u.entries++;
            if (words[i]!.opens) continue;
            u.mid++;
            if (nameWords[k]!.every((t, j) => !t.upper || words[i + j]!.upper)) u.asTitle++;
          }
          node = i + n < words.length ? node.next.get(words[i + n]!.stem) : undefined;
        }
      }
    }
  });
  return uses;
}

function hasAll(set: Set<string>, words: string[]): boolean {
  return words.every((w) => set.has(w));
}
