import { describe, expect, it } from 'vitest';
import type { BrainData, BrainPoint } from '../../src/server/queries.ts';
import { niceMax, scale, smooth, sparseLabels } from '../../web/src/chart.ts';
import { lineDiff } from '../../web/src/diff.ts';
import { openLink } from '../../web/src/markdown.ts';
import { folderCounts, navItems, sourceCounts } from '../../web/src/nav.ts';
import { batchId, importSummary, LOOSE_FOLDER, uploadPath, usable } from '../../web/src/upload.ts';

const t = (iso: string) => Date.parse(iso);

describe('chart helpers', () => {
  it('smooths with a window that shrinks at the ends', () => {
    expect(smooth([0, 3, 6], 1)).toEqual([1.5, 3, 4.5]);
    expect(smooth([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });

  it('scales linear and log values into 0..1', () => {
    expect(scale(5, 10, false)).toBe(0.5);
    expect(scale(-2, 10, false)).toBe(0);
    expect(scale(0, 10, true)).toBe(0);
    expect(scale(10, 10, true)).toBeCloseTo(1);
    expect(scale(3, 0, false)).toBe(0);
  });

  it('rounds an axis top up to 1, 2 or 5 times a power of ten', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(420)).toBe(500);
    expect(niceMax(1000)).toBe(1000);
  });

  it('keeps every nth label when there is no room for all', () => {
    expect([...sparseLabels(10, 5)]).toEqual([0, 2, 4, 6, 8]);
    expect([...sparseLabels(3, 10)]).toEqual([0, 1, 2]);
    expect(sparseLabels(0, 4).size).toBe(0);
  });
});

describe('line diff', () => {
  it('marks kept, added and removed lines in order', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'same', text: 'c' },
      { op: 'add', text: 'd' },
    ]);
  });

  it('treats Windows line ends as plain ones', () => {
    expect(lineDiff('x\r\ny', 'x\ny').every((l) => l.op === 'same')).toBe(true);
  });
});

describe('navigator items', () => {
  const points: BrainPoint[] = [
    [1, 0, 0, 7, 3, 1, -1, t('2025-03-02T10:00:00Z'), 'How deep?'],
    [2, 0, 1, 7, 3, 1, -1, t('2025-03-03T10:00:00Z'), 'About 3 cm'],
    [4, 1, 0, 9, 0, 0, -1, t('2025-04-01T00:00:00Z'), 'Garden plan'],
    [5, 2, 0, 9, 0, 0, -1, t('2025-02-01T00:00:00Z'), 'apple.pdf'],
  ];
  const data = {
    kinds: ['message', 'note', 'file'],
    speakers: ['you', 'assistant'],
    sources: [
      { id: 7, label: 'Claude', kind: 'claude' },
      { id: 9, label: 'notes', kind: 'notes' },
    ],
    folders: ['notes', 'Inbox'],
    projects: [],
    threads: { '3': 'Beans' },
    points,
    links: [],
    organiser: false,
  } as unknown as BrainData;

  it('folds a thread into one row with its span and speakers', () => {
    const items = navItems(data);
    expect(items.map((i) => i.title)).toEqual(['Garden plan', 'Beans', 'apple.pdf']);
    const thread = items[1]!;
    expect(thread.kind).toBe('thread');
    expect(thread.count).toBe(2);
    expect(thread.first).toBe(t('2025-03-02T10:00:00Z'));
    expect(thread.last).toBe(t('2025-03-03T10:00:00Z'));
    expect([...thread.speakers].sort()).toEqual([0, 1]);
    expect(items[2]!.kind).toBe('file');
  });

  it('filters and sorts by name', () => {
    expect(navItems(data, { source: 9 }, 'name').map((i) => i.title)).toEqual(['apple.pdf', 'Garden plan']);
    expect(navItems(data, { speaker: 1 }).map((i) => i.count)).toEqual([1]);
    expect(navItems(data, { since: t('2025-03-15T00:00:00Z') }).map((i) => i.title)).toEqual(['Garden plan']);
  });

  it('counts entries per folder and per source', () => {
    expect(folderCounts(data)).toEqual([2, 2]);
    expect(sourceCounts(data).get(7)).toBe(2);
  });
});

describe('upload helpers', () => {
  it('puts loose files in their own folder and keeps picked folders as they are', () => {
    expect(uploadPath('a.md', '')).toBe(`${LOOSE_FOLDER}/a.md`);
    expect(uploadPath('export.zip', '')).toBe('export.zip');
    expect(uploadPath('a.md', 'vault/notes/a.md')).toBe('vault/notes/a.md');
    expect(uploadPath('a.md', '\\vault\\a.md')).toBe('vault/a.md');
  });

  it('accepts exports and notes, and skips hidden files', () => {
    expect(usable('export.zip')).toBe(true);
    expect(usable('vault/note.MD')).toBe(true);
    expect(usable('photo.png')).toBe(false);
    expect(usable('vault/.obsidian/app.json')).toBe(false);
  });

  it('makes a batch id of 16 lowercase letters and digits', () => {
    let n = 0;
    const id = batchId(() => (n++ % 36) / 36);
    expect(id).toMatch(/^[a-z0-9]{16}$/);
    expect(id.startsWith('abc')).toBe(true);
  });

  it('sums an import in one short sentence', () => {
    const r = (source: string, added: number, versioned = 0) => ({ source, kind: 'x', added, versioned, unchanged: 0, threads: 0 });
    expect(importSummary([])).toBe('Nothing in those files could be read.');
    expect(importSummary([r('ChatGPT', 0)])).toBe('Already in the record: nothing new from ChatGPT.');
    expect(importSummary([r('ChatGPT', 1)])).toBe('Brought in 1 new entry from ChatGPT.');
    expect(importSummary([r('ChatGPT', 3, 2), r('Claude', 1)])).toBe('Brought in 4 new entries and 2 updated from 2 sources.');
  });
});

describe('open wiki link', () => {
  it('finds the [[ being typed before the caret', () => {
    const text = 'See [[Garden pl';
    expect(openLink(text, text.length)).toEqual({ start: 6, typed: 'Garden pl' });
    expect(openLink('See [[Beans]] now', 17)).toBeNull();
    expect(openLink('no link', 7)).toBeNull();
  });
});
