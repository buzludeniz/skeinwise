// A note's front matter as the reader finds it is the front matter every writer keeps: a BOM, spaces after a fence, a
// `...` close and front matter that ends the file read and write alike, so a rewrite never drops the person's
// properties or keeps old text glued above the new.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontMatter } from '../src/importers/notes.ts';
import { notesDir, readNotes, rewriteNoteFile } from '../src/notes.ts';
import { saveEntry } from '../src/server/notes.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

/** Front matter the reader accepts, and the bytes of it a rewrite must keep above the new text. */
const SHAPES = [
  { name: 'a byte order mark before the fence', text: '﻿---\ntags: [garden]\n---\n\nOld words.\n', front: '﻿---\ntags: [garden]\n---\n', body: '\nOld words.\n' },
  { name: 'spaces after the fences', text: '--- \ntags: [garden]\n---\t\n\nOld words.\n', front: '--- \ntags: [garden]\n---\t\n', body: '\nOld words.\n' },
  {
    name: 'a `...` close and a `---` rule further down',
    text: '---\ntags: [garden]\n...\nOld words.\n\n---\n\nMore old words.\n',
    front: '---\ntags: [garden]\n...\n',
    body: 'Old words.\n\n---\n\nMore old words.\n',
  },
  { name: 'front matter that ends the file', text: '---\ntags: [garden]\n---', front: '---\ntags: [garden]\n---\n', body: '' },
];

describe('front matter the reader accepts', () => {
  let home: string;
  let store: Store;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'skeinwise-front-'));
    mkdirSync(notesDir(home));
    store = new Store(openDb(':memory:'), () => '2026-11-26T09:00:00.000Z');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** A note in the record folder holding `text`, read into the record; its file and entry. */
  function note(text: string): { file: string; id: number } {
    const file = join(notesDir(home), 'plan.md');
    writeFileSync(file, text);
    readNotes(store, home);
    const row = store.db.prepare("SELECT id FROM entries WHERE external_id = 'plan.md'").get() as { id: number };
    return { file, id: row.id };
  }

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it('is read as front matter', () => {
        const read = parseFrontMatter(shape.text);
        expect(read.properties.tags).toEqual(['garden']);
        expect(read.body).toBe(shape.body);
      });

      it('is kept by rewriteNoteFile (restore, undo, corrections, an agent)', () => {
        const file = join(notesDir(home), 'plan.md');
        writeFileSync(file, shape.text);
        rewriteNoteFile(file, 'New words.');
        expect(readFileSync(file, 'utf8')).toBe(`${shape.front}\nNew words.\n`);
      });

      // A note with no words below its front matter never becomes an entry, so the web app has nothing to save there.
      it.runIf(shape.body.trim() !== '')("is kept by the web Editor's save, and the next read keeps the note's properties", async () => {
        const { file, id } = note(shape.text);
        const saved = await saveEntry(home, store, id, 'New words.');
        expect(saved.wroteFile).toBe(true);
        expect(readFileSync(file, 'utf8')).toBe(`${shape.front}\nNew words.\n`);
        readNotes(store, home);
        const history = store.history(id);
        expect(history.at(-1)).toMatchObject({ body: 'New words.', properties: { tags: ['garden'] } });
        expect(history).toHaveLength(2);
      });
    });
  }
});
