import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { EntryInput, ImportBatch, ThreadInput } from '../store/store.ts';
import { parseChatGPT, parseClaude, parseClaudeCodeSession, parseCodexSession, parseGemini } from './chats.ts';
import { noteEntry, parseNote } from './notes.ts';
import { asArray, isObj, parseJsonl } from './util.ts';

export interface ImportOptions {
  /** Whose words a notes folder holds: 'you' (default) or a person's name. */
  owner?: string;
  /** Return no batches, instead of failing, when there is nothing to import (the record folder's own notes). */
  emptyOk?: boolean;
}

/** A file's contents, from disk or from inside a zip. */
interface RawFile {
  path: string;
  text: () => string;
  modifiedAt: Date;
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

function walk(root: string): RawFile[] {
  const out: RawFile[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) visit(full);
      } else if (entry.isFile()) {
        out.push({ path: full, text: () => readFileSync(full, 'utf8'), modifiedAt: statSync(full).mtime });
      }
    }
  };
  visit(root);
  return out;
}

function unzip(file: string): RawFile[] {
  const modifiedAt = statSync(file).mtime;
  const wanted = (name: string) => /\.(json|jsonl|md|markdown|txt)$/i.test(name) && !name.includes('__MACOSX');
  const files = unzipSync(new Uint8Array(readFileSync(file)), { filter: (f) => wanted(f.name) });
  return Object.entries(files).map(([name, bytes]) => ({ path: name, text: () => strFromU8(bytes), modifiedAt }));
}

/**
 * Reads a path (a folder, a zip, or a single file) and returns one batch per source found in it.
 * Throws when the path holds nothing Skeinwise can read.
 */
export function readImports(path: string, options: ImportOptions = {}): ImportBatch[] {
  const abs = resolve(path);
  const stat = statSync(abs);
  const isZip = stat.isFile() && extname(abs).toLowerCase() === '.zip';
  const files = stat.isDirectory() ? walk(abs) : isZip ? unzip(abs) : [{ path: abs, text: () => readFileSync(abs, 'utf8'), modifiedAt: stat.mtime }];
  const root = stat.isDirectory() ? abs : isZip ? abs : dirname(abs);
  const rel = (p: string) => (isZip ? p : relative(root, p));

  const batches: ImportBatch[] = [];
  const sessions: Record<'claude-code' | 'codex', ThreadInput[]> = { 'claude-code': [], codex: [] };
  const notes: EntryInput[] = [];

  for (const f of files) {
    const ext = extname(f.path).toLowerCase();
    const name = basename(f.path);
    if (ext === '.json') {
      let data: unknown;
      try {
        data = JSON.parse(f.text());
      } catch {
        continue;
      }
      const kind = sniffExport(data);
      if (kind === 'chatgpt') batches.push(parseChatGPT(data));
      else if (kind === 'claude') batches.push(parseClaude(data));
      else if (kind === 'gemini') batches.push(parseGemini(data));
    } else if (ext === '.jsonl') {
      const text = f.text();
      const kind = sniffSession(text);
      const id = name.replace(/\.jsonl$/i, '');
      if (kind === 'claude-code') sessions['claude-code'].push(parseClaudeCodeSession(text, id));
      else if (kind === 'codex') sessions.codex.push(parseCodexSession(text, id));
    } else if (NOTE_EXT.has(ext)) {
      notes.push(noteEntry(rel(f.path), parseNote(name, f.text(), f.modifiedAt)));
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
  if (!batches.length && !options.emptyOk) throw new Error(`Nothing to import in ${path}`);
  return batches;
}
