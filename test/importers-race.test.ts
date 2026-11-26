// A path the person names is checked once and never reopened through a link (detect.ts), and the safe reader opens a
// file only if it is the one its own check saw (fsafe.ts). These tests swap the file or folder for a link right after a
// check, through a pass-through node:fs whose hook runs once, after the nth call of one kind on one base name.
//
// Every case runs twice: with the system's O_NOFOLLOW, and as on Windows, where there is none and an open follows a
// link (fsafe.ts is loaded again with O_NOFOLLOW missing). On Windows both runs take the Windows path. The checks that
// compare file ids also run with ids past a double's precision, as a 64-bit Windows file id can be.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const swap = vi.hoisted(() => ({
  call: '',
  name: '',
  /** Matching calls still to come before the swap runs. */
  left: 0,
  run: null as null | (() => void),
  /** False: O_NOFOLLOW reads as missing, as on Windows, for the copy of fsafe.ts loaded next. */
  noFollow: true,
  /** Whether this system has O_NOFOLLOW at all. */
  systemNoFollow: true,
  /** lstat reports file id 0, as a file system without file ids does. */
  zeroIno: false,
  /** Every file id is 2^60 plus the real one in bigint, and 2^60 alone as a number: the low bits a number loses. */
  highIds: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const { basename } = await import('node:path');
  swap.systemNoFollow = fs.constants.O_NOFOLLOW !== undefined;
  // Runs the armed swap once, right after the armed call on a path with the armed base name.
  const after =
    <A extends unknown[], R>(call: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      const result = fn(...args);
      if (swap.run && swap.call === call && basename(String(args[0])) === swap.name && --swap.left === 0) {
        const run = swap.run;
        swap.run = null;
        run();
      }
      return result;
    };
  // The stats objects are new on every call, so their file id can be changed in place.
  const ids = <S>(stat: S, zero = false): S => {
    const s = stat as { ino: number | bigint } | undefined;
    if (!s) return stat;
    const big = typeof s.ino === 'bigint';
    if (zero) s.ino = big ? 0n : 0;
    else if (swap.highIds) s.ino = big ? (1n << 60n) + (s.ino as bigint) : 2 ** 60;
    return stat;
  };
  const lstat = ((...args: Parameters<typeof fs.lstatSync>) => ids(fs.lstatSync(...args), swap.zeroIno)) as typeof fs.lstatSync;
  const stat = ((...args: Parameters<typeof fs.statSync>) => ids(fs.statSync(...args))) as typeof fs.statSync;
  const fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => ids(fs.fstatSync(...args))) as typeof fs.fstatSync;
  const realpathSync = Object.assign(after('realpathSync', fs.realpathSync as (path: string) => string), { native: fs.realpathSync.native });
  const constants = Object.defineProperty({ ...fs.constants }, 'O_NOFOLLOW', {
    enumerable: true,
    get: () => (swap.noFollow ? fs.constants.O_NOFOLLOW : undefined),
  });
  return { ...fs, constants, statSync: after('statSync', stat), lstatSync: after('lstatSync', lstat), fstatSync, realpathSync };
});

type Call = 'realpathSync' | 'lstatSync' | 'statSync';

/** Runs `run` once, right after the nth `call` on a path named `on`. */
function armAfter(call: Call, on: string, nth: number, run: () => void): void {
  swap.call = call;
  swap.name = on;
  swap.left = nth;
  swap.run = run;
}

/** After the nth `call` on a path named `on` (by default, like `path`), `path` is moved aside and a link to `to` put in
 * its place. */
function swapAfter(call: Call, path: string, to: string, nth = 1, on = basename(path)): void {
  armAfter(call, on, nth, () => {
    renameSync(path, `${path}.moved`);
    symlinkSync(to, path);
  });
}

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-race-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  swap.run = null;
  swap.zeroIno = false;
  swap.highIds = false;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function outcome(run: () => unknown): { error?: unknown; result?: unknown } {
  try {
    return { result: run() };
  } catch (error) {
    return { error };
  }
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const docx = (text: string) =>
  zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) });

/** A folder outside the one named, holding a note and a zip that must never be read. */
function secret(): string {
  const outside = scratch();
  writeFileSync(join(outside, 'secret.md'), 'FAKE-SECRET');
  writeFileSync(join(outside, 'secret.zip'), zipSync({ 'conversations.json': strToU8('"FAKE-SECRET"'), 'n.md': strToU8('FAKE-SECRET') }));
  return outside;
}

for (const windows of [false, true]) {
  describe(windows ? 'as on Windows, where an open follows a link' : "with the system's own open", () => {
    let readImports: typeof import('../src/importers/detect.ts').readImports;
    let UnsafeFileError: typeof import('../src/fsafe.ts').UnsafeFileError;
    let readSafe: typeof import('../src/fsafe.ts').readSafe;
    beforeAll(async () => {
      swap.noFollow = !windows;
      vi.resetModules();
      ({ readImports } = await import('../src/importers/detect.ts'));
      ({ UnsafeFileError, readSafe } = await import('../src/fsafe.ts'));
    });
    const followsLinks = () => windows || !swap.systemNoFollow;

    describe('a named path swapped for a link after it was checked', () => {
      for (const call of ['realpathSync', 'lstatSync', 'statSync'] as const) {
        it(`refuses a note file swapped after ${call}`, () => {
          const outside = secret();
          const path = join(scratch(), 'note.md');
          writeFileSync(path, 'mine');
          swapAfter(call, path, join(outside, 'secret.md'));
          const { error, result } = outcome(() => readImports(path));
          expect(JSON.stringify(result ?? null)).not.toContain('FAKE-SECRET');
          // statSync is no longer called on the named path: then nothing is swapped and the file reads as it was.
          if (call === 'statSync') expect(result).toBeDefined();
          else {
            expect(error).toBeInstanceOf(UnsafeFileError);
            expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('symlink');
          }
        });
      }

      it('refuses a zip swapped after it was checked', () => {
        const outside = secret();
        const path = join(scratch(), 'export.zip');
        writeFileSync(path, zipSync({ 'n.md': strToU8('mine') }));
        swapAfter('lstatSync', path, join(outside, 'secret.zip'));
        const { error, result } = outcome(() => readImports(path));
        expect(result).toBeUndefined();
        expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('symlink');
      });

      it("reads nothing from a folder swapped for a link to another: its files aren't inside the folder that was named", () => {
        const outside = secret();
        const vault = join(scratch(), 'vault');
        mkdirSync(vault);
        writeFileSync(join(vault, 'mine.md'), 'mine');
        swapAfter('lstatSync', vault, outside);
        const warnings: string[] = [];
        const { error, result } = outcome(() => readImports(vault, { onWarning: (m) => warnings.push(m) }));
        expect(JSON.stringify(result ?? null)).not.toContain('FAKE-SECRET');
        expect((error as Error).message).toMatch(/Nothing to import/);
        expect(warnings).toEqual([expect.stringMatching(/secret\.md: skipped, the folder it was found in changed while it was being read/)]);
      });

      it('refuses a folder swapped right after it was resolved', () => {
        const outside = secret();
        const vault = join(scratch(), 'vault');
        mkdirSync(vault);
        writeFileSync(join(vault, 'mine.md'), 'mine');
        swapAfter('realpathSync', vault, outside);
        const { error } = outcome(() => readImports(vault));
        expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('symlink');
        expect((error as Error).message).toMatch(/vault: skipped, it became a symbolic link while it was being read/);
      });

      it('still follows a link the person named, to the file it points at', () => {
        const dir = scratch();
        writeFileSync(join(dir, 'real.md'), '# Real');
        symlinkSync(join(dir, 'real.md'), join(dir, 'named.md'));
        const [batch] = readImports(join(dir, 'named.md'));
        expect(batch!.entries!.map((e) => e.title)).toEqual(['Real']);
        expect(batch!.origin!.path).toBe(join(dir, 'named.md'));
      });
    });

    // The safe reader's own lstat is the second on a named file (detect.ts's is the first) and the first on a file found
    // in a folder. A swap right after it lands before the open: O_NOFOLLOW refuses the link, and without it the open
    // follows it, so the file opened is checked to be the one the lstat saw.
    describe("a file swapped for a link between the reader's check and its open", () => {
      for (const [name, target, body] of [
        ['note.md', 'secret.md', strToU8('mine')],
        ['export.zip', 'secret.zip', zipSync({ 'n.md': strToU8('mine') })],
        ['Plan.docx', 'secret.docx', docx('mine')],
      ] as const) {
        it(`refuses a named ${name}`, () => {
          const outside = secret();
          writeFileSync(join(outside, 'secret.docx'), docx('FAKE-SECRET'));
          const path = join(scratch(), name);
          writeFileSync(path, body);
          swapAfter('lstatSync', path, join(outside, target), 2);
          const { error, result } = outcome(() => readImports(path));
          expect(JSON.stringify(result ?? null)).not.toContain('FAKE-SECRET');
          expect(error).toBeInstanceOf(UnsafeFileError);
          expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('symlink');
          expect(swap.run).toBeNull();
        });
      }

      it('skips a file found in a named folder, and names it', () => {
        const outside = secret();
        const vault = join(scratch(), 'vault');
        mkdirSync(vault);
        writeFileSync(join(vault, 'mine.md'), 'mine');
        swapAfter('lstatSync', join(vault, 'mine.md'), join(outside, 'secret.md'));
        const warnings: string[] = [];
        const { error, result } = outcome(() => readImports(vault, { onWarning: (m) => warnings.push(m) }));
        expect(JSON.stringify(result ?? null)).not.toContain('FAKE-SECRET');
        expect((error as Error).message).toMatch(/Nothing to import/);
        expect(warnings).toEqual([expect.stringMatching(/mine\.md: skipped, /)]);
        expect(swap.run).toBeNull();
      });

      it('refuses a file whose drive gives no file ids where the open follows links, and reads it where it does not', () => {
        const path = join(scratch(), 'note.md');
        writeFileSync(path, 'mine');
        swap.zeroIno = true;
        const { error, result } = outcome(() => readImports(path));
        if (followsLinks()) {
          expect(result).toBeUndefined();
          expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('symlink');
          expect((error as Error).message).toMatch(/note\.md: skipped, its drive gives no file ids/);
        } else {
          expect(JSON.stringify(result)).toContain('mine');
        }
      });
    });

    // A file id compared as a number loses its low bits past 2^53, so two files can look like one: every compare is in
    // bigint, and each case runs with ids past that too.
    describe('a folder replaced while a file in it is read, told apart by file id', () => {
      for (const highIds of [false, true]) {
        const past = highIds ? ', with file ids past a double' : '';

        it(`refuses a file whose folder became a link to another inside the root, right after the open${past}`, () => {
          const vault = scratch();
          mkdirSync(join(vault, 'sub'));
          mkdirSync(join(vault, 'other'));
          writeFileSync(join(vault, 'sub', 'note.md'), 'mine');
          writeFileSync(join(vault, 'other', 'note.md'), 'other');
          swap.highIds = highIds;
          // openSafe resolves the opened file's real path; right after that, sub becomes a link to other.
          swapAfter('realpathSync', join(vault, 'sub'), join(vault, 'other'), 1, 'note.md');
          const { error } = outcome(() => readSafe(join(vault, 'sub', 'note.md'), { root: vault }));
          expect(swap.run).toBeNull();
          expect(error).toBeInstanceOf(UnsafeFileError);
          expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('outside');
          expect((error as Error).message).toMatch(/note\.md: skipped, it changed while it was being read/);
        });

        it(`reads nothing from a named folder swapped for another folder, not a link${past}`, () => {
          const outside = secret();
          const vault = join(scratch(), 'vault');
          mkdirSync(vault);
          writeFileSync(join(vault, 'mine.md'), 'mine');
          swap.highIds = highIds;
          armAfter('lstatSync', 'vault', 1, () => {
            renameSync(vault, `${vault}.moved`);
            renameSync(outside, vault);
          });
          const warnings: string[] = [];
          const { error, result } = outcome(() => readImports(vault, { onWarning: (m) => warnings.push(m) }));
          expect(swap.run).toBeNull();
          expect(JSON.stringify(result ?? null)).not.toContain('FAKE-SECRET');
          expect((error as Error).message).toMatch(/Nothing to import/);
          expect(warnings).toEqual([expect.stringMatching(/secret\.md: skipped, the folder it was found in changed while it was being read/)]);
        });
      }
    });
  });
}
