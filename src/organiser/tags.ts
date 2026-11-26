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
import { cosine, tokenize } from './text.ts';
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
  const inScope = new Set(entries.map((e) => e.id));
  const rows = db
    .prepare(
      `SELECT e.id, v.properties FROM entries e JOIN versions v ON v.entry_id = e.id AND v.version = e.version
       WHERE v.properties IS NOT NULL ORDER BY e.id`,
    )
    .all() as { id: number; properties: string }[];
  const out: Tagging[] = [];
  for (const r of rows) {
    if (!inScope.has(r.id)) continue;
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
  for (const { note, from } of projects) {
    const name = projectName(note);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const stems = [...new Set(tokenize(name))];
    tags.push({ name, description: `The note "${name}", linked from ${from.size} entries.` });
    for (const e of ctx.entries) {
      if (e.id === note.id || from.has(e.id)) taggings.push({ entryId: e.id, name, score: 1 });
      else if (stems.length && hasAll(stemSet(e), stems)) taggings.push({ entryId: e.id, name, score: 0.8 });
    }
  }
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
  const unique = dedupe(taggings);
  const pairs = new Set(unique.map(pairKey));
  const live = livePairs(ctx.db, schema.id, null);
  const replaced = livePairs(ctx.db, schema.id, replacedRuns(ctx.db, 'tag', schema.id, ctx.scope));
  const used = new Set(unique.map((t) => t.name.toLowerCase()));
  const tagged = new Set(unique.map((t) => t.entryId)).size;
  return {
    counts: {
      entries: ctx.entries.length,
      tagged,
      coverage: ctx.entries.length ? Math.round((100 * tagged) / ctx.entries.length) : 0,
      tags: used.size,
      added: [...pairs].filter((p) => !live.has(p)).length,
      removed: [...replaced].filter((p) => !pairs.has(p)).length,
      unchanged: [...pairs].filter((p) => live.has(p)).length,
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
      for (const t of unique) insert.run(t.entryId, ids.get(t.name.toLowerCase())!, runId, t.score);
    },
  };
}

function dedupe(taggings: Tagging[]): Tagging[] {
  const best = new Map<string, Tagging>();
  for (const t of taggings) {
    const k = pairKey(t);
    const had = best.get(k);
    if (!had || t.score > had.score) best.set(k, t);
  }
  return [...best.values()].sort((a, b) => a.entryId - b.entryId || a.name.localeCompare(b.name));
}

const pairKey = (t: { entryId: number; name: string }) => `${t.entryId}:${t.name.toLowerCase()}`;

/** Entry and tag-name pairs from live runs of a schema; with runIds, from those runs only. */
function livePairs(db: DatabaseSync, schemaId: number, runIds: number[] | null): Set<string> {
  if (runIds && !runIds.length) return new Set();
  const runs = runIds ? `(${runIds.join(',')})` : '(SELECT id FROM live_runs)';
  const rows = db
    .prepare(`SELECT et.entry_id AS entryId, t.name FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE t.schema_id = ? AND et.run_id IN ${runs}`)
    .all(schemaId) as { entryId: number; name: string }[];
  return new Set(rows.map(pairKey));
}

function stemSet(e: Entry): Set<string> {
  return new Set(tokenize(`${e.title ?? ''}\n${e.body}`));
}

function hasAll(set: Set<string>, words: string[]): boolean {
  return words.every((w) => set.has(w));
}
