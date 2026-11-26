// The import readers wired into readImports, readFilesUnder and the worker: .docx in a folder and on its own, a .docx
// inside a zip named and skipped, Templates folders skipped, notes in UTF-16 or with a byte order mark, and front
// matter carried into the entry's properties. Every file is built here at run time.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { UnsafeFileError } from '../src/fsafe.ts';
import { readFilesUnder, readImports, readImportsInWorker } from '../src/importers/detect.ts';
import type { EntryInput, ImportBatch } from '../src/store/store.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docx(...paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  return zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`) });
}

function withDir<T>(run: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-files-'));
  let async = false;
  try {
    const out = run(dir);
    if (out instanceof Promise) {
      async = true;
      return out.finally(() => rmSync(dir, { recursive: true, force: true }));
    }
    return out;
  } finally {
    if (!async) rmSync(dir, { recursive: true, force: true });
  }
}

const entries = (batches: ImportBatch[]): EntryInput[] => batches.flatMap((b) => b.entries ?? []);
const byId = (batches: ImportBatch[]) => new Map(entries(batches).map((e) => [e.externalId, e]));

describe('the import readers, wired in', () => {
  it('reads a .docx from a folder as a note, beside the .md and .txt notes', () =>
    withDir((dir) => {
      writeFileSync(join(dir, 'Garden plan.docx'), docx('Plant #garlic in October.', 'Then the beans.'));
      writeFileSync(join(dir, 'shed.md'), '---\ntitle: Shed\nStatus: open\ntags: [repairs]\n---\nFix the roof. #weekend');
      writeFileSync(join(dir, 'list.txt'), 'Buy twine');
      const warnings: string[] = [];
      const batches = readImports(dir, { onWarning: (m) => warnings.push(m) });
      expect(warnings).toEqual([]);
      expect(batches.map((b) => b.source.kind)).toEqual(['notes']);
      const notes = byId(batches);
      expect([...notes.keys()].sort()).toEqual(['Garden plan.docx', 'list.txt', 'shed.md']);
      const plan = notes.get('Garden plan.docx')!;
      expect(plan.title).toBe('Garden plan');
      expect(plan.body).toContain('Plant #garlic in October.\n\nThen the beans.');
      expect(plan.properties).toEqual({ title: 'Garden plan' });
      expect(plan.origin).toMatchObject({ path: join(dir, 'Garden plan.docx'), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const shed = notes.get('shed.md')!;
      expect(shed).toMatchObject({ title: 'Shed', body: 'Fix the roof. #weekend' });
      expect(shed.properties).toEqual({ title: 'Shed', Status: 'open', tags: ['repairs'] });
      expect(notes.get('list.txt')!.properties).toBeNull();
    }));

  it('reads a single named .docx, and refuses a damaged one by name', () =>
    withDir((dir) => {
      const path = join(dir, 'Minutes.docx');
      writeFileSync(path, docx('Agreed: #budget stays.'));
      const [batch] = readImports(path);
      expect(batch!.origin).toMatchObject({ path });
      expect(entries([batch!]).map((e) => [e.externalId, e.title])).toEqual([['Minutes.docx', 'Minutes']]);

      writeFileSync(join(dir, 'Broken.docx'), 'not a zip at all');
      const error = (() => {
        try {
          readImports(join(dir, 'Broken.docx'));
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(UnsafeFileError);
      expect((error as Error).message).toMatch(/Broken\.docx: refused, it is not a zip file/);
    }));

  it('in a folder, skips a damaged .docx by name and imports the rest', () =>
    withDir((dir) => {
      writeFileSync(join(dir, 'Broken.docx'), 'not a zip at all');
      writeFileSync(join(dir, 'fine.md'), 'fine');
      const warnings: string[] = [];
      const batches = readImports(dir, { onWarning: (m) => warnings.push(m) });
      expect([...byId(batches).keys()]).toEqual(['fine.md']);
      expect(warnings).toEqual([expect.stringMatching(/Broken\.docx: refused, it is not a zip file/)]);
    }));

  it('names a .docx inside a zip and leaves it unread; the zip text is decoded as its bytes say', () =>
    withDir((dir) => {
      const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('# Wide\nnote #w', 'utf16le')]);
      const zip = zipSync({
        'vault/Report.docx': docx('never read'),
        '__MACOSX/vault/._Report.docx': strToU8('junk'),
        'vault/wide.md': utf16,
        'vault/plain.md': strToU8('﻿---\ntitle: Marked\n---\nbody'),
      });
      const path = join(dir, 'vault.zip');
      writeFileSync(path, zip);
      const warnings: string[] = [];
      const batches = readImports(path, { onWarning: (m) => warnings.push(m) });
      expect(warnings).toEqual([`${path} (vault/Report.docx): skipped, a .docx is read on its own or from a folder, not from inside a zip`]);
      const notes = byId(batches);
      expect([...notes.keys()].sort()).toEqual(['vault/plain.md', 'vault/wide.md']);
      expect(notes.get('vault/wide.md')).toMatchObject({ title: 'Wide', body: '# Wide\nnote #w' });
      expect(notes.get('vault/plain.md')).toMatchObject({ title: 'Marked', properties: { title: 'Marked' } });
      expect(JSON.stringify(batches)).not.toContain('never read');
    }));

  it('skips a Templates folder, in a walk and in the live reads', () =>
    withDir((dir) => {
      mkdirSync(join(dir, 'Templates'));
      mkdirSync(join(dir, 'projects', 'templates'), { recursive: true });
      writeFileSync(join(dir, 'Templates', 'Daily.md'), '# {{date}}');
      writeFileSync(join(dir, 'projects', 'templates', 'Meeting.docx'), docx('{{agenda}}'));
      writeFileSync(join(dir, 'projects', 'real.md'), 'real');
      expect([...byId(readImports(dir)).keys()]).toEqual(['projects/real.md']);
      const live = readFilesUnder(dir, ['Templates/Daily.md', 'projects/templates/Meeting.docx', 'projects/real.md']);
      expect([...byId(live).keys()]).toEqual(['projects/real.md']);
    }));

  it('reads a .docx and a UTF-16 note in the live reads and in a worker, the same as in a walk', async () =>
    withDir(async (dir) => {
      writeFileSync(join(dir, 'Plan.docx'), docx('#seeds first'));
      writeFileSync(join(dir, 'wide.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('big endian #be', 'utf16le').swap16()]));
      const walked = readImports(dir);
      const live = readFilesUnder(dir, ['Plan.docx', 'wide.txt']);
      expect(entries(live)).toEqual(entries(walked));
      expect(await readImportsInWorker(dir)).toEqual(walked);
      expect(byId(walked).get('wide.txt')!.body).toBe('big endian #be');
    }));

  it("doesn't open a named file of a kind it doesn't read", () =>
    withDir((dir) => {
      const path = join(dir, 'photo.png');
      writeFileSync(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      expect(() => readImports(path)).toThrow(/Nothing to import/);
      expect(readImports(path, { emptyOk: true })).toEqual([]);
    }));
});
