import { describe, expect, it } from 'vitest';
import type { BrainData, BrainPoint } from '../../src/server/queries.ts';
import { buildModel, legendColors, litValues, MAX_POINTS, samplePoints } from '../../web/src/brain/input.ts';
import { palette, theme } from '../../web/src/themes.ts';

const t = (iso: string) => Date.parse(iso);

function data(points: BrainPoint[], links: [number, number, number][] = []): BrainData {
  return {
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
    links,
    hubs: [],
    organiser: false,
  };
}

const sample = data(
  [
    [1, 0, 0, 7, 3, 1, -1, t('2025-03-02T10:00:00Z'), 'How deep?'],
    [2, 0, 1, 7, 3, 1, -1, t('2025-03-02T10:01:00Z'), 'About 3 cm'],
    [3, 0, 0, 7, 3, 1, -1, t('2025-03-01T09:00:00Z'), 'Beans'],
    [4, 1, 0, 9, 0, 0, -1, t('2025-04-01T00:00:00Z'), 'Garden plan'],
    [5, 1, 0, 9, 0, 0, -1, t('2025-05-01T00:00:00Z'), 'Seeds'],
    [6, 1, 0, 9, 0, 0, -1, t('2025-06-01T00:00:00Z'), '  '],
  ],
  [[4, 5, 0]],
);

const dusk = theme('dusk');
const ember = palette('ember');

describe('brain input', () => {
  it('gives each point its group colour and a size by kind', () => {
    const m = buildModel(sample, 'source', ember, dusk);
    expect(m.legend.map((g) => [g.label, g.count])).toEqual([
      ['Claude', 3],
      ['notes', 3],
    ]);
    expect(m.input.colors).toHaveLength(18);
    // Points 0 and 3 sit in different groups, so their colours differ.
    expect([...m.input.colors.slice(0, 3)]).not.toEqual([...m.input.colors.slice(9, 12)]);
    // Notes are larger than messages, and a linked note larger than an unlinked one.
    expect(m.input.sizes[3]!).toBeGreaterThan(m.input.sizes[0]!);
    expect(m.input.sizes[3]!).toBeGreaterThan(m.input.sizes[5]!);
    expect(m.indexOf.get(4)).toBe(3);
  });

  it('labels the most-linked notes first and skips blank titles', () => {
    const m = buildModel(sample, 'source', ember, dusk);
    expect(m.input.labels.map((l) => l.text)).toEqual(['Seeds', 'Garden plan']);
  });

  it('gives the long tail of groups one shared quiet colour', () => {
    const colors = legendColors(14, ember, dusk);
    expect(colors.slice(0, 9)).toEqual(ember.colors.slice(0, 9));
    expect(new Set(colors.slice(9)).size).toBe(1);
    expect(legendColors(ember.colors.length, ember, dusk)).toEqual(ember.colors);
  });

  it('lights matches, dims the rest and isolates a group', () => {
    const m = buildModel(sample, 'source', ember, dusk);
    expect(litValues(m, null, null)).toBeNull();
    expect([...litValues(m, new Set([2, 5]), null)!]).toEqual([0, 2, 0, 0, 2, 0]);
    expect([...litValues(m, null, 1)!]).toEqual([0, 0, 0, 1, 1, 1]);
    expect([...litValues(m, new Set([2, 5]), 1)!]).toEqual([0, 0, 0, 0, 2, 0]);
  });

  it('adds one large labelled point per hub, with a spoke to each entry it holds', () => {
    const withHubs: BrainData = {
      ...sample,
      hubs: [
        { id: 11, name: 'Sowing depth', entries: [1, 2, 99] },
        { id: 12, name: 'Gone', entries: [98] },
      ],
    };
    const m = buildModel(withHubs, 'source', ember, dusk);
    // The hub with no entries left is skipped; the other comes after every entry.
    expect(m.hubs).toEqual([{ index: 6, id: 11, name: 'Sowing depth', count: 2 }]);
    expect(m.input.points[6]).toMatchObject({ id: -11, kind: 1, time: t('2025-03-02T10:01:00Z'), group: 0 });
    expect([...m.input.spokes]).toEqual([6, 0, 6, 1]);
    expect(m.input.sizes[6]!).toBeGreaterThan(Math.max(...m.input.sizes.slice(0, 6)));
    expect(m.input.labels.map((l) => l.text)).toEqual(['Sowing depth', 'Seeds', 'Garden plan']);
    // The legend counts entries only.
    expect(m.legend.map((g) => g.count)).toEqual([3, 3]);
    // A hub lights with any of its entries, and isolates with its group.
    expect([...litValues(m, new Set([2]), null)!]).toEqual([0, 2, 0, 0, 0, 0, 2]);
    expect([...litValues(m, null, 1)!]).toEqual([0, 0, 0, 1, 1, 1, 0]);
  });
});

describe('the point cap', () => {
  const day = 86_400_000;
  /** n points: every fifth a note, every seventh a file, the rest messages, one a day; ids from 1. */
  function big(n: number): BrainData {
    const points: BrainPoint[] = Array.from({ length: n }, (_, i) => {
      const kind = i % 5 === 0 ? 1 : i % 7 === 0 ? 2 : 0;
      return [i + 1, kind, 0, kind === 1 ? 9 : 7, kind === 1 ? 0 : 3, kind === 1 ? 0 : 1, -1, t('2025-01-01T00:00:00Z') + i * day, `p${i + 1}`] as BrainPoint;
    });
    return { ...data(points), hubs: [{ id: 4, name: 'Soil', entries: points.map((p) => p[0]).filter((id) => id % 3 === 0) }] };
  }

  it('draws every point up to the cap', () => {
    expect(MAX_POINTS).toBe(20_000);
    expect(samplePoints(big(50).points, 50)).toBeNull();
    const m = buildModel(big(50), 'source', ember, dusk, 50);
    expect(m.data.points.length).toBe(50);
    expect(m.total).toBe(50);
  });

  it('past the cap keeps every note and file and spreads the messages over time, in record order', () => {
    const record = big(1000);
    const keep = samplePoints(record.points, 400)!;
    expect(keep).toHaveLength(400);
    expect(keep).toEqual([...keep].sort((a, b) => a - b));
    expect(new Set(keep).size).toBe(400);
    const own = record.points.flatMap((p, i) => (p[1] === 0 ? [] : [i]));
    for (const i of own) expect(keep).toContain(i);
    // The messages reach from the start of the record to its end, not just its first or last stretch.
    const messages = keep.filter((i) => record.points[i]![1] === 0);
    expect(messages.length).toBe(400 - own.length);
    expect(messages[0]!).toBeLessThan(20);
    expect(messages.at(-1)!).toBeGreaterThan(980);
  });

  it('spreads the notes and files too when they alone pass the cap', () => {
    const record = big(1000);
    const keep = samplePoints(record.points, 100)!;
    expect(keep).toHaveLength(100);
    expect(keep.every((i) => record.points[i]![1] !== 0)).toBe(true);
    expect(keep[0]!).toBeLessThan(20);
    expect(keep.at(-1)!).toBeGreaterThan(950);
  });

  it("builds the scene from the sample, with the record's own counts", () => {
    const record = big(1000);
    const m = buildModel(record, 'source', ember, dusk, 400);
    expect(m.data.points).toHaveLength(400);
    expect(m.total).toBe(1000);
    // Point i of the scene is point i of the drawn data, which is what the hover card reads.
    m.data.points.forEach((p, i) => expect(m.input.points[i]!.id).toBe(p[0]));
    for (let i = 0; i < m.data.points.length; i++) expect(m.indexOf.get(m.data.points[i]![0])).toBe(i);
    // The legend counts the whole record, not the sample.
    expect(m.legend.reduce((sum, g) => sum + g.count, 0)).toBe(1000);
    expect(m.grouped.of).toHaveLength(400);
    // The hub draws spokes only to the entries in the sample but counts all of its entries.
    const hub = m.hubs[0]!;
    expect(hub.index).toBe(400);
    expect(hub.count).toBe(333);
    expect(m.input.spokes.length / 2).toBeLessThan(333);
  });
});
