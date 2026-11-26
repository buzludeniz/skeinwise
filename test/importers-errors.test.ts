// What stops an import and what only skips one file: a refusal or a system error skips the file it came from, and any
// other error, a bug, stops the import. The file reader is replaced to throw on cue, as nothing real throws a bug.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = vi.hoisted(() => ({ name: '', error: null as unknown }));

vi.mock('../src/importers/files.ts', async (importOriginal) => {
  const files = await importOriginal<typeof import('../src/importers/files.ts')>();
  return {
    ...files,
    readImportFile: (...args: Parameters<typeof files.readImportFile>) => {
      if (fail.name && args[0].endsWith(fail.name)) throw fail.error;
      return files.readImportFile(...args);
    },
  };
});

const { readImports } = await import('../src/importers/detect.ts');
const { UnsafeFileError } = await import('../src/fsafe.ts');

let vault: string;
beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), 'skeinwise-errors-'));
  mkdirSync(join(vault, 'notes'));
  writeFileSync(join(vault, 'notes', 'kept.md'), '# Kept\n\nSeed swap on Saturday.\n');
  writeFileSync(join(vault, 'notes', 'bad.md'), '# Bad\n');
});
afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
});

function read(error: unknown) {
  fail.name = 'bad.md';
  fail.error = error;
  const warnings: string[] = [];
  try {
    const batches = readImports(vault, { onWarning: (m) => warnings.push(m) });
    return { ids: batches.flatMap((b) => b.entries ?? []).map((e) => e.externalId), warnings };
  } finally {
    fail.name = '';
  }
}

describe('an error reading one file of a folder', () => {
  it('skips the file on a refusal or a system error, and reads the rest', () => {
    const refusal = new UnsafeFileError(join(vault, 'notes', 'bad.md'), 'too-big', 'bad.md: skipped, it is too big');
    const system = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: join(vault, 'notes', 'bad.md') });
    expect(read(refusal)).toEqual({ ids: ['notes/kept.md'], warnings: ['bad.md: skipped, it is too big'] });
    expect(read(system)).toEqual({ ids: ['notes/kept.md'], warnings: [`${join(vault, 'notes', 'bad.md')}: skipped, EACCES`] });
  });

  it('stops the import on any other error, even one with a code that is not a system one', () => {
    // fflate's errors carry a number, and its "unexpected EOF" is 0: neither may pass as a file to skip.
    for (const code of [0, 7, undefined]) {
      const bug = Object.assign(new Error(`a bug, code ${code}`), code === undefined ? {} : { code });
      expect(() => read(bug)).toThrow(`a bug, code ${code}`);
    }
  });
});
