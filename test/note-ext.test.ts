// Every place that counts notes or matches a note's file name knows a .docx is a note: the note-folder count on the
// first screen, the organiser's [[link]] matching and the server's note links. They share one list
// (src/importers/note-ext.ts), and a test below keeps a second copy from coming back.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { readImports } from '../src/importers/detect.ts';
import { IMPORT_EXT } from '../src/importers/files.ts';
import { isNoteFile, NOTE_FILE_EXT, withoutNoteExt } from '../src/importers/note-ext.ts';
import { NoteNames } from '../src/organiser/record.ts';
import { findSources } from '../src/server/found.ts';
import { noteLinks } from '../src/server/queries.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

/** A small Word document whose properties give it a title of its own, not its file name. */
function docx(title: string, text: string): Uint8Array {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return zipSync({
    '_rels/.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>',
    ),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
    'docProps/core.xml': strToU8(
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        `<dc:title>${title}</dc:title></cp:coreProperties>`,
    ),
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-note-ext-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the note extensions', () => {
  it('are Markdown, plain text and Word, in any case, and an import reads every one of them', () => {
    expect([...NOTE_FILE_EXT]).toEqual(['.md', '.markdown', '.txt', '.docx']);
    for (const ext of NOTE_FILE_EXT) expect(IMPORT_EXT.has(ext)).toBe(true);
    for (const name of ['a.md', 'b.markdown', 'c.txt', 'Garden plan.docx', 'LOUD.DOCX', 'Notes/x.Md']) expect(isNoteFile(name), name).toBe(true);
    for (const name of ['a.json', 'b.docx.png', 'c.doc', 'docx', 'readme']) expect(isNoteFile(name), name).toBe(false);
  });

  it('come off a file name, and nothing else does', () => {
    expect(withoutNoteExt('Garden plan.docx')).toBe('Garden plan');
    expect(withoutNoteExt('Plan.MARKDOWN')).toBe('Plan');
    expect(withoutNoteExt('2026-11-25.md')).toBe('2026-11-25');
    expect(withoutNoteExt('photo.png')).toBe('photo.png');
    expect(withoutNoteExt('v1.2')).toBe('v1.2');
  });

  it('are written down once: no other file in src lists them in a pattern of its own', () => {
    const copies: string[] = [];
    const visit = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const path = join(d, e.name);
        if (e.isDirectory()) visit(path);
        else if (e.name.endsWith('.ts') && e.name !== 'note-ext.ts' && /\(md\|markdown\|txt\)/.test(readFileSync(path, 'utf8'))) copies.push(path);
      }
    };
    visit(join(import.meta.dirname, '..', 'src'));
    expect(copies).toEqual([]);
  });
});

describe('a .docx counts as a note', () => {
  it('in the note folders the first screen finds', () => {
    mkdirSync(join(dir, 'Notes', 'Garden'), { recursive: true });
    writeFileSync(join(dir, 'Notes', 'Plan.docx'), docx('Plan', 'Beans'));
    writeFileSync(join(dir, 'Notes', 'Garden', 'BEDS.DOCX'), docx('Beds', 'Peas'));
    writeFileSync(join(dir, 'Notes', 'photo.png'), 'not a note');
    const notes = findSources(dir, []).filter((f) => f.kind === 'notes');
    expect(notes.map((f) => [f.label, f.detail])).toEqual([['Notes: Notes', '2 notes']]);
  });

  it("in the organiser's [[link]] matching, by its file name as well as its title", () => {
    const names = new NoteNames([{ id: 7, kind: 'note', title: 'Seed swap', externalId: 'Notes/Garden plan.docx' }]);
    expect(names.resolve('Garden plan')?.id).toBe(7);
    expect(names.resolve('seed swap')?.id).toBe(7);
    expect(names.resolve('Garden plan.docx')).toBeUndefined();
  });

  it("in the server's note links, by its file name as well as its title", () => {
    writeFileSync(join(dir, 'Garden plan.docx'), docx('Seed swap', 'Beans by the fence.'));
    writeFileSync(join(dir, 'Week.md'), '# Week\n\nSee [[Garden plan]].\n');
    const store = new Store(openDb(':memory:'));
    try {
      for (const batch of readImports(dir)) store.ingest(batch);
      const id = (title: string) => store.allEntries().find((e) => e.title === title)!.id;
      expect(noteLinks(store.db)).toEqual([[id('Week'), id('Seed swap')]]);
    } finally {
      store.db.close();
    }
  });
});
