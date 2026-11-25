import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, schemaVersion } from '../src/store/db.ts';
import { MIGRATIONS } from '../src/store/schema.ts';

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
});
