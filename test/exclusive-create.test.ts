import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureServerKey } from '../src/model-commands.ts';
import { serverKeyPath } from '../src/organiser/model.ts';
import { newToken } from '../src/server/token.ts';
import { writeAtomic } from '../src/sync/bundle.ts';
import { expectMode } from './modes.ts';

// The files Skeinwise creates with O_CREAT | O_EXCL, with a link planted at the name. Windows has no O_NOFOLLOW, and
// there O_EXCL follows a dangling link and creates its target (L8, fixed for new notes in 1e8e9a8). These run on every
// OS; Windows CI is where the dangling-link cases bite.

let dir: string;
let home: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-excl-'));
  home = join(dir, 'home');
  outside = join(dir, 'outside');
  mkdirSync(home);
  mkdirSync(outside);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the model server's key", () => {
  it('is made once, random and owner-only', () => {
    const file = ensureServerKey(home);
    expect(file).toBe(serverKeyPath(home));
    const key = readFileSync(file, 'utf8');
    expect(key).toMatch(/^[\w-]{43}\n$/);
    expectMode(file, 0o600);
    expect(ensureServerKey(home)).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(key);
  });

  it('is never written through a dangling link at its name', () => {
    mkdirSync(join(home, 'models'));
    const target = join(outside, 'key-written-here');
    symlinkSync(target, serverKeyPath(home));
    expect(() => ensureServerKey(home)).toThrow(/\.key is a link, so Skeinwise won't use it as the model server's key/);
    expect(existsSync(target)).toBe(false);
  });

  it('is never taken from the file a link points to', () => {
    mkdirSync(join(home, 'models'));
    const target = join(outside, 'known-key');
    writeFileSync(target, 'a key someone else knows\n', { mode: 0o644 });
    symlinkSync(target, serverKeyPath(home));
    expect(() => ensureServerKey(home)).toThrow(/is a link/);
    expect(readFileSync(target, 'utf8')).toBe('a key someone else knows\n');
    expectMode(target, 0o644);
  });
});

describe('the files written under a random temporary name', () => {
  it("a new access token replaces a link at the token's name, and leaves no temporary file", () => {
    const target = join(outside, 'token-written-here');
    symlinkSync(target, join(home, 'token'));
    const token = newToken(home);
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(join(home, 'token')).isFile()).toBe(true);
    expect(readFileSync(join(home, 'token'), 'utf8')).toBe(`${token}\n`);
    expectMode(join(home, 'token'), 0o600);
    expect(readdirSync(home)).toEqual(['token']);
  });

  it('a bundle file replaces a link at its name, and leaves no part file', () => {
    const target = join(outside, 'bundle-written-here');
    const path = join(home, 'sync', 'record.bundle');
    mkdirSync(join(home, 'sync'));
    symlinkSync(target, path);
    writeAtomic(path, 'whole');
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('whole');
    expectMode(path, 0o600);
    expect(readdirSync(join(home, 'sync'))).toEqual(['record.bundle']);
  });
});
