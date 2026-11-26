// bench/migrations.ts on a small corpus: the old record holds the imported content at the old version, each step runs to
// the latest version, and two processes opening the old record together both end there. The bench itself runs outside
// the suite: at 50k and 150k it takes minutes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildOldRecord, countRecord, migrationReport, openTogether, parseMigrationOptions, timeSteps } from '../bench/migrations.ts';
import { writeCorpus } from '../bench/corpus.ts';
import { work } from '../bench/worker.ts';
import { schemaVersion } from '../src/store/db.ts';
import { MIGRATIONS } from '../src/store/schema.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-bench-migrations-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const latest = MIGRATIONS.length;

describe('migration bench', () => {
  it('takes a size and a version to start from, and keeps its folder inside the checkout by default', () => {
    expect(parseMigrationOptions([])).toMatchObject({ size: '50k', from: 3, entries: 50_000, keep: false });
    expect(parseMigrationOptions([]).dir).toMatch(/[/\\]\.skeinwise[/\\]bench[/\\]migrations-50k$/);
    expect(parseMigrationOptions(['150k', '--from', '4']).from).toBe(4);
    expect(() => parseMigrationOptions(['--from', '0'])).toThrow(/from 1 to/);
    expect(() => parseMigrationOptions(['--from', String(latest)])).toThrow(/from 1 to/);
    expect(() => parseMigrationOptions(['--entries', '10'])).toThrow(/500 or more/);
  });

  it('builds an old record from an import, times each step to the latest version, and opens it in two processes', async () => {
    const corpus = writeCorpus(join(dir, 'corpus'), 600);
    const home = join(dir, 'home');
    await work({ kind: 'cli', runs: [['import', ...corpus.paths]] }, { SKEINWISE_HOME: home, HOME: join(dir, 'user') });
    const current = new DatabaseSync(join(home, 'record.db'), { readOnly: true });
    const imported = countRecord(current);
    current.close();

    const old = join(dir, 'old.db');
    const counts = buildOldRecord(join(home, 'record.db'), old, 3);
    expect(counts).toEqual(imported);
    expect(counts.entries).toBe(600);
    const at = new DatabaseSync(old, { readOnly: true });
    expect(schemaVersion(at)).toBe(3);
    expect((at.prepare("SELECT count(*) AS n FROM entry_search WHERE entry_search MATCH 'the'").get() as { n: number }).n).toBeGreaterThan(0);
    at.close();
    expect(() => buildOldRecord(join(home, 'record.db'), old, 3)).toThrow(/already exists/);

    const stepped = join(dir, 'steps.db');
    copyFileSync(old, stepped);
    const steps = timeSteps(stepped);
    expect(steps.map((s) => s.migration)).toEqual(Array.from({ length: latest - 3 }, (_, i) => i + 4));
    const after = new DatabaseSync(stepped, { readOnly: true });
    expect(schemaVersion(after)).toBe(latest);
    expect(countRecord(after)).toEqual(imported);
    after.close();

    const together = join(dir, 'together.db');
    copyFileSync(old, together);
    const [first, second] = await openTogether(together);
    expect([first, second].map((o) => [o.ok, o.version])).toEqual([[true, latest], [true, latest]]);
    expect(second.startedAt).toBeGreaterThanOrEqual(first.startedAt);

    const text = migrationReport({
      opts: parseMigrationOptions(['--entries', '600']), load: 1, importMs: 1_000, counts, recordMB: 3, steps, alone: first,
      together: [first, second],
    });
    expect(text).toContain('The old record: version 3, 600 entries');
    expect(text).toContain(`Migration ${latest}: `);
    expect(text).toContain(`the second opened it at version ${latest} in `);
  }, 120_000);
});
