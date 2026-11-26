// The web Editor's save never writes over an edit made to the note's file that the record hasn't read: as restore does
// (src/store/commands.ts), it refuses, the file stays as the person left it, and the edit is read in as theirs.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notesDir, readNotes } from '../src/notes.ts';
import { NoteError, saveEntry } from '../src/server/notes.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

describe("the web Editor's save of a note in the record folder", () => {
  let home: string;
  let store: Store;
  let file: string;
  let id: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'skeinwise-web-save-'));
    mkdirSync(notesDir(home));
    store = new Store(openDb(':memory:'), () => '2026-11-26T09:00:00.000Z');
    file = join(notesDir(home), 'plan.md');
    writeFileSync(file, '---\ntags: [garden]\n---\n\nBeds by the fence.\n');
    readNotes(store, home);
    id = (store.db.prepare("SELECT id FROM entries WHERE external_id = 'plan.md'").get() as { id: number }).id;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('refuses when the file holds an edit the record has not read, keeps the edit and reads it in', async () => {
    const edited = '---\ntags: [garden]\n---\n\nBeds by the fence, and a pond.\n';
    writeFileSync(file, edited);
    const save = saveEntry(home, store, id, 'Beds by the shed.');
    await expect(save).rejects.toBeInstanceOf(NoteError);
    await expect(save).rejects.toThrow(/notes\/plan\.md holds an edit .*hadn't read.*Nothing was saved/);
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(store.history(id).map((v) => v.body)).toEqual(['Beds by the fence.', 'Beds by the fence, and a pond.']);
    // Seen and saved again, the change goes through over the edit it now holds.
    const saved = await saveEntry(home, store, id, 'Beds by the shed, and a pond.');
    expect(saved).toMatchObject({ wroteFile: true, version: { version: 3, body: 'Beds by the shed, and a pond.' } });
    expect(readFileSync(file, 'utf8')).toBe('---\ntags: [garden]\n---\n\nBeds by the shed, and a pond.\n');
  });

  it('saves when the file already holds the text being saved (a save that stopped before the record)', async () => {
    writeFileSync(file, '---\ntags: [garden]\n---\n\nBeds by the shed.\n');
    const saved = await saveEntry(home, store, id, 'Beds by the shed.');
    expect(saved).toMatchObject({ wroteFile: true, version: { version: 2, body: 'Beds by the shed.' } });
  });

  it('saves over a file the record has read, as before', async () => {
    const saved = await saveEntry(home, store, id, 'Beds by the shed.');
    expect(saved).toMatchObject({ wroteFile: true, version: { version: 2 } });
    expect(readFileSync(file, 'utf8')).toBe('---\ntags: [garden]\n---\n\nBeds by the shed.\n');
  });
});
