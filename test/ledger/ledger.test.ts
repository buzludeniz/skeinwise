import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catchUpLedger, checkLedger, ledgerPath, type LedgerLine, lineHash, readLedgerText } from '../../src/ledger/ledger.ts';
import { type RunOptions, runSteps, steps } from '../../src/organiser/organise.ts';
import { RecordView } from '../../src/organiser/record.ts';
import { failRun, listRuns, startRun, undoRun } from '../../src/organiser/runs.ts';
import { hashText } from '../../src/store/store.ts';
import { demoRecord, type TempRecord } from './record.ts';

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };
const LATER = '2026-11-21T09:00:00.000Z';

let rec: TempRecord;
beforeEach(() => {
  rec = demoRecord();
});
afterEach(() => rec.close());

const fileLines = () => readLedgerText(rec.home).lines;
const versionCount = () => Number((rec.store.db.prepare('SELECT COUNT(*) AS n FROM versions').get() as { n: number }).n);

/** Rewrites one line of the ledger file by hand, as someone tampering with it would. */
function rewrite(n: number, change: (line: Record<string, unknown>) => void): void {
  const lines = fileLines();
  const line = JSON.parse(lines[n - 1]!) as Record<string, unknown>;
  change(line);
  lines[n - 1] = JSON.stringify(line);
  writeFileSync(ledgerPath(rec.home), `${lines.join('\n')}\n`);
}

describe('catchUpLedger', () => {
  it('records each import as one line per source, chained line to line, and adds nothing when nothing is new', () => {
    const added = catchUpLedger(rec.store, rec.home);
    const sources = rec.store.sources();
    expect(added.map((l) => l.kind)).toEqual(sources.map(() => 'import'));
    expect(added.map((l) => (l as { source: number }).source)).toEqual(sources.map((s) => s.id));
    expect(added.reduce((sum, l) => sum + (l.kind === 'import' ? l.count : 0), 0)).toBe(versionCount());

    const lines = fileLines();
    expect(lines.map((t) => JSON.parse(t))).toEqual(added);
    expect(added[0]).toMatchObject({ n: 1, prev: null, at: rec.store.now(), kind: 'import', sourceKind: sources[0]!.kind });
    for (let i = 1; i < added.length; i++) expect(added[i]!.prev).toBe(lineHash(lines[i - 1]!));

    const before = readFileSync(ledgerPath(rec.home), 'utf8');
    expect(catchUpLedger(rec.store, rec.home)).toEqual([]);
    expect(readFileSync(ledgerPath(rec.home), 'utf8')).toBe(before);
  });

  it('holds hashes and counts, never the words of the record', () => {
    catchUpLedger(rec.store, rec.home);
    const ledger = readFileSync(ledgerPath(rec.home), 'utf8');
    const bodies = rec.store.allEntries().map((e) => e.body.slice(0, 30)).filter((b) => b.length >= 12);
    expect(bodies.length).toBeGreaterThan(10);
    for (const b of bodies) expect(ledger).not.toContain(b);
  });

  it('records an edit as its own line, after the imports', () => {
    catchUpLedger(rec.store, rec.home);
    const entry = rec.store.allEntries()[3]!;
    rec.setNow(LATER);
    rec.store.editEntry(entry.id, 'A sharper version of what I wrote.', 'you');
    const [edit, ...more] = catchUpLedger(rec.store, rec.home);
    expect(more).toEqual([]);
    expect(edit).toMatchObject({
      kind: 'edit',
      at: LATER,
      entry: entry.id,
      version: 2,
      editor: 'you',
      hash: hashText('A sharper version of what I wrote.'),
      prev: lineHash(fileLines().at(-2)!),
    });
  });

  it('records a run when it finishes, and again when it is undone', async () => {
    catchUpLedger(rec.store, rec.home);
    const runs = await runSteps(rec.store, new RecordView(rec.store), steps(rec.store, 'all'), NONE);
    const added = catchUpLedger(rec.store, rec.home);
    expect(added.map((l) => l.kind === 'run' && [l.run, l.task, l.status])).toEqual(runs.map((r) => [r.id, r.task, 'done']));
    expect(added[0]).toMatchObject({ engine: 'none', model: null, scope: 'all', counts: runs[0]!.counts, startedAt: runs[0]!.startedAt });

    const last = runs.at(-1)!;
    undoRun(rec.store.db, last.id);
    const [undone, ...rest] = catchUpLedger(rec.store, rec.home);
    expect(rest).toEqual([]);
    expect(undone).toMatchObject({ kind: 'run', run: last.id, status: 'undone' });
  });

  it('waits for a run to finish, and records a failed one', () => {
    const id = startRun(rec.store.db, { task: 'tag', engine: 'none', model: null, scope: 'all', mark: 0, now: rec.store.now() });
    expect(catchUpLedger(rec.store, rec.home).some((l) => l.kind === 'run')).toBe(false);
    failRun(rec.store.db, id, 'cut off', 0, 0, rec.store.now());
    expect(catchUpLedger(rec.store, rec.home)).toEqual([expect.objectContaining({ kind: 'run', run: id, status: 'failed' })]);
    expect(listRuns(rec.store.db)).toHaveLength(1);
  });

  it('stops at a cut-off last line rather than chain onto it', () => {
    catchUpLedger(rec.store, rec.home);
    appendFileSync(ledgerPath(rec.home), '{"n":99,"prev":"ab');
    rec.store.editEntry(rec.store.allEntries()[0]!.id, 'changed', 'you');
    expect(() => catchUpLedger(rec.store, rec.home)).toThrow(/ends in the middle of line \d+/);
  });

  it('refuses to go on when the record was replaced under it', () => {
    catchUpLedger(rec.store, rec.home);
    const other = demoRecord();
    try {
      // A smaller record in the same folder: the ledger has seen versions it doesn't hold.
      other.store.db.exec('DELETE FROM versions WHERE id > 3');
      writeFileSync(ledgerPath(other.home), readFileSync(ledgerPath(rec.home)));
      expect(() => catchUpLedger(other.store, other.home)).toThrow(/replaced or rolled back/);
    } finally {
      other.close();
    }
  });

  it('lets one writer in at a time, and takes over a lock its holder left behind', () => {
    const lock = join(rec.home, 'ledger.lock');
    writeFileSync(lock, String(process.pid));
    expect(() => catchUpLedger(rec.store, rec.home, { wait: 50 })).toThrow(/The ledger is busy: process \d+ is writing it/);
    expect(existsSync(ledgerPath(rec.home))).toBe(false);

    const gone = spawnSync(process.execPath, ['-e', '']).pid; // a process that has already exited
    writeFileSync(lock, String(gone));
    expect(catchUpLedger(rec.store, rec.home, { wait: 50 }).length).toBeGreaterThan(0);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('checkLedger', () => {
  it('passes a whole ledger and the record it describes', async () => {
    await runSteps(rec.store, new RecordView(rec.store), steps(rec.store, 'tag'), NONE);
    catchUpLedger(rec.store, rec.home);
    const check = checkLedger(rec.store, rec.home);
    expect(check).toMatchObject({ chain: null, record: null, versions: versionCount(), behind: { versions: 0, runs: 0 } });
    expect(check.lines).toBe(fileLines().length);
    expect(check.latest).toBe(lineHash(fileLines().at(-1)!));
  });

  it('names the line where a changed line breaks the chain', () => {
    catchUpLedger(rec.store, rec.home);
    rec.store.editEntry(rec.store.allEntries()[0]!.id, 'changed', 'you');
    catchUpLedger(rec.store, rec.home);
    expect(fileLines().length).toBeGreaterThanOrEqual(4);
    rewrite(2, (line) => {
      line.count = Number(line.count) + 1;
    });
    expect(checkLedger(rec.store, rec.home).chain).toEqual({
      line: 3,
      problem: "Line 3 doesn't follow on from line 2: line 2 was changed after line 3 was written, or line 3 was.",
    });
  });

  it('names a line removed from the middle, and one cut off at the end', () => {
    catchUpLedger(rec.store, rec.home);
    const lines = fileLines();
    writeFileSync(ledgerPath(rec.home), `${[lines[0], ...lines.slice(2)].join('\n')}\n`);
    expect(checkLedger(rec.store, rec.home).chain).toEqual({ line: 2, problem: 'Line 2 says it is line 3: a line was removed or added before it.' });

    writeFileSync(ledgerPath(rec.home), `${lines.join('\n')}\n{"n":${lines.length + 1},"prev":"0`);
    expect(checkLedger(rec.store, rec.home).chain).toMatchObject({ line: lines.length + 1, problem: expect.stringMatching(/is cut off/) });
  });

  it('sees text changed in record.db, and versions slipped in under old numbers', () => {
    catchUpLedger(rec.store, rec.home);
    const lines = fileLines().map((t) => JSON.parse(t) as LedgerLine);
    const second = lines[1]!;
    if (second.kind !== 'import') throw new Error('expected an import line');
    rec.store.db.prepare('UPDATE versions SET body = ? WHERE id = ?').run('Words I never wrote.', second.versions[0] + 1);
    expect(checkLedger(rec.store, rec.home).record).toMatchObject({ line: 2, problem: expect.stringMatching(/^Line 2: the text of entry \d+, version 1, was changed in record\.db\.$/) });
  });

  it('counts what the ledger has not taken in yet', async () => {
    catchUpLedger(rec.store, rec.home);
    rec.store.editEntry(rec.store.allEntries()[0]!.id, 'changed', 'you');
    await runSteps(rec.store, new RecordView(rec.store), steps(rec.store, 'link'), NONE);
    expect(checkLedger(rec.store, rec.home)).toMatchObject({ chain: null, record: null, behind: { versions: 1, runs: 1 } });
  });
});
