// Notes written in the app live as Markdown files in the home folder's notes/ and reach the record through the same
// notes importer as any folder, so dedupe and versions work the same way.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readImports } from '../importers/detect.ts';
import type { Store, Version } from '../store/store.ts';

export class NoteError extends Error {}

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
  mkdirSync(dir, { recursive: true });
  let file = join(dir, `${slug(clean)}.md`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${slug(clean)}-${n}.md`);
  const text = body.trim() || `# ${clean}`;
  writeFileSync(file, `---\ntitle: ${clean.replace(/^["']|["']$/g, '')}\ncreated: ${now.toISOString()}\n---\n\n${text}\n`);
  return importNote(home, store, file);
}

/** Adds a line to today's daily note (notes/daily/YYYY-MM-DD.md), making the note if needed. */
export function appendDaily(home: string, store: Store, line: string, now = new Date()): number {
  const text = line.replace(/\s+/g, ' ').trim();
  if (!text) throw new NoteError('Give some words for the daily note');
  const day = localDay(now);
  const dir = join(notesDir(home), 'daily');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}.md`);
  const existing = existsSync(file) ? readFileSync(file, 'utf8').replace(/\s+$/, '') : `# ${day}`;
  writeFileSync(file, `${existing}\n\n${text}\n`);
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
  const version = store.editEntry(id, body, 'you');
  const file = ownFile(home, store, id);
  if (file) {
    const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(old)?.[0] ?? '';
    writeFileSync(file, `${front}${front ? '\n' : ''}${version.body}\n`);
  }
  return { version, wroteFile: file !== null };
}

/** The note's file when it lives in the home folder's notes/, else null. */
export function ownFile(home: string, store: Store, id: number): string | null {
  const row = store.db
    .prepare(`SELECT e.kind, e.external_id AS externalId, s.kind AS sourceKind, s.location FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id = ?`)
    .get(id) as { kind: string; externalId: string; sourceKind: string; location: string | null } | undefined;
  if (!row || row.kind !== 'note' || row.sourceKind !== 'notes' || !row.location) return null;
  const dir = notesDir(home);
  if (resolve(row.location) !== dir) return null;
  const file = resolve(dir, row.externalId);
  return file.startsWith(`${dir}/`) || file.startsWith(`${dir}\\`) ? file : null;
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
