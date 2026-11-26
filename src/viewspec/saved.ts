// Saved views: one JSON file per view in <home>/views/, private to you (folder 0700, files 0600). The server makes
// each file's id from the view's title (lower-case letters, digits and dashes, at most 40) and builds the path from
// that id alone: no name or path ever comes from the page or the model. A file is created only if nothing is there
// (so a link or an older view is never written through), and every read checks the spec again, refuses links and
// anything that isn't a plain file, and caps the size. A file that fails is listed with its reasons, not dropped.

import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../errors.ts';
import { checkSpecValue, parseSpecText, SPEC_LIMITS, type ViewSpec } from './spec.ts';

export const MAX_SAVED = 200;
export const VIEW_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FILE = /^([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\.json$/;

export interface SavedView {
  id: string;
  spec: ViewSpec;
  savedAt: string;
}

export interface BrokenView {
  id: string;
  reasons: string[];
}

/** No saved view has this id (or the id isn't one the server would make). */
export class ViewNotFound extends Error {}

export function viewsDir(home: string): string {
  return join(home, 'views');
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** The views folder: made private when it isn't there yet (or null, when asked not to), refused when it is a link. */
function folder(home: string, create: boolean): string | null {
  const dir = viewsDir(home);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UsageError(`${dir} isn't a plain folder, so Skeinwise won't keep views there.`);
    return dir;
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
    if (!create) return null;
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }
}

/** A view's id from its title: "Café & garden, 2025" → "cafe-garden-2025"; "view" when nothing is left. */
export function slugFor(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || 'view';
}

function savedNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => FILE.test(n))
    .sort();
}

/** Checks a spec and saves it under a new id: the title's slug, then slug-2, slug-3 and so on. */
export function saveView(home: string, input: unknown): SavedView {
  const checked = checkSpecValue(input);
  if (!checked.ok) throw new UsageError(`That view can't be saved. ${checked.reasons.join(' ')}`);
  const spec = checked.spec;
  const dir = folder(home, true)!;
  if (savedNames(dir).length >= MAX_SAVED) throw new UsageError(`You have ${MAX_SAVED} saved views, the most Skeinwise keeps. Delete one first.`);
  const text = `${JSON.stringify(spec, null, 2)}\n`;
  const base = slugFor(spec.title);
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const file = join(dir, `${id}.json`);
    try {
      // 'wx' creates the file or fails: it never writes through a link or over another view.
      writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (code(error) === 'EEXIST') continue;
      throw error;
    }
    chmodSync(file, 0o600);
    return { id, spec, savedAt: lstatSync(file).mtime.toISOString() };
  }
  throw new UsageError(`There are too many saved views called "${spec.title}". Give this one another title.`);
}

function readOne(dir: string, id: string): SavedView | BrokenView | null {
  const file = join(dir, `${id}.json`);
  let text: string;
  let savedAt: string;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return { id, reasons: ["It isn't a plain file (a link or a folder), so it wasn't read."] };
    // O_NOFOLLOW where the platform has it, so a link swapped in after the check above still isn't followed.
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const open = fstatSync(fd);
      if (!open.isFile()) return { id, reasons: ["It isn't a plain file, so it wasn't read."] };
      const buf = Buffer.alloc(SPEC_LIMITS.text + 1);
      const got = readSync(fd, buf, 0, buf.length, 0);
      if (got > SPEC_LIMITS.text) return { id, reasons: [`It is larger than ${SPEC_LIMITS.text} bytes.`] };
      text = buf.subarray(0, got).toString('utf8');
      savedAt = open.mtime.toISOString();
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    return { id, reasons: [`It couldn't be read (${code(error) ?? 'error'}).`] };
  }
  const r = parseSpecText(text);
  return r.ok ? { id, spec: r.spec, savedAt } : { id, reasons: r.reasons };
}

/** Every saved view, newest first, and the files that didn't pass with their reasons. */
export function listViews(home: string): { views: SavedView[]; broken: BrokenView[] } {
  const dir = folder(home, false);
  const views: SavedView[] = [];
  const broken: BrokenView[] = [];
  if (!dir) return { views, broken };
  for (const name of savedNames(dir).slice(0, MAX_SAVED)) {
    const one = readOne(dir, FILE.exec(name)![1]!);
    if (!one) continue;
    if ('spec' in one) views.push(one);
    else broken.push(one);
  }
  views.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
  return { views, broken };
}

/** Deletes one saved view's file (a link is removed, never what it points at). */
export function deleteView(home: string, id: string): void {
  if (!VIEW_ID.test(id)) throw new ViewNotFound(`No saved view ${JSON.stringify(id.slice(0, 40))}.`);
  const dir = folder(home, false);
  if (!dir) throw new ViewNotFound(`No saved view "${id}".`);
  const file = join(dir, `${id}.json`);
  try {
    if (lstatSync(file).isDirectory()) throw new UsageError(`${file} is a folder, so Skeinwise won't delete it.`);
    unlinkSync(file);
  } catch (error) {
    if (code(error) === 'ENOENT') throw new ViewNotFound(`No saved view "${id}".`);
    throw error;
  }
}
