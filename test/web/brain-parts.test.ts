// What a selected point is and where it leads (web/src/brain/parts.ts), and the names its label buttons carry
// (web/src/brain/input.ts): the facts behind the card one click pins.

import { describe, expect, it } from 'vitest';
import type { BrainData, BrainPoint } from '../../src/server/queries.ts';
import { buildModel } from '../../web/src/brain/input.ts';
import { hubEntryIds, hubMembers, indexOfPoint, linkedRows, neighbourIds, partAt, titleOf } from '../../web/src/brain/parts.ts';
import { palette, theme } from '../../web/src/themes.ts';
import type { EntryLines } from '../../web/src/types.ts';

const t = (iso: string) => Date.parse(iso);

const record: BrainData = {
  kinds: ['message', 'note', 'file'],
  speakers: ['you', 'assistant'],
  sources: [
    { id: 7, label: 'Chat export', kind: 'chat' },
    { id: 9, label: 'notes', kind: 'notes' },
  ],
  folders: ['notes', 'Inbox'],
  projects: [],
  threads: { '3': 'Beans' },
  points: [
    [1, 0, 0, 7, 3, 1, -1, t('2025-03-02T10:00:00Z'), 'How deep?'],
    [2, 0, 1, 7, 3, 1, -1, t('2025-03-02T10:01:00Z'), 'About 3 cm'],
    [3, 0, 0, 7, 3, 1, -1, t('2025-03-01T09:00:00Z'), 'Beans'],
    [4, 1, 0, 9, 0, 0, -1, t('2025-04-01T00:00:00Z'), 'Garden plan'],
    [5, 1, 0, 9, 0, 0, -1, t('2025-05-01T00:00:00Z'), 'Seeds'],
    [6, 2, 0, 9, 0, 0, -1, t('2025-06-01T00:00:00Z'), '  '],
  ] satisfies BrainPoint[],
  links: [[4, 5, 0]],
  hubs: [
    { id: 11, name: 'Sowing depth', entries: [1, 2, 99] },
    { id: 12, name: 'Planning', entries: [4, 5, 6] },
  ],
  organiser: true,
};

const model = buildModel(record, 'source', palette('ember'), theme('dusk'));

function lines(over: Partial<EntryLines> = {}): EntryLines {
  return {
    entry: 2,
    threadLine: { before: null, after: null },
    crossLink: [],
    noteLink: [],
    hubSpoke: [],
    timeChain: { before: null, after: null },
    ...over,
  };
}

describe('a point as its card shows it', () => {
  it('describes an entry: title, date, source, type, speaker and thread', () => {
    expect(partAt(model, record, model.indexOf.get(2)!)).toEqual({
      kind: 'entry',
      point: 2,
      id: 2,
      index: 1,
      title: 'About 3 cm',
      at: t('2025-03-02T10:01:00Z'),
      source: 'Chat export',
      type: 'Message',
      speaker: 'assistant',
      thread: 'Beans',
    });
  });

  it('calls an entry with a blank title Untitled, and one in no thread has none', () => {
    expect(partAt(model, record, model.indexOf.get(6)!)).toMatchObject({ title: 'Untitled', type: 'File', thread: null });
  });

  it('describes a hub by its name and its entries in the record, and names it by its id negated', () => {
    const index = model.hubs.find((h) => h.id === 11)!.index;
    expect(partAt(model, record, index)).toEqual({ kind: 'hub', point: -11, id: 11, index, name: 'Sowing depth', count: 2 });
  });

  it('has nothing at an index past the drawn points', () => {
    expect(partAt(model, record, 999)).toBeNull();
  });

  it('finds where a point is drawn from its id, entry or hub, and -1 for one not drawn', () => {
    expect(indexOfPoint(model, 4)).toBe(3);
    expect(indexOfPoint(model, -12)).toBe(model.hubs.find((h) => h.id === 12)!.index);
    expect(indexOfPoint(model, 99)).toBe(-1);
    expect(indexOfPoint(model, -40)).toBe(-1);
  });
});

describe('where an entry leads', () => {
  const full = lines({
    noteLink: [
      { entry: 5, direction: 'from' },
      { entry: 4, direction: 'to' },
    ],
    hubSpoke: [{ hub: 11, name: 'Sowing depth' }],
    threadLine: { before: 1, after: 3 },
    crossLink: [
      { entry: 6, score: 0.4 },
      { entry: 4, score: 0.9 },
      { entry: 77, score: 0.8 },
    ],
  });

  it('lists links out, links in, its hubs, its thread neighbours, then what reads alike, most alike first', () => {
    expect(linkedRows(full, record).map((r) => [r.point, r.title, r.why])).toEqual([
      [4, 'Garden plan', 'Links to'],
      [5, 'Seeds', 'Linked from'],
      [-11, 'Sowing depth', 'In hub'],
      [1, 'How deep?', 'Before, in its thread'],
      [3, 'Beans', 'After, in its thread'],
      // 4 is already listed as a link; 77 isn't in the record the page has, so it has no title or date.
      [77, 'Untitled', 'Reads alike'],
      [6, 'Untitled', 'Reads alike'],
    ]);
  });

  it('dates entry rows and leaves hub rows undated', () => {
    const rows = linkedRows(full, record);
    expect(rows[0]!.at).toBe(t('2025-04-01T00:00:00Z'));
    expect(rows[2]!.at).toBeUndefined();
    expect(rows[5]!.at).toBeUndefined();
  });

  it('never lists the entry itself', () => {
    expect(linkedRows(lines({ crossLink: [{ entry: 2, score: 1 }] }), record)).toEqual([]);
  });

  it('lights the entry, its links both ways, what reads alike and its thread neighbours, but not its hubs', () => {
    expect(neighbourIds(full).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 77]);
    expect(neighbourIds(lines())).toEqual([2]);
  });
});

describe("a hub's entries", () => {
  it('lists the ones still in the record, newest first', () => {
    expect(hubMembers(record, 12).map((r) => [r.point, r.title, r.why])).toEqual([
      [6, 'Untitled', 'File'],
      [5, 'Seeds', 'Note'],
      [4, 'Garden plan', 'Note'],
    ]);
    expect(hubMembers(record, 11).map((r) => r.point)).toEqual([2, 1]);
    expect(hubMembers(record, 40)).toEqual([]);
  });

  it('lights only the ones still in the record', () => {
    expect(hubEntryIds(record, 11)).toEqual([1, 2]);
    expect(hubEntryIds(record, 40)).toEqual([]);
  });
});

describe('label buttons', () => {
  it('name each label for a screen reader: hubs with their size, notes as notes, hubs first and biggest first', () => {
    expect(model.input.labels.map((l) => l.name)).toEqual(['Planning: concept hub, 3 entries', 'Sowing depth: concept hub, 2 entries', 'Seeds: note', 'Garden plan: note']);
  });

  it('keep the visible text at the start of the name', () => {
    for (const l of model.input.labels) expect(l.name.startsWith(l.text)).toBe(true);
  });

  it('count one entry as one', () => {
    const one = buildModel({ ...record, hubs: [{ id: 13, name: 'Solo', entries: [5] }] }, 'source', palette('ember'), theme('dusk'));
    expect(one.input.labels[0]!.name).toBe('Solo: concept hub, 1 entry');
  });
});

describe('a record the server sampled', () => {
  // Past its cap the server sends a sample: the record's total, and each hub's size in the whole record, come with it.
  const sampled: BrainData = {
    ...record,
    total: 5000,
    hubs: [
      { id: 11, name: 'Sowing depth', size: 40, entries: [1, 2] },
      { id: 12, name: 'Planning', size: 3, entries: [4, 5, 6] },
    ],
  };
  const big = buildModel(sampled, 'source', palette('ember'), theme('dusk'));

  it("counts the record's entries, not the ones it was sent", () => {
    expect(big.data.points).toHaveLength(6);
    expect(big.total).toBe(5000);
  });

  it("counts a hub's entries in the whole record, on its card and its label, and ranks the labels by it", () => {
    expect(partAt(big, sampled, big.hubs.find((h) => h.id === 11)!.index)).toMatchObject({ kind: 'hub', count: 40 });
    expect(big.input.labels.slice(0, 2).map((l) => l.name)).toEqual(['Sowing depth: concept hub, 40 entries', 'Planning: concept hub, 3 entries']);
  });

  it('counts what it was sent when the server sends no total or sizes', () => {
    expect(model.total).toBe(6);
    expect(partAt(model, record, model.hubs.find((h) => h.id === 11)!.index)).toMatchObject({ count: 2 });
  });
});

describe('titles', () => {
  it('trims a title and calls a blank or missing one Untitled', () => {
    expect(titleOf(record.points[3])).toBe('Garden plan');
    expect(titleOf(record.points[5])).toBe('Untitled');
    expect(titleOf(undefined)).toBe('Untitled');
  });
});
