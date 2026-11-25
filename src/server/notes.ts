// Notes written in the app live as Markdown files in the home folder's notes/ and reach the record through the same
// notes importer as any folder, so dedupe and versions work the same way. No note file is opened through a symbolic
// link, and a note's folder must resolve inside notes/ (L8): a link there is refused, never written through.

import { mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readImports } from '../importers/detect.ts';
import type { Store, Version } from '../store/store.ts';
import { folderInside, readPlain, UnsafeFile, writeNew, writeOver } from './files.ts';

export class NoteError extends Error {}

/** A refused file as a NoteError, so the page gets a 400 that names it from inside notes/. */
function safely<T>(home: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof UnsafeFile)) throw error;
    throw new NoteError(error.message.replace(notesDir(home), 'notes'));
  }
}

export function notesDir(home: string): string {
  return resolve(home, 'notes');
}

export function slug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return s || 'note';
}

/** Today's date in this computer's time zone, as YYYY-MM-DD. */
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Imports the notes folder and returns the entry id of one file in it. */
function importNote(home: string, store: Store, file: string): number {
  const dir = notesDir(home);
  for (const batch of readImports(dir)) store.ingest(batch, 'you');
  const externalId = relative(dir, file);
  const row = store.db
    .prepare(`SELECT e.id FROM entries e JOIN sources s ON s.id = e.source_id WHERE s.kind = 'notes' AND s.location = ? AND e.external_id = ?`)
    .get(dir, externalId) as { id: number } | undefined;
  if (!row) throw new NoteError(`The note ${externalId} did not reach the record`);
  return row.id;
}

/** Writes a new note file with this title and imports it. */
export function createNote(home: string, store: Store, title: string, body: string, now = new Date()): number {
  const clean = title.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) throw new NoteError('A note needs a title');
  const dir = notesDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const text = body.trim() || `# ${clean}`;
  const content = `---\ntitle: ${clean.replace(/^["']|["']$/g, '')}\ncreated: ${now.toISOString()}\n---\n\n${text}\n`;
  // Each name is claimed by creating it, so a name already taken, by a link too, moves on to the next.
  for (let n = 1; n <= 1000; n++) {
    const file = join(dir, n === 1 ? `${slug(clean)}.md` : `${slug(clean)}-${n}.md`);
    if (safely(home, () => writeNew(file, content))) return importNote(home, store, file);
  }
  throw new NoteError(`There are already 1,000 notes called ${slug(clean)}. Pick another title.`);
}

/** Adds a line to today's daily note (notes/daily/YYYY-MM-DD.md), making the note if needed. */
export function appendDaily(home: string, store: Store, line: string, now = new Date()): number {
  const text = line.replace(/\s+/g, ' ').trim();
  if (!text) throw new NoteError('Give some words for the daily note');
  const day = localDay(now);
  const dir = join(notesDir(home), 'daily');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${day}.md`);
  if (!folderInside(notesDir(home), file)) throw new NoteError('notes/daily leads outside notes/, so Skeinwise won\'t write the daily note there');
  safely(home, () => {
    const existing = readPlain(file)?.replace(/\s+$/, '') ?? `# ${day}`;
    writeOver(file, `${existing}\n\n${text}\n`);
  });
  return importNote(home, store, file);
}

/**
 * Saves an edit as a new version. A note that lives in the home folder's notes/ also gets its file rewritten
 * (front matter kept); notes from anywhere else keep their original file untouched.
 */
export function saveEntry(home: string, store: Store, id: number, body: string): { version: Version; wroteFile: boolean } {
  const entry = store.getEntry(id);
  if (!entry) throw new NoteError(`No entry ${id}`);
  if (!body.trim()) throw new NoteError('An entry cannot be saved empty');
  const file = ownFile(home, store, id);
  // The file is read before the version is saved, so a link there refuses the whole save.
  const old = file ? (safely(home, () => readPlain(file)) ?? '') : '';
  const version = store.editEntry(id, body, 'you');
  if (file) {
    const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(old)?.[0] ?? '';
    safely(home, () => writeOver(file, `${front}${front ? '\n' : ''}${version.body}\n`));
  }
  return { version, wroteFile: file !== null };
}

/** The note's file when it lives in the home folder's notes/ (its folder resolved), else null. */
export function ownFile(home: string, store: Store, id: number): string | null {
  const row = store.db
    .prepare(`SELECT e.kind, e.external_id AS externalId, s.kind AS sourceKind, s.location FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id = ?`)
    .get(id) as { kind: string; externalId: string; sourceKind: string; location: string | null } | undefined;
  if (!row || row.kind !== 'note' || row.sourceKind !== 'notes' || !row.location) return null;
  const dir = notesDir(home);
  if (resolve(row.location) !== dir) return null;
  const file = resolve(dir, row.externalId);
  if (!file.startsWith(`${dir}/`) && !file.startsWith(`${dir}\\`)) return null;
  // A folder in notes/ that is a link to somewhere else holds no file of ours.
  return folderInside(dir, file) ? file : null;
}

/** Notes for [[ suggestions: id and title, newest first. */
export function noteTitles(store: Store): { id: number; title: string }[] {
  return store.db
    .prepare(
      `SELECT e.id, COALESCE(e.title, e.external_id) AS title FROM entries e JOIN sources s ON s.id = e.source_id
       WHERE e.kind = 'note' AND s.status = 'in' ORDER BY e.created_at DESC, e.id DESC`,
    )
    .all() as unknown as { id: number; title: string }[];
}
