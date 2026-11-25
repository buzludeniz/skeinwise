// Reads of what the organiser has made, as it stands now: rows from live runs only (see the live_runs view), with
// deleted and replaced hubs hidden and merged folders folded into the folder they were merged into.

import type { DatabaseSync } from 'node:sqlite';

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
  const byName = new Map<string, TagView>();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    let tag = byName.get(key);
    if (!tag) byName.set(key, (tag = { ids: [], name: r.name, entryIds: [] }));
    if (!tag.ids.includes(r.id)) tag.ids.push(r.id);
    if (!tag.entryIds.includes(r.entryId)) tag.entryIds.push(r.entryId);
  }
  return [...byName.values()].sort((a, b) => b.entryIds.length - a.entryIds.length || a.name.localeCompare(b.name));
}

export interface Link {
  from: number;
  to: number;
  kind: 'cross' | 'note';
  score: number;
}

export function liveLinks(db: DatabaseSync, entryId?: number): Link[] {
  const where = entryId === undefined ? '' : 'AND (from_entry = ? OR to_entry = ?)';
  const args = entryId === undefined ? [] : [entryId, entryId];
  return db
    .prepare(
      `SELECT from_entry AS "from", to_entry AS "to", kind, score FROM links
       WHERE run_id IN ${LIVE} ${where} ORDER BY kind, score DESC, id`,
    )
    .all(...args) as unknown as Link[];
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
