// Your notes in the record folder: Markdown files under <home>/notes, one daily note per day in notes/daily. Writing
// one reads the notes folder back into the record as your own words, so a change made here or in any editor becomes a
// version of the same entry.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { UsageError } from './errors.ts';
import { readImports } from './importers/detect.ts';
import type { Entry, Store } from './store/store.ts';

export interface NoteWrite {
  path: string;
  entryId: number;
  /** True when the file was new. */
  created: boolean;
}

export function notesDir(home: string): string {
  return resolve(home, 'notes');
}

/** The local calendar day, as YYYY-MM-DD. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Adds a line to today's daily note, starting the note when it is the first line of the day. */
export function appendDailyNote(store: Store, home: string, text: string, now: Date): NoteWrite {
  const line = text.trim();
  if (!line) throw new UsageError('Give the text to add, for example: skeinwise note "Fed the starter at 18:00"');
  const dir = notesDir(home);
  const day = localDay(now);
  const path = join(dir, 'daily', `${day}.md`);
  const item = `- ${line.replace(/\r?\n/g, '\n  ')}\n`;
  const created = !existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  if (created) {
    writeFileSync(path, `# ${day}\n\n${item}`, { flag: 'wx', mode: 0o600 });
  } else {
    const old = readFileSync(path, 'utf8');
    appendFileSync(path, old && !old.endsWith('\n') ? `\n${item}` : item);
  }
  return { path, created, entryId: readBack(store, dir, path) };
}

/** A file name from a title: lower case letters and digits joined by dashes. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/** Starts a note with a title. Refuses when a note of that name is already there. */
export function newNote(store: Store, home: string, title: string, now: Date): NoteWrite {
  const name = title.trim().replace(/\s+/g, ' ');
  if (!name) throw new UsageError('Give the note a title, for example: skeinwise new-note "Garden plan"');
  const slug = slugify(name);
  if (!slug) throw new UsageError(`"${name}" has no letters or digits to name a file after.`);
  const dir = notesDir(home);
  const path = join(dir, `${slug}.md`);
  if (existsSync(path)) throw new UsageError(`A note already exists at ${path}. Open it in an editor, or pick another title.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `---\ncreated: ${now.toISOString()}\n---\n\n# ${name}\n`, { flag: 'wx', mode: 0o600 });
  return { path, created: true, entryId: readBack(store, dir, path) };
}

/** Reads the notes folder into the record as your words, and returns the entry for one file in it. */
function readBack(store: Store, dir: string, path: string): number {
  for (const batch of readImports(dir)) if (batch.source.kind === 'notes') store.ingest(batch, 'you');
  const row = store.db
    .prepare(
      `SELECT e.id FROM entries e JOIN sources s ON s.id = e.source_id
       WHERE s.kind = 'notes' AND s.location = ? AND e.external_id = ?`,
    )
    .get(dir, relative(dir, path)) as { id: number } | undefined;
  if (!row) throw new Error(`${path} was written but did not reach the record.`);
  return row.id;
}

/** The file behind an entry, when it is a note in the record folder's notes; null for anything else. */
export function homeNoteFile(store: Store, home: string, entry: Entry): string | null {
  if (entry.sourceKind !== 'notes') return null;
  const row = store.db.prepare('SELECT location FROM sources WHERE id = ?').get(entry.sourceId) as { location: string } | undefined;
  if (!row?.location || resolve(row.location) !== notesDir(home)) return null;
  return join(notesDir(home), entry.externalId);
}

/** Replaces a note file's text below its front matter, which stays as it was. */
export function rewriteNoteFile(path: string, body: string): void {
  if (!existsSync(path)) throw new Error(`The note file ${path} is gone, so it can't be updated. Nothing was saved.`);
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(readFileSync(path, 'utf8'))?.[0];
  writeFileSync(path, `${front ? `${front}\n` : ''}${body.trim()}\n`);
}
