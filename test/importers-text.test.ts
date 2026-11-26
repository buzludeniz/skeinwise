// .txt as notes, and the decoder every imported text goes through: a plain file, then the hostile ones (bomb, huge,
// odd encoding, truncated). Every hostile file is built here at run time.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, strToU8 } from 'fflate';
import { buildZip } from './fsafe-zip.ts';
import { openZipSafe, UnsafeFileError } from '../src/fsafe.ts';
import { parseNote } from '../src/importers/notes.ts';
import { decodeText, readTextFile, readZipText, TEXT_MAX_BYTES } from '../src/importers/text.ts';

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-text-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function refusal(run: () => unknown): UnsafeFileError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsafeFileError) return error;
    throw error;
  }
  throw new Error('expected the file to be refused');
}

const utf16be = (s: string) => Buffer.from(s, 'utf16le').swap16();
function utf32(s: string, littleEndian: boolean): Buffer {
  const points = [...s].map((c) => c.codePointAt(0)!);
  const out = Buffer.alloc(points.length * 4);
  points.forEach((cp, i) => (littleEndian ? out.writeUInt32LE(cp, i * 4) : out.writeUInt32BE(cp, i * 4)));
  return out;
}

describe('a plain .txt file', () => {
  it('reads as a note, with its sha256 and modified time', () => {
    withDir((dir) => {
      const path = join(dir, 'ideas.txt');
      writeFileSync(path, 'Plant garlic in October.\nCheck the shed roof. #garden\n');
      const file = readTextFile(path);
      expect(file).toMatchObject({ text: 'Plant garlic in October.\nCheck the shed roof. #garden\n', encoding: 'utf-8', bom: false, replaced: false });
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      const note = parseNote('ideas.txt', file.text, file.mtime);
      expect(note).toMatchObject({ title: 'ideas', tags: ['garden'], createdAt: file.mtime.toISOString() });
    });
  });
});

describe('a hostile .txt file', () => {
  it('bomb: text shaped to make a parser backtrack reads in linear time', () => {
    const n = 200_000;
    for (const text of ['#'.repeat(n), ' #a'.repeat(n / 3), '[['.repeat(n / 2), '---\n' + 'k: v\n'.repeat(n / 5), 'a:'.repeat(n / 2), '﻿'.repeat(n)]) {
      const started = performance.now();
      parseNote('x.txt', decodeText(strToU8(text), 'x.txt').text, new Date());
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it('bomb: a note inside a zip that unpacks past what it declares is refused by name', () => {
    withDir((dir) => {
      const path = join(dir, 'notes.zip');
      writeFileSync(path, buildZip([{ name: 'big.txt', data: deflateSync(new Uint8Array(1024 ** 2).fill(97)), size: 100 }]));
      const zip = openZipSafe(path);
      try {
        expect(refusal(() => readZipText(zip, zip.entries[0]!)).message).toMatch(/notes\.zip \(big\.txt\): refused, it unpacks past the 100 bytes it declared/);
      } finally {
        zip.close();
      }
    });
  });

  it('huge: a note over the limit is refused unread; in a zip, before it is inflated', () => {
    withDir((dir) => {
      const path = join(dir, 'huge.txt');
      writeFileSync(path, '');
      truncateSync(path, TEXT_MAX_BYTES + 1);
      const error = refusal(() => readTextFile(path));
      expect(error.reason).toBe('too-big');
      expect(error.message).toMatch(/huge\.txt: skipped, it holds 16 MiB, more than the 16 MiB limit/);
      // A smaller limit asked for by the caller wins; a larger one doesn't.
      writeFileSync(join(dir, 'small.md'), 'x'.repeat(2048));
      expect(refusal(() => readTextFile(join(dir, 'small.md'), { maxBytes: 1024 })).reason).toBe('too-big');
      expect(refusal(() => readTextFile(path, { maxBytes: 2 * TEXT_MAX_BYTES })).reason).toBe('too-big');

      const zipped = join(dir, 'notes.zip');
      writeFileSync(zipped, buildZip([{ name: 'vault/huge.md', data: deflateSync(new Uint8Array(1)), size: 17 * 1024 ** 2 }]));
      const zip = openZipSafe(zipped);
      try {
        const started = performance.now();
        expect(refusal(() => readZipText(zip, zip.entries[0]!)).message).toMatch(/notes\.zip \(vault\/huge\.md\): skipped, it holds 17 MiB, more than the 16 MiB limit/);
        expect(performance.now() - started).toBeLessThan(100);
      } finally {
        zip.close();
      }
    });
  });

  it('huge: an export (.json) keeps the reader own, larger limit', () => {
    withDir((dir) => {
      const path = join(dir, 'conversations.json');
      writeFileSync(path, `[${' '.repeat(TEXT_MAX_BYTES + 10)}]`);
      expect(readTextFile(path).text.length).toBe(TEXT_MAX_BYTES + 12);
    });
  });

  it('odd encoding: follows a byte order mark, finds UTF-16 without one, and drops the mark', () => {
    const text = 'Café ☕ \u{1F331}\nline two';
    const cases: [string, Uint8Array, string, boolean][] = [
      ['utf-8 with BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), 'utf-8', true],
      ['utf-16le with BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), 'utf-16le', true],
      ['utf-16be with BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(text)]), 'utf-16be', true],
      ['utf-16le without BOM', Buffer.from(text, 'utf16le'), 'utf-16le', false],
      ['utf-16be without BOM', utf16be(text), 'utf-16be', false],
      ['utf-32le with BOM', Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), utf32(text, true)]), 'utf-32le', true],
      ['utf-32be with BOM', Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), utf32(text, false)]), 'utf-32be', true],
    ];
    for (const [label, bytes, encoding, bom] of cases) {
      expect(decodeText(bytes, label), label).toEqual({ text, encoding, bom, replaced: false });
    }
  });

  it('odd encoding: replaces invalid bytes, refuses binary data by name, and replaces a late NUL', () => {
    expect(decodeText(new Uint8Array([0x61, 0xff, 0x62, 0xc0, 0xaf]), 'x.txt')).toMatchObject({ text: 'a�b��', replaced: true });
    const binary = refusal(() => decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]), 'photo.txt'));
    expect(binary.reason).toBe('not-a-file');
    expect(binary.message).toBe('photo.txt: skipped, it holds binary data, not text');
    const late = decodeText(strToU8(`${'a'.repeat(9000)}\0b`), 'late.txt');
    expect(late).toMatchObject({ replaced: true });
    expect(late.text.endsWith('a�b')).toBe(true);
    // Bytes that are only zeros and odd bytes don't look like UTF-16 to the sniffer: read as UTF-8 and refused.
    expect(refusal(() => decodeText(new Uint8Array(64), 'zeros.txt')).reason).toBe('not-a-file');
  });

  it('truncated: a cut multibyte character, an odd UTF-16 length, a cut surrogate pair and a short UTF-32 tail', () => {
    const euro = Buffer.from('price €');
    expect(decodeText(euro.subarray(0, euro.length - 1), 'cut.txt')).toMatchObject({ text: 'price �', replaced: true });
    const odd = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le'), Buffer.from([0x21])]);
    expect(decodeText(odd, 'odd.txt')).toMatchObject({ text: 'hi�', encoding: 'utf-16le', replaced: true });
    const pair = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ok \u{1F331}', 'utf16le')]);
    expect(decodeText(pair.subarray(0, pair.length - 2), 'pair.txt')).toMatchObject({ text: 'ok �', replaced: true });
    const wide = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), utf32('ab', true), Buffer.from([0x63, 0])]);
    expect(decodeText(wide, 'wide.txt')).toMatchObject({ text: 'ab�', encoding: 'utf-32le', replaced: true });
    const outOfRange = Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), Buffer.from([0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0xd8, 0x00])]);
    expect(decodeText(outOfRange, 'range.txt')).toMatchObject({ text: '��', replaced: true });
  });

  it('decodes an empty file, and a file of one BOM, as empty text', () => {
    expect(decodeText(new Uint8Array(0), 'empty.txt')).toEqual({ text: '', encoding: 'utf-8', bom: false, replaced: false });
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf]), 'bom.txt')).toEqual({ text: '', encoding: 'utf-8', bom: true, replaced: false });
  });
});
