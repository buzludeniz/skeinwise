import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEMO_NOW, writeDemo } from '../../src/demo/demo.ts';
import { openHome } from '../../src/home.ts';
import { readImports } from '../../src/importers/detect.ts';
import { notesDir, readNotes } from '../../src/notes.ts';
import { type RunOptions, runSteps, steps } from '../../src/organiser/organise.ts';
import { RecordView } from '../../src/organiser/record.ts';
import type { Store } from '../../src/store/store.ts';

// A record folder like a real one, from the demo: chats from three tools, the notes in the record folder, and a
// No-AI organiser run over all of it, so there are tags, folders, hubs, links and runs to carry across.

const NONE: Omit<RunOptions, 'task' | 'schema'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };

const opened: Store[] = [];

/** Opens a record folder on the demo clock, and remembers it so closeRecords can close it. */
export function openRecord(home: string): Store {
  const store = openHome(home, () => DEMO_NOW);
  opened.push(store);
  return store;
}

/** Closes every record openRecord opened. Run it before removing the folders: Windows can't remove an open file. */
export function closeRecords(): void {
  for (const store of opened.splice(0)) if (store.db.isOpen) store.db.close();
}

export async function demoRecord(dir: string, name: string): Promise<{ home: string; store: Store }> {
  const demo = join(dir, 'demo');
  if (!existsSync(demo)) writeDemo(demo);
  const home = join(dir, name);
  const store = openRecord(home);
  for (const p of ['chatgpt', 'claude', 'claude-code']) for (const b of readImports(join(demo, p))) store.ingest(b);
  cpSync(join(demo, 'notes'), notesDir(home), { recursive: true });
  readNotes(store, home);
  await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
  // Made-up side files, so a join has something to bring over.
  writeFileSync(join(home, 'ledger.jsonl'), '{"at":"2026-11-20T18:00:00.000Z","made":"up"}\n', { mode: 0o600 });
  writeFileSync(join(home, 'app.json'), '{"theme":"test"}\n', { mode: 0o600 });
  writeFileSync(join(home, 'config.json'), '{"engine":"none"}\n', { mode: 0o600 });
  return { home, store };
}

/** Every data table's rows, sorted, so two records can be compared whole. */
export function dump(db: DatabaseSync): Record<string, string[]> {
  const tables = db
    .prepare(`SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string; type: string }[];
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    const rows = db.prepare(`SELECT ${t.type === 'virtual' ? 'rowid, ' : ''}* FROM "${t.name}"`).all();
    out[t.name] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

export function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}
