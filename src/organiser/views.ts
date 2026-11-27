// Reads of what the organiser has made, as it stands now: rows from live runs only (see the live_runs view), with
// deleted and replaced hubs hidden and merged folders folded into the folder they were merged into.

import type { DatabaseSync } from 'node:sqlite';

import type { Part, Place } from './atlas.ts';
import { linkTargets, type NoteName, NoteNames } from './record.ts';

const LIVE = '(SELECT id FROM live_runs)';

export interface HubItem {
  text: string;
  entryId: number;
  date: string;
  /** Entries a model's sentence rests on; the first is entryId. */
  cites?: number[];
}

export interface HubSections {
  in_short: HubItem[];
  what_you_found: HubItem[];
  open_ends: HubItem[];
}

export interface Hub {
  id: number;
  name: string;
  runId: number;
  replaces: number | null;
  sections: HubSections;
  entries: number;
}

const HUB_LIVE = `h.run_id IN ${LIVE} AND h.deleted_by IS NULL
  AND NOT EXISTS (SELECT 1 FROM hubs n WHERE n.replaces = h.id AND n.run_id IN ${LIVE} AND n.deleted_by IS NULL)`;

function toHub(row: Record<string, unknown>): Hub {
  return { ...(row as unknown as Hub), sections: JSON.parse(row.sections as string) as HubSections };
}

export function liveHubs(db: DatabaseSync): Hub[] {
  return db
    .prepare(
      `SELECT h.id, h.name, h.run_id AS runId, h.replaces, h.sections,
              (SELECT COUNT(*) FROM hub_entries he WHERE he.hub_id = h.id) AS entries
       FROM hubs h WHERE ${HUB_LIVE} ORDER BY entries DESC, h.id`,
    )
    .all()
    .map(toHub);
}

export function getLiveHub(db: DatabaseSync, id: number): Hub | undefined {
  const row = db
    .prepare(
      `SELECT h.id, h.name, h.run_id AS runId, h.replaces, h.sections,
              (SELECT COUNT(*) FROM hub_entries he WHERE he.hub_id = h.id) AS entries
       FROM hubs h WHERE h.id = ? AND ${HUB_LIVE}`,
    )
    .get(id);
  return row ? toHub(row) : undefined;
}

/** The live hubs a run has placed on the atlas, and where. */
export function hubPlaces(db: DatabaseSync): Map<number, Place> {
  const rows = db
    .prepare(`SELECT h.id, h.place_x AS x, h.place_y AS y FROM hubs h WHERE h.place_x IS NOT NULL AND h.place_y IS NOT NULL AND ${HUB_LIVE}`)
    .all() as { id: number; x: number; y: number }[];
  return new Map(rows.map((r) => [r.id, { x: r.x, y: r.y }]));
}

/** A hub's place and sub-groups on the atlas: null and [] for a hub made before the atlas. */
export function hubAtlas(db: DatabaseSync, hubId: number): { place: Place | null; parts: Part[] } {
  const row = db.prepare('SELECT place_x AS x, place_y AS y, parts FROM hubs WHERE id = ?').get(hubId) as
    | { x: number | null; y: number | null; parts: string | null }
    | undefined;
  if (!row) return { place: null, parts: [] };
  return {
    place: row.x === null || row.y === null ? null : { x: row.x, y: row.y },
    parts: row.parts ? (JSON.parse(row.parts) as Part[]) : [],
  };
}

/** A hub's entries in id order, each with its sub-group (null on a hub made before the atlas). */
export function hubEntryParts(db: DatabaseSync, hubId: number): { id: number; part: number | null }[] {
  return db.prepare('SELECT entry_id AS id, part FROM hub_entries WHERE hub_id = ? ORDER BY entry_id').all(hubId) as {
    id: number;
    part: number | null;
  }[];
}

export function hubEntryIds(db: DatabaseSync, hubId: number): number[] {
  return (db.prepare('SELECT entry_id AS id FROM hub_entries WHERE hub_id = ? ORDER BY entry_id').all(hubId) as { id: number }[]).map(
    (r) => r.id,
  );
}

/** Live hubs that hold an entry. */
export function hubsOfEntry(db: DatabaseSync, entryId: number): { id: number; name: string }[] {
  return db
    .prepare(`SELECT h.id, h.name FROM hubs h JOIN hub_entries he ON he.hub_id = h.id WHERE he.entry_id = ? AND ${HUB_LIVE}`)
    .all(entryId) as { id: number; name: string }[];
}

export interface Folder {
  id: number;
  name: string;
  /** Names of folders merged into this one. */
  aliases: string[];
  entryIds: number[];
}

/** Live folders, each with the entries of the folders merged into it. */
export function liveFolders(db: DatabaseSync): Folder[] {
  const rows = db
    .prepare(`SELECT id, name, alias_of AS aliasOf FROM folders WHERE run_id IN ${LIVE} ORDER BY id`)
    .all() as { id: number; name: string; aliasOf: number | null }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const root = (id: number): number => {
    const seen = new Set<number>();
    let at = id;
    while (byId.get(at)?.aliasOf != null && !seen.has(at)) {
      seen.add(at);
      at = byId.get(at)!.aliasOf!;
    }
    return at;
  };
  const folders = new Map<number, Folder>();
  for (const r of rows) {
    if (r.aliasOf === null) folders.set(r.id, { id: r.id, name: r.name, aliases: [], entryIds: [] });
  }
  for (const r of rows) if (r.aliasOf !== null) folders.get(root(r.id))?.aliases.push(r.name);
  const links = db
    .prepare(`SELECT entry_id AS entryId, folder_id AS folderId FROM entry_folders WHERE run_id IN ${LIVE} ORDER BY entry_id`)
    .all() as { entryId: number; folderId: number }[];
  for (const l of links) {
    const folder = folders.get(root(l.folderId));
    if (folder && !folder.entryIds.includes(l.entryId)) folder.entryIds.push(l.entryId);
  }
  return [...folders.values()].sort((a, b) => b.entryIds.length - a.entryIds.length || a.id - b.id);
}

export interface Schema {
  id: number;
  name: string;
  description: string;
  builtin: boolean;
}

export function schemas(db: DatabaseSync): Schema[] {
  const rows = db.prepare('SELECT id, name, description, builtin FROM schemas ORDER BY id').all() as unknown as (Omit<Schema, 'builtin'> & {
    builtin: number;
  })[];
  return rows.map((s) => ({ ...s, builtin: s.builtin === 1 }));
}

export function findSchema(db: DatabaseSync, name: string): Schema | undefined {
  return schemas(db).find((s) => s.name.toLowerCase() === name.toLowerCase());
}

export interface DefinedTag {
  id: number;
  name: string;
  description: string;
}

/** Tags you defined (Moods and your own schemas). */
export function definedTags(db: DatabaseSync, schemaId: number): DefinedTag[] {
  return db
    .prepare('SELECT id, name, description FROM tags WHERE schema_id = ? AND run_id IS NULL ORDER BY id')
    .all(schemaId) as unknown as DefinedTag[];
}

export interface TagView {
  /** All tag rows with this name (a run makes its own rows for Topics and Projects). */
  ids: number[];
  name: string;
  entryIds: number[];
}

/** A schema's tags in use, by name, with the entries live runs gave them. */
export function liveTags(db: DatabaseSync, schemaId: number): TagView[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, et.entry_id AS entryId FROM tags t
       JOIN entry_tags et ON et.tag_id = t.id AND et.run_id IN ${LIVE}
       WHERE t.schema_id = ? AND (t.run_id IS NULL OR t.run_id IN ${LIVE})
       ORDER BY et.entry_id`,
    )
    .all(schemaId) as { id: number; name: string; entryId: number }[];
  // Repeats are found in Sets kept beside the arrays, so a tag of n entries takes n checks, not n². On the 50,000-entry
  // record the rows come in entry order and scanning the arrays was cheap, so this bounds the worst case rather than
  // saving time there. The arrays keep the order rows first give them.
  const byName = new Map<string, { tag: TagView; ids: Set<number>; entryIds: Set<number> }>();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    let seen = byName.get(key);
    if (!seen) byName.set(key, (seen = { tag: { ids: [], name: r.name, entryIds: [] }, ids: new Set(), entryIds: new Set() }));
    if (!seen.ids.has(r.id)) {
      seen.ids.add(r.id);
      seen.tag.ids.push(r.id);
    }
    if (!seen.entryIds.has(r.entryId)) {
      seen.entryIds.add(r.entryId);
      seen.tag.entryIds.push(r.entryId);
    }
  }
  return [...byName.values()].map((s) => s.tag).sort((a, b) => b.entryIds.length - a.entryIds.length || a.name.localeCompare(b.name));
}

export interface Link {
  from: number;
  to: number;
  kind: 'cross' | 'note';
  score: number;
}

/** Cross links from live runs, then the [[links]] you wrote (`writtenLinks`); with an entry, the ones at it. */
export function liveLinks(db: DatabaseSync, entryId?: number): Link[] {
  const where = entryId === undefined ? '' : 'AND (from_entry = ? OR to_entry = ?)';
  const args = entryId === undefined ? [] : [entryId, entryId];
  // Runs before LS-14 saved note links too; the ones read from your text replace them.
  const cross = db
    .prepare(
      `SELECT from_entry AS "from", to_entry AS "to", kind, score FROM links
       WHERE kind = 'cross' AND run_id IN ${LIVE} ${where} ORDER BY score DESC, id`,
    )
    .all(...args) as unknown as Link[];
  const written = writtenLinks(db);
  return [...cross, ...(entryId === undefined ? written : written.filter((l) => l.from === entryId || l.to === entryId))];
}

/**
 * Store.allEntries' rule (store.ts VISIBLE): an included source, and not in a thread marked not mine. The joins and the
 * condition, for queries that read fewer columns than the store's own.
 */
export const VISIBLE_ENTRIES = `JOIN sources s ON s.id = e.source_id LEFT JOIN threads t ON t.id = e.thread_id
  WHERE s.status = 'in' AND COALESCE(t.not_mine, 0) = 0`;

/**
 * The [[links]] you wrote, read from your entries as they stand now. They are yours, not something a run made, so
 * undoing a run never takes them away, and editing a note changes them (LS-14).
 */
export function writtenLinks(db: DatabaseSync): Link[] {
  const notes = db
    .prepare(`SELECT e.id, e.kind, e.title, e.external_id AS externalId FROM entries e ${VISIBLE_ENTRIES} AND e.kind = 'note' ORDER BY e.created_at, e.id`)
    .all() as unknown as NoteName[];
  if (!notes.length) return [];
  const names = new NoteNames(notes);
  const linking = db
    .prepare(
      `SELECT e.id, v.body FROM entries e JOIN versions v ON v.entry_id = e.id AND v.version = e.version ${VISIBLE_ENTRIES}
         AND instr(v.body, '[[') > 0 ORDER BY e.created_at, e.id`,
    )
    .all() as unknown as { id: number; body: string }[];
  const links: Link[] = [];
  for (const { id, body } of linking) {
    const seen = new Set<number>();
    for (const target of linkTargets(body)) {
      const to = names.resolve(target)?.id;
      if (to === undefined || to === id || seen.has(to)) continue;
      seen.add(to);
      links.push({ from: id, to, kind: 'note', score: 1 });
    }
  }
  return links;
}

export type LayerName = 'cleaned' | 'expanded' | 'digest' | 'ideas';
export const LAYER_NAMES: readonly LayerName[] = ['cleaned', 'expanded', 'digest', 'ideas'];

export interface Layer {
  layer: LayerName;
  body: string;
  engine: string;
  model: string | null;
  runId: number;
}

/** An entry's layers: for each, the one from the newest live run. */
export function entryLayers(db: DatabaseSync, entryId: number): Layer[] {
  const rows = db
    .prepare(
      `SELECT layer, body, engine, model, run_id AS runId FROM layers
       WHERE entry_id = ? AND run_id IN ${LIVE} ORDER BY run_id DESC`,
    )
    .all(entryId) as unknown as Layer[];
  return LAYER_NAMES.map((name) => rows.find((r) => r.layer === name)).filter((l): l is Layer => !!l);
}

export interface Reason {
  entryId: number;
  date: string;
  quote: string;
  why: string;
}

export interface ReviewItem {
  id: number;
  noteEntry: number;
  reasons: Reason[];
  status: 'open' | 'updated' | 'holds' | 'skipped';
  proposed: string;
  runId: number;
}

function toItem(row: Record<string, unknown>): ReviewItem {
  return { ...(row as unknown as ReviewItem), reasons: JSON.parse(row.reasons as string) as Reason[] };
}

const ITEM_SELECT = 'SELECT id, note_entry AS noteEntry, reasons, status, proposed, run_id AS runId FROM review_items';

export function openReviewItems(db: DatabaseSync): ReviewItem[] {
  return db.prepare(`${ITEM_SELECT} WHERE status = 'open' AND run_id IN ${LIVE} ORDER BY id`).all().map(toItem);
}

export function getReviewItem(db: DatabaseSync, id: number): ReviewItem | undefined {
  const row = db.prepare(`${ITEM_SELECT} WHERE id = ? AND run_id IN ${LIVE}`).get(id);
  return row ? toItem(row) : undefined;
}

/** Entries you already judged with "still holds" for a note, in any run not undone: they don't flag it again. */
export function heldEntries(db: DatabaseSync, noteEntry: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT ri.reasons FROM review_items ri JOIN runs r ON r.id = ri.run_id
       WHERE ri.note_entry = ? AND ri.status = 'holds' AND r.status = 'done'`,
    )
    .all(noteEntry) as { reasons: string }[];
  return new Set(rows.flatMap((r) => (JSON.parse(r.reasons) as Reason[]).map((x) => x.entryId)));
}
