// A note in the record folder's notes/ is the person's own file, which Skeinwise writes whenever the note changes, so
// what the file holds is the note: text an older version held, put back in the file, is read in as their new version.
// Anything else (a chat, an export, a note from a folder Skeinwise never writes, a Word document it only reads) keeps
// the older-export rule: text a version already holds changes nothing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/cli-organiser.ts';
import { readImports } from '../src/importers/detect.ts';
import { notesDir, readNotes } from '../src/notes.ts';
import { STORE_COMMANDS } from '../src/store/commands.ts';
import { openDb } from '../src/store/db.ts';
import { type ImportBatch, Store } from '../src/store/store.ts';

describe('text an older version holds, read in again', () => {
  let home: string;
  let store: Store;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'skeinwise-put-back-'));
    mkdirSync(notesDir(home));
    store = new Store(openDb(':memory:'), () => '2026-11-26T09:00:00.000Z');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const bodies = (id: number) => store.history(id).map((v) => v.body);
  const entryId = (externalId: string) => (store.db.prepare('SELECT id FROM entries WHERE external_id = ?').get(externalId) as { id: number }).id;

  /** A note in notes/ read in as "Beds by the fence.", then edited in its file to "Beds by the shed." and read in. */
  function editedNote(): { file: string; id: number } {
    const file = join(notesDir(home), 'plan.md');
    writeFileSync(file, '---\ntags: [garden]\n---\n\nBeds by the fence.\n');
    readNotes(store, home);
    writeFileSync(file, '---\ntags: [garden]\n---\n\nBeds by the shed.\n');
    readNotes(store, home);
    return { file, id: entryId('plan.md') };
  }

  it("is a new version of a note in the record folder: the file is the person's", () => {
    const { file, id } = editedNote();
    writeFileSync(file, '---\ntags: [garden]\n---\n\nBeds by the fence.\n');
    readNotes(store, home);
    expect(bodies(id)).toEqual(['Beds by the fence.', 'Beds by the shed.', 'Beds by the fence.']);
    expect(store.getEntry(id)!.body).toBe('Beds by the fence.');
  });

  it('makes no version when the file is read again unchanged', () => {
    const { id } = editedNote();
    readNotes(store, home);
    readNotes(store, home);
    expect(bodies(id)).toEqual(['Beds by the fence.', 'Beds by the shed.']);
  });

  it('lets restore go on once the put-back text is read in, so its advice no longer loops', () => {
    const { file, id } = editedNote();
    writeFileSync(file, '---\ntags: [garden]\n---\n\nBeds by the fence.\n');
    const restore = () => {
      const ctx: Ctx = { io: { out: () => {}, err: () => {}, env: {} }, home, store, values: {}, args: [String(id), '2'], json: () => {} };
      return STORE_COMMANDS.restore!(ctx);
    };
    expect(restore).toThrow(/holds an edit the record hasn't read yet.*"skeinwise run"/);
    readNotes(store, home); // what "skeinwise run" does first
    expect(restore()).toBe(0);
    expect(bodies(id)).toEqual(['Beds by the fence.', 'Beds by the shed.', 'Beds by the fence.', 'Beds by the shed.']);
  });

  it('changes nothing for a chat: an older export stays older', () => {
    const chat = (body: string): ImportBatch => ({
      source: { kind: 'chatgpt', label: 'ChatGPT', location: '/exports/chatgpt' },
      threads: [{ externalId: 't1', title: 'Garden', entries: [{ externalId: 'm1', kind: 'message', speaker: 'you', createdAt: '2026-11-01T10:00:00.000Z', body }] }],
    });
    store.ingest(chat('Beds by the fence.'));
    store.ingest(chat('Beds by the shed.'));
    store.ingest(chat('Beds by the fence.'));
    expect(bodies(entryId('m1'))).toEqual(['Beds by the fence.', 'Beds by the shed.']);
  });

  it("changes nothing for a note from a folder Skeinwise doesn't write: its edit in the record stands", () => {
    const folder = mkdtempSync(join(tmpdir(), 'skeinwise-vault-'));
    try {
      writeFileSync(join(folder, 'plan.md'), 'Beds by the fence.\n');
      for (const batch of readImports(folder)) store.ingest(batch);
      const id = entryId('plan.md');
      store.editEntry(id, 'Beds by the shed.', 'you'); // the web app's save: the record alone, the file untouched
      for (const batch of readImports(folder)) store.ingest(batch);
      expect(bodies(id)).toEqual(['Beds by the fence.', 'Beds by the shed.']);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('changes nothing for a Word document in notes/, which Skeinwise only reads', () => {
    const doc = zipSync({
      '_rels/.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ),
      'word/document.xml': strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Beds by the fence.</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    writeFileSync(join(notesDir(home), 'Garden plan.docx'), doc);
    readNotes(store, home);
    const id = entryId('Garden plan.docx');
    store.editEntry(id, 'Beds by the shed.', 'you'); // a save of a Word note changes the record alone
    readNotes(store, home);
    expect(bodies(id)).toEqual(['Beds by the fence.', 'Beds by the shed.']);
  });
});
