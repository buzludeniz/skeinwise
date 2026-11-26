// An entry's id is the path inside its folder joined with "/" on every system (pathInside, src/importers/detect.ts).
// The note writers look a file up by that id. Built with relative() instead, the id has "\" on Windows and finds
// nothing, which kept every daily note (notes/daily/) out of the record there. macOS and Linux can't see that, so this
// test reads the source: in the files that look a note up by its id, relative() is left only for containment checks.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The files that write a note and then find its entry by id. */
const LOOKUPS = ['src/notes.ts', 'src/server/notes.ts'];

/** A containment check: whether a path stays inside the notes folder. Its result is never an id. */
const CHECK = /outside\(|!relative\(|^\s*const rel = relative\(dir, full\);$/;

describe('note entry ids', () => {
  it.each(LOOKUPS)('%s builds ids and file names with pathInside, and calls relative() only to check containment', (file) => {
    const lines = readFileSync(join(import.meta.dirname, '..', file), 'utf8').split('\n');
    const naming = lines.flatMap((line, i) => (/\brelative\(/.test(line) && !CHECK.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
    expect(naming).toEqual([]);
  });
});
