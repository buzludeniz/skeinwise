// Times the schema migrations on a large old record: how long each step holds the record's write lock, and whether a
// second process that opens the record during the upgrade (serve or the memory server beside the CLI) waits or fails.
//
//   node bench/migrations.ts [50k|150k] [--from <version>] [--dir <folder>] [--keep] [--seed <n>] [--entries <n>]
//
// It writes the bench's seeded corpus and imports it with today's CLI, then copies the record's sources, threads,
// entries, versions and search index into a new record at an older schema version (--from, default 3, so migrations 4
// onward are timed). On a fresh copy of that old record each time, it measures:
// - each step as migrate runs it: BEGIN IMMEDIATE, the migration, the foreign key check, the new version, COMMIT;
// - openDb in a fresh process, end to end;
// - two fresh processes opening the record together, the second started as the first begins its upgrade.
//
// Everything runs in one folder, `.skeinwise/bench/migrations-<size>` by default (git ignores it), with a stand-in home
// and the No-AI engine, so nothing reads a real record or history or calls a model. The folder is removed at the end
// unless --keep is given. `--open <record.db>` is the role of one opening process: it prints "start <ms since the
// epoch>", then one JSON line (Opened).

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { arch, cpus, loadavg, platform, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { configPath, loadConfig } from '../src/config.ts';
import { BUSY_TIMEOUT_MS, inTransaction, migrateOnce, openDb, schemaVersion } from '../src/store/db.ts';
import { MIGRATIONS } from '../src/store/schema.ts';
import { show, SIZES, type Size } from './budgets.ts';
import { writeCorpus } from './corpus.ts';
import { prepare, runWorker } from './run.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
/** The import is only the set-up; it gets far longer than its budget before the bench gives up on it. */
const IMPORT_TIMEOUT_MS = 60 * 60_000;

export interface MigrationOptions {
  size: Size;
  dir: string;
  keep: boolean;
  seed: number;
  /** The corpus size; the size's own unless --entries gives another. */
  entries: number;
  /** The schema version the old record is built at: every migration after it is timed. */
  from: number;
  /** Set in the opening process's role: the record it opens. */
  open?: string;
}

export function parseMigrationOptions(argv: string[]): MigrationOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' }, keep: { type: 'boolean' }, seed: { type: 'string' }, entries: { type: 'string' },
      from: { type: 'string' }, open: { type: 'string' },
    },
  });
  const size = (positionals[0] ?? '50k') as Size;
  if (!(size in SIZES) || positionals.length > 1) throw new Error(`Give one size, 50k or 150k, not "${positionals.join(' ')}".`);
  const seed = Number(values.seed ?? 42);
  if (!Number.isInteger(seed)) throw new Error(`--seed must be a whole number, not "${values.seed}".`);
  const entries = Number(values.entries ?? SIZES[size]);
  if (!Number.isInteger(entries) || entries < 500) throw new Error(`--entries must be a whole number of 500 or more, not "${values.entries}".`);
  const from = Number(values.from ?? 3);
  // Version 1 is the first that holds entries; the latest has nothing left to time.
  if (!Number.isInteger(from) || from < 1 || from >= MIGRATIONS.length) {
    throw new Error(`--from must be a schema version from 1 to ${MIGRATIONS.length - 1}, not "${values.from}".`);
  }
  const dir = resolve(values.dir ?? join(ROOT, '.skeinwise', 'bench', `migrations-${size}`));
  return { size, dir, keep: values.keep === true, seed, entries, from, ...(values.open ? { open: resolve(values.open) } : {}) };
}

export interface RecordCounts {
  sources: number;
  threads: number;
  entries: number;
  versions: number;
  /** The bytes of every version's text, in MB. */
  textMB: number;
}

/** The tables migrations read and rewrite; the organiser's tables start empty in the old record. */
const CONTENT_TABLES = ['sources', 'threads', 'entries', 'versions', 'entry_search'] as const;

function columns(db: DatabaseSync, schema: 'main' | 'cur', table: string): string[] {
  return (db.prepare('SELECT name FROM pragma_table_info(?, ?)').all(table, schema) as { name: string }[]).map((c) => c.name);
}

export function countRecord(db: DatabaseSync): RecordCounts {
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number | null }).n ?? 0);
  return {
    sources: n('SELECT count(*) AS n FROM sources'),
    threads: n('SELECT count(*) AS n FROM threads'),
    entries: n('SELECT count(*) AS n FROM entries'),
    versions: n('SELECT count(*) AS n FROM versions'),
    textMB: n('SELECT sum(length(CAST(body AS BLOB))) AS n FROM versions') / 2 ** 20,
  };
}

/**
 * Copies the content of the record at `current` into a new record at `old`, built with the migrations up to schema
 * version `from`: every column the old table has, with the same ids. Returns what the old record holds.
 */
export function buildOldRecord(current: string, old: string, from: number): RecordCounts {
  mkdirSync(dirname(old), { recursive: true });
  if (existsSync(old)) throw new Error(`${old} already exists; the old record is built in a new file.`);
  // Foreign keys off, as migrate runs; the timed steps' foreign key check refuses a copy that broke a reference.
  const db = new DatabaseSync(old, { enableForeignKeyConstraints: false });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN');
    for (let v = 0; v < from; v++) db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${from}`);
    db.exec('COMMIT');
    db.prepare('ATTACH DATABASE ? AS cur').run(current);
    db.exec('BEGIN');
    for (const table of CONTENT_TABLES) {
      const have = new Set(columns(db, 'cur', table));
      const shared = columns(db, 'main', table).filter((c) => have.has(c));
      // The search index has no id column of its own; its rowid is the entry's.
      const cols = (table === 'entry_search' ? ['rowid', ...shared] : shared).join(', ');
      db.exec(`INSERT INTO main.${table} (${cols}) SELECT ${cols} FROM cur.${table}`);
    }
    db.exec('COMMIT');
    db.exec('DETACH DATABASE cur');
    const counts = countRecord(db);
    // Everything into the main file, so a plain copy of it is the whole record.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return counts;
  } finally {
    db.close();
  }
}

export interface StepTime {
  /** The migration's number, 1-based as schema.ts counts them. */
  migration: number;
  ms: number;
}

/** Runs each pending migration of the record at `file` as migrate does, and times each one. */
export function timeSteps(file: string): StepTime[] {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA foreign_keys = OFF');
    const steps: StepTime[] = [];
    for (;;) {
      const migration = schemaVersion(db) + 1;
      const started = performance.now();
      if (!inTransaction(db, () => migrateOnce(db))) return steps;
      steps.push({ migration, ms: performance.now() - started });
    }
  } finally {
    db.close();
  }
}

export interface Opened {
  /** When the process began opening the record, in ms since the epoch. */
  startedAt: number;
  ok: boolean;
  /** How long openDb took, or ran before it failed. */
  ms: number;
  /** The record's schema version once open. */
  version?: number;
  error?: string;
}

/** Opens the record at `file` with openDb in a fresh process; onStart runs once the process is about to open it. */
export function openInProcess(file: string, onStart?: () => void): Promise<Opened> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--no-warnings', SELF, '--open', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (onStart && out.includes('\n')) {
        const started = onStart;
        onStart = undefined;
        started();
      }
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', fail);
    child.on('close', (code) => {
      const lines = out.trim().split('\n');
      const start = /^start (\d+(?:\.\d+)?)$/.exec(lines[0] ?? '');
      if (code !== 0 || !start || lines.length < 2) {
        fail(new Error(err.trim().split('\n').slice(-3).join(' ') || `the opening process exited ${code}`));
        return;
      }
      done({ startedAt: Number(start[1]), ...(JSON.parse(lines.at(-1)!) as Omit<Opened, 'startedAt'>) });
    });
  });
}

/** Opens the record at `file` in two fresh processes: the second starts as soon as the first is about to open it. */
export function openTogether(file: string): Promise<[Opened, Opened]> {
  return new Promise((done, fail) => {
    const first: Promise<Opened> = openInProcess(file, () => {
      Promise.all([first, openInProcess(file)]).then(done, fail);
    });
    first.catch(fail);
  });
}

/** The opening process's role: openDb on the record, timed, with the outcome as one JSON line. */
function openRole(file: string): void {
  // writeSync: openDb blocks the event loop, and a pipe write on macOS would wait for it.
  writeSync(1, `start ${performance.timeOrigin + performance.now()}\n`);
  const started = performance.now();
  let result: Omit<Opened, 'startedAt'>;
  try {
    const db = openDb(file);
    result = { ok: true, ms: performance.now() - started, version: schemaVersion(db) };
    db.close();
  } catch (err) {
    result = { ok: false, ms: performance.now() - started, error: message(err) };
  }
  writeSync(1, `${JSON.stringify(result)}\n`);
}

export interface MigrationRun {
  opts: MigrationOptions;
  load: number;
  importMs: number;
  counts: RecordCounts;
  /** The old record's size on disk, in MB. */
  recordMB: number;
  steps: StepTime[];
  alone: Opened;
  together: [Opened, Opened];
}

const opened = (o: Opened) => (o.ok ? `opened it at version ${o.version} in ${show(o.ms, 'ms')}` : `failed after ${show(o.ms, 'ms')}: ${o.error}`);
const count = (n: number) => n.toLocaleString('en');

/** The run as plain lines, like the bench's report. */
export function migrationReport(r: MigrationRun): string {
  const { opts, counts } = r;
  const machine = `Node ${process.version}, ${platform()} ${arch()}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, load ${r.load.toFixed(0)} at the start`;
  const [first, second] = r.together;
  const slow = r.steps.filter((s) => s.ms > BUSY_TIMEOUT_MS).map((s) => `migration ${s.migration} (${show(s.ms, 'ms')})`);
  const lines = [
    `Skeinwise migrations, ${opts.size} (${count(opts.entries)} entries, seed ${opts.seed}). ${machine}.`,
    `The old record: version ${opts.from}, ${count(counts.entries)} entries in ${count(counts.threads)} threads from ${count(counts.sources)} sources, ` +
      `${count(counts.versions)} versions with ${show(counts.textMB, 'MB')} of text, ${show(r.recordMB, 'MB')} on disk. ` +
      `Built from an import with today's CLI (${show(r.importMs, 'ms')}).`,
    ...r.steps.map((s) => `Migration ${s.migration}: ${show(s.ms, 'ms')}`),
    `One process: ${opened(r.alone)}.`,
    `Two processes, the second started ${show(second.startedAt - first.startedAt, 'ms')} after the first: ` +
      `the first ${opened(first)}; the second ${opened(second)}.`,
    slow.length
      ? `Longer than the ${show(BUSY_TIMEOUT_MS, 'ms')} busy timeout: ${slow.join(', ')}.`
      : `No step held the write lock longer than the ${show(BUSY_TIMEOUT_MS, 'ms')} busy timeout.`,
  ];
  return `${lines.join('\n')}\n`;
}

const say = (line: string) => process.stderr.write(`bench: ${line}\n`);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs the migration bench; 0 when every opening process opened the record, 1 when one failed. */
export async function migrationBench(opts: MigrationOptions): Promise<number> {
  const load = loadavg()[0]!;
  prepare(opts.dir);
  const home = join(opts.dir, 'home');
  const user = join(opts.dir, 'user');
  mkdirSync(home, { recursive: true });
  mkdirSync(user, { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify({ engine: 'none' })}\n`);
  if (loadConfig(home).engine !== 'none') throw new Error("The bench record's engine isn't none; refusing to run.");
  const env: NodeJS.ProcessEnv = { ...process.env, SKEINWISE_HOME: home, HOME: user, USERPROFILE: user, NO_COLOR: '1' };

  say(`writing the corpus of ${count(opts.entries)} entries (seed ${opts.seed}) in ${opts.dir}`);
  const corpus = writeCorpus(join(opts.dir, 'corpus'), opts.entries, opts.seed);
  say("importing it with today's CLI");
  const imported = await runWorker({ kind: 'cli', runs: [['import', ...corpus.paths]] }, env, IMPORT_TIMEOUT_MS);
  const current = join(home, 'record.db');
  if (!existsSync(current)) throw new Error(`The import made no record at ${current}.`);

  say(`copying its content into a record at version ${opts.from}`);
  const old = join(opts.dir, 'old', 'record.db');
  const counts = buildOldRecord(current, old, opts.from);
  const copy = (name: string): string => {
    const to = join(opts.dir, name, 'record.db');
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(old, to);
    return to;
  };

  say('timing each migration');
  const steps = timeSteps(copy('steps'));
  say('opening the old record in one process');
  const alone = await openInProcess(copy('alone'));
  say('opening the old record in two processes at once');
  const together = await openTogether(copy('together'));

  const text = migrationReport({ opts, load, importMs: imported.times[0]!, counts, recordMB: statSync(old).size / 2 ** 20, steps, alone, together });
  process.stdout.write(text);
  if (opts.keep) writeFileSync(join(opts.dir, 'report.txt'), text);
  else rmSync(opts.dir, { recursive: true, force: true });
  return alone.ok && together.every((o) => o.ok) ? 0 : 1;
}

if (import.meta.main) {
  try {
    const opts = parseMigrationOptions(process.argv.slice(2));
    if (opts.open) openRole(opts.open);
    else process.exitCode = await migrationBench(opts);
  } catch (err) {
    process.stderr.write(`bench: ${message(err)}\n`);
    process.exitCode = 2;
  }
}
