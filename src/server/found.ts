// What Skeinwise can find on this computer for first run's "Bring in" and the app menu's "Connect": history folders,
// export files in Downloads, note folders, and the AI agents installed. Looks only; reads nothing into the record.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { readImportsInWorker } from '../importers/detect.ts';
import { isNoteFile } from '../importers/note-ext.ts';
import type { Source } from '../store/store.ts';

export type FoundKind = 'claude-code' | 'codex' | 'chatgpt' | 'claude' | 'gemini' | 'notes';

export interface Found {
  id: string;
  kind: FoundKind;
  label: string;
  path: string;
  /** Plain words about what is there: "12 sessions", "export from 3 Nov 2026". */
  detail: string;
  /** True when a note folder: the card asks whose words they are. */
  asksOwner: boolean;
  /** A source with this location (or, for an export, this kind) is already in the record. */
  inRecord: boolean;
}

const MAX_ZIP = 1024 * 1024 * 1024;

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

function countFiles(dir: string, test: (name: string) => boolean, limit = 20000): number {
  let n = 0;
  const visit = (d: string, depth: number) => {
    if (n >= limit || depth > 6) return;
    let list;
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') visit(join(d, e.name), depth + 1);
      } else if (test(e.name)) n += 1;
    }
  };
  visit(dir, 0);
  return n;
}

/** Which account export a zip holds, judged by the names of the files inside. */
export function exportKindOfZip(file: string): 'chatgpt' | 'claude' | 'gemini' | null {
  let names: string[] = [];
  try {
    if (statSync(file).size > MAX_ZIP) return null;
    unzipSync(new Uint8Array(readFileSync(file)), {
      filter: (f) => {
        names.push(f.name);
        return false;
      },
    });
  } catch {
    return null;
  }
  names = names.map((n) => n.toLowerCase());
  if (names.some((n) => n.endsWith('gemini apps/myactivity.json'))) return 'gemini';
  if (!names.some((n) => n.endsWith('conversations.json'))) return null;
  if (names.some((n) => n.endsWith('chat.html') || n.endsWith('message_feedback.json') || n.endsWith('shared_conversations.json'))) {
    return 'chatgpt';
  }
  if (names.some((n) => n.endsWith('users.json') || n.endsWith('projects.json'))) return 'claude';
  return null;
}

const EXPORT_LABEL = { chatgpt: 'ChatGPT export', claude: 'Claude export', gemini: 'Gemini export' } as const;

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Looks in the usual places under `root` (the home directory unless told otherwise). */
export function findSources(root: string, inRecord: readonly Source[]): Found[] {
  const found: Found[] = [];
  const locations = new Set(inRecord.map((s) => s.location && resolve(s.location)));
  const kinds = new Set(inRecord.map((s) => s.kind));
  const add = (kind: FoundKind, label: string, path: string, detail: string) => {
    const abs = resolve(path);
    found.push({
      id: createHash('sha256').update(abs).digest('hex').slice(0, 16),
      kind,
      label,
      path: abs,
      detail,
      asksOwner: kind === 'notes',
      inRecord: locations.has(abs) || (['chatgpt', 'claude', 'gemini'].includes(kind) && kinds.has(kind)),
    });
  };

  const claudeCode = join(root, '.claude', 'projects');
  if (existsSync(claudeCode)) {
    const n = countFiles(claudeCode, (f) => f.endsWith('.jsonl'));
    if (n) add('claude-code', 'Claude Code history', claudeCode, `${n} session${n === 1 ? '' : 's'}`);
  }
  const codex = join(root, '.codex', 'sessions');
  if (existsSync(codex)) {
    const n = countFiles(codex, (f) => f.endsWith('.jsonl'));
    if (n) add('codex', 'Codex history', codex, `${n} session${n === 1 ? '' : 's'}`);
  }

  const downloads = join(root, 'Downloads');
  try {
    for (const name of readdirSync(downloads)) {
      if (!name.toLowerCase().endsWith('.zip')) continue;
      const file = join(downloads, name);
      const kind = exportKindOfZip(file);
      if (kind) add(kind, EXPORT_LABEL[kind], file, `${name}, saved ${day(statSync(file).mtimeMs)}`);
    }
  } catch {
    // No Downloads folder: nothing to find there.
  }

  // Note folders: Obsidian vaults (a folder holding .obsidian) and folders named Notes, one or two levels down.
  const candidates = new Set<string>();
  for (const dir of [root, join(root, 'Documents'), ...safeDirs(join(root, 'Documents')), join(root, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents')]) {
    if (existsSync(join(dir, '.obsidian'))) candidates.add(dir);
    for (const sub of safeDirs(dir)) {
      if (existsSync(join(sub, '.obsidian')) || /^notes$/i.test(basename(sub))) candidates.add(sub);
    }
  }
  for (const dir of candidates) {
    const n = countFiles(dir, isNoteFile);
    if (!n) continue;
    const vault = existsSync(join(dir, '.obsidian'));
    add('notes', vault ? `Obsidian vault: ${basename(dir)}` : `Notes: ${basename(dir)}`, dir, `${n} note${n === 1 ? '' : 's'}`);
  }
  return found;
}

export interface Preview {
  entries: number;
  threads: number;
  first: string | null;
  last: string | null;
}

/**
 * Reads a found source the way an import would, without saving anything, to say how much it holds. The read runs in a
 * worker through part A's reader, as an import does, so a large source never blocks the server.
 */
export async function preview(path: string): Promise<Preview> {
  let entries = 0;
  let threads = 0;
  let first: string | null = null;
  let last: string | null = null;
  const see = (at: string) => {
    // An empty time means the export didn't say when: it counts as an entry, but not toward first or last.
    if (!at) return;
    if (!first || at < first) first = at;
    if (!last || at > last) last = at;
  };
  for (const batch of await readImportsInWorker(path)) {
    threads += batch.threads.length;
    const all = [...batch.threads.flatMap((t) => t.entries), ...(batch.entries ?? [])];
    entries += all.length;
    for (const e of all) see(e.createdAt);
  }
  return { entries, threads, first, last };
}

export interface Agent {
  key: string;
  label: string;
  found: boolean;
}

/** The AI agents whose config folders exist on this computer. */
export function findAgents(root: string): Agent[] {
  const list: [string, string, string][] = [
    ['claude-code', 'Claude Code', '.claude'],
    ['codex', 'Codex', '.codex'],
    ['cursor', 'Cursor', '.cursor'],
    ['claude-desktop', 'Claude desktop', join('Library', 'Application Support', 'Claude')],
  ];
  return list.map(([key, label, dir]) => ({ key, label, found: existsSync(join(root, dir)) }));
}
