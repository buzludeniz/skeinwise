// .md notes with front matter (LS-19): properties kept as written, tags merged, the byte order mark before `---`, and
// the hostile files (bomb, huge, odd encoding, truncated). Every hostile file is built here at run time.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8 } from 'fflate';
import { noteEntry, parseFrontMatter, parseNote } from '../src/importers/notes.ts';
import { decodeText, readTextFile, TEXT_MAX_BYTES } from '../src/importers/text.ts';
import { UnsafeFileError } from '../src/fsafe.ts';

const mtime = new Date('2026-01-05T12:00:00Z');

function linear(run: () => unknown, label: string): void {
  const started = performance.now();
  run();
  expect(performance.now() - started, label).toBeLessThan(1000);
}

describe('a plain .md note', () => {
  const text = [
    '---',
    'title: "Seed swap: \\"spring\\""',
    'created: 2025-03-01',
    'Status: draft',
    'tags: [Garden, seeds]',
    'tag: legacy',
    'rating: 007',
    'link: https://example.invalid/a:b',
    "'quoted key': 'it''s here'",
    'people:',
    '  - Ana',
    '  - "Bo, Jr"',
    'summary: |',
    '  Two lines',
    '    kept as written',
    'folded: >',
    '  one',
    '  two',
    'nested:',
    '  inner: skipped',
    'empty:',
    '# a comment',
    '---',
    '# Swap day',
    '',
    'Bring #seeds and [[Seed list]].',
  ].join('\n');

  it('keeps the front matter as properties, under its keys as written', () => {
    const note = parseNote('swap.md', text, mtime);
    expect(note.title).toBe('Seed swap: "spring"');
    expect(note.createdAt).toBe('2025-03-01T00:00:00.000Z');
    expect({ ...note.properties }).toEqual({
      title: 'Seed swap: "spring"',
      created: '2025-03-01',
      Status: 'draft',
      tags: ['Garden', 'seeds'],
      tag: 'legacy',
      rating: '007',
      link: 'https://example.invalid/a:b',
      'quoted key': "it's here",
      people: ['Ana', 'Bo, Jr'],
      summary: 'Two lines\n  kept as written',
      folded: 'one two',
      nested: '',
      empty: '',
    });
    expect(note.meta.status).toBe('draft');
    expect(note.body).toBe('# Swap day\n\nBring #seeds and [[Seed list]].');
  });

  it('merges the front matter tags with the inline ones', () => {
    expect(parseNote('swap.md', text, mtime).tags.sort()).toEqual(['garden', 'seeds']);
    expect(parseNote('old.md', '---\ntag: legacy\n---\nand #new', mtime).tags.sort()).toEqual(['legacy', 'new']);
    expect(parseNote('csv.md', '---\ntags: a, b c\n---\n', mtime).tags.sort()).toEqual(['a', 'b', 'c']);
  });

  it('gives the entry its properties, and none when the note has no front matter', () => {
    expect(noteEntry('swap.md', parseNote('swap.md', text, mtime)).properties).toMatchObject({ Status: 'draft', rating: '007' });
    expect(noteEntry('plain.md', parseNote('plain.md', '# Just text', mtime)).properties).toBeNull();
  });

  it('reads key:value without a space, as earlier versions did, but not a URL line', () => {
    expect({ ...parseFrontMatter('---\ncreated:2025-01-02\n---\n').properties }).toEqual({ created: '2025-01-02' });
  });
});

describe('a hostile .md note', () => {
  it('BOM: a byte order mark before `---` no longer hides the front matter', () => {
    const note = parseNote('bom.md', '﻿---\ntitle: Marked\n---\nbody', mtime);
    expect(note.title).toBe('Marked');
    expect(note.body).toBe('body');
    // From the bytes too: the decoder drops the mark first.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('---\ntitle: Bytes\n---\nbody')]);
    expect(parseNote('bom.md', decodeText(bytes, 'bom.md').text, mtime).title).toBe('Bytes');
  });

  it('bomb: shapes that would make a front matter or link parser backtrack read in linear time', () => {
    const n = 200_000;
    linear(() => parseNote('a.md', `---\n${'k: v\n'.repeat(n / 5)}`, mtime), 'front matter never closed');
    linear(() => parseNote('b.md', `---\n${'\n'.repeat(n)}x`, mtime), 'blank lines, never closed');
    linear(() => parseNote('c.md', `---\nlist:\n${'  - x\n'.repeat(n / 6)}---\n`, mtime), 'a long list');
    linear(() => parseNote('d.md', `---\nk: |\n${'  line\n'.repeat(n / 7)}---\n`, mtime), 'a long block');
    linear(() => parseNote('e.md', `---\n${'a:'.repeat(n / 2)}\n---\n`, mtime), 'colons without spaces');
    linear(() => parseNote('f.md', `---\nk${' '.repeat(n)}\n---\n`, mtime), 'a key of spaces');
    linear(() => parseNote('g.md', `---\n${'---'.repeat(n / 3)}`, mtime), 'dashes');
    linear(() => parseNote('h.md', `${'[['.repeat(n / 2)}`, mtime), 'links never closed');
    linear(() => parseNote('i.md', `---\nk: v\n---${' '.repeat(n)}x`, mtime), 'a closing line of spaces');
    expect(parseNote('c.md', `---\nlist:\n${'  - x\n'.repeat(n / 6)}---\n`, mtime).properties.list).toHaveLength(Math.floor(n / 6));
  });

  it('bomb: a key named __proto__ is a key, not a prototype', () => {
    const { properties, meta } = parseFrontMatter('---\n__proto__: [x]\nconstructor: c\n---\n');
    expect(Object.getPrototypeOf(properties)).toBeNull();
    expect(Object.getPrototypeOf(meta)).toBeNull();
    expect(Object.entries(properties)).toEqual([
      ['__proto__', ['x']],
      ['constructor', 'c'],
    ]);
    expect(JSON.parse(JSON.stringify(properties))).toEqual(JSON.parse('{"__proto__":["x"],"constructor":"c"}'));
  });

  it('huge: a note over the limit is refused unread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-md-'));
    try {
      const path = join(dir, 'huge.md');
      writeFileSync(path, '');
      truncateSync(path, TEXT_MAX_BYTES + 1);
      const error = (() => {
        try {
          readTextFile(path);
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(UnsafeFileError);
      expect((error as UnsafeFileError).reason).toBe('too-big');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('odd encoding: front matter in UTF-16 and with Windows line endings', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('---\r\ntitle: Wide\r\ntags: [w]\r\n---\r\nbody #x\r\n', 'utf16le')]);
    const note = parseNote('wide.md', decodeText(utf16, 'wide.md').text, mtime);
    expect(note).toMatchObject({ title: 'Wide', body: 'body #x' });
    expect(note.tags.sort()).toEqual(['w', 'x']);
  });

  it('truncated: front matter cut short stays text; a closing line at the very end still closes it', () => {
    const cut = parseNote('cut.md', '---\ntitle: Never closed\ntags: [a', mtime);
    expect(cut.title).toBe('cut');
    expect(cut.body).toBe('---\ntitle: Never closed\ntags: [a');
    expect({ ...cut.properties }).toEqual({});
    expect(parseNote('end.md', '---\ntitle: At the end\n---', mtime)).toMatchObject({ title: 'At the end', body: '' });
    expect({ ...parseFrontMatter('---\n---\nbody').properties }).toEqual({});
    expect(parseFrontMatter('---\n---\nbody').body).toBe('body');
    expect(parseNote('dots.md', '---\ntitle: Dots\n...\nbody', mtime).title).toBe('Dots');
    // A line that only starts with three dashes doesn't close it.
    expect(parseNote('rule.md', '---\ntitle: Rule\n----\nbody', mtime).title).toBe('rule');
  });
});
