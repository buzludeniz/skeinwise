// Files the server writes in the record folder (notes). None of them is ever opened through a symbolic link, so a link
// planted in the folder can't point a write, or a read, at a file elsewhere (L8). An lstat check refuses a link before
// the open, and the open itself uses O_NOFOLLOW where the system has it, so a link swapped in after the check fails
// too. Windows has no O_NOFOLLOW, so there the check stands alone, as in src/fsafe.ts.

import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, sep } from 'node:path';

const { O_CREAT, O_EXCL, O_RDONLY, O_TRUNC, O_WRONLY } = constants;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A file the server won't touch: a symbolic link, or one whose folder lies outside the folder it should be in. */
export class UnsafeFile extends Error {}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Throws UnsafeFile when the name is a symbolic link. Nothing there is not a link: the open decides. */
function refuseLink(file: string, verb: 'read' | 'write'): void {
  let link = false;
  try {
    link = lstatSync(file).isSymbolicLink();
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
  if (link) throw new UnsafeFile(`${file} is a symbolic link, so Skeinwise won't ${verb} through it`);
}

function write(file: string, text: string, flags: number): void {
  // O_EXCL fails on any name that is taken, a link included, on every system.
  if (!(flags & O_EXCL)) refuseLink(file, 'write');
  let fd: number;
  try {
    fd = openSync(file, flags | O_NOFOLLOW, 0o600);
  } catch (error) {
    if (code(error) === 'ELOOP') throw new UnsafeFile(`${file} is a symbolic link, so Skeinwise won't write through it`);
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Writes a new owner-only file. False when the name is taken (by anything, a link included), so the caller picks another. */
export function writeNew(file: string, text: string): boolean {
  try {
    write(file, text, O_WRONLY | O_CREAT | O_EXCL);
    return true;
  } catch (error) {
    if (code(error) === 'EEXIST') return false;
    throw error;
  }
}

/** Writes a file, replacing what is there; a new one is owner-only. Refuses a link at that name. */
export function writeOver(file: string, text: string): void {
  write(file, text, O_WRONLY | O_CREAT | O_TRUNC);
}

/** Reads a file, or null when there is none. Refuses a link at that name. */
export function readPlain(file: string): string | null {
  refuseLink(file, 'read');
  let fd: number;
  try {
    fd = openSync(file, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    if (code(error) === 'ELOOP') throw new UnsafeFile(`${file} is a symbolic link, so Skeinwise won't read through it`);
    throw error;
  }
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Whether the file's folder, links resolved, is `root` or inside it. False when the folder doesn't exist. */
export function folderInside(root: string, file: string): boolean {
  try {
    const top = realpathSync(root);
    const folder = realpathSync(dirname(file));
    return folder === top || folder.startsWith(top + sep);
  } catch {
    return false;
  }
}
