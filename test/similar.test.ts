import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { similarEntries as fromIndex } from '../src/organiser/ask.ts';
import { RecordView } from '../src/organiser/record.ts';
import { similarEntries } from '../src/organiser/similar.ts';
import { keyWords } from '../src/organiser/text.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

describe('keyWords', () => {
  it('keeps the commonest words after stop words, one spelling per stem', () => {
    expect(keyWords('The plots plotted; plotting PLOTS and a Plot. Sourdough, sourdough rye.', 3)).toEqual(['plots', 'sourdough', 'rye']);
    expect(keyWords('the and of it', 5)).toEqual([]);
  });
});

describe('similar from the full-text index', () => {
  let dir: string;
  let store: Store;
  let record: RecordView;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-similar-'));
    writeDemo(dir);
    store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
    record = new RecordView(store);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads like the entry index's cosine on the demo", () => {
    // Every third entry, since the index scores the whole record per call. On all 422 the index's best entry is in
    // the top three for 415, and first for 408 (measured when similar moved to the full-text index).
    const sample = record.entries.filter((_, i) => i % 3 === 0);
    let first = 0;
    let topThree = 0;
    for (const e of sample) {
      const best = fromIndex(record, e.id, 1)[0]!.entryId;
      const hits = similarEntries(store, e.id, 3).map((h) => h.entryId);
      if (hits[0] === best) first++;
      if (hits.includes(best)) topThree++;
    }
    expect(first / sample.length).toBeGreaterThan(0.93);
    expect(topThree / sample.length).toBeGreaterThan(0.96);
  });

  it('leaves out the entry and its own thread, and scores from 1 down', () => {
    const entry = record.byId.get(385)!;
    const hits = similarEntries(store, 385, 20);
    expect(hits.length).toBe(20);
    expect(hits[0]!.entryId).toBe(345);
    for (const h of hits) {
      expect(h.entryId).not.toBe(385);
      expect(record.byId.get(h.entryId)!.threadId).not.toBe(entry.threadId);
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
    expect(similarEntries(store, 385, 0)).toEqual([]);
    expect(() => similarEntries(store, 99_999, 3)).toThrow(/No entry 99999/);
  });

  it('leaves out a thread marked not mine', () => {
    const thread = record.byId.get(345)!.threadId!;
    store.db.prepare('UPDATE threads SET not_mine = 1 WHERE id = ?').run(thread);
    try {
      const hits = similarEntries(store, 385, 50);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => record.byId.get(h.entryId)!.threadId !== thread)).toBe(true);
      expect(() => similarEntries(store, 345, 5)).toThrow(/No entry/);
    } finally {
      store.db.prepare('UPDATE threads SET not_mine = 0 WHERE id = ?').run(thread);
    }
  });

  it('leaves out an excluded source, and refuses an entry in one', () => {
    const notes = record.entries.find((e) => e.kind === 'note')!;
    const message = record.entries.find((e) => e.kind === 'message')!.id;
    const before = similarEntries(store, message, 50);
    store.db.prepare("UPDATE sources SET status = 'out' WHERE id = ?").run(notes.sourceId);
    try {
      const after = similarEntries(store, message, 50);
      expect(after.every((h) => record.byId.get(h.entryId)!.sourceId !== notes.sourceId)).toBe(true);
      expect(before.some((h) => record.byId.get(h.entryId)!.sourceId === notes.sourceId)).toBe(true);
      expect(() => similarEntries(store, notes.id, 5)).toThrow(/No entry/);
    } finally {
      store.db.prepare("UPDATE sources SET status = 'in' WHERE id = ?").run(notes.sourceId);
    }
  });
});
