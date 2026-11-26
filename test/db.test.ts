import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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

  // A source is added once and live keeps adding to it for months, so an old record's entries were seen up to the
  // upgrade, not on the day their source was added: only a time past the upgrade itself is in the future.
  it('keeps the date of an entry captured long after its source was added', () => {
    const db = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS.slice(0, 4)) db.exec(m);
    db.exec('PRAGMA user_version = 4');
    db.exec(`
      INSERT INTO sources (id, kind, label, location, added_at) VALUES (1, 'claude-code', 'Claude Code', '/p', '2026-05-01T00:00:00.000Z');
      INSERT INTO entries (id, source_id, external_id, kind, speaker, created_at) VALUES
        (1, 1, 's1', 'message', 'you', '2026-09-01T10:00:00.000Z'),
        (2, 1, 's2', 'message', 'you', '2030-01-01T00:00:00.000Z');
      INSERT INTO versions (entry_id, version, body, content_hash, editor, edited_at) VALUES
        (1, 1, 'later', 'h1', 'import', '2026-09-01T10:00:00.000Z'),
        (2, 1, 'planted', 'h2', 'import', '2030-01-01T00:00:00.000Z');
    `);
    migrate(db);
    expect(db.prepare('SELECT id, created_at, claimed_at, time_flag FROM entries ORDER BY id').all()).toEqual([
      { id: 1, created_at: '2026-09-01T10:00:00.000Z', claimed_at: '2026-09-01T10:00:00.000Z', time_flag: null },
      { id: 2, created_at: '2026-05-01T00:00:00.000Z', claimed_at: '2030-01-01T00:00:00.000Z', time_flag: 'future' },
    ]);
  });

  // Migration 7 (MCP-5): note runs, on a record with the assistant's tables (6) pointing at runs too.
  it('upgrades a record to note runs, keeping every run, its versions and what points at it', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const before = MIGRATIONS.length - 1;
    for (const m of MIGRATIONS.slice(0, before)) db.exec(m);
    db.exec(`PRAGMA user_version = ${before}`);
    db.exec(`
      INSERT INTO runs (id, task, engine, model, scope, schema_id, status, counts, started_at) VALUES
        (7, 'tag', 'none', NULL, 'all', 1, 'done', '{"tags":1}', 'x'),
        (8, 'tag', 'agent', 'claude-code', 'agent', 1, 'done', '{}', 'x');
      INSERT INTO tags (schema_id, name, run_id) VALUES (1, 'bread', 7);
      INSERT INTO pa_tasks (title, run_id, created_at, updated_at) VALUES ('bake', 7, 'x', 'x');
      INSERT INTO sources (id, kind, label, location, added_at) VALUES (1, 'notes', 'Notes', '/n', 'x');
      INSERT INTO entries (id, source_id, external_id, kind, speaker, created_at) VALUES (1, 1, 'a.md', 'note', 'you', 'x');
      INSERT INTO versions (entry_id, version, body, content_hash, editor, edited_at, observed_at, run_id)
        VALUES (1, 1, 'rye', 'h1', 'claude-code', 'x', 'x', 8);
    `);
    expect(() => db.prepare("INSERT INTO runs (task, engine, scope, status, started_at) VALUES ('note', 'agent', 'agent', 'done', 'x')").run()).toThrow(/CHECK/);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('SELECT id, task, engine, model, counts FROM runs ORDER BY id').all()).toEqual([
      { id: 7, task: 'tag', engine: 'none', model: null, counts: '{"tags":1}' },
      { id: 8, task: 'tag', engine: 'agent', model: 'claude-code', counts: '{}' },
    ]);
    expect(db.prepare('SELECT run_id FROM versions').all()).toEqual([{ run_id: 8 }]);
    expect(db.prepare('SELECT run_id FROM pa_tasks').all()).toEqual([{ run_id: 7 }]);
    const note = Number(db.prepare("INSERT INTO runs (task, engine, model, scope, status, started_at) VALUES ('note', 'agent', 'claude-code', 'agent', 'done', 'x')").run().lastInsertRowid);
    expect(db.prepare('SELECT id FROM live_runs ORDER BY id').all()).toEqual([{ id: 7 }, { id: 8 }]);
    expect(note).toBe(9);
    expect(() => db.prepare("INSERT INTO runs (task, engine, scope, status, started_at) VALUES ('nap', 'agent', 'agent', 'done', 'x')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO tags (schema_id, name, run_id) VALUES (1, 'rye', 99)").run()).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs' AND sql IS NOT NULL").all()).toEqual([{ name: 'runs_task' }]);
  });

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

describe('inTransaction inside inTransaction', () => {
  const insert = (db: DatabaseSync, label: string) =>
    db.prepare("INSERT INTO sources (kind, label, location, added_at) VALUES ('notes', ?, ?, 'x')").run(label, `/${label}`);
  const labels = (db: DatabaseSync) => (db.prepare('SELECT label FROM sources ORDER BY id').all() as { label: string }[]).map((r) => r.label);

  it('joins the transaction it opened, so the outer commit saves both writes', () => {
    const db = openDb(':memory:');
    inTransaction(db, () => {
      insert(db, 'outer');
      inTransaction(db, () => insert(db, 'inner'));
      expect(db.isTransaction).toBe(true);
    });
    expect(labels(db)).toEqual(['outer', 'inner']);
    expect(db.isTransaction).toBe(false);
  });

  it('rolls everything back when an inner call throws, even if the outer one catches it', () => {
    const db = openDb(':memory:');
    expect(() =>
      inTransaction(db, () => {
        insert(db, 'outer');
        try {
          inTransaction(db, () => {
            insert(db, 'inner');
            throw new Error('inner failed');
          });
        } catch {
          // The outer call carries on as if nothing happened.
        }
        insert(db, 'after');
      }),
    ).toThrow('inner failed');
    expect(labels(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
    // The connection is usable again, with nothing left over from the failed transaction.
    inTransaction(db, () => insert(db, 'next'));
    expect(labels(db)).toEqual(['next']);
  });

  it('rolls the inner writes back with the outer ones when the outer call fails after them', () => {
    const db = openDb(':memory:');
    expect(() =>
      inTransaction(db, () => {
        inTransaction(db, () => insert(db, 'inner'));
        throw new Error('later');
      }),
    ).toThrow('later');
    expect(labels(db)).toEqual([]);
  });

  it('keeps the outer writes out when SQLite itself rolled back under a failed inner call', () => {
    const db = openDb(':memory:');
    expect(() =>
      inTransaction(db, () => {
        insert(db, 'outer');
        try {
          inTransaction(db, () => {
            insert(db, 'inner');
            // What SQLite does on its own on a full disk or an I/O error.
            db.exec('ROLLBACK');
            throw new Error('disk full');
          });
        } catch {
          // The outer call carries on.
        }
        insert(db, 'after');
        inTransaction(db, () => insert(db, 'nested'));
      }),
    ).toThrow('disk full');
    expect(labels(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
    inTransaction(db, () => insert(db, 'next'));
    expect(labels(db)).toEqual(['next']);
  });

  it('refuses a nested call once SQLite rolled back under a statement the outer call caught', () => {
    const db = openDb(':memory:');
    expect(() =>
      inTransaction(db, () => {
        insert(db, 'outer');
        db.exec('ROLLBACK');
        inTransaction(db, () => insert(db, 'nested'));
      }),
    ).toThrow("The record's write transaction was rolled back by an earlier error, so nothing more is written.");
    expect(labels(db)).toEqual([]);
    inTransaction(db, () => insert(db, 'next'));
    expect(labels(db)).toEqual(['next']);
  });

  it('refuses to join a transaction opened with a raw BEGIN', () => {
    const db = openDb(':memory:');
    db.exec('BEGIN');
    expect(() => inTransaction(db, () => insert(db, 'joined'))).toThrow(/within a transaction/);
    db.exec('ROLLBACK');
    expect(labels(db)).toEqual([]);
  });
});

describe('two processes opening one old record', () => {
  /** A migration-4 record on disk, as an older Skeinwise left it, with an entry from a planted future. */
  function oldRecord(file: string): void {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 4)) db.exec(m);
    db.exec(`
      PRAGMA user_version = 4;
      INSERT INTO sources (id, kind, label, location, added_at) VALUES (1, 'claude-code', 'Claude Code', '/p', '2026-05-01T00:00:00.000Z');
      INSERT INTO entries (id, source_id, external_id, kind, speaker, created_at) VALUES
        (1, 1, 's1', 'message', 'you', '2026-09-01T10:00:00.000Z'),
        (2, 1, 's2', 'message', 'you', '2030-01-01T00:00:00.000Z');
      INSERT INTO versions (entry_id, version, body, content_hash, editor, edited_at) VALUES
        (1, 1, 'later', 'h1', 'import', '2026-09-01T10:00:00.000Z'),
        (2, 1, 'planted', 'h2', 'import', '2030-01-01T00:00:00.000Z');
    `);
    db.close();
  }

  function upgradedOnce(file: string): void {
    const db = new DatabaseSync(file);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT id, created_at, claimed_at, time_flag FROM entries ORDER BY id').all()).toEqual([
      { id: 1, created_at: '2026-09-01T10:00:00.000Z', claimed_at: '2026-09-01T10:00:00.000Z', time_flag: null },
      { id: 2, created_at: '2026-05-01T00:00:00.000Z', claimed_at: '2030-01-01T00:00:00.000Z', time_flag: 'future' },
    ]);
    expect(db.prepare('SELECT entry_id, version, body FROM versions ORDER BY id').all()).toEqual([
      { entry_id: 1, version: 1, body: 'later' },
      { entry_id: 2, version: 1, body: 'planted' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pa\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name)).toEqual(['pa_briefs', 'pa_found', 'pa_loops', 'pa_tasks']);
    db.close();
  }

  it('runs each migration once when another process upgrades the record between its check and its lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-migrate-'));
    try {
      const file = join(dir, 'record.db');
      oldRecord(file);
      const a = new DatabaseSync(file);
      const b = new DatabaseSync(file);
      // b has read version 4 and is about to start its transaction when a upgrades the record.
      let raced = false;
      const late = new Proxy(b, {
        get(target, key) {
          if (key === 'exec') {
            return (sql: string) => {
              if (!raced && sql.startsWith('BEGIN')) {
                raced = true;
                migrate(a);
              }
              return target.exec(sql);
            };
          }
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      migrate(late);
      expect(raced).toBe(true);
      a.close();
      b.close();
      upgradedOnce(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades it once when two processes open it at the same time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-migrate-'));
    try {
      const file = join(dir, 'record.db');
      oldRecord(file);
      // Hold the write lock until both processes have started opening the record, so both find it at version 4.
      const holder = new DatabaseSync(file);
      holder.exec('BEGIN IMMEDIATE');
      const opens = [openInProcess(file), openInProcess(file)];
      await Promise.all(opens.map((o) => o.ready));
      await new Promise((resolve) => setTimeout(resolve, 300));
      holder.exec('COMMIT');
      holder.close();
      const results = await Promise.all(opens.map((o) => o.done));
      expect(results).toEqual([
        { code: 0, out: `ready\nversion ${MIGRATIONS.length}\n` },
        { code: 0, out: `ready\nversion ${MIGRATIONS.length}\n` },
      ]);
      upgradedOnce(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/** Opens `file` with openDb in a Node process of its own; `ready` once it is about to open, `done` when it exits. */
function openInProcess(file: string): { ready: Promise<void>; done: Promise<{ code: number | null; out: string }> } {
  const script = `
    import { writeSync } from 'node:fs';
    const [module, file] = process.argv.slice(1);
    const { openDb, schemaVersion } = await import(module);
    writeSync(1, 'ready\\n');
    const db = openDb(file, { busyTimeoutMs: 20000 });
    writeSync(1, 'version ' + schemaVersion(db) + '\\n');
    db.close();
  `;
  const module = new URL('../src/store/db.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, module, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    if (out.startsWith('ready')) markReady();
  });
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on('close', (code) => resolve({ code, out })));
  void done.then(markReady);
  return { ready, done };
}
