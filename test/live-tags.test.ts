// liveTags merges a schema's tag rows by name and each tag's entries, dropping repeats. It used to find a repeat by
// scanning the arrays it was building, which is quadratic in a tag's size: 468 ms of a 1.8 s Topics run over a hundred
// new entries at 50,000 entries. The checks now use Sets beside the arrays, and the output must not move: these pins
// are what the build before the change (f15e013) gives.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TAGS } from '../src/demo/content.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { defineTag } from '../src/organiser/corrections.ts';
import { runTask, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import type { Scope } from '../src/organiser/runs.ts';
import { liveTags, schemas } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

type Point = { label: string; digest: string; stats: (string | number)[][]; liveRows: number[] };

describe('liveTags on the demo record', () => {
  let dir: string;
  const points: Point[] = [];

  // One record taken through runs over all, over new entries (a second live run per schema, so names span several tag
  // rows and entries repeat), then all, a source and a date. liveTags is read for every schema after each stage.
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-live-tags-'));
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
    const tag = async (scope: Scope) => {
      const record = new RecordView(store);
      for (const step of steps(store, 'tag')) {
        await runTask(store, record, { task: 'tag', schema: step.schema!, scope, engine: 'none', yes: false, budget: 0, progress: () => {} });
      }
    };
    const read = (label: string) => {
      const bySchema = schemas(store.db).map((s) => [s.name, liveTags(store.db, s.id)] as const);
      points.push({
        label,
        digest: createHash('sha256').update(JSON.stringify(bySchema)).digest('hex'),
        // Per schema: tags, tag rows, entries over all tags, and names that span more than one tag row.
        stats: bySchema.map(([name, tags]) => [
          name,
          tags.length,
          tags.reduce((n, t) => n + t.ids.length, 0),
          tags.reduce((n, t) => n + t.entryIds.length, 0),
          tags.filter((t) => t.ids.length > 1).length,
        ]),
        // The live entry-tag rows behind each schema's tags, before liveTags merges them.
        liveRows: schemas(store.db).map(
          (s) =>
            (
              store.db
                .prepare(
                  `SELECT COUNT(*) AS n FROM entry_tags et JOIN tags t ON t.id = et.tag_id
                   WHERE t.schema_id = ? AND et.run_id IN (SELECT id FROM live_runs)
                   AND (t.run_id IS NULL OR t.run_id IN (SELECT id FROM live_runs))`,
                )
                .get(s.id) as { n: number }
            ).n,
        ),
      });
    };

    await tag({ kind: 'all' });
    read('all');
    for (const n of late) renameSync(join(held, n), join(notes, n));
    appendFileSync(join(notes, names[0]!), '\nThe plot thickens with a second draft of the outline and a new chapter on rivers.\n');
    bring('notes');
    await tag({ kind: 'new' });
    read('new');
    await tag({ kind: 'all' });
    const edited = store.allEntries().find((e) => e.externalId === names[0])!;
    await tag({ kind: 'source', id: edited.sourceId });
    const dates = store.allEntries().map((e) => e.createdAt).sort();
    await tag({ kind: 'since', date: dates[Math.floor(dates.length * 0.9)]! });
    read('source and since');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('gives every schema the same tags, in the same order, with the same ids and entries as before', () => {
    expect(points.map((p) => [p.label, p.stats])).toEqual([
      ['all', [['Topics', 18, 18, 596, 0], ['Projects', 4, 4, 25, 0], ['Moods', 1, 1, 2, 0], ['Areas', 2, 2, 21, 0]]],
      ['new', [['Topics', 22, 26, 603, 4], ['Projects', 5, 6, 29, 1], ['Moods', 1, 1, 2, 0], ['Areas', 2, 2, 21, 0]]],
      ['source and since', [['Topics', 28, 46, 693, 16], ['Projects', 5, 11, 69, 5], ['Moods', 1, 1, 2, 0], ['Areas', 2, 2, 21, 0]]],
    ]);
    // The whole output, names as first seen, ids and entries in their order, and the tags in theirs.
    expect(points.map((p) => p.digest)).toEqual([
      '3d6ac8d870d1613fc043f7913c491fa36b24f712289935c3c499f4e846a1e005',
      '3eb8503994b6bc6c1f3916949dae7ed7d34413b9fd40559af2464d342161182d',
      '107a024c5ffb2ba20b1742faf4b6f0b4353e513dbdba584db7aed4605249d874',
    ]);
  });

  it('drops the repeats the record holds: an entry tagged by more than one live run, or under two rows of a name', () => {
    const last = points.at(-1)!;
    const merged = last.stats.map((s) => s[3] as number);
    expect(last.liveRows.some((rows, i) => rows > merged[i]!)).toBe(true);
  });
});
