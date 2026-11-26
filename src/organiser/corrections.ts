// Your corrections to what the organiser made, and your answers to the review queue.
//
// Merging folders, renaming a hub and deleting one are correction runs: each records what it changed, and
// `skeinwise undo <run>` puts it back (see reverseCorrection in runs.ts). They change the rows a live run made, so a
// later run of the same task over everything starts again from your entries; a run over new entries keeps them.
// Defining a tag is not a run: it is a setting the tag task reads. Answering a review item changes the item, and
// "update" saves the note as a new version, so the note before it stays in its history.

import { lineDiff } from '../diff.ts';
import { UsageError } from '../errors.ts';
import { homeNoteFile, rewriteNoteFile } from '../notes.ts';
import { inTransaction } from '../store/db.ts';
import type { Store } from '../store/store.ts';
import { currentMark, finishRun, getRun, startRun } from './runs.ts';
import { type DefinedTag, type Folder, findSchema, getLiveHub, getReviewItem, type Hub, liveFolders, type ReviewItem, type Schema } from './views.ts';

export interface Correction {
  runId: number;
  message: string;
}

function correction(store: Store, detail: Record<string, unknown> & { op: string; targets: string[] }, apply: (runId: number) => void, message: string): Correction {
  return inTransaction(store.db, () => {
    const runId = startRun(store.db, { task: 'correction', engine: 'you', model: null, scope: 'all', mark: currentMark(store.db), detail, now: store.now() });
    apply(runId);
    finishRun(store.db, runId, { counts: {}, message, tokensIn: 0, tokensOut: 0, now: store.now() });
    return { runId, message };
  });
}

/** A live folder by its number or its name (or a name merged into it). */
export function findFolder(store: Store, ref: string): Folder {
  const folders = liveFolders(store.db);
  const lower = ref.trim().toLowerCase();
  const found = /^\d+$/.test(lower) ? folders.find((f) => f.id === Number(lower)) : folders.find((f) => f.name.toLowerCase() === lower);
  if (found) return found;
  const merged = folders.find((f) => f.aliases.some((a) => a.toLowerCase() === lower));
  if (merged) throw new UsageError(`"${ref}" was merged into folder ${merged.id} (${merged.name}).`);
  throw new UsageError(`No folder "${ref}". Run "skeinwise folders" for the list.`);
}

/** Folds one folder into another. The merged folder's name stays as an alias. */
export function mergeFolders(store: Store, fromRef: string, intoRef: string): Correction & { from: Folder; into: Folder } {
  const from = findFolder(store, fromRef);
  const into = findFolder(store, intoRef);
  if (from.id === into.id) throw new UsageError(`Those are the same folder (${from.name}).`);
  const message = `Merged folder "${from.name}" into "${into.name}".`;
  const done = correction(
    store,
    { op: 'merge-folders', targets: [`folder:${from.id}`, `folder:${into.id}`], folder: from.id, into: into.id, previousAliasOf: null },
    () => store.db.prepare('UPDATE folders SET alias_of = ? WHERE id = ? AND alias_of IS NULL').run(into.id, from.id),
    message,
  );
  return { ...done, from, into };
}

function liveHub(store: Store, id: number): Hub {
  const hub = getLiveHub(store.db, id);
  if (!hub) throw new UsageError(`No hub ${id}. Run "skeinwise hubs" for the list.`);
  return hub;
}

export function renameHub(store: Store, id: number, name: string): Correction {
  const hub = liveHub(store, id);
  const after = name.trim().replace(/\s+/g, ' ');
  if (!after) throw new UsageError('Give the hub a new name.');
  if (after.length > 80) throw new UsageError('Keep a hub name under 80 characters.');
  if (after === hub.name) throw new UsageError(`Hub ${id} is already called "${after}".`);
  return correction(
    store,
    { op: 'rename-hub', targets: [`hub:${id}`], hub: id, before: hub.name, after },
    () => store.db.prepare('UPDATE hubs SET name = ? WHERE id = ?').run(after, id),
    `Renamed hub ${id} from "${hub.name}" to "${after}".`,
  );
}

export function deleteHub(store: Store, id: number): Correction {
  const hub = liveHub(store, id);
  return correction(
    store,
    { op: 'delete-hub', targets: [`hub:${id}`], hub: id, name: hub.name },
    (runId) => store.db.prepare('UPDATE hubs SET deleted_by = ? WHERE id = ?').run(runId, id),
    `Deleted hub ${id} (${hub.name}).`,
  );
}

// Tags you define

export interface TagDefinition {
  schema: Schema;
  tag: DefinedTag;
  /** What changed: a new schema and tag, a new tag, a new description, or the tag removed. */
  change: 'new schema' | 'new tag' | 'described' | 'removed';
}

/**
 * Adds a tag to Moods or a schema of your own (made when it is new), or gives a tag you defined a new description.
 * The tag task tags an entry when its words hold the tag's name, or two words of its description.
 */
export function defineTag(store: Store, schemaName: string, tagName: string, description: string): TagDefinition {
  const name = tagName.trim().replace(/\s+/g, ' ');
  const words = description.trim().replace(/\s+/g, ' ');
  if (!schemaName.trim() || !name) throw new UsageError('Give a schema and a tag, for example: skeinwise define-tag Moods calm calm quiet rested steady');
  if (name.length > 60) throw new UsageError('Keep a tag name under 60 characters.');
  return inTransaction(store.db, () => {
    let schema = findSchema(store.db, schemaName.trim());
    let change: TagDefinition['change'] = 'new tag';
    if (schema) refuseMadeSchema(schema);
    else {
      const res = store.db.prepare("INSERT INTO schemas (name, description, builtin) VALUES (?, 'Your own tags.', 0)").run(schemaName.trim());
      schema = { id: Number(res.lastInsertRowid), name: schemaName.trim(), description: 'Your own tags.', builtin: false };
      change = 'new schema';
    }
    const known = definedTag(store, schema, name);
    if (known) {
      if (!words) throw new UsageError(`${schema.name} already has the tag "${known.name}". Give words to describe it, or remove it with --remove.`);
      store.db.prepare('UPDATE tags SET description = ? WHERE id = ?').run(words, known.id);
      return { schema, tag: { ...known, description: words }, change: 'described' as const };
    }
    const res = store.db.prepare('INSERT INTO tags (schema_id, name, description) VALUES (?, ?, ?)').run(schema.id, name, words);
    return { schema, tag: { id: Number(res.lastInsertRowid), name, description: words }, change };
  });
}

/** Removes a tag you defined, once no run uses it; a schema of your own goes with its last tag. */
export function removeTag(store: Store, schemaName: string, tagName: string): TagDefinition {
  const schema = findSchema(store.db, schemaName.trim());
  if (!schema) throw new UsageError(`No schema "${schemaName}". Run "skeinwise tags" for the list.`);
  refuseMadeSchema(schema);
  const tag = definedTag(store, schema, tagName.trim());
  if (!tag) throw new UsageError(`${schema.name} has no tag "${tagName.trim()}".`);
  const runs = store.db
    .prepare('SELECT DISTINCT et.run_id AS id FROM entry_tags et WHERE et.tag_id = ? ORDER BY et.run_id')
    .all(tag.id) as { id: number }[];
  if (runs.length) {
    const list = runs.map((r) => r.id).join(', ');
    throw new UsageError(`Runs ${list} tagged entries "${tag.name}". Undo ${runs.length > 1 ? 'them' : 'it'} first (skeinwise undo <run>), or keep the tag.`);
  }
  return inTransaction(store.db, () => {
    store.db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    const left = store.db.prepare('SELECT COUNT(*) AS n FROM tags WHERE schema_id = ?').get(schema.id) as { n: number };
    const used = store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE schema_id = ?').get(schema.id) as { n: number };
    if (!schema.builtin && left.n === 0 && used.n === 0) store.db.prepare('DELETE FROM schemas WHERE id = ?').run(schema.id);
    return { schema, tag, change: 'removed' as const };
  });
}

function refuseMadeSchema(schema: Schema): void {
  if (schema.builtin && (schema.name === 'Topics' || schema.name === 'Projects')) {
    throw new UsageError(`The tag task makes ${schema.name} from your entries, so its tags can't be defined by hand. Define tags in Moods or a schema of your own.`);
  }
}

function definedTag(store: Store, schema: Schema, name: string): DefinedTag | undefined {
  return store.db
    .prepare('SELECT id, name, description FROM tags WHERE schema_id = ? AND run_id IS NULL AND name = ? COLLATE NOCASE')
    .get(schema.id, name) as DefinedTag | undefined;
}

// The review queue

export type ReviewAction = 'update' | 'holds' | 'skip';
export const REVIEW_ACTIONS: readonly ReviewAction[] = ['update', 'holds', 'skip'];

export interface Resolution {
  item: ReviewItem;
  action: ReviewAction;
  /** For update: the change to the note, as diff lines. */
  diff: string[];
  /** False for an update shown without --yes. */
  saved: boolean;
  /** For a saved update: the note's new version, and the file rewritten when the note lives in the record folder. */
  version: number | null;
  file: string | null;
}

const STATUS: Record<ReviewAction, ReviewItem['status']> = { update: 'updated', holds: 'holds', skip: 'skipped' };

/**
 * Answers one review item. "holds" keeps the note as it is, and the entries behind the item won't flag it again;
 * "skip" sets it aside until the next review run; "update" shows the proposed note as a diff and, with yes, saves it as
 * a new version (and into its file, for a note in the record folder).
 */
export function resolveReview(store: Store, home: string, id: number, action: ReviewAction, yes: boolean): Resolution {
  const item = getReviewItem(store.db, id);
  if (!item) throw new UsageError(`No review item ${id} in the current review. Run "skeinwise review" for the list.`);
  if (item.status !== 'open') throw new UsageError(`Review item ${id} is already answered (${item.status}).`);
  const base = { item, action, diff: [] as string[], saved: false, version: null, file: null };
  const mark = (status: ReviewItem['status']) =>
    store.db.prepare("UPDATE review_items SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'").run(status, store.now(), id);
  if (action !== 'update') {
    mark(STATUS[action]);
    return { ...base, item: { ...item, status: STATUS[action] }, saved: true };
  }
  const note = store.getEntry(item.noteEntry);
  if (!note) throw new Error(`Review item ${id} points at entry ${item.noteEntry}, which is not in the record.`);
  const run = getRun(store.db, item.runId)!;
  const newest = store.db.prepare('SELECT MAX(id) AS id FROM versions WHERE entry_id = ?').get(note.id) as { id: number };
  if (newest.id > run.mark) {
    throw new UsageError(`Note #${note.id} changed after review run ${run.id}, so its proposal is out of date. Run the review again: skeinwise run review`);
  }
  const diff = lineDiff(note.body, item.proposed.trim());
  if (!yes) return { ...base, diff };
  const file = homeNoteFile(store, home, note);
  if (file) rewriteNoteFile(file, item.proposed);
  const version = store.editEntry(note.id, item.proposed, { editor: 'you', runId: item.runId });
  mark('updated');
  return { ...base, item: { ...item, status: 'updated' }, diff, saved: true, version: version.version, file };
}
