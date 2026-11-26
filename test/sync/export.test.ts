import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notesDir } from '../../src/notes.ts';
import { listRuns } from '../../src/organiser/runs.ts';
import { liveHubs } from '../../src/organiser/views.ts';
import type { Store } from '../../src/store/store.ts';
import { exportZip, writeExport } from '../../src/sync/export.ts';
import { closeRecords, count, demoRecord } from './fixture.ts';
import { expectMode } from '../modes.ts';

// `skeinwise export` on the demo record: what is in the zip, and that it is readable without Skeinwise.

let dir: string;
let a: { home: string; store: Store };
let files: Record<string, string>;
const top = 'skeinwise-export-2026-11-20/';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-export-'));
  a = await demoRecord(dir, 'a');
  // One source set aside: its chats are still yours, so they are exported, marked.
  a.store.db.prepare(`UPDATE sources SET status = 'out' WHERE kind = 'claude-code'`).run();
  const zip = unzipSync(exportZip(a.store, a.home).zip);
  files = Object.fromEntries(Object.entries(zip).map(([k, v]) => [k, strFromU8(v)]));
});
afterAll(() => {
  closeRecords();
  rmSync(dir, { recursive: true, force: true });
});

const under = (prefix: string) => Object.keys(files).filter((k) => k.startsWith(top + prefix));

describe('skeinwise export', () => {
  it('puts everything in one dated folder, with a README saying what is where', () => {
    for (const k of Object.keys(files)) expect(k.startsWith(top)).toBe(true);
    for (const f of ['README.md', 'tags.json', 'folders.json', 'hubs.json', 'runs.json', 'record.json']) expect(files[top + f], f).toBeDefined();
    expect(files[`${top}README.md`]).toMatch(/^# Skeinwise export/);
  });

  it('writes each chat as one Markdown file, every message under a heading with who, when and its entry number', () => {
    const chats = under('chats/');
    expect(chats.length).toBe(count(a.store.db, 'threads'));
    expect(new Set(chats.map((k) => k.split('/')[2]))).toEqual(new Set(['chatgpt', 'claude', 'claude-code']));
    for (const k of chats) {
      expect(k).toMatch(/\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+-\d+\.md$/);
      expect(files[k]).toMatch(/^---\nthread: \d+\nsource: ".*"\nkind: "[a-z-]+"\nstarted: ".*"\nentries: \d+\n/);
      expect(files[k]).toMatch(/\n## (You|Assistant|.+) · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · entry \d+\n/);
    }
    const headings = chats.reduce((n, k) => n + (files[k]!.match(/^## .* · entry \d+/gm)?.length ?? 0), 0);
    const inThreads = Number((a.store.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE thread_id IS NOT NULL').get() as { n: number }).n);
    expect(headings).toBe(inThreads);
    const setAside = chats.filter((k) => k.includes('/claude-code/'));
    for (const k of setAside) expect(files[k]).toContain('\nexcluded: "out"\n');
    for (const k of chats.filter((k) => !k.includes('/claude-code/'))) expect(files[k]).not.toContain('excluded:');
  });

  it('copies the record folder’s notes as they are on disk, and does not repeat them as entries', () => {
    const onDisk = readdirSync(notesDir(a.home), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(under('notes/').length).toBe(onDisk.length);
    for (const e of onDisk) {
      // The zip names files with /, on Windows too.
      const rel = relative(notesDir(a.home), join(e.parentPath, e.name)).split(sep).join('/');
      expect(files[`${top}notes/${rel}`]).toBe(readFileSync(join(e.parentPath, e.name), 'utf8'));
    }
    expect(under('entries/notes/')).toEqual([]);
  });

  it('writes what the organiser made as JSON that names entries by number', () => {
    const ids = new Set((a.store.db.prepare('SELECT id FROM entries').all() as { id: number }[]).map((r) => r.id));
    const tags = JSON.parse(files[`${top}tags.json`]!) as { schema: string; tags: { name: string; entries: number[] }[] }[];
    expect(tags.map((s) => s.schema)).toEqual(expect.arrayContaining(['Topics', 'Projects', 'Moods']));
    const topics = tags.find((s) => s.schema === 'Topics')!;
    expect(topics.tags.length).toBeGreaterThan(0);
    for (const t of topics.tags) for (const id of t.entries) expect(ids.has(id)).toBe(true);
    const hubs = JSON.parse(files[`${top}hubs.json`]!) as { name: string; entries: number[] }[];
    expect(hubs.map((h) => h.name)).toEqual(liveHubs(a.store.db).map((h) => h.name));
    const folders = JSON.parse(files[`${top}folders.json`]!) as { entries: number[] }[];
    expect(folders.reduce((n, f) => n + f.entries.length, 0)).toBeGreaterThan(0);
    const runs = JSON.parse(files[`${top}runs.json`]!) as { id: number }[];
    expect(runs.map((r) => r.id)).toEqual(listRuns(a.store.db, -1).map((r) => r.id).reverse());
    const record = JSON.parse(files[`${top}record.json`]!);
    expect(record).toMatchObject({ exportedAt: '2026-11-20T18:00:00.000Z', chats: count(a.store.db, 'threads'), runs: runs.length, hubs: hubs.length });
    expect(record.sources.length).toBe(count(a.store.db, 'sources'));
  });

  it('writes an owner-only file and never replaces one without --force', () => {
    const file = join(dir, 'out', 'export.zip');
    const r = writeExport(a.store, a.home, file);
    expect(r).toMatchObject({ file, chats: count(a.store.db, 'threads') });
    expectMode(file, 0o600);
    expect(statSync(file).size).toBe(r.bytes);
    writeFileSync(join(dir, 'keep.zip'), 'mine');
    expect(() => writeExport(a.store, a.home, join(dir, 'keep.zip'))).toThrow(/already exists.*--force/);
    expect(readFileSync(join(dir, 'keep.zip'), 'utf8')).toBe('mine');
    writeExport(a.store, a.home, join(dir, 'keep.zip'), { force: true });
    expect(readFileSync(join(dir, 'keep.zip')).subarray(0, 2).toString()).toBe('PK');
    mkdirSync(join(dir, 'a-folder'));
    expect(() => writeExport(a.store, a.home, join(dir, 'a-folder'))).toThrow(/is a folder/);
    expect(readdirSync(join(dir, 'out'))).toEqual(['export.zip']);
  });
});
