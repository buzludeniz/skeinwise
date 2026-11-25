import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openZipSafe, readSafe, UnsafeFileError, type UnsafeReason } from '../fsafe.ts';
import type { EntryInput, ImportBatch, ThreadInput } from '../store/store.ts';
import { parseChatGPT, parseClaude, parseClaudeCodeSession, parseCodexSession, parseGemini } from './chats.ts';
import { noteEntry, parseNote } from './notes.ts';
import { asArray, isObj, parseJsonl } from './util.ts';

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

/** A file's contents, from disk or from inside a zip. Reading it may throw; collect() skips that file alone. */
interface RawFile {
  path: string;
  text: () => string;
  modifiedAt: Date;
}

function warner(options: ImportOptions): (message: string) => void {
  return options.onWarning ?? ((message) => console.warn(`skeinwise: ${message}`));
}

function why(error: unknown): string {
  if (error instanceof UnsafeFileError) return error.message;
  const e = error as NodeJS.ErrnoException;
  return e.path ? `${e.path}: skipped, ${e.code ?? e.message}` : String(e.message ?? error);
}

const NOTE_EXT = new Set(['.md', '.markdown', '.txt']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '.venv']);

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

/** A file found in a folder: read through fsafe, never through a link, and only inside the folder. */
function fileUnder(root: string, full: string, modifiedAt: Date): RawFile {
  return { path: full, text: () => readSafe(full, { root }).bytes.toString('utf8'), modifiedAt };
}

function walk(root: string, warn: (message: string) => void): RawFile[] {
  const out: RawFile[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) visit(full);
      } else if (entry.isFile()) {
        let modifiedAt: Date;
        try {
          modifiedAt = statSync(full).mtime;
        } catch (error) {
          warn(why(error));
          continue;
        }
        out.push(fileUnder(root, full, modifiedAt));
      } else if (!entry.name.startsWith('.') && wantedName(entry.name)) {
        // A link, FIFO, socket or device with a name Skeinwise would read: say why it was left out.
        warn(`${full}: skipped, it is ${entry.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}`);
      }
    }
  };
  visit(root);
  return out;
}

function wantedName(name: string): boolean {
  return /\.(json|jsonl|md|markdown|txt)$/i.test(name) && !name.includes('__MACOSX');
}

/** The zip's entries, inflated one at a time when collect() reads them. Close the zip afterwards. */
function unzip(file: string): { files: RawFile[]; close: () => void } {
  const zip = openZipSafe(file, { followLink: true, filter: wantedName });
  const files = zip.entries.map((entry) => ({
    path: entry.name,
    text: () => Buffer.from(zip.read(entry)).toString('utf8'),
    modifiedAt: zip.mtime,
  }));
  return { files, close: zip.close };
}

/**
 * Reads a path (a folder, a zip, or a single file) and returns one batch per source found in it.
 * Throws when the path holds nothing Skeinwise can read.
 */
export function readImports(path: string, options: ImportOptions = {}): ImportBatch[] {
  const abs = resolve(path);
  const warn = warner(options);
  // The person named this path, so a link here is followed; nothing found inside a folder is.
  const stat = statSync(abs);
  const isZip = stat.isFile() && extname(abs).toLowerCase() === '.zip';
  let batches: ImportBatch[];
  if (stat.isDirectory()) {
    batches = collect(walk(abs, warn), abs, (p) => relative(abs, p), options, warn);
  } else if (isZip) {
    const zip = unzip(abs);
    try {
      batches = collect(zip.files, abs, (p) => p, options, warn);
    } finally {
      zip.close();
    }
  } else {
    // A single named file: refused outright (a FIFO, a device, too big) rather than skipped, so the person hears why.
    const file = readSafe(abs, { followLink: true });
    const raw = { path: abs, text: () => file.bytes.toString('utf8'), modifiedAt: file.mtime };
    batches = collect([raw], dirname(abs), (p) => relative(dirname(abs), p), options, warn);
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
    if (rel.startsWith('..') || rel.split(/[\\/]/).some((part) => part.startsWith('.') || SKIP_DIRS.has(part))) continue;
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
  return collect(files, abs, (p) => relative(abs, p), options, warn);
}

function collect(
  files: RawFile[],
  root: string,
  rel: (p: string) => string,
  options: ImportOptions,
  warn: (message: string) => void,
): ImportBatch[] {
  const batches: ImportBatch[] = [];
  const sessions: Record<'claude-code' | 'codex', ThreadInput[]> = { 'claude-code': [], codex: [] };
  const notes: EntryInput[] = [];

  for (const f of files) {
    const ext = extname(f.path).toLowerCase();
    if (ext !== '.json' && ext !== '.jsonl' && !NOTE_EXT.has(ext)) continue;
    const name = basename(f.path);
    let text: string;
    try {
      text = f.text();
    } catch (error) {
      // One file that can't or mustn't be read never stops the others.
      if (error instanceof UnsafeFileError || (error as NodeJS.ErrnoException).code) {
        warn(why(error));
        continue;
      }
      throw error;
    }
    if (ext === '.json') {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      const kind = sniffExport(data);
      if (kind === 'chatgpt') batches.push(parseChatGPT(data));
      else if (kind === 'claude') batches.push(parseClaude(data));
      else if (kind === 'gemini') batches.push(parseGemini(data));
    } else if (ext === '.jsonl') {
      const kind = sniffSession(text);
      const id = name.replace(/\.jsonl$/i, '');
      if (kind === 'claude-code') sessions['claude-code'].push(parseClaudeCodeSession(text, id));
      else if (kind === 'codex') sessions.codex.push(parseCodexSession(text, id));
    } else {
      notes.push(noteEntry(rel(f.path), parseNote(name, text, f.modifiedAt)));
    }
  }

  if (sessions['claude-code'].length) {
    batches.push({ source: { kind: 'claude-code', label: 'Claude Code', location: root }, threads: sessions['claude-code'] });
  }
  if (sessions.codex.length) {
    batches.push({ source: { kind: 'codex', label: 'Codex', location: root }, threads: sessions.codex });
  }
  if (notes.length) {
    batches.push({
      source: { kind: 'notes', label: basename(root), location: root, owner: options.owner ?? 'you' },
      threads: [],
      entries: notes,
    });
  }
  return batches;
}
