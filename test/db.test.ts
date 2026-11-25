import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inTransaction, isBusy, migrate, openDb, schemaVersion } from '../src/store/db.ts';
import { MIGRATIONS } from '../src/store/schema.ts';
import { DatabaseSync } from 'node:sqlite';

describe('openDb', () => {
  it('creates the schema at the latest version', () => {
    const db = openDb(':memory:');
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['sources', 'threads', 'entries', 'versions', 'entry_search']));
  });

  it('is idempotent when reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-'));
    try {
      const file = join(dir, 'record.db');
      openDb(file).close();
      const db = openDb(file);
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has a working full-text index', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO entry_search (rowid, title, body) VALUES (?, ?, ?)').run(1, 'Gardening', 'Planting tomatoes');
    const hits = db.prepare('SELECT rowid FROM entry_search WHERE entry_search MATCH ?').all('tomato');
    expect(hits).toHaveLength(1);
  });

  it('upgrades a version 1 record to the organiser tables', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATIONS[0]!);
    db.exec('PRAGMA user_version = 1');
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'runs', 'schemas', 'tags', 'entry_tags', 'folders', 'entry_folders', 'links', 'hubs', 'hub_entries',
        'layers', 'review_items', 'live_runs',
      ]),
    );
  });

  it('seeds the built-in tagging schemas and the Moods tags', () => {
    const db = openDb(':memory:');
    const schemas = db.prepare('SELECT name FROM schemas ORDER BY id').all().map((r) => (r as { name: string }).name);
    expect(schemas).toEqual(['Topics', 'Projects', 'Moods']);
    const moods = db
      .prepare("SELECT t.name FROM tags t JOIN schemas s ON s.id = t.schema_id WHERE s.name = 'Moods' AND t.run_id IS NULL")
      .all();
    expect(moods).toHaveLength(6);
  });

  it('shows a run as live until a later run of the same task covers its scope', () => {
    const db = openDb(':memory:');
    const add = (task: string, scope: string, status = 'done') =>
      Number(
        db
          .prepare("INSERT INTO runs (task, engine, scope, status, started_at) VALUES (?, 'none', ?, ?, 'x')")
          .run(task, scope, status).lastInsertRowid,
      );
    const live = () => db.prepare('SELECT id FROM live_runs ORDER BY id').all().map((r) => (r as { id: number }).id);
    const a = add('hub', 'all');
    const b = add('hub', 'new');
    const c = add('hub', 'source:1');
    expect(live()).toEqual([a, b, c]);
    const d = add('hub', 'source:1');
    expect(live()).toEqual([a, b, d]);
    add('hub', 'all', 'failed');
    expect(live()).toEqual([a, b, d]);
    const e = add('hub', 'all');
    const f = add('link', 'all');
    expect(live()).toEqual([e, f]);
    db.prepare("UPDATE runs SET status = 'undone' WHERE id = ?").run(e);
    expect(live()).toEqual([a, b, d, f]);
  });

  it('keeps an agent run live until it is undone; organiser runs neither replace it nor are replaced by it', () => {
    const db = openDb(':memory:');
    const add = (engine: string, scope: string) =>
      Number(
        db
          .prepare("INSERT INTO runs (task, engine, model, scope, schema_id, status, started_at) VALUES ('tag', ?, ?, ?, 3, 'done', 'x')")
          .run(engine, engine === 'agent' ? 'claude-code' : null, scope).lastInsertRowid,
      );
    const live = () => db.prepare('SELECT id FROM live_runs ORDER BY id').all().map((r) => (r as { id: number }).id);
    const a = add('none', 'all');
    const g = add('agent', 'agent');
    const h = add('agent', 'agent');
    expect(live()).toEqual([a, g, h]);
    const b = add('local', 'all');
    expect(live()).toEqual([g, h, b]);
    db.prepare("UPDATE runs SET status = 'undone' WHERE id = ?").run(g);
    expect(live()).toEqual([h, b]);
  });

  it('upgrades a version 2 record to agent runs, keeping every run and what points at it', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(MIGRATIONS[0]!);
    db.exec(MIGRATIONS[1]!);
    db.exec('PRAGMA user_version = 2');
    db.prepare("INSERT INTO runs (id, task, engine, scope, schema_id, status, counts, started_at) VALUES (7, 'tag', 'none', 'all', 1, 'done', '{\"tags\":1}', 'x')").run();
    db.prepare("INSERT INTO tags (schema_id, name, run_id) VALUES (1, 'bread', 7)").run();
    expect(() => db.prepare("INSERT INTO runs (task, engine, scope, status, started_at) VALUES ('tag', 'agent', 'agent', 'done', 'x')").run()).toThrow(/CHECK/);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT id, counts FROM runs').all()).toEqual([{ id: 7, counts: '{"tags":1}' }]);
    expect(db.prepare('SELECT id FROM live_runs').all()).toEqual([{ id: 7 }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    db.prepare("INSERT INTO runs (task, engine, model, scope, status, started_at) VALUES ('tag', 'agent', 'claude-code', 'agent', 'done', 'x')").run();
    expect(() => db.prepare("INSERT INTO tags (schema_id, name, run_id) VALUES (1, 'rye', 99)").run()).toThrow(/FOREIGN KEY/);
  });

  it('upgrades a migration-3 record with live capture’s per-file table, empty', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS.slice(0, 3)) db.exec(m);
    db.exec('PRAGMA user_version = 3');
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT COUNT(*) AS n FROM live_files').get()).toEqual({ n: 0 });
    db.prepare("INSERT INTO live_files (path, target) VALUES ('/v/a.md', 'vault')").run();
    expect(db.prepare('SELECT byte_offset, attempts, extra FROM live_files').get()).toEqual({ byte_offset: 0, attempts: 0, extra: null });
    expect(() => db.prepare("INSERT INTO live_files (path, target) VALUES ('/v/a.md', 'vault')").run()).toThrow(/UNIQUE/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'live_files' AND sql IS NOT NULL").all()).toEqual([
      { name: 'live_files_target' },
    ]);
  });

  // Migration 5 (LS-02, L14) on a v0.3 record and on an mcp-branch (migration 3) record, with rows in them.
  for (const from of [1, 3]) {
    it(`upgrades a migration-${from} record to provenance and pending, keeping every version and flagging bad times`, () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      for (const m of MIGRATIONS.slice(0, from)) db.exec(m);
      db.exec(`PRAGMA user_version = ${from}`);
      db.exec(`
        INSERT INTO sources (id, kind, label, location, added_at) VALUES (1, 'claude', 'Claude', '', '2026-05-01T00:00:00.000Z');
        INSERT INTO threads (id, source_id, external_id, title, started_at) VALUES (1, 1, 'c1', 'Bread', '1970-01-01T00:00:00.000Z');
        INSERT INTO entries (id, source_id, thread_id, external_id, kind, speaker, created_at, seq, version) VALUES
          (1, 1, 1, 'm1', 'message', 'you', '2026-03-01T10:00:00.000Z', 0, 2),
          (2, 1, 1, 'm2', 'message', 'you', '1970-01-01T00:00:00.000Z', 1, 1),
          (3, 1, 1, 'm3', 'message', 'you', '2030-01-01T00:00:00.000Z', 2, 1);
        INSERT INTO versions (id, entry_id, version, body, content_hash, editor, edited_at) VALUES
          (10, 1, 1, 'one', 'h1', 'import', '2026-03-01T10:00:00.000Z'),
          (11, 1, 2, 'one, edited', 'h2', 'you', '2026-06-01T00:00:00.000Z'),
          (12, 2, 1, 'two', 'h3', 'import', '1970-01-01T00:00:00.000Z'),
          (13, 3, 1, 'three', 'h4', 'import', '2030-01-01T00:00:00.000Z');
      `);
      migrate(db);
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('SELECT id, version, editor, edited_at, observed_at, claimed_at, origin_sha256, run_id FROM versions ORDER BY id').all()).toEqual([
        { id: 10, version: 1, editor: 'import', edited_at: '2026-03-01T10:00:00.000Z', observed_at: '2026-05-01T00:00:00.000Z', claimed_at: '2026-03-01T10:00:00.000Z', origin_sha256: null, run_id: null },
        { id: 11, version: 2, editor: 'you', edited_at: '2026-06-01T00:00:00.000Z', observed_at: '2026-06-01T00:00:00.000Z', claimed_at: null, origin_sha256: null, run_id: null },
        { id: 12, version: 1, editor: 'import', edited_at: '1970-01-01T00:00:00.000Z', observed_at: '2026-05-01T00:00:00.000Z', claimed_at: null, origin_sha256: null, run_id: null },
        { id: 13, version: 1, editor: 'import', edited_at: '2030-01-01T00:00:00.000Z', observed_at: '2026-05-01T00:00:00.000Z', claimed_at: '2030-01-01T00:00:00.000Z', origin_sha256: null, run_id: null },
      ]);
      expect(db.prepare('SELECT id, created_at, claimed_at, observed_at, time_flag FROM entries ORDER BY id').all()).toEqual([
        { id: 1, created_at: '2026-03-01T10:00:00.000Z', claimed_at: '2026-03-01T10:00:00.000Z', observed_at: '2026-05-01T00:00:00.000Z', time_flag: null },
        { id: 2, created_at: '2026-05-01T00:00:00.000Z', claimed_at: null, observed_at: '2026-05-01T00:00:00.000Z', time_flag: 'missing' },
        { id: 3, created_at: '2026-05-01T00:00:00.000Z', claimed_at: '2030-01-01T00:00:00.000Z', observed_at: '2026-05-01T00:00:00.000Z', time_flag: 'future' },
      ]);
      expect(db.prepare('SELECT thread_id, version, title, editor, observed_at FROM thread_titles').all()).toEqual([
        { thread_id: 1, version: 1, title: 'Bread', editor: 'import', observed_at: '2026-05-01T00:00:00.000Z' },
      ]);
      expect(db.prepare('SELECT account FROM sources').get()).toEqual({ account: null });
      // versions.observed_at is required from now on, and pending enforces its states.
      expect(() => db.prepare("INSERT INTO versions (entry_id, version, body, content_hash, editor, edited_at) VALUES (1, 3, 'x', 'h', 'you', 'x')").run()).toThrow(/NOT NULL/);
      expect(() => db.prepare("INSERT INTO pending (reason, source_kind, source_label, observed_at, batch) VALUES ('other', 'claude', 'Claude', 'x', '{}')").run()).toThrow(/CHECK/);
      expect(() => db.prepare("INSERT INTO pending (status, reason, source_kind, source_label, observed_at, batch) VALUES ('rejected', 'account', 'claude', 'Claude', 'x', '{}')").run()).toThrow(/CHECK/);
      db.prepare("INSERT INTO pending (reason, source_kind, source_label, origin_sha256, observed_at, batch) VALUES ('account', 'claude', 'Claude', 'abc', 'x', '{}')").run();
      expect(() => db.prepare("INSERT INTO pending (reason, source_kind, source_label, origin_sha256, observed_at, batch) VALUES ('account', 'claude', 'Claude', 'abc', 'x', '{}')").run()).toThrow(/UNIQUE/);
      expect(() => db.prepare('INSERT INTO versions (entry_id, version, body, content_hash, editor, edited_at, observed_at, run_id) VALUES (1, 3, ?, ?, ?, ?, ?, 99)').run('x', 'h', 'you', 'x', 'x')).toThrow(/FOREIGN KEY/);
    });
  }

  it('refuses a migration that would leave a broken reference, and changes nothing', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATIONS[0]!);
    db.exec(MIGRATIONS[1]!);
    db.exec('PRAGMA user_version = 2');
    db.exec('PRAGMA foreign_keys = OFF'); // node:sqlite turns them on; an old record may hold such a row anyway
    db.prepare("INSERT INTO tags (schema_id, name, run_id) VALUES (1, 'orphan', 42)").run();
    expect(() => migrate(db)).toThrow(/Migration 3 would leave 1 broken reference\(s\) \(tags → runs\)/);
    expect(schemaVersion(db)).toBe(2);
    expect(() => db.prepare("INSERT INTO runs (task, engine, scope, status, started_at) VALUES ('tag', 'agent', 'agent', 'done', 'x')").run()).toThrow(/CHECK/);
  });
});

describe('busy records (M8)', () => {
  it('waits for another writer, then retries the whole transaction once and throws a second busy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-busy-'));
    try {
      const file = join(dir, 'record.db');
      const a = openDb(file);
      const b = openDb(file, { busyTimeoutMs: 30 });
      expect(a.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
      a.exec('BEGIN IMMEDIATE');
      let runs = 0;
      const started = performance.now();
      let error: unknown;
      try {
        inTransaction(b, () => runs++);
      } catch (e) {
        error = e;
      }
      expect(isBusy(error)).toBe(true);
      // Two attempts, each waiting out the timeout; fn never ran because the lock is taken before it.
      expect(performance.now() - started).toBeGreaterThanOrEqual(50);
      expect(runs).toBe(0);
      expect(b.isTransaction).toBe(false);
      a.exec('COMMIT');
      expect(inTransaction(b, () => ++runs)).toBe(1);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('succeeds on the retry when the first attempt meets a busy record', () => {
    const db = openDb(':memory:');
    let begins = 0;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === 'exec') {
          return (sql: string) => {
            if (sql === 'BEGIN IMMEDIATE' && begins++ === 0) throw Object.assign(new Error('database is locked'), { errcode: 5 });
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(inTransaction(flaky, () => db.prepare("INSERT INTO sources (kind, label, location, added_at) VALUES ('notes', 'n', '/n', 'x')").run().changes)).toBe(1);
    expect(begins).toBe(2);
    expect(() => inTransaction(db, () => { throw new Error('boom'); })).toThrow('boom');
    expect(db.isTransaction).toBe(false);
  });
});
