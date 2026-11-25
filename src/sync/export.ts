// `skeinwise export`: the record as a zip anyone can read without Skeinwise. Each chat is one Markdown file, each
// other entry (a note, a file) is one, the record folder's notes are copied as they are on disk, and what the
// organiser made (tags, folders, hubs, runs) is JSON. It is plain text, not a backup: a sync bundle is the copy that
// rebuilds a record.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { UsageError } from '../errors.ts';
import { day, minute, speakerLabel } from '../format.ts';
import { homeNoteFile, notesDir, slugify } from '../notes.ts';
import { listRuns } from '../organiser/runs.ts';
import { definedTags, hubEntryIds, liveFolders, liveHubs, liveTags, schemas } from '../organiser/views.ts';
import type { Entry, Store } from '../store/store.ts';
import { writeAtomic } from './bundle.ts';

interface Row extends Entry {
  sourceStatus: 'in' | 'out' | 'later';
  threadStartedAt: string | null;
  notMine: number | null;
}

export interface ExportCounts {
  chats: number;
  entries: number;
  notes: number;
  hubs: number;
  runs: number;
}

export interface ExportResult extends ExportCounts {
  file: string;
  bytes: number;
}

/** Every entry at its current version, excluded sources and threads that aren't yours included: they are still yours to keep. */
function allRows(store: Store): Row[] {
  return store.db
    .prepare(
      `SELECT e.id, e.source_id AS sourceId, s.kind AS sourceKind, s.label AS sourceLabel, s.status AS sourceStatus,
              e.thread_id AS threadId, t.title AS threadTitle, t.started_at AS threadStartedAt, t.not_mine AS notMine,
              e.external_id AS externalId, e.kind, e.speaker, e.title, e.created_at AS createdAt, e.seq, e.version, v.body
       FROM entries e
       JOIN versions v ON v.entry_id = e.id AND v.version = e.version
       JOIN sources s ON s.id = e.source_id
       LEFT JOIN threads t ON t.id = e.thread_id
       ORDER BY e.thread_id, e.seq, e.created_at, e.id`,
    )
    .all() as unknown as Row[];
}

/** YAML front matter. Strings are written double-quoted (JSON's quoting is valid YAML), so a colon in a title is safe. */
function frontMatter(fields: Record<string, string | number | boolean | null | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

function fileName(date: string, title: string | null | undefined, id: number): string {
  const slug = slugify(title ?? '').slice(0, 60).replace(/-+$/, '') || 'untitled';
  return `${day(date)}-${slug}-${id}.md`;
}

function folderName(kind: string): string {
  return slugify(kind) || 'other';
}

function chatMarkdown(rows: Row[]): string {
  const first = rows[0]!;
  const head = frontMatter({
    thread: first.threadId,
    source: first.sourceLabel,
    kind: first.sourceKind,
    started: first.threadStartedAt ?? first.createdAt,
    entries: rows.length,
    excluded: first.sourceStatus !== 'in' ? first.sourceStatus : undefined,
    'not-mine': first.notMine === 1,
  });
  const parts = rows.map((e) => `## ${speakerLabel(e)} · ${minute(e.createdAt)} · entry ${e.id}${e.version > 1 ? ` (version ${e.version})` : ''}\n\n${e.body}\n`);
  return `${head}\n# ${first.threadTitle ?? 'Untitled chat'}\n\n${parts.join('\n')}`;
}

function entryMarkdown(e: Row): string {
  const head = frontMatter({
    entry: e.id,
    source: e.sourceLabel,
    kind: e.kind,
    speaker: e.speaker,
    created: e.createdAt,
    version: e.version,
    excluded: e.sourceStatus !== 'in' ? e.sourceStatus : undefined,
  });
  return `${head}\n${e.title ? `# ${e.title}\n\n` : ''}${e.body}\n`;
}

const README = (exportedAt: string) => `# Skeinwise export

Exported ${exportedAt}. Everything here is plain text.

- \`chats/<source>/\`: one Markdown file per chat, every message under its own heading with who said it, when, and its
  entry number.
- \`entries/<source>/\`: one Markdown file per entry that is not part of a chat: notes and files you imported.
- \`notes/\`: the notes in your record folder, file for file, as they are on disk.
- \`tags.json\`, \`folders.json\`, \`hubs.json\`: what the organiser made, as it stands now. Entries are named by their
  entry number, the one in each Markdown heading or front matter.
- \`runs.json\`: every organiser run, oldest first, with its engine, model, scope and counts.
- \`record.json\`: when this was exported, the sources and the counts.

Only the newest version of each entry is here. A sync bundle (skeinwise sync) holds the whole record, history included.
`;

/** Builds the export zip in memory. */
export function exportZip(store: Store, home: string): { zip: Uint8Array; counts: ExportCounts } {
  const db = store.db;
  const exportedAt = store.now();
  const top = `skeinwise-export-${day(exportedAt)}`;
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string) => (files[`${top}/${path}`] = new TextEncoder().encode(text));
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  const rows = allRows(store);
  const threads = new Map<number, Row[]>();
  let entries = 0;
  for (const e of rows) {
    if (e.threadId !== null) {
      const list = threads.get(e.threadId) ?? [];
      list.push(e);
      threads.set(e.threadId, list);
      continue;
    }
    // A note in the record folder goes in as its own file below; the entry would only repeat it.
    const own = homeNoteFile(store, home, e);
    if (own && existsSync(own)) continue;
    put(`entries/${folderName(e.sourceKind)}/${fileName(e.createdAt, e.title ?? e.body.split('\n')[0], e.id)}`, entryMarkdown(e));
    entries++;
  }
  for (const [id, list] of threads) {
    const first = list[0]!;
    put(`chats/${folderName(first.sourceKind)}/${fileName(first.threadStartedAt ?? first.createdAt, first.threadTitle, id)}`, chatMarkdown(list));
  }

  let notes = 0;
  const dir = notesDir(home);
  const walk = (d: string) => {
    // Sorted, so two exports of the same record list their files in the same order.
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        files[`${top}/notes/${relative(dir, full).split(/[\\/]/).join('/')}`] = new Uint8Array(readFileSync(full));
        notes++;
      }
    }
  };
  if (existsSync(dir)) walk(dir);

  put(
    'tags.json',
    json(
      schemas(db).map((s) => ({
        schema: s.name,
        description: s.description,
        builtin: s.builtin,
        defined: definedTags(db, s.id).map((t) => ({ name: t.name, description: t.description })),
        tags: liveTags(db, s.id).map((t) => ({ name: t.name, entries: t.entryIds })),
      })),
    ),
  );
  put('folders.json', json(liveFolders(db).map((f) => ({ name: f.name, aliases: f.aliases, entries: f.entryIds }))));
  const hubs = liveHubs(db);
  put('hubs.json', json(hubs.map((h) => ({ id: h.id, name: h.name, sections: h.sections, entries: hubEntryIds(db, h.id) }))));
  const runs = listRuns(db, -1).reverse();
  put('runs.json', json(runs));
  const counts: ExportCounts = { chats: threads.size, entries, notes, hubs: hubs.length, runs: runs.length };
  put('record.json', json({ exportedAt, ...counts, sources: store.sources() }));
  put('README.md', README(exportedAt));
  return { zip: zipSync(files, { level: 6 }), counts };
}

/** Writes the export to a file (owner-only, since it is your record in plain text). Refuses to replace one unless forced. */
export function writeExport(store: Store, home: string, file: string, options: { force?: boolean } = {}): ExportResult {
  const st = statSync(file, { throwIfNoEntry: false });
  if (st?.isDirectory()) throw new UsageError(`${file} is a folder. Give a file name, for example: ${join(file, 'skeinwise-export.zip')}`);
  if (st && !options.force) throw new UsageError(`${file} already exists. Give another name, or add --force to replace it.`);
  const { zip, counts } = exportZip(store, home);
  writeAtomic(file, zip);
  return { file, bytes: zip.byteLength, ...counts };
}
