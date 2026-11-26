// The write guard of the fuzz worker: while a target runs, any node:fs call that would write outside the target's own
// folder is refused (it throws, and nothing is written) and recorded, so the run reports it even when the target
// catches the error. node:fs's writing calls are wrapped once, in the worker, with installWriteGuard; ES module
// imports of them see the wrappers through syncBuiltinESMExports. Writes through a FileHandle aren't seen: the
// readers fuzzed here are synchronous and use none.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class OutsideWriteError extends Error {
  override name = 'OutsideWriteError';
}

const state = { active: false, root: '', writes: [] as string[], fds: new Set<number>() };

const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
const WRITING = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND;

function writingFlags(flags: unknown): boolean {
  if (typeof flags === 'number') return (flags & WRITING) !== 0;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return false;
}

/** A path argument as a string, or null for a file descriptor. */
function pathOf(p: unknown): string | null {
  if (typeof p === 'string') return p;
  if (p instanceof URL) return fileURLToPath(p);
  if (p instanceof Uint8Array) return Buffer.from(p).toString();
  return null;
}

function inside(path: string): boolean {
  const rel = relative(state.root, resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function check(call: string, target: unknown): void {
  if (!state.active) return;
  const path = pathOf(target);
  if (path !== null ? inside(path) : state.fds.has(target as number)) return;
  const what = `${call}(${path ?? `fd ${String(target)}`})`;
  state.writes.push(what);
  throw new OutsideWriteError(`fuzz guard: ${what} is outside ${state.root}`);
}

type Fn = (...args: unknown[]) => unknown;

function wrap(object: object, name: string, before: (args: unknown[]) => void, after?: (result: unknown, args: unknown[]) => void): void {
  const holder = object as Record<string, unknown>;
  const original = holder[name];
  if (typeof original !== 'function') return;
  holder[name] = function (this: unknown, ...args: unknown[]): unknown {
    before(args);
    const result = (original as Fn).apply(this, args);
    after?.(result, args);
    return result;
  };
}

/** Calls that write at the path in their first argument. */
const AT_FIRST = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes'];
/** Calls that write at the path in their second argument (and rename, at both). */
const AT_SECOND = ['copyFile', 'cp', 'link', 'symlink', 'rename'];
/** Calls that write through a file descriptor. */
const BY_FD = ['write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'fdatasync', 'fsync'];

let installed = false;

export function installWriteGuard(): void {
  if (installed) return;
  installed = true;
  for (const name of AT_FIRST) {
    for (const [object, call] of [[fs, name], [fs, `${name}Sync`], [fs.promises, name]] as const) wrap(object, call, (args) => check(call, args[0]));
  }
  for (const name of AT_SECOND) {
    for (const [object, call] of [[fs, name], [fs, `${name}Sync`], [fs.promises, name]] as const) {
      wrap(object, call, (args) => {
        if (name === 'rename') check(call, args[0]);
        check(call, args[1]);
      });
    }
  }
  for (const name of BY_FD) for (const call of [name, `${name}Sync`]) wrap(fs, call, (args) => check(call, args[0]));
  wrap(fs, 'createWriteStream', (args) => check('createWriteStream', args[0]));
  for (const [object, call] of [[fs, 'open'], [fs.promises, 'open']] as const) {
    wrap(object, call, (args) => {
      if (writingFlags(args[1])) check(call, args[0]);
    });
  }
  // A descriptor opened for writing inside the folder may be written through.
  wrap(
    fs,
    'openSync',
    (args) => {
      if (writingFlags(args[1])) check('openSync', args[0]);
    },
    (fd, args) => {
      if (state.active && writingFlags(args[1])) state.fds.add(fd as number);
    },
  );
  syncBuiltinESMExports();
}

/** From now until endWrites, writes are allowed only inside `root`. */
export function beginWrites(root: string): void {
  state.active = true;
  state.root = resolve(root);
  state.writes = [];
  state.fds.clear();
}

/** The writes refused since beginWrites. */
export function endWrites(): string[] {
  state.active = false;
  return state.writes;
}
