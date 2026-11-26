// A tag run counts the pairs it keeps (unchanged) against the live ones, and the pairs it drops (removed) against the
// runs it replaces. It used to load every entry-tag pair in the record as a string for that, 1.45 million at 50,000
// entries, even for a run over a hundred new ones, and at 150,000 entries it ran out of heap. A run over part of the
// record now reads the live pairs of the entries it tags, as numbers.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_TAGS } from '../src/demo/content.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { defineTag } from '../src/organiser/corrections.ts';
import { runTask, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import type { Scope } from '../src/organiser/runs.ts';
import { findSchema } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The demo record with three notes held back, and the person's own tags defined. */
function demo() {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-tag-scope-'));
  dirs.push(dir);
  writeDemo(dir);
  const notes = join(dir, 'notes');
  const held = join(dir, 'held');
  mkdirSync(held);
  const names = readdirSync(notes).filter((n) => n.endsWith('.md')).sort();
  const late = [names[1]!, names[4]!, names[9]!];
  for (const n of late) renameSync(join(notes, n), join(held, n));
  const store = new Store(openDb(':memory:'), () => DEMO_NOW);
  const bring = (part: string) => {
    for (const b of readImports(join(dir, part))) store.ingest(b);
  };
  for (const part of ['chatgpt', 'claude', 'claude-code', 'notes']) bring(part);
  for (const t of DEMO_TAGS) defineTag(store, t.schema, t.tag, t.words);
  /** Brings the held notes in and edits one already tagged: a run over new entries then covers four. */
  const later = () => {
    for (const n of late) renameSync(join(held, n), join(notes, n));
    appendFileSync(join(notes, names[0]!), '\nThe plot thickens with a second draft of the outline and a new chapter on rivers.\n');
    bring('notes');
  };
  return { store, later, edited: names[0]! };
}

/** One tag run per schema (or of the one named) over the scope, the way `skeinwise run tag` runs them: their counts. */
async function tag(store: Store, scope: Scope, schemaName?: string): Promise<Record<string, unknown>[]> {
  const record = new RecordView(store);
  const counts: Record<string, unknown>[] = [];
  for (const step of steps(store, 'tag', schemaName ? findSchema(store.db, schemaName)! : undefined)) {
    const run = await runTask(store, record, { task: 'tag', schema: step.schema!, scope, engine: 'none', yes: false, budget: 0, progress: () => {} });
    counts.push({ schema: step.schema!.name, ...run.counts });
  }
  return counts;
}

/** Counts the rows statements that read entry_tags hand back, from now on. */
function countEntryTagReads(db: DatabaseSync): { rows: number } {
  const seen = { rows: 0 };
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const st = prepare(sql);
    if (!/\bFROM entry_tags\b/.test(sql)) return st;
    const all = st.all.bind(st);
    const get = st.get.bind(st);
    const iterate = st.iterate.bind(st);
    st.all = ((...args: Parameters<StatementSync['all']>) => {
      const rows = all(...args);
      seen.rows += rows.length;
      return rows;
    }) as StatementSync['all'];
    st.get = ((...args: Parameters<StatementSync['get']>) => {
      const row = get(...args);
      if (row !== undefined) seen.rows++;
      return row;
    }) as StatementSync['get'];
    st.iterate = ((...args: Parameters<StatementSync['iterate']>) =>
      (function* () {
        for (const row of iterate(...args)) {
          seen.rows++;
          yield row;
        }
      })()) as unknown as StatementSync['iterate'];
    return st;
  }) as DatabaseSync['prepare'];
  return seen;
}

describe('tag runs over all or part of the record', () => {
  it('tag the demo record exactly as they did before the pairs were scoped', async () => {
    const { store, later, edited } = demo();
    const counts = [await tag(store, { kind: 'all' })];
    later();
    counts.push(await tag(store, { kind: 'new' }));
    counts.push(await tag(store, { kind: 'all' }));
    const source = store.allEntries().find((e) => e.externalId === edited)!.sourceId;
    counts.push(await tag(store, { kind: 'source', id: source }));
    counts.push(await tag(store, { kind: 'source', id: source }));
    const dates = store.allEntries().map((e) => e.createdAt).sort();
    counts.push(await tag(store, { kind: 'since', date: dates[Math.floor(dates.length * 0.9)]! }));

    // The counts and rows below are what the build before the change (11da41a) gives for the same runs. They were
    // taken again when the Projects name rule (a name tags an entry only when its words stand side by side and the
    // name stands out) took 9 demo entries off Projects. Four write Learning Rust's words apart, and five say "ride
    // coast to coast". The first and third runs' Projects counts moved, and with them 18 rows.
    const c = (entries: number, tagged: number, coverage: number, tags: number, added: number, removed: number, unchanged: number) =>
      ({ entries, tagged, coverage, tags, added, removed, unchanged });
    const byRun = counts.map((run) => run.map(({ schema, ...n }) => [schema, n]));
    expect(byRun).toEqual([
      [['Topics', c(586, 584, 100, 18, 596, 0, 0)], ['Projects', c(586, 15, 3, 4, 16, 0, 0)], ['Moods', c(586, 2, 0, 1, 2, 0, 0)], ['Areas', c(586, 21, 4, 2, 21, 0, 0)]],
      [['Topics', c(4, 4, 100, 8, 7, 0, 2)], ['Projects', c(4, 3, 75, 2, 4, 0, 0)], ['Moods', c(4, 0, 0, 0, 0, 0, 0)], ['Areas', c(4, 0, 0, 0, 0, 0, 0)]],
      [['Topics', c(589, 589, 100, 22, 45, 43, 560)], ['Projects', c(589, 57, 10, 5, 40, 0, 20)], ['Moods', c(589, 2, 0, 1, 0, 0, 2)], ['Areas', c(589, 21, 4, 2, 0, 0, 21)]],
      [['Topics', c(29, 29, 100, 20, 29, 0, 20)], ['Projects', c(29, 23, 79, 5, 0, 0, 26)], ['Moods', c(29, 2, 7, 1, 0, 0, 2)], ['Areas', c(29, 2, 7, 2, 0, 0, 2)]],
      [['Topics', c(29, 29, 100, 20, 0, 0, 49)], ['Projects', c(29, 23, 79, 5, 0, 0, 26)], ['Moods', c(29, 2, 7, 1, 0, 0, 2)], ['Areas', c(29, 2, 7, 2, 0, 0, 2)]],
      [['Topics', c(59, 59, 100, 4, 59, 0, 2)], ['Projects', c(59, 6, 10, 1, 0, 0, 6)], ['Moods', c(59, 0, 0, 0, 0, 0, 0)], ['Areas', c(59, 1, 2, 1, 0, 0, 1)]],
    ]);
    const rows = store.db
      .prepare(
        `SELECT et.run_id AS run, e.external_id AS entry, s.name AS schema, t.name AS tag, et.score FROM entry_tags et
         JOIN tags t ON t.id = et.tag_id JOIN schemas s ON s.id = t.schema_id JOIN entries e ON e.id = et.entry_id
         ORDER BY et.run_id, et.rowid`,
      )
      .all();
    expect(rows).toHaveLength(1562);
    expect(createHash('sha256').update(JSON.stringify(rows)).digest('hex')).toBe('b31a268d34110b5a98ff8feecda382ba862d83619c9f77e3270b8271044bf748');
  });

  it('read only the live pairs of the entries they tag when they cover new entries', async () => {
    const { store, later } = demo();
    await tag(store, { kind: 'all' });
    const topics = findSchema(store.db, 'Topics')!.id;
    const pairs = (store.db.prepare('SELECT COUNT(*) AS n FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE t.schema_id = ?').get(topics) as { n: number }).n;
    expect(pairs).toBe(596);
    later();

    const scoped = countEntryTagReads(store.db);
    const [run] = await tag(store, { kind: 'new' }, 'Topics');
    // Four entries in scope, the edited one with two live pairs it keeps: a handful of rows, not the record's 596.
    expect(run).toMatchObject({ entries: 4, tagged: 4, unchanged: 2, removed: 0 });
    expect(scoped.rows).toBeLessThan(20);

    // The same count over everything sees every pair, so the figure above is the run's reads and not a missed one.
    const full = countEntryTagReads(store.db);
    await tag(store, { kind: 'all' }, 'Topics');
    expect(full.rows).toBeGreaterThanOrEqual(pairs);
  });
});
