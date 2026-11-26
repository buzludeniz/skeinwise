// A path the person names is checked once and never reopened through a link (detect.ts). These tests swap the file or
// folder for a link right after the check, through a pass-through node:fs whose hook runs once, after the named call.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { UnsafeFileError } from '../src/fsafe.ts';
import { readImports } from '../src/importers/detect.ts';

const swap = vi.hoisted(() => ({ call: '', name: '', run: null as null | (() => void) }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const { basename } = await import('node:path');
  // Runs the armed swap once, right after the armed call on a path with the armed base name.
  const after = <A extends unknown[], R>(call: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      const result = fn(...args);
      if (swap.run && swap.call === call && basename(String(args[0])) === swap.name) {
        const run = swap.run;
        swap.run = null;
        run();
      }
      return result;
    };
  const realpathSync = Object.assign(after('realpathSync', fs.realpathSync as (path: string) => string), { native: fs.realpathSync.native });
  return { ...fs, statSync: after('statSync', fs.statSync), lstatSync: after('lstatSync', fs.lstatSync), realpathSync };
});

/** After the first `call` on a path named `name`, `path` is moved aside and a link to `to` put in its place. */
function swapAfter(call: 'realpathSync' | 'lstatSync' | 'statSync', path: string, to: string): void {
  swap.call = call;
  swap.name = path.split('/').pop()!;
  swap.run = () => {
    renameSync(path, `${path}.moved`);
    symlinkSync(to, path);
  };
}

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-race-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  swap.run = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function outcome(run: () => unknown): { error?: unknown; result?: unknown } {
  try {
    return { result: run() };
  } catch (error) {
    return { error };
  }
}

describe('a named path swapped for a link after it was checked', () => {
  const secret = () => {
    const outside = scratch();
    writeFileSync(join(outside, 'secret.md'), 'FAKE-SECRET');
    writeFileSync(join(outside, 'secret.zip'), zipSync({ 'conversations.json': strToU8('"FAKE-SECRET"'), 'n.md': strToU8('FAKE-SECRET') }));
    return outside;
  };

  for (const call of ['realpathSync', 'lstatSync', 'statSync'] as const) {
    it(`refuses a note file swapped after ${call}`, () => {
      const outside = secret();
      const dir = scratch();
      const path = join(dir, 'note.md');
      writeFileSync(path, 'mine');
      swapAfter(call, path, join(outside, 'secret.md'));
      const { error, result } = outcome(() => readImports(path));
      expect(JSON.stringify(result ?? null)).not.toContain('FAKE-SECRET');
      // statSync is no longer called on the named path: then nothing is swapped and the file reads as it was.
      if (call === 'statSync') expect(result).toBeDefined();
      else {
        expect(error).toBeInstanceOf(UnsafeFileError);
        expect((error as UnsafeFileError).reason).toBe('symlink');
      }
    });
  }

  it('refuses a zip swapped after it was checked', () => {
    const outside = secret();
    const dir = scratch();
    const path = join(dir, 'export.zip');
    writeFileSync(path, zipSync({ 'n.md': strToU8('mine') }));
    swapAfter('lstatSync', path, join(outside, 'secret.zip'));
    const { error, result } = outcome(() => readImports(path));
    expect(result).toBeUndefined();
    expect((error as UnsafeFileError).reason).toBe('symlink');
  });

  it("reads nothing from a folder swapped for a link to another: its files aren't inside the folder that was named", () => {
    const outside = secret();
    const dir = scratch();
    const vault = join(dir, 'vault');
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
    const dir = scratch();
    const vault = join(dir, 'vault');
    mkdirSync(vault);
    writeFileSync(join(vault, 'mine.md'), 'mine');
    swapAfter('realpathSync', vault, outside);
    const { error } = outcome(() => readImports(vault));
    expect((error as UnsafeFileError).reason).toBe('symlink');
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
