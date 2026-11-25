import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, schemaVersion } from '../src/store/db.ts';
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
