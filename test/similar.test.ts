import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { similarEntries as fromIndex } from '../src/organiser/ask.ts';
import { RecordView } from '../src/organiser/record.ts';
import { similarEntries } from '../src/organiser/similar.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

describe('similar without building the entry index', () => {
  let dir: string;
  let store: Store;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-similar-'));
    writeDemo(dir);
    store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('gives the entry index its own answer, scores included', () => {
    // Every third entry: each one scores the whole record twice, and the suite runs on a busy machine.
    const record = new RecordView(store);
    const sample = record.entries.filter((_, i) => i % 3 === 0);
    expect(sample.length).toBeGreaterThan(50);
    for (const e of sample) expect(similarEntries(store, e.id, 5)).toEqual(fromIndex(record, e.id, 5));
  });

  it('leaves out an excluded source, and refuses an entry in one', () => {
    const record = new RecordView(store);
    const notes = record.entries.find((e) => e.kind === 'note')!;
    const before = similarEntries(store, record.entries.find((e) => e.kind === 'message')!.id, 50);
    store.db.prepare("UPDATE sources SET status = 'out' WHERE id = ?").run(notes.sourceId);
    try {
      const after = similarEntries(store, record.entries.find((e) => e.kind === 'message')!.id, 50);
      expect(after.every((h) => record.byId.get(h.entryId)!.sourceId !== notes.sourceId)).toBe(true);
      expect(before.some((h) => record.byId.get(h.entryId)!.sourceId === notes.sourceId)).toBe(true);
      expect(() => similarEntries(store, notes.id, 5)).toThrow(/No entry/);
    } finally {
      store.db.prepare("UPDATE sources SET status = 'in' WHERE id = ?").run(notes.sourceId);
    }
  });
});
