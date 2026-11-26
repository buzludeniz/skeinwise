import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openZipSafe, UnsafeFileError, type UnsafeReason } from '../fsafe.ts';
import type { EntryInput, ImportBatch, Origin, ThreadInput } from '../store/store.ts';
import { parseChatGPT, parseClaude, parseClaudeCodeSession, parseCodexSession, parseGemini } from './chats.ts';
import { noteEntry, parseNote } from './notes.ts';
import { IMPORT_EXT, readImportFile } from './files.ts';
import { readZipText } from './text.ts';
import { asArray, FileReport, isObj, parseJsonl, str } from './util.ts';

export interface ImportOptions {
  /** Whose words a notes folder holds: 'you' (default) or a person's name. */
  owner?: string;
  /** Return no batches, instead of failing, when there is nothing to import (the record folder's own notes). */
  emptyOk?: boolean;
  /**
   * Hears each file or entry that was skipped (a link, a FIFO, a file over the limit, one that can't be read), with
   * a message naming it. Default: printed to stderr, so nothing is ever skipped silently.
   */
  onWarning?: (message: string) => void;
}

/** The names exports come under: one that won't parse is named, unlike any other JSON file that won't. */
const EXPORT_NAME = /^(conversations|MyActivity)\.json$/i;

/**
 * A file's contents, from disk or from inside a zip. Reading it may throw; collect() skips that file alone. A file on
 * disk also gives the SHA-256 of its bytes, its origin; a file inside a zip has the zip's.
 */
interface RawFile {
  path: string;
  read: () => { text: string; sha256?: string };
  modifiedAt: Date;
}

/**
 * The account an export claims, as a fingerprint: the SHA-256 of its kind and user id, never the id itself. The store
 * holds back an export whose fingerprint differs from the one its source was first imported with.
 */
export function accountFingerprint(kind: string, id: string): string {
  return createHash('sha256').update(`${kind}\0${id}`).digest('hex').slice(0, 32);
}

/** The user id in a Claude export (each conversation's account.uuid, or users.json) or ChatGPT's user.json. */
function accountId(kind: 'chatgpt' | 'claude' | 'gemini' | 'users', data: unknown): string | null {
  if (kind === 'claude') {
    for (const conv of asArray(data)) {
      const id = isObj(conv) && isObj(conv.account) ? str(conv.account.uuid) : undefined;
      if (id) return id;
    }
    return null;
  }
  if (kind === 'users') {
    // Claude's users.json is a list of one; ChatGPT's user.json is one object.
    const user = Array.isArray(data) ? data[0] : data;
    return isObj(user) ? (str(user.uuid) ?? str(user.id) ?? null) : null;
  }
  return null;
}

function warner(options: ImportOptions): (message: string) => void {
  return options.onWarning ?? ((message) => console.warn(`skeinwise: ${message}`));
}

function why(error: unknown): string {
  if (error instanceof UnsafeFileError) return error.message;
  const e = error as NodeJS.ErrnoException;
  return e.path ? `${e.path}: skipped, ${e.code ?? e.message}` : String(e.message ?? error);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '.venv']);
/** A notes app's templates folder: its notes are blanks to copy, not anything the person wrote (LS-19). */
const TEMPLATES_DIR = /^templates$/i;

function skippedDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name) || TEMPLATES_DIR.test(name);
}

export type ExportKind = 'chatgpt' | 'claude' | 'gemini';

export function sniffExport(data: unknown): ExportKind | null {
  const first = asArray(data).find(isObj);
  if (!first) return null;
  if ('mapping' in first) return 'chatgpt';
  if ('chat_messages' in first) return 'claude';
  if ('time' in first && 'title' in first) return 'gemini';
  return null;
}

export function sniffSession(text: string): 'claude-code' | 'codex' | null {
  const head = parseJsonl(text.slice(0, 20000));
  if (head.some((l) => l.type === 'session_meta' || l.type === 'response_item')) return 'codex';
  if (head.some((l) => (l.type === 'user' || l.type === 'assistant') && 'sessionId' in l)) return 'claude-code';
  return null;
}

/** A folder the person named, as it was when it was checked: its real path, and which folder that was. */
interface Pinned {
  real: string;
  dev: number;
  ino: number;
}

/**
 * A file found in a folder: read through fsafe, never through a link, and only inside the folder. fsafe resolves the
 * folder's real path again for each read, so a named folder is pinned: after the read it must still be the folder that
 * was checked, or it was swapped for a link meanwhile and the file may have come from anywhere.
 *
 * Not caught: a folder swapped for a link and swapped back between fsafe resolving it and the check below. The file
 * read in that window may come from wherever the link pointed, and the check then sees the pinned folder again.
 * Closing that needs reads relative to an open folder (openat, fdopendir), which Node doesn't offer.
 */
function fileUnder(root: string, full: string, modifiedAt: Date, pinned?: Pinned): RawFile {
  return {
    path: full,
    read: () => {
      const file = readImportFile(full, { root: pinned?.real ?? root });
      if (pinned) {
        const now = lstatSync(pinned.real);
        if (now.isSymbolicLink() || now.dev !== pinned.dev || now.ino !== pinned.ino) {
          throw new UnsafeFileError(full, 'outside', `${full}: skipped, the folder it was found in changed while it was being read`);
        }
      }
      return { text: file.text, sha256: file.sha256 };
    },
    modifiedAt,
  };
}

function walk(root: string, warn: (message: string) => void, pinned?: Pinned): RawFile[] {
  const out: RawFile[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDir(entry.name)) visit(full);
      } else if (entry.isFile()) {
        let modifiedAt: Date;
        try {
          modifiedAt = statSync(full).mtime;
        } catch (error) {
          warn(why(error));
          continue;
        }
        out.push(fileUnder(root, full, modifiedAt, pinned));
      } else if (!entry.name.startsWith('.') && IMPORT_EXT.has(extname(entry.name).toLowerCase())) {
        // A link, FIFO, socket or device with a name Skeinwise would read: say why it was left out.
        warn(`${full}: skipped, it is ${entry.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}`);
      }
    }
  };
  visit(root);
  return out;
}

/** The names read from inside a zip. A .docx isn't one: it is read on its own or from a folder, never from a zip. */
function wantedName(name: string): boolean {
  return /\.(json|jsonl|md|markdown|txt)$/i.test(name) && !name.includes('__MACOSX');
}

/**
 * The zip's entries, inflated one at a time when collect() reads them. Close the zip afterwards. `abs` is the path the
 * person named, for the origin and warnings; `real` is its real path, opened without following links. Each .docx inside
 * is named in a warning, unread.
 */
function unzip(abs: string, real: string, warn: (message: string) => void): { files: RawFile[]; origin: Origin; close: () => void } {
  const docx: string[] = [];
  const zip = openZipSafe(real, {
    filter: (name) => {
      if (/\.docx$/i.test(name) && !name.includes('__MACOSX')) docx.push(name);
      return wantedName(name);
    },
  });
  for (const name of docx) warn(`${abs} (${name}): skipped, a .docx is read on its own or from a folder, not from inside a zip`);
  const files = zip.entries.map((entry) => ({
    path: entry.name,
    read: () => ({ text: readZipText(zip, entry) }),
    modifiedAt: zip.mtime,
  }));
  return { files, origin: { path: abs, sha256: zip.sha256 }, close: zip.close };
}

/**
 * Reads a path (a folder, a zip, or a single file) and returns one batch per source found in it.
 * Throws when the path holds nothing Skeinwise can read.
 */
export function readImports(path: string, options: ImportOptions = {}): ImportBatch[] {
  const abs = resolve(path);
  const warn = warner(options);
  // The person named this path, so a link here is followed, and only here: resolved once, now, to `real`. Every open
  // after this is of `real` without following links, so a file swapped for a link after this check is refused, not
  // followed; a folder is pinned to the one found now (fileUnder). Nothing found inside a folder is followed.
  const real = realpathSync(abs);
  const stat = lstatSync(real);
  if (stat.isSymbolicLink()) throw new UnsafeFileError(abs, 'symlink', `${abs}: skipped, it became a symbolic link while it was being read`);
  const ext = extname(abs).toLowerCase();
  let batches: ImportBatch[];
  if (stat.isDirectory()) {
    batches = collect(walk(abs, warn, { real, dev: stat.dev, ino: stat.ino }), abs, (p) => relative(abs, p), options, warn, null);
  } else if (ext === '.zip') {
    const zip = unzip(abs, real, warn);
    try {
      batches = collect(zip.files, abs, (p) => p, options, warn, zip.origin);
    } finally {
      zip.close();
    }
  } else if (!IMPORT_EXT.has(ext)) {
    // A file of a kind Skeinwise doesn't read: not opened at all.
    batches = [];
  } else {
    // A single named file: refused outright (a FIFO, a device, too big, a damaged .docx) rather than skipped, so the
    // person hears why.
    const file = readImportFile(real);
    const raw = { path: abs, read: () => ({ text: file.text }), modifiedAt: file.mtime };
    batches = collect([raw], dirname(abs), (p) => relative(dirname(abs), p), options, warn, { path: abs, sha256: file.sha256 });
  }
  if (!batches.length && !options.emptyOk) throw new Error(`Nothing to import in ${path}`);
  return batches;
}

/** What a worker sends back: the batches, a warning, or the error that stopped it. */
type WorkerReply =
  | { type: 'warning'; message: string }
  | { type: 'done'; batches: ImportBatch[] }
  | { type: 'error'; message: string; path?: string; reason?: UnsafeReason };

// Next to this file: read-worker.ts when run from source, read-worker.js once built.
const WORKER_URL = new URL(`./read-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

/**
 * readImports in a worker thread, so inflating a zip or parsing a large export never blocks the event loop (the web
 * server keeps answering). Same results and errors; warnings arrive through options.onWarning as they happen.
 */
export function readImportsInWorker(path: string, options: ImportOptions = {}): Promise<ImportBatch[]> {
  const warn = warner(options);
  const { onWarning: _drop, ...plain } = options;
  return new Promise((done, fail) => {
    // The parent's flags, less --input-type, which Node refuses for a worker started from a file.
    const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
    const worker = new Worker(WORKER_URL, { workerData: { path, options: plain }, execArgv });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      fn();
    };
    worker.on('message', (reply: WorkerReply) => {
      if (reply.type === 'warning') warn(reply.message);
      else if (reply.type === 'done') finish(() => done(reply.batches));
      else
        finish(() =>
          fail(reply.reason && reply.path ? new UnsafeFileError(reply.path, reply.reason, reply.message) : new Error(reply.message)),
        );
    });
    worker.on('error', (error) => finish(() => fail(error)));
    worker.on('exit', (code) => finish(() => fail(new Error(`The import worker for ${path} stopped (exit ${code})`))));
  });
}

/**
 * Reads some files inside a folder that was imported (or watched) as a whole, so their entries land under that
 * folder's source with the same ids as a full import. Files that are gone or unreadable are skipped. Returns an
 * empty list when none of them holds anything Skeinwise reads.
 */
export function readFilesUnder(root: string, paths: string[], options: ImportOptions = {}): ImportBatch[] {
  const abs = resolve(root);
  const warn = warner(options);
  const files: RawFile[] = [];
  for (const p of paths) {
    const full = resolve(abs, p);
    const rel = relative(abs, full);
    if (rel.startsWith('..') || rel.split(/[\\/]/).some(skippedDir)) continue;
    let mtime: Date;
    try {
      mtime = statSync(full).mtime;
    } catch (error) {
      // Deleted between the change and the read: the record keeps what it had.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    // A link, a folder or a FIFO is refused by the read itself, with a warning, and skipped alone.
    files.push(fileUnder(abs, full, mtime));
  }
  return collect(files, abs, (p) => relative(abs, p), options, warn, null);
}

/**
 * Parses the files into one batch per source. `container` is the zip or single file they came from: it is every
 * batch's origin. Files from a folder have none, so each export batch, session thread and note carries its own file.
 */
function collect(
  files: RawFile[],
  root: string,
  rel: (p: string) => string,
  options: ImportOptions,
  warn: (message: string) => void,
  container: Origin | null,
): ImportBatch[] {
  const batches: ImportBatch[] = [];
  const sessions: Record<'claude-code' | 'codex', ThreadInput[]> = { 'claude-code': [], codex: [] };
  const notes: EntryInput[] = [];
  // users.json / user.json next to an export names its account; matched to the export after the loop.
  const users = new Map<string, string>();

  for (const f of files) {
    const ext = extname(f.path).toLowerCase();
    if (!IMPORT_EXT.has(ext)) continue;
    const name = basename(f.path);
    let text: string;
    let origin: Origin | null;
    try {
      const read = f.read();
      text = read.text;
      origin = container ?? (read.sha256 ? { path: f.path, sha256: read.sha256 } : null);
    } catch (error) {
      // One file that can't or mustn't be read never stops the others.
      if (error instanceof UnsafeFileError || (error as NodeJS.ErrnoException).code) {
        warn(why(error));
        continue;
      }
      throw error;
    }
    // Each entry in the file is parsed on its own and a bad one named in the report; this try is for the file as a whole.
    const report = new FileReport(rel(f.path), warn);
    try {
      if (ext === '.json') {
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch (error) {
          // Any JSON file is looked at, so only an export's own name is worth a word.
          if (EXPORT_NAME.test(name)) report.skip('', `it is not valid JSON (${(error as Error).message})`, 'file');
          continue;
        }
        const kind = sniffExport(data);
        const parse = kind === 'chatgpt' ? parseChatGPT : kind === 'claude' ? parseClaude : kind === 'gemini' ? parseGemini : null;
        if (parse && kind) {
          const id = accountId(kind, data);
          batches.push({ ...parse(data, report), origin, account: id ? accountFingerprint(kind, id) : null });
        } else if (/^users?\.json$/i.test(name)) {
          const id = accountId('users', data);
          if (id) users.set(dirname(f.path), id);
        }
      } else if (ext === '.jsonl') {
        const kind = sniffSession(text);
        const id = name.replace(/\.jsonl$/i, '');
        const own = container ? {} : { origin };
        if (kind === 'claude-code') sessions['claude-code'].push({ ...parseClaudeCodeSession(text, id, report), ...own });
        else if (kind === 'codex') sessions.codex.push({ ...parseCodexSession(text, id, report), ...own });
      } else {
        const note = report.each('', () => noteEntry(rel(f.path), parseNote(name, text, f.modifiedAt)));
        if (note) notes.push({ ...note, ...(container ? {} : { origin }) });
      }
    } catch (error) {
      report.skip('', error instanceof Error ? error.message : String(error), 'file');
    } finally {
      report.done();
    }
  }
  // An export without an account of its own takes the one its users.json names, from the same folder.
  for (const batch of batches) {
    const dir = batch.origin && !container ? dirname(batch.origin.path) : null;
    const id = users.get(dir ?? '') ?? (container && users.size === 1 ? [...users.values()][0] : undefined);
    if (!batch.account && id) batch.account = accountFingerprint(batch.source.kind, id);
  }

  if (sessions['claude-code'].length) {
    batches.push({ source: { kind: 'claude-code', label: 'Claude Code', location: root }, threads: sessions['claude-code'], origin: container });
  }
  if (sessions.codex.length) {
    batches.push({ source: { kind: 'codex', label: 'Codex', location: root }, threads: sessions.codex, origin: container });
  }
  if (notes.length) {
    batches.push({
      source: { kind: 'notes', label: basename(root), location: root, owner: options.owner ?? 'you' },
      threads: [],
      entries: notes,
      origin: container,
    });
  }
  return batches;
}
